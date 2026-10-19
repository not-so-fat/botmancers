// NOT-504: the direct Codex SessionProvider (./session-provider). It talks
// to the installed Codex through its app-server thread/turn protocol
// (./codex-app-server): thread/list, thread/read, thread/items/list (or
// thread/turns/list), thread/start, thread/resume, turn/start,
// turn/interrupt, and the turn/item/tokenUsage notifications. Agent Deck is
// never involved.
//
// Installed-version capabilities are probed at runtime, never assumed: the
// CLI version (`codex --version`), the app-server `initialize` handshake,
// one deliberately ill-typed request per method (an unknown method answers
// "unknown variant", a known one rejects the parameters, nothing runs), and
// `account/read` for sign-in. Failures are structured: `unavailable` (no
// codex binary, the app-server does not start), `unsupported` (no
// thread/list, or an operation this version cannot do), `auth_required`
// (Codex is not signed in).
//
// `codex exec --json` / `codex exec resume --json` is a capability-gated
// fallback for start/resume only when the app-server lacks
// thread/start / thread/resume / turn/start. It reads the same Codex
// thread id from the structured `thread.started` event, so there is one
// identity model; its runs are files beside the database, so they outlive a
// Botmancers restart.
//
// Codex thread and turn ids stay inside the provider handle strings
// (opaque to Botmancers, stored privately in the registry). Terminal UI text
// is never parsed.
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { CodexAppServerClient, isUnknownMethod, spawnStdioTransport, type RpcResult, type RpcTransport } from './codex-app-server';
import { addUsage, execRunFacts, parseCodexJsonl, usageFromBreakdown } from './codex-usage';
import { workspaceContains } from './agent-registration';
import { dbPath } from './home';
import {
  providerError,
  providerOk,
  registerBuiltinSessionProvider,
  type ProviderCallContext,
  type ProviderResult,
  type ProviderSessionRecord,
  type ProviderTurnHandle,
  type ProviderTurnResult,
  type ProviderTurnUsage,
  type SessionAuthority,
  type SessionProvider,
  type SessionProviderCapabilities,
  type TranscriptEntry,
} from './session-provider';

export const CODEX_PROVIDER_KIND = 'codex-direct';
const PAGE_SIZE = 25;
// Interactive and headless threads; sub-agent threads are not sessions.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'];

export const APP_SERVER_METHODS = [
  'thread/list', 'thread/read', 'thread/items/list', 'thread/turns/list',
  'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt',
] as const;
export type AppServerMethod = (typeof APP_SERVER_METHODS)[number];

// Ill-typed parameters for each probed method: the server rejects them
// before doing anything, which proves the method exists.
const PROBE_PARAMS: Record<AppServerMethod, unknown> = {
  'thread/list': { limit: 'probe' },
  'thread/read': { threadId: 0 },
  'thread/items/list': { threadId: 0 },
  'thread/turns/list': { threadId: 0 },
  'thread/start': { cwd: 0 },
  'thread/resume': { threadId: 0 },
  'turn/start': { threadId: 0 },
  'turn/interrupt': { threadId: 0 },
};

export interface CodexProbe {
  status: 'ready' | 'unavailable' | 'unsupported' | 'auth_required';
  cli_version: string | null;
  methods: Record<AppServerMethod, boolean>;
  // Whether the `codex exec` fallback may be selected at all.
  exec_fallback: boolean;
  detail: string;
}

export interface CodexProviderOptions {
  // The codex executable and leading args (default: BOTMANCERS_CODEX_BIN or 'codex').
  command?: string[];
  env?: NodeJS.ProcessEnv;
  // Allow the `codex exec` fallback (default true).
  execFallback?: boolean;
  // Where exec fallback runs are kept (default: beside the database).
  runsDir?: string;
  requestTimeoutMs?: number;
  // Close an idle app-server after this long without live turns.
  idleMs?: number;
  // Test seam: how the app-server transport is opened.
  transport?: (command: string[], env: NodeJS.ProcessEnv) => RpcTransport;
}

type Thread = Record<string, unknown> & { id: string };
type Turn = { id: string; status: string; items?: unknown[]; error?: { message?: string } | null; completedAt?: number | null };

interface Tracker {
  threadId: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'lost';
  output: string | null;
  finalOutput: string | null;
  usage: ProviderTurnUsage | null;
  error: string | null;
  finishedAt: number | null;
  waiters: (() => void)[];
}

const NO_METHODS = Object.fromEntries(APP_SERVER_METHODS.map(m => [m, false])) as Record<AppServerMethod, boolean>;

// ---- handles ----
// 'as' + thread + turn: an app-server turn. 'ex' + thread + run: an exec run.

function encodeTurn(kind: 'as' | 'ex', threadId: string, id: string): string {
  return `codex:${kind}:${threadId}:${id}`;
}

function decodeTurn(handle: string): { kind: 'as' | 'ex'; threadId: string; id: string } | null {
  const parts = handle.split(':');
  if (parts.length !== 4 || parts[0] !== 'codex' || (parts[1] !== 'as' && parts[1] !== 'ex') || !parts[2] || !parts[3]) return null;
  return { kind: parts[1], threadId: parts[2], id: parts[3] };
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ---- mapping ----

const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null);

