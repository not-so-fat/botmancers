// Shared by the managed-install tests and smoke: build botmancers release
// trees at any version (this checkout's dist/ plus a real or fake packaged
// app), pack them into tarballs, and serve them from a local npm registry
// with real sha512 integrity values. Not shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { PACKAGE_DIR, makeFakeApp } from './product-harness.mjs';

// The package.json inside a tarball, as the registry serves it per version.
const manifests = new Map();
function manifestOf(tarball) {
  if (!manifests.has(tarball)) {
    const { name, version, bin, engines, type, main, exports } = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    manifests.set(tarball, { name, version, bin, engines, type, main, exports });
  }
  return manifests.get(tarball);
}

export const integrityOf = file => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

// A publishable package directory for botmancers@version. With `app`, that
// packaged app is copied and its BUILD_INFO version rewritten; otherwise a
// fake app is generated.
export function makePackage(dir, version, { app } = {}) {
  mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  pkg.version = version;
  delete pkg.scripts;
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const entry of ['dist', 'schemas', 'skills', 'CHANGELOG.md', 'README.md', 'LICENSE']) cpSync(join(PACKAGE_DIR, entry), join(dir, entry), { recursive: true });
  if (app) {
    cpSync(app, join(dir, 'app'), { recursive: true, verbatimSymlinks: true });
    const infoPath = join(dir, 'app', 'BUILD_INFO.json');
    writeFileSync(infoPath, JSON.stringify({ ...JSON.parse(readFileSync(infoPath, 'utf8')), version }));
  } else {
    makeFakeApp(join(dir, 'app'), { version });
    // npm pack drops empty directories; the release check requires these.
    writeFileSync(join(dir, 'app', '.next', 'static', 'chunks', 'main.js'), '');
    writeFileSync(join(dir, 'app', 'public', 'robots.txt'), '');
  }
  return dir;
}

export function pack(dir, destination, env = process.env) {
  mkdirSync(destination, { recursive: true });
  const out = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return join(destination, JSON.parse(out)[0].filename);
}

// Places a release tree directly (no npm), the way `npm install --prefix`
// would lay it out, including the lockfile entry the updater reads.
export function seedRelease(home, version, options = {}) {
  const root = join(home, 'versions', version);
  makePackage(join(root, 'node_modules', 'botmancers'), version, options);
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/botmancers': { version, integrity: `sha512-seeded-${version}` } } }));
  return root;
}

// A minimal npm registry for one package. `releases` maps version -> tarball
// path. Options can be changed while it runs: latest, mode ('ok' | 'hang' |
// 'error' | 'truncate'), and badIntegrity (versions whose per-version
// document advertises a wrong integrity). `hits` lists every request path.
export async function startRegistry({ releases = {}, latest } = {}) {
  const state = { releases: { ...releases }, latest, mode: 'ok', badIntegrity: new Set(), hits: [] };
  const hanging = new Set();
  const server = createServer((req, res) => {
    state.hits.push(req.url);
    if (state.mode === 'hang') {
      hanging.add(res);
      return;
    }
    if (state.mode === 'error') {
      res.writeHead(503).end('unavailable');
      return;
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const meta = version => ({
      ...manifestOf(state.releases[version]),
      name: 'botmancers',
      version,
      dist: { tarball: `${base}/botmancers/-/botmancers-${version}.tgz`, integrity: integrityOf(state.releases[version]) },
    });
    const json = body => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const url = decodeURIComponent(req.url.split('?')[0]);
    let match;
    if (url === '/botmancers') {
      return json({ name: 'botmancers', 'dist-tags': { latest: state.latest }, versions: Object.fromEntries(Object.keys(state.releases).map(v => [v, meta(v)])) });
    }
    if ((match = /^\/botmancers\/-\/botmancers-(.+)\.tgz$/.exec(url)) && state.releases[match[1]]) {
      const body = readFileSync(state.releases[match[1]]);
      if (state.mode === 'truncate') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        res.write(body.subarray(0, Math.floor(body.length / 3)));
        return res.destroy();
      }
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
    }
    if (url === '/botmancers/latest' && state.latest) return json(meta(state.latest));
    if ((match = /^\/botmancers\/([^/]+)$/.exec(url)) && state.releases[match[1]]) {
      const doc = meta(match[1]);
      if (state.badIntegrity.has(match[1])) doc.dist.integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
      return json(doc);
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise(resolve => {
    for (const res of hanging) res.destroy();
    server.closeAllConnections?.();
    server.close(resolve);
  });
  return state;
}

// Every regular file under `dir` (excluding `skip` top-level names) with its sha256.
export function hashTree(dir, skip = []) {
  const out = {};
  const walk = (path, rel) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && skip.includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) out[relPath] = createHash('sha256').update(readFileSync(full)).digest('hex');
      else if (entry.isSymbolicLink()) out[relPath] = 'symlink';
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

export const MANAGED_ENTRIES = ['versions', 'current', 'update-state.json', 'update.lock'];
