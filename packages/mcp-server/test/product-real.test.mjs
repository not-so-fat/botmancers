// The real packaged app (app/, assembled by `npm run build:app`) under the
// supervisor: state is rooted in BOTMANCERS_HOME whatever the launch cwd, an
// Agent, its conversation, and files survive stop/start from a different
// cwd, the bridge reaches the same engine, and an explicit
// BOTMANCERS_DB_PATH still overrides the home default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_DIR, cli, freePort } from '../scripts/product-harness.mjs';
import { rpc } from '../scripts/harness.mjs';

const APP = join(PACKAGE_DIR, 'app');
const built = existsSync(join(APP, 'server.js'));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('real app: home-rooted state survives stop/start from two cwds; the bridge reaches the same engine', { skip: !built && 'app/ is not built: run npm run build:app' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-real-')));
  const home = join(root, 'home');
  const cwdA = join(root, 'cwd-a');
  const cwdB = join(root, 'cwd-b');
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  const ui = await freePort();
  let mcp = await freePort();
  while (mcp === ui) mcp = await freePort();
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: join(root, 'user'),
    BOTMANCERS_HOME: home,
    BOTMANCERS_UI_PORT: String(ui),
    BOTMANCERS_MCP_PORT: String(mcp),
    BOTMANCERS_MCP_COORDINATORS: 'Persisto',
    ...extra,
  });
  const run = (args, cwd, extra) => cli(args, { env: env(extra), cwd });
  t.after(async () => {
    await run(['stop'], root).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${ui}`;
  const owner = { 'content-type': 'application/json', origin: base };
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: owner, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  assert.equal((await run(['setup'], cwdA)).code, 0);
  const start = await run(['start', '--daemon'], cwdA);
  assert.equal(start.code, 0, start.stderr);
  const status = await run(['status'], cwdB);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`ui/core .* ok version ${VERSION.replace(/\./g, '\\.')}`));

  const root200 = await fetch(`${base}/`);
  assert.equal(root200.status, 200);
  assert.match(await root200.text(), /<title>Botmancers/);

  const agent = await api('POST', '/api/bots', { name: 'Persisto', title: 'Persistence probe', description: 'probe', deck_id: '00000000-0000-4000-8000-000000000001' });
  assert.equal(agent.status, 200, JSON.stringify(agent.json));
  const conversation = await api('GET', `/api/conversations?botId=${agent.json.id}`);
  assert.equal(conversation.status, 200);
  const posted = await api('POST', `/api/conversations/${conversation.json.id}/messages`, { content: 'hello persisted' });
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  assert.equal((await api('PUT', `/api/bots/${agent.json.id}/skill`, { content: '# Persisto skill\n' })).status, 200);
  writeFileSync(join(home, 'files', 'note.txt'), 'kept across restarts\n');
  assert.equal((await fetch(`${base}/api/files/note.txt`)).status, 200);

  // /api/v0 is the packaged engine behind service-token auth.
  const { BOTMANCERS_SERVICE_TOKEN: service, BOTMANCERS_MCP_TOKEN: mcpToken } = Object.fromEntries(
    readFileSync(join(home, 'config/bridge.env'), 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')));
  const v0 = await fetch(`${base}/api/v0/conversations/${conversation.json.id}`, { headers: { authorization: `Bearer ${service}` } });
  const v0Body = await v0.json();
  assert.ok([403, 404].includes(v0.status), `service principal is not a participant: ${v0.status} ${JSON.stringify(v0Body)}`);
  assert.equal((await fetch(`${base}/api/v0/conversations/${conversation.json.id}`, { headers: { authorization: 'Bearer wrong-token-0123456789' } })).status, 401);

  // The bridge reaches the same engine: the coordinator created in the UI is available.
  const health = await rpc(`http://127.0.0.1:${mcp}/mcp`, mcpToken, 'tools/call', { name: 'botmancers_health', arguments: {} });
  assert.deepEqual(health.json.result.structuredContent.coordinators, [{ name: 'Persisto', available: true }]);

  for (const path of ['data/botmancers.db', 'data/botmancers.db-wal', 'skills/Persisto/SKILL.md', 'files/note.txt', 'logs/core.log', 'logs/bridge.log', 'logs/supervisor.log', 'run/product.json', 'config/core.env', 'config/bridge.env']) {
    assert.ok(existsSync(join(home, path)), `${path} under the home`);
  }
  assert.equal((await run(['stop'], cwdA)).code, 0);
  assert.ok(!existsSync(join(home, 'run/product.json')));

  const restart = await run(['start', '--daemon'], cwdB);
  assert.equal(restart.code, 0, restart.stderr);
  const bots = await api('GET', '/api/bots');
  assert.ok(bots.json.some(bot => bot.id === agent.json.id && bot.name === 'Persisto'), 'Agent survived the restart');
  const reopened = await api('GET', `/api/conversations?botId=${agent.json.id}`);
  assert.equal(reopened.json.id, conversation.json.id);
  const history = await api('GET', `/api/conversations/${conversation.json.id}/messages`);
  assert.ok(JSON.stringify(history.json).includes('hello persisted'), 'conversation message survived the restart');
  const file = await fetch(`${base}/api/files/note.txt`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'kept across restarts\n');
  assert.equal(readFileSync(join(home, 'skills/Persisto/SKILL.md'), 'utf8'), '# Persisto skill\n');
  assert.equal((await run(['stop'], cwdB)).code, 0);

  for (const cwd of [cwdA, cwdB]) assert.deepEqual(readdirSync(cwd), [], `nothing written to ${cwd}`);

  // An explicit existing path variable still wins over the home default.
  const override = join(root, 'explicit', 'override.db');
  mkdirSync(join(root, 'explicit'));
  const explicit = await run(['start', '--daemon'], cwdA, { BOTMANCERS_DB_PATH: override });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.ok(existsSync(override), 'BOTMANCERS_DB_PATH honored');
  const fresh = await api('GET', '/api/bots');
  assert.ok(!fresh.json.some(bot => bot.id === agent.json.id), 'the override database is a different store');
  assert.equal((await run(['stop'], cwdA)).code, 0);
});
