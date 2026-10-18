// NOT-508: a direct Muse Code SessionProvider (./session-provider) over the
// stable Muse Session Protocol (MSP v1, `muse serve` on stdio). It is a
// lower-priority runtime behind the common boundary: Botmancers still owns
// scope, authority, idempotency, audit, and the registry
// (./provider-sessions), and Agent Deck is never consulted.
//
// Wire operations (all stable MSP v1, verified against Muse 1.4.10):
//   initialize / initialized      capability + version probe
//   session/list                  bounded discovery (cursor, limit, filter)
//   session/read                  metadata, history, lastTurn (never attaches)
//   session/start + turn/start    a new session in an explicit workspace
//   session/resume + turn/start   a turn on the exact existing session
//   turn/completed, session/tokenUsage   observation (notifications)
//   turn/cancel                   cancellation
// Nothing else is sent: no undocumented UI state, no experimental surface.
//
// Authority is enforced by the host, not the wire: `muse serve` fixes its
// sandbox posture at startup, so the provider runs one host per authority
// (read_only adds --disable-write --disable-shell). Sessions are durable on
// disk under the Muse home, so a Botmancers restart reattaches by reading
// the session; a turn that was running in a host that died with Botmancers
// is reported failed (host_lost), never silently replaced.
//
// Muse session and turn ids are opaque provider ids: Botmancers stores them
// privately. The provider turn id is `<sessionId>:<turnId>` so a turn can be
// observed or cancelled from its id alone after a restart.
//
// Usage: MSP reports per-turn token counters (turn/completed.usage, or the
// turn's session/tokenUsage records). It reports no per-turn cost (only a
// session-level estimate that may move either way), so cost stays unknown.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import os from 'os';
import {
  providerError,
  providerOk,
  registerSessionProvider,
  type ProviderError,
  type ProviderResult,
  type ProviderSessionRecord,
  type ProviderTurnResult,
  type SessionAuthority,
  type SessionProvider,
  type SessionProviderCapabilities,
  type TranscriptEntry,
} from './session-provider';

export const MUSE_PROVIDER_KIND = 'muse-msp';
// The oldest Muse build whose stable MSP surface this provider was verified on.
export const MIN_MUSE_VERSION = '1.4.0';
export const MSP_SCHEMA_VERSION = 1;
export const MUSE_CLIENT_INFO = { name: 'botmancers', version: '1' } as const;
// Headless turns never prompt: unmatched approvals are denied.
export const MUSE_APPROVAL_MODE = 'denyUnmatched';
export const MUSE_MAX_PAGE = 50;
const MSP_LIST_MAX = 200;

export const MUSE_DECLARED_CAPABILITIES: SessionProviderCapabilities = {
  list: true, search: true, read: true, resume: true, start: true, cancel: true, usage: true,
  authorities: ['read_only', 'workspace_write'], max_page_size: MUSE_MAX_PAGE,
};
const NO_CAPABILITIES: SessionProviderCapabilities = {
  list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: MUSE_MAX_PAGE,
};

// ---- normalization (pure; exported for fixtures) ----

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// One MSP Session object as a provider record, or null when it is malformed
// or not a user-facing root session (subagent children are skipped).
// MSP v1 has no archive state, so lifecycle is always 'open'; resumable means
// the host persists the session (durable host, non-empty log path).
export function museSessionRecord(raw: unknown, durability: string | null = 'durable'): ProviderSessionRecord | null {
  const s = asRecord(raw);
  const id = asString(s?.sessionId);
  if (!s || !id) return null;
  if (s.kind === 'subagent') return null;
  const workspace = asString(s.workspaceRoot);
  const status = asString(s.status);
  return {
    provider_session_id: id,
    title: asString(s.title) ?? asString(s.firstUserPrompt) ?? asString(s.name),
    workspace: workspace && workspace.startsWith('/') ? workspace : null,
    created_at: asTime(s.createdAt),
    updated_at: asTime(s.lastActivityAt) ?? asTime(s.updatedAt),
    lifecycle: 'open',
    resumable: durability === 'durable' && typeof s.path === 'string' && s.path.length > 0,
    busy: status === 'running' || asString(s.activeTurnId) !== null,
  };
}

