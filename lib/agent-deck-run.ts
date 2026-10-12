// NOT-395: Botmancers adapter boundary for `agent-deck run`.
//
// One boundary that starts, observes, reads the result of, and resumes
// local coding-agent runs without parsing private run files by hand: every
// read goes through `agent-deck run status --json` and
// `agent-deck run log --json`. Session identifiers are opaque runtime
// values: they are copied from status/log output into `--resume` and into
// conversation observations, never parsed apart and never synthesized.
//
// Multi-runtime for codex, claude, cursor, and muse with one command
// builder; any other runtime value fails closed. The capability probe
// advertises a runtime only after its actual local launch path is verified:
// unverified clients stay valid adapter targets but are not advertised.
import { execFile } from 'child_process';
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
  if (!options.deck) throw new DeckRuntimeError(options.client);
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

export function buildDeckRunLogCommand(runId: string, tail?: number): string[] {
  if (!runId) throw new Error('agent-deck run log requires a runId.');
  const argv = ['agent-deck', 'run', 'log', runId, '--json'];
  if (tail !== undefined) argv.push('--tail', String(tail));
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
// session id is copied through opaquely like the status one.
export function extractDeckResult(logJsonl: string): { result: string; sessionId: string | null } | null {
  let found: { result: string; sessionId: string | null } | null = null;
  for (const line of logJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.t !== 'result') continue;
    const sessionId = event.sessionId ?? event.session_id;
    found = {
      result: typeof event.result === 'string' ? event.result : '',
      sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    };
  }
  return found;
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
}

export async function deckRunLog(runId: string, tail?: number): Promise<DeckRunLog> {
  const output = await deckRunProcess(buildDeckRunLogCommand(runId, tail));
  if (output.exitCode !== 0) {
    throw new Error(`agent-deck run log failed for ${runId} (exit ${output.exitCode}): ${output.stderr.slice(0, 300)}`);
  }
  return { raw: output.stdout, result: extractDeckResult(output.stdout) };
}

// Polls `run status` until the run leaves `running`. The caller supplies
// the pacing and the poll budget: this adapter defines no timeout, retry,
// or concurrency values of its own.
export async function waitForDeckRunEnd(
  runId: string,
  poll: { intervalMs: number; maxPolls: number; sleep?: (ms: number) => Promise<void> }
): Promise<DeckRunStatus> {
  let latest: DeckRunStatus | null = null;
  for (let attempt = 0; attempt < poll.maxPolls; attempt++) {
    latest = await deckRunStatus(runId);
    if (latest.state !== 'running') return latest;
    await (poll.sleep ?? defaultSleep)(poll.intervalMs);
  }
  if (!latest) throw new Error(`agent-deck run ${runId} never reported status.`);
  return latest;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Capability probe: a runtime is advertised only after its actual local
// launch path is verified. Each client maps to its own local binary, so a
// passing probe proves the launch path exists on this machine.
const RUNTIME_PROBE_COMMANDS: Record<DeckRuntime, string[]> = {
  codex: ['codex', '--version'],
  claude: ['claude', '--version'],
  cursor: ['cursor', '--version'],
  muse: ['muse', '--version'],
};

export function probeCommandFor(client: DeckRuntime | string): string[] {
  return RUNTIME_PROBE_COMMANDS[parseDeckRuntime(client)];
}

export async function probeDeckRuntime(client: DeckRuntime | string): Promise<boolean> {
  const argv = probeCommandFor(client);
  try {
    const output = await deckRunProcess(argv);
    return output.exitCode === 0;
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

export interface DeckDelegationRequest {
  conversationId: string;
  botId: string;
  deck: string;
  client: DeckRuntime | string;
  cwd: string;
  task: string;
  reviewFocus: string;
  tools?: DeckToolProfile;
  poll?: { intervalMs: number; maxPolls: number; sleep?: (ms: number) => Promise<void> };
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

async function runToEnd(runId: string, poll?: DeckDelegationRequest['poll']): Promise<DeckRunStatus> {
  if (!poll) return deckRunStatus(runId);
  return waitForDeckRunEnd(runId, poll);
}

// The conversation integration: from the same Botmancers conversation the
// caller hands implementation to a local coding agent through agent-deck,
// hands the result to a reviewer run, and resumes the original coding
// session with the review. Every step posts a structured observation into
// the originating thread, so the thread holds correlated evidence with no
// manual prompt or session-ID copying.
export async function delegateCodingViaDeck(request: DeckDelegationRequest): Promise<DeckDelegationResult> {
  const client = parseDeckRuntime(request.client);
  const tools = request.tools ?? 'readonly';
  try {
    observe(request, `[Deck handoff] runtime=${client} deck=${request.deck}\n${request.task}`);
    const impl = await startDeckRun({
      deck: request.deck,
      client,
      cwd: request.cwd,
      prompt: request.task,
      tools,
      detach: true,
    });
    const implStatus = await runToEnd(impl.runId, request.poll);
    if (implStatus.state === 'error' || implStatus.state === 'died') {
      throw new Error(`implementation run ${impl.runId} ${implStatus.state}`);
    }
    observe(request, `[Deck run] runId=${impl.runId} sessionId=${implStatus.sessionId ?? 'unknown'}`);
    const implLog = await deckRunLog(impl.runId);
    const implResult = implLog.result?.result ?? '';
    const implSessionId = implStatus.sessionId ?? implLog.result?.sessionId ?? null;

    const review = await startDeckRun({
      deck: request.deck,
      client,
      cwd: request.cwd,
      prompt: `Review this implementation result against the goal.\n\nGoal: ${request.task}\n\nReview focus: ${request.reviewFocus}\n\nImplementation result:\n${implResult}`,
      tools: 'readonly',
      detach: true,
    });
    const reviewStatus = await runToEnd(review.runId, request.poll);
    if (reviewStatus.state === 'error' || reviewStatus.state === 'died') {
      throw new Error(`review run ${review.runId} ${reviewStatus.state}`);
    }
    const reviewLog = await deckRunLog(review.runId);
    const reviewResult = reviewLog.result?.result ?? '';
    observe(request, `[Deck review] runId=${review.runId} result=${reviewResult.slice(0, 500)}`);

    if (!implSessionId) {
      throw new Error(`implementation run ${impl.runId} reported no session to resume`);
    }
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
    const resumeStatus = await runToEnd(resume.runId, request.poll);
    if (resumeStatus.state === 'error' || resumeStatus.state === 'died') {
      throw new Error(`resume run ${resume.runId} ${resumeStatus.state}`);
    }
    observe(request, `[Deck resume] runId=${resume.runId} sessionId=${resumeStatus.sessionId ?? implSessionId}`);
    const resumeLog = await deckRunLog(resume.runId);
    const finalResult = resumeLog.result?.result ?? '';
    observe(request, `[Deck result] runId=${resume.runId} result=${finalResult.slice(0, 500)}`);
    return {
      implRunId: impl.runId,
      implSessionId,
      implResult,
      reviewRunId: review.runId,
      reviewResult,
      resumeRunId: resume.runId,
      resumedSessionId: resumeStatus.sessionId ?? implSessionId,
      finalResult,
    };
  } catch (error) {
    observe(request, `[Deck failed] runtime=${client} deck=${request.deck} error=${String(error).slice(0, 300)}`);
    throw error;
  }
}
