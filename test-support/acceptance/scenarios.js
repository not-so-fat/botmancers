// NOT-476: the deterministic core scenarios of the acceptance suite
// (test-acceptance-engine.js, docs/acceptance-harness.md).
//
// Each scenario runs in its own process and harness root with a context
// from ./engine-context.js, and asserts both layers:
//   [engine]        durable rows: wakes, work_requests, work_attempts,
//                   engine_events, session_bindings, safety decisions
//   [conversation]  the projected conversation (projector read model, also
//                   read back over HTTP where a route is involved) and the
//                   conversation's messages
// `fixtures` names the inputs each scenario drives (the --list output).
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const lastEntry = input => input.prompt.history[input.prompt.history.length - 1];
const startsFor = (fakeDeck, deckId) => fakeDeck.calls('POST', '/api/agent-runs').filter(call => call.body.deckId === deckId);

const SCENARIOS = [];
function scenario(name, title, fixtures, run, extra = {}) {
  SCENARIOS.push({ name, title, fixtures, run, ...extra });
}

// ---------------------------------------------------------------------
scenario('talk-answer', 'The owner talks to a coding Agent over the real UI route and gets its answer', [
  'owner -> Codex (codex) direct conversation: POST /api/conversations/{id}/messages on an ephemeral port',
  'fake Agent Deck run: one successful result',
  'GET /api/conversations/{id} (projection over HTTP); a foreign-origin POST',
], async ctx => {
  const codex = ctx.agent('Codex', 'codex');
  ctx.deckScripts.set(codex.deck_id, () => ({ result: 'The build is green.', sessionId: 'codex-session-1' }));
  const conversation = ctx.conversations.getByBotId(codex.id);
  const host = await ctx.routeHost();
  ctx.engineCheck(host.port !== 43123, `route host bound an ephemeral port (${host.port}), not the developer server port`);
  const sent = await host.owner('POST', `/api/conversations/${conversation.id}/messages`, { content: 'Is the build green?', idempotencyKey: 'talk-1' });
  const requestIds = sent.json && sent.json.intake ? sent.json.intake.requestIds : [];
  ctx.engineCheck(sent.status === 200 && requestIds.length === 1, `the owner message was accepted with one request (status ${sent.status})`);
  await ctx.settle(requestIds);

  const [request, ...others] = ctx.requestsIn(conversation.id);
  ctx.engineCheck(request && request.id === requestIds[0] && others.length === 0, 'one Work Request for the message');
  ctx.engineCheck(request.state === 'completed' && request.execution_kind === 'conversation' && request.tool_profile === 'readonly',
    `request completed as a read-only conversation turn (got ${request.state}/${request.execution_kind}/${request.tool_profile})`);
  const attempts = ctx.attemptsOf(request.id);
  ctx.engineCheck(attempts.length === 1 && attempts[0].outcome === 'succeeded' && /^run-/.test(attempts[0].external_run_id || ''),
    `one succeeded Attempt carrying the Agent Deck run id (got ${attempts.map(a => `${a.outcome}:${a.external_run_id}`)})`);
  const starts = startsFor(ctx.fakeDeck, codex.deck_id);
  ctx.engineCheck(starts.length === 1 && starts[0].body.tools === 'readonly' && starts[0].body.cwd === ctx.workspace,
    'exactly one Agent Deck run, read-only, in the disposable workspace');
  ctx.engineCheck(ctx.inOrder(ctx.eventTypes(request.id), ['accepted', 'state_changed', 'runtime_started', 'state_changed']),
    `engine events accepted > running > runtime_started > completed (got ${ctx.eventTypes(request.id).join(',')})`);

  const messages = ctx.messagesIn(conversation.id);
  ctx.conversationCheck(messages.length === 2 && messages[0].content === 'Is the build green?' && messages[1].content === 'The build is green.'
    && messages[1].sender_id === codex.id && messages[1].request_id === request.id, 'thread: the question, then Codex\'s answer linked to its request');
  const kinds = ctx.projectedKinds(conversation.id, view => view.requestId === request.id);
  ctx.conversationCheck(ctx.inOrder(kinds, ['request_queued', 'request_running', 'request_completed', 'result']),
    `projection queued > running > completed > result (got ${kinds.join(',')})`);
  const read = await host.owner('GET', `/api/conversations/${conversation.id}`);
  const httpKinds = read.json && Array.isArray(read.json.events) ? read.json.events.map(view => view.kind) : null;
  ctx.conversationCheck(read.status === 200 && JSON.stringify(httpKinds) === JSON.stringify(ctx.projectedKinds(conversation.id)),
    `GET /api/conversations/{id} over HTTP returns the same projection (status ${read.status})`);
  const thread = await host.owner('GET', `/api/conversations/${conversation.id}/messages`);
  ctx.conversationCheck(thread.status === 200 && Array.isArray(thread.json) && thread.json.map(m => m.content).join('|') === 'Is the build green?|The build is green.',
    'GET /api/conversations/{id}/messages over HTTP returns the thread');

  const before = ctx.counts();
  const replay = await host.owner('POST', `/api/conversations/${conversation.id}/messages`, { content: 'Is the build green?', idempotencyKey: 'talk-1' });
  ctx.engineCheck(replay.status === 200 && replay.json.intake.replayed === true && ctx.sameCounts(before, ctx.counts()) && startsFor(ctx.fakeDeck, codex.deck_id).length === 1,
    'resending the same submission replays: no new message, request, or run');
  const foreign = await host.foreign('POST', `/api/conversations/${conversation.id}/messages`, { content: 'hi' });
  ctx.engineCheck(foreign.status === 403 && ctx.sameCounts(before, ctx.counts()), 'a foreign-origin POST is refused 403 by the owner boundary; nothing persisted');
});

module.exports = { SCENARIOS };
