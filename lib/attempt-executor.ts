// NOT-467: executor persistence seam for single Attempts.
//
// beginAttempt persists the Attempt (with its immutable launch snapshot)
// before anything launches; runAttempt runs one adapter and records the
// provenance it returns: runtime_started/runtime_progress events, external
// run/session ids, outcome, failure category, output, and artifact
// references. The executor writes engine records only. Projecting a result
// into a conversation is the caller's job, done through the optional
// `project` callback inside the same transaction that finishes the
// Attempt, so a projection and its terminal record commit together.
import { createHash } from 'crypto';
import type { EngineStore, WorkAttempt, AttemptOutcome } from './engine-store';
import { EngineStoreError } from './engine-store';
import {
  attemptFailure,
  freezeAttemptInput,
  type AttemptAdapter,
  type AttemptEvent,
  type AttemptInput,
  type AttemptResult,
} from './attempt-adapter';

export interface BeginAttemptOptions {
  // Recorded in work_attempts.adapter: the dispatched Agent identity
  // (NOT-456), e.g. hermes or codex. The transport adapter name is kept in
  // the launch snapshot.
  agent: string;
  adapter: AttemptAdapter;
  input: AttemptInput;
  // Extra caller policy recorded verbatim in the launch snapshot.
  snapshot?: Record<string, unknown>;
  now?: number;
}

export interface PreparedAttempt {
  attempt: WorkAttempt;
  input: Readonly<AttemptInput>;
}

function promptHash(input: AttemptInput): string {
  return createHash('sha256').update(JSON.stringify(input.prompt)).digest('hex');
}

export function attemptLaunchSnapshot(options: BeginAttemptOptions): Record<string, unknown> {
  const { input } = options;
  return {
    ...(options.snapshot ?? {}),
    agent: options.agent,
    agent_id: input.target.agentId,
    transport: options.adapter.name,
    deck: input.deck,
    cwd: input.cwd,
    tool_profile: input.toolProfile,
    hermes_profile_path: input.target.hermesProfilePath ?? null,
    prompt_kind: input.prompt.kind,
    prompt_hash: promptHash(input),
    session_binding_id: input.sessionBinding?.bindingId ?? null,
    prepare_finalization: input.prepareFinalization === true,
    deadline_at: input.deadlineAt ?? null,
  };
}

// Persists one Attempt for a running request. Safe inside a caller's
// store.transaction (for example together with the queued -> running
// claim). A resume must name a persisted Session Binding.
export function beginAttempt(store: EngineStore, requestId: string, options: BeginAttemptOptions): PreparedAttempt {
  const binding = options.input.sessionBinding;
  if (binding && !binding.bindingId) {
    throw new EngineStoreError('invalid_input', 'A persisted resume attempt names its Session Binding.');
  }
  const attempt = store.createAttempt(requestId, {
    kind: binding ? 'resume' : 'launch',
    adapter: options.agent,
    toolProfile: options.input.toolProfile,
    launchSnapshot: attemptLaunchSnapshot(options),
    resumedSessionBindingId: binding?.bindingId ?? null,
    now: options.now,
  });
  return {
    attempt,
    input: freezeAttemptInput({
      ...options.input,
      correlation: { ...options.input.correlation, requestId, attemptId: attempt.id },
    }),
  };
}

export function outcomeForResult(result: AttemptResult): AttemptOutcome {
  if (result.status === 'completed') return 'succeeded';
  if (result.failure?.category === 'cancelled') return 'cancelled';
  if (result.failure?.category === 'timed_out') return 'timed_out';
  return 'failed';
}

