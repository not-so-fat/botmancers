// NOT-505: a direct SessionProvider (./session-provider) for Cursor Agent
// CLI/SDK sessions. No Agent Deck, no Cursor IDE history.
//
// Integration. The primary path is the Cursor Agent CLI (`cursor-agent`):
// `create-chat` for a new session and `--print --output-format stream-json
// --resume <chat>` for every turn. The fallback is the Cursor SDK
// (`Agent.create` / `Agent.resume`), used only when the CLI is not
// installed and the SDK module is, run in a child process that writes the
// same stream-json events. Both share this provider's identity (kind
// 'cursor') and state. Only structured output is read: stream-json events,
// the chat id line `create-chat` prints, and, where a version offers it,
// JSON session listing. Nothing here opens Cursor's own stores (IDE
// databases, ~/.cursor), and no human-oriented text is parsed.
//
// Capability probe. `<cli> --version` (and `<cli> ls --help` for a JSON
// listing flag), or a child-process import of the SDK module, decides the
// backend and the capability set. The tested CLI (2026.10.16) has no
// structured listing (`ls` is an interactive picker), so `list` is false
// there and only explicitly imported sessions (importSession) or sessions
// this provider created can be addressed.
//
// Exact-session resume. `cursor-agent --resume <unknown id>` silently starts
// a fresh chat under that id, so this provider resumes only chats it knows:
// ones it created, ones a supported listing reported, or ones explicitly
// imported. An unknown id is not_found and nothing is launched; a resume that
// fails stays a failed turn, never retried as a new session. The init event
// must report the expected chat and workspace, or the turn fails.
//
// Durability. Each turn runs detached (its own process group) with stdout
// journaled to a file under this provider's state directory, beside the
// Botmancers database. A restarted Botmancers re-reads the journal and the
// recorded pid: observe and cancel reattach to the same turn.
//
// Transcript. Neither the CLI nor the SDK exposes a chat's history, so
// `read` returns the turns this provider journaled (prompt, assistant text,
// tool-call steps). History from before the session was imported is not
// readable and is never reconstructed from Cursor's stores.
//
// Privacy. Chat ids and turn ids are provider-private (see
// ./provider-sessions); this module never logs them.
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { dbPath } from './home';
import { SESSION_CONTEXT_ENV, SESSION_CONTEXT_EXEC_ENV, withoutSessionContextEnv } from './session-context-launch';
import {
  normalizeUsage,
  providerError,
  providerOk,
  type ImportSessionInput,
  type ProviderPage,
  type ProviderResult,
  type ProviderScope,
  type ProviderSessionRecord,
  type ProviderTurnResult,
  type ProviderUsage,
  type SessionAuthority,
  type SessionProvider,
  type SessionProviderCapabilities,
  type TranscriptEntry,
} from './session-provider';

export const CURSOR_PROVIDER_KIND = 'cursor';
const DEFAULT_CLI = 'cursor-agent';
const DEFAULT_SDK_MODULE = '@cursor/sdk';
const PAGE = 50;
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const CREATE_TIMEOUT_MS = 60_000;
// Ids are handed to argv verbatim; refuse anything that is not a plain token.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

// ---- capability / version probe ----

export interface CursorBackendProbe {
  available: boolean;
  version: string | null;
  // Structured session enumeration.
  list: boolean;
}

export interface CursorProbe {
  // The selected backend: CLI first, SDK as the fallback, or none.
  backend: 'cli' | 'sdk' | null;
  cli: CursorBackendProbe;
  sdk: CursorBackendProbe;
}

