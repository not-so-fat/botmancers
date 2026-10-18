// NOT-506: the direct Claude Code SessionProvider (./session-provider). No
// Agent Deck: Botmancers talks to the locally installed, logged-in `claude`
// CLI and its local session store (./claude-session-store).
//
// Turns use Claude Code's supported non-interactive interface only:
//
//   claude -p --output-format stream-json --verbose --input-format text
//     --permission-mode <mode> --permission-prompts none
//     --tools <list> --allowedTools <list> --strict-mcp-config
//     (--session-id <new uuid> | --resume <session id>)
//
// with the prompt on stdin, cwd = the explicit workspace (start) or the
// workspace the session recorded (resume; Claude Code resolves a session
// from its project directory). The authority Botmancers passes maps to an
// explicit mode and tool list (CLAUDE_AUTHORITY_MODES); nothing would
// prompt, and if something did, nobody answers it, so it is denied. Output
// is read as structured stream events only (./claude-stream).
//
// A resume never becomes a new session: a missing session is refused
// before any process starts, and a process whose init event names a
// different session is killed and reported, never adopted.
//
// Each turn's process is detached with stdout/stderr in files under the
// provider state directory, beside a small JSON record (pid, session,
// state). observeTurn and cancelTurn read only those files, so a turn
// started before a Botmancers restart is observed and cancelled the same
// way after it. Claude session ids are only ever handed back to
// ./provider-sessions, which keeps them private.
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { dbPath } from './home';
import {
  claudeConfigDir,
  cleanupPeriodDays,
  findSessionFile,
  isClaudeSessionId,
  listSessionFiles,
  liveSessionIds,
  readSessionMeta,
  readTranscriptEntries,
  workspaceWithin,
  type LocalSessionMeta,
} from './claude-session-store';
import { classifyFailure, reportedUsage, resultSucceeded, summarizeStream, type ClaudeFailureCode } from './claude-stream';
import {
  providerError,
  providerOk,
  type ProviderErrorCode,
  type ProviderSessionRecord,
  type ProviderTurnResult,
  type SessionAuthority,
  type SessionProvider,
  type SessionProviderCapabilities,
} from './session-provider';

export const CLAUDE_PROVIDER_KIND = 'claude-code';
// The oldest Claude Code the flag set above was built against.
export const MIN_CLAUDE_CODE_VERSION = '2.1.0';

export const CLAUDE_AUTHORITY_MODES: Record<SessionAuthority, { permission_mode: string; tools: string[] }> = {
  // Reads only: no edit, write, shell, web, or MCP tool exists in the turn.
  read_only: { permission_mode: 'dontAsk', tools: ['Read', 'Glob', 'Grep'] },
  // File edits inside the working directory, still no shell, web, or MCP.
  workspace_write: { permission_mode: 'acceptEdits', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit'] },
};

const CAPABILITIES: SessionProviderCapabilities = {
  list: true, search: true, read: true, resume: true, start: true, cancel: true, usage: true,
  authorities: ['read_only', 'workspace_write'], max_page_size: 25,
};
const DAY_MS = 24 * 60 * 60 * 1000;

type VersionCheck = { ok: true; version: string } | { ok: false; code: ProviderErrorCode; message: string };
// One `claude --version` probe per executable per process.
const versionCache = new Map<string, VersionCheck>();
export function resetClaudeVersionCache(): void {
  versionCache.clear();
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeProviderOptions {
  // The `claude` executable (default $BOTMANCERS_CLAUDE_BIN or `claude`).
  bin?: string;
  // Claude Code's config directory (default $CLAUDE_CONFIG_DIR or ~/.claude).
  configDir?: string;
  // Where turn records and logs live (default $BOTMANCERS_CLAUDE_STATE_DIR,
  // else claude-provider/ beside the Botmancers database).
  stateDir?: string;
  // Base environment for the CLI (default process.env).
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  isPidAlive?: (pid: number) => boolean;
  // How long start/send wait for the first structured event (default 60s).
  startupTimeoutMs?: number;
  pollMs?: number;
}

export function defaultClaudeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BOTMANCERS_CLAUDE_STATE_DIR || '').trim();
  return explicit ? path.resolve(explicit) : path.join(path.dirname(path.resolve(dbPath(env))), 'claude-provider');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// The environment a turn runs with: the base environment without any Agent
// Deck variable (the direct provider never routes through a deck).
export function claudeTurnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(base)) if (!/^AGENT_DECK/.test(key) && value !== undefined) env[key] = value;
  return env;
}

