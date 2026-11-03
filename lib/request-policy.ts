// NOT-473: request-level deadline and bounded retry policy (pure).
//
// Each canonical Work Request stores its retry policy and absolute
// deadline at intake (work_requests.retry_policy, deadline_at); neither
// changes afterwards. The defaults keep pre-NOT-473 behavior: no deadline
// and exactly one Attempt (a failure is final). Retries happen only when a
// request's stored policy allows more than one Attempt, never more than
// MAX_ATTEMPTS_CAP, and only for failures categorized as retryable.
//
// Failure categories:
//   retryable         transient; another Attempt may succeed (runtime
//                     failure, runtime unavailable, a stalled Attempt that
//                     passed its own timeout)
//   terminal          another Attempt would fail the same way (bad launch,
//                     unsupported authority, broken result contract,
//                     cancellation)
//   manual_attention  an operator must act first (credentials, a forked
//                     session); the request waits with the attention flag
import type { AttemptFailureCategory } from './attempt-adapter';

export interface RetryPolicy {
  // Attempts that may run in total, including the first (1 = no retry).
  max_attempts: number;
  // Backoff before retry n (n >= 1): min(max_delay_ms, base_delay_ms * 2^(n-1)).
  base_delay_ms: number;
  max_delay_ms: number;
  // A single Attempt running longer than this is timed out (retryable).
  // Null: only the request deadline bounds an Attempt.
  attempt_timeout_ms: number | null;
}

export const MAX_ATTEMPTS_CAP = 10;

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  max_attempts: 1,
  base_delay_ms: 1_000,
  max_delay_ms: 60_000,
  attempt_timeout_ms: null,
});

export const REQUEST_CONTROL_ENV = {
  deadlineMs: 'BOTMANCERS_REQUEST_DEADLINE_MS',
  maxAttempts: 'BOTMANCERS_RETRY_MAX_ATTEMPTS',
  baseDelayMs: 'BOTMANCERS_RETRY_BASE_DELAY_MS',
  maxDelayMs: 'BOTMANCERS_RETRY_MAX_DELAY_MS',
  attemptTimeoutMs: 'BOTMANCERS_ATTEMPT_TIMEOUT_MS',
} as const;

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Intake defaults from BOTMANCERS_* (resolved once per request and stored).
// Invalid values fall back to the deterministic defaults; max attempts is
// clamped to the cap, so configuration can never make retries unbounded.
// The composed policy is normalized so it always validates: a max delay
// below the base delay (set, or the default left in place) is raised to
// the base, so a stored policy never falls back to one Attempt.
export function requestControlDefaultsFromEnv(env: Record<string, string | undefined> = process.env): { retryPolicy: RetryPolicy; deadlineMs: number | null } {
  const maxAttempts = positiveInt(env[REQUEST_CONTROL_ENV.maxAttempts]);
  const baseDelayMs = positiveInt(env[REQUEST_CONTROL_ENV.baseDelayMs]) ?? DEFAULT_RETRY_POLICY.base_delay_ms;
  const maxDelayMs = positiveInt(env[REQUEST_CONTROL_ENV.maxDelayMs]) ?? DEFAULT_RETRY_POLICY.max_delay_ms;
  const checked = validateRetryPolicy({
    max_attempts: maxAttempts === null ? DEFAULT_RETRY_POLICY.max_attempts : Math.min(maxAttempts, MAX_ATTEMPTS_CAP),
    base_delay_ms: baseDelayMs,
    max_delay_ms: Math.max(maxDelayMs, baseDelayMs),
    attempt_timeout_ms: positiveInt(env[REQUEST_CONTROL_ENV.attemptTimeoutMs]),
  });
  return {
    deadlineMs: positiveInt(env[REQUEST_CONTROL_ENV.deadlineMs]),
    retryPolicy: checked.ok ? checked.policy : { ...DEFAULT_RETRY_POLICY },
  };
}

export type RetryPolicyCheck = { ok: true; policy: RetryPolicy } | { ok: false; reason: string };

