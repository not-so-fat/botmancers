#!/usr/bin/env node
// NOT-467: one single-Attempt adapter contract for Hermes and Agent Deck.
// Proves: both adapters accept the same AttemptInput fixture and return
// the same normalized AttemptResult shape; Agent Deck launches carry the
// explicit tool profile (readonly, edit) and resume the opaque session
// binding verbatim, independent of the Agent type; unsupported authority
// fails closed before launch; cancellation and deadlines are normalized;
// the executor persists the Attempt before launch and records adapter,
// launch snapshot, run/session ids, timestamps, outcome, failure
// category, output, and artifact references; and neither the adapters nor
// the executor write conversation messages.
//
// Self-contained: isolated SQLite file, fakes at the agent-deck process
// boundary and the Hermes gateway fetch boundary. No network, no real runs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-attempt-adapter-test-${process.pid}.db`);
function removeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
const HERMES_KEY = 'hermes-secret-key-must-not-leak';
process.env.HERMES_API_SERVER_KEY = HERMES_KEY;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': __dirname } });
const deck = jiti('./lib/agent-deck-run.ts');
const hermesAttempt = jiti('./lib/hermes-attempt.ts');
const contract = jiti('./lib/attempt-adapter.ts');
const executor = jiti('./lib/attempt-executor.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const dbModule = jiti('./lib/db.ts');
const { bots, conversations, engine } = dbModule;
const sqlite = dbModule.default;

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
function flag(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

// Negative spy: every conversation message write path is counted.
let messageCreates = 0;
const originalCreate = dbModule.messages.create;
dbModule.messages.create = (...args) => { messageCreates++; return originalCreate.apply(dbModule.messages, args); };
const messageRows = () => sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

// Fake agent-deck process boundary. `deckPlan` shapes the next run.
const deckStarts = [];
let runCounter = 0;
let deckPlan = {};
const runs = new Map();
deck.setDeckRunProcess(async argv => {
  if (argv[0] !== 'agent-deck' || argv[1] !== 'run') return { stdout: '', stderr: 'unexpected', exitCode: 127 };
  if (argv[2] === 'status') {
    const plan = runs.get(argv[3]);
    return {
      stdout: JSON.stringify({ runId: argv[3], deck: 'd', client: 'c', state: plan.state || 'ended', sessionId: plan.sessionId, logPath: `/tmp/runs/${argv[3]}.jsonl` }),
      stderr: '', exitCode: 0,
    };
  }
  if (argv[2] === 'log') {
    const plan = runs.get(argv[3]);
    if (plan.hang) return new Promise(() => {});
    const lines = plan.logError
      ? [{ t: 'error', message: plan.logError }]
      : [{ t: 'result', result: plan.result, sessionId: plan.sessionId }, { t: 'end' }];
    return { stdout: lines.map(line => JSON.stringify(line)).join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  deckStarts.push(argv);
  if (deckPlan.startExit) return { stdout: '', stderr: 'agent-deck: deck not found', exitCode: deckPlan.startExit };
  const runId = `run-${++runCounter}`;
  runs.set(runId, { ...deckPlan });
  return { stdout: `run ${runId} detached: pid 4242 log /tmp/runs/${runId}.jsonl\n`, stderr: '', exitCode: 0 };
});

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
const deckAdapter = deck.createAgentDeckAttemptAdapter();

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
    deck: 'deck-xyz',
    toolProfile: 'readonly',
    sessionBinding: null,
    correlation: { requestId: 'req-1', conversationId: 'conv-1' },
    ...overrides,
  };
}
const RESULT_KEYS = ['adapter', 'artifacts', 'externalRunId', 'externalSessionId', 'failure', 'finishedAt', 'output', 'startedAt', 'status'];
const keysOf = value => Object.keys(value).sort().join(',');

async function main() {
  console.log('\nShared contract: equivalent fixtures, equivalent results');
  assert(typeof hermesAdapter.run === 'function' && hermesAdapter.name === 'hermes-gateway', 'Hermes implements AttemptAdapter (name + run)');
  assert(typeof deckAdapter.run === 'function' && deckAdapter.name === 'agent-deck-run', 'Agent Deck implements AttemptAdapter (name + run)');
  assert(Object.keys(dispatch.ATTEMPT_ADAPTERS).sort().join(',') === 'agent-deck-run,hermes-gateway', 'transport map selects one contract adapter per transport (type-checked Record<AgentTransport, () => AttemptAdapter>)');

  const messagesBefore = messageRows();
  hermesPlan = { content: 'db.ts opens SQLite.' };
  const hermesEvents = [];
  const hermesOk = await hermesAdapter.run(contract.freezeAttemptInput(fixture({ target: { agentId: 'agent-1', agent: 'hermes' }, cwd: null })), e => hermesEvents.push(e));
  deckPlan = { result: 'db.ts opens SQLite.', sessionId: 'ses-opaque-1' };
  const deckEvents = [];
  const deckOk = await deckAdapter.run(contract.freezeAttemptInput(fixture()), e => deckEvents.push(e));
  assert(keysOf(hermesOk) === RESULT_KEYS.join(',') && keysOf(deckOk) === RESULT_KEYS.join(','), `both results carry the normalized fields (${keysOf(hermesOk)} | ${keysOf(deckOk)})`);
  assert(hermesOk.status === 'completed' && deckOk.status === 'completed' && hermesOk.output === deckOk.output, 'both complete with the same output for the same fixture');
  assert(hermesOk.failure === null && deckOk.failure === null, 'completed results carry no failure');
  assert(hermesEvents.length === 1 && hermesEvents[0].type === 'started' && deckEvents.length === 1 && deckEvents[0].type === 'started', 'each adapter emits exactly one started event before its terminal result');
  assert(deckEvents[0].externalRunId === 'run-1' && deckOk.externalRunId === 'run-1' && deckOk.externalSessionId === 'ses-opaque-1', 'Agent Deck reports its run id and opaque session id');
  assert(deckOk.artifacts.length === 1 && deckOk.artifacts[0].kind === 'run_log' && deckOk.artifacts[0].ref === '/tmp/runs/run-1.jsonl', 'Agent Deck returns the run log as an artifact reference');
  assert(hermesOk.externalRunId === null && hermesOk.externalSessionId === 'botmancer-specialist-agent-1', 'Hermes reports its gateway session id and no run id');
  assert(hermesOk.startedAt <= hermesOk.finishedAt && deckOk.startedAt <= deckOk.finishedAt, 'both results carry ordered timestamps');
  const deckPrompt = flag(deckStarts[0], '--prompt');
  assert(deckPrompt.startsWith('You are Dev.') && deckPrompt.includes('[person:owner] Explain lib/db.ts'), 'Agent Deck renders the conversation prompt as its transcript');
  assert(hermesCalls[0].messages[0].role === 'system' && hermesCalls[0].messages[1].content === '[From person:owner] Explain lib/db.ts', 'Hermes renders the same conversation prompt as gateway chat messages');

  hermesPlan = { status: 401 };
  const hermesBad = await hermesAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'hermes' }, cwd: null }));
  deckPlan = { logError: 'model crashed' };
  const deckBad = await deckAdapter.run(fixture());
  assert(hermesBad.status === 'failed' && deckBad.status === 'failed' && keysOf(hermesBad) === keysOf(deckBad), 'both fail with the same normalized result shape');
  assert(hermesBad.failure.category === 'runtime_failed' && hermesBad.failure.code === 'http' && deckBad.failure.category === 'runtime_failed', 'runtime failures carry the stable runtime_failed category');
  assert(!hermesBad.failure.message.includes(HERMES_KEY) && !hermesBad.failure.message.includes('127.0.0.1'), 'Hermes failure provenance excludes gateway error bodies (no key or endpoint)');
  deckPlan = { startExit: 2 };
  const deckNoStart = await deckAdapter.run(fixture());
  assert(deckNoStart.status === 'failed' && deckNoStart.failure.category === 'launch_failed' && deckNoStart.externalRunId === null, 'a rejected launch is launch_failed with no run id');
  deckPlan = { result: { not: 'a string' }, sessionId: 'ses-x' };
  const deckContract = await deckAdapter.run(fixture());
  assert(deckContract.failure && deckContract.failure.category === 'result_contract' && deckContract.output === null, 'a non-string result is result_contract (NOT-483) with no output');
  assert(messageRows() === messagesBefore && messageCreates === 0, 'adapters wrote no conversation messages');

  console.log('\nExplicit tool authority and opaque session binding (argument capture)');
  deckStarts.length = 0;
  deckPlan = { result: 'ok', sessionId: 'ses-ro' };
  await deckAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'claude' }, toolProfile: 'readonly' }));
  deckPlan = { result: 'ok', sessionId: 'ses-edit' };
  await deckAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'codex' }, toolProfile: 'edit', prompt: { kind: 'text', text: 'Implement X' } }));
  const OPAQUE = 'ses:opaque/../ID with spaces+%2F🙂';
  deckPlan = { result: 'revised', sessionId: OPAQUE };
  const resumed = await deckAdapter.run(fixture({ toolProfile: 'edit', prompt: { kind: 'text', text: 'Address review' }, sessionBinding: { bindingId: null, externalSessionId: OPAQUE } }));
  const [ro, edit, resume] = deckStarts;
  assert(flag(ro, '--tools') === 'readonly' && flag(ro, '--client') === 'claude' && !ro.includes('--resume'), 'readonly input launches --tools readonly (claude) with no resume');
  assert(flag(edit, '--tools') === 'edit' && flag(edit, '--client') === 'codex' && !edit.includes('--resume') && flag(edit, '--prompt') === 'Implement X', 'edit input launches --tools edit (codex) with the text prompt verbatim');
  assert(flag(resume, '--tools') === 'edit' && flag(resume, '--resume') === OPAQUE, 'resume input passes the opaque session id verbatim to --resume with the explicit profile');
  assert(deckStarts.every(argv => flag(argv, '--deck') === undefined && argv[2] === 'deck-xyz' && flag(argv, '--cwd') === '/repo/checkout' && argv.includes('--detach')), 'every launch carries the explicit deck, cwd, and detach');
  assert(resumed.status === 'completed' && resumed.externalSessionId === OPAQUE, 'the reported session id is returned verbatim');
  deckPlan = { result: 'revised', sessionId: 'ses-other' };
  const forked = await deckAdapter.run(fixture({ toolProfile: 'edit', sessionBinding: { bindingId: null, externalSessionId: OPAQUE } }));
  assert(forked.status === 'failed' && forked.failure.category === 'session_mismatch' && forked.externalSessionId === 'ses-other', 'a resumed run reporting another session fails closed as session_mismatch');

  const startsBefore = deckStarts.length;
  const hermesBefore = hermesCalls.length;
  const noProfile = await deckAdapter.run(fixture({ toolProfile: undefined }));
  const badProfile = await deckAdapter.run(fixture({ toolProfile: 'admin' }));
  const hermesEdit = await hermesAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'hermes' }, toolProfile: 'edit' }));
  assert(noProfile.failure.category === 'unsupported_authority' && badProfile.failure.category === 'unsupported_authority', 'Agent Deck rejects a missing or unknown tool profile (no default)');
  assert(hermesEdit.failure.category === 'unsupported_authority', 'Hermes rejects edit authority it cannot honor');
  assert(deckStarts.length === startsBefore && hermesCalls.length === hermesBefore, 'unsupported authority launches nothing');
  hermesPlan = { content: 'bound' };
  await hermesAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'hermes' }, sessionBinding: { bindingId: 'b-1', externalSessionId: OPAQUE } }));
  assert(hermesCalls[hermesCalls.length - 1].session === OPAQUE, 'Hermes passes a bound opaque session id verbatim to the gateway');

  console.log('\nCancellation and deadline');
  const aborted = new AbortController();
  aborted.abort();
  const preCancelled = await deckAdapter.run(fixture({ signal: aborted.signal }));
  const preExpired = await hermesAdapter.run(fixture({ target: { agentId: 'agent-1', agent: 'hermes' }, deadlineAt: Date.now() - 1 }));
  assert(preCancelled.failure.category === 'cancelled' && preExpired.failure.category === 'timed_out' && deckStarts.length === startsBefore, 'an already-cancelled or expired attempt launches nothing');
  deckPlan = { hang: true };
  const hung = await deckAdapter.run(fixture({ deadlineAt: Date.now() + 50 }));
  assert(hung.status === 'failed' && hung.failure.category === 'timed_out' && hung.externalRunId !== null, 'a run past its deadline is timed_out and keeps its run id');
  const midCancel = new AbortController();
  const pendingCancel = deckAdapter.run(fixture({ signal: midCancel.signal }));
  setTimeout(() => midCancel.abort(), 20);
  const cancelled = await pendingCancel;
  assert(cancelled.failure.category === 'cancelled', 'a cancelled in-flight wait is cancelled');

  console.log('\nExecutor persists the Attempt before launch and records provenance');
  const agentRow = bots.create({ deck_id: 'deck-xyz', name: 'Dev', title: '', description: 'Codes.', agent: 'codex' });
  const hermesRow = bots.create({ deck_id: 'deck-xyz', name: 'Hermy', title: '', description: 'Talks.', agent: 'hermes' });
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
    name: deckAdapter.name,
    run: (input, onEvent) => {
      openDuringLaunch = engine.listAttempts(okReq.id);
      return deckAdapter.run(input, onEvent);
    },
  };
  deckPlan = { result: 'explained', sessionId: 'ses-exec-1' };
  const ok = await executor.executeAttempt(engine, okReq.id, {
    agent: 'codex', adapter: spyAdapter, input: fixture({ target: { agentId: agentRow.id, agent: 'codex' } }), snapshot: { execution_kind: 'conversation' },
  });
  assert(openDuringLaunch && openDuringLaunch.length === 1 && openDuringLaunch[0].finished_at === null, 'the Attempt is persisted (open) before the adapter launches');
  const okRow = engine.getAttempt(ok.attempt.id);
  const okSnapshot = JSON.parse(okRow.launch_snapshot);
  assert(okRow.adapter === 'codex' && okSnapshot.transport === 'agent-deck-run' && okSnapshot.agent_id === agentRow.id, 'provenance: dispatched agent identity plus transport adapter name');
  assert(okSnapshot.deck === 'deck-xyz' && okSnapshot.cwd === '/repo/checkout' && okSnapshot.tool_profile === 'readonly' && okSnapshot.execution_kind === 'conversation' && /^[0-9a-f]{64}$/.test(okSnapshot.prompt_hash), 'provenance: launch snapshot records deck, cwd, tool profile, policy, and prompt hash');
  assert(okRow.external_run_id === ok.result.externalRunId && okRow.external_session_id === 'ses-exec-1', 'provenance: external run and opaque session ids');
  assert(okRow.outcome === 'succeeded' && okRow.error_category === null && okRow.output === 'explained', 'provenance: succeeded outcome and output');
  assert(JSON.parse(okRow.artifacts)[0].ref === `/tmp/runs/${okRow.external_run_id}.jsonl`, 'provenance: artifact references');
  assert(okRow.started_at <= okRow.finished_at && okRow.finished_at === ok.result.finishedAt, 'provenance: started/finished timestamps');
  const okEvents = engine.listEvents(okReq.id).map(event => event.type);
  assert(okEvents.join(',') === 'accepted,state_changed,attempt_started,runtime_started,attempt_finished', `attempt events recorded in order (${okEvents.join(',')})`);

  const badReq = request(agentRow);
  deckPlan = { logError: 'model crashed' };
  const bad = await executor.executeAttempt(engine, badReq.id, { agent: 'codex', adapter: deckAdapter, input: fixture({ target: { agentId: agentRow.id, agent: 'codex' } }) });
  const badRow = engine.getAttempt(bad.attempt.id);
  assert(badRow.outcome === 'failed' && badRow.error_category === 'runtime_failed' && badRow.output === null && /model crashed/.test(badRow.error_message), 'failed run: outcome, failure category, diagnostic, no output');
  assert(badRow.external_run_id !== null && JSON.parse(badRow.artifacts).length === 1 && badRow.finished_at !== null, 'failed run: run id and artifact reference still recorded');

  const hermesReq = request(hermesRow);
  hermesPlan = { status: 401 };
  const hermesFailed = await executor.executeAttempt(engine, hermesReq.id, {
    agent: 'hermes', adapter: hermesAdapter, input: fixture({ target: { agentId: hermesRow.id, agent: 'hermes' }, cwd: null }),
  });
  const hermesRowAttempt = engine.getAttempt(hermesFailed.attempt.id);
  assert(hermesRowAttempt.outcome === 'failed' && hermesRowAttempt.error_category === 'runtime_failed' && hermesRowAttempt.external_session_id === `botmancer-specialist-${hermesRow.id}` && !hermesRowAttempt.error_message.includes(HERMES_KEY), 'failed Hermes run: category, session id, no credential at rest');

  const timeoutReq = request(agentRow);
  deckPlan = { hang: true };
  const timedOut = await executor.executeAttempt(engine, timeoutReq.id, { agent: 'codex', adapter: deckAdapter, input: fixture({ target: { agentId: agentRow.id, agent: 'codex' }, deadlineAt: Date.now() + 30 }) });
  assert(engine.getAttempt(timedOut.attempt.id).outcome === 'timed_out', 'a deadline maps to the timed_out outcome');

  const resumeReq = request(agentRow, 'revision', 'edit');
  const binding = engine.bindSession({ agentId: agentRow.id, adapter: 'codex', externalSessionId: OPAQUE, conversationId: resumeReq.conv.id });
  deckStarts.length = 0;
  deckPlan = { result: 'revised', sessionId: OPAQUE };
  const resumedExec = await executor.executeAttempt(engine, resumeReq.id, {
    agent: 'codex', adapter: deckAdapter,
    input: fixture({ target: { agentId: agentRow.id, agent: 'codex' }, toolProfile: 'edit', sessionBinding: { bindingId: binding.id, externalSessionId: binding.external_session_id } }),
  });
  const resumedRow = engine.getAttempt(resumedExec.attempt.id);
  assert(resumedRow.kind === 'resume' && resumedRow.resumed_session_binding_id === binding.id && resumedRow.tool_profile === 'edit', 'resume attempt records its Session Binding and explicit edit profile');
  assert(flag(deckStarts[0], '--resume') === OPAQUE && flag(deckStarts[0], '--tools') === 'edit' && resumedRow.external_session_id === OPAQUE, 'persisted binding reaches the runtime and provenance verbatim');
  let unboundError = null;
  try {
    executor.beginAttempt(engine, request(agentRow, 'revision', 'edit').id, { agent: 'codex', adapter: deckAdapter, input: fixture({ toolProfile: 'edit', sessionBinding: { bindingId: null, externalSessionId: 'x' } }) });
  } catch (error) { unboundError = error; }
  assert(unboundError && unboundError.code === 'invalid_input', 'the executor refuses a resume without a persisted Session Binding');

  const throwingReq = request(agentRow);
  const thrown = await executor.executeAttempt(engine, throwingReq.id, { agent: 'codex', adapter: { name: 'agent-deck-run', run: async () => { throw new Error('adapter defect'); } }, input: fixture() });
  assert(engine.getAttempt(thrown.attempt.id).outcome === 'failed' && engine.getAttempt(thrown.attempt.id).error_category === 'runtime_failed', 'an adapter defect is recorded as a failed attempt, never left open');

  const progressReq = request(agentRow);
  const progress = await executor.executeAttempt(engine, progressReq.id, {
    agent: 'codex',
    adapter: { name: 'agent-deck-run', run: async (input, onEvent) => {
      onEvent({ type: 'progress', adapter: 'agent-deck-run', at: Date.now(), detail: { phase: 'thinking' } });
      return { status: 'completed', adapter: 'agent-deck-run', externalRunId: null, externalSessionId: null, output: 'done', artifacts: [], startedAt: Date.now(), finishedAt: Date.now(), failure: null };
    } },
    input: fixture(),
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
}

// The fake hung runs settle nothing and adapter deadline timers are
// unref'd, so keep the loop alive and fail if it ever drains early.
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
    deck.resetDeckRunProcessForTests();
    removeDb();
    if (failures > 0) {
      console.log(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll attempt adapter assertions passed.');
    process.exit(0);
  });