// False (nothing written) when the fence reports the caller's claim lost.
function recordEvent(store: EngineStore, attempt: WorkAttempt, event: AttemptEvent, fence: (() => boolean) | undefined): boolean {
  return store.transaction(() => {
    if (fence && !fence()) return false;
    if (event.type === 'started') {
      if (event.externalRunId || event.externalSessionId) {
        store.recordAttemptExternalIds(attempt.id, {
          ...(event.externalRunId ? { externalRunId: event.externalRunId } : {}),
          ...(event.externalSessionId ? { externalSessionId: event.externalSessionId } : {}),
        });
      }
      store.appendEvent(attempt.request_id, {
        type: 'runtime_started',
        attemptId: attempt.id,
        data: { adapter: event.adapter, external_run_id: event.externalRunId },
        now: event.at,
      });
    } else {
      store.appendEvent(attempt.request_id, {
        type: 'runtime_progress',
        attemptId: attempt.id,
        data: { adapter: event.adapter, ...event.detail },
        now: event.at,
      });
    }
    return true;
  });
}

export function recordAttemptResult(store: EngineStore, attemptId: string, result: AttemptResult): WorkAttempt {
  return store.finishAttempt(attemptId, {
    outcome: outcomeForResult(result),
    output: result.output,
    errorCategory: result.failure?.category ?? null,
    errorMessage: result.failure?.message ?? null,
    artifacts: result.artifacts,
    ...(result.externalRunId ? { externalRunId: result.externalRunId } : {}),
    ...(result.externalSessionId ? { externalSessionId: result.externalSessionId } : {}),
    now: result.finishedAt,
  });
}

// NOT-473: a result that arrives after its Attempt was already finished
// (abandoned by cancellation, a deadline, or a superseding retry) is kept
// as evidence on the request's event log and changes nothing else: the
// Attempt stays as it was finished and the request is never promoted.
export function recordLateResult(store: EngineStore, attempt: WorkAttempt, result: AttemptResult, now: number = Date.now()): void {
  const request = store.getWorkRequest(attempt.request_id);
  store.appendEvent(attempt.request_id, {
    type: 'late_result_recorded',
    attemptId: attempt.id,
    data: {
      attempt_number: attempt.attempt_number,
      attempt_outcome: attempt.outcome,
      result_status: result.status,
      result_outcome: outcomeForResult(result),
      error_category: result.failure?.category ?? null,
      external_run_id: result.externalRunId,
      output: result.output,
      request_state: request?.state ?? null,
    },
    now,
  });
}

export interface RunAttemptOptions<T> {
  // Runs in the transaction that finishes the Attempt.
  project?: (result: AttemptResult, attempt: WorkAttempt) => T;
  onEvent?: (event: AttemptEvent) => void;
  // NOT-469: checked inside each event write's transaction. Once it
  // returns false (the caller's lease was taken over) that event and every
  // later one are dropped, external ids included, and onEvent is not
  // called: the new owner reconciles the run.
  fence?: () => boolean;
}

// NOT-473: an Attempt that ended because this process stopped waiting for
// it (cancellation signal or deadline) without stopping the external run:
// the transport cannot stop it, or its cancel request failed. The run may
// continue; the caller records what the runtime was told (external_cancel).
export interface LocallyAbandonedAttempt {
  requestId: string;
  attemptId: string;
  externalRunId: string | null;
  transport: string;
  reason: 'cancelled' | 'timed_out';
  // 'failed': the transport asked the runtime to stop the run and was
  // refused or could not reach it. null: the transport cannot ask.
  externalCancel: 'failed' | null;
}

type RunAttemptResult<T> = { attempt: WorkAttempt; result: AttemptResult; projected: T | undefined; late: boolean; abandoned: LocallyAbandonedAttempt | null };

