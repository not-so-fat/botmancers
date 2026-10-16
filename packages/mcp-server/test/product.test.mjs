// The product commands (setup/start/stop/status/doctor/open) and the
// supervisor, against a fake packaged app so every failure mode is fast and
// deterministic: exit codes, stdout/stderr, redaction, process cleanup,
// stale run metadata, version/health states, and setup's credentials.
// The real packaged app is exercised by product-real.test.mjs and the
// product install smoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cli, freePort, listenOn, makeFakeApp, pidAlive, waitFor } from '../scripts/product-harness.mjs';
import { mcpPost, rpc } from '../scripts/harness.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SENTINEL_HERMES = 'hermes-SENTINEL-0123456789abcdef';
const SENTINEL_DECK = 'deck-SENTINEL-0123456789abcdef';
const SENTINEL_CURSOR = 'cursor-SENTINEL-0123456789abcdef';

async function sandbox(t, { version = VERSION } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-product-')));
  const home = join(root, 'home');
  const app = makeFakeApp(join(root, 'app'), { version });
  const ui = await freePort();
  let mcp = await freePort();
  while (mcp === ui) mcp = await freePort();
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: join(root, 'user'),
    BOTMANCERS_HOME: home,
    BOTMANCERS_APP_DIR: app,
    BOTMANCERS_UI_PORT: String(ui),
    BOTMANCERS_MCP_PORT: String(mcp),
    BOTMANCERS_STARTUP_TIMEOUT_MS: '15000',
    BOTMANCERS_AGENT_DECK_URL: `http://127.0.0.1:${mcp}`,
    ...extra,
  });
  const run = (args, extra = {}, options = {}) => cli(args, { env: env(extra), cwd: options.cwd ?? root });
  t.after(async () => {
    await run(['stop']).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, app, ui, mcp, env, run, runFile: join(home, 'run/product.json') };
}

function tokens(home) {
  const text = readFileSync(join(home, 'config/bridge.env'), 'utf8');
  return {
    service: /^BOTMANCERS_SERVICE_TOKEN=(\S+)$/m.exec(text)[1],
    mcp: /^BOTMANCERS_MCP_TOKEN=(\S+)$/m.exec(text)[1],
  };
}

function assertNoTokens(home, ...outputs) {
  const { service, mcp } = tokens(home);
  for (const output of outputs) {
    assert.ok(!output.includes(service), `service token leaked: ${output}`);
    assert.ok(!output.includes(mcp), `MCP token leaked: ${output}`);
  }
}

const mode = path => statSync(path).mode & 0o777;
const record = runFile => JSON.parse(readFileSync(runFile, 'utf8'));

