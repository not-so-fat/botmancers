// Managed-install smoke (NOT-495): the friend path against the exact
// botmancers tarball, for a clean user whose PATH holds only a temporary
// ~/.local/bin, node/npm, and the system directories.
//
// A local npm registry serves the exact tarball N as `latest` (with its real
// sha512 integrity), and later N+1: the same tarball repacked with only its
// version bumped. The smoke runs the repository's scripts/install.sh (the
// curl | bash entry point), then through the launcher: --version, doctor,
// setup, start, the UI, /api/health, and the MCP bridge against the same
// engine; creates state; publishes N+1 and lets the background updater stage
// it beside the live N; checks status reports N running with N+1 pending;
// restarts once to activate N+1; rolls back to N; and confirms the state and
// user-state file hashes survive, and that BOTMANCERS_DISABLE_AUTOUPDATER=1
// stops every automatic registry request.
//
//   node scripts/smoke-managed-install.mjs --tarball botmancers-X.Y.Z.tgz [--out transcript.txt]
//   node scripts/smoke-managed-install.mjs                    pack this directory first
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_DIR, freePort, run, waitFor } from './product-harness.mjs';
import { mcpSession } from './harness.mjs';
import { integrityOf, pack, startRegistry } from './managed-harness.mjs';

const REPO_ROOT = realpathSync(join(PACKAGE_DIR, '..', '..'));
const INSTALL_SH = join(REPO_ROOT, 'scripts', 'install.sh');
const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const lines = [];
const log = line => {
  lines.push(line);
  process.stdout.write(`${line}\n`);
};
function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
  log(`ok  ${message}`);
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const bump = version => version.replace(/(\d+)$/, patch => String(Number(patch) + 1));

function whichAll(env, name) {
  try {
    return execFileSync('/bin/sh', ['-c', `IFS=:; for d in $PATH; do [ -x "$d/${name}" ] && echo "$d/${name}"; done; true`], { env, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// N+1: the exact tarball N with only package.json and app/BUILD_INFO.json
// versions changed.
function repackNext(tarball, version, workdir) {
  const dir = join(workdir, `next-${version}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  const pkg = join(dir, 'package');
  const previous = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  for (const file of ['package.json', 'app/BUILD_INFO.json', 'app/package.json']) {
    const path = join(pkg, file);
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }, null, 2)}\n`);
  }
  // next build inlines the release version (BOTMANCERS_BUILD_VERSION) into the
  // health route and the server config; rewrite exactly those literals.
  const inlined = [
    [`service:"botmancers-core",version:"${previous}"`, `service:"botmancers-core",version:"${version}"`],
    [`"BOTMANCERS_BUILD_VERSION":"${previous}"`, `"BOTMANCERS_BUILD_VERSION":"${version}"`],
  ];
  let rewritten = 0;
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:js|json)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        const next = inlined.reduce((acc, [from, to]) => acc.split(from).join(to), text);
        if (next !== text) {
          writeFileSync(full, next);
          rewritten += 1;
        }
      }
    }
  };
  visit(join(pkg, 'app'));
  if (!rewritten) throw new Error(`could not find the inlined core version ${previous} to bump`);
  return pack(pkg, join(workdir, 'tgz'));
}

