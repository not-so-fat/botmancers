// NOT-473: controlled termination and recovery of canonical Work Requests.
//
// Every command here is one IMMEDIATE transaction over the engine store and
// is idempotent: repeating it reports the same outcome and writes nothing.
//
// Cancel, by starting state:
//   queued, blocked  -> cancelled now (cancel_requested, then cancelled)
//   waiting          -> cancelled now; an open Attempt (its run may still
//                       be live) is finished cancelled/abandoned and the
//                       attention flag is cleared
//   running          -> cancel_requested: the intent is durable, the
//                       owning worker is signalled and ends cancelled; if
//                       it does not stop within the grace (or its lease
//                       is gone) enforcement abandons the Attempt
//   terminal         -> already_terminal, nothing written
//
// Deadlines: a request past deadline_at fails with reason timed_out from
// any non-terminal state, and the dispatcher never claims it. An Attempt
// past its own timeout (retry_policy.attempt_timeout_ms) is abandoned as
// timed_out, which is retryable within the policy.
//
// Abandoning an Attempt is the honest record of what Botmancers knows:
// the Attempt is finished (cancelled or timed_out, category 'abandoned')
// and its lease deleted, so the worker that ran it is fenced. Whether the
// external run was actually stopped is recorded separately
// (external_cancel events) because a runtime may not support it. A result
// the abandoned run returns later is kept as evidence only
// (late_result_recorded, lib/attempt-executor) and never completes the
// request: terminal requests are immutable.
//
// Retry, by starting state: waiting (operator attention) -> queued when
// the bounded budget allows; queued -> already_queued; running/blocked ->
// not_retryable; terminal -> already_terminal; exhausted budget ->
// retries_exhausted.
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { EngineStoreError, TERMINAL_STATES, type EngineStore, type WorkAttempt, type WorkRequest, type WorkRequestState } from './engine-store';
import { attemptDeadline, classifyFailure, decideRetry, storedRetryPolicy, type RetryDecision } from './request-policy';

type Db = Database.Database;

export interface ControlActor {
  kind: string;
  id: string;
}

export type ControlAction = 'cancel' | 'retry';

// Authorization hook: called inside the command's transaction with the
// current request. False refuses the command (ControlError 'forbidden').
export type ControlAuthorizer = (actor: ControlActor, request: WorkRequest, action: ControlAction) => boolean;

