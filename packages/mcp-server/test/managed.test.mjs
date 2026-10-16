// The managed install (NOT-495): release trees under <home>/versions, the
// atomic `current` link, the ~/.local/bin launcher, the auto-updater, safe
// activation at `start`, version reporting, install/upgrade commands, and the
// guarantee that user state is never touched. Releases are this checkout's
// dist/ with a fake packaged app, served by a local npm registry with real
// sha512 integrity, so npm itself installs them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cli, freePort, run, waitFor, pidAlive } from '../scripts/product-harness.mjs';
import { MANAGED_ENTRIES, hashTree, makePackage, pack, seedRelease, startRegistry } from '../scripts/managed-harness.mjs';

const managed = await import('../dist/managed.js');
const N = '0.9.0';
const N1 = '0.9.1';
const N2 = '0.9.2';
const OLD = '0.8.0';

let shared;
let registry;
before(async () => {
  shared = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-managed-pkgs-')));
  const tarballs = {};
  for (const version of [OLD, N, N1, N2]) tarballs[version] = pack(makePackage(join(shared, `pkg-${version}`), version), join(shared, 'tgz'));
  registry = await startRegistry({ releases: tarballs, latest: N });
});
after(async () => {
  await registry?.close();
  rmSync(shared, { recursive: true, force: true });
});

const realNpm = (() => {
  for (const dir of (process.env.PATH ?? '').split(':')) if (existsSync(join(dir, 'npm'))) return join(dir, 'npm');
  return 'npm';
})();

// An isolated user: HOME, ~/.local/bin, an npm cache, and a tools dir with
// node plus a logging npm wrapper (global install/uninstall are recorded,
// never run). PATH holds nothing else that could provide botmancers.
async function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-managed-')));
  const user = join(root, 'user');
  const home = join(user, '.botmancers');
  const bin = join(user, '.local', 'bin');
  const tools = join(root, 'tools');
  const npmLog = join(root, 'npm.log');
  mkdirSync(tools, { recursive: true });
  mkdirSync(user, { recursive: true });
  symlinkSync(process.execPath, join(tools, 'node'));
  writeFileSync(join(tools, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
case "$1 $2" in
  "install -g"|"uninstall -g") exit 0 ;;
  "prefix -g") echo ${JSON.stringify(join(root, 'global'))}; exit 0 ;;
