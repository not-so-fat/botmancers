#!/usr/bin/env node
// NOT-493: Cursor Grok Bot task handoff through the packaged MCP bridge.
//
//   npm run test:grok-handoff                              pack packages/mcp-server and install the tarball (offline)
//   npm run test:grok-handoff -- --tarball f.tgz           install a given tarball (offline)
//   npm run test:grok-handoff -- --registry 0.1.0          install botmancers@0.1.0 from the registry
//   ... --out docs/integrations/grok-bot/evidence/fixture-smoke.txt   also save the transcript
//
// The parent checks the checked-in Grok Bot templates (exact version pin,
// placeholders only), installs the bridge package the way an operator
// does, and runs the scenario in a disposable acceptance-harness root
// (temporary database, HOME, workspace; loopback only). The scenario
// serves the real Botmancers route handlers, runs the installed
// `botmancers` binary against them, puts a Host-rewriting route in front
// of the bridge (the stand-in for the operator's HTTPS tunnel or private
// network), and drives it as a Grok-compatible remote MCP client:
// initialize, tools/list, botmancers_health, botmancers_start_task once,
// poll pending -> running -> succeeded, read the final conversation, retry
// the same invocation id (mid-flight and after terminal), and reuse the
// key with a changed objective. Fail-closed startup and authentication
// are checked with row counts. The transcript prints no token, port, or
// raw id, so it is deterministic.
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createHash } = require('crypto');

const ROOT = require('./support/repo-root');
const TEMPLATE_DIR = path.join(ROOT, 'docs', 'integrations', 'grok-bot');
const PACKAGE_DIR = path.join(ROOT, 'packages', 'mcp-server');
const TOOL_NAMES = ['botmancers_start_task', 'botmancers_get_request', 'botmancers_get_conversation', 'botmancers_health'];

const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

// ---- parent: templates, package install, harness ------------------------

// The exact version the runbook and templates pin; every mention must agree.
function pinnedVersion() {
  const files = ['README.md', 'bridge.env.template'].map(name => path.join(TEMPLATE_DIR, name));
  const versions = new Set();
  for (const file of files) for (const match of fs.readFileSync(file, 'utf8').matchAll(/botmancers@([0-9A-Za-z.+-]+)/g)) versions.add(match[1].replace(/[.]+$/, ''));
  if (versions.size !== 1) throw new Error(`Grok Bot runbook must pin exactly one botmancers version, found: ${[...versions].join(', ') || 'none'}`);
  const [version] = versions;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`pinned version ${version} is not an exact x.y.z version`);
  return version;
}

// Placeholders only: no token-shaped values, digests, or literal bearer credentials.
function secretScan() {
  const findings = [];
  const patterns = [
    [/\b[0-9a-f]{32,}\b/i, 'long hex value'],
    [/sha256:(?!<)[0-9a-z]/i, 'literal sha256 digest'],
    [/Bearer\s+(?![<$])[A-Za-z0-9._~+/-]{8,}/, 'literal bearer token'],
    [/\b(?:npm_|ghp_|gho_|xai-|sk-)[A-Za-z0-9]{8,}/, 'vendor token prefix'],
    [/^\s*(?:export\s+)?BOTMANCERS_(?:SERVICE|MCP)_TOKEN=(?!<)\S/m, 'filled-in token variable'],
  ];
  const files = fs.readdirSync(TEMPLATE_DIR, { recursive: true }).map(name => path.join(TEMPLATE_DIR, String(name))).filter(file => fs.statSync(file).isFile());
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of patterns) if (pattern.test(text)) findings.push(`${path.relative(ROOT, file)}: ${label}`);
  }
  return { files: files.map(file => path.relative(ROOT, file)).sort(), findings };
}

