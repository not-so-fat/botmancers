#!/usr/bin/env node
// NOT-473: cancellation, deadlines, and bounded retry policy
// (lib/work-request-control, lib/request-policy, lib/dispatcher,
// lib/agent-conversations, lib/conversation-projection).
//
// Deterministic: the dispatcher runs on a fake clock (advanced by hand),
// adapters are controlled fakes that finish only when the test says so,
// and direct coding turns run against a scripted in-process
// SessionProvider. Proves:
//
// [1] cancel from queued, blocked, running (cooperative and stalled),
//     waiting, and terminal states, each with an explicit idempotent
//     outcome, plus the authorization hook;
// [2] deadlines time out queued, running, and waiting work and prevent
//     new launches after expiry;
// [3] retryable failures schedule at most the configured bounded
//     Attempts with deterministic backoff, terminal failures never retry,
//     manual-attention failures wait for an operator retry, and a retry
//     never duplicates an active Attempt;
// [4] a late adapter result after cancellation, timeout, or a superseding
//     retry is recorded as evidence and never completes the request;
//     external cancellation is requested only where the runtime supports
//     it and is recorded honestly where it does not; a cancel or deadline
//     arriving during reconciliation runtime I/O (follow, re-POST) wins
//     over the reconcile decision; losing sight of a turn whose cleanup
//     cancel fails records it abandoned and never retries beside it;
// [5] conversation projections distinguish cancel requested, cancelled,
//     timed out, retry scheduled, and retries exhausted.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-request-control-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-request-control-home-'));
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';
for (const name of Object.values({
  deadlineMs: 'BOTMANCERS_REQUEST_DEADLINE_MS', maxAttempts: 'BOTMANCERS_RETRY_MAX_ATTEMPTS', baseDelayMs: 'BOTMANCERS_RETRY_BASE_DELAY_MS',
  maxDelayMs: 'BOTMANCERS_RETRY_MAX_DELAY_MS', attemptTimeoutMs: 'BOTMANCERS_ATTEMPT_TIMEOUT_MS',
})) delete process.env[name];

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const executor = jiti('./lib/attempt-executor.ts');
const intake = jiti('./lib/conversation-intake.ts');
const policy = jiti('./lib/request-policy.ts');
const control = jiti('./lib/work-request-control.ts');
const lib = jiti('./lib/dispatcher.ts');
const adapterLib = jiti('./lib/attempt-adapter.ts');
const providerContract = jiti('./lib/session-provider.ts');
const sessions = jiti('./lib/provider-sessions.ts');
const fake = require('./test-support/fake-session-provider.js');
const raw = db.default;
const { bots, engine, projector } = db;

let failures = 0;
// A test that awaits a promise nothing will settle would end the event loop
// and exit 0; count that as a failure.
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.log('\nTEST RESULT: FAIL (exited before finishing)');
    process.exitCode = 1;
  }
});
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
const PERSON = { kind: 'person', id: 'control-owner' };
const STRANGER = { kind: 'person', id: 'not-a-participant' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(2);
  }
  assert(false, `timed out waiting: ${label}`);
  return false;
}
const one = (sql, ...args) => raw.prepare(sql).get(...args);
const all = (sql, ...args) => raw.prepare(sql).all(...args);
const types = id => engine.listEvents(id).map(event => event.type);
const count = (id, type) => types(id).filter(t => t === type).length;
const eventData = (id, type) => engine.listEvents(id).filter(e => e.type === type).map(e => JSON.parse(e.data || 'null'));
const attemptsOf = id => all('SELECT * FROM work_attempts WHERE request_id = ? ORDER BY attempt_number', id);
const openAttempts = id => one('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ? AND finished_at IS NULL', id).n;
const leaseOf = id => one('SELECT * FROM dispatch_leases WHERE request_id = ?', id);
const attentionOf = id => one('SELECT * FROM dispatch_attention WHERE request_id = ? AND cleared_at IS NULL', id);
const repliesOf = id => all("SELECT * FROM messages WHERE request_id = ? AND sender_type = 'bot'", id);
const req = id => engine.getWorkRequest(id);
const kindsOf = (conversationId, requestId) =>
  projector.listConversationEvents(conversationId).filter(e => e.requestId === requestId).map(e => e.kind);

// ---------------------------------------------------------------------
// Fake clock: every dispatcher/control decision reads it.
let clock = Date.now();
const advance = ms => { clock += ms; };
function configure(extra = {}) {
  return service.configureDispatcher({
    owner: `control-test:${process.pid}`,
    now: () => clock,
    config: { maxGlobal: 50, maxPerTarget: 50, leaseMs: 10 * 60_000, heartbeatMs: 10, cancelGraceMs: 30_000, ...extra },
  });
}

// Request control defaults are read from the environment at intake.
function withPolicy(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = String(value); }
  try { return fn(); } finally {
    for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

// A queued request that nothing dispatches yet.
function queuedRequest(agentId, key, env = {}) {
  intake.setIntakeDispatcher(() => {});
  try {
    return withPolicy(env, () => service.acceptAgentMessage(PERSON, { agentId, content: `Task ${key}`, idempotencyKey: key }).accepted);
  } finally {
    intake.setIntakeDispatcher(null);
  }
}

function botNamed(name, fields) {
  return bots.getAll().find(bot => bot.name === name) || bots.create({ name, title: '', description: '', ...fields });
}

// Controlled Hermes-transport adapter. Each run waits for the test to
// finish it. honorSignal: an abort ends the run cancelled (a cooperative
// runtime); otherwise the run ignores it (a stalled runtime).
const runs = [];
function result(fields, input) {
  const now = Date.now();
  const failed = fields.category ? adapterLib.attemptFailure(fields.category, `fake ${fields.category}`, fields.code ?? null) : null;
  return {
    status: failed ? 'failed' : 'completed', adapter: 'hermes-gateway', externalRunId: fields.runId ?? null, externalSessionId: null,
    output: failed ? null : (fields.output ?? `ok ${input.correlation.requestId}`), artifacts: [], startedAt: now, finishedAt: now, failure: failed,
  };
}
// withRunId false: the runtime starts work but names no run (as Hermes).
function useControlledAdapter({ honorSignal = false, script = null, externalCancel = false, withRunId = true } = {}) {
  dispatch.setAttemptAdapterOverride(() => ({
    name: 'hermes-gateway',
    ...(externalCancel ? { externalCancel: true } : {}),
    run(input, onEvent) {
      return new Promise(resolve => {
        const entry = {
          input, requestId: input.correlation.requestId, attemptId: input.correlation.attemptId, done: false,
          finish(fields = {}) { if (!entry.done) { entry.done = true; resolve(result(fields, input)); } },
        };
        runs.push(entry);
        onEvent({ type: 'started', adapter: 'hermes-gateway', at: Date.now(), externalRunId: withRunId ? `run-${entry.attemptId}` : null, externalSessionId: null });
        if (honorSignal && input.signal) {
          if (input.signal.aborted) entry.finish({ category: 'cancelled' });
          else input.signal.addEventListener('abort', () => entry.finish({ category: 'cancelled' }), { once: true });
        }
        if (script) script(entry);
      });
    },
  }));
}
const runsFor = id => runs.filter(entry => entry.requestId === id);

let hermes;
let codex;
let WORKROOT;
let STATE;

// The direct provider behind every coding turn: the file-backed fake,
// wrapped so a test can gate one provider call in flight (reconciliation
// races), refuse cancels while the turn keeps running, or fail one
// observe. providerSpy counts wrapper-level calls (including refused
// ones, which never reach the fake's own log).
let providerGate = null;
let failCancelWith = null;
let failObserveWith = null;
const providerSpy = { startSession: 0, sendTurn: 0, observeTurn: 0, cancelTurn: 0 };
function wrappedProvider() {
  const inner = fake.createFakeSessionProvider({ statePath: STATE, kind: 'control-main' });
  const wrap = method => async input => {
    providerSpy[method] += 1;
    if (providerGate && providerGate.method === method && !providerGate.hit) {
      providerGate.hit = true;
      await providerGate.gate;
    }
    if (method === 'cancelTurn' && failCancelWith) return { ok: false, error: { ...failCancelWith } };
    if (method === 'observeTurn' && failObserveWith) {
      const failure = failObserveWith;
      failObserveWith = null;
      return { ok: false, error: { ...failure } };
    }
    return inner[method](input);
  };
  return {
    ...inner,
    startSession: wrap('startSession'), sendTurn: wrap('sendTurn'), observeTurn: wrap('observeTurn'), cancelTurn: wrap('cancelTurn'),
  };
}
function gateProviderCall(method) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  providerGate = { method, hit: false, gate, release: () => release() };
  return providerGate;
}
function clearProviderGate() { providerGate = null; }

