#!/usr/bin/env node
// NOT-509: provider-reported session usage.
// Proves:
// - parser fixtures (lib/usage): Claude/Cursor result usage + total_cost_usd
//   in snake_case and camelCase, Codex turn.completed without cost,
//   Muse-normalized usage, explicit zero, malformed/unsupported data and
//   missing logs failing soft (null, never 0);
// - aggregation fixtures adapted from Agent Dealer's coverage cases: each
//   metric's nullable sum, known/total counts, complete|partial|unavailable;
// - persistence (usage_samples): one sample per Attempt/turn across
//   duplicate terminal results, late results, resume Attempts, partial
//   samples, explicit zero, and a restart (new connection) reconciling the
//   same Attempt; pre-launch failures write nothing;
// - the direct session-provider adapter end to end against the fake
//   session provider, and provider turns through the same fake, including
//   malformed usage that leaves the session result intact;
// - catalog summaries/details, owner routes, and the service API carry the
//   normalized summary under existing grants, never the raw breakdown;
// - Sessions UI helpers and source: compact totals, Partial / Not reported
//   language, $0.00 only for a reported zero, large-number formatting.
// Self-contained: isolated SQLite file, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const DB_PATH = path.join(os.tmpdir(), `botmancers-session-usage-${process.pid}.db`);
function removeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const usage = jiti('../lib/usage.ts');
const dbModule = jiti('../lib/db.ts');
const catalog = jiti('../lib/session-catalog.ts');
const executor = jiti('../lib/attempt-executor.ts');
const view = jiti('../lib/session-view.ts');
const { startRouteHost } = require('./support/acceptance/route-host');
const { EXPECTED, seedSessionUsage } = require('./support/session-usage-fixture');

const db = dbModule.default;
const { engine, bots, conversations } = dbModule;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const metric = (sum, known, total, quality) => ({ sum, known, total, quality });

