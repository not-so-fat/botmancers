#!/usr/bin/env node
// NOT-497: session-targeted Ask and Continue exchanges (lib/session-exchanges,
// POST /api/exchanges, GET /api/exchanges/:id, POST /api/exchanges/:id/cancel).
// Proves: the exchange row and its append-only events enforce mode, the
// state machine, idempotent creation, set-once causal references, and
// referential cleanup, and never hold a provider session id; an Ask resumes
// exactly the selected binding of its owning Agent in one read-only
// conversation turn and answers into the origin conversation; a Continue
// extracts a bounded packet from the source session before a fresh
// destination-owned session is launched, and the destination adapter never
// receives the source provider session id; cancellation and a restart (a
// real second process) leave a truthful state; a failed exchange is retried
// only by a new idempotency key; the owner routes return stable safe
// references and actionable errors. The hops run through the real leased
// dispatcher with a fake attempt adapter. Self-contained: isolated SQLite
// file and HOME, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CHILD = process.env.EXCHANGE_SCENARIO === 'restart-child';
const DB_PATH = process.env.EXCHANGE_DB || path.join(os.tmpdir(), `botmancers-exchanges-${process.pid}.db`);
if (!CHILD) {
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
}
process.env.EXCHANGE_DB = DB_PATH;
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
if (!process.env.EXCHANGE_HOME) process.env.EXCHANGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-exchanges-home-'));
process.env.HOME = process.env.EXCHANGE_HOME;
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const engineStore = jiti('./lib/engine-store.ts');
const lib = jiti('./lib/session-exchanges.ts');
const { startRouteHost } = require('./test-support/acceptance/route-host');

const raw = dbModule.default;
const { engine, bots, conversations, UI_OWNER_PRINCIPAL: OWNER } = dbModule;
const exchanges = service.exchanges;

// Distinct fake provider session ids. None may appear in an exchange row,
// event, or response; the destination adapter must never receive DEV's.
const SECRETS = {
  dev: 'prov-dev-SECRET-1111',
  scout: 'prov-scout-SECRET-2222',
  devEnded: 'prov-dev-ENDED-3333',
  devOld: 'prov-dev-CODEX-4444',
  noDeck: 'prov-nodeck-SECRET-5555',
  scoutFresh: 'prov-scout-FRESH-6666',
  rose: 'prov-rose-SECRET-7777',
  scoutRestart: 'prov-scout-RESTART-9191',
  devFork: 'prov-dev-FORK-7777',
  devForkFail: 'prov-dev-FORKFAIL-8888',
};
const leaks = text => Object.values(SECRETS).filter(id => text.includes(id));

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
const policyOf = request => JSON.parse(request.policy_snapshot);
function threw(fn) {
  try { fn(); return null; } catch (error) { return error; }
}
async function rejects(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

// ---------------------------------------------------------------------
// Fake attempt adapter: records every launch input; `script` decides the
// result; `gate`, when set, holds the adapter until released.
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
      calls.push({ kind, agentId: input.target.agentId, input, requestId: input.correlation.requestId, attemptId: input.correlation.attemptId });
      const started = Date.now();
      onEvent({ type: 'started', adapter: 'hermes-gateway', at: started, externalRunId: null, externalSessionId: null });
      if (gate) await gate.promise;
      const out = script(input, kind);
      const now = Date.now();
      if (out.fail) {
        return {
          status: 'failed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: out.session ?? null, output: null, artifacts: [],
          startedAt: started, finishedAt: now, failure: { category: 'runtime_failed', message: out.failMessage ?? 'fake failure', code: 'fake' },
        };
      }
      return {
        status: 'completed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: out.session ?? null,
        output: out.output, artifacts: [], startedAt: started, finishedAt: now, failure: null,
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
const callsFor = requestId => calls.filter(call => call.requestId === requestId);

function packetJson(extra = {}) {
  return JSON.stringify({
    objective: 'Finish the session exchange contract and land its tests',
    decisions: ['Hops are canonical Work Requests', 'Exchanges never carry edit authority'],
    constraints: ['No UI in this slice'],
    artifacts: ['lib/session-exchanges.ts', `debug note ${SECRETS.dev}`],
    open_questions: ['Who renders exchange cards?'],
    ...extra,
  });
}

// ---------------------------------------------------------------------
// Fixture: three hermes Agents on a deck plus one without a deck. Each
// source session is an implementation the Agent ran and bound in its own
// thread (the shape the dispatcher leaves).
function agent(name, fields = {}) {
  return bots.getAll().find(bot => bot.name === name)
    || bots.create({ name, title: 'Agent', description: `${name} fixture`, agent: 'hermes', deck_id: 'deck-builder', ...fields });
}
function seedSession(bot, secret, { adapter = 'hermes', key } = {}) {
  const conv = conversations.getByBotId(bot.id);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: `seed-${key}`, requester: OWNER, targetAgentId: bot.id,
    intent: `Seed implementation ${key}`, executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: `seed-${key}`,
  });
  engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
  const attempt = engine.createAttempt(request.id, { kind: 'launch', adapter, toolProfile: 'edit', launchSnapshot: { seeded: true } });
  engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', externalSessionId: secret });
  const binding = engine.bindSession({ agentId: bot.id, adapter, externalSessionId: secret, conversationId: conv.id, requestId: request.id, sourceAttemptId: attempt.id });
  engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null } });
  return { binding, request, conv };
}

function fixture() {
  const tank = agent('Tank');
  const dev = agent('Dev');
  const scout = agent('Scout');
  const rose = agent('Rose');
  const noDeck = agent('NoDeck', { deck_id: null });
  return { tank, dev, scout, rose, noDeck };
}

// ---------------------------------------------------------------------
// Restart child: a fresh process over the same database file.
async function restartChild() {
  installAdapter();
  script = (input, kind) => kind === 'deliver' ? { output: 'Picked up after restart.', session: SECRETS.scoutRestart } : { output: 'unexpected' };
  const before = JSON.parse(process.env.EXCHANGE_READ_IDS).map(id => exchanges.view(id));
  service.configureDispatcher({ owner: `exchange-restart-child:${process.pid}` });
  await service.recoverCoordinatorLoops();
  await service.waitForAgentDispatchIdle();
  const pending = JSON.parse(process.env.EXCHANGE_PENDING_IDS).map(id => exchanges.view(id));
  process.stdout.write(JSON.stringify({
    before, pending,
    calls: calls.map(call => ({ kind: call.kind, agentId: call.agentId, requestId: call.requestId, sessionBinding: call.input.sessionBinding, input: JSON.stringify(call.input) })),
  }));
}

