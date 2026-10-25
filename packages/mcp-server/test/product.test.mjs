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
import { createServer } from 'node:http';
import { cli, freePort, listenOn, makeFakeApp, pidAlive, waitFor } from '../scripts/product-harness.mjs';
import { mcpPost, rpc } from '../scripts/harness.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SENTINEL_HERMES = 'hermes-SENTINEL-0123456789abcdef';
const SENTINEL_DECK = 'deck-SENTINEL-0123456789abcdef';
const SENTINEL_CURSOR = 'cursor-SENTINEL-0123456789abcdef';

async function sandbox(t, { version = VERSION, defaultPorts = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-product-')));
  const home = join(root, 'home');
  const app = makeFakeApp(join(root, 'app'), { version });
  const ui = defaultPorts ? 3333 : await freePort();
  let mcp = defaultPorts ? 3332 : await freePort();
  while (mcp === ui) mcp = await freePort();
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: join(root, 'user'),
    BOTMANCERS_HOME: home,
    BOTMANCERS_APP_DIR: app,
    ...(defaultPorts ? {} : { BOTMANCERS_UI_PORT: String(ui), BOTMANCERS_MCP_PORT: String(mcp) }),
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

test('fresh setup, stopped status, and help agree on the default UI and MCP ports', async t => {
  const s = await sandbox(t, { defaultPorts: true });
  const setup = await s.run(['setup']);
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /UI http:\/\/127\.0\.0\.1:3333 {3}MCP http:\/\/127\.0\.0\.1:3332\/mcp/);

  const status = await s.run(['status']);
  assert.equal(status.code, 3, status.stdout);
  assert.match(status.stdout, /ui\/core {5}http:\/\/127\.0\.0\.1:3333 {2}\(not running\)/);
  assert.match(status.stdout, /mcp bridge {2}http:\/\/127\.0\.0\.1:3332\/mcp {2}\(not running\)/);

  const help = await s.run(['start', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /UI\/core on 127\.0\.0\.1:3333 and the MCP bridge\n {28}on 127\.0\.0\.1:3332/);

  const custom = await s.run(['setup'], { BOTMANCERS_UI_PORT: '43333', BOTMANCERS_MCP_PORT: '43332' });
  assert.equal(custom.code, 0, custom.stderr);
  assert.match(custom.stdout, /UI http:\/\/127\.0\.0\.1:43333 {3}MCP http:\/\/127\.0\.0\.1:43332\/mcp/);
  for (const [name, value] of [['BOTMANCERS_UI_PORT', 'bad-ui-port'], ['BOTMANCERS_MCP_PORT', 'bad-mcp-port']]) {
    const invalid = await s.run(['status'], { [name]: value });
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, new RegExp(`${name} must be an integer port`));
    assert.ok(!invalid.stderr.includes(value));
  }
});

test('setup creates an owner-only home with distinct credentials and only the service-token digest in core.env', async t => {
  const s = await sandbox(t);
  const env = { HERMES_API_SERVER_KEY: SENTINEL_HERMES, AGENT_DECK_RUN_TOKEN: SENTINEL_DECK, CURSOR_API_KEY: SENTINEL_CURSOR };
  const first = await s.run(['setup'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /initialized .* \(owner-only\)/);
  assert.match(first.stdout, /HERMES_API_SERVER_KEY=<your Hermes gateway key>/);
  assert.match(first.stdout, /AGENT_DECK_RUN_TOKEN=<token issued by Agent Deck>/);
  assert.match(first.stdout, /botmancers start --daemon/);
  assert.match(first.stdout, new RegExp(`UI http://127\\.0\\.0\\.1:${s.ui} {3}MCP http://127\\.0\\.0\\.1:${s.mcp}/mcp`), 'explicit port overrides reach setup output');

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
  for (const [port, label, variable] of [[s.ui, 'UI/core', 'BOTMANCERS_UI_PORT'], [s.mcp, 'MCP bridge', 'BOTMANCERS_MCP_PORT']]) {
    const blocker = await listenOn(port);
    const start = await s.run(['start', '--daemon']);
    assert.equal(start.code, 6, `${label}: ${start.stderr}`);
    assert.match(start.stderr, new RegExp(`port ${port} on 127\\.0\\.0\\.1 \\(${label}\\) is in use by another process`));
    assert.match(start.stderr, new RegExp(`choose another port with ${variable}`));
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

  // A present but failing ps (permission error, unsupported option) is not
  // proof that the processes are gone: status and stop both fail closed.
  const failingPs = join(s.root, 'failing-ps');
  mkdirSync(failingPs);
  writeFileSync(join(failingPs, 'ps'), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
  const failingStatus = await s.run(['status'], { PATH: failingPs });
  assert.equal(failingStatus.code, 1, failingStatus.stdout);
  assert.match(failingStatus.stdout, /problem {5}cannot verify that supervisor pid \d+, core pid \d+, bridge pid \d+ are botmancers/);
  assert.doesNotMatch(failingStatus.stdout, /removed stale run metadata/);
  const failingStop = await s.run(['stop'], { PATH: failingPs });
  assert.equal(failingStop.code, 1);
  assert.match(failingStop.stderr, /cannot verify that supervisor pid \d+, core pid \d+, bridge pid \d+ are botmancers/);
  assert.deepEqual(record(s.runFile).supervisor, running.supervisor);
  for (const pid of [running.supervisor.pid, running.ui.pid, running.mcp.pid]) assert.ok(pidAlive(pid), `pid ${pid} still running`);

  const stop2 = await s.run(['stop']);
  assert.equal(stop2.code, 0, stop2.stderr);
  assert.ok(await waitFor(() => ![running.supervisor.pid, running.ui.pid, running.mcp.pid].some(pidAlive)));
  assert.ok(!existsSync(s.runFile));
});

test('the MCP token is never sent to a bridge listener whose process is not confirmed ours', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const { mcp: mcpToken } = tokens(s.home);
  const seen = [];
  const impostor = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization ?? null });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', service: 'botmancers-core', version: VERSION, home: s.home }));
  });
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => impostor.close());
  const port = impostor.address().port;
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('exit', resolve));
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'next-server']);
  t.after(() => live.kill('SIGKILL'));
  await waitFor(() => pidAlive(live.pid));
  const failingPs = join(s.root, 'failing-ps');
  mkdirSync(failingPs);
  writeFileSync(join(failingPs, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const point = (supervisor, ui, mcp) => writeFileSync(s.runFile, JSON.stringify({
    schema: 1, version: VERSION, home: s.home, appDir: s.app, state: 'running', startedAt: new Date().toISOString(),
    supervisor: { pid: supervisor }, ui: { pid: ui, port, url: `http://127.0.0.1:${port}` }, mcp: { pid: mcp, port, url: `http://127.0.0.1:${port}/mcp` },
  }));
  const cases = [
    // The bridge process is gone (a core without a start time keeps the record alive).
    ['bridge gone', () => point(dead.pid, live.pid, dead.pid), {}],
    // ps fails, so the live bridge pid is unverifiable.
    ['bridge unverifiable', () => point(live.pid, live.pid, live.pid), { PATH: failingPs }],
  ];
  for (const [name, record, extra] of cases) {
    for (const command of ['status', 'doctor']) {
      record();
      seen.length = 0;
      const result = await s.run([command], extra);
      assert.ok(seen.length > 0, `${name}/${command}: the listener was probed unauthenticated`);
      assert.ok(seen.every(entry => entry.authorization === null && entry.url !== '/mcp'), `${name}/${command}: no credential-bearing request: ${JSON.stringify(seen)}`);
      assertNoTokens(s.home, result.stdout, result.stderr);
      assert.ok(!JSON.stringify(seen).includes(mcpToken));
    }
  }
});

