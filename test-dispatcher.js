#!/usr/bin/env node
// NOT-469: leased dispatcher with restart reconciliation (lib/dispatcher,
// lib/agent-conversations).
//
// Proves, with deterministic fakes (no network, no agent-deck child):
//
// - competing worker processes on one database never hold the same lease
//   or create two Attempts for one claim, and race takeovers of expired
//   leases exactly once;
// - the accepted NOT-468 decision table, row by row;
// - startup and expired-lease reconciliation for running, completed,
//   failed, canceled, died, unknown, unauthorized, unreachable, and
//   no-run-id Attempts, never relaunching an ambiguous run;
// - global and per-target concurrency limits with controlled adapter
//   barriers, without losing queued work (also across a restart);
// - a worker whose lease was taken over cannot commit;
// - ordered engine events for normal and crash-recovery flows;
// - crash injection (SIGKILL) before launch, after launch acceptance,
//   after run-id persistence, and before the terminal commit: no lost
//   request and exactly one Agent Deck launch each.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
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
const db = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const deckApi = jiti('./lib/agent-deck-api.ts');
const deckAttempt = jiti('./lib/agent-deck-attempt.ts');
const executor = jiti('./lib/attempt-executor.ts');
const intake = jiti('./lib/conversation-intake.ts');
const lib = jiti('./lib/dispatcher.ts');
const { createFakeAgentDeck } = require('./test-support/fake-agent-deck-api.js');
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
  for (const id of order) {
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
  const targets = [0, 1, 2, 3].map(i => botNamed(`Race Target ${i}`, { agent: 'hermes', deck_id: 'deck-race' }));
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
  assert(config.maxGlobal === 7 && config.maxPerTarget === lib.DEFAULT_DISPATCH_CONFIG.maxPerTarget
    && config.leaseMs === lib.DEFAULT_DISPATCH_CONFIG.leaseMs && config.heartbeatMs === 250,
  'concurrency config: positive integers apply, invalid values fall back to deterministic defaults');
  const defaults = lib.dispatchConfigFromEnv({});
  assert(JSON.stringify(defaults) === JSON.stringify({ maxGlobal: 4, maxPerTarget: 1, leaseMs: 60000, heartbeatMs: 15000, deferMs: 5000 }), 'deterministic defaults: global 4, per target 1, lease 60s, heartbeat 15s, defer 5s');
}

// ---------------------------------------------------------------------
const DEAD_OWNER = 'dead-host.invalid:1:deadbeef';
let fake;
let codex;
let hermes;

// The durable state a worker leaves when it dies mid-dispatch, built
// from the real claim, Attempt, launch intent, and (optionally) the real
// Agent Deck start: only the crash itself is simulated.
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
    runId = (await deckApi.startAgentDeckRun(JSON.parse(intent.body), intent.idempotency_key)).runId;
  }
  if (options.forceRunId) runId = options.forceRunId;
  if (runId && options.persist !== false) engine.recordAttemptExternalIds(attempt.id, { externalRunId: runId });
  if (options.unleased) raw.prepare('DELETE FROM dispatch_leases WHERE request_id = ?').run(id);
  else raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  return { id, attemptId: attempt.id, runId };
}

const startPosts = () => fake.calls('POST', '/api/agent-runs').length;

