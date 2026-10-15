// NOT-469: leased dispatcher for canonical Work Requests.
//
// A worker (one owner id per dispatcher instance) claims a queued request
// in one IMMEDIATE transaction: the queued -> running compare-and-set, a
// lease row with an expiry, and a dispatch_claimed event commit together.
// The Attempt and its launch intent are written before any adapter call
// (the caller does it inside the claim transaction). Every later write for
// the request is fenced by the lease token, so a worker whose lease expired
// and was taken over cannot commit a terminal result.
//
// Recovery never trusts process memory. An expired lease, a lease whose
// local owner process has exited, or a running request with no lease at
// all is taken over (one compare-and-set) and reconciled from the persisted
// Attempt and public runtime evidence through the accepted NOT-468 decision
// table (docs/evidence/NOT-468/decision-record.md). An ambiguous run is
// never relaunched: it is reattached, deferred, or stopped for operator
// attention.
//
// Concurrency: a claim is refused while the global or per-target number of
// leases is at its limit, or while an older claimable request whose target
// has a free slot is still queued (FIFO admission, NOT-475), so a claim by
// id cannot jump ahead of older waiting work. A refused request stays
// queued with a durable dispatch_deferred event, so a later drain or
// restart claims it.
//
// NOT-475: authority is checked where Attempts start, so no path (a direct
// store write, a replayed dispatch, a race with a revocation) can launch
// work the safety policy did not admit. A claim needs the request's latest
// wake_safety_decisions row to be allowed and, for a Wake-created request,
// its Wake to be accepted; otherwise the request fails not_authorized and
// no Attempt is created. The approved defaults are global 4 and per-target
// 1 running Attempts (lib/wake-safety).
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import os from 'os';
import type { EngineStore, WorkRequest } from './engine-store';
import type { AttemptLaunchIntent, RunObservation } from './attempt-adapter';
import { storedRetryPolicy } from './request-policy';
import { createRequestControl } from './work-request-control';

type Db = Database.Database;

export interface DispatchConfig {
  // Leases held at once across all targets.
  maxGlobal: number;
  // Leases held at once for one target Agent.
  maxPerTarget: number;
  // A lease not renewed for this long may be taken over.
  leaseMs: number;
  // How often a live worker renews its lease.
  heartbeatMs: number;
  // Retry delay of a deferred reconcile (Agent Deck unreachable).
  deferMs: number;
  // NOT-473: a running request whose cancellation was requested this long
  // ago is abandoned even while its worker still holds a live lease.
  cancelGraceMs: number;
}

// Deterministic defaults. One run per Agent at a time keeps two edit runs
// out of one working directory.
export const DEFAULT_DISPATCH_CONFIG: Readonly<DispatchConfig> = Object.freeze({
  maxGlobal: 4,
  maxPerTarget: 1,
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  deferMs: 5_000,
  cancelGraceMs: 30_000,
});

export const DISPATCH_CONFIG_ENV: Record<keyof DispatchConfig, string> = {
  maxGlobal: 'BOTMANCERS_DISPATCH_MAX_GLOBAL',
  maxPerTarget: 'BOTMANCERS_DISPATCH_MAX_PER_TARGET',
  leaseMs: 'BOTMANCERS_DISPATCH_LEASE_MS',
  heartbeatMs: 'BOTMANCERS_DISPATCH_HEARTBEAT_MS',
  deferMs: 'BOTMANCERS_DISPATCH_DEFER_MS',
  cancelGraceMs: 'BOTMANCERS_DISPATCH_CANCEL_GRACE_MS',
};

// NOT-475: the approved safety maxima (wake-safety contract, Limits).
// Configuration may narrow the concurrency limits, never raise them.
export const MAX_DISPATCH_CONCURRENCY: Readonly<Pick<DispatchConfig, 'maxGlobal' | 'maxPerTarget'>> = Object.freeze({
  maxGlobal: DEFAULT_DISPATCH_CONFIG.maxGlobal,
  maxPerTarget: DEFAULT_DISPATCH_CONFIG.maxPerTarget,
});