// The rollout path is the only archived marker thread/read carries; thread/list
// says it directly (its archived filter), which wins.
function archivedByPath(thread: Thread): boolean {
  return typeof thread.path === 'string' && thread.path.split(/[\\/]/).includes('archived_sessions');
}

export function threadRecord(thread: Thread, lifecycle?: 'open' | 'archived'): ProviderSessionRecord {
  const workspace = typeof thread.cwd === 'string' && thread.cwd.startsWith('/') ? thread.cwd : null;
  const status = (thread.status as { type?: string } | undefined)?.type;
  const name = typeof thread.name === 'string' && thread.name.trim() ? thread.name : null;
  const preview = typeof thread.preview === 'string' && thread.preview.trim() ? thread.preview : null;
  return {
    provider_session_id: thread.id,
    title: name ?? preview,
    workspace,
    created_at: seconds(thread.createdAt),
    updated_at: seconds(thread.updatedAt),
    lifecycle: lifecycle ?? (archivedByPath(thread) ? 'archived' : 'open'),
    // Codex resumes any persisted thread whose workspace still exists; a
    // moved or deleted workspace is reported, not guessed around.
    resumable: thread.ephemeral !== true && status !== 'systemError' && workspace !== null && fs.existsSync(workspace),
    busy: status === 'active',
  };
}

function userText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('').trim();
}

function transcriptEntry(item: Record<string, unknown>, seq: number, at: number | null): TranscriptEntry | null {
  if (item.type === 'userMessage') return { seq, role: 'user', text: userText(item), at };
  if (item.type === 'agentMessage' && typeof item.text === 'string') return { seq, role: 'assistant', text: item.text, at };
  if (item.type === 'commandExecution' && typeof item.command === 'string') return { seq, role: 'tool', text: `$ ${item.command}`, at };
  return null;
}

function finalAnswer(items: unknown[] | undefined): string | null {
  let last: string | null = null;
  let final: string | null = null;
  for (const raw of items ?? []) {
    const item = raw as Record<string, unknown>;
    if (item?.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text) continue;
    last = item.text;
    if (item.phase === 'final_answer') final = item.text;
  }
  return final ?? last;
}

function sandboxMode(authority: SessionAuthority): 'read-only' | 'workspace-write' {
  return authority === 'workspace_write' ? 'workspace-write' : 'read-only';
}

function sandboxPolicy(authority: SessionAuthority, cwd: string): Record<string, unknown> {
  return authority === 'workspace_write'
    ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : { type: 'readOnly', networkAccess: false };
}

function isMissing(result: RpcResult<unknown>): boolean {
  return !result.ok && result.kind === 'rpc' && /thread not (found|loaded)|no rollout|invalid thread id|not found/i.test(result.error.message);
}

function rpcFailure(result: Extract<RpcResult<unknown>, { ok: false }>, op: string): { ok: false; error: { code: 'unavailable' | 'timed_out' | 'cancelled' | 'invalid_input'; message: string } } {
  if (result.kind === 'timeout') return providerError('timed_out', `${op} timed out`) as never;
  if (result.kind === 'aborted') return providerError('cancelled', `${op} aborted`) as never;
  if (result.kind === 'closed') return providerError('unavailable', `${op}: app-server closed`) as never;
  return providerError('invalid_input', `${op} refused (${result.error.code})`) as never;
}

// ---- runtime: one app-server per provider configuration ----

export class CodexRuntime {
  private client: CodexAppServerClient | null = null;
  private connecting: Promise<CodexProbe> | null = null;
  probe: CodexProbe | null = null;
  private readonly trackers = new Map<string, Tracker>();
  private readonly keys = new Map<string, ProviderTurnHandle>();
  private idleTimer: NodeJS.Timeout | null = null;
  readonly command: string[];
  readonly env: NodeJS.ProcessEnv;

  constructor(readonly options: CodexProviderOptions = {}) {
    this.command = options.command ?? [process.env.BOTMANCERS_CODEX_BIN || 'codex'];
    this.env = options.env ?? process.env;
  }

  get runsDir(): string {
    return this.options.runsDir ?? path.join(path.dirname(path.resolve(dbPath(this.env))), 'codex-exec-runs');
  }

  capabilities(): SessionProviderCapabilities {
    const probe = this.probe?.status === 'ready' ? this.probe : null;
    const m = probe?.methods ?? NO_METHODS;
    const fallback = !!probe?.exec_fallback;
    const startAs = m['thread/start'] && m['turn/start'];
    const resumeAs = m['thread/resume'] && m['turn/start'];
    return {
      list: m['thread/list'],
      search: m['thread/list'],
      read: m['thread/items/list'] || m['thread/turns/list'],
      resume: resumeAs || (fallback && m['thread/read']),
      start: startAs || fallback,
      cancel: m['turn/interrupt'] || (fallback && (!startAs || !resumeAs)),
      usage: !!probe,
      authorities: probe ? ['read_only', 'workspace_write'] : [],
      max_page_size: PAGE_SIZE,
    };
  }