// Provider-side evidence: starts, observes, cancels, and turn states.
const startCalls = () => fake.providerCalls(STATE, 'startSession');
const observeCalls = () => fake.providerCalls(STATE, 'observeTurn');
const cancelCalls = () => fake.providerCalls(STATE, 'cancelTurn');
const registryTurn = ref => sessions.getProviderTurn(raw, codex.id, ref);
const fakeTurnState = fakeId => fake.loadFakeState(STATE).turns[fakeId]?.state ?? null;
const providerTurnIdOf = runId => one('SELECT provider_turn_id AS id FROM provider_session_turns WHERE id = ?', runId)?.id ?? null;
function holdNextTurns(count = 1) {
  fake.mutateFakeProvider(STATE, state => { state.holdNext = (state.holdNext ?? 0) + count; });
}
function scriptProviderTurn(fakeId, fields) {
  fake.mutateFakeProvider(STATE, state => {
    if (!state.turns[fakeId]) throw new Error(`no provider turn ${fakeId}`);
    Object.assign(state.turns[fakeId], fields);
  });
}
function deleteProviderTurn(fakeId) {
  fake.mutateFakeProvider(STATE, state => { delete state.turns[fakeId]; });
}
function newTurnIds(before) {
  const seen = new Set(before);
  return fake.fakeTurnIds(STATE).filter(id => !seen.has(id));
}

// ---------------------------------------------------------------------
async function cancelStateMachine() {
  console.log('\n[1] cancel: explicit idempotent outcome for every starting state');
  configure();
  useControlledAdapter({ honorSignal: true });

  // queued
  const queued = queuedRequest(hermes.id, 'cancel-queued');
  let first = await service.cancelWorkRequest(queued.requestId, { actor: PERSON, reason: 'no longer needed' });
  let again = await service.cancelWorkRequest(queued.requestId, { actor: PERSON });
  assert(first.outcome === 'cancelled' && !first.replayed && first.state === 'cancelled' && req(queued.requestId).state === 'cancelled',
    'queued -> cancelled immediately');
  assert(again.outcome === 'already_terminal' && again.replayed && count(queued.requestId, 'cancel_requested') === 1 && count(queued.requestId, 'state_changed') === 1,
    'queued: repeat cancel is already_terminal and writes nothing');
  await service.startAgentDispatch(queued.requestId);
  assert(attemptsOf(queued.requestId).length === 0 && runsFor(queued.requestId).length === 0, 'queued: a cancelled request never launches');
  assert(req(queued.requestId).cancel_reason === 'no longer needed' && req(queued.requestId).cancel_requested_by === 'person:control-owner',
    'queued: the durable intent names who cancelled and why');

  // blocked
  const blocked = queuedRequest(hermes.id, 'cancel-blocked');
  engine.transitionWorkRequest(blocked.requestId, { from: 'queued', to: 'blocked', reason: 'target_unavailable' });
  first = await service.cancelWorkRequest(blocked.requestId, { actor: PERSON });
  again = await service.cancelWorkRequest(blocked.requestId, { actor: PERSON });
  assert(first.outcome === 'cancelled' && again.outcome === 'already_terminal' && req(blocked.requestId).state === 'cancelled', 'blocked -> cancelled, then already_terminal');

  // running, cooperative runtime: intent first, cancelled once the Attempt stops.
  const sent = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Cancel me while running', idempotencyKey: 'cancel-running' });
  const runningId = sent.accepted.requestId;
  await waitFor(() => runsFor(runningId).length === 1, 'running adapter entered');
  // A runtime that observes the abort only after the command returns.
  const entry = runsFor(runningId)[0];
  const signal = entry.input.signal;
  first = await service.cancelWorkRequest(runningId, { actor: PERSON, reason: 'stop' });
  assert(first.outcome === 'cancel_requested' && !first.replayed && signal.aborted, 'running -> cancel_requested; the worker\'s Attempt signal is aborted');
  await sent.dispatched;
  again = await service.cancelWorkRequest(runningId, { actor: PERSON });
  const runningAttempts = attemptsOf(runningId);
  assert(req(runningId).state === 'cancelled' && req(runningId).state_reason === 'cancel_requested' && runningAttempts.length === 1
    && runningAttempts[0].outcome === 'cancelled' && !leaseOf(runningId) && repliesOf(runningId).length === 0,
  'running (cooperative): the worker ended the request cancelled, Attempt cancelled, lease released, no reply');
  assert(again.outcome === 'already_terminal' && count(runningId, 'cancel_requested') === 1, 'running: a later cancel is already_terminal');
  // The adapter returned promptly on the signal, but it cannot stop the
  // external run (no externalCancel): the Attempt is abandoned, not
  // finished as if the run had stopped.
  const promptAbandon = eventData(runningId, 'attempt_abandoned');
  const promptExternal = eventData(runningId, 'external_cancel');
  assert(runningAttempts[0].error_category === 'abandoned' && promptAbandon.length === 1 && promptAbandon[0].local_only === true && promptAbandon[0].reason === 'cancelled',
    'running (signal-only runtime returned on the signal): the Attempt is recorded abandoned, local only');
  assert(promptExternal.length === 1 && promptExternal[0].status === 'unsupported' && promptExternal[0].local_signalled === true,
    `running (signal-only runtime): external cancellation recorded honestly as unsupported (${promptExternal.map(e => e.status).join(',')})`);

  // A transport whose signal stops the external run: a normal cancelled Attempt.
  useControlledAdapter({ honorSignal: true, externalCancel: true });
  const hard = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Cancel a hard-cancel run', idempotencyKey: 'cancel-hard' });
  const hardId = hard.accepted.requestId;
  await waitFor(() => runsFor(hardId).length === 1, 'hard-cancel adapter entered');
  await service.cancelWorkRequest(hardId, { actor: PERSON });
  await hard.dispatched;
  const hardAttempts = attemptsOf(hardId);
  assert(req(hardId).state === 'cancelled' && hardAttempts[0].outcome === 'cancelled' && hardAttempts[0].error_category === 'cancelled'
    && count(hardId, 'attempt_abandoned') === 0 && count(hardId, 'external_cancel') === 0,
  'running (externalCancel runtime): the signal stopped the run; the Attempt is cancelled, not abandoned');

  // running, repeat while still running: same outcome, replayed, no new event.
  useControlledAdapter({ honorSignal: false });
  const stalled = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stalled run', idempotencyKey: 'cancel-stalled' });
  const stalledId = stalled.accepted.requestId;
  await waitFor(() => runsFor(stalledId).length === 1, 'stalled adapter entered');
  first = await service.cancelWorkRequest(stalledId, { actor: PERSON });
  again = await service.cancelWorkRequest(stalledId, { actor: PERSON });
  assert(first.outcome === 'cancel_requested' && again.outcome === 'cancel_requested' && again.replayed && count(stalledId, 'cancel_requested') === 1,
    'running: a repeated cancel reports cancel_requested (replayed) and writes nothing');
  // Inside the grace a live worker keeps its lease.
  advance(29_000);
  await service.sweepDispatch();
  assert(req(stalledId).state === 'running' && leaseOf(stalledId), 'running: within the cancel grace the live worker is left to stop');
  advance(2_000);
  await service.sweepDispatch();
  let attempts = attemptsOf(stalledId);
  const external = eventData(stalledId, 'external_cancel');
  assert(req(stalledId).state === 'cancelled' && attempts[0].outcome === 'cancelled' && attempts[0].error_category === 'abandoned' && !leaseOf(stalledId),
    'running (stalled runtime): after the grace the Attempt is abandoned and the request cancelled');
  assert(external.length === 1 && external[0].status === 'unsupported' && external[0].local_signalled === true,
    `running (stalled runtime): external cancellation recorded honestly as unsupported (${external.map(e => e.status).join(',')})`);
  // The stalled runtime answers later: evidence only.
  runsFor(stalledId)[0].finish({ output: 'LATE after cancel' });
  await stalled.dispatched;
  const late = eventData(stalledId, 'late_result_recorded');
  attempts = attemptsOf(stalledId);
  assert(late.length === 1 && late[0].output === 'LATE after cancel' && late[0].result_status === 'completed' && late[0].request_state === 'cancelled',
    'late result after cancellation is recorded as evidence');
  assert(req(stalledId).state === 'cancelled' && attempts.length === 1 && attempts[0].outcome === 'cancelled' && attempts[0].output === null && repliesOf(stalledId).length === 0,
    'late result after cancellation does not complete the request, rewrite the Attempt, or post a reply');

  // A stalled runtime that started work without a run id (Hermes): the
  // run exists but cannot be addressed, so cancellation is unsupported,
  // never not_launched.
  useControlledAdapter({ honorSignal: false, withRunId: false });
  const anon = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stalled run without id', idempotencyKey: 'cancel-stalled-no-id' });
  const anonId = anon.accepted.requestId;
  await waitFor(() => runsFor(anonId).length === 1, 'stalled no-id adapter entered');
  await service.cancelWorkRequest(anonId, { actor: PERSON });
  advance(31_000);
  await service.sweepDispatch();
  const anonExternal = eventData(anonId, 'external_cancel');
  assert(req(anonId).state === 'cancelled' && attemptsOf(anonId)[0].external_run_id === null && attemptsOf(anonId)[0].error_category === 'abandoned'
    && anonExternal.length === 1 && anonExternal[0].status === 'unsupported' && anonExternal[0].external_run_id === null,
  `running (started, no run id): grace enforcement records unsupported, not not_launched (${anonExternal.map(e => e.status).join(',')})`);
  runsFor(anonId)[0].finish({ output: 'LATE no id' });
  await anon.dispatched;
  assert(req(anonId).state === 'cancelled' && eventData(anonId, 'late_result_recorded').length === 1, 'running (started, no run id): the late result is evidence only');

  // waiting (operator attention, Attempt still open).
  const waiting = queuedRequest(hermes.id, 'cancel-waiting');
  const d = service.currentDispatcher();
  const claim = engine.transaction(() => {
    const c = d.claim(waiting.requestId);
    engine.createAttempt(waiting.requestId, { kind: 'launch', adapter: 'hermes', toolProfile: 'readonly', launchSnapshot: { transport: 'hermes-gateway' } });
    return c;
  });
  d.setAttention(claim.lease, { attemptId: attemptsOf(waiting.requestId)[0].id, reason: 'run_not_found' });
  assert(req(waiting.requestId).state === 'waiting' && attentionOf(waiting.requestId), 'waiting: fixture is waiting with an open Attempt and attention');
  first = await service.cancelWorkRequest(waiting.requestId, { actor: PERSON });
  again = await service.cancelWorkRequest(waiting.requestId, { actor: PERSON });
  attempts = attemptsOf(waiting.requestId);
  assert(first.outcome === 'cancelled' && first.abandoned && first.abandoned.attemptId === attempts[0].id && again.outcome === 'already_terminal',
    'waiting -> cancelled, the open Attempt abandoned; repeat is already_terminal');
  assert(attempts[0].outcome === 'cancelled' && attempts[0].error_category === 'abandoned' && !attentionOf(waiting.requestId) && req(waiting.requestId).state === 'cancelled',
    'waiting: Attempt finished cancelled/abandoned, attention cleared');
  assert(eventData(waiting.requestId, 'external_cancel')[0]?.status === 'not_launched', 'waiting: an Attempt with no run id records not_launched');

  // terminal (completed): nothing written.
  useControlledAdapter({ script: e => e.finish({ output: 'done' }) });
  const done = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Complete first', idempotencyKey: 'cancel-terminal' });
  await done.dispatched;
  const before = engine.listEvents(done.accepted.requestId).length;
  first = await service.cancelWorkRequest(done.accepted.requestId, { actor: PERSON });
  assert(first.outcome === 'already_terminal' && first.state === 'completed' && engine.listEvents(done.accepted.requestId).length === before && req(done.accepted.requestId).cancel_requested_at === null,
    'completed -> already_terminal, no event, no intent');

  // Authorization hook.
  const guarded = queuedRequest(hermes.id, 'cancel-guarded');
  let refused = null;
  try { await service.cancelWorkRequest(guarded.requestId, { actor: STRANGER, authorize: () => false }); } catch (error) { refused = error; }
  assert(refused instanceof control.ControlError && refused.code === 'forbidden' && req(guarded.requestId).state === 'queued' && count(guarded.requestId, 'cancel_requested') === 0,
    'authorization hook refusal: forbidden, nothing written');
  refused = null;
  try { await service.cancelAgentRequest(STRANGER, guarded.requestId); } catch (error) { refused = error; }
  assert(refused && refused.code === 'request_not_found' && req(guarded.requestId).state === 'queued', 'principal command: a non-participant cannot cancel (request_not_found)');
  const allowed = await service.cancelAgentRequest(PERSON, guarded.requestId, 'participant');
  assert(allowed.outcome === 'cancelled', 'principal command: a participant cancels');
  dispatch.setAttemptAdapterOverride(null);
}

