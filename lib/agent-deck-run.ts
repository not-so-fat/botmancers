// NOT-395: Botmancers adapter boundary for `agent-deck run`.
//
// One boundary that starts, observes, reads the result of, and resumes
// local coding-agent runs without parsing private run files by hand: every
// read goes through `agent-deck run status --json` and
// `agent-deck run log --json`. Completion comes from the CLI itself
// (`run log --follow --json` blocks until an end/error line), so this
// adapter defines no timeout, poll, retry, or concurrency values of its
// own. A run that never reaches a terminal log event fails closed.
// Session identifiers are opaque runtime values: they are copied from
// status/log output into `--resume` and into conversation observations,
// never parsed apart and never synthesized. A resumed run that reports a
// different session id than the bound run fails closed (session fork).
//
// Multi-runtime for codex, claude, cursor, and muse with one command
// builder; any other runtime value fails closed. The capability probe
// advertises a runtime only after its actual local launch path is verified
// (the runtime binary plus the agent-deck CLI that launches it):
// unverified clients stay valid adapter targets but are not advertised.
import { execFile } from 'child_process';
import { messages } from './db';
import { AGENTS, agentTransport, type BotAgent } from './bot-definition';
import { loadHermesConfig } from './hermes';
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

export const DECK_RUNTIMES = ['codex', 'claude', 'cursor', 'muse'] as const;

export type DeckRuntime = (typeof DECK_RUNTIMES)[number];

export type DeckToolProfile = 'readonly' | 'edit';

export class DeckRuntimeError extends Error {
  readonly code = 'invalid-runtime';
  constructor(value: unknown) {
    super(`Invalid agent-deck runtime: ${JSON.stringify(String(value))}. Expected one of ${DECK_RUNTIMES.join('|')}.`);
  }
}

export function parseDeckRuntime(value: unknown): DeckRuntime {
  if (typeof value === 'string' && (DECK_RUNTIMES as readonly string[]).includes(value)) {
    return value as DeckRuntime;
  }
  throw new DeckRuntimeError(value);
}

export interface DeckRunStartOptions {
  deck: string;
  client: DeckRuntime | string;
  cwd: string;
  prompt?: string;
  promptFile?: string;
  tools?: DeckToolProfile;
  logPath?: string;
  resume?: string;
  detach?: boolean;
}

// One command builder for every runtime. The selected deck and working
// directory pass through exactly; the tool profile defaults to readonly.
// Exactly one of prompt/prompt-file is required (the CLI contract); the
// profile is repeated on resume because nothing is inherited there.
export function buildDeckRunStartCommand(options: DeckRunStartOptions): string[] {
  const client = parseDeckRuntime(options.client);
  if (!options.deck) throw new Error('agent-deck run requires a deck.');
  if (!options.cwd) throw new Error('agent-deck run requires --cwd.');
  const hasPrompt = typeof options.prompt === 'string' && options.prompt.length > 0;
  const hasPromptFile = typeof options.promptFile === 'string' && options.promptFile.length > 0;
  if (hasPrompt === hasPromptFile) {
    throw new Error('agent-deck run requires exactly one of --prompt/--prompt-file.');
  }
  const argv = ['agent-deck', 'run', options.deck, '--client', client, '--cwd', options.cwd];
  if (hasPrompt) argv.push('--prompt', options.prompt as string);
  if (hasPromptFile) argv.push('--prompt-file', options.promptFile as string);
  argv.push('--tools', options.tools ?? 'readonly');
  if (options.logPath) argv.push('--log', options.logPath);
  if (options.resume) argv.push('--resume', options.resume);
  if (options.detach) argv.push('--detach');
  return argv;
}

export function buildDeckRunStatusCommand(runId: string): string[] {
  if (!runId) throw new Error('agent-deck run status requires a runId.');
  return ['agent-deck', 'run', 'status', runId, '--json'];
}

export interface DeckRunLogOptions {
  tail?: number;
  // Block until the CLI sees an end/error line, then exit. This is the
  // adapter's only completion wait, and it comes from the CLI contract.
  follow?: boolean;
}

export function buildDeckRunLogCommand(runId: string, options?: DeckRunLogOptions): string[] {
  if (!runId) throw new Error('agent-deck run log requires a runId.');
  const argv = ['agent-deck', 'run', 'log', runId, '--json'];
  if (options?.tail !== undefined) argv.push('--tail', String(options.tail));
  if (options?.follow) argv.push('--follow');
  return argv;
}

