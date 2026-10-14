#!/usr/bin/env node
// NOT-446 runtime-neutral agent conversation API contract test.
//
// Self-contained: isolated SQLite file pre-seeded with pre-NOT-446 UI
// rows, a test-only authenticator injected at the API boundary, a stub
// Hermes gateway at the fetch seam, and a stub `agent-deck` process at the
// run-adapter seam. No dev server, no network, no real runs.
//
// Covers: fail-closed auth and principal mismatch with zero writes, all
// three principal kinds against Hermes and Agent Deck agents, exact-retry
// and conflicting-retry idempotency with row counts, bot-to-bot and
// external-caller histories retrieved after a database reopen in a fresh
// process, typed unavailable/failure envelopes with no credential leak,
// transport acknowledgement not treated as completion, and the legacy UI
// threads readable through the compatibility participants and writable
// through the UI route.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REOPEN = process.argv[2] === '--reopen';

const DB_PATH = REOPEN
  ? process.argv[3]
  : path.join(os.tmpdir(), `botmancers-agent-conversation-api-test-${process.pid}.db`);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

if (REOPEN) {
  // Fresh process, fresh module graph: only what is on disk survives.
  const service = jiti('./lib/agent-conversations.ts');
  const spec = JSON.parse(process.argv[4]);
  const out = spec.map(entry => ({
    label: entry.label,
    conversation: service.getConversation(entry.principal, entry.conversationId),
    requests: entry.requestIds.map(id => service.getAgentRequest(entry.principal, id)),
  }));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-api-home-'));
process.env.HOME = HOME_DIR;
const HERMES_KEY = 'hermes-secret-key-must-not-leak';
process.env.HERMES_API_SERVER_KEY = HERMES_KEY;

// Pre-NOT-446 UI rows written with the old schema before the engine loads.
const LEGACY = {
  botA: '11111111-1111-4111-8111-111111111111',
  botB: '22222222-2222-4222-8222-222222222222',
  group: '33333333-3333-4333-8333-333333333333',
  direct: '44444444-4444-4444-8444-444444444444',
  groupConversation: '55555555-5555-4555-8555-555555555555',
};
{
  const Database = require('better-sqlite3');
  const raw = new Database(DB_PATH);
  raw.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE group_members (group_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (group_id, bot_id));
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, bot_id TEXT, group_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const t = 1700000000000;
  raw.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, NULL, ?)').run(LEGACY.botA, 'Legacy Ada', 'Researcher', 'Answers briefly.', t);
  raw.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, NULL, ?)').run(LEGACY.botB, 'Legacy Bo', 'Writer', 'Writes briefly.', t + 1);
  raw.prepare('INSERT INTO groups VALUES (?, ?, ?)').run(LEGACY.group, 'Legacy team', t + 2);
  raw.prepare('INSERT INTO group_members VALUES (?, ?)').run(LEGACY.group, LEGACY.botA);
  raw.prepare('INSERT INTO group_members VALUES (?, ?)').run(LEGACY.group, LEGACY.botB);
  raw.prepare('INSERT INTO conversations VALUES (?, ?, ?, NULL, ?)').run(LEGACY.direct, 'bot', LEGACY.botA, t);
  raw.prepare('INSERT INTO conversations VALUES (?, ?, NULL, ?, ?)').run(LEGACY.groupConversation, 'group', LEGACY.group, t + 2);
  const msg = raw.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  msg.run('legacy-d1', LEGACY.direct, 'user', null, 'hello Ada', t + 10);
  msg.run('legacy-d2', LEGACY.direct, 'bot', LEGACY.botA, 'hi owner', t + 11);
  msg.run('legacy-g1', LEGACY.groupConversation, 'user', null, '@Legacy Bo draft it', t + 12);
  msg.run('legacy-g2', LEGACY.groupConversation, 'bot', LEGACY.botB, 'drafted', t + 13);
  raw.close();
}

