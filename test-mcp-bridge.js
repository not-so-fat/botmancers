#!/usr/bin/env node
// NOT-491: the Botmancers MCP bridge (botmancers.mcp.v1) end to end.
// NOT-500: and its additive granted contract, botmancers.mcp.v2.
//
//   npm run test:mcp-bridge                     run
//   npm run test:mcp-bridge -- --write-contract  regenerate the captured v2 tool schemas
//                                                (the v1 capture is frozen)
//
// Runs inside a disposable acceptance-harness root (temporary database,
// HOME, Git workspace; no network, credentials, or coding runtime). The
// real route handlers (proxy.ts, app/api/v0/mcp, app/api/v0/**) are served
// on an ephemeral loopback port and driven as an MCP client would over
// Streamable HTTP with bearer service tokens; coordinator turns are
// scripted and coding Agents run against the fake Agent Deck API.
//
// Covers: initialize and tools/list against the captured contract
// (docs/contracts/mcp-bridge-v1.tools.json); fail-closed authentication
// with row counts; the allowlist and the forbidden-field table; replay
// and conflict, including the REST-reserved "mcp:" key prefix; the
// per-service tool-call rate limit; the read-only direct request and the separately granted
// internal Wake lineage; the read authorization matrix; and status
// snapshots for pending, running, succeeded, failed, and cancelled with no
// session, run, or credential leak.
//
// v2 (NOT-500): the frozen v1 capture still describes the v1 tools; the
// served list equals docs/contracts/mcp-bridge-v2.tools.json; strict schemas,
// annotations, pagination bounds, and idempotency on mutations; the
// workflow and untrusted-data text in the descriptions; a capability matrix
// for two differently granted principals; discovery, same-session messages,
// and Ask/Continue exchanges over seeded Agents and active/ended sessions
// through the real service layer, with canonical row counts on every
// rejection; stable error codes; redaction; and the documentation.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const ROOT = __dirname;
const CONTRACT_FILE = path.join(ROOT, 'docs', 'contracts', 'mcp-bridge-v1.tools.json');
const CONTRACT_V2_FILE = path.join(ROOT, 'docs', 'contracts', 'mcp-bridge-v2.tools.json');
// The v1 capture is frozen: its bytes never change.
const CONTRACT_V1_SHA256 = '64a46eaaf0e63053e75c4fa25c00a1ef7d160a63c1c2a363f882643668b5e166';
const V1_NAMES = ['botmancers_start_task', 'botmancers_get_request', 'botmancers_get_conversation', 'botmancers_health'];
const V2_NAMES = ['botmancers_capabilities', 'botmancers_list_agents', 'botmancers_list_sessions', 'botmancers_list_conversations',
  'botmancers_send_to_session', 'botmancers_create_exchange', 'botmancers_get_exchange', 'botmancers_list_exchanges'];
const WRITE_CONTRACT = process.argv.includes('--write-contract');

if (process.env.BOTMANCERS_MCP_BRIDGE_TEST_CHILD) {
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

async function parent() {
  const harnessLib = require('./test-support/acceptance/harness.js');
  const harness = harnessLib.createHarness('mcp-bridge');
  const run = await new Promise(resolve => {
    const proc = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
      cwd: harness.root,
      env: harness.env({ BOTMANCERS_MCP_BRIDGE_TEST_CHILD: '1' }),
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.on('exit', code => resolve({ code, err }));
  });
  if (run.err) process.stderr.write(run.err.slice(-4000));
  const preserved = harness.finish(run.code === 0, run.err.slice(-4000));
  console.log(`\nTEST RESULT: ${run.code === 0 ? 'PASS' : `FAIL${preserved ? ` (root kept at ${preserved})` : ''}`}`);
  return run.code === 0 ? 0 : 1;
}

// JSON with object keys sorted, for order-insensitive comparison.
const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
  : v));

