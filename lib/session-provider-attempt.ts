// NOT-542: direct SessionProvider single-Attempt adapter (./attempt-adapter
// contract) over Botmancers' own provider-session registry
// (./provider-sessions). One Attempt is one provider turn: a fresh Attempt
// starts a new session in the explicit absolute cwd, a bound Attempt sends
// to that exact Botmancers provider-session ref. No Agent Deck API or CLI
// is ever contacted; the provider is selected by the Agent's runtime
// connection, never by the adapter.
//
// Authority is exactly the input's tool profile (readonly -> read_only,
// edit -> workspace_write), never inferred from the provider or Agent type.
// The provider idempotency key derives deterministically from the frozen
// Attempt correlation (attemptId when present), so replaying the same
// Attempt returns the original provider turn instead of starting a second
// one. The provider turn ref is the Attempt's external run identity and the
// provider session ref its external session identity; both stay opaque to
// the Work Request engine.
//
// Terminal translation: provider completed/failed/cancelled become
// completed/failed with a stable failure category, bounded output (32k,
// outputTruncated when cut), normalized usage, durable start/finish times,
// and the cancel outcome. Provider diagnostics never leak verbatim: failure
// messages are fixed per category and only the stable provider code is
// kept. prepareFinalization is refused explicitly: Agent Deck Git
// finalization is not reimplemented here.
//
// Restart: the reconciler reads the durable provider turn (inspect/follow)
// and replays the persisted launch intent through the registry's own
// idempotency (repost), never spawning a second runtime process. No grant
// fingerprint is used.
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import defaultDb from './db';
import {
  attemptFailure,
  interruption,
  preLaunchInterruption,
  type AttemptAdapter,
  type AttemptEventSink,
  type AttemptFailure,
  type AttemptFailureCategory,
  type AttemptFinalizationEvidence,
  type AttemptFollowInput,
  type AttemptInput,
  type AttemptLaunchIntent,
  type AttemptReconciler,
  type AttemptResult,
} from './attempt-adapter';
import { attemptPromptText } from './attempt-prompt';
import {
  cancelProviderTurn,
  getProviderTurn,
  observeProviderTurn,
  sendProviderTurn,
  startProviderSession,
  ProviderSessionError,
  type ProviderTurnView,
  type Requester,
} from './provider-sessions';
import type { SessionAuthority } from './session-provider';
import { usageFromEvent } from './usage';

type Db = Database.Database;

export const NAME = 'session-provider' as const;

// The largest Attempt output this adapter returns, truncation marker
// included. Matches the largest hop bound (extraction), so an exchange hop
// through here is never cut twice.
export const SESSION_PROVIDER_ATTEMPT_OUTPUT_LIMIT = 32_000;
const TRUNCATED = '\n[truncated]';

// The engine service identity every Attempt turn runs as. Fixed and
// deterministic: replaying the same Attempt correlation reuses the same
// requester and key, so the registry returns the original turn.
const ATTEMPT_REQUESTER: Requester = Object.freeze({ kind: 'service', id: 'botmancers-attempt' });

function boundOutput(text: string, limit: number): { content: string; truncated: boolean } {
  if (text.length <= limit) return { content: text, truncated: false };
  if (limit <= TRUNCATED.length) return { content: text.slice(0, limit), truncated: true };
  return { content: `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`, truncated: true };
}

function authorityFor(toolProfile: unknown): SessionAuthority | null {
  if (toolProfile === 'readonly') return 'read_only';
  if (toolProfile === 'edit') return 'workspace_write';
  return null;
}

// Deterministic per Attempt, so a repeated run of the same frozen input
// returns the original provider turn. Engine Attempts always carry an
// attemptId (beginAttempt freezes it in); direct turns without one hash
// their stable fields instead, so distinct prompts never collide.
export function sessionProviderIdempotencyKey(input: Readonly<AttemptInput>): string {
  const attemptId = input.correlation?.attemptId;
  if (typeof attemptId === 'string' && attemptId) return `botmancers-attempt-${attemptId}`;
  const hash = createHash('sha256').update(JSON.stringify({
    requestId: input.correlation?.requestId ?? null,
    conversationId: input.correlation?.conversationId ?? null,
    agentId: input.target.agentId,
    prompt: input.prompt,
    cwd: input.cwd,
    toolProfile: input.toolProfile,
    binding: input.sessionBinding?.externalSessionId ?? null,
  })).digest('hex').slice(0, 32);
  return `botmancers-direct-${hash}`;
}