const db = jiti('./lib/db.ts');
const api = jiti('./lib/agent-api.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const deckRun = jiti('./lib/agent-deck-run.ts');

const raw = db.default;
const { bots } = db;

let failures = 0;
function log(line) { console.log(line); }
function assert(condition, label) {
  if (condition) log(`  PASS: ${label}`);
  else { failures++; log(`  FAIL: ${label}`); }
}

// ---- runtime stubs -------------------------------------------------------

const hermesCalls = [];
let hermesMode = 'ok';
dispatch.setAgentDispatchHermesFetch(async (url, init) => {
  const body = JSON.parse(init.body);
  hermesCalls.push({ url, session: init.headers['X-Hermes-Session-Id'], messages: body.messages });
  if (hermesMode === 'http401') {
    return new Response(JSON.stringify({ error: { message: `bad key ${HERMES_KEY} at ${url}` } }), { status: 401 });
  }
  const last = body.messages[body.messages.length - 1].content;
  return new Response(JSON.stringify({ choices: [{ message: { content: `hermes reply #${hermesCalls.length} to ${last}` } }] }), { status: 200 });
});

// NOT-487: canonical Agent Deck turns go through the public run API; the
// fake Agent Deck server captures every start. The CLI seam counts spawns
// and must stay at zero.
const { createFakeAgentDeck } = require('./test-support/fake-agent-deck-api.js');
const deckApi = jiti('./lib/agent-deck-api.ts');
const deckAttempt = jiti('./lib/agent-deck-attempt.ts');
const fakeDeck = createFakeAgentDeck();
process.env.AGENT_DECK_RUN_TOKEN = fakeDeck.token;
deckApi.setAgentDeckApiFetch(fakeDeck.fetch);
deckAttempt.setAgentDeckApiPollIntervalForTests(5);
const deckStarts = [];
let deckMode = 'ok';
let releaseGate = null;
fakeDeck.onStart = body => {
  deckStarts.push(body);
  if (deckMode === 'noend') return { state: 'died' };
  const script = { result: run => `deck reply from ${run.runId}` };
  if (deckMode === 'gate') {
    script.hold = true;
    setImmediate(() => {
      const runId = [...fakeDeck.runs.keys()].pop();
      releaseGate = () => fakeDeck.release(runId);
    });
  }
  return script;
};
let cliSpawns = 0;
deckRun.setDeckRunProcess(async () => {
  cliSpawns += 1;
  return { stdout: '', stderr: 'canonical turns never spawn the agent-deck CLI', exitCode: 1 };
});

// ---- helpers -------------------------------------------------------------

function count(table) {
  return raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}
function counts() {
  return {
    messages: count('messages'),
    requests: count('work_requests'),
    events: count('engine_events'),
    intakes: count('conversation_intakes'),
    legacyRequests: count('agent_requests'),
    conversations: count('conversations'),
    hermesLaunches: hermesCalls.length,
    deckLaunches: deckStarts.length,
  };
}
function sameCounts(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Test-only authenticator: trusts a header the test controls. Production
// installs an operator-approved authenticator instead.
function testAuthenticator(request) {
  const header = request.headers.get('x-test-principal');
  if (!header) return null;
  const [kind, ...rest] = header.split(':');
  return { kind, id: rest.join(':') };
}

function headersFor(principal, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (principal) headers['x-test-principal'] = `${principal.kind}:${principal.id}`;
  return headers;
}

async function post(principal, agentId, body, extraHeaders) {
  const response = await api.handleSendAgentMessage(
    new Request(`http://engine.test/api/v0/agents/${agentId}/messages`, {
      method: 'POST',
      headers: headersFor(principal, extraHeaders),
      body: JSON.stringify(body),
    }),
    agentId
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text), text };
}

async function getRequest(principal, requestId) {
  const response = await api.handleGetAgentRequest(
    new Request(`http://engine.test/api/v0/requests/${requestId}`, { headers: headersFor(principal) }),
    requestId
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text), text };
}

async function getConversation(principal, conversationId) {
  const response = await api.handleGetConversation(
    new Request(`http://engine.test/api/v0/conversations/${conversationId}`, { headers: headersFor(principal) }),
    conversationId
  );
  return { status: response.status, json: await response.json() };
}

async function settle(requestId) {
  await service.startAgentDispatch(requestId);
}

function printHistory(label, view) {
  log(`  ${label}: conversation=${view.conversationId} type=${view.type} origin=${view.origin ? view.origin.kind + ':' + view.origin.id : 'none'}`);
  log(`    participants: ${view.participants.map(p => `${p.kind}:${p.id}`).join(', ')}`);
  for (const m of view.messages) {
    log(`    #${m.seq} [${m.sender.kind}:${m.sender.id}] id=${m.messageId} request=${m.requestId ?? '-'} ${JSON.stringify(m.content)}`);
  }
}

