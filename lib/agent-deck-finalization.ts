// NOT-487: reviewed Git finalization through Agent Deck
// (docs/design/2026-10-13-git-finalization-contract.md; docs/core-engine.md,
// Reviewed Git finalization).
//
// Botmancers owns the decision; Agent Deck owns the Git mechanism:
//
//   prepared edit Attempt (implementation or revision)
//     -> public baseline ref/digest recorded at launch
//     -> ordered candidate manifest recorded when the run is terminal
//        (candidate_manifests, immutable)
//   readonly review Wake to a distinct reviewer, linked to that work
//   coordinator reply with a botmancers-finalize "accept" block
//     -> the chain is validated (implementation Attempt, review Attempt,
//        manifest, conversation, lineage all agree) or rejected visibly
//     -> one finalizations row with a deterministic idempotency key and
//        the exact request body
//     -> POST /api/agent-runs/:runId/finalize with the persisted manifest
//     -> committed | blocked | failed | canceled, recorded and projected
//        into the originating conversation
//
// Approval is never inferred from prose: only a valid decision block counts,
// and a "reject" decision or any disagreement in the chain finalizes
// nothing. The manifest submitted is the persisted one, byte for byte;
// nothing here adds, drops, or recomputes a path or digest.
//
// Idempotency and restart: the key is derived from the implementation
// Attempt, the review, and the manifest digest, and the body is stored
// before submission, so a replay, a retry, or a restart submits the same
// request with the same key and Agent Deck returns the original outcome.
// A transport failure after submission leaves the row open for recovery.
import { createHash, randomUUID } from 'crypto';
import db, { engine, type Message } from './db';
import type { WorkAttempt, WorkRequest } from './engine-store';
import type { AttemptResult } from './attempt-adapter';
import {
  AGENT_DECK_API_MESSAGES,
  AgentDeckApiError,
  finalizeAgentDeckRun,
  getAgentDeckRunChanges,
  hasAgentDeckRunToken,
  type CandidateManifestEntry,
  type FinalizeRequestBody,
} from './agent-deck-api';
import { parseFinalizeDecisions, type FinalizeDecision } from './finalize-decision';

export type FinalizationState = 'preparing' | 'committed' | 'blocked' | 'failed' | 'canceled';

export interface CandidateManifestRow {
  id: string;
  attempt_id: string;
  request_id: string;
  conversation_id: string;
  external_run_id: string;
  baseline_ref: string;
  baseline_digest: string;
  base_commit: string;
  manifest_digest: string;
  files: string;
  file_count: number;
  created_at: number;
}

