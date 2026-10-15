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

const path = require('path');
const { spawn } = require('child_process');

const startsFor = (fakeDeck, deckId) => fakeDeck.calls('POST', '/api/agent-runs').filter(call => call.body.deckId === deckId);

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

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

// ---------------------------------------------------------------------
scenario('duplicate-wake', 'A Wake delivered twice (replay, re-routing, restart recovery) runs once', [
  'person -> Tank (hermes coordinator, scripted) via the Agent API service',
  'Tank reply: one botmancers-wake block to Codex (conversation)',
  'replays: same person idempotency key, routeAgentWakes on the same reply, continueAfterTerminal, recoverCoordinatorLoops',
], async ctx => {
  const tank = ctx.agent('Tank', 'hermes');
  const codex = ctx.agent('Codex', 'codex');
  ctx.deckScripts.set(codex.deck_id, () => ({ result: 'Build is green on main.' }));
  const accepted = await ctx.ask(tank, 'Ask Codex whether the build is green.', 'dup-1', [
    () => `Asking Codex.\n${ctx.block({ target: 'Codex', executionKind: 'conversation', objective: 'Is the build on main green?' })}`,
    () => 'Codex confirms the build is green.',
  ]);
  const conv = accepted.conversationId;
  const [first, codexTurn, continuation, ...rest] = ctx.requestsIn(conv);
  ctx.engineCheck(first && codexTurn && continuation && rest.length === 0, `three requests: Tank, Codex, Tank continuation (got ${ctx.requestsIn(conv).length})`);
  ctx.engineCheck(ctx.requestsIn(conv).every(r => r.state === 'completed'), 'every request completed');
  const wakes = ctx.wakesIn(conv);
  ctx.engineCheck(wakes.length === 1 && wakes[0].status === 'accepted' && wakes[0].work_request_id === codexTurn.id, 'one accepted Wake owns the Codex request');
  ctx.engineCheck(startsFor(ctx.fakeDeck, codex.deck_id).length === 1, 'one Agent Deck run for Codex');

  const before = ctx.counts();
  const replay = ctx.service.acceptAgentMessage(ctx.PERSON, { agentId: tank.id, content: 'Ask Codex whether the build is green.', idempotencyKey: 'dup-1' });
  await replay.dispatched;
  ctx.engineCheck(replay.accepted.replayed === true && replay.accepted.requestId === first.id, 'the same person message replays its original request');
  const tankReply = ctx.messagesIn(conv).find(m => m.request_id === first.id && m.sender_id === tank.id);
  const rerouted = ctx.router.routeAgentWakes({ sourceEventId: tankReply.id, parentRequestId: first.id });
  ctx.engineCheck(rerouted.length === 1 && rerouted[0].wake.id === wakes[0].id && rerouted[0].request.id === codexTurn.id, 're-routing the same reply returns the same Wake and request');
  ctx.engineCheck(ctx.lib('coordinator-loop.ts').continueAfterTerminal(codexTurn.id).length === 0, 'replaying the Codex follow-up creates no second continuation');
  await ctx.service.recoverCoordinatorLoops();
  await ctx.service.waitForAgentDispatchIdle();
  ctx.engineCheck(ctx.sameCounts(before, ctx.counts()), `no new rows after every replay (before ${JSON.stringify(before)}, after ${JSON.stringify(ctx.counts())})`);
  ctx.engineCheck(startsFor(ctx.fakeDeck, codex.deck_id).length === 1 && ctx.attemptsOf(codexTurn.id).length === 1, 'still one run and one Attempt for Codex');

  const thread = ctx.messagesIn(conv).map(m => (m.sender_type === 'user' ? 'person' : ctx.bots.getById(m.sender_id).name));
  ctx.conversationCheck(JSON.stringify(thread) === JSON.stringify(['person', 'Tank', 'Codex', 'Tank']), `thread person > Tank > Codex > Tank (got ${thread.join(' > ')})`);
  const wakeViews = ctx.projection(conv).filter(view => view.kind === 'wake_accepted');
  ctx.conversationCheck(wakeViews.length === 1 && wakeViews[0].requestId === codexTurn.id, 'the projection shows the Wake accepted exactly once');
  ctx.conversationCheck(ctx.projectedKinds(conv, view => view.kind === 'result').length === 3, 'three results projected (no duplicate)');
});