// Folds MSP history items into transcript entries: user and agent messages
// only, retracted items dropped, in history order.
export function museTranscript(items: unknown): TranscriptEntry[] {
  if (!Array.isArray(items)) return [];
  const out: TranscriptEntry[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item || item.retracted === true) continue;
    const role = item.kind === 'userMessage' ? 'user' : item.kind === 'agentMessage' ? 'assistant' : null;
    const text = asString(item.text) ?? (role === 'user' ? asString(item.displayText) : null);
    if (!role || !text) continue;
    out.push({ seq: out.length + 1, role, text, at: asTime(item.recordedAt) });
  }
  return out;
}

// The agent's text for one turn, from history items.
export function museTurnOutput(items: unknown, turnId: string): string | null {
  if (!Array.isArray(items)) return null;
  const texts = items.map(asRecord)
    .filter((item): item is Rec => !!item && item.kind === 'agentMessage' && item.turnId === turnId && item.retracted !== true)
    .map(item => asString(item.text))
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join('\n') : null;
}

export interface MuseUsageSample {
  input_tokens: number | null;
  output_tokens: number | null;
  // MSP reports no per-turn cost; always null (unknown), never estimated.
  cost_usd: null;
}

// An aggregate is unknown when any contributing record omitted the field:
// never under-report (Agent Dealer's Muse parser rule).
function sumOrUnknown(values: (number | null)[]): number | null {
  if (values.length === 0 || values.some(value => value === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}

// The common usage sample for one turn: turn/completed.usage when the host
// sent it, else the sum of the turn's session/tokenUsage records, else null
// (absent usage is unknown, not zero).
export function museUsageSample(completedUsage: unknown, tokenUsageRecords: unknown[] = []): MuseUsageSample | null {
  const direct = asRecord(completedUsage);
  if (direct) return { input_tokens: asCount(direct.inputTokens), output_tokens: asCount(direct.outputTokens), cost_usd: null };
  const records = tokenUsageRecords.map(asRecord).filter((record): record is Rec => record !== null);
  if (records.length === 0) return null;
  return {
    input_tokens: sumOrUnknown(records.map(record => asCount(record.inputTokens))),
    output_tokens: sumOrUnknown(records.map(record => asCount(record.outputTokens))),
    cost_usd: null,
  };
}

export function parseMuseVersion(value: unknown): [number, number, number] | null {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(version: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

const AUTH_RE = /login is no longer valid|authentication failed|missing \w+ credentials|api key .*rejected|unauthenticated|unauthori[sz]ed|not (signed|logged) in|\b401\b|\b403\b|forbidden|authRequired/i;
const USAGE_CAP_RE = /rate[\s_-]*limit|usage[\s_-]*limit|quota|\b429\b|rate_limited/i;

export interface MspRpcError { code?: unknown; message?: unknown; data?: unknown }

// A JSON-RPC error as a structured provider error. Diagnostics carry the MSP
// kind and a classification prefix, never the raw message.
export function museRpcError(error: MspRpcError): ProviderError {
  const code = typeof error.code === 'number' ? error.code : null;
  const kind = asString(asRecord(error.data)?.kind) ?? 'unknown';
  const text = `${kind} ${typeof error.message === 'string' ? error.message : ''}`;
  if (AUTH_RE.test(text) || code === 401 || code === 403) return { code: 'unavailable', message: `auth_required (${kind})` };
  if (code === -32601 || kind === 'methodNotFound' || kind === 'experimentalRequired' || kind === 'capabilityRequired' || code === -32010) {
    return { code: 'unsupported', message: `unsupported (${kind})` };
  }
  if (code === -32020 || code === -32011 || kind === 'sessionNotFound' || kind === 'notFound') return { code: 'not_found', message: `not_found (${kind})` };
  if (code === -32021 || kind === 'sessionInUse') return { code: 'busy', message: `busy (${kind})` };
  if (code === -32602 || code === -32002 || kind === 'invalidParams' || kind === 'inputTooLarge') return { code: 'invalid_input', message: `invalid_input (${kind})` };
  return { code: 'unavailable', message: `provider_error (${kind})` };
}

// A failed turn's terminal error as a stable failure code.
export function museTurnFailure(error: unknown, reason: unknown): { code: string; message: string } {
  const e = asRecord(error);
  const kind = asString(e?.kind) ?? '';
  const message = (asString(e?.message) ?? asString(reason) ?? kind) || 'turn failed';
  const text = `${kind} ${message}`;
  const code = AUTH_RE.test(text) ? 'auth' : USAGE_CAP_RE.test(text) || e?.quota ? 'usage_cap' : kind || 'failed';
  return { code, message: message.slice(0, 500) };
}

// UUIDv7 for MSP commandId idempotency handles (session/start, session/resume,
// turn/start, turn/cancel all require one; the server never mints them).
export function museUuidv7(nowMs: number = Date.now()): string {
  const b = Buffer.alloc(16);
  let ts = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  randomBytes(10).copy(b, 6);
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function museTurnHandleId(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function splitTurnHandle(id: string): { sessionId: string; turnId: string } | null {
  const at = id.lastIndexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { sessionId: id.slice(0, at), turnId: id.slice(at + 1) };
}

// ---- stdio MSP host ----

export interface MuseProviderOptions {
  // Executable and leading arguments; `serve` and the posture flags follow.
  // Defaults: BOTMANCERS_MUSE_BIN or `muse`, no leading arguments.
  command?: string;
  commandArgs?: string[];
  // Extra `muse serve` flags for every host (for example --provider echo).
  // Default: BOTMANCERS_MUSE_SERVE_ARGS (a JSON string array) or none.
  serveArgs?: string[];
  env?: Record<string, string>;
  rpcTimeoutMs?: number;
  // How long a cancel waits for the host's terminal record.
  cancelSettleMs?: number;
}

type Reply = { ok: true; result: Rec } | { ok: false; error: ProviderError };

interface TurnTrack {
  sessionId: string;
  completed: Rec | null;
  usageRecords: unknown[];
}

interface ProbeInfo {
  muse_version: string | null;
  schema_version: number | null;
  schema_fingerprint: string | null;
  durability: string | null;
}

class MspHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private readonly listeners = new Set<() => void>();
  private ready: Promise<ProviderError | null> | null = null;
  readonly loaded = new Set<string>();
  readonly turns = new Map<string, TurnTrack>();
  info: ProbeInfo | null = null;

  constructor(private readonly options: Required<Pick<MuseProviderOptions, 'command' | 'commandArgs' | 'serveArgs' | 'env' | 'rpcTimeoutMs'>>, readonly authority: SessionAuthority) {}

  alive(): boolean {
    return this.child !== null;
  }

  // Spawns and handshakes once; resolves to null when ready, else the failure.
  start(): Promise<ProviderError | null> {
    if (this.ready && this.child) return this.ready;
    this.ready = this.spawnAndInitialize();
    return this.ready;
  }

  private async spawnAndInitialize(): Promise<ProviderError | null> {
    const posture = this.authority === 'read_only' ? ['--disable-write', '--disable-shell'] : [];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, [...this.options.commandArgs, 'serve', ...posture, ...this.options.serveArgs], {
        cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.options.env },
      });
    } catch {
      return { code: 'unavailable', message: 'spawn_failed' };
    }
    this.child = child;
    let spawnError: string | null = null;
    let stderrTail = '';
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code === 'ENOENT' ? 'binary_missing' : 'spawn_failed';
      this.drop(child);
    });
    child.stdin.on('error', () => this.drop(child));
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000); });
    child.stdout.on('data', (chunk: Buffer) => this.onData(child, chunk));
    child.on('close', () => this.drop(child));
    const init = await this.request('initialize', { clientInfo: { ...MUSE_CLIENT_INFO } });
    if (!init.ok) {
      this.close();
      if (spawnError) return { code: 'unavailable', message: spawnError };
      if (AUTH_RE.test(stderrTail)) return { code: 'unavailable', message: 'auth_required (host exited)' };
      return init.error;
    }
    const server = asRecord(init.result.serverInfo);
    const schema = asRecord(init.result.schema);
    this.info = {
      muse_version: asString(server?.version),
      schema_version: typeof schema?.version === 'number' ? schema.version : null,
      schema_fingerprint: asString(schema?.fingerprint),
      // Absent reads as durable (the MSP default for hosts predating the field).
      durability: asString(init.result.sessionDurability) ?? 'durable',
    };
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    } catch {
      this.close();
      return { code: 'unavailable', message: 'transport_error' };
    }
    return null;
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    this.buffer += chunk.toString();
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.close();
      return;
    }
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: Rec | null = null;
    try {
      msg = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg) return;
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      const error = asRecord(msg.error);
      resolve(error ? { ok: false, error: museRpcError(error) } : { ok: true, result: asRecord(msg.result) ?? {} });
      return;
    }
    if (typeof msg.method !== 'string' || msg.id !== undefined) return;
    if (msg.method !== 'turn/completed' && msg.method !== 'session/tokenUsage') return;
    const params = asRecord(msg.params);
    const turnId = asString(params?.turnId);
    const sessionId = asString(params?.sessionId);
    if (!params || !turnId || !sessionId) return;
    // A notification can arrive in the same chunk as its turn/start ack,
    // before the caller records the turn, so the track is created here too.
    let track = this.turns.get(turnId);
    if (!track) {
      track = { sessionId, completed: null, usageRecords: [] };
      this.turns.set(turnId, track);
    }
    if (msg.method === 'turn/completed') {
      track.completed = params;
      this.notify();
    } else if (msg.method === 'session/tokenUsage') {
      track.usageRecords.push(params.usage);
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // Resolves when `done()` holds, the host dies, or the signal/deadline fires.
  async waitFor(done: () => boolean, signal: AbortSignal | null | undefined, deadlineAt: number | null | undefined): Promise<'done' | 'dead' | 'cancelled' | 'timed_out'> {
    for (;;) {
      if (done()) return 'done';
      if (!this.alive()) return 'dead';
      if (signal?.aborted) return 'cancelled';
      const remaining = typeof deadlineAt === 'number' ? deadlineAt - Date.now() : 1000;
      if (remaining <= 0) return 'timed_out';
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          this.listeners.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(remaining, 1000));
        this.listeners.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }

  request(method: string, params: Rec): Promise<Reply> {
    const child = this.child;
    if (!child) return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'host_not_running' } });
    const id = ++this.seq;
    return new Promise<Reply>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'unavailable', message: `rpc_timeout (${method})` } });
      }, this.options.rpcTimeoutMs);
      this.pending.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: { code: 'unavailable', message: 'transport_error' } });
      }
    });
  }

  private drop(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    this.child = null;
    this.ready = null;
    this.loaded.clear();
    for (const resolve of this.pending.values()) resolve({ ok: false, error: { code: 'unavailable', message: 'host_exited' } });
    this.pending.clear();
    this.notify();
  }

  close(): void {
    const child = this.child;
    if (!child) return;
    this.drop(child);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  runningTurns(): number {
    let n = 0;
    for (const track of this.turns.values()) if (!track.completed) n++;
    return n;
  }
}

