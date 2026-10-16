// Builds the Botmancers app (repository root) as a standalone Next.js server
// and assembles it into packages/mcp-server/app/, the UI/API/core-engine
// runtime the botmancers package ships next to the MCP bridge.
//
//   node scripts/build-app.mjs              next build + assemble
//   node scripts/build-app.mjs --skip-next  assemble from an existing .next/standalone
//
// The assembly is an allowlist, not a copy of the traced output: Next traces
// the whole checkout (tests, docs, a local botmancers.db) because the engine
// touches the filesystem dynamically, so only server.js, .next, the traced
// node_modules, static assets and public/ are taken. better-sqlite3 is
// replaced by its full package so every platform's prebuilt binary ships;
// sharp is left out (the package build serves images unoptimized). Symlinks,
// which npm drops from tarballs, become require shims, and the checkout's
// absolute path is scrubbed from the output.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
export const APP_DIR = join(PACKAGE_DIR, 'app');

// Traced packages that are not shipped: sharp and its platform binaries.
const SKIPPED_MODULES = new Set(['sharp', '@img', 'detect-libc']);
const BETTER_SQLITE3_FILES = ['package.json', 'LICENSE', 'lib', 'prebuilds'];
const TEXT_FILE = /\.(?:js|cjs|mjs|json|html|rsc|txt|css|meta|body)$/;

function log(line) {
  process.stdout.write(`build-app: ${line}\n`);
}

function gitCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

function nextBuild(version, commit) {
  const envFile = join(REPO_ROOT, 'next-env.d.ts');
  const envBefore = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
  log(`next build (standalone) for botmancers@${version} at ${commit}`);
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        BOTMANCERS_STANDALONE: '1',
        BOTMANCERS_BUILD_VERSION: version,
        BOTMANCERS_BUILD_COMMIT: commit,
        // Page-data collection imports lib/db in parallel workers: give each an
        // in-memory database instead of the checkout's botmancers.db.
        BOTMANCERS_DB_PATH: ':memory:',
        BOTMANCERS_HOME: '',
        BOTMANCERS_NO_AUTOPROCESS: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    });
  } finally {
    // next build rewrites next-env.d.ts; keep the checkout clean.
    if (envBefore !== null && readFileSync(envFile, 'utf8') !== envBefore) writeFileSync(envFile, envBefore);
  }
}

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    visit(path, stat);
    if (stat.isDirectory()) walk(path, visit);
  }
}

// A turbopack external like .next/node_modules/better-sqlite3-<hash> is a
// symlink to the real package; npm would drop it, so make it a shim package.
function replaceSymlinks(root) {
  const links = [];
  walk(root, (path, stat) => { if (stat.isSymbolicLink()) links.push(path); });
  for (const link of links) {
    const target = readlinkSync(link);
    const parts = target.split(/[\\/]/);
    const at = parts.lastIndexOf('node_modules');
    const name = parts.slice(at + 1).join('/');
    if (at < 0 || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`cannot shim symlink ${relative(root, link)} -> ${target}`);
    unlinkSync(link);
    mkdirSync(link);
    writeFileSync(join(link, 'package.json'), `${JSON.stringify({ name: link.split(sep).pop(), private: true, main: 'index.js' })}\n`);
    writeFileSync(join(link, 'index.js'), `module.exports = require(${JSON.stringify(name)});\n`);
    log(`shimmed ${relative(root, link)} -> require('${name}')`);
  }
}

// The checkout path must not ship (it is the builder's home directory and
// nothing at runtime may depend on it). server.js gets __dirname, JSON ".".
function scrubRepoPath(root) {
  const needle = REPO_ROOT.endsWith(sep) ? REPO_ROOT.slice(0, -1) : REPO_ROOT;
  let scrubbed = 0;
  walk(root, (path, stat) => {
    if (!stat.isFile() || !TEXT_FILE.test(path) || stat.size > 20 * 1024 * 1024) return;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(needle)) return;
    let next = text;
    if (path === join(root, 'server.js')) next = next.split(JSON.stringify(needle)).join('__dirname');
    next = next.split(JSON.stringify(needle)).join('"."').split(needle).join('.');
    writeFileSync(path, next);
    scrubbed++;
  });
  return scrubbed;
}

export function assemble({ version, commit, dirty }) {
  const standalone = join(REPO_ROOT, '.next/standalone');
  if (!existsSync(join(standalone, 'server.js'))) throw new Error('.next/standalone/server.js is missing; run without --skip-next');
  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });

  cpSync(join(standalone, 'server.js'), join(APP_DIR, 'server.js'));
  cpSync(join(standalone, '.next'), join(APP_DIR, '.next'), { recursive: true, filter: src => !src.endsWith('.map') && !src.includes(`${sep}cache${sep}`) });
  mkdirSync(join(APP_DIR, 'node_modules'));
  for (const name of readdirSync(join(standalone, 'node_modules'))) {
    if (SKIPPED_MODULES.has(name) || name.startsWith('.')) continue;
    cpSync(join(standalone, 'node_modules', name), join(APP_DIR, 'node_modules', name), { recursive: true, filter: src => !src.endsWith('.map') });
  }
  const sqlite = join(APP_DIR, 'node_modules/better-sqlite3');
  rmSync(sqlite, { recursive: true, force: true });
  for (const entry of BETTER_SQLITE3_FILES) cpSync(join(REPO_ROOT, 'node_modules/better-sqlite3', entry), join(sqlite, entry), { recursive: true });
  cpSync(join(REPO_ROOT, '.next/static'), join(APP_DIR, '.next/static'), { recursive: true, filter: src => !src.endsWith('.map') });
  cpSync(join(REPO_ROOT, 'public'), join(APP_DIR, 'public'), { recursive: true, filter: src => !src.split(sep).pop().startsWith('.') });
  replaceSymlinks(APP_DIR);

  // The outer package is "type": "module"; the standalone server is CommonJS.
  writeFileSync(join(APP_DIR, 'package.json'), `${JSON.stringify({ name: 'botmancers-app', version, private: true, type: 'commonjs' }, null, 2)}\n`);
  const nextVersion = JSON.parse(readFileSync(join(APP_DIR, 'node_modules/next/package.json'), 'utf8')).version;
  writeFileSync(join(APP_DIR, 'BUILD_INFO.json'), `${JSON.stringify({ name: 'botmancers', version, commit, dirty, next: nextVersion }, null, 2)}\n`);
  const scrubbed = scrubRepoPath(APP_DIR);
  log(`scrubbed the checkout path from ${scrubbed} file(s)`);

  let files = 0;
  let bytes = 0;
  walk(APP_DIR, (path, stat) => {
    if (!stat.isFile()) return;
    files++;
    bytes += stat.size;
  });
  log(`assembled ${relative(PACKAGE_DIR, APP_DIR)}/: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB (next ${nextVersion})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const { sha, dirty } = gitCommit();
  if (!process.argv.includes('--skip-next')) nextBuild(version, sha);
  assemble({ version, commit: sha, dirty });
  if (!statSync(join(APP_DIR, 'server.js')).isFile()) process.exit(1);
}