function parserFixtures() {
  console.log('\nParser fixtures (lib/usage)');
  const claude = usage.usageFromEvent({
    type: 'result', subtype: 'success', total_cost_usd: 0.0421,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50, service_tier: 'standard' },
  });
  assert(claude.input_tokens === 1200 && claude.output_tokens === 340 && claude.cost_usd === 0.0421 && claude.source === 'result',
    'Claude result: snake_case usage plus total_cost_usd');
  assert(same(claude.breakdown, { cache_read_input_tokens: 9000, cache_creation_input_tokens: 50 }), 'breakdown keeps whitelisted numeric counters only (no text fields)');
  const cursor = usage.usageFromEvent({ type: 'result', totalCostUsd: 0.5, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3 } });
  assert(cursor.input_tokens === 10 && cursor.output_tokens === 20 && cursor.cost_usd === 0.5 && cursor.breakdown.cache_read_input_tokens === 3,
    'Cursor result: camelCase usage and totalCostUsd');
  const codex = usage.usageFromEvent({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 60, reasoning_output_tokens: 7 } });
  assert(codex.input_tokens === 500 && codex.output_tokens === 60 && codex.cost_usd === null && codex.source === 'codex.turn_completed',
    'Codex turn.completed: tokens, cost not reported (null, not 0)');
  const codexCost = usage.usageFromEvent({ type: 'turn.completed', usage: { input_tokens: 1 }, total_cost_usd: 9 });
  assert(codexCost.cost_usd === null, 'a Codex turn event never yields a cost');
  const muse = usage.usageFromEvent({ input_tokens: 7, output_tokens: 8, cost_usd: 0.01 });
  const museWrapped = usage.usageFromEvent({ type: 'usage', usage: { inputTokens: 7, outputTokens: 8, costUsd: 0.01 } });
  assert(muse.source === 'normalized' && muse.cost_usd === 0.01 && same(museWrapped && [museWrapped.input_tokens, museWrapped.output_tokens, museWrapped.cost_usd], [7, 8, 0.01]),
    'Muse-compatible normalized usage, bare or wrapped');
  const zero = usage.usageFromEvent({ type: 'result', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
  assert(zero.cost_usd === 0 && zero.input_tokens === 0 && zero.output_tokens === 0, 'an explicit provider zero stays 0');
  const costOnly = usage.usageFromEvent({ type: 'result', total_cost_usd: 1.25 });
  assert(costOnly.cost_usd === 1.25 && costOnly.input_tokens === null && costOnly.output_tokens === null, 'a result with cost and no usage: tokens unknown');
  const malformed = [
    { type: 'result', total_cost_usd: '0.42', usage: { input_tokens: '12', output_tokens: -1 } },
    { type: 'result', total_cost_usd: Number.NaN, usage: { input_tokens: 1.5, output_tokens: Infinity } },
    { type: 'result', usage: [1, 2] },
    { type: 'turn.completed', usage: null },
    { type: 'text', text: 'input_tokens: 100' },
    { type: 'tool', name: 'Read', usage: { input_tokens: 5 } },
    null, 'garbage', 42, [], { type: 'result', subtype: 'success', result: 'done' },
  ];
  assert(malformed.every(event => usage.usageFromEvent(event) === null), 'malformed values and unsupported events yield null (fail soft)');
  const halfBad = usage.usageFromEvent({ type: 'result', total_cost_usd: -3, usage: { input_tokens: 40, output_tokens: 'many' } });
  assert(halfBad.input_tokens === 40 && halfBad.output_tokens === null && halfBad.cost_usd === null, 'a bad value is unknown while good values survive');

  console.log('\nEvent streams and logs');
  assert(usage.usageFromEvents(null) === null && usage.usageFromEvents([]) === null, 'no events: null');
  assert(usage.usageFromJsonl(null) === null && usage.usageFromJsonl('') === null && usage.usageFromJsonl('\n\n') === null, 'missing or empty log: null');
  const turns = usage.usageFromEvents([
    { seq: 1, type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } },
    { seq: 2, type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
    { seq: 2, type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } },
  ]);
  assert(turns.input_tokens === 150 && turns.output_tokens === 15 && turns.cost_usd === null, 'Codex turns add up; a replayed event (same seq) counts once');
  const resultWins = usage.usageFromEvents([
    { seq: 1, type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } },
    { seq: 2, type: 'result', usage: { input_tokens: 90, output_tokens: 9 }, total_cost_usd: 0.2 },
    { seq: 3, type: 'result', usage: { input_tokens: 120, output_tokens: 12 }, total_cost_usd: 0.3 },
  ]);
  assert(resultWins.source === 'result' && resultWins.input_tokens === 120 && resultWins.cost_usd === 0.3, 'the last result event is cumulative and wins');
  const log = [
    '{"type":"thread.started","thread_id":"t-1"}',
    'not json at all',
    '{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":4}',
    '{"type":"turn.completed","usage":{"input_tokens":30,"output_tokens":4}}',
  ].join('\n');
  const fromLog = usage.usageFromJsonl(log);
  assert(fromLog.input_tokens === 30 && fromLog.output_tokens === 4, 'JSONL: unparseable lines are skipped, valid ones counted');
  assert(usage.usageFromJsonl('{"type":"text","text":"hi"}') === null, 'a log with no usage events: null');
  assert(usage.normalizeUsage({ input_tokens: -1, output_tokens: 'x', cost_usd: null }) === null
    && usage.normalizeUsage({ input_tokens: 5, breakdown: { cache_read_input_tokens: 2, model: 'gpt' } }).breakdown.model === undefined,
  'normalizeUsage drops bad values and non-whitelisted breakdown keys');
}

