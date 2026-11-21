#!/usr/bin/env node
// NOT-556 (was NOT-499's test-service-grants): service access to Agents,
// sessions, conversations, exchanges, pins, and shares with no owner grants
// layer (lib/service-api, lib/service-api-http, lib/mcp-bridge-v2,
// app/api/v0/**).
// Proves: with no grants file, and with a leftover invalid one (never read,
// never deleted), a configured service token reaches every registered
// Agent: capabilities reports mode granted with every Agent and the full
// capability list; it lists Agents, sessions, and conversations, sends to
// an active session, and creates Ask and Continue exchanges. The Agent's
// policy stays the gate for starting a session (no_eligible_session when
// new sessions are off, a read-only start when on with a default
// workspace) and for resume with edits (authority_not_allowed when the
// policy is off, approval_required without approve_write); the owner's
// allowlist stays the gate for share audiences (audience_not_allowed). A
// second service principal cannot read or cancel the first one's
// exchanges, pins, or shares; an unknown Agent is agent_not_found; a bad
// token is 401; the session-context principal sees no Agents. No view
// carries a provider session or run id, Deck, or working directory; every
// call appends a bounded audit event; idempotent replays survive a restart
// (a real second process). Handlers run in-process with the real
// service-token authenticator, a fake attempt adapter through the real
// leased dispatcher, and a fake session provider. Self-contained: isolated
// SQLite file and HOME, no network, no listening socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CHILD = process.env.ACCESS_SCENARIO === 'restart-child';
const DB_PATH = process.env.ACCESS_DB || path.join(os.tmpdir(), `botmancers-access-${process.pid}.db`);
if (!CHILD) for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
process.env.ACCESS_DB = DB_PATH;
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
if (!process.env.ACCESS_HOME) process.env.ACCESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-access-home-'));
process.env.HOME = process.env.ACCESS_HOME;
process.env.BOTMANCERS_HOME = path.join(process.env.ACCESS_HOME, '.botmancers');
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';
// Where earlier releases read the owner's grants document. Nothing reads it now.
const LEFTOVER_GRANTS_PATH = path.join(process.env.BOTMANCERS_HOME, 'config', 'service-grants.json');
// NOT-515: the owner's session-share allowlist (lib/session-shares).
const SHARES_PATH = path.join(process.env.ACCESS_HOME, 'config', 'session-shares.json');
const STATE = path.join(process.env.ACCESS_HOME, 'provider.json');
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;

const TOKENS = { grok: 'tok-grok-bot-SECRET-aaaa', ci: 'tok-ci-bot-SECRET-bbbb', other: 'tok-other-SECRET-cccc' };
const digest = token => `sha256:${createHash('sha256').update(token).digest('hex')}`;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(TOKENS.grok)},ci-bot=${digest(TOKENS.ci)},other-bot=${digest(TOKENS.other)}`;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const capabilitiesLib = jiti('./lib/service-grants.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const mcp = jiti('./lib/mcp-bridge-v2.ts');
const { SESSION_CONTEXT_PRINCIPAL } = jiti('./lib/session-context.ts');
const fake = require('./test-support/fake-session-provider');
const http = jiti('./lib/service-api-http.ts');
const agentApi = jiti('./lib/agent-api.ts');

const raw = dbModule.default;
const { engine, bots, conversations, serviceAudit, UI_OWNER_PRINCIPAL: OWNER } = dbModule;

const SECRETS = {
  codex: 'prov-codex-SECRET-1111',
  codexOld: 'prov-codex-OLD-2222',
  codexEnded: 'prov-codex-ENDED-3333',
  codexForeign: 'prov-codex-FOREIGN-4444',
  grok: 'prov-grok-SECRET-5555',
  claude: 'prov-claude-SECRET-6666',
  grokFresh: 'prov-grok-FRESH-7777',
  run: 'run-codex-RUNID-8888',
  grokEcho: 'prov-grok-ECHO-9999',
};
const WORKDIR = '/Users/someone/private-workdir-SECRET';
const PROMPT_MARK = 'PROMPT-BODY-MARK-9f3';
const CREDENTIAL = process.env.HERMES_API_SERVER_KEY;
const leaks = text => [...Object.values(SECRETS), ...Object.values(TOKENS), WORKDIR, 'deck-builder', 'private-workdir', CREDENTIAL].filter(id => text.includes(id));

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(5);
  }
  assert(false, `timed out waiting: ${label}`);
  return false;
}
const one = (sql, ...args) => raw.prepare(sql).get(...args);
const count = (sql, ...args) => one(sql, ...args).n;
const rowCounts = () => ({
  exchanges: count('SELECT COUNT(*) AS n FROM session_exchanges'),
  requests: count('SELECT COUNT(*) AS n FROM work_requests'),
  messages: count('SELECT COUNT(*) AS n FROM messages'),
  conversations: count('SELECT COUNT(*) AS n FROM conversations'),
  attempts: count('SELECT COUNT(*) AS n FROM work_attempts'),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------
// Fake attempt adapter (as test-agent-exchanges): records launches.
const calls = [];
let script = () => ({ output: 'ok' });
let gate = null;
function hopKind(input) {
  const text = input.prompt.kind === 'conversation' ? input.prompt.history.map(entry => entry.content).join('\n') : input.prompt.text;
  if (text.includes('[Session Ask')) return 'ask';
  if (text.includes('[Session Continue handoff')) return 'extract';
  if (text.includes('[Session Continue]')) return 'deliver';
  return 'other';
}
function installAdapter() {
  dispatch.setAttemptAdapterOverride(() => ({
    name: 'hermes-gateway',
    async run(input, onEvent) {
      const kind = hopKind(input);
      calls.push({ kind, agentId: input.target.agentId, input, requestId: input.correlation.requestId });
      const started = Date.now();
      onEvent({ type: 'started', adapter: 'hermes-gateway', at: started, externalRunId: null, externalSessionId: null });
      if (gate) await gate.promise;
      const out = script(input, kind);
      return {
        status: 'completed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: out.session ?? null,
        output: out.output, artifacts: [], startedAt: started, finishedAt: Date.now(), failure: null,
      };
    },
  }));
}
function holdAdapter() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  gate = { promise, release: () => { gate = null; release(); } };
  return gate;
}

// ---------------------------------------------------------------------
// HTTP helpers: the real handlers, a standard Request, the real
// service-token authenticator.
function req(method, url, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(`http://127.0.0.1${url}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}
async function call(handler, method, url, options, ...args) {
  const response = await handler(req(method, url, options), ...args);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}
const api = {
  capabilities: token => call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', { token }),
  agents: (token, qs = '') => call(http.handleListAgents, 'GET', `/api/v0/agents${qs}`, { token }),
  agent: (token, id) => call(http.handleGetAgent, 'GET', `/api/v0/agents/${id}`, { token }, id),
  sessions: (token, id, qs = '') => call(http.handleListSessions, 'GET', `/api/v0/agents/${id}/sessions${qs}`, { token }, id),
  session: (token, id, ref) => call(http.handleGetSession, 'GET', `/api/v0/agents/${id}/sessions/${ref}`, { token }, id, ref),
  conversations: (token, id, qs = '') => call(http.handleListConversations, 'GET', `/api/v0/agents/${id}/conversations${qs}`, { token }, id),
  conversation: (token, id, cid, qs = '') => call(http.handleGetConversation, 'GET', `/api/v0/agents/${id}/conversations/${cid}${qs}`, { token }, id, cid),
  message: (token, ref, body, headers) => call(http.handleSendSessionMessage, 'POST', `/api/v0/sessions/${ref}/messages`, { token, body, headers }, ref),
  exchanges: (token, qs = '') => call(http.handleListExchanges, 'GET', `/api/v0/exchanges${qs}`, { token }),
  createExchange: (token, body) => call(http.handleCreateExchange, 'POST', '/api/v0/exchanges', { token, body }),
  exchange: (token, id) => call(http.handleGetExchange, 'GET', `/api/v0/exchanges/${id}`, { token }, id),
  cancel: (token, id, body) => call(http.handleCancelExchange, 'POST', `/api/v0/exchanges/${id}/cancel`, { token, body }, id),
  narrowRequest: (token, id) => call(agentApi.handleGetAgentRequest, 'GET', `/api/v0/requests/${id}`, { token }, id),
  narrowConversation: (token, id) => call(agentApi.handleGetConversation, 'GET', `/api/v0/conversations/${id}`, { token }, id),
  narrowSend: (token, agentId, body) => call(agentApi.handleSendAgentMessage, 'POST', `/api/v0/agents/${agentId}/messages`, { token, body }, agentId),
};

const ALL_CAPABILITIES = [...capabilitiesLib.SERVICE_CAPABILITIES];
const mcpCall = async (principal, name, args) => {
  try {
    return { data: await mcp.callMcpV2Tool(principal, name, args, { v1Operations: [] }) };
  } catch (error) {
    if (error instanceof mcp.McpV2Error) return { error: mcp.mcpV2ErrorBody(error).error };
    throw error;
  }
};

