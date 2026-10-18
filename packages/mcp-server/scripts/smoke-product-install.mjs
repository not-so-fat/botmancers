// Full-product clean-install smoke: install the exact botmancers tarball
// into an empty temporary project with an empty HOME and npm cache, then run
// the friend path from an unrelated directory: `botmancers setup`,
// `botmancers start --daemon`, the real UI, a /api/v0 read, the MCP bridge
// (health, tools/list, a read-only tools/call reaching the same engine),
// state across stop/start, and status/doctor/stop. It asserts that the
// running processes and their loaded files come from the temporary install,
// never from this repository or its node_modules.
//
//   node scripts/smoke-product-install.mjs                    pack this directory and install the tarball (offline)
//   node scripts/smoke-product-install.mjs --tarball f.tgz    install a given tarball (offline)
//   node scripts/smoke-product-install.mjs --registry 0.2.0   install botmancers@0.2.0 from the registry
//   ... --out transcript.txt                                  also save the transcript
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_DIR, freePort, run } from './product-harness.mjs';
import { mcpPost, mcpSession } from './harness.mjs';

// tools/list must be exactly the bundled botmancers.mcp.v2 list (v1 tools first).
const BUNDLED_TOOL_NAMES = JSON.parse(readFileSync(new URL('../schemas/botmancers.mcp.v2.tools.json', import.meta.url), 'utf8')).tools.map(tool => tool.name);

const REPO_ROOT = realpathSync(join(PACKAGE_DIR, '..', '..'));
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

async function portOrFree(preferred) {
  const probe = await freePort();
  // Prefer the documented port when it is free; otherwise record the substitute.
  try {
    const { createServer } = await import('node:net');
    await new Promise((ok, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(preferred, '127.0.0.1', () => server.close(ok));
    });
    return preferred;
  } catch {
    return probe;
  }
}

function walkFiles(dir, visit) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    visit(path, stat);
    if (stat.isDirectory()) walkFiles(path, visit);
  }
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function openFiles(pid) {
  try {
    return execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
      .split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  } catch {
    return null;
  }
}