  // Which mechanism start/resume uses on this installed version.
  selection(): { start: 'app-server' | 'exec' | null; resume: 'app-server' | 'exec' | null } {
    const caps = this.capabilities();
    const m = this.probe?.methods ?? NO_METHODS;
    return {
      start: !caps.start ? null : m['thread/start'] && m['turn/start'] ? 'app-server' : 'exec',
      resume: !caps.resume ? null : m['thread/resume'] && m['turn/start'] ? 'app-server' : 'exec',
    };
  }

  async ready(): Promise<ProviderResult<void>> {
    const probe = await this.connect();
    if (probe.status === 'ready') return providerOk(undefined);
    const code = probe.status === 'auth_required' ? 'auth_required' : probe.status === 'unsupported' ? 'unsupported' : 'unavailable';
    return providerError(code, probe.detail);
  }

  async connect(): Promise<CodexProbe> {
    if (this.client && !this.client.closed && this.probe?.status === 'ready') return this.probe;
    if (!this.connecting) this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private cliVersion(): Promise<string | null> {
    return new Promise(resolve => {
      execFile(this.command[0], [...this.command.slice(1), '--version'], { env: this.env, timeout: 10_000 }, (error, stdout) => {
        if (error) return resolve(null);
        const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(String(stdout));
        resolve(match ? match[1] : null);
      });
    });
  }

  private async doConnect(): Promise<CodexProbe> {
    const version = await this.cliVersion();
    const fail = (status: CodexProbe['status'], detail: string): CodexProbe => {
      this.probe = { status, cli_version: version, methods: { ...NO_METHODS }, exec_fallback: false, detail };
      return this.probe;
    };
    this.client?.close();
    this.client = null;
    const open = this.options.transport ?? ((command, env) => spawnStdioTransport([...command, 'app-server'], { env }));
    const client = new CodexAppServerClient(open(this.command, this.env), this.options.requestTimeoutMs ?? 30_000);
    const init = await client.request<{ userAgent?: string }>('initialize', {
      clientInfo: { name: 'botmancers', title: 'Botmancers', version: '1' }, capabilities: null,
    }, { timeoutMs: 20_000 });
    if (!init.ok) {
      client.close();
      if (version === null) return fail('unavailable', `codex is not installed or did not start (${init.error.message})`);
      return fail(init.kind === 'rpc' ? 'unsupported' : 'unavailable', `codex ${version}: app-server initialize failed (${init.error.message})`);
    }
    client.notify('initialized');
    const answers = await Promise.all(APP_SERVER_METHODS.map(method => client.request(method, PROBE_PARAMS[method], { timeoutMs: 10_000 })));
    const methods = { ...NO_METHODS };
    APP_SERVER_METHODS.forEach((method, i) => {
      const answer = answers[i];
      methods[method] = answer.ok || (answer.kind === 'rpc' && !isUnknownMethod(answer.error, method));
    });
    if (!methods['thread/list']) {
      client.close();
      return fail('unsupported', `codex ${version ?? 'unknown'}: app-server has no thread/list`);
    }
    const account = await client.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>('account/read', {}, { timeoutMs: 10_000 });
    if (account.ok && account.result && account.result.account == null && account.result.requiresOpenaiAuth === true) {
      client.close();
      return fail('auth_required', 'codex is not signed in');
    }
    this.attach(client);
    this.probe = {
      status: 'ready', cli_version: version, methods,
      exec_fallback: this.options.execFallback !== false && version !== null,
      detail: `codex ${version ?? 'unknown'} app-server`,
    };
    return this.probe;
  }

  private attach(client: CodexAppServerClient): void {
    this.client = client;
    client.handleServerRequests(method => {
      // Authority is fixed per turn (approvalPolicy 'never'); anything that
      // would widen it is declined, never approved.
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { result: { decision: 'decline' } };
      if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { result: { decision: { denied: { rejection: 'Botmancers turns run with a fixed authority.' } } } };
      return { error: { code: -32601, message: 'not supported by Botmancers' } };
    });
    client.onNotification(({ method, params }) => {
      const turnId = typeof params.turnId === 'string' ? params.turnId
        : params.turn && typeof (params.turn as Turn).id === 'string' ? (params.turn as Turn).id : null;
      if (!turnId || typeof params.threadId !== 'string') return;
      const tracker = this.tracker(turnId, params.threadId);
      if (method === 'item/completed') {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
          tracker.output = item.text;
          if (item.phase === 'final_answer') tracker.finalOutput = item.text;
        }
      } else if (method === 'thread/tokenUsage/updated') {
        tracker.usage = addUsage(tracker.usage, usageFromBreakdown((params.tokenUsage as { last?: unknown } | undefined)?.last));
      } else if (method === 'turn/completed') {
        const turn = params.turn as Turn;
        this.settle(tracker, turn);
      }
    });
    client.onClose(() => {
      for (const tracker of this.trackers.values()) {
        if (tracker.status !== 'inProgress') continue;
        tracker.status = 'lost';
        tracker.error = 'the Codex app-server exited during the turn';
        tracker.finishedAt = Date.now();
        tracker.waiters.splice(0).forEach(wake => wake());
      }
    });
  }

