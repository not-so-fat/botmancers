// NOT-503: one transport-neutral contract for the native sessions a
// coding-agent runtime holds, whether or not Botmancers created them.
//
// A SessionProvider is selected by a registered Agent's runtime connection
// (bots.runtime_connection_id, lib/agent-registration), never by Agent
// Deck. It discovers, reads, starts, resumes, observes, and cancels
// sessions on that runtime and reports facts only: it never chooses
// orchestration, never widens authority, never stores Botmancers state,
// and never writes conversation messages. Grants, scope, authority,
// idempotency, audit, and the session registry belong to Botmancers
// (./provider-sessions). AttemptAdapter (./attempt-adapter) stays the
// per-turn seam of the Work Request engine; a provider may implement its
// turns with one, or with a provider-native turn handle as here.
//
// Provider session and turn identifiers are opaque: Botmancers stores them
// privately and hands them back verbatim, never parses or synthesizes them,
// and never returns them in a normal API, MCP, or UI response.
import type { AttemptCorrelation } from './attempt-adapter';
import type { ScopeKind } from './agent-registration';

// Capabilities are data, not assumptions: each provider says what it can
// do, and Botmancers refuses an unsupported operation before calling it.
export const SESSION_PROVIDER_CAPABILITIES = ['list', 'search', 'read', 'resume', 'start', 'cancel', 'usage'] as const;
export type SessionProviderCapability = (typeof SESSION_PROVIDER_CAPABILITIES)[number];

// The authority a turn runs with. Always explicit on every start/send; a
// provider never infers it from the runtime or the workspace.
export const SESSION_AUTHORITIES = ['read_only', 'workspace_write'] as const;
export type SessionAuthority = (typeof SESSION_AUTHORITIES)[number];

export interface SessionProviderCapabilities {
  list: boolean;
  search: boolean;
  read: boolean;
  resume: boolean;
  start: boolean;
  cancel: boolean;
  usage: boolean;
  // The authority modes the runtime can enforce. A mode not listed is
  // refused, never downgraded or upgraded.
  authorities: SessionAuthority[];
  // The largest list/transcript page the provider returns. Botmancers clamps
  // every request to it.
  max_page_size: number;
}

// Independent session facts. Availability and lifecycle are the
// provider's; resumable is what the provider says about continuing it (an
// archived or long-idle session may still be resumable); busy is whether a
// turn is in flight right now.
export type SessionAvailability = 'available' | 'missing';
export type SessionLifecycle = 'open' | 'archived';

export interface ProviderSessionRecord {
  // Opaque provider identifier. Private to Botmancers.
  provider_session_id: string;
  title: string | null;
  // Absolute workspace the session runs in, when the provider knows it.
  workspace: string | null;
  created_at: number | null;
  updated_at: number | null;
  lifecycle: SessionLifecycle;
  resumable: boolean;
  busy: boolean;
}

// The registered scope, translated for the provider. For a 'sessions'
// scope the list holds the provider ids of the selected Botmancers refs.
// Botmancers re-checks every returned record against it regardless.
export interface ProviderScope {
  kind: ScopeKind;
  workspaces: string[];
  provider_session_ids: string[];
}

export interface ProviderPage<T> {
  items: T[];
  // Opaque continuation, or null on the last page.
  next_cursor: string | null;
}

export interface TranscriptEntry {
  // Stable per session; ordering key within the transcript.
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  at: number | null;
}

export interface ProviderCallContext {
  signal?: AbortSignal | null;
  // Epoch ms after which the call is abandoned.
  deadline_at?: number | null;
  correlation: AttemptCorrelation;
}

export interface ListSessionsInput extends ProviderCallContext {
  scope: ProviderScope;
  // Free-text search; only with the 'search' capability.
  query?: string | null;
  cursor?: string | null;
  limit: number;
}

export interface ReadTranscriptInput extends ProviderCallContext {
  provider_session_id: string;
  cursor?: string | null;
  limit: number;
}

// NOT-517: lets a provider mint the launch-bound session context
// (lib/session-context) for a launch it is about to make. mint answers null
// when the owner has share_from_turn off. A provider with no per-launch MCP
// seam (Cursor) never calls it.
export interface SessionContextLaunchRequest {
  kind: 'claude_turn' | 'codex_thread_load' | 'codex_exec';
  ref: string;
  // The launch cannot outlive this Botmancers process (an app-server load).
  processBound?: boolean;
}

// A minted context as the provider sees it: the secret for its launch
// arguments only, and end() for when the launch ends (thread unload,
// app-server exit, a launch that never happened).
export interface MintedLaunchContext {
  token: string;
  url: string;
  end(reason: 'thread_unload' | 'app_server_exit' | 'launch_failed'): void;
}

