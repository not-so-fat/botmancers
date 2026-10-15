#!/usr/bin/env node
// NOT-472: coordinator-led developer/reviewer revision loops
// (lib/coordinator-loop, lib/wake-router, lib/agent-conversations).
//
// Proves through the canonical dispatcher, with deterministic scripted
// runtimes (no network, no agent-deck child):
//
// - a developer result is projected into the source conversation and
//   continues the original coordinator exactly once (read-only), with the
//   canonical Work Request reference and result evidence and no external
//   run/session identifiers;
// - implementation completion alone launches no reviewer; the coordinator
//   emits the separate review Wake and chooses a distinct reviewer;
// - named reviewers are preserved; developer-as-reviewer, ambiguous, and
//   unavailable reviewers lead the coordinator to ask the person, with no
//   review recorded as having run;
// - a revision resumes the original developer's Session Binding with edit
//   authority; cross-lineage, other-target, and sessionless references fail
//   closed;
// - reviewer and revision results return to the coordinator across several
//   cycles until it is satisfied, and a runaway loop is stopped by limits;
// - replay and database reopen create no duplicate continuations, review
//   requests, or revision Attempts, and a continuation lost to a crash is
//   recovered exactly once.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SCENARIO = process.env.COORDINATOR_LOOP_SCENARIO || 'main';
const DB_PATH = process.env.COORDINATOR_LOOP_DB || path.join(os.tmpdir(), `botmancers-coordinator-loop-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
if (SCENARIO === 'main') removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-coordinator-loop-home-'));
delete process.env.HERMES_API_SERVER_KEY;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

const db = jiti('./lib/db.ts');
const service = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const router = jiti('./lib/wake-router.ts');
const loop = jiti('./lib/coordinator-loop.ts');
const raw = db.default;
const { bots, engine, projector } = db;

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}

const PERSON = { kind: 'person', id: 'owner' };
const TABLES = ['wakes', 'work_requests', 'work_attempts', 'session_bindings', 'messages'];
function counts() {
  return Object.fromEntries(TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}
function sameCounts(a, b) {
  return TABLES.every(table => a[table] === b[table]);
}
function block(envelope) {
  return '```botmancers-wake\n' + JSON.stringify({ version: 1, ...envelope }, null, 2) + '\n```';
}
function requestsIn(conversationId) {
  return raw.prepare('SELECT * FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(conversationId);
}
function continuationsOf(requestId) {
  return raw.prepare("SELECT * FROM work_requests WHERE requester_kind = 'service' AND idempotency_key = ?").all(`continuation:v1:result:${requestId}`);
}
function messagesIn(conversationId) {
  return raw.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC').all(conversationId);
}
function lastEntry(input) {
  const history = input.prompt.history;
  return history[history.length - 1];
}

// ---- scripted runtimes ---------------------------------------------------
// Coordinator turns follow a per-conversation plan; specialists answer by
// Agent. Every launch is recorded with its input.
const launches = [];
const plans = new Map();
const specialists = new Map();
let runCounter = 0;

function conversationOf(input) {
  return engine.getWorkRequest(input.correlation.requestId).source_conversation_id;
}

function scriptedAdapter(transport) {
  return {
    name: transport,
    async run(input, onEvent) {
      // Yield first, as a real runtime does, so a plan registered right
      // after acceptance is in place.
      await new Promise(resolve => setImmediate(resolve));
      const request = engine.getWorkRequest(input.correlation.requestId);
      const runId = `run-${++runCounter}`;
      launches.push({ input, request, runId });
      onEvent && onEvent({ type: 'started', adapter: transport, at: Date.now(), externalRunId: runId, externalSessionId: null });
      let reply;
      const specialist = specialists.get(input.target.agentId);
      if (specialist) {
        reply = specialist(input, request);
      } else {
        const plan = plans.get(conversationOf(input)) || [];
        const step = plan.shift();
        reply = step ? { output: step(input, request) } : { output: 'Nothing more to do.' };
      }
      const sessionId = input.sessionBinding ? input.sessionBinding.externalSessionId : reply.sessionId ?? null;
      if (reply.fail) {
        return { status: 'failed', adapter: transport, externalRunId: runId, externalSessionId: sessionId, output: null, artifacts: [], startedAt: Date.now(), finishedAt: Date.now(), failure: { category: 'runtime_failed', code: null, message: 'scripted failure' } };
      }
      return { status: 'completed', adapter: transport, externalRunId: runId, externalSessionId: sessionId, output: reply.output, artifacts: [], startedAt: Date.now(), finishedAt: Date.now(), failure: null };
    },
  };
}

dispatch.setAttemptAdapterOverride(scriptedAdapter);
router.setWakeAvailabilityProbe(() => ({ available: true }));

async function ask(coordinator, content, key) {
  const { accepted, dispatched } = service.acceptAgentMessage(PERSON, { agentId: coordinator.id, content, idempotencyKey: key });
  await dispatched;
  await service.waitForAgentDispatchIdle();
  return accepted;
}

if (SCENARIO === 'restart') {
  runRestart().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
} else {
  runMain().then(ok => {
    removeDb(DB_PATH);
    process.exit(ok ? 0 : 1);
  }, error => {
    console.error(error);
    process.exit(1);
  });
}

// A fresh process on the same database: recover from durable rows only.
async function runRestart() {
  const before = counts();
  await service.recoverCoordinatorLoops();
  await service.waitForAgentDispatchIdle();
  const after = counts();
  process.stdout.write(`\nRESTART ${JSON.stringify({ before, after, launches: launches.map(l => l.request.id) })}\n`);
}

function restart(extraEnv = {}) {
  const run = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, COORDINATOR_LOOP_SCENARIO: 'restart', COORDINATOR_LOOP_DB: DB_PATH, ...extraEnv },
    encoding: 'utf8',
  });
  const line = (run.stdout || '').split('\n').find(l => l.startsWith('RESTART '));
  if (run.status !== 0 || !line) {
    console.log(run.stdout, run.stderr);
    return null;
  }
  return JSON.parse(line.slice('RESTART '.length));
}

async function runMain() {
  const tank = bots.create({ deck_id: 'deck-tank', name: 'Tank', title: 'Coordinator', description: 'Coordinates the team.', agent: 'hermes' });
  const dev = bots.create({ deck_id: 'deck-dev', name: 'Dev', title: 'Developer', description: 'Implements.', agent: 'claude' });
  const reviewer = bots.create({ deck_id: 'deck-review', name: 'Reviewer', title: 'Reviewer', description: 'Reviews.', agent: 'codex' });
  const auditor = bots.create({ deck_id: 'deck-audit', name: 'Auditor', title: 'Second reviewer', description: 'Audits.', agent: 'cursor' });
  const idle = bots.create({ name: 'Idle', title: 'Unconfigured', description: 'No deck yet.', agent: 'codex' });
  // NOT-475: the owner already allowed Tank's edit Wakes to Dev
  // (test-wake-safety.js covers the first-use approval).
  const safety = jiti('./lib/wake-safety.ts');
  safety.ensureEditGrant({ callerAgentId: tank.id, targetAgentId: dev.id, grantedBy: safety.OWNER_PRINCIPAL, sourceWakeId: null, now: Date.now() });

  let devSessions = 0;
  const devTurns = [];
  specialists.set(dev.id, (input, request) => {
    devTurns.push({ kind: request.execution_kind, tools: input.toolProfile, resumed: input.sessionBinding });
    if (request.execution_kind === 'revision') return { output: `Revised: addressed ${lastEntry(input).content.includes('missing tests') ? 'missing tests' : 'findings'}.` };
    return { output: `Implemented: ${request.intent}`, sessionId: `dev-session-${++devSessions}` };
  });
  let reviews = 0;
  const reviewInputs = [];
  const reviewerScript = (input, request) => {
    reviewInputs.push({ input, request });
    reviews++;
    return { output: reviews === 1 ? 'Finding: missing tests for the retry path.' : 'Looks good. No findings.' };
  };
  specialists.set(reviewer.id, reviewerScript);
  specialists.set(auditor.id, reviewerScript);

  // =====================================================================
  console.log('Coordinator loop: person -> Tank -> Dev -> Tank -> Reviewer -> Tank -> resumed Dev -> Tank -> Reviewer -> Tank');
  const tankInputs = [];
  let atFirstContinuation = null;
  const loopPlan = [
    () => `I will have Dev implement it.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Add retry to the uploader.' })}`,
    (input, request) => {
      tankInputs.push({ input, request });
      // Snapshot when the engine returns the implementation result.
      atFirstContinuation = {
        reviewRequests: raw.prepare("SELECT COUNT(*) AS n FROM work_requests WHERE execution_kind = 'review'").get().n,
        reviewerLaunches: launches.filter(l => l.input.target.agentId === reviewer.id).length,
      };
      const implId = /Work Request: (\S+)/.exec(lastEntry(input).content)[1];
      return `Dev is done. Reviewer, please check.\n${block({ target: 'Reviewer', executionKind: 'review', objective: 'Review the uploader retry change.', contextWorkRequests: [implId] })}`;
    },
    (input, request) => {
      tankInputs.push({ input, request });
      const reviewId = /Work Request: (\S+)/.exec(lastEntry(input).content)[1];
      const implId = requestsIn(request.source_conversation_id).find(r => r.execution_kind === 'implementation').id;
      return `Reviewer found a gap. Dev, please revise.\n${block({ target: 'Dev', executionKind: 'revision', objective: 'Add the missing tests for the retry path.', resumeWorkRequest: implId, contextWorkRequests: [reviewId] })}`;
    },
    (input, request) => {
      tankInputs.push({ input, request });
      const revisionId = /Work Request: (\S+)/.exec(lastEntry(input).content)[1];
      return `Revision done; one more review.\n${block({ target: 'Reviewer', executionKind: 'review', objective: 'Re-review the revised change.', contextWorkRequests: [revisionId] })}`;
    },
    (input, request) => {
      tankInputs.push({ input, request });
      return 'Final: the uploader retry is implemented, revised with tests, and Reviewer found no further issues.';
    },
  ];
  const loopConv = await (async () => {
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Implement retry for the uploader and get it reviewed.', idempotencyKey: 'loop-1' });
    plans.set(first.accepted.conversationId, loopPlan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    return first.accepted.conversationId;
  })();

  const requests = requestsIn(loopConv);
  const kinds = requests.map(r => `${bots.getById(r.target_agent_id).name}:${r.execution_kind}`);
  assert(JSON.stringify(kinds) === JSON.stringify([
    'Tank:conversation', 'Dev:implementation', 'Tank:conversation', 'Reviewer:review', 'Tank:conversation',
    'Dev:revision', 'Tank:conversation', 'Reviewer:review', 'Tank:conversation',
  ]), `ordered Work Requests alternate coordinator and specialists (got ${kinds.join(', ')})`);
  assert(requests.every(r => r.state === 'completed'), 'every request completed');
  const [r0, impl, c1, review1, c2, revision, c3, review2, c4] = requests;
  const thread = messagesIn(loopConv).map(m => m.sender_type === 'user' ? 'person' : bots.getById(m.sender_id).name);
  assert(JSON.stringify(thread) === JSON.stringify(['person', 'Tank', 'Dev', 'Tank', 'Reviewer', 'Tank', 'Dev', 'Tank', 'Reviewer', 'Tank']),
    `conversation messages in order (got ${thread.join(' -> ')})`);
  assert(/^Final:/.test(messagesIn(loopConv).pop().content), 'Tank reports the final result in the source conversation');
  assert(!messagesIn(loopConv).some(m => /^\[Deck (handoff|review|resume|result)\]/.test(m.content)), 'no composite observations');

  console.log('\nDeveloper result continues the original coordinator exactly once');
  assert(messagesIn(loopConv)[2].request_id === impl.id && messagesIn(loopConv)[2].content.startsWith('Implemented:'), 'developer result projected into the source conversation');
  for (const specialist of [impl, review1, revision, review2]) {
    const cont = continuationsOf(specialist.id);
    assert(cont.length === 1 && cont[0].target_agent_id === tank.id && cont[0].parent_request_id === specialist.id, `${specialist.execution_kind} ${specialist.id.slice(0, 8)}: one continuation for Tank`);
    assert(cont[0].execution_kind === 'conversation' && cont[0].tool_profile === 'readonly' && JSON.parse(cont[0].policy_snapshot).execution_policy.rule === 'coordinator_continuation', 'continuation is read-only under the continuation rule');
    const policy = JSON.parse(specialist.policy_snapshot);
    assert(policy.return_to.agent_id === tank.id && policy.return_to.conversation_id === loopConv, 'specialist request records coordinator and return conversation');
  }
  assert([c1, c2, c3, c4].every((c, i) => c.id === continuationsOf([impl, review1, revision, review2][i].id)[0].id), 'each coordinator turn after r0 is the continuation of the previous specialist');
  assert(continuationsOf(r0.id).length === 0 && [c1, c2, c3, c4].every(c => continuationsOf(c.id).length === 0), 'coordinator turns themselves create no result continuation');
  const firstInput = tankInputs[0].input;
  const context = lastEntry(firstInput);
  assert(context.speakerLabel === 'Botmancers' && context.content.includes(`Work Request: ${impl.id}`) && context.content.includes('Execution kind: implementation'),
    'coordinator input names the canonical Work Request');
  const historyText = firstInput.prompt.history.slice(0, -1).map(entry => entry.content);
  assert(historyText.filter(text => text.includes('Implemented: Add retry to the uploader.')).length === 1 && context.content.includes('Result: the Dev reply above.'),
    'coordinator input carries the result evidence once (the projected reply), referenced from the continuation');
  assert(!context.content.includes('Implemented:'), 'continuation does not repeat the reply already in history');
  const tankText = JSON.stringify(tankInputs.map(t => t.input.prompt));
  assert(!/dev-session-|run-\d+/.test(tankText), 'coordinator inputs expose no external run or session ids');
  assert(tankInputs.every(t => t.input.toolProfile === 'readonly'), 'every coordinator continuation launched read-only');

  console.log('\nThe coordinator, not the engine, wakes the reviewer');
  assert(atFirstContinuation && atFirstContinuation.reviewRequests === 0 && atFirstContinuation.reviewerLaunches === 0,
    'implementation completion alone created no review request and launched no reviewer');
  const reviewWake = router.getWake(review1.wake_event_id);
  assert(reviewWake.requester_agent_id === tank.id && reviewWake.source_event_id === messagesIn(loopConv)[3].id, 'review Wake was emitted by Tank in its continuation reply');
  assert(review1.target_agent_id === reviewer.id && review1.target_agent_id !== impl.target_agent_id && review1.tool_profile === 'readonly', 'reviewer is distinct from the developer and read-only');
  assert(reviewInputs[0].input.toolProfile === 'readonly' && lastEntry(reviewInputs[0].input).content.includes(`Work Request: ${impl.id}`) && lastEntry(reviewInputs[0].input).content.includes('Implemented:'),
    'reviewer receives the implementation reference and result');
  assert(c2.parent_request_id === review1.id && c2.target_agent_id === tank.id && requestsIn(loopConv).every(r => r.parent_request_id !== review1.id || r.id === c2.id),
    'review result went to Tank only, not straight to a revision');
  assert(revision.parent_request_id === c2.id && router.getWake(revision.wake_event_id).requester_agent_id === tank.id, 'revision Wake came from Tank after the review result');

  console.log('\nRevision resumes the original developer session with edit authority');
  const implAttempt = engine.listAttempts(impl.id)[0];
  const revAttempts = engine.listAttempts(revision.id);
  const implBinding = engine.getActiveSessionBinding({ agentId: dev.id, adapter: 'claude', conversationId: loopConv, requestId: impl.id });
  assert(implBinding && implBinding.external_session_id === 'dev-session-1' && implBinding.source_attempt_id === implAttempt.id, 'implementation bound its reported session');
  assert(revAttempts.length === 1 && revAttempts[0].kind === 'resume' && revAttempts[0].resumed_session_binding_id === implBinding.id && revAttempts[0].tool_profile === 'edit',
    'one resume Attempt on the implementation binding with edit authority');
  assert(revAttempts[0].external_session_id === implAttempt.external_session_id, 'resumed session id is unchanged');
  const revTurn = devTurns.find(t => t.kind === 'revision');
  assert(revTurn && revTurn.tools === 'edit' && revTurn.resumed.externalSessionId === 'dev-session-1' && revTurn.resumed.bindingId === implBinding.id, 'runtime received the opaque binding unchanged');
  assert(revision.root_request_id === impl.root_request_id && revision.target_agent_id === impl.target_agent_id, 'revision shares root lineage and developer');
  assert(devSessions === 1, 'no fresh developer session was started for the revision');

  console.log('\nConversation events in order');
  const events = projector.listConversationEvents(loopConv).filter(e => e.kind === 'request_completed').map(e => e.requestId);
  assert(JSON.stringify(events) === JSON.stringify(requests.map(r => r.id)), 'request_completed events project in loop order');
  assert(requests.every(r => engine.listAttempts(r.id).length === 1), 'exactly one Attempt per request');

  // =====================================================================
  console.log('\nReplay creates no duplicate work');
  const beforeReplay = counts();
  const launchesBefore = launches.length;
  for (let i = 0; i < 3; i++) {
    for (const r of requests) {
      assert(loop.continueAfterTerminal(r.id).length === 0, `replay ${i + 1}: ${r.execution_kind} ${r.id.slice(0, 8)} queues nothing`);
      await service.startAgentDispatch(r.id);
    }
  }
  assert(loop.pendingCoordinatorWork().length === 0, 'recovery scan finds nothing pending');
  await service.waitForAgentDispatchIdle();
  assert(sameCounts(counts(), beforeReplay) && launches.length === launchesBefore, 'replay wrote no rows and launched nothing');
  const reopened = restart();
  assert(reopened && sameCounts(reopened.before, reopened.after) && reopened.launches.length === 0, 'database reopen: recovery creates and launches nothing');

  // =====================================================================
  console.log('\nReviewer choice');
  {
    // Named reviewer: the person names Auditor; Tank wakes Auditor.
    const namedPlan = [
      () => `Dev first.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Add the cache.' })}`,
      input => `Auditor, as requested.\n${block({ target: 'Auditor', executionKind: 'review', objective: 'Review the cache.', contextWorkRequests: [/Work Request: (\S+)/.exec(lastEntry(input).content)[1]] })}`,
      () => 'Auditor reviewed it: no findings.',
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Add a cache and have Auditor review it.', idempotencyKey: 'named-1' });
    plans.set(first.accepted.conversationId, namedPlan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const reviewsIn = requestsIn(first.accepted.conversationId).filter(r => r.execution_kind === 'review');
    assert(reviewsIn.length === 1 && reviewsIn[0].target_agent_id === auditor.id && reviewsIn[0].state === 'completed', 'named reviewer: the review targets the named Agent');
    assert(JSON.parse(reviewsIn[0].policy_snapshot).target_name_snapshot === 'Auditor', 'named reviewer snapshot preserved');
  }
  {
    // Developer as reviewer is refused; Tank is told and asks the person.
    let notice = null;
    const selfPlan = [
      () => `Dev first.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Add logging.' })}`,
      input => [
        'Dev can check its own work.',
        block({ target: 'Dev', executionKind: 'review', objective: 'Review the logging.', contextWorkRequests: [/Work Request: (\S+)/.exec(lastEntry(input).content)[1]] }),
        block({ target: 'Dev', executionKind: 'review', objective: 'Review the logging without references.' }),
      ].join('\n'),
      input => { notice = lastEntry(input).content; return 'No independent reviewer ran. Who should review the logging change: Reviewer or Auditor?'; },
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Add logging.', idempotencyKey: 'self-1' });
    plans.set(first.accepted.conversationId, selfPlan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    const wakes = raw.prepare("SELECT * FROM wakes WHERE source_conversation_id = ? AND execution_kind = 'review'").all(convId);
    assert(wakes.length === 2 && wakes.every(w => w.status === 'rejected' && w.reason_code === 'reviewer_not_independent'),
      'developer-as-reviewer Wake is rejected, with or without contextWorkRequests');
    assert(requestsIn(convId).filter(r => r.execution_kind === 'review').length === 0, 'no review Work Request exists');
    assert(notice && notice.startsWith('[Wake not started]') && /Dev did the work under review/.test(notice), 'Tank is told the review did not start');
    assert(/Who should review/.test(messagesIn(convId).pop().content), 'Tank asks the person instead of claiming a review');
  }
  {
    // Ambiguous: no suitable reviewer is clear, so Tank asks.
    const ambiguousPlan = [
      () => `Dev first.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Add metrics.' })}`,
      () => 'Dev implemented metrics. I am not sure who should review it; should I ask Reviewer or Auditor?',
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Add metrics and get it reviewed by whoever fits.', idempotencyKey: 'ambiguous-1' });
    plans.set(first.accepted.conversationId, ambiguousPlan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    assert(requestsIn(convId).filter(r => r.execution_kind === 'review').length === 0 && raw.prepare("SELECT COUNT(*) AS n FROM wakes WHERE source_conversation_id = ? AND execution_kind = 'review'").get(convId).n === 0,
      'ambiguous reviewer: no review Wake or request');
    assert(/should I ask/.test(messagesIn(convId).pop().content), 'ambiguous reviewer: Tank asks the person');
  }
  {
    // Unavailable reviewers: missing name and unconfigured Agent.
    let notice = null;
    const unavailablePlan = [
      () => `Dev first.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Add tracing.' })}`,
      input => {
        const implId = /Work Request: (\S+)/.exec(lastEntry(input).content)[1];
        return `Reviews please.\n${block({ target: 'Ghost', executionKind: 'review', objective: 'Review tracing.', contextWorkRequests: [implId] })}\n${block({ target: 'Idle', executionKind: 'review', objective: 'Review tracing too.', contextWorkRequests: [implId] })}`;
      },
      input => { notice = lastEntry(input).content; return 'Neither reviewer is available, so tracing is not reviewed yet. Who else should review it?'; },
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Add tracing and get it reviewed.', idempotencyKey: 'unavailable-1' });
    plans.set(first.accepted.conversationId, unavailablePlan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    const wakes = raw.prepare("SELECT * FROM wakes WHERE source_conversation_id = ? AND execution_kind = 'review' ORDER BY position").all(convId);
    assert(wakes.length === 2 && wakes[0].status === 'unavailable' && wakes[1].status === 'blocked', 'missing reviewer unavailable, unconfigured reviewer blocked');
    const blocked = engine.getWorkRequest(wakes[1].work_request_id);
    assert(blocked.state === 'blocked' && engine.listAttempts(blocked.id).length === 0, 'blocked review never ran');
    // NOT-475: a blocked Wake waits silently until it runs, is denied, or is stopped.
    assert(notice && /Ghost was unavailable/.test(notice) && !/Idle/.test(notice), 'Tank is told which reviews did not start; the blocked one waits without a notice');
    assert(/not reviewed yet/.test(messagesIn(convId).pop().content), 'Tank does not claim a review occurred');
    assert(raw.prepare("SELECT COUNT(*) AS n FROM work_requests WHERE requester_kind = 'service' AND idempotency_key LIKE 'continuation:v1:wakes:%' AND source_conversation_id = ?").get(convId).n === 1,
      'one Wake-outcome continuation for the reply');
  }

  // =====================================================================
  console.log('\nRevision reference validation');
  {
    const otherConv = (await ask(tank, 'Unrelated question.', 'other-1')).conversationId;
    const otherImpl = await (async () => {
      const plan = [() => `Dev.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Other work.' })}`, () => 'Done elsewhere.'];
      const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Other implementation.', idempotencyKey: 'other-2' });
      plans.set(first.accepted.conversationId, plan);
      await first.dispatched;
      await service.waitForAgentDispatchIdle();
      return requestsIn(first.accepted.conversationId).find(r => r.execution_kind === 'implementation');
    })();
    assert(!!otherConv && otherImpl.state === 'completed', 'a completed implementation in another lineage exists');

    let rejectionNotice = null;
    const plan = [
      () => `Dev first.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Build the exporter.' })}`,
      input => {
        const implId = /Work Request: (\S+)/.exec(lastEntry(input).content)[1];
        return [
          'Revisions:',
          block({ target: 'Dev', executionKind: 'revision', objective: 'Revise other work.', resumeWorkRequest: otherImpl.id }),
          block({ target: 'Reviewer', executionKind: 'revision', objective: 'Revise as someone else.', resumeWorkRequest: implId }),
        ].join('\n');
      },
      input => { rejectionNotice = lastEntry(input).content; return 'Both revisions were refused; nothing changed.'; },
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Build the exporter.', idempotencyKey: 'revise-bad-1' });
    plans.set(first.accepted.conversationId, plan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    const wakes = raw.prepare("SELECT * FROM wakes WHERE source_conversation_id = ? AND execution_kind = 'revision' ORDER BY position").all(convId);
    assert(wakes.length === 2 && wakes.every(w => w.status === 'rejected' && w.reason_code === 'invalid_reference' && w.work_request_id === null), 'cross-lineage and other-target revisions are rejected');
    assert(requestsIn(convId).filter(r => r.execution_kind === 'revision').length === 0, 'no revision request or Attempt');
    assert(rejectionNotice && /not in this conversation lineage/.test(rejectionNotice) && /same Agent/.test(rejectionNotice), 'Tank is told why');
  }
  {
    // An implementation that reported no session cannot be resumed.
    const noSession = bots.create({ deck_id: 'deck-ns', name: 'NoSession', title: 'Dev', description: 'Forgets sessions.', agent: 'claude' });
    specialists.set(noSession.id, (input, request) => ({ output: `${request.execution_kind} done` }));
    safety.ensureEditGrant({ callerAgentId: tank.id, targetAgentId: noSession.id, grantedBy: safety.OWNER_PRINCIPAL, sourceWakeId: null, now: Date.now() });
    let failureNotice = null;
    const plan = [
      () => `NoSession.\n${block({ target: 'NoSession', executionKind: 'implementation', objective: 'Build it.' })}`,
      input => `Revise.\n${block({ target: 'NoSession', executionKind: 'revision', objective: 'Fix it.', resumeWorkRequest: /Work Request: (\S+)/.exec(lastEntry(input).content)[1] })}`,
      input => { failureNotice = lastEntry(input).content; return 'The revision could not resume the session.'; },
    ];
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Build it.', idempotencyKey: 'nosession-1' });
    plans.set(first.accepted.conversationId, plan);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const rev = requestsIn(first.accepted.conversationId).find(r => r.execution_kind === 'revision');
    assert(rev && rev.state === 'failed' && rev.error_code === 'session_unavailable' && engine.listAttempts(rev.id).length === 0, 'sessionless revision fails closed before launch');
    assert(failureNotice && failureNotice.includes(`Work Request: ${rev.id}`) && /State: failed/.test(failureNotice), 'failed revision result still returns to Tank');
    assert(continuationsOf(rev.id).length === 1, 'failed specialist continues Tank exactly once');
  }

  // =====================================================================
  console.log('\nBounded termination: a coordinator that never stops is stopped by limits');
  {
    const echo = bots.create({ deck_id: 'deck-echo', name: 'Echo', title: 'Echo', description: 'Echoes.', agent: 'codex' });
    specialists.set(echo.id, () => ({ output: 'echo' }));
    const forever = () => `Again.\n${block({ target: 'Echo', executionKind: 'conversation', objective: 'Say it again.' })}`;
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Loop forever.', idempotencyKey: 'forever-1' });
    plans.set(first.accepted.conversationId, Array.from({ length: 200 }, () => forever));
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    const all = requestsIn(convId);
    const specialistsRun = all.filter(r => r.wake_event_id !== null);
    const continuations = all.filter(r => r.requester_kind === 'service');
    assert(specialistsRun.length === router.WAKE_MAX_SPECIALIST_REQUESTS, `specialist budget stops new Wakes (${specialistsRun.length})`);
    assert(continuations.length === loop.COORDINATOR_MAX_CONTINUATIONS, `continuation budget ends the loop (${continuations.length})`);
    assert(raw.prepare("SELECT COUNT(*) AS n FROM wakes WHERE source_conversation_id = ? AND reason_code = 'root_budget_exhausted' AND limit_value = 12").get(convId).n > 0, 'Wakes past the budget are recorded as root_budget_exhausted (limit 12)');
    assert(raw.prepare("SELECT COUNT(*) AS n FROM engine_events e JOIN work_requests r ON r.id = e.request_id WHERE r.source_conversation_id = ? AND e.type = 'lineage_stopped'").get(convId).n === 1, 'the stop is recorded once');
    assert(projector.listConversationEvents(convId).filter(e => e.kind === 'lineage_stopped').map(e => e.text).join('|') === 'Stopped: coordinator continuation limit 24 reached', 'the stop projects once as lineage_stopped');
    assert(all.every(r => r.terminal_at !== null), 'nothing left running');
  }

  // =====================================================================
  console.log('\nRestart recovers a continuation lost to a crash, exactly once');
  {
    const first = service.acceptAgentMessage(PERSON, { agentId: tank.id, content: 'Crash test.', idempotencyKey: 'crash-1' });
    plans.set(first.accepted.conversationId, [() => 'Thinking.']);
    await first.dispatched;
    await service.waitForAgentDispatchIdle();
    const convId = first.accepted.conversationId;
    const r0c = requestsIn(convId)[0];
    // Simulate a crash between the specialist's terminal commit and its
    // follow-up: route the Wake and complete the request directly.
    const wakeMsg = db.messages.create(convId, 'bot', block({ target: 'Dev', executionKind: 'implementation', objective: 'Survive a crash.' }), tank.id);
    const routed = router.routeAgentWakes({ sourceEventId: wakeMsg.id, parentRequestId: r0c.id });
    const crashed = routed[0].request;
    engine.transitionWorkRequest(crashed.id, { from: 'queued', to: 'running' });
    const reply = db.messages.create(convId, 'bot', 'Implemented before the crash.', dev.id);
    engine.transitionWorkRequest(crashed.id, { from: 'running', to: 'completed', result: { reply_message_id: reply.id } });
    assert(continuationsOf(crashed.id).length === 0, 'no continuation yet (crashed before follow-up)');
    const once = restart();
    assert(once && once.after.work_requests - once.before.work_requests === 1 && once.after.work_attempts - once.before.work_attempts === 1, 'reopen creates and runs one continuation');
    assert(continuationsOf(crashed.id).length === 1 && continuationsOf(crashed.id)[0].state === 'completed', 'recovered continuation completed for Tank');
    const twice = restart();
    assert(twice && sameCounts(twice.before, twice.after) && twice.launches.length === 0, 'second reopen creates nothing');
  }

  // =====================================================================
  console.log('\nA Wake routing error is reported to the coordinator, once');
  {
    const convId = (await ask(tank, 'Routing error test.', 'route-error-1')).conversationId;
    const person = messagesIn(convId)[0];
    const turn = engine.createOrGetWorkRequest({
      sourceConversationId: convId, sourceEventId: person.id, requester: PERSON, targetAgentId: tank.id,
      intent: 'Routing error test.', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'route-error-turn',
    }).request;
    engine.transitionWorkRequest(turn.id, { from: 'queued', to: 'running' });
    // The reply's Wake was recorded with one payload, then the stored text
    // changed: routing it again is an idempotency conflict.
    const reply = db.messages.create(convId, 'bot', block({ target: 'Ghost', executionKind: 'implementation', objective: 'First payload.' }), tank.id);
    router.routeAgentWakes({ sourceEventId: reply.id, parentRequestId: turn.id });
    raw.prepare('UPDATE messages SET content = ? WHERE id = ?').run(block({ target: 'Dev', executionKind: 'implementation', objective: 'Changed payload.' }), reply.id);
    engine.transitionWorkRequest(turn.id, { from: 'running', to: 'completed', result: { reply_message_id: reply.id } });
    const queued = loop.continueAfterTerminal(turn.id);
    const notice = queued.length === 1 ? engine.getWorkRequest(queued[0]) : null;
    assert(notice && notice.target_agent_id === tank.id && notice.tool_profile === 'readonly' && /^\[Wake not started\] The Wakes in your last message could not be routed/.test(notice.intent),
      'routing error creates one read-only Wake-outcome continuation for Tank');
    assert(!requestsIn(convId).some(r => r.execution_kind === 'implementation'), 'no implementation started');
    assert(loop.continueAfterTerminal(turn.id).length === 0, 'replaying the routing error queues nothing');
    await service.startAgentDispatch(queued[0]);
    await service.waitForAgentDispatchIdle();
    assert(engine.getWorkRequest(queued[0]).state === 'completed', 'Tank ran the routing-error continuation');
  }

  // =====================================================================
  console.log('\nRecovery never routes replies that ended before the follow-up marker existed');
  {
    const convId = (await ask(tank, 'Old conversation.', 'pre-upgrade-1')).conversationId;
    const person = messagesIn(convId)[0];
    const old = engine.createOrGetWorkRequest({
      sourceConversationId: convId, sourceEventId: person.id, requester: PERSON, targetAgentId: tank.id,
      intent: 'Old conversation.', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'pre-upgrade-turn',
    }).request;
    engine.transitionWorkRequest(old.id, { from: 'queued', to: 'running' });
    const reply = db.messages.create(convId, 'bot', `Old reply.\n${block({ target: 'Dev', executionKind: 'implementation', objective: 'Old work.' })}\nWAKE Reviewer: please look.`, tank.id);
    engine.transitionWorkRequest(old.id, { from: 'running', to: 'completed', result: { reply_message_id: reply.id } });
    // A request that went terminal before migration 9 has no follow-up row.
    raw.prepare('DELETE FROM terminal_followups WHERE request_id = ?').run(old.id);
    const before = counts();
    const reopened = restart();
    assert(reopened && sameCounts(reopened.before, reopened.after) && reopened.launches.length === 0, 'reopen creates and launches nothing for the old reply');
    assert(loop.continueAfterTerminal(old.id).length === 0 && sameCounts(counts(), before), 'a direct replay creates nothing either');
    assert(raw.prepare('SELECT COUNT(*) AS n FROM wakes WHERE source_event_id = ?').get(reply.id).n === 0, 'no Wake recorded from the old reply');
    assert(raw.prepare('SELECT COUNT(*) AS n FROM terminal_followups WHERE done_at IS NULL').get().n === 0, 'no follow-up left open');
  }

  dispatch.setAttemptAdapterOverride(null);
  router.setWakeAvailabilityProbe(null);
  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}