// A value that is not a positive integer falls back to its default, so a
// typo never yields an unbounded or zero-capacity dispatcher. Concurrency
// values above the approved maxima are clamped to them.
export function dispatchConfigFromEnv(env: Record<string, string | undefined> = process.env): DispatchConfig {
  const config = { ...DEFAULT_DISPATCH_CONFIG };
  for (const key of Object.keys(DISPATCH_CONFIG_ENV) as (keyof DispatchConfig)[]) {
    const raw = env[DISPATCH_CONFIG_ENV[key]];
    if (raw === undefined || !/^\d+$/.test(raw.trim())) continue;
    const value = Number(raw.trim());
    if (Number.isSafeInteger(value) && value > 0) config[key] = value;
  }
  config.maxGlobal = Math.min(config.maxGlobal, MAX_DISPATCH_CONCURRENCY.maxGlobal);
  config.maxPerTarget = Math.min(config.maxPerTarget, MAX_DISPATCH_CONCURRENCY.maxPerTarget);
  return config;
}

export interface DispatchLease {
  requestId: string;
  owner: string;
  token: string;
  expiresAt: number;
}

// NOT-473: 'not_eligible' is a retry still in its backoff, 'timed_out' a
// request past its deadline (failed timed_out by the refused claim), and
// 'exhausted' a request with no Attempt left in its bounded budget.
// NOT-475: 'older_waiting' is capacity this request could use going to an
// older claimable request first (FIFO admission); blockedBy names it.
export type ClaimRefusal = 'not_queued' | 'attention' | 'global_limit' | 'target_limit' | 'older_waiting' | 'not_eligible' | 'timed_out' | 'exhausted' | 'not_authorized';

export type ClaimResult =
  | { ok: true; lease: DispatchLease; request: WorkRequest }
  | { ok: false; reason: ClaimRefusal; blockedBy?: string };

export type RecoveryReason = 'lease_expired' | 'owner_exited' | 'unleased_running';

export interface RecoverableRequest {
  requestId: string;
  reason: RecoveryReason;
  // The lease being taken over; null for a running request without one.
  priorToken: string | null;
  priorOwner: string | null;
}

export interface LaunchIntentRow {
  attempt_id: string;
  request_id: string;
  transport: string;
  idempotency_key: string | null;
  body: string | null;
  body_hash: string | null;
  grant_fingerprint: string | null;
  owner: string;
  created_at: number;
}

export interface AttentionRow {
  id: string;
  request_id: string;
  attempt_id: string | null;
  reason: string;
  detail: string | null;
  created_at: number;
  cleared_at: number | null;
}

export class LeaseLostError extends Error {
  readonly requestId: string;
  constructor(requestId: string) {
    super(`The dispatch lease for ${requestId} is no longer held.`);
    this.name = 'LeaseLostError';
    this.requestId = requestId;
  }
}