// ---------------------------------------------------------------------
scenario('unavailable-target', 'Wakes to a missing Agent and to an unlaunchable Agent are reported, then the blocked one recovers', [
  'Tank reply: Wake to "Ghost" (no such Agent) and to Researcher (hermes; gateway unconfigured)',
  'owner POST /api/wakes/{id}/retry on an ephemeral port after Researcher becomes available',
], async ctx => {
  const tank = ctx.agent('Tank', 'hermes');
  const researcher = ctx.agent('Researcher', 'hermes');
  ctx.hermesScripts.set(researcher.id, () => 'Research summary: three prior incidents.');
  const accepted = await ctx.ask(tank, 'Get me research on past incidents.', 'unavail-1', [
    () => `Waking two helpers.\n${ctx.block({ target: 'Ghost', executionKind: 'conversation', objective: 'Find incidents.' })}\n${ctx.block({ target: 'Researcher', executionKind: 'conversation', objective: 'Summarize past incidents.' })}`,
    () => 'Ghost is not an Agent here; Researcher is not reachable yet.',
    () => 'Researcher found three prior incidents.',
  ]);
  const conv = accepted.conversationId;
  const wakes = ctx.wakesIn(conv);
  const ghost = wakes.find(w => w.requested_target === 'Ghost');
  const blocked = wakes.find(w => w.requested_target === 'Researcher');
  ctx.engineCheck(ghost && ghost.status === 'unavailable' && ghost.reason_code === 'target_not_found' && !ghost.work_request_id,
    `Ghost: Wake unavailable/target_not_found with no request (got ${ghost && `${ghost.status}/${ghost.reason_code}`})`);
  const blockedRequest = blocked && ctx.engine.getWorkRequest(blocked.work_request_id);
  ctx.engineCheck(blocked && blocked.status === 'blocked' && blocked.reason_code === 'target_unavailable' && blockedRequest && blockedRequest.state === 'blocked'
    && ctx.attemptsOf(blockedRequest.id).length === 0, `Researcher: Wake and request blocked (target_unavailable), no Attempt (got ${blocked && `${blocked.status}/${blocked.reason_code}`})`);
  const outcome = ctx.requestsIn(conv).find(r => r.idempotency_key === `continuation:v1:wakes:${ctx.messagesIn(conv)[1].id}`);
  ctx.engineCheck(outcome && outcome.state === 'completed' && outcome.target_agent_id === tank.id, 'Tank was continued once with the unstarted Wake outcome');
  const outcomeInput = ctx.coordinatorLaunches.find(launch => launch.request.id === (outcome && outcome.id));
  ctx.conversationCheck(outcomeInput && /Ghost/.test(ctx.lastEntry(outcomeInput.input).content), 'the continuation tells Tank that Ghost could not be woken');
  const blockedViews = ctx.projection(conv).filter(view => view.kind === 'wake_blocked' && view.wakeId === blocked.id);
  ctx.conversationCheck(blockedViews.length === 1 && /Researcher/.test(blockedViews[0].text) && JSON.stringify(blockedViews[0].data.actions) === '[]',
    `projection: Researcher Wake blocked, no owner action offered (got ${blockedViews.map(v => v.text)})`);
  // A Wake with no target creates no request; the conversation shows it
  // through the coordinator's continuation, whose result is projected.
  ctx.conversationCheck(!!outcome && ctx.inOrder(ctx.projectedKinds(conv, view => view.requestId === outcome.id), ['request_queued', 'request_completed', 'result'])
    && /Ghost is not an Agent/.test(ctx.messagesIn(conv).find(m => m.request_id === outcome.id).content), 'projection: Tank\'s continuation reports the missing Agent in the thread');

  // The target becomes reachable; the owner retries the Wake over HTTP.
  ctx.router.setWakeAvailabilityProbe(() => ({ available: true }));
  const host = await ctx.routeHost();
  const retried = await host.owner('POST', `/api/wakes/${blocked.id}/retry`);
  ctx.engineCheck(retried.status === 200, `POST /api/wakes/{id}/retry accepted (status ${retried.status})`);
  await ctx.settle([blockedRequest.id]);
  await ctx.settle(ctx.requestsIn(conv).map(r => r.id));
  const after = ctx.engine.getWorkRequest(blockedRequest.id);
  ctx.engineCheck(after.state === 'completed' && ctx.attemptsOf(after.id).length === 1, `the retried Researcher request completed with one Attempt (got ${after.state})`);
  ctx.engineCheck(ctx.router.getWake(blocked.id).status === 'accepted', 'the Wake is accepted after the retry');
  const thread = ctx.messagesIn(conv).map(m => (m.sender_type === 'user' ? 'person' : ctx.bots.getById(m.sender_id).name));
  ctx.conversationCheck(JSON.stringify(thread) === JSON.stringify(['person', 'Tank', 'Tank', 'Researcher', 'Tank']), `thread person > Tank > Tank > Researcher > Tank (got ${thread.join(' > ')})`);
  ctx.conversationCheck(ctx.inOrder(ctx.projectedKinds(conv, view => view.requestId === blockedRequest.id), ['wake_blocked', 'wake_accepted', 'request_running', 'request_completed']),
    `projection of the Researcher request: blocked > accepted > running > completed (got ${ctx.projectedKinds(conv, view => view.requestId === blockedRequest.id).join(',')})`);
});