export interface FinalizationRow {
  id: string;
  idempotency_key: string;
  conversation_id: string;
  decision_event_id: string;
  decision_request_id: string;
  coordinator_agent_id: string;
  implementation_request_id: string;
  implementation_attempt_id: string;
  review_request_id: string;
  review_attempt_id: string;
  manifest_id: string;
  external_run_id: string;
  request_body: string;
  request_hash: string;
  state: FinalizationState;
  submitted_at: number | null;
  reason_code: string | null;
  reason: string | null;
  commit_id: string | null;
  tree_id: string | null;
  parent_commit: string | null;
  result_manifest_digest: string | null;
  file_count: number | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function policyOf(request: WorkRequest): Record<string, unknown> {
  try {
    const parsed = JSON.parse(request.policy_snapshot) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function returnAgentOf(request: WorkRequest): string | null {
  if (!request.wake_event_id) return null;
  const back = policyOf(request).return_to as { agent_id?: unknown } | undefined;
  return back && typeof back.agent_id === 'string' ? back.agent_id : null;
}

const EDIT_KINDS = ['implementation', 'revision'];

function latestAttempt(requestId: string): WorkAttempt | undefined {
  return db.prepare('SELECT * FROM work_attempts WHERE request_id = ? ORDER BY attempt_number DESC LIMIT 1').get(requestId) as WorkAttempt | undefined;
}

export function getCandidateManifest(attemptId: string): CandidateManifestRow | undefined {
  return db.prepare('SELECT * FROM candidate_manifests WHERE attempt_id = ?').get(attemptId) as CandidateManifestRow | undefined;
}

export function getFinalization(id: string): FinalizationRow | undefined {
  return db.prepare('SELECT * FROM finalizations WHERE id = ?').get(id) as FinalizationRow | undefined;
}

export function listFinalizationsForConversation(conversationId: string): FinalizationRow[] {
  return db.prepare('SELECT * FROM finalizations WHERE conversation_id = ? ORDER BY created_at ASC, id ASC').all(conversationId) as FinalizationRow[];
}

export function manifestFiles(row: CandidateManifestRow): CandidateManifestEntry[] {
  return JSON.parse(row.files) as CandidateManifestEntry[];
}

// ---- prepared-Attempt evidence -------------------------------------------

// The public baseline, recorded as soon as the run reports it.
export function recordAttemptBaseline(attemptId: string, baseline: { baselineRef: string; baselineDigest: string }, now: number = Date.now()): void {
  const attempt = engine.getAttempt(attemptId);
  if (!attempt?.external_run_id) return;
  db.prepare(`
    INSERT OR IGNORE INTO attempt_finalization_baselines (attempt_id, request_id, external_run_id, baseline_ref, baseline_digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(attemptId, attempt.request_id, attempt.external_run_id, baseline.baselineRef, baseline.baselineDigest, now);
}

// Persists the finalization evidence a prepared Attempt returned, inside
// the transaction that finishes it: the baseline, then either the
// immutable candidate manifest or the reason there is none.
export function recordPreparedEvidence(request: WorkRequest, attempt: WorkAttempt, result: AttemptResult, now: number = Date.now()): void {
  const evidence = result.finalization;
  if (!evidence || !attempt.external_run_id) return;
  if (evidence.baselineRef && evidence.baselineDigest) {
    recordAttemptBaseline(attempt.id, { baselineRef: evidence.baselineRef, baselineDigest: evidence.baselineDigest }, now);
  }
  const candidate = evidence.candidate;
  if (!candidate) return;
  if (!candidate.ok) {
    engine.appendEvent(request.id, {
      type: 'candidate_manifest_unavailable',
      attemptId: attempt.id,
      data: { external_run_id: attempt.external_run_id, reason_code: candidate.code, reason: candidate.message.slice(0, 300) },
      now,
    });
    return;
  }
  const manifest = candidate.manifest;
  if (getCandidateManifest(attempt.id)) return;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO candidate_manifests (
      id, attempt_id, request_id, conversation_id, external_run_id, baseline_ref, baseline_digest,
      base_commit, manifest_digest, files, file_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, attempt.id, request.id, request.source_conversation_id, attempt.external_run_id, manifest.baselineRef, manifest.baselineDigest,
    manifest.baseCommit, manifest.manifestDigest, JSON.stringify(manifest.files), manifest.files.length, now
  );
  engine.appendEvent(request.id, {
    type: 'candidate_manifest_recorded',
    attemptId: attempt.id,
    data: {
      manifest_id: id,
      external_run_id: attempt.external_run_id,
      baseline_ref: manifest.baselineRef,
      baseline_digest: manifest.baselineDigest,
      base_commit: manifest.baseCommit,
      manifest_digest: manifest.manifestDigest,
      file_count: manifest.files.length,
    },
    now,
  });
}

const EVIDENCE_FILE_LIMIT = 50;

// The exact candidate artifact, as the reviewer and coordinator see it in
// result evidence. Null when the request did not prepare finalization.
export function candidateEvidence(request: WorkRequest): string | null {
  if (!EDIT_KINDS.includes(request.execution_kind)) return null;
  const attempt = latestAttempt(request.id);
  if (!attempt) return null;
  const manifest = getCandidateManifest(attempt.id);
  if (manifest) {
    const files = manifestFiles(manifest);
    const lines = files.slice(0, EVIDENCE_FILE_LIMIT).map(file => `- ${file.path} ${file.sha256 ? `sha256=${file.sha256} mode=${file.mode}` : 'deleted'}`);
    if (files.length > EVIDENCE_FILE_LIMIT) lines.push(`- ... ${files.length - EVIDENCE_FILE_LIMIT} more`);
    return [
      `Candidate manifest: ${manifest.manifest_digest} (${files.length} ${files.length === 1 ? 'file' : 'files'}, base commit ${manifest.base_commit}, baseline ${manifest.baseline_digest})`,
      ...lines,
    ].join('\n');
  }
  const unavailable = db.prepare(
    "SELECT data FROM engine_events WHERE request_id = ? AND attempt_id = ? AND type = 'candidate_manifest_unavailable' ORDER BY sequence DESC LIMIT 1"
  ).get(request.id, attempt.id) as { data: string } | undefined;
  if (unavailable) {
    const data = JSON.parse(unavailable.data) as { reason_code?: string };
    return `Candidate manifest: unavailable (${data.reason_code ?? 'unknown'}); this work cannot be finalized.`;
  }
  return null;
}

// ---- the coordinator's decision -------------------------------------------

export type DecisionReasonCode =
  | 'invalid_decision'
  | 'review_rejected'
  | 'invalid_implementation'
  | 'invalid_review'
  | 'cross_conversation'
  | 'lineage_mismatch'
  | 'implementation_not_completed'
  | 'review_not_completed'
  | 'review_not_linked'
  | 'reviewer_not_independent'
  | 'not_finalizable'
  | 'stale_manifest'
  | 'already_finalized';

export interface DecisionOutcome {
  position: number;
  finalizationId: string | null;
  reasonCode: DecisionReasonCode | null;
  reason: string | null;
  implementationRequestId: string | null;
  reviewRequestId: string | null;
}

type Chain = { implementation: WorkRequest; implementationAttempt: WorkAttempt; review: WorkRequest; reviewAttempt: WorkAttempt; manifest: CandidateManifestRow };
// existing: an open or committed finalization of the same Attempt.
type ChainCheck = { ok: true; chain: Chain; existing: string | null } | { ok: false; code: DecisionReasonCode; reason: string };

// Every link must agree: the decision's coordinator woke both the
// implementation and the review in this conversation and lineage, the
// review is a completed independent readonly review that names that
// implementation, and the implementation's latest Attempt succeeded with a
// persisted manifest the review could have seen.
export function validateDecisionChain(decision: FinalizeDecision, decisionRequest: WorkRequest, conversationId: string): ChainCheck {
  const coordinator = decisionRequest.target_agent_id;
  const fail = (code: DecisionReasonCode, reason: string): ChainCheck => ({ ok: false, code, reason });
  const implementation = engine.getWorkRequest(decision.implementationWorkRequest);
  if (!implementation || !EDIT_KINDS.includes(implementation.execution_kind)) {
    return fail('invalid_implementation', `Work Request ${decision.implementationWorkRequest} is not an implementation or revision.`);
  }
  const review = engine.getWorkRequest(decision.reviewWorkRequest);
  if (!review || review.execution_kind !== 'review' || review.tool_profile !== 'readonly') {
    return fail('invalid_review', `Work Request ${decision.reviewWorkRequest} is not a readonly review.`);
  }
  if (implementation.source_conversation_id !== conversationId || review.source_conversation_id !== conversationId) {
    return fail('cross_conversation', 'The implementation and review must belong to this conversation.');
  }
  for (const linked of [implementation, review]) {
    if (linked.root_request_id !== decisionRequest.root_request_id || returnAgentOf(linked) !== coordinator) {
      return fail('lineage_mismatch', `Work Request ${linked.id} was not woken by this coordinator in this lineage.`);
    }
  }
  if (implementation.state !== 'completed') {
    return fail('implementation_not_completed', `Implementation ${implementation.id} is ${implementation.state}, not completed.`);
  }
  const implementationAttempt = latestAttempt(implementation.id);
  if (!implementationAttempt || implementationAttempt.outcome !== 'succeeded') {
    return fail('implementation_not_completed', `Implementation ${implementation.id} has no successful Attempt.`);
  }
  const manifest = getCandidateManifest(implementationAttempt.id);
  if (!manifest) return fail('not_finalizable', `Implementation ${implementation.id} has no candidate manifest to finalize.`);
  const context = policyOf(review).context_work_requests;
  if (!Array.isArray(context) || !context.includes(implementation.id)) {
    return fail('review_not_linked', `Review ${review.id} does not reference implementation ${implementation.id}.`);
  }
  if (review.target_agent_id === implementation.target_agent_id) {
    return fail('reviewer_not_independent', 'The reviewer did the work under review.');
  }
  const reviewAttempt = latestAttempt(review.id);
  if (review.state !== 'completed' || !reviewAttempt || reviewAttempt.outcome !== 'succeeded') {
    return fail('review_not_completed', `Review ${review.id} did not complete.`);
  }
  // The review must have been requested after the manifest existed, and
  // no later edit of the same developer in this lineage may have replaced
  // the working tree it describes.
  if (review.created_at < manifest.created_at) {
    return fail('stale_manifest', `Review ${review.id} was requested before the candidate manifest was recorded.`);
  }
  const newer = db.prepare(`
    SELECT id FROM work_requests
    WHERE root_request_id = ? AND target_agent_id = ? AND execution_kind IN ('implementation', 'revision')
      AND id <> ? AND created_at > ? LIMIT 1
  `).get(implementation.root_request_id, implementation.target_agent_id, implementation.id, implementation.created_at) as { id: string } | undefined;
  if (newer) return fail('stale_manifest', `A later edit (${newer.id}) replaced the manifest of ${implementation.id}.`);
  const existing = db.prepare("SELECT id FROM finalizations WHERE implementation_attempt_id = ? AND state IN ('preparing', 'committed') LIMIT 1")
    .get(implementationAttempt.id) as { id: string } | undefined;
  return { ok: true, chain: { implementation, implementationAttempt, review, reviewAttempt, manifest }, existing: existing?.id ?? null };
}

export const COMMIT_MESSAGE_MAX = 4000;

export function commitMessageFor(decision: FinalizeDecision, implementation: WorkRequest, review: WorkRequest): string {
  const subject = decision.commitMessage
    ?? `Botmancers: ${(implementation.intent.split('\n').find(line => line.trim()) ?? 'reviewed change').trim().slice(0, 60)}`;
  const trailers = `\n\nBotmancers-Work-Request: ${implementation.id}\nBotmancers-Review: ${review.id}`;
  return `${subject.slice(0, COMMIT_MESSAGE_MAX - trailers.length)}${trailers}`;
}

export function finalizationIdempotencyKey(implementationAttemptId: string, reviewRequestId: string, manifestDigest: string): string {
  return `botmancers-finalize-v1-${sha256([implementationAttemptId, reviewRequestId, manifestDigest].join(':')).slice(0, 48)}`;
}

function insertFinalization(chain: Chain, decision: FinalizeDecision, decisionRequest: WorkRequest, reply: Message, now: number): { row: FinalizationRow; created: boolean } {
  const key = finalizationIdempotencyKey(chain.implementationAttempt.id, chain.review.id, chain.manifest.manifest_digest);
  const existing = db.prepare('SELECT * FROM finalizations WHERE idempotency_key = ?').get(key) as FinalizationRow | undefined;
  if (existing) return { row: existing, created: false };
  const body: FinalizeRequestBody = {
    baselineDigest: chain.manifest.baseline_digest,
    expectedBaseCommit: chain.manifest.base_commit,
    reviewId: chain.review.id,
    commitMessage: commitMessageFor(decision, chain.implementation, chain.review),
    // Exactly the persisted manifest, in its recorded order.
    files: manifestFiles(chain.manifest),
  };
  const serialized = JSON.stringify(body);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO finalizations (
      id, idempotency_key, conversation_id, decision_event_id, decision_request_id, coordinator_agent_id,
      implementation_request_id, implementation_attempt_id, review_request_id, review_attempt_id,
      manifest_id, external_run_id, request_body, request_hash, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
  `).run(
    id, key, reply.conversation_id, reply.id, decisionRequest.id, decisionRequest.target_agent_id,
    chain.implementation.id, chain.implementationAttempt.id, chain.review.id, chain.reviewAttempt.id,
    chain.manifest.id, chain.manifest.external_run_id, serialized, sha256(serialized), now, now
  );
  const row = getFinalization(id) as FinalizationRow;
  engine.appendEvent(chain.implementation.id, {
    type: 'finalization_preparing',
    attemptId: chain.implementationAttempt.id,
    data: linkage(row, chain.manifest),
    now,
  });
  return { row, created: true };
}

function linkage(row: FinalizationRow, manifest: CandidateManifestRow | undefined): Record<string, unknown> {
  return {
    finalization_id: row.id,
    decision_event_id: row.decision_event_id,
    coordinator_agent_id: row.coordinator_agent_id,
    implementation_request_id: row.implementation_request_id,
    implementation_attempt_id: row.implementation_attempt_id,
    review_request_id: row.review_request_id,
    review_attempt_id: row.review_attempt_id,
    external_run_id: row.external_run_id,
    manifest_id: row.manifest_id,
    manifest_digest: manifest?.manifest_digest ?? null,
    baseline_digest: manifest?.baseline_digest ?? null,
    base_commit: manifest?.base_commit ?? null,
    file_count: manifest?.file_count ?? null,
  };
}

// Records every finalization decision in one coordinator reply. Runs
// inside the coordinator loop's follow-up transaction (once per terminal
// request); an accepted decision replayed later returns its stored row.
export function recordFinalizeDecisions(reply: Message, decisionRequest: WorkRequest, now: number = Date.now()): DecisionOutcome[] {
  const candidates = parseFinalizeDecisions(reply.content);
  if (candidates.length === 0) return [];
  return engine.transaction(() => candidates.map((candidate): DecisionOutcome => {
    const outcome: DecisionOutcome = { position: candidate.position, finalizationId: null, reasonCode: null, reason: null, implementationRequestId: null, reviewRequestId: null };
    const reject = (code: DecisionReasonCode, reason: string): DecisionOutcome => {
      engine.appendEvent(decisionRequest.id, {
        type: 'finalization_rejected',
        data: { decision_event_id: reply.id, position: candidate.position, reason_code: code, reason, implementation_request_id: outcome.implementationRequestId, review_request_id: outcome.reviewRequestId },
        now,
      });
      return { ...outcome, reasonCode: code, reason };
    };
    if (!candidate.validation.ok) return reject('invalid_decision', candidate.validation.reason);
    const decision = candidate.validation.decision;
    outcome.implementationRequestId = decision.implementationWorkRequest;
    outcome.reviewRequestId = decision.reviewWorkRequest;
    if (decision.decision === 'reject') return reject('review_rejected', 'The coordinator rejected the review; nothing was finalized.');
    const checked = validateDecisionChain(decision, decisionRequest, reply.conversation_id);
    if (!checked.ok) return reject(checked.code, checked.reason);
    const key = finalizationIdempotencyKey(checked.chain.implementationAttempt.id, checked.chain.review.id, checked.chain.manifest.manifest_digest);
    const sameKey = db.prepare('SELECT id FROM finalizations WHERE idempotency_key = ?').get(key) as { id: string } | undefined;
    if (checked.existing && !sameKey) {
      return reject('already_finalized', `Implementation ${checked.chain.implementation.id} already has a finalization (${checked.existing}).`);
    }
    const { row } = insertFinalization(checked.chain, decision, decisionRequest, reply, now);
    return { ...outcome, finalizationId: row.id };
  }));
}

// ---- submission -----------------------------------------------------------

const BLOCKED_CODES = new Set([
  'BASE_MISMATCH', 'INDEX_DIRTY', 'BASELINE_MISMATCH', 'PATH_INVALID', 'PATH_UNEXPECTED', 'DIGEST_MISMATCH',
  'IDEMPOTENCY_CONFLICT', 'GIT_LOCK_CONFLICT', 'REF_RACE', 'FINALIZATION_NOT_PREPARED', 'RUN_NOT_TERMINAL',
  'FINALIZATION_INVALID', 'RUN_NOT_FOUND',
]);

function finish(row: FinalizationRow, state: Exclude<FinalizationState, 'preparing'>, fields: {
  reasonCode?: string | null; reason?: string | null; commit?: string | null; tree?: string | null; parent?: string | null;
  manifestDigest?: string | null; fileCount?: number | null;
}, now: number): FinalizationRow {
  return engine.transaction(() => {
    const changed = db.prepare(`
      UPDATE finalizations SET state = ?, reason_code = ?, reason = ?, commit_id = ?, tree_id = ?, parent_commit = ?,
        result_manifest_digest = ?, file_count = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND finished_at IS NULL
    `).run(
      state, fields.reasonCode ?? null, fields.reason?.slice(0, 300) ?? null, fields.commit ?? null, fields.tree ?? null, fields.parent ?? null,
      fields.manifestDigest ?? null, fields.fileCount ?? null, now, now, row.id
    );
    const current = getFinalization(row.id) as FinalizationRow;
    if (changed.changes !== 1) return current;
    const manifest = db.prepare('SELECT * FROM candidate_manifests WHERE id = ?').get(row.manifest_id) as CandidateManifestRow | undefined;
    engine.appendEvent(row.implementation_request_id, {
      type: `finalization_${state}`,
      attemptId: row.implementation_attempt_id,
      data: {
        ...linkage(current, manifest),
        reason_code: current.reason_code,
        reason: current.reason,
        commit: current.commit_id,
        tree: current.tree_id,
        parent: current.parent_commit,
        result_manifest_digest: current.result_manifest_digest,
      },
      now,
    });
    return current;
  });
}

function failureFields(error: unknown): { state: Exclude<FinalizationState, 'preparing' | 'committed'> | null; reasonCode: string; reason: string } {
  if (!(error instanceof AgentDeckApiError)) {
    return { state: 'failed', reasonCode: 'finalization_failed', reason: 'The finalization could not be completed.' };
  }
  if (error.code === 'agent_deck_unreachable') return { state: null, reasonCode: error.code, reason: error.message };
  if (error.code !== 'agent_deck_rejected') return { state: 'failed', reasonCode: error.code, reason: error.message };
  const deckCode = error.deckCode ?? '';
  if (deckCode === 'FINALIZATION_CANCELED') return { state: 'canceled', reasonCode: deckCode.toLowerCase(), reason: error.message };
  if (BLOCKED_CODES.has(deckCode)) return { state: 'blocked', reasonCode: deckCode.toLowerCase(), reason: error.message };
  return { state: 'failed', reasonCode: deckCode ? deckCode.toLowerCase() : 'finalization_failed', reason: error.message };
}

function retryPending(row: FinalizationRow, reasonCode: string, reason: string, now: number): FinalizationRow {
  engine.appendEvent(row.implementation_request_id, {
    type: 'finalization_retry_pending',
    attemptId: row.implementation_attempt_id,
    data: { finalization_id: row.id, external_run_id: row.external_run_id, reason_code: reasonCode, reason },
    now,
  });
  return getFinalization(row.id) as FinalizationRow;
}

function sameManifest(left: CandidateManifestEntry[], right: CandidateManifestEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Submits one open finalization. Before the first submission the
// candidate is re-read: a manifest that changed since review blocks
// without any finalize call. After submission, every retry sends the
// stored body under the stored key.
export async function runFinalization(id: string): Promise<FinalizationRow | undefined> {
  let row = getFinalization(id);
  if (!row || row.state !== 'preparing') return row;
  const now = () => Date.now();
  if (!hasAgentDeckRunToken()) {
    return finish(row, 'failed', { reasonCode: 'agent_deck_token_missing', reason: AGENT_DECK_API_MESSAGES.agent_deck_token_missing }, now());
  }
  const body = JSON.parse(row.request_body) as FinalizeRequestBody;
  const manifest = db.prepare('SELECT * FROM candidate_manifests WHERE id = ?').get(row.manifest_id) as CandidateManifestRow;
  if (row.submitted_at === null) {
    try {
      const current = await getAgentDeckRunChanges(row.external_run_id);
      if (current.manifestDigest !== manifest.manifest_digest || current.baselineDigest !== manifest.baseline_digest
        || current.baseCommit !== manifest.base_commit || !sameManifest(current.files, body.files)) {
        return finish(row, 'blocked', {
          reasonCode: 'manifest_changed',
          reason: `The workspace changed after review (candidate manifest ${current.manifestDigest}, reviewed ${manifest.manifest_digest}); nothing was committed.`,
        }, now());
      }
    } catch (error) {
      const failure = failureFields(error);
      if (!failure.state) return retryPending(row, failure.reasonCode, failure.reason, now());
      return finish(row, failure.state, { reasonCode: failure.reasonCode, reason: failure.reason }, now());
    }
    db.prepare('UPDATE finalizations SET submitted_at = ?, updated_at = ? WHERE id = ? AND submitted_at IS NULL AND finished_at IS NULL').run(now(), now(), row.id);
    row = getFinalization(id) as FinalizationRow;
  }
  try {
    const result = await finalizeAgentDeckRun(row.external_run_id, body, row.idempotency_key);
    return finish(row, 'committed', {
      commit: result.commit,
      tree: result.tree,
      parent: result.parent,
      manifestDigest: result.manifestDigest,
      fileCount: result.fileCount,
    }, now());
  } catch (error) {
    const failure = failureFields(error);
    if (!failure.state) return retryPending(row, failure.reasonCode, failure.reason, now());
    return finish(row, failure.state, { reasonCode: failure.reasonCode, reason: failure.reason }, now());
  }
}

export function openFinalizationIds(): string[] {
  return (db.prepare("SELECT id FROM finalizations WHERE state = 'preparing' ORDER BY created_at ASC, id ASC").all() as { id: string }[]).map(row => row.id);
}

// Caller-facing summary of a finished finalization, for the coordinator.
export function finalizationEvidence(row: FinalizationRow): string {
  const lines = [
    `Finalization: ${row.id}`,
    `Implementation: ${row.implementation_request_id}`,
    `Review: ${row.review_request_id}`,
    `State: ${row.state}`,
  ];
  if (row.state === 'committed') {
    lines.push(`Commit: ${row.commit_id}`, `Tree: ${row.tree_id}`, `Manifest: ${row.result_manifest_digest}`, `Files: ${row.file_count}`);
  } else if (row.reason_code) {
    lines.push(`Reason: ${row.reason_code}${row.reason ? ` - ${row.reason}` : ''}`);
  }
  return lines.join('\n');
}