// ---------------------------------------------------------------------
// Fixture: three Agents (Codex, Grok, Claude) on a deck. Codex has two
// active sessions, one ended, one under another runtime; Grok and Claude
// one each. Launch snapshots record a Deck and a working directory that no
// view may show.
function agent(name) {
  return bots.getAll().find(bot => bot.name === name)
    || bots.create({ name, title: `${name} agent`, description: `${name} fixture`, agent: 'hermes', deck_id: 'deck-builder' });
}
let seedClock = Date.now() - 1_000_000;
function seedSession(bot, secret, { adapter = 'hermes', key, end = false } = {}) {
  const conv = conversations.getByBotId(bot.id);
  const now = (seedClock += 1000);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: `seed-${key}`, requester: OWNER, targetAgentId: bot.id,
    intent: `Implement ${key} feature`, executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: `seed-${key}`, now,
  });
  engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running', now });
  const attempt = engine.createAttempt(request.id, {
    kind: 'launch', adapter, toolProfile: 'edit',
    launchSnapshot: { transport: 'hermes-gateway', cwd: WORKDIR, deck: 'deck-builder' }, now,
  });
  if (key === 'codex-a') engine.recordAttemptExternalIds(attempt.id, { externalRunId: SECRETS.run });
  engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', externalSessionId: secret, now });
  const binding = engine.bindSession({ agentId: bot.id, adapter, externalSessionId: secret, conversationId: conv.id, requestId: request.id, sourceAttemptId: attempt.id, now });
  engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null }, now });
  if (end) engine.bindSession({ agentId: bot.id, adapter, externalSessionId: `${secret}-next`, conversationId: conv.id, requestId: request.id, now: now + 1 });
  return { binding, request, conv };
}

function fixture() {
  const codex = agent('Codex');
  const grok = agent('Grok');
  const claude = agent('Claude');
  return { codex, grok, claude };
}

// ---------------------------------------------------------------------
// Restart child: a fresh process over the same database.
async function restartChild() {
  installAdapter();
  const ids = JSON.parse(process.env.ACCESS_IDS);
  service.configureDispatcher({ owner: `access-restart-child:${process.pid}` });
  await service.recoverCoordinatorLoops();
  const before = rowCounts();
  const replayExchange = await api.createExchange(TOKENS.grok, ids.exchangeBody);
  const replayMessage = await api.message(TOKENS.grok, ids.sessionRef, ids.messageBody);
  const detail = await api.exchange(TOKENS.grok, ids.exchangeId);
  const denied = await api.exchange(TOKENS.ci, ids.exchangeId);
  await service.waitForAgentDispatchIdle();
  process.stdout.write(JSON.stringify({ before, after: rowCounts(), replayExchange, replayMessage, detail, denied, calls: calls.length }));
}

