#!/usr/bin/env node
// NOT-467 (NOT-543 cutover): one single-Attempt adapter contract for the
// Hermes gateway and the direct session provider. Proves: both adapters
// accept the same AttemptInput fixture and return the same normalized
// AttemptResult shape; direct launches carry the explicit tool profile
// (readonly, edit) and resume the opaque session binding verbatim,
// independent of the Agent type; unsupported authority fails closed
// before launch; cancellation and deadlines are normalized; the executor
// persists the Attempt before launch and records adapter, launch
// snapshot, run/session ids, timestamps, outcome, failure category,
// output, and artifact references; and neither the adapters nor the
// executor write conversation messages.
//
// Self-contained: isolated SQLite file, a fake session provider behind
// the registry and a stub at the Hermes gateway fetch boundary. No
// network, no real runs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-attempt-adapter-test-${process.pid}.db`);
const STATE_PATH = path.join(os.tmpdir(), `botmancers-attempt-adapter-provider-${process.pid}.json`);
function removeAll() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
  try { fs.rmSync(STATE_PATH, { force: true }); } catch { /* fresh start */ }
}
removeAll();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
const HERMES_KEY = 'hermes-secret-key-must-not-leak';
process.env.HERMES_API_SERVER_KEY = HERMES_KEY;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': require('./support/repo-root') } });
const directAttempt = jiti('../lib/session-provider-attempt.ts');
const hermesAttempt = jiti('../lib/hermes-attempt.ts');
const contract = jiti('../lib/attempt-adapter.ts');
const executor = jiti('../lib/attempt-executor.ts');
const dispatch = jiti('../lib/agent-dispatch.ts');
const dbModule = jiti('../lib/db.ts');
const providerContract = jiti('../lib/session-provider.ts');
const fake = require('./support/fake-session-provider');
const { bots, conversations, engine } = dbModule;
const sqlite = dbModule.default;

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}

// Negative spy: every conversation message write path is counted.
let messageCreates = 0;
const originalCreate = dbModule.messages.create;
dbModule.messages.create = (...args) => { messageCreates++; return originalCreate.apply(dbModule.messages, args); };
const messageRows = () => sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

// Fake Hermes gateway boundary. `hermesPlan` shapes the next reply.
const hermesCalls = [];
let hermesPlan = {};
const hermesFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  hermesCalls.push({ url, session: init.headers['X-Hermes-Session-Id'], messages: body.messages });
  if (hermesPlan.status && hermesPlan.status !== 200) {
    return new Response(JSON.stringify({ error: { message: `bad key ${HERMES_KEY} at ${url}` } }), { status: hermesPlan.status });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: hermesPlan.content } }] }), { status: 200 });
};
const hermesAdapter = hermesAttempt.createHermesAttemptAdapter({ fetchImpl: hermesFetch });
const directAdapter = directAttempt.createSessionProviderAttemptAdapter();

// One equivalent fixture for both adapters; only the target differs.
function fixture(overrides = {}) {
  return {
    target: { agentId: 'agent-1', agent: 'codex' },
    prompt: {
      kind: 'conversation',
      system: 'You are Dev.\nExplains code.',
      history: [{ speakerLabel: 'person:owner', fromAgent: false, content: 'Explain lib/db.ts' }],
    },
    cwd: '/repo/checkout',
    toolProfile: 'readonly',
    sessionBinding: null,
    correlation: { requestId: 'req-1', conversationId: 'conv-1' },
    ...overrides,
  };
}
const RESULT_KEYS = ['adapter', 'artifacts', 'externalRunId', 'externalSessionId', 'failure', 'finishedAt', 'output', 'startedAt', 'status'];
const keysOf = value => Object.keys(value).sort().join(',');