esac
exec ${JSON.stringify(realNpm)} "$@"
`);
  chmodSync(join(tools, 'npm'), 0o755);
  const ui = await freePort();
  let mcp = await freePort();
  while (mcp === ui) mcp = await freePort();
  const env = (extra = {}) => ({
    PATH: [bin, tools, '/usr/bin', '/bin'].join(':'),
    HOME: user,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(user, '.npmrc'),
    npm_config_registry: registry.url,
    npm_config_update_notifier: 'false',
    BOTMANCERS_UI_PORT: String(ui),
    BOTMANCERS_MCP_PORT: String(mcp),
    BOTMANCERS_STARTUP_TIMEOUT_MS: '15000',
    BOTMANCERS_AGENT_DECK_URL: `http://127.0.0.1:${mcp}`,
    // Off unless a test turns it on, so no stray detached worker races a test.
    BOTMANCERS_DISABLE_AUTOUPDATER: '1',
    ...extra,
  });
  const launcher = join(bin, 'botmancers');
  const bm = (args, extra = {}) => run(launcher, args, { env: env(extra), cwd: root, timeoutMs: 120_000 });
  const dev = (args, extra = {}) => cli(args, { env: env(extra), cwd: root, timeoutMs: 120_000 });
  const paths = managed.managedPaths(env());
  const state = () => JSON.parse(readFileSync(join(home, 'update-state.json'), 'utf8'));
  const current = () => readlinkSync(join(home, 'current'));
  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  t.after(async () => {
    if (existsSync(launcher)) await bm(['stop']).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  return { root, user, home, bin, tools, launcher, env, bm, dev, paths, state, current, npmCalls, ui, mcp };
}

const runFile = s => JSON.parse(readFileSync(join(s.home, 'run/product.json'), 'utf8'));
const health = async s => (await (await fetch(`http://127.0.0.1:${s.ui}/api/health`)).json()).version;
const bridgeVersion = async s => (await (await fetch(`http://127.0.0.1:${s.mcp}/healthz`)).json()).version;
const count = (text, needle) => text.split(needle).length - 1;
const on = { BOTMANCERS_DISABLE_AUTOUPDATER: '' };
const off = { BOTMANCERS_DISABLE_AUTOUPDATER: '1' };

async function installed(t, version = N) {
  const s = await sandbox(t);
  const result = await s.dev(['install', '--to', version]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return s;
}

// Fake npm for in-process staging: lays out a release in the --prefix dir.
function fakeNpm({ integrity = 'sha512-fake', version, fail = null, calls = [] } = {}) {
  return async args => {
    calls.push(args);
    const prefix = args[args.indexOf('--prefix') + 1];
    const v = version ?? args.at(-1).split('@')[1];
    if (fail === 'interrupt') {
      mkdirSync(join(prefix, 'node_modules', 'botmancers', 'dist'), { recursive: true });
      writeFileSync(join(prefix, 'node_modules', 'botmancers', 'package.json'), '{"name":"botm');
      return { code: 1, stderr: 'npm ERR! network aborted' };
    }
    makePackage(join(prefix, 'node_modules', 'botmancers'), v);
    if (fail === 'incomplete') rmSync(join(prefix, 'node_modules', 'botmancers', 'app', 'server.js'));
    writeFileSync(join(prefix, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/botmancers': { integrity } } }));
    return { code: 0, stderr: '' };
  };
}

test('install --to N creates versions/N, an atomic current link, and a launcher that runs the product', async t => {
  const s = await installed(t);
  assert.ok(lstatSync(join(s.home, 'current')).isSymbolicLink());
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(realpathSync(join(s.home, 'current')), join(s.home, 'versions', N));
  assert.ok(existsSync(join(s.home, 'versions', N, 'node_modules/botmancers/dist/cli.js')));
  const lock = JSON.parse(readFileSync(join(s.home, 'versions', N, 'package-lock.json'), 'utf8'));
  assert.match(lock.packages['node_modules/botmancers'].integrity, /^sha512-/);
  assert.deepEqual(readdirSync(join(s.home, 'versions')), [N], 'no partial tree left');
  assert.equal(lstatSync(s.launcher).mode & 0o777, 0o755);
  assert.match(readFileSync(s.launcher, 'utf8'), /exec node "\$BIN" "\$@"/);

  const version = await s.bm(['--version']);
  assert.equal(version.stdout.trim(), N);
  assert.equal((await s.bm(['setup'])).code, 0);
  writeFileSync(join(s.home, 'update-state.json'), JSON.stringify({ checkedAt: new Date().toISOString(), latest: N }));
  const doctor = await s.bm(['doctor'], on);
  assert.match(doctor.stdout, new RegExp(`info  install     managed \\(${join(s.home, 'versions', N).replace(/\//g, '\\/')}/node_modules/botmancers/dist/cli.js\\)`));
  assert.match(doctor.stdout, new RegExp(`ok    path        PATH resolves botmancers to ${s.launcher}`));
  assert.match(doctor.stdout, /ok    updater     automatic updates on/);
  const start = await s.bm(['start', '--daemon']);
  assert.equal(start.code, 0, start.stderr);
  const status = await s.bm(['status']);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`versions    cli ${N}, current ${N}$`, 'm'));
  assert.match(status.stdout, new RegExp(`running     core ${N}, bridge ${N} \\(started by ${N}\\)`));
  assert.ok(runFile(s).cli.startsWith(join(s.home, 'versions', N)), 'supervisor runs from the release tree');
});

test('the auto-updater is throttled to once a day, managed-only, and never waits on the registry', async t => {
  const s = await installed(t);
  const cliPath = join(s.home, 'versions', N, 'node_modules/botmancers/dist/cli.js');
  const spawned = [];
  const spawnWorker = (path) => spawned.push(path);
  let now = Date.parse('2026-10-16T00:00:00Z');
  const clock = { now: () => now };

  assert.equal(managed.scheduleAutoUpdate(s.env(off), { cliPath, clock, spawnWorker }), 'disabled');
  assert.equal(managed.scheduleAutoUpdate(s.env(on), { clock, spawnWorker }), 'not-managed', 'the dev checkout never updates itself');
  const t0 = performance.now();
  assert.equal(managed.scheduleAutoUpdate(s.env(on), { cliPath, clock, spawnWorker }), 'scheduled');
  assert.ok(performance.now() - t0 < 100, 'scheduling is immediate');
  assert.deepEqual(spawned, [cliPath]);

  // Offline: the check is recorded, nothing is staged, and the next check waits a day.
  let calls = 0;
  const offline = async () => { calls += 1; throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
  const failed = await managed.runUpdateCheck(s.env(on), { clock, latest: offline }, cliPath);
  assert.equal(failed.result, 'error');
  assert.equal(s.state().checkedAt, new Date(now).toISOString());
  assert.equal(s.state().pendingVersion, null);
  assert.match(s.state().lastError, /ENOTFOUND/);
  now += 23 * 60 * 60 * 1000;
  assert.equal((await managed.runUpdateCheck(s.env(on), { clock, latest: offline }, cliPath)).result, 'not-due');
  assert.equal(managed.scheduleAutoUpdate(s.env(on), { cliPath, clock, spawnWorker }), 'not-due');
  assert.equal(calls, 1);

  // A day later: up to date, then (after another day) a newer latest is staged.
  now += 60 * 60 * 1000;
  assert.equal((await managed.runUpdateCheck(s.env(on), { clock, latest: async () => N }, cliPath)).result, 'up-to-date');
  now += 24 * 60 * 60 * 1000;
  const npmCalls = [];
  const staged = await managed.runUpdateCheck(s.env(on), { clock, latest: async () => N1, integrity: async () => 'sha512-good', npm: fakeNpm({ integrity: 'sha512-good', calls: npmCalls }) }, cliPath);
  assert.deepEqual(staged, { result: 'staged', version: N1, reused: false });
  assert.equal(npmCalls[0][npmCalls[0].indexOf('--prefix') + 1], join(s.home, 'versions', `.partial-${N1}`), 'downloads under a partial name');
  assert.equal(s.state().pendingVersion, N1);
  assert.equal(s.state().pendingIntegrity, 'sha512-good');
  assert.equal(s.current(), `versions/${N}`, 'staging never moves current');
  assert.ok(!existsSync(join(s.home, 'update.lock')));

  // A real registry that hangs: the timeout bounds the worker, not any command.
  registry.mode = 'hang';
  try {
    const started = performance.now();
    await assert.rejects(managed.fetchLatestVersion(s.env(), 300));
    assert.ok(performance.now() - started < 2000);
  } finally {
    registry.mode = 'ok';
  }
});

test('a hanging or failing registry never delays a managed command; the detached worker records the failure', async t => {
  const s = await installed(t);
  assert.equal((await s.bm(['setup'])).code, 0);
  registry.mode = 'hang';
  t.after(() => { registry.mode = 'ok'; });
  const quiet = performance.now();
  const baseline = await s.bm(['status']);
  const offMs = performance.now() - quiet;
  const started = performance.now();
  const status = await s.bm(['status'], on);
  const onMs = performance.now() - started;
  assert.equal(status.code, baseline.code);
  assert.ok(onMs < offMs + 1000, `status took ${Math.round(onMs)} ms with a hanging registry (${Math.round(offMs)} ms with updates off)`);
  assert.ok(await waitFor(() => existsSync(join(s.home, 'update-state.json')) && /update check failed/.test(readFileSync(join(s.home, 'update-state.json'), 'utf8')), 10_000), 'worker timed out and recorded it');
  assert.equal(s.state().pendingVersion, null);
  assert.equal(s.current(), `versions/${N}`);
  assert.ok(await waitFor(() => !existsSync(join(s.home, 'update.lock')), 5000));
});

test('integrity failures and interrupted downloads leave no release, no pending version, and no partial tree', async t => {
  const s = await installed(t);
  const cliPath = join(s.home, 'versions', N, 'node_modules/botmancers/dist/cli.js');
  let now = Date.parse('2026-10-16T00:00:00Z');
  const clock = { now: () => now };
  const cases = [
    ['integrity mismatch', { integrity: async () => 'sha512-expected', npm: fakeNpm({ integrity: 'sha512-other' }) }, /integrity mismatch/],
    ['interrupted download', { integrity: async () => 'sha512-x', npm: fakeNpm({ fail: 'interrupt' }) }, /network aborted/],
    ['incomplete package', { integrity: async () => 'sha512-x', npm: fakeNpm({ integrity: 'sha512-x', fail: 'incomplete' }) }, /incomplete: packaged app is missing server\.js/],
  ];
  for (const [name, deps, error] of cases) {
    now += 25 * 60 * 60 * 1000;
    const outcome = await managed.runUpdateCheck(s.env(on), { clock, latest: async () => N1, ...deps }, cliPath);
    assert.equal(outcome.result, 'error', name);
    assert.match(s.state().lastError, error, name);
    assert.equal(s.state().pendingVersion, null, name);
    assert.deepEqual(readdirSync(join(s.home, 'versions')), [N], `${name}: nothing left in versions/`);
    assert.equal(s.current(), `versions/${N}`);
  }

  // Through real npm: a registry whose version document disagrees with the tarball.
  registry.badIntegrity.add(N1);
  try {
    now += 25 * 60 * 60 * 1000;
    const outcome = await managed.runUpdateCheck(s.env(on), { clock, latest: async () => N1 }, cliPath);
    assert.equal(outcome.result, 'error');
    assert.match(outcome.error, /integrity mismatch/);
  } finally {
    registry.badIntegrity.delete(N1);
  }
  // And a truncated tarball.
  registry.mode = 'truncate';
  try {
    now += 25 * 60 * 60 * 1000;
    // A fresh npm cache: the case above already cached the intact tarball.
    const outcome = await managed.runUpdateCheck(s.env({ ...on, npm_config_cache: join(s.root, 'cold-cache'), npm_config_fetch_retries: '0' }), { clock, latest: async () => N1 }, cliPath);
    assert.equal(outcome.result, 'error');
    assert.match(s.state().lastError, /npm install botmancers@0\.9\.1 failed/);
  } finally {
    registry.mode = 'ok';
  }
  assert.deepEqual(readdirSync(join(s.home, 'versions')), [N]);
  assert.equal(s.state().pendingVersion, null);
});

test('N+1 is staged beside a live N, activates only at a start that finds nothing running', async t => {
  const s = await installed(t);
  assert.equal((await s.bm(['setup'])).code, 0);
  assert.equal((await s.bm(['start', '--daemon'])).code, 0);
  const before = runFile(s);

  // Publish N+1 and let the real worker run (through the launcher, as the supervisor would).
  registry.latest = N1;
  t.after(() => { registry.latest = N; });
  const worker = await s.bm(['__update-check'], on);
  assert.equal(worker.code, 0);
  assert.equal(s.state().pendingVersion, N1);
  assert.equal(s.state().latest, N1);
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(await health(s), N, 'the running core is still N');
  assert.equal(runFile(s).supervisor.pid, before.supervisor.pid, 'the running product was not restarted');

  // Fully running: start leaves it alone and prints one restart instruction.
  const status = await s.bm(['status'], on);
  assert.equal(status.code, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`versions    cli ${N}, current ${N}, pending ${N1} \\(staged, not running\\)`));
  assert.match(status.stdout, new RegExp(`running     core ${N}, bridge ${N}`));
  assert.match(status.stdout, new RegExp(`restart     botmancers stop && botmancers start --daemon   \\(activates ${N1}\\)`));
  const running = await s.bm(['start', '--daemon'], on);
  assert.equal(running.code, 0);
  assert.equal(count(running.stdout + running.stderr, 'botmancers stop && botmancers start --daemon'), 1, running.stdout);
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(s.state().pendingVersion, N1);

  // Partially running (bridge killed): degraded, still pending, one instruction.
  process.kill(runFile(s).mcp.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(before.mcp.pid));
  const partial = await s.bm(['start', '--daemon'], on);
  assert.equal(partial.code, 1);
  assert.equal(count(partial.stdout + partial.stderr, 'botmancers stop && botmancers start --daemon'), 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout, new RegExp(`\\(activates ${N1}\\)`));
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(s.state().pendingVersion, N1);

  // Stale PIDs (everything killed hard): start proves them gone, activates, runs N+1.
  for (const pid of [before.supervisor.pid, before.ui.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await waitFor(() => !pidAlive(before.supervisor.pid) && !pidAlive(before.ui.pid));
  const restart = await s.bm(['start', '--daemon'], on);
  assert.equal(restart.code, 0, restart.stdout + restart.stderr);
  assert.match(restart.stdout, new RegExp(`activated ${N1} \\(was ${N}\\)`));
  assert.match(restart.stderr, /removed stale run metadata/);
  assert.equal(s.current(), `versions/${N1}`);
  assert.equal(s.state().pendingVersion, null);
  assert.equal(await health(s), N1);
  assert.equal(await bridgeVersion(s), N1);
  assert.ok(runFile(s).cli.startsWith(join(s.home, 'versions', N1)));
  const after = await s.bm(['status']);
  assert.equal(after.code, 0);
  assert.match(after.stdout, new RegExp(`running     core ${N1}, bridge ${N1} \\(started by ${N1}\\)`));

  // A clean stop then start with nothing pending changes nothing.
  assert.equal((await s.bm(['stop'])).code, 0);
  const plain = await s.bm(['start', '--daemon'], on);
  assert.equal(plain.code, 0);
  assert.doesNotMatch(plain.stdout, /activated/);
});

test('a stopped product activates a pending release at start; corrupt pending trees are never made current', async t => {
  const s = await installed(t);
  assert.equal((await s.bm(['setup'])).code, 0);
  seedRelease(s.home, N1);
  writeFileSync(join(s.home, 'update-state.json'), JSON.stringify({ checkedAt: new Date().toISOString(), latest: N1, pendingVersion: N1 }));
  rmSync(join(s.home, 'versions', N1, 'node_modules/botmancers/app/BUILD_INFO.json'));
  const status = await s.bm(['status'], on);
  assert.doesNotMatch(status.stdout, /pending/, 'an incomplete tree is not reported as pending');
  const start = await s.bm(['start', '--daemon'], on);
  assert.equal(start.code, 0);
  assert.doesNotMatch(start.stdout, /activated/);
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(await health(s), N);
  assert.equal((await s.bm(['stop'])).code, 0);

  seedRelease(s.home, N2);
  writeFileSync(join(s.home, 'update-state.json'), JSON.stringify({ checkedAt: new Date().toISOString(), latest: N2, pendingVersion: N2 }));
  const next = await s.bm(['start', '--daemon'], on);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, new RegExp(`activated ${N2} \\(was ${N}\\)`));
  assert.equal(await health(s), N2);
});

test('NOT-279: a launcher switched to N under a live N-1 reports the running N-1, degraded, with restart guidance', async t => {
  const s = await installed(t, N);
  assert.equal((await s.bm(['setup'])).code, 0);
  assert.equal((await s.bm(['start', '--daemon'], off)).code, 0);
  // Something flips current beneath the live product (an older release's
  // updater, a manual ln): the launcher now resolves to N+1.
  seedRelease(s.home, N1);
  symlinkSync(`versions/${N1}`, join(s.home, 'current.flip'));
  renameSync(join(s.home, 'current.flip'), join(s.home, 'current'));
  assert.equal((await s.bm(['--version'])).stdout.trim(), N1);

  const status = await s.bm(['status'], off);
  assert.equal(status.code, 1, status.stdout);
  assert.match(status.stdout, new RegExp(`^botmancers ${N1}: degraded$`, 'm'));
  assert.match(status.stdout, new RegExp(`versions    cli ${N1}, current ${N1}$`, 'm'));
  assert.match(status.stdout, new RegExp(`running     core ${N}, bridge ${N} \\(started by ${N}\\)`));
  assert.match(status.stdout, new RegExp(`problem     version mismatch: core reports ${N}, installed ${N1}`));
  assert.match(status.stdout, new RegExp(`problem     version mismatch: bridge reports ${N}, installed ${N1}`));
  assert.match(status.stdout, /fix {9}botmancers stop && botmancers start --daemon/);
  assert.doesNotMatch(status.stdout, /bridge \(pid \d+\) is not running/, 'the N bridge is still recognized as ours');
  assert.doesNotMatch(status.stdout, new RegExp(`core ${N1}|bridge ${N1}`));
  const doctor = await s.bm(['doctor'], off);
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, new RegExp(`info  running     core ${N}, bridge ${N} \\(started by ${N}\\)`));
  assert.match(doctor.stdout, /fail  product     running but degraded: .*; fix: botmancers stop && botmancers start --daemon/);

  // The N+1 CLI stops the N product it did not start, and the restart runs N+1.
  const stop = await s.bm(['stop'], off);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /supervisor pid \d+/);
  assert.equal((await s.bm(['start', '--daemon'], off)).code, 0);
  assert.equal(await health(s), N1);
  assert.equal((await s.bm(['status'], off)).code, 0);
});

test('BOTMANCERS_DISABLE_AUTOUPDATER=1: no automatic check, download, state change, or activation on any command; explicit upgrade works', async t => {
  const s = await installed(t);
  assert.equal((await s.bm(['setup'], off)).code, 0);
  seedRelease(s.home, N1);
  writeFileSync(join(s.home, 'update-state.json'), JSON.stringify({ checkedAt: '2000-01-01T00:00:00.000Z', latest: N1, pendingVersion: N1 }));
  registry.latest = N2;
  t.after(() => { registry.latest = N; });
  const hitsBefore = registry.hits.length;
  const stateBefore = readFileSync(join(s.home, 'update-state.json'), 'utf8');
  const tree = () => JSON.stringify([readdirSync(join(s.home, 'versions')).sort(), s.current()]);
  const treeBefore = tree();

  for (const args of [['status'], ['doctor'], ['open'], ['setup'], ['start', '--daemon'], ['status'], ['--version'], ['mcp', '--help'], ['stop'], ['start', '--daemon'], ['stop']]) {
    const result = await s.bm(args, off);
    assert.ok(result.code !== null, args.join(' '));
    assert.doesNotMatch(result.stdout, /activated/, args.join(' '));
  }
  assert.equal((await s.bm(['__update-check'], off)).code, 0, 'even the worker does nothing');
  await new Promise(resolve => setTimeout(resolve, 500)); // any detached worker would have hit the registry by now
  assert.equal(registry.hits.length, hitsBefore, `registry requests: ${registry.hits.slice(hitsBefore).join(', ')}`);
  assert.equal(readFileSync(join(s.home, 'update-state.json'), 'utf8'), stateBefore);
  assert.equal(tree(), treeBefore);
  assert.ok(!existsSync(join(s.home, 'update.lock')));

  const status = await s.bm(['status'], off);
  assert.match(status.stdout, new RegExp(`pending ${N1} \\(staged, not running; auto-update disabled\\)`));
  const doctor = await s.bm(['doctor'], off);
  assert.match(doctor.stdout, /info  updater     automatic updates disabled \(BOTMANCERS_DISABLE_AUTOUPDATER\); botmancers upgrade still works/);

  const upgrade = await s.bm(['upgrade', '--to', N2], off);
  assert.equal(upgrade.code, 0, upgrade.stdout + upgrade.stderr);
  assert.match(upgrade.stdout, new RegExp(`activated ${N2} \\(was ${N}\\)`));
  assert.equal(s.current(), `versions/${N2}`);
  assert.equal((await s.bm(['--version'], off)).stdout.trim(), N2);
});

test('upgrade: managed --check, --to, and latest; a live product gets a pending release instead of a switch', async t => {
  const s = await installed(t);
  const check = await s.bm(['upgrade', '--check']);
  assert.equal(check.code, 0);
  assert.match(check.stdout, /Install: {2}managed/);
  assert.match(check.stdout, /Already on the latest version/);
  registry.latest = N1;
  t.after(() => { registry.latest = N; });
  const available = await s.bm(['upgrade', '--check']);
  assert.match(available.stdout, new RegExp(`Current:  ${N}\\nLatest:   ${N1}\\nUpdate available\\. Run: botmancers upgrade`));
  assert.deepEqual(readdirSync(join(s.home, 'versions')), [N], '--check downloads nothing');

  const latest = await s.bm(['upgrade']);
  assert.equal(latest.code, 0, latest.stderr);
  assert.match(latest.stdout, new RegExp(`downloaded botmancers@${N1} \\(sha512-`));
  assert.equal(s.current(), `versions/${N1}`);

  // While the product runs, an explicit upgrade stages instead of switching.
  assert.equal((await s.bm(['setup'])).code, 0);
  assert.equal((await s.bm(['start', '--daemon'])).code, 0);
  const live = await s.bm(['upgrade', '--to', N2], on);
  assert.equal(live.code, 0, live.stderr);
  assert.match(live.stdout, new RegExp(`${N2} is staged; botmancers ${N1} keeps running\\. Restart once to activate it: botmancers stop && botmancers start --daemon`));
  assert.equal(s.current(), `versions/${N1}`);
  assert.equal(s.state().pendingVersion, N2);
  const blocked = await s.bm(['upgrade', '--to', N2], off);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /automatic activation is off/);
  assert.equal(s.current(), `versions/${N1}`);
  assert.equal((await s.bm(['stop'])).code, 0);
  const start = await s.bm(['start', '--daemon'], on);
  assert.match(start.stdout, new RegExp(`activated ${N2}`));
  assert.equal(await health(s), N2);
  assert.ok(!s.npmCalls().some(line => / -g\b/.test(line)), `no global npm command: ${s.npmCalls().join(' | ')}`);
});

