#!/usr/bin/env node
// NOT-487 reviewed Agent Deck finalization contract. Deterministic and
// self-contained: isolated SQLite, in-process fake public API, no child
// Agent Deck CLI and no host Git commands.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-deck-finalization-${process.pid}.db`);
const FIXTURE_WORKTREE = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-finalization-worktree-'));
fs.mkdirSync(path.join(FIXTURE_WORKTREE, '.git'));
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HERMES_API_SERVER_KEY = 'fixture-hermes-key';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const finalization = jiti('./lib/agent-deck-finalization.ts');
const decisions = jiti('./lib/finalize-decision.ts');
const deckApi = jiti('./lib/agent-deck-api.ts');
const agentConversations = jiti('./lib/agent-conversations.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const { createFakeAgentDeck, sha } = require('./test-support/fake-agent-deck-api.js');
const raw = db.default;
const { bots, conversations, engine, messages, projector } = db;

const emittedLogs = [];
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...values) => {
    emittedLogs.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
    original(...values);
  };
}

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
function block(value) {
  return `\`\`\`botmancers-finalize\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
}
function wake(value) {
  return `\`\`\`botmancers-wake\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
}

const fake = createFakeAgentDeck({ token: 'adg_NOT_487_fixture_bearer_never_persist' });
process.env.AGENT_DECK_RUN_TOKEN = fake.token;
deckApi.setAgentDeckApiFetch(fake.fetch);

const coordinator = bots.create({ name: 'Coordinator 487', title: 'Coordinator', description: '', agent: 'hermes', deck_id: 'deck-coord' });
const developer = bots.create({ name: 'Developer 487', title: 'Developer', description: '', agent: 'codex', deck_id: 'deck-dev', working_directory: FIXTURE_WORKTREE });
const reviewer = bots.create({ name: 'Reviewer 487', title: 'Reviewer', description: '', agent: 'claude', deck_id: 'deck-review', working_directory: FIXTURE_WORKTREE });
const other = bots.create({ name: 'Other 487', title: 'Other', description: '', agent: 'cursor', deck_id: 'deck-other' });
const conversation = conversations.getByBotId(coordinator.id);
let clock = 1800000000000;

function source(content, sender = coordinator) {
  return messages.create(conversation.id, sender === coordinator ? 'bot' : 'user', content, sender === coordinator ? sender.id : undefined);
}

function request({ label, target, kind, profile, parent = null, policy = {}, wake = true, conv = conversation.id }) {
  const event = conv === conversation.id ? source(`${label} source`) : messages.create(conv, 'user', `${label} source`);
  return engine.createOrGetWorkRequest({
    sourceConversationId: conv,
    sourceEventId: event.id,
    requester: parent ? { kind: 'bot', id: coordinator.id } : { kind: 'person', id: 'owner' },
    targetAgentId: target.id,
    intent: label,
    executionKind: kind,
    toolProfile: profile,
    idempotencyKey: `${label}-${randomUUID()}`,
    parentRequestId: parent?.id ?? null,
    wakeEventId: wake && parent ? `wake-${randomUUID()}` : null,
    policy: {
      ...policy,
      ...(parent ? { return_to: { agent_id: coordinator.id, conversation_id: conv } } : {}),
    },
    now: clock++,
  }).request;
}

function completeAttempt(work, profile, runId, at = clock++) {
  engine.transitionWorkRequest(work.id, { from: 'queued', to: 'running', now: at });
  const attempt = engine.createAttempt(work.id, {
    kind: 'launch', adapter: work.target_agent_id === developer.id ? 'codex' : 'claude', toolProfile: profile,
    launchSnapshot: { transport: 'agent-deck-api', prepare_finalization: profile === 'edit' }, now: at + 1,
  });
  engine.recordAttemptExternalIds(attempt.id, { externalRunId: runId, externalSessionId: `session-${runId}` });
  const finished = engine.finishAttempt(attempt.id, {
    outcome: 'succeeded', output: `${work.execution_kind} completed`, artifacts: [], now: at + 2,
  });
  engine.transitionWorkRequest(work.id, { from: 'running', to: 'completed', result: { ok: true }, now: at + 3 });
  clock = Math.max(clock, at + 4);
  return finished;
}

const candidateFiles = [
  { path: 'src/new.ts', sha256: sha('new'), mode: '100644' },
  { path: 'src/modified.ts', sha256: sha('modified'), mode: '100644' },
  { path: 'src/deleted.ts', sha256: null, mode: null },
  { path: 'bin/mode-change', sha256: sha('mode-change'), mode: '100755' },
];

async function makeChain(label, files = candidateFiles) {
  const root = request({ label: `${label}-root`, target: coordinator, kind: 'conversation', profile: 'readonly', wake: false });
  const implementation = request({ label: `${label}-implementation`, target: developer, kind: 'implementation', profile: 'edit', parent: root });
  fake.onStart = () => ({ result: 'implemented', files });
  const started = await deckApi.startAgentDeckRun({
    deckId: 'deck-dev', client: 'codex', cwd: '/public/workspace', prompt: label, tools: 'edit', prepareFinalization: true,
  }, `start-${label}`);
  const status = await deckApi.getAgentDeckRun(started.runId);
  const changes = await deckApi.getAgentDeckRunChanges(started.runId);
  const implementationAttempt = completeAttempt(implementation, 'edit', started.runId);
  finalization.recordPreparedEvidence(implementation, implementationAttempt, {
    status: 'completed', adapter: 'agent-deck-api', externalRunId: started.runId, externalSessionId: status.sessionId,
    output: 'implemented', artifacts: [{ kind: 'candidate_manifest', ref: changes.manifestDigest }],
    startedAt: clock, finishedAt: clock, failure: null,
    finalization: {
      baselineRef: status.finalization.baselineRef, baselineDigest: status.finalization.baselineDigest,
      candidate: { ok: true, manifest: changes },
    },
  }, clock++);
  const review = request({
    label: `${label}-review`, target: reviewer, kind: 'review', profile: 'readonly', parent: root,
    policy: { context_work_requests: [implementation.id] },
  });
  const reviewAttempt = completeAttempt(review, 'readonly', `review-run-${label}`);
  const decisionRequest = request({ label: `${label}-decision`, target: coordinator, kind: 'conversation', profile: 'readonly', parent: root });
  return { root, implementation, implementationAttempt, review, reviewAttempt, decisionRequest, run: fake.runs.get(started.runId) };
}

function decisionFor(chain, decision = 'accept') {
  return {
    decision,
    implementationAttemptId: chain.implementationAttempt.id,
    reviewAttemptId: chain.reviewAttempt.id,
  };
}

async function main() {
  console.log('NOT-487 candidate persistence and exact finalization');
  const chain = await makeChain('valid');
  const manifest = finalization.getCandidateManifest(chain.implementationAttempt.id);
  assert(!!manifest, 'terminal prepared edit stores one candidate manifest');
  assert(manifest && manifest.files === JSON.stringify(candidateFiles), 'candidate path/digest/mode order is persisted byte-for-byte');
  assert(manifest && !manifest.files.includes('unrelated-user-dirty.txt'), 'unchanged pre-existing dirty paths are absent from candidate state');
  assert(raw.prepare('SELECT COUNT(*) AS n FROM attempt_finalization_baselines WHERE attempt_id = ?').get(chain.implementationAttempt.id).n === 1,
    'public baseline reference and digest are linked to the Attempt');
  const reopened = JSON.parse(execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});process.stdout.write(JSON.stringify(d.prepare('SELECT files,manifest_digest,file_count FROM candidate_manifests WHERE attempt_id=?').get(process.argv[2])));`, DB_PATH, chain.implementationAttempt.id], { encoding: 'utf8' }));
  assert(reopened.files === JSON.stringify(candidateFiles) && reopened.file_count === candidateFiles.length, 'a fresh process reopens the exact immutable candidate artifact');
  let immutable = false;
  try { raw.prepare('UPDATE candidate_manifests SET files = ? WHERE id = ?').run('[]', manifest.id); } catch { immutable = true; }
  assert(immutable, 'candidate artifacts reject mutation');

  const reply = source(block({ ...decisionFor(chain), commitMessage: 'Finalize the reviewed fixture' }));
  const outcomes = finalization.recordFinalizeDecisions(reply, chain.decisionRequest, clock++);
  assert(outcomes.length === 1 && outcomes[0].finalizationId, 'explicit acceptance of exact Attempts creates one preparing finalization');
  const id = outcomes[0].finalizationId;
  const beforeFinalize = fake.calls('POST', '/finalize').length;
  const committed = await finalization.runFinalization(id);
  const finalizeCalls = fake.calls('POST', '/finalize').slice(beforeFinalize);
  const submitted = finalizeCalls[0];
  assert(committed.state === 'committed' && committed.commit_id && committed.tree_id, 'finalization persists terminal commit and tree evidence');
  assert(submitted && JSON.stringify(submitted.body.files) === manifest.files, 'POST /finalize submits exactly the persisted ordered manifest');
  assert(submitted && submitted.headers['idempotency-key'] === committed.idempotency_key, 'the deterministic stored idempotency key is sent');
  assert(submitted && submitted.body.commitMessage.length <= finalization.COMMIT_MESSAGE_MAX, 'the stored commit message is bounded');
  await finalization.runFinalization(id);
  finalization.recordFinalizeDecisions(reply, chain.decisionRequest, clock++);
  assert(fake.calls('POST', '/finalize').length === beforeFinalize + 1 && fake.commits.length === 1, 'replay returns the stored outcome without another finalize call or commit');

  console.log('\nDecision chain rejection table');
  const callsBeforeRejects = fake.calls('POST', '/finalize').length;
  const free = source('Reviewer says this looks good; please ship it.');
  assert(finalization.recordFinalizeDecisions(free, chain.decisionRequest).length === 0, 'free-form approval prose is never approval');
  const rejectedReply = source(block(decisionFor(chain, 'reject')));
  const rejected = finalization.recordFinalizeDecisions(rejectedReply, chain.decisionRequest);
  assert(rejected[0].reasonCode === 'review_rejected', 'an explicit rejected review commits nothing');
  const checks = [
    ['wrong implementation Attempt', { ...decisionFor(chain), implementationAttemptId: chain.reviewAttempt.id }, 'invalid_implementation', conversation.id, chain.decisionRequest],
    ['wrong review Attempt', { ...decisionFor(chain), reviewAttemptId: chain.implementationAttempt.id }, 'invalid_review', conversation.id, chain.decisionRequest],
  ];
  const otherConversation = conversations.getByBotId(other.id);
  checks.push(['cross-conversation ids', decisionFor(chain), 'cross_conversation', otherConversation.id, chain.decisionRequest]);
  for (const [label, decision, code, conv, decisionRequest] of checks) {
    const result = finalization.validateDecisionChain({ version: 1, ...decision }, decisionRequest, conv);
    assert(!result.ok && result.code === code, `${label} is rejected (${code})`);
  }
  const missingLineageRequest = request({ label: 'missing-lineage-decision', target: other, kind: 'conversation', profile: 'readonly', parent: chain.root });
  const missingLineage = finalization.validateDecisionChain({ version: 1, ...decisionFor(chain) }, missingLineageRequest, conversation.id);
  assert(!missingLineage.ok && missingLineage.code === 'lineage_mismatch', 'missing coordinator lineage is rejected');
  const staleEdit = request({ label: 'valid-later-edit', target: developer, kind: 'revision', profile: 'edit', parent: chain.root });
  const stale = finalization.validateDecisionChain({ version: 1, ...decisionFor(chain) }, chain.decisionRequest, conversation.id);
  assert(!stale.ok && stale.code === 'stale_manifest', 'a later edit makes the reviewed artifact stale');
  assert(fake.calls('POST', '/finalize').length === callsBeforeRejects, 'all rejected decisions make zero finalize calls');

  console.log('\nRetry, failure, cancellation, and projection');
  const retryChain = await makeChain('retry');
  const retryReply = source(block(decisionFor(retryChain)));
  const retryId = finalization.recordFinalizeDecisions(retryReply, retryChain.decisionRequest)[0].finalizationId;
  let dropCommittedResponse = true;
  deckApi.setAgentDeckApiFetch(async (url, init) => {
    if (dropCommittedResponse && init.method === 'POST' && url.endsWith('/finalize')) {
      dropCommittedResponse = false;
      await fake.fetch(url, init);
      throw new Error('fixture drops response after Agent Deck committed');
    }
    return fake.fetch(url, init);
  });
  const pending = await finalization.runFinalization(retryId);
  assert(pending.state === 'preparing' && pending.submitted_at !== null, 'unknown transport outcome remains preparing for restart recovery');
  const pendingReopen = JSON.parse(execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});process.stdout.write(JSON.stringify(d.prepare('SELECT state,submitted_at,idempotency_key,request_body FROM finalizations WHERE id=?').get(process.argv[2])));`, DB_PATH, retryId], { encoding: 'utf8' }));
  deckApi.setAgentDeckApiFetch(fake.fetch);
  const recovered = await finalization.runFinalization(retryId);
  const retryRequests = fake.calls('POST', '/finalize').filter(call => call.path.includes(retryChain.run.runId));
  assert(pendingReopen.state === 'preparing' && recovered.state === 'committed', 'a fresh-process database read preserves the restartable request and recovery reaches one outcome');
  assert(retryRequests.length === 2 && retryRequests[0].headers['idempotency-key'] === retryRequests[1].headers['idempotency-key']
    && JSON.stringify(retryRequests[0].body) === JSON.stringify(retryRequests[1].body), 'retry repeats the exact body and idempotency key');
  assert(fake.commits.filter(commit => commit.runId === retryChain.run.runId).length === 1, 'lost-response retry creates one logical commit');

  const optionalChain = await makeChain('optional-evidence');
  const optionalId = finalization.recordFinalizeDecisions(source(block(decisionFor(optionalChain))), optionalChain.decisionRequest)[0].finalizationId;
  let omitOptionalEvidence = true;
  deckApi.setAgentDeckApiFetch(async (url, init) => {
    const response = await fake.fetch(url, init);
    if (!omitOptionalEvidence || init.method !== 'POST' || !url.endsWith('/finalize')) return response;
    omitOptionalEvidence = false;
    const payload = await response.json();
    delete payload.data.parent;
    delete payload.data.fileCount;
    delete payload.data.reviewId;
    return { status: response.status, json: async () => payload };
  });
  const optionalCommitted = await finalization.runFinalization(optionalId);
  assert(optionalCommitted.state === 'committed' && optionalCommitted.parent_commit === optionalChain.run.baseCommit
    && optionalCommitted.file_count === candidateFiles.length, 'a contract-minimal commit response is accepted and completed from persisted evidence');

  const malformedChain = await makeChain('malformed-response');
  const malformedId = finalization.recordFinalizeDecisions(source(block(decisionFor(malformedChain))), malformedChain.decisionRequest)[0].finalizationId;
  let garbleCommittedResponse = true;
  deckApi.setAgentDeckApiFetch(async (url, init) => {
    if (garbleCommittedResponse && init.method === 'POST' && url.endsWith('/finalize')) {
      garbleCommittedResponse = false;
      await fake.fetch(url, init);
      return { status: 200, json: async () => ({ success: true, data: { finalizationState: 'finalized' } }) };
    }
    return fake.fetch(url, init);
  });
  const malformedPending = await finalization.runFinalization(malformedId);
  deckApi.setAgentDeckApiFetch(fake.fetch);
  const malformedRecovered = await finalization.runFinalization(malformedId);
  assert(malformedPending.state === 'preparing' && malformedRecovered.state === 'committed'
    && fake.commits.filter(commit => commit.runId === malformedChain.run.runId).length === 1,
  'an invalid post-submit response remains retryable and reconciles to one commit');

  const changedChain = await makeChain('changed');
  const changedId = finalization.recordFinalizeDecisions(source(block(decisionFor(changedChain))), changedChain.decisionRequest)[0].finalizationId;
  changedChain.run.files = [...candidateFiles, { path: 'unexpected.txt', sha256: sha('unexpected'), mode: '100644' }];
  const changed = await finalization.runFinalization(changedId);
  assert(changed.state === 'blocked' && changed.reason_code === 'manifest_changed', 'a changed candidate manifest blocks before commit');

  const failedChain = await makeChain('auth-failed');
  const failedId = finalization.recordFinalizeDecisions(source(block(decisionFor(failedChain))), failedChain.decisionRequest)[0].finalizationId;
  delete process.env.AGENT_DECK_RUN_TOKEN;
  const failed = await finalization.runFinalization(failedId);
  process.env.AGENT_DECK_RUN_TOKEN = fake.token;
  assert(failed.state === 'failed' && failed.reason_code === 'agent_deck_token_missing', 'missing API auth becomes a stable failed finalization');

  const retryFailedReply = source(block(decisionFor(failedChain)));
  const retriedFailed = finalization.recordFinalizeDecisions(retryFailedReply, failedChain.decisionRequest, clock++);
  assert(retriedFailed[0].finalizationId && retriedFailed[0].finalizationId !== failedId && retriedFailed[0].reasonCode === null,
    'a new explicit acceptance retries a terminal failed finalization with a new auditable row');
  const recoveredFailed = await finalization.runFinalization(retriedFailed[0].finalizationId);
  assert(recoveredFailed.state === 'committed', 'the retry after restored authentication returns a committed outcome');

  const blockedRetryChain = await makeChain('blocked-retry');
  const blockedReply = source(block(decisionFor(blockedRetryChain)));
  const blockedId = finalization.recordFinalizeDecisions(blockedReply, blockedRetryChain.decisionRequest, clock++)[0].finalizationId;
  fake.onFinalize = (_body, run) => run.runId === blockedRetryChain.run.runId ? { status: 409, code: 'GIT_LOCK_CONFLICT' } : null;
  const terminalBlocked = await finalization.runFinalization(blockedId);
  fake.onFinalize = null;
  const retryBlockedReply = source(block(decisionFor(blockedRetryChain)));
  const retriedBlockedId = finalization.recordFinalizeDecisions(retryBlockedReply, blockedRetryChain.decisionRequest, clock++)[0].finalizationId;
  assert(terminalBlocked.state === 'blocked' && retriedBlockedId && retriedBlockedId !== blockedId,
    'a new explicit acceptance retries a terminal operational block instead of silently reusing it');
  const recoveredBlocked = await finalization.runFinalization(retriedBlockedId);
  assert(recoveredBlocked.state === 'committed', 'the retry after a cleared operational block returns a committed outcome');

  const canceledChain = await makeChain('canceled');
  const canceledId = finalization.recordFinalizeDecisions(source(block(decisionFor(canceledChain))), canceledChain.decisionRequest)[0].finalizationId;
  fake.onFinalize = (_body, run) => run.runId === canceledChain.run.runId ? { status: 409, code: 'FINALIZATION_CANCELED' } : null;
  const canceled = await finalization.runFinalization(canceledId);
  fake.onFinalize = null;
  assert(canceled.state === 'canceled', 'Agent Deck cancellation persists a canceled terminal outcome');

  console.log('\nCoordinator-led API loop and finalization');
  fake.onStart = body => body.tools === 'edit'
    ? { result: 'Implementation complete.', files: candidateFiles }
    : { result: 'Readonly review accepted the exact candidate manifest.' };
  let coordinatorTurn = 0;
  const coordinatorInputs = [];
  dispatch.setAgentDispatchHermesFetch(async (_url, init) => {
    coordinatorTurn += 1;
    coordinatorInputs.push(JSON.parse(init.body));
    let content;
    if (coordinatorTurn === 1) {
      content = wake({ target: developer.name, executionKind: 'implementation', objective: 'Implement the end-to-end finalization fixture.' });
    } else if (coordinatorTurn === 2) {
      const implementation = raw.prepare("SELECT * FROM work_requests WHERE execution_kind = 'implementation' ORDER BY rowid DESC LIMIT 1").get();
      content = wake({ target: reviewer.name, executionKind: 'review', objective: 'Review the exact candidate manifest.', contextWorkRequests: [implementation.id] });
    } else if (coordinatorTurn === 3) {
      const implementation = raw.prepare("SELECT * FROM work_requests WHERE execution_kind = 'implementation' ORDER BY rowid DESC LIMIT 1").get();
      const review = raw.prepare("SELECT * FROM work_requests WHERE execution_kind = 'review' ORDER BY rowid DESC LIMIT 1").get();
      const implementationAttempt = raw.prepare('SELECT id FROM work_attempts WHERE request_id = ? ORDER BY attempt_number DESC LIMIT 1').get(implementation.id);
      const reviewAttempt = raw.prepare('SELECT id FROM work_attempts WHERE request_id = ? ORDER BY attempt_number DESC LIMIT 1').get(review.id);
      content = block({ decision: 'accept', implementationAttemptId: implementationAttempt.id, reviewAttemptId: reviewAttempt.id, commitMessage: 'Finalize coordinator loop fixture' });
    } else {
      content = 'Coordinator received the committed finalization evidence.';
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  const accepted = agentConversations.acceptAgentMessage(
    { kind: 'person', id: 'fixture-owner' },
    { agentId: coordinator.id, content: 'Implement, review, and finalize the fixture.', idempotencyKey: 'not-487-e2e-loop' }
  );
  await accepted.dispatched;
  await agentConversations.waitForAgentDispatchIdle();
  const loopRequests = raw.prepare('SELECT * FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at, rowid').all(accepted.accepted.conversationId);
  const loopKinds = loopRequests.map(row => row.execution_kind);
  const loopImplementation = loopRequests.find(row => row.execution_kind === 'implementation');
  const loopReview = loopRequests.find(row => row.execution_kind === 'review');
  const loopAttempt = raw.prepare('SELECT * FROM work_attempts WHERE request_id = ?').get(loopImplementation.id);
  const loopManifest = finalization.getCandidateManifest(loopAttempt.id);
  const loopFinalization = finalization.listFinalizationsForConversation(accepted.accepted.conversationId)[0];
  if (!loopManifest || !loopFinalization) {
    console.log('  DIAGNOSTIC:', JSON.stringify({
      conversationId: accepted.accepted.conversationId,
      implementation: { id: loopImplementation?.id, state: loopImplementation?.state, error: loopImplementation?.error_code },
      review: { id: loopReview?.id, state: loopReview?.state, error: loopReview?.error_code },
      attempt: loopAttempt && { id: loopAttempt.id, outcome: loopAttempt.outcome, run: loopAttempt.external_run_id },
      manifest: loopManifest ?? null,
      finalization: loopFinalization ?? null,
      coordinatorTurn,
    }));
  }
  assert(JSON.stringify(loopKinds) === JSON.stringify(['conversation', 'implementation', 'conversation', 'review', 'conversation', 'conversation']),
    'real runTurn path alternates coordinator, implementation, review, acceptance, and finalization continuation');
  assert(loopManifest && loopManifest.external_run_id === loopAttempt.external_run_id && loopManifest.files === JSON.stringify(candidateFiles),
    'runTurn records the prepared baseline and exact terminal candidate manifest');
  assert(loopFinalization && loopFinalization.state === 'committed' && loopFinalization.review_request_id === loopReview.id,
    'coordinator acceptance flows through startFinalization/runFinalization to one committed outcome');
  assert(loopFinalization && coordinatorTurn === 4 && JSON.stringify(coordinatorInputs[3]).includes(loopFinalization.commit_id)
    && JSON.stringify(coordinatorInputs[3]).includes(loopFinalization.tree_id)
    && JSON.stringify(coordinatorInputs[3]).includes(loopFinalization.result_manifest_digest),
    'continueAfterFinalization returns exact commit, tree, and manifest evidence to the coordinator conversation');
  assert(fake.commits.filter(commit => commit.runId === loopAttempt.external_run_id).length === 1,
    'the coordinator-led loop creates exactly one logical commit');
  dispatch.setAgentDispatchHermesFetch(null);

  const kinds = projector.listConversationEvents(conversation.id).map(event => event.kind);
  for (const kind of ['artifact', 'finalization_preparing', 'finalization_committed', 'finalization_blocked', 'finalization_failed', 'finalization_canceled', 'finalization_rejected']) {
    assert(kinds.includes(kind), `${kind} projects into the originating conversation`);
  }
  const projectionRows = raw.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(conversation.id).n;
  projector.projectConversation(conversation.id);
  assert(raw.prepare('SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ?').get(conversation.id).n === projectionRows, 'conversation projection replay is idempotent');

  const api = jiti('./lib/agent-api.ts');
  api.setAgentApiAuthenticator(() => db.UI_OWNER_PRINCIPAL);
  const response = await api.handleGetConversation(
    new Request(`http://engine.test/api/v0/conversations/${conversation.id}`),
    conversation.id,
  );
  const httpResponseBody = Buffer.from(await response.text());
  const serializedState = [
    ...['', '-wal', '-shm'].filter(suffix => fs.existsSync(DB_PATH + suffix)).map(suffix => [`sqlite${suffix || '-main'}`, fs.readFileSync(DB_PATH + suffix)]),
    ['conversation-events', Buffer.from(JSON.stringify(projector.listConversationEvents(conversation.id)))],
    ['work-requests', Buffer.from(JSON.stringify(raw.prepare('SELECT error_message, result FROM work_requests').all()))],
    ['agent-deck-responses', Buffer.from(JSON.stringify(fake.responses))],
    ['logs', Buffer.from(emittedLogs.join('\n'))],
    ['botmancers-http-response', httpResponseBody],
  ];
  const leakingSurfaces = serializedState.filter(([, value]) => value.includes(Buffer.from(fake.token))).map(([label]) => label);
  assert(response.status === 200 && leakingSurfaces.length === 0,
    `fixture bearer is absent from SQLite/WAL, logs, Agent Deck captures, conversation state, and Botmancers HTTP responses${leakingSurfaces.length ? ` (found in ${leakingSurfaces.join(', ')})` : ''}`);
  api.setAgentApiAuthenticator(null);

  deckApi.setAgentDeckApiFetch(null);
  delete process.env.AGENT_DECK_RUN_TOKEN;
  delete process.env.HERMES_API_SERVER_KEY;
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
  fs.rmSync(FIXTURE_WORKTREE, { recursive: true, force: true });
  console.log(`\nTEST RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('agent-deck-finalization test crashed:', error);
  process.exit(1);
});