function aggregationFixtures() {
  console.log('\nAggregation fixtures (Agent Dealer coverage cases)');
  const s = (input_tokens, output_tokens, cost_usd) => ({ input_tokens, output_tokens, cost_usd });
  const cases = [
    ['no samples', [], { input_tokens: metric(null, 0, 0, 'unavailable'), output_tokens: metric(null, 0, 0, 'unavailable'), cost_usd: metric(null, 0, 0, 'unavailable') }],
    ['every sample reports everything', [s(10, 1, 0.1), s(20, 2, 0.2)],
      { input_tokens: metric(30, 2, 2, 'complete'), output_tokens: metric(3, 2, 2, 'complete'), cost_usd: metric(0.3, 2, 2, 'complete') }],
    ['token-only (Codex): cost unavailable', [s(10, 1, null), s(5, 1, null)],
      { input_tokens: metric(15, 2, 2, 'complete'), output_tokens: metric(2, 2, 2, 'complete'), cost_usd: metric(null, 0, 2, 'unavailable') }],
    ['mixed providers: cost partial', [s(10, 1, null), s(5, 1, 0.05)],
      { input_tokens: metric(15, 2, 2, 'complete'), output_tokens: metric(2, 2, 2, 'complete'), cost_usd: metric(0.05, 1, 2, 'partial') }],
    ['an interrupted run: every metric partial', [s(10, 1, 0.1), s(null, null, null)],
      { input_tokens: metric(10, 1, 2, 'partial'), output_tokens: metric(1, 1, 2, 'partial'), cost_usd: metric(0.1, 1, 2, 'partial') }],
    ['nothing reported: unavailable, sum null (not 0)', [s(null, null, null), s(null, null, null)],
      { input_tokens: metric(null, 0, 2, 'unavailable'), output_tokens: metric(null, 0, 2, 'unavailable'), cost_usd: metric(null, 0, 2, 'unavailable') }],
    ['explicit zero is known and complete', [s(0, 0, 0)],
      { input_tokens: metric(0, 1, 1, 'complete'), output_tokens: metric(0, 1, 1, 'complete'), cost_usd: metric(0, 1, 1, 'complete') }],
    ['metrics are independent', [s(10, null, null), s(null, 4, null), s(null, null, 0.5)],
      { input_tokens: metric(10, 1, 3, 'partial'), output_tokens: metric(4, 1, 3, 'partial'), cost_usd: metric(0.5, 1, 3, 'partial') }],
  ];
  for (const [label, samples, expected] of cases) assert(same(usage.aggregateUsage(samples), expected), label);
  const floats = usage.aggregateUsage([s(null, null, 0.1), s(null, null, 0.2)]);
  assert(floats.cost_usd.sum === 0.3, 'cost sums are rounded to micro-dollars (no 0.30000000000000004)');
}

const owner = { kind: 'person', id: 'local-owner' };
let keyN = 0;
function runningRequest(agent, kind = 'implementation', parent = null) {
  const conv = conversations.getByBotId(agent.id);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: `store-msg-${++keyN}`, requester: owner, targetAgentId: agent.id,
    intent: `Store case ${keyN}`, executionKind: kind, toolProfile: 'edit', idempotencyKey: `store-${keyN}`, parentRequestId: parent,
  });
  engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
  return request;
}
const completed = (usageValue, extra = {}) => ({
  status: 'completed', adapter: 'session-provider', externalRunId: `run-${++keyN}`, externalSessionId: null, output: 'ok', artifacts: [],
  startedAt: Date.now(), finishedAt: Date.now(), failure: null, usage: usageValue, ...extra,
});
const samplesOf = attemptId => db.prepare('SELECT * FROM usage_samples WHERE attempt_id = ?').all(attemptId);