// ---------------------------------------------------------------------
async function deadlineScenarios() {
  console.log('\n[2] deadlines time out eligible work and prevent launches after expiry (fake clock)');
  configure();
  useControlledAdapter();
  const DEADLINE = 120_000;

  // Before the deadline a claim launches; after it nothing does.
  clock = Date.now();
  const early = queuedRequest(hermes.id, 'deadline-early', { BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE });
  const late = queuedRequest(hermes.id, 'deadline-late', { BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE });
  const swept = queuedRequest(hermes.id, 'deadline-swept', { BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE });
  assert(req(late.requestId).deadline_at !== null && Math.abs(req(late.requestId).deadline_at - (clock + DEADLINE)) < 5000, 'intake stored an absolute deadline');
  advance(DEADLINE - 1_000);
  void service.startAgentDispatch(early.requestId);
  await waitFor(() => runsFor(early.requestId).length === 1, 'claim just before the deadline launched');
  assert(req(early.requestId).state === 'running', 'one second before the deadline the request launches');
  advance(2_000);
  await service.startAgentDispatch(late.requestId);
  assert(req(late.requestId).state === 'failed' && req(late.requestId).state_reason === 'timed_out' && req(late.requestId).error_code === 'timed_out'
    && attemptsOf(late.requestId).length === 0 && runsFor(late.requestId).length === 0,
  'after the deadline a dispatch launches nothing: the refused claim times the request out');

  // The sweep times out queued work and the running Attempt past the deadline.
  await service.sweepDispatch();
  assert(req(swept.requestId).state === 'failed' && req(swept.requestId).state_reason === 'timed_out' && attemptsOf(swept.requestId).length === 0, 'sweep: queued request past its deadline timed out');
  const earlyAttempts = attemptsOf(early.requestId);
  assert(req(early.requestId).state === 'failed' && req(early.requestId).state_reason === 'timed_out' && earlyAttempts[0].outcome === 'timed_out'
    && earlyAttempts[0].error_category === 'abandoned' && !leaseOf(early.requestId),
  'sweep: running request past its deadline timed out, its Attempt abandoned, lease dropped');
  assert(runsFor(early.requestId)[0].input.signal.aborted, 'sweep: the local worker was signalled');
  // Late result after the timeout: evidence only.
  runsFor(early.requestId)[0].finish({ output: 'LATE after timeout' });
  await service.waitForAgentDispatchIdle();
  const lateEvidence = eventData(early.requestId, 'late_result_recorded');
  assert(lateEvidence.length === 1 && lateEvidence[0].output === 'LATE after timeout' && req(early.requestId).state === 'failed' && repliesOf(early.requestId).length === 0,
    'late result after timeout is evidence; the request stays timed out with no reply');
  await service.sweepDispatch();
  assert(count(early.requestId, 'state_changed') === 2 && count(swept.requestId, 'state_changed') === 1, 'repeated sweeps after the timeout write nothing');

  // A result reaching the worker after the deadline but before any sweep.
  clock = Date.now();
  useControlledAdapter();
  const racing = withPolicy({ BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Race the deadline', idempotencyKey: 'deadline-race' }));
  await waitFor(() => runsFor(racing.accepted.requestId).length === 1, 'race adapter entered');
  advance(DEADLINE + 1_000);
  runsFor(racing.accepted.requestId)[0].finish({ output: 'just too late' });
  await racing.dispatched;
  const raced = req(racing.accepted.requestId);
  assert(raced.state === 'failed' && raced.state_reason === 'timed_out' && repliesOf(raced.id).length === 0
    && attemptsOf(raced.id)[0].outcome === 'succeeded' && eventData(raced.id, 'late_result_recorded').length === 1,
  'a success committed after the deadline times out; the Attempt keeps its succeeded evidence');

  // A stalled runtime that started without a run id, past its deadline:
  // the sweep abandons it as unsupported, never not_launched.
  clock = Date.now();
  useControlledAdapter({ withRunId: false });
  const anon = withPolicy({ BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stall past the deadline without id', idempotencyKey: 'deadline-no-id' }));
  await waitFor(() => runsFor(anon.accepted.requestId).length === 1, 'no-id adapter entered');
  advance(DEADLINE + 1_000);
  await service.sweepDispatch();
  const anonExternal = eventData(anon.accepted.requestId, 'external_cancel');
  assert(req(anon.accepted.requestId).state_reason === 'timed_out' && anonExternal.length === 1 && anonExternal[0].status === 'unsupported' && anonExternal[0].reason === 'timed_out',
    `deadline enforcement of a started run without id records unsupported (${anonExternal.map(e => e.status).join(',')})`);
  runsFor(anon.accepted.requestId)[0].finish({ output: 'late' });
  await anon.dispatched;
  useControlledAdapter();

  // waiting past the deadline.
  clock = Date.now();
  const waiting = queuedRequest(hermes.id, 'deadline-waiting', { BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE });
  const d = service.currentDispatcher();
  const claim = engine.transaction(() => {
    const c = d.claim(waiting.requestId);
    engine.createAttempt(waiting.requestId, { kind: 'launch', adapter: 'hermes', toolProfile: 'readonly', launchSnapshot: { transport: 'hermes-gateway' } });
    return c;
  });
  d.setAttention(claim.lease, { attemptId: attemptsOf(waiting.requestId)[0].id, reason: 'grant_expired' });
  advance(DEADLINE + 1_000);
  await service.sweepDispatch();
  assert(req(waiting.requestId).state === 'failed' && req(waiting.requestId).state_reason === 'timed_out' && attemptsOf(waiting.requestId)[0].outcome === 'timed_out'
    && !attentionOf(waiting.requestId), 'waiting past its deadline: timed out, Attempt abandoned, attention cleared');
  const retried = await service.retryWorkRequest(waiting.requestId, { actor: PERSON });
  assert(retried.outcome === 'already_terminal', 'a timed-out request cannot be retried');

  // Cancelling and timing out race: the first decision wins.
  clock = Date.now();
  const both = queuedRequest(hermes.id, 'deadline-vs-cancel', { BOTMANCERS_REQUEST_DEADLINE_MS: DEADLINE });
  advance(DEADLINE + 1_000);
  const cancelled = await service.cancelWorkRequest(both.requestId, { actor: PERSON });
  await service.sweepDispatch();
  assert(cancelled.outcome === 'cancelled' && req(both.requestId).state === 'cancelled' && count(both.requestId, 'state_changed') === 1,
    'cancel committed before the sweep wins; the sweep finds a terminal request and writes nothing');
  dispatch.setAttemptAdapterOverride(null);
}

// ---------------------------------------------------------------------
function policyUnits() {
  console.log('\n[3a] failure categories, backoff, and bounded policy (parameterized)');
  const expected = {
    unavailable: 'retryable', runtime_failed: 'retryable', timed_out: 'retryable',
    launch_failed: 'terminal', unsupported_authority: 'terminal', result_contract: 'terminal', cancelled: 'terminal',
    session_mismatch: 'manual_attention',
  };
  for (const category of adapterLib.ATTEMPT_FAILURE_CATEGORIES) {
    assert(policy.classifyFailure(category) === expected[category], `category ${category} -> ${expected[category]}`);
  }
  for (const code of ['unavailable', 'provider_unavailable', 'agent_not_found', 'auth_required', 'permission_denied', 'incompatible_version', 'usage_limit']) {
    assert(policy.classifyFailure('unavailable', code) === 'manual_attention', `code ${code} -> manual_attention`);
  }
  assert(policy.classifyFailure('runtime_failed', 'auth_required') === 'manual_attention', 'a manual code wins whatever the adapter category');
  assert(policy.classifyFailure('unavailable', 'internal') === 'retryable', 'an unknown code falls back to the category disposition');
  const p = { max_attempts: 6, base_delay_ms: 1000, max_delay_ms: 5000, attempt_timeout_ms: null };
  const delays = [1, 2, 3, 4, 5].map(n => policy.backoffDelay(p, n));
  assert(delays.join(',') === '1000,2000,4000,5000,5000', `deterministic capped exponential backoff (${delays.join(',')})`);
  for (const max of [1, 2, 3, 5]) {
    const pol = { ...p, max_attempts: max };
    const decisions = [];
    for (let used = 1; used <= max; used++) decisions.push(policy.decideRetry({ policy: pol, attemptCount: used, disposition: 'retryable', deadlineAt: null, now: 0 }).action);
    const retries = decisions.filter(a => a === 'retry').length;
    assert(retries === max - 1 && decisions.at(-1) === 'exhausted', `max_attempts ${max}: ${max - 1} retries then exhausted (${decisions.join(',')})`);
    assert(policy.decideRetry({ policy: pol, attemptCount: 1, disposition: 'terminal', deadlineAt: null, now: 0 }).action === 'fail', `max_attempts ${max}: a terminal failure never retries`);
  }
  assert(policy.decideRetry({ policy: { ...p, max_attempts: 3 }, attemptCount: 1, disposition: 'retryable', deadlineAt: 500, now: 0 }).action === 'deadline',
    'a retry that would become eligible after the deadline is not scheduled');
  for (const bad of [{ ...p, max_attempts: 0 }, { ...p, max_attempts: policy.MAX_ATTEMPTS_CAP + 1 }, { ...p, base_delay_ms: -1 }, { ...p, max_delay_ms: 10 }, { ...p, attempt_timeout_ms: 0 }]) {
    assert(!policy.validateRetryPolicy(bad).ok, `invalid policy refused: ${JSON.stringify(bad)}`);
  }
  const clamped = policy.requestControlDefaultsFromEnv({ BOTMANCERS_RETRY_MAX_ATTEMPTS: '999', BOTMANCERS_RETRY_BASE_DELAY_MS: 'x' });
  assert(clamped.retryPolicy.max_attempts === policy.MAX_ATTEMPTS_CAP && clamped.retryPolicy.base_delay_ms === 1000 && clamped.deadlineMs === null,
    'env: max attempts clamped to the cap, invalid values fall back to defaults');
  // Cross-field: a base delay above the default max delay must not make the
  // composed policy invalid (stored, it would fall back to one Attempt).
  for (const env of [
    { BOTMANCERS_RETRY_MAX_ATTEMPTS: '3', BOTMANCERS_RETRY_BASE_DELAY_MS: '120000' },
    { BOTMANCERS_RETRY_MAX_ATTEMPTS: '3', BOTMANCERS_RETRY_BASE_DELAY_MS: '120000', BOTMANCERS_RETRY_MAX_DELAY_MS: '5000' },
  ]) {
    const composed = policy.requestControlDefaultsFromEnv(env).retryPolicy;
    const stored = policy.storedRetryPolicy(JSON.stringify(composed));
    assert(policy.validateRetryPolicy(composed).ok && composed.max_delay_ms === 120000 && stored.max_attempts === 3 && stored.base_delay_ms === 120000,
      `env: max delay below base delay is normalized; the stored policy keeps its retry budget (${JSON.stringify(env)})`);
  }
  const defaults = policy.requestControlDefaultsFromEnv({});
  assert(defaults.retryPolicy.max_attempts === 1 && defaults.deadlineMs === null && defaults.retryPolicy.attempt_timeout_ms === null,
    'defaults: one Attempt, no deadline, no Attempt timeout (no automatic retry)');
  let threw = false;
  try { raw.prepare('UPDATE work_requests SET retry_policy = ? WHERE id = (SELECT id FROM work_requests LIMIT 1)').run('{}'); } catch { threw = true; }
  assert(threw, 'the stored retry policy is immutable');
}

async function farDeadlines() {
  console.log('\n[2b] a far-future deadline stays pending (setTimeout overflow)');
  for (const days of [25, 365]) {
    const stop = adapterLib.interruption({ signal: null, deadlineAt: Date.now() + days * 86_400_000 });
    const raced = await Promise.race([stop.promise.then(() => 'fired'), sleep(30).then(() => 'pending')]);
    stop.dispose();
    assert(raced === 'pending', `a deadline ${days} days away does not fire early (${raced})`);
  }
  const near = adapterLib.interruption({ signal: null, deadlineAt: Date.now() + 5 });
  const fired = await Promise.race([near.promise.then(f => f.category), sleep(1000).then(() => 'pending')]);
  near.dispose();
  assert(fired === 'timed_out', 'a near deadline still fires timed_out');
}

async function retryScenarios() {
  console.log('\n[3b] retryable failures retry within the bounded budget; terminal failures never retry');
  configure();
  const BASE = 60_000;
  for (const [category, max, expectRetries] of [['runtime_failed', 1, 0], ['runtime_failed', 2, 1], ['runtime_failed', 3, 2], ['unavailable', 3, 2], ['launch_failed', 3, 0], ['result_contract', 3, 0]]) {
    clock = Date.now();
    useControlledAdapter({ script: e => e.finish({ category }) });
    const label = `${category}/max ${max}`;
    const sent = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: max, BOTMANCERS_RETRY_BASE_DELAY_MS: BASE, BOTMANCERS_RETRY_MAX_DELAY_MS: BASE * 10 }, () =>
      service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: `Retry ${label}`, idempotencyKey: `retry-${category}-${max}` }));
    const id = sent.accepted.requestId;
    await sent.dispatched;
    const schedule = [];
    for (let i = 0; i < max + 2; i++) {
      const r = req(id);
      if (r.state !== 'queued') break;
      schedule.push(r.next_eligible_at - clock);
      // Not claimable before the backoff ends: no new Attempt.
      advance(r.next_eligible_at - clock - 1);
      const attemptsBefore = attemptsOf(id).length;
      await service.startAgentDispatch(id);
      if (attemptsOf(id).length !== attemptsBefore) assert(false, `${label}: claimed before the backoff ended`);
      advance(1);
      await service.sweepDispatch();
      await service.waitForAgentDispatchIdle();
    }
    const r = req(id);
    const attempts = attemptsOf(id);
    const retries = eventData(id, 'state_changed').filter(e => e.reason === 'retry_scheduled');
    assert(attempts.length === expectRetries + 1 && retries.length === expectRetries && r.attempt_count === attempts.length,
      `${label}: ${attempts.length} Attempts, ${retries.length} retries scheduled (expected ${expectRetries + 1}/${expectRetries})`);
    assert(r.state === 'failed' && r.state_reason === (expectRetries > 0 ? 'retries_exhausted' : null),
      `${label}: final state failed${expectRetries > 0 ? ' with retries_exhausted' : ' (no retry)'} (${r.state}/${r.state_reason})`);
    const expectedSchedule = Array.from({ length: expectRetries }, (_, i) => policy.backoffDelay({ base_delay_ms: BASE, max_delay_ms: BASE * 10 }, i + 1));
    assert(schedule.join(',') === expectedSchedule.join(','), `${label}: backoff ${schedule.join(',') || 'none'}`);
    assert(attempts.every(a => a.outcome === 'failed' && a.error_category === category) && openAttempts(id) === 0 && !leaseOf(id), `${label}: every Attempt finished, no lease left`);
  }

  // manual attention: waits for an operator retry, bounded by the same budget.
  clock = Date.now();
  useControlledAdapter({ script: e => e.finish({ category: 'session_mismatch' }) });
  const manual = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 2 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Manual attention', idempotencyKey: 'retry-manual' }));
  await manual.dispatched;
  const manualId = manual.accepted.requestId;
  assert(req(manualId).state === 'waiting' && attentionOf(manualId) && attemptsOf(manualId).length === 1, 'manual_attention: request waits with the attention flag, no automatic retry');
  await service.sweepDispatch();
  assert(attemptsOf(manualId).length === 1, 'manual_attention: a sweep does not retry it');
  let refused = null;
  try { await service.retryAgentRequest(STRANGER, manualId); } catch (error) { refused = error; }
  assert(refused && refused.code === 'request_not_found' && req(manualId).state === 'waiting', 'retry command: a non-participant is refused');
  let retried = await service.retryAgentRequest(PERSON, manualId);
  await service.waitForAgentDispatchIdle();
  assert(retried.outcome === 'retry_scheduled' && attemptsOf(manualId).length === 2 && req(manualId).attempt_count === 2,
    'operator retry: attention cleared, a second Attempt ran');
  assert(req(manualId).state === 'failed' && attemptsOf(manualId).length === 2 && !attentionOf(manualId),
    'the second Attempt failed the same way with no budget left: failed, no further wait');
  retried = await service.retryWorkRequest(manualId, { actor: PERSON });
  assert(retried.outcome === 'already_terminal' && attemptsOf(manualId).length === 2, 'operator retry of the failed request: already_terminal');
  // An attention wait with its budget spent (one-Attempt default policy).
  const spent = queuedRequest(hermes.id, 'retry-spent');
  const d = service.currentDispatcher();
  const claim = engine.transaction(() => {
    const c = d.claim(spent.requestId);
    engine.createAttempt(spent.requestId, { kind: 'launch', adapter: 'hermes', toolProfile: 'readonly', launchSnapshot: { transport: 'hermes-gateway' } });
    return c;
  });
  d.setAttention(claim.lease, { attemptId: attemptsOf(spent.requestId)[0].id, reason: 'run_died' });
  retried = await service.retryWorkRequest(spent.requestId, { actor: PERSON });
  assert(retried.outcome === 'retries_exhausted' && attemptsOf(spent.requestId).length === 1 && req(spent.requestId).state === 'waiting' && attentionOf(spent.requestId),
    'operator retry past the budget: retries_exhausted, nothing launched, still waiting');
  await service.cancelWorkRequest(spent.requestId);

  // Retry command outcomes in the other states.
  const queued = queuedRequest(hermes.id, 'retry-queued');
  assert((await service.retryWorkRequest(queued.requestId)).outcome === 'already_queued', 'retry on queued: already_queued');
  // FIFO admission: the older queued request would take Hermes's slot first.
  await service.cancelWorkRequest(queued.requestId);
  useControlledAdapter();
  const active = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Retry active', idempotencyKey: 'retry-active' });
  await waitFor(() => runsFor(active.accepted.requestId).length === 1, 'active adapter entered');
  assert((await service.retryWorkRequest(active.accepted.requestId)).outcome === 'not_retryable', 'retry on running: not_retryable');
  runsFor(active.accepted.requestId)[0].finish({ output: 'fine' });
  await active.dispatched;
  assert((await service.retryWorkRequest(active.accepted.requestId)).outcome === 'already_terminal', 'retry on completed: already_terminal');

  // A retry is never claimed twice: competing dispatchers race for it.
  clock = Date.now();
  useControlledAdapter({ script: e => e.finish({ category: 'runtime_failed' }) });
  const raced = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 3, BOTMANCERS_RETRY_BASE_DELAY_MS: BASE }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Race the retry', idempotencyKey: 'retry-race' }));
  await raced.dispatched;
  const racedId = raced.accepted.requestId;
  advance(BASE);
  const workers = [0, 1, 2].map(i => lib.createDispatcher(raw, engine, { owner: `retry-racer-${i}`, now: () => clock, config: { maxGlobal: 50, maxPerTarget: 50 } }));
  const wins = workers.map(w => engine.transaction(() => {
    const c = w.claim(racedId);
    if (c.ok) engine.createAttempt(racedId, { kind: 'launch', adapter: 'hermes', toolProfile: 'readonly', launchSnapshot: { transport: 'hermes-gateway' } });
    return c.ok;
  }));
  assert(wins.filter(Boolean).length === 1 && openAttempts(racedId) === 1 && attemptsOf(racedId).length === 2 && req(racedId).attempt_count === 2,
    `a scheduled retry is claimed once: one open Attempt (${wins.join(',')})`);
  await service.cancelWorkRequest(racedId, { actor: PERSON });
  advance(31_000);
  await service.sweepDispatch();
  dispatch.setAttemptAdapterOverride(null);
}