export function sessionProviderRequester(): Requester {
  return { ...ATTEMPT_REQUESTER };
}

// What run() would send, or why it cannot launch. Deterministic for a
// frozen input, so the persisted intent is byte-identical to the launch.
interface LaunchPlan {
  kind: 'start' | 'send';
  agentId: string;
  workspace: string | null;
  sessionRef: string | null;
  prompt: string;
  authority: SessionAuthority;
}

function planFor(input: Readonly<AttemptInput>): { ok: true; plan: LaunchPlan } | { ok: false; failure: AttemptFailure } {
  if (input.prepareFinalization === true) {
    return { ok: false, failure: attemptFailure('unsupported_authority', 'Session provider attempts do not support prepareFinalization.') };
  }
  if (input.freshSession && input.sessionBinding) {
    return { ok: false, failure: attemptFailure('session_mismatch', 'A fresh-session turn cannot resume a session.') };
  }
  const authority = authorityFor(input.toolProfile);
  if (!authority) {
    return { ok: false, failure: attemptFailure('unsupported_authority', `Unsupported tool profile: ${JSON.stringify(String(input.toolProfile))}.`) };
  }
  const prompt = attemptPromptText(input.prompt);
  if (!prompt.trim()) {
    return { ok: false, failure: attemptFailure('launch_failed', 'The attempt prompt is empty.') };
  }
  if (input.sessionBinding) {
    const ref = input.sessionBinding.externalSessionId;
    if (typeof ref !== 'string' || !ref) {
      return { ok: false, failure: attemptFailure('launch_failed', 'The session binding names no session.') };
    }
    return { ok: true, plan: { kind: 'send', agentId: input.target.agentId, workspace: null, sessionRef: ref, prompt, authority } };
  }
  if (typeof input.cwd !== 'string' || !input.cwd.startsWith('/')) {
    return { ok: false, failure: attemptFailure('unavailable', 'A session provider start requires an absolute working directory.') };
  }
  return { ok: true, plan: { kind: 'start', agentId: input.target.agentId, workspace: input.cwd, sessionRef: null, prompt, authority } };
}

// The persisted launch body: everything repost needs to replay the same
// registry call under the intent's key. Keys in fixed order for stable JSON.
interface LaunchBody {
  agentId: string;
  kind: 'start' | 'send';
  workspace: string | null;
  sessionRef: string | null;
  prompt: string;
  authority: SessionAuthority;
  requester: Requester;
}

function bodyFor(plan: LaunchPlan): LaunchBody {
  return {
    agentId: plan.agentId, kind: plan.kind, workspace: plan.workspace, sessionRef: plan.sessionRef,
    prompt: plan.prompt, authority: plan.authority, requester: sessionProviderRequester(),
  };
}

function parseBody(raw: string): LaunchBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  if (typeof body.agentId !== 'string' || !body.agentId) return null;
  if (body.kind !== 'start' && body.kind !== 'send') return null;
  if (body.kind === 'start' && (typeof body.workspace !== 'string' || !body.workspace.startsWith('/'))) return null;
  if (body.kind === 'send' && (typeof body.sessionRef !== 'string' || !body.sessionRef)) return null;
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return null;
  if (body.authority !== 'read_only' && body.authority !== 'workspace_write') return null;
  const requester = body.requester as { kind?: unknown; id?: unknown } | undefined;
  if (!requester || !['person', 'bot', 'service'].includes(String(requester.kind)) || typeof requester.id !== 'string' || !requester.id) return null;
  return body as unknown as LaunchBody;
}

// Stable category per provider refusal. Messages are fixed (provider
// diagnostics never leak verbatim); the stable provider code is kept.
function categoryForLaunch(code: string): AttemptFailureCategory {
  if (code === 'authority_not_allowed' || code === 'new_sessions_not_allowed') return 'unsupported_authority';
  if (code === 'provider_unavailable' || code === 'auth_required' || code === 'permission_denied'
    || code === 'incompatible_version' || code === 'usage_limit' || code === 'unsupported'
    || code === 'agent_not_found') return 'unavailable';
  return 'launch_failed';
}

