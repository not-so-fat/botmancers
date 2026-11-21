#!/usr/bin/env node
// NOT-517: launch-bound SessionContext and share-current
// (lib/session-context, docs/service-access.md "Share the current session",
// docs/design/2026-10-24-session-share-preflight.md §2). Proves against the
// real store, an isolated SQLite file, the real Claude Code and Codex
// providers (driven through test-support/fake-claude-cli.js and
// test-support/fake-codex.js), the real Cursor provider (fake cursor-agent),
// and the real REST and MCP handlers:
//   - minting: bmsc_ + 256 random bits, only the SHA-256 stored, one
//     (Agent, session_ref, launch) per context, nothing minted while the
//     owner has share-from-turn off;
//   - resolution: exact binding; the frozen reasons missing, ambiguous,
//     unsupported, unknown, stale, revoked; the 15-minute rule after the
//     last turn; launch end, process restart, thread unload, app-server
//     exit, owner toggle-off; replay of an ended token; cross-Agent and
//     moved sessions;
//   - authentication: the header authenticates only the reserved principal
//     and only for share-current; a service token cannot call share-current;
//     the reserved principal cannot call any other REST/MCP operation and is
//     refused in grants and token configuration;
//   - the §2 error matrix over REST and MCP, table-driven, with no share,
//     event, or pin written by any refusal and the same NOT-515 rows on
//     success; session_ref and every heuristic/provider selector refused;
//   - Claude: a per-turn 0600 --mcp-config whose header is an ${ENV}
//     reference, exactly the share-current tool added to --allowedTools, the
//     value only in the turn's environment; ended with the turn;
//   - Codex app-server: distinct contexts per thread/start and first
//     thread/resume load, none on a resume of a loaded thread (load-scoped,
//     not turn-scoped), ended on thread/closed and app-server exit, a new
//     one after a restart; codex exec: -c mcp_servers.botmancers.*;
//   - Cursor: no context, no MCP configuration written anywhere,
//     session_context_required;
//   - the secret never in argv, logs, provider records, the database file,
//     an audit row, a response, or a tool's arguments.
// Self-contained: no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const ROOT = __dirname;
const TAG = process.env.NOT517_TAG || `${process.pid}`;
const TMP = fs.realpathSync(os.tmpdir()) + `/botmancers-session-context-${TAG}`;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const STATE = path.join(TMP, 'provider.json');
const SHARES_PATH = path.join(TMP, 'session-shares.json');
const HOME_DIR = path.join(TMP, 'home');
const WS = path.join(TMP, 'ws');
const CLAUDE = { config: path.join(TMP, 'claude-config'), state: path.join(TMP, 'claude-state'), calls: path.join(TMP, 'claude-calls.jsonl'), mcp: path.join(TMP, 'claude-mcp.jsonl') };
const CODEX = { main: path.join(TMP, 'codex-main.json'), exec: path.join(TMP, 'codex-exec.json'), runs: path.join(TMP, 'codex-runs') };
const CURSOR = { bin: path.join(TMP, 'bin', 'cursor-agent'), fake: path.join(TMP, 'cursor-fake'), state: path.join(TMP, 'cursor-state') };
for (const dir of [HOME_DIR, WS, CLAUDE.config, CLAUDE.state, CODEX.runs, path.dirname(CURSOR.bin), CURSOR.fake, CURSOR.state]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(CURSOR.bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test-support', 'fake-cursor-cli.js')}" "$@"\n`, { mode: 0o755 });

const digest = token => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
const GROK_TOKEN = 'grok-token-NOT517';
process.env.HOME = HOME_DIR;
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(GROK_TOKEN)}`;
process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '100000';
process.env.BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE = '100000';
process.env.BOTMANCERS_SESSION_CONTEXT_URL = 'http://127.0.0.1:3999/api/v0/mcp';
// An ambient value in Botmancers' own environment is never passed on.
process.env.BOTMANCERS_SESSION_CONTEXT = 'bmsc_AMBIENTambientAMBIENTambientAMBIENTambient0';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK|^CLAUDE_CODE/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const tokenAuth = jiti('./lib/service-token-auth.ts');
const sc = jiti('./lib/session-context.ts');
const launch = jiti('./lib/session-context-launch.ts');
const claude = jiti('./lib/claude-session-provider.ts');
const codex = jiti('./lib/codex-session-provider.ts');
const cursor = jiti('./lib/cursor-session-provider.ts');
const { serviceOperations } = jiti('./lib/service-api-http.ts');
const { handleMcpPost } = jiti('./lib/mcp-http.ts');
const mcpBridge = jiti('./lib/mcp-bridge.ts');
const currentRoute = jiti('./app/api/v0/shares/current/route.ts');
const agentsRoute = jiti('./app/api/v0/agents/route.ts');
const fake = require('./test-support/fake-session-provider');
const { seedFakeCodex, FAKE_CODEX } = require('./test-support/fake-codex');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const owner = { kind: 'person', id: 'local-owner' };
const grok = { kind: 'service', id: 'grok-bot' };
const audience = { kind: 'slack', team_id: 'T0CTX0001', channel_id: 'C0CTX0001' };
const TOKEN_SHAPE = /^bmsc_[A-Za-z0-9_-]{43}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

function writeJson(file, value, mode = 0o600) {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, mode);
}

// Every token handed out in this run: none may appear on a durable or
// visible surface.
const issued = new Set();
const track = token => { if (token) issued.add(token); return token; };

function snapshot() {
  return {
    shares: count('SELECT COUNT(*) AS n FROM session_shares'),
    events: count('SELECT COUNT(*) AS n FROM session_share_events'),
    pins: count('SELECT COUNT(*) AS n FROM session_pins'),
    pinTurns: count('SELECT COUNT(*) AS n FROM session_pin_turns'),
  };
}
const audits = () => count('SELECT COUNT(*) AS n FROM service_audit_events');
const lastAudit = () => db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT 1').get();
const ctxRow = token => db.prepare('SELECT * FROM session_contexts WHERE token_sha256 = ?').get(sha(token));

// ---- transports ----

function restCurrent(headers, body) {
  return currentRoute.POST(new Request('http://127.0.0.1:3999/api/v0/shares/current', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })).then(async res => ({ status: res.status, body: await res.json() }));
}

let rpcId = 0;
async function mcpPost(headers, method, params) {
  const res = await handleMcpPost(new Request('http://127.0.0.1:3999/api/v0/mcp', {
    method: 'POST', headers: { host: '127.0.0.1:3999', 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
const contextHeader = value => ({ [launch.SESSION_CONTEXT_HEADER]: value });
async function mcpShare(headers, args) {
  const res = await mcpPost(headers, 'tools/call', { name: launch.SHARE_CURRENT_TOOL, arguments: args });
  const structured = res.json && res.json.result ? res.json.result.structuredContent : null;
  return { ...res, structured, isError: !!(res.json && res.json.result && res.json.result.isError) };
}

// ---- fixtures ----

async function syncAll(agentId) {
  let cursorValue = null;
  do cursorValue = (await ps.syncAgentSessions(db, agentId, { cursor: cursorValue })).next_cursor; while (cursorValue);
}

function botOf(name, agentKind, connectionId, extra = {}) {
  return dbModule.bots.create({
    name, title: name, description: 'NOT-517', agent: agentKind, runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0, ...extra,
  });
}

const codexRuntimes = [];
function codexRuntime(statePath) {
  const rt = new codex.CodexRuntime({
    command: [process.execPath, FAKE_CODEX], env: { ...process.env, FAKE_CODEX_STATE: statePath }, runsDir: CODEX.runs, requestTimeoutMs: 10_000,
  });
  codexRuntimes.push(rt);
  return rt;
}
// The provider's real requests (not its capability probes, which send
// ill-typed parameters).
const codexCalls = (statePath, method) => JSON.parse(fs.readFileSync(statePath, 'utf8')).calls
  .filter(call => call.method === method && typeof (call.params.cwd ?? call.params.threadId ?? '') === 'string');
const configToken = call => {
  const entry = call && call.params && call.params.config && call.params.config.mcp_servers && call.params.config.mcp_servers.botmancers;
  return entry ? entry.http_headers[launch.SESSION_CONTEXT_HEADER] : null;
};

main().then(() => {
  for (const rt of codexRuntimes) rt.shutdown();
  console.log(failures ? `\n${failures} failure(s)` : '\nAll session-context checks passed.');
  process.exit(failures ? 1 : 0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});

async function main() {
  console.log('\nSetup: Agents on a deterministic provider, Claude Code, Codex, and Cursor; owner share configuration');
  const fakeConnection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Fake', host: 'This computer' }).id;
  const claudeConnection = dbModule.runtimeConnections.create({ provider: 'claude', label: 'Claude', host: 'This computer' }).id;
  const codexConnection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' }).id;
  const execConnection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex exec', host: 'This computer' }).id;
  const cursorConnection = dbModule.runtimeConnections.create({ provider: 'cursor', label: 'Cursor', host: 'This computer' }).id;
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId: fakeConnection }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
  const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE.config, FAKE_CLAUDE_LOG: CLAUDE.calls, FAKE_CLAUDE_MCP_OUT: CLAUDE.mcp };
  contract.registerSessionProvider({ connectionId: claudeConnection }, () => claude.createClaudeSessionProvider({
    bin: path.join(ROOT, 'test-support', 'fake-claude-cli.js'), configDir: CLAUDE.config, stateDir: CLAUDE.state, env: claudeEnv, pollMs: 20, startupTimeoutMs: 20_000,
  }));
  seedFakeCodex(CODEX.main, []);
  seedFakeCodex(CODEX.exec, [], { missingMethods: ['thread/start', 'thread/resume', 'turn/start'] });
  let codexMain = codexRuntime(CODEX.main);
  const registerCodex = () => contract.registerSessionProvider({ connectionId: codexConnection }, () => codex.createCodexSessionProvider(codexMain));
  registerCodex();
  const codexExec = codexRuntime(CODEX.exec);
  contract.registerSessionProvider({ connectionId: execConnection }, () => codex.createCodexSessionProvider(codexExec));
  contract.registerSessionProvider({ connectionId: cursorConnection }, connection => cursor.createCursorSessionProvider(connection, {
    cliPath: CURSOR.bin, sdkModule: path.join(TMP, 'no-sdk.mjs'), stateDir: CURSOR.state, env: { ...process.env, FAKE_CURSOR_STATE: CURSOR.fake }, pollMs: 20,
  }));
  fake.seedFakeProvider(STATE, [
    { id: 'ctx-1-SECRET', title: 'Uploader retry', workspace: '/work/ctx' },
    { id: 'ctx-2-SECRET', title: 'Release notes', workspace: '/work/ctx' },
    { id: 'gone-1-SECRET', title: 'Soon gone', workspace: '/work/ctx' },
    { id: 'other-1-SECRET', title: 'Other agent', workspace: '/work/other' },
  ]);
  const dev = botOf('Dev', 'codex', fakeConnection);
  const otherAgent = botOf('Other', 'codex', fakeConnection);
  const claudeDev = botOf('ClaudeDev', 'claude', claudeConnection);
  const claudeOff = botOf('ClaudeOff', 'claude', claudeConnection);
  const codexDev = botOf('CodexDev', 'codex', codexConnection);
  const execDev = botOf('ExecDev', 'codex', execConnection);
  const cursorDev = botOf('CursorDev', 'cursor', cursorConnection);
  for (const bot of [dev, otherAgent]) await syncAll(bot.id);
  const keep = (bot, ids) => db.prepare(`DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id NOT IN (${ids.map(() => '?').join(',')})`).run(bot.id, ...ids);
  keep(dev, ['ctx-1-SECRET', 'ctx-2-SECRET', 'gone-1-SECRET']);
  keep(otherAgent, ['other-1-SECRET']);
  const refOf = (bot, id) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(bot.id, id).id;
  const s1 = refOf(dev, 'ctx-1-SECRET');
  const s2 = refOf(dev, 'ctx-2-SECRET');
  const gone = refOf(dev, 'gone-1-SECRET');
  const otherRef = refOf(otherAgent, 'other-1-SECRET');
  const sharesConfig = on => ({
    version: 1, audiences: [audience],
    agents: [dev, claudeDev, codexDev, execDev, cursorDev].map(bot => ({ agent: bot.id, share_from_turn: on }))
      .concat([{ agent: otherAgent.id, share_from_turn: false }, { agent: claudeOff.id, share_from_turn: false }]),
  });
  writeJson(SHARES_PATH, sharesConfig(true));
  const launchOf = ref => ({ kind: 'codex_thread_load', ref });
  const mint = (agentId, sessionRef, ref, processBound = false) => {
    const minted = sc.mintSessionContext({ agentId, sessionRef, launch: launchOf(ref), processBound });
    if (minted) track(minted.token);
    return minted;
  };

  console.log('\nMint: bmsc_ + 256 random bits, only SHA-256 stored, one Agent/session/launch');
  let c1;
  {
    c1 = mint(dev.id, s1, 'launch-1');
    const raw = Buffer.from(c1.token.slice(5), 'base64url');
    assert(TOKEN_SHAPE.test(c1.token) && raw.length === 32, 'the context is bmsc_ followed by 32 random bytes (256 bits) in base64url');
    const row = sc.contextRow(c1.id);
    assert(row.token_sha256 === sha(c1.token) && row.agent_id === dev.id && row.session_ref === s1 && row.state === 'live' && row.launch_kind === 'codex_thread_load',
      'the row binds exactly one Agent, session_ref, and launch, and stores only the SHA-256 of the token');
    assert(!Object.values(row).some(value => typeof value === 'string' && (value.includes(c1.token) || value.includes('launch-1'))),
      'no column holds the token or the raw provider launch id (the launch is a digest)');
    const tokens = new Set(Array.from({ length: 50 }, (_, i) => mint(dev.id, s2, `burst-${i}`).token));
    assert(tokens.size === 50, '50 mints are 50 distinct tokens');
    for (let i = 0; i < 50; i++) sc.endSessionLaunch(launchOf(`burst-${i}`), 'process_exit');
    assert(mint(otherAgent.id, otherRef, 'off-1') === null, 'share-from-turn off for the Agent: nothing is minted');
    assert(mint(dev.id, otherRef, 'cross-1') === null, 'a session of another Agent: nothing is minted');
    const ok = sc.resolveSessionContext(c1.token);
    assert(ok.ok && ok.agentId === dev.id && ok.sessionRef === s1 && ok.contextId === c1.id, 'resolve: exactly the bound Agent and session_ref');
  }

  console.log('\nResolve: the frozen reasons');
  {
    const reason = value => { const r = sc.resolveSessionContext(value); return r.ok ? 'ok' : r.reason; };
    const c2 = mint(dev.id, s2, 'launch-2');
    assert(reason(null) === 'missing' && reason('') === 'missing' && reason('  ') === 'missing', 'no header (or an empty one): missing');
    assert(reason(`${c1.token}, ${c2.token}`) === 'ambiguous' && reason(`${c1.token},${c1.token}`) === 'ambiguous', 'two values (repeated or comma-joined), even the same twice: ambiguous');
    for (const ambient of ['0b9e3c1a-1111-4222-8333-944455556666', 'claude:0b9e3c1a-1111-4222-8333-944455556666', 'chat_01HZXY', '/Users/dev/project', `bmsc_${'A'.repeat(42)}`, 'x'.repeat(5000)]) {
      assert(reason(ambient) === 'unsupported', `a provider id or other value in place of a minted context (${ambient.slice(0, 24)}…): unsupported`);
    }
    assert(reason(`bmsc_${'A'.repeat(43)}`) === 'unknown', 'well-formed but never minted: unknown');
    sc.endSessionLaunch(launchOf('launch-2'), 'process_exit');
    assert(reason(c2.token) === 'stale' && sc.contextRow(c2.id).end_reason === 'process_exit', 'the launch ended (its process exited): stale');
    assert(reason(c2.token) === 'stale', 'replaying an ended context stays stale');
    const c3 = mint(dev.id, s2, 'launch-3');
    sc.revokeSessionContext(c3.id);
    assert(reason(c3.token) === 'revoked', 'a revoked context: revoked');
    const c4 = mint(dev.id, s2, 'launch-4', true);
    sc.simulateSessionContextRestart();
    assert(reason(c4.token) === 'stale' && sc.contextRow(c4.id).end_reason === 'restart', 'a process-bound launch after a Botmancers restart: stale (ended restart)');
    const unbound = sc.mintSessionContext({ agentId: dev.id, sessionRef: null, launch: launchOf('start-1') });
    track(unbound.token);
    assert(reason(unbound.token) === 'stale', 'a start launch whose session is not recorded yet names no session: stale');
    assert(sc.bindSessionContext(unbound.id, otherRef) === false && sc.contextRow(unbound.id).state === 'ended', 'binding it to another Agent\'s session fails and ends it');
    const c5 = mint(dev.id, s2, 'launch-5');
    // A row tampered to name another Agent's session (the binding is checked
    // against the session's owner on every use).
    db.prepare('UPDATE session_contexts SET session_ref = ? WHERE id = ?').run(otherRef, c5.id);
    assert(reason(c5.token) === 'stale' && sc.contextRow(c5.id).end_reason === 'session_changed', 'a context naming a session its Agent does not own: stale, never re-pointed');
  }

  console.log('\nLiveness: at most 15 minutes after the last Botmancers turn on the session');
  {
    const t0 = Date.now();
    sc.setSessionContextClock(() => t0);
    const live = mint(dev.id, s2, 'idle-1');
    sc.setSessionContextClock(() => t0 + sc.SESSION_CONTEXT_IDLE_MS - 1000);
    assert(sc.resolveSessionContext(live.token).ok, 'within 15 minutes of the mint: valid');
    sc.setSessionContextClock(() => t0 + sc.SESSION_CONTEXT_IDLE_MS + 1000);
    const idle = sc.resolveSessionContext(live.token);
    assert(!idle.ok && idle.reason === 'stale' && sc.contextRow(live.id).end_reason === 'idle_timeout', 'past 15 minutes with no turn: stale (ended idle_timeout)');
    sc.setSessionContextClock(() => t0);
    const running = mint(dev.id, s1, 'idle-2');
    const turn = await ps.sendProviderTurn(db, dev.id, s1, { prompt: '[hold] long', authority: 'read_only', idempotencyKey: 'idle-turn-1', requester: owner });
    sc.setSessionContextClock(() => t0 + 3 * sc.SESSION_CONTEXT_IDLE_MS);
    assert(sc.resolveSessionContext(running.token).ok, 'a Botmancers turn on the session is running: valid past 15 minutes');
    db.prepare("UPDATE provider_session_turns SET state = 'completed', finished_at = ? WHERE id = ?").run(t0 + 2 * sc.SESSION_CONTEXT_IDLE_MS, turn.turn.turn_ref);
    assert(sc.resolveSessionContext(running.token).ok, 'within 15 minutes after that turn finished: valid');
    sc.setSessionContextClock(() => t0 + 3 * sc.SESSION_CONTEXT_IDLE_MS + 1000);
    assert(sc.resolveSessionContext(running.token).reason === 'stale', '15 minutes after the last turn finished: stale');
    sc.setSessionContextClock(null);
    fake.mutateFakeProvider(STATE, state => { for (const t of Object.values(state.turns)) if (t.state === 'running') t.prompt = t.prompt.replace('[hold] ', ''); });
  }

  console.log('\nOwner toggle-off: every live context of the Agent is revoked');
  {
    const a = mint(dev.id, s1, 'toggle-1');
    const b = mint(dev.id, s2, 'toggle-2');
    writeJson(SHARES_PATH, sharesConfig(false));
    const r = sc.resolveSessionContext(a.token);
    assert(!r.ok && r.reason === 'revoked', 'share-from-turn off: revoked');
    assert(sc.contextRow(a.id).state === 'revoked' && sc.contextRow(b.id).state === 'revoked' && sc.contextRow(b.id).end_reason === 'owner_off', 'every live context of that Agent is durably revoked (owner_off)');
    assert(mint(dev.id, s1, 'toggle-3') === null, 'nothing new is minted while it is off');
    writeJson(SHARES_PATH, sharesConfig(true));
    assert(sc.resolveSessionContext(b.token).reason === 'revoked', 'turning it back on never revives a revoked context');
  }

  console.log('\nThe reserved principal: share-current only; reaches no Agent; refused in token configuration');
  {
    const serviceApi = jiti('./lib/service-api.ts');
    const ctxView = serviceApi.serviceContext(sc.SESSION_CONTEXT_PRINCIPAL);
    assert(!serviceApi.holds(ctxView, dev.id) && serviceApi.listServiceAgents(ctxView, { cursor: null, limit: 20 }).items.length === 0,
      'service:botmancers-session-context reaches no Agent through the service API (NOT-556: there are no grants to name it in)');
    const refusedToken = (() => {
      try { tokenAuth.parseServiceTokens(`botmancers-session-context=${digest('x')}`); return false; } catch (error) { return error instanceof tokenAuth.ServiceTokenConfigError && /reserved/.test(error.message); }
    })();
    assert(refusedToken, 'no service token may be configured as botmancers-session-context');
    const before = snapshot();
    const listAgents = await serviceOperations.listAgents(sc.SESSION_CONTEXT_PRINCIPAL, { cursor: null, limit: null });
    const explicit = await serviceOperations.createShare(sc.SESSION_CONTEXT_PRINCIPAL, s1, () => ({ audience, idempotency_key: 'reserved-explicit' }), null);
    const caps = await serviceOperations.capabilities(sc.SESSION_CONTEXT_PRINCIPAL);
    assert(listAgents.status === 403 && explicit.status === 403 && caps.status === 403
      && [listAgents, explicit, caps].every(res => res.body.error.code === 'principal_not_allowed'), 'serviceOperations other than share-current refuse it (principal_not_allowed), explicit create-share included');
    const live = mint(dev.id, s1, 'reserved-1');
    const rest = await agentsRoute.GET(new Request('http://127.0.0.1:3999/api/v0/agents', { headers: contextHeader(live.token) }));
    assert(rest.status === 401, 'a REST route other than /shares/current with only the context header: 401 (it authenticates nobody there)');
    const listed = await mcpPost(contextHeader(live.token), 'tools/list', {});
    assert(listed.status === 200 && same(listed.json.result.tools.map(tool => tool.name), [launch.SHARE_CURRENT_TOOL]), 'MCP tools/list for a context: exactly botmancers_share_current_session');
    const tool = listed.json.result.tools[0];
    assert(tool.inputSchema.additionalProperties === false && !Object.keys(tool.inputSchema.properties).includes('session_ref')
      && same(Object.keys(tool.inputSchema.properties).sort(), ['agent_id', 'audience', 'idempotency_key', 'max_turns', 'ttl_seconds']) && /never name it/.test(tool.description),
      'the tool is self-describing: no session selector in its closed input schema');
    const init = await mcpPost(contextHeader(live.token), 'initialize', { protocolVersion: '2025-06-18' });
    assert(init.json.result.instructions.includes(launch.SHARE_CURRENT_TOOL) && !init.json.result.instructions.includes('botmancers_list_agents'), 'initialize instructions name only share-current');
    for (const other of ['botmancers_list_agents', 'botmancers_create_share', 'botmancers_capabilities', 'botmancers_start_task', 'botmancers_get_share']) {
      const res = await mcpPost(contextHeader(live.token), 'tools/call', { name: other, arguments: {} });
      assert(res.json.error && res.json.error.code === -32602 && !res.json.result, `MCP ${other} with a context: unknown tool, nothing runs`);
    }
    const serviceList = await mcpPost({ authorization: `Bearer ${GROK_TOKEN}` }, 'tools/list', {});
    assert(!serviceList.json.result.tools.some(t => t.name === launch.SHARE_CURRENT_TOOL), 'a service principal\'s tools/list never shows share-current');
    assert(same(before, snapshot()), 'none of it wrote a share, event, or pin');
  }

  console.log('\n§2 error matrix over REST and MCP (no share, event, or pin written; audited)');
  {
    const liveFor = key => mint(dev.id, s1, `matrix-${key}`);
    const ended = mint(dev.id, s1, 'matrix-ended');
    sc.endSessionLaunch(launchOf('matrix-ended'), 'thread_unload');
    const revoked = mint(dev.id, s1, 'matrix-revoked');
    sc.revokeSessionContext(revoked.id);
    const gonCtx = mint(dev.id, gone, 'matrix-gone');
    fake.mutateFakeProvider(STATE, state => { state.sessions['gone-1-SECRET'].deleted = true; });
    await ps.refreshProviderSession(db, dev.id, gone);
    const a = liveFor('a');
    const b = liveFor('b');
    const rows = [
      ['missing header', {}, {}, 409, 'session_context_required', 'missing', { mcpHeaders: contextHeader('') }],
      ['two values', contextHeader(`${a.token}, ${b.token}`), {}, 409, 'session_context_required', 'ambiguous'],
      ['a provider UUID', contextHeader('0b9e3c1a-1111-4222-8333-944455556666'), {}, 409, 'session_context_required', 'unsupported'],
      ['a Cursor chat id', contextHeader('chat_01HZXYSECRET'), {}, 409, 'session_context_required', 'unsupported'],
      ['well-formed, never minted', contextHeader(`bmsc_${'B'.repeat(43)}`), {}, 409, 'session_context_required', 'unknown'],
      ['the launch ended', contextHeader(ended.token), {}, 409, 'session_context_required', 'stale'],
      ['revoked', contextHeader(revoked.token), {}, 409, 'session_context_required', 'revoked'],
      ['agent_id of another Agent', contextHeader(a.token), { agent_id: otherAgent.id }, 404, 'session_not_found', null],
      ['session_ref as well', contextHeader(a.token), { session_ref: s2 }, 400, 'invalid_request', null],
      ['an unknown field', contextHeader(a.token), { unexpected: 1 }, 400, 'invalid_request', null, { mcpCode: 'unsupported_field' }],
      ['a service token', { authorization: `Bearer ${GROK_TOKEN}` }, {}, 400, 'invalid_request', null],
      ['a service token with a context too', { authorization: `Bearer ${GROK_TOKEN}`, ...contextHeader(a.token) }, {}, 400, 'invalid_request', null],
      ['a session that can no longer take an Ask', contextHeader(gonCtx.token), {}, null, ['session_missing', 'session_ended', 'session_not_resumable'], null],
    ];
    for (const field of ['provider_session_id', 'external_session_id', 'claude_session_id', 'codex_thread_id', 'cursor_chat_id', 'cwd', 'workspace',
      'latest', 'most_recent', 'title', 'title_match', 'active_since']) {
      rows.push([`selector ${field}`, contextHeader(a.token), { [field]: 'x' }, 403, 'authority_not_allowed', null]);
    }
    for (const [label, headers, extra, status, code, reason, options = {}] of rows) {
      const body = { audience, idempotency_key: `m-${label.replace(/\W+/g, '-')}`, ...extra };
      const before = snapshot();
      const auditBefore = audits();
      const rest = await restCurrent(headers, body);
      const codes = Array.isArray(code) ? code : [code];
      const restOk = (status === null || rest.status === status) && codes.includes(rest.body.error && rest.body.error.code)
        && (reason === null ? !('reason' in rest.body.error) : rest.body.error.reason === reason)
        && (code !== 'session_context_required' || rest.body.error.recovery === 'choose_session');
      const restAudit = audits() - auditBefore === 1 && lastAudit().operation === 'shares.create' && ['denied', 'rejected'].includes(lastAudit().outcome);
      const mcp = await mcpShare(options.mcpHeaders || headers, body);
      const mcpCode = options.mcpCode || (code === 'invalid_request' ? 'invalid_arguments' : null);
      const mcpOk = mcp.isError && (mcpCode ? mcp.structured.error.code === mcpCode : codes.includes(mcp.structured.error.code))
        && (reason === null ? !('reason' in mcp.structured.error) : mcp.structured.error.reason === reason);
      const leaked = [...issued].some(token => rest.text === token || JSON.stringify(rest.body).includes(token) || mcp.text.includes(token))
        || /SECRET|0b9e3c1a/.test(JSON.stringify(rest.body) + mcp.text);
      assert(restOk && mcpOk && restAudit && same(before, snapshot()) && !leaked,
        `${label}: REST ${rest.status} ${rest.body.error && rest.body.error.code}${reason ? `/${reason}` : ''}, MCP ${mcp.structured && mcp.structured.error && mcp.structured.error.code}; audited, nothing written, nothing echoed`);
    }
  }

  console.log('\nSuccess: the same NOT-515 share and audit rows, exact session, replay');
  {
    const ctx = mint(dev.id, s2, 'success-1');
    const before = snapshot();
    const auditBefore = audits();
    const created = await restCurrent(contextHeader(ctx.token), { audience, ttl_seconds: 3600, idempotency_key: 'current-0001' });
    const share = created.body.share;
    assert(created.status === 201 && share.session_ref === s2 && share.agent_id === dev.id && share.authority === 'ask' && share.state === 'active' && share.created_via === 'current_session',
      'POST /api/v0/shares/current -> 201: exactly its bound session_ref, ask-only, created_via current_session');
    const after = snapshot();
    assert(after.shares - before.shares === 1 && after.events - before.events === 1 && after.pins - before.pins === 1 && after.pinTurns === before.pinTurns,
      'one share row, one created event, one ask pin (the NOT-515 rows); nothing dispatched');
    const row = db.prepare('SELECT * FROM session_shares WHERE id = ?').get(share.share_ref);
    const pin = db.prepare('SELECT * FROM session_pins WHERE id = ?').get(row.pin_ref);
    assert(row.creator_id === 'botmancers-session-context' && row.created_via === 'current_session' && pin.requester_id === 'botmancers-session-share' && pin.session_ref === s2 && pin.action === 'ask',
      'the share is the NOT-515 one: an exact ask pin on session_ref by the share principal, created by the session-context principal');
    const audit = lastAudit();
    assert(audits() - auditBefore === 1 && audit.principal === 'service:botmancers-session-context' && audit.operation === 'shares.create' && audit.capability === 'shares:current'
      && audit.outcome === 'allowed' && audit.target_kind === 'session' && audit.target_ref === s2 && audit.agent_id === dev.id, 'one shares.create audit row, allowed, on the session and its Agent');
    const replay = await restCurrent(contextHeader(ctx.token), { audience, ttl_seconds: 3600, idempotency_key: 'current-0001' });
    assert(replay.status === 200 && replay.body.replayed === true && replay.body.share.share_ref === share.share_ref && same(after, snapshot()), 'the exact replay -> 200, the same share, nothing written');
    const conflict = await restCurrent(contextHeader(ctx.token), { audience, ttl_seconds: 600, idempotency_key: 'current-0001' });
    assert(conflict.status === 409 && conflict.body.error.code === 'idempotency_conflict', 'the same key with another body -> 409 idempotency_conflict');
    const otherSession = mint(dev.id, s1, 'success-2');
    const separate = await restCurrent(contextHeader(otherSession.token), { audience, ttl_seconds: 3600, idempotency_key: 'current-0001' });
    assert(separate.status === 201 && separate.body.share.session_ref === s1, 'the same key from a context of another session is that session\'s own share (keys are scoped per session)');
    const viaMcp = await mcpShare(contextHeader(otherSession.token), { audience, idempotency_key: 'current-mcp-1', max_turns: 5 });
    assert(!viaMcp.isError && viaMcp.structured.contract === 'botmancers.mcp.v2' && viaMcp.structured.share.session_ref === s1 && viaMcp.structured.share.max_turns === 5
      && viaMcp.structured.share.created_via === 'current_session', 'botmancers_share_current_session over /api/v0/mcp creates the same share shape');
    const sameShare = await serviceOperations.getShare(grok, viaMcp.structured.share.share_ref);
    assert(sameShare.status === 404, 'another principal cannot read it (NOT-515 visibility)');
    const offList = await restCurrent(contextHeader(otherSession.token), { audience: { ...audience, channel_id: 'C0NOTLIST' }, idempotency_key: 'current-off' });
    assert(offList.status === 403 && offList.body.error.code === 'audience_not_allowed', 'an audience off the owner allowlist -> audience_not_allowed');
  }

  console.log('\nClaude Code: per-turn 0600 --mcp-config, the exact allowed tool, the value only in the turn env');
  {
    const plain = claude.claudeTurnArgs('read_only', { sessionId: 'S' });
    const withMcp = claude.claudeTurnArgs('read_only', { sessionId: 'S' }, '/tmp/x.mcp.json');
    const allowed = args => args[args.indexOf('--allowedTools') + 1].split(',');
    assert(!plain.includes('--mcp-config') && !allowed(plain).some(t => t.startsWith('mcp__')), 'without a context: no --mcp-config and no MCP tool allowed (unchanged)');
    assert(withMcp[withMcp.indexOf('--mcp-config') + 1] === '/tmp/x.mcp.json' && withMcp.includes('--strict-mcp-config')
      && same(allowed(withMcp).filter(t => t.startsWith('mcp__')), ['mcp__botmancers__botmancers_share_current_session'])
      && same(withMcp[withMcp.indexOf('--tools') + 1], plain[plain.indexOf('--tools') + 1]), 'with a context: --mcp-config, --strict-mcp-config, exactly the share-current tool allowed, built-in tools unchanged');
    const started = await ps.startProviderSession(db, claudeDev.id, { workspace: WS, prompt: '[hold] share this', authority: 'read_only', idempotencyKey: 'claude-1', requester: owner });
    const call = readLines(CLAUDE.calls).pop();
    const requests = readLines(CLAUDE.mcp);
    const request = requests.pop();
    const token = track(request && request.headers[launch.SESSION_CONTEXT_HEADER]);
    assert(request && request.server === 'botmancers' && request.type === 'http' && request.url === 'http://127.0.0.1:3999/api/v0/mcp' && request.mode === 0o600 && TOKEN_SHAPE.test(token),
      'the turn\'s MCP client reads a 0600 config with one http entry at Botmancers\' /api/v0/mcp and sends a minted bmsc_ header');
    assert(call.env.session_context_present === true && !call.argv.some(arg => arg.includes(token)) && !JSON.stringify(call.argv).includes('bmsc_'), 'the value is in the turn environment, never argv');
    const configFile = call.argv[call.argv.indexOf('--mcp-config') + 1];
    const configText = fs.readFileSync(configFile, 'utf8');
    assert((fs.statSync(configFile).mode & 0o777) === 0o600 && configText.includes('${BOTMANCERS_SESSION_CONTEXT}') && !configText.includes('bmsc_'), 'the config file is 0600 and holds the ${ENV} reference, not the value');
    assert(token !== process.env.BOTMANCERS_SESSION_CONTEXT, 'the ambient BOTMANCERS_SESSION_CONTEXT of the Botmancers process is not what the turn got');
    await sleep(100);
    const shared = await mcpShare(contextHeader(token), { audience, idempotency_key: 'claude-share-1' });
    assert(!shared.isError && shared.structured.share.session_ref === started.turn.session_ref && shared.structured.share.agent_id === claudeDev.id,
      'share-current from the running Claude turn shares exactly the session Botmancers started');
    await ps.cancelProviderTurn(db, claudeDev.id, started.turn.turn_ref);
    const afterTurn = sc.resolveSessionContext(token);
    assert(!afterTurn.ok && afterTurn.reason === 'stale' && ctxRow(token).end_reason === 'turn_end', 'the turn process ended: its context is stale (ended turn_end)');
    assert(!fs.existsSync(configFile), 'the turn\'s MCP config is removed with the turn');
    const resumed = await ps.sendProviderTurn(db, claudeDev.id, started.turn.session_ref, { prompt: 'and again', authority: 'read_only', idempotencyKey: 'claude-2', requester: owner });
    const next = track(readLines(CLAUDE.mcp).pop().headers[launch.SESSION_CONTEXT_HEADER]);
    assert(TOKEN_SHAPE.test(next) && next !== token && ctxRow(next).session_ref === started.turn.session_ref, 'an exact resume is a new turn process with a new context for the same session');
    await ps.observeProviderTurn(db, claudeDev.id, resumed.turn.turn_ref);
    assert(sc.resolveSessionContext(next).reason === 'stale', 'once that turn finishes, its context is stale too');
    const offStart = await ps.startProviderSession(db, claudeOff.id, { workspace: WS, prompt: 'no sharing here', authority: 'read_only', idempotencyKey: 'claude-off-1', requester: owner });
    await ps.observeProviderTurn(db, claudeOff.id, offStart.turn.turn_ref);
    const offCall = readLines(CLAUDE.calls).pop();
    assert(!offCall.argv.includes('--mcp-config') && offCall.env.session_context_present === false && count('SELECT COUNT(*) AS n FROM session_contexts WHERE agent_id = ?', claudeOff.id) === 0,
      'share-from-turn off: no --mcp-config, no context env (the ambient one stripped), nothing minted');
    const turnFiles = fs.readdirSync(path.join(CLAUDE.state, 'turns')).map(name => fs.readFileSync(path.join(CLAUDE.state, 'turns', name), 'utf8')).join('\n');
    assert(!turnFiles.includes('bmsc_'), 'the turn records, stream logs, and stderr logs never hold a context');
  }

  console.log('\nCodex app-server: one context per thread load, none on a resume of a loaded thread');
  {
    const startA = await ps.startProviderSession(db, codexDev.id, { workspace: WS, prompt: '[hold] thread A', authority: 'read_only', idempotencyKey: 'codex-a', requester: owner });
    const startB = await ps.startProviderSession(db, codexDev.id, { workspace: WS, prompt: '[hold] thread B', authority: 'read_only', idempotencyKey: 'codex-b', requester: owner });
    const starts = codexCalls(CODEX.main, 'thread/start');
    const tokenA = track(configToken(starts[0]));
    const tokenB = track(configToken(starts[1]));
    assert(TOKEN_SHAPE.test(tokenA) && TOKEN_SHAPE.test(tokenB) && tokenA !== tokenB && starts[0].params.config.mcp_servers.botmancers.url === 'http://127.0.0.1:3999/api/v0/mcp',
      'two thread/start loads on one app-server each carry their own config.mcp_servers.botmancers context');
    const entry = starts[0].params.config.mcp_servers.botmancers;
    assert(same(Object.keys(starts[0].params.config.mcp_servers), ['botmancers']) && same(entry.enabled_tools, [launch.SHARE_CURRENT_TOOL])
      && same(entry.tools, { [launch.SHARE_CURRENT_TOOL]: { approval_mode: 'approve' } }) && same(Object.keys(entry.http_headers), [launch.SESSION_CONTEXT_HEADER]),
    'the entry enables exactly the share-current tool and pre-approves only it (turns run with approvalPolicy never)');
    const rA = sc.resolveSessionContext(tokenA);
    const rB = sc.resolveSessionContext(tokenB);
    assert(rA.ok && rB.ok && rA.sessionRef === startA.turn.session_ref && rB.sessionRef === startB.turn.session_ref && rA.sessionRef !== rB.sessionRef,
      'each context resolves to exactly its own thread\'s session_ref');
    const shareA = await mcpShare(contextHeader(tokenA), { audience, idempotency_key: 'codex-share-a' });
    assert(!shareA.isError && shareA.structured.share.session_ref === startA.turn.session_ref, 'share-current from thread A shares thread A');
    await ps.cancelProviderTurn(db, codexDev.id, startA.turn.turn_ref);
    assert(sc.resolveSessionContext(tokenA).ok, 'the turn ended but the thread stays loaded: the load-scoped context is still valid (15-minute rule)');
    const resumesBefore = codexCalls(CODEX.main, 'thread/resume').length;
    const contextsBefore = count('SELECT COUNT(*) AS n FROM session_contexts WHERE agent_id = ?', codexDev.id);
    const again = await ps.sendProviderTurn(db, codexDev.id, startA.turn.session_ref, { prompt: 'second turn on A', authority: 'read_only', idempotencyKey: 'codex-a2', requester: owner });
    const resume = codexCalls(CODEX.main, 'thread/resume')[resumesBefore];
    assert(resume && !('config' in resume.params) && count('SELECT COUNT(*) AS n FROM session_contexts WHERE agent_id = ?', codexDev.id) === contextsBefore,
      'a resume of an already loaded thread sends no config and mints nothing (Codex keeps the load\'s MCP client)');
    assert(sc.resolveSessionContext(tokenA).ok, 'the load\'s context remains the one for that thread');
    await ps.observeProviderTurn(db, codexDev.id, again.turn.turn_ref);
    const unload = await ps.sendProviderTurn(db, codexDev.id, startA.turn.session_ref, { prompt: 'finish [unload]', authority: 'read_only', idempotencyKey: 'codex-a3', requester: owner });
    await ps.observeProviderTurn(db, codexDev.id, unload.turn.turn_ref);
    await sleep(50);
    assert(sc.resolveSessionContext(tokenA).reason === 'stale' && ctxRow(tokenA).end_reason === 'thread_unload', 'thread/closed (the thread unloaded): stale (ended thread_unload)');
    const reload = await ps.sendProviderTurn(db, codexDev.id, startA.turn.session_ref, { prompt: '[hold] after unload', authority: 'read_only', idempotencyKey: 'codex-a4', requester: owner });
    const reloadToken = track(configToken(codexCalls(CODEX.main, 'thread/resume').pop()));
    assert(TOKEN_SHAPE.test(reloadToken) && reloadToken !== tokenA && sc.resolveSessionContext(reloadToken).sessionRef === startA.turn.session_ref,
      'the next resume loads the thread again with a new context');
    await ps.cancelProviderTurn(db, codexDev.id, startB.turn.turn_ref);
    await ps.cancelProviderTurn(db, codexDev.id, reload.turn.turn_ref);
    assert(sc.resolveSessionContext(tokenB).ok, 'thread B\'s turn ended; its load is still live');
    codexMain.shutdown();
    await sleep(50);
    assert(sc.resolveSessionContext(tokenB).reason === 'stale' && ctxRow(tokenB).end_reason === 'app_server_exit'
      && sc.resolveSessionContext(reloadToken).reason === 'stale', 'the app-server exited: every thread it loaded is unloaded and its context stale');
    codexMain = codexRuntime(CODEX.main);
    registerCodex();
    const restartTurn = await ps.sendProviderTurn(db, codexDev.id, startB.turn.session_ref, { prompt: 'after restart', authority: 'read_only', idempotencyKey: 'codex-b2', requester: owner });
    const restartToken = track(configToken(codexCalls(CODEX.main, 'thread/resume').pop()));
    assert(TOKEN_SHAPE.test(restartToken) && restartToken !== tokenB && sc.resolveSessionContext(restartToken).sessionRef === startB.turn.session_ref,
      'a new app-server: the first thread/resume carries a new context for exactly that session');
    await ps.observeProviderTurn(db, codexDev.id, restartTurn.turn.turn_ref);
    sc.simulateSessionContextRestart();
    assert(sc.resolveSessionContext(restartToken).reason === 'stale', 'a Botmancers restart ends every app-server-bound context');
  }

  console.log('\nCodex exec fallback: -c mcp_servers.botmancers.*, the value in the run environment');
  {
    const started = await ps.startProviderSession(db, execDev.id, { workspace: WS, prompt: '[hold] exec share', authority: 'read_only', idempotencyKey: 'exec-1', requester: owner });
    const call = codexCalls(CODEX.exec, 'exec').pop();
    const token = track(call.params.contextEnv);
    const args = call.params.args;
    assert(args.includes('mcp_servers.botmancers.url="http://127.0.0.1:3999/api/v0/mcp"')
      && args.includes('mcp_servers.botmancers.env_http_headers={ "Botmancers-Session-Context" = "BOTMANCERS_SESSION_CONTEXT_TOKEN" }'),
    'exec runs with -c mcp_servers.botmancers.url and env_http_headers naming the environment variable');
    assert(args.includes('mcp_servers.botmancers.enabled_tools=["botmancers_share_current_session"]')
      && args.includes('mcp_servers.botmancers.tools.botmancers_share_current_session.approval_mode="approve"'), 'and enables and pre-approves exactly the share-current tool');
    assert(TOKEN_SHAPE.test(token) && !JSON.stringify(args).includes('bmsc_'), 'the context is in the run environment, never argv');
    const shared = await mcpShare(contextHeader(token), { audience, idempotency_key: 'exec-share-1' });
    assert(!shared.isError && shared.structured.share.session_ref === started.turn.session_ref, 'share-current from the exec run shares exactly its session');
    await ps.cancelProviderTurn(db, execDev.id, started.turn.turn_ref);
    assert(sc.resolveSessionContext(token).reason === 'stale', 'the exec process ended with its turn: stale');
    const runFiles = fs.readdirSync(CODEX.runs).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(CODEX.runs, name), 'utf8')).join('\n');
    assert(!runFiles.includes('bmsc_'), 'exec run records never hold a context');
  }

  console.log('\nCursor: no context, no MCP configuration written, session_context_required');
  {
    const tree = dir => {
      const out = {};
      const walk = d => { if (!fs.existsSync(d)) return; for (const name of fs.readdirSync(d)) { const p = path.join(d, name); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[p] = sha(fs.readFileSync(p, 'utf8')); } };
      walk(dir);
      return out;
    };
    const watched = () => ({ home: tree(path.join(HOME_DIR, '.cursor')), repo: tree(path.join(WS, '.cursor')), ws: fs.readdirSync(WS).sort() });
    const before = watched();
    const contextsBefore = count('SELECT COUNT(*) AS n FROM session_contexts');
    const started = await ps.startProviderSession(db, cursorDev.id, { workspace: WS, prompt: 'share this session', authority: 'read_only', idempotencyKey: 'cursor-1', requester: owner });
    await ps.observeProviderTurn(db, cursorDev.id, started.turn.turn_ref);
    const calls = readLines(path.join(CURSOR.fake, 'calls.jsonl'));
    assert(started.turn.session_ref && calls.length > 0 && calls.every(entry => entry.session_context_env === false) && !JSON.stringify(calls).includes('mcp'),
      'a Cursor launch gets no context in its environment or arguments');
    assert(count('SELECT COUNT(*) AS n FROM session_contexts') === contextsBefore, 'nothing is minted for a Cursor launch (share-from-turn on for the Agent)');
    assert(same(before, watched()) && !fs.existsSync(path.join(HOME_DIR, '.cursor', 'mcp.json')) && !fs.existsSync(path.join(WS, '.cursor', 'mcp.json')),
      'no global (~/.cursor/mcp.json) or repository (.cursor/mcp.json) MCP configuration is written');
    const res = await restCurrent({}, { audience, idempotency_key: 'cursor-share-1' });
    assert(res.status === 409 && res.body.error.code === 'session_context_required' && res.body.error.reason === 'missing', 'share-current from a Cursor turn: session_context_required (missing)');
  }

  console.log('\nThe secret on durable and visible surfaces');
  {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbFiles = fs.readdirSync(TMP).filter(name => name.startsWith('botmancers.db')).map(name => fs.readFileSync(path.join(TMP, name)));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    const dump = tables.map(name => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
    const found = [...issued].filter(token => dump.includes(token) || dbFiles.some(buf => buf.includes(Buffer.from(token))) || dump.includes(token.slice(5)));
    assert(issued.size > 10 && found.length === 0, `none of the ${issued.size} issued contexts is in any table or the database files (only SHA-256 digests)`);
    const auditDump = JSON.stringify(db.prepare('SELECT * FROM service_audit_events').all());
    assert(!auditDump.includes('bmsc_'), 'no audit row holds a context');
    assert(count("SELECT COUNT(*) AS n FROM session_contexts WHERE length(token_sha256) = 64") === count('SELECT COUNT(*) AS n FROM session_contexts'), 'every row holds a 64-hex digest');
  }
}