// Owner ids name the host and process, so a restarted process can tell a
// lease left by an exited local process from one held by a live worker.
export function newDispatchOwner(): string {
  return `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function localOwnerExited(owner: string): boolean {
  const match = /^(.*):(\d+):[^:]+$/.exec(owner);
  if (!match || match[1] !== os.hostname()) return false;
  const pid = Number(match[2]);
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Test seam for crash injection at dispatch boundaries. Production never
// sets it.
export type DispatchFaultPoint = 'before_launch' | 'after_run_id_persisted' | 'before_terminal_commit';
let faultHook: ((point: DispatchFaultPoint, requestId: string) => void) | null = null;

export function setDispatchFaultHook(next: ((point: DispatchFaultPoint, requestId: string) => void) | null): void {
  faultHook = next;
}

export function dispatchFault(point: DispatchFaultPoint, requestId: string): void {
  faultHook?.(point, requestId);
}

export interface DispatcherOptions {
  owner?: string;
  config?: Partial<DispatchConfig>;
  now?: () => number;
}

export function createDispatcher(db: Db, store: EngineStore, options: DispatcherOptions = {}) {
  const owner = options.owner ?? newDispatchOwner();
  const config: DispatchConfig = { ...dispatchConfigFromEnv(), ...(options.config ?? {}) };
  const now = options.now ?? Date.now;
  const control = createRequestControl(db, store, { now, cancelGraceMs: config.cancelGraceMs });

  const countAll = db.prepare('SELECT COUNT(*) AS n FROM dispatch_leases');
  const countTarget = db.prepare('SELECT COUNT(*) AS n FROM dispatch_leases WHERE target_agent_id = ?');
  const openAttention = db.prepare('SELECT * FROM dispatch_attention WHERE request_id = ? AND cleared_at IS NULL');
  const lastEvent = db.prepare('SELECT type, data FROM engine_events WHERE request_id = ? ORDER BY sequence DESC LIMIT 1');
  const held = db.prepare('SELECT 1 FROM dispatch_leases WHERE request_id = ? AND token = ?');
  const latestDecision = db.prepare('SELECT decision FROM wake_safety_decisions WHERE request_id = ? ORDER BY sequence DESC LIMIT 1');
  const wakeStatus = db.prepare('SELECT status FROM wakes WHERE id = ?');

  function authorityProblem(request: WorkRequest): string | null {
    const decision = latestDecision.get(request.id) as { decision: string } | undefined;
    if (decision?.decision !== 'allowed') return 'The request has no allowed safety decision.';
    if (request.wake_event_id !== null) {
      const wake = wakeStatus.get(request.wake_event_id) as { status: string } | undefined;
      if (wake?.status !== 'accepted') return 'The Wake that created this request was not accepted.';
    }
    return null;
  }

  // The oldest queued request created before this one that its own claim
  // would admit now: eligible, before its deadline, no open attention, an
  // allowed latest decision (and an accepted Wake), and a target with a
  // free slot. Same order as claimNext.
  const olderClaimable = db.prepare(`
    SELECT w.id FROM work_requests w
    WHERE w.state = 'queued' AND w.legacy_agent_request_id IS NULL AND w.id <> ?
      AND (w.created_at < ? OR (w.created_at = ? AND w.rowid < (SELECT rowid FROM work_requests WHERE id = ?)))
      AND (w.next_eligible_at IS NULL OR w.next_eligible_at <= ?)
      AND (w.deadline_at IS NULL OR w.deadline_at > ?)
      AND NOT EXISTS (SELECT 1 FROM dispatch_attention a WHERE a.request_id = w.id AND a.cleared_at IS NULL)
      AND (SELECT d.decision FROM wake_safety_decisions d WHERE d.request_id = w.id ORDER BY d.sequence DESC LIMIT 1) = 'allowed'
      AND (w.wake_event_id IS NULL OR EXISTS (SELECT 1 FROM wakes k WHERE k.id = w.wake_event_id AND k.status = 'accepted'))
      AND (SELECT COUNT(*) FROM dispatch_leases l WHERE l.target_agent_id = w.target_agent_id) < ?
    ORDER BY w.created_at ASC, w.rowid ASC
    LIMIT 1
  `);

  function deferClaim(request: WorkRequest, reason: 'global_limit' | 'target_limit' | 'older_waiting', active: { global: number; target: number }, blockedBy?: string): ClaimResult {
    // One deferral event per wait, not one per refused poll.
    const last = lastEvent.get(request.id) as { type: string; data: string | null } | undefined;
    const lastReason = last?.type === 'dispatch_deferred' && last.data ? (JSON.parse(last.data) as { reason?: string }).reason : null;
    if (lastReason !== reason) {
      store.appendEvent(request.id, {
        type: 'dispatch_deferred',
        data: {
          reason, active_global: active.global, active_target: active.target, max_global: config.maxGlobal, max_per_target: config.maxPerTarget,
          ...(blockedBy ? { waiting_behind: blockedBy } : {}),
        },
        now: now(),
      });
    }
    return blockedBy ? { ok: false, reason, blockedBy } : { ok: false, reason };
  }

  function requireHeld(lease: DispatchLease): void {
    if (!held.get(lease.requestId, lease.token)) throw new LeaseLostError(lease.requestId);
  }

  const dispatcher = {
    owner,
    config,
    // The dispatcher's clock (injectable for fake-clock tests) and the
    // request control commands bound to it (lib/work-request-control).
    now,
    control,

    // Claims one queued request: the lifecycle compare-and-set, the lease,
    // and the claim event commit together. Callers create the Attempt and
    // its launch intent in the same transaction (wrap both in
    // store.transaction) so a claimed request always has them.
    claim(requestId: string, claimOptions: { expectedVersion?: number; data?: Record<string, unknown> } = {}): ClaimResult {
      return store.transaction((): ClaimResult => {
        const request = store.getWorkRequest(requestId);
        if (!request || request.state !== 'queued') return { ok: false, reason: 'not_queued' };
        if (claimOptions.expectedVersion !== undefined && request.version !== claimOptions.expectedVersion) {
          return { ok: false, reason: 'not_queued' };
        }
        const at = now();
        // NOT-473: nothing launches after the deadline; the refused claim
        // records the timeout itself.
        if (request.deadline_at !== null && at >= request.deadline_at) {
          control.timeOut(requestId, at);
          return { ok: false, reason: 'timed_out' };
        }
        if (request.next_eligible_at !== null && at < request.next_eligible_at) return { ok: false, reason: 'not_eligible' };
        if (openAttention.get(requestId)) return { ok: false, reason: 'attention' };
        const unauthorized = authorityProblem(request);
        if (unauthorized) {
          store.transitionWorkRequest(requestId, {
            from: 'queued', to: 'failed', reason: 'not_authorized', expectedVersion: request.version,
            errorCode: 'not_authorized', errorMessage: unauthorized, now: at,
          });
          return { ok: false, reason: 'not_authorized' };
        }
        // Defense in depth: the budget is checked where Attempts start, so
        // no path can launch past it.
        const policy = storedRetryPolicy(request.retry_policy);
        const used = control.attemptsUsed(request);
        if (used >= policy.max_attempts) {
          store.transitionWorkRequest(requestId, {
            from: 'queued', to: 'failed', reason: 'retries_exhausted', expectedVersion: request.version,
            errorCode: 'retries_exhausted', errorMessage: 'No Attempt is left in the retry budget.',
            data: { attempt_count: used, max_attempts: policy.max_attempts }, now: at,
          });
          return { ok: false, reason: 'exhausted' };
        }
        const global = (countAll.get() as { n: number }).n;
        const target = (countTarget.get(request.target_agent_id) as { n: number }).n;
        if (global >= config.maxGlobal) return deferClaim(request, 'global_limit', { global, target });
        if (target >= config.maxPerTarget) return deferClaim(request, 'target_limit', { global, target });
        // FIFO admission (contract, Limits): a free slot goes to the oldest
        // claimable request whose target has room, whichever path asked.
        const older = olderClaimable.get(
          requestId, request.created_at, request.created_at, requestId, at, at, config.maxPerTarget
        ) as { id: string } | undefined;
        if (older) return deferClaim(request, 'older_waiting', { global, target }, older.id);
        const lease: DispatchLease = { requestId, owner, token: randomUUID(), expiresAt: at + config.leaseMs };
        db.prepare(`
          INSERT INTO dispatch_leases (request_id, target_agent_id, owner, token, acquired_at, heartbeat_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(requestId, request.target_agent_id, owner, lease.token, at, at, lease.expiresAt);
        store.appendEvent(requestId, {
          type: 'dispatch_claimed',
          data: {
            owner, lease_expires_at: lease.expiresAt, active_global: global + 1, active_target: target + 1,
            attempt_number: used + 1, max_attempts: policy.max_attempts,
          },
          now: at,
        });
        db.prepare('UPDATE work_requests SET attempt_count = ?, next_eligible_at = NULL WHERE id = ?').run(used + 1, requestId);
        const running = store.transitionWorkRequest(requestId, {
          from: 'queued', to: 'running', expectedVersion: request.version, data: claimOptions.data, now: at,
        });
        return { ok: true, lease, request: running };
      });
    },

    // Claims the oldest claimable request among candidates (all queued
    // canonical requests when omitted). A target at its limit is skipped;
    // the global limit stops the scan.
    claimNext(candidates?: string[]): ClaimResult {
      const ids = candidates ?? (db.prepare(`
        SELECT id FROM work_requests WHERE state = 'queued' AND legacy_agent_request_id IS NULL
          AND (next_eligible_at IS NULL OR next_eligible_at <= ?)
        ORDER BY created_at ASC, rowid ASC
      `).all(now()) as { id: string }[]).map(row => row.id);
      let refusal: ClaimRefusal = 'not_queued';
      for (const id of ids) {
        const claimed = dispatcher.claim(id);
        if (claimed.ok || claimed.reason === 'global_limit') return claimed;
        if (claimed.reason === 'target_limit' || claimed.reason === 'older_waiting') refusal = claimed.reason;
      }
      return { ok: false, reason: refusal };
    },

    // Durable before the adapter runs. Fenced.
    recordLaunchIntent(lease: DispatchLease, attemptId: string, transport: string, intent: AttemptLaunchIntent | null): LaunchIntentRow {
      return store.transaction(() => {
        requireHeld(lease);
        const at = now();
        const bodyHash = intent ? createHash('sha256').update(intent.body).digest('hex') : null;
        db.prepare(`
          INSERT INTO attempt_launch_intents (attempt_id, request_id, transport, idempotency_key, body, body_hash, grant_fingerprint, owner, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attemptId, lease.requestId, transport, intent?.idempotencyKey ?? null, intent?.body ?? null, bodyHash,
          intent?.grantFingerprint ?? null, owner, at
        );
        store.appendEvent(lease.requestId, {
          type: 'launch_intent_recorded',
          attemptId,
          data: { transport, idempotency_key: intent?.idempotencyKey ?? null, body_hash: bodyHash, grant_fingerprint: intent?.grantFingerprint ?? null },
          now: at,
        });
        return dispatcher.launchIntent(attemptId) as LaunchIntentRow;
      });
    },

    launchIntent(attemptId: string): LaunchIntentRow | undefined {
      return db.prepare('SELECT * FROM attempt_launch_intents WHERE attempt_id = ?').get(attemptId) as LaunchIntentRow | undefined;
    },

    // Renews the lease. False once it was taken over or released.
    heartbeat(lease: DispatchLease): boolean {
      const at = now();
      const expiresAt = at + config.leaseMs;
      const changed = db.prepare(
        'UPDATE dispatch_leases SET heartbeat_at = ?, expires_at = ? WHERE request_id = ? AND token = ?'
      ).run(at, expiresAt, lease.requestId, lease.token).changes === 1;
      if (changed) lease.expiresAt = expiresAt;
      return changed;
    },

    holds(lease: DispatchLease): boolean {
      return !!held.get(lease.requestId, lease.token);
    },

    // Throws LeaseLostError unless the lease is still held. Call inside the
    // transaction whose writes it fences.
    assertHeld(lease: DispatchLease): void {
      requireHeld(lease);
    },

    // Ends the lease with the request's outcome. Fenced.
    release(lease: DispatchLease, outcome: string): void {
      store.transaction(() => {
        requireHeld(lease);
        db.prepare('DELETE FROM dispatch_leases WHERE request_id = ? AND token = ?').run(lease.requestId, lease.token);
        store.appendEvent(lease.requestId, { type: 'dispatch_released', data: { owner, outcome }, now: now() });
      });
    },

    // Keeps the lease (and its concurrency slot) but lets it expire after
    // the defer delay, so the next sweep reconciles again. Fenced.
    defer(lease: DispatchLease, reason: string, attemptId: string | null = null): void {
      store.transaction(() => {
        requireHeld(lease);
        const at = now();
        lease.expiresAt = at + config.deferMs;
        db.prepare('UPDATE dispatch_leases SET heartbeat_at = ?, expires_at = ? WHERE request_id = ? AND token = ?')
          .run(at, lease.expiresAt, lease.requestId, lease.token);
        store.appendEvent(lease.requestId, { type: 'reconcile_deferred', attemptId, data: { owner, reason, retry_at: lease.expiresAt }, now: at });
      });
    },

    // Sets the operator-attention flag, moves the request to waiting, and
    // releases the lease, in one fenced transaction. Nothing automatic
    // launches, re-POSTs, retries, or resumes the request until an
    // operator clears the flag.
    setAttention(lease: DispatchLease, input: { attemptId: string | null; reason: string; detail?: string | null }): AttentionRow {
      return store.transaction(() => {
        requireHeld(lease);
        const at = now();
        const id = randomUUID();
        db.prepare(
          'INSERT INTO dispatch_attention (id, request_id, attempt_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, lease.requestId, input.attemptId, input.reason, input.detail ?? null, at);
        store.appendEvent(lease.requestId, {
          type: 'attention_set', attemptId: input.attemptId, data: { reason: input.reason, detail: input.detail ?? null }, now: at,
        });
        const request = store.getWorkRequest(lease.requestId);
        if (request?.state === 'running') {
          store.transitionWorkRequest(lease.requestId, { from: 'running', to: 'waiting', reason: `manual_attention:${input.reason}`, now: at });
        }
        db.prepare('DELETE FROM dispatch_leases WHERE request_id = ? AND token = ?').run(lease.requestId, lease.token);
        store.appendEvent(lease.requestId, { type: 'dispatch_released', data: { owner, outcome: 'attention' }, now: at });
        return openAttention.get(lease.requestId) as AttentionRow;
      });
    },

    attention(requestId: string): AttentionRow | undefined {
      return openAttention.get(requestId) as AttentionRow | undefined;
    },

    // Requests a sweep may take over: expired leases, leases of an exited
    // local owner, and running requests with no lease and no open flag
    // (left by a crash before this dispatcher existed, NOT-468 F1).
    recoverable(): RecoverableRequest[] {
      const at = now();
      const found: RecoverableRequest[] = [];
      const leases = db.prepare('SELECT request_id, owner, token, expires_at FROM dispatch_leases ORDER BY acquired_at ASC, request_id ASC')
        .all() as { request_id: string; owner: string; token: string; expires_at: number }[];
      for (const row of leases) {
        if (row.owner === owner && row.expires_at > at) continue;
        const reason: RecoveryReason | null = row.expires_at <= at ? 'lease_expired' : localOwnerExited(row.owner) ? 'owner_exited' : null;
        if (reason) found.push({ requestId: row.request_id, reason, priorToken: row.token, priorOwner: row.owner });
      }
      const orphans = db.prepare(`
        SELECT w.id FROM work_requests w
        WHERE w.state = 'running' AND w.legacy_agent_request_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM dispatch_leases l WHERE l.request_id = w.id)
          AND NOT EXISTS (SELECT 1 FROM dispatch_attention a WHERE a.request_id = w.id AND a.cleared_at IS NULL)
        ORDER BY w.updated_at ASC, w.id ASC
      `).all() as { id: string }[];
      for (const row of orphans) found.push({ requestId: row.id, reason: 'unleased_running', priorToken: null, priorOwner: null });
      return found;
    },

    // Compare-and-set takeover. Null when another worker got there first
    // or the lease was renewed. Not subject to the concurrency limits: the
    // request already holds its slot (or its run may be live).
    takeOver(item: RecoverableRequest): DispatchLease | null {
      return store.transaction((): DispatchLease | null => {
        const at = now();
        const lease: DispatchLease = { requestId: item.requestId, owner, token: randomUUID(), expiresAt: at + config.leaseMs };
        if (item.priorToken) {
          const guard = item.reason === 'lease_expired' ? 'AND expires_at <= ?' : '';
          const args: unknown[] = [owner, lease.token, at, at, lease.expiresAt, item.requestId, item.priorToken];
          if (guard) args.push(at);
          const changed = db.prepare(`
            UPDATE dispatch_leases SET owner = ?, token = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
            WHERE request_id = ? AND token = ? ${guard}
          `).run(...args).changes;
          if (changed !== 1) return null;
        } else {
          const request = store.getWorkRequest(item.requestId);
          if (!request || request.state !== 'running') return null;
          if (db.prepare('SELECT 1 FROM dispatch_leases WHERE request_id = ?').get(item.requestId)) return null;
          if (openAttention.get(item.requestId)) return null;
          db.prepare(`
            INSERT INTO dispatch_leases (request_id, target_agent_id, owner, token, acquired_at, heartbeat_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(item.requestId, request.target_agent_id, owner, lease.token, at, at, lease.expiresAt);
        }
        store.appendEvent(item.requestId, {
          type: 'dispatch_lease_taken_over',
          data: { owner, previous_owner: item.priorOwner, reason: item.reason },
          now: at,
        });
        return lease;
      });
    },

    leaseOf(requestId: string): { owner: string; token: string; expires_at: number } | undefined {
      return db.prepare('SELECT owner, token, expires_at FROM dispatch_leases WHERE request_id = ?').get(requestId) as
        { owner: string; token: string; expires_at: number } | undefined;
    },
  };
  return dispatcher;
}