  private tracker(turnId: string, threadId: string): Tracker {
    let tracker = this.trackers.get(turnId);
    if (!tracker) {
      tracker = { threadId, status: 'inProgress', output: null, finalOutput: null, usage: null, error: null, finishedAt: null, waiters: [] };
      this.trackers.set(turnId, tracker);
    }
    return tracker;
  }

  private settle(tracker: Tracker, turn: Turn): void {
    if (turn.status === 'inProgress' || tracker.status !== 'inProgress') return;
    tracker.status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
    tracker.output = tracker.finalOutput ?? tracker.output ?? finalAnswer(turn.items);
    tracker.error = turn.error?.message ?? (tracker.status === 'failed' ? 'codex turn failed' : null);
    tracker.finishedAt = seconds(turn.completedAt) ?? Date.now();
    tracker.waiters.splice(0).forEach(wake => wake());
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    this.idleTimer = setTimeout(() => {
      if ([...this.trackers.values()].some(t => t.status === 'inProgress')) return this.scheduleIdle();
      this.client?.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  async rpc<T>(method: string, params: unknown, ctx: Readonly<ProviderCallContext>): Promise<RpcResult<T>> {
    const probe = await this.connect();
    if (probe.status !== 'ready' || !this.client) return { ok: false, kind: 'closed', error: { code: -1, message: probe.detail } };
    this.scheduleIdle();
    return this.client.request<T>(method, params, { signal: ctx.signal ?? null });
  }

  has(method: AppServerMethod): boolean {
    return !!this.probe?.methods[method];
  }

  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.client?.close();
    this.client = null;
    this.probe = null;
  }

  // ---- sessions ----

  async listSessions(input: Parameters<SessionProvider['listSessions']>[0]): ReturnType<SessionProvider['listSessions']> {
    const cursor = decodeCursor(input.cursor);
    if (input.scope.kind === 'sessions') {
      const start = Number(cursor?.i ?? 0);
      const ids = input.scope.provider_session_ids.slice(start, start + input.limit);
      const items: ProviderSessionRecord[] = [];
      for (const id of ids) {
        const record = await this.getSession({ ...input, provider_session_id: id });
        if (!record.ok) return record;
        if (record.value) items.push(record.value);
      }
      const next = start + input.limit < input.scope.provider_session_ids.length ? encodeCursor({ i: start + input.limit }) : null;
      return providerOk({ items, next_cursor: next });
    }
    const phase = cursor?.phase === 'archived' ? 'archived' : 'open';
    const listed = await this.rpc<{ data?: Thread[]; nextCursor?: string | null }>('thread/list', {
      limit: input.limit,
      cursor: typeof cursor?.c === 'string' ? cursor.c : null,
      archived: phase === 'archived',
      sourceKinds: SOURCE_KINDS,
      sortKey: 'updated_at',
      ...(input.query ? { searchTerm: input.query } : {}),
    }, input);
    if (!listed.ok) return rpcFailure(listed, 'thread/list');
    const threads = Array.isArray(listed.result?.data) ? listed.result.data : [];
    // Codex's cwd filter is exact; a workspace scope also admits subdirectories,
    // so the scope is applied here (and again by Botmancers).
    const inScope = (record: ProviderSessionRecord) => input.scope.kind === 'all_provider_sessions'
      || (record.workspace !== null && input.scope.workspaces.some(root => workspaceContains(root, record.workspace as string)));
    const items = threads
      .filter(thread => thread && typeof thread.id === 'string' && thread.ephemeral !== true && !thread.parentThreadId)
      .map(thread => threadRecord(thread, phase))
      .filter(inScope);
    const nextCodex = listed.result?.nextCursor ?? null;
    const next = nextCodex ? encodeCursor({ phase, c: nextCodex }) : phase === 'open' ? encodeCursor({ phase: 'archived' }) : null;
    return providerOk({ items, next_cursor: next });
  }

  async getSession(input: Readonly<ProviderCallContext & { provider_session_id: string }>): Promise<ProviderResult<ProviderSessionRecord | null>> {
    const read = await this.rpc<{ thread?: Thread }>('thread/read', { threadId: input.provider_session_id }, input);
    if (!read.ok) return isMissing(read) ? providerOk(null) : rpcFailure(read, 'thread/read');
    const thread = read.result?.thread;
    return providerOk(thread && typeof thread.id === 'string' ? threadRecord(thread) : null);
  }

  async readTranscript(input: Parameters<SessionProvider['readTranscript']>[0]): ReturnType<SessionProvider['readTranscript']> {
    const cursor = decodeCursor(input.cursor) ?? {};
    const offset = Number(cursor.n ?? 0);
    const threadId = input.provider_session_id;
    if (cursor.mode !== 'turns' && this.has('thread/items/list')) {
      const page = await this.rpc<{ data?: { item: Record<string, unknown>; startedAtMs?: number | null; completedAtMs?: number | null }[]; nextCursor?: string | null }>(
        'thread/items/list', { threadId, cursor: typeof cursor.c === 'string' ? cursor.c : null, limit: input.limit, sortDirection: 'asc' }, input);
      if (page.ok) {
        const data = (page.result?.data ?? []).slice(0, input.limit);
        const items = data
          .map((entry, i) => transcriptEntry(entry.item ?? {}, offset + i + 1, entry.completedAtMs ?? entry.startedAtMs ?? null))
          .filter((entry): entry is TranscriptEntry => entry !== null);
        const next = page.result?.nextCursor ? encodeCursor({ c: page.result.nextCursor, n: offset + data.length }) : null;
        return providerOk({ items, next_cursor: next });
      }
      if (isMissing(page)) return providerError('not_found', 'no such thread');
      // A thread whose history is not paginated answers -32601; read it by turns.
      if (!(page.kind === 'rpc' && page.error.code === -32601)) return rpcFailure(page, 'thread/items/list');
    }
    if (!this.has('thread/turns/list')) return providerError('unsupported', 'no transcript method');
    // One turn per request; a long turn is split across pages with `skip`.
    const turnCursor = typeof cursor.c === 'string' ? cursor.c : null;
    const skip = Number(cursor.skip ?? 0);
    const page = await this.rpc<{ data?: Turn[]; nextCursor?: string | null }>(
      'thread/turns/list', { threadId, cursor: turnCursor, limit: 1, sortDirection: 'asc', itemsView: 'full' }, input);
    if (!page.ok) return isMissing(page) ? providerError('not_found', 'no such thread') : rpcFailure(page, 'thread/turns/list');
    const turn = (page.result?.data ?? [])[0];
    if (!turn) return providerOk({ items: [], next_cursor: null });
    const all = Array.isArray(turn.items) ? turn.items : [];
    const slice = all.slice(skip, skip + input.limit);
    const items = slice
      .map((item, i) => transcriptEntry(item as Record<string, unknown>, offset + i + 1, null))
      .filter((entry): entry is TranscriptEntry => entry !== null);
    const n = offset + slice.length;
    const next = skip + input.limit < all.length ? encodeCursor({ mode: 'turns', c: turnCursor, skip: skip + input.limit, n })
      : page.result?.nextCursor ? encodeCursor({ mode: 'turns', c: page.result.nextCursor, skip: 0, n }) : null;
    return providerOk({ items, next_cursor: next });
  }

  // ---- turns (app-server) ----

  private turnInput(prompt: string) {
    return [{ type: 'text', text: prompt, text_elements: [] }];
  }

  private async beginTurn(threadId: string, cwd: string, input: { prompt: string; authority: SessionAuthority; idempotency_key: string } & ProviderCallContext): Promise<ProviderResult<ProviderTurnHandle>> {
    const started = await this.rpc<{ turn?: Turn }>('turn/start', {
      threadId,
      input: this.turnInput(input.prompt),
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: sandboxPolicy(input.authority, cwd),
      clientUserMessageId: input.idempotency_key,
    }, input);
    if (!started.ok) return isMissing(started) ? providerError('not_found', 'no such thread') : rpcFailure(started, 'turn/start');
    const turn = started.result?.turn;
    if (!turn || typeof turn.id !== 'string') return providerError('unavailable', 'turn/start returned no turn');
    const tracker = this.tracker(turn.id, threadId);
    this.settle(tracker, turn);
    const handle = { provider_turn_id: encodeTurn('as', threadId, turn.id), provider_session_id: threadId };
    this.keys.set(input.idempotency_key, handle);
    return providerOk(handle);
  }

  async startSession(input: Parameters<SessionProvider['startSession']>[0]): Promise<ProviderResult<ProviderTurnHandle>> {
    const known = this.keys.get(input.idempotency_key) ?? this.execRunByKey(input.idempotency_key);
    if (known) return providerOk(known);
    const route = this.selection().start;
    if (route === null) return providerError('unsupported', 'this Codex cannot start sessions');
    if (route === 'exec') return this.execStart(null, input.workspace, input);
    const thread = await this.rpc<{ thread?: Thread }>('thread/start', {
      cwd: input.workspace, approvalPolicy: 'never', sandbox: sandboxMode(input.authority), ephemeral: false,
    }, input);
    if (!thread.ok) return rpcFailure(thread, 'thread/start');
    const threadId = thread.result?.thread?.id;
    if (typeof threadId !== 'string') return providerError('unavailable', 'thread/start returned no thread');
    return this.beginTurn(threadId, input.workspace, input);
  }

  // A turn already started with this key on the thread (after a restart,
  // before Botmancers recorded it): Codex keeps the key as the user
  // message's clientId.
  private async findKeyedTurn(threadId: string, key: string, ctx: ProviderCallContext): Promise<string | null> {
    if (!this.has('thread/turns/list')) return null;
    const page = await this.rpc<{ data?: Turn[] }>('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' }, ctx);
    if (!page.ok) return null;
    for (const turn of page.result?.data ?? []) {
      if ((turn.items ?? []).some(item => (item as Record<string, unknown>)?.type === 'userMessage' && (item as Record<string, unknown>).clientId === key)) return turn.id;
    }
    return null;
  }

  async sendTurn(input: Parameters<SessionProvider['sendTurn']>[0]): Promise<ProviderResult<ProviderTurnHandle>> {
    const known = this.keys.get(input.idempotency_key) ?? this.execRunByKey(input.idempotency_key);
    if (known) return providerOk(known);
    const threadId = input.provider_session_id;
    const route = this.selection().resume;
    if (route === null) return providerError('unsupported', 'this Codex cannot resume sessions');
    if (route === 'exec') {
      const record = await this.getSession(input);
      if (!record.ok) return record;
      if (!record.value) return providerError('not_found', 'no such thread');
      if (!record.value.resumable || !record.value.workspace) return providerError('not_resumable', 'the thread cannot be resumed');
      return this.execStart(threadId, record.value.workspace, input);
    }
    const resumed = await this.rpc<{ thread?: Thread; cwd?: string }>('thread/resume', {
      threadId, approvalPolicy: 'never', sandbox: sandboxMode(input.authority), excludeTurns: true,
    }, input);
    if (!resumed.ok) return isMissing(resumed) ? providerError('not_found', 'no such thread') : rpcFailure(resumed, 'thread/resume');
    const cwd = typeof resumed.result?.cwd === 'string' ? resumed.result.cwd : (resumed.result?.thread?.cwd as string | undefined);
    if (!cwd || !fs.existsSync(cwd)) return providerError('not_resumable', 'the thread workspace no longer exists');
    const prior = await this.findKeyedTurn(threadId, input.idempotency_key, input);
    if (prior) {
      const handle = { provider_turn_id: encodeTurn('as', threadId, prior), provider_session_id: threadId };
      this.keys.set(input.idempotency_key, handle);
      return providerOk(handle);
    }
    // turn/start on an active thread would steer its running turn instead.
    if ((resumed.result?.thread?.status as { type?: string } | undefined)?.type === 'active') return providerError('busy', 'the thread has a turn in flight');
    return this.beginTurn(threadId, cwd, input);
  }

  private result(tracker: Tracker): ProviderTurnResult {
    const status = tracker.status === 'completed' ? 'completed' : tracker.status === 'interrupted' ? 'cancelled' : 'failed';
    return {
      status,
      provider_session_id: tracker.threadId,
      output: tracker.output,
      failure: status === 'completed' ? null
        : status === 'cancelled' ? { code: 'cancelled', message: 'interrupted' }
          : { code: tracker.status === 'lost' ? 'interrupted' : 'codex_turn_failed', message: tracker.error ?? 'codex turn failed' },
      usage: tracker.usage,
      finished_at: tracker.finishedAt ?? Date.now(),
    };
  }

  // The turn's state from Codex history, for a turn this process did not
  // start (a Botmancers restart). Returns the tracker it rebuilt.
  private async recover(threadId: string, turnId: string, ctx: ProviderCallContext): Promise<ProviderResult<Tracker>> {
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const page: RpcResult<{ data?: Turn[]; nextCursor?: string | null }> = await this.rpc<{ data?: Turn[]; nextCursor?: string | null }>(
        'thread/turns/list', { threadId, cursor, limit: 10, sortDirection: 'desc', itemsView: 'full' }, ctx);
      if (!page.ok) return isMissing(page) ? providerError('not_found', 'no such thread') : rpcFailure(page, 'thread/turns/list');
      const turn = (page.result?.data ?? []).find(t => t.id === turnId);
      if (turn) {
        const tracker = this.tracker(turnId, threadId);
        if (turn.status !== 'inProgress') {
          this.settle(tracker, turn);
          return providerOk(tracker);
        }
        // In progress in history: live only if this app-server runs it.
        const read = await this.rpc<{ thread?: Thread }>('thread/read', { threadId }, ctx);
        const live = read.ok && (read.result?.thread?.status as { type?: string } | undefined)?.type === 'active';
        if (live) {
          await this.rpc('thread/resume', { threadId, excludeTurns: true }, ctx);
          return providerOk(tracker);
        }
        tracker.status = 'lost';
        tracker.output = finalAnswer(turn.items);
        tracker.error = 'the turn ended without a result (its Codex app-server exited)';
        tracker.finishedAt = Date.now();
        return providerOk(tracker);
      }
      cursor = page.result?.nextCursor ?? null;
      if (!cursor) break;
    }
    return providerError('not_found', 'no such turn');
  }