test('setup creates an owner-only home with distinct credentials and only the service-token digest in core.env', async t => {
  const s = await sandbox(t);
  const env = { HERMES_API_SERVER_KEY: SENTINEL_HERMES, AGENT_DECK_RUN_TOKEN: SENTINEL_DECK, CURSOR_API_KEY: SENTINEL_CURSOR };
  const first = await s.run(['setup'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /initialized .* \(owner-only\)/);
  assert.match(first.stdout, /HERMES_API_SERVER_KEY=<your Hermes gateway key>/);
  assert.match(first.stdout, /AGENT_DECK_RUN_TOKEN=<token issued by Agent Deck>/);
  assert.match(first.stdout, /botmancers start --daemon/);

  assert.equal(mode(s.home), 0o700);
  for (const dir of ['config', 'data', 'files', 'skills', 'logs', 'run']) assert.equal(mode(join(s.home, dir)), 0o700, dir);
  for (const file of ['config/core.env', 'config/bridge.env']) assert.equal(mode(join(s.home, file)), 0o600, file);

  const { service, mcp } = tokens(s.home);
  assert.notEqual(service, mcp);
  assert.ok(service.length >= 64 && mcp.length >= 64);
  const core = readFileSync(join(s.home, 'config/core.env'), 'utf8');
  const digest = `sha256:${createHash('sha256').update(service).digest('hex')}`;
  assert.match(core, new RegExp(`^BOTMANCERS_SERVICE_TOKENS=botmancers-bridge=${digest}$`, 'm'));
  assert.ok(!core.includes(service) && !core.includes(mcp), 'core.env holds no raw token');

  const everything = readdirSync(s.home, { recursive: true }).map(rel => join(s.home, rel)).filter(path => statSync(path).isFile()).map(path => readFileSync(path, 'utf8')).join('\n');
  for (const sentinel of [SENTINEL_HERMES, SENTINEL_DECK, SENTINEL_CURSOR]) assert.ok(!everything.includes(sentinel), `setup wrote ${sentinel}`);
  assert.ok(!/^\s*(?:HERMES_API_SERVER_KEY|AGENT_DECK_RUN_TOKEN|CURSOR_API_KEY)=/m.test(everything), 'no external credential lines');
  assertNoTokens(s.home, first.stdout, first.stderr);

  // Re-running keeps the credentials and the operator's own lines, and re-tightens modes.
  writeFileSync(join(s.home, 'config/core.env'), `${core}HERMES_BASE_URL=http://127.0.0.1:9999\n`);
  chmodSync(join(s.home, 'config/core.env'), 0o644);
  const again = await s.run(['setup']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already set up/);
  assert.deepEqual(tokens(s.home), { service, mcp });
  assert.match(readFileSync(join(s.home, 'config/core.env'), 'utf8'), /^HERMES_BASE_URL=http:\/\/127\.0\.0\.1:9999$/m);
  assert.equal(mode(join(s.home, 'config/core.env')), 0o600);
});

test('setup into an unwritable location exits 9 without a stack trace', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async t => {
  const s = await sandbox(t);
  const locked = join(s.root, 'locked');
  mkdirSync(locked, { mode: 0o500 });
  t.after(() => { try { chmodSync(locked, 0o700); } catch { /* already removed */ } });
  const result = await s.run(['setup'], { BOTMANCERS_HOME: join(locked, 'home') });
  assert.equal(result.code, 9);
  assert.match(result.stderr, /cannot write BOTMANCERS_HOME .*locked\/home \(EACCES\)/);
  assert.ok(!/\n\s+at /.test(result.stderr), 'no stack trace');

  // start against a home that exists but is read-only is distinguished from "not set up".
  assert.equal((await s.run(['setup'])).code, 0);
  chmodSync(join(s.home, 'run'), 0o500);
  t.after(() => { try { chmodSync(join(s.home, 'run'), 0o700); } catch { /* already removed */ } });
  const start = await s.run(['start', '--daemon']);
  assert.equal(start.code, 9);
  assert.match(start.stderr, /is not writable \(EACCES\)/);
});

test('start before setup exits 10; a packaged app with missing assets exits 8 and doctor names them', async t => {
  const s = await sandbox(t);
  const before = await s.run(['start', '--daemon']);
  assert.equal(before.code, 10);
  assert.match(before.stderr, /does not exist\. Run: botmancers setup/);

  assert.equal((await s.run(['setup'])).code, 0);
  const empty = join(s.root, 'empty-app');
  mkdirSync(empty);
  const start = await s.run(['start', '--daemon'], { BOTMANCERS_APP_DIR: empty });
  assert.equal(start.code, 8);
  assert.match(start.stderr, /packaged app .* is incomplete \(missing server\.js, package\.json, BUILD_INFO\.json, \.next\/BUILD_ID/);
  assert.ok(!existsSync(s.runFile));
  const doctor = await s.run(['doctor'], { BOTMANCERS_APP_DIR: empty });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /^ {2}fail {2}assets {6}packaged app .* is missing server\.js/m);
  assert.match(doctor.stdout, /^result: FAILED/m);
});

test('start --daemon supervises core and bridge; status, repeated start, open, MCP auth, degraded child, stop', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const start = await s.run(['start', '--daemon']);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, new RegExp(`botmancers ${VERSION.replace(/\./g, '\\.')}: running\\n {2}UI {3}http://127\\.0\\.0\\.1:${s.ui}\\n {2}MCP {2}http://127\\.0\\.0\\.1:${s.mcp}/mcp`));
  const first = record(s.runFile);
  assert.equal(first.state, 'running');
  assert.equal(mode(s.runFile), 0o600);
  for (const pid of [first.supervisor.pid, first.ui.pid, first.mcp.pid]) assert.ok(pidAlive(pid), `pid ${pid} alive`);

  const status = await s.run(['status']);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`^botmancers ${VERSION.replace(/\./g, '\\.')}: healthy$`, 'm'));
  assert.match(status.stdout, new RegExp(`ui/core {5}http://127\\.0\\.0\\.1:${s.ui} {2}ok version ${VERSION.replace(/\./g, '\\.')} \\(pid ${first.ui.pid}\\)`));
  assert.match(status.stdout, new RegExp(`mcp bridge {2}http://127\\.0\\.0\\.1:${s.mcp}/mcp {2}ok version ${VERSION.replace(/\./g, '\\.')} \\(pid ${first.mcp.pid}\\)`));
  assert.match(status.stdout, /bridge→core ok \(service:botmancers-bridge\)/);

  // The core received the digest and the home, never the raw bridge tokens.
  const coreEnv = JSON.parse(readFileSync(join(s.home, 'logs/fake-core-env.json'), 'utf8'));
  assert.equal(coreEnv.BOTMANCERS_HOME, s.home);
  assert.match(coreEnv.BOTMANCERS_SERVICE_TOKENS, /^botmancers-bridge=sha256:[0-9a-f]{64}$/);
  assert.equal(coreEnv.BOTMANCERS_SERVICE_TOKEN, undefined);
  assert.equal(coreEnv.BOTMANCERS_MCP_TOKEN, undefined);

  const again = await s.run(['start', '--daemon']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already running/);
  assert.deepEqual(record(s.runFile).supervisor, first.supervisor);

  // The generated bridge credential authenticates; a wrong one does not.
  const { mcp: mcpToken } = tokens(s.home);
  const ok = await rpc(`http://127.0.0.1:${s.mcp}/mcp`, mcpToken, 'tools/call', { name: 'botmancers_health', arguments: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result.structuredContent.principal.id, 'botmancers-bridge');
  const wrong = await mcpPost(`http://127.0.0.1:${s.mcp}/mcp`, { token: `${mcpToken}x`, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(wrong.status, 401);

  const opened = join(s.root, 'opened.txt');
  const browser = join(s.root, 'browser.sh');
  writeFileSync(browser, `#!/bin/sh\necho "$1" > ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  const open = await s.run(['open'], { BOTMANCERS_BROWSER: browser });
  assert.equal(open.code, 0, open.stderr);
  assert.match(open.stdout, new RegExp(`opened http://127\\.0\\.0\\.1:${s.ui}`));
  assert.ok(await waitFor(() => existsSync(opened)));
  assert.equal(readFileSync(opened, 'utf8').trim(), `http://127.0.0.1:${s.ui}`);

  // One child down: degraded (exit 1), and start refuses to call it healthy.
  process.kill(first.mcp.pid, 'SIGKILL');
  assert.ok(await waitFor(() => !pidAlive(first.mcp.pid)));
  const degraded = await s.run(['status']);
  assert.equal(degraded.code, 1);
  assert.match(degraded.stdout, /: degraded$/m);
  assert.match(degraded.stdout, new RegExp(`problem {5}bridge \\(pid ${first.mcp.pid}\\) is not running`));
  assert.match(degraded.stdout, /fix {9}botmancers stop && botmancers start --daemon/);
  const blocked = await s.run(['start', '--daemon']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /previous start is degraded/);
  const doctor = await s.run(['doctor']);
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /fail {2}product {5}running but degraded: .*bridge/);

  const stop = await s.run(['stop']);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, new RegExp(`stopped \\(supervisor pid ${first.supervisor.pid}, core pid ${first.ui.pid}\\)`));
  assert.ok(await waitFor(() => !pidAlive(first.supervisor.pid) && !pidAlive(first.ui.pid)));
  assert.ok(!existsSync(s.runFile));
  const stopAgain = await s.run(['stop']);
  assert.equal(stopAgain.code, 0);
  assert.match(stopAgain.stdout, /not running/);
  const stopped = await s.run(['status']);
  assert.equal(stopped.code, 3);
  assert.match(stopped.stdout, /: stopped$/m);
  const openStopped = await s.run(['open'], { BOTMANCERS_BROWSER: browser });
  assert.equal(openStopped.code, 3);

  const log = readFileSync(join(s.home, 'logs/supervisor.log'), 'utf8');
  assert.match(log, /bridge \(pid \d+\) exited unexpectedly/);
  assertNoTokens(s.home, start.stdout, start.stderr, status.stdout, degraded.stdout, stop.stdout, doctor.stdout, log,
    readFileSync(join(s.home, 'logs/bridge.log'), 'utf8'), readFileSync(join(s.home, 'logs/core.log'), 'utf8'));
});