export type Dispatcher = ReturnType<typeof createDispatcher>;

// ---------------------------------------------------------------------
// Accepted NOT-468 decision table (docs/evidence/NOT-468/decision-record.md).
// Pure: the caller gathers evidence, these choose the action.

export type ReconcileDecision =
  // Keep the Attempt open and observe it to a terminal result.
  | { action: 'reattach' }
  // Re-send the persisted launch intent under its key (table A).
  | { action: 'repost' }
  // Terminal 'interrupted' and set the attention flag (a died run).
  | { action: 'interrupted_attention'; reason: string }
  // Keep the Attempt open and set the attention flag.
  | { action: 'attention'; reason: string }
  // Keep the Attempt open; reconcile again after a delay.
  | { action: 'defer'; reason: string }
  // Terminal 'failed' with a category; no model work ran.
  | { action: 'fail'; category: 'launch_failed'; code: string }
  // Terminal 'interrupted'; the transport cannot be observed after a
  // restart, so the outcome is unknown. Retryable by an operator, never
  // relaunched automatically.
  | { action: 'interrupted'; reason: string };

// Pre-launch rejections: Agent Deck refused before any model work, so the
// Attempt fails and a later fresh Attempt is safe.
const PRE_LAUNCH_REJECTIONS: { status: number; code: RegExp }[] = [
  { status: 400, code: /.*/ },
  { status: 404, code: /^DECK_NOT_FOUND$/ },
  { status: 422, code: /^(WORKSPACE_[A-Z0-9_]+|PROFILE_UNSUPPORTED|RESUME_UNVERIFIED|FINALIZATION_INVALID)$/ },
  { status: 409, code: /^INDEX_DIRTY$/ },
  { status: 503, code: /^CLIENT_UNAVAILABLE$/ },
];