// ---------------------------------------------------------------------
scenario('safety-denial', 'An edit Wake without a grant waits for the owner, who denies it; nothing runs', [
  'Tank reply: implementation Wake to Dev (claude) with no edit grant',
  'foreign-origin and owner POST /api/wakes/{id}/decision {decision: deny} on an ephemeral port',
], async ctx => {
  const tank = ctx.agent('Tank', 'hermes');
  const dev = ctx.agent('Dev', 'claude');
  const accepted = await ctx.ask(tank, 'Have Dev rewrite the uploader.', 'deny-1', [
    () => `Dev, please implement it.\n${ctx.block({ target: 'Dev', executionKind: 'implementation', objective: 'Rewrite the uploader.' })}`,
    () => 'The owner declined the edit work; nothing was changed.',
  ]);
  const conv = accepted.conversationId;
  const [wake] = ctx.wakesIn(conv);
  const request = wake && ctx.engine.getWorkRequest(wake.work_request_id);
  ctx.engineCheck(wake && wake.status === 'blocked' && wake.reason_code === 'grant_required', `Wake blocked: grant_required (got ${wake && `${wake.status}/${wake.reason_code}`})`);
  ctx.engineCheck(request && request.state === 'blocked' && request.tool_profile === 'edit' && ctx.attemptsOf(request.id).length === 0, 'edit request blocked, no Attempt');
  const decision = ctx.engine.latestSafetyDecision(request.id);
  ctx.engineCheck(decision && decision.decision === 'blocked' && decision.principal_type === 'agent_principal' && decision.target_agent_id === dev.id,
    `safety decision recorded: blocked for Agent caller -> Dev (got ${decision && `${decision.decision}/${decision.principal_type}`})`);
  const pending = ctx.projection(conv).filter(view => view.kind === 'wake_blocked' && view.wakeId === wake.id);
  ctx.conversationCheck(pending.length === 1 && JSON.stringify(pending[0].data.actions) === '["allow","deny"]', 'projection: Wake waits for the owner with Allow / Deny');

  const host = await ctx.routeHost();
  let before = ctx.counts();
  const forged = await host.foreign('POST', `/api/wakes/${wake.id}/decision`, { decision: 'allow' });
  ctx.engineCheck(forged.status === 403 && ctx.sameCounts(before, ctx.counts()) && ctx.engine.getWorkRequest(request.id).state === 'blocked',
    'a foreign-origin Allow is refused 403; the request stays blocked');
  const denied = await host.owner('POST', `/api/wakes/${wake.id}/decision`, { decision: 'deny' });
  ctx.engineCheck(denied.status === 200 && denied.json.requestState === 'cancelled', `owner Deny over HTTP cancels the request (got ${denied.status} ${denied.text})`);
  await ctx.settle(ctx.requestsIn(conv).map(r => r.id));
  ctx.engineCheck(ctx.engine.latestSafetyDecision(request.id).decision === 'denied', 'latest safety decision: denied');
  ctx.engineCheck(ctx.attemptsOf(request.id).length === 0 && startsFor(ctx.fakeDeck, dev.deck_id).length === 0, 'no Attempt and no Agent Deck run for Dev, ever');
  ctx.engineCheck(ctx.one('SELECT COUNT(*) AS n FROM wake_grants').n === 0, 'no grant was created');
  before = ctx.counts();
  const again = await host.owner('POST', `/api/wakes/${wake.id}/decision`, { decision: 'allow' });
  ctx.engineCheck(again.status >= 400 && ctx.engine.getWorkRequest(request.id).state === 'cancelled' && startsFor(ctx.fakeDeck, dev.deck_id).length === 0,
    `a later Allow cannot revive the denied Wake (status ${again.status})`);

  const kinds = ctx.projectedKinds(conv, view => view.requestId === request.id || view.wakeId === wake.id);
  ctx.conversationCheck(kinds.includes('wake_blocked') && !kinds.some(kind => ['request_running', 'request_completed', 'result'].includes(kind)),
    `projection: blocked then denied, nothing that implies work ran (got ${kinds.join(',')})`);
  const thread = ctx.messagesIn(conv).map(m => (m.sender_type === 'user' ? 'person' : ctx.bots.getById(m.sender_id).name));
  ctx.conversationCheck(JSON.stringify(thread) === JSON.stringify(['person', 'Tank', 'Tank']) && /declined/.test(ctx.messagesIn(conv).pop().content),
    `Tank is told of the denial and reports it (got ${thread.join(' > ')})`);
});

