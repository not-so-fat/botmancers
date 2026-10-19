// NOT-509: deterministic session-usage fixture, shared by
// test-session-usage.js and scripts/seed-usage-fixture.js (the real-app
// visual proof). Seeds one Agent, Ledger, whose past sessions cover every
// usage state, written through the canonical engine store and the attempt
// executor's result path (lib/attempt-executor recordAttemptResult), so the
// samples are exactly what a real run would record:
//   claude   complete input/output/cost, launch + resume, large numbers
//   codex    token-only (Codex reports no cost): cost not reported
//   partial  tokens from one run, a second run interrupted (unknown)
//   zero     a provider-reported $0.00 cost (Cursor)
//   legacy   a session from before usage was recorded: nothing reported
'use strict';

const USAGE_BASE = Date.UTC(2026, 9, 16, 14, 0, 0);
const MIN = 60 * 1000;

// Expected aggregates, for the tests and the proof.
const EXPECTED = {
  claude: { input: 1_203_456, output: 45_678, cost: 3.34 },
  codex: { input: 52_310, output: 7_904 },
  partial: { input: 9_876, output: 1_234 },
};

function seedSessionUsage({ engine, bots, conversations }, executor) {
  const ledger = bots.create({ name: 'Ledger', title: 'Implementer', description: 'Usage fixture', agent: 'claude', deck_id: 'deck-builder' });
  const conv = conversations.getByBotId(ledger.id);
  const owner = { kind: 'person', id: 'local-owner' };
  let n = 0;

  const result = (at, usage, extra = {}) => ({
    status: 'completed', adapter: 'agent-deck-api', externalRunId: `usage-run-${n}`, externalSessionId: null, output: 'done', artifacts: [],
    startedAt: at, finishedAt: at + 3 * MIN, failure: null, usage, ...extra,
  });

  function request(intent, at, kind = 'implementation', parent = null) {
    const { request: made } = engine.createOrGetWorkRequest({
      sourceConversationId: conv.id, sourceEventId: `usage-msg-${++n}`, requester: owner, targetAgentId: ledger.id,
      intent, executionKind: kind, toolProfile: 'edit', idempotencyKey: `usage-${n}`, parentRequestId: parent, now: at,
    });
    engine.transitionWorkRequest(made.id, { from: 'queued', to: 'running', now: at });
    return made;
  }

  // One Attempt through the executor's terminal path, then its request.
  function run({ work, adapter, at, resume = null, outcome }) {
    const attempt = engine.createAttempt(work.id, {
      kind: resume ? 'resume' : 'launch', adapter, toolProfile: 'edit',
      launchSnapshot: { transport: 'agent-deck-api', agent: adapter, cwd: '/Users/owner/work/ledger', deck: 'builder' },
      resumedSessionBindingId: resume, now: at,
    });
    if (outcome.interrupted) {
      // What restart reconciliation records for a run that died: one
      // sample with every metric unknown, then the interrupted Attempt.
      engine.transaction(() => {
        engine.recordAttemptUsage(attempt.id, { usage: null, observedAt: at + 3 * MIN });
        engine.finishAttempt(attempt.id, { outcome: 'interrupted', errorCategory: 'interrupted', errorMessage: 'Run died.', now: at + 3 * MIN });
      });
      engine.transitionWorkRequest(work.id, { from: 'running', to: 'failed', reason: 'retryable', errorCode: 'interrupted', errorMessage: 'interrupted', now: at + 3 * MIN });
    } else {
      engine.transaction(() => executor.recordAttemptResult(engine, attempt.id, result(at, outcome.usage)));
      engine.transitionWorkRequest(work.id, { from: 'running', to: 'completed', now: at + 4 * MIN });
    }
    return attempt;
  }

  function session({ intent, adapter, at, secret, launch, resumes = [] }) {
    const work = request(intent, at);
    const attempt = run({ work, adapter, at, outcome: launch });
    const binding = engine.bindSession({
      agentId: ledger.id, adapter, externalSessionId: secret, conversationId: conv.id, requestId: work.id, sourceAttemptId: attempt.id, now: at + 5 * MIN,
    });
    resumes.forEach((outcome, i) => {
      const resumeAt = at + (10 + i * 10) * MIN;
      const revision = request(`${intent} (follow-up ${i + 1})`, resumeAt, 'revision', work.id);
      run({ work: revision, adapter, at: resumeAt, resume: binding.id, outcome });
    });
    return binding;
  }

  const claude = session({
    intent: 'Migrate the settings page to the new form kit', adapter: 'claude', at: USAGE_BASE + 60 * MIN, secret: 'usage-claude-SECRET',
    launch: { usage: { input_tokens: 18_240, output_tokens: 3_512, cost_usd: 0.4213, source: 'result', breakdown: { cache_read_input_tokens: 120_000 } } },
    resumes: [{ usage: { input_tokens: 1_185_216, output_tokens: 42_166, cost_usd: 2.9187, source: 'result' } }],
  });
  const codex = session({
    intent: 'Fix the flaky exchange ledger test', adapter: 'codex', at: USAGE_BASE + 40 * MIN, secret: 'usage-codex-SECRET',
    launch: { usage: { input_tokens: 52_310, output_tokens: 7_904, cost_usd: null, source: 'codex.turn_completed', breakdown: { cached_input_tokens: 31_000 } } },
  });
  const partial = session({
    intent: 'Investigate the restart reconciliation gap', adapter: 'codex', at: USAGE_BASE + 20 * MIN, secret: 'usage-partial-SECRET',
    launch: { usage: { input_tokens: 9_876, output_tokens: 1_234, cost_usd: null, source: 'codex.turn_completed' } },
    resumes: [{ interrupted: true }],
  });
  const zero = session({
    intent: 'Rename the avatar helpers', adapter: 'cursor', at: USAGE_BASE + 10 * MIN, secret: 'usage-zero-SECRET',
    launch: { usage: { input_tokens: 640, output_tokens: 128, cost_usd: 0, source: 'result' } },
  });
  // Before NOT-509 no sample was written: a conversation-only binding with
  // no Attempt.
  const legacy = engine.bindSession({ agentId: ledger.id, adapter: 'claude', externalSessionId: 'usage-legacy-SECRET', conversationId: conv.id, now: USAGE_BASE });

  return { agent: ledger, conversation: conv, sessions: { claude, codex, partial, zero, legacy } };
}

module.exports = { USAGE_BASE, EXPECTED, seedSessionUsage };