// ---------------------------------------------------------------------
async function supersedingRetry() {
  console.log('\n[4] a late result from a superseded Attempt is evidence only');
  configure();
  clock = Date.now();
  useControlledAdapter();
  const TIMEOUT = 90_000;
  const sent = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 2, BOTMANCERS_RETRY_BASE_DELAY_MS: 1_000, BOTMANCERS_ATTEMPT_TIMEOUT_MS: TIMEOUT }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stall then retry', idempotencyKey: 'supersede' }));
  const id = sent.accepted.requestId;
  await waitFor(() => runsFor(id).length === 1, 'first Attempt entered');
  const firstInput = runsFor(id)[0].input;
  assert(typeof firstInput.deadlineAt === 'number' && firstInput.deadlineAt === attemptsOf(id)[0].started_at + TIMEOUT
    && JSON.parse(attemptsOf(id)[0].launch_snapshot).deadline_at === firstInput.deadlineAt,
  'the adapter received the Attempt deadline, recorded in the launch snapshot');
  advance(TIMEOUT - 1);
  await service.sweepDispatch();
  assert(req(id).state === 'running' && attemptsOf(id).length === 1, 'before the Attempt timeout nothing changes');
  advance(1);
  await service.sweepDispatch();
  let attempts = attemptsOf(id);
  assert(attempts[0].outcome === 'timed_out' && attempts[0].error_category === 'abandoned' && req(id).state === 'queued' && req(id).state_reason === 'retry_scheduled',
    'the stalled Attempt timed out (abandoned) and a retry was scheduled');
  advance(1_000);
  await service.sweepDispatch();
  await waitFor(() => runsFor(id).length === 2, 'second Attempt entered');
  // The first (stalled) runtime answers while the retry is running.
  runsFor(id)[0].finish({ output: 'STALE first' });
  await waitFor(() => count(id, 'late_result_recorded') === 1, 'late evidence of the first Attempt');
  attempts = attemptsOf(id);
  assert(req(id).state === 'running' && attempts.length === 2 && attempts[0].output === null && attempts[1].finished_at === null && repliesOf(id).length === 0,
    'superseded Attempt\'s late result: evidence only, the retry keeps running');
  runsFor(id)[1].finish({ output: 'FRESH second' });
  await service.waitForAgentDispatchIdle();
  const replies = repliesOf(id);
  attempts = attemptsOf(id);
  assert(req(id).state === 'completed' && replies.length === 1 && replies[0].content === 'FRESH second' && attempts[1].outcome === 'succeeded',
    'the request completed from the superseding Attempt only');
  const evidence = eventData(id, 'late_result_recorded')[0];
  assert(evidence.output === 'STALE first' && evidence.attempt_number === 1 && evidence.attempt_outcome === 'timed_out', 'evidence names the superseded Attempt and its abandoned outcome');
  assert(attempts[0].outcome === 'timed_out' && attempts[0].output === null && (await service.retryWorkRequest(id)).outcome === 'already_terminal',
    'the superseded Attempt row is unchanged and the completed request takes no retry');
  dispatch.setAttemptAdapterOverride(null);
}