// ---------------------------------------------------------------------
scenario('composed-review', 'Implementation, independent review, and revision composed by the coordinator', [
  'Tank -> Dev implementation (owner Allow over HTTP) -> Tank -> Reviewer review -> Tank -> Dev revision (resumed session) -> Tank',
  'fake Agent Deck: Dev edit runs report a session; Reviewer finds one gap, then none',
], async ctx => {
  const tank = ctx.agent('Tank', 'hermes');
  const dev = ctx.agent('Dev', 'claude');
  const reviewer = ctx.agent('Reviewer', 'codex');
  ctx.deckScripts.set(dev.deck_id, body => (body.resumeSessionId
    ? { result: 'Revised: added the missing retry tests.' }
    : { result: 'Implemented: retry for the uploader.', sessionId: 'dev-session-1' }));
  let reviews = 0;
  ctx.deckScripts.set(reviewer.deck_id, () => ({ result: ++reviews === 1 ? 'Finding: missing tests for the retry path.' : 'Looks good. No findings.' }));
  const workRequestIn = input => /Work Request: (\S+)/.exec(ctx.lastEntry(input).content)[1];
  const accepted = await ctx.ask(tank, 'Implement retry for the uploader and get it reviewed.', 'compose-1', [
    () => `Dev will implement it.\n${ctx.block({ target: 'Dev', executionKind: 'implementation', objective: 'Add retry to the uploader.' })}`,
    input => `Reviewer, please check.\n${ctx.block({ target: 'Reviewer', executionKind: 'review', objective: 'Review the uploader retry.', contextWorkRequests: [workRequestIn(input)] })}`,
    (input, request) => {
      const impl = ctx.requestsIn(request.source_conversation_id).find(r => r.execution_kind === 'implementation');
      return `Dev, please revise.\n${ctx.block({ target: 'Dev', executionKind: 'revision', objective: 'Add the missing retry tests.', resumeWorkRequest: impl.id, contextWorkRequests: [workRequestIn(input)] })}`;
    },
    input => `Revised; one more review.\n${ctx.block({ target: 'Reviewer', executionKind: 'review', objective: 'Re-review.', contextWorkRequests: [workRequestIn(input)] })}`,
    () => 'Final: retry implemented, revised with tests, and approved by Reviewer.',
  ]);
  const conv = accepted.conversationId;
  const [wake] = ctx.wakesIn(conv);
  ctx.engineCheck(wake && wake.status === 'blocked' && wake.reason_code === 'grant_required', 'the first edit Wake waits for the owner');
  const host = await ctx.routeHost();
  const allowed = await host.owner('POST', `/api/wakes/${wake.id}/decision`, { decision: 'allow' });
  ctx.engineCheck(allowed.status === 200 && !!allowed.json.grantId, `owner Allow over HTTP records a grant (status ${allowed.status})`);
  await ctx.settle([wake.work_request_id]);
  // The loop runs to completion: wait for every request it creates.
  for (let round = 0; round < 20; round += 1) {
    await ctx.settle(ctx.requestsIn(conv).map(r => r.id));
    if (ctx.messagesIn(conv).some(m => /^Final:/.test(m.content))) break;
  }

  const requests = ctx.requestsIn(conv);
  const kinds = requests.map(r => `${ctx.bots.getById(r.target_agent_id).name}:${r.execution_kind}`);
  ctx.engineCheck(JSON.stringify(kinds) === JSON.stringify(['Tank:conversation', 'Dev:implementation', 'Tank:conversation', 'Reviewer:review', 'Tank:conversation',
    'Dev:revision', 'Tank:conversation', 'Reviewer:review', 'Tank:conversation']), `requests alternate coordinator and specialists (got ${kinds.join(', ')})`);
  ctx.engineCheck(requests.every(r => r.state === 'completed'), `every request completed (got ${requests.map(r => r.state).join(',')})`);
  const impl = requests[1];
  const review = requests[3];
  const revision = requests[5];
  ctx.engineCheck(impl.tool_profile === 'edit' && review.tool_profile === 'readonly' && revision.tool_profile === 'edit', 'edit for implementation/revision, read-only for review');
  ctx.engineCheck(review.target_agent_id !== impl.target_agent_id, 'the reviewer is independent of the developer');
  const binding = ctx.engine.getActiveSessionBinding({ agentId: dev.id, adapter: 'claude', conversationId: conv, requestId: impl.id });
  const revAttempts = ctx.attemptsOf(revision.id);
  ctx.engineCheck(binding && binding.external_session_id === 'dev-session-1' && revAttempts.length === 1 && revAttempts[0].kind === 'resume'
    && revAttempts[0].resumed_session_binding_id === binding.id, 'the revision resumed the implementation session binding');
  const devStarts = startsFor(ctx.fakeDeck, dev.deck_id);
  ctx.engineCheck(devStarts.length === 2 && devStarts[0].body.tools === 'edit' && devStarts[1].body.resumeSessionId === 'dev-session-1',
    'two Dev runs: implementation, then revision resuming dev-session-1');
  ctx.engineCheck(startsFor(ctx.fakeDeck, reviewer.deck_id).every(call => call.body.tools === 'readonly') && startsFor(ctx.fakeDeck, reviewer.deck_id).length === 2, 'two read-only Reviewer runs');

  const thread = ctx.messagesIn(conv).map(m => (m.sender_type === 'user' ? 'person' : ctx.bots.getById(m.sender_id).name));
  ctx.conversationCheck(JSON.stringify(thread) === JSON.stringify(['person', 'Tank', 'Dev', 'Tank', 'Reviewer', 'Tank', 'Dev', 'Tank', 'Reviewer', 'Tank']),
    `thread alternates coordinator and specialists (got ${thread.join(' > ')})`);
  ctx.conversationCheck(/^Final:/.test(ctx.messagesIn(conv).pop().content), 'Tank reports the final result in the source conversation');
  const accepts = ctx.projection(conv).filter(view => view.kind === 'wake_accepted').map(view => view.data.execution_kind);
  ctx.conversationCheck(JSON.stringify(accepts) === JSON.stringify(['implementation', 'review', 'revision', 'review']), `projection: four Wakes accepted in order (got ${accepts.join(',')})`);
  ctx.conversationCheck(ctx.projectedKinds(conv, view => view.requestId === impl.id).includes('wake_blocked'), 'projection keeps the implementation Wake\'s wait for the owner');
});