// Installs the bridge into an empty project with an empty HOME and npm
// cache, as smoke-install.mjs does, and returns the installed binary.
function installBridge(dir, version) {
  const project = path.join(dir, 'project');
  const home = path.join(dir, 'npm-home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const registry = option('--registry');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    npm_config_cache: path.join(dir, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...(registry ? {} : { npm_config_offline: 'true' }),
  };
  let spec;
  let source;
  if (registry) {
    spec = `botmancers@${registry}`;
    source = `registry ${spec}`;
  } else {
    let tarball = option('--tarball');
    if (!tarball) {
      const [entry] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      tarball = path.join(dir, entry.filename);
    }
    spec = path.resolve(tarball);
    source = `tarball ${path.basename(spec)} (integrity sha512-${createHash('sha512').update(fs.readFileSync(spec)).digest('base64')})`;
  }
  execFileSync('npm', ['init', '-y'], { cwd: project, env, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-save', spec], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const installed = JSON.parse(fs.readFileSync(path.join(project, 'node_modules', 'botmancers', 'package.json'), 'utf8'));
  if (installed.name !== 'botmancers' || installed.version !== version) {
    throw new Error(`installed ${installed.name}@${installed.version}, but the runbook pins botmancers@${version}`);
  }
  // npm records the installed artifact's sha512 for both tarball and registry installs.
  const integrity = (JSON.parse(fs.readFileSync(path.join(project, 'node_modules', '.package-lock.json'), 'utf8')).packages['node_modules/botmancers'] || {}).integrity || null;
  return { cli: path.join(project, 'node_modules', 'botmancers', installed.bin.botmancers), version: installed.version, source, integrity };
}

async function parent() {
  const lines = [];
  const log = line => {
    lines.push(line);
    console.log(line);
  };
  let ok = true;
  const check = (condition, label) => {
    if (!condition) ok = false;
    log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
    return !!condition;
  };

  log('Grok Bot templates');
  const version = pinnedVersion();
  check(true, `runbook and bridge template pin exactly botmancers@${version}`);
  const scan = secretScan();
  check(scan.findings.length === 0, `secret scan of ${scan.files.join(', ')}: ${scan.findings.length ? scan.findings.join('; ') : 'no secret values'}`);
  const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'cursor-mcp.template.json'), 'utf8'));
  const server = template.mcpServers && template.mcpServers.botmancers;
  check(server && /^https:\/\/<[A-Z_]+>\/mcp$/.test(server.url) && server.headers.Authorization === 'Bearer ${env:BOTMANCERS_MCP_TOKEN}' && Object.keys(server).sort().join(',') === 'headers,url',
    'Grok Bot client template: HTTPS URL placeholder and an env-referenced bearer header, nothing else');

  const harnessLib = require('./support/acceptance/harness.js');
  const harness = harnessLib.createHarness('grok-handoff');
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-grok-bridge-'));
  let run = { code: 1, err: '' };
  try {
    const bridge = installBridge(installDir, version);
    log(`\nBridge package\n  source: ${bridge.source}\n  installed: botmancers@${bridge.version}`);
    const recorded = (fs.readFileSync(path.join(PACKAGE_DIR, 'release-evidence', 'clean-install-smoke.txt'), 'utf8').match(/integrity (sha512-\S+?)\)/) || [])[1];
    check(!!recorded && bridge.integrity === recorded, `the installed package is byte-identical to the one recorded in packages/mcp-server/release-evidence for botmancers@${version}${recorded ? '' : ' (no recorded integrity found)'}`);
    run = await new Promise(resolve => {
      const proc = spawn(process.execPath, [__filename], {
        cwd: harness.root,
        env: harness.env({ BOTMANCERS_GROK_TEST_CHILD: '1', BOTMANCERS_GROK_BRIDGE_CLI: bridge.cli, BOTMANCERS_GROK_BRIDGE_VERSION: bridge.version }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      let buffer = '';
      proc.stdout.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts) log(line);
      });
      proc.stderr.on('data', chunk => { err += chunk; });
      proc.on('exit', code => {
        if (buffer) log(buffer);
        resolve({ code, err });
      });
    });
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  if (run.err) process.stderr.write(run.err.slice(-4000));
  const passed = ok && run.code === 0;
  const preserved = harness.finish(passed, run.err.slice(-4000));
  log(`\nTEST RESULT: ${passed ? 'PASS' : `FAIL${preserved ? ' (harness root kept)' : ''}`}`);
  if (preserved) console.log(`harness root: ${preserved}`);
  const out = option('--out');
  if (out) fs.writeFileSync(out, `${lines.join('\n')}\n`);
  return passed ? 0 : 1;
}

// ---- child: the scenario inside the harness root ------------------------

const digest = token => `sha256:${createHash('sha256').update(token).digest('hex')}`;

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Runs the installed bridge binary until it listens or exits.
function runBridge(cli, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`bridge did not start or exit: ${output}`));
    }, timeoutMs);
    const onData = chunk => {
      output += chunk;
      const match = /listening on http:\/\/\S+?:(\d+)\/mcp/.exec(output);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ port: Number(match[1]), proc, output: () => output, code: null });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ port: null, proc: null, output: () => output, code });
    });
  });
}

