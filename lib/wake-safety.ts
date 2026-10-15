// NOT-475: Wake safety policy (docs/design/2026-10-14-wake-safety-contract.md;
// docs/core-engine.md, Wake safety policy). The approved principals, grant
// rules, and limits, plus the durable edit grants they consult:
//
//   principals  human_owner (UI behind the loopback boundary),
//               api_principal (/api/v0 authenticator), agent_principal
//               (engine-derived Wake caller), engine (continuations);
//               anything else is unknown and is refused before persistence
//   grants      conversation/review Wakes: readonly_default
//               implementation/revision: edit_grant for the exact
//               (caller, target) pair, or owner_direct_self_wake
//   limits      depth 3, root budget 12, continuations 24 (2 x budget),
//               global 4 and per-target 1 running Attempts
//
// Enforcement lives where work becomes runnable: lib/wake-router (grants,
// depth, budget), lib/conversation-intake (principal categories),
// lib/coordinator-loop (continuations), lib/dispatcher (an allowed decision
// and the concurrency limits at claim). Every evaluation is recorded in
// wake_safety_decisions with the policy snapshot it used.
import { randomUUID } from 'crypto';
import db, { type Principal } from './db';
import type { SafetyPrincipalType } from './engine-store';

export const WAKE_SAFETY_VERSION = 1;

export interface WakeSafetyLimits {
  maxWakeDepth: number;
  rootBudget: number;
  maxContinuations: number;
  globalConcurrency: number;
  perTargetConcurrency: number;
}

// Approved defaults. Configuration may only narrow them.
export const DEFAULT_WAKE_SAFETY_LIMITS: Readonly<WakeSafetyLimits> = Object.freeze({
  maxWakeDepth: 3,
  rootBudget: 12,
  maxContinuations: 24,
  globalConcurrency: 4,
  perTargetConcurrency: 1,
});

export const WAKE_SAFETY_ENV: Record<'maxWakeDepth' | 'rootBudget', string> = {
  maxWakeDepth: 'BOTMANCERS_WAKE_MAX_DEPTH',
  rootBudget: 'BOTMANCERS_WAKE_ROOT_BUDGET',
};

// Depth and root budget from the environment, never above the approved
// defaults (a value that is not a positive integer, or is larger, keeps
// the default). The continuation cap stays derived: 2 x root budget.
export function wakeSafetyLimits(env: Record<string, string | undefined> = process.env): WakeSafetyLimits {
  const narrowed = (key: 'maxWakeDepth' | 'rootBudget', min: number): number => {
    const raw = env[WAKE_SAFETY_ENV[key]]?.trim();
    const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= min && value < DEFAULT_WAKE_SAFETY_LIMITS[key] ? value : DEFAULT_WAKE_SAFETY_LIMITS[key];
  };
  const rootBudget = narrowed('rootBudget', 1);
  return { ...DEFAULT_WAKE_SAFETY_LIMITS, maxWakeDepth: narrowed('maxWakeDepth', 0), rootBudget, maxContinuations: 2 * rootBudget };
}

export const OWNER_PRINCIPAL: Readonly<Principal> = Object.freeze({ kind: 'person', id: 'local-owner' });

export type CallerCategory = SafetyPrincipalType | 'unknown';

export function isOwnerPrincipal(principal: { kind: string; id: string } | null | undefined): boolean {
  return !!principal && principal.kind === OWNER_PRINCIPAL.kind && principal.id === OWNER_PRINCIPAL.id;
}

// Categorizes a message intake caller at its boundary. The UI surface is
// the human owner only for the owner principal (the loopback boundary in
// proxy.ts admitted the request); the /api/v0 surface is an API principal
// whatever kind the authenticator vouched for, so it never acts as the
// owner or as an Agent. Anything else is unknown.
export function categorizeIntakeCaller(surface: 'ui' | 'api', principal: Principal | null | undefined): CallerCategory {
  if (!principal || !['person', 'bot', 'service'].includes(principal.kind) || typeof principal.id !== 'string' || !principal.id.trim()) return 'unknown';
  if (surface === 'ui') return isOwnerPrincipal(principal) ? 'human_owner' : 'unknown';
  if (surface === 'api') return 'api_principal';
  return 'unknown';
}

export type GrantRule = 'readonly_default' | 'edit_grant' | 'owner_direct_self_wake';

export function needsEditGrant(executionKind: string): boolean {
  return executionKind === 'implementation' || executionKind === 'revision';
}