export interface CursorProviderOptions {
  cliPath?: string;
  sdkModule?: string;
  stateDir?: string;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Resolved {
  cliPath: string;
  sdkModule: string;
  stateDir: string;
  pollMs: number;
  env: NodeJS.ProcessEnv;
}

const probes = new Map<string, { at: number; probe: CursorProbe }>();

export function resetCursorProbeCache(): void {
  probes.clear();
}

// The SDK runs only in a child: Botmancers never loads it in-process.
// Assumed SDK surface (gated by the probe): Agent.create({ cwd }) -> { id },
// Agent.resume(id, { cwd, mode }) -> agent whose stream(prompt) yields
// stream-json events, optional Agent.list() -> [{ id, cwd, title,
// createdAt, updatedAt }], optional `version`.
const SDK_RUNNER = `
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
const [op, spec, ...rest] = process.argv.slice(1);
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
async function load() {
  const abs = path.isAbsolute(spec) ? spec : createRequire(path.join(process.cwd(), 'package.json')).resolve(spec);
  const mod = await import(pathToFileURL(abs).href);
  return mod.default && mod.default.Agent ? mod.default : mod;
}
try {
  const sdk = await load();
  const Agent = sdk.Agent;
  if (op === 'probe') {
    out({ resume: typeof Agent?.resume === 'function', create: typeof Agent?.create === 'function', list: typeof Agent?.list === 'function', version: typeof sdk.version === 'string' ? sdk.version : null });
  } else if (op === 'create') {
    const chat = await Agent.create({ cwd: rest[0] });
    out({ id: chat && chat.id });
  } else if (op === 'list') {
    out(await Agent.list({}));
  } else if (op === 'turn') {
    const [id, cwd, mode, prompt] = rest;
    const agent = await Agent.resume(id, { cwd, mode: mode === '-' ? null : mode });
    for await (const event of agent.stream(prompt)) out(event);
  } else {
    process.exit(2);
  }
} catch (error) {
  if (op === 'turn') out({ type: 'result', subtype: 'sdk_error', is_error: true, result: null });
  process.exit(op === 'probe' ? 3 : 1);
}
`;

function sdkArgs(op: string, r: Resolved, rest: string[]): string[] {
  return ['--input-type=module', '-e', SDK_RUNNER, op, r.sdkModule, ...rest];
}

function probeCli(r: Resolved): CursorBackendProbe {
  const version = spawnSync(r.cliPath, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = version.status === 0 ? String(version.stdout ?? '').trim().split('\n').pop()?.trim() ?? '' : '';
  if (!/^[0-9][\w.+-]{0,80}$/.test(line)) return { available: false, version: null, list: false };
  // A version whose `ls` offers JSON output can enumerate; the interactive
  // picker alone cannot.
  const help = spawnSync(r.cliPath, ['ls', '--help'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const list = help.status === 0 && /--output-format\b[^\n]*\bjson\b/.test(String(help.stdout ?? ''));
  return { available: true, version: line, list };
}

function probeSdk(r: Resolved): CursorBackendProbe {
  const run = spawnSync(process.execPath, sdkArgs('probe', r, []), { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status !== 0) return { available: false, version: null, list: false };
  try {
    const shape = JSON.parse(String(run.stdout).trim().split('\n').pop() ?? '');
    const available = shape.resume === true && shape.create === true;
    return { available, version: available && typeof shape.version === 'string' ? shape.version.slice(0, 80) : null, list: available && shape.list === true };
  } catch {
    return { available: false, version: null, list: false };
  }
}

export function probeCursor(options: CursorProviderOptions = {}): CursorProbe {
  const r = resolve(options, 'probe');
  // An explicit env (tests, per-connection overrides) is part of the key.
  const key = `${r.cliPath}\n${r.sdkModule}\n${r.env === process.env ? '' : JSON.stringify(r.env)}`;
  const cached = probes.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
  const cli = probeCli(r);
  // The fallback is probed only when the primary is absent.
  const sdk = cli.available ? { available: false, version: null, list: false } : probeSdk(r);
  const probe: CursorProbe = { backend: cli.available ? 'cli' : sdk.available ? 'sdk' : null, cli, sdk };
  probes.set(key, { at: Date.now(), probe });
  return probe;
}

function capabilitiesFor(probe: CursorProbe): SessionProviderCapabilities {
  const on = probe.backend !== null;
  const list = probe.backend === 'cli' ? probe.cli.list : probe.backend === 'sdk' ? probe.sdk.list : false;
  return {
    list, search: false, read: on, resume: on, start: on, cancel: on, usage: on,
    authorities: on ? ['read_only', 'workspace_write'] : [], max_page_size: PAGE,
  };
}

// ---- structured stream parser ----

export interface ParsedCursorTurn {
  init: { session_id: string | null; cwd: string | null } | null;
  // In order: assistant text and completed tool steps.
  steps: { role: 'assistant' | 'tool'; text: string; at: number | null }[];
  // The first result event; later ones are counted, never merged.
  result: { ok: boolean; subtype: string | null; text: string | null; usage: ProviderUsage | null } | null;
  result_events: number;
  // Lines that are not JSON objects (ignored, never interpreted).
  malformed: number;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map(part => (part && (part as { type?: unknown }).type === 'text' ? str((part as { text?: unknown }).text) : null)).filter((part): part is string => part !== null);
  return parts.length ? parts.join('') : null;
}

// Cursor reports camelCase counts; cost only when the runtime states one.
function cursorUsage(event: Record<string, unknown>): ProviderUsage | null {
  const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : null;
  const cost = event.total_cost_usd ?? usage?.costUsd ?? usage?.cost_usd;
  if (!usage && cost === undefined) return null;
  return normalizeUsage({ input_tokens: usage?.inputTokens ?? usage?.input_tokens, output_tokens: usage?.outputTokens ?? usage?.output_tokens, cost_usd: cost });
}

function toolName(event: Record<string, unknown>): string {
  const call = event.tool_call && typeof event.tool_call === 'object' ? event.tool_call as Record<string, unknown> : {};
  const key = Object.keys(call).find(name => /ToolCall$/.test(name));
  return key ? key.replace(/ToolCall$/, '') : 'tool';
}

// Parses stream-json text. Only newline-terminated lines count unless
// `final` (the process ended), so a half-written line is never misread.
export function parseCursorStream(text: string, final = false): ParsedCursorTurn {
  const parsed: ParsedCursorTurn = { init: null, steps: [], result: null, result_events: 0, malformed: 0 };
  const lines = text.split('\n');
  if (!final) lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      event = value;
    } catch {
      parsed.malformed++;
      continue;
    }
    const at = typeof event.timestamp_ms === 'number' ? event.timestamp_ms : null;
    if (event.type === 'system' && event.subtype === 'init' && !parsed.init) {
      parsed.init = { session_id: str(event.session_id), cwd: str(event.cwd) };
    } else if (event.type === 'assistant') {
      const said = messageText(event.message);
      if (said) parsed.steps.push({ role: 'assistant', text: said, at });
    } else if (event.type === 'tool_call' && event.subtype === 'completed') {
      parsed.steps.push({ role: 'tool', text: `${toolName(event)} (completed)`, at });
    } else if (event.type === 'result') {
      parsed.result_events++;
      if (!parsed.result) {
        parsed.result = {
          ok: event.is_error === false && event.subtype === 'success',
          subtype: str(event.subtype),
          text: str(event.result),
          usage: cursorUsage(event),
        };
      }
    }
  }
  return parsed;
}

// ---- provider-owned state ----

interface ChatRecord {
  workspace: string;
  title: string | null;
  origin: 'created' | 'listed' | 'imported';
  created_at: number;
  updated_at: number;
  turns: string[];
}

interface TurnMeta {
  id: string;
  chat: string;
  workspace: string;
  prompt: string;
  authority: SessionAuthority;
  backend: 'cli' | 'sdk';
  pid: number | null;
  started_at: number;
  cancel_requested_at: number | null;
  correlation: Record<string, unknown>;
}

interface State {
  version: 1;
  chats: Record<string, ChatRecord>;
  turns: Record<string, TurnMeta>;
  keys: Record<string, string>;
}

function resolve(options: CursorProviderOptions, connectionId: string): Resolved {
  const env = options.env ?? process.env;
  const base = options.stateDir ?? (env.BOTMANCERS_CURSOR_STATE_DIR?.trim() || path.join(path.dirname(path.resolve(dbPath(env))), 'providers', 'cursor'));
  return {
    cliPath: options.cliPath ?? (env.BOTMANCERS_CURSOR_CLI?.trim() || DEFAULT_CLI),
    sdkModule: options.sdkModule ?? (env.BOTMANCERS_CURSOR_SDK_MODULE?.trim() || DEFAULT_SDK_MODULE),
    stateDir: path.join(base, connectionId.replace(/[^A-Za-z0-9._-]/g, '_')),
    pollMs: options.pollMs ?? 100,
    // NOT-517: Cursor has no per-launch MCP seam, so it never gets a session
    // context, not even one inherited from Botmancers' own environment.
    env: env[SESSION_CONTEXT_ENV] !== undefined || env[SESSION_CONTEXT_EXEC_ENV] !== undefined ? withoutSessionContextEnv(env) : env,
  };
}

function statePath(r: Resolved): string {
  return path.join(r.stateDir, 'state.json');
}

function turnFile(r: Resolved, turnId: string, ext: 'out' | 'err' | 'exit'): string {
  return path.join(r.stateDir, 'turns', `${turnId}.${ext}`);
}

function load(r: Resolved): State {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(r), 'utf8'));
    if (value && value.version === 1) return value as State;
  } catch {
    // First use: no state yet.
  }
  return { version: 1, chats: {}, turns: {}, keys: {} };
}

