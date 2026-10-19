// NOT-467: one transport-neutral contract for executing a single Attempt.
//
// A runtime adapter receives one immutable AttemptInput (target launch
// snapshot, prompt, working directory, deck, explicit tool profile,
// optional opaque session binding, deadline/cancellation, correlation IDs)
// and returns runtime evidence: started/progress events through a callback
// and exactly one normalized completed/failed AttemptResult. Adapters never
// throw for runtime failures, never choose orchestration (whether a review
// or revision runs), never infer tool authority from the Agent type, and
// never write conversation messages; persistence is the executor's job
// (./attempt-executor) and projection is the caller's.
//
// Session identifiers stay opaque: the binding's external session id is
// handed to the runtime verbatim and the runtime's reported id is returned
// verbatim, never parsed or synthesized.
import type { BotAgent } from './bot-definition';
import type { ToolProfile } from './engine-store';
import type { NormalizedUsage } from './usage';

// NOT-487: 'agent-deck-api' is the canonical Agent Deck transport (public
// run HTTP API); 'agent-deck-run' is the legacy CLI compatibility adapter.
export type AttemptAdapterName = 'hermes-gateway' | 'agent-deck-run' | 'agent-deck-api';

// Who is launched. Frozen by the caller before launch and recorded as the
// Attempt's launch snapshot; adapters read it, never widen it.
export interface AttemptLaunchSnapshot {
  agentId: string;
  agent: BotAgent;
  // Hermes chat path for the target (bots.hermes_profile); null elsewhere.
  hermesProfilePath?: string | null;
}

export interface AttemptHistoryEntry {
  speakerLabel: string;
  fromAgent: boolean;
  content: string;
}

// A plain task prompt, or a conversation the adapter renders in its own
// transport format (gateway chat messages or a transcript prompt).
export type AttemptPrompt =
  | { kind: 'text'; text: string }
  | { kind: 'conversation'; system: string; history: AttemptHistoryEntry[] };

// Opaque runtime continuity. bindingId names the persisted Session Binding
// when there is one; externalSessionId is passed to the runtime unchanged.
export interface AttemptSessionBinding {
  bindingId: string | null;
  externalSessionId: string;
}

export interface AttemptCorrelation {
  requestId?: string | null;
  attemptId?: string | null;
  conversationId?: string | null;
  [key: string]: string | null | undefined;
}

export interface AttemptInput {
  target: AttemptLaunchSnapshot;
  prompt: AttemptPrompt;
  cwd: string | null;
  deck: string | null;
  toolProfile: ToolProfile;
  sessionBinding: AttemptSessionBinding | null;
  // Epoch ms after which the attempt is reported timed_out.
  deadlineAt?: number | null;
  signal?: AbortSignal | null;
  correlation: AttemptCorrelation;
  // NOT-487: ask the runtime to capture a Git baseline before launch so the
  // edit can later be finalized into one reviewed commit. Only an edit
  // Attempt may ask; the caller decides (implementation and revision in a
  // Git worktree), never the adapter.
  prepareFinalization?: boolean;
  // NOT-497: launch in a new runtime session the target owns from now on
  // (a Continue destination). Never together with sessionBinding. An
  // adapter whose launch would otherwise reuse a standing session (the
  // Hermes per-Agent gateway session) must open a new one instead.
  freshSession?: boolean;
}

export type AttemptFailureCategory =
  | 'unavailable'
  | 'unsupported_authority'
  | 'launch_failed'
  | 'runtime_failed'
  | 'result_contract'
  | 'session_mismatch'
  | 'cancelled'
  | 'timed_out';

export const ATTEMPT_FAILURE_CATEGORIES: readonly AttemptFailureCategory[] = [
  'unavailable', 'unsupported_authority', 'launch_failed', 'runtime_failed',
  'result_contract', 'session_mismatch', 'cancelled', 'timed_out',
];

export interface AttemptArtifact {
  kind: string;
  ref: string;
}