function stopBridge(proc) {
  return new Promise(resolve => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.once('exit', code => resolve(code));
    proc.kill('SIGTERM');
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// The operator's route in miniature: forwards /mcp to the loopback bridge,
// passing Authorization through unchanged and rewriting Host to the
// bridge's loopback address (what a TLS-terminating tunnel or reverse
// proxy must do; TLS itself is outside this fixture).
async function startRoute(bridgePort) {
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: '127.0.0.1', port: bridgePort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${bridgePort}` },
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'bad_gateway', message: 'Bridge unreachable.' } }));
    });
    req.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// A Grok-compatible remote MCP client: Streamable HTTP, bearer header,
// the initialize handshake, then the negotiated protocol version on every
// later request.
function grokClient(url, token) {
  let id = 0;
  let protocolVersion = null;
  async function post(body, extraHeaders = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': 'grok-bot-fixture/1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, json, text };
  }
  return {
    post,
    async initialize() {
      const init = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok-bot-fixture', version: '1' } } });
      if (init.json && init.json.result) protocolVersion = init.json.result.protocolVersion;
      const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return { init, initialized };
    },
    rpc: (method, params = {}) => post({ jsonrpc: '2.0', id: ++id, method, params }),
    async call(name, toolArgs = {}) {
      const res = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: toolArgs } });
      const result = res.json && res.json.result;
      return { ...res, result, data: result && result.structuredContent };
    },
  };
}

async function child() {
  const { createContext } = require('./support/acceptance/engine-context.js');
  const ctx = createContext('grok-handoff');
  const { raw, engine } = ctx;
  const cli = process.env.BOTMANCERS_GROK_BRIDGE_CLI;
  const version = process.env.BOTMANCERS_GROK_BRIDGE_VERSION;
  let failures = 0;
  const check = (condition, label) => {
    if (!condition) failures += 1;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
    return !!condition;
  };
  const section = title => console.log(`\n${title}`);

  // Fixture-only tokens, generated per run and never printed.
  const SERVICE_TOKEN = `fixture-svc-${createHash('sha256').update(`svc${Math.random()}`).digest('hex').slice(0, 32)}`;
  const MCP_TOKEN = `fixture-mcp-${createHash('sha256').update(`mcp${Math.random()}`).digest('hex').slice(0, 32)}`;
  const SERVICE_ID = 'grok-bot';
  const INVOCATION_ID = 'grok-run-0001';
  const OBJECTIVE = 'Read-only: summarize README.md of the disposable workspace in one sentence. Do not change anything.';

  const TABLES = ['conversations', 'conversation_intakes', 'messages', 'wakes', 'work_requests', 'work_attempts', 'engine_events', 'conversation_events', 'session_bindings'];
  const counts = () => Object.fromEntries(TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const launches = [];
  const snapshot = () => ({ ...counts(), coordinator_launches: launches.length });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const serviceRows = () => ({
    intakes: raw.prepare("SELECT COUNT(*) AS n FROM conversation_intakes WHERE requester_kind = 'service' AND requester_id = ?").get(SERVICE_ID).n,
    intakes_for_key: raw.prepare("SELECT COUNT(*) AS n FROM conversation_intakes WHERE requester_kind = 'service' AND requester_id = ? AND idempotency_key = ?").get(SERVICE_ID, `mcp:${INVOCATION_ID}`).n,
    work_requests: raw.prepare("SELECT COUNT(*) AS n FROM work_requests WHERE requester_kind = 'service' AND requester_id = ?").get(SERVICE_ID).n,
  });

  // Ids are printed as stable labels so the transcript is deterministic.
  const labels = new Map();
  const label = (value, name) => {
    if (!labels.has(value)) labels.set(value, name);
    return labels.get(value);
  };
  const redact = value => JSON.parse(JSON.stringify(value), (key, v) => {
    if (/_at$/.test(key) && typeof v === 'number') return '<ms>';
    if (typeof v === 'string' && labels.has(v)) return labels.get(v);
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return '<id>';
    return v;
  });
  const show = (title, value) => console.log(`  ${title} -> ${JSON.stringify(redact(value))}`);

  // ---- fixtures: one allowlisted coordinator whose runs are held --------
  const tank = ctx.agent('Tank', 'hermes');
  ctx.agent('Other', 'hermes');
  const reviewer = ctx.agent('Rev', 'claude');
  ctx.deckScripts.set(reviewer.deck_id, () => ({ result: 'Review: README.md is accurate; no changes needed.' }));
  label(tank.id, '<tank>');
  const holds = new Map();
  let holding = true;
  ctx.dispatch.setAttemptAdapterOverride(transport => (transport !== 'hermes-gateway' ? ctx.dispatch.ATTEMPT_ADAPTERS[transport]() : {
    name: 'hermes-gateway',
    async run(input, onEvent) {
      const request = engine.getWorkRequest(input.correlation.requestId);
      const runId = `coordinator-run-${launches.length + 1}`;
      launches.push(request.id);
      onEvent?.({ type: 'started', adapter: 'hermes-gateway', at: Date.now(), externalRunId: runId, externalSessionId: null });
      if (holding) await new Promise(resolve => holds.set(request.id, resolve));
      const ask = ctx.lastEntry(input).content;
      const output = request.parent_request_id ? 'Final: Rev reviewed README.md and found it accurate.'
        : /\[review\]/.test(ask) ? `Rev will review it.\n${ctx.block({ target: 'Rev', executionKind: 'review', objective: 'Review README.md for accuracy. Read-only.' })}`
          : /README/.test(ask) ? 'Final: the README describes a disposable acceptance workspace created by the Botmancers harness. Nothing was changed.' : `Answer: ${ask.slice(0, 40)}`;
      const now = Date.now();
      return { status: 'completed', adapter: 'hermes-gateway', externalRunId: runId, externalSessionId: null, output, artifacts: [], startedAt: now, finishedAt: now, failure: null };
    },
  }));
  const release = async requestId => {
    await waitFor(() => holds.has(requestId), `the coordinator run for ${labels.get(requestId) || requestId}`);
    holds.get(requestId)();
  };

  process.env.BOTMANCERS_SERVICE_TOKENS = `${SERVICE_ID}=${digest(SERVICE_TOKEN)}`;
  process.env.BOTMANCERS_MCP_COORDINATORS = 'Tank';
  const app = await ctx.routeHost();
  const bridgeEnv = extra => ({
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    BOTMANCERS_URL: app.origin, BOTMANCERS_SERVICE_TOKEN: SERVICE_TOKEN, BOTMANCERS_MCP_TOKEN: MCP_TOKEN, BOTMANCERS_MCP_PORT: '0',
    ...extra,
  });
  const outputs = [];

  // ---- fail closed: the bridge refuses to start ---------------------------
  section('Fail closed: the bridge does not start without a working route to Botmancers or its credentials');
  {
    const before = snapshot();
    const cases = [
      ['no inbound MCP token', { BOTMANCERS_MCP_TOKEN: '' }, 2],
      ['no service token', { BOTMANCERS_SERVICE_TOKEN: '' }, 2],
      ['Botmancers unreachable (nothing listening at BOTMANCERS_URL)', { BOTMANCERS_URL: `http://127.0.0.1:${await freePort()}` }, 4],
      ['service token not registered with Botmancers', { BOTMANCERS_SERVICE_TOKEN: `${SERVICE_TOKEN}-rotated-away` }, 5],
    ];
    for (const [name, extra, expected] of cases) {
      const started = await runBridge(cli, bridgeEnv(extra));
      if (started.proc) await stopBridge(started.proc);
      outputs.push(started.output());
      check(started.port === null && started.code === expected, `${name}: exits ${expected} without listening (got ${started.code})`);
    }
    delete process.env.BOTMANCERS_SERVICE_TOKENS;
    const unconfigured = await runBridge(cli, bridgeEnv({}));
    if (unconfigured.proc) await stopBridge(unconfigured.proc);
    outputs.push(unconfigured.output());
    check(unconfigured.port === null && unconfigured.code === 5, `Botmancers has no service tokens configured: exits 5 without listening (got ${unconfigured.code})`);
    process.env.BOTMANCERS_SERVICE_TOKENS = `${SERVICE_ID}=${digest(SERVICE_TOKEN)}`;
    check(same(before, snapshot()), 'no rows written by any refused start');
  }

  // ---- the bridge and its route ------------------------------------------
  section(`Bridge botmancers@${version} behind the authenticated route`);
  const bridge = await runBridge(cli, bridgeEnv({}));
  if (!check(bridge.port !== null, `the installed binary listens on loopback: ${(bridge.output().match(/botmancers \S+: MCP bridge listening on/) || ['(not listening)'])[0]}`)) return 1;
  const route = await startRoute(bridge.port);
  const grok = grokClient(route.url, MCP_TOKEN);

  section('Fail closed: inbound authentication and route checks');
  {
    const before = snapshot();
    const start = { coordinator: 'Tank', objective: OBJECTIVE, idempotency_key: INVOCATION_ID };
    for (const [name, token] of [['no Authorization header', null], ['wrong bearer token', `${MCP_TOKEN}x`], ['the Botmancers service token instead of the MCP token', SERVICE_TOKEN]]) {
      const client = grokClient(route.url, token);
      const init = (await client.initialize()).init;
      const call = await client.call('botmancers_start_task', start);
      check(init.status === 401 && call.status === 401, `${name}: initialize and tools/call -> 401 (got ${init.status}/${call.status})`);
    }
    // A route that forwards the public Host instead of rewriting it.
    const unrewritten = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'botmancers_start_task', arguments: start } });
      const req = http.request({
        host: '127.0.0.1', port: bridge.port, path: '/mcp', method: 'POST',
        headers: { host: 'bridge.example.invalid', authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
    check(unrewritten.status === 403 && /host_not_allowed/.test(unrewritten.text), `a route that does not rewrite Host -> 403 host_not_allowed (got ${unrewritten.status})`);
    check(same(before, snapshot()), 'no rows written by any refused request');
  }

  section('Handshake and tool surface');
  {
    const { init, initialized } = await grok.initialize();
    const info = init.json && init.json.result;
    check(init.status === 200 && info.serverInfo.name === 'botmancers' && info.serverInfo.version === version, `initialize -> ${info && `${info.serverInfo.name} ${info.serverInfo.version}, protocol ${info.protocolVersion}`}`);
    check(initialized.status === 202 || initialized.status === 200, `notifications/initialized accepted (${initialized.status})`);
    const tools = (await grok.rpc('tools/list')).json.result.tools;
    check(same(tools.map(tool => tool.name), TOOL_NAMES), `tools/list -> exactly the four approved tools: ${tools.map(tool => tool.name).join(', ')}`);
    const startSchema = tools.find(tool => tool.name === 'botmancers_start_task').inputSchema;
    check(same(Object.keys(startSchema.properties).sort(), ['coordinator', 'idempotency_key', 'objective']) && startSchema.additionalProperties === false,
      'botmancers_start_task accepts only coordinator, objective, idempotency_key');
    const health = await grok.call('botmancers_health');
    show('botmancers_health', health.data);
    check(!health.result.isError && health.data.status === 'ok' && health.data.principal.id === SERVICE_ID && same(health.data.coordinators, [{ name: 'Tank', available: true }]),
      'health: ok, principal service:grok-bot, only the allowlisted coordinator');
  }

  section('No external elevation of authority');
  {
    const before = snapshot();
    const notAllowed = await grok.call('botmancers_start_task', { coordinator: 'Other', objective: OBJECTIVE, idempotency_key: 'grok-run-other' });
    check(notAllowed.result.isError && notAllowed.data.error.code === 'coordinator_not_allowed', 'a coordinator outside the allowlist -> coordinator_not_allowed');
    const selected = await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: OBJECTIVE, idempotency_key: 'grok-run-extra', deck: 'deck-x', runtime: 'claude', model: 'grok-4', workspace: '/tmp', target: 'Dev', grant: true });
    check(selected.result.isError && selected.data.error.code === 'unsupported_field', `deck/runtime/model/workspace/target/grant fields -> unsupported_field (${selected.data && JSON.stringify(selected.data.error.fields || selected.data.error.message)})`);
    check(same(before, snapshot()), 'no rows written');
  }

  // ---- the handoff --------------------------------------------------------
  section('Handoff: start once, poll to terminal, read the final conversation');
  let started;
  const observed = [];
  {
    // The coordinator is busy with an owner question, so the Grok task queues.
    const busy = ctx.service.acceptAgentMessage(ctx.PERSON, { agentId: tank.id, content: 'Owner question that keeps Tank busy', idempotencyKey: 'owner-busy' }).accepted;
    label(busy.requestId, '<owner_request_id>');
    await waitFor(() => holds.has(busy.requestId), 'the owner question to start');
    const before = snapshot();

    const start = await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: OBJECTIVE, idempotency_key: INVOCATION_ID });
    started = start.data;
    label(started.request_id, '<request_id>');
    label(started.conversation_id, '<conversation_id>');
    show('botmancers_start_task', started);
    check(!start.result.isError && started.request_id && started.conversation_id && started.replayed === false && started.coordinator.name === 'Tank', 'start_task returns durable request_id and conversation_id');
    const after = snapshot();
    check(after.conversation_intakes - before.conversation_intakes === 1 && after.work_requests - before.work_requests === 1, 'one intake and one Work Request written');

    const poll = async () => {
      const view = (await grok.call('botmancers_get_request', { request_id: started.request_id })).data;
      if (observed[observed.length - 1] !== view.status) observed.push(view.status);
      return view;
    };
    const pending = await poll();
    show('poll 1 botmancers_get_request', pending);
    check(pending.status === 'pending' && pending.terminal === false, 'poll: pending while the coordinator is busy');

    await release(busy.requestId);
    await waitFor(() => holds.has(started.request_id), 'the Grok task to start');
    const running = await poll();
    show('poll 2 botmancers_get_request', running);
    check(running.status === 'running' && running.terminal === false && running.result === null, 'poll: running');
    const midConversation = (await grok.call('botmancers_get_conversation', { conversation_id: started.conversation_id })).data;
    check(midConversation.status === 'active' && midConversation.open_request_count === 1, 'get_conversation while running: active, one open request');

    // A Grok retry (for example after a timeout) while the task runs.
    const midSnapshot = snapshot();
    const midRetry = (await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: OBJECTIVE, idempotency_key: INVOCATION_ID })).data;
    show('retry while running', midRetry);
    check(midRetry.replayed === true && midRetry.request_id === started.request_id && midRetry.conversation_id === started.conversation_id && midRetry.status === 'running', 'retry while running replays the original ids');
    check(same(midSnapshot, snapshot()), 'the mid-flight retry writes nothing and launches nothing');

    await release(started.request_id);
    let view = running;
    for (let i = 0; i < 200 && !view.terminal; i += 1) {
      view = await poll();
      if (!view.terminal) await new Promise(resolve => setTimeout(resolve, 10));
    }
    label(view.result && view.result.message_id, '<result_message_id>');
    show('final botmancers_get_request', view);
    check(view.status === 'succeeded' && view.terminal === true && /^Final:/.test(view.result.content), 'poll reaches terminal succeeded with the coordinator result');
    check(same(observed, ['pending', 'running', 'succeeded']), `observed status sequence: ${observed.join(' -> ')}`);

    await ctx.service.waitForAgentDispatchIdle();
    const conversation = (await grok.call('botmancers_get_conversation', { conversation_id: started.conversation_id })).data;
    const thread = conversation.messages.map(m => `${m.sender.kind === 'service' ? `service:${m.sender.id}` : m.sender.name}: ${m.content}`);
    console.log(`  botmancers_get_conversation -> status ${conversation.status}, events ${conversation.events.map(e => e.kind).join(', ')}`);
    for (const line of thread) console.log(`    ${line}`);
    check(conversation.status === 'idle' && thread.length === 2 && thread[0] === `service:${SERVICE_ID}: ${OBJECTIVE}` && /^Tank: Final:/.test(thread[1]),
      'the final conversation: the Grok objective, then the coordinator\'s final result');
    const text = JSON.stringify(conversation);
    check(!/session|external_run|deck-|policy_snapshot|tool_profile/.test(text), 'no Session Binding, run id, Deck, or policy in the conversation view');
  }

  section('Retry idempotency and conflict (row counts)');
  {
    const before = snapshot();
    const beforeRows = serviceRows();
    const retry = (await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: `  ${OBJECTIVE}\r\n`, idempotency_key: INVOCATION_ID })).data;
    show('retry after terminal', retry);
    check(retry.replayed === true && retry.request_id === started.request_id && retry.conversation_id === started.conversation_id && retry.status === 'succeeded', 'retry of the same invocation id returns the original ids and terminal status');
    await ctx.service.waitForAgentDispatchIdle();
    const conflict = await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: 'Read-only: list the files in the workspace.', idempotency_key: INVOCATION_ID });
    show('changed objective, same invocation id', conflict.data);
    check(conflict.result.isError && conflict.data.error.code === 'idempotency_conflict', 'changed objective with the same key -> idempotency_conflict');
    await ctx.service.waitForAgentDispatchIdle();
    const afterRows = serviceRows();
    console.log(`  rows for service:${SERVICE_ID} -> ${JSON.stringify(afterRows)}`);
    check(same(before, snapshot()), `retry and conflict write nothing (${TABLES.join(', ')}, coordinator launches)`);
    check(same(beforeRows, afterRows) && afterRows.intakes === 1 && afterRows.intakes_for_key === 1 && afterRows.work_requests === 1, 'exactly one intake and one Work Request for the Grok principal and key');
    check(launches.filter(id => id === started.request_id).length === 1, 'the coordinator ran the Grok task exactly once');
  }

  section('Durable records correlated with the invocation');
  {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-handoff-correlate.js'), '--db', process.env.BOTMANCERS_DB_PATH, '--request-id', started.request_id, '--key', INVOCATION_ID], { encoding: 'utf8' });
    const report = JSON.parse(out);
    for (const event of report.engine_events) label(event.id, `<engine_event_${event.sequence}>`);
    show('mcp-handoff-correlate', { ...report, intake: report.intake && { ...report.intake, created_at: '<ms>' } });
    check(report.conversation_id === started.conversation_id && report.intake && report.intake.idempotency_key === `mcp:${INVOCATION_ID}` && report.intake.work_request_ids.join() === started.request_id,
      'the intake row ties the invocation id to the request and conversation');
    check(report.counts.intakes_for_key === 1 && report.counts.direct_work_requests === 1, 'correlation counts: one intake, one direct Work Request');
    check(report.verdict.no_external_elevation && report.verdict.terminal && report.lineage.length === 1 && report.lineage[0].origin === 'external' && report.lineage[0].requester === `service:${SERVICE_ID}`,
      'verdict: one read-only conversation turn from service:grok-bot; no other work attributed to the external principal');
  }

  section('The elevation verdict fails closed on unexpected provenance');
  {
    const correlate = (db, extra = []) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-handoff-correlate.js'), '--db', db, '--request-id', started.request_id, '--key', INVOCATION_ID, ...extra], { encoding: 'utf8' })).verdict;
    const tampered = (name, sql) => {
      const file = path.join(path.dirname(process.env.BOTMANCERS_DB_PATH), `correlate-${name}.db`);
      raw.prepare('VACUUM INTO ?').run(file);
      const Database = require('better-sqlite3');
      const copy = new Database(file);
      // The copy simulates provenance the engine would never write, so lift its integrity guards.
      copy.pragma('foreign_keys = OFF');
      for (const { name: trigger } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) copy.exec(`DROP TRIGGER "${trigger}"`);
      copy.prepare(sql).run(started.request_id);
      copy.close();
      return file;
    };
    const cases = [
      ['another service principal is expected', correlate(process.env.BOTMANCERS_DB_PATH, ['--service', 'other-bot'])],
      ['the direct read-only turn was requested by an Agent', correlate(tampered('bot-requester', `UPDATE work_requests SET requester_kind = 'bot', requester_id = '${tank.id}' WHERE id = ?`))],
      ['the direct turn was requested by the engine principal', correlate(tampered('engine-requester', "UPDATE work_requests SET requester_id = 'botmancers-engine' WHERE id = ?"))],
      ['the direct turn is not the lineage root', correlate(tampered('not-root', "UPDATE work_requests SET root_request_id = 'elsewhere' WHERE id = ?"))],
      ['the intake belongs to another principal', correlate(tampered('intake', "UPDATE conversation_intakes SET requester_id = 'other-bot' WHERE work_request_ids LIKE '%' || ? || '%'"))],
    ];
    for (const [why, verdict] of cases) {
      console.log(`  ${why} -> ${JSON.stringify(verdict)}`);
      check(verdict.no_external_elevation === false, `no_external_elevation is false when ${why}`);
    }
  }

  section('Coordinator Wakes stay internal');
  {
    holding = false;
    const key = 'grok-run-0002';
    const start = (await grok.call('botmancers_start_task', { coordinator: 'Tank', objective: 'Read-only: have a reviewer check README.md for accuracy. [review]', idempotency_key: key })).data;
    label(start.request_id, '<request_id_2>');
    label(start.conversation_id, '<conversation_id_2>');
    let view = { terminal: false };
    for (let i = 0; i < 200 && !view.terminal; i += 1) {
      view = (await grok.call('botmancers_get_request', { request_id: start.request_id })).data;
      if (!view.terminal) await new Promise(resolve => setTimeout(resolve, 10));
    }
    let conversation = { status: 'active' };
    for (let i = 0; i < 200 && conversation.status !== 'idle'; i += 1) {
      await ctx.service.waitForAgentDispatchIdle();
      conversation = (await grok.call('botmancers_get_conversation', { conversation_id: start.conversation_id })).data;
      if (conversation.status !== 'idle') await new Promise(resolve => setTimeout(resolve, 10));
    }
    const thread = conversation.messages.map(m => (m.sender.kind === 'service' ? `service:${m.sender.id}` : m.sender.name));
    console.log(`  botmancers_get_conversation -> status ${conversation.status}; ${thread.join(' > ')}`);
    check(view.status === 'succeeded' && conversation.status === 'idle' && /^Final:/.test(conversation.messages[conversation.messages.length - 1].content),
      'the direct request succeeds, then the conversation goes idle with the coordinator\'s final report');
    const report = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-handoff-correlate.js'), '--db', process.env.BOTMANCERS_DB_PATH, '--request-id', start.request_id, '--key', key], { encoding: 'utf8' }));
    for (const r of report.lineage) label(r.request_id, `<${r.origin}_request_id>`);
    for (const w of report.wakes) label(w.wake_id, '<wake_id>');
    show('lineage', report.lineage.map(r => `${r.origin}: ${r.requester} -> ${r.target} ${r.execution_kind}/${r.tool_profile} ${r.state}`));
    show('wakes', report.wakes);
    const [direct, review, continuation] = report.lineage;
    check(report.lineage.length === 3 && direct.origin === 'external' && direct.requester === `service:${SERVICE_ID}`
      && review.origin === 'wake' && review.requester === 'bot:Tank' && review.execution_kind === 'review' && review.tool_profile === 'readonly'
      && continuation.origin === 'engine_continuation' && continuation.requester === 'service:botmancers-engine'
      && report.lineage.every(r => r.root_principal === `service:${SERVICE_ID}`),
      'the review comes from Tank\'s Wake and the report from an engine continuation; service:grok-bot is only the root principal');
    check(report.wakes.length === 1 && report.wakes[0].requester === 'Tank' && report.wakes[0].status === 'accepted', 'one accepted Wake, requested by the coordinator');
    check(report.verdict.no_external_elevation && report.counts.direct_work_requests === 2, 'verdict: no external elevation; the Grok principal opened only its two direct turns');

    const missingWakeDb = path.join(path.dirname(process.env.BOTMANCERS_DB_PATH), 'correlate-missing-wake.db');
    raw.prepare('VACUUM INTO ?').run(missingWakeDb);
    const Database = require('better-sqlite3');
    const copy = new Database(missingWakeDb);
    copy.pragma('foreign_keys = OFF');
    for (const { name: trigger } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) copy.exec(`DROP TRIGGER "${trigger}"`);
    copy.prepare('DELETE FROM wakes WHERE work_request_id = ?').run(review.request_id);
    copy.close();
    const missingWakeReport = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-handoff-correlate.js'), '--db', missingWakeDb, '--request-id', start.request_id, '--key', key], { encoding: 'utf8' }));
    const missingWakeChild = missingWakeReport.lineage.find(r => r.request_id === review.request_id);
    check(missingWakeChild.origin === 'unexpected' && missingWakeChild.wake_id === null && missingWakeReport.verdict.no_external_elevation === false,
      'the verdict fails closed when a bot-authored child has no matching durable Wake');
  }

  section('Route removed: the client fails closed');
  {
    const before = snapshot();
    await route.close();
    let refused = false;
    try {
      await grok.call('botmancers_health');
    } catch {
      refused = true;
    }
    check(refused, 'with the route gone the client cannot connect');
    const code = await stopBridge(bridge.proc);
    outputs.push(bridge.output());
    check(code === 0, 'SIGTERM stops the bridge with exit 0');
    check(same(before, snapshot()), 'nothing written');
    const all = outputs.join('\n');
    check(!all.includes(SERVICE_TOKEN) && !all.includes(MCP_TOKEN) && !all.includes(digest(SERVICE_TOKEN).slice(7)), 'bridge output contains no token or digest');
  }

  await ctx.close();
  console.log(`\n${failures === 0 ? 'scenario passed' : `${failures} check(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

if (process.env.BOTMANCERS_GROK_TEST_CHILD) {
  child().then(code => process.exit(code), error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
} else {
  parent().then(code => process.exit(code), error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