export interface WakeGrant {
  id: string;
  caller_agent_id: string;
  target_agent_id: string;
  authority: 'edit';
  granted_by_kind: string;
  granted_by_id: string;
  source_wake_id: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by_kind: string | null;
  revoked_by_id: string | null;
}

export type WakeSafetyErrorCode = 'owner_required' | 'not_found' | 'not_pending';

export const WAKE_SAFETY_ERROR_STATUS: Record<WakeSafetyErrorCode, number> = {
  owner_required: 403,
  not_found: 404,
  not_pending: 409,
};

export class WakeSafetyError extends Error {
  readonly code: WakeSafetyErrorCode;
  constructor(code: WakeSafetyErrorCode, message: string) {
    super(message);
    this.name = 'WakeSafetyError';
    this.code = code;
  }
  get status(): number {
    return WAKE_SAFETY_ERROR_STATUS[this.code];
  }
}

// Grant decisions belong to the human owner alone; an API principal (even
// one vouched as person:local-owner) and an Agent never decide.
export function assertOwner(category: CallerCategory): void {
  if (category !== 'human_owner') throw new WakeSafetyError('owner_required', 'Only the owner can allow, deny, or revoke Wake grants.');
}

export function activeEditGrant(callerAgentId: string, targetAgentId: string): WakeGrant | undefined {
  return db.prepare(
    "SELECT * FROM wake_grants WHERE caller_agent_id = ? AND target_agent_id = ? AND authority = 'edit' AND revoked_at IS NULL"
  ).get(callerAgentId, targetAgentId) as WakeGrant | undefined;
}

export function getWakeGrant(id: string): WakeGrant | undefined {
  return db.prepare('SELECT * FROM wake_grants WHERE id = ?').get(id) as WakeGrant | undefined;
}

export function listWakeGrants(options: { includeRevoked?: boolean } = {}): WakeGrant[] {
  return db.prepare(
    `SELECT * FROM wake_grants ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY created_at ASC, id ASC`
  ).all() as WakeGrant[];
}

// The pair's active grant, created when there is none. Callers check the
// owner first and run this inside their transaction.
export function ensureEditGrant(input: { callerAgentId: string; targetAgentId: string; grantedBy: Principal; sourceWakeId: string | null; now: number }): { grant: WakeGrant; created: boolean } {
  const existing = activeEditGrant(input.callerAgentId, input.targetAgentId);
  if (existing) return { grant: existing, created: false };
  const id = randomUUID();
  db.prepare(`
    INSERT INTO wake_grants (id, caller_agent_id, target_agent_id, authority, granted_by_kind, granted_by_id, source_wake_id, created_at)
    VALUES (?, ?, ?, 'edit', ?, ?, ?, ?)
  `).run(id, input.callerAgentId, input.targetAgentId, input.grantedBy.kind, input.grantedBy.id, input.sourceWakeId, input.now);
  return { grant: getWakeGrant(id) as WakeGrant, created: true };
}

// Owner-only. Revocation affects every Wake not yet accepted (new Wakes and
// retries); accepted requests keep their recorded decision. Revoking an
// already revoked grant returns it unchanged.
export function revokeWakeGrant(grantId: string, caller: { category: CallerCategory; principal: Principal }, now: number = Date.now()): { grant: WakeGrant; revoked: boolean } {
  assertOwner(caller.category);
  return db.transaction(() => {
    const grant = getWakeGrant(grantId);
    if (!grant) throw new WakeSafetyError('not_found', `No Wake grant ${grantId}.`);
    if (grant.revoked_at !== null) return { grant, revoked: false };
    db.prepare('UPDATE wake_grants SET revoked_at = ?, revoked_by_kind = ?, revoked_by_id = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, caller.principal.kind, caller.principal.id, grantId);
    // Audit on the request whose Wake asked for the grant, when it exists.
    const source = grant.source_wake_id
      ? db.prepare('SELECT work_request_id FROM wakes WHERE id = ?').get(grant.source_wake_id) as { work_request_id: string | null } | undefined
      : undefined;
    if (source?.work_request_id) {
      db.prepare(`
        INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at)
        SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, NULL, 'grant_revoked', ?, ? FROM engine_events WHERE request_id = ?
      `).run(randomUUID(), source.work_request_id, JSON.stringify({
        grant_id: grant.id, wake_id: grant.source_wake_id, caller_agent_id: grant.caller_agent_id, target_agent_id: grant.target_agent_id,
        decided_by: { kind: caller.principal.kind, id: caller.principal.id },
      }), now, source.work_request_id);
    }
    return { grant: getWakeGrant(grantId) as WakeGrant, revoked: true };
  }).immediate();
}