function preLaunchRejection(observation: { status: number | null; code: string | null }): boolean {
  return PRE_LAUNCH_REJECTIONS.some(rule => rule.status === observation.status && rule.code.test(observation.code ?? ''));
}

// A failed live POST: true only when Agent Deck provably started no model
// work (no grant was sent, the grant was refused, or a known pre-launch
// rejection). Anything else (unreachable, a lost response, 5xx, an
// unrecognized answer) is ambiguous: the run may be live, so the Attempt
// stays open for same-key reconciliation.
export function launchRejectedBeforeWork(observation: RunObservation): boolean {
  switch (observation.kind) {
    case 'no_grant':
    case 'unauthorized':
    case 'forbidden':
      return true;
    case 'rejected':
      return preLaunchRejection(observation);
    default:
      return false;
  }
}

// Table A: the Attempt is open and has no run id. Decides whether a
// re-POST is safe at all.
export function decideWithoutRunId(input: {
  reconcilable: boolean;
  intent: Pick<LaunchIntentRow, 'body' | 'idempotency_key' | 'grant_fingerprint'> | undefined;
  currentGrantFingerprint: string | null;
}): ReconcileDecision {
  if (!input.reconcilable) return { action: 'interrupted', reason: 'runtime_unobservable' };
  if (!input.intent?.body || !input.intent.idempotency_key) return { action: 'attention', reason: 'launch_intent_missing' };
  if (!input.currentGrantFingerprint) return { action: 'attention', reason: 'grant_unavailable' };
  // Never POST under another grant: it could launch a second run (N5c).
  if (input.intent.grant_fingerprint !== input.currentGrantFingerprint) return { action: 'attention', reason: 'grant_mismatch' };
  return { action: 'repost' };
}