export class ControlError extends Error {
  readonly code: 'forbidden' | 'not_found';
  constructor(code: 'forbidden' | 'not_found', message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

// An Attempt abandoned by a command or enforcement. The caller signals its
// local worker and asks the runtime to cancel the run where it can.
export interface AbandonedAttempt {
  requestId: string;
  attemptId: string;
  externalRunId: string | null;
  transport: string | null;
  reason: 'cancelled' | 'timed_out' | 'retried';
  // The Attempt is known to have started a run: its runtime_started event
  // or an external id was recorded. A transport without run ids (Hermes)
  // starts work that may continue even though it cannot be addressed.
  launched: boolean;
}

export type CancelOutcome = 'cancelled' | 'cancel_requested' | 'already_terminal';

export interface CancelResult {
  outcome: CancelOutcome;
  state: WorkRequestState;
  // True when an earlier command already produced this outcome.
  replayed: boolean;
  abandoned: AbandonedAttempt | null;
}

export type RetryOutcome = 'retry_scheduled' | 'already_queued' | 'not_retryable' | 'retries_exhausted' | 'already_terminal';

export interface RetryResult {
  outcome: RetryOutcome;
  state: WorkRequestState;
  abandoned: AbandonedAttempt | null;
}

export interface SettleInput {
  category: string | null;
  code: string | null;
  errorCode: string;
  errorMessage: string;
  // Set when a retry must not launch automatically: the attention reason
  // recorded instead of scheduling the retry.
  attention?: string;
}

export type SettleOutcome = 'retry_scheduled' | 'retries_exhausted' | 'timed_out' | 'attention' | 'failed';

export interface SettleResult {
  outcome: SettleOutcome;
  decision: RetryDecision;
  request: WorkRequest;
}

export type EnforcedOutcome = 'timed_out' | 'cancelled' | SettleOutcome;

export interface EnforcedRequest {
  requestId: string;
  outcome: EnforcedOutcome;
  abandoned: AbandonedAttempt | null;
}

export interface RequestControlOptions {
  now?: () => number;
  // A running request whose cancellation was requested this long ago, and
  // whose worker still holds a live lease, is abandoned by enforcement.
  cancelGraceMs?: number;
}

export const DEFAULT_CANCEL_GRACE_MS = 30_000;

const ACTIVE: WorkRequestState[] = ['queued', 'blocked', 'running', 'waiting'];

function parseSnapshot(attempt: WorkAttempt): Record<string, unknown> {
  try {
    const parsed = JSON.parse(attempt.launch_snapshot);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function attemptDeadlineOf(attempt: WorkAttempt): number | null {
  const value = parseSnapshot(attempt).deadline_at;
  return typeof value === 'number' ? value : null;
}

export function createRequestControl(db: Db, store: EngineStore, options: RequestControlOptions = {}) {
  const clock = options.now ?? Date.now;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const openAttemptOf = db.prepare('SELECT * FROM work_attempts WHERE request_id = ? AND finished_at IS NULL');
  const countAttempts = db.prepare('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ?');
  const leaseOf = db.prepare('SELECT owner, token, expires_at FROM dispatch_leases WHERE request_id = ?');
  const startedEventOf = db.prepare("SELECT 1 FROM engine_events WHERE attempt_id = ? AND type = 'runtime_started' LIMIT 1");

  function requireRequest(id: string): WorkRequest {
    const request = store.getWorkRequest(id);
    if (!request) throw new ControlError('not_found', `No work request ${id}.`);
    return request;
  }

  function authorize(actor: ControlActor | undefined, request: WorkRequest, action: ControlAction, hook: ControlAuthorizer | undefined): void {
    if (hook && (!actor || !hook(actor, request, action))) {
      throw new ControlError('forbidden', `Not allowed to ${action} this request.`);
    }
  }

  // Attempts claimed so far. Rows claimed before NOT-473 have a zero
  // counter, so the Attempt rows are the floor.
  function attemptsUsed(request: WorkRequest): number {
    return Math.max(request.attempt_count, (countAttempts.get(request.id) as { n: number }).n);
  }

  function clearAttention(requestId: string, at: number): void {
    db.prepare('UPDATE dispatch_attention SET cleared_at = ? WHERE request_id = ? AND cleared_at IS NULL').run(at, requestId);
  }

  // Deletes whatever lease the request holds: the worker that held it is
  // fenced from every later write (lib/dispatcher).
  function dropLease(requestId: string, outcome: string, at: number): void {
    const lease = leaseOf.get(requestId) as { owner: string } | undefined;
    if (!lease) return;
    db.prepare('DELETE FROM dispatch_leases WHERE request_id = ?').run(requestId);
    store.appendEvent(requestId, { type: 'dispatch_released', data: { owner: lease.owner, outcome, forced: true }, now: at });
  }

  function abandonOpenAttempt(request: WorkRequest, reason: AbandonedAttempt['reason'], at: number): AbandonedAttempt | null {
    const open = openAttemptOf.get(request.id) as WorkAttempt | undefined;
    if (!open) return null;
    const transport = parseSnapshot(open).transport;
    const messages: Record<AbandonedAttempt['reason'], string> = {
      cancelled: 'The request was cancelled while this Attempt was open; its result is no longer awaited.',
      timed_out: 'The Attempt passed its deadline; its result is no longer awaited.',
      retried: 'An operator retried the request; this Attempt is superseded.',
    };
    store.finishAttempt(open.id, {
      outcome: reason === 'timed_out' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'interrupted',
      errorCategory: 'abandoned',
      errorMessage: messages[reason],
      now: at,
    });
    store.appendEvent(request.id, {
      type: 'attempt_abandoned',
      attemptId: open.id,
      data: { reason, attempt_number: open.attempt_number, external_run_id: open.external_run_id, transport: typeof transport === 'string' ? transport : null },
      now: at,
    });
    return {
      requestId: request.id,
      attemptId: open.id,
      externalRunId: open.external_run_id,
      transport: typeof transport === 'string' ? transport : null,
      reason,
      launched: !!open.external_run_id || !!open.external_session_id || !!startedEventOf.get(open.id),
    };
  }

  function recordCancelIntent(request: WorkRequest, actor: ControlActor | undefined, reason: string | null, at: number): void {
    const by = actor ? `${actor.kind}:${actor.id}` : null;
    db.prepare(
      'UPDATE work_requests SET cancel_requested_at = ?, cancel_requested_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND cancel_requested_at IS NULL'
    ).run(at, by, reason, at, request.id);
    store.appendEvent(request.id, { type: 'cancel_requested', data: { by, reason, state: request.state }, now: at });
  }

  function finishCancelled(request: WorkRequest, at: number, data: Record<string, unknown> = {}): WorkRequest {
    return store.transitionWorkRequest(request.id, {
      from: request.state, to: 'cancelled', reason: 'cancel_requested',
      errorCode: 'cancelled', errorMessage: request.cancel_reason ?? 'The request was cancelled.',
      data, now: at,
    });
  }

  function finishTimedOut(request: WorkRequest, at: number, data: Record<string, unknown> = {}): WorkRequest {
    return store.transitionWorkRequest(request.id, {
      from: request.state, to: 'failed', reason: 'timed_out',
      errorCode: 'timed_out', errorMessage: 'The request passed its deadline.',
      data: { ...data, deadline_at: request.deadline_at }, now: at,
    });
  }

  // The failure outcome of the latest Attempt of a running request, under
  // its bounded policy. Writes the transition (and the attention flag);
  // the caller owns the lease. Call inside a transaction.
  // input.attention: a failure that must not be retried automatically
  // (its run may still be live) waits for an operator instead.
  function settle(request: WorkRequest, input: SettleInput, at: number): SettleResult {
    const policy = storedRetryPolicy(request.retry_policy);
    const disposition = classifyFailure(input.category, input.code);
    const used = attemptsUsed(request);
    const decided = decideRetry({ policy, attemptCount: used, disposition, deadlineAt: request.deadline_at, now: at });
    const decision: RetryDecision = input.attention && decided.action === 'retry' ? { action: 'attention' } : decided;
    const base = { category: input.category, disposition, attempt_count: used, max_attempts: policy.max_attempts };
    switch (decision.action) {
      case 'retry': {
        db.prepare('UPDATE work_requests SET next_eligible_at = ? WHERE id = ?').run(decision.nextEligibleAt, request.id);
        const next = store.transitionWorkRequest(request.id, {
          from: 'running', to: 'queued', reason: 'retry_scheduled',
          data: { ...base, retry: decision.retry, delay_ms: decision.delayMs, next_eligible_at: decision.nextEligibleAt, error_code: input.errorCode },
          now: at,
        });
        return { outcome: 'retry_scheduled', decision, request: next };
      }
      case 'deadline':
        return { outcome: 'timed_out', decision, request: finishTimedOut(request, at, base) };
      case 'attention': {
        const reason = input.attention ?? `failure:${input.category ?? 'unknown'}`;
        db.prepare(
          'INSERT INTO dispatch_attention (id, request_id, attempt_id, reason, detail, created_at) VALUES (?, ?, NULL, ?, ?, ?)'
        ).run(randomUUID(), request.id, reason, input.code, at);
        store.appendEvent(request.id, { type: 'attention_set', data: { reason, detail: input.code }, now: at });
        const next = store.transitionWorkRequest(request.id, {
          from: 'running', to: 'waiting', reason: `manual_attention:${input.attention ?? input.category ?? 'unknown'}`, data: base, now: at,
        });
        return { outcome: 'attention', decision, request: next };
      }
      case 'exhausted':
        // With a one-Attempt policy there was nothing to exhaust: the
        // failure is reported as is (pre-NOT-473 behavior).
        if (policy.max_attempts > 1) {
          return {
            outcome: 'retries_exhausted', decision,
            request: store.transitionWorkRequest(request.id, {
              from: 'running', to: 'failed', reason: 'retries_exhausted',
              errorCode: input.errorCode, errorMessage: input.errorMessage, data: base, now: at,
            }),
          };
        }
        // falls through
      case 'fail':
        return {
          outcome: 'failed', decision,
          request: store.transitionWorkRequest(request.id, {
            from: 'running', to: 'failed', errorCode: input.errorCode, errorMessage: input.errorMessage,
            data: decision.action === 'fail' ? base : {}, now: at,
          }),
        };
    }
  }

  const control = {
    now: clock,
    cancelGraceMs,

    cancel(requestId: string, input: { actor?: ControlActor; reason?: string | null; authorize?: ControlAuthorizer; now?: number } = {}): CancelResult {
      return store.transaction((): CancelResult => {
        const request = requireRequest(requestId);
        authorize(input.actor, request, 'cancel', input.authorize);
        if (TERMINAL_STATES.includes(request.state)) {
          return { outcome: 'already_terminal', state: request.state, replayed: true, abandoned: null };
        }
        const at = input.now ?? clock();
        if (request.state === 'running') {
          if (request.cancel_requested_at !== null) return { outcome: 'cancel_requested', state: 'running', replayed: true, abandoned: null };
          recordCancelIntent(request, input.actor, input.reason ?? null, at);
          return { outcome: 'cancel_requested', state: 'running', replayed: false, abandoned: null };
        }
        if (request.cancel_requested_at === null) recordCancelIntent(request, input.actor, input.reason ?? null, at);
        const current = requireRequest(requestId);
        const abandoned = abandonOpenAttempt(current, 'cancelled', at);
        clearAttention(requestId, at);
        dropLease(requestId, 'cancelled', at);
        const done = finishCancelled(current, at, { from_state: request.state });
        return { outcome: 'cancelled', state: done.state, replayed: false, abandoned };
      });
    },

    retry(requestId: string, input: { actor?: ControlActor; authorize?: ControlAuthorizer; now?: number } = {}): RetryResult {
      return store.transaction((): RetryResult => {
        const request = requireRequest(requestId);
        authorize(input.actor, request, 'retry', input.authorize);
        if (TERMINAL_STATES.includes(request.state)) return { outcome: 'already_terminal', state: request.state, abandoned: null };
        if (request.state === 'queued') return { outcome: 'already_queued', state: 'queued', abandoned: null };
        if (request.state !== 'waiting' || request.cancel_requested_at !== null) {
          return { outcome: 'not_retryable', state: request.state, abandoned: null };
        }
        const policy = storedRetryPolicy(request.retry_policy);
        const used = attemptsUsed(request);
        if (used >= policy.max_attempts) return { outcome: 'retries_exhausted', state: request.state, abandoned: null };
        const at = input.now ?? clock();
        if (request.deadline_at !== null && at >= request.deadline_at) return { outcome: 'not_retryable', state: request.state, abandoned: null };
        const abandoned = abandonOpenAttempt(request, 'retried', at);
        clearAttention(requestId, at);
        db.prepare('UPDATE work_requests SET next_eligible_at = ? WHERE id = ?').run(at, requestId);
        const next = store.transitionWorkRequest(requestId, {
          from: 'waiting', to: 'queued', reason: 'retry_scheduled',
          data: {
            manual: true, by: input.actor ? `${input.actor.kind}:${input.actor.id}` : null,
            attempt_count: used, max_attempts: policy.max_attempts, retry: used, delay_ms: 0, next_eligible_at: at,
          },
          now: at,
        });
        return { outcome: 'retry_scheduled', state: next.state, abandoned };
      });
    },

    // Fails a non-terminal request whose deadline passed. Abandons an open
    // Attempt and drops a lease. Null when the deadline has not passed or
    // the request is already terminal.
    timeOut(requestId: string, now?: number): EnforcedRequest | null {
      return store.transaction((): EnforcedRequest | null => {
        const request = store.getWorkRequest(requestId);
        const at = now ?? clock();
        if (!request || !ACTIVE.includes(request.state) || request.deadline_at === null || at < request.deadline_at) return null;
        const abandoned = abandonOpenAttempt(request, 'timed_out', at);
        clearAttention(requestId, at);
        dropLease(requestId, 'timed_out', at);
        finishTimedOut(request, at, { from_state: request.state });
        return { requestId, outcome: 'timed_out', abandoned };
      });
    },

    // Called by the worker holding the lease, inside the transaction that
    // finishes the Attempt: decides what the failure leads to.
    settleFailure(requestId: string, input: SettleInput, now?: number): SettleResult {
      return store.transaction(() => {
        const request = requireRequest(requestId);
        if (request.state !== 'running') {
          throw new EngineStoreError('stale_state', `Work request ${requestId} is ${request.state}, not running.`);
        }
        return settle(request, input, now ?? clock());
      });
    },

    // Ends a running request whose worker must not decide any more
    // (cancellation intent, its deadline, or the Attempt's own deadline):
    // the decision is durable first, the lease goes, the caller then
    // signals the worker and the runtime. force: the caller holds the
    // lease itself (a reconcile takeover), so no grace is owed to a worker.
    enforceRequest(requestId: string, now?: number, enforceOptions: { force?: boolean } = {}): EnforcedRequest | null {
      return store.transaction((): EnforcedRequest | null => {
        const request = store.getWorkRequest(requestId);
        const at = now ?? clock();
        if (!request || !ACTIVE.includes(request.state) || request.legacy_agent_request_id !== null) return null;
        if (request.deadline_at !== null && at >= request.deadline_at) return control.timeOut(requestId, at);
        if (request.state !== 'running') return null;
        if (request.cancel_requested_at !== null) {
          const lease = leaseOf.get(requestId) as { expires_at: number } | undefined;
          const workerGone = enforceOptions.force === true || !lease || lease.expires_at <= at;
          if (!workerGone && at - request.cancel_requested_at < cancelGraceMs) return null;
          const abandoned = abandonOpenAttempt(request, 'cancelled', at);
          dropLease(requestId, 'cancelled', at);
          finishCancelled(request, at, { abandoned: abandoned !== null });
          return { requestId, outcome: 'cancelled', abandoned };
        }
        const open = openAttemptOf.get(requestId) as WorkAttempt | undefined;
        const deadline = open ? attemptDeadlineOf(open) : null;
        if (!open || deadline === null || at < deadline) return null;
        const abandoned = abandonOpenAttempt(request, 'timed_out', at);
        dropLease(requestId, 'attempt_timed_out', at);
        const settled = settle(requireRequest(requestId), {
          category: 'timed_out', code: null, errorCode: 'timed_out', errorMessage: 'The Attempt passed its deadline.',
        }, at);
        return { requestId, outcome: settled.outcome, abandoned };
      });
    },

    // Requests enforcement may act on now, oldest first.
    dueRequests(now?: number): string[] {
      const at = now ?? clock();
      return (db.prepare(`
        SELECT id FROM work_requests
        WHERE state IN ('queued', 'blocked', 'running', 'waiting') AND legacy_agent_request_id IS NULL AND executor = 'dispatcher'
          AND ((deadline_at IS NOT NULL AND deadline_at <= ?) OR state = 'running')
        ORDER BY created_at ASC, id ASC
      `).all(at) as { id: string }[]).map(row => row.id);
    },

    enforceDue(now?: number): EnforcedRequest[] {
      const at = now ?? clock();
      const done: EnforcedRequest[] = [];
      for (const id of control.dueRequests(at)) {
        const enforced = control.enforceRequest(id, at);
        if (enforced) done.push(enforced);
      }
      return done;
    },

    // The deadline a new Attempt for this request starts with.
    attemptDeadlineFor(request: WorkRequest, startedAt: number): number | null {
      return attemptDeadline(storedRetryPolicy(request.retry_policy), request.deadline_at, startedAt);
    },

    attemptsUsed,
  };
  return control;
}

export type RequestControl = ReturnType<typeof createRequestControl>;