export interface SessionContextMinter {
  mint(launch: SessionContextLaunchRequest): MintedLaunchContext | null;
}

interface TurnInputBase extends ProviderCallContext {
  prompt: string;
  authority: SessionAuthority;
  // Botmancers' idempotency key for this turn. A provider that sees the same
  // key twice returns the original turn instead of starting another.
  idempotency_key: string;
  session_context?: SessionContextMinter | null;
}

export interface StartSessionInput extends TurnInputBase {
  // Explicit, absolute. Botmancers has already checked it against scope.
  workspace: string;
}

export interface SendTurnInput extends TurnInputBase {
  provider_session_id: string;
}

export interface ProviderTurnHandle {
  // Opaque provider turn identifier. Private to Botmancers.
  provider_turn_id: string;
  provider_session_id: string;
}

export interface ObserveTurnInput extends ProviderCallContext {
  provider_turn_id: string;
}

// What the runtime itself reported for one turn. Every field is nullable:
// an absent or malformed value is unknown, never zero or an estimate.
// cached_input_tokens (NOT-504, Codex) is a subset of input_tokens, present
// only for runtimes that report it.
export interface ProviderUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens?: number | null;
  cost_usd?: number | null;
}

export type ProviderTurnUsage = ProviderUsage;

export interface ProviderTurnResult {
  status: 'completed' | 'failed' | 'cancelled';
  provider_session_id: string;
  output: string | null;
  // no_output (NOT-560): the runtime process ended having written nothing
  // at all, so the cause is likely its environment; the core logs its own
  // process context for it.
  failure: { code: string; message: string; no_output?: boolean } | null;
  // What the runtime reported, never estimated: each field is null when the
  // runtime did not report it (or reported something malformed), and an
  // explicit zero stays zero; Botmancers never infers a price from tokens.
  // Besides ProviderUsage / ProviderReportedUsage, lib/usage usageFromEvent
  // (NOT-509) also accepts a Codex turn.completed or a Claude/Cursor result
  // event here.
  usage?: ProviderReportedUsage | ProviderUsage | Record<string, unknown> | null;
  finished_at: number;
}

// NOT-506: the Claude Code provider's shape: total_cost_usd is the
// runtime's own figure.
export interface ProviderReportedUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost_usd?: number | null;
}

// NOT-505: an operator-named session for a provider that cannot enumerate
// its sessions. The provider confirms what it can (and must refuse what it
// knows is absent); Botmancers checks the result against scope.
export interface ImportSessionInput extends ProviderCallContext {
  provider_session_id: string;
  // Explicit, absolute.
  workspace: string;
}

export interface CancelTurnInput extends ProviderCallContext {
  provider_turn_id: string;
}

// cancelled: this call stopped the turn. already_terminal: it had already
// ended (a repeated cancel lands here, so cancel is idempotent).
export type ProviderCancelOutcome = 'cancelled' | 'already_terminal';

export type ProviderErrorCode =
  | 'unsupported'
  | 'unsupported_authority'
  | 'not_found'
  | 'unavailable'
  // The runtime is installed and reachable but not signed in.
  | 'auth_required'
  | 'invalid_input'
  | 'busy'
  | 'not_resumable'
  | 'cancelled'
  | 'timed_out'
  // NOT-506: runtime-reported refusals with a stable meaning. None of them
  // is ever answered by starting a different session.
  | 'auth_required'
  | 'permission_denied'
  | 'incompatible_version'
  | 'usage_limit';