async function main() {
  const agentRow = bots.create({
    name: 'Dev', title: '', description: 'Codes.', agent: 'codex',
    runtime_connection_id: dbModule.runtimeConnections.ensureLocal('codex'),
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify(['/repo/checkout']),
    policy_mode: 'workspace_write', allow_new_sessions: 1, allow_resume_with_edits: 1,
  });
  const hermesRow = bots.create({ name: 'Hermy', title: '', description: 'Talks.', agent: 'hermes' });
  providerContract.registerSessionProvider(
    { connectionId: agentRow.runtime_connection_id },
    () => fake.createFakeSessionProvider({ statePath: STATE_PATH, kind: 'attempt-contract' }),
  );
  const directFixture = (overrides = {}) => fixture({ target: { agentId: agentRow.id, agent: 'codex' }, ...overrides });
  const hermesFixture = (overrides = {}) => fixture({ target: { agentId: hermesRow.id, agent: 'hermes' }, cwd: null, ...overrides });

  console.log('\nShared contract: equivalent fixtures, equivalent results');
  assert(typeof hermesAdapter.run === 'function' && hermesAdapter.name === 'hermes-gateway', 'Hermes implements AttemptAdapter (name + run)');
  assert(typeof directAdapter.run === 'function' && directAdapter.name === 'session-provider', 'direct implements AttemptAdapter (name + run)');
  assert(Object.keys(dispatch.ATTEMPT_ADAPTERS).sort().join(',') === 'hermes-gateway,session-provider', 'transport map selects one contract adapter per transport (type-checked Record<AgentTransport, () => AttemptAdapter>)');

  const messagesBefore = messageRows();
  hermesPlan = { content: 'db.ts opens SQLite.' };
  const hermesEvents = [];
  const hermesOk = await hermesAdapter.run(contract.freezeAttemptInput(hermesFixture()), e => hermesEvents.push(e));
  const directEvents = [];
  const directOk = await directAdapter.run(contract.freezeAttemptInput(directFixture({ correlation: { requestId: 'req-1', conversationId: 'conv-1', attemptId: 'att-shape' } })), e => directEvents.push(e));
  assert(keysOf(hermesOk) === RESULT_KEYS.join(','), `Hermes carries the normalized fields (${keysOf(hermesOk)})`);
  assert(keysOf(directOk) === RESULT_KEYS.join(',') || keysOf(directOk) === [...RESULT_KEYS, 'usage'].sort().join(','), `direct carries the normalized fields plus its reported usage (${keysOf(directOk)})`);
  assert(hermesOk.status === 'completed' && directOk.status === 'completed', 'both complete for the same fixture');
  assert(hermesOk.failure === null && directOk.failure === null, 'completed results carry no failure');
  assert(hermesEvents.length === 1 && hermesEvents[0].type === 'started' && directEvents.length === 1 && directEvents[0].type === 'started', 'each adapter emits exactly one started event before its terminal result');
  assert(directEvents[0].externalRunId === directOk.externalRunId && directOk.externalRunId && directOk.externalSessionId, 'direct reports its opaque turn and session refs');
  assert(directOk.artifacts.length === 0, 'direct exposes no artifact paths');
  assert(hermesOk.externalRunId === null && hermesOk.externalSessionId === `botmancer-specialist-${hermesRow.id}`, 'Hermes reports its gateway session id and no run id');
  assert(hermesOk.startedAt <= hermesOk.finishedAt && directOk.startedAt <= directOk.finishedAt, 'both results carry ordered timestamps');
  assert(/Explain lib\/db\.ts/.test(directOk.output ?? ''), 'direct renders the conversation prompt as its turn');
  assert(hermesCalls[0].messages[0].role === 'system' && hermesCalls[0].messages[1].content === '[From person:owner] Explain lib/db.ts', 'Hermes renders the same conversation prompt as gateway chat messages');

  hermesPlan = { status: 401 };
  const hermesBad = await hermesAdapter.run(hermesFixture());
  assert(hermesBad.status === 'failed' && keysOf(hermesBad) === keysOf(hermesOk), 'Hermes fails with the same normalized result shape');
  assert(hermesBad.failure.category === 'runtime_failed' && hermesBad.failure.code === 'http', 'gateway failures carry the stable runtime_failed category');
  assert(!hermesBad.failure.message.includes(HERMES_KEY) && !hermesBad.failure.message.includes('127.0.0.1'), 'Hermes failure provenance excludes gateway error bodies (no key or endpoint)');
  assert(messageRows() === messagesBefore && messageCreates === 0, 'adapters wrote no conversation messages');

  console.log('\nExplicit tool authority and opaque session binding');
  const roResult = await directAdapter.run(directFixture({ correlation: { attemptId: 'att-auth-ro' } }));
  const editResult = await directAdapter.run(directFixture({ toolProfile: 'edit', prompt: { kind: 'text', text: 'Implement X' }, correlation: { attemptId: 'att-auth-edit' } }));
  const roRow = sqlite.prepare('SELECT authority, kind FROM provider_session_turns WHERE id = ?').get(roResult.externalRunId);
  const editRow = sqlite.prepare('SELECT authority, kind FROM provider_session_turns WHERE id = ?').get(editResult.externalRunId);
  assert(roRow.authority === 'read_only' && roRow.kind === 'start', 'readonly input runs a start turn with read_only authority');
  assert(editRow.authority === 'workspace_write' && editRow.kind === 'start' && /Implement X/.test(editResult.output ?? ''), 'edit input runs a start turn with workspace_write authority and the text prompt verbatim');
  const resumed = await directAdapter.run(directFixture({
    toolProfile: 'edit', prompt: { kind: 'text', text: 'Address review' },
    sessionBinding: { bindingId: 'b-1', externalSessionId: editResult.externalSessionId },
    correlation: { attemptId: 'att-auth-resume' },
  }));
  const resumeRow = sqlite.prepare('SELECT authority, kind FROM provider_session_turns WHERE id = ?').get(resumed.externalRunId);
  assert(resumeRow.kind === 'send' && resumeRow.authority === 'workspace_write', 'resume input sends with the explicit profile');
  assert(resumed.status === 'completed' && resumed.externalSessionId === editResult.externalSessionId, 'the bound session ref is resumed verbatim');

  const providerCallsBefore = fake.providerCalls(STATE_PATH);
  const hermesBefore = hermesCalls.length;
  const noProfile = await directAdapter.run(directFixture({ toolProfile: undefined, correlation: { attemptId: 'att-auth-none' } }));
  const badProfile = await directAdapter.run(directFixture({ toolProfile: 'admin', correlation: { attemptId: 'att-auth-bad' } }));
  const hermesEdit = await hermesAdapter.run(hermesFixture({ toolProfile: 'edit' }));
  assert(noProfile.failure.category === 'unsupported_authority' && badProfile.failure.category === 'unsupported_authority', 'direct rejects a missing or unknown tool profile (no default)');
  assert(hermesEdit.failure.category === 'unsupported_authority', 'Hermes rejects edit authority it cannot honor');
  assert(fake.providerCalls(STATE_PATH) === providerCallsBefore && hermesCalls.length === hermesBefore, 'unsupported authority launches nothing');
  hermesPlan = { content: 'bound' };
  const OPAQUE = 'ses:opaque/../ID with spaces+%2F🙂';
  await hermesAdapter.run(hermesFixture({ sessionBinding: { bindingId: 'b-1', externalSessionId: OPAQUE } }));
  assert(hermesCalls[hermesCalls.length - 1].session === OPAQUE, 'Hermes passes a bound opaque session id verbatim to the gateway');

  console.log('\nCancellation and deadline');
  const aborted = new AbortController();
  aborted.abort();
  const preCancelled = await directAdapter.run(directFixture({ signal: aborted.signal, correlation: { attemptId: 'att-pre-cancelled' } }));
  const preExpired = await hermesAdapter.run(hermesFixture({ deadlineAt: Date.now() - 1 }));
  assert(preCancelled.failure.category === 'cancelled' && preExpired.failure.category === 'timed_out' && fake.providerCalls(STATE_PATH) === providerCallsBefore, 'an already-cancelled or expired attempt launches nothing');

  console.log('\nExecutor persists the Attempt before launch and records provenance');
  let seq = 0;
  const request = (target, kind = 'conversation', profile = 'readonly') => {
    const conv = conversations.getByBotId(target.id);
    const { request: created } = engine.createOrGetWorkRequest({
      sourceConversationId: conv.id, sourceEventId: `ev-${++seq}`, requester: { kind: 'person', id: 'owner' },
      targetAgentId: target.id, intent: 'Explain', executionKind: kind, toolProfile: profile, idempotencyKey: `k-${seq}`,
    });
    engine.transitionWorkRequest(created.id, { from: 'queued', to: 'running' });
    return { id: created.id, conv };
  };
  const messagesBeforeExec = messageRows();

  const okReq = request(agentRow);
  let openDuringLaunch = null;
  const spyAdapter = {
    name: directAdapter.name,
    run: (input, onEvent) => {
      openDuringLaunch = engine.listAttempts(okReq.id);
      return directAdapter.run(input, onEvent);
    },
  };
  const ok = await executor.executeAttempt(engine, okReq.id, {
    agent: 'codex', adapter: spyAdapter, input: directFixture(), snapshot: { execution_kind: 'conversation' },
  });
  assert(openDuringLaunch && openDuringLaunch.length === 1 && openDuringLaunch[0].finished_at === null, 'the Attempt is persisted (open) before the adapter launches');
  const okRow = engine.getAttempt(ok.attempt.id);
  const okSnapshot = JSON.parse(okRow.launch_snapshot);
  assert(okRow.adapter === 'codex' && okSnapshot.transport === 'session-provider' && okSnapshot.agent_id === agentRow.id, 'provenance: dispatched agent identity plus transport adapter name');
  assert(!('deck' in okSnapshot) && okSnapshot.cwd === '/repo/checkout' && okSnapshot.tool_profile === 'readonly' && okSnapshot.execution_kind === 'conversation' && /^[0-9a-f]{64}$/.test(okSnapshot.prompt_hash), 'provenance: launch snapshot records cwd, tool profile, policy, and prompt hash (no deck)');
  assert(okRow.external_run_id === ok.result.externalRunId && okRow.external_session_id === ok.result.externalSessionId, 'provenance: external turn and opaque session ids');
  assert(okRow.outcome === 'succeeded' && okRow.error_category === null && /Explain lib\/db\.ts/.test(okRow.output ?? ''), 'provenance: succeeded outcome and output');
  assert(JSON.parse(okRow.artifacts).length === 0, 'provenance: no artifact paths exposed');
  assert(okRow.started_at <= okRow.finished_at && okRow.finished_at === ok.result.finishedAt, 'provenance: started/finished timestamps');
  const okEvents = engine.listEvents(okReq.id).map(event => event.type);
  assert(okEvents.join(',') === 'accepted,state_changed,attempt_started,runtime_started,attempt_finished', `attempt events recorded in order (${okEvents.join(',')})`);

  const badReq = request(agentRow);
  fake.mutateFakeProvider(STATE_PATH, state => { state.failStarts = (state.failStarts ?? 0) + 1; state.startError = { code: 'runtime_error', message: 'model crashed' }; });
  const bad = await executor.executeAttempt(engine, badReq.id, { agent: 'codex', adapter: directAdapter, input: directFixture() });
  const badRow = engine.getAttempt(bad.attempt.id);
  assert(badRow.outcome === 'failed' && badRow.error_category === 'launch_failed' && badRow.output === null, 'refused start: outcome, failure category, no output');
  assert(badRow.external_run_id === null && badRow.finished_at !== null, 'failed launch: no run id, still finished');

  const hermesReq = request(hermesRow);
  hermesPlan = { status: 401 };
  const hermesFailed = await executor.executeAttempt(engine, hermesReq.id, {
    agent: 'hermes', adapter: hermesAdapter, input: hermesFixture(),
  });
  const hermesRowAttempt = engine.getAttempt(hermesFailed.attempt.id);
  assert(hermesRowAttempt.outcome === 'failed' && hermesRowAttempt.error_category === 'runtime_failed' && hermesRowAttempt.external_session_id === `botmancer-specialist-${hermesRow.id}` && !hermesRowAttempt.error_message.includes(HERMES_KEY), 'failed Hermes run: category, session id, no credential at rest');

  const resumeReq = request(agentRow, 'revision', 'edit');
  const binding = engine.bindSession({ agentId: agentRow.id, adapter: 'codex', externalSessionId: resumed.externalSessionId, conversationId: resumeReq.conv.id });
  const resumedExec = await executor.executeAttempt(engine, resumeReq.id, {
    agent: 'codex', adapter: directAdapter,
    input: directFixture({ toolProfile: 'edit', sessionBinding: { bindingId: binding.id, externalSessionId: binding.external_session_id } }),
  });
  const resumedRow = engine.getAttempt(resumedExec.attempt.id);
  assert(resumedRow.kind === 'resume' && resumedRow.resumed_session_binding_id === binding.id && resumedRow.tool_profile === 'edit', 'resume attempt records its Session Binding and explicit edit profile');
  assert(resumedRow.external_session_id === resumed.externalSessionId, 'persisted binding reaches the runtime and provenance verbatim');
  let unboundError = null;
  try {
    executor.beginAttempt(engine, request(agentRow, 'revision', 'edit').id, { agent: 'codex', adapter: directAdapter, input: directFixture({ toolProfile: 'edit', sessionBinding: { bindingId: null, externalSessionId: 'x' } }) });
  } catch (error) { unboundError = error; }
  assert(unboundError && unboundError.code === 'invalid_input', 'the executor refuses a resume without a persisted Session Binding');

  const throwingReq = request(agentRow);
  const thrown = await executor.executeAttempt(engine, throwingReq.id, { agent: 'codex', adapter: { name: 'session-provider', run: async () => { throw new Error('adapter defect'); } }, input: directFixture() });
  assert(engine.getAttempt(thrown.attempt.id).outcome === 'failed' && engine.getAttempt(thrown.attempt.id).error_category === 'runtime_failed', 'an adapter defect is recorded as a failed attempt, never left open');

  const progressReq = request(agentRow);
  const progress = await executor.executeAttempt(engine, progressReq.id, {
    agent: 'codex',
    adapter: { name: 'session-provider', run: async (input, onEvent) => {
      onEvent({ type: 'progress', adapter: 'session-provider', at: Date.now(), detail: { phase: 'thinking' } });
      return { status: 'completed', adapter: 'session-provider', externalRunId: null, externalSessionId: null, output: 'done', artifacts: [], startedAt: Date.now(), finishedAt: Date.now(), failure: null };
    } },
    input: directFixture(),
  });
  const progressEvent = engine.listEvents(progressReq.id).find(event => event.type === 'runtime_progress');
  assert(progressEvent && progressEvent.attempt_id === progress.attempt.id && JSON.parse(progressEvent.data).phase === 'thinking', 'progress events are recorded against the attempt');
  assert(messageRows() === messagesBeforeExec && messageCreates === 0, 'the executor and adapters wrote no conversation messages');

  console.log('\nCompatibility: direct dispatch still returns reply text through the adapters');
  dispatch.setAgentDispatchHermesFetch(hermesFetch);
  hermesPlan = { content: 'compat reply' };
  const reply = await dispatch.dispatchToAgent({ bot: hermesRow, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hi' }] });
  assert(reply === 'compat reply', 'dispatchToAgent returns the Hermes reply');
  hermesPlan = { status: 500 };
  let compatError = null;
  try { await dispatch.dispatchToAgent({ bot: hermesRow, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hi' }] }); } catch (error) { compatError = error; }
  assert(compatError && compatError.code === 'runtime_failed' && compatError.message === 'The agent runtime did not complete the turn (http).', 'dispatch failure text stays fixed per category');
  dispatch.setAgentDispatchHermesFetch(null);
  providerContract.clearSessionProviders({ builtins: true });
}

// The fake provider settles promptly; keep the loop alive and fail if it
// ever drains early.
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on('beforeExit', () => {
  if (!finished) { console.log('  FAIL: event loop drained before the test finished'); process.exit(1); }
});

main()
  .catch(error => { failures++; console.error(error); })
  .finally(() => {
    finished = true;
    clearInterval(keepAlive);
    removeAll();
    if (failures > 0) {
      console.log(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll attempt adapter assertions passed.');
    process.exit(0);
  });