test('the link probe, which forwards the service token to the core, needs the core to be confirmed ours too', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  assert.equal((await s.run(['start', '--daemon'])).code, 0);
  const running = record(s.runFile);
  assert.match((await s.run(['status'])).stdout, /bridge→core ok/, 'baseline: owned bridge and core are probed');
  // The recorded core process is no longer ours (its pid is dead) while a
  // listener still answers on the core port and the owned bridge is alive:
  // a replacement core would receive the bridge's service token.
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('exit', resolve));
  writeFileSync(s.runFile, JSON.stringify({ ...running, ui: { ...running.ui, pid: dead.pid } }));
  const result = await s.run(['status']);
  assert.equal(result.code, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /bridge→core/, 'no bridge -> core probe without a confirmed core');
  assert.match(result.stdout, /problem {5}core \(pid \d+\) is not running/);
  assertNoTokens(s.home, result.stdout, result.stderr);
  writeFileSync(s.runFile, JSON.stringify(running));
});

test('an operator-exported BOTMANCERS_SERVICE_TOKENS stays usable next to the generated bridge principal', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const generated = /^BOTMANCERS_SERVICE_TOKENS=(.+)$/m.exec(readFileSync(join(s.home, 'config/core.env'), 'utf8'))[1].trim();
  assert.match(generated, /^botmancers-bridge=sha256:[0-9a-f]{64}$/);
  const other = `grok-bot=sha256:${'a'.repeat(64)}`;
  const spoof = `botmancers-bridge=sha256:${'b'.repeat(64)}`;
  const start = await s.run(['start', '--daemon'], { BOTMANCERS_SERVICE_TOKENS: `${other}, ${spoof}` });
  assert.equal(start.code, 0, start.stderr);
  const entries = JSON.parse(readFileSync(join(s.home, 'logs/fake-core-env.json'), 'utf8')).BOTMANCERS_SERVICE_TOKENS.split(',');
  assert.ok(entries.includes(other), 'the exported principal reaches the core');
  assert.deepEqual(entries.filter(entry => entry.startsWith('botmancers-bridge=')), [generated], 'one bridge entry, the generated digest');
  assert.equal(entries.length, 2);
  const status = await s.run(['status'], { BOTMANCERS_SERVICE_TOKENS: `${other}, ${spoof}` });
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, /bridge→core ok/, 'the bridge still authenticates to the core');
  assertNoTokens(s.home, start.stdout, start.stderr, status.stdout);
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