// ---------------------------------------------------------------------
scenario('lifecycle-controls', 'Cancellation, deadline timeout, and bounded retry of running work', [
  'Holdout (codex): held Agent Deck run, cancelled by the person through the Agent API service',
  'Slowpoke (codex): held run under BOTMANCERS_REQUEST_DEADLINE_MS=300, enforced by the recovery sweep',
  'Flaky (codex): BOTMANCERS_RETRY_MAX_ATTEMPTS=2; first run errors, second succeeds',
], async ctx => {
  const send = (agent, content, key) => ctx.service.acceptAgentMessage(ctx.PERSON, { agentId: agent.id, content, idempotencyKey: key }).accepted;
  const launched = requestId => () => ctx.attemptsOf(requestId).some(a => a.external_run_id && a.finished_at === null);

  // Cancellation of a running request.
  const holdout = ctx.agent('Holdout', 'codex');
  ctx.deckScripts.set(holdout.deck_id, () => ({ result: 'This answer must never be shown.', hold: true }));
  const cancelled = send(holdout, 'Start a long analysis.', 'cancel-1');
  await waitFor(launched(cancelled.requestId), 'the Holdout run to start');
  const cancel = await ctx.service.cancelAgentRequest(ctx.PERSON, cancelled.requestId, 'No longer needed.');
  ctx.engineCheck(cancel.outcome === 'cancel_requested' || cancel.outcome === 'cancelled', `cancel accepted for running work (got ${cancel.outcome})`);
  await ctx.settle([cancelled.requestId]);
  const c = ctx.engine.getWorkRequest(cancelled.requestId);
  const cAttempts = ctx.attemptsOf(c.id);
  ctx.engineCheck(c.state === 'cancelled' && c.cancel_requested_at !== null, `request cancelled with its intent recorded (got ${c.state})`);
  ctx.engineCheck(cAttempts.length === 1 && cAttempts[0].finished_at !== null && cAttempts[0].outcome !== 'succeeded', `the Attempt ended without success (got ${cAttempts.map(a => a.outcome)})`);
  ctx.engineCheck(ctx.fakeDeck.calls('POST', '/cancel').some(call => call.path.includes(cAttempts[0].external_run_id)), 'Agent Deck was asked to cancel the run');
  const cKinds = ctx.projectedKinds(cancelled.conversationId, view => view.requestId === c.id);
  ctx.conversationCheck(cKinds.includes('request_cancel_requested') && !cKinds.includes('request_completed') && !cKinds.includes('result'),
    `projection: cancel requested, never completed (got ${cKinds.join(',')})`);
  ctx.conversationCheck(!ctx.messagesIn(cancelled.conversationId).some(m => /never be shown/.test(m.content)), 'the cancelled run\'s answer is not in the thread');

  // A request deadline passes while its run is held.
  const slowpoke = ctx.agent('Slowpoke', 'codex');
  ctx.deckScripts.set(slowpoke.deck_id, () => ({ result: 'Too late.', hold: true }));
  process.env.BOTMANCERS_REQUEST_DEADLINE_MS = '300';
  const timed = send(slowpoke, 'Answer within the deadline.', 'deadline-1');
  delete process.env.BOTMANCERS_REQUEST_DEADLINE_MS;
  await waitFor(launched(timed.requestId), 'the Slowpoke run to start');
  const t0 = ctx.engine.getWorkRequest(timed.requestId);
  ctx.engineCheck(t0.deadline_at !== null && t0.deadline_at - t0.created_at === 300, 'the request stored its 300ms deadline at intake');
  await waitFor(() => Date.now() > t0.deadline_at + 20, 'the deadline to pass');
  await ctx.service.sweepDispatch();
  await ctx.settle([timed.requestId]);
  const t = ctx.engine.getWorkRequest(timed.requestId);
  ctx.engineCheck(t.state === 'failed' && t.error_code === 'timed_out', `request failed timed_out (got ${t.state}/${t.error_code})`);
  ctx.engineCheck(ctx.attemptsOf(t.id).length === 1 && ctx.attemptsOf(t.id)[0].outcome === 'timed_out', `its Attempt ended timed_out (got ${ctx.attemptsOf(t.id).map(a => a.outcome)})`);
  const tRun = ctx.attemptsOf(t.id)[0].external_run_id;
  ctx.engineCheck(ctx.fakeDeck.calls('POST', '/cancel').some(call => call.path.includes(tRun)) && ctx.fakeDeck.runs.get(tRun).state === 'canceled',
    'the run past its deadline was cancelled in Agent Deck');
  const tKinds = ctx.projectedKinds(timed.conversationId, view => view.requestId === t.id);
  ctx.conversationCheck(tKinds.includes('request_timed_out') && !tKinds.includes('result'), `projection: timed out, no result (got ${tKinds.join(',')})`);

  // A retryable failure is retried once under the stored policy.
  const flaky = ctx.agent('Flaky', 'codex');
  let flakyRuns = 0;
  ctx.deckScripts.set(flaky.deck_id, () => (++flakyRuns === 1 ? { state: 'error', errorMessage: 'transient failure' } : { result: 'Second time lucky.' }));
  process.env.BOTMANCERS_RETRY_MAX_ATTEMPTS = '2';
  process.env.BOTMANCERS_RETRY_BASE_DELAY_MS = '20';
  const retried = send(flaky, 'Try the flaky thing.', 'retry-1');
  delete process.env.BOTMANCERS_RETRY_MAX_ATTEMPTS;
  delete process.env.BOTMANCERS_RETRY_BASE_DELAY_MS;
  await ctx.settle([retried.requestId]);
  const r = ctx.engine.getWorkRequest(retried.requestId);
  const rAttempts = ctx.attemptsOf(r.id);
  ctx.engineCheck(r.state === 'completed' && JSON.parse(r.retry_policy).max_attempts === 2, `request completed under a stored 2-Attempt policy (got ${r.state})`);
  ctx.engineCheck(rAttempts.length === 2 && rAttempts[0].outcome === 'failed' && rAttempts[1].outcome === 'succeeded' && flakyRuns === 2,
    `two Attempts: failed, then succeeded (got ${rAttempts.map(a => a.outcome)})`);
  const rKinds = ctx.projectedKinds(retried.conversationId, view => view.requestId === r.id);
  ctx.conversationCheck(ctx.inOrder(rKinds, ['request_queued', 'request_running', 'request_retry_scheduled', 'request_running', 'request_completed', 'result']),
    `projection: running > retry scheduled > running > completed (got ${rKinds.join(',')})`);
  ctx.conversationCheck(ctx.messagesIn(retried.conversationId).map(m => m.content).join('|') === 'Try the flaky thing.|Second time lucky.', 'the thread shows only the successful answer');

  // A finished request cannot be retried or cancelled into new work.
  const before = ctx.counts();
  const late = await ctx.service.retryAgentRequest(ctx.PERSON, r.id);
  const lateCancel = await ctx.service.cancelAgentRequest(ctx.PERSON, r.id, 'too late');
  await ctx.service.waitForAgentDispatchIdle();
  ctx.engineCheck(late.outcome === 'already_terminal' && lateCancel.outcome === 'already_terminal' && ctx.counts().work_attempts === before.work_attempts,
    `retry/cancel of completed work change nothing (got ${late.outcome}/${lateCancel.outcome})`);
});