// ---- test ----------------------------------------------------------------

async function main() {
  log('NOT-446 agent conversation API contract test (isolated DB, injected authenticator, stub runtimes)');
  log(`DB: ${DB_PATH}`);

  const hermesAgent = bots.create({ deck_id: 'deck-test', name: 'Hermy', title: 'Analyst', description: 'Replies briefly.', agent: 'hermes' });
  const deckAgent = bots.create({ name: 'Decky', title: 'Coder', description: 'Codes.', agent: 'codex', deck_id: 'deck-api' });
  const teamBot = bots.create({ deck_id: 'deck-test', name: 'Teammate', title: 'Coordinator', description: 'Coordinates.', agent: 'hermes' });
  const unresolvedDeck = bots.create({ name: 'Stale', title: 'Coder', description: 'Old.', agent: 'codex', deck_name: 'old-deck', needs_deck_selection: 1 });

  const person = { kind: 'person', id: 'alice' };
  const service_ = { kind: 'service', id: 'ci-pipeline' };
  const botPrincipal = { kind: 'bot', id: teamBot.id };

  // AC5: fail closed before persistence or launch.
  log('\nAC5 authentication boundary (no rows, no launches on failure)');
  {
    const before = counts();
    const noAuth = await post(person, hermesAgent.id, { content: 'hi', idempotencyKey: 'k-auth' });
    log(`  no authenticator configured -> ${noAuth.status} ${JSON.stringify(noAuth.json)}`);
    assert(noAuth.status === 503 && noAuth.json.error.code === 'authentication_unavailable', 'no authenticator configured fails closed with authentication_unavailable');

    api.setAgentApiAuthenticator(testAuthenticator);
    const unauth = await post(null, hermesAgent.id, { content: 'hi', idempotencyKey: 'k-auth' });
    log(`  unauthenticated -> ${unauth.status} ${JSON.stringify(unauth.json)}`);
    assert(unauth.status === 401 && unauth.json.error.code === 'unauthenticated', 'unauthenticated request fails with unauthenticated');

    const bodyOnly = await post(null, hermesAgent.id, { content: 'hi', idempotencyKey: 'k-auth', principal: person });
    assert(bodyOnly.status === 401 && bodyOnly.json.error.code === 'unauthenticated', 'body-declared principal without authentication is rejected');

    const mismatch = await post(person, hermesAgent.id, { content: 'hi', idempotencyKey: 'k-auth', principal: service_ });
    log(`  principal mismatch -> ${mismatch.status} ${JSON.stringify(mismatch.json)}`);
    assert(mismatch.status === 403 && mismatch.json.error.code === 'principal_mismatch', 'body principal different from authenticated principal fails with principal_mismatch');

    const ghostBot = await post({ kind: 'bot', id: 'no-such-bot' }, hermesAgent.id, { content: 'hi', idempotencyKey: 'k-auth' });
    assert(ghostBot.status === 401 && ghostBot.json.error.code === 'unauthenticated', 'bot principal that is not a registered bot is rejected');

    const unauthRead = await getConversation(null, LEGACY.direct);
    assert(unauthRead.status === 401, 'unauthenticated conversation read is rejected');

    const after = counts();
    log(`  counts before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    assert(sameCounts(before, after), 'zero message, request, event, conversation, and launch records added by rejected requests');
  }

  // AC1: every principal kind against both runtimes, no runtime selected by the caller.
  log('\nAC1 principal kinds x runtimes');
  const firstByPair = {};
  for (const principal of [person, botPrincipal, service_]) {
    for (const target of [hermesAgent, deckAgent]) {
      const key = `open-${principal.kind}-${target.name}`;
      const res = await post(principal, target.id, { content: `hello ${target.name} from ${principal.kind}`, idempotencyKey: key });
      const ok = res.status === 202 && !!res.json.conversationId && !!res.json.requestId && !!res.json.acceptedMessageId;
      assert(ok, `${principal.kind} -> ${target.name}: 202 with conversation/request/accepted-message ids`);
      assert(!('runtime' in res.json), `${principal.kind} -> ${target.name}: response does not expose runtime selection`);
      await settle(res.json.requestId);
      const view = await getRequest(principal, res.json.requestId);
      log(`  ${principal.kind}:${principal.id} -> ${target.name}: conversation=${res.json.conversationId} request=${res.json.requestId} accepted=${res.json.acceptedMessageId} state=${view.json.state} reply=${JSON.stringify(view.json.reply && view.json.reply.content)}`);
      assert(view.json.state === 'completed' && view.json.reply && view.json.reply.content.length > 0, `${principal.kind} -> ${target.name}: reply retrievable and completed`);
      firstByPair[`${principal.kind}-${target.name}`] = { ...res.json, key, content: `hello ${target.name} from ${principal.kind}`, agentId: target.id, principal };
    }
  }
  assert(hermesCalls.length === 3 && deckStarts.length === 3, `runtime-neutral dispatch: 3 Hermes turns and 3 Agent Deck runs (got ${hermesCalls.length}/${deckStarts.length})`);
  // NOT-462: the direct dispatchDeckRun() conversation turn is not the
  // composite implementation workflow; it stays read-only.
  assert(
    deckStarts.length > 0 && deckStarts.every(body => body.tools === 'readonly' && !body.resumeSessionId && !body.prepareFinalization) && cliSpawns === 0,
    `direct Agent Deck conversation turns launch through the API with tools readonly and no finalization (got ${deckStarts.map(body => body.tools).join(',')}, cli spawns ${cliSpawns})`
  );
  assert(hermesCalls.every(call => !call.url.includes(HERMES_KEY)), 'Hermes adapter used its own configured credentials');
  // NOT-465: requests are canonical Work Requests; the launch Attempt
  // records the dispatched agent and agent_requests is never written.
  const dispatchedAgents = raw.prepare("SELECT DISTINCT adapter FROM work_attempts ORDER BY adapter").all().map(row => row.adapter);
  assert(JSON.stringify(dispatchedAgents) === JSON.stringify(['codex', 'hermes']), `requests record the dispatched agent identity, never Agent Deck (got ${dispatchedAgents.join(',')})`);
  assert(count('agent_requests') === 0 && count('agent_request_events') === 0 && count('processing_queue') === 0, 'API acceptance writes no agent_requests or processing_queue rows');

  // AC2: idempotency.
  log('\nAC2 idempotency');
  {
    const first = firstByPair['service-Hermy'];
    const before = counts();
    const retry = await post(service_, hermesAgent.id, { content: first.content, idempotencyKey: first.key });
    const afterRetry = counts();
    log(`  exact retry -> ${retry.status} ${JSON.stringify(retry.json)}`);
    log(`  counts before=${JSON.stringify(before)} after exact retry=${JSON.stringify(afterRetry)}`);
    assert(retry.status === 200 && retry.json.replayed === true, 'exact retry returns 200 replayed');
    assert(retry.json.requestId === first.requestId && retry.json.conversationId === first.conversationId && retry.json.acceptedMessageId === first.acceptedMessageId, 'exact retry returns the original identifiers');
    assert(retry.json.state === 'completed', 'exact retry reports the original result state');
    await service.startAgentDispatch(retry.json.requestId);
    assert(sameCounts(before, counts()), 'exact retry adds no message, request, event, or run');

    const headerRetry = await post(service_, hermesAgent.id, { content: first.content }, { 'Idempotency-Key': first.key });
    assert(headerRetry.status === 200 && headerRetry.json.requestId === first.requestId, 'Idempotency-Key header is the same key as the body field');

    const conflict = await post(service_, hermesAgent.id, { content: 'a different payload', idempotencyKey: first.key });
    const afterConflict = counts();
    log(`  conflicting retry -> ${conflict.status} ${JSON.stringify(conflict.json)}`);
    log(`  counts after conflicting retry=${JSON.stringify(afterConflict)}`);
    assert(conflict.status === 409 && conflict.json.error.code === 'idempotency_conflict', 'same key with different payload fails with idempotency_conflict');
    assert(sameCounts(before, afterConflict), 'conflicting retry adds no message, request, event, or run');

    const otherPrincipal = await post(person, hermesAgent.id, { content: 'a different payload', idempotencyKey: first.key });
    assert(otherPrincipal.status === 202, 'idempotency keys are scoped per principal');
    await settle(otherPrincipal.json.requestId);
  }

  // AC3: bot-to-bot and external-caller histories, continued, then reopened.
  log('\nAC3 bot-to-bot and external-caller histories');
  const teamFirst = firstByPair['bot-Hermy'];
  const teamSecond = await post(botPrincipal, hermesAgent.id, { content: 'second team turn', conversationId: teamFirst.conversationId, idempotencyKey: 'team-2' });
  assert(teamSecond.status === 202 && teamSecond.json.conversationId === teamFirst.conversationId, 'bot continues the same team conversation');
  await settle(teamSecond.json.requestId);
  const lastHermes = hermesCalls[hermesCalls.length - 1];
  assert(lastHermes.messages.some(m => m.role === 'assistant') && lastHermes.messages.some(m => m.content.includes(`hello Hermy from bot`)), 'continued turn sends the durable prior history to the runtime');

  const extFirst = firstByPair['service-Decky'];
  const extSecond = await post(service_, deckAgent.id, { content: 'second external turn', conversationId: extFirst.conversationId, idempotencyKey: 'ext-2' });
  await settle(extSecond.json.requestId);
  const joinThird = await post(service_, hermesAgent.id, { content: 'Hermy, review Decky', conversationId: extFirst.conversationId, idempotencyKey: 'ext-3' });
  await settle(joinThird.json.requestId);

  const team = (await getConversation(botPrincipal, teamFirst.conversationId)).json;
  const ext = (await getConversation(service_, extFirst.conversationId)).json;
  printHistory('team (bot origin)', team);
  printHistory('external (service origin)', ext);
  assert(team.type === 'agent' && team.origin.kind === 'bot' && team.origin.id === teamBot.id, 'team conversation origin bound to the calling bot');
  assert(team.participants.map(p => p.kind).join(',') === 'bot,bot', 'team conversation participants are both bots');
  assert(team.messages.map(m => m.sender.kind).join(',') === 'bot,bot,bot,bot', 'team history: caller bot, agent, caller bot, agent');
  assert(team.messages[0].sender.id === teamBot.id && team.messages[1].sender.id === hermesAgent.id, 'team history sender identities are explicit');
  assert(ext.origin.kind === 'service' && ext.participants.map(p => `${p.kind}:${p.id}`).join(',') === `service:ci-pipeline,bot:${deckAgent.id},bot:${hermesAgent.id}`, 'external conversation origin and participants (agent joined on address)');
  assert(ext.messages.length === 6 && ext.messages.every((m, i) => m.seq === i + 1), 'external history ordered with stable sequence');

  const forbidden = await getConversation(person, teamFirst.conversationId);
  assert(forbidden.status === 404 && forbidden.json.error.code === 'conversation_not_found', 'non-participant cannot read the team conversation');

  log('\n  reopening the database in a fresh process');
  const spec = [
    { label: 'team', principal: botPrincipal, conversationId: team.conversationId, requestIds: [teamFirst.requestId, teamSecond.json.requestId] },
    { label: 'external', principal: service_, conversationId: ext.conversationId, requestIds: [extFirst.requestId, extSecond.json.requestId, joinThird.json.requestId] },
  ];
  const reopened = JSON.parse(execFileSync(process.execPath, [__filename, '--reopen', DB_PATH, JSON.stringify(spec)], { encoding: 'utf8' }));
  for (const entry of reopened) {
    printHistory(`${entry.label} after reopen`, entry.conversation);
    for (const request of entry.requests) {
      log(`    request ${request.requestId} state=${request.state} reply=${request.reply ? request.reply.messageId : '-'} events=${request.events.map(e => e.type).join('>')}`);
    }
  }
  const [teamAfter, extAfter] = reopened;
  assert(JSON.stringify(teamAfter.conversation) === JSON.stringify(team), 'team history identical after reopen (ids, participants, order, content)');
  assert(JSON.stringify(extAfter.conversation) === JSON.stringify(ext), 'external history identical after reopen (ids, participants, order, content)');
  assert([...teamAfter.requests, ...extAfter.requests].every(r => r.state === 'completed' && r.reply && r.events.map(e => e.type).join('>') === 'accepted>dispatched>runtime_started>completed'), 'runtime-neutral result state and events durable after reopen');

  log('\nPhase 1 done; failure and compatibility fixtures follow.');
  return phaseTwo({ hermesAgent, deckAgent, unresolvedDeck, person, service_, agentConversationId: team.conversationId });
}

async function phaseTwo(ctx) {
  const agent = jiti('./lib/agent.ts');
  const uiRoute = jiti('./app/api/conversations/[id]/messages/route.ts');
  const uiIdRoutes = {
    conversation: jiti('./app/api/conversations/[id]/route.ts'),
    draft: jiti('./app/api/conversations/[id]/draft/route.ts'),
    stop: jiti('./app/api/conversations/[id]/stop/route.ts'),
    approve: jiti('./app/api/conversations/[id]/approve/route.ts'),
    deny: jiti('./app/api/conversations/[id]/deny/route.ts'),
  };
  return phaseTwoRun(ctx, { db, api, service, agent, uiRoute, uiIdRoutes });
}

async function phaseTwoRun(ctx, m) {
  const raw2 = m.db.default;
  const { hermesAgent, deckAgent, unresolvedDeck, person } = ctx;
  const hermesBase = hermesCalls.length;
  const deckBase = deckStarts.length;
  const hermes2 = { get length() { return hermesCalls.length - hermesBase; } };
  const deck2 = { get length() { return deckStarts.length - deckBase; } };

  async function post2(principal, agentId, body) {
    const response = await m.api.handleSendAgentMessage(
      new Request(`http://engine.test/api/v0/agents/${agentId}/messages`, { method: 'POST', headers: headersFor(principal), body: JSON.stringify(body) }),
      agentId
    );
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text), text };
  }
  async function getRequest2(principal, requestId) {
    const response = await m.api.handleGetAgentRequest(new Request(`http://engine.test/api/v0/requests/${requestId}`, { headers: headersFor(principal) }), requestId);
    const text = await response.text();
    return { status: response.status, json: JSON.parse(text), text };
  }
  const replyCount = requestId => raw2.prepare("SELECT COUNT(*) AS n FROM messages WHERE request_id = ? AND sender_kind = 'bot'").get(requestId).n;

  // AC4: typed unavailable / failure envelopes, no credential leak, ack != completion.
  log('\nAC4 typed failures through the selected runtime');
  {
    delete process.env.HERMES_API_SERVER_KEY;
    const res = await post2(person, hermesAgent.id, { content: 'are you there', idempotencyKey: 'fail-hermes-off', wait: true });
    log(`  Hermes unconfigured -> ${res.status} state=${res.json.state} failure=${JSON.stringify(res.json.failure)}`);
    assert(res.json.state === 'failed' && res.json.failure.code === 'agent_unavailable', 'Hermes agent without gateway config fails with agent_unavailable');
    assert(replyCount(res.json.requestId) === 0 && hermes2.length === 0, 'no reply message and no Hermes call when unavailable');
    process.env.HERMES_API_SERVER_KEY = HERMES_KEY;

    hermesMode = 'http401';
    const rejected = await post2(person, hermesAgent.id, { content: 'try again', idempotencyKey: 'fail-hermes-401', wait: true });
    hermesMode = 'ok';
    const fetched = await getRequest2(person, rejected.json.requestId);
    log(`  Hermes rejects -> state=${rejected.json.state} failure=${JSON.stringify(rejected.json.failure)}`);
    assert(rejected.json.state === 'failed' && rejected.json.failure.code === 'runtime_failed', 'Hermes gateway rejection fails with runtime_failed');
    assert(!rejected.text.includes(HERMES_KEY) && !fetched.text.includes(HERMES_KEY) && !fetched.text.includes('127.0.0.1'), 'failure envelope exposes no adapter credential or endpoint');

    const stale = await post2(person, unresolvedDeck.id, { content: 'build it', idempotencyKey: 'fail-deck-stale', wait: true });
    log(`  Agent Deck without deck selection -> state=${stale.json.state} failure=${JSON.stringify(stale.json.failure)}`);
    assert(stale.json.state === 'failed' && stale.json.failure.code === 'agent_unavailable' && deck2.length === 0, 'Agent Deck agent without a launchable deck fails with agent_unavailable and launches nothing');

    deckMode = 'noend';
    const noend = await post2(person, deckAgent.id, { content: 'build it', idempotencyKey: 'fail-deck-noend', wait: true });
    deckMode = 'ok';
    log(`  Agent Deck acked but no end event -> state=${noend.json.state} failure=${JSON.stringify(noend.json.failure)} events=${noend.json.events.map(e => e.type).join('>')}`);
    assert(noend.json.state === 'failed' && noend.json.failure.code === 'runtime_failed' && replyCount(noend.json.requestId) === 0, 'launch acknowledgement without a terminal event (run died) is a failure, not completion');

    deckMode = 'gate';
    const gated = await post2(person, deckAgent.id, { content: 'long task', idempotencyKey: 'deck-gated' });
    const running = m.service.startAgentDispatch(gated.json.requestId);
    for (let i = 0; i < 50 && !releaseGate; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const mid = await getRequest2(person, gated.json.requestId);
    log(`  Agent Deck acked, run still going -> state=${mid.json.state} events=${mid.json.events.map(e => e.type).join('>')} reply=${JSON.stringify(mid.json.reply)}`);
    assert(mid.json.state === 'dispatched' && mid.json.reply === null && mid.json.events.some(e => e.type === 'runtime_started'), 'transport acknowledgement leaves the request dispatched with no reply');
    releaseGate();
    deckMode = 'ok';
    await running;
    const done = await getRequest2(person, gated.json.requestId);
    log(`  Agent Deck end event -> state=${done.json.state} reply=${JSON.stringify(done.json.reply && done.json.reply.content)}`);
    assert(done.json.state === 'completed' && done.json.reply.content.startsWith('deck reply from run-'), 'request completes only after the run end event');

    const missingAgent = await post2(person, 'no-such-agent', { content: 'hi', idempotencyKey: 'missing-agent' });
    assert(missingAgent.status === 404 && missingAgent.json.error.code === 'agent_not_found', 'unknown agent fails with agent_not_found');
    const badBody = await post2(person, hermesAgent.id, { content: '', idempotencyKey: 'empty' });
    assert(badBody.status === 400 && badBody.json.error.code === 'invalid_request', 'empty content fails with invalid_request');
    const noKey = await post2(person, hermesAgent.id, { content: 'hi' });
    assert(noKey.status === 400 && noKey.json.error.code === 'invalid_request', 'missing idempotency key fails with invalid_request');
  }

  // AC6 (compat slice): legacy UI threads after migration.
  log('\nAC6 legacy UI threads through the compatibility path');
  {
    const owner = m.db.UI_OWNER_PRINCIPAL;
    const direct = await m.api.handleGetConversation(new Request('http://engine.test/x', { headers: headersFor(owner) }), LEGACY.direct);
    const directView = await direct.json();
    printHistory('legacy direct', directView);
    assert(directView.type === 'direct' && directView.origin.id === owner.id, 'legacy direct thread bound to the UI owner origin');
    assert(directView.participants.map(p => `${p.kind}:${p.id}`).join(',') === `person:local-owner,bot:${LEGACY.botA}`, 'legacy direct thread participants backfilled');
    assert(directView.messages.map(x => x.messageId).join(',') === 'legacy-d1,legacy-d2', 'legacy direct messages kept in place and order');
    assert(directView.messages[0].sender.kind === 'person' && directView.messages[1].sender.id === LEGACY.botA, 'legacy direct sender kinds backfilled');

    const group = await m.api.handleGetConversation(new Request('http://engine.test/x', { headers: headersFor(owner) }), LEGACY.groupConversation);
    const groupView = await group.json();
    printHistory('legacy group', groupView);
    assert(groupView.type === 'group' && groupView.participants.length === 3, 'legacy group thread participants are owner plus members');

    const memberRead = await m.api.handleGetConversation(new Request('http://engine.test/x', { headers: headersFor({ kind: 'bot', id: LEGACY.botB }) }), LEGACY.groupConversation);
    assert(memberRead.status === 200, 'a group member bot can read its group thread');

    const write = await post2(owner, LEGACY.botA, { content: 'via api', conversationId: LEGACY.direct, idempotencyKey: 'legacy-write' });
    assert(write.status === 409 && write.json.error.code === 'conversation_not_writable', 'agent API does not write into UI threads (UI route stays their writer)');

    m.agent.setDelegationChatStub(() => 'ui loop reply');
    const before = raw2.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(LEGACY.direct).n;
    const uiPost = await m.uiRoute.POST(
      new Request(`http://engine.test/api/conversations/${LEGACY.direct}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'still works?' }) }),
      { params: Promise.resolve({ id: LEGACY.direct }) }
    );
    for (let i = 0; i < 40 && await m.agent.processNextQueueItem(); i++) { /* drain */ }
    const uiGet = await m.uiRoute.GET(new Request(`http://engine.test/api/conversations/${LEGACY.direct}/messages`), { params: Promise.resolve({ id: LEGACY.direct }) });
    const uiMessages = await uiGet.json();
    log(`  UI route POST -> ${uiPost.status}; thread now: ${uiMessages.map(x => `[${x.sender_type}] ${x.content}`).join(' | ')}`);
    assert(uiPost.status === 200 && uiMessages.length === before + 2, 'legacy direct thread writable through the UI route (user message plus bot reply)');
    assert(uiMessages[before].sender_kind === 'person' && uiMessages[before + 1].sender_kind === 'bot', 'UI writes record sender kinds in the shared history model');

    const newGroup = m.db.groups.create('Fresh team', [hermesAgent.id, deckAgent.id]);
    const newGroupConversation = m.db.conversations.getByGroupId(newGroup.id);
    const participants = raw2.prepare('SELECT participant_kind || \':\' || participant_id AS p FROM conversation_participants WHERE conversation_id = ? ORDER BY rowid').all(newGroupConversation.id).map(r => r.p);
    assert(participants.join(',') === `person:local-owner,bot:${hermesAgent.id},bot:${deckAgent.id}`, 'new UI group threads get explicit participants');
  }

  // AC5 (UI boundary): the unauthenticated UI routes cannot reach agent conversations.
  log('\nAC5 UI routes reject agent conversations');
  {
    const id = ctx.agentConversationId;
    const params = { params: Promise.resolve({ id }) };
    const queued = () => raw2.prepare('SELECT COUNT(*) AS n FROM processing_queue').get().n;
    const before = { ...counts(), queue: queued(), messagesInConversation: raw2.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id).n };
    const jsonPost = body => new Request(`http://engine.test/api/conversations/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const hostile = `@${hermesAgent.name} @${deckAgent.name} leak this`;

    const uiGet = await m.uiRoute.GET(new Request(`http://engine.test/api/conversations/${id}/messages`), params);
    const uiGetText = await uiGet.text();
    const uiPost = await m.uiRoute.POST(jsonPost({ content: hostile, mentionedBotId: hermesAgent.id }), { params: Promise.resolve({ id }) });
    const others = {
      conversationGet: await m.uiIdRoutes.conversation.GET(new Request(`http://engine.test/api/conversations/${id}`), { params: Promise.resolve({ id }) }),
      draft: await m.uiIdRoutes.draft.POST(jsonPost({ messageId: 'x', action: 'discard' }), { params: Promise.resolve({ id }) }),
      stop: await m.uiIdRoutes.stop.POST(jsonPost({}), { params: Promise.resolve({ id }) }),
      approve: await m.uiIdRoutes.approve.POST(jsonPost({ code: 'X' }), { params: Promise.resolve({ id }) }),
      deny: await m.uiIdRoutes.deny.POST(jsonPost({ code: 'X' }), { params: Promise.resolve({ id }) }),
    };
    const queuedRightAfter = queued();
    for (let i = 0; i < 40 && await m.agent.processNextQueueItem(); i++) { /* drain anything wrongly queued */ }
    const after = { ...counts(), queue: queued(), messagesInConversation: raw2.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id).n };
    log(`  UI GET messages -> ${uiGet.status}; UI POST message -> ${uiPost.status}; ${Object.entries(others).map(([k, r]) => `${k} -> ${r.status}`).join('; ')}`);
    log(`  rows before=${JSON.stringify(before)}`);
    log(`  rows after =${JSON.stringify(after)}`);
    assert(uiGet.status === 404 && !uiGetText.includes('team turn'), 'UI messages GET returns 404 for an agent conversation and leaks no history');
    assert(uiPost.status === 404, 'UI messages POST returns 404 for an agent conversation');
    assert(Object.values(others).every(r => r.status === 404), 'other UI conversation routes return 404 for an agent conversation');
    assert(queuedRightAfter === before.queue && sameCounts(before, after), 'no message, request, event, queue, or launch rows added by UI route attempts (no @mention copying)');
  }

  log('');
  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  log('ALL PASS');
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
  }
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