async function main() {
  installAdapter();
  service.configureDispatcher({ owner: `exchange-test:${process.pid}`, config: { maxGlobal: 10, maxPerTarget: 1, heartbeatMs: 600_000 } });
  const { tank, dev, scout, rose, noDeck } = fixture();
  const tankConv = conversations.getByBotId(tank.id);
  const devSession = seedSession(dev, SECRETS.dev, { key: 'dev' });
  const scoutSession = seedSession(scout, SECRETS.scout, { key: 'scout' });
  const roseSession = seedSession(rose, SECRETS.rose, { key: 'rose' });
  const ended = seedSession(dev, SECRETS.devEnded, { key: 'dev-ended' });
  engine.bindSession({ agentId: dev.id, adapter: 'hermes', externalSessionId: 'prov-dev-REPLACEMENT-0000', conversationId: ended.conv.id, requestId: ended.request.id });
  const codex = seedSession(dev, SECRETS.devOld, { key: 'dev-codex', adapter: 'codex' });
  // NoDeck ran while it still had a deck.
  raw.prepare("UPDATE bots SET deck_id = 'deck-builder', needs_deck_selection = 0 WHERE id = ?").run(noDeck.id);
  const noDeckSession = seedSession(noDeck, SECRETS.noDeck, { key: 'nodeck' });
  raw.prepare('UPDATE bots SET deck_id = NULL, needs_deck_selection = 1 WHERE id = ?').run(noDeck.id);
  const ask = (fields = {}) => ({
    requester: OWNER, idempotencyKey: `ask-${Math.random()}`, mode: 'ask', originConversationId: tankConv.id,
    sourceAgentId: dev.id, sessionRef: devSession.binding.id, instruction: 'Why did you choose canonical Work Requests for hops?', ...fields,
  });
  const cont = (fields = {}) => ({
    requester: OWNER, idempotencyKey: `cont-${Math.random()}`, mode: 'continue', originConversationId: tankConv.id,
    sourceAgentId: dev.id, sessionRef: devSession.binding.id, destinationAgentId: scout.id, instruction: 'Hand the remaining test work to Scout.', ...fields,
  });
  const exchangeRows = () => count('SELECT COUNT(*) AS n FROM session_exchanges');
  const requestRows = () => count('SELECT COUNT(*) AS n FROM work_requests');

  // -------------------------------------------------------------------
  console.log('\n[1] persistence model: idempotency, state machine, set-once references');
  {
    const input = ask({ idempotencyKey: 'store-1' });
    const first = exchanges.create(input);
    const ex = first.exchange;
    const hop = engine.getWorkRequest(ex.source_request_id);
    const policy = policyOf(hop);
    assert(first.created && ex.state === 'queued' && ex.mode === 'ask' && ex.source_binding_id === devSession.binding.id && ex.source_agent_id === dev.id,
      'create persists a queued Ask naming the selected binding and its Agent');
    assert(hop.state === 'queued' && hop.target_agent_id === dev.id && hop.execution_kind === 'conversation' && hop.tool_profile === 'readonly'
      && policy.execution_policy.entry_point === 'exchange' && policy.execution_policy.rule === 'session_exchange_conversation'
      && policy.exchange_id === ex.id && policy.hop === 'ask' && policy.resume_session_binding === devSession.binding.id,
    'the first hop Work Request commits with it: read-only conversation under the exchange rule, naming the exchange and binding');
    assert(hop.requester_kind === 'service' && hop.requester_id === 'botmancers-exchanges' && hop.parent_request_id === devSession.request.id
      && hop.source_conversation_id === devSession.conv.id && JSON.parse(hop.retry_policy).max_attempts === 1,
    'the hop continues the binding\'s own lineage and conversation, with exactly one Attempt allowed');
    const decision = engine.latestSafetyDecision(hop.id);
    assert(decision.decision === 'allowed' && decision.principal_type === 'human_owner' && decision.principal_id === OWNER.id, 'the hop is admitted for the owner (allowed safety decision)');
    const rowsBefore = exchangeRows();
    const requestsBefore = requestRows();
    const replay = exchanges.create(input);
    assert(!replay.created && replay.exchange.id === ex.id && exchangeRows() === rowsBefore && requestRows() === requestsBefore, 'an exact replay returns the same exchange and writes nothing');
    const conflict = threw(() => exchanges.create({ ...input, instruction: 'A different question' }));
    assert(conflict?.code === 'idempotency_conflict' && exchangeRows() === rowsBefore && requestRows() === requestsBefore, 'the same key with another payload is idempotency_conflict and writes nothing');

    const sqlError = sql => threw(() => raw.prepare(sql).run(ex.id))?.message ?? null;
    assert(/invalid session_exchanges state transition/.test(sqlError("UPDATE session_exchanges SET state = 'completed', terminal_at = 1 WHERE id = ?")), 'queued -> completed is refused');
    assert(/invalid session_exchanges state transition/.test(sqlError("UPDATE session_exchanges SET state = 'delivering' WHERE id = ?")), 'an Ask never delivers (queued -> delivering refused)');
    assert(/immutable/.test(sqlError("UPDATE session_exchanges SET instruction = 'changed' WHERE id = ?")), 'identity and instruction are immutable');
    assert(/set once/.test(sqlError("UPDATE session_exchanges SET source_request_id = NULL WHERE id = ?")), 'a causal reference is set once');
    assert(/append-only/.test(threw(() => raw.prepare('UPDATE session_exchange_events SET type = ? WHERE exchange_id = ?').run('x', ex.id))?.message ?? ''), 'exchange events cannot be rewritten');
    assert(/append-only/.test(threw(() => raw.prepare('DELETE FROM session_exchange_events WHERE exchange_id = ?').run(ex.id))?.message ?? ''), 'exchange events cannot be deleted one by one');
    const rawInsert = threw(() => raw.prepare(`INSERT INTO session_exchanges (id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
      source_agent_id, source_binding_id, instruction, state, created_at, updated_at) VALUES ('x1', 'person', 'local-owner', 'raw', 'h', 'ask', ?, ?, ?, 'q', 'extracting', 1, 1)`)
      .run(tankConv.id, dev.id, devSession.binding.id));
    assert(/starts queued/.test(rawInsert?.message ?? ''), 'a raw exchange cannot start past queued');
    const foreignBinding = threw(() => raw.prepare(`INSERT INTO session_exchanges (id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
      source_agent_id, source_binding_id, instruction, state, created_at, updated_at) VALUES ('x2', 'person', 'local-owner', 'raw2', 'h', 'ask', ?, ?, ?, 'q', 'queued', 1, 1)`)
      .run(tankConv.id, dev.id, scoutSession.binding.id));
    assert(/does not belong to its source agent/.test(foreignBinding?.message ?? ''), 'a raw exchange cannot name another Agent\'s binding');
    const badMode = threw(() => raw.prepare(`INSERT INTO session_exchanges (id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
      source_agent_id, source_binding_id, instruction, state, created_at, updated_at) VALUES ('x3', 'person', 'local-owner', 'raw3', 'h', 'debate', ?, ?, ?, 'q', 'queued', 1, 1)`)
      .run(tankConv.id, dev.id, devSession.binding.id));
    assert(/CHECK constraint/.test(badMode?.message ?? ''), 'an unknown mode is refused');
    assert(/RESTRICT|FOREIGN KEY/.test(threw(() => raw.prepare('DELETE FROM session_bindings WHERE id = ?').run(devSession.binding.id))?.message ?? ''),
      'a binding an exchange names cannot be deleted under it');
    // The answer reference must be the source Agent's message in the
    // origin conversation, produced by the source hop request.
    const message = (id, conversationId, senderId, requestId) => raw.prepare(
      "INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, 'bot', ?, 'bot', ?, 'x', 1)"
    ).run(id, conversationId, senderId, requestId);
    message('m-other-agent', tankConv.id, scout.id, ex.source_request_id);
    message('m-other-conv', devSession.conv.id, dev.id, ex.source_request_id);
    message('m-other-request', tankConv.id, dev.id, devSession.request.id);
    for (const [label, id] of [['a missing message', 'no-such-message'], ['another Agent\'s message', 'm-other-agent'],
      ['a message in another conversation', 'm-other-conv'], ['a message of another request', 'm-other-request']]) {
      assert(/answer_message_id/.test(sqlError(`UPDATE session_exchanges SET answer_message_id = '${id}' WHERE id = ?`) ?? ''),
        `the answer reference cannot name ${label}`);
    }
    raw.prepare("DELETE FROM messages WHERE id IN ('m-other-agent', 'm-other-conv', 'm-other-request')").run();

    // A Continue never completes straight from extracting.
    const c = exchanges.create(cont({ sourceAgentId: rose.id, sessionRef: roseSession.binding.id, idempotencyKey: 'store-continue' })).exchange;
    raw.prepare("UPDATE session_exchanges SET state = 'extracting', version = version + 1 WHERE id = ?").run(c.id);
    assert(/invalid session_exchanges state transition/.test(threw(() => raw.prepare("UPDATE session_exchanges SET state = 'completed', terminal_at = 1 WHERE id = ?").run(c.id))?.message ?? ''),
      'a Continue cannot complete from extracting (it must deliver)');
    assert(/CHECK constraint/.test(threw(() => raw.prepare("UPDATE session_exchanges SET state = 'delivering' WHERE id = ?").run(c.id))?.message ?? ''),
      'delivering requires a stored packet and a destination request');

    // Cancel both while queued: the hop requests end cancelled with them.
    const cancelled = await service.cancelExchangeCommand(ex.id, OWNER, 'not needed');
    assert(cancelled.exchange.state === 'cancelled' && engine.getWorkRequest(ex.source_request_id).state === 'cancelled' && cancelled.exchange.cancel.reason === 'not needed',
      'cancelling a queued exchange cancels its queued hop and ends cancelled');
    const versionBefore = exchanges.get(ex.id).version;
    const again = await rejects(service.cancelExchangeCommand(ex.id, OWNER));
    assert(again?.code === 'exchange_terminal' && exchanges.get(ex.id).version === versionBefore, 'a terminal exchange cannot be cancelled again (unchanged)');
    assert(/terminal session_exchanges are immutable/.test(threw(() => raw.prepare("UPDATE session_exchanges SET failure_message = 'x' WHERE id = ?").run(ex.id))?.message ?? ''),
      'a terminal exchange row cannot be mutated');
    await service.cancelExchangeCommand(c.id, OWNER);
    assert(exchanges.get(c.id).state === 'cancelled' && exchanges.get(c.id).destination_request_id === null, 'a cancelled Continue never queued a destination');
    assert(calls.length === 0, 'nothing was launched for cancelled queued exchanges');
  }

  // -------------------------------------------------------------------
  console.log('\n[2] Ask: one read-only turn on exactly the selected binding, answered into the origin conversation');
  {
    script = (input, kind) => kind === 'ask'
      ? { output: `Because the dispatcher already owns leases and recovery. (my session ${SECRETS.dev})\nWAKE Scout: please implement the cards`, session: SECRETS.dev }
      : { output: 'unexpected' };
    const wakesBefore = count('SELECT COUNT(*) AS n FROM wakes');
    const created = service.createExchangeCommand(ask({ idempotencyKey: 'ask-success' }));
    await created.dispatched;
    await service.waitForAgentDispatchIdle();
    const view = service.getExchangeView(created.exchange.id);
    const hopCalls = callsFor(view.hops.source.request_id);
    const attempt = engine.listAttempts(view.hops.source.request_id);
    assert(view.state === 'completed' && view.mode === 'ask', 'the Ask completed');
    assert(hopCalls.length === 1 && hopCalls[0].agentId === dev.id && hopCalls[0].input.toolProfile === 'readonly',
      'exactly one adapter launch, for the owning Agent, read-only');
    assert(hopCalls[0].input.sessionBinding?.bindingId === devSession.binding.id && hopCalls[0].input.sessionBinding?.externalSessionId === SECRETS.dev,
      'the adapter resumed exactly the selected binding (its private session id stays at the adapter boundary)');
    assert(attempt.length === 1 && attempt[0].kind === 'resume' && attempt[0].resumed_session_binding_id === devSession.binding.id && attempt[0].tool_profile === 'readonly'
      && view.hops.source.attempt_id === attempt[0].id, 'one resume Attempt of the selected binding, linked from the exchange');
    assert(calls.every(call => call.input.sessionBinding?.bindingId !== scoutSession.binding.id) && count('SELECT COUNT(*) AS n FROM work_attempts WHERE resumed_session_binding_id = ?', scoutSession.binding.id) === 0,
      'the other Agent\'s session was never resumed');
    const answer = dbModule.messages.getById(view.answer.message_id);
    assert(answer.conversation_id === tankConv.id && answer.sender_id === dev.id && answer.request_id === view.hops.source.request_id
      && view.answer.content.includes('dispatcher already owns leases'), 'one answer message in the origin conversation, from the source Agent, linked to the hop request');
    assert(!view.answer.content.includes(SECRETS.dev) && view.answer.content.includes('[redacted session id]'), 'an echoed provider session id is redacted from the answer');
    const storedOutput = one('SELECT output FROM work_attempts WHERE id = ?', attempt[0].id).output;
    assert(!storedOutput.includes(SECRETS.dev) && storedOutput.includes('[redacted session id]')
      && count("SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ? AND data LIKE ?", view.hops.source.request_id, `%${SECRETS.dev}%`) === 0,
    'the hop Attempt\'s stored output is redacted too, and no hop event carries the provider session id');
    assert(/answer_message_id/.test(threw(() => raw.prepare('DELETE FROM messages WHERE id = ?').run(answer.id))?.message ?? ''),
      'the answer message cannot be deleted under its exchange');
    assert(count("SELECT COUNT(*) AS n FROM messages WHERE request_id = ? AND sender_type = 'bot'", view.hops.source.request_id) === 1
      && count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND request_id = ?", devSession.conv.id, view.hops.source.request_id) === 0,
    'nothing was written into the source session\'s own thread');
    assert(count('SELECT COUNT(*) AS n FROM wakes') === wakesBefore, 'a Wake in the answer routes nothing (an Ask cannot continue after its answer)');
    assert(count('SELECT COUNT(*) AS n FROM session_bindings WHERE agent_id = ? AND released_at IS NULL AND id = ?', dev.id, devSession.binding.id) === 1,
      'the selected binding stays active and unchanged');
    const types = view.events.map(event => event.type);
    assert(JSON.stringify(types) === JSON.stringify(['created', 'hop_queued', 'state_changed', 'hop_started', 'answer_returned', 'state_changed']),
      `ordered exchange events (${types.join(',')})`);
    assert(view.events[2].data.to === 'extracting' && view.events[5].data.to === 'completed', 'queued -> extracting -> completed');
    const stored = JSON.stringify([one('SELECT * FROM session_exchanges WHERE id = ?', view.id), raw.prepare('SELECT * FROM session_exchange_events WHERE exchange_id = ?').all(view.id)]);
    assert(leaks(stored).length === 0 && leaks(JSON.stringify(view)).length === 0, 'neither the stored row, its events, nor the view holds a provider session id');
  }

  // -------------------------------------------------------------------
  console.log('\n[2b] a session id the adapter reports for the turn (a fork) is as private as the source id');
  {
    script = () => ({ output: `forked into ${SECRETS.devFork}`, session: SECRETS.devFork });
    const ok = service.createExchangeCommand(ask({ idempotencyKey: 'ask-forked' }));
    await ok.dispatched;
    await service.waitForAgentDispatchIdle();
    const okView = service.getExchangeView(ok.exchange.id);
    const okAttempt = engine.listAttempts(okView.hops.source.request_id)[0];
    assert(okView.state === 'completed' && !okView.answer.content.includes(SECRETS.devFork), 'a forked Ask answer does not carry the newly reported session id');
    assert(!one('SELECT output FROM work_attempts WHERE id = ?', okAttempt.id).output.includes(SECRETS.devFork),
      'the Attempt output does not carry it either');
    script = () => ({ fail: true, session: SECRETS.devForkFail, failMessage: `session_mismatch: resumed ${SECRETS.dev} but got ${SECRETS.devForkFail}` });
    const bad = service.createExchangeCommand(ask({ idempotencyKey: 'ask-forked-fail' }));
    await bad.dispatched;
    await service.waitForAgentDispatchIdle();
    const badView = service.getExchangeView(bad.exchange.id);
    const badAttempt = engine.listAttempts(badView.hops.source.request_id)[0];
    const stored = JSON.stringify(one('SELECT * FROM work_attempts WHERE id = ?', badAttempt.id)).replace(/"external_session_id":"[^"]*"/g, '');
    assert(!stored.includes(SECRETS.devForkFail) && !stored.includes(SECRETS.dev),
      'a failed forked resume keeps neither session id in the Attempt error text');
    assert(count('SELECT COUNT(*) AS n FROM engine_events WHERE data LIKE ?', `%${SECRETS.devForkFail}%`) === 0, 'no event carries the reported session id');
  }

  console.log('\n[3] Ask rejections: ended, mismatched, unknown, edit-seeking, recursive, unavailable, busy');
  {
    const rowsBefore = exchangeRows();
    const requestsBefore = requestRows();
    const attemptsBefore = count('SELECT COUNT(*) AS n FROM work_attempts');
    const cases = [
      ['unknown session', ask({ sessionRef: 'no-such-session' }), 'session_not_found'],
      ['another Agent\'s session', ask({ sessionRef: scoutSession.binding.id }), 'session_not_found'],
      ['ended session', ask({ sessionRef: ended.binding.id }), 'session_ended'],
      ['session under another runtime', ask({ sessionRef: codex.binding.id }), 'session_not_resumable'],
      ['edit-seeking (implementation)', ask({ executionKind: 'implementation' }), 'authority_not_allowed'],
      ['edit-seeking (revision)', ask({ executionKind: 'revision' }), 'authority_not_allowed'],
      ['recursive (an Agent principal)', ask({ requester: { kind: 'bot', id: dev.id } }), 'recursive_exchange'],
      ['Ask with a destination', ask({ destinationAgentId: scout.id }), 'destination_invalid'],
      ['unknown origin', ask({ originConversationId: 'no-such-conversation' }), 'conversation_not_found'],
      ['unknown source Agent', ask({ sourceAgentId: 'no-such-agent' }), 'agent_not_found'],
      ['source Agent without a deck', ask({ sourceAgentId: noDeck.id, sessionRef: noDeckSession.binding.id }), 'agent_unavailable'],
      ['instruction over the limit', ask({ instruction: 'x'.repeat(lib.EXCHANGE_LIMITS.instructionChars + 1) }), 'invalid_request'],
      ['Continue to its own source Agent', cont({ destinationAgentId: dev.id }), 'destination_invalid'],
    ];
    for (const [label, input, code] of cases) {
      const error = threw(() => service.createExchangeCommand(input));
      assert(error?.code === code && leaks(error.message).length === 0, `${label}: ${code} (${error?.message})`);
    }
    assert(exchangeRows() === rowsBefore && requestRows() === requestsBefore && count('SELECT COUNT(*) AS n FROM work_attempts') === attemptsBefore,
      'no rejection wrote an exchange, Work Request, or Attempt');

    // Busy: one exchange per source session at a time.
    const held = holdAdapter();
    script = () => ({ output: 'Held answer.' });
    const running = service.createExchangeCommand(ask({ idempotencyKey: 'ask-busy-1' }));
    await waitFor(() => callsFor(running.exchange.hops.source.request_id).length === 1, 'busy Ask in its adapter');
    const busy = threw(() => service.createExchangeCommand(ask({ idempotencyKey: 'ask-busy-2' })));
    assert(busy?.code === 'source_session_busy' && exchanges.view(running.exchange.id).state === 'extracting', 'a second exchange on a busy session is source_session_busy');
    held.release();
    await service.waitForAgentDispatchIdle();
    assert(exchanges.view(running.exchange.id).state === 'completed', 'the held Ask then completed');
  }

  // -------------------------------------------------------------------
  console.log('\n[4] Continue: source-owned packet first, then a fresh destination-owned session');
  let continueId;
  {
    const order = [];
    script = (input, kind) => {
      order.push(kind);
      if (kind === 'extract') return { output: `Here is the packet:\n\`\`\`json\n${packetJson()}\n\`\`\``, session: SECRETS.dev };
      if (kind === 'deliver') return { output: `Scout here: picking up the test work in ${SECRETS.scoutFresh}.`, session: SECRETS.scoutFresh };
      return { output: 'unexpected' };
    };
    const callsBefore = calls.length;
    const created = service.createExchangeCommand(cont({ idempotencyKey: 'continue-success' }));
    continueId = created.exchange.id;
    await created.dispatched;
    await service.waitForAgentDispatchIdle();
    const view = service.getExchangeView(continueId);
    const mine = calls.slice(callsBefore);
    const extract = mine.find(call => call.kind === 'extract');
    const deliver = mine.find(call => call.kind === 'deliver');
    assert(view.state === 'completed' && JSON.stringify(order) === JSON.stringify(['extract', 'deliver']), 'extraction ran before delivery, and the Continue completed');
    assert(extract.agentId === dev.id && extract.input.sessionBinding?.bindingId === devSession.binding.id && extract.input.toolProfile === 'readonly',
      'the extraction resumed the selected source binding, read-only');
    assert(deliver.agentId === scout.id && deliver.input.sessionBinding === null && deliver.input.toolProfile === 'readonly',
      'the destination launched fresh (no session to resume), read-only');
    assert(deliver.input.freshSession === true && extract.input.freshSession === undefined
      && JSON.parse(engine.listAttempts(view.hops.destination.request_id)[0].launch_snapshot).fresh_session === true,
    'the destination adapter is asked for a fresh session (recorded in its launch snapshot); the extraction is not');
    assert(leaks(JSON.stringify(deliver.input)).length === 0, 'the destination adapter input carries no source (or any) provider session id');
    assert(deliver.input.prompt.history.at(-1).content.includes('Finish the session exchange contract') && deliver.input.prompt.history.at(-1).content.includes('Hand the remaining test work to Scout.'),
      'the destination receives the packet and the owner instruction');
    assert(view.packet.objective === 'Finish the session exchange contract and land its tests' && view.packet.decisions.length === 2
      && view.packet.artifacts[1] === 'debug note [redacted session id]', 'a bounded structured packet is stored, with the provider session id redacted');
    const destination = one('SELECT * FROM session_bindings WHERE id = ?', view.destination.session_ref);
    const delivery = engine.getWorkRequest(view.hops.destination.request_id);
    const scoutConv = conversations.getByBotId(scout.id);
    assert(destination && destination.agent_id === scout.id && destination.request_id === delivery.id && destination.conversation_id === scoutConv.id
      && destination.external_session_id === SECRETS.scoutFresh && destination.id !== devSession.binding.id && destination.id !== scoutSession.binding.id,
    'a new destination binding owned by Scout, scoped to the delivery request in Scout\'s thread');
    assert(one('SELECT released_at FROM session_bindings WHERE id = ?', devSession.binding.id).released_at === null
      && one('SELECT released_at FROM session_bindings WHERE id = ?', scoutSession.binding.id).released_at === null, 'the source binding and Scout\'s earlier session are untouched');
    const extraction = engine.getWorkRequest(view.hops.source.request_id);
    assert(policyOf(extraction).hop === 'extract' && policyOf(delivery).hop === 'deliver' && policyOf(delivery).exchange_id === continueId
      && delivery.parent_request_id === null && delivery.execution_kind === 'conversation' && delivery.tool_profile === 'readonly'
      && policyOf(delivery).resume_session_binding === undefined, 'both hops name the exchange; the delivery is a fresh read-only root naming no binding');
    assert(view.hops.source.attempt_id === engine.listAttempts(extraction.id)[0].id && view.hops.destination.attempt_id === engine.listAttempts(delivery.id)[0].id
      && engine.listAttempts(delivery.id)[0].kind === 'launch', 'both hop Attempts are linked (the destination\'s is a launch, not a resume)');
    const reply = one("SELECT * FROM messages WHERE request_id = ? AND sender_type = 'bot'", delivery.id);
    assert(reply.conversation_id === scoutConv.id && reply.sender_id === scout.id, 'the destination reply lands in the destination conversation');
    assert(leaks(reply.content).length === 0 && reply.content.includes('[redacted session id]')
      && leaks(engine.listAttempts(delivery.id)[0].output).length === 0
      && count('SELECT COUNT(*) AS n FROM engine_events WHERE data LIKE ?', `%${SECRETS.scoutFresh}%`) === 0,
    'a destination reply echoing its own new session id keeps it out of the message, the Attempt output, and every event');
    const types = view.events.map(event => event.type);
    assert(JSON.stringify(types) === JSON.stringify(['created', 'hop_queued', 'state_changed', 'hop_started', 'packet_extracted', 'hop_queued', 'state_changed', 'hop_started', 'destination_replied', 'state_changed']),
      `ordered exchange events (${types.join(',')})`);
    assert(JSON.stringify(view.events.filter(event => event.type === 'state_changed').map(event => event.data.to)) === JSON.stringify(['extracting', 'delivering', 'completed']),
      'queued -> extracting -> delivering -> completed');
    const stored = JSON.stringify([one('SELECT * FROM session_exchanges WHERE id = ?', continueId), raw.prepare('SELECT * FROM session_exchange_events WHERE exchange_id = ?').all(continueId)]);
    assert(leaks(stored).length === 0 && leaks(JSON.stringify(view)).length === 0, 'no provider session id stored or shown');
  }

  // -------------------------------------------------------------------
  console.log('\n[4b] real Hermes adapter boundary: the destination never lands in its stable per-Agent gateway session');
  let scoutStableSession;
  {
    const hermes = jiti('./lib/hermes.ts');
    const config = hermes.loadHermesConfig();
    scoutStableSession = hermes.hermesSessionIdForBot(scout.id, config);
    const requests = [];
    dispatch.setAttemptAdapterOverride(null);
    dispatch.setAgentDispatchHermesFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      const text = body.messages.map(message => message.content).join('\n');
      const kind = text.includes('[Session Continue handoff') ? 'extract' : text.includes('[Session Continue]') ? 'deliver' : 'other';
      requests.push({ kind, session: init.headers['X-Hermes-Session-Id'], body: init.body });
      const content = kind === 'extract' ? packetJson() : kind === 'deliver' ? 'Scout (gateway) picking it up.' : 'Noted.';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      // An ordinary read-only turn first: it runs in Scout's stable gateway
      // session, which then holds unrelated memory but no Session Binding.
      const ordinary = service.acceptAgentMessage(OWNER, { agentId: scout.id, content: 'Remember: the launch codes are 0000.', idempotencyKey: 'hermes-ordinary-scout' });
      await ordinary.dispatched;
      await service.waitForAgentDispatchIdle();
      assert(requests.length === 1 && requests[0].kind === 'other' && requests[0].session === scoutStableSession
        && count('SELECT COUNT(*) AS n FROM session_bindings WHERE external_session_id = ?', scoutStableSession) === 0,
      'fixture: an ordinary Hermes turn ran in Scout\'s stable gateway session and bound nothing');

      const created = service.createExchangeCommand(cont({ idempotencyKey: 'continue-real-hermes' }));
      await created.dispatched;
      await service.waitForAgentDispatchIdle();
      const view = service.getExchangeView(created.exchange.id);
      const extract = requests.find(request => request.kind === 'extract');
      const deliver = requests.find(request => request.kind === 'deliver');
      assert(view.state === 'completed' && extract?.session === SECRETS.dev, `the extraction resumed the selected source gateway session (${view.state}${view.failure ? `: ${view.failure.message}` : ''})`);
      assert(!!deliver && deliver.session !== scoutStableSession && deliver.session !== SECRETS.dev && deliver.session !== SECRETS.scout
        && deliver.session.startsWith(`${scoutStableSession}-x-`), `the delivery opened a new gateway session for Scout (${deliver?.session})`);
      assert(!!deliver && leaks(deliver.body).length === 0 && !deliver.body.includes('launch codes'),
        'the delivery request carries no provider session id and none of the stable session\'s turns');
      const destination = one('SELECT * FROM session_bindings WHERE id = ?', view.destination.session_ref);
      assert(destination?.agent_id === scout.id && destination.external_session_id === deliver?.session && destination.adapter === 'hermes',
        'the new destination binding names exactly that fresh gateway session');

      // The adapter contract itself: a fresh-session input never resumes,
      // and without freshSession the stable session is what it would use.
      const adapter = jiti('./lib/hermes-attempt.ts').createHermesAttemptAdapter({ fetchImpl: (url, init) => {
        requests.push({ kind: 'direct', session: init.headers['X-Hermes-Session-Id'], body: init.body });
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
      } });
      const base = { target: { agentId: scout.id, agent: 'hermes' }, prompt: { kind: 'text', text: 'hi' }, cwd: null, deck: null, toolProfile: 'readonly', sessionBinding: null, correlation: {} };
      const both = await adapter.run({ ...base, freshSession: true, sessionBinding: { bindingId: 'b', externalSessionId: SECRETS.scout } });
      const fresh1 = await adapter.run({ ...base, freshSession: true });
      const fresh2 = await adapter.run({ ...base, freshSession: true });
      const standing = await adapter.run(base);
      assert(both.status === 'failed' && both.failure.category === 'session_mismatch', 'a fresh-session input that also names a binding fails before launch');
      assert(fresh1.externalSessionId !== fresh2.externalSessionId && fresh1.externalSessionId !== scoutStableSession && standing.externalSessionId === scoutStableSession,
        'each fresh-session launch gets its own gateway session; an ordinary launch keeps the stable one');
    } finally {
      dispatch.setAgentDispatchHermesFetch(null);
      installAdapter();
    }
  }

  // -------------------------------------------------------------------
  console.log('\n[5] Continue failures: extraction failure prevents launch; a destination failure stays visible and is retried only by a new key');
  {
    for (const [label, behavior, code] of [
      ['extraction turn failed', () => ({ fail: true }), 'source_turn_failed'],
      ['extraction returned no packet', () => ({ output: 'I would rather not.' }), 'packet_invalid'],
      ['packet over a limit', () => ({ output: packetJson({ decisions: Array.from({ length: 21 }, (_, i) => `d${i}`) }) }), 'packet_invalid'],
    ]) {
      script = (input, kind) => kind === 'extract' ? behavior() : { output: 'MUST NOT DELIVER' };
      const before = calls.length;
      const created = service.createExchangeCommand(cont({ idempotencyKey: `continue-fail-${code}-${label}` }));
      await created.dispatched;
      await service.waitForAgentDispatchIdle();
      const view = service.getExchangeView(created.exchange.id);
      assert(view.state === 'failed' && view.failure.code === code && view.hops.destination === null && exchanges.get(view.id).destination_request_id === null,
        `${label}: failed ${code} with no destination request (${view.failure.message})`);
      assert(calls.slice(before).every(call => call.kind !== 'deliver') && calls.slice(before).length === 1, `${label}: the destination adapter never ran`);
    }

    script = (input, kind) => kind === 'extract' ? { output: packetJson() } : { fail: true };
    const key = 'continue-dest-fail';
    const created = service.createExchangeCommand(cont({ idempotencyKey: key }));
    await created.dispatched;
    await service.waitForAgentDispatchIdle();
    const failed = service.getExchangeView(created.exchange.id);
    assert(failed.state === 'failed' && failed.failure.code === 'destination_turn_failed' && failed.hops.destination.state === 'failed'
      && engine.listAttempts(failed.hops.destination.request_id).length === 1, 'a destination failure after launch is visible, with one Attempt and no automatic retry');
    await service.recoverCoordinatorLoops();
    await service.waitForAgentDispatchIdle();
    assert(engine.listAttempts(failed.hops.destination.request_id).length === 1 && exchanges.get(failed.id).state === 'failed', 'recovery does not relaunch a failed hop');
    const requestsBefore = requestRows();
    const replay = service.createExchangeCommand(cont({ idempotencyKey: key }));
    await replay.dispatched;
    assert(!replay.created && replay.exchange.id === failed.id && replay.exchange.state === 'failed' && requestRows() === requestsBefore,
      'replaying the same key returns the failed exchange and runs nothing');
    script = (input, kind) => kind === 'extract' ? { output: packetJson() } : { output: 'Retry delivered.', session: 'prov-scout-RETRY-8888' };
    const retry = service.createExchangeCommand(cont({ idempotencyKey: `${key}-retry` }));
    await retry.dispatched;
    await service.waitForAgentDispatchIdle();
    assert(retry.created && retry.exchange.id !== failed.id && service.getExchangeView(retry.exchange.id).state === 'completed', 'a new idempotency key is the explicit retry');
  }

  // -------------------------------------------------------------------
  console.log('\n[5b] delivery boundaries: no Wakes, a fresh destination session, bounded outputs');
  {
    const run = async (key, behavior, input = cont) => {
      script = behavior;
      const created = service.createExchangeCommand(input({ idempotencyKey: key }));
      await created.dispatched;
      await service.waitForAgentDispatchIdle();
      return service.getExchangeView(created.exchange.id);
    };
    // A delivery reply that emits a Wake routes nothing: the exchange ends
    // with its one destination turn (no follow-up, no edit work).
    const wakesBefore = count('SELECT COUNT(*) AS n FROM wakes');
    const roseRequestsBefore = count('SELECT COUNT(*) AS n FROM work_requests WHERE target_agent_id = ?', rose.id);
    const waking = await run('deliver-wake', (input, kind) => kind === 'extract' ? { output: packetJson() }
      : { output: 'On it.\nWAKE Rose: implement the cards with edit access', session: 'prov-scout-WAKE-1212' });
    const wakingDelivery = engine.getWorkRequest(waking.hops.destination.request_id);
    assert(waking.state === 'completed' && count('SELECT COUNT(*) AS n FROM wakes') === wakesBefore
      && count('SELECT COUNT(*) AS n FROM work_requests WHERE target_agent_id = ?', rose.id) === roseRequestsBefore
      && JSON.parse(wakingDelivery.result).reply_message_id === undefined && typeof JSON.parse(wakingDelivery.result).destination_message_id === 'string',
    'a Wake in the delivery reply routes nothing (no Wake, no follow-up Work Request)');

    // No fresh destination session: the hand-off fails visibly, unbound.
    for (const [label, session, reason] of [
      ['no session reported', null, 'not_reported'],
      ['the source session id reported', SECRETS.dev, 'reused'],
      ['an already-bound session id reported', SECRETS.scout, 'reused'],
      ['the stable gateway session an ordinary turn ran in', scoutStableSession, 'reused'],
    ]) {
      const bindingsBefore = count('SELECT COUNT(*) AS n FROM session_bindings WHERE agent_id = ?', scout.id);
      const view = await run(`deliver-session-${reason}-${label}`, (input, kind) => kind === 'extract' ? { output: packetJson() } : { output: 'Delivered.', session });
      const rejected = view.events.find(event => event.type === 'destination_session_rejected');
      assert(view.state === 'failed' && view.failure.code === 'destination_session_invalid' && view.destination.session_ref === null
        && rejected?.data.reason === reason && count('SELECT COUNT(*) AS n FROM session_bindings WHERE agent_id = ?', scout.id) === bindingsBefore
        && count("SELECT COUNT(*) AS n FROM messages WHERE request_id = ?", view.hops.destination.request_id) === 0,
      `${label}: failed destination_session_invalid, no destination binding or reply (${view.failure?.message})`);
    }

    // Output bounds: at the limit kept whole; over it, cut to the limit
    // with the marker included; extraction output over its limit refused.
    const L = lib.EXCHANGE_LIMITS;
    assert(lib.boundOutput('a'.repeat(40), 40).content.length === 40 && !lib.boundOutput('a'.repeat(40), 40).truncated
      && lib.boundOutput('a'.repeat(41), 40).content.length === 40 && lib.boundOutput('a'.repeat(41), 40).truncated
      && lib.boundOutput('a'.repeat(41), 5).content.length === 5, 'boundOutput keeps the limit, marker included');
    const atLimit = await run('ask-at-limit', () => ({ output: 'a'.repeat(L.answerChars) }), ask);
    const overLimit = await run('ask-over-limit', () => ({ output: 'b'.repeat(L.answerChars * 2) }), ask);
    assert(atLimit.answer.content.length === L.answerChars && !atLimit.answer.content.includes('[truncated]'), `an answer of exactly ${L.answerChars} characters is kept whole`);
    assert(overLimit.answer.content.length === L.answerChars && overLimit.answer.content.endsWith('[truncated]'), `an oversized answer is stored at ${L.answerChars} characters, marker included`);
    const attemptOutput = hopId => one('SELECT output FROM work_attempts WHERE request_id = ?', hopId).output;
    assert(attemptOutput(overLimit.hops.source.request_id).length === L.answerChars && attemptOutput(atLimit.hops.source.request_id).length === L.answerChars
      && overLimit.events.find(event => event.type === 'answer_returned')?.data.truncated === true,
    'the oversized answer\'s Attempt output is stored bounded as well (and the answer reads truncated)');
    const longReply = await run('deliver-over-limit', (input, kind) => kind === 'extract' ? { output: packetJson() }
      : { output: 'c'.repeat(L.replyChars * 3), session: 'prov-scout-LONG-1313' });
    const replyMessage = one("SELECT content FROM messages WHERE request_id = ?", longReply.hops.destination.request_id);
    assert(longReply.state === 'completed' && replyMessage.content.length === L.replyChars && replyMessage.content.endsWith('[truncated]'),
      `an oversized delivery reply is stored at ${L.replyChars} characters`);
    assert(attemptOutput(longReply.hops.destination.request_id).length === L.replyChars, 'the oversized delivery Attempt output is stored bounded as well');
    const padded = packetJson() + ' '.repeat(L.extractionOutputChars);
    assert(padded.length > L.extractionOutputChars, 'fixture: the padded extraction output is over its limit');
    const oversized = await run('extract-over-limit', (input, kind) => kind === 'extract' ? { output: padded } : { output: 'MUST NOT DELIVER', session: 'prov-scout-NO-1414' });
    assert(oversized.state === 'failed' && oversized.failure.code === 'packet_invalid' && /extraction output exceeds/.test(oversized.failure.message)
      && oversized.hops.destination === null, 'an extraction output over its limit is refused before any packet is stored or destination launched');
    assert(attemptOutput(oversized.hops.source.request_id).length === L.extractionOutputChars && oversized.packet === null,
      `the oversized extraction is never stored whole: its Attempt output is cut to ${L.extractionOutputChars} characters`);
    assert(lib.parseHandoffPacket(packetJson() + ' '.repeat(L.extractionOutputChars - packetJson().length)).ok, 'an extraction output exactly at its limit parses');
    assert(waking.limits.promptChars === L.promptChars && L.instructionChars + L.packetChars + 2000 <= L.promptChars,
      'the hop prompt ceiling covers the bounded instruction and packet');
  }

  // -------------------------------------------------------------------
  console.log('\n[6] cancellation of a running hop: truthful state, nothing after it');
  {
    const L = lib.EXCHANGE_LIMITS;
    for (const mode of ['ask', 'continue']) {
      const held = holdAdapter();
      script = (input, kind) => kind === 'extract'
        ? { output: `${packetJson()}\n(session ${SECRETS.dev})` }
        : { output: `Late answer that must be discarded. (session ${SECRETS.dev}) ${'d'.repeat(L.answerChars)}` };
      const before = calls.length;
      const created = service.createExchangeCommand(mode === 'ask' ? ask({ idempotencyKey: 'cancel-run-ask' }) : cont({ idempotencyKey: 'cancel-run-continue' }));
      const hopId = created.exchange.hops.source.request_id;
      await waitFor(() => callsFor(hopId).length === 1, `${mode} hop in its adapter`);
      const cancelled = await service.cancelExchangeCommand(created.exchange.id, OWNER, 'changed my mind');
      assert(cancelled.exchange.state === 'extracting' && cancelled.exchange.cancel !== null && engine.getWorkRequest(hopId).cancel_requested_at !== null,
        `${mode}: while its hop is still running the exchange stays extracting with the cancel recorded`);
      const replayed = await service.cancelExchangeCommand(created.exchange.id, OWNER, 'again');
      assert(replayed.replayed && replayed.exchange.cancel.reason === 'changed my mind', `${mode}: a repeated cancel is a replay (intent recorded once)`);
      held.release();
      await service.waitForAgentDispatchIdle();
      const view = service.getExchangeView(created.exchange.id);
      assert(view.state === 'cancelled' && engine.getWorkRequest(hopId).state === 'cancelled', `${mode}: once the hop ended, the exchange is cancelled`);
      assert(view.answer === null && view.packet === null && view.hops.destination === null && calls.slice(before).every(call => call.kind !== 'deliver'),
        `${mode}: no answer, packet, or destination launch after cancellation`);
      const lateEvents = raw.prepare("SELECT data FROM engine_events WHERE request_id = ? AND type = 'late_result_recorded'").all(hopId);
      const stored = one('SELECT output FROM work_attempts WHERE request_id = ?', hopId).output ?? '';
      const limit = mode === 'ask' ? L.answerChars : L.extractionOutputChars;
      assert(lateEvents.length === 1 && lateEvents.every(row => { const output = JSON.parse(row.data).output ?? ''; return !output.includes(SECRETS.dev) && output.length <= limit; })
        && !stored.includes(SECRETS.dev) && stored.length <= limit
        && count('SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ? AND data LIKE ?', hopId, `%${SECRETS.dev}%`) === 0,
      `${mode}: the cancelled hop's late result and Attempt output are redacted and bounded`);
    }
  }

  // -------------------------------------------------------------------
  console.log('\n[7] restart: an interrupted hop, and a Continue whose destination was queued when the process died');
  {
    // (a) The source hop is running when the worker dies. A new dispatcher
    // takes over the expired lease: the run cannot be observed, so the hop
    // is interrupted (never relaunched) and the exchange says so.
    const held = holdAdapter();
    script = () => ({ output: 'never committed' });
    const created = service.createExchangeCommand(ask({ sessionRef: roseSession.binding.id, sourceAgentId: rose.id, idempotencyKey: 'restart-running' }));
    const hopId = created.exchange.hops.source.request_id;
    await waitFor(() => callsFor(hopId).length === 1, 'restart hop in its adapter');
    assert(exchanges.get(created.exchange.id).state === 'extracting', 'before the crash the exchange is extracting');
    // The worker is still awaiting its adapter in this process; its lease
    // expires as if the process had died. A real second process recovers.
    raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(hopId);

    // (b) Extraction committed (packet stored, destination hop queued in the
    // same transaction) and the process died before dispatching it. A real
    // second process recovers it and launches the destination exactly once.
    const pending = exchanges.create(cont({ idempotencyKey: 'restart-pending' })).exchange;
    const extraction = engine.getWorkRequest(pending.source_request_id);
    engine.transaction(() => {
      engine.transitionWorkRequest(extraction.id, { from: 'queued', to: 'running' });
      const attempt = engine.createAttempt(extraction.id, { kind: 'resume', adapter: 'hermes', toolProfile: 'readonly', launchSnapshot: { test: 'crash' }, resumedSessionBindingId: devSession.binding.id });
      exchanges.hopClaimed(extraction.id, attempt.id, Date.now());
      const finished = engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: packetJson() });
      const result = exchanges.commitHop(extraction, finished, { status: 'completed', output: packetJson(), externalSessionId: null }, Date.now());
      engine.transitionWorkRequest(extraction.id, { from: 'running', to: 'completed', result });
      exchanges.advance(pending.id);
    });
    const crashed = exchanges.get(pending.id);
    assert(crashed.state === 'delivering' && engine.getWorkRequest(crashed.destination_request_id).state === 'queued' && crashed.packet !== null,
      'at the crash: delivering, packet stored, destination hop queued and never launched');
    const readIds = [continueId];
    const parentViews = readIds.map(id => exchanges.view(id));
    const child = spawnSync(process.execPath, [__filename], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, EXCHANGE_SCENARIO: 'restart-child', EXCHANGE_PENDING_IDS: JSON.stringify([created.exchange.id, pending.id]), EXCHANGE_READ_IDS: JSON.stringify(readIds) },
    });
    assert(child.status === 0, `restart child exited 0 (status ${child.status}${child.stderr ? `, stderr: ${child.stderr.slice(0, 400)}` : ''})`);
    const out = JSON.parse(child.stdout || '{}');
    assert(JSON.stringify(out.before) === JSON.stringify(parentViews), 'a fresh process reads the same exchange views (restart-safe reads)');
    const [interrupted, delivered] = out.pending;
    assert(interrupted.state === 'failed' && interrupted.failure.code === 'source_turn_failed' && /interrupted/.test(interrupted.failure.message)
      && engine.getWorkRequest(hopId).error_code === 'interrupted' && callsFor(hopId).length === 1 && out.calls.every(call => call.requestId !== hopId),
    `(a) after restart the running hop is failed (interrupted) and was not relaunched (${interrupted.failure?.message})`);
    assert(delivered.state === 'completed' && delivered.destination.session_ref !== null && out.calls.length === 1 && out.calls[0].kind === 'deliver'
      && out.calls[0].agentId === scout.id && out.calls[0].sessionBinding === null && leaks(out.calls[0].input).length === 0,
    '(b) the restarted process launched the queued destination once, fresh, with no provider session id');
    const finalRow = exchanges.get(pending.id);
    assert(finalRow.state === 'completed' && one('SELECT external_session_id FROM session_bindings WHERE id = ?', finalRow.destination_binding_id).external_session_id === SECRETS.scoutRestart,
      'the first process sees the completed exchange and its new destination binding');
    held.release();
    await service.waitForAgentDispatchIdle();
    assert(exchanges.get(created.exchange.id).state === 'failed' && !service.getExchangeView(created.exchange.id).answer
      && count("SELECT COUNT(*) AS n FROM messages WHERE request_id = ?", hopId) === 0, 'the stale first-process worker could not write an answer afterwards');
    service.configureDispatcher({ owner: `exchange-test-2:${process.pid}`, config: { maxGlobal: 10, maxPerTarget: 1 } });
  }

  // -------------------------------------------------------------------
  console.log('\n[8] owner routes: create, detail, cancel; safe references and actionable errors');
  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  const texts = [];
  const call = async (method, pathname, body) => {
    const response = await host.owner(method, pathname, body);
    texts.push(response.text);
    return response;
  };
  try {
    script = (input, kind) => kind === 'ask' ? { output: 'Route answer.' } : kind === 'extract' ? { output: packetJson() } : { output: 'Route delivery.', session: 'prov-scout-ROUTE-9999' };
    const askBody = {
      mode: 'ask', idempotency_key: 'route-ask', origin_conversation_id: tankConv.id,
      source: { agent_id: dev.id, session_ref: devSession.binding.id }, instruction: 'What is left to do?',
    };
    const created = await call('POST', '/api/exchanges', askBody);
    assert(created.status === 201 && created.json.replayed === false && typeof created.json.exchange.id === 'string'
      && created.json.exchange.source.session_ref === devSession.binding.id, 'POST /api/exchanges (ask) is 201 with the exchange and its session reference');
    await service.waitForAgentDispatchIdle();
    const detail = await call('GET', `/api/exchanges/${created.json.exchange.id}`);
    assert(detail.status === 200 && detail.json.exchange.state === 'completed' && detail.json.exchange.answer.content === 'Route answer.'
      && detail.json.exchange.answer.conversation_id === tankConv.id && detail.json.exchange.hops.source.tool_profile === 'readonly',
    'GET /api/exchanges/:id shows the completed Ask, its answer, and read-only hop');
    const replay = await call('POST', '/api/exchanges', askBody);
    assert(replay.status === 200 && replay.json.replayed === true && replay.json.exchange.id === created.json.exchange.id, 'an exact replay is 200 with the same exchange');
    const conflict = await call('POST', '/api/exchanges', { ...askBody, instruction: 'Something else' });
    assert(conflict.status === 409 && conflict.json.error.code === 'idempotency_conflict', 'the same key with another payload is 409 idempotency_conflict');

    const contBody = {
      mode: 'continue', idempotency_key: 'route-continue', origin_conversation_id: tankConv.id,
      source: { agent_id: dev.id, session_ref: devSession.binding.id }, destination: { agent_id: scout.id }, instruction: 'Take it from here.',
    };
    const contCreated = await call('POST', '/api/exchanges', contBody);
    assert(contCreated.status === 201 && contCreated.json.exchange.mode === 'continue' && contCreated.json.exchange.destination.agent_id === scout.id, 'POST /api/exchanges (continue) is 201');
    await service.waitForAgentDispatchIdle();
    const contDetail = await call('GET', `/api/exchanges/${contCreated.json.exchange.id}`);
    assert(contDetail.status === 200 && contDetail.json.exchange.state === 'completed' && typeof contDetail.json.exchange.destination.session_ref === 'string'
      && contDetail.json.exchange.packet.objective.length > 0, 'the Continue completed with a destination session reference and its packet');

    const base = { ...askBody, idempotency_key: 'route-err' };
    const variants = [
      ['missing mode', { ...base, mode: undefined }, 400, 'invalid_request'],
      ['unknown mode', { ...base, mode: 'debate' }, 400, 'invalid_request'],
      ['unknown field', { ...base, priority: 'high' }, 400, 'invalid_request'],
      ['two sources', { ...base, source: [askBody.source, askBody.source] }, 400, 'invalid_request'],
      ['two destinations', { ...contBody, idempotency_key: 'route-err-2', destination: [{ agent_id: scout.id }, { agent_id: tank.id }] }, 400, 'destination_invalid'],
      ['edit-seeking execution_kind', { ...base, execution_kind: 'implementation' }, 403, 'authority_not_allowed'],
      ['edit-seeking tool_profile', { ...base, tool_profile: 'edit' }, 403, 'authority_not_allowed'],
      ['recursive', { ...base, parent_exchange_id: created.json.exchange.id }, 403, 'recursive_exchange'],
      ['unknown session', { ...base, source: { agent_id: dev.id, session_ref: 'nope' } }, 404, 'session_not_found'],
      ['cross-Agent session', { ...base, source: { agent_id: dev.id, session_ref: scoutSession.binding.id } }, 404, 'session_not_found'],
      ['ended session', { ...base, source: { agent_id: dev.id, session_ref: ended.binding.id } }, 409, 'session_ended'],
      ['other runtime', { ...base, source: { agent_id: dev.id, session_ref: codex.binding.id } }, 409, 'session_not_resumable'],
      ['unknown Agent', { ...base, source: { agent_id: 'nope', session_ref: devSession.binding.id } }, 404, 'agent_not_found'],
      ['unknown origin', { ...base, origin_conversation_id: 'nope' }, 404, 'conversation_not_found'],
      ['ask with destination', { ...base, destination: { agent_id: scout.id } }, 400, 'destination_invalid'],
      ['continue without destination', { ...contBody, idempotency_key: 'route-err-3', destination: undefined }, 400, 'destination_invalid'],
      ['continue to itself', { ...contBody, idempotency_key: 'route-err-4', destination: { agent_id: dev.id } }, 400, 'destination_invalid'],
    ];
    for (const [label, body, status, code] of variants) {
      const response = await call('POST', '/api/exchanges', body);
      assert(response.status === status && response.json?.error?.code === code && typeof response.json.error.message === 'string' && response.json.error.message.length > 0,
        `${label}: ${status} ${code} (${response.json?.error?.message})`);
    }
    const notJson = await host.owner('POST', '/api/exchanges');
    texts.push(notJson.text);
    assert(notJson.status === 400 && notJson.json.error.code === 'invalid_request', 'an empty body is 400 invalid_request');
    const unknownGet = await call('GET', '/api/exchanges/no-such-exchange');
    assert(unknownGet.status === 404 && unknownGet.json.error.code === 'exchange_not_found', 'an unknown exchange is 404');
    const unknownCancel = await call('POST', '/api/exchanges/no-such-exchange/cancel', {});
    assert(unknownCancel.status === 404 && unknownCancel.json.error.code === 'exchange_not_found', 'cancelling an unknown exchange is 404');
    const terminalCancel = await call('POST', `/api/exchanges/${created.json.exchange.id}/cancel`, {});
    assert(terminalCancel.status === 409 && terminalCancel.json.error.code === 'exchange_terminal'
      && exchanges.get(created.json.exchange.id).state === 'completed', 'cancelling a terminal exchange is 409 exchange_terminal and changes nothing');

    const held = holdAdapter();
    const live = await call('POST', '/api/exchanges', { ...askBody, idempotency_key: 'route-cancel' });
    for (const [label, body] of [['an array', []], ['a boolean', true], ['a string', 'stop'], ['an unknown field', { reason: 'x', force: true }], ['a non-string reason', { reason: 3 }]]) {
      const refused = await call('POST', `/api/exchanges/${live.json.exchange.id}/cancel`, body);
      assert(refused.status === 400 && refused.json.error.code === 'invalid_request' && exchanges.get(live.json.exchange.id).cancel_requested_at === null,
        `a cancel body that is ${label} is 400 invalid_request and cancels nothing (${refused.json.error.message})`);
    }
    await waitFor(() => callsFor(live.json.exchange.hops.source.request_id).length === 1, 'route Ask in its adapter');
    const cancel = await call('POST', `/api/exchanges/${live.json.exchange.id}/cancel`, { reason: 'stop' });
    assert(cancel.status === 200 && cancel.json.exchange.cancel.reason === 'stop' && cancel.json.exchange.state === 'extracting', 'cancel of a running Ask is 200 with the recorded intent');
    held.release();
    await service.waitForAgentDispatchIdle();
    const afterCancel = await call('GET', `/api/exchanges/${live.json.exchange.id}`);
    assert(afterCancel.json.exchange.state === 'cancelled' && afterCancel.json.exchange.answer === null, 'it then reads cancelled, with no answer');

    const foreign = await host.foreign('POST', '/api/exchanges', { ...askBody, idempotency_key: 'route-foreign' });
    assert(foreign.status === 403 && count("SELECT COUNT(*) AS n FROM session_exchanges WHERE idempotency_key = 'route-foreign'") === 0,
      'a cross-origin create is refused by the owner boundary and writes nothing');
    assert(texts.every(text => leaks(text).length === 0) && texts.every(text => !text.includes('external_session_id')),
      `no response body (${texts.length} checked) carries a provider session id`);
  } finally {
    await host.close();
  }

  // -------------------------------------------------------------------
  console.log('\n[9] referential cleanup');
  {
    const temp = agent('Temp');
    const tempSession = seedSession(temp, 'prov-temp-SECRET-0001', { key: 'temp' });
    const asTemp = exchanges.create(ask({ sourceAgentId: temp.id, sessionRef: tempSession.binding.id, idempotencyKey: 'cleanup-1' })).exchange;
    const toTemp = exchanges.create(cont({ sourceAgentId: rose.id, sessionRef: roseSession.binding.id, destinationAgentId: temp.id, idempotencyKey: 'cleanup-2' })).exchange;
    assert(/FOREIGN KEY/.test(threw(() => raw.prepare('DELETE FROM bots WHERE id = ?').run(temp.id))?.message ?? ''), 'an Agent an exchange names cannot be deleted directly');
    // The real Agent delete path (lib/db bots.removeMany) refuses an Agent
    // with open work, so the exchanges end first; their rows stay.
    await service.cancelExchangeCommand(asTemp.id, OWNER);
    await service.cancelExchangeCommand(toTemp.id, OWNER);
    assert(!!exchanges.get(asTemp.id) && !!exchanges.get(toTemp.id), 'cancelled exchanges are kept');
    bots.removeMany([temp.id]);
    assert(!exchanges.get(asTemp.id) && !exchanges.get(toTemp.id) && count('SELECT COUNT(*) AS n FROM session_exchange_events WHERE exchange_id IN (?, ?)', asTemp.id, toTemp.id) === 0,
      'deleting an Agent removes exchanges sourced from or delivered to it, with their events');
    assert(!engine.getWorkRequest(asTemp.source_request_id) && one('SELECT 1 AS ok FROM session_bindings WHERE id = ?', roseSession.binding.id)?.ok === 1,
      'their hop requests go too; other Agents\' sessions stay');
    // Open exchanges: their hop requests run elsewhere (the source hop in
    // the source binding's thread, for the source Agent), yet go with the
    // exchange when its origin conversation or destination Agent is deleted.
    const srcA = agent('CleanSrcA');
    const srcB = agent('CleanSrcB');
    const destB = agent('CleanDestB');
    const originAgent = agent('CleanOrigin');
    const originConv = conversations.getByBotId(originAgent.id);
    const sessionA = seedSession(srcA, 'prov-cleana-SECRET-0002', { key: 'clean-a' });
    const sessionB = seedSession(srcB, 'prov-cleanb-SECRET-0003', { key: 'clean-b' });
    const fromOrigin = exchanges.create(cont({ originConversationId: originConv.id, sourceAgentId: srcA.id, sessionRef: sessionA.binding.id, destinationAgentId: scout.id, idempotencyKey: 'cleanup-open-origin' })).exchange;
    const toDest = exchanges.create(cont({ sourceAgentId: srcB.id, sessionRef: sessionB.binding.id, destinationAgentId: destB.id, idempotencyKey: 'cleanup-open-dest' })).exchange;
    const hopA = engine.getWorkRequest(fromOrigin.source_request_id);
    const hopB = engine.getWorkRequest(toDest.source_request_id);
    assert(hopA.state === 'queued' && hopA.source_conversation_id === sessionA.conv.id && hopA.target_agent_id === srcA.id
      && hopB.state === 'queued' && hopB.target_agent_id === srcB.id, 'fixture: open exchanges whose source hops run in the source thread for the source Agent');
    raw.transaction(() => engineStore.deleteEngineRecordsForConversation(raw, originConv.id))();
    assert(!exchanges.get(fromOrigin.id) && !engine.getWorkRequest(hopA.id)
      && count('SELECT COUNT(*) AS n FROM session_exchange_events WHERE exchange_id = ?', fromOrigin.id) === 0
      && one('SELECT 1 AS ok FROM session_bindings WHERE id = ?', sessionA.binding.id)?.ok === 1 && !!engine.getWorkRequest(sessionA.request.id),
    'deleting an open exchange\'s origin conversation removes its queued source hop request too (the source session and its own work stay)');
    raw.transaction(() => engineStore.deleteEngineRecordsForAgent(raw, destB.id))();
    assert(!exchanges.get(toDest.id) && !engine.getWorkRequest(hopB.id)
      && count('SELECT COUNT(*) AS n FROM session_exchange_events WHERE exchange_id = ?', toDest.id) === 0
      && one('SELECT 1 AS ok FROM session_bindings WHERE id = ?', sessionB.binding.id)?.ok === 1 && !!engine.getWorkRequest(sessionB.request.id),
    'deleting an open exchange\'s destination Agent removes its queued source hop request (for the source Agent) too');
    assert(count('SELECT COUNT(*) AS n FROM work_requests WHERE requester_id = ? AND id NOT IN (SELECT source_request_id FROM session_exchanges UNION SELECT destination_request_id FROM session_exchanges WHERE destination_request_id IS NOT NULL)', 'botmancers-exchanges') === 0,
      'no exchange hop request outlives its exchange');
    const tankThreadExchanges = count('SELECT COUNT(*) AS n FROM session_exchanges WHERE origin_conversation_id = ?', tankConv.id);
    raw.transaction(() => engineStore.deleteEngineRecordsForConversation(raw, tankConv.id))();
    assert(tankThreadExchanges > 0 && count('SELECT COUNT(*) AS n FROM session_exchanges WHERE origin_conversation_id = ?', tankConv.id) === 0,
      'deleting the origin conversation\'s engine records removes its exchanges');
  }

  console.log(`\n${failures === 0 ? 'All exchange checks passed.' : `${failures} exchange check(s) FAILED.`}`);
  dispatch.setAttemptAdapterOverride(null);
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
  process.exit(failures === 0 ? 0 : 1);
}

if (CHILD) {
  restartChild().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
} else {
  main().catch(error => { console.error(error); process.exit(1); });
}
