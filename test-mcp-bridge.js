#!/usr/bin/env node
// NOT-491: the Botmancers MCP bridge (botmancers.mcp.v1) end to end.
//
//   npm run test:mcp-bridge                     run
//   npm run test:mcp-bridge -- --write-contract  regenerate the captured tool schemas
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
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const ROOT = __dirname;
const CONTRACT_FILE = path.join(ROOT, 'docs', 'contracts', 'mcp-bridge-v1.tools.json');
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
    check(JSON.stringify(names) === JSON.stringify(['botmancers_start_task', 'botmancers_get_request', 'botmancers_get_conversation', 'botmancers_health']),
      'exactly botmancers_start_task, botmancers_get_request, botmancers_get_conversation, botmancers_health');
    check(tools.every(tool => tool._meta['botmancers/contract'] === 'botmancers.mcp.v1' && tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false
      && tool.outputSchema && tool.outputSchema.properties.contract.const === 'botmancers.mcp.v1'), 'every tool carries contract botmancers.mcp.v1, a closed input schema, and an output schema');
    if (WRITE_CONTRACT) {
      fs.writeFileSync(CONTRACT_FILE, `${JSON.stringify({ contract: 'botmancers.mcp.v1', tools }, null, 2)}\n`);
      console.log(`  wrote ${path.relative(ROOT, CONTRACT_FILE)}`);
    }
    const captured = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8'));
    check(captured.contract === 'botmancers.mcp.v1' && JSON.stringify(captured.tools) === JSON.stringify(tools), `tools/list equals the captured schemas in ${path.relative(ROOT, CONTRACT_FILE)}`);
    const unknownTool = await call('botmancers_run_anything', {});
    check(unknownTool.json.error && unknownTool.json.error.code === -32602, 'an unknown tool name is a JSON-RPC invalid params error');
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

  await ctx.service.waitForAgentDispatchIdle();
  await ctx.close();
  await ctx.fakeDeck.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}