function messageFor(category: AttemptFailureCategory): string {
  if (category === 'unavailable') return 'The session provider is not available.';
  if (category === 'unsupported_authority') return 'The session provider cannot honor the requested authority.';
  if (category === 'launch_failed') return 'The session provider did not start the turn.';
  return 'The session provider did not complete the turn.';
}

function failureForLaunch(error: unknown): AttemptFailure {
  if (error instanceof ProviderSessionError) {
    const category = categoryForLaunch(error.code);
    return attemptFailure(category, `[${error.code}] ${messageFor(category)}`, error.code);
  }
  return attemptFailure('launch_failed', error instanceof Error ? `The session provider did not start the turn (${error.name}).` : 'The session provider did not start the turn.');
}

function failureForObserve(error: unknown): AttemptFailure {
  if (error instanceof ProviderSessionError) {
    // Observe failures mean the turn did not complete observably, whatever
    // the provider's reason; the stable code is kept for the operator.
    if (error.code === 'provider_unavailable' || error.code === 'auth_required') {
      return attemptFailure('unavailable', `[${error.code}] ${messageFor('unavailable')}`, error.code);
    }
    return attemptFailure('runtime_failed', `[${error.code}] ${messageFor('runtime_failed')}`, error.code);
  }
  return attemptFailure('runtime_failed', 'The session provider did not complete the turn.');
}

function agentIdForTurn(database: Db, turnRef: string): string | null {
  try {
    const row = database.prepare('SELECT agent_id FROM provider_session_turns WHERE id = ?').get(turnRef) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  } catch {
    return null;
  }
}

function resultBuilder(startedAt: number) {
  const result = (fields: Partial<AttemptResult> & Pick<AttemptResult, 'status'>): AttemptResult => ({
    adapter: NAME,
    externalRunId: null,
    externalSessionId: null,
    output: null,
    artifacts: [],
    startedAt,
    finishedAt: Date.now(),
    failure: null,
    ...fields,
  });
  const failed = (failure: AttemptFailure, extra: Partial<AttemptResult> = {}) => result({ status: 'failed', failure, ...extra });
  return { result, failed };
}

// Translates one terminal provider turn. Attempt times are the adapter's
// own start/finish (like the Agent Deck adapters), so they stay ordered
// across runtimes with their own clocks; the turn's durable times remain in
// the registry for audit.
function terminalResult(turn: ProviderTurnView, resumeSessionId: string | null, fallbackStartedAt: number): AttemptResult {
  const { result, failed } = resultBuilder(fallbackStartedAt);
  const ids = { externalRunId: turn.turn_ref, externalSessionId: turn.session_ref };
  const usage = usageFromEvent(turn.usage ?? null);
  const finishedAt = Date.now();
  if (turn.state === 'cancelled') {
    return failed(attemptFailure('cancelled', 'The provider turn was cancelled.'), { ...ids, usage, finishedAt });
  }
  if (turn.state === 'failed') {
    const code = typeof turn.failure_code === 'string' && turn.failure_code ? turn.failure_code.slice(0, 100) : 'provider_failed';
    return failed(attemptFailure('runtime_failed', `[${code}] ${messageFor('runtime_failed')}`, code), { ...ids, usage, finishedAt });
  }
  if (turn.state !== 'completed') {
    return failed(attemptFailure('runtime_failed', messageFor('runtime_failed')), { ...ids, usage, finishedAt });
  }
  if (typeof turn.output !== 'string' || !turn.output) {
    return failed(
      attemptFailure('result_contract', `Provider turn ${turn.turn_ref} result contract mismatch: expected a non-empty string output.`),
      { ...ids, usage, finishedAt },
    );
  }
  if (resumeSessionId !== null && turn.session_ref !== resumeSessionId) {
    return failed(
      attemptFailure('session_mismatch', `Resume turn ${turn.turn_ref} forked the session; failing closed.`),
      { ...ids, usage, finishedAt },
    );
  }
  const bounded = boundOutput(turn.output, SESSION_PROVIDER_ATTEMPT_OUTPUT_LIMIT);
  return result({
    status: 'completed',
    ...ids,
    output: bounded.content,
    ...(bounded.truncated ? { outputTruncated: true } : {}),
    usage,
    finishedAt,
  });
}

