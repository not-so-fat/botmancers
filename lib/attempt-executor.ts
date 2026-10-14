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

export async function runAttempt<T = undefined>(
  store: EngineStore,
  prepared: PreparedAttempt,
  adapter: AttemptAdapter,
  options: RunAttemptOptions<T> = {}
): Promise<{ attempt: WorkAttempt; result: AttemptResult; projected: T | undefined }> {
  let result: AttemptResult;
  let fenced = false;
  try {
    result = await adapter.run(prepared.input, event => {
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
    const attempt = recordAttemptResult(store, prepared.attempt.id, result);
    const projected = options.project ? options.project(result, attempt) : undefined;
    return { attempt, result, projected };
  });
}

export async function executeAttempt<T = undefined>(
  store: EngineStore,
  requestId: string,
  options: BeginAttemptOptions & RunAttemptOptions<T>
): Promise<{ attempt: WorkAttempt; result: AttemptResult; projected: T | undefined }> {
  const prepared = beginAttempt(store, requestId, options);
  return runAttempt(store, prepared, options.adapter, options);
}