function save(r: Resolved, state: State): void {
  fs.mkdirSync(path.join(r.stateDir, 'turns'), { recursive: true });
  const tmp = `${statePath(r)}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath(r));
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function realpathOr(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

type Outcome =
  | { state: 'running'; parsed: ParsedCursorTurn }
  | { state: 'terminal'; parsed: ParsedCursorTurn; result: ProviderTurnResult };

function failed(meta: TurnMeta, code: string, parsed: ParsedCursorTurn, at: number): Outcome {
  return { state: 'terminal', parsed, result: { status: 'failed', provider_session_id: meta.chat, output: null, failure: { code, message: code }, usage: parsed.result?.usage ?? null, finished_at: at } };
}

// The turn's state from its journal, exit marker, pid, and cancel request.
function outcome(r: Resolved, meta: TurnMeta): Outcome {
  const exitText = readText(turnFile(r, meta.id, 'exit'));
  const ended = exitText !== null || !alive(meta.pid);
  const parsed = parseCursorStream(readText(turnFile(r, meta.id, 'out')) ?? '', ended);
  const at = Date.now();
  if (parsed.init) {
    if (parsed.init.session_id !== meta.chat) return failed(meta, 'session_mismatch', parsed, at);
    if (parsed.init.cwd !== null && realpathOr(parsed.init.cwd) !== realpathOr(meta.workspace)) return failed(meta, 'workspace_mismatch', parsed, at);
  }
  if (parsed.result) {
    if (!parsed.result.ok) return failed(meta, `cursor_${(parsed.result.subtype ?? 'error').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)}`, parsed, at);
    const output = parsed.result.text ?? (parsed.steps.filter(step => step.role === 'assistant').map(step => step.text).join('\n') || null);
    return { state: 'terminal', parsed, result: { status: 'completed', provider_session_id: meta.chat, output, failure: null, usage: parsed.result.usage, finished_at: at } };
  }
  if (meta.cancel_requested_at !== null) {
    return { state: 'terminal', parsed, result: { status: 'cancelled', provider_session_id: meta.chat, output: null, failure: { code: 'cancelled', message: 'cancelled' }, usage: null, finished_at: meta.cancel_requested_at } };
  }
  if (exitText !== null) return failed(meta, `exit_${String(Number.parseInt(exitText, 10))}`, parsed, at);
  if (!alive(meta.pid)) return failed(meta, 'process_lost', parsed, at);
  return { state: 'running', parsed };
}

// ---- backend calls ----

function collect(command: string, args: string[], cwd: string, r: Resolved, timeoutMs: number): Promise<{ status: number | null; stdout: string }> {
  return new Promise(done => {
    const child = spawn(command, args, { cwd, env: r.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); done({ status: null, stdout }); });
    child.on('close', status => { clearTimeout(timer); done({ status, stdout }); });
  });
}

async function createChat(r: Resolved, backend: 'cli' | 'sdk', workspace: string): Promise<string | null> {
  const run = backend === 'cli'
    ? await collect(r.cliPath, ['create-chat'], workspace, r, CREATE_TIMEOUT_MS)
    : await collect(process.execPath, sdkArgs('create', r, [workspace]), workspace, r, CREATE_TIMEOUT_MS);
  if (run.status !== 0) return null;
  const last = run.stdout.trim().split('\n').pop()?.trim() ?? '';
  let id: unknown = last;
  if (backend === 'sdk') {
    try { id = JSON.parse(last).id; } catch { id = null; }
  }
  return typeof id === 'string' && SAFE_ID.test(id) ? id : null;
}

interface ListedChat {
  id: string;
  workspace: string | null;
  title: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// A supported JSON listing: an array, or { sessions | chats: [...] }.
async function listChats(r: Resolved, backend: 'cli' | 'sdk'): Promise<ListedChat[] | null> {
  fs.mkdirSync(r.stateDir, { recursive: true });
  const run = backend === 'cli'
    ? await collect(r.cliPath, ['ls', '--output-format', 'json'], r.stateDir, r, CREATE_TIMEOUT_MS)
    : await collect(process.execPath, sdkArgs('list', r, []), r.stateDir, r, CREATE_TIMEOUT_MS);
  if (run.status !== 0) return null;
  let value: unknown;
  try { value = JSON.parse(run.stdout.trim()); } catch { return null; }
  const items = Array.isArray(value) ? value : (value as { sessions?: unknown; chats?: unknown } | null)?.sessions ?? (value as { chats?: unknown } | null)?.chats;
  if (!Array.isArray(items)) return null;
  const out: ListedChat[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id) ?? str(row.chatId) ?? str(row.session_id);
    if (!id || !SAFE_ID.test(id)) continue;
    const workspace = str(row.cwd) ?? str(row.workspace);
    out.push({
      id, workspace: workspace && path.isAbsolute(workspace) ? workspace : null, title: str(row.title) ?? str(row.name),
      created_at: epoch(row.createdAt ?? row.created_at), updated_at: epoch(row.updatedAt ?? row.updated_at),
    });
  }
  return out;
}

function modeArgs(authority: SessionAuthority): string[] {
  // read_only runs in Cursor's read-only ask mode; workspace_write in the
  // default agent mode. Never --force: Cursor's own approvals still apply.
  return authority === 'read_only' ? ['--mode', 'ask'] : [];
}

// Launches one detached turn whose stdout is journaled. The shell wrapper
// records the exit status once the backend ends on its own.
function launchTurn(r: Resolved, meta: TurnMeta): number | null {
  fs.mkdirSync(path.join(r.stateDir, 'turns'), { recursive: true });
  const [command, args] = meta.backend === 'cli'
    ? [r.cliPath, ['--print', '--output-format', 'stream-json', '--trust', '--workspace', meta.workspace, ...modeArgs(meta.authority), '--resume', meta.chat, meta.prompt]]
    : [process.execPath, sdkArgs('turn', r, [meta.chat, meta.workspace, meta.authority === 'read_only' ? 'ask' : '-', meta.prompt])];
  const script = '"$@" >"$BM_OUT" 2>"$BM_ERR" </dev/null; echo $? >"$BM_EXIT.tmp" && mv "$BM_EXIT.tmp" "$BM_EXIT"';
  try {
    const child = spawn('/bin/sh', ['-c', script, 'sh', command, ...args], {
      cwd: meta.workspace,
      detached: true,
      stdio: 'ignore',
      env: {
        ...r.env,
        BM_OUT: turnFile(r, meta.id, 'out'),
        BM_ERR: turnFile(r, meta.id, 'err'),
        BM_EXIT: turnFile(r, meta.id, 'exit'),
        BOTMANCERS_CORRELATION: JSON.stringify(meta.correlation),
      },
    });
    child.on('error', () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

function inScope(scope: ProviderScope, id: string, workspace: string | null): boolean {
  if (scope.kind === 'all_provider_sessions') return true;
  if (scope.kind === 'sessions') return scope.provider_session_ids.includes(id);
  return workspace !== null && scope.workspaces.some(root => workspace === root || workspace.startsWith(`${root.replace(/\/+$/, '')}/`));
}

// ---- the provider ----

export interface CursorSessionProvider extends SessionProvider {
  probe(): CursorProbe;
}

export function createCursorSessionProvider(connection: { id: string; provider: string }, options: CursorProviderOptions = {}): CursorSessionProvider {
  const r = resolve(options, connection.id);
  const probe = () => probeCursor(options);
  const backend = () => probe().backend;
  const caps = () => capabilitiesFor(probe());
  const unsupported = (what: string) => providerError(backend() === null ? 'unavailable' : 'unsupported', `Cursor ${what} is not available.`);

  function record(state: State, id: string, chat: ChatRecord): ProviderSessionRecord {
    const running = chat.turns.some(turnId => state.turns[turnId] && outcome(r, state.turns[turnId]).state === 'running');
    const last = chat.turns.length ? state.turns[chat.turns[chat.turns.length - 1]]?.started_at ?? chat.updated_at : chat.updated_at;
    return {
      provider_session_id: id, title: chat.title, workspace: chat.workspace, created_at: chat.created_at,
      updated_at: Math.max(chat.updated_at, last), lifecycle: 'open', resumable: true, busy: running,
    };
  }

  async function listed(kind: 'cli' | 'sdk'): Promise<ProviderResult<ListedChat[]>> {
    const chats = await listChats(r, kind);
    return chats ? providerOk(chats) : providerError('unavailable', 'Cursor session listing failed.');
  }

  function beginTurn(state: State, kind: 'cli' | 'sdk', chatId: string, input: { prompt: string; authority: SessionAuthority; idempotency_key: string; correlation: object }): ProviderResult<{ provider_turn_id: string; provider_session_id: string }> {
    const chat = state.chats[chatId];
    const meta: TurnMeta = {
      id: `ct-${randomUUID()}`, chat: chatId, workspace: chat.workspace, prompt: input.prompt, authority: input.authority, backend: kind,
      pid: null, started_at: Date.now(), cancel_requested_at: null, correlation: { ...input.correlation },
    };
    // Recorded before launch, so a crash between the two leaves a turn that
    // observes as process_lost rather than an untracked process.
    state.turns[meta.id] = meta;
    state.keys[input.idempotency_key] = meta.id;
    chat.turns.push(meta.id);
    save(r, state);
    meta.pid = launchTurn(r, meta);
    save(r, state);
    return providerOk({ provider_turn_id: meta.id, provider_session_id: chatId });
  }

  function replay(state: State, key: string) {
    const turnId = state.keys[key];
    return turnId && state.turns[turnId] ? providerOk({ provider_turn_id: turnId, provider_session_id: state.turns[turnId].chat }) : null;
  }

  return {
    kind: CURSOR_PROVIDER_KIND,
    probe,
    capabilities: caps,

    async listSessions(input) {
      const kind = backend();
      if (!kind || !caps().list) return unsupported('session listing');
      const chats = await listed(kind);
      if (!chats.ok) return chats;
      const state = load(r);
      const visible = chats.value.filter(chat => inScope(input.scope, chat.id, chat.workspace));
      const start = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
      const page = visible.slice(start, start + Math.min(input.limit, PAGE));
      const now = Date.now();
      for (const chat of page) {
        if (!state.chats[chat.id] && chat.workspace) {
          state.chats[chat.id] = { workspace: chat.workspace, title: chat.title, origin: 'listed', created_at: chat.created_at ?? now, updated_at: chat.updated_at ?? now, turns: [] };
        }
      }
      save(r, state);
      const items = page.map(chat => (state.chats[chat.id]
        ? { ...record(state, chat.id, state.chats[chat.id]), title: chat.title ?? state.chats[chat.id].title }
        : { provider_session_id: chat.id, title: chat.title, workspace: null, created_at: chat.created_at, updated_at: chat.updated_at, lifecycle: 'open' as const, resumable: false, busy: false }));
      const next = start + page.length < visible.length ? String(start + page.length) : null;
      return providerOk({ items, next_cursor: next });
    },

    async getSession(input) {
      const kind = backend();
      if (!kind) return unsupported('sessions');
      const state = load(r);
      const chat = state.chats[input.provider_session_id];
      if (!chat) return providerOk(null);
      if (caps().list) {
        // A listing-capable version is asked; absence there means missing.
        const chats = await listed(kind);
        if (!chats.ok) return chats;
        if (!chats.value.some(item => item.id === input.provider_session_id)) return providerOk(null);
      }
      return providerOk(record(state, input.provider_session_id, chat));
    },

    async importSession(input: Readonly<ImportSessionInput>) {
      const kind = backend();
      if (!kind) return unsupported('sessions');
      if (!SAFE_ID.test(input.provider_session_id)) return providerError('invalid_input', 'Not a Cursor session id.');
      if (!path.isAbsolute(input.workspace) || !isDirectory(input.workspace)) return providerError('invalid_input', 'workspace must be an existing absolute directory.');
      const state = load(r);
      const known = state.chats[input.provider_session_id];
      if (known) return providerOk(record(state, input.provider_session_id, known));
      let workspace = input.workspace;
      let title: string | null = null;
      if (caps().list) {
        const chats = await listed(kind);
        if (!chats.ok) return chats;
        const found = chats.value.find(item => item.id === input.provider_session_id);
        if (!found) return providerError('not_found', 'Cursor does not list that session.');
        workspace = found.workspace ?? workspace;
        title = found.title;
      }
      // Without a listing the id is the operator's explicit statement; it is
      // the only way an outside session becomes addressable.
      const now = Date.now();
      state.chats[input.provider_session_id] = { workspace, title, origin: caps().list ? 'listed' : 'imported', created_at: now, updated_at: now, turns: [] };
      save(r, state);
      return providerOk(record(state, input.provider_session_id, state.chats[input.provider_session_id]));
    },

    async readTranscript(input) {
      if (!backend()) return unsupported('transcripts');
      const state = load(r);
      const chat = state.chats[input.provider_session_id];
      if (!chat) return providerError('not_found', 'Unknown Cursor session.');
      const entries: TranscriptEntry[] = [];
      for (const turnId of chat.turns) {
        const meta = state.turns[turnId];
        if (!meta) continue;
        entries.push({ seq: entries.length + 1, role: 'user', text: meta.prompt, at: meta.started_at });
        for (const step of outcome(r, meta).parsed.steps) entries.push({ seq: entries.length + 1, role: step.role, text: step.text, at: step.at });
      }
      const start = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
      const items = entries.slice(start, start + Math.min(input.limit, PAGE));
      const page: ProviderPage<TranscriptEntry> = { items, next_cursor: start + items.length < entries.length ? String(start + items.length) : null };
      return providerOk(page);
    },

    async startSession(input) {
      const kind = backend();
      if (!kind) return unsupported('sessions');
      const state = load(r);
      const again = replay(state, input.idempotency_key);
      if (again) return again;
      if (!path.isAbsolute(input.workspace) || !isDirectory(input.workspace)) return providerError('invalid_input', 'workspace must be an existing absolute directory.');
      const chatId = await createChat(r, kind, input.workspace);
      if (!chatId) return providerError('unavailable', 'Cursor did not create a chat.');
      const fresh = load(r);
      const now = Date.now();
      fresh.chats[chatId] = { workspace: input.workspace, title: null, origin: 'created', created_at: now, updated_at: now, turns: [] };
      return beginTurn(fresh, kind, chatId, input);
    },

    async sendTurn(input) {
      const kind = backend();
      if (!kind) return unsupported('sessions');
      const state = load(r);
      const again = replay(state, input.idempotency_key);
      if (again) return again;
      const chat = state.chats[input.provider_session_id];
      // Never `--resume` an id this provider does not know: Cursor would
      // silently start a fresh chat under it.
      if (!chat) return providerError('not_found', 'Unknown Cursor session.');
      if (chat.turns.some(turnId => state.turns[turnId] && outcome(r, state.turns[turnId]).state === 'running')) return providerError('busy', 'A turn is in flight.');
      return beginTurn(state, kind, input.provider_session_id, input);
    },

    async observeTurn(input) {
      for (;;) {
        const meta = load(r).turns[input.provider_turn_id];
        if (!meta) return providerError('not_found', 'Unknown Cursor turn.');
        const now = outcome(r, meta);
        if (now.state === 'terminal') return providerOk(now.result);
        if (input.signal?.aborted) return providerError('cancelled', 'observe aborted');
        if (typeof input.deadline_at === 'number' && Date.now() >= input.deadline_at) return providerError('timed_out', 'observe deadline');
        await new Promise(done => setTimeout(done, r.pollMs));
      }
    },

    async cancelTurn(input) {
      const state = load(r);
      const meta = state.turns[input.provider_turn_id];
      if (!meta) return providerError('not_found', 'Unknown Cursor turn.');
      if (outcome(r, meta).state === 'terminal') return providerOk('already_terminal');
      meta.cancel_requested_at = Date.now();
      save(r, state);
      if (meta.pid) {
        try { process.kill(-meta.pid, 'SIGTERM'); } catch { /* already gone */ }
        const pid = meta.pid;
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
      }
      return providerOk('cancelled');
    },
  };
}

// The default factory for every runtime connection whose provider is cursor.
export function cursorSessionProviderFactory(connection: { id: string; provider: string }): SessionProvider {
  return createCursorSessionProvider(connection);
}