// Table A: the answer to the re-POST.
export function decideRepostResult(observation: RunObservation): ReconcileDecision {
  switch (observation.kind) {
    case 'accepted': return { action: 'reattach' };
    case 'unreachable': return { action: 'defer', reason: 'unreachable' };
    case 'unauthorized':
    case 'forbidden':
    case 'no_grant': return { action: 'attention', reason: 'grant' };
    case 'rejected':
      if (observation.status === 409 && observation.code === 'IDEMPOTENCY_CONFLICT') return { action: 'attention', reason: 'idempotency_conflict' };
      if (preLaunchRejection(observation)) return { action: 'fail', category: 'launch_failed', code: observation.code ?? String(observation.status) };
      if (observation.status !== null && observation.status >= 500) return { action: 'defer', reason: 'server_error' };
      return { action: 'attention', reason: 'unrecognized_response' };
    default:
      return { action: 'attention', reason: 'unrecognized_response' };
  }
}

// Table B: the Attempt is open and has a run id; the observation is the
// read-only GET status answer.
export function decideWithRunId(observation: RunObservation): ReconcileDecision {
  switch (observation.kind) {
    case 'run':
      // starting/running reattach; ended/error/canceled reattach too: the
      // follow reads the terminal page and yields the same result contract
      // as a live run (succeeded, result_contract, runtime_failed,
      // cancelled).
      if (observation.state === 'died') return { action: 'interrupted_attention', reason: 'run_died' };
      return { action: 'reattach' };
    case 'not_found': return { action: 'attention', reason: 'run_not_found' };
    case 'unauthorized': return { action: 'attention', reason: 'grant_expired' };
    case 'forbidden': return { action: 'attention', reason: 'grant_scope' };
    case 'no_grant': return { action: 'attention', reason: 'grant_unavailable' };
    case 'unreachable': return { action: 'defer', reason: 'unreachable' };
    case 'rejected':
      if (observation.status !== null && observation.status >= 500) return { action: 'defer', reason: 'server_error' };
      return { action: 'attention', reason: 'unrecognized_response' };
    default:
      return { action: 'attention', reason: 'unrecognized_response' };
  }
}
