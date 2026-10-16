// Package boundary: tarball contents allowlist, contract schema parity with
// the Botmancers app, and the README install checklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { checkManifest, packManifest } from '../scripts/check-pack.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));

test('npm pack contains only the allowlisted runtime files', () => {
  const entry = packManifest();
  assert.deepEqual(checkManifest(entry), []);
  const paths = entry.files.map(file => file.path);
  for (const forbidden of [/^src\//, /^test\//, /^scripts\//, /\.env/, /\.db/, /\.log$/, /\.tgz$/, /node_modules/, /tsconfig/]) {
    assert.ok(!paths.some(path => forbidden.test(path)), `${forbidden} in ${paths}`);
  }
});

test('the allowlist rejects unrelated content', () => {
  const entry = packManifest();
  const problems = checkManifest({ ...entry, files: [...entry.files, { path: 'src/server.ts' }, { path: '.env' }, { path: 'botmancers.db' }] });
  assert.ok(problems.includes('not allowlisted: src/server.ts'));
  assert.ok(problems.includes('not allowlisted: .env'));
  assert.ok(problems.includes('not allowlisted: botmancers.db'));
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
  ];
  const missing = checklist.filter(([pattern]) => !pattern.test(readme)).map(([, label]) => label);
  assert.deepEqual(missing, []);
});
