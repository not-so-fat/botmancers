// NOT-496: deterministic session-catalog fixture, shared by
// test-session-catalog.js and scripts/ui-sessions-proof.js. Seeds two
// Agents with active and released Session Bindings through the canonical
// engine store (lib/engine-store): no row is written around it.
'use strict';

const BASE = Date.UTC(2026, 9, 15, 9, 0, 0);
const MIN = 60 * 1000;

// Every external provider session id the fixture writes. None may reach a
// normal response or the default UI.
const EXTERNAL_IDS = {
  replaced: 'prov-sess-7f3a-replaced-SECRET',
  implementation: 'prov-sess-9c1d-impl-SECRET',
  direct: 'prov-sess-2b8e-direct-SECRET',
  group: 'prov-sess-5e60-group-SECRET',
  other: 'prov-sess-0aa4-other-SECRET',
  requestOnly: 'prov-sess-3d71-request-only-SECRET',
  conversationOnly: 'prov-sess-81c2-conversation-only-SECRET',
};

function seedSessionCatalog({ engine, bots, groups, conversations }) {
  const dev = bots.create({ name: 'Dev', title: 'Implementer', description: 'Writes the code', agent: 'codex', deck_id: 'deck-builder' });
  const tank = bots.create({ name: 'Tank', title: 'Coordinator', description: 'Coordinates work', agent: 'hermes', deck_id: 'deck-builder' });
  const scout = bots.create({ name: 'Scout', title: 'Researcher', description: 'Reads things', agent: 'claude', deck_id: 'deck-builder' });
  const devConv = conversations.getByBotId(dev.id);
  const tankConv = conversations.getByBotId(tank.id);
  const scoutConv = conversations.getByBotId(scout.id);
  const room = groups.create('Design review', [dev.id, tank.id], undefined, { created_at: BASE });
  const roomConv = conversations.getByGroupId(room.id);
  let n = 0;

  function run({ conversation, agent, requester, intent, kind, parent = null, at, resume = null, snapshot }) {
    const { request } = engine.createOrGetWorkRequest({
      sourceConversationId: conversation.id, sourceEventId: `fixture-msg-${++n}`, requester, targetAgentId: agent.id,
      intent, executionKind: kind, toolProfile: kind === 'conversation' || kind === 'review' ? 'readonly' : 'edit',
      idempotencyKey: `fixture-${n}`, parentRequestId: parent, now: at,
    });
    engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running', now: at });
    const attempt = engine.createAttempt(request.id, {
      kind: resume ? 'resume' : 'launch', adapter: agent.agent, toolProfile: request.tool_profile,
      launchSnapshot: snapshot, resumedSessionBindingId: resume, now: at,
    });
    engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', now: at + 4 * MIN });
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', now: at + 4 * MIN });
    return { request, attempt };
  }

  const tankAsks = { kind: 'bot', id: tank.id };
  const owner = { kind: 'person', id: 'local-owner' };
  const workspace = { transport: 'agent-deck', cwd: '/Users/owner/work/botmancers', deck: 'builder' };

  // 1. An implementation Tank woke Dev for, from Tank's thread. Its first
  //    binding was replaced (ended); the replacement was resumed by a
  //    revision (active, newest activity).
  const impl = run({
    conversation: tankConv, agent: dev, requester: tankAsks, kind: 'implementation', at: BASE + 10 * MIN,
    intent: 'Add the session catalog read model\n\nUse the canonical session_bindings table.',
    snapshot: { ...workspace, agent: 'codex' },
  });
  const replaced = engine.bindSession({
    agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.replaced, conversationId: tankConv.id,
    requestId: impl.request.id, sourceAttemptId: impl.attempt.id, now: BASE + 14 * MIN,
  });
  const implementation = engine.bindSession({
    agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.implementation, conversationId: tankConv.id,
    requestId: impl.request.id, sourceAttemptId: impl.attempt.id, now: BASE + 20 * MIN,
  });
  run({
    conversation: tankConv, agent: dev, requester: tankAsks, kind: 'revision', parent: impl.request.id, at: BASE + 60 * MIN,
    intent: 'Address review findings on the session catalog', resume: implementation.id,
    snapshot: { ...workspace, agent: 'codex', session_binding_id: implementation.id },
  });

  // 2. A conversation-only binding in Dev's own thread, later released by
  //    a newer one in the same scope: the fallback title, ended.
  const direct = engine.bindSession({ agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.direct, conversationId: devConv.id, now: BASE + 5 * MIN });
  const directNext = engine.bindSession({ agentId: dev.id, adapter: 'codex', externalSessionId: `${EXTERNAL_IDS.direct}-next`, conversationId: devConv.id, now: BASE + 30 * MIN });

  // 3. A group-room binding: titled from the group, active.
  const group = engine.bindSession({ agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.group, conversationId: roomConv.id, now: BASE + 40 * MIN });

  // 4. Sparse scopes the engine store permits. A request-only binding
  //    (no conversation, no source Attempt): its conversation is the Work
  //    Request's source conversation, Dev's own thread.
  const ask = run({
    conversation: devConv, agent: dev, requester: owner, kind: 'conversation', at: BASE + 44 * MIN,
    intent: 'Explain the session binding lifecycle', snapshot: { transport: 'agent-deck', agent: 'codex' },
  });
  const requestOnly = engine.bindSession({ agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.requestOnly, requestId: ask.request.id, now: BASE + 46 * MIN });
  //    A conversation-only binding with a source Attempt: its Work Request,
  //    title, and launch context come from that Attempt.
  const summary = run({
    conversation: tankConv, agent: dev, requester: tankAsks, kind: 'review', at: BASE + 32 * MIN,
    intent: 'Summarize the open review threads', snapshot: { ...workspace, agent: 'codex' },
  });
  const conversationOnly = engine.bindSession({
    agentId: dev.id, adapter: 'codex', externalSessionId: EXTERNAL_IDS.conversationOnly, conversationId: tankConv.id,
    sourceAttemptId: summary.attempt.id, now: BASE + 34 * MIN,
  });

  // 5. Another Agent's session: never listed or disclosed under Dev.
  const own = run({
    conversation: scoutConv, agent: scout, requester: owner, kind: 'implementation', at: BASE + 50 * MIN,
    intent: 'Survey the MCP bridge docs', snapshot: { transport: 'agent-deck', agent: 'claude' },
  });
  const other = engine.bindSession({
    agentId: scout.id, adapter: 'claude', externalSessionId: EXTERNAL_IDS.other, conversationId: scoutConv.id,
    requestId: own.request.id, sourceAttemptId: own.attempt.id, now: BASE + 55 * MIN,
  });

  return {
    agents: { dev, tank, scout },
    conversations: { devConv, tankConv, scoutConv, roomConv },
    requests: { implementation: impl.request, ask: ask.request, summary: summary.request },
    bindings: { replaced, implementation, direct, directNext, group, requestOnly, conversationOnly, other },
  };
}

module.exports = { BASE, MIN, EXTERNAL_IDS, seedSessionCatalog };