export type DeckRunState = 'running' | 'ended' | 'error' | 'died';

export interface DeckRunStatus {
  runId: string;
  deck: string;
  client: string;
  state: DeckRunState;
  sessionId: string | null;
  logPath: string | null;
}

// Detached launches print `run <runId> detached: pid <pid> log <path>`.
// That line is CLI output, not a private run file, and is the only
// start-output parsing in this adapter.
export function parseDetachLine(stdout: string): { runId: string; pid: string; logPath: string } {
  const match = stdout.match(/run\s+(\S+)\s+detached:\s+pid\s+(\S+)\s+log\s+(\S+)/);
  if (!match) throw new Error(`Unrecognized agent-deck detach output: ${JSON.stringify(stdout.slice(0, 200))}.`);
  return { runId: match[1], pid: match[2], logPath: match[3] };
}

const DECK_RUN_STATES: readonly string[] = ['running', 'ended', 'error', 'died'];

export function parseDeckRunStatus(stdout: string): DeckRunStatus {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('agent-deck run status did not return JSON.');
  }
  const state = String(parsed.state ?? '');
  if (!DECK_RUN_STATES.includes(state)) {
    throw new Error(`Unknown agent-deck run state: ${JSON.stringify(state)}.`);
  }
  const sessionId = parsed.sessionId;
  return {
    runId: String(parsed.runId ?? ''),
    deck: String(parsed.deck ?? ''),
    client: String(parsed.client ?? ''),
    state: state as DeckRunState,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    logPath: typeof parsed.logPath === 'string' ? parsed.logPath : null,
  };
}

// The last `result` event in the JSONL log carries the run's outcome; its
// session id is copied through opaquely like the status one. `ended` is
// true only once an `end` line is seen; an `error` line carries the run's
// failure text. A stream with neither is not a completed run.
//
// NOT-483: the public result payload is usable only when it is a non-empty
// string. Any other shape (object, null, missing, empty) leaves `result`
// null and names the payload type in `resultMismatch`, so the caller fails
// closed at this run instead of continuing with empty context. No `text`
// events are reassembled into a substitute result.
export interface DeckLogStream {
  result: { result: string; sessionId: string | null } | null;
  resultMismatch: string | null;
  ended: boolean;
  errorMessage: string | null;
}

function describeResultPayload(event: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(event, 'result')) return 'missing';
  const value = event.result;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === '') return 'empty string';
  return typeof value;
}

export function parseDeckLogStream(logJsonl: string): DeckLogStream {
  let result: { result: string; sessionId: string | null } | null = null;
  let resultMismatch: string | null = null;
  let ended = false;
  let errorMessage: string | null = null;
  for (const line of logJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.t === 'result') {
      const sessionId = event.sessionId ?? event.session_id;
      if (typeof event.result === 'string' && event.result.length > 0) {
        result = {
          result: event.result,
          sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
        };
        resultMismatch = null;
      } else {
        result = null;
        resultMismatch = describeResultPayload(event);
      }
    } else if (event.t === 'end') {
      ended = true;
    } else if (event.t === 'error') {
      const message = event.message ?? event.error;
      errorMessage = typeof message === 'string' && message.length > 0 ? message : 'unknown log error';
    }
  }
  return { result, resultMismatch, ended, errorMessage };
}

export interface DeckRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DeckRunProcess = (argv: string[]) => Promise<DeckRunOutput>;

function defaultDeckRunProcess(argv: string[]): Promise<DeckRunOutput> {
  const [command, ...args] = argv;
  return new Promise(resolve => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ stdout: '', stderr: `Command not found: ${command}`, exitCode: 127 });
        return;
      }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0,
      });
    });
  });
}

let deckRunProcess: DeckRunProcess = defaultDeckRunProcess;

export function setDeckRunProcess(process: DeckRunProcess | null): void {
  deckRunProcess = process ?? defaultDeckRunProcess;
}

export function resetDeckRunProcessForTests(): void {
  deckRunProcess = defaultDeckRunProcess;
}

export interface StartedDeckRun {
  runId: string;
  pid: string;
  logPath: string;
  argv: string[];
}

