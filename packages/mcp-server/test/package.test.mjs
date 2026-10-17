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
  for (const path of ['dist/managed.js', 'dist/upgrade.js', 'app/server.js', 'app/.next/BUILD_ID', 'app/.next/server/app/api/health/route.js', 'app/node_modules/next/package.json', 'app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node', 'app/node_modules/better-sqlite3/prebuilds/linux-x64.node', 'dist/cli.js', 'dist/index.js']) {
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
  for (const name of ['MCP_CONTRACT', 'MCP_CONTRACT_V1', 'MCP_CONTRACTS', 'MCP_PROTOCOL_VERSIONS', 'TOOL_SCHEMA_URL', 'TOOL_SCHEMA_V1_URL', 'toolContractOf', 'loadToolContract', 'negotiateProtocolVersion', 'packageVersion',
    'DEFAULT_HOST', 'DEFAULT_PORT', 'ENV', 'ConfigError', 'isLoopbackHost', 'parseBotmancersUrl', 'parseCli', 'createRedactor', 'REDACTED',
    'UPSTREAM_PATH', 'UpstreamError', 'createUpstream', 'HEALTH_PATH', 'MAX_BODY_BYTES', 'MCP_PATH', 'createBridge', 'EXIT', 'main']) {
    assert.ok(name in lib, `export ${name}`);
  }
  assert.deepEqual(lib.EXIT, { ok: 0, config: 2, listen: 3, unavailable: 4, credentials: 5 });
  assert.equal(lib.DEFAULT_PORT, 43124);
  assert.equal(lib.MCP_CONTRACT, 'botmancers.mcp.v2');
  assert.deepEqual(lib.MCP_CONTRACTS, ['botmancers.mcp.v1', 'botmancers.mcp.v2']);
  assert.equal(lib.loadToolContract().contract, 'botmancers.mcp.v2');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './schemas/botmancers.mcp.v1.tools.json', './schemas/botmancers.mcp.v2.tools.json', './package.json']);
});

test('the bundled schemas are exactly the contracts the Botmancers app captures', () => {
  const appV2 = new URL('../../../docs/contracts/mcp-bridge-v2.tools.json', import.meta.url);
  const appV1 = new URL('../../../docs/contracts/mcp-bridge-v1.tools.json', import.meta.url);
  if (!existsSync(appV2)) return; // outside the monorepo
  assert.equal(read('../schemas/botmancers.mcp.v2.tools.json'), readFileSync(appV2, 'utf8'), 'v2 schema byte-identical to the app capture');
  assert.equal(read('../schemas/botmancers.mcp.v1.tools.json'), readFileSync(appV1, 'utf8'), 'frozen v1 schema byte-identical to the app capture');
});

test('the bundled v2 schema keeps every v1 tool and adds the eight v2 tools', async () => {
  const lib = await import('../dist/index.js');
  const v2 = lib.loadToolContract();
  const v1 = JSON.parse(read('../schemas/botmancers.mcp.v1.tools.json'));
  const names = v2.tools.map(tool => tool.name);
  assert.deepEqual(names.slice(0, 4), v1.tools.map(tool => tool.name));
  assert.deepEqual(names.slice(4), ['botmancers_capabilities', 'botmancers_list_agents', 'botmancers_list_sessions', 'botmancers_list_conversations',
    'botmancers_send_to_session', 'botmancers_create_exchange', 'botmancers_get_exchange', 'botmancers_list_exchanges']);
  for (const tool of v1.tools.filter(tool => tool.name !== 'botmancers_get_conversation')) assert.deepEqual(v2.tools.find(t => t.name === tool.name), tool);
  assert.deepEqual(v2.tools.map(lib.toolContractOf), [...Array(4).fill('botmancers.mcp.v1'), ...Array(8).fill('botmancers.mcp.v2')]);
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
    [/^curl -fsSL https:\/\/raw\.githubusercontent\.com\/not-so-fat\/botmancers\/main\/scripts\/install\.sh \| bash$/m, 'managed install command'],
    [/`BOTMANCERS_DISABLE_AUTOUPDATER=1`/, 'auto-updater kill switch'],
    [/botmancers upgrade --check/, 'upgrade check'],
    [/botmancers install --to /, 'rollback'],
  ];
  const missing = checklist.filter(([pattern]) => !pattern.test(readme)).map(([, label]) => label);
  assert.deepEqual(missing, []);
});

test('README documents the optional collaboration skill: when, why optional, clients, lifecycle, ownership, MCP-only', () => {
  const readme = read('../README.md');
  const section = readme.split('## Client setup and the collaboration skill')[1]?.split('\n## ')[0] ?? '';
  const checklist = [
    [/\*\*When it helps\.\*\*/, 'when the skill helps'],
    [/\*\*Why it is optional\.\*\*[\s\S]*only source of live data,\s+authorization, and actions/, 'why optional; MCP is the authority'],
    [/^### Supported clients$/m, 'supported clients'],
    [/\| Codex \| `codex` \|[\s\S]*\| Cursor \| `cursor` \|[\s\S]*\| Claude Code \| `claude` \|/, 'codex, cursor, claude rows'],
    [/^botmancers setup --client codex /m, 'install command'],
    [/\*\*Update\.\*\*[\s\S]*`botmancers setup` refreshes it/, 'update after upgrade'],
    [/^botmancers setup --client codex --remove$/m, 'removal command'],
    [/^### Managed-file ownership$/m, 'managed-file ownership'],
    [/config\/clients\/<client>\.json/, 'ownership record path'],
    [/exits 12/, 'conflict exit code'],
    [/^### MCP-only clients$/m, 'MCP-only fallback'],
  ];
  assert.deepEqual(checklist.filter(([pattern]) => !pattern.test(section)).map(([, label]) => label), []);
  assert.match(readme, /`botmancers setup --client codex\\\|cursor\\\|claude \[--remove\]`/, 'command table row');
});

test('documentation links resolve: README, the bridge doc, and the skill', () => {
  const docs = [
    new URL('../README.md', import.meta.url),
    new URL('../../../docs/mcp-bridge.md', import.meta.url),
    new URL('../skills/botmancers-collaboration/SKILL.md', import.meta.url),
    new URL('../skills/botmancers-collaboration/references/workflows.md', import.meta.url),
  ];
  const slug = heading => heading.trim().toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  const problems = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, anchor] = target.split('#');
      const resolved = file ? new URL(file, doc) : doc;
      if (!existsSync(resolved)) {
        problems.push(`${doc.pathname}: ${target} does not exist`);
        continue;
      }
      if (anchor && resolved.pathname.endsWith('.md')) {
        const headings = [...readFileSync(resolved, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]));
        if (!headings.includes(anchor)) problems.push(`${doc.pathname}: #${anchor} not found in ${resolved.pathname}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