// External cancellation where the runtime supports it (direct provider).
async function externalCancel() {
  console.log('\n[4b] direct provider turns are cancelled externally; the outcome is recorded');
  configure({ heartbeatMs: 10 });
  clock = Date.now();
  holdNextTurns(1);
  const cancelsBefore = cancelCalls();
  const sent = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Cancel the direct turn', idempotencyKey: 'direct-cancel' });
  const id = sent.accepted.requestId;
  await waitFor(() => attemptsOf(id)[0]?.external_run_id, 'direct turn id persisted');
  const runId = attemptsOf(id)[0].external_run_id;
  const fakeId = providerTurnIdOf(runId);
  // Another process records the intent: this worker learns it from its heartbeat.
  const remote = control.createRequestControl(raw, engine, { now: () => clock });
  const outcome = remote.cancel(id, { actor: PERSON, reason: 'from another process' });
  assert(outcome.outcome === 'cancel_requested', 'intent recorded by another process');
  await sent.dispatched;
  const attempts = attemptsOf(id);
  assert(req(id).state === 'cancelled' && attempts[0].outcome === 'cancelled' && attempts[0].error_category === 'cancelled'
    && registryTurn(runId).state === 'cancelled' && fakeTurnState(fakeId) === 'cancelled'
    && cancelCalls() >= cancelsBefore + 1 && count(id, 'external_cancel') === 0 && repliesOf(id).length === 0,
  'heartbeat saw the intent; the adapter cancelled the provider turn; a clean cancelled Attempt, request cancelled');

  // A worker that is gone: the sweep abandons and asks the provider to cancel.
  holdNextTurns(1);
  const orphan = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Orphaned direct turn', idempotencyKey: 'direct-cancel-orphan' });
  const orphanId = orphan.accepted.requestId;
  await waitFor(() => attemptsOf(orphanId)[0]?.external_run_id, 'orphan turn id persisted');
  const orphanRun = attemptsOf(orphanId)[0].external_run_id;
  // Simulate the worker's death: its lease is gone, the intent arrives.
  raw.prepare('DELETE FROM dispatch_leases WHERE request_id = ?').run(orphanId);
  remote.cancel(orphanId, { actor: PERSON });
  configure({ heartbeatMs: 60_000 });
  await service.sweepDispatch();
  const external = eventData(orphanId, 'external_cancel');
  assert(req(orphanId).state === 'cancelled' && attemptsOf(orphanId)[0].error_category === 'abandoned' && external.length === 1 && external[0].status === 'requested'
    && registryTurn(orphanRun).state === 'cancelled', `worker gone: abandoned, provider cancel requested (${external.map(e => e.status).join(',')})`);
  await orphan.dispatched;
  assert(req(orphanId).state === 'cancelled' && repliesOf(orphanId).length === 0, 'the old worker\'s result never completed the request');

  // The provider refuses the cancel: the turn is not stopped, so the
  // Attempt is abandoned with failed external cancellation, not finished
  // as stopped.
  configure({ heartbeatMs: 10 });
  holdNextTurns(1);
  failCancelWith = { code: 'unavailable', message: 'cancel refused' };
  const refused = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Cancel refused', idempotencyKey: 'direct-cancel-refused' });
  const refusedId = refused.accepted.requestId;
  await waitFor(() => attemptsOf(refusedId)[0]?.external_run_id, 'refused turn id persisted');
  const refusedRun = attemptsOf(refusedId)[0].external_run_id;
  const refusedFake = providerTurnIdOf(refusedRun);
  const spyBefore = providerSpy.cancelTurn;
  remote.cancel(refusedId, { actor: PERSON });
  await refused.dispatched;
  failCancelWith = null;
  let refusedAttempt = attemptsOf(refusedId)[0];
  let refusedExternal = eventData(refusedId, 'external_cancel');
  let refusedAbandon = eventData(refusedId, 'attempt_abandoned');
  assert(req(refusedId).state === 'cancelled' && refusedAttempt.outcome === 'cancelled' && refusedAttempt.error_category === 'abandoned'
    && /did not accept the cancel/.test(refusedAttempt.error_message) && refusedAbandon.length === 1 && refusedAbandon[0].external_cancel === 'failed',
  'cancel refused: the Attempt is recorded abandoned, not cancelled as if stopped');
  assert(refusedExternal.length === 1 && refusedExternal[0].status === 'failed' && refusedExternal[0].external_run_id === refusedRun
    && fakeTurnState(refusedFake) === 'running' && providerSpy.cancelTurn === spyBefore + 1,
  `cancel refused: external_cancel is failed and the provider turn still runs (${refusedExternal.map(e => e.status).join(',')})`);
  fake.releaseFakeTurn(STATE, refusedFake, 'DONE-refused');

  // The same on the request deadline: a refused cancel is not a stopped turn.
  clock = Date.now();
  holdNextTurns(1);
  failCancelWith = { code: 'unavailable', message: 'cancel refused' };
  const timedOut = withPolicy({ BOTMANCERS_REQUEST_DEADLINE_MS: 300, BOTMANCERS_RETRY_MAX_ATTEMPTS: 1 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Deadline cancel refused', idempotencyKey: 'direct-deadline-refused' }));
  const timedId = timedOut.accepted.requestId;
  await timedOut.dispatched;
  failCancelWith = null;
  refusedAttempt = attemptsOf(timedId)[0];
  const timedRun = refusedAttempt.external_run_id;
  const timedFake = providerTurnIdOf(timedRun);
  refusedExternal = eventData(timedId, 'external_cancel');
  refusedAbandon = eventData(timedId, 'attempt_abandoned');
  assert(req(timedId).state === 'failed' && refusedAttempt.outcome === 'timed_out' && refusedAttempt.error_category === 'abandoned'
    && refusedAbandon.length === 1 && refusedAbandon[0].reason === 'timed_out' && refusedAbandon[0].external_cancel === 'failed'
    && refusedExternal.length === 1 && refusedExternal[0].status === 'failed' && refusedExternal[0].reason === 'timed_out'
    && fakeTurnState(timedFake) === 'running' && repliesOf(timedId).length === 0,
  `deadline cancel failure: Attempt abandoned, external_cancel failed, turn still running (${req(timedId).state}/${refusedAttempt.outcome}/${refusedExternal.map(e => e.status).join(',')})`);
  fake.releaseFakeTurn(STATE, timedFake, 'DONE-deadline');
}

// ---------------------------------------------------------------------
// The durable state a worker leaves when it dies mid-dispatch (as in
// test-dispatcher): the real claim, Attempt, and launch intent; optionally
// the real direct provider start through the adapter's own repost. Only
// the crash is simulated.
async function crashedAttempt(key, options = {}) {
  // Intake stamps the deadline from the wall clock.
  if (options.deadlineMs) clock = Date.now();
  const id = queuedRequest(codex.id, key, options.deadlineMs ? { BOTMANCERS_REQUEST_DEADLINE_MS: options.deadlineMs } : {}).requestId;
  const prepared = dispatch.prepareDispatch({
    bot: codex, history: [{ speakerLabel: 'person:control-owner', fromAgent: false, content: `Task ${key}` }], toolProfile: 'readonly',
  });
  const dead = lib.createDispatcher(raw, engine, { owner: 'dead-host.invalid:1:deadbeef', now: () => clock, config: { maxGlobal: 1000, maxPerTarget: 1000 } });
  const agent = dispatch.agentForDispatch(codex);
  const attempt = engine.transaction(() => {
    const claim = dead.claim(id, { data: { agent } });
    const begun = executor.beginAttempt(engine, id, { agent, adapter: prepared.adapter, input: prepared.input, snapshot: { agent }, now: clock });
    const intent = prepared.adapter.launchIntent ? prepared.adapter.launchIntent(begun.input) : null;
    dead.recordLaunchIntent(claim.lease, begun.attempt.id, prepared.adapter.name, intent);
    return begun.attempt;
  });
  let runId = options.forceRunId ?? null;
  if (options.post) {
    const intent = dead.launchIntent(attempt.id);
    const launched = await prepared.adapter.reconciler.repost({ idempotencyKey: intent.idempotency_key, body: intent.body });
    if (launched.kind !== 'accepted') throw new Error(`crashedAttempt launch not accepted: ${JSON.stringify(launched)}`);
    runId = launched.runId;
  }
  if (runId) engine.recordAttemptExternalIds(attempt.id, { externalRunId: runId });
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  return { id, attemptId: attempt.id, runId };
}

async function reconcileRaces() {
  console.log('\n[4c] cancellation or a deadline arriving during reconciliation runtime I/O wins over the reconcile decision');
  // Direct inspect is a local registry read; the reconcile runtime I/O is
  // the follow (observe) and the same-key re-POST (start), both gated at
  // the provider seam. The heartbeat is fast so a cancel intent aborts a
  // gated follow promptly.
  configure({ heartbeatMs: 10 });
  clock = Date.now();
  const remote = control.createRequestControl(raw, engine, { now: () => clock });
  const decisions = id => eventData(id, 'reconcile_decided').map(d => `${d.phase}/${d.action}`).join(',');

  // follow: a running turn is reattached, but a cancel arrives while the
  // follow observes it.
  holdNextTurns(1);
  const held = fake.fakeTurnIds(STATE);
  const following = await crashedAttempt('race-follow-cancel', { post: true });
  let gate = gateProviderCall('observeTurn');
  let sweeping = service.sweepDispatch();
  await waitFor(() => gate.hit, 'follow observe in flight');
  assert(remote.cancel(following.id, { actor: PERSON, reason: 'during follow' }).outcome === 'cancel_requested', 'follow race: intent recorded while the follow observes');
  gate.release();
  await sweeping;
  clearProviderGate();
  assert(req(following.id).state === 'cancelled' && attemptsOf(following.id)[0].outcome === 'cancelled'
    && attemptsOf(following.id)[0].error_category === 'cancelled' && decisions(following.id) === 'run/reattach'
    && registryTurn(following.runId).state === 'cancelled' && repliesOf(following.id).length === 0 && !leaseOf(following.id),
  `follow race: cancelled, the reattached turn stopped, never completed (${req(following.id).state}, ${decisions(following.id)})`);

  // follow: the request deadline passes while the follow observes a live
  // turn. The commit sees the deadline first: timed out, and the turn's
  // late completion is evidence only.
  holdNextTurns(1);
  const diedBefore = fake.fakeTurnIds(STATE);
  const died = await crashedAttempt('race-follow-deadline', { post: true, deadlineMs: 5_000 });
  const diedFake = newTurnIds(diedBefore)[0];
  assert(held.length < fake.fakeTurnIds(STATE).length && diedFake, 'follow race: the crash left a live provider turn');
  gate = gateProviderCall('observeTurn');
  sweeping = service.sweepDispatch();
  await waitFor(() => gate.hit, 'follow observe in flight');
  advance(10_000);
  gate.release();
  fake.releaseFakeTurn(STATE, diedFake, 'DONE-after-deadline');
  await sweeping;
  clearProviderGate();
  let reqRow = req(died.id);
  assert(reqRow.state === 'failed' && reqRow.error_code === 'timed_out' && !attentionOf(died.id) && attemptsOf(died.id).length === 1
    && attemptsOf(died.id)[0].outcome === 'succeeded' && eventData(died.id, 'late_result_recorded').length === 1 && repliesOf(died.id).length === 0,
  `follow race: the deadline wins; the followed Attempt keeps its succeeded evidence (${reqRow.state}/${reqRow.error_code})`);

  // terminal (fail): the same-key re-POST is refused, but a cancel arrives
  // while it is in flight: cancelled, not failed launch_failed.
  fake.mutateFakeProvider(STATE, state => { state.failStarts = (state.failStarts ?? 0) + 1; state.startError = { code: 'unsupported', message: 'model cannot start' }; });
  const refused = await crashedAttempt('race-fail-cancel');
  gate = gateProviderCall('startSession');
  sweeping = service.sweepDispatch();
  await waitFor(() => gate.hit, 're-POST in flight');
  remote.cancel(refused.id, { actor: PERSON });
  gate.release();
  await sweeping;
  clearProviderGate();
  reqRow = req(refused.id);
  assert(reqRow.state === 'cancelled' && reqRow.error_code === 'cancelled' && attemptsOf(refused.id)[0].outcome === 'cancelled'
    && decisions(refused.id) === 'launch/repost',
  `fail race: cancelled, the refusal decision never recorded (${reqRow.state}/${reqRow.error_code}, ${decisions(refused.id)})`);

  // terminal (fail) with a deadline crossing during the re-POST.
  fake.mutateFakeProvider(STATE, state => { state.failStarts = (state.failStarts ?? 0) + 1; state.startError = { code: 'unsupported', message: 'model cannot start' }; });
  const refusedLate = await crashedAttempt('race-fail-deadline', { deadlineMs: 5_000 });
  gate = gateProviderCall('startSession');
  sweeping = service.sweepDispatch();
  await waitFor(() => gate.hit, 're-POST in flight');
  advance(10_000);
  gate.release();
  await sweeping;
  clearProviderGate();
  reqRow = req(refusedLate.id);
  assert(reqRow.state === 'failed' && reqRow.error_code === 'timed_out' && attemptsOf(refusedLate.id)[0].outcome === 'timed_out'
    && decisions(refusedLate.id) === 'launch/repost',
  `fail race: the deadline wins over launch_failed (${reqRow.state}/${reqRow.error_code})`);

  // repost: the re-POST is accepted after a cancel arrived meanwhile. The
  // turn it names is recorded and asked to stop; it is never followed.
  const observesBefore = observeCalls();
  const reposted = await crashedAttempt('race-repost-cancel');
  gate = gateProviderCall('startSession');
  sweeping = service.sweepDispatch();
  await waitFor(() => gate.hit, 're-POST in flight');
  remote.cancel(reposted.id, { actor: PERSON });
  gate.release();
  await sweeping;
  clearProviderGate();
  const repostRun = attemptsOf(reposted.id)[0].external_run_id;
  const repostCancel = eventData(reposted.id, 'external_cancel');
  assert(req(reposted.id).state === 'cancelled' && repostRun && registryTurn(repostRun).state === 'cancelled'
    && repostCancel.length === 1 && repostCancel[0].status === 'requested' && repostCancel[0].external_run_id === repostRun
    && observeCalls() === observesBefore && repliesOf(reposted.id).length === 0,
  `repost race: cancelled, the accepted turn recorded and cancelled, never followed (${req(reposted.id).state}, ${repostCancel.map(e => e.status).join(',')})`);

  // repost after a cancel landed before the sweep: nothing is POSTed.
  const starts = startCalls();
  const early = await crashedAttempt('race-repost-early');
  remote.cancel(early.id, { actor: PERSON });
  await service.sweepDispatch();
  assert(req(early.id).state === 'cancelled' && startCalls() === starts && !types(early.id).includes('reconcile_decided'),
    'repost: a request cancelled before reconciliation is never re-POSTed');
  await service.waitForAgentDispatchIdle();
}

// Observation of a live provider turn fails. Under a retry-enabled policy
// the cleanup cancel decides: accepted, the turn is stopped and a retry
// may follow; refused, the turn may continue, so the Attempt is abandoned
// and nothing relaunches.
async function observationLoss() {
  console.log('\n[4d] losing sight of a turn: a failed cleanup cancel is abandoned evidence, never a retry');
  configure({ heartbeatMs: 60_000 });
  clock = Date.now();

  // Cancel refused: the provider lost the turn mid-observation, so the
  // cleanup cancel fails too.
  holdNextTurns(1);
  const refused = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 3, BOTMANCERS_RETRY_BASE_DELAY_MS: 1_000 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Unobserved cancel refused', idempotencyKey: 'observation-lost-refused' }));
  const refusedId = refused.accepted.requestId;
  await waitFor(() => attemptsOf(refusedId)[0]?.external_run_id, 'turn started');
  const refusedRun = attemptsOf(refusedId)[0].external_run_id;
  deleteProviderTurn(providerTurnIdOf(refusedRun));
  await refused.dispatched;
  const refusedAttempt = attemptsOf(refusedId)[0];
  const refusedAbandon = eventData(refusedId, 'attempt_abandoned');
  const refusedExternal = eventData(refusedId, 'external_cancel');
  assert(refusedAttempt.outcome === 'failed' && refusedAttempt.error_category === 'abandoned' && /did not accept the cancel/.test(refusedAttempt.error_message)
    && refusedAbandon.length === 1 && refusedAbandon[0].reason === 'observation_lost' && refusedAbandon[0].external_cancel === 'failed'
    && refusedExternal.length === 1 && refusedExternal[0].status === 'failed' && refusedExternal[0].external_run_id === refusedRun,
  `cancel refused: Attempt abandoned with failed external cancel (${refusedAttempt.error_category}, ${refusedExternal.map(e => e.status).join(',')})`);
  assert(req(refusedId).state === 'waiting' && attentionOf(refusedId)?.reason === 'external_cancel_failed' && req(refusedId).next_eligible_at === null
    && registryTurn(refusedRun).state === 'running',
  `cancel refused: no retry scheduled; operator attention while the registry turn still runs (${req(refusedId).state}, ${attentionOf(refusedId)?.reason ?? 'none'})`);
  const startsBefore = startCalls();
  advance(60_000);
  await service.sweepDispatch();
  await service.waitForAgentDispatchIdle();
  assert(attemptsOf(refusedId).length === 1 && startCalls() === startsBefore && req(refusedId).state === 'waiting',
    `cancel refused: later sweeps launch no second Attempt beside the live turn (${attemptsOf(refusedId).length} Attempts)`);

  // Cancel accepted: one observe fails, the cleanup stops the turn, and
  // the retryable failure schedules a bounded retry.
  failObserveWith = { code: 'internal', message: 'observe blew up' };
  const accepted = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 3, BOTMANCERS_RETRY_BASE_DELAY_MS: 1_000 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Unobserved cancel accepted', idempotencyKey: 'observation-lost-accepted' }));
  const acceptedId = accepted.accepted.requestId;
  await accepted.dispatched;
  const acceptedAttempt = attemptsOf(acceptedId)[0];
  const acceptedRun = acceptedAttempt.external_run_id;
  assert(acceptedAttempt.outcome === 'failed' && acceptedAttempt.error_category === 'runtime_failed'
    && count(acceptedId, 'attempt_abandoned') === 0 && count(acceptedId, 'external_cancel') === 0
    && registryTurn(acceptedRun).state === 'cancelled' && req(acceptedId).state === 'queued' && req(acceptedId).next_eligible_at !== null && !attentionOf(acceptedId),
  `cancel accepted: the turn was stopped, so the retryable failure schedules a bounded retry (${req(acceptedId).state}, ${acceptedAttempt.error_category})`);
  await service.cancelWorkRequest(acceptedId, { actor: PERSON });
}

// ---------------------------------------------------------------------
async function projections() {
  console.log('\n[5] conversation projections distinguish each control outcome');
  configure();
  clock = Date.now();
  // cancel requested -> cancelled.
  useControlledAdapter({ honorSignal: true });
  const cancelled = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Project cancel', idempotencyKey: 'proj-cancel' });
  await waitFor(() => runsFor(cancelled.accepted.requestId).length === 1, 'adapter entered');
  await service.cancelWorkRequest(cancelled.accepted.requestId, { actor: PERSON, reason: 'changed my mind' });
  await cancelled.dispatched;
  let kinds = kindsOf(cancelled.accepted.conversationId, cancelled.accepted.requestId);
  assert(kinds.join(',') === 'request_queued,request_running,request_running,request_cancel_requested,request_cancelled', `cancel sequence: ${kinds.join(',')}`);
  const view = projector.listConversationEvents(cancelled.accepted.conversationId).filter(e => e.requestId === cancelled.accepted.requestId);
  const cancelText = view.find(e => e.kind === 'request_cancel_requested');
  const cancelledText = view.find(e => e.kind === 'request_cancelled');
  assert(cancelText.text === 'Cancel requested: changed my mind' && cancelText.data.by === 'person:control-owner' && cancelledText.text === 'Cancelled: changed my mind' && cancelledText.state === 'cancelled',
    'cancel rows carry the reason, actor, and state');

  // timed out.
  useControlledAdapter();
  const timed = withPolicy({ BOTMANCERS_REQUEST_DEADLINE_MS: 5_000 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Project timeout', idempotencyKey: 'proj-timeout' }));
  await waitFor(() => runsFor(timed.accepted.requestId).length === 1, 'adapter entered');
  advance(10_000);
  await service.sweepDispatch();
  kinds = kindsOf(timed.accepted.conversationId, timed.accepted.requestId);
  assert(kinds.join(',') === 'request_queued,request_running,request_running,request_timed_out', `timeout sequence: ${kinds.join(',')}`);
  runsFor(timed.accepted.requestId)[0].finish({ output: 'late' });
  await service.waitForAgentDispatchIdle();
  assert(kindsOf(timed.accepted.conversationId, timed.accepted.requestId).length === kinds.length, 'a late result adds no projected row');

  // retry scheduled (x2) -> retries exhausted.
  clock = Date.now();
  useControlledAdapter({ script: e => e.finish({ category: 'runtime_failed' }) });
  const exhausted = withPolicy({ BOTMANCERS_RETRY_MAX_ATTEMPTS: 3, BOTMANCERS_RETRY_BASE_DELAY_MS: 1_000 }, () =>
    service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Project retries', idempotencyKey: 'proj-retry' }));
  await exhausted.dispatched;
  for (let i = 0; i < 2; i++) {
    advance(10_000);
    await service.sweepDispatch();
    await service.waitForAgentDispatchIdle();
  }
  kinds = kindsOf(exhausted.accepted.conversationId, exhausted.accepted.requestId);
  const expected = ['request_queued', 'request_running', 'request_running', 'request_retry_scheduled', 'request_running', 'request_running', 'request_retry_scheduled', 'request_running', 'request_running', 'request_retries_exhausted'];
  assert(kinds.join(',') === expected.join(','), `retry sequence: ${kinds.join(',')}`);
  const retryRows = projector.listConversationEvents(exhausted.accepted.conversationId).filter(e => e.kind === 'request_retry_scheduled' && e.requestId === exhausted.accepted.requestId);
  assert(retryRows.map(e => e.text).join(' | ') === 'Retry scheduled (Attempt 2 of 3) in 1000 ms | Retry scheduled (Attempt 3 of 3) in 2000 ms'
    && retryRows.every(e => e.state === 'queued' && e.data.category === 'runtime_failed' && typeof e.data.next_eligible_at === 'number'),
  `retry rows carry the Attempt number, delay, and category (${retryRows.map(e => e.text).join(' | ')})`);
  const exhaustedRow = projector.listConversationEvents(exhausted.accepted.conversationId).find(e => e.kind === 'request_retries_exhausted');
  assert(exhaustedRow.data.attempt_count === 3 && exhaustedRow.data.max_attempts === 3 && exhaustedRow.state === 'failed', 'exhausted row names 3 of 3 Attempts');

  // Distinct from a plain failure and idempotent on replay.
  useControlledAdapter({ script: e => e.finish({ category: 'runtime_failed' }) });
  const plain = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Plain failure', idempotencyKey: 'proj-plain' });
  await plain.dispatched;
  kinds = kindsOf(plain.accepted.conversationId, plain.accepted.requestId);
  assert(kinds.at(-1) === 'request_failed', 'a one-Attempt failure still projects request_failed');
  const rows = one('SELECT COUNT(*) AS n FROM conversation_events').n;
  raw.prepare('DELETE FROM conversation_projection_cursors').run();
  for (const id of [cancelled, timed, exhausted, plain].map(s => s.accepted.requestId)) projector.projectRequest(id);
  assert(one('SELECT COUNT(*) AS n FROM conversation_events').n === rows, 'reprojecting from the event log writes no duplicate rows');
  const api = service.getAgentRequest(PERSON, cancelled.accepted.requestId);
  assert(api.events.map(e => e.type).join('>') === 'accepted>dispatched>runtime_started>cancel_requested>failed' && api.failure.code === 'cancelled',
    `API request view keeps its vocabulary and shows cancel_requested (${api.events.map(e => e.type).join('>')})`);
  dispatch.setAttemptAdapterOverride(null);
}

// ---------------------------------------------------------------------
async function main() {
  console.log('NOT-473 cancellation, deadlines, and bounded retries');
  WORKROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-request-control-work-'));
  STATE = path.join(os.tmpdir(), `botmancers-request-control-provider-${process.pid}.json`);
  fs.rmSync(STATE, { force: true });
  hermes = botNamed('Control Hermes', { agent: 'hermes' });
  codex = botNamed('Control Codex', { agent: 'codex' });
  db.bots.updateRegistration(codex.id, 'codex', {
    runtime_connection_id: db.runtimeConnections.ensureLocal('codex'),
    session_scope: { kind: 'workspaces', workspaces: [WORKROOT], sessions: [] },
    default_workspace: WORKROOT,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  codex = bots.getById(codex.id);
  providerContract.registerSessionProvider({ connectionId: codex.runtime_connection_id }, () => wrappedProvider());

  await cancelStateMachine();
  await deadlineScenarios();
  await farDeadlines();
  policyUnits();
  await retryScenarios();
  await supersedingRetry();
  await externalCancel();
  await reconcileRaces();
  await observationLoss();
  await projections();
  await service.waitForAgentDispatchIdle();

  void executor;
  finished = true;
  console.log(`\nTEST RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures} assertion(s))`}`);
  removeDb(DB_PATH);
  fs.rmSync(STATE, { force: true });
  fs.rmSync(WORKROOT, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