function storeFixtures() {
  console.log('\nPersistence: one sample per Attempt (usage_samples)');
  const agent = bots.create({ name: 'Store', title: 'Implementer', description: 'Store cases', agent: 'claude' });
  const req = runningRequest(agent);
  const attempt = engine.createAttempt(req.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {} });
  const reported = completed({ input_tokens: 100, output_tokens: 20, cost_usd: 0.25, source: 'result' });
  const finished = engine.transaction(() => executor.recordAttemptResult(engine, attempt.id, reported));
  let rows = samplesOf(attempt.id);
  assert(rows.length === 1 && rows[0].sample_key === `attempt:${attempt.id}` && rows[0].input_tokens === 100 && rows[0].cost_usd === 0.25
    && rows[0].provider === 'claude' && rows[0].agent_id === agent.id, 'the terminal result writes one sample keyed by the Attempt');
  // A duplicate terminal result: the executor's late path (Attempt already
  // finished) and a repeated recordAttemptResult both keep one sample.
  executor.recordLateResult(engine, finished, reported);
  executor.recordLateResult(engine, finished, completed({ input_tokens: 999, output_tokens: 999, cost_usd: 99, source: 'result' }));
  let threw = null;
  try { engine.transaction(() => executor.recordAttemptResult(engine, attempt.id, reported)); } catch (error) { threw = error; }
  rows = samplesOf(attempt.id);
  assert(threw && threw.code === 'attempt_conflict', 'a second terminal record of the same Attempt is refused');
  assert(rows.length === 1 && rows[0].input_tokens === 100 && rows[0].output_tokens === 20 && rows[0].cost_usd === 0.25,
    'duplicate and conflicting late results never add or overwrite reported values');

  console.log('\nPartial samples fill, never add');
  const req2 = runningRequest(agent);
  const a2 = engine.createAttempt(req2.id, { kind: 'launch', adapter: 'codex', toolProfile: 'edit', launchSnapshot: {} });
  const fin2 = engine.transaction(() => executor.recordAttemptResult(engine, a2.id, completed({ input_tokens: 40, output_tokens: null, cost_usd: null, source: 'codex.turn_completed' })));
  executor.recordLateResult(engine, fin2, completed({ input_tokens: 41, output_tokens: 7, cost_usd: null, source: 'codex.turn_completed' }));
  rows = samplesOf(a2.id);
  assert(rows.length === 1 && rows[0].input_tokens === 40 && rows[0].output_tokens === 7 && rows[0].cost_usd === null,
    'a later report fills an unknown metric only; the reported one stays; cost stays unknown');

  console.log('\nExplicit zero and no-usage runs');
  const req3 = runningRequest(agent);
  const a3 = engine.createAttempt(req3.id, { kind: 'launch', adapter: 'cursor', toolProfile: 'edit', launchSnapshot: {} });
  engine.transaction(() => executor.recordAttemptResult(engine, a3.id, completed({ input_tokens: 0, output_tokens: 0, cost_usd: 0, source: 'result' })));
  rows = samplesOf(a3.id);
  assert(rows.length === 1 && rows[0].cost_usd === 0 && rows[0].input_tokens === 0, 'a reported zero is stored as 0, not NULL');
  const req4 = runningRequest(agent);
  const a4 = engine.createAttempt(req4.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {} });
  engine.transaction(() => executor.recordAttemptResult(engine, a4.id, completed(undefined)));
  rows = samplesOf(a4.id);
  assert(rows.length === 1 && rows[0].source === 'none' && rows[0].input_tokens === null && rows[0].cost_usd === null,
    'a run that reported nothing is one sample with every metric NULL (unknown)');
  const req5 = runningRequest(agent);
  const a5 = engine.createAttempt(req5.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {} });
  engine.transaction(() => executor.recordAttemptResult(engine, a5.id, {
    ...completed(undefined), status: 'failed', externalRunId: null, output: null, failure: { category: 'launch_failed', code: null, message: 'refused' },
  }));
  assert(samplesOf(a5.id).length === 0, 'a launch refused before any run existed writes no sample');

  console.log('\nCrash recovery: a restarted process reconciles the same Attempt');
  const req6 = runningRequest(agent);
  const a6 = engine.createAttempt(req6.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {} });
  engine.transaction(() => engine.recordAttemptUsage(a6.id, { usage: null, observedAt: Date.now() }));
  // The process died before finishing the Attempt. A new connection and
  // store (as after a restart) follow the run to its result.
  const Database = require('better-sqlite3');
  const restartedDb = new Database(DB_PATH);
  const store = jiti('../lib/engine-store.ts');
  store.migrateEngineSchema(restartedDb);
  const restarted = store.createEngineStore(restartedDb);
  const followed = completed({ input_tokens: 300, output_tokens: 30, cost_usd: 0.03, source: 'result' });
  restarted.transaction(() => executor.recordAttemptResult(restarted, a6.id, followed));
  executor.recordLateResult(restarted, restarted.getAttempt(a6.id), followed);
  restartedDb.close();
  rows = samplesOf(a6.id);
  assert(rows.length === 1 && rows[0].input_tokens === 300 && rows[0].cost_usd === 0.03 && engine.getAttempt(a6.id).outcome === 'succeeded',
    'the unknown sample written before the crash is filled by the reconciled result; still one sample');
  assert(store.ENGINE_SCHEMA_VERSION >= 18 && db.prepare("SELECT 1 FROM schema_migrations WHERE version = 18 AND name = 'usage_samples'").get(),
    'migration 18 (usage_samples) applied once');

  console.log('\nResume Attempts aggregate per session');
  const conv = conversations.getByBotId(agent.id);
  const binding = engine.bindSession({ agentId: agent.id, adapter: 'claude', externalSessionId: 'store-binding-SECRET', conversationId: conv.id, requestId: req.id, sourceAttemptId: attempt.id });
  const rev = runningRequest(agent, 'revision', req.id);
  const resume = engine.createAttempt(rev.id, { kind: 'resume', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {}, resumedSessionBindingId: binding.id });
  const resumeFinished = engine.transaction(() => executor.recordAttemptResult(engine, resume.id, completed({ input_tokens: 50, output_tokens: 5, cost_usd: 0.05, source: 'result' })));
  executor.recordLateResult(engine, resumeFinished, completed({ input_tokens: 50, output_tokens: 5, cost_usd: 0.05, source: 'result' }));
  const detail = catalog.getAgentSession(db, agent.id, binding.id);
  assert(same(detail.usage, {
    input_tokens: metric(150, 2, 2, 'complete'), output_tokens: metric(25, 2, 2, 'complete'), cost_usd: metric(0.3, 2, 2, 'complete'),
  }), 'launch + resume aggregate once each (a replayed resume result is not counted twice)');
  assert(detail.usage_samples.length === 2 && detail.usage_samples[0].turn_kind === 'launch' && detail.usage_samples[1].turn_kind === 'resume'
    && detail.usage_samples.every(sample => sample.kind === 'attempt' && !('breakdown' in sample) && !('sample_key' in sample)),
  'detail lists one usage entry per run, without keys or raw breakdown');

  console.log('\nDeletion takes the samples with their Attempts');
  const doomed = bots.create({ name: 'Doomed', title: 'x', description: 'x', agent: 'claude' });
  const dreq = runningRequest(doomed);
  const da = engine.createAttempt(dreq.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {} });
  engine.transaction(() => executor.recordAttemptResult(engine, da.id, completed({ input_tokens: 1, output_tokens: 1, cost_usd: 0, source: 'result' })));
  engine.transitionWorkRequest(dreq.id, { from: 'running', to: 'completed' });
  bots.removeMany([doomed.id]);
  assert(samplesOf(da.id).length === 0 && db.prepare('SELECT COUNT(*) AS n FROM usage_samples WHERE agent_id = ?').get(doomed.id).n === 0,
    'deleting an Agent deletes its usage samples');
}

