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
import fs from 'fs';
import path from 'path';
import { messages } from './db';

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
export interface DeckLogStream {
  result: { result: string; sessionId: string | null } | null;
  ended: boolean;
  errorMessage: string | null;
}

export function parseDeckLogStream(logJsonl: string): DeckLogStream {
  let result: { result: string; sessionId: string | null } | null = null;
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
      result = {
        result: typeof event.result === 'string' ? event.result : '',
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
      };
    } else if (event.t === 'end') {
      ended = true;
    } else if (event.t === 'error') {
      const message = event.message ?? event.error;
      errorMessage = typeof message === 'string' && message.length > 0 ? message : 'unknown log error';
    }
  }
  return { result, ended, errorMessage };
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
  ended: boolean;
  errorMessage: string | null;
}

export async function deckRunLog(runId: string, options?: DeckRunLogOptions): Promise<DeckRunLog> {
  const output = await deckRunProcess(buildDeckRunLogCommand(runId, options));
  if (output.exitCode !== 0) {
    throw new Error(`agent-deck run log failed for ${runId} (exit ${output.exitCode}): ${output.stderr.slice(0, 300)}`);
  }
  const stream = parseDeckLogStream(output.stdout);
  return { raw: output.stdout, result: stream.result, ended: stream.ended, errorMessage: stream.errorMessage };
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
export async function awaitDeckRunEnd(runId: string): Promise<AwaitedDeckRun> {
  const log = await deckRunLog(runId, { follow: true });
  if (log.errorMessage) {
    throw new Error(`agent-deck run ${runId} failed: ${log.errorMessage.slice(0, 300)}`);
  }
  if (!log.ended) {
    throw new Error(`agent-deck run ${runId} ended without a terminal log event; failing closed.`);
  }
  const status = await deckRunStatus(runId);
  if (status.state === 'error' || status.state === 'died') {
    throw new Error(`agent-deck run ${runId} ${status.state}`);
  }
  return {
    status,
    result: log.result?.result ?? '',
    sessionId: status.sessionId ?? log.result?.sessionId ?? null,
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

// The DECK how-to presented to the model in the conversation loop, so a
// real model-driven turn can emit the directive instead of only test stubs.
// The verified list comes from the capability probe and is reported as-is:
// before the first probe completes the caller passes null, and an empty or
// unknown-only probe result both render as 'none verified yet' — no runtime
// is named until its launch path is actually verified. Unverified runtimes
// stay valid targets but are flagged as fail-closed when their launch path
// is missing.
export function formatDeckHowTo(available: readonly string[] | null | undefined): string {
  const verified = (available ?? []).filter((runtime): runtime is DeckRuntime =>
    (DECK_RUNTIMES as readonly string[]).includes(runtime)
  );
  const verifiedText = verified.length > 0 ? verified.join(', ') : 'none verified yet';
  return [
    'You can also hand implementation work to a local coding agent through agent-deck: put a DECK directive on its own line.',
    '- DECK <runtime>: <task>  (runtimes: codex, claude, cursor, muse)',
    `Verified launch paths right now: ${verifiedText}. An unverified runtime is still accepted but fails closed when its launch path is missing.`,
    'The implementation run, a reviewer run, and a resume of the original coding session all post into this same thread; like any delegated reply, the result comes back to you and you report it.',
  ].join('\n');
}

export interface DeckDelegationRequest {
  conversationId: string;
  botId: string;
  deck: string;
  client: DeckRuntime | string;
  cwd: string;
  task: string;
  reviewFocus: string;
  tools?: DeckToolProfile;
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
  const tools = request.tools ?? 'readonly';
  const stopped = request.isStopped ?? (() => false);
  try {
    if (stopped()) return null;
    observe(request, `[Deck handoff] runtime=${client} deck=${request.deck}\n${request.task}`);
    const impl = await startDeckRun({
      deck: request.deck,
      client,
      cwd: request.cwd,
      prompt: request.task,
      tools,
      detach: true,
    });
    const implAwaited = await awaitDeckRunEnd(impl.runId);
    if (stopped()) return null;
    const implSessionId = implAwaited.sessionId;
    observe(request, `[Deck run] runId=${impl.runId} sessionId=${implSessionId ?? 'unknown'}`);
    const implResult = implAwaited.result;

    if (stopped()) return null;
    const review = await startDeckRun({
      deck: request.deck,
      client,
      cwd: request.cwd,
      prompt: `Review this implementation result against the goal.\n\nGoal: ${request.task}\n\nReview focus: ${request.reviewFocus}\n\nImplementation result:\n${implResult}`,
      tools: 'readonly',
      detach: true,
    });
    const reviewAwaited = await awaitDeckRunEnd(review.runId);
    if (stopped()) return null;
    const reviewResult = reviewAwaited.result;
    observe(request, `[Deck review] runId=${review.runId} result=${reviewResult.slice(0, 500)}`);

    if (!implSessionId) {
      throw new Error(`implementation run ${impl.runId} reported no session to resume`);
    }
    if (stopped()) return null;
    // Resume receives the original session id unchanged: the value is
    // copied from the bound run's status, never synthesized.
    const resume = await resumeDeckRun({
      deck: request.deck,
      client,
      cwd: request.cwd,
      prompt: reviewResult,
      tools,
      resume: implSessionId,
    });
    const resumeAwaited = await awaitDeckRunEnd(resume.runId);
    if (stopped()) return null;
    const resumedSessionId = resumeAwaited.sessionId ?? implSessionId;
    if (resumeAwaited.sessionId !== null && resumeAwaited.sessionId !== implSessionId) {
      throw new Error(
        `resume run ${resume.runId} forked the session (expected ${implSessionId}, got ${resumeAwaited.sessionId}); failing closed.`
      );
    }
    observe(request, `[Deck resume] runId=${resume.runId} sessionId=${resumedSessionId}`);
    const finalResult = resumeAwaited.result;
    observe(request, `[Deck result] runId=${resume.runId} result=${finalResult.slice(0, 500)}`);
    return {
      implRunId: impl.runId,
      implSessionId,
      implResult,
      reviewRunId: review.runId,
      reviewResult,
      resumeRunId: resume.runId,
      resumedSessionId,
      finalResult,
    };
  } catch (error) {
    // A Stop that lands with an error in flight stays silent: Stop promises
    // no late messages and already posted its own notice.
    if (stopped()) return null;
    observe(request, `[Deck failed] runtime=${client} deck=${request.deck} error=${String(error).slice(0, 300)}`);
    throw error;
  }
}

// Default review focus for conversation-triggered deck delegations, where
// the model directive carries only the task. Exported so the conversation
// loop and tests share the exact string.
export const DECK_REVIEW_FOCUS_DEFAULT = 'Correctness, edge cases, and fit to the stated goal.';

// Resolves the deck for a working directory from the repo's own agent-deck
// assignment (`agent-deck use <deck>` writes `.agent-deck/use.json` there),
// so the conversation loop passes the folder's deck exactly and never a
// second copy of it. Prefers the stable deck id, falls back to the name.
// Fails closed when the folder names no deck: `run` itself would fail
// closed on the mismatch, so the adapter refuses before starting anything.
export function resolveDeckForCwd(cwd: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, '.agent-deck', 'use.json'), 'utf8');
  } catch {
    throw new Error(
      `no agent-deck deck assignment for ${cwd} (expected .agent-deck/use.json via 'agent-deck use <deck>').`
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`unreadable agent-deck deck assignment for ${cwd} (expected JSON in .agent-deck/use.json).`);
  }
  const deck = parsed.deckId ?? parsed.deckName;
  if (typeof deck !== 'string' || deck.length === 0) {
    throw new Error(`agent-deck deck assignment for ${cwd} names no deck (expected deckId or deckName).`);
  }
  return deck;
}

export interface DeckDirective {
  client: string;
  task: string;
}

// A model-reply directive paralleling WAKE: `DECK <runtime>: <task>` routes
// the turn through the deck adapter instead of another bot. Anchored to a
// line start, uppercase DECK only, and known runtime tokens only, so prose
// that merely mentions a deck ('update the deck notes: ...', 'the deck
// below: ...') and WAKE handoffs fall through to the normal reply path.
// An unknown runtime is not a directive either: it stays a normal reply
// (with the usual caller-managed return) instead of hijacking the turn.
// Requires a non-empty task: `run` needs exactly one of
// --prompt/--prompt-file.
export const DECK_DIRECTIVE_PATTERN = /^DECK[ \t]+(codex|claude|cursor|muse)[ \t]*:[ \t]*(\S[\s\S]*)/m;

export function parseDeckDirective(responseContent: string): DeckDirective | null {
  const match = responseContent.match(DECK_DIRECTIVE_PATTERN);
  if (!match) return null;
  return { client: match[1], task: match[2].trim() };
}
