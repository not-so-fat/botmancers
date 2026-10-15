#!/usr/bin/env node
// NOT-470: conversation projection of Wake and Work Request lifecycle
// events (lib/conversation-projection).
//
// Proves: accepted and blocked Wakes and queued/running/completed/failed/
// cancelled/waiting requests, questions, results, and artifacts project
// into typed conversation_events rows carrying request, attempt, Wake, and
// engine event ids with machine-readable data; transport acceptance
// (runtime_started) projects as running and completed success requires a
// terminal succeeded Attempt; replay and redelivery write nothing new,
// also from a fresh process that reopens the database, and a rebuild from
// the same engine events yields the same projection; interleaved requests
// keep their own order; the UI conversation read and /api/v0 return the
// same projection; legacy history stays readable. Self-contained:
// isolated SQLite file, fake adapter, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SCENARIO = process.env.PROJECTION_SCENARIO || 'main';
const DB_PATH = process.env.PROJECTION_DB || path.join(os.tmpdir(), `botmancers-projection-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
if (SCENARIO === 'main') removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-projection-home-'));
delete process.env.HERMES_API_SERVER_KEY;

const Database = require('better-sqlite3');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}

const db = jiti('./lib/db.ts');
const raw = db.default;
const { bots, conversations, messages, engine, projector, UI_OWNER_PRINCIPAL } = db;

function rowCount(conversationId) {
  return raw.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(conversationId).n;
}
function kindsOf(views, requestId) {
  return views.filter(view => view.requestId === requestId).map(view => view.kind);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

if (SCENARIO === 'reopen') runReopen();
else runMain().catch(error => { console.error(error); process.exit(1); });

async function runMain() {
  const router = jiti('./lib/wake-router.ts');
  const executor = jiti('./lib/attempt-executor.ts');
  const api = jiti('./lib/agent-api.ts');
  const uiRoute = jiti('./app/api/conversations/[id]/route.ts');
  const engineStore = jiti('./lib/engine-store.ts');

  router.setWakeAvailabilityProbe(() => ({ available: true }));
  const tank = bots.create({ deck_id: 'deck-tank', name: 'Tank', title: 'Coordinator', description: 'Coordinates.', agent: 'hermes' });
  const dev = bots.create({ deck_id: 'deck-dev', name: 'Dev', title: 'Developer', description: 'Implements.', agent: 'claude' });
  bots.create({ name: 'Idle', title: 'Idle', description: 'No deck yet.', agent: 'cursor' });
  const conversation = conversations.getByBotId(tank.id);

  const ask = messages.create(conversation.id, 'user', 'Implement notifications.');
  const { request: root } = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id, sourceEventId: ask.id,
    requester: { kind: 'person', id: 'local-owner' }, targetAgentId: tank.id,
    intent: ask.content, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'ask-1',
  });
  // NOT-475: the owner already allowed Tank's edit Wakes to Dev.
  const safety = jiti('./lib/wake-safety.ts');
  safety.ensureEditGrant({ callerAgentId: tank.id, targetAgentId: dev.id, grantedBy: safety.OWNER_PRINCIPAL, sourceWakeId: null, now: Date.now() });

  console.log('Wake accepted and blocked');
  const block = envelope => '```botmancers-wake\n' + JSON.stringify(envelope) + '\n```';
  const reply = messages.create(conversation.id, 'bot', [
    block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Add notifications.' }),
    block({ version: 1, target: 'Idle', executionKind: 'review', objective: 'Review notifications.' }),
  ].join('\n'), tank.id);
  const routed = router.routeAgentWakes({ sourceEventId: reply.id, parentRequestId: root.id });
  const accepted = routed[0];
  const blocked = routed[1];
  assert(accepted.wake.status === 'accepted' && blocked.wake.status === 'blocked', 'one accepted and one blocked Wake');
  let views = projector.listConversationEvents(conversation.id);
  const wakeAccepted = views.find(view => view.kind === 'wake_accepted');
  assert(!!wakeAccepted && wakeAccepted.requestId === accepted.request.id && wakeAccepted.wakeId === accepted.wake.id, 'wake_accepted names its request and Wake');
  assert(wakeAccepted.data.target_agent_id === dev.id && wakeAccepted.data.target_name === 'Dev' && wakeAccepted.data.execution_kind === 'implementation' && wakeAccepted.data.tool_profile === 'edit', 'wake_accepted data carries target, kind, and authority');
  assert(wakeAccepted.data.parent_request_id === root.id && wakeAccepted.data.requester_id === tank.id, 'wake_accepted data carries lineage and requester');
  assert(wakeAccepted.state === 'queued' && wakeAccepted.text === 'Wake accepted: Dev (implementation)', 'wake_accepted state and text');
  const firstAccepted = engine.listEvents(accepted.request.id)[0];
  assert(wakeAccepted.engineEventId === firstAccepted.id && wakeAccepted.requestSequence === 1, 'wake_accepted names its source engine event and sequence');
  assert(kindsOf(views, blocked.request.id).join(',') === 'wake_blocked', 'blocked Wake projects only wake_blocked (never accepted)');
  const wakeBlocked = views.find(view => view.kind === 'wake_blocked');
  assert(wakeBlocked.state === 'blocked' && wakeBlocked.wakeId === blocked.wake.id && wakeBlocked.data.reason_code === 'target_unconfigured' && wakeBlocked.text === 'Wake blocked: Idle — Idle has no Agent Deck selected.' && wakeBlocked.data.actions.length === 0, 'wake_blocked carries the persisted reason');
  assert(kindsOf(views, root.id).join(',') === 'request_queued', 'person request projects as request_queued');

  console.log('Stored metadata');
  const stored = raw.prepare('SELECT * FROM conversation_events WHERE id = ?').get(wakeAccepted.eventId);
  assert(stored.id === `${firstAccepted.id}:0` && stored.engine_event_id === firstAccepted.id && stored.part === 0, 'row id derives from engine event id and part');
  assert(stored.request_id === accepted.request.id && stored.wake_id === accepted.wake.id && stored.conversation_id === conversation.id, 'row stores request, Wake, and conversation ids');
  assert(JSON.parse(stored.data).target_agent_id === dev.id && stored.text !== stored.data, 'machine-readable data is stored apart from text');
  let threw = false;
  try { raw.prepare("UPDATE conversation_events SET text = 'x' WHERE id = ?").run(stored.id); } catch { threw = true; }
  assert(threw, 'projected rows are immutable');

  console.log('Transport acceptance is running, not success');
  const work = accepted.request;
  engine.transitionWorkRequest(work.id, { from: 'queued', to: 'running' });
  const release = deferred();
  const started = deferred();
  const adapter = {
    name: 'agent-deck',
    async run(input, emit) {
      emit({ type: 'started', adapter: 'agent-deck', at: Date.now(), externalRunId: 'run-77', externalSessionId: null });
      started.resolve();
      await release.promise;
      return {
        status: 'completed', adapter: 'agent-deck', externalRunId: 'run-77', externalSessionId: 'sess-77',
        output: 'Notifications added.', artifacts: [{ kind: 'file', ref: 'lib/notify.ts' }, { kind: 'commit', ref: 'abc123' }],
        startedAt: Date.now(), finishedAt: Date.now(), failure: null,
      };
    },
  };
  const attemptInput = {
    target: { agentId: dev.id }, deck: 'deck-dev', cwd: null, toolProfile: 'edit',
    prompt: { kind: 'text', text: 'Add notifications.' }, correlation: { conversationId: conversation.id },
  };
  const prepared = executor.beginAttempt(engine, work.id, { agent: 'claude', adapter, input: attemptInput });
  const running = executor.runAttempt(engine, prepared, adapter, {
    project: () => {
      const replyId = messages.create(conversation.id, 'bot', 'Notifications added.', dev.id).id;
      engine.transitionWorkRequest(work.id, { from: 'running', to: 'completed', result: { reply_message_id: replyId } });
      return replyId;
    },
  });
  await started.promise;
  views = projector.listConversationEvents(conversation.id);
  const midKinds = kindsOf(views, work.id);
  assert(midKinds.join(',') === 'wake_accepted,request_running,request_running', 'dispatch and transport acceptance both project as request_running');
  const transport = views.find(view => view.requestId === work.id && view.data.phase === 'runtime_started');
  assert(!!transport && transport.attemptId === prepared.attempt.id && transport.data.external_run_id === 'run-77' && transport.data.success === false, 'runtime_started is running with attempt id and run id, success false');
  assert(!views.some(view => view.requestId === work.id && (view.kind === 'request_completed' || view.kind === 'result' || view.data.success === true)), 'no success or result before a terminal Attempt outcome');
  release.resolve();
  const done = await running;
  views = projector.listConversationEvents(conversation.id);
  assert(kindsOf(views, work.id).join(',') === 'wake_accepted,request_running,request_running,artifact,artifact,request_completed,result', 'terminal Attempt projects artifacts, completion, and result in order');
  const completed = views.find(view => view.requestId === work.id && view.kind === 'request_completed');
  assert(completed.data.success === true && completed.data.outcome === 'succeeded' && completed.attemptId === prepared.attempt.id && completed.state === 'completed', 'completed success names the succeeded Attempt');
  const result = views.find(view => view.requestId === work.id && view.kind === 'result');
  assert(result.text === 'Notifications added.' && result.data.reply_message_id === done.projected && result.attemptId === prepared.attempt.id, 'result carries the output and reply message id');
  const artifacts = views.filter(view => view.requestId === work.id && view.kind === 'artifact');
  assert(artifacts.length === 2 && artifacts[0].data.ref === 'lib/notify.ts' && artifacts[0].data.artifact_kind === 'file' && artifacts[1].data.ref === 'abc123', 'artifact references are projected in order');
  assert(artifacts.every(view => view.attemptId === prepared.attempt.id) && artifacts[0].text === 'Artifact (file): lib/notify.ts', 'artifact rows name the Attempt and render text');

  console.log('Completed without a terminal Attempt outcome');
  const bare = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id, sourceEventId: ask.id, requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: dev.id, intent: 'bare', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'bare-1',
  }).request;
  engine.transitionWorkRequest(bare.id, { from: 'queued', to: 'running' });
  engine.transitionWorkRequest(bare.id, { from: 'running', to: 'completed', result: { reply_message_id: null } });
  const failedFirst = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id, sourceEventId: ask.id, requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: dev.id, intent: 'failed-first', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'failed-first-1',
  }).request;
  engine.transitionWorkRequest(failedFirst.id, { from: 'queued', to: 'running' });
  const failedAttempt = engine.createAttempt(failedFirst.id, { kind: 'launch', adapter: 'claude', toolProfile: 'readonly', launchSnapshot: { a: 1 } });
  engine.finishAttempt(failedAttempt.id, { outcome: 'failed', errorCategory: 'runtime_failed', errorMessage: 'boom' });
  engine.transitionWorkRequest(failedFirst.id, { from: 'running', to: 'completed' });
  views = projector.listConversationEvents(conversation.id);
  const bareDone = views.find(view => view.requestId === bare.id && view.kind === 'request_completed');
  assert(bareDone.data.success === false && bareDone.data.outcome === null && bareDone.attemptId === null, 'completed with no Attempt is not success');
  const failedDone = views.find(view => view.requestId === failedFirst.id && view.kind === 'request_completed');
  assert(failedDone.data.success === false && failedDone.data.outcome === 'failed', 'completed after a failed Attempt is not success');
  assert(!views.some(view => (view.requestId === bare.id || view.requestId === failedFirst.id) && view.kind === 'result'), 'no result without a succeeded Attempt');

  console.log('Failure, cancellation, waiting, question');
  const failing = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id, sourceEventId: ask.id, requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: dev.id, intent: 'failing', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'failing-1',
  }).request;
  engine.transitionWorkRequest(failing.id, { from: 'queued', to: 'running' });
  const failingAttempt = engine.createAttempt(failing.id, { kind: 'launch', adapter: 'claude', toolProfile: 'readonly', launchSnapshot: { a: 2 } });
  engine.finishAttempt(failingAttempt.id, { outcome: 'timed_out', errorCategory: 'timed_out', errorMessage: 'deadline' });
  engine.transitionWorkRequest(failing.id, { from: 'running', to: 'failed', errorCode: 'timed_out', errorMessage: 'The agent did not finish in time.' });
  const asking = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id, sourceEventId: ask.id, requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: dev.id, intent: 'asking', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'asking-1',
  }).request;
  engine.transitionWorkRequest(asking.id, { from: 'queued', to: 'running' });
  engine.transitionWorkRequest(asking.id, { from: 'running', to: 'waiting', reason: 'needs_input' });
  engine.appendEvent(asking.id, { type: 'question', data: { question: 'Which channel?' } });
  engine.transitionWorkRequest(asking.id, { from: 'waiting', to: 'cancelled', reason: 'person_cancelled' });
  views = projector.listConversationEvents(conversation.id);
  const failure = views.find(view => view.requestId === failing.id && view.kind === 'request_failed');
  assert(failure.data.error_code === 'timed_out' && failure.data.error_message === 'The agent did not finish in time.' && failure.data.outcome === 'timed_out' && failure.data.success === false, 'request_failed carries typed code, message, and Attempt outcome');
  assert(failure.attemptId === failingAttempt.id && failure.text === 'Failed: The agent did not finish in time.' && failure.state === 'failed', 'request_failed names the Attempt and renders text');
  assert(kindsOf(views, asking.id).join(',') === 'request_queued,request_running,request_waiting,question,request_cancelled', 'waiting, question, cancellation in order');
  const question = views.find(view => view.requestId === asking.id && view.kind === 'question');
  assert(question.text === 'Which channel?' && question.data.question === 'Which channel?' && question.state === 'waiting', 'question text and data');
  const cancelled = views.find(view => view.requestId === asking.id && view.kind === 'request_cancelled');
  assert(cancelled.data.reason === 'person_cancelled' && cancelled.state === 'cancelled', 'cancellation carries its reason');

  console.log('Blocked Wake recovers');
  router.setWakeAvailabilityProbe(() => ({ available: true }));
  raw.prepare("UPDATE bots SET deck_id = 'deck-idle', needs_deck_selection = 0 WHERE name = 'Idle'").run();
  router.retryWake(blocked.wake.id);
  views = projector.listConversationEvents(conversation.id);
  // NOT-475: a recovered blocked Wake is accepted now (wake-safety fixture
  // flow_c_target_becomes_available_after_allow).
  assert(kindsOf(views, blocked.request.id).join(',') === 'wake_blocked,wake_accepted', 'unblocked Wake projects wake_accepted after wake_blocked');
  assert(views.find(view => view.requestId === blocked.request.id && view.kind === 'wake_accepted').data.reason === 'target_available', 'acceptance carries its reason');

  console.log('Interleaved requests');
  const other = bots.create({ deck_id: 'deck-o', name: 'Other', title: 'Other', description: 'Other.', agent: 'hermes' });
  const thread = conversations.getByBotId(other.id);
  const src = messages.create(thread.id, 'user', 'two things');
  const base = 1_000_000;
  const mk = (key, at) => engine.createOrGetWorkRequest({
    sourceConversationId: thread.id, sourceEventId: src.id, requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: other.id, intent: key, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: key, now: at,
  }).request;
  const a = mk('inter-a', base);
  const b = mk('inter-b', base + 1);
  engine.transitionWorkRequest(b.id, { from: 'queued', to: 'running', now: base + 2 });
  engine.transitionWorkRequest(a.id, { from: 'queued', to: 'running', now: base + 3 });
  // A clock that steps back inside request a must not reorder it.
  engine.transitionWorkRequest(a.id, { from: 'running', to: 'failed', errorCode: 'x', errorMessage: 'a failed', now: base });
  engine.transitionWorkRequest(b.id, { from: 'running', to: 'cancelled', reason: 'stop', now: base + 4 });
  const inter = projector.listConversationEvents(thread.id);
  const order = inter.map(view => `${view.requestId === a.id ? 'a' : 'b'}:${view.kind}`).join(' ');
  assert(order === 'a:request_queued b:request_queued b:request_running a:request_running a:request_failed b:request_cancelled', `interleaved order is stable (${order})`);
  for (const request of [a, b]) {
    const seqs = inter.filter(view => view.requestId === request.id).map(view => view.requestSequence);
    assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), `request ${request === a ? 'a' : 'b'} keeps its own event order`);
  }
  assert(inter.map(view => view.seq).join(',') === inter.map((_, index) => index + 1).join(','), 'conversation seq is contiguous');

  console.log('Duplicate delivery and replay');
  const before = rowCount(conversation.id);
  const snapshot = JSON.stringify(projector.listConversationEvents(conversation.id));
  for (const event of engine.listEvents(work.id)) {
    projector.projectEvent(event);
    projector.projectEvent(event);
  }
  projector.projectConversation(conversation.id);
  raw.prepare('DELETE FROM conversation_projection_cursors').run();
  assert(projector.projectConversation(conversation.id) === 0, 'replaying every event with cursors reset writes no rows');
  assert(rowCount(conversation.id) === before && JSON.stringify(projector.listConversationEvents(conversation.id)) === snapshot, 'redelivery leaves the projection unchanged');

  console.log('Rebuild from the same engine events');
  raw.pragma('wal_checkpoint(TRUNCATE)');
  const copyPath = `${DB_PATH}.rebuild`;
  removeDb(copyPath);
  fs.copyFileSync(DB_PATH, copyPath);
  const copy = new Database(copyPath);
  copy.exec('DELETE FROM conversation_events; DELETE FROM conversation_projection_cursors;');
  const rebuilt = jiti('./lib/conversation-projection.ts').createConversationProjector(copy);
  for (const id of [conversation.id, thread.id]) {
    assert(JSON.stringify(rebuilt.listConversationEvents(id)) === JSON.stringify(projector.listConversationEvents(id)), `rebuilt projection equals the live one (${id === thread.id ? 'interleaved' : 'main'})`);
  }
  copy.close();
  removeDb(copyPath);

  console.log('UI and /api/v0 read parity');
  api.setAgentApiAuthenticator(() => UI_OWNER_PRINCIPAL);
  const apiResponse = await api.handleGetConversation(new Request(`http://engine.test/api/v0/conversations/${conversation.id}`), conversation.id);
  const apiBody = await apiResponse.json();
  const uiResponse = await uiRoute.GET(new Request(`http://engine.test/api/conversations/${conversation.id}`), { params: Promise.resolve({ id: conversation.id }) });
  const uiBody = await uiResponse.json();
  assert(apiResponse.status === 200 && uiResponse.status === 200, 'both reads succeed');
  assert(Array.isArray(apiBody.events) && apiBody.events.length === rowCount(conversation.id), '/api/v0 exposes every projected event');
  assert(JSON.stringify(apiBody.events) === JSON.stringify(uiBody.events), 'UI and /api/v0 return the same projected events');
  for (const kind of ['wake_accepted', 'wake_blocked', 'request_running', 'request_completed', 'result', 'request_failed', 'artifact']) {
    assert(apiBody.events.some(view => view.kind === kind) && uiBody.events.some(view => view.kind === kind), `both reads expose ${kind}`);
  }
  assert(Array.isArray(apiBody.messages) && apiBody.messages.some(message => message.content === 'Notifications added.'), '/api/v0 messages are unchanged alongside events');

  console.log('Legacy history stays readable');
  const legacyBot = bots.create({ deck_id: 'deck-l', name: 'Legacy', title: 'Legacy', description: 'Legacy.', agent: 'hermes' });
  const legacyThread = conversations.getByBotId(legacyBot.id);
  const legacyAsk = messages.create(legacyThread.id, 'user', 'old question');
  const legacyReply = messages.create(legacyThread.id, 'bot', 'old answer', legacyBot.id);
  messages.create(legacyThread.id, 'bot', '[Agent Deck] launching', legacyBot.id);
  // NOT-477: a pre-NOT-465 agent_requests row, as an older database held
  // it, migrated by the retirement step.
  raw.exec(`CREATE TABLE agent_requests (id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, conversation_id TEXT NOT NULL, target_bot_id TEXT NOT NULL,
    accepted_message_id TEXT NOT NULL, runtime TEXT, state TEXT NOT NULL, reply_message_id TEXT, failure_code TEXT,
    failure_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE agent_request_events (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);`);
  raw.prepare(`INSERT INTO agent_requests (id, principal_kind, principal_id, operation, idempotency_key, payload_hash, conversation_id,
    target_bot_id, accepted_message_id, runtime, state, reply_message_id, created_at, updated_at)
    VALUES ('legacy-req', 'person', 'local-owner', 'send_message', 'legacy-key', 'h', ?, ?, ?, 'hermes', 'completed', ?, 1, 2)`)
    .run(legacyThread.id, legacyBot.id, legacyAsk.id, legacyReply.id);
  for (const [i, type] of ['accepted', 'dispatched', 'runtime_started', 'completed'].entries()) {
    raw.prepare('INSERT INTO agent_request_events (id, request_id, type, data, created_at) VALUES (?, ?, ?, NULL, ?)').run(`legacy-ev-${i}`, 'legacy-req', type, i + 1);
  }
  assert(raw.transaction(() => engineStore.archiveLegacyAgentRequests(raw))() === 1, 'legacy request backfilled');
  const legacyView = (await (await api.handleGetConversation(new Request('http://engine.test/x'), legacyThread.id)).json());
  assert(legacyView.messages.map(m => m.content).join('|') === 'old question|old answer|[Agent Deck] launching', 'legacy messages read unchanged and in order');
  assert(Array.isArray(legacyView.events) && legacyView.events.length === 0, 'backfilled legacy request projects no lifecycle (no false running/success)');
  const legacyUi = await (await uiRoute.GET(new Request('http://engine.test/x'), { params: Promise.resolve({ id: legacyThread.id }) })).json();
  assert(JSON.stringify(legacyUi.events) === '[]', 'UI legacy read has the same empty projection');

  console.log('Database reopen');
  const expected = {
    main: { conversationId: conversation.id, rows: rowCount(conversation.id), view: JSON.stringify(projector.listConversationEvents(conversation.id)) },
    thread: { conversationId: thread.id, rows: rowCount(thread.id), view: JSON.stringify(projector.listConversationEvents(thread.id)) },
  };
  const expectedPath = `${DB_PATH}.expected.json`;
  fs.writeFileSync(expectedPath, JSON.stringify(expected));
  raw.pragma('wal_checkpoint(TRUNCATE)');
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, PROJECTION_SCENARIO: 'reopen', PROJECTION_DB: DB_PATH, PROJECTION_EXPECTED: expectedPath },
    encoding: 'utf8',
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert(child.status === 0, 'reopened process replays without duplicates');
  fs.rmSync(expectedPath, { force: true });

  console.log('Conversation delete removes its projection');
  bots.removeMany([other.id]);
  assert(rowCount(thread.id) === 0 && raw.prepare('SELECT COUNT(*) AS n FROM conversation_projection_cursors WHERE request_id IN (?, ?)').get(a.id, b.id).n === 0, 'deleting the Agent and its conversation leaves no projected rows');

  removeDb(DB_PATH);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log('\nAll conversation projection checks passed.');
}

function runReopen() {
  const expected = JSON.parse(fs.readFileSync(process.env.PROJECTION_EXPECTED, 'utf8'));
  for (const [name, entry] of Object.entries(expected)) {
    assert(projector.projectConversation(entry.conversationId) === 0, `${name}: reopened replay writes no rows`);
    raw.prepare('DELETE FROM conversation_projection_cursors').run();
    assert(projector.projectConversation(entry.conversationId) === 0, `${name}: replay from sequence 0 after reopen writes no rows`);
    assert(rowCount(entry.conversationId) === entry.rows, `${name}: row count unchanged after reopen`);
    assert(JSON.stringify(projector.listConversationEvents(entry.conversationId)) === entry.view, `${name}: projection identical after reopen`);
  }
  process.exit(failures > 0 ? 1 : 0);
}