async function reconciliationScenarios() {
  console.log('\n[3] reconciliation follows runtime evidence, never relaunching an ambiguous run');
  service.configureDispatcher({ owner: `test-main:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });

  // running: reattach, observe to terminal, complete once.
  fake.onStart = () => ({ result: 'DONE-running', hold: true });
  const running = await crashedAttempt('running', { post: true });
  const postsBefore = startPosts();
  const sweeping = service.sweepDispatch();
  await waitFor(() => fake.calls('GET', '/events').some(call => call.path.includes(running.runId)), 'reattached run observed');
  assert(engine.getWorkRequest(running.id).state === 'running' && attemptsOf(running.id)[0].finished_at === null, 'running: Attempt stays open while the run is live');
  fake.release(running.runId);
  await sweeping;
  let request = engine.getWorkRequest(running.id);
  let attempts = attemptsOf(running.id);
  assert(request.state === 'completed' && attempts.length === 1 && attempts[0].outcome === 'succeeded' && attempts[0].output === 'DONE-running', 'running: reattached and completed with the run output');
  assert(startPosts() === postsBefore && repliesOf(running.id).length === 1 && !leaseOf(running.id), 'running: no re-POST, one reply, lease released');
  assert(inOrder(types(running.id), ['dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded', 'dispatch_lease_taken_over', 'reconcile_decided', 'attempt_finished', 'state_changed', 'dispatch_released']),
    `running: ordered recovery events (${types(running.id).join(',')})`);
  assert(eventData(running.id, 'dispatch_lease_taken_over')[0].reason === 'lease_expired' && eventData(running.id, 'reconcile_decided')[0].action === 'reattach', 'running: takeover reason lease_expired, decision reattach');

  // completed (ended with a result).
  fake.onStart = () => ({ result: 'DONE-completed' });
  const completed = await crashedAttempt('completed', { post: true });
  await service.sweepDispatch();
  request = engine.getWorkRequest(completed.id);
  assert(request.state === 'completed' && attemptsOf(completed.id)[0].output === 'DONE-completed' && repliesOf(completed.id).length === 1, 'completed: reconciled succeeded with the recorded result, one reply');

  // failed (error).
  fake.onStart = () => ({ state: 'error' });
  const errored = await crashedAttempt('error', { post: true });
  await service.sweepDispatch();
  attempts = attemptsOf(errored.id);
  assert(engine.getWorkRequest(errored.id).state === 'failed' && attempts[0].outcome === 'failed' && attempts[0].error_category === 'runtime_failed', 'failed: an error run fails runtime_failed');

  // canceled.
  fake.onStart = () => ({ state: 'canceled' });
  const canceled = await crashedAttempt('canceled', { post: true });
  await service.sweepDispatch();
  assert(attemptsOf(canceled.id)[0].outcome === 'cancelled' && engine.getWorkRequest(canceled.id).state === 'failed', 'canceled: reconciled cancelled');

  // ended without a valid result.
  fake.onStart = () => ({ result: '' });
  const noResult = await crashedAttempt('no-result', { post: true });
  await service.sweepDispatch();
  assert(attemptsOf(noResult.id)[0].error_category === 'result_contract', 'ended without a valid result fails result_contract');

  // interrupted: a died run.
  fake.onStart = () => ({ hold: true });
  const died = await crashedAttempt('died', { post: true });
  fake.runs.get(died.runId).state = 'died';
  const diedPosts = startPosts();
  await service.sweepDispatch();
  attempts = attemptsOf(died.id);
  const diedAttention = attentionOf(died.id);
  assert(attempts.length === 1 && attempts[0].outcome === 'interrupted', 'died: the Attempt is terminal interrupted (not failed)');
  assert(diedAttention && diedAttention.reason === 'run_died' && engine.getWorkRequest(died.id).state === 'waiting', 'died: operator attention run_died, request waiting');
  assert(startPosts() === diedPosts && !leaseOf(died.id), 'died: no relaunch, lease released');
  await service.sweepDispatch();
  assert(attemptsOf(died.id).length === 1 && startPosts() === diedPosts && engine.getWorkRequest(died.id).state === 'waiting', 'died: a later sweep does nothing while the flag is set');
  const blockedClaim = service.currentDispatcher().recoverable().some(item => item.requestId === died.id);
  assert(!blockedClaim, 'died: the flagged request is not recoverable automation');

  // unknown run id (404 RUN_NOT_FOUND).
  const unknown = await crashedAttempt('unknown', { forceRunId: 'run-20261014T000000-missing' });
  const unknownPosts = startPosts();
  await service.sweepDispatch();
  attempts = attemptsOf(unknown.id);
  assert(attempts[0].finished_at === null && attentionOf(unknown.id)?.reason === 'run_not_found' && engine.getWorkRequest(unknown.id).state === 'waiting',
    'unknown: Attempt stays open with attention run_not_found');
  assert(startPosts() === unknownPosts, 'unknown: never relaunched');

  // unauthorized: the launching grant expired.
  fake.onStart = () => ({ result: 'DONE-grant' });
  const expired = await crashedAttempt('grant-expired', { post: true });
  process.env.AGENT_DECK_RUN_TOKEN = 'adg_rotated_or_revoked';
  await service.sweepDispatch();
  process.env.AGENT_DECK_RUN_TOKEN = fake.token;
  assert(attemptsOf(expired.id)[0].finished_at === null && attentionOf(expired.id)?.reason === 'grant_expired', 'unauthorized: Attempt open, attention grant_expired');

  // unreachable: defer, keep the slot, then complete once reachable.
  fake.onStart = () => ({ result: 'DONE-unreachable' });
  const unreachable = await crashedAttempt('unreachable', { post: true });
  deckApi.setAgentDeckApiFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  await service.sweepDispatch();
  deckApi.setAgentDeckApiFetch(fake.fetch);
  const deferredLease = leaseOf(unreachable.id);
  assert(deferredLease && deferredLease.owner === service.currentDispatcher().owner && attemptsOf(unreachable.id)[0].finished_at === null
    && engine.getWorkRequest(unreachable.id).state === 'running' && types(unreachable.id).includes('reconcile_deferred'),
  'unreachable: deferred, Attempt open, lease (and slot) kept by the reconciler');
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(unreachable.id);
  await service.sweepDispatch();
  assert(engine.getWorkRequest(unreachable.id).state === 'completed' && attemptsOf(unreachable.id).length === 1, 'unreachable: completed after Agent Deck returned');

  // No run id, the first POST never landed: re-POST launches once.
  fake.onStart = () => ({ result: 'DONE-before-launch' });
  const runsBefore = fake.runs.size;
  const unlaunched = await crashedAttempt('no-run-id', {});
  await service.sweepDispatch();
  assert(engine.getWorkRequest(unlaunched.id).state === 'completed' && fake.runs.size === runsBefore + 1 && attemptsOf(unlaunched.id)[0].external_run_id,
    'no run id (never sent): one same-key re-POST, one launch, completed');

  // No run id, the POST landed: same-key re-POST returns the same run.
  fake.onStart = () => ({ result: 'DONE-after-accept' });
  const accepted = await crashedAttempt('accepted-lost', { post: true, persist: false });
  const runsAfterAccept = fake.runs.size;
  await service.sweepDispatch();
  assert(engine.getWorkRequest(accepted.id).state === 'completed' && fake.runs.size === runsAfterAccept && attemptsOf(accepted.id)[0].external_run_id === accepted.runId,
    'no run id (accepted, id lost): re-POST returned the original run, no second launch');

  // No run id under a rotated grant: never POST (NOT-468 N5c).
  fake.onStart = () => ({ result: 'DONE-rotated' });
  const rotated = await crashedAttempt('rotated', { post: true, persist: false });
  const rotatedRuns = fake.runs.size;
  const rotatedPosts = startPosts();
  const previousToken = fake.token;
  fake.token = 'adg_rotated_grant_valid';
  process.env.AGENT_DECK_RUN_TOKEN = fake.token;
  await service.sweepDispatch();
  fake.token = previousToken;
  process.env.AGENT_DECK_RUN_TOKEN = previousToken;
  assert(startPosts() === rotatedPosts && fake.runs.size === rotatedRuns && attentionOf(rotated.id)?.reason === 'grant_mismatch' && attemptsOf(rotated.id)[0].finished_at === null,
    'no run id under another grant: no re-POST, attention grant_mismatch');

  // No run id, pre-launch rejection: fail launch_failed.
  fake.onStart = () => ({ startError: { status: 422, code: 'WORKSPACE_MISSING' } });
  const rejectedLaunch = await crashedAttempt('rejected', {});
  await service.sweepDispatch();
  attempts = attemptsOf(rejectedLaunch.id);
  assert(attempts[0].outcome === 'failed' && attempts[0].error_category === 'launch_failed' && engine.getWorkRequest(rejectedLaunch.id).state === 'failed' && !attentionOf(rejectedLaunch.id),
    'no run id, pre-launch rejection: failed launch_failed without attention');

  // Interrupted: a transport that cannot be observed after a restart.
  dispatch.setAttemptAdapterOverride(transport => transport === 'hermes-gateway'
    ? { name: 'hermes-gateway', run: async () => { throw new Error('must not relaunch'); } }
    : deckAttempt.createAgentDeckApiAttemptAdapter());
  const hermesCrash = await crashedAttempt('hermes', { bot: hermes });
  await service.sweepDispatch();
  dispatch.setAttemptAdapterOverride(null);
  attempts = attemptsOf(hermesCrash.id);
  request = engine.getWorkRequest(hermesCrash.id);
  assert(attempts.length === 1 && attempts[0].outcome === 'interrupted' && request.state === 'failed' && request.error_code === 'interrupted' && request.state_reason === 'retryable',
    'interrupted (unobservable transport): Attempt interrupted, request failed retryable, nothing relaunched');

  // Startup orphan: running with an open Attempt and no lease (NOT-468 F1).
  fake.onStart = () => ({ result: 'DONE-orphan' });
  const orphan = await crashedAttempt('orphan', { post: true, unleased: true });
  await service.recoverCoordinatorLoops();
  assert(engine.getWorkRequest(orphan.id).state === 'completed' && eventData(orphan.id, 'dispatch_lease_taken_over')[0].reason === 'unleased_running',
    'startup: an unleased running request is taken over and reconciled');

  // A lease that is still live is left alone.
  fake.onStart = () => ({ result: 'DONE-live', hold: true });
  const live = await crashedAttempt('live', { post: true });
  raw.prepare('UPDATE dispatch_leases SET expires_at = ? WHERE request_id = ?').run(Date.now() + 60_000, live.id);
  await service.sweepDispatch();
  assert(leaseOf(live.id).owner === DEAD_OWNER && !types(live.id).includes('dispatch_lease_taken_over'), 'a live lease of another worker is not taken over');
  fake.release(live.runId);
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(live.id);
  await service.sweepDispatch();
}

// ---------------------------------------------------------------------
async function fencingScenario() {
  console.log('\n[4] a worker whose lease was taken over cannot commit');
  service.configureDispatcher({ owner: `test-a:${process.pid}`, config: { maxGlobal: 50, maxPerTarget: 50 } });
  fake.onStart = () => ({ result: 'DONE-fenced', hold: true });
  const accepted = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Fenced work', idempotencyKey: 'fence-1' });
  const id = accepted.accepted.requestId;
  await waitFor(() => attemptsOf(id)[0]?.external_run_id, 'live run id persisted');
  const runId = attemptsOf(id)[0].external_run_id;
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  const other = lib.createDispatcher(raw, engine, { owner: `test-b:${process.pid}` });
  const taken = other.takeOver(other.recoverable().find(item => item.requestId === id));
  assert(!!taken, 'worker B took over the expired lease');
  fake.release(runId);
  await accepted.dispatched;
  assert(engine.getWorkRequest(id).state === 'running' && attemptsOf(id)[0].finished_at === null && repliesOf(id).length === 0,
    'worker A observed the end but its fenced commit wrote nothing');
  raw.prepare('UPDATE dispatch_leases SET expires_at = 0 WHERE request_id = ?').run(id);
  await service.sweepDispatch();
  assert(engine.getWorkRequest(id).state === 'completed' && repliesOf(id).length === 1 && attemptsOf(id).length === 1 && fake.calls('POST', '/api/agent-runs').filter(c => c.headers['idempotency-key'] === `botmancers-attempt-${attemptsOf(id)[0].id}`).length === 1,
    'the next owner reconciled it once: one reply, one Attempt, one launch');
}

// ---------------------------------------------------------------------
async function concurrencyScenario() {
  console.log('\n[5] global and per-target limits with adapter barriers');
  const alpha = botNamed('Limit Alpha', { agent: 'hermes', deck_id: 'deck-limit' });
  const beta = botNamed('Limit Beta', { agent: 'hermes', deck_id: 'deck-limit' });
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
  fake.onStart = () => ({ result: 'DONE-normal' });
  const accepted = service.acceptAgentMessage(PERSON, { agentId: codex.id, content: 'Normal flow', idempotencyKey: 'normal-1' });
  await accepted.dispatched;
  const id = accepted.accepted.requestId;
  const list = types(id);
  const expected = ['accepted', 'policy_selected', 'dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded', 'runtime_started', 'attempt_finished', 'state_changed', 'dispatch_released'];
  assert(list.join(',') === expected.join(','), `normal flow: ${list.join(',')}`);
  const intent = raw.prepare('SELECT * FROM attempt_launch_intents WHERE request_id = ?').get(id);
  const post = fake.calls('POST', '/api/agent-runs').find(call => call.headers['idempotency-key'] === intent.idempotency_key);
  assert(intent && post && JSON.stringify(post.body) === intent.body && intent.grant_fingerprint === deckApi.agentDeckGrantFingerprint(),
    'launch intent is exactly the body and key that were POSTed, with the grant fingerprint');
  assert(!intent.body.includes(fake.token) && !raw.prepare("SELECT 1 FROM engine_events WHERE data LIKE ?").get(`%${fake.token}%`), 'the grant token itself is never persisted');
  const view = service.getAgentRequest(PERSON, id);
  assert(view.events.map(e => e.type).join('>') === 'accepted>dispatched>runtime_started>completed', 'API request events keep the documented vocabulary');
}

// ---------------------------------------------------------------------
// Crash injection with real process death (SIGKILL). The fake Agent Deck
// runs in this process behind a loopback server, so its runs outlive the
// killed Botmancers process.
async function crashChild() {
  deckApi.setAgentDeckApiServerUrlForTests(process.env.CRASH_DECK_URL);
  deckAttempt.setAgentDeckApiPollIntervalForTests(5);
  const point = process.env.CRASH_POINT;
  if (process.env.DISPATCH_SCENARIO === 'crash-launch') {
    service.configureDispatcher({ config: { maxGlobal: 10, maxPerTarget: 10 } });
    const kill = () => process.kill(process.pid, 'SIGKILL');
    if (point === 'after_launch_accepted') {
      deckApi.setAgentDeckApiFetch(async (url, init) => {
        const response = await fetch(url, init);
        if (init.method === 'POST' && new URL(url).pathname === '/api/agent-runs') {
          await response.json();
          kill();
        }
        return response;
      });
    } else {
      jiti('./lib/dispatcher.ts').setDispatchFaultHook(at => { if (at === point) kill(); });
    }
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
  const crashFake = createFakeAgentDeck({ token: fake.token });
  crashFake.onStart = body => ({ result: `DONE ${body.prompt.slice(-30)}` });
  let url;
  try {
    url = await crashFake.listen();
  } catch (error) {
    assert(false, `loopback listen for the crash fake failed: ${error && error.message}`);
    return;
  }
  const env = { CRASH_DECK_URL: url, CRASH_BOT: codex.id, AGENT_DECK_RUN_TOKEN: fake.token };
  for (const point of ['before_launch', 'after_launch_accepted', 'after_run_id_persisted', 'before_terminal_commit']) {
    const runsBefore = crashFake.runs.size;
    const postsBefore = crashFake.calls('POST', '/api/agent-runs').length;
    const launch = await runChild({ ...env, DISPATCH_SCENARIO: 'crash-launch', CRASH_POINT: point });
    const request = one('SELECT * FROM work_requests WHERE idempotency_key = ?', `crash-${point}`);
    const crashedState = request && engine.getWorkRequest(request.id);
    const openAttempt = request && attemptsOf(request.id)[0];
    assert(launch.signal === 'SIGKILL' && crashedState && crashedState.state === 'running' && openAttempt && openAttempt.finished_at === null,
      `${point}: process killed with the request running and its Attempt open (${launch.signal || launch.code}${launch.err ? ` ${launch.err.slice(0, 200)}` : ''})`);
    if (!request) continue;
    const intent = one('SELECT * FROM attempt_launch_intents WHERE attempt_id = ?', openAttempt.id);
    assert(intent && intent.body && intent.idempotency_key === `botmancers-attempt-${openAttempt.id}`, `${point}: Attempt and launch intent were durable before the adapter ran`);
    const launchedBeforeCrash = crashFake.runs.size - runsBefore;
    if (point === 'before_launch') assert(launchedBeforeCrash === 0 && !openAttempt.external_run_id, 'before_launch: nothing launched, no run id');
    if (point === 'after_launch_accepted') assert(launchedBeforeCrash === 1 && !openAttempt.external_run_id, 'after_launch_accepted: Agent Deck accepted the run, the id was lost with the process');
    if (point === 'after_run_id_persisted' || point === 'before_terminal_commit') {
      assert(launchedBeforeCrash === 1 && openAttempt.external_run_id && crashFake.runs.has(openAttempt.external_run_id), `${point}: the confirmed run id was persisted immediately after acceptance`);
    }
    const restart = await runChild({ ...env, DISPATCH_SCENARIO: 'crash-restart' });
    assert(restart.code === 0, `${point}: restart process exited cleanly${restart.err ? ` (${restart.err.slice(0, 200)})` : ''}`);
    const after = engine.getWorkRequest(request.id);
    const attempts = attemptsOf(request.id);
    const posts = crashFake.calls('POST', '/api/agent-runs').length - postsBefore;
    assert(after.state === 'completed' && attempts.length === 1 && attempts[0].outcome === 'succeeded', `${point}: request completed by its one Attempt (no lost request)`);
    assert(crashFake.runs.size - runsBefore === 1 && attempts[0].external_run_id && crashFake.runs.has(attempts[0].external_run_id),
      `${point}: exactly one Agent Deck launch (${crashFake.runs.size - runsBefore} runs, ${posts} POSTs)`);
    assert(repliesOf(request.id).length === 1 && !leaseOf(request.id), `${point}: one reply, lease released`);
    const list = types(request.id);
    const takeover = eventData(request.id, 'dispatch_lease_taken_over')[0];
    assert(takeover && takeover.reason === 'owner_exited', `${point}: startup took over the exited process's lease (${takeover && takeover.reason})`);
    const expectedOrder = ['dispatch_claimed', 'state_changed', 'attempt_started', 'launch_intent_recorded'];
    if (point !== 'before_launch' && point !== 'after_launch_accepted') expectedOrder.push('runtime_started');
    expectedOrder.push('dispatch_lease_taken_over', 'reconcile_decided');
    if (point === 'before_launch' || point === 'after_launch_accepted') expectedOrder.push('runtime_started', 'reconcile_decided');
    expectedOrder.push('attempt_finished', 'state_changed', 'dispatch_released');
    assert(inOrder(list, expectedOrder), `${point}: ordered crash-recovery events (${list.join(',')})`);
    const decisions = eventData(request.id, 'reconcile_decided').map(d => `${d.phase}/${d.action}`).join(',');
    const expectedDecisions = point === 'before_launch' || point === 'after_launch_accepted' ? 'launch/repost,launch/reattach' : 'run/reattach';
    assert(decisions === expectedDecisions, `${point}: decisions ${decisions}`);
  }
  await crashFake.close();
}

// ---------------------------------------------------------------------
async function main() {
  if (SCENARIO === 'race') return raceWorker();
  if (SCENARIO === 'crash-launch' || SCENARIO === 'crash-restart') return crashChild();

  console.log('NOT-469 leased dispatcher');
  fake = createFakeAgentDeck({ token: 'adg_NOT_469_fixture_bearer_never_persist' });
  process.env.AGENT_DECK_RUN_TOKEN = fake.token;
  deckApi.setAgentDeckApiFetch(fake.fetch);
  deckAttempt.setAgentDeckApiPollIntervalForTests(5);
  codex = botNamed('Dispatch Codex', { agent: 'codex', deck_id: 'deck-dispatch' });
  hermes = botNamed('Dispatch Hermes', { agent: 'hermes', deck_id: 'deck-dispatch' });

  await raceScenario();
  decisionTable();
  await reconciliationScenarios();
  await fencingScenario();
  await concurrencyScenario();
  await normalFlowEvents();
  await crashScenarios();

  console.log(`\nTEST RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures} assertion(s))`}`);
  removeDb(DB_PATH);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