test('a mismatched core version is degraded, never healthy', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const start = await s.run(['start', '--daemon'], { FAKE_APP_VERSION: '9.9.9-other' });
  assert.equal(start.code, 0, start.stderr);
  const status = await s.run(['status']);
  assert.equal(status.code, 1);
  assert.match(status.stdout, /: degraded$/m);
  assert.match(status.stdout, new RegExp(`problem {5}version mismatch: core reports 9\\.9\\.9-other, installed ${VERSION.replace(/\./g, '\\.')}`));
  assert.equal((await s.run(['stop'])).code, 0);
});

test('a core that dies at startup exits 7 and leaves nothing running', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const start = await s.run(['start', '--daemon'], { FAKE_APP_MODE: 'exit' });
  assert.equal(start.code, 7);
  assert.match(start.stderr, /degraded start: the core exited \(1\); nothing left running/);
  assert.match(start.stderr, /fake core: failing at startup on purpose/);
  assert.ok(!existsSync(s.runFile));
  assert.equal((await s.run(['status'])).code, 3);
  assertNoTokens(s.home, start.stdout, start.stderr);
});

test('a bridge that cannot authenticate to the core exits 7 and the core is stopped too', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const start = await s.run(['start', '--daemon'], { FAKE_APP_MODE: 'reject-mcp' });
  assert.equal(start.code, 7);
  assert.match(start.stderr, /degraded start: the core started but the bridge exited \(5\); stopped the core too/);
  assert.match(start.stderr, /rejected the service token/);
  assert.ok(!existsSync(s.runFile));
  const log = readFileSync(join(s.home, 'logs/supervisor.log'), 'utf8');
  const corePid = Number(/core healthy at \S+ \(pid (\d+)\)/.exec(log)[1]);
  assert.ok(await waitFor(() => !pidAlive(corePid)), 'core process cleaned up');
  assert.ok(!(await listenOn(s.ui).then(server => (server.close(), false)).catch(() => true)), 'UI port released');
  assertNoTokens(s.home, start.stdout, start.stderr, log);
});