export async function smoke({ tarball } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-managed-smoke-')));
  const user = join(root, 'user');
  const bin = join(user, '.local', 'bin');
  const tools = join(root, 'tools');
  const elsewhere = join(root, 'elsewhere');
  for (const dir of [user, tools, elsewhere]) mkdirSync(dir, { recursive: true });
  // node and npm only, so nothing else on PATH can provide `botmancers`.
  const nodeBin = dirname(process.execPath);
  for (const tool of ['node', 'npm', 'npx']) symlinkSync(join(nodeBin, tool), join(tools, tool));
  const home = join(user, '.botmancers');
  const launcher = join(bin, 'botmancers');
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* not a git checkout */ }

  let registry;
  const env = { PATH: [bin, tools, '/usr/bin', '/bin'].join(':') };
  const botmancers = (cmdArgs, extra = {}) => run('botmancers', cmdArgs, { env: { ...env, ...extra }, cwd: elsewhere, timeoutMs: 180_000 });
  try {
    if (!tarball) {
      const out = execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      tarball = join(root, JSON.parse(out.slice(out.lastIndexOf('\n[\n') + 1))[0].filename);
    }
    tarball = resolve(tarball);
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    const N = manifest.version;
    const N1 = bump(N);
    const integrityN = integrityOf(tarball);
    log(`source: tarball ${tarball.split('/').pop()} = botmancers@${N}, integrity ${integrityN}`);
    log(`checkout commit: ${commit}`);
    const nextTarball = repackNext(tarball, N1, root);
    const integrityN1 = integrityOf(nextTarball);
    log(`N+1: botmancers@${N1} repacked from the same tarball, integrity ${integrityN1}`);
    registry = await startRegistry({ releases: { [N]: tarball, [N1]: nextTarball }, latest: N });
    const ui = await freePort();
    let mcp = await freePort();
    while (mcp === ui) mcp = await freePort();
    Object.assign(env, {
      HOME: user,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_userconfig: join(user, '.npmrc'),
      npm_config_registry: registry.url,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      BOTMANCERS_UI_PORT: String(ui),
      BOTMANCERS_MCP_PORT: String(mcp),
      BOTMANCERS_MCP_COORDINATORS: 'Smokey',
    });
    log(`node ${process.version}, npm ${execFileSync('npm', ['--version'], { env, encoding: 'utf8' }).trim()}, ${process.platform}-${process.arch}; registry ${registry.url}; ports ui ${ui}, mcp ${mcp}`);
    log(`PATH=${env.PATH}`);
    log(`  ${tools}: ${readdirSync(tools).join(', ')}`);
    check(whichAll(env, 'botmancers').length === 0, 'before install, no botmancers anywhere on PATH');

    // 1. The friend path: scripts/install.sh (what curl | bash runs).
    const install = await run('bash', [INSTALL_SH], { env, cwd: elsewhere, timeoutMs: 300_000 });
    log(install.stdout.trimEnd().split('\n').map(line => `    | ${line}`).join('\n'));
    check(install.code === 0, `scripts/install.sh exits 0${install.code ? `: ${install.stderr}` : ''}`);
    check(readdirSync(join(home, 'versions')).join(',') === N, `${home}/versions holds only ${N}`);
    check(lstatSync(join(home, 'current')).isSymbolicLink() && readlinkSync(join(home, 'current')) === `versions/${N}`, `current -> ${readlinkSync(join(home, 'current'))}`);
    const lock = JSON.parse(readFileSync(join(home, 'versions', N, 'package-lock.json'), 'utf8'));
    check(lock.packages['node_modules/botmancers'].integrity === integrityN, `versions/${N} was installed from the exact tarball (${integrityN})`);
    check(whichAll(env, 'botmancers').join(',') === launcher, `PATH resolves botmancers only to the launcher ${launcher}`);
    log(`launcher:\n${readFileSync(launcher, 'utf8').trimEnd().split('\n').map(line => `    | ${line}`).join('\n')}`);

    const version = await botmancers(['--version']);
    check(version.code === 0 && version.stdout.trim() === N, `botmancers --version -> ${version.stdout.trim()}`);
    const doctor0 = await botmancers(['doctor']);
    log(doctor0.stdout.trimEnd().split('\n').map(line => `    | ${line}`).join('\n'));
    check(/info  install     managed/.test(doctor0.stdout) && /ok    path {8}PATH resolves botmancers to/.test(doctor0.stdout), 'doctor reports a managed install resolved through the launcher');
    check((await botmancers(['setup'])).code === 0, 'botmancers setup');
    const doctor = await botmancers(['doctor']);
    check(doctor.code === 0, `botmancers doctor: ${doctor.stdout.trim().split('\n').pop()}`);
    const start = await botmancers(['start', '--daemon']);
    check(start.code === 0, `botmancers start --daemon:\n${start.stdout.trimEnd()}`);
    const status = await botmancers(['status']);
    log(status.stdout.trimEnd().split('\n').map(line => `    | ${line}`).join('\n'));
    check(status.code === 0 && new RegExp(`running     core ${N}, bridge ${N}`).test(status.stdout), `status: healthy, running ${N}`);
    const record = () => JSON.parse(readFileSync(join(home, 'run/product.json'), 'utf8'));
    check(record().cli === join(home, 'versions', N, 'node_modules/botmancers/dist/cli.js'), `supervisor and bridge run ${record().cli.replace(root, '<tmp>')}`);

    // 2. The unified product through the launcher, and some user state.
    const base = `http://127.0.0.1:${ui}`;
    const page = await fetch(`${base}/`);
    check(page.status === 200 && /<title>Botmancers/.test(await page.text()), `GET / -> ${page.status}, the Botmancers UI`);
    const health = async () => (await (await fetch(`${base}/api/health`)).json());
    const bridgeVersion = async () => (await (await fetch(`http://127.0.0.1:${mcp}/healthz`)).json()).version;
    check((await health()).version === N && (await bridgeVersion()) === N, `/api/health and bridge /healthz -> ${N}`);
    const mcpToken = /^BOTMANCERS_MCP_TOKEN=(\S+)$/m.exec(readFileSync(join(home, 'config/bridge.env'), 'utf8'))[1];
    const owner = { 'content-type': 'application/json', origin: base };
    const agent = await (await fetch(`${base}/api/bots`, { method: 'POST', headers: owner, body: JSON.stringify({ name: 'Smokey', title: 'Managed smoke', description: 'smoke', deck_id: '00000000-0000-4000-8000-000000000001' }) })).json();
    const conversation = await (await fetch(`${base}/api/conversations?botId=${agent.id}`)).json();
    const posted = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: owner, body: JSON.stringify({ content: 'managed smoke: kept across upgrade and rollback' }) });
    check(typeof agent.id === 'string' && posted.status === 200, `created Agent ${agent.id} and a message in conversation ${conversation.id}`);
    writeFileSync(join(home, 'files', 'managed-smoke.txt'), 'kept\n');
    mkdirSync(join(home, 'skills', 'smoke'), { recursive: true });
    writeFileSync(join(home, 'skills', 'smoke', 'SKILL.md'), 'smoke skill\n');
    const session = await mcpSession(`http://127.0.0.1:${mcp}/mcp`, mcpToken);
    check(session.health.json.result.structuredContent.status === 'ok', 'MCP tools/call botmancers_health reaches the same engine');
    const stateFiles = ['config/core.env', 'config/bridge.env', 'files/managed-smoke.txt', 'skills/smoke/SKILL.md'];
    const hashes = () => Object.fromEntries(stateFiles.map(file => [file, sha256(join(home, file))]));
    const before = hashes();
    log(`user-state hashes: ${JSON.stringify(before)}`);
    const stateIntact = async label => {
      const bots = await (await fetch(`${base}/api/bots`)).json();
      const history = await (await fetch(`${base}/api/conversations/${conversation.id}/messages`)).text();
      check(bots.some(bot => bot.id === agent.id) && history.includes('kept across upgrade and rollback'), `${label}: the Agent and its message are still there`);
      check(JSON.stringify(hashes()) === JSON.stringify(before), `${label}: user-state file hashes unchanged`);
    };

    // 3. Publish N+1; the background updater stages it beside the live N.
    registry.latest = N1;
    const supervisorPid = record().supervisor.pid;
    const statePath = join(home, 'update-state.json');
    const checked = JSON.parse(readFileSync(statePath, 'utf8'));
    check(checked.latest === N && checked.pendingVersion === null, `the product's own daily check already ran at ${checked.checkedAt} (latest ${checked.latest}); nothing pending`);
    const quiet = await botmancers(['status']);
    check(quiet.code === 0 && JSON.parse(readFileSync(statePath, 'utf8')).checkedAt === checked.checkedAt, 'within 24 hours no second check runs, even though N+1 is now on latest');
    // The next day: age the last check past 24 hours.
    writeFileSync(statePath, JSON.stringify({ ...checked, checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));
    log(`(simulating the next day: checkedAt set to 25 hours ago)`);
    const trigger = await botmancers(['status']);
    check(trigger.code === 0, 'botmancers status (schedules the daily update check) exits 0 at once');
    const staged = await waitFor(() => {
      try { return JSON.parse(readFileSync(join(home, 'update-state.json'), 'utf8')).pendingVersion === N1; } catch { return false; }
    }, 180_000);
    check(staged, `the detached updater staged ${N1}: ${readFileSync(join(home, 'update-state.json'), 'utf8').replace(/\s+/g, ' ')}`);
    check(readdirSync(join(home, 'versions')).sort().join(',') === [N, N1].sort().join(',') && readlinkSync(join(home, 'current')) === `versions/${N}`, `versions/${N1} staged; current still -> versions/${N}`);
    check(record().supervisor.pid === supervisorPid && (await health()).version === N && (await bridgeVersion()) === N, `the live product was not interrupted: supervisor pid ${supervisorPid}, core and bridge still ${N}`);
    const pendingStatus = await botmancers(['status']);
    log(pendingStatus.stdout.trimEnd().split('\n').map(line => `    | ${line}`).join('\n'));
    check(new RegExp(`pending ${N1} \\(staged, not running\\)`).test(pendingStatus.stdout) && new RegExp(`running     core ${N}, bridge ${N}`).test(pendingStatus.stdout)
      && /restart     botmancers stop && botmancers start --daemon/.test(pendingStatus.stdout), `status shows ${N} running, ${N1} pending, and the restart action`);

    // 4. Restart once: N+1 activates.
    check((await botmancers(['stop'])).code === 0, 'botmancers stop');
    const restart = await botmancers(['start', '--daemon']);
    log(restart.stdout.trimEnd().split('\n').map(line => `    | ${line}`).join('\n'));
    check(restart.code === 0 && new RegExp(`activated ${N1} \\(was ${N}\\)`).test(restart.stdout), `botmancers start activated ${N1}`);
    check((await health()).version === N1 && (await bridgeVersion()) === N1 && readlinkSync(join(home, 'current')) === `versions/${N1}`, `core and bridge report ${N1}; current -> versions/${N1}`);
    check((await botmancers(['status'])).code === 0, 'status healthy after the upgrade');
    await stateIntact(`after upgrade to ${N1}`);

    // 5. Roll back to N.
    check((await botmancers(['stop'])).code === 0, 'botmancers stop');
    const rollback = await botmancers(['install', '--to', N]);
    check(rollback.code === 0 && new RegExp(`activated ${N} \\(was ${N1}\\)`).test(rollback.stdout), `botmancers install --to ${N} (rollback) activated ${N} without a download`);
    check((await botmancers(['start', '--daemon'])).code === 0 && (await health()).version === N && (await bridgeVersion()) === N, `after rollback the product runs ${N}`);
    await stateIntact(`after rollback to ${N}`);

    // 6. The kill switch: no automatic registry traffic or state change at all.
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), checkedAt: '2000-01-01T00:00:00.000Z', declinedVersion: null }));
    const frozen = readFileSync(statePath, 'utf8');
    const hits = registry.hits.length;
    const off = { BOTMANCERS_DISABLE_AUTOUPDATER: '1' };
    for (const cmd of [['status'], ['doctor'], ['stop'], ['start', '--daemon'], ['status']]) await botmancers(cmd, off);
    await new Promise(done => setTimeout(done, 1500));
    check(registry.hits.length === hits && readFileSync(statePath, 'utf8') === frozen && readlinkSync(join(home, 'current')) === `versions/${N}`,
      'BOTMANCERS_DISABLE_AUTOUPDATER=1: no registry request, update-state unchanged, current unchanged across status/doctor/stop/start');
    check((await botmancers(['stop'], off)).code === 0, 'botmancers stop');

    const homeEntries = readdirSync(home).sort().join(',');
    check(homeEntries === 'config,current,data,files,logs,run,skills,update-state.json,versions', `BOTMANCERS_HOME holds ${homeEntries}`);
    check(readdirSync(elsewhere).length === 0, 'nothing was written to the launch directory');
    log(`PASS managed install smoke for botmancers@${N} -> ${N1} -> ${N} (integrity ${integrityN}) at checkout ${commit}`);
  } finally {
    if (existsSync(launcher)) {
      try {
        execFileSync(launcher, ['stop'], { env, cwd: elsewhere, stdio: 'ignore', timeout: 30_000 });
      } catch { /* already stopped */ }
    }
    await registry?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const out = option('--out');
smoke({ tarball: option('--tarball') }).then(
  () => {
    if (out) writeFileSync(out, `${lines.join('\n')}\n`);
  },
  error => {
    log(`FAIL ${error.message}`);
    if (out) writeFileSync(out, `${lines.join('\n')}\n`);
    process.exit(1);
  },
);