test('upgrade: npm-global asks before npm install -g; dev and project-local copies only report guidance', async t => {
  const s = await sandbox(t);
  const prefix = join(s.root, 'global');
  const pkgDir = makePackage(join(prefix, 'lib', 'node_modules', 'botmancers'), N);
  const globalCli = join(pkgDir, 'dist', 'cli.js');
  const env = s.env({ npm_config_prefix: prefix });
  registry.latest = N1;
  t.after(() => { registry.latest = N; });

  const check = await run(process.execPath, [globalCli, 'upgrade', '--check'], { env, cwd: s.root });
  assert.equal(check.code, 0);
  assert.match(check.stdout, /Install: {2}npm-global/);
  assert.match(check.stdout, /Update available/);
  const noTty = await run(process.execPath, [globalCli, 'upgrade'], { env, cwd: s.root });
  assert.equal(noTty.code, 0);
  assert.match(noTty.stdout, new RegExp(`Not upgraded\\. To upgrade, run: npm install -g botmancers@${N1}`));
  assert.ok(!s.npmCalls().some(line => line.startsWith('install -g')));
  const yes = await run(process.execPath, [globalCli, 'upgrade', '--yes', '--to', N2], { env, cwd: s.root });
  assert.equal(yes.code, 0, yes.stderr);
  assert.ok(s.npmCalls().includes(`install -g botmancers@${N2}`), s.npmCalls().join(' | '));

  const dev = await s.dev(['upgrade']);
  assert.equal(dev.code, 1);
  assert.match(dev.stdout, /Install: {2}dev-checkout/);
  assert.match(dev.stderr, /does not update itself; update the checkout with git and rebuild/);
  assert.ok(!existsSync(s.home), 'the dev checkout wrote nothing');
  const devCheck = await s.dev(['upgrade', '--check']);
  assert.equal(devCheck.code, 0);

  const local = makePackage(join(s.root, 'proj', 'node_modules', 'botmancers'), N);
  const localRun = await run(process.execPath, [join(local, 'dist/cli.js'), 'upgrade'], { env: s.env(), cwd: s.root });
  assert.equal(localRun.code, 1);
  assert.match(localRun.stdout, /Install: {2}project-local/);
  assert.ok(!s.npmCalls().some(line => /^(?:install|uninstall) -g/.test(line) && !line.includes(N2)));

  const usage = await s.dev(['upgrade', '--to', 'latest']);
  assert.equal(usage.code, 2);
});