async function adapterFixtures() {
  console.log('\nDirect adapter: usage from provider turns (fake session provider)');
  const spAttempt = jiti('../lib/session-provider-attempt.ts');
  const contract = jiti('../lib/session-provider.ts');
  const fake = require('./support/fake-session-provider');
  const statePath = path.join(os.tmpdir(), `botmancers-session-usage-adapter-${process.pid}.json`);
  fs.rmSync(statePath, { force: true });
  const connection = dbModule.runtimeConnections.create({ provider: 'claude', label: 'Usage direct', host: 'This computer' });
  contract.registerSessionProvider({ connectionId: connection.id }, () => fake.createFakeSessionProvider({ statePath }));
  const adapter = spAttempt.createSessionProviderAttemptAdapter();
  const agent = bots.create({
    name: 'Direct', title: 'Implementer', description: 'Adapter cases', agent: 'claude', runtime_connection_id: connection.id,
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify(['/tmp/usage-cwd']),
    policy_mode: 'workspace_write', allow_new_sessions: 1, allow_resume_with_edits: 1,
  });
  async function launch(scriptedUsage) {
    fake.mutateFakeProvider(statePath, state => { state.usageQueue = [scriptedUsage]; });
    const req = runningRequest(agent);
    const prepared = executor.beginAttempt(engine, req.id, {
      agent: 'claude', adapter,
      input: {
        target: { agentId: agent.id, agent: 'claude' }, prompt: { kind: 'text', text: 'work' }, cwd: '/tmp/usage-cwd',
        toolProfile: 'edit', sessionBinding: null, correlation: {},
      },
    });
    const ran = await executor.runAttempt(engine, prepared, adapter);
    return { ran, rows: samplesOf(prepared.attempt.id) };
  }
  const claudeRun = await launch({ input_tokens: 2048, output_tokens: 512, total_cost_usd: 0.0731 });
  assert(claudeRun.ran.result.status === 'completed' && claudeRun.rows.length === 1 && claudeRun.rows[0].input_tokens === 2048
    && claudeRun.rows[0].output_tokens === 512 && claudeRun.rows[0].cost_usd === 0.0731 && claudeRun.rows[0].source === 'normalized',
  'Claude: reported usage and total_cost_usd recorded as the Attempt\'s sample');
  const codexRun = await launch({ input_tokens: 800, output_tokens: 90 });
  assert(codexRun.ran.result.status === 'completed' && codexRun.rows.length === 1 && codexRun.rows[0].input_tokens === 800
    && codexRun.rows[0].cost_usd === null && codexRun.rows[0].source === 'normalized', 'Codex: reported tokens, cost unknown (null, never estimated)');
  const cursorRun = await launch({ input_tokens: 64, output_tokens: 8, total_cost_usd: 0 });
  assert(cursorRun.rows[0].cost_usd === 0 && cursorRun.rows[0].input_tokens === 64, 'an explicit $0 cost is stored as 0, not NULL');
  const bad = await launch({ type: 'result', total_cost_usd: 'lots', usage: { input_tokens: 'many', output_tokens: -4 } });
  assert(bad.ran.result.status === 'completed' && /work/.test(bad.ran.result.output) && bad.rows.length === 1 && bad.rows[0].source === 'none'
    && bad.rows[0].input_tokens === null && bad.rows[0].cost_usd === null, 'malformed usage fails soft: the result stands, usage unknown');
  const none = await launch(null);
  assert(none.ran.result.status === 'completed' && none.rows.length === 1 && none.rows[0].source === 'none', 'no usage reported: one unknown sample');
  contract.clearSessionProviders({ builtins: true });
  fs.rmSync(statePath, { force: true });
}

