#!/usr/bin/env node
// NOT-543: canonical dispatch uses the direct session-provider adapter.
//
// Proves through the real engine, executor, and projector (no network,
// no Agent Deck, scripted in-process providers):
// (1) canonical Claude, Codex, Cursor, and Muse Work Requests select the
//     direct provider adapter for fresh turns: one provider start each,
//     durable terminal results, no provider id leak;
// (2) bound turns (exact-session revisions) send to that exact session and
//     start nothing new;
// (3) cancellation: a pre-cancelled Attempt launches nothing; a held
//     direct turn cancels through the registry;
// (4) replay of the same Attempt correlation returns the original turn;
// (5) terminal results project (request_completed) per conversation;
// (6) Hermes still dispatches through its gateway adapter, unchanged;
// (7) open Attempts on removed transports reconcile as interrupted after
//     a restart and are never relaunched.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const DB_PATH = path.join(os.tmpdir(), `botmancers-direct-cutover-${process.pid}.db`);
const TMP = path.join(os.tmpdir(), `botmancers-direct-cutover-states-${process.pid}`);
function removeAll() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fresh start */ }
}
removeAll();
fs.mkdirSync(TMP, { recursive: true });
const WORKROOT = path.join(TMP, 'work');
fs.mkdirSync(WORKROOT, { recursive: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HERMES_API_SERVER_KEY = 'test-hermes-key';
process.env.HERMES_BASE_URL = 'http://127.0.0.1:65530';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
// No transport may reach the network: every fetch is counted and refused.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const dispatch = jiti('../lib/agent-dispatch.ts');
const executor = jiti('../lib/attempt-executor.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const service = jiti('../lib/agent-conversations.ts');
const fake = require('./support/fake-session-provider');

const db = dbModule.default;
const { bots, conversations, engine, projector } = dbModule;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const SECRET = /SECRET/;
const owner = { kind: 'person', id: 'local-owner' };
const PROVIDERS = ['claude', 'codex', 'cursor', 'muse'];
const STATES = Object.fromEntries(PROVIDERS.map(p => [p, path.join(TMP, `${p}.json`)]));

function makeAgent(name, provider, policy) {
  return bots.create({
    name, title: 'Direct', description: 'Cutover case', agent: provider,
    runtime_connection_id: dbModule.runtimeConnections.ensureLocal(provider),
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([WORKROOT]),
    default_workspace: WORKROOT,
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0,
    allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}

function runningRequest(agent, key, kind = 'implementation') {
  const conv = conversations.getByBotId(agent.id);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: `cutover-${key}`, requester: owner, targetAgentId: agent.id,
    intent: `Cutover ${key}`, executionKind: kind, toolProfile: 'edit', idempotencyKey: `cutover-${key}`,
  });
  engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
  return request;
}

async function main() {
  contract.clearSessionProviders({ builtins: true });
  for (const provider of PROVIDERS) {
    const connectionId = dbModule.runtimeConnections.ensureLocal(provider);
    contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATES[provider], kind: `cutover-${provider}` }));
  }
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const agents = Object.fromEntries(PROVIDERS.map(p => [p, makeAgent(`Dev-${p}`, p, write)]));

  console.log('\n(1) Fresh turns select the direct adapter, one provider start each');
  const sessionRefs = {};
  const history = [{ speakerLabel: 'person:owner', fromAgent: false, content: 'Implement the widget' }];
  for (const provider of PROVIDERS) {
    const agent = agents[provider];
    const prepared = dispatch.prepareDispatch({ bot: bots.getById(agent.id), history, toolProfile: 'edit' });
    assert(prepared.adapter.name === 'session-provider', `${provider}: prepareDispatch selects session-provider`);
    assert(prepared.input.cwd === WORKROOT && prepared.input.sessionBinding === null, `${provider}: fresh turn carries the default workspace and no binding`);
    const startsBefore = fake.providerCalls(STATES[provider], 'startSession');
    const request = runningRequest(agent, `fresh-${provider}`);
    const freshPrep = executor.beginAttempt(engine, request.id, { agent: provider, adapter: prepared.adapter, input: prepared.input });
    const run = await executor.runAttempt(engine, freshPrep, prepared.adapter);
    assert(run.result.status === 'completed' && run.attempt.outcome === 'succeeded', `${provider}: fresh Work Request completes with a succeeded Attempt`);
    assert(fake.providerCalls(STATES[provider], 'startSession') === startsBefore + 1, `${provider}: exactly one provider start`);
    assert(!SECRET.test(JSON.stringify(run.result)), `${provider}: no provider id in the Attempt result`);
    sessionRefs[provider] = run.result.externalSessionId;
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null } });
  }

  console.log('\n(2) Bound turns resume the exact session and start nothing');
  for (const provider of PROVIDERS) {
    const agent = agents[provider];
    const conv = conversations.getByBotId(agent.id);
    const binding = engine.bindSession({
      agentId: agent.id, adapter: provider, externalSessionId: sessionRefs[provider], conversationId: conv.id, now: Date.now(),
    });
    const startsBefore = fake.providerCalls(STATES[provider], 'startSession');
    const sendsBefore = fake.providerCalls(STATES[provider], 'sendTurn');
    const prepared = dispatch.prepareDispatch({
      bot: bots.getById(agent.id), history, toolProfile: 'edit',
      sessionBinding: { bindingId: binding.id, externalSessionId: sessionRefs[provider] },
    });
    assert(prepared.adapter.name === 'session-provider' && prepared.input.cwd === null, `${provider}: bound turn stays on session-provider with no fresh workspace`);
    const request = runningRequest(agent, `bound-${provider}`, 'revision');
    const boundPrep = executor.beginAttempt(engine, request.id, { agent: provider, adapter: prepared.adapter, input: prepared.input });
    const run = await executor.runAttempt(engine, boundPrep, prepared.adapter);
    assert(run.result.status === 'completed' && run.result.externalSessionId === sessionRefs[provider], `${provider}: revision returns the exact session ref`);
    assert(fake.providerCalls(STATES[provider], 'startSession') === startsBefore, `${provider}: bound turn starts no session`);
    assert(fake.providerCalls(STATES[provider], 'sendTurn') === sendsBefore + 1, `${provider}: bound turn sends exactly one turn`);
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: null } });
  }

  console.log('\n(3) Cancellation launches nothing and cancels a held turn');
  const codex = agents.codex;
  const cancelledCalls = fake.providerCalls(STATES.codex);
  const aborted = new AbortController();
  aborted.abort();
  const doomed = dispatch.prepareDispatch({ bot: bots.getById(codex.id), history, toolProfile: 'edit' });
  const doomedRequest = runningRequest(codex, 'cancelled');
  const doomedPrep = executor.beginAttempt(engine, doomedRequest.id, { agent: 'codex', adapter: doomed.adapter, input: { ...doomed.input, signal: aborted.signal } });
  const doomedRun = await executor.runAttempt(engine, doomedPrep, doomed.adapter);
  assert(doomedRun.result.status === 'failed' && doomedRun.result.failure.category === 'cancelled', 'a pre-cancelled Attempt fails cancelled');
  assert(fake.providerCalls(STATES.codex) === cancelledCalls, 'a pre-cancelled Attempt launches no provider turn');
  fake.mutateFakeProvider(STATES.codex, state => { state.holdNext = (state.holdNext ?? 0) + 1; });
  const held = dispatch.prepareDispatch({ bot: bots.getById(codex.id), history: [{ speakerLabel: 'person:owner', fromAgent: false, content: '[hold] slow turn' }], toolProfile: 'edit' });
  const heldRequest = runningRequest(codex, 'held');
  const heldPrep = executor.beginAttempt(engine, heldRequest.id, { agent: 'codex', adapter: held.adapter, input: held.input });
  const heldRun = executor.runAttempt(engine, heldPrep, held.adapter);
  const heldTurnId = await (async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const row = db.prepare("SELECT id FROM provider_session_turns WHERE agent_id = ? AND state = 'running' ORDER BY created_at DESC").get(codex.id);
      if (row) return row.id;
      if (Date.now() > deadline) throw new Error('held turn never started');
      await new Promise(done => setTimeout(done, 10));
    }
  })();
  const cancelled = await held.adapter.reconciler.cancel(heldTurnId);
  assert(cancelled === 'requested', 'the held direct turn cancels through the reconciler');
  const heldResult = await heldRun;
  assert(heldResult.result.status === 'failed' && heldResult.result.failure.category === 'cancelled', 'the cancelled Attempt records cancelled, not a result');

  console.log('\n(4) Replay returns the original turn');
  const replayStarts = fake.providerCalls(STATES.codex, 'startSession');
  const replayAdapter = dispatch.prepareDispatch({ bot: bots.getById(codex.id), history, toolProfile: 'edit' }).adapter;
  const replayInput = { ...dispatch.prepareDispatch({ bot: bots.getById(codex.id), history, toolProfile: 'edit' }).input, correlation: { attemptId: 'cutover-replay-1' } };
  const first = await replayAdapter.run(replayInput);
  const second = await replayAdapter.run(replayInput);
  assert(first.status === 'completed' && second.status === 'completed', 'both replays complete');
  assert(first.externalRunId === second.externalRunId && first.output === second.output, 'replay returns the same turn and output');
  assert(fake.providerCalls(STATES.codex, 'startSession') === replayStarts + 1, 'replay starts no second provider turn');

  console.log('\n(5) Terminal results project per conversation');
  for (const provider of PROVIDERS) {
    const conv = conversations.getByBotId(agents[provider].id);
    const kinds = projector.listConversationEvents(conv.id).map(view => view.kind);
    assert(kinds.filter(kind => kind === 'request_completed').length === 2, `${provider}: fresh + revision project as two request_completed`);
  }

  console.log('\n(6) Hermes still dispatches through its gateway adapter');
  let hermesCalls = 0;
  dispatch.setAgentDispatchHermesFetch(async () => {
    hermesCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hermes reply' } }] }), { status: 200 });
  });
  try {
    const hermes = makeAgent('Tank', 'hermes', { mode: 'read_only', newSessions: true });
    const prepared = dispatch.prepareDispatch({ bot: bots.getById(hermes.id), history });
    assert(prepared.adapter.name === 'hermes-gateway' && prepared.input.cwd === null, 'Hermes prepares on hermes-gateway with no workspace');
    const reply = await dispatch.dispatchToAgent({ bot: bots.getById(hermes.id), history });
    assert(reply === 'hermes reply' && hermesCalls === 1, 'Hermes turn completes through the gateway stub');
  } finally {
    dispatch.setAgentDispatchHermesFetch(null);
  }

  console.log('\n(7) Removed transports reconcile as interrupted, never relaunched');
  assert(dispatch.adapterForTransport('agent-deck-run') === null && dispatch.adapterForTransport('agent-deck-api') === null,
    'agent-deck-run and agent-deck-api have no adapter');
  const stranded = agents.claude;
  const strandedRequest = runningRequest(stranded, 'stranded');
  const strandedAttempt = engine.createAttempt(strandedRequest.id, {
    kind: 'launch', adapter: 'session-provider', toolProfile: 'edit',
    launchSnapshot: { transport: 'agent-deck-run', agent: 'claude' },
  });
  db.prepare('UPDATE work_attempts SET external_run_id = ? WHERE id = ?').run('deck-run-orphan', strandedAttempt.id);
  const providerCallsBefore = PROVIDERS.map(p => fake.providerCalls(STATES[p]));
  service.configureDispatcher({ owner: `cutover-test:${process.pid}` });
  await service.recoverCoordinatorLoops();
  await service.waitForAgentDispatchIdle();
  const reconciled = engine.getAttempt(strandedAttempt.id);
  const strandedAfter = engine.getWorkRequest(strandedRequest.id);
  assert(reconciled.outcome === 'interrupted' && reconciled.error_category === 'interrupted', 'the deck-transport Attempt reconciles as interrupted');
  assert(strandedAfter.state === 'failed' && strandedAfter.error_code === 'interrupted', 'its request fails interrupted');
  assert(JSON.stringify(PROVIDERS.map(p => fake.providerCalls(STATES[p]))) === JSON.stringify(providerCallsBefore), 'recovery relaunched nothing');

  assert(fetchCalls === 0, `no coding-agent dispatch touched the network (${fetchCalls} fetch calls)`);

  removeAll();
  if (failures > 0) {
    console.log(`\ntest:direct-cutover: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\ntest:direct-cutover: all assertions passing');
}

main().catch(error => {
  console.error(`FAIL: direct-cutover test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
