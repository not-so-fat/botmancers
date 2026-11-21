#!/usr/bin/env node
// NOT-469: leased dispatcher with restart reconciliation (lib/dispatcher,
// lib/agent-conversations), NOT-543 direct cutover.
//
// Proves, with deterministic fakes (no network, in-process providers):
//
// - competing worker processes on one database never hold the same lease
//   or create two Attempts for one claim, and race takeovers of expired
//   leases exactly once;
// - the accepted NOT-468 decision table, row by row;
// - startup and expired-lease reconciliation for running, completed,
//   failed, canceled, provider-lost, unknown, provider-unavailable, and
//   no-run-id Attempts, never relaunching an ambiguous run;
// - global and per-target concurrency limits with controlled adapter
//   barriers, without losing queued work (also across a restart);
// - a worker whose lease was taken over cannot commit, nor write runtime
//   events or external ids while its adapter is still running;
// - a refused direct launch fails the Attempt immediately; direct
//   launches are synchronous registry calls, so there is no lost-response
//   ambiguity (same-key idempotency is proven by the no-run-id and crash
//   cases instead);
// - ordered engine events for normal and crash-recovery flows;
// - crash injection (SIGKILL) before launch, after provider acceptance,
//   after run-id persistence, and before the terminal commit: no lost
//   request and exactly one provider turn each.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = require('./support/repo-root');
const SCENARIO = process.env.DISPATCH_SCENARIO || 'main';
const DB_PATH = process.env.DISPATCH_DB || path.join(os.tmpdir(), `botmancers-dispatcher-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
if (SCENARIO === 'main') removeDb(DB_PATH);
process.env.DISPATCH_DB = DB_PATH;
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
if (!process.env.DISPATCH_HOME) process.env.DISPATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-dispatcher-home-'));
process.env.HOME = process.env.DISPATCH_HOME;
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const service = jiti('../lib/agent-conversations.ts');
const dispatch = jiti('../lib/agent-dispatch.ts');
const executor = jiti('../lib/attempt-executor.ts');
const intake = jiti('../lib/conversation-intake.ts');
const lib = jiti('../lib/dispatcher.ts');
const providerContract = jiti('../lib/session-provider.ts');
const sessions = jiti('../lib/provider-sessions.ts');
const fake = require('./support/fake-session-provider');
const raw = db.default;
const { bots, engine } = db;

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
const PERSON = { kind: 'person', id: 'dispatch-owner' };
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
const all = (sql, ...args) => raw.prepare(sql).all(...args);
const types = requestId => engine.listEvents(requestId).map(event => event.type);
const attemptsOf = requestId => all('SELECT * FROM work_attempts WHERE request_id = ? ORDER BY attempt_number', requestId);
const leaseOf = requestId => one('SELECT * FROM dispatch_leases WHERE request_id = ?', requestId);
const attentionOf = requestId => one('SELECT * FROM dispatch_attention WHERE request_id = ? AND cleared_at IS NULL', requestId);
const repliesOf = requestId => all("SELECT * FROM messages WHERE request_id = ? AND sender_type = 'bot'", requestId);
function eventData(requestId, type) {
  return engine.listEvents(requestId).filter(event => event.type === type).map(event => JSON.parse(event.data || 'null'));
}
// Whether `expected` appears in order (not necessarily adjacent) in `list`.
function inOrder(list, expected) {
  let at = 0;
  for (const item of list) if (item === expected[at]) at += 1;
  return at === expected.length;
}

// Creates queued requests without dispatching them.
function queuedRequest(agentId, key, content = `Task ${key}`) {
  intake.setIntakeDispatcher(() => {});
  try {
    return service.acceptAgentMessage(PERSON, { agentId, content, idempotencyKey: key }).accepted.requestId;
  } finally {
    intake.setIntakeDispatcher(null);
  }
}

function botNamed(name, fields) {
  return bots.getAll().find(bot => bot.name === name) || bots.create({ name, title: '', description: '', ...fields });
}

// ---------------------------------------------------------------------
// Child: competing worker process.
async function raceWorker() {
  const ids = JSON.parse(fs.readFileSync(process.env.RACE_IDS, 'utf8'));
  const owner = `race-worker-${process.env.RACE_WORKER}`;
  const worker = lib.createDispatcher(raw, engine, { owner, config: { maxGlobal: 10_000, maxPerTarget: 10_000, leaseMs: 60_000 } });
  fs.writeFileSync(`${process.env.RACE_SYNC}.ready.${process.env.RACE_WORKER}`, '');
  while (!fs.existsSync(`${process.env.RACE_SYNC}.go`)) await sleep(2);
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const won = [];
  const errors = [];
  // FIFO admission refuses a younger claim while an older request is still
  // queued, so claim workers sweep their shuffled order until none is left.
  const passes = process.env.RACE_PHASE === 'claim' ? 400 : 1;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0 && !ids.some(id => engine.getWorkRequest(id).state === 'queued')) break;
    for (const id of order) {
      if (process.env.RACE_PHASE === 'claim' && engine.getWorkRequest(id).state !== 'queued') continue;
      try {
        if (process.env.RACE_PHASE === 'claim') {
          const claimed = engine.transaction(() => {
            const claim = worker.claim(id);
            if (!claim.ok) return false;
            const attempt = engine.createAttempt(id, { kind: 'launch', adapter: 'race', toolProfile: 'readonly', launchSnapshot: { owner } });
            worker.recordLaunchIntent(claim.lease, attempt.id, 'race', null);
            return true;
          });
          if (claimed) won.push(id);
          // Yield so the workers interleave instead of one sweeping all.
          await sleep(1);
        } else {
          const item = worker.recoverable().find(entry => entry.requestId === id);
          if (item && worker.takeOver(item)) won.push(id);
          await sleep(1);
        }
      } catch (error) {
        errors.push(String(error && error.message));
      }
    }
  }
  process.stdout.write(JSON.stringify({ owner, won, errors }));
}

function runChild(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [__filename], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err, pid: child.pid }));
  });
}

async function raceScenario() {
  console.log('\n[1] competing workers: one lease and one Attempt per claim');
  const targets = [0, 1, 2, 3].map(i => botNamed(`Race Target ${i}`, { agent: 'hermes' }));
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(queuedRequest(targets[i % 4].id, `race-${i}`));
  const idsFile = path.join(os.tmpdir(), `botmancers-race-${process.pid}.json`);
  fs.writeFileSync(idsFile, JSON.stringify(ids));
  const WORKERS = 4;
  for (const phase of ['claim', 'takeover']) {
    const sync = path.join(os.tmpdir(), `botmancers-race-${process.pid}-${phase}`);
    const children = [];
    for (let w = 0; w < WORKERS; w++) {
      children.push(runChild({ DISPATCH_SCENARIO: 'race', RACE_IDS: idsFile, RACE_WORKER: String(w), RACE_SYNC: sync, RACE_PHASE: phase }));
    }
    const ready = () => [...Array(WORKERS).keys()].every(w => fs.existsSync(`${sync}.ready.${w}`));
    await waitFor(ready, `${phase} workers ready`, 60_000);
    fs.writeFileSync(`${sync}.go`, '');
    const results = (await Promise.all(children)).map(result => {
      try { return JSON.parse(result.out); } catch { console.log(result.err); return { owner: null, won: [], errors: ['no output'] }; }
    });
    const won = results.flatMap(result => result.won);
    assert(results.every(result => result.errors.length === 0), `${phase}: no worker hit a database error (${results.flatMap(r => r.errors).slice(0, 2).join('; ')})`);
    assert(won.length === ids.length && new Set(won).size === ids.length, `${phase}: ${WORKERS} workers won each of ${ids.length} requests exactly once (wins ${won.length})`);
    assert(results.filter(result => result.won.length > 0).length >= 2, `${phase}: the race was real (${results.map(r => r.won.length).join('/')} wins per worker)`);
    for (const id of ids) {
      const winner = results.find(result => result.won.includes(id));
      const lease = leaseOf(id);
      if (!lease || !winner || lease.owner !== winner.owner) {
        assert(false, `${phase}: lease of ${id} is held by its winner`);
        break;
      }
    }
    for (const sfx of ['go', ...[...Array(WORKERS).keys()].map(w => `ready.${w}`)]) fs.rmSync(`${sync}.${sfx}`, { force: true });
    if (phase === 'claim') {
      const counts = ids.map(id => ({
        leases: one('SELECT COUNT(*) AS n FROM dispatch_leases WHERE request_id = ?', id).n,
        attempts: one('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ?', id).n,
        intents: one('SELECT COUNT(*) AS n FROM attempt_launch_intents WHERE request_id = ?', id).n,
        claims: one("SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ? AND type = 'dispatch_claimed'", id).n,
        state: engine.getWorkRequest(id).state,
      }));
      assert(counts.every(c => c.leases === 1 && c.attempts === 1 && c.intents === 1 && c.claims === 1 && c.state === 'running'),
        'database: every request has exactly one lease, one Attempt, one launch intent, one claim event, and is running');
      // Expire every lease for the takeover race.
      raw.prepare('UPDATE dispatch_leases SET expires_at = 0').run();
    } else {
      const takeovers = ids.map(id => one("SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ? AND type = 'dispatch_lease_taken_over'", id).n);
      assert(takeovers.every(n => n === 1), 'database: each expired lease was taken over exactly once');
      assert(ids.every(id => one('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ? AND finished_at IS NULL', id).n === 1), 'takeover created no second Attempt');
    }
  }
  // Clean up so later scenarios see free capacity.
  for (const id of ids) {
    engine.transaction(() => {
      for (const attempt of attemptsOf(id)) if (!attempt.finished_at) engine.finishAttempt(attempt.id, { outcome: 'cancelled' });
      engine.transitionWorkRequest(id, { from: 'running', to: 'cancelled', reason: 'test_cleanup' });
      raw.prepare('DELETE FROM dispatch_leases WHERE request_id = ?').run(id);
    });
  }
  fs.rmSync(idsFile, { force: true });
}

// ---------------------------------------------------------------------
function decisionTable() {
  console.log('\n[2] accepted NOT-468 decision table');
  const intent = { body: '{}', idempotency_key: 'botmancers-attempt-x', grant_fingerprint: 'g1' };
  const rowsA = [
    [{ reconcilable: false, intent, currentGrantFingerprint: 'g1' }, 'interrupted', 'runtime_unobservable'],
    [{ reconcilable: true, intent: undefined, currentGrantFingerprint: 'g1' }, 'attention', 'launch_intent_missing'],
    [{ reconcilable: true, intent, currentGrantFingerprint: null }, 'attention', 'grant_unavailable'],
    [{ reconcilable: true, intent, currentGrantFingerprint: 'g2' }, 'attention', 'grant_mismatch'],
    [{ reconcilable: true, intent, currentGrantFingerprint: 'g1' }, 'repost', undefined],
  ];
  for (const [input, action, reason] of rowsA) {
    const decision = lib.decideWithoutRunId(input);
    assert(decision.action === action && decision.reason === reason, `A (no run id): ${JSON.stringify({ ...input, intent: !!input.intent })} -> ${action}${reason ? `/${reason}` : ''}`);
  }
  const rejected = (status, code) => ({ kind: 'rejected', status, code });
  const rowsRepost = [
    [{ kind: 'accepted', runId: 'r' }, 'reattach'],
    [rejected(409, 'IDEMPOTENCY_CONFLICT'), 'attention', 'idempotency_conflict'],
    [rejected(400, 'BAD_REQUEST'), 'fail'],
    [rejected(404, 'DECK_NOT_FOUND'), 'fail'],
    [rejected(422, 'WORKSPACE_MISSING'), 'fail'],
    [rejected(422, 'PROFILE_UNSUPPORTED'), 'fail'],
    [rejected(422, 'RESUME_UNVERIFIED'), 'fail'],
    [rejected(422, 'FINALIZATION_INVALID'), 'fail'],
    [rejected(409, 'INDEX_DIRTY'), 'fail'],
    [rejected(503, 'CLIENT_UNAVAILABLE'), 'fail'],
    [{ kind: 'unauthorized' }, 'attention', 'grant'],
    [{ kind: 'forbidden' }, 'attention', 'grant'],
    [{ kind: 'unreachable' }, 'defer', 'unreachable'],
    [rejected(502, null), 'defer', 'server_error'],
    [rejected(418, 'TEAPOT'), 'attention', 'unrecognized_response'],
  ];
  for (const [observation, action, reason] of rowsRepost) {
    const decision = lib.decideRepostResult(observation);
    assert(decision.action === action && (reason === undefined || decision.reason === reason), `A (re-POST answer): ${JSON.stringify(observation)} -> ${action}${reason ? `/${reason}` : ''}`);
  }
  const run = state => ({ kind: 'run', state });
  const rowsB = [
    [run('starting'), 'reattach'],
    [run('running'), 'reattach'],
    [run('ended'), 'reattach'],
    [run('error'), 'reattach'],
    [run('canceled'), 'reattach'],
    [run('died'), 'interrupted_attention', 'run_died'],
    [{ kind: 'not_found' }, 'attention', 'run_not_found'],
    [{ kind: 'unauthorized' }, 'attention', 'grant_expired'],
    [{ kind: 'forbidden' }, 'attention', 'grant_scope'],
    [{ kind: 'unreachable' }, 'defer', 'unreachable'],
    [rejected(500, null), 'defer', 'server_error'],
  ];
  for (const [observation, action, reason] of rowsB) {
    const decision = lib.decideWithRunId(observation);
    assert(decision.action === action && (reason === undefined || decision.reason === reason), `B (run id): ${JSON.stringify(observation)} -> ${action}${reason ? `/${reason}` : ''}`);
  }

  const config = lib.dispatchConfigFromEnv({
    BOTMANCERS_DISPATCH_MAX_GLOBAL: '7', BOTMANCERS_DISPATCH_MAX_PER_TARGET: '0', BOTMANCERS_DISPATCH_LEASE_MS: 'abc', BOTMANCERS_DISPATCH_HEARTBEAT_MS: '250',
  });
  assert(config.maxGlobal === 4 && config.maxPerTarget === lib.DEFAULT_DISPATCH_CONFIG.maxPerTarget
    && config.leaseMs === lib.DEFAULT_DISPATCH_CONFIG.leaseMs && config.heartbeatMs === 250,
  'concurrency config: positive integers apply, invalid values fall back to deterministic defaults, global 7 clamps to 4');
  const overLimit = lib.dispatchConfigFromEnv({ BOTMANCERS_DISPATCH_MAX_GLOBAL: '100', BOTMANCERS_DISPATCH_MAX_PER_TARGET: '100' });
  assert(overLimit.maxGlobal === 4 && overLimit.maxPerTarget === 1, 'over-limit concurrency config (100/100) clamps to the approved global 4 / per-target 1');
  const narrowed = lib.dispatchConfigFromEnv({ BOTMANCERS_DISPATCH_MAX_GLOBAL: '2', BOTMANCERS_DISPATCH_MAX_PER_TARGET: '1' });
  assert(narrowed.maxGlobal === 2 && narrowed.maxPerTarget === 1, 'concurrency config may narrow below the approved maxima');
  const previousEnv = { g: process.env.BOTMANCERS_DISPATCH_MAX_GLOBAL, t: process.env.BOTMANCERS_DISPATCH_MAX_PER_TARGET };
  process.env.BOTMANCERS_DISPATCH_MAX_GLOBAL = '100';
  process.env.BOTMANCERS_DISPATCH_MAX_PER_TARGET = '100';
  const fromEnv = lib.createDispatcher(raw, engine, { owner: 'env-clamp' });
  if (previousEnv.g === undefined) delete process.env.BOTMANCERS_DISPATCH_MAX_GLOBAL; else process.env.BOTMANCERS_DISPATCH_MAX_GLOBAL = previousEnv.g;
  if (previousEnv.t === undefined) delete process.env.BOTMANCERS_DISPATCH_MAX_PER_TARGET; else process.env.BOTMANCERS_DISPATCH_MAX_PER_TARGET = previousEnv.t;
  assert(fromEnv.config.maxGlobal === 4 && fromEnv.config.maxPerTarget === 1, 'a production dispatcher built from over-limit env runs at global 4 / per-target 1');
  const defaults = lib.dispatchConfigFromEnv({});
  assert(JSON.stringify(defaults) === JSON.stringify({ maxGlobal: 4, maxPerTarget: 1, leaseMs: 60000, heartbeatMs: 15000, deferMs: 5000, cancelGraceMs: 30000 }), 'deterministic defaults: global 4, per target 1, lease 60s, heartbeat 15s, defer 5s, cancel grace 30s');
}

// ---------------------------------------------------------------------
const DEAD_OWNER = 'dead-host.invalid:1:deadbeef';
let codex;
let hermes;
let WORKROOT;
let STATE;

// The durable state a worker leaves when it dies mid-dispatch, built
// from the real claim, Attempt, launch intent, and (optionally) the real
// direct provider start through the adapter's own repost: only the crash
// itself is simulated.
async function crashedAttempt(label, options = {}) {
  const bot = options.bot || codex;
  const id = queuedRequest(bot.id, `crash-${label}`, `Reconcile ${label}`);
  const prepared = dispatch.prepareDispatch({
    bot, history: [{ speakerLabel: 'person:dispatch-owner', fromAgent: false, content: `Reconcile ${label}` }], toolProfile: 'readonly',
  });
  const dead = lib.createDispatcher(raw, engine, { owner: DEAD_OWNER, config: { maxGlobal: 1000, maxPerTarget: 1000 } });
  const agent = dispatch.agentForDispatch(bot);
  const { attempt } = engine.transaction(() => {
    const claim = dead.claim(id, { data: { agent } });
    const begun = executor.beginAttempt(engine, id, { agent, adapter: prepared.adapter, input: prepared.input, snapshot: { agent } });
    const intent = prepared.adapter.launchIntent ? prepared.adapter.launchIntent(begun.input) : null;
    dead.recordLaunchIntent(claim.lease, begun.attempt.id, prepared.adapter.name, intent);
    return { attempt: begun.attempt, lease: claim.lease };
  });
  let runId = null;
  if (options.post) {
    const intent = dead.launchIntent(attempt.id);
    const launched = await prepared.adapter.reconciler.repost({ idempotencyKey: intent.idempotency_key, body: intent.body });
    if (launched.kind !== 'accepted') throw new Error(`crashedAttempt launch not accepted: ${JSON.stringify(launched)}`);
    runId = launched.runId;
  }
  if (options.forceRunId) runId = options.forceRunId;
  if (runId && options.persist !== false) engine.recordAttemptExternalIds(attempt.id, { externalRunId: runId });
  if (options.unleased) raw.prepare('DELETE FROM dispatch_leases WHERE request_id = ?').run(id);
  else raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  return { id, attemptId: attempt.id, runId };
}

// Provider-side evidence: starts and the fake turn ids behind them.
const startCalls = () => fake.providerCalls(STATE, 'startSession');
const observeCalls = () => fake.providerCalls(STATE, 'observeTurn');
const turnRows = () => one('SELECT COUNT(*) AS n FROM provider_session_turns WHERE agent_id = ?', codex.id).n;
// Script the next provider turn's output (the fake completes unheld
// turns with the next queued result).
function queueResults(...results) {
  fake.mutateFakeProvider(STATE, state => { state.results = [...(state.results ?? []), ...results]; });
}
function holdNextTurns(count = 1) {
  fake.mutateFakeProvider(STATE, state => { state.holdNext = (state.holdNext ?? 0) + count; });
}
function newTurnIds(before) {
  const seen = new Set(before);
  return fake.fakeTurnIds(STATE).filter(id => !seen.has(id));
}
function scriptTurn(fakeId, fields) {
  fake.mutateFakeProvider(STATE, state => {
    if (!state.turns[fakeId]) throw new Error(`no provider turn ${fakeId}`);
    Object.assign(state.turns[fakeId], fields);
  });
}

async function reconciliationScenarios() {
  console.log('\n[3] reconciliation follows runtime evidence, never relaunching an ambiguous run');
  service.configureDispatcher({ owner: `test-main:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });

  // running: reattach, observe to terminal, complete once.
  holdNextTurns(1);
  const running = await crashedAttempt('running', { post: true });
  const runningFake = newTurnIds([]).at(-1);
  const startsBefore = startCalls();
  const observesBefore = observeCalls();
  const sweeping = service.sweepDispatch();
  await waitFor(() => observeCalls() > observesBefore, 'reattached turn observed');
  assert(engine.getWorkRequest(running.id).state === 'running' && attemptsOf(running.id)[0].finished_at === null, 'running: Attempt stays open while the turn is live');
  fake.releaseFakeTurn(STATE, runningFake, 'DONE-running');
  await sweeping;
  let request = engine.getWorkRequest(running.id);
  let attempts = attemptsOf(running.id);
  assert(request.state === 'completed' && attempts.length === 1 && attempts[0].outcome === 'succeeded' && attempts[0].output === 'DONE-running', 'running: reattached and completed with the turn output');
  assert(startCalls() === startsBefore && repliesOf(running.id).length === 1 && !leaseOf(running.id), 'running: no second start, one reply, lease released');
  assert(inOrder(types(running.id), ['dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded', 'dispatch_lease_taken_over', 'reconcile_decided', 'attempt_finished', 'state_changed', 'dispatch_released']),
    `running: ordered recovery events (${types(running.id).join(',')})`);
  assert(eventData(running.id, 'dispatch_lease_taken_over')[0].reason === 'lease_expired' && eventData(running.id, 'reconcile_decided')[0].action === 'reattach', 'running: takeover reason lease_expired, decision reattach');

  // completed (ended with a result).
  queueResults('DONE-completed');
  const completed = await crashedAttempt('completed', { post: true });
  await service.sweepDispatch();
  request = engine.getWorkRequest(completed.id);
  assert(request.state === 'completed' && attemptsOf(completed.id)[0].output === 'DONE-completed' && repliesOf(completed.id).length === 1, 'completed: reconciled succeeded with the recorded result, one reply');

  // failed (error).
  const errorBefore = fake.fakeTurnIds(STATE);
  const errored = await crashedAttempt('error', { post: true });
  scriptTurn(newTurnIds(errorBefore)[0], { state: 'failed', output: null, finished_at: Date.now() });
  await service.sweepDispatch();
  attempts = attemptsOf(errored.id);
  assert(engine.getWorkRequest(errored.id).state === 'failed' && attempts[0].outcome === 'failed' && attempts[0].error_category === 'runtime_failed', 'failed: an error turn fails runtime_failed');

  // canceled.
  const canceledBefore = fake.fakeTurnIds(STATE);
  const canceled = await crashedAttempt('canceled', { post: true });
  await sessions.cancelProviderTurn(raw, codex.id, canceled.runId, { correlation: {} });
  assert(newTurnIds(canceledBefore).length === 1, 'canceled: the crash left one provider turn');
  await service.sweepDispatch();
  assert(attemptsOf(canceled.id)[0].outcome === 'cancelled' && engine.getWorkRequest(canceled.id).state === 'failed', 'canceled: reconciled cancelled');

  // ended without a valid result.
  const emptyBefore = fake.fakeTurnIds(STATE);
  const noResult = await crashedAttempt('no-result', { post: true });
  scriptTurn(newTurnIds(emptyBefore)[0], { state: 'completed', output: '', finished_at: Date.now() });
  await service.sweepDispatch();
  assert(attemptsOf(noResult.id)[0].error_category === 'result_contract', 'ended without a valid result fails result_contract');

  // provider-lost: the provider has no such turn anymore. The run is
  // provably gone (not ambiguous), so the Attempt fails closed and the
  // request fails under the one-Attempt policy; nothing relaunches.
  const lostBefore = fake.fakeTurnIds(STATE);
  const lost = await crashedAttempt('lost', { post: true });
  const lostFake = newTurnIds(lostBefore)[0];
  const lostTurns = turnRows();
  const lostStarts = startCalls();
  fake.mutateFakeProvider(STATE, state => { delete state.turns[lostFake]; });
  await service.sweepDispatch();
  attempts = attemptsOf(lost.id);
  assert(attempts.length === 1 && attempts[0].outcome === 'failed' && attempts[0].error_category === 'abandoned', 'provider-lost: the Attempt fails abandoned/observation-lost (not interrupted, not relaunched)');
  assert(engine.getWorkRequest(lost.id).state === 'failed' && !attentionOf(lost.id), 'provider-lost: request failed fast, no attention');
  assert(turnRows() === lostTurns && startCalls() === lostStarts && !leaseOf(lost.id), 'provider-lost: no relaunch, lease released');
  await service.sweepDispatch();
  assert(attemptsOf(lost.id).length === 1 && startCalls() === lostStarts && engine.getWorkRequest(lost.id).state === 'failed', 'provider-lost: a later sweep does nothing (terminal)');

  // unknown run id (no registry turn).
  const unknown = await crashedAttempt('unknown', { forceRunId: 'turn-20261014T000000-missing' });
  const unknownStarts = startCalls();
  await service.sweepDispatch();
  attempts = attemptsOf(unknown.id);
  assert(attempts[0].finished_at === null && attentionOf(unknown.id)?.reason === 'run_not_found' && engine.getWorkRequest(unknown.id).state === 'waiting',
    'unknown: Attempt stays open with attention run_not_found');
  assert(startCalls() === unknownStarts, 'unknown: never relaunched');

  // provider unavailable at reconcile: the Attempt fails closed (no hang,
  // no relaunch); the provider is restored afterwards.
  queueResults('DONE-unavailable');
  const down = await crashedAttempt('unavailable', { post: true });
  const downTurns = turnRows();
  const downStarts = startCalls();
  providerContract.clearSessionProviders({ builtins: true });
  await service.sweepDispatch();
  providerContract.registerSessionProvider({ connectionId: codex.runtime_connection_id },
    () => fake.createFakeSessionProvider({ statePath: STATE, kind: 'dispatch-main' }));
  attempts = attemptsOf(down.id);
  assert(attempts[0].outcome === 'failed' && engine.getWorkRequest(down.id).state === 'failed', 'unavailable: Attempt and request fail closed');
  assert(turnRows() === downTurns && startCalls() === downStarts, 'unavailable: no relaunch while the provider is gone');

  // No run id, the first start never landed: repost launches once.
  queueResults('DONE-before-launch');
  const turnsBefore = turnRows();
  const unlaunched = await crashedAttempt('no-run-id', {});
  await service.sweepDispatch();
  assert(engine.getWorkRequest(unlaunched.id).state === 'completed' && turnRows() === turnsBefore + 1 && attemptsOf(unlaunched.id)[0].external_run_id,
    'no run id (never sent): one same-key repost, one launch, completed');

  // No run id, the start landed: same-key repost returns the same turn.
  queueResults('DONE-after-accept');
  const accepted = await crashedAttempt('accepted-lost', { post: true, persist: false });
  const turnsAfterAccept = turnRows();
  const startsAfterAccept = startCalls();
  await service.sweepDispatch();
  assert(engine.getWorkRequest(accepted.id).state === 'completed' && turnRows() === turnsAfterAccept && startCalls() === startsAfterAccept && attemptsOf(accepted.id)[0].external_run_id === accepted.runId,
    'no run id (accepted, id lost): repost returned the original turn, no second launch');

  // No run id, pre-launch rejection: fail launch_failed. The intent names
  // the crashed workspace; after the crash the scope no longer covers it.
  const rejectedLaunch = await crashedAttempt('rejected', {});
  const scopeBefore = { kind: codex.session_scope_kind, items: codex.session_scope_items };
  db.bots.updateRegistration(codex.id, 'codex', {
    runtime_connection_id: codex.runtime_connection_id,
    session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'elsewhere')], sessions: [] },
    default_workspace: null,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  await service.sweepDispatch();
  db.bots.updateRegistration(codex.id, 'codex', {
    runtime_connection_id: codex.runtime_connection_id,
    session_scope: { kind: scopeBefore.kind, workspaces: JSON.parse(scopeBefore.items), sessions: [] },
    default_workspace: WORKROOT,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  codex = bots.getById(codex.id);
  attempts = attemptsOf(rejectedLaunch.id);
  assert(attempts[0].outcome === 'failed' && attempts[0].error_category === 'launch_failed' && engine.getWorkRequest(rejectedLaunch.id).state === 'failed' && !attentionOf(rejectedLaunch.id),
    'no run id, pre-launch rejection: failed launch_failed without attention');

  // Interrupted: a transport that cannot be observed after a restart.
  const hermesAdapter = dispatch.adapterForTransport('hermes-gateway');
  dispatch.setAttemptAdapterOverride(transport => transport === 'hermes-gateway'
    ? { name: 'hermes-gateway', run: async () => { throw new Error('must not relaunch'); } }
    : hermesAdapter);
  const hermesCrash = await crashedAttempt('hermes', { bot: hermes });
  await service.sweepDispatch();
  dispatch.setAttemptAdapterOverride(null);
  attempts = attemptsOf(hermesCrash.id);
  request = engine.getWorkRequest(hermesCrash.id);
  assert(attempts.length === 1 && attempts[0].outcome === 'interrupted' && request.state === 'failed' && request.error_code === 'interrupted' && request.state_reason === 'retryable',
    'interrupted (unobservable transport): Attempt interrupted, request failed retryable, nothing relaunched');

  // Startup orphan: running with an open Attempt and no lease (NOT-468 F1).
  queueResults('DONE-orphan');
  const orphan = await crashedAttempt('orphan', { post: true, unleased: true });
  await service.recoverCoordinatorLoops();
  assert(engine.getWorkRequest(orphan.id).state === 'completed' && eventData(orphan.id, 'dispatch_lease_taken_over')[0].reason === 'unleased_running',
    'startup: an unleased running request is taken over and reconciled');

  // A lease that is still live is left alone.
  holdNextTurns(1);
  const liveBefore = fake.fakeTurnIds(STATE);
  const live = await crashedAttempt('live', { post: true });
  const liveFake = newTurnIds(liveBefore)[0];
  raw.prepare('UPDATE dispatch_leases SET expires_at = ? WHERE request_id = ?').run(Date.now() + 60_000, live.id);
  await service.sweepDispatch();
  assert(leaseOf(live.id).owner === DEAD_OWNER && !types(live.id).includes('dispatch_lease_taken_over'), 'a live lease of another worker is not taken over');
  fake.releaseFakeTurn(STATE, liveFake, 'DONE-live');
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(live.id);
  await service.sweepDispatch();
}

// ---------------------------------------------------------------------
async function fencingScenario() {
  console.log('\n[4] a worker whose lease was taken over cannot commit');
  service.configureDispatcher({ owner: `test-a:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });
  holdNextTurns(1);
  const fenceBefore = fake.fakeTurnIds(STATE);
  const startsBefore = startCalls();
  const accepted = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Fenced work', idempotencyKey: 'fence-1' });
  const id = accepted.accepted.requestId;
  await waitFor(() => attemptsOf(id)[0]?.external_run_id, 'live run id persisted');
  const other = lib.createDispatcher(raw, engine, { owner: `test-b:${process.pid}` });
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  const taken = other.takeOver(other.recoverable().find(item => item.requestId === id));
  assert(!!taken, 'worker B took over the expired lease');
  fake.releaseFakeTurn(STATE, newTurnIds(fenceBefore)[0], 'DONE-fenced');
  await accepted.dispatched;
  assert(engine.getWorkRequest(id).state === 'running' && attemptsOf(id)[0].finished_at === null && repliesOf(id).length === 0,
    'worker A observed the end but its fenced commit wrote nothing');
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  await service.sweepDispatch();
  assert(engine.getWorkRequest(id).state === 'completed' && repliesOf(id).length === 1 && attemptsOf(id).length === 1 && startCalls() === startsBefore + 1,
    'the next owner reconciled it once: one reply, one Attempt, one launch');
}

// ---------------------------------------------------------------------
// A live direct launch that the provider refuses fails the Attempt
// immediately and releases the lease: direct launches are synchronous
// registry calls, so there is no lost-response ambiguity to reconcile.
async function launchFailureScenario() {
  console.log('\n[4b] a refused direct launch fails fast; nothing stays ambiguous');
  service.configureDispatcher({ owner: `test-launch:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });
  fake.mutateFakeProvider(STATE, state => { state.failStarts = (state.failStarts ?? 0) + 1; state.startError = { code: 'runtime_error', message: 'model crashed' }; });
  const turnsBefore = turnRows();
  const sent = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Launch failure 0', idempotencyKey: 'launch-failure-0' });
  const id = sent.accepted.requestId;
  await sent.dispatched;
  const attempts = attemptsOf(id);
  assert(attempts.length === 1 && attempts[0].outcome === 'failed' && attempts[0].error_category === 'launch_failed'
    && engine.getWorkRequest(id).state === 'failed' && !leaseOf(id) && !types(id).includes('reconcile_deferred') && turnRows() === turnsBefore,
  'refused start: a pre-launch refusal fails the Attempt and releases the lease');
  await service.startAgentDispatch(id);
  assert(attemptsOf(id).length === 1, 'a repeated dispatch of the failed request creates no Attempt');
}

// ---------------------------------------------------------------------
// A live worker whose lease was taken over while its adapter was waiting
// writes no runtime events or external ids afterwards.
async function staleWorkerScenario() {
  console.log('\n[4c] a worker that lost its lease cannot write runtime events or external ids');
  let entered = null;
  let release = null;
  dispatch.setAttemptAdapterOverride(() => ({
    name: 'hermes-gateway',
    async run(input, onEvent) {
      await new Promise(resolve => { release = resolve; entered?.(); });
      onEvent({ type: 'started', adapter: 'hermes-gateway', at: Date.now(), externalRunId: 'stale-run', externalSessionId: 'stale-session' });
      onEvent({ type: 'progress', adapter: 'hermes-gateway', at: Date.now(), detail: { phase: 'stale' } });
      const now = Date.now();
      return { status: 'completed', adapter: 'hermes-gateway', externalRunId: 'stale-run', externalSessionId: 'stale-session', output: 'stale output', artifacts: [], startedAt: now, finishedAt: now, failure: null };
    },
  }));
  const ownerA = `test-stale-a:${process.pid}`;
  service.configureDispatcher({ owner: ownerA, config: { maxGlobal: 50, maxPerTarget: 50 } });

  // Control: with its lease held, the same adapter's events are recorded.
  let inAdapter = new Promise(resolve => { entered = resolve; });
  const control = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stale control', idempotencyKey: 'stale-control' });
  await inAdapter;
  release();
  await control.dispatched;
  const controlId = control.accepted.requestId;
  assert(types(controlId).includes('runtime_started') && types(controlId).includes('runtime_progress') && attemptsOf(controlId)[0].external_run_id === 'stale-run'
    && engine.getWorkRequest(controlId).state === 'completed', 'control: a worker holding its lease records started/progress and the run id');

  inAdapter = new Promise(resolve => { entered = resolve; });
  const sent = service.acceptAgentMessage(PERSON, { agentId: hermes.id, content: 'Stale worker', idempotencyKey: 'stale-worker' });
  const id = sent.accepted.requestId;
  await inAdapter;
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  const ownerB = `test-stale-b:${process.pid}`;
  const other = lib.createDispatcher(raw, engine, { owner: ownerB });
  assert(!!other.takeOver(other.recoverable().find(item => item.requestId === id)), 'worker B took over while worker A awaited its adapter');
  const atTakeover = engine.listEvents(id).length;
  release();
  await sent.dispatched;
  const after = engine.listEvents(id).slice(atTakeover).map(event => event.type);
  const attempt = attemptsOf(id)[0];
  assert(after.length === 0, `worker A wrote no events after the takeover (${after.join(',') || 'none'})`);
  assert(!types(id).includes('runtime_started') && !types(id).includes('runtime_progress'), 'no runtime_started or runtime_progress from the stale worker');
  assert(attempt.external_run_id === null && attempt.external_session_id === null && attempt.finished_at === null && repliesOf(id).length === 0
    && leaseOf(id)?.owner === ownerB && engine.getWorkRequest(id).state === 'running', 'Attempt ids untouched, Attempt open, no reply, lease still B\'s');

  // B's reconcile owns the outcome (an unobservable transport: interrupted).
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  await service.sweepDispatch();
  dispatch.setAttemptAdapterOverride(null);
  const request = engine.getWorkRequest(id);
  assert(request.state === 'failed' && request.error_code === 'interrupted' && attemptsOf(id).length === 1 && attemptsOf(id)[0].outcome === 'interrupted'
    && !types(id).includes('runtime_started'), 'the new owner reconciled it; the stale run id never appeared');
}

// ---------------------------------------------------------------------
async function concurrencyScenario() {
  console.log('\n[5] global and per-target limits with adapter barriers');
  const alpha = botNamed('Limit Alpha', { agent: 'hermes' });
  const beta = botNamed('Limit Beta', { agent: 'hermes' });
  const live = new Map();
  const gates = [];
  let maxActive = 0;
  const maxPerTarget = new Map();
  dispatch.setAttemptAdapterOverride(() => ({
    name: 'hermes-gateway',
    async run(input) {
      const target = input.target.agentId;
      live.set(target, (live.get(target) || 0) + 1);
      maxPerTarget.set(target, Math.max(maxPerTarget.get(target) || 0, live.get(target)));
      maxActive = Math.max(maxActive, [...live.values()].reduce((a, b) => a + b, 0));
      await new Promise(resolve => gates.push({ requestId: input.correlation.requestId, resolve }));
      live.set(target, live.get(target) - 1);
      const now = Date.now();
      return { status: 'completed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: null, output: `ok ${input.correlation.requestId}`, artifacts: [], startedAt: now, finishedAt: now, failure: null };
    },
  }));
  service.configureDispatcher({ owner: `test-limits:${process.pid}`, config: { maxGlobal: 2, maxPerTarget: 1 } });
  const sent = [];
  for (const [i, bot] of [alpha, alpha, beta, alpha, beta].entries()) {
    sent.push(service.acceptAgentMessage(PERSON, { agentId: bot.id, content: `Limited ${i}`, idempotencyKey: `limit-${i}` }).accepted.requestId);
  }
  await waitFor(() => gates.length === 2, 'two adapters entered');
  await sleep(20);
  const leases = one('SELECT COUNT(*) AS n FROM dispatch_leases').n;
  const queued = sent.filter(id => engine.getWorkRequest(id).state === 'queued');
  assert(gates.length === 2 && leases === 2 && queued.length === 3, `at the limits: 2 running, 3 queued (${gates.length} in adapter, ${leases} leases)`);
  assert(queued.every(id => types(id).at(-1) === 'dispatch_deferred'), 'each refused request recorded a durable dispatch_deferred event');
  const reasons = queued.map(id => eventData(id, 'dispatch_deferred').at(-1).reason);
  assert(reasons.includes('target_limit') || reasons.includes('global_limit'), `deferral reasons recorded (${reasons.join(',')})`);
  let released = 0;
  while (released < sent.length) {
    await waitFor(() => gates.length > 0, 'an adapter waiting');
    gates.shift().resolve();
    released += 1;
    await sleep(15);
  }
  await service.waitForAgentDispatchIdle();
  dispatch.setAttemptAdapterOverride(null);
  assert(maxActive === 2, `never more than 2 launches at once (max ${maxActive})`);
  assert([...maxPerTarget.values()].every(n => n === 1), 'never more than 1 launch per target');
  assert(sent.every(id => engine.getWorkRequest(id).state === 'completed' && attemptsOf(id).length === 1 && repliesOf(id).length === 1), 'no queued work lost: all 5 completed with exactly one Attempt and one reply');
  assert(one('SELECT COUNT(*) AS n FROM dispatch_leases').n === 0, 'all leases released');

  // Deferred work survives a restart: the slot is held by another live
  // worker, the request is deferred, then a fresh process drains it.
  const holder = queuedRequest(beta.id, 'limit-holder');
  const outside = lib.createDispatcher(raw, engine, { owner: 'other-host.invalid:7:live', config: { maxGlobal: 100, maxPerTarget: 100 } });
  const held = engine.transaction(() => outside.claim(holder));
  dispatch.setAttemptAdapterOverride(() => ({
    name: 'hermes-gateway',
    async run(input) {
      const now = Date.now();
      return { status: 'completed', adapter: 'hermes-gateway', externalRunId: null, externalSessionId: null, output: `ok ${input.correlation.requestId}`, artifacts: [], startedAt: now, finishedAt: now, failure: null };
    },
  }));
  service.configureDispatcher({ owner: `test-limits-2:${process.pid}`, config: { maxGlobal: 1, maxPerTarget: 1 } });
  const waiting = service.acceptAgentMessage(PERSON, { agentId: alpha.id, content: 'After restart', idempotencyKey: 'limit-restart' });
  await waiting.dispatched;
  assert(engine.getWorkRequest(waiting.accepted.requestId).state === 'queued' && types(waiting.accepted.requestId).at(-1) === 'dispatch_deferred', 'at the global limit the request stays queued (durable)');
  engine.transaction(() => {
    engine.transitionWorkRequest(holder, { from: 'running', to: 'cancelled', reason: 'test_cleanup' });
    outside.release(held.lease, 'cancelled');
  });
  service.configureDispatcher({ owner: `test-restarted:${process.pid}`, config: { maxGlobal: 1, maxPerTarget: 1 } });
  await service.recoverCoordinatorLoops();
  await service.waitForAgentDispatchIdle();
  dispatch.setAttemptAdapterOverride(null);
  assert(engine.getWorkRequest(waiting.accepted.requestId).state === 'completed', 'startup recovery drained the deferred request');
}

// ---------------------------------------------------------------------
async function normalFlowEvents() {
  console.log('\n[6] ordered engine events, normal flow');
  service.configureDispatcher({ owner: `test-normal:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });
  queueResults('DONE-normal');
  const accepted = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Normal flow', idempotencyKey: 'normal-1' });
  await accepted.dispatched;
  const id = accepted.accepted.requestId;
  const list = types(id);
  const expected = ['accepted', 'policy_selected', 'dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded', 'runtime_started', 'attempt_finished', 'state_changed', 'dispatch_released'];
  assert(list.join(',') === expected.join(','), `normal flow: ${list.join(',')}`);
  const intent = raw.prepare('SELECT * FROM attempt_launch_intents WHERE request_id = ?').get(id);
  const body = JSON.parse(intent.body);
  assert(intent && /^botmancers-(attempt|direct)-/.test(intent.idempotency_key) && intent.grant_fingerprint === null
    && body.agentId === codex.id && body.kind === 'start' && body.workspace === WORKROOT && body.authority === 'read_only'
    && body.requester && typeof body.requester.id === 'string',
  'launch intent is the replayable direct launch (key, workspace, authority) with no grant');
  assert(!intent.body.includes('SECRET') && !raw.prepare("SELECT 1 FROM engine_events WHERE request_id = ? AND data LIKE '%SECRET%'").get(id), 'no provider id is persisted in the intent or events');
  const view = service.getAgentRequest(PERSON, id);
  assert(view.events.map(e => e.type).join('>') === 'accepted>dispatched>runtime_started>completed', 'API request events keep the documented vocabulary');
}

// ---------------------------------------------------------------------
// Crash injection with real process death (SIGKILL). The fake provider is
// file-backed, so its turns outlive the killed Botmancers process and the
// restart child observes the same provider state.
async function crashChild() {
  const point = process.env.CRASH_POINT;
  const crashState = process.env.CRASH_STATE;
  const bot = bots.getById(process.env.CRASH_BOT);
  const inner = fake.createFakeSessionProvider({ statePath: crashState, kind: 'dispatch-crash' });
  // after_accept: die right after the provider accepts, before the
  // registry writes its row or the Attempt learns the run id.
  const provider = process.env.DISPATCH_SCENARIO === 'crash-launch' && point === 'after_accept'
    ? {
      ...inner,
      startSession: async input => {
        const out = await inner.startSession(input);
        if (out && out.ok) process.kill(process.pid, 'SIGKILL');
        return out;
      },
    }
    : inner;
  providerContract.registerSessionProvider({ connectionId: bot.runtime_connection_id }, () => provider);
  if (process.env.DISPATCH_SCENARIO === 'crash-launch') {
    service.configureDispatcher({ config: { maxGlobal: 10, maxPerTarget: 10 } });
    const kill = () => process.kill(process.pid, 'SIGKILL');
    if (point !== 'after_accept') jiti('../lib/dispatcher.ts').setDispatchFaultHook(at => { if (at === point) kill(); });
    const accepted = service.acceptAgentMessage(PERSON, { agentId: process.env.CRASH_BOT, content: `Crash ${point}`, idempotencyKey: `crash-${point}` });
    await accepted.dispatched;
    process.stdout.write('NOT-KILLED');
    return;
  }
  // Restart: a fresh process recovers from durable state only.
  service.configureDispatcher({ config: { maxGlobal: 10, maxPerTarget: 10 } });
  await service.recoverCoordinatorLoops();
  await service.waitForAgentDispatchIdle();
}

async function crashScenarios() {
  console.log('\n[7] crash injection: no lost request, no duplicate confirmed launch');
  for (const point of ['before_launch', 'after_accept', 'after_run_id_persisted', 'before_terminal_commit']) {
    const crashState = path.join(os.tmpdir(), `botmancers-dispatch-crash-${process.pid}-${point}.json`);
    fs.rmSync(crashState, { force: true });
    fake.mutateFakeProvider(crashState, state => { state.results = [`DONE crash ${point}`]; });
    const env = { CRASH_STATE: crashState, CRASH_BOT: codex.id };
    const turnsBefore = turnRows();
    const launch = await runChild({ ...env, DISPATCH_SCENARIO: 'crash-launch', CRASH_POINT: point });
    const request = one('SELECT * FROM work_requests WHERE idempotency_key = ?', `crash-${point}`);
    const crashedState = request && engine.getWorkRequest(request.id);
    const openAttempt = request && attemptsOf(request.id)[0];
    assert(launch.signal === 'SIGKILL' && crashedState && crashedState.state === 'running' && openAttempt && openAttempt.finished_at === null,
      `${point}: process killed with the request running and its Attempt open (${launch.signal || launch.code}${launch.err ? ` ${launch.err.slice(0, 200)}` : ''})`);
    if (!request) continue;
    const intent = one('SELECT * FROM attempt_launch_intents WHERE attempt_id = ?', openAttempt.id);
    assert(intent && intent.body && /^botmancers-(attempt|direct)-/.test(intent.idempotency_key), `${point}: Attempt and launch intent were durable before the adapter ran`);
    const launchedBeforeCrash = turnRows() - turnsBefore;
    const providerTurns = () => fake.fakeTurnIds(crashState).length;
    if (point === 'before_launch') assert(launchedBeforeCrash === 0 && providerTurns() === 0 && !openAttempt.external_run_id, 'before_launch: nothing launched, no run id');
    if (point === 'after_accept') assert(launchedBeforeCrash === 0 && providerTurns() === 1 && !openAttempt.external_run_id, 'after_accept: provider accepted the turn, the id was lost with the process');
    if (point === 'after_run_id_persisted' || point === 'before_terminal_commit') {
      assert(launchedBeforeCrash === 1 && openAttempt.external_run_id, `${point}: the confirmed run id was persisted immediately after acceptance`);
    }
    const restart = await runChild({ ...env, DISPATCH_SCENARIO: 'crash-restart' });
    assert(restart.code === 0, `${point}: restart process exited cleanly${restart.err ? ` (${restart.err.slice(0, 200)})` : ''}`);
    const after = engine.getWorkRequest(request.id);
    const attempts = attemptsOf(request.id);
    assert(after.state === 'completed' && attempts.length === 1 && attempts[0].outcome === 'succeeded', `${point}: request completed by its one Attempt (no lost request)`);
    assert(turnRows() - turnsBefore === 1 && providerTurns() === 1 && attempts[0].external_run_id,
      `${point}: exactly one provider turn (${turnRows() - turnsBefore} registry turns, ${providerTurns()} provider turns)`);
    assert(attempts[0].output === `DONE crash ${point}`, `${point}: the reply carries the scripted turn output`);
    assert(repliesOf(request.id).length === 1 && !leaseOf(request.id), `${point}: one reply, lease released`);
    const list = types(request.id);
    const takeover = eventData(request.id, 'dispatch_lease_taken_over')[0];
    assert(takeover && takeover.reason === 'owner_exited', `${point}: startup took over the exited process's lease (${takeover && takeover.reason})`);
    const expectedOrder = ['dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded'];
    if (point !== 'before_launch' && point !== 'after_accept') expectedOrder.push('runtime_started');
    expectedOrder.push('dispatch_lease_taken_over', 'reconcile_decided');
    if (point === 'before_launch' || point === 'after_accept') expectedOrder.push('runtime_started', 'reconcile_decided');
    expectedOrder.push('attempt_finished', 'state_changed', 'dispatch_released');
    assert(inOrder(list, expectedOrder), `${point}: ordered crash-recovery events (${list.join(',')})`);
    const decisions = eventData(request.id, 'reconcile_decided').map(d => `${d.phase}/${d.action}`).join(',');
    const expectedDecisions = point === 'before_launch' || point === 'after_accept' ? 'launch/repost,launch/reattach' : 'run/reattach';
    assert(decisions === expectedDecisions, `${point}: decisions ${decisions}`);
    fs.rmSync(crashState, { force: true });
  }
}

// ---------------------------------------------------------------------
async function main() {
  if (SCENARIO === 'race') return raceWorker();
  if (SCENARIO === 'crash-launch' || SCENARIO === 'crash-restart') return crashChild();

  console.log('NOT-469 leased dispatcher');
  WORKROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-dispatcher-work-'));
  STATE = path.join(os.tmpdir(), `botmancers-dispatcher-provider-${process.pid}.json`);
  fs.rmSync(STATE, { force: true });
  codex = botNamed('Dispatch Codex', { agent: 'codex' });
  db.bots.updateRegistration(codex.id, 'codex', {
    runtime_connection_id: db.runtimeConnections.ensureLocal('codex'),
    session_scope: { kind: 'workspaces', workspaces: [WORKROOT], sessions: [] },
    default_workspace: WORKROOT,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  codex = bots.getById(codex.id);
  hermes = botNamed('Dispatch Hermes', { agent: 'hermes' });
  providerContract.registerSessionProvider({ connectionId: codex.runtime_connection_id },
    () => fake.createFakeSessionProvider({ statePath: STATE, kind: 'dispatch-main' }));

  await raceScenario();
  decisionTable();
  await reconciliationScenarios();
  await fencingScenario();
  await launchFailureScenario();
  await staleWorkerScenario();
  await concurrencyScenario();
  await normalFlowEvents();
  await crashScenarios();

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
