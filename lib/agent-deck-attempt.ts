// NOT-487: canonical Agent Deck single-Attempt adapter (./attempt-adapter
// contract) over the public run HTTP API (./agent-deck-api).
//
// One Attempt is one run: POST /api/agent-runs (a resume when a session
// binding is given), then GET /api/agent-runs/:runId/events until a
// terminal state, then GET /api/agent-runs/:runId for the opaque session.
// Cancellation and the deadline POST /api/agent-runs/:runId/cancel. No
// `agent-deck run` child is ever spawned here, and an API failure (missing
// or rejected token, unreachable server) fails the Attempt with a stable
// code; it never falls back to the CLI adapter in ./agent-deck-run.
//
// The tool profile is exactly the input's. prepareFinalization is sent only
// when the caller asked for it on an edit Attempt; a readonly Attempt never
// requests Git finalization. For a prepared run the adapter returns the
// public baseline reference/digest and, once the run is terminal, the
// ordered candidate manifest from GET /api/agent-runs/:runId/changes.
//
// The run id and session id are opaque: copied from the API, never parsed.
// A resumed run reporting a different session than the binding fails
// closed as a session mismatch.
import { randomUUID } from 'crypto';
import {
  AGENT_DECK_TERMINAL_STATES,
  AgentDeckApiError,
  cancelAgentDeckRun,
  getAgentDeckRun,
  getAgentDeckRunChanges,
  getAgentDeckRunEvents,
  startAgentDeckRun,
  type AgentDeckRunEvent,
  type AgentDeckRunState,
  type AgentDeckRunStatus,
} from './agent-deck-api';
import { deckPromptForAttempt, parseDeckRuntime, type DeckRuntime } from './agent-deck-run';
import {
  attemptFailure,
  interruption,
  preLaunchInterruption,
  type AttemptAdapter,
  type AttemptFailure,
  type AttemptFailureCategory,
  type AttemptFinalizationEvidence,
  type AttemptInput,
  type AttemptResult,
} from './attempt-adapter';

// Interval between event reads while a run is live. Placeholder value
// until the owner confirms it; change one line here.
export const AGENT_DECK_API_POLL_MS = 1000;

let pollMs = AGENT_DECK_API_POLL_MS;

export function setAgentDeckApiPollIntervalForTests(ms: number | null): void {
  pollMs = ms ?? AGENT_DECK_API_POLL_MS;
}

// Deterministic per Attempt, so a repeated start of the same Attempt
// returns the original run instead of launching a second one.
export function agentDeckStartIdempotencyKey(input: Readonly<AttemptInput>): string {
  const attemptId = input.correlation.attemptId;
  return attemptId ? `botmancers-attempt-${attemptId}` : `botmancers-direct-${randomUUID()}`;
}

function categoryFor(error: unknown, fallback: AttemptFailureCategory): AttemptFailureCategory {
  if (!(error instanceof AgentDeckApiError)) return fallback;
  if (error.code === 'agent_deck_token_missing' || error.code === 'agent_deck_unauthorized'
    || error.code === 'agent_deck_forbidden' || error.code === 'agent_deck_unreachable') {
    return 'unavailable';
  }
  if (error.code === 'agent_deck_invalid_response') return 'result_contract';
  return fallback;
}

function failureOf(error: unknown, fallback: AttemptFailureCategory): AttemptFailure {
  if (error instanceof AgentDeckApiError) {
    return attemptFailure(categoryFor(error, fallback), `[${error.code}${error.deckCode ? ` ${error.deckCode}` : ''}] ${error.message}`, error.code);
  }
  return attemptFailure(fallback, error instanceof Error ? error.message : String(error));
}

const terminal = (state: AgentDeckRunState) => AGENT_DECK_TERMINAL_STATES.includes(state);