async function providerTurnFixtures() {
  console.log('\nProvider turns (fake session provider)');
  const contract = jiti('../lib/session-provider.ts');
  const ps = jiti('../lib/provider-sessions.ts');
  const fake = require('./support/fake-session-provider');
  const statePath = path.join(os.tmpdir(), `botmancers-session-usage-provider-${process.pid}.json`);
  fs.rmSync(statePath, { force: true });
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Usage native', host: 'This computer' });
  contract.registerSessionProvider({ connectionId: connection.id }, () => fake.createFakeSessionProvider({ statePath }));
  const nat = bots.create({
    name: 'NativeUsage', title: 'Implementer', description: 'Native usage', agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  fake.seedFakeProvider(statePath, [{ id: 'prov-usage-SECRET', title: 'Native usage session', workspace: '/work/u', resumable: true }]);
  await ps.syncAgentSessions(db, nat.id, {});
  const ref = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ?').get(nat.id).id;
  fake.mutateFakeProvider(statePath, state => {
    state.usageQueue = [
      { input_tokens: 11, output_tokens: 3, cost_usd: 0.002 },
      { type: 'turn.completed', usage: { input_tokens: 21, output_tokens: 4 } },
      { input_tokens: 'NaN', cost_usd: {} },
    ];
  });
  const send = async key => {
    const sent = await ps.sendProviderTurn(db, nat.id, ref, { prompt: `turn ${key}`, authority: 'read_only', idempotencyKey: key, requester: owner });
    return ps.observeProviderTurn(db, nat.id, sent.turn.turn_ref);
  };
  const t1 = await send('u-1');
  await ps.observeProviderTurn(db, nat.id, t1.turn_ref);
  await send('u-2');
  const t3 = await send('u-3');
  assert(t3.state === 'completed', 'a turn with malformed usage still completes');
  const replay = await ps.sendProviderTurn(db, nat.id, ref, { prompt: 'turn u-1', authority: 'read_only', idempotencyKey: 'u-1', requester: owner });
  assert(replay.replayed === true, 'an idempotent replay of a turn returns the original');
  const turnRows = db.prepare('SELECT * FROM usage_samples WHERE session_ref = ? ORDER BY observed_at, sample_key').all(ref);
  assert(turnRows.length === 3 && turnRows.every(row => row.sample_key.startsWith('turn:') && row.provider === 'fake-direct'),
    'one sample per provider turn; re-observing and replaying add none');
  const detail = catalog.getAgentSession(db, nat.id, ref);
  assert(same(detail.usage, {
    input_tokens: metric(32, 2, 3, 'partial'), output_tokens: metric(7, 2, 3, 'partial'), cost_usd: metric(0.002, 1, 3, 'partial'),
  }), 'a native session aggregates its turns: normalized, Codex-shaped, and malformed (unknown)');
  assert(detail.usage_samples.length === 3 && detail.usage_samples.every(sample => sample.kind === 'turn' && sample.attempt_number === null && sample.turn_kind === 'send'),
    'native detail lists provider turns');
  assert(!/SECRET/.test(JSON.stringify(detail)), 'no provider id in the usage detail');
  contract.clearSessionProviders({ builtins: true });
  fs.rmSync(statePath, { force: true });
}

async function catalogFixtures() {
  console.log('\nCatalog, owner routes, and service API');
  const fixture = seedSessionUsage(dbModule, executor);
  const { agent, sessions } = fixture;
  const rows = Object.fromEntries(catalog.listAgentSessions(db, agent.id, 'all').map(row => [row.ref, row]));
  const claude = rows[sessions.claude.id].usage;
  assert(claude.input_tokens.sum === EXPECTED.claude.input && claude.output_tokens.sum === EXPECTED.claude.output && claude.cost_usd.sum === EXPECTED.claude.cost
    && claude.cost_usd.quality === 'complete' && claude.cost_usd.total === 2, 'Claude session: complete tokens and cost over launch + resume');
  const codex = rows[sessions.codex.id].usage;
  assert(codex.input_tokens.sum === EXPECTED.codex.input && codex.input_tokens.quality === 'complete'
    && codex.cost_usd.sum === null && codex.cost_usd.quality === 'unavailable' && codex.cost_usd.total === 1, 'Codex session: token-only, cost unavailable (null)');
  const partial = rows[sessions.partial.id].usage;
  assert(same(partial.input_tokens, metric(EXPECTED.partial.input, 1, 2, 'partial')) && same(partial.cost_usd, metric(null, 0, 2, 'unavailable')),
    'partial session: one run reported tokens, an interrupted run did not');
  assert(same(rows[sessions.zero.id].usage.cost_usd, metric(0, 1, 1, 'complete')), 'zero session: a reported $0 is a complete 0');
  assert(same(rows[sessions.legacy.id].usage.cost_usd, metric(null, 0, 0, 'unavailable')), 'a session from before usage was recorded: unavailable');

  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const list = await host.owner('GET', `/api/bots/${agent.id}/sessions`);
    const byRef = Object.fromEntries(list.json.sessions.map(row => [row.ref, row]));
    assert(list.status === 200 && same(byRef[sessions.claude.id].usage, claude) && same(byRef[sessions.codex.id].usage, codex),
      'GET /api/bots/:id/sessions rows carry the same usage summary');
    assert(!/breakdown|cache_read|cached_input|SECRET/.test(list.text), 'owner list JSON has no raw breakdown or provider id');
    const one = await host.owner('GET', `/api/bots/${agent.id}/sessions/${sessions.partial.id}`);
    assert(one.status === 200 && one.json.session.usage_samples.length === 2 && one.json.session.usage_samples[1].input_tokens === null
      && one.json.session.usage_samples[1].turn_kind === 'resume', 'GET /api/bots/:id/sessions/:ref lists per-run usage, the unknown run as null');
  } finally {
    await host.close();
  }

  const serviceApi = jiti('../lib/service-api.ts');
  const granted = serviceApi.serviceContext({ kind: 'service', id: 'svc-usage' });
  const page = serviceApi.listServiceSessions(granted, agent.id, { cursor: null, limit: 10, status: 'all' });
  const serviceRow = page.items.find(item => item.ref === sessions.claude.id);
  assert(same(serviceRow.usage, claude) && page.items.every(item => item.usage && !('context' in item)), 'service list carries the usage summary, still without launch context');
  const serviceDetail = serviceApi.getServiceSession(granted, agent.id, sessions.claude.id);
  assert(serviceDetail.usage_samples.length === 2 && serviceDetail.usage_samples[0].cost_usd === 0.4213 && !/breakdown|cache_read|SECRET/.test(JSON.stringify(serviceDetail)),
    'service detail carries per-run usage, no breakdown or provider id');
  // NOT-556: no grants; an engine-internal principal still reaches no Agent.
  const internal = serviceApi.serviceContext({ kind: 'service', id: 'botmancers-engine' });
  let refused = null;
  try { serviceApi.getServiceSession(internal, agent.id, sessions.claude.id); } catch (error) { refused = error; }
  assert(refused && refused.code === 'agent_not_found', 'an engine-internal principal cannot read session usage');
  return fixture;
}

function uiFixtures(fixture) {
  console.log('\nSessions UI helpers');
  const rows = Object.fromEntries(catalog.listAgentSessions(db, fixture.agent.id, 'all').map(row => [row.ref, row]));
  const line = ref => view.sessionUsageLine(rows[ref].usage);
  const claude = line(fixture.sessions.claude.id);
  assert(claude.text === '1.2M in · 45.7k out · $3.34' && claude.quality === 'complete' && !claude.partial, `complete: "${claude.text}"`);
  assert(/Input tokens: 1,203,456, reported by all 2 runs/.test(claude.label) && /Cost: \$3\.34/.test(claude.label), 'accessible label spells out exact values');
  const codex = line(fixture.sessions.codex.id);
  assert(codex.text === '52.3k in · 7.9k out · cost not reported' && !/\$/.test(codex.text) && codex.quality === 'partial' && !codex.partial,
    `token-only: "${codex.text}" (no dollar value)`);
  const partial = line(fixture.sessions.partial.id);
  assert(partial.text === '9.9k in · 1.2k out · cost not reported' && partial.partial && /at least 9,876, partial, reported by 1 of 2 runs/.test(partial.label),
    `partial: "${partial.text}" with a Partial tag and coverage in the label`);
  const zero = line(fixture.sessions.zero.id);
  assert(zero.text === '640 in · 128 out · $0.00', `explicit zero: "${zero.text}"`);
  const legacy = line(fixture.sessions.legacy.id);
  assert(legacy.text === 'Not reported' && legacy.label === 'Usage: not reported' && view.sessionUsageLine(undefined).text === 'Not reported',
    'unavailable (or a row from an older server): "Not reported", never $0.00');
  assert(view.formatTokenCount(0) === '0' && view.formatTokenCount(999) === '999' && view.formatTokenCount(1000) === '1k' && view.formatTokenCount(12_345) === '12.3k'
    && view.formatTokenCount(999_999) === '1M' && view.formatTokenCount(1_250_000) === '1.3M' && view.formatTokenCount(7_300_000_000) === '7.3B',
  'large-number token formatting');
  assert(view.formatUsd(0) === '$0.00' && view.formatUsd(0.0042) === '$0.0042' && view.formatUsd(0.00001) === '<$0.0001'
    && view.formatUsd(0.4213) === '$0.42' && view.formatUsd(12345.678) === '$12,345.68', 'cost formatting: a small cost never rounds to $0.00');
  const unknownMetric = view.usageMetricView('cost_usd', { sum: null, known: 0, total: 2, quality: 'unavailable' }, true);
  assert(unknownMetric.text === 'Not reported' && unknownMetric.coverage === '0 of 2 runs reported', 'detail coverage for an unreported metric');
  const partialMetric = view.usageMetricView('input_tokens', rows[fixture.sessions.partial.id].usage.input_tokens, true);
  assert(partialMetric.text === '9,876' && partialMetric.coverage === 'Partial: 1 of 2 runs reported', 'detail coverage for a partial metric');
  const values = view.usageSampleValues({ kind: 'attempt', attempt_number: 1, turn_kind: 'resume', provider: 'codex', source: 'none', input_tokens: null, output_tokens: 0, cost_usd: null, observed_at: 0 });
  assert(view.usageSampleLabel({ kind: 'attempt', turn_kind: 'resume' }, 1) === 'Run 2 · resumed'
    && view.usageSampleLabel({ kind: 'turn', turn_kind: 'send' }, 0) === 'Run 1 · provider turn', 'runs are numbered within the session');
  assert(values.input === 'Not reported' && values.output === '0' && values.cost === 'Not reported', 'per-run values: unknown vs reported zero');

  console.log('\nSessions UI source contract');
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const panel = read('app/components/SessionsPanel.tsx');
  const css = read('app/globals.css');
  assert(/<dt>Reported usage<\/dt>/.test(panel) && /sessionUsageLine\(row\.usage\)/.test(panel), 'each row shows compact reported usage');
  assert(/session-usage-tag">Partial</.test(panel) && /className="session-sr">\{usage\.label\}/.test(panel) && /aria-hidden="true">\{usage\.text\}/.test(panel),
    'Partial tag and an accessible full label for the compact total');
  assert(/<SessionUsageDetail /.test(panel) && /aria-label="Reported usage by run"/.test(panel) && /usage_samples/.test(panel), 'details list usage per run');
  assert(/No run in this session reported usage\./.test(panel), 'details say when nothing was reported');
  const panelCode = panel.split('\n').filter(codeLine => !codeLine.trim().startsWith('//')).join('\n');
  assert(!/toFixed\(|price|pricing|estimate/i.test(panelCode), 'the panel formats nothing itself and never estimates');
  assert(/\.session-usage-runs li \{[\s\S]*?flex-wrap: wrap/.test(css) && /\.session-usage-totals dd \{[\s\S]*?flex-wrap: wrap/.test(css),
    'usage rows wrap at narrow widths instead of overflowing');
  const docs = read('docs/session-usage.md');
  assert(/# Session usage/.test(docs) && /usage_samples/.test(docs) && /never\s+estimated/i.test(docs), 'docs/session-usage.md documents session usage');
}

async function main() {
  parserFixtures();
  aggregationFixtures();
  storeFixtures();
  await adapterFixtures();
  await providerTurnFixtures();
  const fixture = await catalogFixtures();
  uiFixtures(fixture);
  removeDb();
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session usage checks passed.');
}

main().catch(error => {
  console.error(error);
  removeDb();
  process.exit(1);
});
