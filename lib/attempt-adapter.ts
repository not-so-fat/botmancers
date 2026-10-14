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
}

export type AttemptEventSink = (event: AttemptEvent) => void;

export interface AttemptAdapter {
  readonly name: AttemptAdapterName;
  run(input: Readonly<AttemptInput>, onEvent?: AttemptEventSink): Promise<AttemptResult>;
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

// Cancellation and deadline, shared by both adapters. Resolves to the
// failure that ended the wait, or never resolves while neither fires.
export function interruption(input: Readonly<AttemptInput>): { promise: Promise<AttemptFailure>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const promise = new Promise<AttemptFailure>(resolve => {
    if (input.signal) {
      onAbort = () => resolve(attemptFailure('cancelled', 'The attempt was cancelled.'));
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof input.deadlineAt === 'number') {
      const delay = Math.max(0, input.deadlineAt - Date.now());
      timer = setTimeout(() => resolve(attemptFailure('timed_out', 'The attempt passed its deadline.')), delay);
      if (timer.unref) timer.unref();
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