export type AttemptEvent =
  | { type: 'started'; adapter: AttemptAdapterName; at: number; externalRunId: string | null; externalSessionId: string | null }
  | { type: 'progress'; adapter: AttemptAdapterName; at: number; detail: Record<string, unknown> };

export interface AttemptFailure {
  category: AttemptFailureCategory;
  // Transport-specific code (for example a Hermes error code); optional.
  code: string | null;
  // Internal diagnostic text, bounded. Callers project their own fixed
  // user-facing text from the category.
  message: string;
}

// NOT-487: public finalization evidence of a prepared edit Attempt: the
// opaque baseline reference/digest captured before launch and, once the run
// is terminal, the ordered candidate manifest (paths, digests, modes; never
// file contents or host paths) or the reason it is unavailable.
export interface AttemptCandidateManifest {
  baselineRef: string;
  baselineDigest: string;
  baseCommit: string;
  manifestDigest: string;
  files: { path: string; sha256: string | null; mode: '100644' | '100755' | null }[];
}

export interface AttemptFinalizationEvidence {
  baselineRef: string | null;
  baselineDigest: string | null;
  candidate:
    | { ok: true; manifest: AttemptCandidateManifest }
    | { ok: false; code: string; message: string }
    | null;
}

export interface AttemptResult {
  status: 'completed' | 'failed';
  adapter: AttemptAdapterName;
  externalRunId: string | null;
  externalSessionId: string | null;
  output: string | null;
  artifacts: AttemptArtifact[];
  startedAt: number;
  finishedAt: number;
  failure: AttemptFailure | null;
  // NOT-487: present only for an Attempt launched with prepareFinalization.
  finalization?: AttemptFinalizationEvidence | null;
  // NOT-469: the launch request failed in a way that does not prove no run
  // started (for example the response was lost). A dispatcher keeps the
  // Attempt open and reconciles it under the same idempotency key.
  launchUnconfirmed?: boolean;
  // NOT-473: set by an externalCancel transport when its signal or deadline
  // ended the wait, or when it lost sight of the run and asked the runtime
  // to stop it: whether the runtime accepted the cancel request. On
  // 'failed' the run may continue and the Attempt is abandoned, not stopped.
  externalCancel?: 'requested' | 'failed';
  // NOT-497: set when a caller's sanitize step cut output to its bound;
  // output then holds the bounded text only.
  outputTruncated?: boolean;
  // NOT-509: provider-reported usage, normalized from the runtime's own
  // structured events (lib/usage). Absent or null: the runtime reported
  // none; never estimated.
  usage?: NormalizedUsage | null;
}

export type AttemptEventSink = (event: AttemptEvent) => void;

// NOT-469: what a launch will send, persisted by the dispatcher before the
// adapter runs. body is the exact serialized start body; a re-POST after a
// crash sends only this body, under this key, with the same grant.
export interface AttemptLaunchIntent {
  idempotencyKey: string;
  body: string;
  // Non-secret fingerprint of the credential the launch uses; null when
  // none is configured.
  grantFingerprint: string | null;
}

// Runtime evidence about an external run, read through the public API
// only. Classifies the answer; deciding what to do is the dispatcher's
// (lib/dispatcher, NOT-468 decision table).
export type RunObservation =
  | { kind: 'run'; state: 'starting' | 'running' | 'ended' | 'error' | 'died' | 'canceled' }
  | { kind: 'accepted'; runId: string }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'no_grant' }
  | { kind: 'unreachable' }
  | { kind: 'rejected'; status: number | null; code: string | null };

// What a reattach needs from the launch: re-derived from the persisted
// launch snapshot and intent, never from process memory.
export interface AttemptFollowInput {
  resumeSessionId: string | null;
  prepareFinalization: boolean;
  deadlineAt: number | null;
  signal?: AbortSignal | null;
}