export async function startDeckRun(options: DeckRunStartOptions): Promise<StartedDeckRun> {
  const argv = buildDeckRunStartCommand(options);
  const output = await deckRunProcess(argv);
  if (output.exitCode !== 0) {
    throw new Error(`agent-deck run failed to start (exit ${output.exitCode}): ${output.stderr.slice(0, 300) || output.stdout.slice(0, 300)}`);
  }
  // A foreground (non-detached) run streams the JSONL log instead of the
  // detach line; it has no runId to observe, so only detached starts are
  // observable runs here.
  const parsed = parseDetachLine(output.stdout);
  return { ...parsed, argv };
}

export async function resumeDeckRun(options: DeckRunStartOptions & { resume: string }): Promise<StartedDeckRun> {
  return startDeckRun({ ...options, detach: true });
}

export async function deckRunStatus(runId: string): Promise<DeckRunStatus> {
  const output = await deckRunProcess(buildDeckRunStatusCommand(runId));
  if (output.exitCode !== 0) {
    throw new Error(`agent-deck run status failed for ${runId} (exit ${output.exitCode}): ${output.stderr.slice(0, 300)}`);
  }
  return parseDeckRunStatus(output.stdout);
}

export interface DeckRunLog {
  raw: string;
  result: { result: string; sessionId: string | null } | null;
  resultMismatch: string | null;
  ended: boolean;
  errorMessage: string | null;
}

export async function deckRunLog(runId: string, options?: DeckRunLogOptions): Promise<DeckRunLog> {
  const output = await deckRunProcess(buildDeckRunLogCommand(runId, options));
  if (output.exitCode !== 0) {
    throw new Error(`agent-deck run log failed for ${runId} (exit ${output.exitCode}): ${output.stderr.slice(0, 300)}`);
  }
  const stream = parseDeckLogStream(output.stdout);
  return { raw: output.stdout, ...stream };
}

// Failure raised by awaitDeckRunEnd. The category is the stable Attempt
// failure category; the message text is unchanged from earlier releases.
export class DeckRunEndError extends Error {
  readonly category: 'runtime_failed' | 'result_contract';
  constructor(category: 'runtime_failed' | 'result_contract', message: string) {
    super(message);
    this.category = category;
  }
}

export interface AwaitedDeckRun {
  status: DeckRunStatus;
  result: string;
  sessionId: string | null;
}

// Awaits a run to completion through the CLI only: `run log --follow`
// blocks until an end/error line, then `run status` gives the authoritative
// state. An error line, a missing terminal line, or an error/died state
// all fail closed. Assumes the CLI's --follow terminates for died runs
// (it exits once an end or error line is seen); a still-running run whose
// log never terminates stays inside the CLI wait, never in adapter timing.
// NOT-483: an ended run without a non-empty string result also fails
// closed here, naming the run and the payload type, before any later run.
export async function awaitDeckRunEnd(runId: string): Promise<AwaitedDeckRun> {
  const log = await deckRunLog(runId, { follow: true });
  if (log.errorMessage) {
    throw new DeckRunEndError('runtime_failed', `agent-deck run ${runId} failed: ${log.errorMessage.slice(0, 300)}`);
  }
  if (!log.ended) {
    throw new DeckRunEndError('runtime_failed', `agent-deck run ${runId} ended without a terminal log event; failing closed.`);
  }
  const status = await deckRunStatus(runId);
  if (status.state === 'error' || status.state === 'died') {
    throw new DeckRunEndError('runtime_failed', `agent-deck run ${runId} ${status.state}`);
  }
  if (!log.result) {
    throw new DeckRunEndError(
      'result_contract',
      `agent-deck run ${runId} result contract mismatch: expected a non-empty string result, got ${log.resultMismatch ?? 'no result event'}.`
    );
  }
  return {
    status,
    result: log.result.result,
    sessionId: status.sessionId ?? log.result.sessionId,
  };
}

// Capability probe: a runtime is advertised only after its actual local
// launch path is verified. Each client maps to its own local binary, and
// the agent-deck CLI itself must be present to launch it: both probes must
// pass. The cursor/muse binary names follow the same `<name> --version`
// convention as codex/claude (both binaries exist on the owner's Mac); a
// wrong name fails closed here (binary missing, not advertised) rather
// than launching something unexpected.
const RUNTIME_PROBE_COMMANDS: Record<DeckRuntime, string[]> = {
  codex: ['codex', '--version'],
  claude: ['claude', '--version'],
  cursor: ['cursor', '--version'],
  muse: ['muse', '--version'],
};

