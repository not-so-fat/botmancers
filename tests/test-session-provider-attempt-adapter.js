#!/usr/bin/env node
// NOT-542: direct SessionProvider AttemptAdapter (lib/session-provider-attempt)
// driven end to end without Agent Deck. Proves: fresh Attempts start via
// startProviderSession and bound Attempts send via sendProviderTurn, one
// started event, opaque turn/session refs, normalized AttemptResult for text
// and conversation prompts, across all four shipped coding-agent providers
// (claude, codex, cursor, muse); readonly->read_only and edit->
// workspace_write authority, never inferred; fresh-plus-binding and
// refused combinations fail before any provider launch; replay of the same
// Attempt correlation returns the original turn; restart reattachment (a
// second process) observes the durable turn without a second runtime
// process; abort/deadline via observe/cancel with truthful cancelled,
// failed, and timed-out outcomes, cancel idempotency, stable categories,
// bounded output, and no leaked provider diagnostics; and no Agent Deck API
// or CLI call on any path.
// Self-contained: isolated SQLite and fake-provider state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT542_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-sp-attempt-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
const STATES = {
  claude: path.join(TMP, 'claude.json'),
  codex: path.join(TMP, 'codex.json'),
  cursor: path.join(TMP, 'cursor.json'),
  muse: path.join(TMP, 'muse.json'),
};
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
// No transport may reach the network: every fetch is counted and refused.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const attemptLib = jiti('./lib/session-provider-attempt.ts');
const promptLib = jiti('./lib/attempt-prompt.ts');
const adapterContract = jiti('./lib/attempt-adapter.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const fake = require('./test-support/fake-session-provider');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const SECRET = /SECRET/;
const CATEGORIES = new Set(adapterContract.ATTEMPT_FAILURE_CATEGORIES);

const PROVIDERS = ['claude', 'codex', 'cursor', 'muse'];

function registerFakes(ids) {
  contract.clearSessionProviders({ builtins: true });
  for (const provider of PROVIDERS) {
    contract.registerSessionProvider(
      { connectionId: ids[provider] },
      () => fake.createFakeSessionProvider({ statePath: STATES[provider], kind: `fake-${provider}` }),
    );
  }
}

function makeAgent(name, provider, connectionId, scope, policy) {
  return dbModule.bots.create({
    name, title: 'Native', description: 'Direct attempt', agent: provider,
    runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: scope.kind, session_scope_items: JSON.stringify(scope.items ?? []),
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0,
    allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}

function fixture(agentId, agent, overrides = {}) {
  return {
    target: { agentId, agent },
    prompt: { kind: 'text', text: 'Explain the module' },
    cwd: '/work/alpha',
    toolProfile: 'readonly',
    sessionBinding: null,
    correlation: {},
    ...overrides,
  };
}

if (RESTART) {
  restart().catch(fatal);
} else {
  main()
    .catch(error => { failures++; console.error(error); })
    .finally(() => {
      finished = true;
      clearInterval(keepAlive);
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
      if (failures > 0) {
        console.log(`\n${failures} assertion(s) failed.`);
        process.exit(1);
      }
      console.log('\nAll session-provider attempt assertions passed.');
      process.exit(0);
    });
}

function fatal(error) {
  console.error(error);
  process.exit(1);
}

async function main() {
  console.log('\nSetup: four providers, no Agent Deck selection');
  const ids = {};
  for (const provider of PROVIDERS) {
    ids[provider] = dbModule.runtimeConnections.create({ provider, label: `${provider} local`, host: 'This computer' }).id;
  }
  registerFakes(ids);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const agents = {};
  for (const provider of PROVIDERS) {
    agents[provider] = makeAgent(`Dev-${provider}`, provider, ids[provider], { kind: 'workspaces', items: ['/work/alpha'] }, write);
  }
  const reader = makeAgent('Reader', 'codex', ids.codex, { kind: 'workspaces', items: ['/work/alpha'] }, { mode: 'read_only', newSessions: true });
  const noNew = makeAgent('NoNew', 'codex', ids.codex, { kind: 'workspaces', items: ['/work/alpha'] }, { mode: 'workspace_write', newSessions: false });
  assert(PROVIDERS.every(p => dbModule.bots.getById(agents[p].id).launch_profile === 'direct'), 'every attempt agent is direct with no deck');
  assert(dispatch.adapterForTransport('session-provider')?.name === 'session-provider', 'restart lookup resolves session-provider');
  assert(dispatch.prepareDispatch, 'dispatch module loaded (canonical coding selection is session-provider)');
  const adapter = attemptLib.createSessionProviderAttemptAdapter();

  console.log('\nFresh and resume across all four providers (text and conversation)');
  const sessionRefs = {};
  for (const provider of PROVIDERS) {
    const agent = agents[provider];
    const statePath = STATES[provider];
    // Fresh text: start.
    const startsBefore = fake.providerCalls(statePath, 'startSession');
    const sendsBefore = fake.providerCalls(statePath, 'sendTurn');
    const events = [];
    const textResult = await adapter.run(
      adapterContract.freezeAttemptInput(fixture(agent.id, provider, { correlation: { attemptId: `att-${provider}-text` } })),
      e => events.push(e),
    );
    assert(events.length === 1 && events[0].type === 'started' && events[0].adapter === 'session-provider', `${provider}: one started event`);
    assert(textResult.status === 'completed' && textResult.failure === null, `${provider}: fresh text completes`);
    assert(textResult.externalRunId && textResult.externalSessionId, `${provider}: opaque turn and session refs returned`);
    assert(events[0].externalRunId === textResult.externalRunId && events[0].externalSessionId === textResult.externalSessionId, `${provider}: started event carries the same opaque ids`);
    assert(/Explain the module/.test(textResult.output ?? ''), `${provider}: output carries the prompt reply`);
    assert(Array.isArray(textResult.artifacts) && textResult.artifacts.length === 0, `${provider}: no artifact paths exposed`);
    assert(textResult.startedAt <= textResult.finishedAt, `${provider}: ordered timestamps`);
    assert(textResult.usage && textResult.usage.input_tokens !== null, `${provider}: normalized usage reported`);
    assert(!SECRET.test(JSON.stringify(textResult)) && !SECRET.test(JSON.stringify(events)), `${provider}: no provider id in result or events`);
    assert(fake.providerCalls(statePath, 'startSession') === startsBefore + 1, `${provider}: fresh maps to exactly one startSession`);
    assert(fake.providerCalls(statePath, 'sendTurn') === sendsBefore, `${provider}: fresh sends no turn`);
    const turnRow = db.prepare('SELECT kind, authority FROM provider_session_turns WHERE id = ?').get(textResult.externalRunId);
    assert(turnRow && turnRow.kind === 'start' && turnRow.authority === 'read_only', `${provider}: registry turn is start/read_only for a readonly attempt`);
    sessionRefs[provider] = textResult.externalSessionId;

    // Fresh conversation: the transcript renders deterministically.
    const convEvents = [];
    const convResult = await adapter.run(
      adapterContract.freezeAttemptInput(fixture(agent.id, provider, {
        prompt: { kind: 'conversation', system: 'You are Dev.', history: [{ speakerLabel: 'person:owner', fromAgent: false, content: 'Review the diff' }] },
        correlation: { attemptId: `att-${provider}-conv` },
      })),
      e => convEvents.push(e),
    );
    const rendered = promptLib.attemptPromptText({
      kind: 'conversation', system: 'You are Dev.',
      history: [{ speakerLabel: 'person:owner', fromAgent: false, content: 'Review the diff' }],
    });
    assert(rendered.startsWith('You are Dev.') && rendered.includes('[person:owner] Review the diff'), `${provider}: shared transcript rendering is deterministic`);
    assert(convResult.status === 'completed' && /Review the diff/.test(convResult.output ?? ''), `${provider}: conversation prompt completes with its transcript reply`);
    assert(convEvents.length === 1 && convEvents[0].type === 'started', `${provider}: conversation emits one started event`);

    // Bound: exact-ref resume via send.
    const resumeEvents = [];
    const resumeResult = await adapter.run(
      adapterContract.freezeAttemptInput(fixture(agent.id, provider, {
        toolProfile: 'edit', prompt: { kind: 'text', text: 'Address the review' },
        sessionBinding: { bindingId: 'b-1', externalSessionId: sessionRefs[provider] },
        correlation: { attemptId: `att-${provider}-resume` },
      })),
      e => resumeEvents.push(e),
    );
    assert(resumeResult.status === 'completed' && resumeResult.externalSessionId === sessionRefs[provider], `${provider}: resume returns the exact session ref`);
    assert(/Address the review/.test(resumeResult.output ?? ''), `${provider}: resume output carries the follow-up reply`);
    assert(fake.providerCalls(statePath, 'sendTurn') === sendsBefore + 1, `${provider}: bound maps to exactly one sendTurn`);
    const resumeRow = db.prepare('SELECT kind, authority FROM provider_session_turns WHERE id = ?').get(resumeResult.externalRunId);
    assert(resumeRow && resumeRow.kind === 'send' && resumeRow.authority === 'workspace_write', `${provider}: registry turn is send/workspace_write for an edit resume`);
  }

  console.log('\nAuthority mapping and pre-launch refusals (zero provider calls)');
  const codexState = STATES.codex;
  const callsBefore = () => fake.providerCalls(codexState);
  const turnsBefore = () => count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE agent_id = ?', agents.codex.id);
  // readonly -> read_only, edit -> workspace_write (never inferred).
  const roResult = await adapter.run(fixture(agents.codex.id, 'codex', { correlation: { attemptId: 'att-auth-ro' } }));
  const editResult = await adapter.run(fixture(agents.codex.id, 'codex', { toolProfile: 'edit', correlation: { attemptId: 'att-auth-edit' } }));
  const roRow = db.prepare('SELECT authority FROM provider_session_turns WHERE id = ?').get(roResult.externalRunId);
  const editRow = db.prepare('SELECT authority FROM provider_session_turns WHERE id = ?').get(editResult.externalRunId);
  assert(roRow.authority === 'read_only' && editRow.authority === 'workspace_write', 'readonly runs read_only, edit runs workspace_write');
  // Edit on a read-only agent is refused by policy, before any runtime work.
  const policyCalls = callsBefore();
  const policyDenied = await adapter.run(fixture(reader.id, 'codex', { toolProfile: 'edit', correlation: { attemptId: 'att-auth-denied' } }));
  assert(policyDenied.status === 'failed' && policyDenied.failure.category === 'unsupported_authority', 'edit on a read_only agent fails unsupported_authority');
  assert(fake.providerCalls(codexState) === policyCalls, 'policy refusal launches no provider call');
  // Every refused combination below launches nothing.
  const refused = [
    ['fresh-plus-binding', fixture(agents.codex.id, 'codex', { freshSession: true, sessionBinding: { bindingId: 'b-1', externalSessionId: sessionRefs.codex }, correlation: { attemptId: 'att-ref-fresh' } }), 'session_mismatch'],
    ['missing-profile', fixture(agents.codex.id, 'codex', { toolProfile: undefined, correlation: { attemptId: 'att-ref-noprofile' } }), 'unsupported_authority'],
    ['unknown-profile', fixture(agents.codex.id, 'codex', { toolProfile: 'admin', correlation: { attemptId: 'att-ref-badprofile' } }), 'unsupported_authority'],
    ['missing-cwd', fixture(agents.codex.id, 'codex', { cwd: null, correlation: { attemptId: 'att-ref-nocwd' } }), 'unavailable'],
    ['relative-cwd', fixture(agents.codex.id, 'codex', { cwd: 'relative/path', correlation: { attemptId: 'att-ref-relcwd' } }), 'unavailable'],
  ];
  for (const [label, input, category] of refused) {
    const before = callsBefore();
    const beforeTurns = turnsBefore();
    const result = await adapter.run(adapterContract.freezeAttemptInput(input));
    assert(result.status === 'failed' && result.failure.category === category && result.externalRunId === null, `${label} fails ${category} with no run id`);
    assert(fake.providerCalls(codexState) === before && turnsBefore() === beforeTurns, `${label} launches no provider turn`);
    assert(adapter.launchIntent(adapterContract.freezeAttemptInput(input)) === null, `${label} has no launch intent`);
  }
  // Already-cancelled and expired attempts launch nothing.
  const aborted = new AbortController();
  aborted.abort();
  const deadCalls = callsBefore();
  const preCancelled = await adapter.run(fixture(agents.codex.id, 'codex', { signal: aborted.signal, correlation: { attemptId: 'att-ref-cancelled' } }));
  const preExpired = await adapter.run(fixture(agents.codex.id, 'codex', { deadlineAt: Date.now() - 1, correlation: { attemptId: 'att-ref-expired' } }));
  assert(preCancelled.failure.category === 'cancelled' && preExpired.failure.category === 'timed_out', 'pre-cancelled and expired attempts fail before launch');
  assert(fake.providerCalls(codexState) === deadCalls, 'pre-launch interruption launches nothing');
  // New sessions forbidden by policy.
  const noNewResult = await adapter.run(fixture(noNew.id, 'codex', { correlation: { attemptId: 'att-ref-nonew' } }));
  assert(noNewResult.failure.category === 'unsupported_authority', 'start on a no-new-sessions agent fails unsupported_authority');

  console.log('\nReplay: the same Attempt correlation returns the original turn');
  const replayInput = () => adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', { correlation: { attemptId: 'att-replay-1', requestId: 'req-replay' } }));
  const replayStarts = fake.providerCalls(codexState, 'startSession');
  const first = await adapter.run(replayInput());
  const second = await adapter.run(replayInput());
  assert(first.status === 'completed' && second.status === 'completed', 'both replays complete');
  assert(first.externalRunId === second.externalRunId && first.externalSessionId === second.externalSessionId && first.output === second.output, 'replay returns the same turn, session, and output');
  assert(fake.providerCalls(codexState, 'startSession') === replayStarts + 1, 'replay starts no second provider turn');
  assert(count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE agent_id = ? AND idempotency_key = ?', agents.codex.id, 'botmancers-attempt-att-replay-1') === 1, 'one provider turn row for the replayed key');
  // Repost through the reconciler replays too.
  const intent = adapter.launchIntent(replayInput());
  assert(intent && intent.idempotencyKey === 'botmancers-attempt-att-replay-1' && intent.grantFingerprint === null, 'launch intent carries the deterministic key and no grant');
  const repost1 = await adapter.reconciler.repost({ idempotencyKey: intent.idempotencyKey, body: intent.body });
  const repost2 = await adapter.reconciler.repost({ idempotencyKey: intent.idempotencyKey, body: intent.body });
  assert(repost1.kind === 'accepted' && repost2.kind === 'accepted' && repost1.runId === first.externalRunId && repost2.runId === first.externalRunId, 'repost replays the original turn without duplicating');
  assert(fake.providerCalls(codexState, 'startSession') === replayStarts + 1, 'repost starts no second runtime process');

  console.log('\nRestart: a second process reattaches to the durable turn');
  const probe = await adapter.run(adapterContract.freezeAttemptInput(fixture(agents.claude.id, 'claude', { prompt: { kind: 'text', text: 'restart-probe output' }, correlation: { attemptId: 'att-restart-probe' } })));
  assert(probe.status === 'completed', 'probe turn completes before the restart');
  const turnRowsBefore = count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE id = ?', probe.externalRunId);
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: { ...process.env, NOT542_TAG: TAG, NOT542_IDS: JSON.stringify({ agentId: agents.claude.id, turnRef: probe.externalRunId, sessionRef: probe.externalSessionId, output: probe.output }) },
    encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const restarted = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && restarted && restarted.failures === 0, 'the restarted process reattached without duplicating');
  assert(restarted && restarted.output === probe.output && restarted.sessionRef === probe.externalSessionId, 'restart returns the same terminal output and session ref');
  assert(count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE id = ?', probe.externalRunId) === turnRowsBefore, 'one provider turn row before and after restart');
  assert(fetchCalls === 0 && restarted && restarted.fetchCalls === 0, 'no network call in either process');

  console.log('\nAbort, deadline, cancel idempotency, and stable failures');
  // Adapter-level cancel: a held run aborted mid-flight.
  const midCancel = new AbortController();
  const cancelPromise = adapter.run(adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', {
    prompt: { kind: 'text', text: '[hold] adapter cancel' }, signal: midCancel.signal, correlation: { attemptId: 'att-hold-cancel' },
  })));
  setTimeout(() => midCancel.abort(), 20);
  const cancelled = await cancelPromise;
  assert(cancelled.status === 'failed' && cancelled.failure.category === 'cancelled' && cancelled.externalRunId !== null, 'a cancelled held run is cancelled with its run id');
  assert(cancelled.externalCancel === 'requested', 'cancel is accepted by the runtime');
  assert(ps.getProviderTurn(db, agents.codex.id, cancelled.externalRunId).state === 'cancelled', 'cancel leaves the provider turn cancelled, not running');
  // Direct held turn cancelled twice through the reconciler (idempotent).
  const directHeld = await ps.startProviderSession(db, agents.codex.id, {
    workspace: '/work/alpha', prompt: '[hold] direct hold', authority: 'read_only',
    idempotencyKey: 'hold-direct-1', requester: { kind: 'service', id: 'botmancers-attempt' }, correlation: {},
  });
  const heldTurnRef = directHeld.turn.turn_ref;
  assert(ps.getProviderTurn(db, agents.codex.id, heldTurnRef).state === 'running', 'direct held turn starts running');
  const cancel1 = await adapter.reconciler.cancel(heldTurnRef);
  const cancelCalls = fake.providerCalls(codexState, 'cancelTurn');
  const cancel2 = await adapter.reconciler.cancel(heldTurnRef);
  assert(cancel1 === 'requested' && cancel2 === 'requested', 'cancel is idempotent (requested twice)');
  assert(fake.providerCalls(codexState, 'cancelTurn') === cancelCalls, 'second cancel of a terminal turn makes no provider call');
  const heldView = ps.getProviderTurn(db, agents.codex.id, heldTurnRef);
  assert(heldView.state === 'cancelled', 'held turn ends cancelled');
  // The adapter-level held run observes with a deadline and cancels truthfully.
  const timed = await adapter.run(adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', {
    prompt: { kind: 'text', text: '[hold] adapter deadline' }, deadlineAt: Date.now() + 60, correlation: { attemptId: 'att-hold-deadline' },
  })));
  assert(timed.status === 'failed' && timed.failure.category === 'timed_out' && timed.externalRunId !== null, 'a held run past its deadline is timed_out with its run id');
  assert(timed.externalCancel === 'requested', 'deadline cancel is accepted by the runtime');
  const timedView = ps.getProviderTurn(db, agents.codex.id, timed.externalRunId);
  assert(timedView.state === 'cancelled', 'deadline leaves the provider turn cancelled, not running');
  // Missing and busy sessions fail stably without leaking diagnostics.
  const missing = await adapter.run(adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', {
    sessionBinding: { bindingId: 'b-1', externalSessionId: 'no-such-ref' }, correlation: { attemptId: 'att-fail-missing' },
  })));
  assert(missing.status === 'failed' && missing.failure.category === 'launch_failed' && CATEGORIES.has(missing.failure.category), 'unknown session ref fails launch_failed');
  assert(!SECRET.test(JSON.stringify(missing)) && missing.failure.message.length <= 500, 'failure carries no provider diagnostics and stays bounded');
  const busySession = sessionRefs.codex;
  await ps.sendProviderTurn(db, agents.codex.id, busySession, {
    prompt: '[hold] occupy session', authority: 'read_only', idempotencyKey: 'occupy-1',
    requester: { kind: 'service', id: 'botmancers-attempt' }, correlation: {},
  });
  const busyResult = await adapter.run(adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', {
    sessionBinding: { bindingId: 'b-2', externalSessionId: busySession }, correlation: { attemptId: 'att-fail-busy' },
  })));
  assert(busyResult.failure.category === 'launch_failed' && busyResult.failure.code === 'busy', 'a session with a turn in flight fails launch_failed/busy');
  // Clean the occupied session for later sections.
  const occupying = db.prepare("SELECT id FROM provider_session_turns WHERE session_ref = ? AND state = 'running' ORDER BY created_at DESC LIMIT 1").get(busySession);
  if (occupying) await ps.cancelProviderTurn(db, agents.codex.id, occupying.id, {});
  // Bounded output: an oversized stored output is cut with the flag.
  const big = await adapter.run(adapterContract.freezeAttemptInput(fixture(agents.codex.id, 'codex', { correlation: { attemptId: 'att-big-output' } })));
  const bigProviderTurn = db.prepare('SELECT provider_turn_id FROM provider_session_turns WHERE id = ?').get(big.externalRunId).provider_turn_id;
  const bigProviderSession = db.prepare('SELECT provider_session_id FROM provider_sessions WHERE id = ?').get(big.externalSessionId).provider_session_id;
  db.prepare('UPDATE provider_session_turns SET output = ? WHERE id = ?').run(`echo ${bigProviderTurn} ${bigProviderSession} ${'x'.repeat(40_000)}`, big.externalRunId);
  const followed = await adapter.reconciler.follow(big.externalRunId, { resumeSessionId: null, deadlineAt: null });
  assert(followed.status === 'completed' && followed.outputTruncated === true && (followed.output?.length ?? 0) <= attemptLib.SESSION_PROVIDER_ATTEMPT_OUTPUT_LIMIT, 'oversized output is bounded with outputTruncated');
  assert(!SECRET.test(followed.output ?? '') && /\[redacted\]/.test(followed.output ?? ''), 'bounded output redacts provider ids');
  // Observe failure after the provider lost the turn.
  const doomedStart = await ps.startProviderSession(db, agents.codex.id, {
    workspace: '/work/alpha', prompt: '[hold] doomed', authority: 'read_only',
    idempotencyKey: 'doomed-1', requester: { kind: 'service', id: 'botmancers-attempt' }, correlation: {},
  });
  const doomedRef = doomedStart.turn.turn_ref;
  const providerTurnId = db.prepare('SELECT provider_turn_id FROM provider_session_turns WHERE id = ?').get(doomedRef).provider_turn_id;
  fake.mutateFakeProvider(codexState, state => { delete state.turns[providerTurnId]; });
  const doomed = await adapter.reconciler.follow(doomedRef, { resumeSessionId: null, deadlineAt: null });
  assert(doomed.status === 'failed' && doomed.failure.category === 'runtime_failed', 'a turn the provider lost fails runtime_failed');
  assert(!SECRET.test(JSON.stringify(doomed)), 'observe failure leaks no provider diagnostics');

  console.log('\nNo Agent Deck contact on any adapter path');
  const source = fs.readFileSync(path.join(ROOT, 'lib/session-provider-attempt.ts'), 'utf8');
  assert(!/from '\.\/agent-deck/.test(source) && !/require\(.*agent-deck/.test(source), 'the adapter imports no Agent Deck module');
  assert(!fs.existsSync(path.join(ROOT, 'lib/agent-deck-run.ts')) && fetchCalls === 0, 'no Agent Deck run module to spawn and no network fetch');
  assert(dispatch.ATTEMPT_ADAPTERS && Object.keys(dispatch.ATTEMPT_ADAPTERS).sort().join(',') === 'hermes-gateway,session-provider', 'live dispatch selects the direct transports');

  console.log(`\nDone: ${failures} failure(s).`);
}