export function claudeTurnArgs(authority: SessionAuthority, target: { resume: string } | { sessionId: string }): string[] {
  const mode = CLAUDE_AUTHORITY_MODES[authority];
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text',
    '--permission-mode', mode.permission_mode, '--permission-prompts', 'none',
    '--tools', mode.tools.join(','), '--allowedTools', mode.tools.join(','), '--strict-mcp-config',
    ...('resume' in target ? ['--resume', target.resume] : ['--session-id', target.sessionId]),
  ];
}

interface TurnRecord {
  id: string;
  session_id: string;
  kind: 'start' | 'send';
  authority: SessionAuthority;
  workspace: string;
  pid: number | null;
  state: 'running' | 'exited' | 'cancelled' | 'spawn_failed';
  exit_code: number | null;
  created_at: number;
  finished_at: number | null;
}

// Provider error code for each stable stream failure.
const FAILURE_TO_ERROR: Record<ClaudeFailureCode, ProviderErrorCode> = {
  session_missing: 'not_found',
  auth_required: 'auth_required',
  permission_denied: 'permission_denied',
  usage_limit: 'usage_limit',
  incompatible_version: 'incompatible_version',
  session_mismatch: 'not_resumable',
  process_exited: 'unavailable',
  cancelled: 'cancelled',
  runtime_error: 'unavailable',
};