const AGENT_DECK_PROBE_COMMAND = ['agent-deck', '--version'];

export function probeCommandFor(client: DeckRuntime | string): string[] {
  return RUNTIME_PROBE_COMMANDS[parseDeckRuntime(client)];
}

export async function probeDeckRuntime(client: DeckRuntime | string): Promise<boolean> {
  const argv = probeCommandFor(client);
  try {
    const binary = await deckRunProcess(argv);
    if (binary.exitCode !== 0) return false;
    const launcher = await deckRunProcess(AGENT_DECK_PROBE_COMMAND);
    return launcher.exitCode === 0;
  } catch {
    return false;
  }
}

// Only launch paths whose probe is ready are advertised. Unverified clients
// remain valid adapter targets (the builder accepts them) but are listed
// here only after verification.
export async function listAvailableDeckRuntimes(): Promise<DeckRuntime[]> {
  const available: DeckRuntime[] = [];
  for (const runtime of DECK_RUNTIMES) {
    if (await probeDeckRuntime(runtime)) available.push(runtime);
  }
  return available;
}

// NOT-456: agent capability path. Every agent (Hermes included) is
// launched on its selected Agent Deck through its adapter: Hermes through
// the persistent Hermes gateway, the coding agents through `agent-deck
// run`. An agent is advertised only when its adapter is verified ready:
// the Hermes gateway configuration for Hermes, the deck-run probe above
// for the coding agents. Agent Deck itself is never an agent here.
let hermesAdapterProbe: () => boolean = () => loadHermesConfig() !== null;

export function setHermesAdapterProbe(probe: (() => boolean) | null): void {
  hermesAdapterProbe = probe ?? (() => loadHermesConfig() !== null);
}

export async function probeAgent(agent: BotAgent): Promise<boolean> {
  if (agentTransport(agent) === 'hermes-gateway') {
    try {
      return hermesAdapterProbe();
    } catch {
      return false;
    }
  }
  return probeDeckRuntime(agent);
}

export async function listAvailableAgents(): Promise<BotAgent[]> {
  const available: BotAgent[] = [];
  for (const agent of AGENTS) {
    if (await probeAgent(agent)) available.push(agent);
  }
  return available;
}