// Observes one launched turn to a terminal result, cancelling it when the
// signal or deadline ends the wait. Shared by run() and reconciler.follow().
async function followTurn(
  database: Db,
  turnRef: string,
  agentId: string,
  input: { resumeSessionId: string | null; deadlineAt: number | null; signal?: AbortSignal | null; correlation?: AttemptInput['correlation'] },
  fallbackStartedAt: number,
): Promise<AttemptResult> {
  const { failed } = resultBuilder(fallbackStartedAt);
  const stop = interruption({ signal: input.signal ?? null, deadlineAt: input.deadlineAt ?? null });
  const observing = observeProviderTurn(database, agentId, turnRef, {
    signal: input.signal ?? null, deadlineAt: input.deadlineAt ?? null, correlation: input.correlation ?? {},
  });
  observing.catch(() => {});
  try {
    const settled = await Promise.race([
      observing.then(view => ({ view }), (error: unknown) => ({ error })),
      stop.promise.then(interrupted => ({ interrupted })),
    ]);
    if ('interrupted' in settled) {
      let externalCancel: 'requested' | 'failed' = 'requested';
      try {
        await cancelProviderTurn(database, agentId, turnRef, { correlation: input.correlation ?? {} });
      } catch {
        externalCancel = 'failed';
      }
      const ids = await idsFor(database, agentId, turnRef);
      return failed(settled.interrupted, { ...ids, externalCancel });
    }
    if ('error' in settled) {
      let externalCancel: 'requested' | 'failed' = 'requested';
      try {
        await cancelProviderTurn(database, agentId, turnRef, { correlation: input.correlation ?? {} });
      } catch {
        externalCancel = 'failed';
      }
      const ids = await idsFor(database, agentId, turnRef);
      return failed(failureForObserve(settled.error), { ...ids, externalCancel });
    }
    const view = settled.view;
    if (view.state === 'running') {
      // The provider ended the wait (signal/deadline) but left the turn
      // running: stop it and report the interruption truthfully.
      const interrupted = (input.signal?.aborted)
        ? attemptFailure('cancelled', 'The attempt was cancelled.')
        : attemptFailure('timed_out', 'The attempt passed its deadline.');
      let externalCancel: 'requested' | 'failed' = 'requested';
      try {
        await cancelProviderTurn(database, agentId, turnRef, { correlation: input.correlation ?? {} });
      } catch {
        externalCancel = 'failed';
      }
      return failed(interrupted, { externalRunId: view.turn_ref, externalSessionId: view.session_ref, externalCancel });
    }
    return terminalResult(view, input.resumeSessionId, fallbackStartedAt);
  } finally {
    stop.dispose();
  }
}

async function idsFor(database: Db, agentId: string, turnRef: string): Promise<{ externalRunId: string; externalSessionId: string | null }> {
  try {
    const view = getProviderTurn(database, agentId, turnRef);
    return { externalRunId: turnRef, externalSessionId: view?.session_ref ?? null };
  } catch {
    return { externalRunId: turnRef, externalSessionId: null };
  }
}