  private async liveTracker(threadId: string, turnId: string, ctx: ProviderCallContext): Promise<ProviderResult<Tracker>> {
    const known = this.trackers.get(turnId);
    if (known && (known.status !== 'inProgress' || (this.client && !this.client.closed))) return providerOk(known);
    if (!this.has('thread/turns/list')) {
      await this.connect();
      if (!this.has('thread/turns/list')) return providerError('unsupported', 'cannot read turn history');
    }
    return this.recover(threadId, turnId, ctx);
  }

  async observeTurn(input: Parameters<SessionProvider['observeTurn']>[0]): Promise<ProviderResult<ProviderTurnResult>> {
    const handle = decodeTurn(input.provider_turn_id);
    if (!handle) return providerError('not_found', 'unknown turn handle');
    if (handle.kind === 'ex') return this.execObserve(handle.threadId, handle.id, input);
    const found = await this.liveTracker(handle.threadId, handle.id, input);
    if (!found.ok) return found;
    const tracker = found.value;
    while (tracker.status === 'inProgress') {
      const outcome = await new Promise<'done' | 'aborted' | 'deadline'>(resolve => {
        const wake = () => finish('done');
        const onAbort = () => finish('aborted');
        const ms = typeof input.deadline_at === 'number' ? Math.max(0, input.deadline_at - Date.now()) : null;
        const timer = ms === null ? null : setTimeout(() => finish('deadline'), ms);
        function finish(value: 'done' | 'aborted' | 'deadline') {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener('abort', onAbort);
          const i = tracker.waiters.indexOf(wake);
          if (i >= 0) tracker.waiters.splice(i, 1);
          resolve(value);
        }
        if (input.signal?.aborted) return finish('aborted');
        tracker.waiters.push(wake);
        input.signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (outcome === 'aborted') return providerError('cancelled', 'observe aborted');
      if (outcome === 'deadline') return providerError('timed_out', 'observe deadline');
    }
    return providerOk(this.result(tracker));
  }

  async cancelTurn(input: Parameters<SessionProvider['cancelTurn']>[0]): ReturnType<SessionProvider['cancelTurn']> {
    const handle = decodeTurn(input.provider_turn_id);
    if (!handle) return providerError('not_found', 'unknown turn handle');
    if (handle.kind === 'ex') return this.execCancel(handle.id);
    const found = await this.liveTracker(handle.threadId, handle.id, input);
    if (!found.ok) return found;
    const tracker = found.value;
    if (tracker.status !== 'inProgress') return providerOk('already_terminal');
    if (!this.has('turn/interrupt')) return providerError('unsupported', 'this Codex cannot interrupt turns');
    const interrupted = await this.rpc('turn/interrupt', { threadId: handle.threadId, turnId: handle.id }, input);
    if (!interrupted.ok) {
      if (tracker.status !== 'inProgress') return providerOk('already_terminal');
      return rpcFailure(interrupted, 'turn/interrupt');
    }
    // Wait briefly for Codex's own terminal notification.
    const deadline = Date.now() + 10_000;
    while (tracker.status === 'inProgress' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (tracker.status === 'inProgress' || tracker.status === 'interrupted') {
      tracker.status = 'interrupted';
      tracker.finishedAt = tracker.finishedAt ?? Date.now();
      tracker.waiters.splice(0).forEach(wake => wake());
      return providerOk('cancelled');
    }
    return providerOk('already_terminal');
  }

  // ---- exec fallback ----

  private runPath(runId: string, ext: 'json' | 'jsonl'): string {
    return path.join(this.runsDir, `${runId.replace(/[^A-Za-z0-9-]/g, '')}.${ext}`);
  }

  private readMeta(runId: string): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(this.runPath(runId, 'json'), 'utf8'));
    } catch {
      return null;
    }
  }