test('occupied ports are reported by start (exit 6) and doctor', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  for (const [port, label] of [[s.ui, 'UI/core'], [s.mcp, 'MCP bridge']]) {
    const blocker = await listenOn(port);
    const start = await s.run(['start', '--daemon']);
    assert.equal(start.code, 6, `${label}: ${start.stderr}`);
    assert.match(start.stderr, new RegExp(`port ${port} on 127\\.0\\.0\\.1 \\(${label}\\) is in use by another process`));
    const doctor = await s.run(['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, new RegExp(`fail {2}ports {7}port ${port} on 127\\.0\\.0\\.1 is in use by another process`));
    await new Promise(resolve => blocker.close(resolve));
    assert.ok(!existsSync(s.runFile));
  }
});

test('stale run metadata is repaired, and a recycled PID is never signalled', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('exit', resolve));
  const stale = (pid, extra = {}) => writeFileSync(s.runFile, JSON.stringify({
    schema: 1, version: VERSION, home: s.home, appDir: s.app, state: 'running', startedAt: new Date().toISOString(),
    supervisor: { pid }, ui: { pid: null, port: s.ui, url: `http://127.0.0.1:${s.ui}` }, mcp: { pid: null, port: s.mcp, url: `http://127.0.0.1:${s.mcp}/mcp` }, ...extra,
  }));

  stale(dead.pid);
  const status = await s.run(['status']);
  assert.equal(status.code, 3);
  assert.match(status.stdout, new RegExp(`note {8}removed stale run metadata \\(supervisor pid ${dead.pid} is not running\\)`));
  assert.ok(!existsSync(s.runFile));

  // A live but unrelated process holding a recorded PID survives stop.
  const unrelated = spawn('sleep', ['30']);
  t.after(() => unrelated.kill('SIGKILL'));
  stale(unrelated.pid, { ui: { pid: unrelated.pid, port: s.ui, url: `http://127.0.0.1:${s.ui}` } });
  const stop = await s.run(['stop']);
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /removed stale run metadata/);
  assert.ok(pidAlive(unrelated.pid), 'unrelated process untouched');

  // Another Next.js server that inherited the recorded core PID: its command
  // line looks like a core, but its start time is not the recorded one.
  const next = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'next-server']);
  t.after(() => next.kill('SIGKILL'));
  await waitFor(() => pidAlive(next.pid));
  stale(dead.pid, { ui: { pid: next.pid, started: 'Thu Jan 1 00:00:00 2026', port: s.ui, url: `http://127.0.0.1:${s.ui}` } });
  const recycled = await s.run(['stop']);
  assert.equal(recycled.code, 0, recycled.stderr);
  assert.match(recycled.stdout, /removed stale run metadata/);
  assert.ok(!existsSync(s.runFile));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(pidAlive(next.pid), 'recycled next-server PID untouched');

  // Without a recorded start time the identity cannot be verified: fail closed.
  stale(dead.pid, { ui: { pid: next.pid, port: s.ui, url: `http://127.0.0.1:${s.ui}` } });
  const legacy = await s.run(['stop']);
  assert.equal(legacy.code, 1);
  assert.match(legacy.stderr, new RegExp(`cannot verify that core pid ${next.pid} is botmancers .*not signalled`));
  assert.match(legacy.stderr, /run metadata kept in .*product\.json; retry with botmancers stop/);
  assert.ok(existsSync(s.runFile), 'metadata kept');
  const legacyStatus = await s.run(['status']);
  assert.equal(legacyStatus.code, 1);
  assert.match(legacyStatus.stdout, /problem {5}cannot verify that core pid/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(pidAlive(next.pid), 'unverifiable PID untouched');
  rmSync(s.runFile);

  // start repairs stale metadata and proceeds.
  stale(dead.pid);
  const start = await s.run(['start', '--daemon']);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stderr, /removed stale run metadata/);
  const running = record(s.runFile);
  for (const entry of [running.supervisor, running.ui, running.mcp]) assert.match(entry.started, /^\w{3} \w{3} \d+ \d\d:\d\d:\d\d \d{4}$/);
  assert.equal((await s.run(['status'])).code, 0);

  // Where process identity cannot be checked (no ps), stop signals nothing
  // and keeps the run record; the product keeps running and a later stop works.
  const blind = await s.run(['stop'], { PATH: join(s.root, 'no-ps') });
  assert.equal(blind.code, 1);
  assert.match(blind.stderr, /cannot verify that supervisor pid \d+, core pid \d+, bridge pid \d+ are botmancers/);
  assert.deepEqual(record(s.runFile).supervisor, running.supervisor);
  for (const pid of [running.supervisor.pid, running.ui.pid, running.mcp.pid]) assert.ok(pidAlive(pid), `pid ${pid} still running`);
  const after = await s.run(['status']);
  assert.equal(after.code, 0, after.stdout);
  const stop2 = await s.run(['stop']);
  assert.equal(stop2.code, 0, stop2.stderr);
  assert.ok(await waitFor(() => ![running.supervisor.pid, running.ui.pid, running.mcp.pid].some(pidAlive)));
  assert.ok(!existsSync(s.runFile));
});