// ---- provider ----

export type MuseProbeStatus = 'ready' | 'unsupported' | 'auth_required' | 'unavailable';

export interface MuseProbe extends ProbeInfo {
  status: MuseProbeStatus;
  // Why the host is not usable; null when ready.
  reason: string | null;
  capabilities: SessionProviderCapabilities;
}

interface ConnectionState {
  hosts: Partial<Record<SessionAuthority, MspHost>>;
  probe: MuseProbe | null;
  startKeys: Map<string, { provider_session_id: string; provider_turn_id: string }>;
}

// Hosts outlive a provider object: sessionProviderFor builds a fresh provider
// per call, so state lives per runtime connection for the process lifetime.
const connections = new Map<string, ConnectionState>();

function connectionState(key: string): ConnectionState {
  let state = connections.get(key);
  if (!state) {
    state = { hosts: {}, probe: null, startKeys: new Map() };
    connections.set(key, state);
  }
  return state;
}

function envServeArgs(): string[] {
  const raw = process.env.BOTMANCERS_MUSE_SERVE_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((arg): arg is string => typeof arg === 'string') : [];
  } catch {
    return [];
  }
}

// Capability probe from one host's handshake: the stable schema version, a
// verified Muse version, and a durable host (else nothing is resumable).
function probeFrom(info: ProbeInfo | null, failure: ProviderError | null): MuseProbe {
  const base: ProbeInfo = info ?? { muse_version: null, schema_version: null, schema_fingerprint: null, durability: null };
  if (failure) {
    const status: MuseProbeStatus = /^auth_required/.test(failure.message) ? 'auth_required' : failure.code === 'unsupported' ? 'unsupported' : 'unavailable';
    return { ...base, status, reason: failure.message, capabilities: { ...NO_CAPABILITIES } };
  }
  const version = parseMuseVersion(base.muse_version);
  if (base.schema_version !== MSP_SCHEMA_VERSION) {
    return { ...base, status: 'unsupported', reason: `msp_schema_${base.schema_version ?? 'unknown'}`, capabilities: { ...NO_CAPABILITIES } };
  }
  if (!version || !versionAtLeast(version, parseMuseVersion(MIN_MUSE_VERSION)!)) {
    return { ...base, status: 'unsupported', reason: `muse_version_${base.muse_version ?? 'unknown'}`, capabilities: { ...NO_CAPABILITIES } };
  }
  const durable = base.durability === 'durable';
  return {
    ...base, status: 'ready', reason: null,
    // An ephemeral host keeps nothing: no past session to list, read, or resume.
    capabilities: durable ? { ...MUSE_DECLARED_CAPABILITIES, authorities: [...MUSE_DECLARED_CAPABILITIES.authorities] }
      : { ...MUSE_DECLARED_CAPABILITIES, list: false, search: false, read: false, resume: false, authorities: [...MUSE_DECLARED_CAPABILITIES.authorities] },
  };
}