test('install never uninstalls the global package unless --purge-global; --migrate-cli explains PATH shadowing', async t => {
  const s = await sandbox(t);
  const shadow = join(s.root, 'shadow');
  mkdirSync(shadow);
  writeFileSync(join(shadow, 'botmancers'), '#!/bin/sh\necho global\n');
  chmodSync(join(shadow, 'botmancers'), 0o755);
  const env = { PATH: [shadow, s.bin, s.tools, '/usr/bin', '/bin'].join(':') };
  const plain = await s.dev(['install', '--to', N, '--migrate-cli'], env);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, new RegExp(`\`botmancers\` currently resolves to ${join(shadow, 'botmancers')}, which shadows the launcher`));
  assert.match(plain.stdout, /To migrate: put .* before .* on PATH/);
  assert.ok(!s.npmCalls().some(line => line.startsWith('uninstall')));
  const doctor = await run(s.launcher, ['doctor'], { env: s.env(env), cwd: s.root });
  assert.match(doctor.stdout, new RegExp(`warn  path        \`botmancers\` on PATH resolves to ${join(shadow, 'botmancers')}, not the managed launcher`));
  const purge = await s.dev(['install', '--to', N, '--purge-global'], env);
  assert.equal(purge.code, 0);
  assert.deepEqual(s.npmCalls().filter(line => line.startsWith('uninstall')), ['uninstall -g botmancers']);
});

