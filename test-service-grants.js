#!/usr/bin/env node
// NOT-499: granted service access to Agents, sessions, conversations, and
// exchanges (lib/service-grants, lib/service-audit, lib/service-api,
// lib/service-api-http, app/api/v0/**).
// Proves: the versioned owner-only grants document allows exactly what it
// lists and fails closed when missing (narrow behavior kept), malformed,
// unknown, duplicate, over-broad, reserved, or not owner-only; two service
// principals over three Agents see only their granted Agents, sessions,
// conversations, and exchanges, newest activity first with deterministic
// cursors, and a target outside the grants is answered exactly like a
// missing one; no view carries a provider session or run id, Deck, or
// working directory; a session message accepts only content and an
// idempotency key, refuses authority-seeking fields before any write, and
// resumes exactly the referenced active binding as one read-only turn whose
// request and conversation the caller can poll; exchanges reuse the
// canonical store under exchanges:read/create on every Agent involved,
// with cancellation, idempotent replay, and a restart (a real second
// process); every call appends a bounded audit event that leaks no prompt,
// transcript, token, provider id, or working directory. Handlers run
// in-process with the real service-token authenticator and a fake attempt
// adapter through the real leased dispatcher. Self-contained: isolated
// SQLite file and HOME, no network, no listening socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CHILD = process.env.GRANTS_SCENARIO === 'restart-child';
const DB_PATH = process.env.GRANTS_DB || path.join(os.tmpdir(), `botmancers-grants-${process.pid}.db`);
if (!CHILD) for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
process.env.GRANTS_DB = DB_PATH;
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
if (!process.env.GRANTS_HOME) process.env.GRANTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-grants-home-'));
process.env.HOME = process.env.GRANTS_HOME;
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';
const GRANTS_PATH = path.join(process.env.GRANTS_HOME, 'config', 'service-grants.json');
process.env.BOTMANCERS_SERVICE_GRANTS_PATH = GRANTS_PATH;