export function validateRetryPolicy(value: unknown): RetryPolicyCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'A retry policy is an object.' };
  const input = value as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);
  if (!int(input.max_attempts) || (input.max_attempts as number) < 1 || (input.max_attempts as number) > MAX_ATTEMPTS_CAP) {
    return { ok: false, reason: `max_attempts must be an integer from 1 to ${MAX_ATTEMPTS_CAP}.` };
  }
  if (!int(input.base_delay_ms) || (input.base_delay_ms as number) < 0) return { ok: false, reason: 'base_delay_ms must be a non-negative integer.' };
  if (!int(input.max_delay_ms) || (input.max_delay_ms as number) < (input.base_delay_ms as number)) {
    return { ok: false, reason: 'max_delay_ms must be an integer no smaller than base_delay_ms.' };
  }
  const timeout = input.attempt_timeout_ms ?? null;
  if (timeout !== null && (!int(timeout) || (timeout as number) < 1)) return { ok: false, reason: 'attempt_timeout_ms must be a positive integer or null.' };
  return {
    ok: true,
    policy: {
      max_attempts: input.max_attempts as number,
      base_delay_ms: input.base_delay_ms as number,
      max_delay_ms: input.max_delay_ms as number,
      attempt_timeout_ms: timeout as number | null,
    },
  };
}

// The stored policy of a request; rows from before NOT-473 (null) and
// unreadable values use the default (no retry).
export function storedRetryPolicy(raw: string | null | undefined): RetryPolicy {
  if (!raw) return { ...DEFAULT_RETRY_POLICY };
  try {
    const checked = validateRetryPolicy(JSON.parse(raw));
    return checked.ok ? checked.policy : { ...DEFAULT_RETRY_POLICY };
  } catch {
    return { ...DEFAULT_RETRY_POLICY };
  }
}

export type FailureDisposition = 'retryable' | 'terminal' | 'manual_attention';

// Direct provider and registry codes that need an operator (install or
// sign in the CLI, fix permissions, wait out a limit), whatever the
// adapter category.
const MANUAL_CODES = ['unavailable', 'provider_unavailable', 'agent_not_found', 'auth_required', 'permission_denied', 'incompatible_version', 'usage_limit'];

const DISPOSITION: Record<AttemptFailureCategory, FailureDisposition> = {
  unavailable: 'retryable',
  runtime_failed: 'retryable',
  timed_out: 'retryable',
  launch_failed: 'terminal',
  unsupported_authority: 'terminal',
  result_contract: 'terminal',
  cancelled: 'terminal',
  session_mismatch: 'manual_attention',
};

export function classifyFailure(category: string | null | undefined, code: string | null = null): FailureDisposition {
  if (code && MANUAL_CODES.includes(code)) return 'manual_attention';
  return DISPOSITION[(category ?? 'runtime_failed') as AttemptFailureCategory] ?? 'terminal';
}

// Delay before retry number `retry` (1 = the first retry). Deterministic:
// no jitter, so fake-clock tests and operators see the same schedule.
export function backoffDelay(policy: RetryPolicy, retry: number): number {
  const exponent = Math.max(0, retry - 1);
  return Math.min(policy.max_delay_ms, policy.base_delay_ms * 2 ** Math.min(exponent, 30));
}

export type RetryDecision =
  | { action: 'retry'; nextEligibleAt: number; delayMs: number; retry: number }
  | { action: 'exhausted' }
  | { action: 'deadline' }
  | { action: 'fail'; disposition: 'terminal' }
  | { action: 'attention' };

// What a failed Attempt leads to. attemptCount is the number of Attempts
// already claimed for the request (including the one that just failed).
export function decideRetry(input: {
  policy: RetryPolicy;
  attemptCount: number;
  disposition: FailureDisposition;
  deadlineAt: number | null;
  now: number;
}): RetryDecision {
  if (input.disposition === 'terminal') return { action: 'fail', disposition: 'terminal' };
  const remaining = input.attemptCount < input.policy.max_attempts;
  if (input.disposition === 'manual_attention') return remaining ? { action: 'attention' } : { action: 'fail', disposition: 'terminal' };
  if (!remaining) return { action: 'exhausted' };
  const retry = input.attemptCount;
  const delayMs = backoffDelay(input.policy, retry);
  const nextEligibleAt = input.now + delayMs;
  // A retry that could only become eligible at or after the deadline
  // would never launch: the request times out instead.
  if (input.deadlineAt !== null && nextEligibleAt >= input.deadlineAt) return { action: 'deadline' };
  return { action: 'retry', nextEligibleAt, delayMs, retry };
}

// The deadline of one Attempt started at `startedAt`: its own timeout, the
// request deadline, whichever comes first (null when neither is set).
export function attemptDeadline(policy: RetryPolicy, requestDeadline: number | null, startedAt: number): number | null {
  const own = policy.attempt_timeout_ms === null ? null : startedAt + policy.attempt_timeout_ms;
  if (own === null) return requestDeadline;
  if (requestDeadline === null) return own;
  return Math.min(own, requestDeadline);
}