function sleep(ms: number): Promise<void> {
  // Not unref'd: a live run being observed keeps the process alive.
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ObservedRun {
  state: AgentDeckRunState;
  result: string | null;
  resultMismatch: string | null;
  sessionId: string | null;
}

// Reads events from the start until the API reports a terminal state; a
// terminal state read alongside a page means that page holds the terminal
// event (Agent Deck docs/AGENT_RUN_API.md, Events).
async function observeRun(runId: string): Promise<ObservedRun> {
  const observed: ObservedRun = { state: 'starting', result: null, resultMismatch: null, sessionId: null };
  let cursor: string | null = null;
  for (;;) {
    const page = await getAgentDeckRunEvents(runId, cursor);
    for (const event of page.events as AgentDeckRunEvent[]) {
      if ('sessionId' in event && typeof event.sessionId === 'string' && event.sessionId) observed.sessionId = event.sessionId;
      if (event.type === 'result') {
        if (typeof event.result === 'string' && event.result.length > 0) {
          observed.result = event.result;
          observed.resultMismatch = null;
        } else {
          observed.result = null;
          observed.resultMismatch = event.result === null ? 'null' : Array.isArray(event.result) ? 'array' : event.result === '' ? 'empty string' : typeof event.result;
        }
      }
    }
    observed.state = page.state;
    const advanced = page.nextCursor !== (cursor ?? '0') && page.events.length > 0;
    cursor = page.nextCursor;
    if (terminal(page.state) && !advanced) return observed;
    if (!advanced) await sleep(pollMs);
  }
}

async function finalizationEvidence(runId: string, status: AgentDeckRunStatus | null): Promise<AttemptFinalizationEvidence> {
  if (!status?.finalization) {
    return { baselineRef: null, baselineDigest: null, candidate: { ok: false, code: 'FINALIZATION_NOT_PREPARED', message: 'The run reported no finalization baseline.' } };
  }
  const base = { baselineRef: status.finalization.baselineRef, baselineDigest: status.finalization.baselineDigest };
  try {
    const changes = await getAgentDeckRunChanges(runId);
    if (changes.baselineRef !== status.finalization.baselineRef
      || changes.baselineDigest !== status.finalization.baselineDigest) {
      return {
        ...base,
        candidate: { ok: false, code: 'BASELINE_MISMATCH', message: 'Agent Deck returned candidate evidence for a different baseline.' },
      };
    }
    return {
      ...base,
      candidate: {
        ok: true,
        manifest: {
          baselineRef: changes.baselineRef,
          baselineDigest: changes.baselineDigest,
          baseCommit: changes.baseCommit,
          manifestDigest: changes.manifestDigest,
          files: changes.files,
        },
      },
    };
  } catch (error) {
    const code = error instanceof AgentDeckApiError ? error.deckCode ?? error.code : 'agent_deck_invalid_response';
    const message = error instanceof AgentDeckApiError ? error.message : 'The candidate manifest could not be read.';
    return { ...base, candidate: { ok: false, code, message } };
  }
}

export function createAgentDeckApiAttemptAdapter(): AttemptAdapter {
  const name = 'agent-deck-api' as const;
  return {
    name,
    async run(input: Readonly<AttemptInput>, onEvent): Promise<AttemptResult> {
      const startedAt = Date.now();
      const result = (fields: Partial<AttemptResult> & Pick<AttemptResult, 'status'>): AttemptResult => ({
        adapter: name,
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

      if (input.toolProfile !== 'readonly' && input.toolProfile !== 'edit') {
        return failed(attemptFailure('unsupported_authority', `Unsupported tool profile: ${JSON.stringify(String(input.toolProfile))}.`));
      }
      if (input.prepareFinalization && input.toolProfile !== 'edit') {
        return failed(attemptFailure('unsupported_authority', 'Only an edit Attempt can prepare Git finalization.'));
      }
      if (!input.deck) return failed(attemptFailure('unavailable', 'An Agent Deck run requires a deck.'));
      if (!input.cwd) return failed(attemptFailure('unavailable', 'An Agent Deck run requires a working directory.'));
      let client: DeckRuntime;
      try {
        client = parseDeckRuntime(input.target.agent);
      } catch (error) {
        return failed(attemptFailure('unavailable', error instanceof Error ? error.message : String(error)));
      }
      const early = preLaunchInterruption(input);
      if (early) return failed(early);

      const resume = input.sessionBinding?.externalSessionId ?? null;
      const prepare = input.prepareFinalization === true;
      let runId: string;
      try {
        const started = await startAgentDeckRun({
          deckId: input.deck,
          client,
          cwd: input.cwd,
          prompt: deckPromptForAttempt(input.prompt),
          tools: input.toolProfile,
          ...(resume ? { resumeSessionId: resume } : {}),
          ...(prepare ? { prepareFinalization: true } : {}),
        }, agentDeckStartIdempotencyKey(input));
        runId = started.runId;
      } catch (error) {
        return failed(failureOf(error, 'launch_failed'));
      }
      onEvent?.({ type: 'started', adapter: name, at: Date.now(), externalRunId: runId, externalSessionId: null });

      const stop = interruption(input);
      const ids = { externalRunId: runId };
      try {
        if (prepare) {
          // The baseline exists before model work: record it right away so
          // it survives even if this process stops before the run ends.
          try {
            const status = await getAgentDeckRun(runId);
            if (status.finalization) {
              onEvent?.({
                type: 'progress', adapter: name, at: Date.now(),
                detail: { phase: 'finalization_prepared', baseline_ref: status.finalization.baselineRef, baseline_digest: status.finalization.baselineDigest },
              });
            }
          } catch { /* read again once the run is terminal */ }
        }
        const watching = observeRun(runId);
        // An interrupted wait abandons this read; its rejection must not
        // surface unhandled.
        watching.catch(() => {});
        const settled = await Promise.race([
          watching.then(observed => ({ observed }), (error: unknown) => ({ error })),
          stop.promise.then(interrupted => ({ interrupted })),
        ]);
        if ('interrupted' in settled) {
          try { await cancelAgentDeckRun(runId); } catch { /* reported by the interruption below */ }
          return failed(settled.interrupted, ids);
        }
        if ('error' in settled) {
          // Stop the run we can no longer observe rather than let it edit
          // unwatched; failure to reach the API is reported as is.
          try { await cancelAgentDeckRun(runId); } catch { /* unreachable */ }
          return failed(failureOf(settled.error, 'runtime_failed'), ids);
        }
        const { observed } = settled;
        let status: AgentDeckRunStatus | null = null;
        try {
          status = await getAgentDeckRun(runId);
        } catch (error) {
          if (!prepare) return failed(failureOf(error, 'runtime_failed'), ids);
        }
        const sessionId = status?.sessionId ?? observed.sessionId;
        const finalization = prepare ? await finalizationEvidence(runId, status) : undefined;
        const evidence = { ...ids, externalSessionId: sessionId, ...(finalization ? { finalization } : {}) };
        if (observed.state === 'canceled') return failed(attemptFailure('cancelled', `Agent Deck run ${runId} was canceled.`), evidence);
        if (observed.state !== 'ended') {
          // Agent Deck-authored event prose is not durable Botmancers
          // evidence: it can contain model output, paths, or credentials.
          return failed(attemptFailure('runtime_failed', `Agent Deck run ${runId} ended in state ${observed.state}.`), evidence);
        }
        if (observed.result === null) {
          return failed(attemptFailure(
            'result_contract',
            `Agent Deck run ${runId} result contract mismatch: expected a non-empty string result, got ${observed.resultMismatch ?? 'no result event'}.`
          ), evidence);
        }
        if (resume && sessionId !== null && sessionId !== resume) {
          return failed(attemptFailure(
            'session_mismatch',
            `resume run ${runId} forked the session (expected ${resume}, got ${sessionId}); failing closed.`
          ), evidence);
        }
        const manifest = finalization?.candidate?.ok ? finalization.candidate.manifest : null;
        return result({
          status: 'completed',
          ...evidence,
          externalSessionId: sessionId ?? resume,
          output: observed.result,
          // The candidate manifest is referenced by its digest; the run's
          // private log path is never exposed by the API.
          artifacts: manifest ? [{ kind: 'candidate_manifest', ref: manifest.manifestDigest }] : [],
        });
      } finally {
        stop.dispose();
      }
    },
  };
}