const TOKENS = { grok: 'tok-grok-bot-SECRET-aaaa', ci: 'tok-ci-bot-SECRET-bbbb', other: 'tok-other-SECRET-cccc' };
const digest = token => `sha256:${createHash('sha256').update(token).digest('hex')}`;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(TOKENS.grok)},ci-bot=${digest(TOKENS.ci)},other-bot=${digest(TOKENS.other)}`;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const grantsLib = jiti('./lib/service-grants.ts');
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

function writeGrants(doc, mode = 0o600) {
  fs.mkdirSync(path.dirname(GRANTS_PATH), { recursive: true });
  fs.writeFileSync(GRANTS_PATH, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  fs.chmodSync(GRANTS_PATH, mode);
  grantsLib.resetServiceGrantsCache();
}
function removeGrants() {
  fs.rmSync(GRANTS_PATH, { force: true });
  grantsLib.resetServiceGrantsCache();
}

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

function grantsDoc({ codex, grok, claude }) {
  return {
    version: 1,
    grants: [
      { service: 'grok-bot', agent: codex.id, capabilities: ['agents:read', 'sessions:read', 'conversations:read', 'sessions:message', 'exchanges:read', 'exchanges:create'] },
      { service: 'grok-bot', agent: grok.id, capabilities: ['agents:read', 'conversations:read', 'exchanges:read', 'exchanges:create'] },
      { service: 'ci-bot', agent: claude.id, capabilities: ['agents:read', 'sessions:read', 'conversations:read'] },
    ],
  };
}

// ---------------------------------------------------------------------
// Restart child: a fresh process over the same database and grants.
async function restartChild() {
  installAdapter();
  const ids = JSON.parse(process.env.GRANTS_IDS);
  service.configureDispatcher({ owner: `grants-restart-child:${process.pid}` });
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
  service.configureDispatcher({ owner: `grants-test:${process.pid}`, config: { maxGlobal: 10, maxPerTarget: 1, heartbeatMs: 600_000 } });
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
  console.log('\n[1] grants document: missing keeps the narrow behavior; malformed fails closed');
  {
    removeGrants();
    const caps = await api.capabilities(TOKENS.grok);
    assert(caps.status === 200 && caps.json.mode === 'narrow' && caps.json.agents.length === 0, 'missing document: narrow mode, no Agents');
    const list = await api.agents(TOKENS.grok);
    assert(list.status === 200 && list.json.items.length === 0, 'missing document: the Agent list is empty');
    const sess = await api.sessions(TOKENS.grok, codex.id);
    const unknownAgent = await api.sessions(TOKENS.grok, 'no-such-agent');
    assert(sess.status === 404 && same(sess.json, unknownAgent.json), 'missing document: a real Agent is indistinguishable from a missing one');
    script = () => ({ output: 'narrow reply' });
    const narrow = await api.narrowSend(TOKENS.grok, codex.id, { content: 'Start a fresh coordinator task', idempotencyKey: 'narrow-1' });
    assert(narrow.status === 202 && typeof narrow.json.requestId === 'string', 'missing document: the existing narrow new-conversation route still accepts');
    await service.waitForAgentDispatchIdle();
    const narrowRead = await api.narrowConversation(TOKENS.grok, narrow.json.conversationId);
    assert(narrowRead.status === 200 && narrowRead.json.messages.length === 2, 'missing document: the service still reads the conversation it opened');

    const bad = [
      ['not JSON', '{ "version": 1, '],
      ['wrong version', { version: 2, grants: [] }],
      ['unknown top-level field', { version: 1, grants: [], defaults: {} }],
      ['unknown capability', { version: 1, grants: [{ service: 'grok-bot', agent: codex.id, capabilities: ['sessions:write'] }] }],
      ['wildcard capability', { version: 1, grants: [{ service: 'grok-bot', agent: codex.id, capabilities: ['*'] }] }],
      ['wildcard Agent', { version: 1, grants: [{ service: 'grok-bot', agent: '*', capabilities: ['agents:read'] }] }],
      ['duplicate capability', { version: 1, grants: [{ service: 'grok-bot', agent: codex.id, capabilities: ['agents:read', 'agents:read'] }] }],
      ['duplicate entry', { version: 1, grants: [
        { service: 'grok-bot', agent: codex.id, capabilities: ['agents:read'] },
        { service: 'grok-bot', agent: codex.id, capabilities: ['sessions:read'] }] }],
      ['empty capabilities', { version: 1, grants: [{ service: 'grok-bot', agent: codex.id, capabilities: [] }] }],
      ['unknown entry field', { version: 1, grants: [{ service: 'grok-bot', agent: codex.id, capabilities: ['agents:read'], deck: 'x' }] }],
      ['reserved engine principal', { version: 1, grants: [{ service: 'botmancers-exchanges', agent: codex.id, capabilities: ['exchanges:create'] }] }],
      ['unconfigured service principal', { version: 1, grants: [
        { service: 'grok-bot', agent: codex.id, capabilities: ['agents:read'] },
        { service: 'grok-bott', agent: codex.id, capabilities: ['agents:read'] }] }],
    ];
    for (const [label, doc] of bad) {
      writeGrants(doc);
      const state = grantsLib.loadServiceGrants();
      const response = await api.capabilities(TOKENS.grok);
      const agentsResponse = await api.agents(TOKENS.ci);
      assert(state.state === 'invalid' && response.status === 503 && response.json.error.code === 'grants_unavailable' && agentsResponse.status === 503,
        `${label}: the whole document is refused (grants_unavailable for every service)`);
    }
    for (const mode of [0o666, 0o620, 0o644, 0o640, 0o604, 0o610]) {
      writeGrants(grantsDoc(agents), mode);
      assert(grantsLib.loadServiceGrants().state === 'invalid' && (await api.agents(TOKENS.grok)).status === 503,
        `a document with mode 0${mode.toString(8)} (group/other readable or writable) is refused (owner-only)`);
    }
    writeGrants(grantsDoc(agents));
    const tokens = process.env.BOTMANCERS_SERVICE_TOKENS;
    process.env.BOTMANCERS_SERVICE_TOKENS = 'grok-bot=not-a-digest';
    const malformedTokens = grantsLib.loadServiceGrants();
    process.env.BOTMANCERS_SERVICE_TOKENS = `ci-bot=${digest(TOKENS.ci)}`;
    const grokUnconfigured = grantsLib.loadServiceGrants();
    process.env.BOTMANCERS_SERVICE_TOKENS = tokens;
    assert(malformedTokens.state === 'invalid' && grokUnconfigured.state === 'invalid' && /configured service principal/.test(grokUnconfigured.reason)
      && grantsLib.loadServiceGrants().state === 'loaded',
    'grant entries are checked against BOTMANCERS_SERVICE_TOKENS: a malformed list or a removed service refuses the document; restoring it reloads');
    const narrowStill = await api.narrowSend(TOKENS.grok, codex.id, { content: 'Still fresh', idempotencyKey: 'narrow-2' });
    assert(narrowStill.status === 202, 'a malformed document leaves the narrow route working');
    await service.waitForAgentDispatchIdle();

    writeGrants(grantsDoc(agents));
    const loaded = grantsLib.loadServiceGrants();
    assert(loaded.state === 'loaded' && loaded.grants.get('grok-bot').size === 2 && loaded.grants.get('ci-bot').size === 1, 'the valid owner-only document loads');
    const capsA = await api.capabilities(TOKENS.grok);
    const capsOther = await api.capabilities(TOKENS.other);
    assert(capsA.json.mode === 'granted' && same(capsA.json.agents.map(a => a.agent_id).sort(), [codex.id, grok.id].sort())
      && same(capsA.json.agents.find(a => a.agent_id === grok.id).capabilities, ['agents:read', 'conversations:read', 'exchanges:read', 'exchanges:create']),
    'capabilities lists exactly the caller\'s Agents and capability subsets');
    assert(capsOther.status === 200 && capsOther.json.agents.length === 0, 'an authenticated service with no entry is granted nothing');
    const unauth = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', { token: 'wrong-token' });
    const noAuth = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', {});
    assert(unauth.status === 401 && noAuth.status === 401, 'unknown or missing tokens are unauthenticated');
  }

  // -------------------------------------------------------------------
  console.log('\n[2] reads: two principals, three Agents, only granted safe metadata');
  {
    const listA = await api.agents(TOKENS.grok);
    const listB = await api.agents(TOKENS.ci);
    assert(same(listA.json.items.map(a => a.agent_id).sort(), [codex.id, grok.id].sort()), 'grok-bot discovers Codex and Grok only');
    assert(same(listB.json.items.map(a => a.agent_id), [claude.id]), 'ci-bot discovers Claude only');
    assert(listA.json.items.every((a, i, all) => i === 0 || all[i - 1].last_activity_at >= a.last_activity_at), 'Agents are newest activity first');
    const hidden = await api.agent(TOKENS.grok, claude.id);
    const missing = await api.agent(TOKENS.grok, 'no-such-agent');
    assert(hidden.status === 404 && same(hidden.json, missing.json), 'an ungranted Agent is answered exactly like a missing one');
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
    assert(grokSessions.status === 404 && same(grokSessions.json, (await api.sessions(TOKENS.grok, 'no-such-agent')).json),
      'sessions of an Agent granted without sessions:read are answered like a missing Agent');
    const viaOther = await api.session(TOKENS.grok, codex.id, claudeS.binding.id);
    const unknownRef = await api.session(TOKENS.grok, codex.id, 'no-such-ref');
    assert(viaOther.status === 404 && same(viaOther.json, unknownRef.json), 'another Agent\'s session is answered like a missing session');
    const bSessions = await api.sessions(TOKENS.ci, claude.id);
    const bCodex = await api.sessions(TOKENS.ci, codex.id);
    assert(bSessions.json.items.map(s => s.ref).join() === claudeS.binding.id && bCodex.status === 404, 'ci-bot sees Claude\'s session and no Codex row');

    const convs = await api.conversations(TOKENS.grok, codex.id);
    const ids = convs.json.items.map(c => c.conversation_id);
    assert(ids.includes(codexA.conv.id) && !ids.includes(groupConv) && !ids.includes(otherConv),
      'Codex conversations exclude a group with an ungranted Agent and another service\'s conversation');
    assert(convs.json.items.every((c, i, list) => i === 0 || list[i - 1].last_activity_at >= c.last_activity_at), 'conversations are newest activity first');
    const thread = await api.conversation(TOKENS.grok, codex.id, codexA.conv.id);
    assert(thread.status === 200 && thread.json.messages.some(m => m.content.includes('[redacted runtime id]')) && leaks(thread.text).length === 0,
      'a transcript that echoed a provider session id and run id is redacted');
    assert(thread.json.messages.some(m => m.content.startsWith('Working in [redacted]/src with [redacted], key [redacted].')),
      'a transcript that echoed the working directory, the Deck selection, and a credential is redacted');
    const groupRead = await api.conversation(TOKENS.grok, codex.id, groupConv);
    const missingConv = await api.conversation(TOKENS.grok, codex.id, 'no-such-conversation');
    const otherRead = await api.conversation(TOKENS.grok, codex.id, otherConv);
    assert(groupRead.status === 404 && same(groupRead.json, missingConv.json) && same(otherRead.json, missingConv.json),
      'an ungranted conversation is answered exactly like a missing one');
    const bConvs = await api.conversations(TOKENS.ci, claude.id);
    assert(bConvs.json.items.every(c => c.conversation_id !== codexA.conv.id && c.conversation_id !== groupConv), 'ci-bot sees no Codex or mixed conversation');
    const person = await call(http.handleGetCapabilities, 'GET', '/api/v0/capabilities', {});
    assert(person.status === 401, 'no principal, no access');
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
    const ungranted = await api.message(TOKENS.grok, claudeS.binding.id, { content: 'hi', idempotency_key: 'ungranted' });
    const noMessageCap = await api.message(TOKENS.grok, grokS.binding.id, { content: 'hi', idempotency_key: 'nocap' });
    const otherService = await api.message(TOKENS.ci, codexA.binding.id, { content: 'hi', idempotency_key: 'ci' });
    assert(ended.status === 409 && ended.json.error.code === 'session_ended', 'an ended session is session_ended');
    assert(mismatched.status === 409 && mismatched.json.error.code === 'session_not_resumable', 'a session under another runtime is session_not_resumable');
    assert(unknown.status === 404 && same(ungranted.json, unknown.json) && same(noMessageCap.json, unknown.json) && same(otherService.json, unknown.json),
      'unknown, another Agent\'s ungranted, capability-less, and another service\'s sessions are all one session_not_found');
  }

  // -------------------------------------------------------------------
  console.log('\n[4] exchanges: canonical store, grants on every Agent involved, cancel, replay');
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
      if (kind === 'extract') return { output: JSON.stringify({ objective: 'Finish the grants API', decisions: ['Grants are per Agent'], constraints: [], artifacts: [], open_questions: [] }), session: SECRETS.codex };
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

    const toClaude = await api.createExchange(TOKENS.grok, { ...continueBody, idempotency_key: 'cont-claude', destination: { agent_id: claude.id } });
    const toMissing = await api.createExchange(TOKENS.grok, { ...continueBody, idempotency_key: 'cont-missing', destination: { agent_id: 'no-such-agent' } });
    assert(toClaude.status === 404 && same(toClaude.json, toMissing.json), 'a Continue to an ungranted Agent is answered like a missing Agent');
    const fromGrok = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'from-grok-ask', source: { session_ref: claudeS.binding.id }, instruction: 'q' });
    const ciCreate = await api.createExchange(TOKENS.ci, { mode: 'ask', idempotency_key: 'ci-ask', source: { session_ref: claudeS.binding.id }, instruction: 'q' });
    const missingRef = await api.createExchange(TOKENS.ci, { mode: 'ask', idempotency_key: 'ci-missing', source: { session_ref: 'no-such-ref' }, instruction: 'q' });
    assert(fromGrok.status === 404 && ciCreate.status === 404 && same(ciCreate.json, missingRef.json),
      'without exchanges:create on the source Agent the session is answered as missing');
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
    assert((await api.exchanges(TOKENS.ci)).json.items.length === 0, 'ci-bot has no exchanges');

    // Cancellation of an in-flight Ask.
    const held = holdAdapter();
    const ask = await api.createExchange(TOKENS.grok, { mode: 'ask', idempotency_key: 'ask-cancel', source: { session_ref: codexB.binding.id }, instruction: 'Hold on' });
    await waitFor(() => calls.some(c => c.requestId === ask.json.exchange.hops.source.request_id), 'held Ask in its adapter');
    const ciCancel = await api.cancel(TOKENS.ci, ask.json.exchange.id);
    assert(ciCancel.status === 404, 'another service cannot cancel it');
    const cancelResult = await api.cancel(TOKENS.grok, ask.json.exchange.id, { reason: 'not needed' });
    held.release();
    await service.waitForAgentDispatchIdle();
    const afterCancel = await api.exchange(TOKENS.grok, ask.json.exchange.id);
    assert(cancelResult.status === 200 && afterCancel.json.state === 'cancelled' && afterCancel.json.answer === null, 'cancelling an in-flight Ask ends it cancelled with no answer');
    const again = await api.cancel(TOKENS.grok, ask.json.exchange.id);
    assert(again.status === 409 && again.json.error.code === 'exchange_terminal', 'a terminal exchange cannot be cancelled again');
  }

  // -------------------------------------------------------------------
  console.log('\n[4b] every service-visible output is redacted; create-only sees status; audit commits with the mutation');
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

    // exchanges:create without exchanges:read: status metadata only.
    const doc = grantsDoc(agents);
    doc.grants.push({ service: 'other-bot', agent: codex.id, capabilities: ['exchanges:create'] });
    writeGrants(doc);
    const createOnly = await api.createExchange(TOKENS.other, { mode: 'ask', idempotency_key: 'create-only', source: { session_ref: codexB.binding.id }, instruction: `Secret plan ${PROMPT_MARK}` });
    await service.waitForAgentDispatchIdle();
    const createOnlyReplay = await api.createExchange(TOKENS.other, { mode: 'ask', idempotency_key: 'create-only', source: { session_ref: codexB.binding.id }, instruction: `Secret plan ${PROMPT_MARK}` });
    const summaryKeys = ['created_at', 'destination', 'failure', 'id', 'kind', 'mode', 'source', 'state', 'terminal_at', 'updated_at'];
    assert(createOnly.status === 201 && same(Object.keys(createOnly.json.exchange).sort(), summaryKeys), 'a create-only principal gets status metadata on create');
    assert(createOnlyReplay.status === 200 && createOnlyReplay.json.replayed && createOnlyReplay.json.exchange.state === 'completed'
      && same(Object.keys(createOnlyReplay.json.exchange).sort(), summaryKeys)
      && !createOnlyReplay.text.includes('Answer:') && !createOnlyReplay.text.includes(PROMPT_MARK) && !/"answer"|"packet"|"instruction"|"hops"|"events"|conversation_id/.test(createOnlyReplay.text),
    'replaying the create after completion reveals no answer, instruction, hop, or conversation');
    const createOnlyRead = await api.exchange(TOKENS.other, createOnly.json.exchange.id);
    assert(createOnlyRead.status === 404 && (await api.exchanges(TOKENS.other)).json.items.length === 0, 'without exchanges:read the exchange cannot be read or listed');
    const createOnlyCont = await api.createExchange(TOKENS.grok, { mode: 'continue', idempotency_key: 'grok-full', source: { session_ref: codexB.binding.id }, destination: { agent_id: grok.id }, instruction: 'x' });
    assert(createOnlyCont.status === 201 && 'instruction' in createOnlyCont.json.exchange, 'a principal holding exchanges:read still gets the full view on create');
    await service.waitForAgentDispatchIdle();
    const heldOnly = holdAdapter();
    const pendingAsk = await api.createExchange(TOKENS.other, { mode: 'ask', idempotency_key: 'create-only-cancel', source: { session_ref: codexB.binding.id }, instruction: 'hold' });
    const pendingHop = one('SELECT source_request_id FROM session_exchanges WHERE id = ?', pendingAsk.json.exchange.id).source_request_id;
    await waitFor(() => calls.some(c => c.requestId === pendingHop), 'held create-only exchange');
    const cancelOnly = await api.cancel(TOKENS.other, pendingAsk.json.exchange.id);
    heldOnly.release();
    await service.waitForAgentDispatchIdle();
    assert(cancelOnly.status === 200 && same(Object.keys(cancelOnly.json.exchange).sort(), summaryKeys), 'a create-only cancel returns status metadata only');
    writeGrants(grantsDoc(agents));

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
  console.log('\n[5] restart: a second process replays idempotently and re-reads the grants');
  {
    const child = spawnSync(process.execPath, [__filename], {
      env: {
        ...process.env, GRANTS_SCENARIO: 'restart-child',
        GRANTS_IDS: JSON.stringify({
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
  console.log('\n[6] rate limit and rotation');
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
    assert((await api.narrowRequest(TOKENS.grok, hopRequestId)).status === 200, 'fixture: the requesting service reads its exchange hop while granted');
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
    const granted = await hopMessages();
    assert(granted.ask === 2 && granted.dest === 1, 'fixture: while granted its own conversations show the session-message question/answer and the Continue reply');

    // Rotation: removing grok-bot's Codex entry revokes it on the next call.
    const doc = grantsDoc(agents);
    doc.grants = doc.grants.filter(g => !(g.service === 'grok-bot' && g.agent === codex.id));
    writeGrants(doc);
    const revoked = await api.sessions(TOKENS.grok, codex.id);
    const revokedEx = await api.exchange(TOKENS.grok, continueId);
    assert(revoked.status === 404 && revokedEx.status === 404, 'a revoked grant applies on the next call (sessions and exchanges hidden)');
    const revokedHop = await api.narrowRequest(TOKENS.grok, hopRequestId);
    assert(revokedHop.status === 404 && revokedHop.json.error.code === 'request_not_found' && leaks(revokedHop.text).length === 0,
      'the exchange hop request it learned is gone on the next call too (request_not_found)');
    const revokedConv = await hopMessages();
    assert(revokedConv.ask === 0 && revokedConv.dest === 0 && revokedConv.events === 0 && !revokedConv.text.includes(PROMPT_MARK),
      'its own conversations withhold the exchange-written question, answer, and Continue reply on the next call');
    writeGrants(grantsDoc(agents));
    assert((await api.sessions(TOKENS.grok, codex.id)).status === 200, 'rolling the document back restores access');
    assert((await api.narrowRequest(TOKENS.grok, hopRequestId)).status === 200, 'and restores the hop read');
    const restored = await hopMessages();
    assert(restored.ask === 2 && restored.dest === 1, 'and the exchange-written conversation messages');
    fs.rmSync(GRANTS_PATH, { force: true });
    assert((await api.narrowRequest(TOKENS.grok, hopRequestId)).status === 404, 'with no grants document a service reads no exchange hop');
    writeGrants(grantsDoc(agents));

    // The redactor's reference exemption is explicit: a Botmancers id passes,
    // the provider's own run and session ids (whatever their key) do not.
    const { serviceRedactor } = jiti('./lib/service-redaction.ts');
    const shown = serviceRedactor().deep({
      request_id: 'req-1', originConversationId: 'conv-1', sender_id: 'bot-1',
      data: { phase: 'runtime_started', external_run_id: SECRETS.run, externalSessionId: SECRETS.codex, runId: SECRETS.run, resumeSessionId: SECRETS.codexOld },
    });
    assert(shown.request_id === 'req-1' && shown.originConversationId === 'conv-1' && shown.sender_id === 'bot-1', 'Botmancers reference fields are left as they are');
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
    assert(rows.some(r => r.operation === 'agents.read' && r.outcome === 'denied' && r.code === 'not_granted' && r.target_ref === claude.id)
      && rows.some(r => r.operation === 'agents.read' && r.outcome === 'denied' && r.code === 'agent_not_found'),
    'internally the trail tells an ungranted target from a missing one');
    assert(rows.some(r => r.outcome === 'rejected' && r.code === 'authority_not_allowed') && rows.some(r => r.outcome === 'error' && r.code === 'internal_error')
      && rows.some(r => r.code === 'rate_limited') && rows.some(r => r.code === 'grants_unavailable'),
    'validation, internal-error, rate-limit, and grants-unavailable paths are audited');
    assert(rows.some(r => r.target_ref === '[invalid]'), 'a reference that is not a Botmancers id is stored as [invalid]');
    const createRows = rows.filter(r => r.operation === 'exchanges.create');
    const authorityRow = createRows.find(r => r.code === 'authority_not_allowed');
    const deniedRow = createRows.find(r => r.code === 'not_granted');
    const okRow = createRows.find(r => r.outcome === 'allowed');
    assert(authorityRow && authorityRow.target_kind === 'session' && authorityRow.target_ref === codexA.binding.id && authorityRow.agent_id === codex.id,
      'a refused (authority-seeking) create records its source session and owning Agent');
    assert(deniedRow && deniedRow.target_kind === 'session' && deniedRow.target_ref && deniedRow.agent_id,
      'a grant-denied create records its source session and owning Agent');
    assert(okRow && okRow.target_kind === 'exchange' && okRow.target_ref === continueId && okRow.agent_id === codex.id, 'an allowed create records the exchange');
    const msgDenied = rows.find(r => r.operation === 'sessions.message' && r.code === 'not_granted' && r.target_ref === claudeS.binding.id);
    assert(msgDenied && msgDenied.agent_id === claude.id, 'a grant-denied session message records the owning Agent');
    assert(rows.some(r => r.capability === 'participant' && r.operation === 'requests.read' && r.target_ref === message.request_id),
      'narrow /api/v0 reads by a service are audited too');
    const update = (() => { try { raw.prepare("UPDATE service_audit_events SET outcome = 'allowed'").run(); return null; } catch (e) { return e; } })();
    const del = (() => { try { raw.prepare('DELETE FROM service_audit_events').run(); return null; } catch (e) { return e; } })();
    assert(/append-only/.test(update?.message ?? '') && /append-only/.test(del?.message ?? ''), 'audit events cannot be updated or deleted');
    assert(serviceAudit.list({ principal: 'service:ci-bot', limit: 5 }).every(r => r.principal === 'service:ci-bot'), 'the owner can read the trail per principal');
  }

  // -------------------------------------------------------------------
  console.log('\n[8] documentation');
  {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/service-grants.md'), 'utf8');
    assert(/service-grants\.json/.test(doc) && /chmod 600/.test(doc) && /Rotation/i.test(doc) && /Rollback/i.test(doc) && /least[- ]privilege/i.test(doc),
      'docs/service-grants.md covers setup, rotation, rollback, and least-privilege examples');
  }

  console.log(failures === 0 ? '\nAll service grant checks passed.' : `\n${failures} service grant check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

(CHILD ? restartChild() : main()).catch(error => {
  console.error(error);
  process.exit(1);
});