const digest = token => `sha256:${createHash('sha256').update(token).digest('hex')}`;

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function child() {
  const { createContext } = require('./test-support/acceptance/engine-context.js');
  const ctx = createContext('mcp-bridge');
  const { engine, raw, bots } = ctx;
  let failures = 0;
  let passes = 0;
  const check = (condition, label) => {
    if (condition) passes += 1; else failures += 1;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
    return !!condition;
  };
  const section = title => console.log(`\n${title}`);

  const TOKEN = 'bmt_grok_bot_fixture_token_0123456789';
  const OTHER_TOKEN = 'bmt_other_service_fixture_token_9876';
  const TABLES = ['conversations', 'conversation_participants', 'conversation_intakes', 'messages', 'wakes', 'work_requests', 'work_attempts', 'engine_events', 'conversation_events', 'session_bindings'];
  const counts = () => Object.fromEntries(TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const deckStarts = () => ctx.fakeDeck.calls('POST', '/api/agent-runs').length;
  const snapshot = () => ({ ...counts(), deck_starts: deckStarts(), coordinator_runs: ctx.coordinatorLaunches.length });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- fixtures ----------------------------------------------------------
  const tank = ctx.agent('Tank', 'hermes');
  const dev = ctx.agent('Dev', 'claude');
  const other = ctx.agent('Other', 'hermes');
  const holder = ctx.agent('Holder', 'codex');
  ctx.deckScripts.set(dev.deck_id, () => ({ result: 'Implemented: retry for the uploader.', sessionId: 'dev-session-secret-1' }));
  ctx.deckScripts.set(holder.deck_id, body => {
    if (/FAIL-ME/.test(body.prompt)) return { state: 'error', errorMessage: 'client failed' };
    if (/HOLD-ME/.test(body.prompt)) return { result: 'Held answer.', hold: true, sessionId: 'holder-session-secret' };
    return { result: 'Holder answer.' };
  });
  // Tank: a Wake for "[wake]" objectives, a report on its continuation,
  // a plain answer otherwise.
  ctx.hermesScripts.set(tank.id, (input, request) => {
    if (request.parent_request_id) return 'Final: Dev implemented the retry; reporting back.';
    const ask = ctx.lastEntry(input).content;
    if (/\[wake\]/.test(ask)) return `Dev will implement it.\n${ctx.block({ target: 'Dev', executionKind: 'implementation', objective: 'Add retry to the uploader.' })}`;
    return `Answer: ${ask.slice(0, 40)}`;
  });

  const host = await ctx.routeHost();
  const endpoint = `${host.origin}/api/v0/mcp`;
  let rpcId = 0;
  async function post(body, { token = TOKEN, headers = {}, raw: rawBody } = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: rawBody ?? JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: response.status, headers: response.headers, json, text };
  }
  // node:http, because fetch cannot set Host; chunked omits Content-Length.
  function rawPost(body, headers, { chunked = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: host.port, path: '/api/v0/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(chunked ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* empty */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      if (chunked) for (let i = 0; i < body.length; i += 16 * 1024) req.write(body.slice(i, i + 16 * 1024));
      else req.write(body);
      req.end();
    });
  }
  const rpc = (method, params, options) => post({ jsonrpc: '2.0', id: ++rpcId, method, params }, options);
  const call = async (name, args, options) => {
    const res = await rpc('tools/call', { name, arguments: args }, { headers: { 'mcp-protocol-version': '2025-06-18' }, ...options });
    return { ...res, result: res.json && res.json.result, data: res.json && res.json.result && res.json.result.structuredContent };
  };
  const allText = [];
  const record = res => { allText.push(res.text); return res; };

  // ---- AC2: fail closed --------------------------------------------------
  section('AC2 authentication fails closed before persistence');
  {
    delete process.env.BOTMANCERS_SERVICE_TOKENS;
    process.env.BOTMANCERS_MCP_COORDINATORS = 'Tank, Holder';
    // This suite makes more tool calls per minute than the default allows;
    // the rate-limit section lowers it.
    process.env.BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE = '1000';
    const before = snapshot();
    const startArgs = { coordinator: 'Tank', objective: 'Hello', idempotency_key: 'auth-1' };
    const unconfigured = await call('botmancers_start_task', startArgs);
    check(unconfigured.status === 503 && unconfigured.json.error.code === 'authentication_unavailable', `no service tokens configured -> 503 authentication_unavailable (got ${unconfigured.status} ${unconfigured.text})`);
    process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(TOKEN)},grok-bot=${digest(OTHER_TOKEN)}`;
    const malformed = await call('botmancers_start_task', startArgs);
    check(malformed.status === 503 && malformed.json.error.code === 'authentication_unavailable', `malformed token list (duplicate id) installs nothing -> 503 (got ${malformed.status})`);
    process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(TOKEN)}, other-svc=${digest(OTHER_TOKEN)}`;

    const cases = [
      ['missing Authorization', { token: null }],
      ['wrong token', { token: 'bmt_not_a_real_token' }],
      ['token digest presented as the token', { token: digest(TOKEN) }],
      ['Basic scheme', { token: null, headers: { authorization: `Basic ${Buffer.from(`grok-bot:${TOKEN}`).toString('base64')}` } }],
      ['principal header without a token', { token: null, headers: { 'x-botmancers-principal': 'service:grok-bot', 'x-test-principal': 'service:grok-bot' } }],
    ];
    for (const [label, options] of cases) {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, options);
      const start = await call('botmancers_start_task', startArgs, options);
      check(init.status === 401 && start.status === 401 && start.json.error.code === 'unauthenticated' && /Bearer/.test(start.headers.get('www-authenticate') || ''),
        `${label}: initialize and tools/call -> 401 unauthenticated with WWW-Authenticate: Bearer`);
    }
    const crossOrigin = await call('botmancers_start_task', startArgs, { headers: { origin: 'http://evil.invalid' } });
    check(crossOrigin.status === 403 && crossOrigin.json.error.code === 'origin_not_allowed', 'cross-origin browser request -> 403 origin_not_allowed');

    // DNS rebinding: Host and Origin both attacker-controlled, valid token.
    const startBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'botmancers_start_task', arguments: startArgs } });
    const loopbackHost = `127.0.0.1:${host.port}`;
    const rebinding = [
      ['rebound Host and Origin', { host: `evil.example:${host.port}`, origin: `http://evil.example:${host.port}` }, 'host_not_allowed'],
      ['rebound Host, no Origin', { host: 'evil.example' }, 'host_not_allowed'],
      ['loopback Host, https Origin (scheme mismatch)', { host: loopbackHost, origin: `https://${loopbackHost}` }, 'origin_not_allowed'],
      ['loopback Host, other loopback port Origin', { host: loopbackHost, origin: 'http://127.0.0.1:1' }, 'origin_not_allowed'],
      ['loopback Host, Origin: null', { host: loopbackHost, origin: 'null' }, 'origin_not_allowed'],
    ];
    for (const [label, headers, code] of rebinding) {
      const res = await rawPost(startBody, { authorization: `Bearer ${TOKEN}`, ...headers });
      check(res.status === 403 && res.json && res.json.error.code === code, `${label} -> 403 ${code} (got ${res.status} ${res.text})`);
    }
    const sameOrigin = await rpc('tools/list', {}, { headers: { origin: host.origin } });
    check(sameOrigin.status === 200, 'loopback Host with its exact http Origin is accepted');
    process.env.BOTMANCERS_MCP_ALLOWED_HOSTS = 'mcp.example.test';
    process.env.BOTMANCERS_MCP_ALLOWED_ORIGINS = 'https://mcp.example.test';
    const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const deployed = await rawPost(listBody, { authorization: `Bearer ${TOKEN}`, host: 'mcp.example.test', origin: 'https://mcp.example.test' });
    check(deployed.status === 200, 'an allowlisted deployment Host and Origin are accepted');
    const deployedWrongScheme = await rawPost(listBody, { authorization: `Bearer ${TOKEN}`, host: 'mcp.example.test', origin: 'http://mcp.example.test' });
    check(deployedWrongScheme.status === 403 && deployedWrongScheme.json.error.code === 'origin_not_allowed', 'an allowlisted Host with a non-allowlisted Origin scheme -> 403');
    delete process.env.BOTMANCERS_MCP_ALLOWED_HOSTS;
    delete process.env.BOTMANCERS_MCP_ALLOWED_ORIGINS;

    // Body cap: declared and streamed (chunked) oversize bodies.
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'botmancers_start_task', arguments: { ...startArgs, objective: 'x'.repeat(300 * 1024) } } });
    const declaredTooLarge = await rawPost(oversized, { authorization: `Bearer ${TOKEN}`, host: loopbackHost });
    check(declaredTooLarge.status === 413 && declaredTooLarge.json.error.code === 'payload_too_large', 'Content-Length over 256 KiB -> 413 payload_too_large');
    const chunkedTooLarge = await rawPost(oversized, { authorization: `Bearer ${TOKEN}`, host: loopbackHost }, { chunked: true });
    check(chunkedTooLarge.status === 413 && chunkedTooLarge.json.error.code === 'payload_too_large', 'chunked body over 256 KiB -> 413 payload_too_large');
    const restBad = await fetch(`${host.origin}/api/v0/agents/${tank.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify({ content: 'hi', idempotencyKey: 'rest-1' }),
    });
    check(restBad.status === 401, '/api/v0 REST with an invalid token -> 401 (same shipped authenticator)');
    const after = snapshot();
    console.log(`  rows before=${JSON.stringify(before)}`);
    console.log(`  rows after =${JSON.stringify(after)}`);
    check(same(before, after), 'no conversation, intake, message, request, attempt, event, or runtime launch from any rejected call');
  }

  // ---- AC1: initialize / tools/list -------------------------------------
  section('AC1 Streamable HTTP initialize and tools/list');
  let tools;
  {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } });
    console.log(`  initialize -> ${init.status} ${JSON.stringify(init.json.result && { protocolVersion: init.json.result.protocolVersion, serverInfo: init.json.result.serverInfo, capabilities: init.json.result.capabilities })}`);
    check(init.status === 200 && init.headers.get('content-type').startsWith('application/json') && init.json.result.protocolVersion === '2025-06-18'
      && init.json.result.capabilities.tools && init.json.result.serverInfo.name === 'botmancers', 'initialize succeeds over Streamable HTTP (application/json) and negotiates the client version');
    const future = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
    check(future.json.result.protocolVersion === '2025-11-25', 'an unknown client protocol version is answered with the newest supported');
    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-protocol-version': '2025-06-18' } });
    check(initialized.status === 202 && initialized.text === '', 'notifications/initialized -> 202 Accepted, no body');
    const badVersion = await rpc('tools/list', {}, { headers: { 'mcp-protocol-version': '1999-01-01' } });
    check(badVersion.status === 400, 'unsupported MCP-Protocol-Version header -> 400');
    const getStream = await fetch(endpoint, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
    check(getStream.status === 405, 'GET (server stream) -> 405: stateless JSON responses only');
    const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    check(batch.status === 400 && batch.json.error.code === -32600, 'JSON-RPC batch -> invalid request');
    const ping = await rpc('ping');
    check(ping.status === 200 && JSON.stringify(ping.json.result) === '{}', 'ping -> {}');
    const unknown = await rpc('resources/list');
    check(unknown.json.error && unknown.json.error.code === -32601, 'methods other than the tool surface -> method not found');

    const listed = await rpc('tools/list', {}, { headers: { 'mcp-protocol-version': '2025-06-18' } });
    tools = listed.json.result.tools;
    const names = tools.map(tool => tool.name);
    console.log(`  tools: ${names.join(', ')}`);
    check(JSON.stringify(names) === JSON.stringify([...V1_NAMES, ...V2_NAMES]),
      'the four v1 tools in their v1 order, then the eight v2 tools');
    const v1Capture = fs.readFileSync(CONTRACT_FILE);
    check(createHash('sha256').update(v1Capture).digest('hex') === CONTRACT_V1_SHA256, `the v1 capture ${path.relative(ROOT, CONTRACT_FILE)} is unchanged (frozen)`);
    const captured = JSON.parse(v1Capture.toString('utf8'));
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    for (const name of ['botmancers_start_task', 'botmancers_get_request', 'botmancers_health']) {
      check(canonical(byName[name]) === canonical(captured.tools.find(tool => tool.name === name)), `${name} is served exactly as captured in v1`);
    }
    const v1Get = captured.tools.find(tool => tool.name === 'botmancers_get_conversation');
    const served = byName.botmancers_get_conversation;
    check(served.title === v1Get.title && canonical(served.annotations) === canonical(v1Get.annotations) && served._meta['botmancers/contract'] === 'botmancers.mcp.v1'
      && served.description.startsWith(v1Get.description), 'botmancers_get_conversation keeps its v1 title, annotations, contract, and description (then adds the v2 path)');
    check(canonical(served.inputSchema.properties.conversation_id) === canonical(v1Get.inputSchema.properties.conversation_id)
      && canonical(served.inputSchema.required) === canonical(v1Get.inputSchema.required) && served.inputSchema.additionalProperties === false
      && JSON.stringify(Object.keys(served.inputSchema.properties)) === '["conversation_id","agent_id","cursor","limit"]',
    'its input keeps the v1 conversation_id and required list; the v2 path adds only optional agent_id, cursor, limit');
    check(canonical(served.outputSchema.anyOf[0]) === canonical(v1Get.outputSchema) && served.outputSchema.anyOf[1].properties.contract.const === 'botmancers.mcp.v2',
      'its output is the exact v1 shape or the v2 shape');
    check(canonical(ctx.lib('mcp-bridge.ts').MCP_V1_TOOLS) === canonical(captured.tools), 'the bridge\'s own v1 definitions equal the frozen capture');
    if (WRITE_CONTRACT) {
      fs.writeFileSync(CONTRACT_V2_FILE, `${JSON.stringify({ contract: 'botmancers.mcp.v2', contracts: ['botmancers.mcp.v1', 'botmancers.mcp.v2'], tools }, null, 2)}\n`);
      console.log(`  wrote ${path.relative(ROOT, CONTRACT_V2_FILE)}`);
    }
    const capturedV2 = JSON.parse(fs.readFileSync(CONTRACT_V2_FILE, 'utf8'));
    check(capturedV2.contract === 'botmancers.mcp.v2' && JSON.stringify(capturedV2.contracts) === '["botmancers.mcp.v1","botmancers.mcp.v2"]'
      && JSON.stringify(capturedV2.tools) === JSON.stringify(tools), `tools/list equals the captured schemas in ${path.relative(ROOT, CONTRACT_V2_FILE)}`);
    const unknownTool = await call('botmancers_run_anything', {});
    check(unknownTool.json.error && unknownTool.json.error.code === -32602, 'an unknown tool name is a JSON-RPC invalid params error');
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__']) {
      const res = await call(inherited, {});
      check(res.json.error && res.json.error.code === -32602 && !res.json.result, `inherited Object.prototype name "${inherited}" is rejected as invalid params`);
    }
  }

  // ---- AC3: allowlist and forbidden fields -------------------------------
  section('AC3 start_task accepts only coordinator, objective, idempotency_key');
  {
    const start = tools[0];
    check(JSON.stringify(Object.keys(start.inputSchema.properties)) === '["coordinator","objective","idempotency_key"]'
      && JSON.stringify(start.inputSchema.required) === '["coordinator","objective","idempotency_key"]' && start.inputSchema.additionalProperties === false,
      'schema: exactly coordinator, objective, idempotency_key, all required, no additional properties');
    const before = snapshot();
    const forbidden = ['runtime', 'agent', 'adapter', 'deck', 'deck_id', 'model', 'tool_profile', 'tools', 'grant', 'grants', 'execution_kind', 'executionKind',
      'target', 'target_agent_id', 'implementation_target', 'workspace', 'working_directory', 'principal', 'caller', 'requester', 'service_id',
      'conversation_id', 'session_id', 'limits'];
    const accepted = [];
    for (const field of forbidden) {
      const res = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Do it', idempotency_key: `forbid-${field}`, [field]: field === 'principal' ? { kind: 'service', id: 'admin' } : 'x' });
      if (!(res.result.isError && res.data.error.code === 'unsupported_field' && JSON.stringify(res.data.error.fields) === JSON.stringify([field]))) accepted.push(field);
    }
    check(accepted.length === 0, `${forbidden.length} forbidden fields each rejected with unsupported_field naming the field${accepted.length ? ` (not rejected: ${accepted.join(', ')})` : ''}`);
    const targets = [['Other', 'registered Agent not on the allowlist'], ['Dev', 'implementation Agent not on the allowlist'], ['Nobody', 'unknown name'], [tank.id, 'allowlisted Agent addressed by id']];
    for (const [coordinator, label] of targets) {
      const res = await call('botmancers_start_task', { coordinator, objective: 'Do it', idempotency_key: `target-${label.length}` });
      check(res.result.isError && res.data.error.code === 'coordinator_not_allowed', `${label} -> coordinator_not_allowed`);
    }
    const invalid = [
      [{ objective: 'x', idempotency_key: 'k' }, 'missing coordinator'],
      [{ coordinator: 'Tank', objective: '   ', idempotency_key: 'k' }, 'blank objective'],
      [{ coordinator: 'Tank', objective: 'x' }, 'missing idempotency_key'],
      [{ coordinator: 'Tank', objective: 'x', idempotency_key: 'has spaces' }, 'idempotency_key outside the pattern'],
      ['not-an-object', 'non-object arguments'],
    ];
    for (const [args, label] of invalid) {
      const res = await call('botmancers_start_task', args);
      check(res.result.isError && res.data.error.code === 'invalid_arguments', `${label} -> invalid_arguments`);
    }
    check(same(before, snapshot()), 'no rows written by any rejected start_task');
  }

  // ---- AC4: replay and conflict ------------------------------------------
  section('AC4 idempotent replay and conflict');
  let first;
  {
    const before = snapshot();
    first = record(await call('botmancers_start_task', { coordinator: 'Tank', objective: '  What is the build status?\r\n', idempotency_key: 'task-1' }));
    console.log(`  first -> ${JSON.stringify(first.data)}`);
    check(!first.result.isError && first.data.request_id && first.data.conversation_id && first.data.replayed === false && first.data.coordinator.name === 'Tank', 'first call returns durable request_id and conversation_id');
    await ctx.settle([first.data.request_id]);
    const afterFirst = snapshot();
    const replay = record(await call('botmancers_start_task', { coordinator: 'tank', objective: 'What is the build status?', idempotency_key: 'task-1' }));
    console.log(`  replay -> ${JSON.stringify(replay.data)}`);
    check(replay.data.request_id === first.data.request_id && replay.data.conversation_id === first.data.conversation_id && replay.data.replayed === true && replay.data.status === 'succeeded',
      'replay (same principal, coordinator, key, normalized objective) returns the original ids and current status');
    await ctx.service.waitForAgentDispatchIdle();
    check(same(afterFirst, snapshot()), 'replay writes nothing and launches nothing');
    const conflict = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Something else entirely', idempotency_key: 'task-1' });
    const conflict2 = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Something else entirely', idempotency_key: 'task-1' });
    console.log(`  conflict -> ${JSON.stringify(conflict.data)}`);
    check(conflict.result.isError && conflict.data.error.code === 'idempotency_conflict' && conflict.text === conflict2.text.replace(`"id":${rpcId}`, `"id":${rpcId - 1}`),
      'same key, different objective -> deterministic idempotency_conflict');
    const otherCoordinator = await call('botmancers_start_task', { coordinator: 'Holder', objective: 'What is the build status?', idempotency_key: 'task-1' });
    check(otherCoordinator.result.isError && otherCoordinator.data.error.code === 'idempotency_conflict', 'same key, different coordinator -> idempotency_conflict');
    check(same(afterFirst, snapshot()), 'conflicts write nothing');
    // Cross-surface: REST cannot occupy (or replay from) the bridge's key namespace.
    const restPost = (key, { header = false, content = 'Something else entirely' } = {}) => fetch(`${host.origin}/api/v0/agents/${tank.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(header ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify({ content, ...(header ? {} : { idempotencyKey: key }) }),
    }).then(async res => ({ status: res.status, json: await res.json() }));
    for (const [label, key, header] of [['body key mcp:task-1', 'mcp:task-1', false], ['header key mcp:task-1', 'mcp:task-1', true], ['body key MCP:task-2', 'MCP:task-2', false]]) {
      const res = await restPost(key, { header });
      check(res.status === 400 && res.json.error.code === 'invalid_request' && /reserved/.test(res.json.error.message), `REST ${label} -> 400 invalid_request (reserved prefix)`);
    }
    const restReplayAttempt = await restPost('mcp:task-1', { content: 'What is the build status?' });
    check(restReplayAttempt.status === 400 && !JSON.stringify(restReplayAttempt.json).includes(first.data.request_id), 'REST cannot replay the MCP call\'s ids through the prefixed key');
    check(same(afterFirst, snapshot()), 'reserved-prefix REST calls write nothing');
    const restPlain = await restPost('task-1');
    check(restPlain.status === 202 && restPlain.json.requestId !== first.data.request_id, 'REST key task-1 is a separate namespace from MCP key task-1');
    await ctx.settle([restPlain.json.requestId]);
    const replayAfterRest = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'What is the build status?', idempotency_key: 'task-1' });
    check(replayAfterRest.data.request_id === first.data.request_id && replayAfterRest.data.replayed === true, 'MCP task-1 still replays its original ids after REST used task-1');
    const freshMcp = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Something else entirely', idempotency_key: 'task-2' });
    check(!freshMcp.result.isError && freshMcp.data.replayed === false && freshMcp.data.request_id !== restPlain.json.requestId, 'MCP key task-2 is not occupied by any REST call');
    await ctx.settle([freshMcp.data.request_id]);
    const otherService = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'What is the build status?', idempotency_key: 'task-1' }, { token: OTHER_TOKEN });
    check(!otherService.result.isError && otherService.data.request_id !== first.data.request_id, 'keys are scoped per service principal');
    await ctx.settle([otherService.data.request_id]);
    const firstRow = engine.getWorkRequest(first.data.request_id);
    const conv = raw.prepare('SELECT * FROM conversations WHERE id = ?').get(first.data.conversation_id);
    const intake = raw.prepare('SELECT * FROM conversation_intakes WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?').get('service', 'grok-bot', 'mcp:task-1');
    console.log(`  delta first call=${JSON.stringify(Object.fromEntries(Object.keys(before).map(k => [k, afterFirst[k] - before[k]])))}`);
    check(intake && firstRow.requester_kind === 'service' && firstRow.requester_id === 'grok-bot' && conv.origin_kind === 'service' && conv.origin_id === 'grok-bot',
      'one shared-intake record; request requester and conversation origin are the token\'s service principal');
    check(ctx.messagesIn(first.data.conversation_id)[0].content === 'What is the build status?', 'the objective is stored normalized');
  }

  // ---- AC5: direct read-only request and the granted Wake lineage -------
  section('AC5 direct request vs. internal Wake lineage under the owner grant');
  let lineage;
  {
    lineage = record(await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Implement retry for the uploader [wake]', idempotency_key: 'task-wake' }));
    const conv = lineage.data.conversation_id;
    await ctx.settle([lineage.data.request_id]);
    await ctx.service.waitForAgentDispatchIdle();
    const root = engine.getWorkRequest(lineage.data.request_id);
    const policy = JSON.parse(root.policy_snapshot);
    console.log(`  direct request: requester=${root.requester_kind}:${root.requester_id} kind=${root.execution_kind} tools=${root.tool_profile} root=${root.root_principal_kind}:${root.root_principal_id} state=${root.state}`);
    check(root.execution_kind === 'conversation' && root.tool_profile === 'readonly' && root.requester_kind === 'service' && root.target_agent_id === tank.id && root.parent_request_id === null,
      'the external principal\'s request is one direct read-only conversation turn to the coordinator');
    check(policy && JSON.stringify(policy).includes('readonly'), 'its stored policy snapshot is read-only');
    const [wake] = ctx.wakesIn(conv);
    const wakeRequest = wake && engine.getWorkRequest(wake.work_request_id);
    console.log(`  wake: status=${wake && wake.status} reason=${wake && wake.reason_code} request=${wakeRequest && `${wakeRequest.requester_kind}:${bots.getById(wakeRequest.requester_id).name} -> ${bots.getById(wakeRequest.target_agent_id).name} ${wakeRequest.execution_kind}/${wakeRequest.tool_profile} ${wakeRequest.state}`}`);
    check(wake && wake.status === 'blocked' && wake.reason_code === 'grant_required', 'the coordinator\'s implementation Wake waits for an owner grant (grant_required)');
    check(wakeRequest && wakeRequest.requester_kind === 'bot' && wakeRequest.requester_id === tank.id && wakeRequest.parent_request_id === root.id
      && wakeRequest.root_principal_kind === 'service' && wakeRequest.root_principal_id === 'grok-bot' && wakeRequest.tool_profile === 'edit',
      'the implementation request is created by the coordinator\'s Wake (requester bot:Tank, parent = the direct request, root principal recorded as the service)');
    check(ctx.attemptsOf(wakeRequest.id).length === 0 && ctx.fakeDeck.calls('POST', '/api/agent-runs').filter(c => c.body.deckId === dev.deck_id).length === 0, 'no Attempt and no Dev run before the grant');
    const decision = engine.latestSafetyDecision(wakeRequest.id);
    check(decision && decision.decision === 'blocked' && decision.principal_type === 'agent_principal', `safety decision: blocked for the Agent caller (got ${decision && `${decision.decision}/${decision.principal_type}`})`);
    const pendingView = await call('botmancers_get_conversation', { conversation_id: conv });
    check(pendingView.data.status === 'active' && pendingView.data.open_request_count === 1 && pendingView.data.events.some(e => e.kind === 'wake_blocked'),
      'get_conversation: active, one open request, the Wake shown waiting');
    check(!('botmancers_decide_grant' in Object.fromEntries(tools.map(t => [t.name, 1]))) && tools.every(t => !/grant/i.test(Object.keys(t.inputSchema.properties).join(','))),
      'the bridge offers no way to decide a grant');

    const allowed = await host.owner('POST', `/api/wakes/${wake.id}/decision`, { decision: 'allow' });
    check(allowed.status === 200 && !!allowed.json.grantId, `the owner allows over the owner boundary (status ${allowed.status})`);
    for (let round = 0; round < 20; round += 1) {
      await ctx.settle(ctx.requestsIn(conv).map(r => r.id));
      if (ctx.messagesIn(conv).some(m => /^Final:/.test(m.content))) break;
    }
    const requests = ctx.requestsIn(conv);
    const chain = requests.map(r => `${r.requester_kind}:${r.requester_kind === 'bot' ? bots.getById(r.requester_id).name : r.requester_id}->${bots.getById(r.target_agent_id).name}:${r.execution_kind}/${r.tool_profile}:${r.state}`);
    console.log(`  lineage: ${chain.join(' | ')}`);
    check(requests.length === 3 && requests.every(r => r.state === 'completed' && r.root_request_id === root.id) && requests[1].execution_kind === 'implementation' && requests[2].parent_request_id === requests[1].id,
      'after the grant: direct turn -> granted implementation -> coordinator continuation, one lineage');
    const grant = raw.prepare('SELECT * FROM wake_grants').all();
    check(grant.length === 1 && grant[0].caller_agent_id === tank.id && grant[0].target_agent_id === dev.id, 'the only grant is the owner\'s Tank -> Dev pair grant');
    const finalView = record(await call('botmancers_get_conversation', { conversation_id: conv }));
    const thread = finalView.data.messages.map(m => (m.sender.kind === 'service' ? `service:${m.sender.id}` : m.sender.name));
    console.log(`  conversation: ${finalView.data.status}; ${thread.join(' > ')}`);
    check(finalView.data.status === 'idle' && JSON.stringify(thread) === JSON.stringify(['service:grok-bot', 'Tank', 'Dev', 'Tank']) && /^Final:/.test(finalView.data.messages[3].content),
      'get_conversation: idle; service > Tank > Dev > Tank with the coordinator\'s final report');
    const rootView = record(await call('botmancers_get_request', { request_id: lineage.data.request_id }));
    check(rootView.data.status === 'succeeded' && /Dev will implement it/.test(rootView.data.result.content), 'get_request reports the direct request succeeded with the coordinator reply');
  }

  // ---- AC6: authorization matrix and status snapshots --------------------
  section('AC6 read authorization matrix');
  {
    const ownerConversation = ctx.conversations.getByBotId(tank.id);
    const matrix = [
      ['own request', 'botmancers_get_request', { request_id: first.data.request_id }, TOKEN, null],
      ['own conversation', 'botmancers_get_conversation', { conversation_id: first.data.conversation_id }, TOKEN, null],
      ['other service -> request', 'botmancers_get_request', { request_id: first.data.request_id }, OTHER_TOKEN, 'request_not_found'],
      ['other service -> conversation', 'botmancers_get_conversation', { conversation_id: first.data.conversation_id }, OTHER_TOKEN, 'conversation_not_found'],
      ['coordinator Wake request (by id, same conversation)', 'botmancers_get_request', { request_id: ctx.requestsIn(lineage.data.conversation_id)[1].id }, TOKEN, null],
      ['other service -> Wake request', 'botmancers_get_request', { request_id: ctx.requestsIn(lineage.data.conversation_id)[1].id }, OTHER_TOKEN, 'request_not_found'],
      ['owner UI thread', 'botmancers_get_conversation', { conversation_id: ownerConversation.id }, TOKEN, 'conversation_not_found'],
      ['unknown request', 'botmancers_get_request', { request_id: 'no-such-request' }, TOKEN, 'request_not_found'],
      ['unknown conversation', 'botmancers_get_conversation', { conversation_id: 'no-such-conversation' }, TOKEN, 'conversation_not_found'],
      ['extra read field', 'botmancers_get_request', { request_id: first.data.request_id, include_sessions: true }, TOKEN, 'unsupported_field'],
    ];
    for (const [label, tool, args, token, expected] of matrix) {
      const res = record(await call(tool, args, { token }));
      const code = res.result.isError ? res.data.error.code : null;
      check(code === expected, `${label}: ${expected || 'allowed'} (got ${code || 'allowed'})`);
    }
    const otherFoundNothing = await call('botmancers_get_request', { request_id: first.data.request_id }, { token: OTHER_TOKEN });
    const missing = await call('botmancers_get_request', { request_id: 'no-such-request' }, { token: OTHER_TOKEN });
    check(otherFoundNothing.data.error.message === missing.data.error.message, 'a foreign request is indistinguishable from a missing one');
    const health = await call('botmancers_health', {});
    console.log(`  health -> ${JSON.stringify(health.data)}`);
    check(!health.result.isError && health.data.status === 'ok' && health.data.principal.id === 'grok-bot' && JSON.stringify(health.data.coordinators) === '[{"name":"Tank","available":true},{"name":"Holder","available":true}]',
      'health: ok, the token\'s principal, and the allowlisted coordinators');
  }

  section('AC6 status snapshots: pending, running, succeeded, failed, cancelled');
  {
    const start = async (objective, key) => record(await call('botmancers_start_task', { coordinator: 'Holder', objective, idempotency_key: key })).data;
    const running = await start('HOLD-ME: long analysis', 'status-running');
    await waitFor(() => ctx.attemptsOf(running.request_id).some(a => a.external_run_id && a.finished_at === null), 'the held run to start');
    const pending = await start('Second question for Holder', 'status-pending');
    const toCancel = await start('Third question for Holder', 'status-cancelled');
    const read = async id => record(await call('botmancers_get_request', { request_id: id })).data;
    const runningView = await read(running.request_id);
    const pendingView = await read(pending.request_id);
    await ctx.service.cancelAgentRequest({ kind: 'service', id: 'grok-bot' }, toCancel.request_id, 'caller withdrew');
    const cancelledView = await read(toCancel.request_id);
    const runId = ctx.attemptsOf(running.request_id)[0].external_run_id;
    ctx.fakeDeck.release(runId);
    await ctx.settle([running.request_id, pending.request_id]);
    const succeededView = await read(running.request_id);
    const failed = await start('FAIL-ME please', 'status-failed');
    await ctx.settle([failed.request_id]);
    const failedView = await read(failed.request_id);

    const ids = new Map();
    const norm = value => JSON.parse(JSON.stringify(value), (key, v) => {
      if (/_at$/.test(key) && typeof v === 'number') return '<ms>';
      if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) {
        if (!ids.has(v)) ids.set(v, `<id${ids.size + 1}>`);
        return ids.get(v);
      }
      return v;
    });
    const shape = view => norm({ ...view, request_id: view.request_id, conversation_id: view.conversation_id });
    const snapshots = {
      pending: shape(pendingView), running: shape(runningView), succeeded: shape(succeededView), failed: shape(failedView), cancelled: shape(cancelledView),
    };
    for (const [status, view] of Object.entries(snapshots)) console.log(`  ${status.padEnd(9)} ${JSON.stringify(view)}`);
    const base = { contract: 'botmancers.mcp.v1', coordinator: { agent_id: '<holder>', name: 'Holder' }, created_at: '<ms>', updated_at: '<ms>' };
    const expected = {
      pending: { ...base, status: 'pending', terminal: false, result: null, failure: null },
      running: { ...base, status: 'running', terminal: false, result: null, failure: null },
      succeeded: { ...base, status: 'succeeded', terminal: true, result: { message_id: '<msg>', content: 'Held answer.' }, failure: null },
      failed: { ...base, status: 'failed', terminal: true, result: null, failure: { code: 'runtime_failed', message: '<text>' } },
      cancelled: { ...base, status: 'cancelled', terminal: true, result: null, failure: { code: 'cancelled', message: 'caller withdrew' } },
    };
    for (const [status, view] of Object.entries(snapshots)) {
      const comparable = {
        ...view,
        coordinator: { ...view.coordinator, agent_id: view.coordinator.agent_id === ids.get(holder.id) ? '<holder>' : view.coordinator.agent_id },
        result: view.result ? { ...view.result, message_id: '<msg>' } : null,
        failure: view.failure && status === 'failed' ? { ...view.failure, message: '<text>' } : view.failure,
      };
      delete comparable.request_id;
      delete comparable.conversation_id;
      const keys = Object.keys(view).join(',');
      check(canonical(comparable) === canonical(expected[status]) && keys === 'contract,request_id,conversation_id,coordinator,status,terminal,result,failure,created_at,updated_at',
        `${status}: stable representation`);
    }
    check(typeof failedView.failure.message === 'string' && failedView.failure.message.length > 0, 'failed: a typed failure with a message');
  }

  section('Per-service rate limit on tool calls');
  {
    const BURST_TOKEN = 'bmt_burst_service_fixture_token_1111';
    const CALM_TOKEN = 'bmt_calm_service_fixture_token_22222';
    const tokens = process.env.BOTMANCERS_SERVICE_TOKENS;
    process.env.BOTMANCERS_SERVICE_TOKENS = `${tokens}, burst-svc=${digest(BURST_TOKEN)}, calm-svc=${digest(CALM_TOKEN)}`;
    process.env.BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE = '3';
    await ctx.service.waitForAgentDispatchIdle();
    const before = snapshot();
    const admitted = [];
    for (let i = 0; i < 3; i += 1) admitted.push(await call('botmancers_health', {}, { token: BURST_TOKEN }));
    check(admitted.every(res => res.status === 200 && !res.result.isError), 'calls up to the limit are admitted');
    const limited = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Flood', idempotency_key: 'flood-1' }, { token: BURST_TOKEN });
    const limited2 = await call('botmancers_start_task', { coordinator: 'Tank', objective: 'Flood', idempotency_key: 'flood-2' }, { token: BURST_TOKEN });
    const retryAfter = Number(limited.headers.get('retry-after'));
    console.log(`  over limit -> ${limited.status} ${limited.text} Retry-After=${limited.headers.get('retry-after')}`);
    check(limited.status === 429 && limited.json.error.code === 'rate_limited' && Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
      'a tool call over the limit -> 429 rate_limited with Retry-After (1-60 s)');
    check(limited2.status === 429 && limited2.text === limited.text, 'the refusal is stable');
    const list = await rpc('tools/list', {}, { token: BURST_TOKEN });
    check(list.status === 200, 'non-tool messages (tools/list) are not counted');
    const calm = await call('botmancers_health', {}, { token: CALM_TOKEN });
    check(calm.status === 200 && !calm.result.isError, 'the limit is per service principal');
    await ctx.service.waitForAgentDispatchIdle();
    check(same(before, snapshot()), 'rate-limited start_task calls persist nothing and launch nothing');
    process.env.BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE = '0';
    const invalidLimit = await call('botmancers_health', {}, { token: CALM_TOKEN });
    check(invalidLimit.status === 200, 'an invalid limit setting falls back to the bounded default');
    process.env.BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE = '1000';
    process.env.BOTMANCERS_SERVICE_TOKENS = tokens;
  }

  section('AC6 no session binding, run id, credential, or deck leak');
  {
    const text = allText.join('\n');
    const runIds = raw.prepare('SELECT external_run_id FROM work_attempts WHERE external_run_id IS NOT NULL').all().map(r => r.external_run_id);
    const sessions = raw.prepare('SELECT external_session_id FROM session_bindings').all().map(r => r.external_session_id);
    const leaks = [TOKEN, OTHER_TOKEN, digest(TOKEN), process.env.AGENT_DECK_RUN_TOKEN, 'dev-session-secret-1', 'holder-session-secret', ...sessions, ...runIds,
      dev.deck_id, holder.deck_id, 'session_binding', 'external_run_id', 'external_session_id', 'policy_snapshot', 'tool_profile', ctx.workspace]
      .filter(needle => needle && text.includes(needle));
    check(sessions.length > 0 && runIds.length > 0, `fixtures produced session bindings (${sessions.length}) and run ids (${runIds.length}) to look for`);
    check(leaks.length === 0, `no bridge response contains them${leaks.length ? ` (leaked: ${leaks.join(', ')})` : ''}`);
  }

  // =====================================================================
  // NOT-500: botmancers.mcp.v2
  // =====================================================================
  // A strict JSON Schema check of a structured result against the tool's
  // outputSchema (the subset the contract uses).
  const schemaProblems = (schema, value, at = '$') => {
    if (schema.anyOf) {
      return schema.anyOf.some(option => schemaProblems({ ...option, ...(schema.type && !option.type ? { type: schema.type } : {}) }, value, at).length === 0)
        ? [] : [`${at}: matches no anyOf option`];
    }
    const types = schema.type === undefined ? null : [].concat(schema.type);
    const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
    if (types && !types.some(t => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) return [`${at}: ${typeOf(value)} is not ${types.join('|')}`];
    if ('const' in schema && value !== schema.const) return [`${at}: not ${schema.const}`];
    if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${value} not in enum`];
    const problems = [];
    if (typeOf(value) === 'object') {
      for (const key of schema.required || []) if (!(key in value)) problems.push(`${at}.${key}: missing`);
      for (const [key, v] of Object.entries(value)) {
        if (schema.properties && schema.properties[key]) problems.push(...schemaProblems(schema.properties[key], v, `${at}.${key}`));
        else if (schema.additionalProperties === false) problems.push(`${at}.${key}: not allowed`);
      }
    }
    if (typeOf(value) === 'array' && schema.items) value.forEach((item, i) => problems.push(...schemaProblems(schema.items, item, `${at}[${i}]`)));
    return problems;
  };
  const v2Text = [];
  const v2call = async (name, args, options) => {
    const res = await call(name, args, options);
    v2Text.push(res.text);
    return res;
  };
  const conforms = (name, res, label) => {
    const tool = tools.find(t => t.name === name);
    const problems = res.result && !res.result.isError ? schemaProblems(tool.outputSchema, res.data) : ['tool error'];
    return check(problems.length === 0, `${label || name}: structuredContent conforms to the outputSchema${problems.length ? ` (${problems.slice(0, 3).join('; ')})` : ''}`);
  };
  const errorOf = res => (res.result && res.result.isError ? res.data.error : null);
  const V2_TABLES = ['session_exchanges', 'session_exchange_events', 'work_requests', 'work_attempts', 'messages', 'conversations', 'conversation_participants', 'session_bindings', 'conversation_intakes'];
  const v2counts = () => Object.fromEntries(V2_TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

  section('v2 contract: strict schemas, annotations, pagination, idempotency, no authority fields');
  {
    const v2Tools = tools.filter(tool => V2_NAMES.includes(tool.name));
    const closedEverywhere = schema => {
      if (!schema || typeof schema !== 'object') return true;
      if (schema.type === 'object' && schema.additionalProperties !== false && schema.properties) return false;
      return Object.values(schema.properties || {}).every(closedEverywhere) && closedEverywhere(schema.items) && (schema.anyOf || []).every(closedEverywhere);
    };
    check(v2Tools.every(tool => tool._meta['botmancers/contract'] === 'botmancers.mcp.v2' && tool.outputSchema.properties.contract.const === 'botmancers.mcp.v2'
      && Array.isArray(tool._meta['botmancers/errors'])), 'every v2 tool carries contract botmancers.mcp.v2 (meta and output) and lists its error codes');
    check(v2Tools.every(tool => closedEverywhere(tool.inputSchema) && closedEverywhere(tool.outputSchema)) && closedEverywhere(tools.find(t => t.name === 'botmancers_get_conversation').inputSchema),
      'every v2 input and output object schema is closed (additionalProperties: false), nested objects included');
    const reads = ['botmancers_capabilities', 'botmancers_list_agents', 'botmancers_list_sessions', 'botmancers_list_conversations', 'botmancers_get_exchange', 'botmancers_list_exchanges'];
    const writes = ['botmancers_send_to_session', 'botmancers_create_exchange'];
    check(reads.every(name => { const a = tools.find(t => t.name === name).annotations; return a.readOnlyHint === true && a.destructiveHint === false && a.idempotentHint === true; }),
      'read tools: readOnlyHint true, destructiveHint false, idempotentHint true');
    check(writes.every(name => { const a = tools.find(t => t.name === name).annotations; return a.readOnlyHint === false && a.destructiveHint === false && a.idempotentHint === true; }),
      'mutating tools: readOnlyHint false, destructiveHint false, idempotentHint true (caller idempotency key)');
    check(writes.every(name => { const s = tools.find(t => t.name === name).inputSchema; return s.required.includes('idempotency_key') && s.properties.idempotency_key.maxLength === 128 && !!s.properties.idempotency_key.pattern; }),
      'mutating tools require a bounded, patterned idempotency_key');
    const lists = ['botmancers_list_agents', 'botmancers_list_sessions', 'botmancers_list_conversations', 'botmancers_list_exchanges', 'botmancers_get_conversation'];
    check(lists.every(name => { const p = tools.find(t => t.name === name).inputSchema.properties; return p.limit.type === 'integer' && p.limit.minimum === 1 && p.limit.maximum <= 200 && p.cursor.type === 'string' && p.cursor.maxLength === 1024; })
      && lists.filter(n => n !== 'botmancers_get_conversation').every(name => tools.find(t => t.name === name).outputSchema.properties.next_cursor),
    'list tools take a bounded integer limit and an opaque bounded cursor and return next_cursor');
    const forbidden = ['deck', 'deck_id', 'deckId', 'runtime', 'model', 'tool_profile', 'toolProfile', 'execution_kind', 'provider_session_id', 'external_session_id', 'session_id',
      'resume', 'grant', 'grants', 'capability', 'principal', 'requester', 'owner', 'cwd', 'working_directory', 'workspace', 'adapter', 'transport'];
    const propertyNames = schema => (!schema || typeof schema !== 'object') ? [] : [...Object.keys(schema.properties || {}), ...Object.values(schema.properties || {}).flatMap(propertyNames)];
    const offered = tools.flatMap(tool => propertyNames(tool.inputSchema).filter(name => forbidden.includes(name)).map(name => `${tool.name}.${name}`));
    check(offered.length === 0, `no input schema offers a Deck, runtime, model, tool profile, provider session, grant, or principal field${offered.length ? ` (${offered.join(', ')})` : ''}`);
    const create = tools.find(t => t.name === 'botmancers_create_exchange').inputSchema;
    check(JSON.stringify(Object.keys(create.properties.destination.properties)) === '["agent_id","conversation_id"]', 'a Continue destination names an Agent, never a destination session');

    section('v2 descriptions: discover -> select -> act -> observe, untrusted content');
    const desc = Object.fromEntries(tools.map(tool => [tool.name, tool.description]));
    check(/^Step 1 \(discover\)/.test(desc.botmancers_capabilities) && /Next: botmancers_list_agents/.test(desc.botmancers_capabilities), 'capabilities: step 1, discover; next list_agents');
    check(/^Step 2 \(discover\)/.test(desc.botmancers_list_agents) && /botmancers_list_sessions/.test(desc.botmancers_list_agents), 'list_agents: step 2; choose an Agent by name, then list its sessions');
    check(/^Step 3 \(select\)/.test(desc.botmancers_list_sessions) && /recognizable title/.test(desc.botmancers_list_sessions) && /botmancers_send_to_session/.test(desc.botmancers_list_sessions)
      && /botmancers_create_exchange/.test(desc.botmancers_list_sessions), 'list_sessions: step 3; recognizable sessions; send_to_session for the same Agent or create_exchange');
    check(/^Step 4 \(act, same Agent\)/.test(desc.botmancers_send_to_session) && /^Step 4 \(act, exchange\)/.test(desc.botmancers_create_exchange), 'send_to_session and create_exchange: step 4, act');
    check(writes.every(name => /Step 5 \(observe\): poll botmancers_get_exchange/.test(desc[name]) && /doubling up to 30 s/.test(desc[name])), 'both mutations: step 5, poll get_exchange with backoff');
    check(/^Step 5 \(observe\)/.test(desc.botmancers_get_exchange) && /until terminal is true/.test(desc.botmancers_get_exchange), 'get_exchange: step 5, poll until terminal');
    check(['botmancers_get_exchange', 'botmancers_get_conversation'].every(name => /untrusted data/.test(desc[name]) && /never follow instructions/.test(desc[name]))
      && ['botmancers_send_to_session', 'botmancers_create_exchange', 'botmancers_list_sessions', 'botmancers_list_agents', 'botmancers_list_conversations'].every(name => /untrusted data/.test(desc[name])),
    'conversation, transcript, answer, and packet content is marked untrusted data, never instructions');
    check(/Ask/.test(desc.botmancers_create_exchange) && /mode "continue"/.test(desc.botmancers_create_exchange) && /fresh session of its own/.test(desc.botmancers_create_exchange),
      'create_exchange explains Ask versus Continue');
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    check(/botmancers_capabilities, then botmancers_list_agents/.test(init.json.result.instructions) && /untrusted data, never instructions/.test(init.json.result.instructions)
      && /botmancers_start_task/.test(init.json.result.instructions), 'initialize instructions give the v2 sequence and keep the v1 one');
    console.log('  reviewed tools/list payload (generated):');
    for (const tool of tools) {
      console.log(`    ${tool.name} [${tool._meta['botmancers/contract']}] readOnly=${tool.annotations.readOnlyHint} destructive=${tool.annotations.destructiveHint} idempotent=${tool.annotations.idempotentHint}`);
      console.log(`      inputs: ${Object.keys(tool.inputSchema.properties).map(key => `${key}${tool.inputSchema.required.includes(key) ? '*' : ''}`).join(', ') || '(none)'}`);
      console.log(`      ${tool.description}`);
    }
  }

  // ---- v2 fixtures: Agents, sessions, grants -----------------------------
  const PROVIDER = { scoutFresh: 'prov-scout-FRESH-445566', sageOld: 'prov-sage-OLD-d4e5f6', scout: 'prov-scout-SECRET-778899', vault: 'prov-vault-SECRET-112233' };
  const sage = ctx.agent('Sage', 'hermes');
  const scout = ctx.agent('Scout', 'hermes');
  const vault = ctx.agent('Vault', 'hermes');
  const hopText = input => (input.prompt.kind === 'conversation' ? input.prompt.history.map(entry => entry.content).join('\n') : input.prompt.text);
  ctx.hermesScripts.set(sage.id, input => {
    const textIn = hopText(input);
    if (textIn.includes('[Session Continue handoff')) {
      if (textIn.includes('BAD-PACKET')) return 'this is not a handoff packet';
      return JSON.stringify({ objective: 'Finish the v2 bridge', decisions: ['Grants decide access'], constraints: [], artifacts: [], open_questions: [] });
    }
    if (textIn.includes('[Session Ask')) return `Sage answers: leases are fine (resumed ${PROVIDER.sageOld}-next).`;
    return 'Sage: nothing to do.';
  });
  ctx.hermesScripts.set(scout.id, () => ({ output: `Scout picked up the handoff in ${PROVIDER.scoutFresh}.`, sessionId: PROVIDER.scoutFresh }));
  let seedClock = Date.now() - 1_000_000;
  const seedSession = (bot, secret, key, { end = false } = {}) => {
    const conv = ctx.conversations.getByBotId(bot.id);
    const now = (seedClock += 1000);
    const { request } = engine.createOrGetWorkRequest({
      sourceConversationId: conv.id, sourceEventId: `v2-seed-${key}`, requester: ctx.UI_OWNER_PRINCIPAL, targetAgentId: bot.id,
      intent: `Plan the ${key} rollout`, executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: `v2-seed-${key}`, now,
    });
    engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running', now });
    const attempt = engine.createAttempt(request.id, { kind: 'launch', adapter: 'hermes', toolProfile: 'edit', launchSnapshot: { transport: 'hermes-gateway', cwd: ctx.workspace, deck: bot.deck_id }, now });
    engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', externalSessionId: secret, now });
    const binding = engine.bindSession({ agentId: bot.id, adapter: 'hermes', externalSessionId: secret, conversationId: conv.id, requestId: request.id, sourceAttemptId: attempt.id, now });
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null }, now });
    if (end) engine.bindSession({ agentId: bot.id, adapter: 'hermes', externalSessionId: `${secret}-next`, conversationId: conv.id, requestId: request.id, now: now + 1 });
    return { binding, conv };
  };
  const sageEnded = seedSession(sage, PROVIDER.sageOld, 'sage-ended', { end: true });
  const sageActive = { binding: raw.prepare('SELECT * FROM session_bindings WHERE external_session_id = ?').get(`${PROVIDER.sageOld}-next`), conv: sageEnded.conv };
  // NOT-509: one provider-reported usage sample on Sage's ended session.
  engine.recordAttemptUsage(sageEnded.binding.source_attempt_id, {
    usage: { input_tokens: 1200, output_tokens: 340, cost_usd: 0.0123, source: 'result', breakdown: { cache_read_input_tokens: 99 } }, observedAt: seedClock,
  });
  const scoutS = seedSession(scout, PROVIDER.scout, 'scout');
  const vaultS = seedSession(vault, PROVIDER.vault, 'vault');
  ctx.db.messages.create(sageEnded.conv.id, 'bot', `I resumed ${PROVIDER.sageOld} in ${ctx.workspace} on ${sage.deck_id}.`, sage.id);
  const GRANTS_PATH = path.join(process.env.HOME, 'config', 'service-grants.json');
  process.env.BOTMANCERS_SERVICE_GRANTS_PATH = GRANTS_PATH;
  process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '1000';
  const ALL = ['agents:read', 'sessions:read', 'conversations:read', 'sessions:message', 'exchanges:read', 'exchanges:create'];
  const grants = {
    version: 1,
    grants: [
      { service: 'grok-bot', agent: sage.id, capabilities: ALL },
      { service: 'grok-bot', agent: scout.id, capabilities: ['agents:read', 'conversations:read', 'exchanges:read', 'exchanges:create'] },
      { service: 'other-svc', agent: vault.id, capabilities: ['agents:read', 'sessions:read', 'exchanges:read'] },
    ],
  };
  const writeGrants = doc => {
    fs.mkdirSync(path.dirname(GRANTS_PATH), { recursive: true });
    fs.writeFileSync(GRANTS_PATH, typeof doc === 'string' ? doc : JSON.stringify(doc));
    fs.chmodSync(GRANTS_PATH, 0o600);
  };

  section('v2 capability matrix: v1/v2 support and only the granted operations, per principal');
  {
    fs.rmSync(GRANTS_PATH, { force: true });
    const narrow = await v2call('botmancers_capabilities', {});
    conforms('botmancers_capabilities', narrow, 'narrow mode');
    check(narrow.data.mode === 'narrow' && narrow.data.agents.length === 0 && narrow.data.operations.every(op => op.contract === 'botmancers.mcp.v1'),
      'without a grants document: narrow mode, no Agents, only the v1 operations');
    const narrowList = await v2call('botmancers_list_agents', {});
    check(errorOf(narrowList)?.code === 'grant_required' && errorOf(narrowList).retryable === false && /service-grants\.json/.test(errorOf(narrowList).message),
      'a v2 tool whose capability the caller holds nowhere -> grant_required, naming where the owner grants it');
    writeGrants('{ "version": 1, ');
    const broken = await v2call('botmancers_capabilities', {});
    check(errorOf(broken)?.code === 'grants_unavailable' && errorOf(broken).retryable === true, 'a malformed grants document -> grants_unavailable (retryable once the owner fixes it)');
    writeGrants(grants);

    const capsA = await v2call('botmancers_capabilities', {});
    const capsB = await v2call('botmancers_capabilities', {}, { token: OTHER_TOKEN });
    conforms('botmancers_capabilities', capsA, 'grok-bot');
    conforms('botmancers_capabilities', capsB, 'other-svc');
    const ops = data => Object.fromEntries(data.operations.filter(op => op.contract === 'botmancers.mcp.v2').map(op => [op.tool, op.agent_ids.slice().sort()]));
    console.log(`  grok-bot  v2 operations: ${JSON.stringify(ops(capsA.data))}`);
    console.log(`  other-svc v2 operations: ${JSON.stringify(ops(capsB.data))}`);
    const both = [sage.id, scout.id].sort();
    check(JSON.stringify(capsA.data.contracts_supported) === '["botmancers.mcp.v1","botmancers.mcp.v2"]' && capsA.data.mode === 'granted' && capsA.data.principal.id === 'grok-bot',
      'grok-bot: contracts v1 and v2 supported, granted mode, its own principal');
    check(canonical(ops(capsA.data)) === canonical({
      botmancers_list_agents: [], botmancers_list_sessions: [sage.id], botmancers_list_conversations: both, botmancers_get_conversation: both,
      botmancers_send_to_session: [sage.id], botmancers_create_exchange: both, botmancers_get_exchange: [], botmancers_list_exchanges: [],
    }), 'grok-bot: exactly its granted v2 operations, each with the Agents it applies to');
    check(canonical(ops(capsB.data)) === canonical({ botmancers_list_agents: [], botmancers_list_sessions: [vault.id], botmancers_get_exchange: [], botmancers_list_exchanges: [] }),
      'other-svc: only list_agents, list_sessions (Vault), and exchange reads; no send, create, or conversation operation');
    check(capsA.data.operations.some(op => op.tool === 'botmancers_start_task' && op.contract === 'botmancers.mcp.v1') && capsA.data.polling.initial_seconds === 2 && capsA.data.polling.max_seconds === 30,
      'the v1 operations stay listed, with the suggested polling backoff');
  }

  section('v2 discover and select: Agents, sessions, conversations (pagination, unknown fields, permission)');
  {
    const before = v2counts();
    const agentsA = await v2call('botmancers_list_agents', {});
    conforms('botmancers_list_agents', agentsA);
    check(canonical(agentsA.data.items.map(a => a.name).sort()) === '["Sage","Scout"]' && agentsA.data.next_cursor === null, 'grok-bot discovers Sage and Scout by name, nothing else');
    const page1 = await v2call('botmancers_list_agents', { limit: 1 });
    const page2 = await v2call('botmancers_list_agents', { limit: 1, cursor: page1.data.next_cursor });
    check(page1.data.items.length === 1 && typeof page1.data.next_cursor === 'string' && page2.data.next_cursor === null
      && canonical([...page1.data.items, ...page2.data.items].map(a => a.agent_id)) === canonical(agentsA.data.items.map(a => a.agent_id)), 'limit 1 pages concatenate to the full list via the opaque cursor');
    const invalid = [
      [{ limit: 0 }, 'limit 0'], [{ limit: 101 }, 'limit over 100'], [{ limit: '5' }, 'string limit'], [{ limit: 1.5 }, 'fractional limit'],
      [{ cursor: 'not-a-cursor' }, 'forged cursor'], [{ cursor: '' }, 'empty cursor'], ['nope', 'non-object arguments'],
    ];
    for (const [args, label] of invalid) {
      const res = await v2call('botmancers_list_agents', args);
      check(errorOf(res)?.code === 'invalid_arguments' && errorOf(res).retryable === false, `${label} -> invalid_arguments`);
    }
    const crossCursor = await v2call('botmancers_list_sessions', { agent_id: sage.id, cursor: page1.data.next_cursor });
    check(errorOf(crossCursor)?.code === 'invalid_arguments', 'a cursor from another list -> invalid_arguments');
    const unknown = await v2call('botmancers_list_agents', { limit: 5, include_hidden: true });
    check(errorOf(unknown)?.code === 'unsupported_field' && JSON.stringify(errorOf(unknown).fields) === '["include_hidden"]', 'an unknown field -> unsupported_field naming it');
    const authority = await v2call('botmancers_list_sessions', { agent_id: sage.id, deck: 'x', provider_session_id: 'y' });
    check(errorOf(authority)?.code === 'authority_not_allowed' && JSON.stringify(errorOf(authority).fields) === '["deck","provider_session_id"]', 'Deck and provider-session fields -> authority_not_allowed naming them');

    const all = await v2call('botmancers_list_sessions', { agent_id: sage.id, status: 'all' });
    const active = await v2call('botmancers_list_sessions', { agent_id: sage.id, status: 'active' });
    conforms('botmancers_list_sessions', all);
    console.log(`  Sage sessions: ${all.data.items.map(s => `${s.ref.slice(0, 8)} ${s.status} resumable=${s.resumable} "${s.title}"`).join(' | ')}`);
    check(all.data.items.length === 2 && active.data.items.length === 1 && active.data.items[0].ref === sageActive.binding.id && active.data.items[0].resumable === true
      && all.data.items.some(s => s.ref === sageEnded.binding.id && s.status === 'ended'), 'Sage: one active resumable session and one ended, by exact Botmancers reference');
    check(all.data.items.every(s => s.title && s.agent.name === 'Sage'), 'each session carries a recognizable title and its Agent\'s name');
    // NOT-509: additive normalized usage under the same grant; unknown is
    // null, never 0; no raw breakdown; an item without usage still conforms.
    const endedItem = all.data.items.find(s => s.ref === sageEnded.binding.id);
    const activeItem = all.data.items.find(s => s.ref === sageActive.binding.id);
    check(endedItem.usage.input_tokens.sum === 1200 && endedItem.usage.output_tokens.sum === 340 && endedItem.usage.cost_usd.sum === 0.0123
      && endedItem.usage.cost_usd.quality === 'complete' && endedItem.usage.cost_usd.known === 1 && endedItem.usage.cost_usd.total === 1,
    'list_sessions carries the session\'s reported usage summary with coverage');
    check(activeItem.usage.cost_usd.sum === null && activeItem.usage.cost_usd.quality === 'unavailable' && activeItem.usage.input_tokens.total === 0,
      'a session with no reported usage is unavailable with a null sum, not zero');
    check(!/breakdown|cache_read/.test(JSON.stringify(all.data)), 'no raw provider breakdown in the MCP result');
    const itemSchema = tools.find(t => t.name === 'botmancers_list_sessions').outputSchema.properties.items.items;
    const withoutUsage = { ...endedItem };
    delete withoutUsage.usage;
    check(schemaProblems(itemSchema, withoutUsage).length === 0 && !itemSchema.required.includes('usage'),
      'usage is optional in the v2 session item: a result without it still conforms (backward compatible)');
    const scoutSessions = await v2call('botmancers_list_sessions', { agent_id: scout.id });
    const ghost = await v2call('botmancers_list_sessions', { agent_id: 'no-such-agent' });
    const vaultViaA = await v2call('botmancers_list_sessions', { agent_id: vault.id });
    check(errorOf(scoutSessions)?.code === 'agent_not_found' && canonical(errorOf(scoutSessions)) === canonical(errorOf(ghost)) && canonical(errorOf(vaultViaA)) === canonical(errorOf(ghost)),
      'an Agent granted without sessions:read, and an ungranted Agent, are indistinguishable from a missing one');
    const vaultViaB = await v2call('botmancers_list_sessions', { agent_id: vault.id }, { token: OTHER_TOKEN });
    const sageViaB = await v2call('botmancers_list_sessions', { agent_id: sage.id }, { token: OTHER_TOKEN });
    check(vaultViaB.data && vaultViaB.data.items.map(s => s.ref).join() === vaultS.binding.id && errorOf(sageViaB)?.code === 'agent_not_found',
      'other-svc sees Vault\'s session and no Sage row');

    const convs = await v2call('botmancers_list_conversations', { agent_id: sage.id });
    conforms('botmancers_list_conversations', convs);
    check(convs.data.items.some(c => c.conversation_id === sageEnded.conv.id && c.type === 'direct' && /Sage/.test(c.label)), 'Sage\'s direct thread is listed with a readable label');
    const thread = await v2call('botmancers_get_conversation', { conversation_id: sageEnded.conv.id, agent_id: sage.id });
    conforms('botmancers_get_conversation', thread, 'get_conversation (v2 path)');
    check(thread.data.contract === 'botmancers.mcp.v2' && thread.data.content_trust === 'untrusted'
      && thread.data.messages.some(m => m.content.includes('[redacted runtime id]') && m.content.includes('[redacted]')) && !thread.text.includes(PROVIDER.sageOld),
    'v2 path: the transcript is returned redacted (provider id, workspace, Deck) and marked untrusted');
    const firstPage = await v2call('botmancers_get_conversation', { conversation_id: sageEnded.conv.id, agent_id: sage.id, limit: 1 });
    check(firstPage.data.messages.length === 1 || firstPage.data.next_cursor === null, 'v2 path: limit bounds the message page');
    const v1Read = await call('botmancers_get_conversation', { conversation_id: sageEnded.conv.id });
    check(v1Read.result.isError && v1Read.data.contract === 'botmancers.mcp.v1' && v1Read.data.error.code === 'conversation_not_found',
      'without agent_id the v1 tool answers as before: the owner\'s thread is not a conversation the service opened');
    const v1Cursor = await call('botmancers_get_conversation', { conversation_id: first.data.conversation_id, cursor: 'x' });
    check(v1Cursor.data.error.code === 'unsupported_field' && v1Cursor.data.contract === 'botmancers.mcp.v1', 'cursor without agent_id is the v1 tool\'s unsupported_field');
    const v1Own = await call('botmancers_get_conversation', { conversation_id: first.data.conversation_id });
    check(!v1Own.result.isError && v1Own.data.contract === 'botmancers.mcp.v1' && Object.keys(v1Own.data).join(',') === 'contract,conversation_id,status,open_request_count,origin,participants,messages,events',
      'a v1 get_conversation of its own conversation keeps the exact v1 shape');
    const scoutThread = await v2call('botmancers_get_conversation', { conversation_id: sageEnded.conv.id, agent_id: scout.id });
    const vaultThread = await v2call('botmancers_get_conversation', { conversation_id: vaultS.conv.id, agent_id: sage.id });
    check(errorOf(scoutThread)?.code === 'conversation_not_found' && errorOf(vaultThread)?.code === 'conversation_not_found', 'a conversation outside the grants -> conversation_not_found');
    const convB = await v2call('botmancers_list_conversations', { agent_id: vault.id }, { token: OTHER_TOKEN });
    check(errorOf(convB)?.code === 'grant_required', 'other-svc holds conversations:read nowhere -> grant_required');
    check(same(before, v2counts()), 'discovery and every refusal wrote nothing');
  }

  section('v2 act (same Agent): send_to_session resumes exactly the referenced session');
  let sent;
  {
    const before = v2counts();
    const ref = sageActive.binding.id;
    const rejected = [
      ['authority field (runtime)', { session_ref: ref, content: 'hi', idempotency_key: 'r-1', runtime: 'codex' }, 'authority_not_allowed', 'grok'],
      ['authority field (external_session_id)', { session_ref: ref, content: 'hi', idempotency_key: 'r-2', external_session_id: PROVIDER.scout }, 'authority_not_allowed', 'grok'],
      ['unknown field', { session_ref: ref, content: 'hi', idempotency_key: 'r-3', urgent: true }, 'unsupported_field', 'grok'],
      ['missing idempotency_key', { session_ref: ref, content: 'hi' }, 'invalid_arguments', 'grok'],
      ['idempotency_key outside the pattern', { session_ref: ref, content: 'hi', idempotency_key: 'has space' }, 'invalid_arguments', 'grok'],
      ['blank content', { session_ref: ref, content: '   ', idempotency_key: 'r-4' }, 'invalid_arguments', 'grok'],
      ['content over 4000 characters', { session_ref: ref, content: 'x'.repeat(4001), idempotency_key: 'r-5' }, 'invalid_arguments', 'grok'],
      ['ended session', { session_ref: sageEnded.binding.id, content: 'hi', idempotency_key: 'r-6' }, 'session_ended', 'grok'],
      ['unknown session', { session_ref: 'no-such-session', content: 'hi', idempotency_key: 'r-7' }, 'session_not_found', 'grok'],
      ['ungranted Agent\'s session', { session_ref: vaultS.binding.id, content: 'hi', idempotency_key: 'r-8' }, 'session_not_found', 'grok'],
      ['Agent granted without sessions:message', { session_ref: scoutS.binding.id, content: 'hi', idempotency_key: 'r-9' }, 'session_not_found', 'grok'],
      ['principal with sessions:message nowhere', { session_ref: ref, content: 'hi', idempotency_key: 'r-10' }, 'grant_required', 'other'],
    ];
    const missing = await v2call('botmancers_send_to_session', { session_ref: 'no-such-session', content: 'hi', idempotency_key: 'r-0' });
    for (const [label, args, code, who] of rejected) {
      const res = await v2call('botmancers_send_to_session', args, who === 'other' ? { token: OTHER_TOKEN } : {});
      check(errorOf(res)?.code === code, `${label} -> ${code} (got ${errorOf(res) ? errorOf(res).code : 'accepted'})`);
      if (code === 'session_not_found') check(errorOf(res).message === errorOf(missing).message, `${label}: indistinguishable from a missing session`);
    }
    await ctx.service.waitForAgentDispatchIdle();
    console.log(`  rows before=${JSON.stringify(before)}`);
    console.log(`  rows after =${JSON.stringify(v2counts())}`);
    check(same(before, v2counts()), 'no rejected send wrote an exchange, event, request, Attempt, message, conversation, or binding');

    sent = await v2call('botmancers_send_to_session', { session_ref: ref, content: 'Are the leases still needed?', idempotency_key: 'send-1' });
    conforms('botmancers_send_to_session', sent);
    console.log(`  send -> ${JSON.stringify(sent.data)}`);
    check(sent.data.session_ref === ref && sent.data.agent_id === sage.id && sent.data.replayed === false && sent.data.exchange_id && sent.data.request_id && sent.data.conversation_id,
      'accepted: the exact session_ref, its owning Agent, and durable exchange, request, and conversation ids');
    await ctx.settle([sent.data.request_id]);
    const attempts = ctx.attemptsOf(sent.data.request_id);
    const hop = engine.getWorkRequest(sent.data.request_id);
    check(attempts.length === 1 && attempts[0].kind === 'resume' && attempts[0].resumed_session_binding_id === ref && hop.tool_profile === 'readonly' && hop.target_agent_id === sage.id,
      'exactly one read-only resume Attempt of exactly the referenced binding, for its owning Agent');
    const polled = await v2call('botmancers_get_exchange', { exchange_id: sent.data.exchange_id });
    conforms('botmancers_get_exchange', polled);
    check(polled.data.terminal === true && polled.data.exchange.state === 'completed' && polled.data.exchange.kind === 'session_message' && polled.data.content_trust === 'untrusted'
      && /Sage answers/.test(polled.data.exchange.answer.content) && !polled.text.includes(PROVIDER.sage), 'polling get_exchange: terminal, completed, the reply redacted and marked untrusted');
    const mine = await v2call('botmancers_get_conversation', { conversation_id: sent.data.conversation_id, agent_id: sage.id });
    check(mine.data && mine.data.messages.length === 2 && mine.data.messages[0].sender.kind === 'service', 'the caller reads its question and the reply in the returned conversation');
    const mid = v2counts();
    const replay = await v2call('botmancers_send_to_session', { session_ref: ref, content: 'Are the leases still needed?', idempotency_key: 'send-1' });
    check(replay.data.replayed === true && replay.data.exchange_id === sent.data.exchange_id && replay.data.request_id === sent.data.request_id && same(mid, v2counts()),
      'an exact replay returns the original ids and writes nothing');
    const conflict = await v2call('botmancers_send_to_session', { session_ref: ref, content: 'Something else', idempotency_key: 'send-1' });
    check(errorOf(conflict)?.code === 'idempotency_conflict' && errorOf(conflict).retryable === false && same(mid, v2counts()), 'the same key with other content -> idempotency_conflict, nothing written');
    const rest = await fetch(`${host.origin}/api/v0/sessions/${ref}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ content: 'Are the leases still needed?', idempotency_key: 'send-1' }),
    }).then(async res => ({ status: res.status, json: await res.json() }));
    check(rest.status === 200 && rest.json.replayed === true && rest.json.exchange_id === sent.data.exchange_id && same(mid, v2counts()),
      'REST /api/v0/sessions/{ref}/messages replays the same durable exchange: MCP and API share one record');
  }

  section('v2 act (exchange): Ask and Continue through the canonical exchange store');
  {
    const before = v2counts();
    const askArgs = { mode: 'ask', source: { session_ref: sageActive.binding.id }, instruction: 'Summarize where the rollout stands.', idempotency_key: 'ask-1' };
    const contArgs = { mode: 'continue', source: { session_ref: sageActive.binding.id, agent_id: sage.id }, destination: { agent_id: scout.id }, instruction: 'Carry the rollout on.', idempotency_key: 'cont-1' };
    const rejected = [
      ['Ask with a destination', { ...askArgs, idempotency_key: 'x-1', destination: { agent_id: scout.id } }, 'destination_invalid'],
      ['Continue without a destination', { ...contArgs, idempotency_key: 'x-2', destination: undefined }, 'destination_invalid'],
      ['Continue to an ungranted Agent', { ...contArgs, idempotency_key: 'x-3', destination: { agent_id: vault.id } }, 'agent_not_found'],
      ['nested authority field', { ...contArgs, idempotency_key: 'x-4', destination: { agent_id: scout.id, deck: 'deck-x' } }, 'authority_not_allowed'],
      ['destination session field', { ...contArgs, idempotency_key: 'x-5', destination: { agent_id: scout.id, session_ref: scoutS.binding.id } }, 'unsupported_field'],
      ['tool_profile field', { ...askArgs, idempotency_key: 'x-6', tool_profile: 'edit' }, 'authority_not_allowed'],
      ['source owned by another Agent than named', { ...askArgs, idempotency_key: 'x-7', source: { session_ref: sageActive.binding.id, agent_id: scout.id } }, 'session_not_found'],
      ['unknown source session', { ...askArgs, idempotency_key: 'x-8', source: { session_ref: 'no-such-session' } }, 'session_not_found'],
      ['ended source session', { ...askArgs, idempotency_key: 'x-9', source: { session_ref: sageEnded.binding.id } }, 'session_ended'],
      ['bad mode', { ...askArgs, idempotency_key: 'x-10', mode: 'fork' }, 'invalid_arguments'],
      ['nested exchange id', { ...askArgs, idempotency_key: 'x-11', parent_exchange_id: 'e-1' }, 'unsupported_field'],
    ];
    for (const [label, args, code] of rejected) {
      const clean = JSON.parse(JSON.stringify(args));
      const res = await v2call('botmancers_create_exchange', clean);
      check(errorOf(res)?.code === code, `${label} -> ${code} (got ${errorOf(res) ? errorOf(res).code : 'accepted'})`);
    }
    const nested = await v2call('botmancers_create_exchange', { ...contArgs, idempotency_key: 'x-12', destination: { agent_id: scout.id, deck: 'deck-x' } });
    check(JSON.stringify(errorOf(nested).fields) === '["destination.deck"]', 'a nested authority field is named with its path');
    const otherCreate = await v2call('botmancers_create_exchange', askArgs, { token: OTHER_TOKEN });
    check(errorOf(otherCreate)?.code === 'grant_required', 'a principal holding exchanges:create nowhere -> grant_required');
    await ctx.service.waitForAgentDispatchIdle();
    check(same(before, v2counts()), 'no rejected create wrote anything');

    const ask = await v2call('botmancers_create_exchange', askArgs);
    conforms('botmancers_create_exchange', ask, 'create_exchange (Ask)');
    check(ask.data.exchange.mode === 'ask' && ask.data.exchange.source.session_ref === sageActive.binding.id && ask.data.replayed === false && 'instruction' in ask.data.exchange,
      'Ask created on the exact session, full view (the caller also holds exchanges:read)');
    const cont = await v2call('botmancers_create_exchange', contArgs);
    conforms('botmancers_create_exchange', cont, 'create_exchange (Continue)');
    const poll = async id => {
      for (let i = 0; i < 200; i += 1) {
        const res = await v2call('botmancers_get_exchange', { exchange_id: id });
        if (res.data && res.data.terminal) return res;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return v2call('botmancers_get_exchange', { exchange_id: id });
    };
    const askDone = await poll(ask.data.exchange.id);
    const contDone = await poll(cont.data.exchange.id);
    console.log(`  ask      -> ${askDone.data.exchange.state}: ${askDone.data.exchange.answer && askDone.data.exchange.answer.content}`);
    console.log(`  continue -> ${contDone.data.exchange.state}: packet ${JSON.stringify(contDone.data.exchange.packet)}; destination ${contDone.data.exchange.destination && contDone.data.exchange.destination.agent_name}`);
    check(askDone.data.terminal && askDone.data.exchange.state === 'completed' && /Sage answers/.test(askDone.data.exchange.answer.content), 'the Ask completes with Sage\'s answer');
    check(contDone.data.terminal && contDone.data.exchange.state === 'completed' && contDone.data.exchange.packet.objective === 'Finish the v2 bridge'
      && contDone.data.exchange.destination.agent_id === scout.id && contDone.data.exchange.destination.session_ref && contDone.data.exchange.destination.session_ref !== sageActive.binding.id,
    'the Continue completes: a handoff packet, delivered to Scout in a fresh session of its own');
    const mid = v2counts();
    const replay = await v2call('botmancers_create_exchange', contArgs);
    check(replay.data.replayed === true && replay.data.exchange.id === cont.data.exchange.id && replay.data.terminal === true && same(mid, v2counts()), 'an exact replay returns the same (now terminal) exchange and writes nothing');
    const conflict = await v2call('botmancers_create_exchange', { ...contArgs, instruction: 'different' });
    check(errorOf(conflict)?.code === 'idempotency_conflict' && same(mid, v2counts()), 'a changed payload under the same key -> idempotency_conflict');

    const bad = await v2call('botmancers_create_exchange', { ...contArgs, idempotency_key: 'cont-bad', instruction: 'BAD-PACKET please' });
    const badDone = await poll(bad.data.exchange.id);
    console.log(`  failed   -> ${badDone.data.exchange.state}: ${JSON.stringify(badDone.data.exchange.failure)}`);
    check(badDone.data.terminal === true && badDone.data.exchange.state === 'failed' && typeof badDone.data.exchange.failure.code === 'string' && badDone.data.exchange.failure.code.length > 0,
      'a failed exchange is terminal with a stable failure code');

    const listAll = await v2call('botmancers_list_exchanges', { limit: 100 });
    conforms('botmancers_list_exchanges', listAll);
    check(listAll.data.items.some(e => e.id === sent.data.exchange_id && e.kind === 'session_message') && listAll.data.items.some(e => e.id === cont.data.exchange.id && e.kind === 'exchange'),
      'list_exchanges holds the session message and the exchanges');
    const p1 = await v2call('botmancers_list_exchanges', { limit: 2 });
    const p2 = await v2call('botmancers_list_exchanges', { limit: 2, cursor: p1.data.next_cursor });
    check(p1.data.items.length === 2 && p2.data.items.length >= 1 && !p2.data.items.some(e => p1.data.items.some(x => x.id === e.id)), 'list_exchanges pages without repeats');
    const foreign = await v2call('botmancers_get_exchange', { exchange_id: cont.data.exchange.id }, { token: OTHER_TOKEN });
    const ghost = await v2call('botmancers_get_exchange', { exchange_id: 'no-such-exchange' }, { token: OTHER_TOKEN });
    const otherList = await v2call('botmancers_list_exchanges', {}, { token: OTHER_TOKEN });
    check(errorOf(foreign)?.code === 'exchange_not_found' && canonical(errorOf(foreign)) === canonical(errorOf(ghost)) && otherList.data.items.length === 0,
      'another principal cannot read or list the exchange (indistinguishable from missing)');
    const audit = raw.prepare("SELECT operation, outcome, code FROM service_audit_events WHERE principal = 'service:grok-bot'").all();
    check(audit.filter(r => r.operation === 'sessions.message' && r.outcome === 'allowed').length >= 2 && audit.some(r => r.operation === 'exchanges.create' && r.code === 'authority_not_allowed')
      && audit.some(r => r.operation === 'sessions.message' && r.code === 'session_ended'), 'every v2 call, allowed or refused, is in the service audit trail');
  }

  section('v2 rate limit: the service layer\'s limit is a structured, retryable tool error');
  {
    const RATE_TOKEN = 'bmt_rate_service_fixture_token_3333';
    const tokens = process.env.BOTMANCERS_SERVICE_TOKENS;
    process.env.BOTMANCERS_SERVICE_TOKENS = `${tokens}, rate-svc=${digest(RATE_TOKEN)}`;
    process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '2';
    const before = v2counts();
    await v2call('botmancers_capabilities', {}, { token: RATE_TOKEN });
    await v2call('botmancers_capabilities', {}, { token: RATE_TOKEN });
    const limited = await v2call('botmancers_send_to_session', { session_ref: sageActive.binding.id, content: 'flood', idempotency_key: 'flood-1' }, { token: RATE_TOKEN });
    console.log(`  over limit -> ${limited.status} ${JSON.stringify(limited.data)}`);
    check(limited.status === 200 && errorOf(limited)?.code === 'rate_limited' && errorOf(limited).retryable === true && errorOf(limited).retry_after_seconds >= 1,
      'over the service limit -> rate_limited, retryable, with retry_after_seconds');
    check(same(before, v2counts()), 'the rate-limited call wrote nothing');
    process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '1000';
    process.env.BOTMANCERS_SERVICE_TOKENS = tokens;
  }

  section('v2 redaction: no provider session or run id, Deck, workspace, or token in any v2 result');
  {
    const textAll = v2Text.join('\n');
    const runIds = raw.prepare('SELECT external_run_id FROM work_attempts WHERE external_run_id IS NOT NULL').all().map(r => r.external_run_id);
    const leaks = [...Object.values(PROVIDER), `${PROVIDER.sageOld}-next`, TOKEN, OTHER_TOKEN, digest(TOKEN), sage.deck_id, scout.deck_id, vault.deck_id, ctx.workspace,
      ...runIds].filter(needle => needle && textAll.includes(needle));
    check(v2Text.length > 60, `collected ${v2Text.length} v2 responses`);
    check(leaks.length === 0, `no v2 response contains a private value${leaks.length ? ` (leaked: ${leaks.join(', ')})` : ''}`);
  }

  section('v2 documentation and source links');
  {
    const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
    const bridgeDoc = read('docs/mcp-bridge.md');
    const pkgReadme = read('packages/mcp-server/README.md');
    const readme = read('README.md');
    const changelog = read('packages/mcp-server/CHANGELOG.md');
    check(V2_NAMES.every(name => bridgeDoc.includes(`\`${name}\``)) && bridgeDoc.includes('`botmancers_get_conversation`'), 'docs/mcp-bridge.md documents every v2 tool');
    check(/botmancers\.mcp\.v2/.test(bridgeDoc) && /## Versioning/.test(bridgeDoc) && /v1 compatibility/i.test(bridgeDoc) && /service-grants\.md/.test(bridgeDoc)
      && /backoff/i.test(bridgeDoc) && /## Error recovery/.test(bridgeDoc) && /same-session/i.test(bridgeDoc) && /cross-Agent/.test(bridgeDoc),
    'docs/mcp-bridge.md covers grants, v1 compatibility, polling/backoff, error recovery, versioning, and a same-session plus cross-Agent example');
    const codes = ctx.lib('mcp-bridge-v2.ts').MCP_V2_ERROR_CODES;
    check(codes.every(code => bridgeDoc.includes(`\`${code}\``)), 'docs/mcp-bridge.md lists every v2 error code');
    check(/botmancers\.mcp\.v2/.test(readme) && readme.includes('docs/contracts/mcp-bridge-v2.tools.json'), 'README names the v2 contract and its capture');
    check(/botmancers\.mcp\.v2/.test(pkgReadme) && V2_NAMES.every(name => pkgReadme.includes(name)) && /preflight/i.test(pkgReadme), 'the package README documents the v2 tools and the compatibility preflight');
    check(/botmancers\.mcp\.v2/.test(changelog), 'the package CHANGELOG records the v2 contract');
    const broken = [];
    for (const [file, text] of [['docs/mcp-bridge.md', bridgeDoc], ['README.md', readme], ['packages/mcp-server/README.md', pkgReadme]]) {
      for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        if (/^[a-z]+:/i.test(target)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(path.join(ROOT, file)), target))) broken.push(`${file} -> ${target}`);
      }
    }
    check(broken.length === 0, `every relative link in the bridge docs resolves${broken.length ? ` (broken: ${broken.join(', ')})` : ''}`);
  }

  await ctx.service.waitForAgentDispatchIdle();
  await ctx.close();
  await ctx.fakeDeck.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}