// NOT-467: Agent Deck single-Attempt adapter (./attempt-adapter contract).
// One Attempt is one detached `agent-deck run` (a resume when a session
// binding is given) awaited to its terminal log event. The tool profile is
// exactly the input's; there is no default here and nothing is derived
// from the Agent type. A resumed run reporting a different session than
// the binding fails closed as a session mismatch.
export function deckPromptForAttempt(prompt: AttemptPrompt): string {
  if (prompt.kind === 'text') return prompt.text;
  const transcript = prompt.history
    .map(entry => `[${entry.fromAgent ? 'you' : entry.speakerLabel}] ${entry.content}`)
    .join('\n\n');
  return `${prompt.system}\n\nConversation so far (reply to the last message):\n\n${transcript}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAgentDeckAttemptAdapter(): AttemptAdapter {
  const name = 'agent-deck-run' as const;
  return {
    name,
    async run(input: Readonly<AttemptInput>, onEvent): Promise<AttemptResult> {
      const startedAt = Date.now();
      const failed = (failure: AttemptFailure, ids: { runId?: string | null; sessionId?: string | null; logPath?: string | null } = {}): AttemptResult => ({
        status: 'failed',
        adapter: name,
        externalRunId: ids.runId ?? null,
        externalSessionId: ids.sessionId ?? null,
        output: null,
        artifacts: ids.logPath ? [{ kind: 'run_log', ref: ids.logPath }] : [],
        startedAt,
        finishedAt: Date.now(),
        failure,
      });
      if (input.toolProfile !== 'readonly' && input.toolProfile !== 'edit') {
        return failed(attemptFailure('unsupported_authority', `Unsupported tool profile: ${JSON.stringify(String(input.toolProfile))}.`));
      }
      if (!input.deck) return failed(attemptFailure('unavailable', 'agent-deck run requires a deck.'));
      if (!input.cwd) return failed(attemptFailure('unavailable', 'agent-deck run requires --cwd.'));
      let client: DeckRuntime;
      try {
        client = parseDeckRuntime(input.target.agent);
      } catch (error) {
        return failed(attemptFailure('unavailable', errorText(error)));
      }
      const early = preLaunchInterruption(input);
      if (early) return failed(early);

      const resume = input.sessionBinding?.externalSessionId ?? null;
      let started: StartedDeckRun;
      try {
        started = await startDeckRun({
          deck: input.deck,
          client,
          cwd: input.cwd,
          prompt: deckPromptForAttempt(input.prompt),
          tools: input.toolProfile,
          ...(resume ? { resume } : {}),
          detach: true,
        });
      } catch (error) {
        return failed(attemptFailure('launch_failed', errorText(error)));
      }
      onEvent?.({ type: 'started', adapter: name, at: Date.now(), externalRunId: started.runId, externalSessionId: null });

      const stop = interruption(input);
      const awaiting = awaitDeckRunEnd(started.runId);
      // An interrupted wait leaves the CLI child running; its outcome is
      // discarded, so its rejection must not surface unhandled.
      awaiting.catch(() => {});
      const ids = { runId: started.runId, logPath: started.logPath };
      try {
        const settled = await Promise.race([
          awaiting.then(awaited => ({ awaited }), (error: unknown) => ({ error })),
          stop.promise.then(interrupted => ({ interrupted })),
        ]);
        if ('interrupted' in settled) return failed(settled.interrupted, ids);
        if ('error' in settled) {
          const category = settled.error instanceof DeckRunEndError ? settled.error.category : 'runtime_failed';
          return failed(attemptFailure(category, errorText(settled.error)), ids);
        }
        const { awaited } = settled;
        const logPath = awaited.status.logPath ?? started.logPath;
        if (resume && awaited.sessionId !== null && awaited.sessionId !== resume) {
          return failed(attemptFailure(
            'session_mismatch',
            `resume run ${started.runId} forked the session (expected ${resume}, got ${awaited.sessionId}); failing closed.`
          ), { ...ids, sessionId: awaited.sessionId, logPath });
        }
        return {
          status: 'completed',
          adapter: name,
          externalRunId: started.runId,
          externalSessionId: awaited.sessionId ?? resume,
          output: awaited.result,
          artifacts: logPath ? [{ kind: 'run_log', ref: logPath }] : [],
          startedAt,
          finishedAt: Date.now(),
          failure: null,
        };
      } finally {
        stop.dispose();
      }
    },
  };
}

// NOT-442: the model is never presented a DECK how-to. Ordinary turns
// dispatch through the bot's own stored runtime in the conversation loop
// (processAgentDeckTurn in ./agent), so no directive vocabulary is
// advertised and no directive is parsed anywhere.

export interface DeckDelegationRequest {
  conversationId: string;
  botId: string;
  deck: string;
  client: DeckRuntime | string;
  cwd: string;
  task: string;
  reviewFocus: string;
  // Cooperative Stop: checked before every phase and after every wait. When
  // it flips mid-sequence the delegation returns null silently (Stop
  // already posted its own notice and promises no late messages) instead
  // of starting further runs or posting results. The in-flight CLI child
  // keeps running; its result is discarded.
  isStopped?: () => boolean;
}

export interface DeckDelegationResult {
  implRunId: string;
  implSessionId: string | null;
  implResult: string;
  reviewRunId: string;
  reviewResult: string;
  resumeRunId: string;
  resumedSessionId: string | null;
  finalResult: string;
}

function observe(request: DeckDelegationRequest, text: string): void {
  messages.create(request.conversationId, 'bot', text, request.botId);
}

// NOT-462: phase authority for the composite implementation workflow is
// fixed here, at the orchestration boundary, per docs/core-engine.md:
// implementation and revision edit, review stays read-only. There is no
// caller-supplied profile, so an omitted option can neither downgrade the
// builder nor broaden the reviewer. The low-level command builder keeps its
// readonly default for every other caller.
export const DECK_DELEGATION_PHASE_TOOLS = Object.freeze({
  implement: 'edit',
  review: 'readonly',
  revise: 'edit',
} as const satisfies Record<'implement' | 'review' | 'revise', DeckToolProfile>);

// The conversation integration: from the same Botmancers conversation the
// caller hands implementation to a local coding agent through agent-deck,
// hands the result to a reviewer run, and resumes the original coding
// session with the review. Every step posts a structured observation into
// the originating thread, so the thread holds correlated evidence with no
// manual prompt or session-ID copying. Returns null (silently) when Stop
// halts the sequence mid-flight; throws (after a [Deck failed]
// observation) on any run failure, including a resumed session that forks.
export async function delegateCodingViaDeck(request: DeckDelegationRequest): Promise<DeckDelegationResult | null> {
  const client = parseDeckRuntime(request.client);
  const stopped = request.isStopped ?? (() => false);
  // NOT-467: compatibility caller. Each phase is one single Attempt through
  // the shared adapter; phase order, authority, and observations stay here.
  const adapter = createAgentDeckAttemptAdapter();
  const phase = async (
    prompt: string,
    toolProfile: DeckToolProfile,
    sessionBinding: AttemptInput['sessionBinding'] = null
  ): Promise<AttemptResult> => adapter.run({
    target: { agentId: request.botId, agent: client },
    prompt: { kind: 'text', text: prompt },
    cwd: request.cwd,
    deck: request.deck,
    toolProfile,
    sessionBinding,
    correlation: { conversationId: request.conversationId },
  });
  const outputOf = (result: AttemptResult): string => {
    if (result.status !== 'completed' || result.output === null) {
      throw new Error(result.failure?.message ?? `agent-deck run ${result.externalRunId ?? 'unknown'} failed`);
    }
    return result.output;
  };
  try {
    if (stopped()) return null;
    observe(request, `[Deck handoff] agent=${client} deck=${request.deck}\n${request.task}`);
    const impl = await phase(request.task, DECK_DELEGATION_PHASE_TOOLS.implement);
    if (stopped()) return null;
    const implResult = outputOf(impl);
    const implRunId = impl.externalRunId as string;
    const implSessionId = impl.externalSessionId;
    observe(request, `[Deck run] runId=${implRunId} sessionId=${implSessionId ?? 'unknown'}`);

    if (stopped()) return null;
    const review = await phase(
      `Review this implementation result against the goal.\n\nGoal: ${request.task}\n\nReview focus: ${request.reviewFocus}\n\nImplementation result:\n${implResult}`,
      DECK_DELEGATION_PHASE_TOOLS.review
    );
    if (stopped()) return null;
    const reviewResult = outputOf(review);
    const reviewRunId = review.externalRunId as string;
    observe(request, `[Deck review] runId=${reviewRunId} result=${reviewResult.slice(0, 500)}`);

    if (!implSessionId) {
      throw new Error(`implementation run ${implRunId} reported no session to resume`);
    }
    if (stopped()) return null;
    // Resume receives the original session id unchanged: the value is
    // copied from the bound run's status, never synthesized. The adapter
    // fails closed when the resumed run reports a different session.
    const resume = await phase(reviewResult, DECK_DELEGATION_PHASE_TOOLS.revise, {
      bindingId: null,
      externalSessionId: implSessionId,
    });
    if (stopped()) return null;
    const finalResult = outputOf(resume);
    const resumeRunId = resume.externalRunId as string;
    const resumedSessionId = resume.externalSessionId ?? implSessionId;
    observe(request, `[Deck resume] runId=${resumeRunId} sessionId=${resumedSessionId}`);
    observe(request, `[Deck result] runId=${resumeRunId} result=${finalResult.slice(0, 500)}`);
    return {
      implRunId,
      implSessionId,
      implResult,
      reviewRunId,
      reviewResult,
      resumeRunId,
      resumedSessionId,
      finalResult,
    };
  } catch (error) {
    // A Stop that lands with an error in flight stays silent: Stop promises
    // no late messages and already posted its own notice.
    if (stopped()) return null;
    observe(request, `[Deck failed] agent=${client} deck=${request.deck} error=${String(error).slice(0, 300)}`);
    throw error;
  }
}

// Default review focus for direct Agent Deck turns, where the ordinary
// message carries only the task. Exported so the conversation loop and
// tests share the exact string.
export const DECK_REVIEW_FOCUS_DEFAULT = 'Correctness, edge cases, and fit to the stated goal.';

// NOT-442: no DECK directive and no working-directory deck resolution.
// Ordinary messages to an agent-deck bot launch the stored agent client on
// the stored deck ID directly; the Hermes reply is never parsed for
// routing and no `.agent-deck/use.json` file is read here.