export function createSessionProviderAttemptAdapter(options: { db?: Db } = {}): AttemptAdapter {
  const database = options.db ?? defaultDb;
  const reconciler: AttemptReconciler = {
    currentGrantFingerprint: () => null,
    async inspect(runId) {
      try {
        const agentId = agentIdForTurn(database, runId);
        if (!agentId) return { kind: 'not_found' };
        const view = getProviderTurn(database, agentId, runId);
        if (!view) return { kind: 'not_found' };
        if (view.state === 'running') return { kind: 'run', state: 'running' };
        if (view.state === 'completed') return { kind: 'run', state: 'ended' };
        if (view.state === 'cancelled') return { kind: 'run', state: 'canceled' };
        return { kind: 'run', state: 'error' };
      } catch {
        return { kind: 'unreachable' };
      }
    },
    async repost(intent) {
      const body = parseBody(intent.body);
      if (!body) return { kind: 'rejected', status: null, code: 'INTENT_UNREADABLE' };
      try {
        const launched = body.kind === 'start'
          ? await startProviderSession(database, body.agentId, {
            workspace: body.workspace as string, prompt: body.prompt, authority: body.authority,
            idempotencyKey: intent.idempotencyKey, requester: body.requester, correlation: {},
          })
          : await sendProviderTurn(database, body.agentId, body.sessionRef as string, {
            prompt: body.prompt, authority: body.authority,
            idempotencyKey: intent.idempotencyKey, requester: body.requester, correlation: {},
          });
        return { kind: 'accepted', runId: launched.turn.turn_ref };
      } catch (error) {
        if (error instanceof ProviderSessionError) {
          if (error.code === 'idempotency_conflict') return { kind: 'rejected', status: 409, code: 'IDEMPOTENCY_CONFLICT' };
          if (['invalid_input', 'out_of_scope', 'scope_missing', 'authority_not_allowed', 'new_sessions_not_allowed',
            'not_resumable', 'session_missing', 'session_not_found', 'agent_not_found', 'unsupported'].includes(error.code)) {
            return { kind: 'rejected', status: 400, code: error.code.toUpperCase() };
          }
          if (error.code === 'provider_unavailable') return { kind: 'unreachable' };
          return { kind: 'rejected', status: null, code: error.code.toUpperCase().slice(0, 64) };
        }
        return { kind: 'rejected', status: null, code: null };
      }
    },
    async follow(runId, input: AttemptFollowInput) {
      const startedAt = Date.now();
      const { failed } = resultBuilder(startedAt);
      if (input.prepareFinalization) {
        return failed(
          attemptFailure('unsupported_authority', 'Session provider attempts do not support prepareFinalization.'),
          { externalRunId: runId },
        );
      }
      const agentId = agentIdForTurn(database, runId);
      if (!agentId) {
        return failed(attemptFailure('runtime_failed', 'The provider turn was not found.'), { externalRunId: runId });
      }
      return followTurn(database, runId, agentId, {
        resumeSessionId: input.resumeSessionId, deadlineAt: input.deadlineAt ?? null, signal: input.signal ?? null, correlation: {},
      }, startedAt);
    },
    async evidence(): Promise<AttemptFinalizationEvidence> {
      return { baselineRef: null, baselineDigest: null, candidate: null };
    },
    async cancel(runId) {
      try {
        const agentId = agentIdForTurn(database, runId);
        if (!agentId) return 'failed';
        await cancelProviderTurn(database, agentId, runId, { correlation: {} });
        return 'requested';
      } catch {
        return 'failed';
      }
    },
  };

  return {
    name: NAME,
    reconciler,
    externalCancel: true,
    launchIntent(input: Readonly<AttemptInput>): AttemptLaunchIntent | null {
      const planned = planFor(input);
      if (!planned.ok) return null;
      return {
        idempotencyKey: sessionProviderIdempotencyKey(input),
        body: JSON.stringify(bodyFor(planned.plan)),
        grantFingerprint: null,
      };
    },
    async run(input: Readonly<AttemptInput>, onEvent?: AttemptEventSink): Promise<AttemptResult> {
      const startedAt = Date.now();
      const { failed } = resultBuilder(startedAt);
      const planned = planFor(input);
      if (!planned.ok) return failed(planned.failure);
      const early = preLaunchInterruption(input);
      if (early) return failed(early);
      const plan = planned.plan;
      const idempotencyKey = sessionProviderIdempotencyKey(input);
      const requester = sessionProviderRequester();
      let turn: ProviderTurnView;
      try {
        turn = plan.kind === 'start'
          ? (await startProviderSession(database, plan.agentId, {
            workspace: plan.workspace as string, prompt: plan.prompt, authority: plan.authority,
            idempotencyKey, requester, correlation: { ...input.correlation },
          })).turn
          : (await sendProviderTurn(database, plan.agentId, plan.sessionRef as string, {
            prompt: plan.prompt, authority: plan.authority,
            idempotencyKey, requester, correlation: { ...input.correlation },
          })).turn;
      } catch (error) {
        return failed(failureForLaunch(error));
      }
      onEvent?.({ type: 'started', adapter: NAME, at: Date.now(), externalRunId: turn.turn_ref, externalSessionId: turn.session_ref });
      return followTurn(database, turn.turn_ref, plan.agentId, {
        resumeSessionId: plan.sessionRef, deadlineAt: input.deadlineAt ?? null,
        signal: input.signal ?? null, correlation: { ...input.correlation },
      }, startedAt);
    },
  };
}

