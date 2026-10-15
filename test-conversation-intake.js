#!/usr/bin/env node
// NOT-465 shared conversation intake test.
//
// Self-contained: isolated SQLite file, a test-only authenticator at the
// /api/v0 boundary, the intake dispatch seam replaced by a spy (so intake
// is proven without launching runtimes), and, for the default-dispatch
// negative checks, a stub UI chat model and a stub Hermes gateway.
//
// Covers: the web UI message route and POST /api/v0/agents/{id}/messages
// reach the same intake seam; equivalent input persists one source event,
// one canonical Work Request, and one intake record; exact and conflicting
// retries on both surfaces; missing conversation, invalid target, and
// transaction failures with one normalized category and no partial rows;
// and no agent_requests tables (NOT-477) or processing_queue rows (API)
// lifecycle rows.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-conversation-intake-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-intake-home-'));
process.env.HOME = HOME_DIR;
process.env.HERMES_API_SERVER_KEY = 'intake-test-key';

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

const db = jiti('./lib/db.ts');
const intake = jiti('./lib/conversation-intake.ts');
const api = jiti('./lib/agent-api.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const agent = jiti('./lib/agent.ts');
const uiRoute = jiti('./app/api/conversations/[id]/messages/route.ts');

const raw = db.default;
const { bots, conversations, groups } = db;

let failures = 0;
function log(line) { console.log(line); }
function assert(condition, label) {
  if (condition) log(`  PASS: ${label}`);
  else { failures++; log(`  FAIL: ${label}`); }
}

const TABLES = ['messages', 'conversations', 'work_requests', 'engine_events', 'conversation_intakes', 'work_attempts', 'processing_queue'];
function counts() {
  const out = {};
  for (const table of TABLES) out[table] = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}
function delta(before, after) {
  const out = {};
  for (const table of TABLES) out[table] = after[table] - before[table];
  return out;
}
function deltaIs(d, expected) {
  return TABLES.every(table => d[table] === (expected[table] ?? 0));
}

function testAuthenticator(request) {
  const header = request.headers.get('x-test-principal');
  if (!header) return null;
  const [kind, ...rest] = header.split(':');
  return { kind, id: rest.join(':') };
}
api.setAgentApiAuthenticator(testAuthenticator);

async function uiPost(conversationId, body, headers = {}) {
  const response = await uiRoute.POST(
    new Request(`http://engine.test/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: conversationId }) }
  );
  return { status: response.status, json: await response.json() };
}

async function apiPost(principal, agentId, body) {
  const response = await api.handleSendAgentMessage(
    new Request(`http://engine.test/api/v0/agents/${agentId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': `${principal.kind}:${principal.id}` },
      body: JSON.stringify(body),
    }),
    agentId
  );
  return { status: response.status, json: await response.json() };
}

function workRequest(id) {
  return raw.prepare('SELECT * FROM work_requests WHERE id = ?').get(id);
}