  private execRunByKey(key: string): ProviderTurnHandle | null {
    if (!fs.existsSync(this.runsDir)) return null;
    for (const name of fs.readdirSync(this.runsDir)) {
      if (!name.endsWith('.json')) continue;
      const meta = this.readMeta(name.slice(0, -5));
      if (meta?.key === key && typeof meta.thread_id === 'string') {
        return { provider_turn_id: encodeTurn('ex', meta.thread_id, String(meta.run_id)), provider_session_id: meta.thread_id };
      }
    }
    return null;
  }

  private async execStart(threadId: string | null, cwd: string, input: { prompt: string; authority: SessionAuthority; idempotency_key: string } & ProviderCallContext): Promise<ProviderResult<ProviderTurnHandle>> {
    fs.mkdirSync(this.runsDir, { recursive: true });
    const runId = randomUUID();
    const config = ['-c', `sandbox_mode="${sandboxMode(input.authority)}"`, '-c', 'approval_policy="never"'];
    const args = threadId
      ? [...this.command.slice(1), 'exec', 'resume', '--json', ...config, threadId, '-']
      : [...this.command.slice(1), 'exec', '--json', '-C', cwd, ...config, '-'];
    const out = fs.openSync(this.runPath(runId, 'jsonl'), 'a');
    let child;
    try {
      child = spawn(this.command[0], args, { cwd, env: this.env, detached: true, stdio: ['pipe', out, 'ignore'] });
    } catch (error) {
      fs.closeSync(out);
      return providerError('unavailable', `codex exec did not start: ${(error as Error).message}`);
    }
    fs.closeSync(out);
    const spawnError = new Promise<string>(resolve => child.once('error', error => resolve(error.message)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input.prompt);
    const meta = {
      run_id: runId, pid: child.pid ?? null, thread_id: threadId, key: input.idempotency_key, authority: input.authority, cwd,
      correlation: input.correlation ?? {}, cancelled: false, started_at: Date.now(),
    };
    fs.writeFileSync(this.runPath(runId, 'json'), JSON.stringify(meta));
    child.unref();
    if (!threadId) {
      // A new thread's id comes from its structured thread.started event.
      const deadline = Date.now() + 30_000;
      let failed: string | null = null;
      void spawnError.then(message => { failed = message; });
      for (;;) {
        const facts = execRunFacts(parseCodexJsonl(this.readLog(runId)));
        if (facts.thread_id) {
          meta.thread_id = facts.thread_id;
          fs.writeFileSync(this.runPath(runId, 'json'), JSON.stringify(meta));
          break;
        }
        if (failed || facts.terminal || Date.now() > deadline || (meta.pid && !alive(meta.pid))) {
          return providerError('unavailable', `codex exec reported no thread${failed ? `: ${failed}` : ''}`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return providerOk({ provider_turn_id: encodeTurn('ex', meta.thread_id as string, runId), provider_session_id: meta.thread_id as string });
  }

  private readLog(runId: string): string {
    try {
      return fs.readFileSync(this.runPath(runId, 'jsonl'), 'utf8');
    } catch {
      return '';
    }
  }

  private execResult(threadId: string, runId: string): ProviderTurnResult | null {
    const meta = this.readMeta(runId);
    if (!meta) return null;
    const facts = execRunFacts(parseCodexJsonl(this.readLog(runId)));
    const running = typeof meta.pid === 'number' && alive(meta.pid);
    if (!facts.terminal && running && !meta.cancelled) return null;
    const status = meta.cancelled && facts.terminal !== 'completed' ? 'cancelled' : facts.terminal === 'completed' ? 'completed' : 'failed';
    return {
      status,
      provider_session_id: threadId,
      output: facts.output,
      failure: status === 'completed' ? null : status === 'cancelled' ? { code: 'cancelled', message: 'interrupted' }
        : { code: facts.terminal ? 'codex_turn_failed' : 'interrupted', message: facts.error ?? 'codex exec ended without a result' },
      usage: facts.usage,
      finished_at: Number(meta.finished_at ?? Date.now()),
    };
  }

  private async execObserve(threadId: string, runId: string, input: ProviderCallContext): Promise<ProviderResult<ProviderTurnResult>> {
    if (!this.readMeta(runId)) return providerError('not_found', 'no such run');
    for (;;) {
      const result = this.execResult(threadId, runId);
      if (result) return providerOk(result);
      if (input.signal?.aborted) return providerError('cancelled', 'observe aborted');
      if (typeof input.deadline_at === 'number' && Date.now() >= input.deadline_at) return providerError('timed_out', 'observe deadline');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  private execCancel(runId: string): ProviderResult<'cancelled' | 'already_terminal'> {
    const meta = this.readMeta(runId);
    if (!meta) return providerError('not_found', 'no such run');
    const facts = execRunFacts(parseCodexJsonl(this.readLog(runId)));
    if (meta.cancelled || facts.terminal || typeof meta.pid !== 'number' || !alive(meta.pid)) return providerOk('already_terminal');
    try {
      process.kill(meta.pid, 'SIGINT');
    } catch {
      return providerOk('already_terminal');
    }
    fs.writeFileSync(this.runPath(runId, 'json'), JSON.stringify({ ...meta, cancelled: true, finished_at: Date.now() }));
    return providerOk('cancelled');
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- provider ----

export function createCodexSessionProvider(runtime: CodexRuntime): SessionProvider {
  return {
    kind: CODEX_PROVIDER_KIND,
    capabilities: () => runtime.capabilities(),
    ready: () => runtime.ready(),
    listSessions: input => runtime.listSessions(input),
    getSession: input => runtime.getSession(input),
    readTranscript: input => runtime.readTranscript(input),
    startSession: input => runtime.startSession(input),
    sendTurn: input => runtime.sendTurn(input),
    observeTurn: input => runtime.observeTurn(input),
    cancelTurn: input => runtime.cancelTurn(input),
  };
}

// One runtime (one app-server) per process for the default provider, shared
// by every 'codex' runtime connection on this computer.
let defaultRuntime: CodexRuntime | null = null;

export function defaultCodexRuntime(): CodexRuntime {
  if (!defaultRuntime) defaultRuntime = new CodexRuntime();
  return defaultRuntime;
}

export function shutdownDefaultCodexRuntime(): void {
  defaultRuntime?.shutdown();
  defaultRuntime = null;
}

if (process.env.BOTMANCERS_CODEX_PROVIDER !== 'off') {
  registerBuiltinSessionProvider('codex', () => createCodexSessionProvider(defaultCodexRuntime()));
}