export function createMuseSessionProvider(key: string, options: MuseProviderOptions = {}): SessionProvider & { probe(): Promise<MuseProbe> } {
  const state = connectionState(key);
  const settings = {
    command: options.command ?? process.env.BOTMANCERS_MUSE_BIN ?? 'muse',
    commandArgs: options.commandArgs ?? [],
    serveArgs: options.serveArgs ?? envServeArgs(),
    env: options.env ?? {},
    rpcTimeoutMs: options.rpcTimeoutMs ?? 30_000,
  };
  const cancelSettleMs = options.cancelSettleMs ?? 10_000;

  async function host(authority: SessionAuthority): Promise<{ ok: true; host: MspHost } | { ok: false; error: ProviderError }> {
    let h = state.hosts[authority];
    if (!h) {
      h = new MspHost(settings, authority);
      state.hosts[authority] = h;
    }
    const failure = await h.start();
    state.probe = probeFrom(h.info, failure);
    if (failure) return { ok: false, error: failure };
    if (state.probe.status !== 'ready') {
      h.close();
      return { ok: false, error: { code: 'unsupported', message: state.probe.reason ?? 'unsupported' } };
    }
    return { ok: true, host: h };
  }

  // Reads never attach, so any live host serves them; read_only otherwise.
  function readerHost() {
    const live = (['read_only', 'workspace_write'] as const).find(authority => state.hosts[authority]?.alive());
    return host(live ?? 'read_only');
  }

  async function call(h: MspHost, method: string, params: Rec): Promise<Reply> {
    return h.request(method, params);
  }

  async function readSession(sessionId: string, withItems: boolean): Promise<Reply> {
    const h = await readerHost();
    if (!h.ok) return h;
    return call(h.host, 'session/read', { sessionId, excludeItems: !withItems });
  }

  function durability(): string | null {
    return state.probe?.durability ?? 'durable';
  }

  // Loads the session on `h` for a turn. A session our other host still
  // holds is released first when that host is idle; otherwise it is busy.
  async function attach(h: MspHost, sessionId: string): Promise<{ ok: true; session: Rec } | { ok: false; error: ProviderError }> {
    for (const other of Object.values(state.hosts)) {
      if (!other || other === h || !other.loaded.has(sessionId)) continue;
      if (other.runningTurns() > 0) return { ok: false, error: { code: 'busy', message: 'busy (loaded by another host)' } };
      other.close();
    }
    if (h.loaded.has(sessionId)) {
      const read = await call(h, 'session/read', { sessionId, excludeItems: true });
      if (!read.ok) return read;
      return { ok: true, session: asRecord(read.result.session) ?? {} };
    }
    const resumed = await call(h, 'session/resume', { commandId: museUuidv7(), sessionId, excludeItems: true });
    if (!resumed.ok) return resumed;
    h.loaded.add(sessionId);
    return { ok: true, session: asRecord(resumed.result.session) ?? {} };
  }

  async function startTurn(h: MspHost, sessionId: string, prompt: string): Promise<ProviderResult<string>> {
    const started = await call(h, 'turn/start', { commandId: museUuidv7(), sessionId, input: [{ type: 'text', text: prompt }] });
    if (!started.ok) return started;
    const turnId = asString(started.result.turnId);
    if (!turnId) return providerError('unavailable', 'provider_error (turn/start without turnId)');
    if (!h.turns.has(turnId)) h.turns.set(turnId, { sessionId, completed: null, usageRecords: [] });
    return providerOk(turnId);
  }

  // A terminal result from turn/completed params plus the session history.
  async function terminalResult(sessionId: string, turnId: string, terminal: unknown, error: unknown, reason: unknown, usage: MuseUsageSample | null, items?: unknown): Promise<ProviderTurnResult> {
    let history = items;
    if (history === undefined) {
      const read = await readSession(sessionId, true);
      history = read.ok ? asRecord(read.result.history)?.items : null;
    }
    const status = terminal === 'completed' ? 'completed' : terminal === 'cancelled' ? 'cancelled' : 'failed';
    return {
      status,
      provider_session_id: sessionId,
      output: museTurnOutput(history, turnId),
      failure: status === 'completed' ? null : status === 'cancelled' ? { code: 'cancelled', message: asString(reason) ?? 'cancelled' } : museTurnFailure(error, reason),
      usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : null,
      finished_at: Date.now(),
    };
  }

  function liveTrack(turnId: string): { host: MspHost; track: TurnTrack } | null {
    for (const h of Object.values(state.hosts)) {
      const track = h?.alive() ? h.turns.get(turnId) : undefined;
      if (h && track) return { host: h, track };
    }
    return null;
  }

  // Reattachment after a restart (or a host death): the session's durable
  // record says how the turn ended. A turn that is neither the session's
  // last terminal nor running anywhere died with its host.
  async function observeCold(sessionId: string, turnId: string, signal: AbortSignal | null | undefined, deadlineAt: number | null | undefined): Promise<ProviderResult<ProviderTurnResult>> {
    for (;;) {
      const read = await readSession(sessionId, true);
      if (!read.ok) return read;
      const session = asRecord(read.result.session);
      const last = asRecord(read.result.lastTurn);
      const items = asRecord(read.result.history)?.items;
      if (last && last.turnId === turnId) return providerOk(await terminalResult(sessionId, turnId, last.terminal, last.error, last.reason, null, items));
      if (session?.activeTurnId !== turnId) {
        return providerOk({
          status: 'failed', provider_session_id: sessionId, output: museTurnOutput(items, turnId),
          failure: { code: 'host_lost', message: 'The Muse host running this turn exited before it finished.' }, usage: null, finished_at: Date.now(),
        });
      }
      // Still running in a host this process does not own: poll its record.
      if (signal?.aborted) return providerError('cancelled', 'observe aborted');
      if (typeof deadlineAt === 'number' && Date.now() >= deadlineAt) return providerError('timed_out', 'observe deadline');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return {
    kind: MUSE_PROVIDER_KIND,

    // The probed capabilities once a host has handshaken; the declared MSP v1
    // set before that (every operation re-checks the probe first).
    capabilities() {
      const caps = state.probe?.capabilities ?? MUSE_DECLARED_CAPABILITIES;
      return { ...caps, authorities: [...caps.authorities] };
    },

    async probe() {
      const h = await readerHost();
      return state.probe ?? probeFrom(null, h.ok ? null : h.error);
    },

    async listSessions(input) {
      const h = await readerHost();
      if (!h.ok) return h;
      const filter: Rec = {};
      const scopedIds = input.scope.kind === 'sessions' ? input.scope.provider_session_ids : null;
      if (scopedIds) {
        if (scopedIds.length === 0) return providerOk({ items: [], next_cursor: null });
        filter.sessionId = { anyOf: scopedIds.slice(0, MSP_LIST_MAX) };
      }
      const terms = (input.query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 16);
      if (terms.length > 0) filter.text = { allOf: terms, fields: ['name', 'title'] };
      const listed = await call(h.host, 'session/list', {
        limit: Math.min(Math.max(1, input.limit), MUSE_MAX_PAGE),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      });
      if (!listed.ok) return listed;
      // Filtering is probed per predicate: a predicate missing from
      // appliedFilter was not applied by this host.
      const applied = asRecord(listed.result.appliedFilter);
      if (filter.text && !asRecord(applied?.text)) return providerError('unsupported', 'unsupported (session/list text filter)');
      const sessions = Array.isArray(listed.result.sessions) ? listed.result.sessions : [];
      const items = sessions
        .map(raw => museSessionRecord(raw, durability()))
        .filter((record): record is ProviderSessionRecord => record !== null)
        .filter(record => !scopedIds || scopedIds.includes(record.provider_session_id));
      return providerOk({ items, next_cursor: asString(listed.result.nextCursor) });
    },

    async getSession(input) {
      const read = await readSession(input.provider_session_id, false);
      if (!read.ok) return read.error.code === 'not_found' ? providerOk(null) : read;
      const record = museSessionRecord(read.result.session, durability());
      return providerOk(record && record.provider_session_id === input.provider_session_id ? record : null);
    },

    async readTranscript(input) {
      const read = await readSession(input.provider_session_id, true);
      if (!read.ok) return read;
      const history = asRecord(read.result.history);
      // Only inline history is a complete transcript; a budget-downgraded
      // snapshot is reported as unavailable rather than partially folded.
      if (history?.mode !== 'inline') return providerError('unavailable', `history_${asString(history?.mode) ?? 'missing'}`);
      const entries = museTranscript(history.items);
      const start = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
      const items = entries.slice(start, start + input.limit);
      return providerOk({ items, next_cursor: start + input.limit < entries.length ? String(start + input.limit) : null });
    },

    async startSession(input) {
      const replay = state.startKeys.get(input.idempotency_key);
      if (replay) return providerOk(replay);
      const h = await host(input.authority);
      if (!h.ok) return h;
      const started = await call(h.host, 'session/start', { commandId: museUuidv7(), workspaceRoot: input.workspace, approvalMode: MUSE_APPROVAL_MODE });
      if (!started.ok) return started;
      const sessionId = asString(asRecord(started.result.session)?.sessionId);
      if (!sessionId) return providerError('unavailable', 'provider_error (session/start without sessionId)');
      h.host.loaded.add(sessionId);
      const turn = await startTurn(h.host, sessionId, input.prompt);
      if (!turn.ok) return turn;
      const handle = { provider_session_id: sessionId, provider_turn_id: museTurnHandleId(sessionId, turn.value) };
      state.startKeys.set(input.idempotency_key, handle);
      return providerOk(handle);
    },

    async sendTurn(input) {
      const replay = state.startKeys.get(input.idempotency_key);
      if (replay) return providerOk(replay);
      const h = await host(input.authority);
      if (!h.ok) return h;
      const attached = await attach(h.host, input.provider_session_id);
      if (!attached.ok) return attached;
      // Never queue behind, steer, or replace a running turn.
      if (attached.session.status === 'running' || asString(attached.session.activeTurnId)) return providerError('busy', 'busy (turn in flight)');
      const turn = await startTurn(h.host, input.provider_session_id, input.prompt);
      if (!turn.ok) return turn;
      const handle = { provider_session_id: input.provider_session_id, provider_turn_id: museTurnHandleId(input.provider_session_id, turn.value) };
      state.startKeys.set(input.idempotency_key, handle);
      return providerOk(handle);
    },

    async observeTurn(input) {
      const ids = splitTurnHandle(input.provider_turn_id);
      if (!ids) return providerError('not_found', 'not_found (turn handle)');
      const live = liveTrack(ids.turnId);
      if (live) {
        const outcome = await live.host.waitFor(() => live.track.completed !== null, input.signal, input.deadline_at);
        if (outcome === 'cancelled') return providerError('cancelled', 'observe aborted');
        if (outcome === 'timed_out') return providerError('timed_out', 'observe deadline');
        const done = live.track.completed;
        if (done) {
          return providerOk(await terminalResult(ids.sessionId, ids.turnId, done.terminal, done.error, done.reason, museUsageSample(done.usage, live.track.usageRecords)));
        }
      }
      return observeCold(ids.sessionId, ids.turnId, input.signal, input.deadline_at);
    },

    async cancelTurn(input) {
      const ids = splitTurnHandle(input.provider_turn_id);
      if (!ids) return providerError('not_found', 'not_found (turn handle)');
      const live = liveTrack(ids.turnId);
      if (!live) {
        // No host of ours runs it: it has ended (or died with its host), or a
        // foreign host runs it, which this connection cannot cancel.
        const read = await readSession(ids.sessionId, false);
        if (!read.ok) return read;
        if (asRecord(read.result.session)?.activeTurnId === ids.turnId) return providerError('unavailable', 'turn runs in another Muse host');
        return providerOk('already_terminal');
      }
      if (live.track.completed) return providerOk('already_terminal');
      const cancelled = await call(live.host, 'turn/cancel', { commandId: museUuidv7(), sessionId: ids.sessionId, turnId: ids.turnId });
      if (!cancelled.ok) return cancelled;
      await live.host.waitFor(() => live.track.completed !== null, null, Date.now() + cancelSettleMs);
      // Re-read: the wait above settles the track asynchronously.
      const terminal = (live.track.completed as Rec | null)?.terminal;
      return providerOk(terminal === undefined || terminal === 'cancelled' ? 'cancelled' : 'already_terminal');
    },
  };
}

// Registers the Muse provider for every runtime connection whose provider is
// `muse` (a connection-specific registration still wins).
export function registerMuseSessionProvider(options: MuseProviderOptions = {}, target: { connectionId: string } | { provider: string } = { provider: 'muse' }): void {
  registerSessionProvider(target, connection => createMuseSessionProvider(connection.id, options));
}

// Stops every host this process started (server teardown and tests).
export function shutdownMuseSessionProviders(): void {
  for (const state of connections.values()) {
    for (const h of Object.values(state.hosts)) h?.close();
  }
  connections.clear();
}

export function museConnectionProbe(connectionId: string): MuseProbe | null {
  return connections.get(connectionId)?.probe ?? null;
}

process.once('exit', () => shutdownMuseSessionProviders());