export function createClaudeSessionProvider(options: ClaudeProviderOptions = {}): SessionProvider {
  const baseEnv = options.env ?? process.env;
  const bin = options.bin ?? ((baseEnv.BOTMANCERS_CLAUDE_BIN || '').trim() || 'claude');
  const configDir = options.configDir ?? claudeConfigDir(baseEnv);
  const stateDir = options.stateDir ?? defaultClaudeStateDir(baseEnv);
  const spawn = options.spawn ?? (nodeSpawn as SpawnFn);
  const isAlive = options.isPidAlive ?? pidAlive;
  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 100;
  const turnsDir = path.join(stateDir, 'turns');
  const keysDir = path.join(stateDir, 'keys');

  const turnFile = (id: string, ext: string) => path.join(turnsDir, `${id}.${ext}`);
  const readTurn = (id: string): TurnRecord | null => {
    if (!/^ct-[0-9a-f-]{36}$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(turnFile(id, 'json'), 'utf8')) as TurnRecord;
    } catch {
      return null;
    }
  };
  const writeTurn = (turn: TurnRecord) => {
    const tmp = turnFile(turn.id, `json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(turn));
    fs.renameSync(tmp, turnFile(turn.id, 'json'));
  };
  const readText = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };

  function checkVersion(): VersionCheck {
    const cached = versionCache.get(bin);
    if (cached) return cached;
    let version: VersionCheck;
    try {
      const out = execFileSync(bin, ['--version'], { env: claudeTurnEnv(baseEnv), encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
      const found = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
      version = !found ? { ok: false, code: 'incompatible_version', message: 'Claude Code did not report a version.' }
        : compareVersions(found, MIN_CLAUDE_CODE_VERSION) < 0
          ? { ok: false, code: 'incompatible_version', message: `Claude Code ${found} is older than ${MIN_CLAUDE_CODE_VERSION}.` }
          : { ok: true, version: found };
    } catch (error) {
      // Not cached: the CLI may be installed later.
      return { ok: false, code: 'unavailable', message: `Claude Code is not runnable: ${(error as Error).message}` };
    }
    versionCache.set(bin, version);
    return version;
  }

  function runningTurnSessions(): Set<string> {
    const sessions = new Set<string>();
    for (const name of fs.existsSync(turnsDir) ? fs.readdirSync(turnsDir) : []) {
      if (!name.endsWith('.json')) continue;
      const turn = readTurn(name.slice(0, -5));
      if (turn && turn.state === 'running' && !terminalOf(turn)) sessions.add(turn.session_id);
    }
    return sessions;
  }

  function record(meta: LocalSessionMeta, busy: Set<string>, now: number, archiveAfter: number): ProviderSessionRecord {
    return {
      provider_session_id: meta.id,
      title: meta.title,
      workspace: meta.workspace,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      // Claude Code has no archive flag; a session idle past its own
      // transcript retention (cleanupPeriodDays) is archived. Still
      // resumable while its file exists.
      lifecycle: meta.updated_at !== null && now - meta.updated_at > archiveAfter ? 'archived' : 'open',
      resumable: meta.messages > 0,
      busy: busy.has(meta.id),
    };
  }

  function busySessions(): Set<string> {
    return new Set([...liveSessionIds(configDir, isAlive), ...runningTurnSessions()]);
  }

  // The terminal result a turn's files already hold, or null while running.
  function terminalOf(turn: TurnRecord): ProviderTurnResult | null {
    const summary = summarizeStream(readText(turnFile(turn.id, 'out.jsonl')));
    const finished = turn.finished_at ?? Date.now();
    const base = { provider_session_id: turn.session_id, usage: reportedUsage(summary.result), finished_at: finished };
    if (summary.session_id !== null && summary.session_id !== turn.session_id) {
      return { ...base, status: 'failed', output: null, failure: { code: 'session_mismatch', message: 'Claude Code ran a different session than the one requested.' } };
    }
    if (summary.result) {
      if (resultSucceeded(summary.result)) {
        return { ...base, status: 'completed', output: typeof summary.result.result === 'string' ? summary.result.result : null, failure: null };
      }
      return { ...base, status: 'failed', output: null, failure: classifyFailure(summary.result, summary) };
    }
    if (turn.state === 'cancelled') return { ...base, status: 'cancelled', output: null, failure: { code: 'cancelled', message: 'Cancelled.' } };
    const exited = turn.state === 'exited' || turn.state === 'spawn_failed' || turn.pid === null || !isAlive(turn.pid);
    if (!exited) return null;
    // No result event: the process ended without reporting one. A CLI that
    // rejects the flag set is an incompatible version.
    const stderr = readText(turnFile(turn.id, 'err.log'));
    const incompatible = /unknown option|unrecognized option|invalid option/i.test(stderr);
    return {
      ...base, status: 'failed', output: null,
      failure: incompatible
        ? { code: 'incompatible_version', message: 'The installed Claude Code rejected the non-interactive flag set.' }
        : { code: 'process_exited', message: `Claude Code exited without a result${turn.exit_code === null ? '' : ` (exit ${turn.exit_code})`}.` },
    };
  }

  function claimKey(key: string): { existing: TurnRecord | null; claimed: boolean } {
    fs.mkdirSync(keysDir, { recursive: true });
    const file = path.join(keysDir, key.replace(/[^a-zA-Z0-9_-]/g, '_'));
    try {
      fs.writeFileSync(file, '', { flag: 'wx' });
      return { existing: null, claimed: true };
    } catch {
      const id = readText(file).trim();
      return { existing: id ? readTurn(id) : null, claimed: false };
    }
  }
  const keyFile = (key: string) => path.join(keysDir, key.replace(/[^a-zA-Z0-9_-]/g, '_'));

  async function launch(kind: 'start' | 'send', input: { prompt: string; authority: SessionAuthority; idempotency_key: string }, sessionId: string, workspace: string) {
    const id = `ct-${randomUUID()}`;
    fs.mkdirSync(turnsDir, { recursive: true });
    const turn: TurnRecord = { id, session_id: sessionId, kind, authority: input.authority, workspace, pid: null, state: 'running', exit_code: null, created_at: Date.now(), finished_at: null };
    const out = fs.openSync(turnFile(id, 'out.jsonl'), 'a');
    const err = fs.openSync(turnFile(id, 'err.log'), 'a');
    let child: ChildProcess;
    let spawnError: Error | null = null;
    try {
      child = spawn(bin, claudeTurnArgs(input.authority, kind === 'send' ? { resume: sessionId } : { sessionId }), {
        cwd: workspace, env: claudeTurnEnv(baseEnv), stdio: ['pipe', out, err], detached: true,
      });
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    child.on('error', error => { spawnError = error; });
    turn.pid = child.pid ?? null;
    writeTurn(turn);
    child.on('exit', code => {
      const current = readTurn(id);
      if (current && current.state === 'running') writeTurn({ ...current, state: 'exited', exit_code: code, finished_at: Date.now() });
    });
    child.stdin?.on('error', () => { /* the process may exit before reading */ });
    child.stdin?.end(input.prompt);
    child.unref();

    // Wait for the first structured event: init (the session Claude Code is
    // running) or an early result (a refusal before any turn).
    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      const current = readTurn(id) as TurnRecord;
      const summary = summarizeStream(readText(turnFile(id, 'out.jsonl')));
      if (spawnError) {
        writeTurn({ ...current, state: 'spawn_failed', finished_at: Date.now() });
        return { turn: null, error: providerError('unavailable', `Claude Code could not start: ${(spawnError as Error).message}`) };
      }
      if (summary.session_id !== null && summary.session_id !== sessionId) {
        // Never adopt a different session (a fork or a fresh one).
        stopProcess(current);
        writeTurn({ ...current, state: 'cancelled', finished_at: Date.now() });
        return { turn: null, error: providerError('not_resumable', 'Claude Code started a different session; it was stopped.') };
      }
      if (summary.session_id === null && summary.result && !resultSucceeded(summary.result)) {
        const failure = classifyFailure(summary.result, summary);
        return { turn: null, error: providerError(FAILURE_TO_ERROR[failure.code], failure.message) };
      }
      if (summary.session_id !== null || summary.result) return { turn: current, error: null };
      const terminal = terminalOf(current);
      if (terminal) {
        const code = terminal.failure?.code as ClaudeFailureCode | undefined;
        return { turn: null, error: providerError(code ? FAILURE_TO_ERROR[code] ?? 'unavailable' : 'unavailable', terminal.failure?.message ?? 'Claude Code exited.') };
      }
      if (Date.now() >= deadline) return { turn: current, error: null };
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, 25)));
    }
  }

  function stopProcess(turn: TurnRecord): void {
    if (turn.pid === null) return;
    for (const target of [-turn.pid, turn.pid]) {
      try {
        process.kill(target, 'SIGTERM');
        return;
      } catch {
        // Try the next form; an already-gone process is fine.
      }
    }
  }

  async function beginTurn(kind: 'start' | 'send', input: { prompt: string; authority: SessionAuthority; idempotency_key: string }, sessionId: string, workspace: string) {
    if (!CLAUDE_AUTHORITY_MODES[input.authority]) return providerError('unsupported_authority', `No Claude Code mode for ${String(input.authority)}.`);
    const key = claimKey(input.idempotency_key);
    if (!key.claimed) {
      if (key.existing) return providerOk({ provider_turn_id: key.existing.id, provider_session_id: key.existing.session_id });
      return providerError('busy', 'A turn with this idempotency key is starting.');
    }
    const release = () => fs.rmSync(keyFile(input.idempotency_key), { force: true });
    const ready = checkVersion();
    if (!ready.ok) { release(); return providerError(ready.code, ready.message); }
    const launched = await launch(kind, input, sessionId, workspace);
    if (!launched.turn) { release(); return launched.error; }
    fs.writeFileSync(keyFile(input.idempotency_key), launched.turn.id);
    return providerOk({ provider_turn_id: launched.turn.id, provider_session_id: sessionId });
  }

  function inScope(scope: { kind: string; workspaces: string[]; provider_session_ids: string[] }, meta: LocalSessionMeta): boolean {
    if (scope.kind === 'all_provider_sessions') return true;
    if (scope.kind === 'sessions') return scope.provider_session_ids.includes(meta.id);
    return meta.workspace !== null && scope.workspaces.some(root => workspaceWithin(root, meta.workspace as string));
  }

  return {
    kind: CLAUDE_PROVIDER_KIND,
    capabilities: () => ({ ...CAPABILITIES, authorities: [...CAPABILITIES.authorities] }),

    async listSessions(input) {
      const scope = input.scope;
      if (scope.kind === 'workspaces' && scope.workspaces.length === 0) return providerOk({ items: [], next_cursor: null });
      const files = scope.kind === 'sessions'
        ? scope.provider_session_ids.map(id => findSessionFile(configDir, id)).filter((file): file is string => !!file)
          .map(file => ({ id: path.basename(file, '.jsonl'), file, mtime_ms: fs.statSync(file).mtimeMs }))
        : listSessionFiles(configDir, scope.kind === 'workspaces' ? scope.workspaces : null);
      const start = Math.max(0, Number(input.cursor ?? 0) || 0);
      const query = (input.query ?? '').trim().toLowerCase();
      const busy = busySessions();
      const now = Date.now();
      const archiveAfter = cleanupPeriodDays(configDir) * DAY_MS;
      const items: ProviderSessionRecord[] = [];
      // Each page parses a bounded number of files, in scope or not.
      const budget = input.limit * 20;
      let index = start;
      for (; index < files.length && items.length < input.limit && index - start < budget; index++) {
        if (input.signal?.aborted) return providerError('cancelled', 'list aborted');
        const meta = readSessionMeta(files[index]);
        if (!meta || !inScope(scope, meta)) continue;
        if (query && !`${meta.title ?? ''}\n${meta.workspace ?? ''}`.toLowerCase().includes(query)) continue;
        items.push(record(meta, busy, now, archiveAfter));
      }
      return providerOk({ items, next_cursor: index < files.length ? String(index) : null });
    },

    async getSession(input) {
      const file = findSessionFile(configDir, input.provider_session_id);
      if (!file) return providerOk(null);
      const meta = readSessionMeta({ id: input.provider_session_id, file, mtime_ms: fs.statSync(file).mtimeMs });
      return providerOk(meta ? record(meta, busySessions(), Date.now(), cleanupPeriodDays(configDir) * DAY_MS) : null);
    },

    async readTranscript(input) {
      const file = findSessionFile(configDir, input.provider_session_id);
      const entries = file ? readTranscriptEntries(file, input.provider_session_id) : null;
      if (!entries) return providerError('not_found', 'Claude Code has no such session.');
      const start = Math.max(0, Number(input.cursor ?? 0) || 0);
      return providerOk({ items: entries.slice(start, start + input.limit), next_cursor: start + input.limit < entries.length ? String(start + input.limit) : null });
    },

    async startSession(input) {
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(input.workspace); } catch { stat = null; }
      if (!stat?.isDirectory()) return providerError('invalid_input', 'The workspace is not a directory here.');
      return beginTurn('start', input, randomUUID(), input.workspace);
    },

    async sendTurn(input) {
      // Refused before any process: never a fresh session in its place.
      if (!isClaudeSessionId(input.provider_session_id)) return providerError('not_found', 'Not a Claude Code session id.');
      const file = findSessionFile(configDir, input.provider_session_id);
      if (!file) return providerError('not_found', 'Claude Code has no such session.');
      const meta = readSessionMeta({ id: input.provider_session_id, file, mtime_ms: fs.statSync(file).mtimeMs });
      if (!meta || meta.messages === 0 || !meta.workspace) return providerError('not_resumable', 'The session has no conversation to resume.');
      if (busySessions().has(meta.id)) {
        const existing = claimKeyPeek(input.idempotency_key);
        if (existing) return providerOk({ provider_turn_id: existing.id, provider_session_id: existing.session_id });
        return providerError('busy', 'The session is open in a running Claude Code process.');
      }
      return beginTurn('send', input, meta.id, meta.workspace);
    },

    async observeTurn(input) {
      for (;;) {
        const turn = readTurn(input.provider_turn_id);
        if (!turn) return providerError('not_found', 'No such turn.');
        const terminal = terminalOf(turn);
        if (terminal) {
          if (turn.state === 'running') writeTurn({ ...turn, state: 'exited', finished_at: terminal.finished_at });
          return providerOk(terminal);
        }
        if (input.signal?.aborted) return providerError('cancelled', 'observe aborted');
        if (typeof input.deadline_at === 'number' && Date.now() >= input.deadline_at) return providerError('timed_out', 'observe deadline');
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    },

    async cancelTurn(input) {
      const turn = readTurn(input.provider_turn_id);
      if (!turn) return providerError('not_found', 'No such turn.');
      if (terminalOf(turn)) return providerOk('already_terminal');
      stopProcess(turn);
      writeTurn({ ...turn, state: 'cancelled', finished_at: Date.now() });
      return providerOk('cancelled');
    },
  };

  function claimKeyPeek(key: string): TurnRecord | null {
    const id = readText(keyFile(key)).trim();
    return id ? readTurn(id) : null;
  }
}