export async function smoke({ tarball, registryVersion } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmancers-product-smoke-')));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const elsewhere = join(root, 'elsewhere');
  const cache = join(root, 'npm-cache');
  for (const dir of [project, home, elsewhere]) mkdirSync(dir, { recursive: true });
  const uiPort = await portOrFree(3333);
  let mcpPort = await portOrFree(3332);
  while (mcpPort === uiPort) mcpPort = await freePort();
  // A clean user: empty HOME and npm cache, no inherited npm config or tokens,
  // no BOTMANCERS_* or NODE_* variables, and a PATH without this repository.
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    npm_config_cache: cache,
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    BOTMANCERS_UI_PORT: String(uiPort),
    BOTMANCERS_MCP_PORT: String(mcpPort),
    BOTMANCERS_MCP_COORDINATORS: 'Smokey',
    ...(registryVersion ? {} : { npm_config_offline: 'true' }),
  };
  const npm = npmArgs => execFileSync('npm', npmArgs, { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const bin = join(project, 'node_modules/.bin/botmancers');
  const botmancers = (cmdArgs, extra = {}) => run(bin, cmdArgs, { env: { ...env, ...extra }, cwd: elsewhere, timeoutMs: 120_000 });
  const botmancersHome = join(home, '.botmancers');

  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* not a git checkout */ }

  try {
    let spec;
    if (registryVersion) {
      spec = `botmancers@${registryVersion}`;
      log(`source: registry ${spec}`);
    } else {
      if (!tarball) {
        // prepack (build + build:app) prints progress to stdout ahead of the JSON.
        const out = execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
        const [entry] = JSON.parse(out.slice(out.lastIndexOf('\n[\n') + 1));
        tarball = join(root, entry.filename);
      }
      spec = resolve(tarball);
      const sha512 = createHash('sha512').update(readFileSync(spec)).digest('base64');
      log(`source: tarball ${spec.split('/').pop()} (${statSync(spec).size} B, integrity sha512-${sha512})`);
    }
    log(`checkout commit: ${commit}`);
    log(`node: ${process.version}, npm: ${npm(['--version']).trim()}, platform: ${process.platform}-${process.arch}`);
    log(`ports: ui/core ${uiPort}${uiPort === 3333 ? ' (default)' : ' (3333 busy; substitute)'}, mcp ${mcpPort}${mcpPort === 3332 ? ' (default)' : ' (3332 busy; substitute)'}`);
    log(`BOTMANCERS_HOME: unset (default ${botmancersHome}); commands run from ${elsewhere}`);

    npm(['init', '-y']);
    check(readdirSync(project).join(',') === 'package.json', 'temporary project is empty apart from package.json');
    npm(['install', '--no-save', spec]);
    const installedDir = join(project, 'node_modules/botmancers');
    const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
    const build = JSON.parse(readFileSync(join(installedDir, 'app/BUILD_INFO.json'), 'utf8'));
    log(`installed: ${installed.name}@${installed.version}; packaged app ${build.version} built from commit ${build.commit}${build.dirty ? ' (dirty tree)' : ''}, next ${build.next}`);
    check(installed.name === 'botmancers' && !installed.private, 'installed package is the public botmancers package');
    if (registryVersion) check(installed.version === registryVersion, `registry version is ${registryVersion}`);
    check(build.version === installed.version, 'packaged app version matches the package version');
    check(readdirSync(join(project, 'node_modules')).filter(name => !name.startsWith('.')).join(',') === 'botmancers', 'no install-time dependencies: the runtime is bundled');

    const escapes = [];
    walkFiles(installedDir, (path, stat) => {
      if (stat.isSymbolicLink()) escapes.push(`${path} -> ${readlinkSync(path)}`);
    });
    check(escapes.length === 0, 'the installed package contains no symlinks (nothing can point back into a checkout)');
    const sourceHits = [];
    walkFiles(join(installedDir, 'app'), (path, stat) => {
      if (stat.isFile() && /\.(?:js|json)$/.test(path) && stat.size < 8 * 1024 * 1024 && readFileSync(path, 'utf8').includes(REPO_ROOT)) sourceHits.push(path);
    });
    check(sourceHits.length === 0, 'no installed file mentions the build checkout path');

    const version = await botmancers(['--version']);
    check(version.code === 0 && version.stdout.trim() === installed.version, `\`botmancers --version\` prints ${installed.version}`);

    const setup = await botmancers(['setup']);
    check(setup.code === 0 && /initialized .*\(owner-only\)/.test(setup.stdout), '`botmancers setup` exits 0 and initializes the default home');
    const mode = path => (statSync(path).mode & 0o777).toString(8);
    check(mode(botmancersHome) === '700' && mode(join(botmancersHome, 'config/core.env')) === '600' && mode(join(botmancersHome, 'config/bridge.env')) === '600',
      `home 0${mode(botmancersHome)}, core.env 0${mode(join(botmancersHome, 'config/core.env'))}, bridge.env 0${mode(join(botmancersHome, 'config/bridge.env'))}`);
    const bridgeEnv = Object.fromEntries(readFileSync(join(botmancersHome, 'config/bridge.env'), 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')));
    const serviceToken = bridgeEnv.BOTMANCERS_SERVICE_TOKEN;
    const mcpToken = bridgeEnv.BOTMANCERS_MCP_TOKEN;
    const coreEnv = readFileSync(join(botmancersHome, 'config/core.env'), 'utf8');
    check(!coreEnv.includes(serviceToken) && coreEnv.includes(`sha256:${createHash('sha256').update(serviceToken).digest('hex')}`), 'core.env holds the service-token digest, not the token');

    const doctorBefore = await botmancers(['doctor']);
    check(doctorBefore.code === 0, `\`botmancers doctor\` before start: ${doctorBefore.stdout.trim().split('\n').pop()}`);

    const start = await botmancers(['start', '--daemon']);
    check(start.code === 0, `\`botmancers start --daemon\` exits 0:\n${start.stdout.trimEnd()}`);
    const status = await botmancers(['status']);
    check(status.code === 0 && /: healthy$/m.test(status.stdout), `\`botmancers status\` is healthy:\n${status.stdout.trimEnd()}`);
    const record = JSON.parse(readFileSync(join(botmancersHome, 'run/product.json'), 'utf8'));
    check(record.ui.port === uiPort && record.mcp.port === mcpPort, `run metadata lists both endpoints: ${record.ui.url} and ${record.mcp.url}`);

    // Provenance: the processes and their loaded code are the temporary install.
    const commands = [record.supervisor.pid, record.ui.pid, record.mcp.pid].map(commandOf);
    log(`processes: supervisor ${record.supervisor.pid} "${commands[0]}", core ${record.ui.pid} "${commands[1]}", bridge ${record.mcp.pid} "${commands[2]}"`);
    check(commands[0].includes(installedDir) && commands[2].includes(installedDir), 'supervisor and bridge run dist/cli.js from the temporary install');
    check(!commands.some(command => command.includes(REPO_ROOT)), 'no process command line references the repository');
    const files = openFiles(record.ui.pid);
    if (files) {
      const native = files.filter(path => path.endsWith('.node'));
      check(native.length > 0 && native.every(path => realpathSync(path).startsWith(realpathSync(installedDir))), `core loaded its native SQLite driver from the install: ${native.map(path => path.replace(root, '<tmp>')).join(', ')}`);
      check(!files.some(path => path.startsWith(REPO_ROOT)), 'core holds no file open under the repository (or its node_modules)');
      const db = files.filter(path => path.includes('botmancers.db'));
      check(db.length > 0 && db.every(path => realpathSync(path).startsWith(realpathSync(botmancersHome))), `core database is under BOTMANCERS_HOME: ${db.map(path => path.replace(root, '<tmp>')).join(', ')}`);
    } else {
      log('note: lsof unavailable; open-file provenance checks skipped');
    }

    const base = `http://127.0.0.1:${uiPort}`;
    const page = await fetch(`${base}/`);
    const html = await page.text();
    check(page.status === 200 && /<title>Botmancers/.test(html), `GET / -> ${page.status}, the built Botmancers UI (${html.length} B)`);
    const asset = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(html)?.[0];
    const assetResponse = asset ? await fetch(`${base}${asset}`) : null;
    check(assetResponse?.status === 200, `static asset ${asset} -> ${assetResponse?.status}`);
    const health = await (await fetch(`${base}/api/health`)).json();
    check(health.status === 'ok' && health.version === installed.version && health.commit === build.commit && health.home === botmancersHome,
      `GET /api/health -> version ${health.version}, commit ${health.commit}, engine ${health.engine}`);
    const missingRequest = await fetch(`${base}/api/v0/requests/smoke-missing-request`, { headers: { authorization: `Bearer ${serviceToken}` } });
    const missingBody = await missingRequest.json();
    check(missingRequest.status === 404 && typeof missingBody.error?.code === 'string', `GET /api/v0/requests/<unknown> with the service token -> ${missingRequest.status} ${missingBody.error?.code} (authenticated engine read)`);
    const anonymous = await fetch(`${base}/api/v0/requests/smoke-missing-request`, { headers: { authorization: 'Bearer wrong-token-0123456789abcdef' } });
    check(anonymous.status === 401, `the same read with a wrong token -> ${anonymous.status}`);

    const owner = { 'content-type': 'application/json', origin: base };
    const agent = await (await fetch(`${base}/api/bots`, { method: 'POST', headers: owner, body: JSON.stringify({ name: 'Smokey', title: 'Install smoke', description: 'smoke', deck_id: '00000000-0000-4000-8000-000000000001' }) })).json();
    check(typeof agent.id === 'string', `created Agent ${agent.name} (${agent.id}) through the UI API`);
    const conversation = await (await fetch(`${base}/api/conversations?botId=${agent.id}`)).json();
    const posted = await fetch(`${base}/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: owner, body: JSON.stringify({ content: 'smoke: kept across restarts' }) });
    check(posted.status === 200, `posted a message to conversation ${conversation.id}`);
    writeFileSync(join(botmancersHome, 'files', 'smoke.txt'), 'smoke file\n');

    const bridgeHealth = await (await fetch(`http://127.0.0.1:${mcpPort}/healthz`)).json();
    check(bridgeHealth.status === 'ok' && bridgeHealth.version === installed.version, `bridge GET /healthz -> ${JSON.stringify(bridgeHealth)}`);
    const session = await mcpSession(`http://127.0.0.1:${mcpPort}/mcp`, mcpToken);
    const names = session.tools.json.result.tools.map(tool => tool.name);
    check(names.join(',') === BUNDLED_TOOL_NAMES.join(','), `MCP tools/list -> ${names.join(', ')}`);
    const structured = session.health.json.result.structuredContent;
    check(session.health.json.result.isError === false && structured.principal.id === 'botmancers-bridge'
      && structured.coordinators.some(entry => entry.name === 'Smokey' && entry.available), `MCP tools/call botmancers_health reaches the same engine -> ${JSON.stringify(structured)}`);
    const rejected = await mcpPost(`http://127.0.0.1:${mcpPort}/mcp`, { token: `${mcpToken}x`, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    check(rejected.status === 401, `a wrong MCP token -> ${rejected.status}`);

    const stop = await botmancers(['stop']);
    check(stop.code === 0, `\`botmancers stop\` -> ${stop.stdout.trim()}`);
    const stopped = await botmancers(['status']);
    check(stopped.code === 3 && /: stopped$/m.test(stopped.stdout), '`botmancers status` after stop exits 3 (stopped)');
    const restart = await botmancers(['start', '--daemon']);
    check(restart.code === 0, '`botmancers start --daemon` again exits 0');
    const bots = await (await fetch(`${base}/api/bots`)).json();
    const history = await (await fetch(`${base}/api/conversations/${conversation.id}/messages`)).text();
    const file = await fetch(`${base}/api/files/smoke.txt`);
    check(bots.some(bot => bot.id === agent.id) && history.includes('smoke: kept across restarts') && file.status === 200,
      'the Agent, its conversation message, and the file survived stop/start');
    const again = await botmancers(['start', '--daemon']);
    check(again.code === 0 && /already running/.test(again.stdout), 'a repeated start leaves the running product alone');
    const doctor = await botmancers(['doctor']);
    check(doctor.code === 0 && /ok {4}product/.test(doctor.stdout), `\`botmancers doctor\` while running: ${doctor.stdout.trim().split('\n').pop()}`);
    const finalStop = await botmancers(['stop']);
    check(finalStop.code === 0 && (await botmancers(['stop'])).code === 0, '`botmancers stop` twice exits 0');

    const homeEntries = readdirSync(botmancersHome).sort().join(',');
    check(homeEntries === 'config,data,files,logs,run,skills', `BOTMANCERS_HOME holds ${homeEntries}`);
    check(readdirSync(elsewhere).length === 0, 'nothing was written to the launch directory');
    const outputs = [setup, doctorBefore, start, status, stop, restart, again, doctor, finalStop].map(result => result.stdout + result.stderr).join('\n')
      + readFileSync(join(botmancersHome, 'logs/supervisor.log'), 'utf8') + readFileSync(join(botmancersHome, 'logs/bridge.log'), 'utf8') + readFileSync(join(botmancersHome, 'logs/core.log'), 'utf8');
    check(!outputs.includes(serviceToken) && !outputs.includes(mcpToken), 'no token in command output or logs');
    log(`PASS product install smoke for ${installed.name}@${installed.version} (app commit ${build.commit}) at checkout ${commit}; ui ${uiPort}, mcp ${mcpPort}`);
  } finally {
    try {
      execFileSync(bin, ['stop'], { env, cwd: elsewhere, stdio: 'ignore', timeout: 30_000 });
    } catch { /* not installed or already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
}

const out = option('--out');
smoke({ tarball: option('--tarball'), registryVersion: option('--registry') }).then(
  () => {
    if (out) writeFileSync(out, `${lines.join('\n')}\n`);
  },
  error => {
    log(`FAIL ${error.message}`);
    if (out) writeFileSync(out, `${lines.join('\n')}\n`);
    process.exit(1);
  },
);