// Optional capability of a transport whose runs outlive the process that
// launched them. A transport without it cannot be reconciled: an open
// Attempt is reported interrupted, never relaunched.
export interface AttemptReconciler {
  currentGrantFingerprint(): string | null;
  inspect(runId: string): Promise<RunObservation>;
  // Re-sends a persisted launch intent. 'accepted' names the run Agent
  // Deck holds for the key (the original, or the first launch when the
  // earlier POST never arrived).
  repost(intent: { idempotencyKey: string; body: string }): Promise<RunObservation>;
  // Observes an existing run to a terminal result, exactly like the tail
  // of run(): the same result contract, deadline, and session checks.
  follow(runId: string, input: AttemptFollowInput, onEvent?: AttemptEventSink): Promise<AttemptResult>;
  // Public finalization evidence of a terminal (including died) run.
  evidence(runId: string): Promise<AttemptFinalizationEvidence>;
  // NOT-473: asks the runtime to stop a run Botmancers abandoned
  // (cancellation or deadline). 'requested' means the runtime accepted the
  // cancel; 'failed' that it could not be reached or refused. Absent: the
  // transport cannot stop a run it does not hold.
  cancel?(runId: string): Promise<'requested' | 'failed'>;
}

export interface AttemptAdapter {
  readonly name: AttemptAdapterName;
  run(input: Readonly<AttemptInput>, onEvent?: AttemptEventSink): Promise<AttemptResult>;
  // NOT-469: the start body run() would send for this input, or null when
  // the transport has no external run or run() would fail before launch.
  launchIntent?(input: Readonly<AttemptInput>): AttemptLaunchIntent | null;
  readonly reconciler?: AttemptReconciler;
  // NOT-473: true when aborting input.signal (or passing the deadline)
  // stops the external run itself, not only this process's wait. A
  // transport without it is abandoned locally: its run may continue and
  // any later result is evidence only.
  readonly externalCancel?: boolean;
}

export function freezeAttemptInput(input: AttemptInput): Readonly<AttemptInput> {
  return Object.freeze({
    ...input,
    target: Object.freeze({ ...input.target }),
    prompt: Object.freeze(input.prompt.kind === 'text'
      ? { ...input.prompt }
      : { ...input.prompt, history: Object.freeze(input.prompt.history.map(entry => Object.freeze({ ...entry }))) as AttemptHistoryEntry[] }),
    sessionBinding: input.sessionBinding ? Object.freeze({ ...input.sessionBinding }) : null,
    correlation: Object.freeze({ ...input.correlation }),
  });
}

export function attemptFailure(category: AttemptFailureCategory, message: string, code: string | null = null): AttemptFailure {
  return { category, code, message: message.slice(0, 500) };
}

// The largest delay setTimeout honors (2^31 - 1 ms, about 24.8 days).
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Cancellation and deadline, shared by both adapters. Resolves to the
// failure that ended the wait, or never resolves while neither fires.
export function interruption(input: Readonly<Pick<AttemptInput, 'signal' | 'deadlineAt'>>): { promise: Promise<AttemptFailure>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const promise = new Promise<AttemptFailure>(resolve => {
    if (input.signal) {
      onAbort = () => resolve(attemptFailure('cancelled', 'The attempt was cancelled.'));
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof input.deadlineAt === 'number') {
      const deadlineAt = input.deadlineAt;
      // setTimeout fires after 1 ms for delays above MAX_TIMER_DELAY_MS, so
      // a far deadline is reached in steps.
      const arm = () => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve(attemptFailure('timed_out', 'The attempt passed its deadline.'));
          return;
        }
        timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
        if (timer.unref) timer.unref();
      };
      arm();
    }
  });
  return {
    promise,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (onAbort && input.signal) input.signal.removeEventListener('abort', onAbort);
    },
  };
}

// Checked before launch so an already-cancelled or expired attempt never
// starts a runtime.
export function preLaunchInterruption(input: Readonly<AttemptInput>): AttemptFailure | null {
  if (input.signal?.aborted) return attemptFailure('cancelled', 'The attempt was cancelled before launch.');
  if (typeof input.deadlineAt === 'number' && Date.now() >= input.deadlineAt) {
    return attemptFailure('timed_out', 'The attempt passed its deadline before launch.');
  }
  return null;
}