async function restart() {
  const ids = JSON.parse(process.env.NOT542_IDS || '{}');
  contract.clearSessionProviders({ builtins: true });
  // Re-register the claude fake on the same state file; the connection id
  // is recovered from the durable turn row, so no id must be passed.
  const turnRow = db.prepare('SELECT agent_id FROM provider_session_turns WHERE id = ?').get(ids.turnRef);
  const agentRow = dbModule.bots.getById(turnRow.agent_id);
  contract.registerSessionProvider({ connectionId: agentRow.runtime_connection_id }, () => fake.createFakeSessionProvider({ statePath: STATES.claude, kind: 'fake-claude' }));
  const adapter = attemptLib.createSessionProviderAttemptAdapter();
  console.log('inspect and follow the durable turn');

  const startsBefore = fake.providerCalls(STATES.claude, 'startSession');
  const sendsBefore = fake.providerCalls(STATES.claude, 'sendTurn');
  const inspected = await adapter.reconciler.inspect(ids.turnRef);
  assert(inspected.kind === 'run' && inspected.state === 'ended', 'inspect reads the durable terminal turn');
  const followed = await adapter.reconciler.follow(ids.turnRef, { resumeSessionId: null, deadlineAt: null });
  assert(followed.status === 'completed' && followed.output === ids.output && followed.externalSessionId === ids.sessionRef, 'follow returns the same terminal output and session ref');
  assert(followed.externalRunId === ids.turnRef, 'follow keeps the same turn ref');
  assert(fake.providerCalls(STATES.claude, 'startSession') === startsBefore && fake.providerCalls(STATES.claude, 'sendTurn') === sendsBefore, 'reattach spawns no second runtime process');
  assert(count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE id = ?', ids.turnRef) === 1, 'one provider turn row after restart');
  assert(fetchCalls === 0, 'no network call in the restarted process');

  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls, output: followed.output, sessionRef: followed.externalSessionId })}`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

// Held runs settle via cancel; keep the loop alive for the abort path.
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on('beforeExit', () => {
  if (!finished && !RESTART) { console.log('  FAIL: event loop drained before the test finished'); process.exit(1); }
});