export interface ProviderError {
  code: ProviderErrorCode;
  // Internal diagnostic text; never shown verbatim to a caller.
  message: string;
  // See ProviderTurnResult.failure.no_output.
  no_output?: boolean;
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export interface SessionProvider {
  // Stable provider kind (for example 'fake-direct'); recorded on the
  // registry row, never used to infer authority.
  readonly kind: string;
  capabilities(): SessionProviderCapabilities;
  // Optional readiness check, awaited before every call. A provider that
  // learns its capabilities at runtime (an installed-version probe) does it
  // here; capabilities() reflects the result afterwards. An error
  // (unavailable, unsupported, auth_required) refuses the call.
  ready?(input: Readonly<ProviderCallContext>): Promise<ProviderResult<void>>;
  listSessions(input: Readonly<ListSessionsInput>): Promise<ProviderResult<ProviderPage<ProviderSessionRecord>>>;
  // ok with null value: the provider no longer has the session (missing).
  getSession(input: Readonly<ProviderCallContext & { provider_session_id: string }>): Promise<ProviderResult<ProviderSessionRecord | null>>;
  readTranscript(input: Readonly<ReadTranscriptInput>): Promise<ProviderResult<ProviderPage<TranscriptEntry>>>;
  startSession(input: Readonly<StartSessionInput>): Promise<ProviderResult<ProviderTurnHandle>>;
  sendTurn(input: Readonly<SendTurnInput>): Promise<ProviderResult<ProviderTurnHandle>>;
  // Resolves once the turn is terminal (or the signal/deadline fires, as
  // a 'cancelled' / 'timed_out' error that leaves the turn running).
  observeTurn(input: Readonly<ObserveTurnInput>): Promise<ProviderResult<ProviderTurnResult>>;
  cancelTurn(input: Readonly<CancelTurnInput>): Promise<ProviderResult<ProviderCancelOutcome>>;
  // Optional: register one explicitly named session (see ImportSessionInput).
  importSession?(input: Readonly<ImportSessionInput>): Promise<ProviderResult<ProviderSessionRecord>>;
}

// A reported count or cost is kept only when it is a finite, non-negative
// number; anything else (absent, a string, negative) stays null.
export function normalizeUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const cost = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    input_tokens: count(value.input_tokens), output_tokens: count(value.output_tokens),
    ...('cached_input_tokens' in value ? { cached_input_tokens: count(value.cached_input_tokens) } : {}),
    cost_usd: cost(value.cost_usd),
  };
}

export function providerError(code: ProviderErrorCode, message: string): { ok: false; error: ProviderError } {
  return { ok: false, error: { code, message: message.slice(0, 500) } };
}

export function providerOk<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

// Defensive copy of what a provider reported: unknown keys dropped, bad
// values refused, page size clamped, authorities filtered to known modes.
export function normalizeCapabilities(raw: Partial<SessionProviderCapabilities> | null | undefined): SessionProviderCapabilities {
  const flag = (value: unknown) => value === true;
  const size = Number(raw?.max_page_size);
  return {
    list: flag(raw?.list),
    search: flag(raw?.search),
    read: flag(raw?.read),
    resume: flag(raw?.resume),
    start: flag(raw?.start),
    cancel: flag(raw?.cancel),
    usage: flag(raw?.usage),
    authorities: SESSION_AUTHORITIES.filter(mode => Array.isArray(raw?.authorities) && raw.authorities.includes(mode)),
    max_page_size: Number.isInteger(size) && size > 0 ? Math.min(size, MAX_PROVIDER_PAGE) : DEFAULT_PROVIDER_PAGE,
  };
}

export const DEFAULT_PROVIDER_PAGE = 25;
export const MAX_PROVIDER_PAGE = 100;

// ---- provider selection ----
//
// Providers register per runtime connection id, or per connection provider
// (codex, claude, ...) as the fallback for every connection of that kind.
// Real runtime adapters register their provider kind from
// ./provider-sessions (NOT-506 Claude Code: ./claude-session-provider, as a
// built-in; NOT-505 Cursor: ./cursor-session-provider; NOT-504 Codex:
// ./codex-session-provider, as a built-in). A connection
// without a provider has no native-session support;
// Botmancers-launched sessions stay in the catalog either way.

export type SessionProviderFactory = (connection: { id: string; provider: string }) => SessionProvider;

const byConnection = new Map<string, SessionProviderFactory>();
const byProviderKind = new Map<string, SessionProviderFactory>();
const builtins = new Map<string, SessionProviderFactory>();

export function registerSessionProvider(target: { connectionId: string } | { provider: string }, factory: SessionProviderFactory | null): void {
  const map = 'connectionId' in target ? byConnection : byProviderKind;
  const key = 'connectionId' in target ? target.connectionId : target.provider;
  if (factory) map.set(key, factory);
  else map.delete(key);
}

// The default adapter for every connection of a provider kind, used when
// nothing more specific is registered.
export function registerBuiltinSessionProvider(provider: string, factory: SessionProviderFactory): void {
  builtins.set(provider, factory);
}

// Clears explicit registrations; { builtins: true } also drops the built-in
// adapters (tests that must never reach a real runtime).
export function clearSessionProviders(options: { builtins?: boolean } = {}): void {
  byConnection.clear();
  byProviderKind.clear();
  if (options.builtins) builtins.clear();
}

export function sessionProviderFor(connection: { id: string; provider: string } | null | undefined): SessionProvider | null {
  if (!connection) return null;
  const factory = byConnection.get(connection.id) ?? byProviderKind.get(connection.provider) ?? builtins.get(connection.provider);
  return factory ? factory(connection) : null;
}
