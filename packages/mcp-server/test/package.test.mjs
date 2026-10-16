// Package boundary: tarball contents allowlist (bridge plus the packaged
// UI/core runtime), contract schema parity with the Botmancers app, the
// unchanged library surface, and the README install checklist. Requires
// `npm run build:app` (check-pack needs app/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { checkManifest, packManifest } from '../scripts/check-pack.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));

const entry = packManifest();
const paths = entry.files.map(file => file.path);

test('npm pack contains only the allowlisted runtime files', () => {
  assert.deepEqual(checkManifest(entry), []);
  for (const forbidden of [/^src\//, /^test\//, /^scripts\//, /\.env/, /\.db/, /\.log$/, /\.tgz$/, /^(?!app\/)(?:.*\/)?node_modules\//, /tsconfig/, /^app\/(?:lib|docs|files|skills|scripts|test-support)\//, /^app\/test-/, /\.temporal/]) {
    assert.ok(!paths.some(path => forbidden.test(path)), `${forbidden} matched`);
  }
});

test('the tarball carries the production UI/core runtime next to the bridge', () => {
  for (const path of ['app/server.js', 'app/.next/BUILD_ID', 'app/.next/server/app/api/health/route.js', 'app/node_modules/next/package.json', 'app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node', 'app/node_modules/better-sqlite3/prebuilds/linux-x64.node', 'dist/cli.js', 'dist/index.js']) {
    assert.ok(paths.includes(path), path);
  }
  assert.ok(paths.some(path => path.startsWith('app/.next/static/')), 'static assets');
  assert.ok(paths.some(path => path.startsWith('app/public/brand/')), 'public assets');
  assert.ok(!paths.some(path => /^app\/node_modules\/(?:sharp|@img)\//.test(path)), 'no platform-specific sharp binaries');
  const info = JSON.parse(read('../app/BUILD_INFO.json'));
  assert.equal(info.version, pkg.version);
  assert.match(info.commit, /^[0-9a-f]{40}$|^unknown$/);
});

test('the allowlist rejects unrelated content', () => {
  const extra = ['src/server.ts', '.env', 'botmancers.db', 'app/botmancers.db', 'app/.env.local', 'app/lib/db.ts', 'app/files/x.txt', 'app/.next/server/x.js.map', 'app/node_modules/x/logs/a.log', 'app/.next/core.env'];
  const problems = checkManifest({ ...entry, files: [...entry.files, ...extra.map(path => ({ path }))] });
  for (const path of ['src/server.ts', '.env', 'botmancers.db', 'app/botmancers.db', 'app/.env.local', 'app/lib/db.ts', 'app/files/x.txt']) {
    assert.ok(problems.includes(`not allowlisted: ${path}`), path);
  }
  for (const path of ['app/botmancers.db', 'app/.env.local', 'app/.next/server/x.js.map', 'app/node_modules/x/logs/a.log', 'app/.next/core.env']) {
    assert.ok(problems.some(problem => problem.startsWith('forbidden') && problem.endsWith(`: ${path}`)), path);
  }
  assert.ok(problems.includes('forbidden (TypeScript source): app/lib/db.ts'));
});

test('the bridge library surface is unchanged', async () => {
  const lib = await import('../dist/index.js');
  for (const name of ['MCP_CONTRACT', 'MCP_PROTOCOL_VERSIONS', 'TOOL_SCHEMA_URL', 'loadToolContract', 'negotiateProtocolVersion', 'packageVersion',
    'DEFAULT_HOST', 'DEFAULT_PORT', 'ENV', 'ConfigError', 'isLoopbackHost', 'parseBotmancersUrl', 'parseCli', 'createRedactor', 'REDACTED',
    'UPSTREAM_PATH', 'UpstreamError', 'createUpstream', 'HEALTH_PATH', 'MAX_BODY_BYTES', 'MCP_PATH', 'createBridge', 'EXIT', 'main']) {
    assert.ok(name in lib, `export ${name}`);
  }
  assert.deepEqual(lib.EXIT, { ok: 0, config: 2, listen: 3, unavailable: 4, credentials: 5 });
  assert.equal(lib.DEFAULT_PORT, 43124);
  assert.equal(lib.loadToolContract().contract, 'botmancers.mcp.v1');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './schemas/botmancers.mcp.v1.tools.json', './package.json']);
});

test('the bundled schema is the contract the Botmancers app serves', () => {
  const appContract = new URL('../../../docs/contracts/mcp-bridge-v1.tools.json', import.meta.url);
  if (!existsSync(appContract)) return; // outside the monorepo
  assert.deepEqual(JSON.parse(read('../schemas/botmancers.mcp.v1.tools.json')), JSON.parse(readFileSync(appContract, 'utf8')));
});

test('the manifest is a public package distinct from the private app', () => {
  const root = JSON.parse(read('../../../package.json'));
  assert.equal(root.private, true);
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.name, 'botmancers');
  assert.deepEqual(pkg.bin, { botmancers: 'dist/cli.js' });
  assert.match(pkg.engines.node, />=\s*20/);
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.publishConfig.access, 'public');
});

test('README documents the install, configuration, exposure, upgrade, and uninstall path', () => {
  const readme = read('../README.md');
  const checklist = [
    [/^\s*BOTMANCERS_URL=\S+ npx botmancers$/m, 'copy-paste npx botmancers command'],
    [new RegExp(`npx botmancers@${pkg.version.replace(/\./g, '\\.')}\\b`), 'pinned-version example for the current version'],
    [/`BOTMANCERS_URL`/, 'BOTMANCERS_URL'],
    [/`BOTMANCERS_SERVICE_TOKEN`/, 'BOTMANCERS_SERVICE_TOKEN'],
    [/`BOTMANCERS_MCP_TOKEN`/, 'BOTMANCERS_MCP_TOKEN'],
    [/`BOTMANCERS_MCP_HOST`/, 'BOTMANCERS_MCP_HOST'],
    [/`BOTMANCERS_MCP_PORT`/, 'BOTMANCERS_MCP_PORT'],
    [/\*\*Loopback by default\.\*\* The bridge binds `127\.0\.0\.1`/, 'loopback-only default binding'],
    [/HTTPS endpoint[\s\S]*private network/, 'HTTPS/private-network expectations for remote consumers'],
    [/^## Upgrade$/m, 'upgrade section'],
    [/^## Uninstall$/m, 'uninstall section'],
    [/npm uninstall botmancers/, 'uninstall command'],
    [/Node\.js 20/, 'Node engine'],
    [/^\s*npx botmancers setup$/m, 'full-product setup command'],
    [/^\s*npx botmancers start --daemon --open$/m, 'full-product start command'],
    [/`botmancers (?:stop|status|doctor|open)`/, 'lifecycle commands'],
    [/`BOTMANCERS_HOME`/, 'BOTMANCERS_HOME'],
    [/`botmancers mcp`/, 'explicit bridge-only command'],
  ];
  const missing = checklist.filter(([pattern]) => !pattern.test(readme)).map(([, label]) => label);
  assert.deepEqual(missing, []);
});
