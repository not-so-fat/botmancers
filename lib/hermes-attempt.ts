// NOT-467: Hermes single-Attempt adapter (./attempt-adapter contract).
//
// One Attempt is one chat request to the persistent Hermes gateway through
// the existing client (hermesChat). Completion is the gateway's HTTP 200
// answer. The gateway session is the binding's opaque external session id
// when one is given, a new one when the input asks for a fresh session,
// otherwise the target's stable per-Agent session.
// Hermes chat carries no workspace edit authority, so only the readonly
// tool profile is supported; anything else fails closed before launch.
import {
  HERMES_DEFAULT_CHAT_PATH,
  HermesError,
  hermesChat,
  hermesFreshSessionIdForBot,
  hermesSessionIdForBot,
  loadHermesConfig,
  type HermesChatMessage,
  type HermesConfig,
} from './hermes';
import {
  attemptFailure,
  interruption,
  preLaunchInterruption,
  type AttemptAdapter,
  type AttemptFailure,
  type AttemptInput,
  type AttemptPrompt,
  type AttemptResult,
} from './attempt-adapter';

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface HermesAttemptAdapterOptions {
  fetchImpl?: FetchImpl | null;
  loadConfig?: () => HermesConfig | null;
}

export function hermesMessagesForPrompt(prompt: AttemptPrompt): HermesChatMessage[] {
  if (prompt.kind === 'text') return [{ role: 'user', content: prompt.text }];
  return [
    { role: 'system', content: prompt.system },
    ...prompt.history.map(entry => entry.fromAgent
      ? { role: 'assistant', content: entry.content }
      : { role: 'user', content: `[From ${entry.speakerLabel}] ${entry.content}` }),
  ];
}

export function createHermesAttemptAdapter(options: HermesAttemptAdapterOptions = {}): AttemptAdapter {
  const name = 'hermes-gateway' as const;
  return {
    name,
    async run(input: Readonly<AttemptInput>, onEvent): Promise<AttemptResult> {
      const startedAt = Date.now();
      const failed = (failure: AttemptFailure, externalSessionId: string | null = null): AttemptResult => ({
        status: 'failed',
        adapter: name,
        externalRunId: null,
        externalSessionId,
        output: null,
        artifacts: [],
        startedAt,
        finishedAt: Date.now(),
        failure,
      });
      if (input.toolProfile !== 'readonly') {
        return failed(attemptFailure('unsupported_authority', `The Hermes gateway does not support the ${input.toolProfile} tool profile.`));
      }
      const config = (options.loadConfig ?? loadHermesConfig)();
      if (!config) return failed(attemptFailure('unavailable', 'The Hermes gateway is not configured.'));
      const early = preLaunchInterruption(input);
      if (early) return failed(early);

      if (input.freshSession && input.sessionBinding) {
        return failed(attemptFailure('session_mismatch', 'A fresh-session turn cannot resume a session.'));
      }
      const sessionId = input.sessionBinding?.externalSessionId
        ?? (input.freshSession ? hermesFreshSessionIdForBot(input.target.agentId, config) : hermesSessionIdForBot(input.target.agentId, config));
      const controller = new AbortController();
      const stop = interruption(input);
      let interrupted: AttemptFailure | null = null;
      void stop.promise.then(failure => {
        interrupted = failure;
        controller.abort();
      });
      onEvent?.({ type: 'started', adapter: name, at: Date.now(), externalRunId: null, externalSessionId: sessionId });
      try {
        const output = await hermesChat({
          config,
          profilePath: input.target.hermesProfilePath || HERMES_DEFAULT_CHAT_PATH,
          sessionId,
          messages: hermesMessagesForPrompt(input.prompt),
          signal: controller.signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        return {
          status: 'completed',
          adapter: name,
          externalRunId: null,
          externalSessionId: sessionId,
          output,
          artifacts: [],
          startedAt,
          finishedAt: Date.now(),
          failure: null,
        };
      } catch (error) {
        const code = error instanceof HermesError ? error.code : 'unknown';
        if (interrupted) return failed({ ...(interrupted as AttemptFailure), code }, sessionId);
        const category = code === 'timeout' ? 'timed_out' : 'runtime_failed';
        // Gateway error bodies can echo request details (URLs, keys), so
        // only the error code and HTTP status are kept as provenance.
        const status = error instanceof HermesError && error.status !== undefined ? ` ${error.status}` : '';
        return failed(attemptFailure(category, `The Hermes gateway did not complete the turn (${code}${status}).`, code), sessionId);
      } finally {
        stop.dispose();
      }
    },
  };
}