// NOT-519: the Slack line reads the running core's GET /api/health only and
// never prints a Slack credential.
test('doctor reports Slack disabled, misconfigured, connecting, connected, and reconnecting without a mutating probe or a token', async t => {
  // Assembled at run time so no committed file holds a token-shaped string.
  const SENTINEL_APP = ['xapp', '1', 'A0NOT519', 'SENTINELAPP', '0123456789abcdef'].join('-');
  const SENTINEL_BOT = ['xoxb', '519', 'SENTINELBOT', '0123456789abcdef'].join('-');
  const s = await sandbox(t);
  assert.equal((await s.run(['setup'])).code, 0);
  const slackLine = out => (/^ {2}(\w+) +slack +(.*)$/m.exec(out) ?? []).slice(1).join(' ');
  const outputs = [];
  const doctor = async (extra = {}) => {
    const result = await s.run(['doctor'], { PATH: '/usr/bin:/bin', ...extra });
    outputs.push(result.stdout, result.stderr);
    return result;
  };

  // Stopped: only presence of the credentials is reported.
  assert.match(slackLine((await doctor()).stdout), /^info Slack relay disabled \(no Slack tokens configured\)/);
  assert.match(slackLine((await doctor({ BOTMANCERS_SLACK_APP_TOKEN: SENTINEL_APP })).stdout), /^warn Slack relay misconfigured \(bot_token_missing\); set BOTMANCERS_SLACK_BOT_TOKEN/);
  const coreEnv = join(s.home, 'config/core.env');
  writeFileSync(coreEnv, `${readFileSync(coreEnv, 'utf8')}BOTMANCERS_SLACK_APP_TOKEN=${SENTINEL_APP}\nBOTMANCERS_SLACK_BOT_TOKEN=${SENTINEL_BOT}\n`);
  const configured = await doctor();
  assert.match(slackLine(configured.stdout), /^info Slack tokens are configured; the relay connects when botmancers starts\.$/);
  assert.match(configured.stdout, /^result: ok/m, 'Slack never fails doctor');

  // Running: the core's own state, one line per state.
  assert.equal((await s.run(['start', '--daemon'])).code, 0);
  const slackFile = join(s.home, 'run/fake-slack.json');
  const requests = join(s.home, 'logs/fake-core-requests.log');
  const cases = [
    [{ state: 'disabled', reason: 'slack_tokens_absent', since: 1, connections: 0 }, /^info Slack relay disabled/],
    [{ state: 'misconfigured', reason: 'share_config_no_audience', since: 1, connections: 0 }, /^warn Slack relay misconfigured \(share_config_no_audience\); add a Slack channel to the share allowlist/],
    [{ state: 'misconfigured', reason: 'workspace_not_allowlisted', since: 1, connections: 0 }, /^warn Slack relay misconfigured \(workspace_not_allowlisted\)/],
    [{ state: 'failed', reason: 'slack_auth_failed', since: 1, connections: 0 }, /^warn Slack relay failed \(slack_auth_failed\); Slack refused the bot token/],
    [{ state: 'connecting', reason: null, since: 1, connections: 0 }, /^info Slack relay connecting to Socket Mode$/],
    [{ state: 'connected', reason: null, since: 1, connections: 1 }, /^ok Slack relay connected over Socket Mode$/],
    [{ state: 'reconnecting', reason: null, since: 1, connections: 3 }, /^warn Slack relay reconnecting to Socket Mode \(2 reconnects since start\)/],
    [{ state: 'connected', reason: null, since: 1, connections: 2 }, /^ok Slack relay connected over Socket Mode \(1 reconnect since start\)$/],
    // A reason the CLI does not know is never echoed as free text.
    [{ state: 'misconfigured', reason: `leak ${SENTINEL_BOT}`, since: 1, connections: 0 }, /^warn Slack relay misconfigured$/],
  ];
  for (const [state, expected] of cases) {
    writeFileSync(slackFile, JSON.stringify(state));
    writeFileSync(requests, '');
    const result = await doctor();
    assert.match(slackLine(result.stdout), expected, JSON.stringify(state));
    // Doctor reads the Slack state from GET /api/health; the only other
    // request the core sees is the existing read-only bridge link probe
    // (botmancers_health over /api/v0/mcp). Nothing reaches a share or Slack.
    const lines = readFileSync(requests, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.includes('GET /api/health'), 'doctor read the core health');
    assert.ok(lines.every(line => line === 'GET /api/health' || line === 'POST /api/v0/mcp'), `doctor sent ${lines.join(', ')}`);
  }
  for (const output of outputs) {
    assert.ok(!output.includes(SENTINEL_APP) && !output.includes(SENTINEL_BOT) && !output.includes('SENTINEL'), 'doctor printed a Slack token');
  }
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

test('the run record is replaced atomically: a concurrent reader never sees a partial file', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-runfile-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { writeRun, readRun } = await import('../dist/product.js');
  const paths = { runFile: join(root, 'product.json') };
  const record = padding => ({
    schema: 1, version: VERSION, home: root, appDir: root, state: 'running', startedAt: new Date().toISOString(), padding,
    supervisor: { pid: process.pid }, ui: { pid: null, port: 1, url: 'http://127.0.0.1:1' }, mcp: { pid: null, port: 2, url: 'http://127.0.0.1:2/mcp' },
  });
  writeRun(paths, record('x'));
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeRun } from ${JSON.stringify(new URL('../dist/product.js', import.meta.url).href)};
    const paths = { runFile: ${JSON.stringify(paths.runFile)} };
    const record = padding => ({ schema: 1, version: ${JSON.stringify(VERSION)}, home: '/', appDir: '/', state: 'running', startedAt: 'x', padding,
      supervisor: { pid: process.pid }, ui: { pid: null, port: 1, url: 'u' }, mcp: { pid: null, port: 2, url: 'm' } });
    for (let i = 0; i < 4000; i++) writeRun(paths, record('y'.repeat(200000 + (i % 7))));
  `], { stdio: 'ignore' });
  const exited = new Promise(resolve => writer.on('exit', resolve));
  let reads = 0;
  let finished = false;
  exited.then(() => { finished = true; });
  while (!finished) {
    assert.ok(readRun(paths), `a reader saw a missing or partial run record after ${reads} reads`);
    reads++;
    if (reads % 50 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(reads > 100, `the reader overlapped the writer (${reads} reads)`);
  // Exclusive creation publishes a complete file or fails with EEXIST.
  assert.throws(() => writeRun(paths, record('z'), true), { code: 'EEXIST' });
  assert.ok(readRun(paths));
  rmSync(paths.runFile);
  writeRun(paths, record('z'), true);
  assert.ok(readRun(paths));
  assert.deepEqual(readdirSync(root), ['product.json'], 'no temp file left behind');
});