test('doctor distinguishes missing Hermes configuration and unavailable Agent Deck without printing secrets', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const bare = await s.run(['doctor'], { PATH: '/usr/bin:/bin' });
  assert.equal(bare.code, 0, bare.stdout);
  assert.match(bare.stdout, /^ {2}warn {2}hermes {6}Hermes is not configured: .*HERMES_API_SERVER_KEY/m);
  assert.match(bare.stdout, /^ {2}warn {2}agent-deck {2}Agent Deck is unavailable: `agent-deck` is not on PATH/m);
  assert.match(bare.stdout, /^ {2}ok {4}config/m);
  assert.match(bare.stdout, /^ {2}ok {4}ports/m);
  assert.match(bare.stdout, /^result: ok \(2 warnings\)$/m);

  const bin = join(s.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'agent-deck'), '#!/bin/sh\necho 0.0.0\n', { mode: 0o755 });
  writeFileSync(join(s.home, 'config/core.env'), `${readFileSync(join(s.home, 'config/core.env'), 'utf8')}HERMES_API_SERVER_KEY=${SENTINEL_HERMES}\nAGENT_DECK_RUN_TOKEN=${SENTINEL_DECK}\n`);
  const closed = await freePort();
  const unreachable = await s.run(['doctor'], { PATH: `${bin}:/usr/bin:/bin`, BOTMANCERS_AGENT_DECK_URL: `http://127.0.0.1:${closed}` });
  assert.equal(unreachable.code, 0);
  assert.match(unreachable.stdout, /^ {2}ok {4}hermes {6}HERMES_API_SERVER_KEY is configured/m);
  assert.match(unreachable.stdout, new RegExp(`^ {2}warn {2}agent-deck {2}Agent Deck is unavailable: .*agent-deck found, but its server at http://127\\.0\\.0\\.1:${closed} is not answering`, 'm'));

  const deck = await listenOn(await freePort());
  t.after(() => deck.close());
  const reachable = await s.run(['doctor'], { PATH: `${bin}:/usr/bin:/bin`, BOTMANCERS_AGENT_DECK_URL: `http://127.0.0.1:${deck.address().port}` });
  assert.doesNotMatch(reachable.stdout, /agent-deck .*not on PATH/);
  for (const output of [bare.stdout, unreachable.stdout, reachable.stdout]) {
    assert.ok(!output.includes(SENTINEL_HERMES) && !output.includes(SENTINEL_DECK), 'doctor printed a secret');
  }
  assertNoTokens(s.home, bare.stdout, unreachable.stdout, reachable.stdout);
});

test('product commands reject unknown arguments with exit 2 and never echo values', async t => {
  const s = await sandbox(t);
  const unknown = await s.run(['start', '--bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown argument "--bogus" for start/);
  const pasted = await s.run(['start', 'SECRET-looking-value-123456']);
  assert.equal(pasted.code, 2);
  assert.ok(!pasted.stderr.includes('SECRET-looking-value-123456'));
  const extra = await s.run(['status', 'now']);
  assert.equal(extra.code, 2);
  const badPort = await s.run(['status'], { BOTMANCERS_UI_PORT: 'tok-123456789' });
  assert.equal(badPort.code, 2);
  assert.ok(!badPort.stderr.includes('tok-123456789'));
  const help = await s.run(['start', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /start \[--daemon\] \[--open\]/);
});