export async function runAttempt<T = undefined>(
  store: EngineStore,
  prepared: PreparedAttempt,
  adapter: AttemptAdapter,
  options: RunAttemptOptions<T> = {}
): Promise<RunAttemptResult<T>> {
  let result: AttemptResult;
  let fenced = false;
  let launched = false;
  try {
    result = await adapter.run(prepared.input, event => {
      if (event.type === 'started') launched = true;
      if (fenced || !recordEvent(store, prepared.attempt, event, options.fence)) {
        fenced = true;
        return;
      }
      options.onEvent?.(event);
    });
  } catch (error) {
    // Adapters report runtime failures as results; a throw is a defect,
    // recorded as a failed attempt rather than left open.
    const now = Date.now();
    result = {
      status: 'failed',
      adapter: adapter.name,
      externalRunId: null,
      externalSessionId: null,
      output: null,
      artifacts: [],
      startedAt: prepared.attempt.started_at,
      finishedAt: now,
      failure: attemptFailure('runtime_failed', error instanceof Error ? error.message : String(error)),
    };
  }
  return store.transaction(() => {
    const current = store.getAttempt(prepared.attempt.id);
    if (current && current.finished_at !== null) {
      recordLateResult(store, current, result);
      return { attempt: current, result, projected: undefined, late: true, abandoned: null };
    }
    const abandoned = launched ? abandonedLocally(prepared.attempt, adapter, prepared.input.signal ?? null, result) : null;
    const attempt = abandoned ? recordAbandonedResult(store, abandoned, result) : recordAttemptResult(store, prepared.attempt.id, result);
    const projected = options.project ? options.project(result, attempt) : undefined;
    return { attempt, result, projected, late: false, abandoned };
  });
}

// A launched Attempt that returned cancelled or timed out was interrupted
// locally (its signal, its deadline, or the transport's own wait limit).
// Unless the transport stops the external run on that signal
// (adapter.externalCancel) and the runtime accepted the cancel, only this
// process's wait ended.
export function abandonedLocally(
  attempt: WorkAttempt,
  adapter: Pick<AttemptAdapter, 'name' | 'externalCancel'>,
  signal: AbortSignal | null,
  result: AttemptResult,
): LocallyAbandonedAttempt | null {
  if (result.status !== 'failed') return null;
  const category = result.failure?.category;
  if (category !== 'cancelled' && category !== 'timed_out') return null;
  if (category === 'cancelled' && !signal?.aborted) return null;
  const cancelFailed = result.externalCancel === 'failed';
  if (adapter.externalCancel && !cancelFailed) return null;
  return {
    requestId: attempt.request_id,
    attemptId: attempt.id,
    externalRunId: result.externalRunId,
    transport: adapter.name,
    reason: category,
    externalCancel: cancelFailed ? 'failed' : null,
  };
}

// Finished the way enforcement abandons an Attempt (lib/work-request-
// control): the same outcome, category 'abandoned', and an
// attempt_abandoned record saying the run was not stopped.
export function recordAbandonedResult(store: EngineStore, abandoned: LocallyAbandonedAttempt, result: AttemptResult): WorkAttempt {
  const notStopped = abandoned.externalCancel === 'failed'
    ? 'The runtime did not accept the cancel request'
    : 'The runtime cannot stop the run';
  const attempt = store.finishAttempt(abandoned.attemptId, {
    outcome: outcomeForResult(result),
    errorCategory: 'abandoned',
    errorMessage: `${result.failure?.message ?? 'The attempt was interrupted.'} ${notStopped}; it may continue and a later result is not awaited.`.slice(0, 500),
    artifacts: result.artifacts,
    ...(result.externalRunId ? { externalRunId: result.externalRunId } : {}),
    ...(result.externalSessionId ? { externalSessionId: result.externalSessionId } : {}),
    now: result.finishedAt,
  });
  // The run id may have been recorded from a 'started' event only.
  abandoned.externalRunId = attempt.external_run_id;
  store.appendEvent(abandoned.requestId, {
    type: 'attempt_abandoned',
    attemptId: abandoned.attemptId,
    data: {
      reason: abandoned.reason, attempt_number: attempt.attempt_number, external_run_id: attempt.external_run_id,
      transport: abandoned.transport, local_only: true, error_code: result.failure?.code ?? null,
      external_cancel: abandoned.externalCancel,
    },
    now: result.finishedAt,
  });
  return attempt;
}

export async function executeAttempt<T = undefined>(
  store: EngineStore,
  requestId: string,
  options: BeginAttemptOptions & RunAttemptOptions<T>
): Promise<RunAttemptResult<T>> {
  const prepared = beginAttempt(store, requestId, options);
  return runAttempt(store, prepared, options.adapter, options);
}