// ---------------------------------------------------------------------
// A separate Botmancers process, sharing this scenario's database and
// environment (both inside the harness root).
function runWorker(role, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'restart-worker.js')], {
      env: { ...process.env, BOTMANCERS_RESTART_ROLE: role, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => resolve({ code, out, err }));
  });
}

scenario('restart-recovery', 'A worker crashes mid-run; a restarted process reattaches without a duplicate launch', [
  'fake Agent Deck served over loopback HTTP (ephemeral port) and stored as the harness database\'s Agent Deck URL',
  'worker 1: person -> Codex (codex); exits right after the run id is persisted (held run)',
  'worker 2: fresh process; startup recovery (recoverCoordinatorLoops) after the run ended',
], async ctx => {
  const codex = ctx.agent('Codex', 'codex');
  ctx.deckScripts.set(codex.deck_id, () => ({ result: 'Recovered answer: the cache is warm.', hold: true }));
  const url = await ctx.fakeDeck.listen();
  ctx.lib('agent-deck-settings.ts').setAgentDeckServerUrl(url);
  try {
    const crash = await runWorker('crash', { BOTMANCERS_RESTART_AGENT_ID: codex.id, BOTMANCERS_RESTART_CONTENT: 'Is the cache warm?' });
    ctx.engineCheck(crash.code === 70, `worker 1 crashed at the injected point (exit ${crash.code}${crash.err ? `; ${crash.err.slice(-300)}` : ''})`);
    const [request] = ctx.all('SELECT * FROM work_requests WHERE target_agent_id = ?', codex.id);
    const [attempt] = request ? ctx.attemptsOf(request.id) : [];
    ctx.engineCheck(request && request.state === 'running' && attempt && attempt.finished_at === null && !!attempt.external_run_id,
      `after the crash: request running, one open Attempt with its run id (got ${request && request.state})`);
    const lease = ctx.one('SELECT owner FROM dispatch_leases WHERE request_id = ?', request.id);
    ctx.engineCheck(lease && lease.owner.split(':')[1] !== String(process.pid), 'the crashed worker still holds the lease');
    ctx.conversationCheck(!ctx.projectedKinds(request.source_conversation_id).includes('request_completed') && ctx.messagesIn(request.source_conversation_id).length === 1,
      'before recovery the conversation shows the question and running work, no answer');

    // The run finishes while no Botmancers process is alive.
    ctx.fakeDeck.release(attempt.external_run_id);
    const recover = await runWorker('recover', {});
    ctx.engineCheck(recover.code === 0, `worker 2 recovered and exited cleanly (exit ${recover.code}${recover.err ? `; ${recover.err.slice(-300)}` : ''})`);

    const after = ctx.engine.getWorkRequest(request.id);
    const attempts = ctx.attemptsOf(request.id);
    ctx.engineCheck(after.state === 'completed' && attempts.length === 1 && attempts[0].outcome === 'succeeded', `request completed on the original Attempt (got ${after.state}, ${attempts.length} Attempt(s))`);
    ctx.engineCheck(startsFor(ctx.fakeDeck, codex.deck_id).length === 1, 'Agent Deck saw exactly one launch (no duplicate)');
    const decided = ctx.engine.listEvents(request.id).filter(event => event.type === 'reconcile_decided').map(event => JSON.parse(event.data).action);
    ctx.engineCheck(ctx.eventTypes(request.id).includes('dispatch_lease_taken_over') && decided.includes('reattach'), `recovery took the lease over and reattached (decisions: ${decided.join(',')})`);
    ctx.engineCheck(!ctx.one('SELECT 1 AS x FROM dispatch_leases WHERE request_id = ?', request.id), 'no lease is left behind');
    const messages = ctx.messagesIn(request.source_conversation_id);
    ctx.conversationCheck(messages.length === 2 && messages[1].content === 'Recovered answer: the cache is warm.' && messages[1].request_id === request.id,
      'the thread shows the answer exactly once');
    const kinds = ctx.projectedKinds(request.source_conversation_id, view => view.requestId === request.id);
    ctx.conversationCheck(ctx.inOrder(kinds, ['request_queued', 'request_running', 'request_completed', 'result']) && kinds.filter(kind => kind === 'result').length === 1,
      `projection: queued > running > completed > one result (got ${kinds.join(',')})`);
  } finally {
    await ctx.fakeDeck.close();
  }
});

// ---------------------------------------------------------------------
// Harness self-test only (never in the default run): a scenario that
// fails on purpose, so test-acceptance-harness.js can prove a failing
// root is preserved with a useful FAILED.txt.
scenario('self-test-failure', 'Deliberately failing scenario (harness self-test only)', [
  'person -> Codex; then one assertion that is false on purpose',
], async ctx => {
  const codex = ctx.agent('Codex', 'codex');
  const accepted = await ctx.ask(codex, 'Hello?', 'self-test-1');
  ctx.engineCheck(ctx.engine.getWorkRequest(accepted.requestId).state === 'completed', 'the request completed');
  ctx.conversationCheck(ctx.messagesIn(accepted.conversationId).length === 99, 'deliberate failure: the thread has 99 messages');
}, { selfTestOnly: true });

module.exports = { SCENARIOS };