async function main() {
  installAdapter();
  service.configureDispatcher({ owner: `access-test:${process.pid}`, config: { maxGlobal: 10, maxPerTarget: 1, heartbeatMs: 600_000 } });
  const agents = fixture();
  const { codex, grok, claude } = agents;
  const codexA = seedSession(codex, SECRETS.codex, { key: 'codex-a' });
  const codexEnded = seedSession(codex, SECRETS.codexEnded, { key: 'codex-ended', end: true });
  const codexOther = seedSession(codex, SECRETS.codexOld, { key: 'codex-other-runtime', adapter: 'codex' });
  const grokS = seedSession(grok, SECRETS.grok, { key: 'grok' });
  const claudeS = seedSession(claude, SECRETS.claude, { key: 'claude' });
  // The ended seed bound a replacement: Codex's newest active binding.
  const codexB = { binding: one('SELECT * FROM session_bindings WHERE external_session_id = ?', `${SECRETS.codexEnded}-next`) };
  // A transcript line that echoes a provider session id and a run id.
  dbModule.messages.create(codexA.conv.id, 'bot', `Resumed ${SECRETS.codex} under ${SECRETS.run}; continuing.`, codex.id);
  // A transcript line that echoes the working directory, the Deck, and a credential.
  dbModule.messages.create(codexA.conv.id, 'bot', `Working in ${WORKDIR}/src with deck-builder, key ${CREDENTIAL}.`, codex.id);
  // A group with Codex and Claude: never fully granted to either service.
  const groupId = 'group-codex-claude';
  raw.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Pair', Date.now());
  const groupConv = 'conv-group-pair';
  raw.prepare("INSERT INTO conversations (id, type, group_id, origin_kind, origin_id, created_at) VALUES (?, 'group', ?, 'person', 'local-owner', ?)").run(groupConv, groupId, Date.now());
  for (const [kind, id] of [['person', OWNER.id], ['bot', codex.id], ['bot', claude.id]]) {
    raw.prepare('INSERT INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)').run(groupConv, kind, id, Date.now());
  }
  // Another service's conversation with Codex.
  const otherConv = 'conv-other-service';
  raw.prepare("INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, 'agent', 'service', 'other-bot', ?)").run(otherConv, Date.now());
  for (const [kind, id] of [['service', 'other-bot'], ['bot', codex.id]]) {
    raw.prepare('INSERT INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)').run(otherConv, kind, id, Date.now());
  }

  // -------------------------------------------------------------------
  console.log('\n[1] no grants layer: every configured token reaches every registered Agent');
  const allIds = [codex.id, grok.id, claude.id].sort();
  const ACCESS_CALLS = async token => {
    const caps = await api.capabilities(token);
    const list = await api.agents(token);
    const sess = await api.sessions(token, claude.id);
    const convs = await api.conversations(token, claude.id);
    return { caps, list, sess, convs };
  };
  {
    assert(!fs.existsSync(LEFTOVER_GRANTS_PATH), 'fixture: no grants file at the old path');
    const { caps, list, sess, convs } = await ACCESS_CALLS(TOKENS.grok);
    assert(list.status === 200 && same(list.json.items.map(a => a.agent_id).sort(), allIds)
      && list.json.items.every(a => same(a.capabilities, ALL_CAPABILITIES)),
    'absent grants file lists all Agents (each with the full capability list)');
    assert(caps.status === 200 && caps.json.mode === 'granted' && same(caps.json.agents.map(a => a.agent_id), allIds)
      && caps.json.agents.every(a => same(a.capabilities, ALL_CAPABILITIES)) && same(caps.json.vocabulary, ALL_CAPABILITIES),
    'capabilities reports every Agent: mode granted, every registered Agent, the full capability list');
    assert(sess.status === 200 && sess.json.items.some(s => s.ref === claudeS.binding.id) && convs.status === 200
      && convs.json.items.some(c => c.conversation_id === claudeS.conv.id),
    'absent grants file: a token lists any Agent\'s sessions and conversations');
    for (const token of [TOKENS.ci, TOKENS.other]) {
      const other = await api.agents(token);
      assert(other.status === 200 && same(other.json.items.map(a => a.agent_id).sort(), allIds), 'every configured service principal sees every Agent');
    }
    const mcpCaps = await mcpCall({ kind: 'service', id: 'grok-bot' }, 'botmancers_capabilities', {});
    const v2Tools = mcp.MCP_V2_TOOLS.map(t => t.name).filter(n => n !== 'botmancers_capabilities');
    const listed = new Set(mcpCaps.data.operations.map(op => op.tool));
    assert(mcpCaps.data.mode === 'granted' && same(mcpCaps.data.agents.map(a => a.agent_id), allIds)
      && v2Tools.filter(n => !['botmancers_share_current_session'].includes(n)).every(n => listed.has(n))
      && mcpCaps.data.operations.filter(op => op.tool === 'botmancers_list_sessions').every(op => same([...op.agent_ids].sort(), allIds)),
    'MCP capabilities: mode granted, every Agent, every v2 tool with all Agent ids');
    const mcpList = await mcpCall({ kind: 'service', id: 'grok-bot' }, 'botmancers_list_agents', {});
    assert(same(mcpList.data.items.map(a => a.agent_id).sort(), allIds), 'MCP botmancers_list_agents returns every Agent');

    // A leftover grants file from an earlier release: not owner-only, not
    // JSON, naming nothing. It is never read, never deleted, never an error.
    fs.mkdirSync(path.dirname(LEFTOVER_GRANTS_PATH), { recursive: true });
    fs.writeFileSync(LEFTOVER_GRANTS_PATH, '{ "version": 1, this is not json');
    fs.chmodSync(LEFTOVER_GRANTS_PATH, 0o644);
    const leftover = await ACCESS_CALLS(TOKENS.grok);
    const leftoverMcp = await mcpCall({ kind: 'service', id: 'grok-bot' }, 'botmancers_list_agents', {});
    assert(leftover.caps.status === 200 && leftover.caps.json.mode === 'granted' && same(leftover.caps.json.agents.map(a => a.agent_id), allIds)
      && leftover.list.status === 200 && same(leftover.list.json.items.map(a => a.agent_id).sort(), allIds)
      && leftover.sess.status === 200 && leftover.convs.status === 200 && same(leftoverMcp.data.items.map(a => a.agent_id).sort(), allIds)
      && ![leftover.caps, leftover.list, leftover.sess, leftover.convs].some(r => r.text.includes('grants_unavailable')),
    'leftover grants file is ignored: the same calls succeed, no grants_unavailable');
    assert(fs.existsSync(LEFTOVER_GRANTS_PATH) && fs.readFileSync(LEFTOVER_GRANTS_PATH, 'utf8') === '{ "version": 1, this is not json'
      && (fs.statSync(LEFTOVER_GRANTS_PATH).mode & 0o777) === 0o644, 'leftover grants file is still on disk, unchanged');

    const missing = await api.agent(TOKENS.grok, 'no-such-agent');
    const missingSessions = await api.sessions(TOKENS.grok, 'no-such-agent');
    assert(missing.status === 404 && missing.json.error.code === 'agent_not_found' && missingSessions.json.error.code === 'agent_not_found',
      'an unknown Agent id answers agent_not_found');
    const unauth = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', { token: 'wrong-token' });
    const unauthList = await api.agents('tok-grok-bot-SECRET-aaab');
    const noAuth = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', {});
    assert(unauth.status === 401 && unauthList.status === 401 && noAuth.status === 401, 'a bad or missing token still answers 401');
    const ctxList = await http.serviceOperations.listAgents(SESSION_CONTEXT_PRINCIPAL, { cursor: null, limit: null });
    const ctxCaps = await http.serviceOperations.capabilities(SESSION_CONTEXT_PRINCIPAL);
    const ctxAgent = await http.serviceOperations.getAgent(SESSION_CONTEXT_PRINCIPAL, codex.id);
    const serviceApi = jiti('./lib/service-api.ts');
    const ctxInner = serviceApi.serviceContext(SESSION_CONTEXT_PRINCIPAL);
    const innerList = serviceApi.listServiceAgents(ctxInner, { cursor: null, limit: 20 });
    assert([ctxList, ctxCaps, ctxAgent].every(r => r.status === 403 && r.body.error.code === 'principal_not_allowed')
      && innerList.items.length === 0 && serviceApi.capabilitiesView(ctxInner).agents.length === 0 && !serviceApi.holds(ctxInner, codex.id),
    'the session-context principal cannot list Agents (refused at the boundary, and reaches no Agent underneath)');
    const { RESERVED_SERVICE_IDS, parseServiceTokens } = jiti('./lib/service-token-auth.ts');
    const engineReach = [];
    for (const id of RESERVED_SERVICE_IDS) {
      const ctx = serviceApi.serviceContext({ kind: 'service', id });
      if (serviceApi.holds(ctx, codex.id) || serviceApi.listServiceAgents(ctx, { cursor: null, limit: 20 }).items.length) engineReach.push(id);
      try { parseServiceTokens(`${id}=${digest('x')}`); engineReach.push(`${id} (token)`); } catch { /* refused, as it must be */ }
    }
    assert(engineReach.length === 0 && RESERVED_SERVICE_IDS.length === 4,
      `the engine-internal principals reach no Agent and no token can name one (${engineReach.join(',')})`);
    const relayPin = await http.serviceOperations.pinSession({ kind: 'service', id: 'botmancers-session-share' }, codexA.binding.id,
      () => ({ action: 'ask', idempotency_key: 'relay-direct' }), null);
    assert(relayPin.status === 404 && relayPin.body.error.code === 'session_not_found', 'the session-share principal cannot pin a session through the service API');
    const ownerCaps = await http.serviceOperations.capabilities(OWNER);
    assert(ownerCaps.status === 403 && ownerCaps.body.error.code === 'principal_not_allowed', 'a non-service principal is principal_not_allowed');

    script = () => ({ output: 'narrow reply' });
    const narrow = await api.narrowSend(TOKENS.grok, codex.id, { content: 'Start a fresh coordinator task', idempotencyKey: 'narrow-1' });
    assert(narrow.status === 202 && typeof narrow.json.requestId === 'string', 'the v1 narrow new-conversation route still accepts');
    await service.waitForAgentDispatchIdle();
    const narrowRead = await api.narrowConversation(TOKENS.grok, narrow.json.conversationId);
    assert(narrowRead.status === 200 && narrowRead.json.messages.length === 2, 'the service still reads the conversation it opened');
  }

  // -------------------------------------------------------------------
  console.log('\n[2] reads: every Agent, only safe metadata, caller-owned conversations');
  {
    const listA = await api.agents(TOKENS.grok);
    assert(listA.json.items.every((a, i, all) => i === 0 || all[i - 1].last_activity_at >= a.last_activity_at), 'Agents are newest activity first');
    const agentDetail = await api.agent(TOKENS.grok, codex.id);
    assert(agentDetail.status === 200 && agentDetail.json.runtime === 'hermes' && !('deck_id' in agentDetail.json) && leaks(agentDetail.text).length === 0,
      'Agent detail names the runtime kind, never the Deck selection');

    const page1 = await api.sessions(TOKENS.grok, codex.id, '?limit=2');
    const page2 = await api.sessions(TOKENS.grok, codex.id, `?limit=2&cursor=${page1.json.next_cursor}`);
    const all = await api.sessions(TOKENS.grok, codex.id, '?limit=100');
    const refs = all.json.items.map(s => s.ref);
    assert(all.json.items.length === 4 && all.json.next_cursor === null, 'all four Codex sessions are listed (active, ended, other runtime)');
    assert(same([...page1.json.items, ...page2.json.items].map(s => s.ref), refs) && page2.json.next_cursor === null, 'cursor pages concatenate to the full list without gaps or repeats');
    assert(all.json.items.every((s, i, list) => i === 0 || list[i - 1].last_activity_at > s.last_activity_at
      || (list[i - 1].last_activity_at === s.last_activity_at && list[i - 1].created_at >= s.created_at)), 'sessions are newest activity first');
    const again = await api.sessions(TOKENS.grok, codex.id, '?limit=2');
    assert(same(again.json, page1.json), 'the same query returns the same page and cursor (deterministic)');
    const active = await api.sessions(TOKENS.grok, codex.id, '?status=active&limit=100');
    assert(active.json.items.every(s => s.status === 'active') && active.json.items.some(s => s.ref === codexA.binding.id), 'status=active filters');
    const crossCursor = await api.sessions(TOKENS.grok, codex.id, `?status=active&cursor=${page1.json.next_cursor}`);
    const garbage = await api.sessions(TOKENS.grok, codex.id, '?cursor=not-a-cursor');
    const badLimit = await api.sessions(TOKENS.grok, codex.id, '?limit=1000');
    assert(crossCursor.json.error.code === 'invalid_request' && garbage.json.error.code === 'invalid_request' && badLimit.json.error.code === 'invalid_request',
      'a cursor from another list, a forged cursor, and an out-of-range limit are invalid_request');
    const sessText = all.text;
    assert(leaks(sessText).length === 0 && !/"context"|"workspace"|"cwd"|"deck"|external_session|external_run/.test(sessText),
      `no session view carries a provider id, Deck, or working directory (${leaks(sessText).join(',')})`);
    const detail = await api.session(TOKENS.grok, codex.id, codexA.binding.id);
    assert(detail.status === 200 && detail.json.ref === codexA.binding.id && Array.isArray(detail.json.attempts) && leaks(detail.text).length === 0, 'session detail is safe');
    const grokSessions = await api.sessions(TOKENS.grok, grok.id);
    assert(grokSessions.status === 200 && grokSessions.json.items.some(s => s.ref === grokS.binding.id), 'any Agent\'s sessions are listed');
    const viaOther = await api.session(TOKENS.grok, codex.id, claudeS.binding.id);
    const unknownRef = await api.session(TOKENS.grok, codex.id, 'no-such-ref');
    assert(viaOther.status === 404 && same(viaOther.json, unknownRef.json), 'another Agent\'s session is answered like a missing session');
    const bCodex = await api.sessions(TOKENS.ci, codex.id, '?limit=100');
    assert(bCodex.status === 200 && same(bCodex.json.items.map(s => s.ref), refs), 'a second service sees the same Codex sessions');

    const convs = await api.conversations(TOKENS.grok, codex.id);
    const ids = convs.json.items.map(c => c.conversation_id);
    assert(ids.includes(codexA.conv.id) && ids.includes(groupConv) && !ids.includes(otherConv),
      'Codex conversations include a group with another registered Agent and exclude another service\'s conversation');
    assert(convs.json.items.every((c, i, list) => i === 0 || list[i - 1].last_activity_at >= c.last_activity_at), 'conversations are newest activity first');
    const thread = await api.conversation(TOKENS.grok, codex.id, codexA.conv.id);
    assert(thread.status === 200 && thread.json.messages.some(m => m.content.includes('[redacted runtime id]')) && leaks(thread.text).length === 0,
      'a transcript that echoed a provider session id and run id is redacted');
    assert(thread.json.messages.some(m => m.content.startsWith('Working in [redacted]/src with [redacted], key [redacted].')),
      'a transcript that echoed the working directory, the Deck selection, and a credential is redacted');
    const groupRead = await api.conversation(TOKENS.grok, codex.id, groupConv);
    const missingConv = await api.conversation(TOKENS.grok, codex.id, 'no-such-conversation');
    const otherRead = await api.conversation(TOKENS.grok, codex.id, otherConv);
    assert(groupRead.status === 200 && missingConv.status === 404 && otherRead.status === 404 && same(otherRead.json, missingConv.json),
      'another service\'s conversation is answered exactly like a missing one');
    const otherOwn = await api.conversation(TOKENS.other, codex.id, otherConv);
    assert(otherOwn.status === 200, 'the service that owns that conversation reads it');
    const person = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', {});
    assert(person.status === 401, 'no principal, no access');
  }

  // -------------------------------------------------------------------
  console.log('\n[2b] shares: the owner\'s allowlist is the gate, no shares:create grant');
  {
    fs.mkdirSync(path.dirname(SHARES_PATH), { recursive: true });
    fs.writeFileSync(SHARES_PATH, JSON.stringify({ version: 1, audiences: [{ kind: 'slack', team_id: 'T0ACCESS1', channel_id: 'C0ACCESS1' }] }));
    fs.chmodSync(SHARES_PATH, 0o600);
    const audience = { kind: 'slack', team_id: 'T0ACCESS1', channel_id: 'C0ACCESS1' };
    const share = (token, ref, body = {}) => call(http.handleCreateShare, 'POST', `/api/v0/sessions/${encodeURIComponent(ref)}/shares`,
      { token, body: { audience, idempotency_key: `share-${ref.length}-${Object.keys(body).join('-') || 'x'}`, ...body } }, ref);
    const getShare = (token, ref) => call(http.handleGetShare, 'GET', `/api/v0/shares/${ref}`, { token }, ref);
    const listShares = token => call(http.handleListShares, 'GET', '/api/v0/shares', { token });
    const revoke = (token, ref) => call(http.handleRevokeShare, 'POST', `/api/v0/shares/${ref}/revoke`, { token, body: {} }, ref);
    assert(!fs.existsSync(LEFTOVER_GRANTS_PATH) || !/shares:create/.test(fs.readFileSync(LEFTOVER_GRANTS_PATH, 'utf8')), 'fixture: no shares:create grant anywhere');
    const offList = await share(TOKENS.grok, codexA.binding.id, { audience: { kind: 'slack', team_id: 'T0ACCESS1', channel_id: 'C0NOTLISTED' } });
    assert(offList.status === 403 && offList.json.error.code === 'audience_not_allowed', 'a channel not on the allowlist -> audience_not_allowed (403)');
    const created = await share(TOKENS.grok, codexA.binding.id);
    assert(created.status === 201 && created.json.share.session_ref === codexA.binding.id && created.json.share.authority === 'ask',
      'a channel on the allowlist -> 201, ask only, with no shares:create grant');
    const missing = await share(TOKENS.grok, 'no-such-session');
    const wrongAgent = await share(TOKENS.grok, codexA.binding.id, { agent_id: grok.id });
    const malformed = await share(TOKENS.grok, '%00../x');
    assert(missing.status === 404 && missing.json.error.code === 'session_not_found', 'an unknown session is session_not_found');
    for (const [label, res] of [['an agent_id expectation for another Agent', wrongAgent], ['a malformed reference', malformed]]) {
      assert(res.status === 404 && same(res.json, missing.json), `${label} -> exactly the missing-session answer`);
    }
    const own = await getShare(TOKENS.grok, created.json.share.share_ref);
    const foreign = await getShare(TOKENS.ci, created.json.share.share_ref);
    const none = await getShare(TOKENS.grok, 'shr_none');
    const foreignList = await listShares(TOKENS.ci);
    const foreignRevoke = await revoke(TOKENS.ci, created.json.share.share_ref);
    assert(own.status === 200 && foreign.status === 404 && same(foreign.json, none.json)
      && foreignList.status === 200 && foreignList.json.items.every(item => item.share_ref !== created.json.share.share_ref)
      && foreignRevoke.status === 404 && foreignRevoke.json.error.code === 'share_not_found',
    'a second service cannot read, list, or revoke the first one\'s share (answered as not found)');
    assert((await getShare(TOKENS.grok, created.json.share.share_ref)).json.share.state === 'active', 'the share is still active after the refused revoke');
    const audit = raw.prepare("SELECT outcome, code FROM service_audit_events WHERE operation = 'shares.create' ORDER BY id").all();
    assert(audit.length === 5 && audit.some(r => r.code === 'audience_not_allowed') && !audit.some(r => r.code === 'not_granted'),
      'every share create is audited; none is refused for a missing grant');
  }

  // -------------------------------------------------------------------
  console.log('\n[3] session messaging: only session_ref, content, idempotency key; exact binding; read-only');
  let message;
  {
    const before = rowCounts();
    const authority = ['deck', 'deck_id', 'runtime', 'model', 'tool_profile', 'provider_session_id', 'external_session_id', 'grants', 'execution_kind', 'cwd'];
    for (const field of authority) {
      const res = await api.message(TOKENS.grok, codexA.binding.id, { content: PROMPT_MARK, idempotency_key: `auth-${field}`, [field]: 'x' });
      assert(res.status === 403 && res.json.error.code === 'authority_not_allowed', `${field} is refused (authority_not_allowed)`);
    }
    const unknownField = await api.message(TOKENS.grok, codexA.binding.id, { content: 'hi', idempotency_key: 'k', agent_id: codex.id, extra: 1 });
    assert(unknownField.status === 400 && unknownField.json.error.code === 'invalid_request', 'any other field is invalid_request');
    const noKey = await api.message(TOKENS.grok, codexA.binding.id, { content: 'hi' });
    const tooLong = await api.message(TOKENS.grok, codexA.binding.id, { content: 'x'.repeat(4001), idempotency_key: 'long' });
    const notJson = await call(http.handleSendSessionMessage, 'POST', `/api/v0/sessions/${codexA.binding.id}/messages`, { token: TOKENS.grok, body: '{nope' }, codexA.binding.id);
    const big = await call(http.handleSendSessionMessage, 'POST', `/api/v0/sessions/${codexA.binding.id}/messages`, { token: TOKENS.grok, body: JSON.stringify({ content: 'x'.repeat(70_000), idempotency_key: 'big' }) }, codexA.binding.id);
    assert(noKey.status === 400 && tooLong.status === 400 && notJson.status === 400 && big.status === 413, 'missing key, oversized content, a non-JSON body, and an oversized body are refused');
    assert(same(rowCounts(), before), 'no refusal wrote an exchange, request, message, conversation, or Attempt');

    script = (input, kind) => kind === 'ask' ? { output: `Because the leases were already there. (${SECRETS.codex})`, session: SECRETS.codex } : { output: 'unexpected' };
    const sent = await api.message(TOKENS.grok, codexA.binding.id, { content: `Why leases? ${PROMPT_MARK}`, idempotency_key: 'msg-1' });
    message = sent.json;
    assert(sent.status === 202 && message.session_ref === codexA.binding.id && message.agent_id === codex.id
      && typeof message.request_id === 'string' && typeof message.conversation_id === 'string' && message.replayed === false,
    'accepted: durable request and conversation ids, owning Agent inferred from the session');
    await service.waitForAgentDispatchIdle();
    const launches = calls.filter(c => c.requestId === message.request_id);
    const attempts = engine.listAttempts(message.request_id);
    assert(launches.length === 1 && launches[0].agentId === codex.id && launches[0].input.toolProfile === 'readonly'
      && launches[0].input.sessionBinding?.bindingId === codexA.binding.id && launches[0].input.sessionBinding?.externalSessionId === SECRETS.codex,
    'exactly one read-only launch for Codex that resumes exactly the referenced binding');
    assert(attempts.length === 1 && attempts[0].kind === 'resume' && attempts[0].resumed_session_binding_id === codexA.binding.id, 'one resume Attempt of that binding');
    const hop = engine.getWorkRequest(message.request_id);
    assert(hop.execution_kind === 'conversation' && hop.tool_profile === 'readonly' && engine.latestSafetyDecision(hop.id).principal_type === 'api_principal',
      'the turn is a read-only conversation admitted for the service as an API principal');
    const polled = await api.narrowRequest(TOKENS.grok, message.request_id);
    assert(polled.status === 200 && polled.json.state === 'completed' && polled.json.conversationId === message.conversation_id
      && polled.json.reply.content.includes('leases were already there') && !polled.text.includes(SECRETS.codex),
    'the caller polls its request: completed, answered, in its own conversation, redacted');
    const conv = await api.narrowConversation(TOKENS.grok, message.conversation_id);
    assert(conv.status === 200 && conv.json.messages.length === 2 && conv.json.messages[0].sender.kind === 'service'
      && conv.json.messages[1].sender.id === codex.id && conv.json.messages[0].messageId === message.message_id,
    'the caller\'s conversation holds its question and the Codex answer');
    assert(count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND request_id = ?', codexA.conv.id, message.request_id) === 0,
      'nothing was written into the session\'s own thread');
    const otherPoll = await api.narrowRequest(TOKENS.ci, message.request_id);
    assert(otherPoll.status === 404, 'another service cannot poll it');

    const mid = rowCounts();
    const replay = await api.message(TOKENS.grok, codexA.binding.id, { content: `Why leases? ${PROMPT_MARK}`, idempotency_key: 'msg-1' });
    assert(replay.status === 200 && replay.json.replayed && replay.json.request_id === message.request_id && same(rowCounts(), mid), 'an exact replay returns the same ids and writes nothing');
    const conflict = await api.message(TOKENS.grok, codexA.binding.id, { content: 'Something else', idempotency_key: 'msg-1' });
    assert(conflict.status === 409 && conflict.json.error.code === 'idempotency_conflict' && same(rowCounts(), mid), 'the same key with other content is idempotency_conflict');
    const headerKey = await api.message(TOKENS.grok, codexA.binding.id, { content: 'Header key works' }, { 'Idempotency-Key': 'msg-2' });
    await service.waitForAgentDispatchIdle();
    assert(headerKey.status === 202 && headerKey.json.conversation_id === message.conversation_id, 'a second message to the same session lands in the same conversation');

    const ended = await api.message(TOKENS.grok, codexEnded.binding.id, { content: 'hi', idempotency_key: 'ended' });
    const mismatched = await api.message(TOKENS.grok, codexOther.binding.id, { content: 'hi', idempotency_key: 'other-runtime' });
    const unknown = await api.message(TOKENS.grok, 'no-such-ref', { content: 'hi', idempotency_key: 'unknown' });
    assert(ended.status === 409 && ended.json.error.code === 'session_ended', 'an ended session is session_ended');
    assert(mismatched.status === 409 && mismatched.json.error.code === 'session_not_resumable', 'a session under another runtime is session_not_resumable');
    assert(unknown.status === 404 && unknown.json.error.code === 'session_not_found', 'an unknown session is session_not_found');
    script = () => ({ output: 'claude answer', session: SECRETS.claude });
    const anyAgent = await api.message(TOKENS.ci, claudeS.binding.id, { content: 'hi Claude', idempotency_key: 'ci-claude' });
    await service.waitForAgentDispatchIdle();
    assert(anyAgent.status === 202 && anyAgent.json.agent_id === claude.id, 'with no grants file a second token sends to an active session of any Agent');
    const ciConv = await api.narrowConversation(TOKENS.grok, anyAgent.json.conversation_id);
    assert(ciConv.status === 404, 'the first service cannot read the second one\'s session-message conversation');
  }

  // -------------------------------------------------------------------
  console.log('\n[4] exchanges: canonical store, any Agent, caller-owned, cancel, replay');
  let continueBody;
  let continueId;
  {
    // Owner-seeded Ask and Continue exchanges are never the service's.
    script = () => ({ output: 'owner answer' });
    const ownerAsk = service.createExchangeCommand({
      requester: OWNER, idempotencyKey: 'owner-ask', mode: 'ask', originConversationId: conversations.getByBotId(grok.id).id,
      sourceAgentId: claude.id, sessionRef: claudeS.binding.id, instruction: 'Owner question',
    });
    await ownerAsk.dispatched;
    await service.waitForAgentDispatchIdle();
    const ownerRead = await api.exchange(TOKENS.grok, ownerAsk.exchange.id);
    const missingEx = await api.exchange(TOKENS.grok, 'no-such-exchange');
    assert(ownerRead.status === 404 && same(ownerRead.json, missingEx.json), 'an owner exchange is answered like a missing one');

    script = (input, kind) => {
      if (kind === 'extract') return { output: JSON.stringify({ objective: 'Finish the access API', decisions: ['Every Agent is reachable'], constraints: [], artifacts: [], open_questions: [] }), session: SECRETS.codex };
      if (kind === 'deliver') return { output: 'Grok picked it up.', session: SECRETS.grokFresh };
      return { output: 'ask answer', session: SECRETS.codex };
    };
    continueBody = { mode: 'continue', idempotency_key: 'cont-1', source: { session_ref: codexA.binding.id }, destination: { agent_id: grok.id }, instruction: `Carry on ${PROMPT_MARK}` };
    const created = await api.createExchange(TOKENS.grok, continueBody);
    continueId = created.json.exchange?.id;
    assert(created.status === 201 && created.json.exchange.mode === 'continue' && created.json.exchange.requester.id === 'grok-bot', 'grok-bot creates a Continue from Codex to Grok');
    await service.waitForAgentDispatchIdle();
    const detail = await api.exchange(TOKENS.grok, continueId);
    const hopCalls = calls.filter(c => c.requestId === detail.json.hops.source.request_id || c.requestId === detail.json.hops.destination?.request_id);
    assert(detail.json.state === 'completed' && detail.json.destination.session_ref && detail.json.destination.session_ref !== codexA.binding.id,
      'source extraction then destination delivery completed with a fresh destination-owned session');
    const deliver = hopCalls.find(c => c.kind === 'deliver');
    assert(hopCalls.find(c => c.kind === 'extract')?.input.sessionBinding?.bindingId === codexA.binding.id
      && deliver && deliver.agentId === grok.id && !deliver.input.sessionBinding && !JSON.stringify(deliver.input).includes(SECRETS.codex),
    'Grok launched fresh: no binding and never the Codex provider session id');
    assert(leaks(detail.text).length === 0, 'the exchange view carries no provider id, Deck, or working directory');
    const grokThread = conversations.getByBotId(grok.id).id;
    const destConv = detail.json.destination.conversation_id;
    assert(destConv && destConv !== grokThread && count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND request_id = ?', grokThread, detail.json.hops.destination.request_id) === 0
      && count("SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ? AND participant_kind = 'service' AND participant_id = 'grok-bot'", destConv) === 1
      && one('SELECT conversation_id FROM session_bindings WHERE id = ?', detail.json.destination.session_ref).conversation_id === destConv,
    'without destination.conversation_id the Continue is delivered into a new service-owned conversation, never the owner\'s Grok thread');
    const destRead = await api.narrowConversation(TOKENS.grok, destConv);
    assert(destRead.status === 200 && destRead.json.messages.some(m => m.content.includes('Grok picked it up')), 'the service reads the delivery in its own destination conversation');
    const storeFallback = (() => {
      try {
        service.exchanges.create({ requester: { kind: 'service', id: 'grok-bot' }, serviceGrant: true, idempotencyKey: 'store-fallback', mode: 'continue',
          originConversationId: detail.json.origin_conversation_id,
          sourceAgentId: codex.id, sessionRef: codexB.binding.id, destinationAgentId: grok.id, instruction: 'x' });
        return null;
      } catch (error) { return error; }
    })();
    assert(storeFallback?.code === 'destination_invalid',
      `the canonical store refuses a service Continue that would fall back to the owner's direct thread (${storeFallback?.code})`);
    assert(detail.json.hops.destination.tool_profile === 'readonly' && one('SELECT COUNT(*) AS n FROM session_exchanges WHERE id = ?', continueId).n === 1,
      'one canonical exchange row; hops are read-only');

    const mid = rowCounts();
    const replay = await api.createExchange(TOKENS.grok, continueBody);
    assert(replay.status === 200 && replay.json.replayed && replay.json.exchange.id === continueId && same(rowCounts(), mid), 'an exact replay returns the same exchange');
    const conflict = await api.createExchange(TOKENS.grok, { ...continueBody, instruction: 'different' });
    assert(conflict.status === 409 && conflict.json.error.code === 'idempotency_conflict', 'a changed payload is idempotency_conflict');

    const toMissing = await api.createExchange(TOKENS.grok, { ...continueBody, idempotency_key: 'cont-missing', destination: { agent_id: 'no-such-agent' } });
    assert(toMissing.status === 404 && toMissing.json.error.code === 'agent_not_found', 'a Continue to an unknown Agent is agent_not_found');
    script = () => ({ output: 'ci ask answer', session: SECRETS.claude });
    const ciCreate = await api.createExchange(TOKENS.ci, { mode: 'ask', idempotency_key: 'ci-ask', source: { session_ref: claudeS.binding.id }, instruction: 'q' });
    const missingRef = await api.createExchange(TOKENS.ci, { mode: 'ask', idempotency_key: 'ci-missing', source: { session_ref: 'no-such-ref' }, instruction: 'q' });
    await service.waitForAgentDispatchIdle();
    assert(ciCreate.status === 201 && ciCreate.json.exchange.mode === 'ask' && missingRef.status === 404 && missingRef.json.error.code === 'session_not_found',
      'with no grants file a token creates an Ask on any Agent\'s session; an unknown session is session_not_found');
    const ciAsk = await api.exchange(TOKENS.ci, ciCreate.json.exchange.id);
    const grokOnCi = await api.exchange(TOKENS.grok, ciCreate.json.exchange.id);
    assert(ciAsk.json.state === 'completed' && ciAsk.json.answer?.content === 'ci ask answer' && grokOnCi.status === 404,
      'the Ask completes for its creator only');
    const authority = await api.createExchange(TOKENS.grok, { ...continueBody, idempotency_key: 'auth', tool_profile: 'edit' });
    const nestedAuthority = await api.createExchange(TOKENS.grok, { ...continueBody, idempotency_key: 'auth2', destination: { agent_id: grok.id, deck: 'x' } });
    assert(authority.json.error.code === 'authority_not_allowed' && nestedAuthority.json.error.code === 'authority_not_allowed', 'tool_profile and nested Deck fields are refused');
    const ciRead = await api.exchange(TOKENS.ci, continueId);
    assert(ciRead.status === 404 && same(ciRead.json, missingEx.json), 'another service cannot read the exchange');

    const listA = await api.exchanges(TOKENS.grok, '?limit=1');
    const listAll = await api.exchanges(TOKENS.grok, '?limit=100');
    assert(listAll.json.items.every(e => e.id !== ownerAsk.exchange.id) && listAll.json.items.some(e => e.id === continueId)
      && listAll.json.items.some(e => e.kind === 'session_message') && listA.json.next_cursor !== null,
    'the exchange list holds only the caller\'s own (session messages included), paginated');
    assert(listAll.json.items.every((e, i, list) => i === 0 || list[i - 1].updated_at >= e.updated_at), 'exchanges are newest activity first');
    const ciList = await api.exchanges(TOKENS.ci, '?limit=100');
    assert(ciList.json.items.every(e => e.id !== continueId) && ciList.json.items.some(e => e.id === ciCreate.json.exchange.id),
      'ci-bot lists only its own exchanges');

    // Cancellation of an in-flight Ask.
    const held = holdAdapter();
    const ask = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'ask-cancel', source: { session_ref: codexB.binding.id }, instruction: 'Hold on' });
    await waitFor(() => calls.some(c => c.requestId === ask.json.exchange.hops.source.request_id), 'held Ask in its adapter');
    const ciCancel = await api.cancel(TOKENS.ci, ask.json.exchange.id);
    assert(ciCancel.status === 404 && ciCancel.json.error.code === 'exchange_not_found'
      && one('SELECT cancel_requested_at FROM session_exchanges WHERE id = ?', ask.json.exchange.id).cancel_requested_at === null,
    'another service cannot cancel it (exchange_not_found, nothing recorded)');
    const cancelResult = await api.cancel(TOKENS.grok, ask.json.exchange.id, { reason: 'not needed' });
    held.release();
    await service.waitForAgentDispatchIdle();
    const afterCancel = await api.exchange(TOKENS.grok, ask.json.exchange.id);
    assert(cancelResult.status === 200 && afterCancel.json.state === 'cancelled' && afterCancel.json.answer === null, 'cancelling an in-flight Ask ends it cancelled with no answer');
    const again = await api.cancel(TOKENS.grok, ask.json.exchange.id);
    assert(again.status === 409 && again.json.error.code === 'exchange_terminal', 'a terminal exchange cannot be cancelled again');
  }

  // -------------------------------------------------------------------
  console.log('\n[4b] every service-visible output is redacted; audit commits with the mutation');
  {
    http.resetServiceApiRateLimits();
    // Each runtime output echoes a run id, the working directory, the Deck
    // selection, a credential, and the provider session ids.
    const echo = `run ${SECRETS.run} in ${WORKDIR} on deck-builder key ${CREDENTIAL} sessions ${SECRETS.codex} ${SECRETS.grokFresh}`;
    script = (input, kind) => {
      if (kind === 'extract') {
        return { output: JSON.stringify({ objective: `Echo ${echo}`, decisions: [echo], constraints: [echo], artifacts: [], open_questions: [echo] }), session: SECRETS.codex };
      }
      if (kind === 'deliver') return { output: `Delivered: ${echo} ${SECRETS.grokEcho}`, session: SECRETS.grokEcho };
      return { output: `Answer: ${echo}`, session: SECRETS.codex };
    };
    const ask = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'echo-ask', source: { session_ref: codexB.binding.id }, instruction: 'Echo it' });
    const cont = await api.createExchange(TOKENS.grok, { mode: 'continue', idempotency_key: 'echo-cont', source: { session_ref: codexA.binding.id }, destination: { agent_id: grok.id }, instruction: 'Echo it on' });
    const msg = await api.message(TOKENS.grok, codexA.binding.id, { content: 'Echo it here', idempotency_key: 'echo-msg' });
    await service.waitForAgentDispatchIdle();
    const askDetail = await api.exchange(TOKENS.grok, ask.json.exchange.id);
    const contDetail = await api.exchange(TOKENS.grok, cont.json.exchange.id);
    assert(askDetail.json.state === 'completed' && askDetail.json.answer?.content.startsWith('Answer: run [redacted runtime id] in [redacted] on [redacted] key [redacted]')
      && leaks(askDetail.text).length === 0, `an Ask answer echoing private values is redacted in exchange detail (${leaks(askDetail.text).join(',')})`);
    assert(contDetail.json.state === 'completed' && contDetail.json.packet && JSON.stringify(contDetail.json.packet).includes('[redacted]')
      && leaks(contDetail.text).length === 0, `a Continue packet echoing private values is redacted in exchange detail (${leaks(contDetail.text).join(',')})`);
    const polls = [
      await api.narrowRequest(TOKENS.grok, askDetail.json.hops.source.request_id),
      await api.narrowRequest(TOKENS.grok, contDetail.json.hops.destination.request_id),
      await api.narrowRequest(TOKENS.grok, msg.json.request_id),
      await api.narrowConversation(TOKENS.grok, askDetail.json.origin_conversation_id),
      await api.narrowConversation(TOKENS.grok, contDetail.json.destination.conversation_id),
      await api.narrowConversation(TOKENS.grok, msg.json.conversation_id),
    ];
    assert(polls.every(p => p.status === 200) && polls.some(p => p.text.includes('Answer: run [redacted runtime id]'))
      && polls.some(p => p.text.includes('Delivered: run [redacted runtime id]')),
    'the documented polling routes return the echoed results');
    assert(polls.every(p => leaks(p.text).length === 0), `polling /api/v0/requests and /api/v0/conversations never shows a private value (${polls.flatMap(p => leaks(p.text)).join(',')})`);
    const ownerView = service.getConversation(OWNER, conversations.getByBotId(codex.id).id);
    assert(ownerView.messages.some(m => m.content.includes(WORKDIR)), 'the owner\'s own reads are unchanged (not redacted)');

    const createdFull = await api.createExchange(TOKENS.other, { mode: 'ask', idempotency_key: 'other-full', source: { session_ref: codexB.binding.id }, instruction: `Plan ${PROMPT_MARK}` });
    await service.waitForAgentDispatchIdle();
    assert(createdFull.status === 201 && 'instruction' in createdFull.json.exchange, 'every service principal gets the full view of its own exchange on create');

    // A failing audit append rolls the mutation back: nothing is written,
    // dispatched, or launched; the failure itself is audited as an error.
    const appendOriginal = serviceAudit.append;
    serviceAudit.append = input => {
      if (input.outcome === 'allowed') throw new Error('audit store unavailable');
      return appendOriginal(input);
    };
    const beforeRows = rowCounts();
    const beforeCalls = calls.length;
    const beforeAudit = count('SELECT COUNT(*) AS n FROM service_audit_events');
    const failMsg = await api.message(TOKENS.grok, codexA.binding.id, { content: 'unaudited', idempotency_key: 'audit-fail-msg' });
    const failCreate = await api.createExchange(TOKENS.grok, { mode: 'continue', idempotency_key: 'audit-fail-cont', source: { session_ref: codexA.binding.id }, destination: { agent_id: grok.id }, instruction: 'unaudited' });
    await service.waitForAgentDispatchIdle();
    assert(failMsg.status === 500 && failMsg.json.error.code === 'internal_error' && failCreate.status === 500 && failCreate.json.error.code === 'internal_error',
      'when the audit append fails the caller gets internal_error');
    assert(same(rowCounts(), beforeRows) && calls.length === beforeCalls,
      'no exchange, request, message, conversation, Attempt, or launch survives an unaudited session message or exchange create');
    assert(count("SELECT COUNT(*) AS n FROM service_audit_events WHERE outcome = 'error' AND code = 'internal_error' AND operation IN ('sessions.message', 'exchanges.create')") >= 2
      && count('SELECT COUNT(*) AS n FROM service_audit_events') === beforeAudit + 2, 'each failed mutation is audited as an error, never as allowed');
    serviceAudit.append = appendOriginal;

    // The narrow /api/v0 message route obeys the same rule: its audit event
    // commits with the message, or the message is never accepted.
    serviceAudit.append = input => {
      if (input.outcome === 'allowed') throw new Error('audit store unavailable');
      return appendOriginal(input);
    };
    const narrowRows = rowCounts();
    const narrowCalls = calls.length;
    const failNarrow = await api.narrowSend(TOKENS.grok, codex.id, { content: 'unaudited narrow message', idempotencyKey: 'audit-fail-narrow' });
    await service.waitForAgentDispatchIdle();
    serviceAudit.append = appendOriginal;
    assert(failNarrow.status === 500 && failNarrow.json.error.code === 'internal_error' && same(rowCounts(), narrowRows) && calls.length === narrowCalls,
      'when the audit append fails an unaudited narrow service message leaves no conversation, message, request, Attempt, or launch');
    const narrowRetry = await api.narrowSend(TOKENS.grok, codex.id, { content: 'unaudited narrow message', idempotencyKey: 'audit-fail-narrow' });
    await service.waitForAgentDispatchIdle();
    assert(narrowRetry.status === 202 && narrowRetry.json.replayed === false, 'the same key then accepts once the audit store is back (nothing was recorded)');
    const heldCancel = holdAdapter();
    const toCancel = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'audit-fail-cancel', source: { session_ref: codexB.binding.id }, instruction: 'hold' });
    await waitFor(() => calls.some(c => c.requestId === toCancel.json.exchange.hops.source.request_id), 'held Ask before an unaudited cancel');
    serviceAudit.append = input => {
      if (input.outcome === 'allowed') throw new Error('audit store unavailable');
      return appendOriginal(input);
    };
    const failCancel = await api.cancel(TOKENS.grok, toCancel.json.exchange.id);
    serviceAudit.append = appendOriginal;
    const cancelRow = one('SELECT cancel_requested_at, state FROM session_exchanges WHERE id = ?', toCancel.json.exchange.id);
    const hopState = engine.getWorkRequest(toCancel.json.exchange.hops.source.request_id).state;
    assert(failCancel.status === 500 && cancelRow.cancel_requested_at === null && hopState === 'running',
      'an unaudited cancel records no intent and cancels nothing');
    heldCancel.release();
    await service.waitForAgentDispatchIdle();
    assert(one('SELECT state FROM session_exchanges WHERE id = ?', toCancel.json.exchange.id).state === 'completed', 'the exchange runs on to completion');
  }

  // -------------------------------------------------------------------
  console.log('\n[4c] the Agent\'s policy is the only gate for starting a session and resume with edits');
  {
    http.resetServiceApiRateLimits();
    const { runtimeConnections } = dbModule;
    const connectionId = runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
    contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
    fake.seedFakeProvider(STATE, [
      { id: 'pol-open-SECRET', title: 'Fix the uploader retry', workspace: '/work/a' },
      { id: 'pol-ro-SECRET', title: 'Read-only session', workspace: '/work/a' },
    ]);
    const nativeAgent = (name, policy, extra = {}) => {
      const bot = bots.create({
        name, title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
        session_scope_kind: 'all_provider_sessions', session_scope_items: '[]',
        policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0, allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
      });
      if (extra.defaultWorkspace) raw.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run(extra.defaultWorkspace, bot.id);
      return bot;
    };
    const closed = nativeAgent('Closed', { mode: 'read_only', newSessions: false, resumeEdits: false });
    const starter = nativeAgent('Starter', { mode: 'read_only', newSessions: true, resumeEdits: false }, { defaultWorkspace: '/work/a' });
    const writer = nativeAgent('Writer', { mode: 'workspace_write', newSessions: false, resumeEdits: true });
    const reader = nativeAgent('Reader', { mode: 'read_only', newSessions: false, resumeEdits: false });
    const sync = async agentId => { let cursor = null; do { cursor = (await ps.syncAgentSessions(raw, agentId, { cursor })).next_cursor; } while (cursor); };
    for (const bot of [writer, reader]) await sync(bot.id);
    const keep = (bot, ids) => raw.prepare(`DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id NOT IN (${ids.map(() => '?').join(',')})`).run(bot.id, ...ids);
    keep(writer, ['pol-open-SECRET']);
    keep(reader, ['pol-ro-SECRET']);
    const writerRef = one('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?', writer.id, 'pol-open-SECRET').id;
    const readerRef = one('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?', reader.id, 'pol-ro-SECRET').id;
    const msgAgent = (token, agentId, body) => call(http.handleMessageAgent, 'POST', `/api/v0/agents/${agentId}/pins`, { token, body }, agentId);
    const pinSession = (token, ref, body) => call(http.handlePinSession, 'POST', `/api/v0/sessions/${ref}/pins`, { token, body }, ref);
    const readPin = (token, ref) => call(http.handleReadPin, 'GET', `/api/v0/pins/${ref}`, { token }, ref);
    const sendToPin = (token, ref, body) => call(http.handleSendToPin, 'POST', `/api/v0/pins/${ref}/messages`, { token, body }, ref);
    const detachPin = (token, ref) => call(http.handleDetachPin, 'POST', `/api/v0/pins/${ref}/detach`, { token, body: {} }, ref);

    const startsBefore = fake.providerCalls(STATE, 'startSession');
    const closedMsg = await msgAgent(TOKENS.grok, closed.id, { content: 'Anyone there?', idempotency_key: 'pol-closed' });
    assert(closedMsg.status === 409 && closedMsg.json.error.code === 'no_eligible_session' && fake.providerCalls(STATE, 'startSession') === startsBefore,
      'allow_new_sessions off: messaging an Agent with no eligible session -> no_eligible_session, nothing started');
    const startedMsg = await msgAgent(TOKENS.grok, starter.id, { content: 'Start please', idempotency_key: 'pol-start' });
    const startCall = fake.loadFakeState(STATE).calls.filter(c => c.op === 'startSession').pop();
    assert(startedMsg.status === 202 && startedMsg.json.resolution === 'started' && startedMsg.json.pin.authority === 'read_only'
      && startCall && startCall.workspace === '/work/a' && startCall.authority === 'read_only' && fake.providerCalls(STATE, 'startSession') === startsBefore + 1,
    'allow_new_sessions on with a default workspace: a read-only session is started (no sessions:start grant)');
    const startAudit = raw.prepare("SELECT * FROM service_audit_events WHERE operation = 'agents.message.start' ORDER BY id DESC LIMIT 1").get();
    assert(startAudit && startAudit.capability === 'sessions:start' && startAudit.outcome === 'allowed', 'the start is audited with sessions:start');

    const resumeOff = await pinSession(TOKENS.grok, readerRef, { action: 'resume', approve_write: true, idempotency_key: 'pol-r-off' });
    assert(resumeOff.status === 403 && resumeOff.json.error.code === 'authority_not_allowed',
      'resume refused with authority_not_allowed when allow_resume_with_edits is off (even with approve_write)');
    const resumeNoApproval = await pinSession(TOKENS.grok, writerRef, { action: 'resume', idempotency_key: 'pol-r-noapprove' });
    assert(resumeNoApproval.status === 403 && resumeNoApproval.json.error.code === 'approval_required' && resumeNoApproval.json.error.recovery === 'approve_write',
      'resume refused when approve_write is missing (approval_required)');
    const resumed = await pinSession(TOKENS.grok, writerRef, { action: 'resume', approve_write: true, idempotency_key: 'pol-r-ok' });
    assert(resumed.status === 201 && resumed.json.pin.authority === 'workspace_write' && resumed.json.pin.action === 'resume',
      'resume allowed when the policy is on and approve_write is true (no sessions:resume grant)');
    const mcpResumeOff = await mcpCall({ kind: 'service', id: 'grok-bot' }, 'botmancers_pin_session', { session_ref: readerRef, action: 'resume', approve_write: true, idempotency_key: 'pol-mcp-off' });
    assert(mcpResumeOff.error?.code === 'authority_not_allowed', 'MCP: the same policy refusal (authority_not_allowed)');

    // Pins are caller-owned: a second service sees none of the first one's.
    const pinRef = resumed.json.pin.pin_ref;
    const otherRead = await readPin(TOKENS.ci, pinRef);
    const otherSend = await sendToPin(TOKENS.ci, pinRef, { content: 'hijack', idempotency_key: 'pol-hijack' });
    const otherDetach = await detachPin(TOKENS.ci, pinRef);
    const noPin = await readPin(TOKENS.ci, 'pin_none');
    assert(otherRead.status === 404 && otherRead.json.error.code === 'pin_not_found' && same(otherRead.json, noPin.json)
      && otherSend.status === 404 && otherDetach.status === 404,
    'a second service cannot read, send to, or detach the first one\'s pin (answered as not found)');
    const stillAttached = await readPin(TOKENS.grok, pinRef);
    assert(stillAttached.status === 200 && stillAttached.json.pin.state === 'attached', 'the pin is still attached for its owner');
    const leaksHere = [closedMsg, startedMsg, resumed, stillAttached].map(r => r.text).join('');
    assert(!/SECRET/.test(leaksHere.replace(/tok-[a-z-]+SECRET[a-z-]*/g, '')) && !leaksHere.includes('/work/a'), 'no provider id or workspace path in any pin view');
  }

  // -------------------------------------------------------------------
  console.log('\n[5] restart: a second process replays idempotently');
  {
    const child = spawnSync(process.execPath, [__filename], {
      env: {
        ...process.env, ACCESS_SCENARIO: 'restart-child',
        ACCESS_IDS: JSON.stringify({
          exchangeBody: continueBody, exchangeId: continueId, sessionRef: codexA.binding.id,
          messageBody: { content: `Why leases? ${PROMPT_MARK}`, idempotency_key: 'msg-1' },
        }),
      },
      encoding: 'utf8', timeout: 60_000,
    });
    let out = null;
    try { out = JSON.parse(child.stdout); } catch { console.log(child.stdout, child.stderr); }
    assert(out && out.replayExchange.status === 200 && out.replayExchange.json.exchange.id === continueId && out.replayExchange.json.replayed,
      'after a restart the exchange create replays to the same exchange');
    assert(out && out.replayMessage.status === 200 && out.replayMessage.json.request_id === message.request_id, 'after a restart the session message replays to the same request');
    assert(out && same(out.before, out.after) && out.calls === 0, 'the restarted process wrote and launched nothing for the replays');
    assert(out && out.detail.json.state === 'completed' && out.denied.status === 404, 'the restarted process serves the detail and still denies another service');
  }

  // -------------------------------------------------------------------
  console.log('\n[6] rate limit; exchange hops stay readable to their requester only');
  {
    http.resetServiceApiRateLimits();
    process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '3';
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await api.capabilities(TOKENS.ci));
    assert(results.slice(0, 3).every(r => r.status === 200) && results[3].status === 429 && results[3].json.error.code === 'rate_limited'
      && Number(results[3].headers.get('retry-after')) >= 1, 'calls over the per-service limit are 429 rate_limited with Retry-After');
    assert((await api.capabilities(TOKENS.grok)).status === 200, 'the limit is per service principal');
    delete process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE;
    http.resetServiceApiRateLimits();

    const hopRequestId = service.exchanges.get(continueId).source_request_id;
    const destHopRequestId = service.exchanges.get(continueId).destination_request_id;
    assert((await api.narrowRequest(TOKENS.grok, hopRequestId)).status === 200 && !!destHopRequestId
      && (await api.narrowRequest(TOKENS.grok, destHopRequestId)).status === 200, 'the requesting service reads both exchange hops while the Agents exist (no grants file)');
    const continueRow = service.exchanges.get(continueId);
    const hopMessages = async () => {
      const ask = await api.narrowConversation(TOKENS.grok, message.conversation_id);
      const dest = await api.narrowConversation(TOKENS.grok, continueRow.destination_conversation_id);
      return {
        ask: ask.json.messages.filter(m => m.requestId === message.request_id).length,
        dest: dest.json.messages.filter(m => m.requestId === continueRow.destination_request_id).length,
        events: [...ask.json.events, ...dest.json.events]
          .filter(e => [message.request_id, continueRow.destination_request_id].includes(e.requestId)).length,
        text: ask.text + dest.text,
      };
    };
    const own = await hopMessages();
    assert(own.ask === 2 && own.dest === 1, 'its own conversations show the session-message question/answer and the Continue reply');
    const ciHop = await api.narrowRequest(TOKENS.ci, hopRequestId);
    const ciDest = await api.narrowRequest(TOKENS.ci, destHopRequestId);
    assert(ciHop.status === 404 && ciHop.json.error.code === 'request_not_found' && ciDest.status === 404 && leaks(ciHop.text).length === 0,
      'another service cannot read those exchange hops (request_not_found)');
    assert(fs.existsSync(LEFTOVER_GRANTS_PATH) && (await api.narrowRequest(TOKENS.grok, hopRequestId)).status === 200,
      'the leftover grants file still changes nothing for hop reads');

    // The redactor's reference exemption is explicit: a Botmancers id passes,
    // the provider's own run and session ids (whatever their key) do not.
    const { serviceRedactor } = jiti('./lib/service-redaction.ts');
    const shown = serviceRedactor().deep({
      request_id: 'req-1', originConversationId: 'conv-1', sender_id: 'bot-1',
      data: { phase: 'runtime_started', external_run_id: SECRETS.run, externalSessionId: SECRETS.codex, runId: SECRETS.run, resumeSessionId: SECRETS.codexOld },
    });
    assert(shown.request_id === 'req-1' && shown.originConversationId === 'conv-1' && shown.sender_id === 'bot-1', 'Botmancers reference fields are left as they are');
    // A short provider id is redacted as a whole token (never inside other text).
    engine.bindSession({ agentId: claude.id, adapter: 'hermes', externalSessionId: 'ab7', conversationId: conversations.getByBotId(claude.id).id });
    const shortShown = serviceRedactor().deep({ data: { external_run_id: 'ab7' }, text: 'run ab7 finished; tab7 and ab70 are other words' });
    assert(shortShown.data.external_run_id === '[redacted runtime id]' && shortShown.text === 'run [redacted runtime id] finished; tab7 and ab70 are other words',
      'a recorded provider run id shorter than six characters is redacted too, without rewriting other text');
    assert(leaks(JSON.stringify(shown)).length === 0 && shown.data.external_run_id === '[redacted runtime id]',
      'a projected runtime_started external_run_id (and other provider id keys) is redacted');
  }

  // -------------------------------------------------------------------
  console.log('\n[7] audit: bounded, append-only, no prompt, transcript, token, provider id, or working directory');
  {
    // Internal error path: the canonical store throws.
    const original = service.exchanges.create;
    service.exchanges.create = () => { throw new Error(`boom ${SECRETS.codex} ${PROMPT_MARK}`); };
    const internal = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'boom', source: { session_ref: codexB.binding.id }, instruction: `boom ${PROMPT_MARK}` });
    service.exchanges.create = original;
    assert(internal.status === 500 && internal.json.error.code === 'internal_error' && leaks(internal.text).length === 0 && !internal.text.includes(PROMPT_MARK),
      'an internal error answers internal_error with no detail');
    const oddRef = await api.session(TOKENS.grok, codex.id, encodeURIComponent(`${PROMPT_MARK} please`));
    assert(oddRef.status === 404, 'a garbage reference is a missing session');

    const rows = raw.prepare('SELECT * FROM service_audit_events ORDER BY id ASC').all();
    const text = JSON.stringify(rows);
    assert(rows.length > 40, `every call appended an audit event (${rows.length})`);
    assert(rows.every(r => r.at > 0 && /^(service|person):/.test(r.principal) && r.capability && r.operation && r.target_kind && r.outcome),
      'every event names when, principal, operation, capability, target kind, and outcome');
    assert(leaks(text).length === 0 && !text.includes(PROMPT_MARK) && !text.includes('leases') && !text.includes('Bearer'),
      `no audit event holds a prompt, transcript, token, provider id, or working directory (${leaks(text).join(',')})`);
    const outcomes = new Set(rows.map(r => r.outcome));
    assert(['allowed', 'denied', 'rejected', 'error'].every(o => outcomes.has(o)), 'allowed, denied, rejected (validation), and error outcomes are all recorded');
    const msg = rows.find(r => r.operation === 'sessions.message' && r.outcome === 'allowed');
    assert(msg && msg.capability === 'sessions:message' && msg.target_ref === codexA.binding.id && msg.agent_id === codex.id && msg.principal === 'service:grok-bot',
      'a session message records the principal, capability, session reference, and owning Agent');
    assert(rows.some(r => r.operation === 'agents.read' && r.outcome === 'denied' && r.code === 'agent_not_found')
      && !rows.some(r => r.code === 'grants_unavailable' || r.code === 'grant_required'),
    'an unknown Agent is audited as agent_not_found; no grants refusal exists any more');
    assert(rows.some(r => r.outcome === 'rejected' && r.code === 'authority_not_allowed') && rows.some(r => r.outcome === 'error' && r.code === 'internal_error')
      && rows.some(r => r.code === 'rate_limited'),
    'validation, internal-error, and rate-limit paths are audited');
    assert(rows.some(r => r.target_ref === '[invalid]'), 'a reference that is not a Botmancers id is stored as [invalid]');
    const createRows = rows.filter(r => r.operation === 'exchanges.create');
    const authorityRow = createRows.find(r => r.code === 'authority_not_allowed');
    const deniedRow = createRows.find(r => r.code === 'session_not_found');
    const okRow = createRows.find(r => r.outcome === 'allowed');
    assert(authorityRow && authorityRow.target_kind === 'session' && authorityRow.target_ref === codexA.binding.id && authorityRow.agent_id === codex.id,
      'a refused (authority-seeking) create records its source session and owning Agent');
    assert(deniedRow && deniedRow.target_kind === 'session' && deniedRow.target_ref,
      'a create on an unknown session records its source session');
    assert(okRow && okRow.target_kind === 'exchange' && okRow.target_ref === continueId && okRow.agent_id === codex.id, 'an allowed create records the exchange');
    const msgOther = rows.find(r => r.operation === 'sessions.message' && r.outcome === 'allowed' && r.principal === 'service:ci-bot' && r.target_ref === claudeS.binding.id);
    assert(msgOther && msgOther.agent_id === claude.id && msgOther.capability === 'sessions:message', 'a second service\'s session message is audited with its capability and owning Agent');
    assert(rows.some(r => r.capability === 'participant' && r.operation === 'requests.read' && r.target_ref === message.request_id),
      'narrow /api/v0 reads by a service are audited too');
    const update = (() => { try { raw.prepare("UPDATE service_audit_events SET outcome = 'allowed'").run(); return null; } catch (e) { return e; } })();
    const del = (() => { try { raw.prepare('DELETE FROM service_audit_events').run(); return null; } catch (e) { return e; } })();
    assert(/append-only/.test(update?.message ?? '') && /append-only/.test(del?.message ?? ''), 'audit events cannot be updated or deleted');
    assert(serviceAudit.list({ principal: 'service:ci-bot', limit: 5 }).every(r => r.principal === 'service:ci-bot'), 'the owner can read the trail per principal');
  }

  console.log(failures === 0 ? '\nAll service access checks passed.' : `\n${failures} service access check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

(CHILD ? restartChild() : main()).catch(error => {
  console.error(error);
  process.exit(1);
});