async function settleUiQueue() {
  for (let i = 0; i < 200; i++) {
    const open = raw.prepare("SELECT COUNT(*) AS n FROM processing_queue WHERE status IN ('pending', 'processing')").get().n;
    if (open === 0) return;
    await agent.processNextQueueItem();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function main() {
  log('NOT-465 shared conversation intake test (isolated DB, spy dispatcher, stub runtimes)');
  log(`DB: ${DB_PATH}`);

  const hermy = bots.create({ deck_id: 'deck-test', name: 'Hermy', title: 'Analyst', description: 'Replies briefly.', agent: 'hermes' });
  const bo = bots.create({ deck_id: 'deck-test', name: 'Bo', title: 'Writer', description: 'Writes briefly.', agent: 'hermes' });
  const direct = conversations.getByBotId(hermy.id);
  const team = groups.create('Team', [hermy.id, bo.id]);
  const teamConversation = conversations.getByGroupId(team.id);
  const service = { kind: 'service', id: 'ci-pipeline' };

  const seen = [];
  intake.setIntakeDispatcher(accepted => { seen.push(accepted); });

  log('\nAC1 both entry points reach the same intake seam');
  let ui;
  let apiFirst;
  let uiDelta;
  let apiDelta;
  {
    let before = counts();
    ui = await uiPost(direct.id, { content: 'explain the module', idempotencyKey: 'ui-1' });
    uiDelta = delta(before, counts());
    before = counts();
    apiFirst = await apiPost(service, hermy.id, { content: 'explain the module', idempotencyKey: 'api-1' });
    apiDelta = delta(before, counts());
    log(`  UI -> ${ui.status} intake=${JSON.stringify(ui.json.intake)}`);
    log(`  API -> ${apiFirst.status} ${JSON.stringify(apiFirst.json)}`);
    log(`  seam calls: ${seen.map(a => `${a.surface}:${a.requestIds.join(',')}:replayed=${a.replayed}`).join(' | ')}`);
    assert(seen.length === 2 && seen[0].surface === 'ui' && seen[1].surface === 'api', 'UI route and /api/v0 both hand their accepted intake to the one intake dispatch seam');
    assert(seen[0].requestIds[0] === ui.json.intake.requestIds[0] && seen[1].requestIds[0] === apiFirst.json.requestId, 'the seam receives the identifiers each entry point returns');
  }

  log('\nAC2 one source event and one canonical Work Request per equivalent intake');
  {
    log(`  UI row delta:  ${JSON.stringify(uiDelta)}`);
    log(`  API row delta: ${JSON.stringify(apiDelta)}`);
    assert(deltaIs(uiDelta, { messages: 1, work_requests: 1, engine_events: 2, conversation_intakes: 1 }), 'UI submission: one message, one Work Request (+accepted, policy_selected events), one intake record, nothing else');
    assert(deltaIs(apiDelta, { messages: 1, conversations: 1, work_requests: 1, engine_events: 2, conversation_intakes: 1 }), 'API submission: one message, one new agent conversation, one Work Request (+accepted, policy_selected events), one intake record, nothing else');

    const uiRequest = workRequest(ui.json.intake.requestIds[0]);
    const apiRequest = workRequest(apiFirst.json.requestId);
    const shape = r => ({ target: r.target_agent_id, intent: r.intent, kind: r.execution_kind, profile: r.tool_profile, state: r.state, depth: r.depth, parent: r.parent_request_id });
    log(`  UI WR:  ${JSON.stringify({ ...shape(uiRequest), requester: `${uiRequest.requester_kind}:${uiRequest.requester_id}`, key: uiRequest.idempotency_key })}`);
    log(`  API WR: ${JSON.stringify({ ...shape(apiRequest), requester: `${apiRequest.requester_kind}:${apiRequest.requester_id}`, key: apiRequest.idempotency_key })}`);
    assert(JSON.stringify(shape(uiRequest)) === JSON.stringify(shape(apiRequest)), 'equivalent UI and API input create the same canonical Work Request (target, intent, conversation/readonly, queued)');
    assert(uiRequest.source_event_id === ui.json.id && ui.json.intake.acceptedMessageId === ui.json.id && uiRequest.source_conversation_id === direct.id, 'UI Work Request names the accepted message as its source event');
    assert(apiRequest.source_event_id === apiFirst.json.acceptedMessageId && apiRequest.source_conversation_id === apiFirst.json.conversationId, 'API Work Request names the accepted message as its source event');
    assert(ui.json.request_id === uiRequest.id && raw.prepare('SELECT request_id FROM messages WHERE id = ?').get(apiFirst.json.acceptedMessageId).request_id === apiRequest.id, 'both source messages reference their Work Request');
    assert(uiRequest.requester_kind === 'person' && uiRequest.requester_id === 'local-owner' && uiRequest.idempotency_key === 'ui:ui-1', 'UI requester is the UI owner; UI keys are namespaced');
    assert(apiRequest.requester_kind === 'service' && apiRequest.idempotency_key === 'api-1' && apiFirst.json.state === 'accepted' && apiFirst.status === 202, 'API keeps its key and documented 202 accepted response');
    const uiEvents = raw.prepare('SELECT type FROM engine_events WHERE request_id = ?').all(uiRequest.id).map(e => e.type);
    const apiEvents = raw.prepare('SELECT type FROM engine_events WHERE request_id = ?').all(apiRequest.id).map(e => e.type);
    assert(uiEvents.join() === 'accepted,policy_selected' && apiEvents.join() === 'accepted,policy_selected', 'both requests start with the same lifecycle and policy events');

    log('  duplicates');
    const before = counts();
    const uiAgain = await uiPost(direct.id, { content: 'explain the module' }, { 'Idempotency-Key': 'ui-1' });
    const apiAgain = await apiPost(service, hermy.id, { content: 'explain the module', idempotencyKey: 'api-1' });
    const afterReplay = counts();
    log(`  UI replay -> ${uiAgain.status} intake=${JSON.stringify(uiAgain.json.intake)}`);
    log(`  API replay -> ${apiAgain.status} ${JSON.stringify(apiAgain.json)}`);
    assert(uiAgain.status === 200 && uiAgain.json.intake.replayed === true && uiAgain.json.id === ui.json.id && uiAgain.json.intake.requestIds[0] === ui.json.intake.requestIds[0], 'UI exact retry replays the original message and request ids');
    assert(apiAgain.status === 200 && apiAgain.json.replayed === true && apiAgain.json.requestId === apiFirst.json.requestId && apiAgain.json.acceptedMessageId === apiFirst.json.acceptedMessageId, 'API exact retry replays the original ids');
    assert(deltaIs(delta(before, afterReplay), {}), `exact retries add no rows (delta ${JSON.stringify(delta(before, afterReplay))})`);

    const uiConflict = await uiPost(direct.id, { content: 'something else', idempotencyKey: 'ui-1' });
    const apiConflict = await apiPost(service, hermy.id, { content: 'something else', idempotencyKey: 'api-1' });
    log(`  UI conflict -> ${uiConflict.status} ${JSON.stringify(uiConflict.json)}; API conflict -> ${apiConflict.status} ${JSON.stringify(apiConflict.json)}`);
    assert(uiConflict.status === 409 && uiConflict.json.code === 'idempotency_conflict', 'UI conflicting retry fails with idempotency_conflict');
    assert(apiConflict.status === 409 && apiConflict.json.error.code === 'idempotency_conflict', 'API conflicting retry fails with idempotency_conflict');
    assert(deltaIs(delta(before, counts()), {}), 'conflicting retries add no rows');

    const fresh = await uiPost(direct.id, { content: 'explain the module' });
    assert(fresh.status === 200 && fresh.json.intake.replayed === false && fresh.json.id !== ui.json.id, 'a UI submission without a key is a distinct submission');

    log('  group fan-out');
    const beforeGroup = counts();
    const fan = await uiPost(teamConversation.id, { content: 'status update, everyone', idempotencyKey: 'ui-group-1' });
    const fanDelta = delta(beforeGroup, counts());
    const keys = fan.json.intake.requestIds.map(id => workRequest(id).idempotency_key).sort();
    log(`  group -> ${fan.status} requests=${fan.json.intake.requestIds.length} keys=${keys.join(',')} delta=${JSON.stringify(fanDelta)}`);
    assert(deltaIs(fanDelta, { messages: 1, work_requests: 2, engine_events: 4, conversation_intakes: 1 }), 'group message: one source event, one Work Request per member, one intake');
    assert(fan.json.intake.requestIds.every(id => workRequest(id).source_event_id === fan.json.id) && fan.json.request_id === null, 'fan-out requests share the one source event');
  }

  log('\nAC3 normalized failures leave no partial rows');
  {
    const before = counts();
    const uiMissing = await uiPost('no-such-conversation', { content: 'hi', idempotencyKey: 'ui-missing' });
    const apiMissing = await apiPost(service, hermy.id, { content: 'hi', conversationId: 'no-such-conversation', idempotencyKey: 'api-missing' });
    log(`  missing conversation: UI -> ${uiMissing.status} ${JSON.stringify(uiMissing.json)}; API -> ${apiMissing.status} ${JSON.stringify(apiMissing.json)}`);
    assert(uiMissing.status === 404 && uiMissing.json.code === 'conversation_not_found' && uiMissing.json.error === 'Conversation not found', 'UI missing conversation: 404 conversation_not_found (legacy error text kept)');
    assert(apiMissing.status === 404 && apiMissing.json.error.code === 'conversation_not_found', 'API missing conversation: 404 conversation_not_found');

    const apiAgentConversation = await apiPost(service, hermy.id, { content: 'hi', conversationId: direct.id, idempotencyKey: 'api-ui-thread' });
    const uiAgentConversation = await uiPost(apiFirst.json.conversationId, { content: 'hi', idempotencyKey: 'ui-agent-thread' });
    assert(uiAgentConversation.status === 404 && uiAgentConversation.json.code === 'conversation_not_found', 'UI cannot write an agent conversation (404, not revealed)');
    assert(apiAgentConversation.status === 404 && apiAgentConversation.json.error.code === 'conversation_not_found', 'API principal outside a UI thread cannot see it');

    const apiBadTarget = await apiPost(service, 'no-such-agent', { content: 'hi', idempotencyKey: 'api-bad-target' });
    log(`  invalid target: API -> ${apiBadTarget.status} ${JSON.stringify(apiBadTarget.json)}`);
    assert(apiBadTarget.status === 404 && apiBadTarget.json.error.code === 'agent_not_found', 'API invalid target: documented 404 agent_not_found');
    let serviceError = null;
    try {
      intake.acceptConversationMessage({
        surface: 'ui', requester: db.UI_OWNER_PRINCIPAL, idempotencyKey: 'ui:bad-target', conversation: { id: teamConversation.id },
        content: 'hi', fingerprint: ['bad'], route: () => ({ deliveries: [{ agentId: hermy.id }, { agentId: 'no-such-agent' }] }), dispatch: () => {},
      });
    } catch (error) {
      serviceError = error;
    }
    log(`  invalid target: service -> ${serviceError && serviceError.code}`);
    assert(serviceError instanceof intake.IntakeError && serviceError.code === 'target_not_found', 'service: a fan-out with one invalid target fails as target_not_found');
    assert(deltaIs(delta(before, counts()), {}), 'missing-conversation and invalid-target failures add no rows');

    log('  transaction failure (injected at the last write of the intake)');
    raw.exec("CREATE TRIGGER test_intake_fault BEFORE INSERT ON conversation_intakes BEGIN SELECT RAISE(ABORT, 'injected intake fault'); END;");
    const seenBefore = seen.length;
    const uiFault = await uiPost(direct.id, { content: 'will roll back', idempotencyKey: 'ui-fault' });
    const apiFault = await apiPost(service, hermy.id, { content: 'will roll back', idempotencyKey: 'api-fault' });
    raw.exec('DROP TRIGGER test_intake_fault');
    log(`  UI -> ${uiFault.status} ${JSON.stringify(uiFault.json)}; API -> ${apiFault.status} ${JSON.stringify(apiFault.json)}`);
    assert(uiFault.status === 500 && uiFault.json.code === 'intake_failed', 'UI transaction failure: 500 intake_failed');
    assert(apiFault.status === 500 && apiFault.json.error.code === 'internal_error' && !JSON.stringify(apiFault.json).includes('injected'), 'API transaction failure: documented 500 internal_error envelope, no internals');
    const afterFault = counts();
    log(`  delta after faults: ${JSON.stringify(delta(before, afterFault))}`);
    assert(deltaIs(delta(before, afterFault), {}), 'rolled back: no message, conversation, Work Request, event, or intake rows remain');
    assert(seen.length === seenBefore, 'nothing is dispatched for a failed intake');

    const retry = await uiPost(direct.id, { content: 'will roll back', idempotencyKey: 'ui-fault' });
    assert(retry.status === 200 && retry.json.intake.replayed === false, 'the same key is accepted normally after a rolled-back attempt');
  }

  log('\nAC4 default dispatch: no agent_requests tables, no processing_queue from the API');
  {
    intake.setIntakeDispatcher(null);
    agent.setDelegationChatStub(() => 'ui loop reply');
    dispatch.setAgentDispatchHermesFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      const last = body.messages[body.messages.length - 1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: `hermes reply to ${last}` } }] }), { status: 200 });
    });

    let before = counts();
    const uiLive = await uiPost(direct.id, { content: 'hello from the UI', idempotencyKey: 'ui-live' });
    const uiQueued = raw.prepare('SELECT conversation_id, bot_id FROM processing_queue ORDER BY rowid DESC LIMIT 1').get();
    const uiLiveDelta = delta(before, counts());
    log(`  UI live -> ${uiLive.status} delta=${JSON.stringify(uiLiveDelta)}`);
    assert(uiLiveDelta.processing_queue === 1 && uiQueued.conversation_id === direct.id && uiQueued.bot_id === hermy.id, 'the UI agent loop receives exactly one turn, derived from the accepted Work Request');
    await settleUiQueue();
    const uiReplay = await uiPost(direct.id, { content: 'hello from the UI', idempotencyKey: 'ui-live' });
    assert(uiReplay.json.intake.replayed === true && raw.prepare('SELECT COUNT(*) AS n FROM processing_queue').get().n === before.processing_queue + 1, 'a UI replay enqueues no second turn');

    // Earlier sections (and the stubbed UI loop) leave accepted work queued.
    // FIFO admission (NOT-475) would run that older work on Hermy first, so
    // it is cancelled before the API turn is measured.
    for (const { id } of raw.prepare("SELECT id FROM work_requests WHERE state = 'queued'").all()) {
      db.engine.transitionWorkRequest(id, { from: 'queued', to: 'cancelled', reason: 'test_cleanup' });
    }
    before = counts();
    const apiLive = await apiPost(service, hermy.id, { content: 'hello from the API', idempotencyKey: 'api-live', wait: true });
    const apiLiveDelta = delta(before, counts());
    log(`  API live -> ${apiLive.status} state=${apiLive.json.state} events=${apiLive.json.events.map(e => e.type).join('>')} delta=${JSON.stringify(apiLiveDelta)}`);
    assert(apiLive.json.state === 'completed' && apiLive.json.reply && apiLive.json.reply.content === 'hermes reply to [From service:ci-pipeline] hello from the API', 'API request completes through the canonical dispatcher');
    assert(apiLiveDelta.processing_queue === 0, 'API submission writes no processing_queue rows');
    assert(apiLiveDelta.work_requests === 1 && apiLiveDelta.work_attempts === 1 && workRequest(apiLive.json.requestId).state === 'completed', 'API lifecycle lives on one Work Request with one Attempt');
    assert(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agent_requests', 'agent_request_events')").get().n === 0, 'NOT-477: no agent_requests lifecycle tables exist after every UI and API submission in this run');
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
