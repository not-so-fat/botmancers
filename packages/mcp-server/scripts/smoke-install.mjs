// Clean-install smoke for bridge-only mode: install the package into an empty
// temporary project with an empty HOME and npm cache, then run it the way an
// existing MCP configuration does: `npx botmancers --help`, the installed
// `botmancers` binary, and a served bridge against a fake Botmancers, driven
// by an MCP client. The full product (UI/core plus bridge) is covered by
// smoke-product-install.mjs.
//
//   node scripts/smoke-install.mjs                    pack this directory and install the tarball (offline)
//   node scripts/smoke-install.mjs --tarball f.tgz    install a given tarball (offline)
//   node scripts/smoke-install.mjs --registry 0.1.0   install botmancers@0.1.0 from the registry (canary/stable check)
//   ... --out transcript.txt                          also save the transcript
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PACKAGE_DIR } from './check-pack.mjs';
import { startFakeBotmancers } from './fake-botmancers.mjs';
import { mcpSession, runBridge, stopBridge } from './harness.mjs';

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

const SERVICE_TOKEN = `smoke-svc-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24)}`;
const MCP_TOKEN = `smoke-mcp-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24)}`;

export async function smoke({ tarball, registryVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmancers-smoke-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const cache = join(root, 'npm-cache');
  for (const dir of [project, home]) execFileSync('mkdir', ['-p', dir]);
  // A clean user: empty HOME and npm cache, no inherited npm config or tokens.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    npm_config_cache: cache,
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...(registryVersion ? {} : { npm_config_offline: 'true' }),
  };
  const npm = (npmArgs, cwd = project) => execFileSync('npm', npmArgs, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_DIR, encoding: 'utf8' }).trim();
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
      log(`source: tarball ${spec.split('/').pop()} (integrity sha512-${sha512})`);
    }
    log(`commit: ${commit}`);
    log(`node: ${process.version}, npm: ${npm(['--version']).trim()}`);

    npm(['init', '-y']);
    check(readdirSync(project).join(',') === 'package.json', 'temporary project is empty apart from package.json');
    npm(['install', '--no-save', spec]);
    const installed = JSON.parse(readFileSync(join(project, 'node_modules/botmancers/package.json'), 'utf8'));
    log(`installed: ${installed.name}@${installed.version}`);
    check(installed.name === 'botmancers' && !installed.private, 'installed package is the public botmancers package');
    if (registryVersion) check(installed.version === registryVersion, `registry version is ${registryVersion}`);

    const shipped = readdirSync(join(project, 'node_modules/botmancers')).sort();
    check(shipped.every(name => ['CHANGELOG.md', 'LICENSE', 'README.md', 'app', 'dist', 'package.json', 'schemas'].includes(name)), `installed files are only ${shipped.join(', ')}`);
    check(Object.keys(installed.dependencies ?? {}).length === 0 && readdirSync(join(project, 'node_modules')).filter(n => !n.startsWith('.')).join(',') === 'botmancers', 'no transitive dependencies installed');

    const help = await runBridge('npx', ['botmancers', '--help'], { env, cwd: project });
    check(help.code === 0 && help.stdout.includes('Usage: botmancers'), '`npx botmancers --help` exits 0 and prints usage');
    const bin = join(project, 'node_modules/.bin/botmancers');
    const version = await runBridge(bin, ['--version'], { env, cwd: project });
    check(version.code === 0 && version.stdout.trim() === installed.version, `installed \`botmancers --version\` prints ${installed.version}`);
    const unconfigured = await runBridge(bin, [], { env, cwd: project });
    check(unconfigured.code === 2 && unconfigured.stderr.includes('BOTMANCERS_URL is required'), 'installed binary without configuration exits 2 with guidance');

    const fake = await startFakeBotmancers({ serviceToken: SERVICE_TOKEN });
    const serveEnv = { ...env, BOTMANCERS_URL: fake.url, BOTMANCERS_SERVICE_TOKEN: SERVICE_TOKEN, BOTMANCERS_MCP_TOKEN: MCP_TOKEN, BOTMANCERS_MCP_PORT: '0' };
    const started = await runBridge('npx', ['botmancers'], { env: serveEnv, cwd: project });
    try {
      check(started.port !== null, `\`npx botmancers\` serves: ${started.stderr.trim().split('\n').pop()}`);
      const base = `http://127.0.0.1:${started.port}`;
      const health = await (await fetch(`${base}/healthz`)).json();
      check(health.status === 'ok' && health.version === installed.version, `GET /healthz -> ${JSON.stringify(health)}`);
      const session = await mcpSession(`${base}/mcp`, MCP_TOKEN);
      const init = session.initialize.json.result;
      check(init.serverInfo.name === 'botmancers' && init.serverInfo.version === installed.version, `MCP initialize -> ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`);
      const names = session.tools.json.result.tools.map(tool => tool.name);
      check(names.join(',') === 'botmancers_start_task,botmancers_get_request,botmancers_get_conversation,botmancers_health', `tools/list -> ${names.join(', ')}`);
      const result = session.health.json.result;
      check(result.isError === false && result.structuredContent.status === 'ok', `tools/call botmancers_health -> ${JSON.stringify(result.structuredContent)}`);
      check(fake.received.some(entry => entry.headers.authorization === `Bearer ${SERVICE_TOKEN}`), 'fake Botmancers received the service token');
    } finally {
      const code = started.child ? await stopBridge(started.child) : started.code;
      const output = started.child ? started.output().stderr : started.stderr;
      await fake.close();
      check(code === 0, 'SIGTERM stops the bridge with exit 0');
      check(!output.includes(SERVICE_TOKEN) && !output.includes(MCP_TOKEN), 'bridge output contains no token');
    }
    log(`PASS clean-install smoke for ${installed.name}@${installed.version} at ${commit}`);
  } finally {
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