test('install, upgrade, activation, rollback, and pruning leave user state byte-for-byte unchanged', async t => {
  const s = await sandbox(t);
  // NOT-494 user state, seeded before any managed operation.
  const seed = {
    'config/core.env': 'BOTMANCERS_SERVICE_TOKENS=botmancers-bridge=sha256:abc\nHERMES_API_SERVER_KEY=keep\n',
    'config/bridge.env': 'BOTMANCERS_SERVICE_TOKEN=bmsvc_x\nBOTMANCERS_MCP_TOKEN=bmmcp_y\n',
    'data/botmancers.db': Buffer.alloc(4096, 3),
    'data/botmancers.db-wal': Buffer.alloc(512, 9),
    'files/report.md': '# kept\n',
    'skills/local/SKILL.md': 'skill\n',
    'logs/core.log': 'log line\n',
    'logs/supervisor.log': 'supervisor\n',
    'workdirs/bot-1/notes.txt': 'workdir\n',
    'run/.keep': '',
  };
  for (const [rel, body] of Object.entries(seed)) {
    mkdirSync(dirname(join(s.home, rel)), { recursive: true });
    writeFileSync(join(s.home, rel), body);
  }
  const userState = () => hashTree(s.home, MANAGED_ENTRIES);
  const baseline = userState();
  assert.equal(Object.keys(baseline).length, Object.keys(seed).length);

  // Three complete releases plus a corrupt, newer fourth.
  seedRelease(s.home, '0.7.0');
  seedRelease(s.home, OLD);
  assert.equal((await s.dev(['install', '--to', N])).code, 0);
  const corrupt = seedRelease(s.home, '0.9.5');
  rmSync(join(corrupt, 'node_modules/botmancers/dist/cli.js'));
  assert.deepEqual(userState(), baseline);

  // The corrupt release is never made current.
  const bad = await s.bm(['upgrade', '--to', '0.9.5']);
  assert.equal(bad.code, 1);
  assert.equal(s.current(), `versions/${N}`);
  assert.deepEqual(userState(), baseline);

  // Upgrade to N+1 and N+2: activation prunes to current + two previous complete releases.
  assert.equal((await s.bm(['upgrade', '--to', N1])).code, 0);
  assert.deepEqual(userState(), baseline);
  assert.deepEqual(readdirSync(join(s.home, 'versions')).sort(), [OLD, N, N1].sort(), 'oldest and corrupt releases pruned');
  assert.equal((await s.bm(['upgrade', '--to', N2])).code, 0);
  assert.deepEqual(readdirSync(join(s.home, 'versions')).sort(), [N, N1, N2].sort());
  assert.deepEqual(userState(), baseline);

  // Roll back to N: no download, N+2 is declined so the updater does not reinstate it.
  const back = await s.bm(['install', '--to', N]);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, new RegExp(`${N} is already installed`));
  assert.equal(s.current(), `versions/${N}`);
  assert.equal(s.state().declinedVersion, N2);
  assert.deepEqual(readdirSync(join(s.home, 'versions')).sort(), [N, N1, N2].sort());
  registry.latest = N2;
  t.after(() => { registry.latest = N; });
  const cliPath = join(s.home, 'versions', N, 'node_modules/botmancers/dist/cli.js');
  assert.equal((await managed.runUpdateCheck(s.env(on), {}, cliPath)).result, 'declined');
  assert.equal(s.state().pendingVersion, null);
  assert.equal((await s.bm(['--version'])).stdout.trim(), N);
  assert.deepEqual(userState(), baseline);

  // An explicit upgrade clears the rollback hold.
  assert.equal((await s.bm(['upgrade'])).code, 0);
  assert.equal(s.current(), `versions/${N2}`);
  assert.equal(s.state().declinedVersion, null);
  assert.deepEqual(userState(), baseline);
});

test('semver ordering and install-kind detection', () => {
  assert.ok(managed.compareSemver('0.10.0', '0.9.9') > 0);
  assert.ok(managed.compareSemver('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(managed.compareSemver('0.3.0', 'v0.3.0'), 0);
  assert.equal(managed.detectInstallKind(process.env).kind, 'dev-checkout');
  assert.equal(managed.detectInstallKind(process.env, { cliPath: '/x/.npm/_npx/abc/node_modules/botmancers/dist/cli.js' }).kind, 'npx');
  assert.equal(managed.detectInstallKind(process.env, { cliPath: '/elsewhere/cli.js' }).kind, 'unknown');
});
