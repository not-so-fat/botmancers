// NOT-503: Botmancers' side of the SessionProvider boundary
// (./session-provider). The provider-session registry (engine migration 17,
// provider_sessions) gives every native runtime session a stable Botmancers
// reference: a Session Binding keeps its own id, a discovered or started
// session gets a new one. The provider session id is stored privately and
// never leaves this module except through providerSessionDebugId (the
// owner-only local debug disclosure) and the service redactor's id list.
//
// Everything a provider must not decide lives here: the registered scope
// (lib/agent-registration session_scope), launch policy (authority is
// always the caller's explicit choice, checked against the Agent's policy
// and the provider's capabilities, never inferred from the runtime or the
// workspace), idempotency (provider_session_turns), and audit
// (provider_session_events). The provider is selected by the Agent's
// runtime connection; Agent Deck is never consulted.
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import {
  readStoredPolicy,
  readStoredScope,
  workspaceContains,
  type LaunchPolicy,
  type SessionScope,
} from './agent-registration';
import {
  normalizeCapabilities,
  normalizeUsage,
  registerSessionProvider,
  sessionProviderFor,
  type ProviderCallContext,
  type ProviderError,
  type ProviderScope,
  type ProviderSessionRecord,
  type ProviderTurnResult,
  type SessionAuthority,
  type SessionAvailability,
  type SessionLifecycle,
  type SessionProvider,
  type SessionProviderCapabilities,
  type SessionProviderCapability,
  type TranscriptEntry,
  type ProviderReportedUsage,
} from './session-provider';
import { registerBuiltinSessionProvider } from './session-provider';
import { createClaudeSessionProvider } from './claude-session-provider';
import { createMuseSessionProvider } from './muse-session-provider';
import type { AttemptCorrelation } from './attempt-adapter';
// NOT-504: installs the direct Codex provider as the default for 'codex'
// runtime connections (an explicit registration still wins).
import './codex-session-provider';
import { usageFromEvent, type NormalizedUsage } from './usage';
import { recordTurnUsageSample } from './usage-samples';
import { CURSOR_PROVIDER_KIND, cursorSessionProviderFactory } from './cursor-session-provider';
import { attachSessionContextsToTurn, bindSessionContext, endSessionContext, endTurnSessionContexts, mintSessionContext } from './session-context';
import type { SessionContextMinter } from './session-provider';

// NOT-506: a registered Claude Code Agent talks to the local `claude` CLI
// directly (lib/claude-session-provider), with no Agent Deck.
registerBuiltinSessionProvider('claude', () => createClaudeSessionProvider());

type Db = Database.Database;

// NOT-505: every Cursor runtime connection gets the direct Cursor CLI/SDK
// provider unless a connection-specific provider is registered.
registerSessionProvider({ provider: CURSOR_PROVIDER_KIND }, cursorSessionProviderFactory);

// NOT-508: Muse connections get the direct MSP provider (lib/muse-session-provider)
// by default; Agent Deck is not consulted.
registerBuiltinSessionProvider('muse', connection => createMuseSessionProvider(connection.id));

export type ProviderSessionErrorCode =
  | 'agent_not_found'
  | 'session_not_found'
  | 'turn_not_found'
  | 'provider_unavailable'
  | 'auth_required'
  | 'unsupported'
  | 'scope_missing'
  | 'out_of_scope'
  | 'authority_not_allowed'
  | 'new_sessions_not_allowed'
  | 'invalid_input'
  | 'idempotency_conflict'
  | 'session_missing'
  | 'not_resumable'
  | 'busy'
  | 'provider_failed'
  // NOT-506: stable runtime refusals (see ProviderErrorCode).
  | 'auth_required'
  | 'permission_denied'
  | 'incompatible_version'
  | 'usage_limit';

export class ProviderSessionError extends Error {
  readonly code: ProviderSessionErrorCode;
  constructor(code: ProviderSessionErrorCode, message: string) {
    super(message);
    this.name = 'ProviderSessionError';
    this.code = code;
  }
}

export interface ProviderSessionRow {
  id: string;
  agent_id: string;
  runtime_connection_id: string;
  provider_kind: string;
  provider_session_id: string;
  binding_id: string | null;
  origin: 'binding' | 'discovered' | 'started';
  title: string | null;
  workspace: string | null;
  provider_created_at: number | null;
  provider_updated_at: number | null;
  availability: SessionAvailability;
  lifecycle: SessionLifecycle;
  resumable: number | null;
  busy: number;
  capabilities: string | null;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

export type TurnState = 'running' | 'completed' | 'failed' | 'cancelled';

interface TurnRow {
  id: string;
  session_ref: string;
  agent_id: string;
  kind: 'start' | 'send';
  authority: SessionAuthority;
  requester_kind: string;
  requester_id: string;
  idempotency_key: string;
  request_hash: string;
  provider_turn_id: string;
  state: TurnState;
  output: string | null;
  failure_code: string | null;
  correlation: string;
  created_at: number;
  finished_at: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost_usd: number | null;
}

// The public turn shape: Botmancers references only.
export interface ProviderTurnView {
  turn_ref: string;
  session_ref: string;
  kind: 'start' | 'send';
  authority: SessionAuthority;
  state: TurnState;
  output: string | null;
  failure_code: string | null;
  // As the runtime reported it (null: not reported); null until terminal.
  usage: ProviderReportedUsage | null;
  created_at: number;
  finished_at: number | null;
}

export interface Requester {
  kind: 'person' | 'bot' | 'service';
  id: string;
}

const TITLE_LIMIT = 80;
const PROMPT_LIMIT = 20_000;
const KEY_LIMIT = 200;

// ---- Agent context ----

interface AgentContext {
  agentId: string;
  connection: { id: string; provider: string };
  provider: SessionProvider;
  capabilities: SessionProviderCapabilities;
  scope: SessionScope | null;
  policy: LaunchPolicy | null;
}

interface BotRegistrationRow {
  id: string;
  runtime_connection_id: string | null;
  session_scope_kind: string | null;
  session_scope_items: string | null;
  policy_mode: string | null;
  allow_new_sessions: number | null;
  allow_resume_with_edits: number | null;
}

function agentContext(db: Db, agentId: string): AgentContext {
  const bot = db.prepare(`
    SELECT id, runtime_connection_id, session_scope_kind, session_scope_items, policy_mode, allow_new_sessions, allow_resume_with_edits
    FROM bots WHERE id = ?
  `).get(agentId) as BotRegistrationRow | undefined;
  if (!bot) throw new ProviderSessionError('agent_not_found', 'No such Agent.');
  const connection = bot.runtime_connection_id
    ? db.prepare('SELECT id, provider FROM runtime_connections WHERE id = ?').get(bot.runtime_connection_id) as { id: string; provider: string } | undefined
    : undefined;
  const provider = connection ? sessionProviderFor(connection) : null;
  if (!connection || !provider) {
    throw new ProviderSessionError('provider_unavailable', 'The Agent\'s runtime connection has no session provider.');
  }
  return {
    agentId,
    connection,
    provider,
    capabilities: normalizeCapabilities(provider.capabilities()),
    scope: readStoredScope(bot),
    policy: readStoredPolicy(bot),
  };
}

// agentContext plus the provider's readiness check (an installed-version
// probe, for example). Capabilities are re-read once the provider is ready.
async function readyContext(db: Db, agentId: string, input: { correlation?: AttemptCorrelation | null; signal?: AbortSignal | null; deadlineAt?: number | null } = {}): Promise<AgentContext> {
  const ctx = agentContext(db, agentId);
  if (!ctx.provider.ready) return ctx;
  const ready = await ctx.provider.ready(callContext(input));
  if (!ready.ok) failWith(ready.error);
  return { ...ctx, capabilities: normalizeCapabilities(ctx.provider.capabilities()) };
}

function requireCapability(ctx: AgentContext, capability: SessionProviderCapability): void {
  if (!ctx.capabilities[capability]) {
    throw new ProviderSessionError('unsupported', `The session provider does not support ${capability}.`);
  }
}

function requireScope(ctx: AgentContext): SessionScope {
  // An unconfigured scope is never unrestricted: nothing is imported.
  if (!ctx.scope) throw new ProviderSessionError('scope_missing', 'The Agent has no session scope.');
  return ctx.scope;
}

function clampLimit(ctx: AgentContext, limit: number | null | undefined): number {
  const n = Number(limit ?? ctx.capabilities.max_page_size);
  if (!Number.isInteger(n) || n < 1) throw new ProviderSessionError('invalid_input', 'limit must be a positive integer.');
  return Math.min(n, ctx.capabilities.max_page_size);
}

function failWith(error: ProviderError, fallback: ProviderSessionErrorCode = 'provider_failed'): never {
  const code: ProviderSessionErrorCode = error.code === 'unsupported' ? 'unsupported'
    : error.code === 'unsupported_authority' ? 'authority_not_allowed'
      : error.code === 'not_found' ? 'session_missing'
        : error.code === 'busy' ? 'busy'
          : error.code === 'not_resumable' ? 'not_resumable'
            : error.code === 'invalid_input' ? 'invalid_input'
              : error.code === 'unavailable' ? 'provider_unavailable'
                : error.code === 'auth_required' || error.code === 'permission_denied'
                  || error.code === 'incompatible_version' || error.code === 'usage_limit' ? error.code
                  : fallback;
  // Provider diagnostics never reach the caller verbatim.
  throw new ProviderSessionError(code, `The session provider refused the call (${error.code}).`);
}

function callContext(input: { correlation?: AttemptCorrelation | null; signal?: AbortSignal | null; deadlineAt?: number | null }): ProviderCallContext {
  return { correlation: { ...(input.correlation ?? {}) }, signal: input.signal ?? null, deadline_at: input.deadlineAt ?? null };
}

// NOT-517: the session-context minter one turn hands its provider
// (lib/session-context). The provider decides whether its launch is a new
// one (a Codex resume of an already loaded thread is not); Botmancers binds
// the contexts of a start launch to the session once it is recorded, links
// them to the turn (a per-turn launch ends with it), and ends them if the
// launch never happened.
function contextMinter(agentId: string, sessionRef: string | null): {
  minter: SessionContextMinter;
  minted: string[];
  record: (sessionRef: string, turnRef: string) => void;
  abandon: () => void;
} {
  const minted: string[] = [];
  return {
    minted,
    minter: {
      mint: launch => {
        const context = mintSessionContext({ agentId, sessionRef, launch: { kind: launch.kind, ref: launch.ref }, processBound: launch.processBound === true });
        if (!context) return null;
        minted.push(context.id);
        const id = context.id;
        return { token: context.token, url: context.url, end: reason => { endSessionContext(id, reason); } };
      },
    },
    record: (ref, turnRef) => {
      for (const id of minted) bindSessionContext(id, ref);
      attachSessionContextsToTurn(minted, turnRef);
    },
    abandon: () => {
      for (const id of minted) endSessionContext(id, 'launch_failed');
    },
  };
}

// ---- registry ----

const ROW_SELECT = 'SELECT * FROM provider_sessions';

export function getProviderSessionRow(db: Db, agentId: string, ref: string): ProviderSessionRow | undefined {
  return db.prepare(`${ROW_SELECT} WHERE id = ? AND agent_id = ?`).get(ref, agentId) as ProviderSessionRow | undefined;
}

function requireSession(db: Db, agentId: string, ref: string): ProviderSessionRow {
  const row = getProviderSessionRow(db, agentId, ref);
  // Unknown and foreign references are indistinguishable.
  if (!row) throw new ProviderSessionError('session_not_found', 'No session with that reference.');
  return row;
}

function appendEvent(db: Db, event: { agentId: string; sessionRef?: string | null; turnId?: string | null; type: string; detail?: Record<string, unknown>; now: number }): void {
  db.prepare('INSERT INTO provider_session_events (id, agent_id, session_ref, turn_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), event.agentId, event.sessionRef ?? null, event.turnId ?? null, event.type, JSON.stringify(event.detail ?? {}), event.now);
}

function excerpt(text: string | null | undefined): string | null {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(part => part.length > 0);
  if (!line) return null;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line;
}

function absoluteWorkspace(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') ? value : null;
}

// Whether a provider-reported session is inside the registered scope. A
// 'sessions' scope admits exactly the selected references' provider ids.
function inScope(scope: SessionScope, record: { workspace: string | null; provider_session_id: string }, selectedProviderIds: Set<string>): boolean {
  if (scope.kind === 'all_provider_sessions') return true;
  if (scope.kind === 'sessions') return selectedProviderIds.has(record.provider_session_id);
  const workspace = absoluteWorkspace(record.workspace);
  return workspace !== null && scope.workspaces.some(root => workspaceContains(root, workspace));
}

function selectedProviderIds(db: Db, ctx: AgentContext, scope: SessionScope): Set<string> {
  if (scope.kind !== 'sessions' || scope.sessions.length === 0) return new Set();
  const rows = db.prepare(`
    SELECT provider_session_id FROM provider_sessions
    WHERE agent_id = ? AND runtime_connection_id = ? AND id IN (SELECT value FROM json_each(?))
  `).all(ctx.agentId, ctx.connection.id, JSON.stringify(scope.sessions)) as { provider_session_id: string }[];
  return new Set(rows.map(row => row.provider_session_id));
}

function providerScope(scope: SessionScope, selected: Set<string>): ProviderScope {
  return { kind: scope.kind, workspaces: [...scope.workspaces], provider_session_ids: [...selected] };
}

// The registry row a provider session maps to for this Agent and
// connection: the unlinked native row when there is one, else the newest
// Botmancers-launched row (a binding) reporting that provider id. One
// provider session therefore keeps one reference across syncs.
function findRow(db: Db, ctx: AgentContext, providerSessionId: string): ProviderSessionRow | undefined {
  return db.prepare(`
    ${ROW_SELECT} WHERE agent_id = ? AND runtime_connection_id = ? AND provider_session_id = ?
    ORDER BY (binding_id IS NULL) DESC, created_at DESC, id DESC LIMIT 1
  `).get(ctx.agentId, ctx.connection.id, providerSessionId) as ProviderSessionRow | undefined;
}

// Insert-or-update one provider record. Returns the reference and whether
// it was new. Identity columns never change; facts are overwritten with
// what the provider reported now.
function upsertRecord(
  db: Db, ctx: AgentContext, record: ProviderSessionRecord, origin: 'discovered' | 'started', now: number, fallbackTitle: string | null = null,
): { ref: string; created: boolean } {
  const existing = findRow(db, ctx, record.provider_session_id);
  if (existing) {
    updateRow(db, ctx, existing.id, record, now);
    return { ref: existing.id, created: false };
  }
  const ref = randomUUID();
  db.prepare(`
    INSERT INTO provider_sessions (
      id, agent_id, runtime_connection_id, provider_kind, provider_session_id, binding_id, origin, title, workspace,
      provider_created_at, provider_updated_at, availability, lifecycle, resumable, busy, capabilities, last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref, ctx.agentId, ctx.connection.id, ctx.provider.kind, record.provider_session_id, origin,
    excerpt(record.title) ?? fallbackTitle, absoluteWorkspace(record.workspace), record.created_at, record.updated_at,
    record.lifecycle === 'archived' ? 'archived' : 'open', record.resumable ? 1 : 0, record.busy ? 1 : 0, JSON.stringify(ctx.capabilities), now, now, now,
  );
  return { ref, created: true };
}

// Overwrites one row's provider facts with what the provider reported now.
function updateRow(db: Db, ctx: AgentContext, id: string, record: ProviderSessionRecord, now: number): void {
  db.prepare(`
    UPDATE provider_sessions SET title = COALESCE(?, title), workspace = COALESCE(?, workspace),
      provider_created_at = COALESCE(?, provider_created_at), provider_updated_at = COALESCE(?, provider_updated_at),
      availability = 'available', lifecycle = ?, resumable = ?, busy = ?, capabilities = ?, last_synced_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    excerpt(record.title), absoluteWorkspace(record.workspace), record.created_at, record.updated_at,
    record.lifecycle === 'archived' ? 'archived' : 'open', record.resumable ? 1 : 0, record.busy ? 1 : 0, JSON.stringify(ctx.capabilities), now, now, id,
  );
}

function markMissing(db: Db, row: ProviderSessionRow, now: number): void {
  if (row.availability === 'missing') {
    db.prepare('UPDATE provider_sessions SET last_synced_at = ? WHERE id = ?').run(now, row.id);
    return;
  }
  // Missing is a fact about the provider, never a deletion.
  db.prepare("UPDATE provider_sessions SET availability = 'missing', busy = 0, last_synced_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
  appendEvent(db, { agentId: row.agent_id, sessionRef: row.id, type: 'session_missing', now });
}

// ---- discovery ----

export interface ProviderCapabilitiesView extends SessionProviderCapabilities {
  provider_kind: string;
  // Whether a session can be named explicitly (importProviderSession).
  explicit_import: boolean;
}

// Capability discovery for the Agent's runtime connection, or null when the
// connection has no session provider.
// NOT-507: a runtime may learn its capabilities only once it is probed
// (lib/codex-session-provider after a Botmancers restart). Probes it, bounded,
// so session actions are judged on the runtime's real capabilities; a
// runtime that is not ready simply keeps reporting what it can do now.
const WARM_TIMEOUT_MS = 10_000;

export async function warmAgentProvider(db: Db, agentId: string, options: { onlyWithSessions?: boolean } = {}): Promise<void> {
  // A listing only needs the probe when a session could take the provider
  // route; it never starts a runtime for an Agent with none.
  if (options.onlyWithSessions && !db.prepare('SELECT 1 FROM provider_sessions WHERE agent_id = ? LIMIT 1').get(agentId)) return;
  let ctx: AgentContext;
  try {
    ctx = agentContext(db, agentId);
  } catch {
    return;
  }
  if (!ctx.provider.ready) return;
  try {
    await ctx.provider.ready(callContext({ deadlineAt: Date.now() + WARM_TIMEOUT_MS }));
  } catch {
    // Not ready: availability says so from the capabilities it reports.
  }
}

export function agentProviderCapabilities(db: Db, agentId: string): ProviderCapabilitiesView | null {
  try {
    const ctx = agentContext(db, agentId);
    return { provider_kind: ctx.provider.kind, ...ctx.capabilities, explicit_import: typeof ctx.provider.importSession === 'function' };
  } catch (error) {
    if (error instanceof ProviderSessionError && error.code === 'provider_unavailable') return null;
    throw error;
  }
}

export interface SyncResult {
  imported: string[];
  updated: string[];
  // Count only: an out-of-scope record is never stored or named.
  rejected_out_of_scope: number;
  // Opaque provider continuation for the next page, or null.
  next_cursor: string | null;
}

export interface SyncInput {
  query?: string | null;
  cursor?: string | null;
  limit?: number | null;
  correlation?: AttemptCorrelation | null;
  signal?: AbortSignal | null;
  deadlineAt?: number | null;
  now?: number;
  // Internal: syncAgentSessionHistory passes a collector so the full-history
  // sync can reconcile sessions the provider no longer reports. Provider ids
  // stay in this set (server memory only); they never enter SyncResult.
  seenCollector?: Set<string>;
}

export interface SessionHistorySyncResult extends SyncResult {
  pages: number;
  // False only when a provider repeats a cursor or exceeds the safety bound.
  complete: boolean;
}

const MAX_HISTORY_SYNC_PAGES = 1_000;

// Imports one bounded page of the provider's sessions inside the registered
// scope. Repeating it imports nothing twice: each provider session maps to
// one reference (findRow), and the partial unique index backs that up.
export async function syncAgentSessions(db: Db, agentId: string, input: SyncInput = {}): Promise<SyncResult> {
  const ctx = await readyContext(db, agentId, input);
  requireCapability(ctx, 'list');
  const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim().slice(0, 200) : null;
  if (query) requireCapability(ctx, 'search');
  const scope = requireScope(ctx);
  const selected = selectedProviderIds(db, ctx, scope);
  const limit = clampLimit(ctx, input.limit);
  const result = await ctx.provider.listSessions({
    ...callContext(input), scope: providerScope(scope, selected), query, cursor: input.cursor ?? null, limit,
  });
  if (!result.ok) failWith(result.error);
  const now = input.now ?? Date.now();
  // A provider returning more than asked is cut to the bound.
  const records = result.value.items.slice(0, limit);
  return db.transaction(() => {
    const out: SyncResult = { imported: [], updated: [], rejected_out_of_scope: 0, next_cursor: result.value.next_cursor ?? null };
    for (const record of records) {
      if (!record || typeof record.provider_session_id !== 'string' || !record.provider_session_id) continue;
      // Tracked before the scope check: a stored row whose provider id was
      // reported (even out of scope by its reported workspace) is still
      // reported, not missing. The empty-listing guard also counts these.
      if (input.seenCollector) input.seenCollector.add(record.provider_session_id);
      if (!inScope(scope, record, selected)) { out.rejected_out_of_scope++; continue; }
      const { ref, created } = upsertRecord(db, ctx, record, 'discovered', now);
      (created ? out.imported : out.updated).push(ref);
      appendEvent(db, { agentId, sessionRef: ref, type: created ? 'session_imported' : 'session_synced', now });
    }
    if (out.rejected_out_of_scope > 0) {
      appendEvent(db, { agentId, type: 'sync_rejected_out_of_scope', detail: { count: out.rejected_out_of_scope }, now });
    }
    return out;
  }).immediate();
}

// Imports every page the provider exposes. Registration (through
// syncHistoryAtRegistration) uses this so an Agent begins with its in-scope
// local history instead of an empty catalog. A cursor loop or an
// implausibly large provider listing is stopped without turning
// registration into an unbounded operation.
//
// NOT-546: after a complete full-history sync, stored discovered sessions
// the provider no longer reports are marked missing (never deleted), one
// session_missing event per row. A session the provider reports again
// returns to available through the normal upsert (updateRow). Binding and
// started rows are never touched, and sessions-scope Agents are not
// reconciled (they fetch by id). Three guards skip the marking with an
// event and no state change: an incomplete sync (sync_incomplete_guarded),
// a listing error (sync_error_guarded), and an empty listing while stored
// rows exist (sync_empty_guarded).
export async function syncAgentSessionHistory(db: Db, agentId: string, input: SyncInput = {}): Promise<SessionHistorySyncResult> {
  const imported: string[] = [];
  const updated: string[] = [];
  let rejected = 0;
  let cursor = input.cursor ?? null;
  const initialCursor = cursor;
  const hasQuery = typeof input.query === 'string' && input.query.trim().length > 0;
  let pages = 0;
  const seen = new Set<string>();
  const seenProviderIds = new Set<string>();
  const now = input.now ?? Date.now();

  while (pages < MAX_HISTORY_SYNC_PAGES) {
    if (cursor !== null) {
      if (seen.has(cursor)) {
        appendEvent(db, { agentId, type: 'sync_incomplete_guarded', detail: { pages, reason: 'cursor_loop' }, now });
        return { imported, updated, rejected_out_of_scope: rejected, next_cursor: cursor, pages, complete: false };
      }
      seen.add(cursor);
    }
    let page: SyncResult;
    try {
      page = await syncAgentSessions(db, agentId, { ...input, cursor, seenCollector: seenProviderIds });
    } catch (error) {
      // Configuration failures never listed anything: no guard event, the
      // caller's outcome (unsupported/empty) stands. Any other failure
      // means the listing broke: record the guard, then rethrow so the
      // caller still reports the failure. provider_unavailable and
      // invalid_input come from both sides, so they are disambiguated: no
      // provider (or a bad caller limit) is configuration, otherwise the
      // provider's listing (or readiness probe) failed.
      if (error instanceof ProviderSessionError) {
        if (error.code === 'agent_not_found' || error.code === 'scope_missing' || error.code === 'unsupported') {
          throw error;
        }
        if (error.code === 'provider_unavailable') {
          try {
            agentContext(db, agentId);
          } catch {
            throw error;
          }
        } else if (error.code === 'invalid_input' && input.limit !== undefined && input.limit !== null) {
          const n = Number(input.limit);
          if (!Number.isInteger(n) || n < 1) throw error;
        }
      }
      const errorCode = error instanceof ProviderSessionError ? error.code : 'provider_failed';
      appendEvent(db, { agentId, type: 'sync_error_guarded', detail: { error_code: errorCode, pages }, now });
      throw error;
    }
    imported.push(...page.imported);
    updated.push(...page.updated);
    rejected += page.rejected_out_of_scope;
    pages++;
    cursor = page.next_cursor;
    if (cursor === null) {
      reconcileMissingSessions(db, agentId, { seenProviderIds, hasQuery, initialCursor, now });
      return { imported, updated, rejected_out_of_scope: rejected, next_cursor: null, pages, complete: true };
    }
  }

  appendEvent(db, { agentId, type: 'sync_incomplete_guarded', detail: { pages, reason: 'page_cap' }, now });
  return { imported, updated, rejected_out_of_scope: rejected, next_cursor: cursor, pages, complete: false };
}

// NOT-546: marks the Agent's discovered rows the completed sync did not
// report as missing. No-op (no event, no state change) for a filtered sync
// (query or resumed cursor), for a sessions scope, and when the listing
// returned nothing while stored rows exist (sync_empty_guarded).
function reconcileMissingSessions(
  db: Db, agentId: string,
  tracking: { seenProviderIds: Set<string>; hasQuery: boolean; initialCursor: string | null; now: number },
): void {
  if (tracking.hasQuery || tracking.initialCursor !== null) return;
  let ctx: AgentContext;
  try {
    ctx = agentContext(db, agentId);
  } catch {
    return;
  }
  const scope = ctx.scope;
  if (!scope || scope.kind === 'sessions') return;
  const stored = (db.prepare(`
    SELECT COUNT(*) AS n FROM provider_sessions
    WHERE agent_id = ? AND runtime_connection_id = ? AND origin = 'discovered' AND binding_id IS NULL AND availability = 'available'
  `).get(agentId, ctx.connection.id) as { n: number }).n;
  if (tracking.seenProviderIds.size === 0) {
    if (stored > 0) {
      appendEvent(db, { agentId, type: 'sync_empty_guarded', detail: { stored }, now: tracking.now });
    }
    return;
  }
  if (stored === 0) return;
  const selected = selectedProviderIds(db, ctx, scope);
  const candidates = db.prepare(`
    SELECT * FROM provider_sessions
    WHERE agent_id = ? AND runtime_connection_id = ? AND origin = 'discovered' AND binding_id IS NULL AND availability = 'available'
  `).all(agentId, ctx.connection.id) as ProviderSessionRow[];
  db.transaction(() => {
    for (const row of candidates) {
      if (!inScope(scope, { workspace: row.workspace, provider_session_id: row.provider_session_id }, selected)) continue;
      if (tracking.seenProviderIds.has(row.provider_session_id)) continue;
      markMissing(db, row, tracking.now);
    }
  }).immediate();
}

// NOT-547: one durable fact per full-history sync, read by GET
// /api/bots/:id/sessions as `sync`. A completed sync (including
// 'unsupported': nothing to list is a success, not a failure) writes
// sync_completed with counts only; a broken listing writes sync_failed
// with its error_code. Counts and codes only: never a provider id.
export function recordSyncCompleted(
  db: Db, agentId: string, detail: { imported: number; rejected_out_of_scope: number; complete: boolean; now: number },
): void {
  appendEvent(db, {
    agentId, type: 'sync_completed',
    detail: { imported: detail.imported, rejected_out_of_scope: detail.rejected_out_of_scope, complete: detail.complete },
    now: detail.now,
  });
}

export function recordSyncFailed(db: Db, agentId: string, detail: { error_code: string; now: number }): void {
  appendEvent(db, { agentId, type: 'sync_failed', detail: { error_code: detail.error_code }, now: detail.now });
}

export interface AgentSyncState {
  synced_at: number | null;
  last_error_code: string | null;
  out_of_scope_count: number | null;
}

// The drawer's truth: when the last completed sync ran, whether the last
// attempt failed, and how many provider-reported sessions the scope
// excluded at the last completed sync. Agents synced before outcome
// events existed fall back to the newest row time (with unknown error
// and out-of-scope counts); agents never synced are all null.
export function getAgentSyncState(db: Db, agentId: string): AgentSyncState {
  const latest = db.prepare(`
    SELECT type, detail FROM provider_session_events
    WHERE agent_id = ? AND type IN ('sync_completed', 'sync_failed')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(agentId) as { type: string; detail: string } | undefined;
  const completed = db.prepare(`
    SELECT detail, created_at FROM provider_session_events
    WHERE agent_id = ? AND type = 'sync_completed'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(agentId) as { detail: string; created_at: number } | undefined;
  let synced_at: number | null = null;
  let out_of_scope_count: number | null = null;
  if (completed) {
    synced_at = completed.created_at;
    try {
      const parsed = JSON.parse(completed.detail) as { rejected_out_of_scope?: unknown };
      if (typeof parsed.rejected_out_of_scope === 'number') out_of_scope_count = parsed.rejected_out_of_scope;
    } catch { /* a corrupt detail leaves the count unknown */ }
  } else {
    const row = db.prepare(
      'SELECT MAX(last_synced_at) AS synced_at FROM provider_sessions WHERE agent_id = ?'
    ).get(agentId) as { synced_at: number | null } | undefined;
    synced_at = row?.synced_at ?? null;
  }
  let last_error_code: string | null = null;
  if (latest?.type === 'sync_failed') {
    try {
      const parsed = JSON.parse(latest.detail) as { error_code?: unknown };
      last_error_code = typeof parsed.error_code === 'string' ? parsed.error_code : 'provider_failed';
    } catch {
      last_error_code = 'provider_failed';
    }
  }
  return { synced_at, last_error_code, out_of_scope_count };
}

// NOT-544: registration-time history sync for every provider that can
// list. A small outcome instead of a throw: 'synced' once the full
// in-scope history was imported, 'unsupported' when the Agent has no
// session provider (Hermes) or the provider reports no `list` capability,
// 'failed' when the listing itself broke (the registration still stands;
// the caller logs error_code). Discovery stays read-only.
//
// Readiness is probed before the `list` check: a runtime may report its
// real capabilities only once ready (Codex reports list=false until its
// app-server probe). A ready refusal of 'unsupported' stays 'unsupported';
// any other ready or listing failure is 'failed' with its error_code, so
// a temporarily unavailable runtime is distinguishable from one that can
// never list.
//
// NOT-547: every outcome is recorded (sync_completed / sync_failed) so
// the Sessions drawer can tell never synced, failed, and out-of-scope
// apart. Only a missing Agent records nothing.
export interface RegistrationHistorySyncResult {
  outcome: 'synced' | 'unsupported' | 'failed';
  imported: number;
  rejected_out_of_scope: number;
  complete: boolean;
  error_code?: ProviderSessionErrorCode;
}

export async function syncHistoryAtRegistration(db: Db, agentId: string, input: SyncInput = {}): Promise<RegistrationHistorySyncResult> {
  const now = input.now ?? Date.now();
  // No session provider (Hermes): skip without probing.
  try {
    agentContext(db, agentId);
  } catch (error) {
    if (error instanceof ProviderSessionError && error.code === 'provider_unavailable') {
      recordSyncCompleted(db, agentId, { imported: 0, rejected_out_of_scope: 0, complete: true, now });
      return { outcome: 'unsupported', imported: 0, rejected_out_of_scope: 0, complete: true };
    }
    return {
      outcome: 'failed', imported: 0, rejected_out_of_scope: 0, complete: false,
      error_code: error instanceof ProviderSessionError ? error.code : 'provider_failed',
    };
  }
  let ctx: AgentContext;
  try {
    ctx = await readyContext(db, agentId, input);
  } catch (error) {
    if (error instanceof ProviderSessionError && error.code === 'unsupported') {
      recordSyncCompleted(db, agentId, { imported: 0, rejected_out_of_scope: 0, complete: true, now });
      return { outcome: 'unsupported', imported: 0, rejected_out_of_scope: 0, complete: true };
    }
    const error_code = error instanceof ProviderSessionError ? error.code : 'provider_failed';
    recordSyncFailed(db, agentId, { error_code, now });
    return { outcome: 'failed', imported: 0, rejected_out_of_scope: 0, complete: false, error_code };
  }
  if (!ctx.capabilities.list) {
    recordSyncCompleted(db, agentId, { imported: 0, rejected_out_of_scope: 0, complete: true, now });
    return { outcome: 'unsupported', imported: 0, rejected_out_of_scope: 0, complete: true };
  }
  try {
    const synced = await syncAgentSessionHistory(db, agentId, input);
    recordSyncCompleted(db, agentId, {
      imported: synced.imported.length, rejected_out_of_scope: synced.rejected_out_of_scope, complete: synced.complete, now,
    });
    return { outcome: 'synced', imported: synced.imported.length, rejected_out_of_scope: synced.rejected_out_of_scope, complete: synced.complete };
  } catch (error) {
    if (error instanceof ProviderSessionError && error.code === 'unsupported') {
      recordSyncCompleted(db, agentId, { imported: 0, rejected_out_of_scope: 0, complete: true, now });
      return { outcome: 'unsupported', imported: 0, rejected_out_of_scope: 0, complete: true };
    }
    const error_code = error instanceof ProviderSessionError ? error.code : 'provider_failed';
    recordSyncFailed(db, agentId, { error_code, now });
    return { outcome: 'failed', imported: 0, rejected_out_of_scope: 0, complete: false, error_code };
  }
}

// Re-reads one session's metadata from the provider. A session the provider
// no longer has becomes availability 'missing' (never deleted).
export async function refreshProviderSession(db: Db, agentId: string, ref: string, input: SyncInput = {}): Promise<ProviderSessionRow> {
  const ctx = await readyContext(db, agentId, input);
  const row = requireSession(db, agentId, ref);
  if (row.runtime_connection_id !== ctx.connection.id) {
    throw new ProviderSessionError('provider_unavailable', 'The session belongs to another runtime connection.');
  }
  const result = await ctx.provider.getSession({ ...callContext(input), provider_session_id: row.provider_session_id });
  if (!result.ok) failWith(result.error);
  const now = input.now ?? Date.now();
  db.transaction(() => {
    if (result.value === null) markMissing(db, row, now);
    else {
      updateRow(db, ctx, row.id, result.value, now);
      appendEvent(db, { agentId, sessionRef: row.id, type: 'session_synced', now });
    }
  }).immediate();
  return requireSession(db, agentId, ref);
}

export interface ImportInput {
  // The provider's own session id, as the operator states it. Stored
  // privately like every discovered id; never echoed back.
  providerSessionId: string;
  // Explicit and absolute.
  workspace: string;
  correlation?: AttemptCorrelation | null;
  signal?: AbortSignal | null;
  now?: number;
}

// NOT-505: registers one explicitly named provider session, for a provider
// that cannot (or, in this version, does not) enumerate. The workspace
// must be inside a workspaces scope or the scope must be the explicit
// all-provider-sessions choice; a selected-sessions scope names only
// existing references. Idempotent: the same provider session keeps its one
// reference. The provider confirms what it can and refuses what it knows
// is absent.
export async function importProviderSession(db: Db, agentId: string, input: ImportInput): Promise<{ ref: string; created: boolean }> {
  const ctx = agentContext(db, agentId);
  if (typeof ctx.provider.importSession !== 'function') {
    throw new ProviderSessionError('unsupported', 'The session provider does not support explicit import.');
  }
  const providerSessionId = typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : '';
  if (!providerSessionId || providerSessionId.length > KEY_LIMIT) throw new ProviderSessionError('invalid_input', 'providerSessionId is required.');
  const workspace = absoluteWorkspace(input.workspace);
  if (!workspace) throw new ProviderSessionError('invalid_input', 'workspace must be an absolute path.');
  const scope = requireScope(ctx);
  const admits = (where: string | null) => scope.kind === 'all_provider_sessions'
    || (scope.kind === 'workspaces' && where !== null && scope.workspaces.some(root => workspaceContains(root, where)));
  if (!admits(workspace)) throw new ProviderSessionError('out_of_scope', 'The session is outside the Agent\'s session scope.');
  const result = await ctx.provider.importSession({ ...callContext(input), provider_session_id: providerSessionId, workspace });
  if (!result.ok) failWith(result.error);
  const reported = { ...result.value, provider_session_id: providerSessionId };
  const now = input.now ?? Date.now();
  return db.transaction(() => {
    // The provider's answer is re-checked: a session it places elsewhere is
    // refused and not stored.
    if (!admits(absoluteWorkspace(reported.workspace))) {
      appendEvent(db, { agentId, type: 'import_rejected_out_of_scope', detail: { count: 1 }, now });
      throw new ProviderSessionError('out_of_scope', 'The session is outside the Agent\'s session scope.');
    }
    const { ref, created } = upsertRecord(db, ctx, reported, 'discovered', now);
    appendEvent(db, { agentId, sessionRef: ref, type: created ? 'session_imported' : 'session_synced', detail: { explicit: true }, now });
    return { ref, created };
  }).immediate();
}

// ---- transcript ----

export interface TranscriptPage {
  session_ref: string;
  entries: TranscriptEntry[];
  next_cursor: string | null;
}

function redactor(row: ProviderSessionRow, turnIds: string[] = []): (text: string) => string {
  const secrets = [row.provider_session_id, ...turnIds].filter(id => id.length > 0).sort((a, b) => b.length - a.length);
  return text => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

export async function readProviderTranscript(
  db: Db, agentId: string, ref: string, input: { cursor?: string | null; limit?: number | null; correlation?: AttemptCorrelation | null; signal?: AbortSignal | null; now?: number } = {},
): Promise<TranscriptPage> {
  const ctx = await readyContext(db, agentId, input);
  requireCapability(ctx, 'read');
  const row = requireSession(db, agentId, ref);
  if (row.runtime_connection_id !== ctx.connection.id) {
    throw new ProviderSessionError('provider_unavailable', 'The session belongs to another runtime connection.');
  }
  const limit = clampLimit(ctx, input.limit);
  const result = await ctx.provider.readTranscript({ ...callContext(input), provider_session_id: row.provider_session_id, cursor: input.cursor ?? null, limit });
  if (!result.ok) {
    if (result.error.code === 'not_found') db.transaction(() => markMissing(db, row, input.now ?? Date.now())).immediate();
    failWith(result.error);
  }
  const redact = redactor(row);
  return {
    session_ref: row.id,
    entries: result.value.items.slice(0, limit).map(entry => ({
      seq: Number(entry.seq), role: entry.role, text: redact(String(entry.text ?? '')), at: typeof entry.at === 'number' ? entry.at : null,
    })),
    next_cursor: result.value.next_cursor ?? null,
  };
}

// ---- turns ----

export interface TurnInput {
  prompt: string;
  authority: SessionAuthority;
  idempotencyKey: string;
  requester: Requester;
  correlation?: AttemptCorrelation | null;
  signal?: AbortSignal | null;
  deadlineAt?: number | null;
  now?: number;
}

function checkTurnInput(input: TurnInput): void {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new ProviderSessionError('invalid_input', 'prompt is required.');
  if (input.prompt.length > PROMPT_LIMIT) throw new ProviderSessionError('invalid_input', `prompt is longer than ${PROMPT_LIMIT} characters.`);
  if (input.authority !== 'read_only' && input.authority !== 'workspace_write') {
    // Never defaulted: the caller states the authority every time.
    throw new ProviderSessionError('invalid_input', 'authority must be read_only or workspace_write.');
  }
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > KEY_LIMIT) {
    throw new ProviderSessionError('invalid_input', 'idempotencyKey is required.');
  }
  if (!input.requester || !['person', 'bot', 'service'].includes(input.requester.kind) || !input.requester.id) {
    throw new ProviderSessionError('invalid_input', 'requester is required.');
  }
}

function checkAuthority(ctx: AgentContext, authority: SessionAuthority, kind: 'start' | 'send'): void {
  if (!ctx.capabilities.authorities.includes(authority)) {
    throw new ProviderSessionError('authority_not_allowed', `The session provider cannot enforce ${authority}.`);
  }
  if (!ctx.policy) throw new ProviderSessionError('authority_not_allowed', 'The Agent has no launch policy.');
  if (authority === 'workspace_write') {
    if (ctx.policy.mode !== 'workspace_write') {
      throw new ProviderSessionError('authority_not_allowed', 'The Agent\'s policy is read only.');
    }
    if (kind === 'send' && !ctx.policy.allow_resume_with_edits) {
      throw new ProviderSessionError('authority_not_allowed', 'The Agent\'s policy does not allow resuming with edits.');
    }
  }
}

function turnHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

// The key the provider sees: derived, so one requester's key never collides
// with another's on the runtime.
function providerKey(agentId: string, requester: Requester, key: string): string {
  return `bm-${createHash('sha256').update(`${agentId}\n${requester.kind}\n${requester.id}\n${key}`).digest('hex').slice(0, 32)}`;
}

function existingTurn(db: Db, agentId: string, input: TurnInput): TurnRow | undefined {
  return db.prepare('SELECT * FROM provider_session_turns WHERE agent_id = ? AND requester_kind = ? AND requester_id = ? AND idempotency_key = ?')
    .get(agentId, input.requester.kind, input.requester.id, input.idempotencyKey) as TurnRow | undefined;
}

function replayOrConflict(row: TurnRow | undefined, hash: string): TurnRow | undefined {
  if (!row) return undefined;
  if (row.request_hash !== hash) {
    throw new ProviderSessionError('idempotency_conflict', 'That idempotency key was used for a different turn.');
  }
  return row;
}

function turnView(db: Db, row: TurnRow): ProviderTurnView {
  const session = db.prepare(`${ROW_SELECT} WHERE id = ?`).get(row.session_ref) as ProviderSessionRow;
  const redact = redactor(session, [row.provider_turn_id]);
  return {
    turn_ref: row.id,
    session_ref: row.session_ref,
    kind: row.kind,
    authority: row.authority,
    state: row.state,
    output: row.output === null ? null : redact(row.output),
    failure_code: row.failure_code,
    usage: row.state === 'running' ? null
      : { input_tokens: row.input_tokens ?? null, output_tokens: row.output_tokens ?? null, total_cost_usd: row.total_cost_usd ?? null },
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

function insertTurn(db: Db, fields: Omit<TurnRow, 'state' | 'output' | 'failure_code' | 'finished_at' | 'input_tokens' | 'output_tokens' | 'total_cost_usd'>): TurnRow {
  db.prepare(`
    INSERT INTO provider_session_turns (
      id, session_ref, agent_id, kind, authority, requester_kind, requester_id, idempotency_key, request_hash,
      provider_turn_id, state, output, failure_code, correlation, created_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL)
  `).run(
    fields.id, fields.session_ref, fields.agent_id, fields.kind, fields.authority, fields.requester_kind, fields.requester_id,
    fields.idempotency_key, fields.request_hash, fields.provider_turn_id, fields.correlation, fields.created_at,
  );
  db.prepare('UPDATE provider_sessions SET busy = 1, updated_at = ? WHERE id = ?').run(fields.created_at, fields.session_ref);
  appendEvent(db, { agentId: fields.agent_id, sessionRef: fields.session_ref, turnId: fields.id, type: 'turn_started', detail: { kind: fields.kind, authority: fields.authority }, now: fields.created_at });
  return db.prepare('SELECT * FROM provider_session_turns WHERE id = ?').get(fields.id) as TurnRow;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: provider_session_turns/.test(error.message);
}

export interface StartInput extends TurnInput {
  // Explicit and absolute; never taken from default_workspace.
  workspace: string;
}

// Starts a new provider session in an explicit workspace and records its
// first turn. Requires the 'start' capability, the Agent's
// allow_new_sessions policy, and a workspace inside the registered scope.
export async function startProviderSession(db: Db, agentId: string, input: StartInput): Promise<{ turn: ProviderTurnView; replayed: boolean }> {
  checkTurnInput(input);
  const workspace = absoluteWorkspace(input.workspace);
  if (!workspace) throw new ProviderSessionError('invalid_input', 'workspace must be an absolute path.');
  agentContext(db, agentId);
  const hash = turnHash({ kind: 'start', workspace, prompt: input.prompt, authority: input.authority });
  const replay = replayOrConflict(existingTurn(db, agentId, input), hash);
  if (replay) return { turn: turnView(db, replay), replayed: true };
  const ctx = await readyContext(db, agentId, input);
  requireCapability(ctx, 'start');
  const scope = requireScope(ctx);
  if (scope.kind === 'sessions') throw new ProviderSessionError('out_of_scope', 'The Agent is scoped to selected sessions; it cannot start new ones.');
  if (scope.kind === 'workspaces' && !scope.workspaces.some(root => workspaceContains(root, workspace))) {
    throw new ProviderSessionError('out_of_scope', 'The workspace is outside the Agent\'s session scope.');
  }
  if (!ctx.policy?.allow_new_sessions) throw new ProviderSessionError('new_sessions_not_allowed', 'The Agent\'s policy does not allow new sessions.');
  checkAuthority(ctx, input.authority, 'start');
  const contexts = contextMinter(agentId, null);
  const started = await ctx.provider.startSession({
    ...callContext(input), workspace, prompt: input.prompt, authority: input.authority,
    idempotency_key: providerKey(agentId, input.requester, input.idempotencyKey), session_context: contexts.minter,
  });
  if (!started.ok) {
    contexts.abandon();
    failWith(started.error);
  }
  const handle = started.value;
  const record = await ctx.provider.getSession({ ...callContext(input), provider_session_id: handle.provider_session_id });
  const now = input.now ?? Date.now();
  try {
    const row = db.transaction(() => {
      const known = record.ok && record.value
        ? { ...record.value, provider_session_id: handle.provider_session_id, workspace: record.value.workspace ?? workspace }
        : { provider_session_id: handle.provider_session_id, title: null, workspace, created_at: now, updated_at: now, lifecycle: 'open' as const, resumable: false, busy: true };
      const { ref, created } = upsertRecord(db, ctx, known, 'started', now, excerpt(input.prompt));
      if (created) appendEvent(db, { agentId, sessionRef: ref, type: 'session_started', detail: { authority: input.authority }, now });
      return insertTurn(db, {
        id: randomUUID(), session_ref: ref, agent_id: agentId, kind: 'start', authority: input.authority,
        requester_kind: input.requester.kind, requester_id: input.requester.id, idempotency_key: input.idempotencyKey,
        request_hash: hash, provider_turn_id: handle.provider_turn_id, correlation: JSON.stringify(input.correlation ?? {}), created_at: now,
      });
    }).immediate();
    contexts.record(row.session_ref, row.id);
    return { turn: turnView(db, row), replayed: false };
  } catch (error) {
    contexts.abandon();
    // A concurrent caller with the same key won the insert.
    if (isUniqueViolation(error)) return { turn: turnView(db, replayOrConflict(existingTurn(db, agentId, input), hash) as TurnRow), replayed: true };
    throw error;
  }
}

// Sends one turn to an exact session (a resume). The session is refreshed
// from the provider first, so resumability, availability, and busy are
// the provider's current answer, also after a Botmancers restart. A past
// or archived session is resumable whenever the provider says so; a
// released Session Binding is not, by itself, a reason to refuse.
export async function sendProviderTurn(db: Db, agentId: string, ref: string, input: TurnInput): Promise<{ turn: ProviderTurnView; replayed: boolean }> {
  checkTurnInput(input);
  agentContext(db, agentId);
  const row = requireSession(db, agentId, ref);
  const hash = turnHash({ kind: 'send', ref, prompt: input.prompt, authority: input.authority });
  const replay = replayOrConflict(existingTurn(db, agentId, input), hash);
  if (replay) return { turn: turnView(db, replay), replayed: true };
  const ctx = await readyContext(db, agentId, input);
  requireCapability(ctx, 'resume');
  if (row.runtime_connection_id !== ctx.connection.id) {
    throw new ProviderSessionError('provider_unavailable', 'The session belongs to another runtime connection.');
  }
  const scope = requireScope(ctx);
  // A Botmancers-launched session (a binding) is the Agent's own; a native
  // one must still be inside the registered scope.
  if (row.origin !== 'binding') {
    const allowed = scope.kind === 'all_provider_sessions'
      || (scope.kind === 'sessions' && scope.sessions.includes(row.id))
      || (scope.kind === 'workspaces' && row.workspace !== null && scope.workspaces.some(root => workspaceContains(root, row.workspace as string)));
    if (!allowed) throw new ProviderSessionError('out_of_scope', 'The session is outside the Agent\'s session scope.');
  }
  checkAuthority(ctx, input.authority, 'send');
  const fresh = await refreshProviderSession(db, agentId, ref, input);
  if (fresh.availability === 'missing') throw new ProviderSessionError('session_missing', 'The provider no longer has this session.');
  if (fresh.resumable !== 1) throw new ProviderSessionError('not_resumable', 'The provider cannot resume this session.');
  const running = db.prepare("SELECT 1 FROM provider_session_turns WHERE session_ref = ? AND state = 'running'").get(ref);
  if (fresh.busy === 1 || running) throw new ProviderSessionError('busy', 'The session has a turn in flight.');
  const contexts = contextMinter(agentId, ref);
  const sent = await ctx.provider.sendTurn({
    ...callContext(input), provider_session_id: row.provider_session_id, prompt: input.prompt, authority: input.authority,
    idempotency_key: providerKey(agentId, input.requester, input.idempotencyKey), session_context: contexts.minter,
  });
  if (!sent.ok) {
    contexts.abandon();
    failWith(sent.error);
  }
  const now = input.now ?? Date.now();
  try {
    const turn = db.transaction(() => insertTurn(db, {
      id: randomUUID(), session_ref: ref, agent_id: agentId, kind: 'send', authority: input.authority,
      requester_kind: input.requester.kind, requester_id: input.requester.id, idempotency_key: input.idempotencyKey,
      request_hash: hash, provider_turn_id: sent.value.provider_turn_id, correlation: JSON.stringify(input.correlation ?? {}), created_at: now,
    })).immediate();
    contexts.record(ref, turn.id);
    return { turn: turnView(db, turn), replayed: false };
  } catch (error) {
    contexts.abandon();
    if (isUniqueViolation(error)) return { turn: turnView(db, replayOrConflict(existingTurn(db, agentId, input), hash) as TurnRow), replayed: true };
    throw error;
  }
}

function requireTurn(db: Db, agentId: string, turnRef: string): TurnRow {
  const row = db.prepare('SELECT * FROM provider_session_turns WHERE id = ? AND agent_id = ?').get(turnRef, agentId) as TurnRow | undefined;
  if (!row) throw new ProviderSessionError('turn_not_found', 'No turn with that reference.');
  return row;
}

// Reported numbers only: a finite non-negative number is kept (tokens: an
// integer), anything else is null. Zero stays zero.
function reportedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
function reportedDollars(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Malformed provider usage fails soft: the turn still finishes, its usage
// unknown.
function safeUsage(raw: unknown): NormalizedUsage | null {
  try { return usageFromEvent(raw); } catch { return null; }
}

// Records a terminal provider result once. Later calls find the turn
// terminal and change nothing (no duplicate events).
function finishTurn(db: Db, turn: TurnRow, result: ProviderTurnResult, now: number): void {
  db.transaction(() => {
    const state: TurnState = result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const reported = (result.usage ?? null) as Record<string, unknown> | null;
    const changed = db.prepare(`
      UPDATE provider_session_turns SET state = ?, output = ?, failure_code = ?, finished_at = ?, input_tokens = ?, output_tokens = ?, total_cost_usd = ?
      WHERE id = ? AND state = 'running'
    `).run(state, typeof result.output === 'string' ? result.output : null, result.failure ? String(result.failure.code).slice(0, 100) : null,
      typeof result.finished_at === 'number' ? result.finished_at : now,
      reportedCount(reported?.input_tokens), reportedCount(reported?.output_tokens), reportedDollars(reported?.total_cost_usd), turn.id).changes;
    if (changed === 0) return;
    // NOT-517: a launch that was this turn (a Claude turn process, a codex
    // exec run) has ended with it, and its session context with it.
    endTurnSessionContexts(turn.id);
    // The runtime said the session is gone: a fact, never a reason to start
    // another one.
    if (result.failure?.code === 'session_missing') {
      const missing = db.prepare(`${ROW_SELECT} WHERE id = ?`).get(turn.session_ref) as ProviderSessionRow;
      markMissing(db, missing, now);
    }
    // NOT-509: the turn's one usage sample, keyed by the turn: a repeated
    // observe after a restart never adds a second one.
    const session = db.prepare('SELECT provider_kind FROM provider_sessions WHERE id = ?').get(turn.session_ref) as { provider_kind: string } | undefined;
    recordTurnUsageSample(db, turn.id, turn.session_ref, {
      agentId: turn.agent_id, provider: session?.provider_kind ?? 'unknown', usage: safeUsage(result.usage),
      observedAt: typeof result.finished_at === 'number' ? result.finished_at : now, now,
    });
    db.prepare(`
      UPDATE provider_sessions SET busy = CASE WHEN EXISTS (
        SELECT 1 FROM provider_session_turns WHERE session_ref = ? AND state = 'running') THEN 1 ELSE 0 END,
        provider_updated_at = ?, updated_at = ? WHERE id = ?
    `).run(turn.session_ref, now, now, turn.session_ref);
    // NOT-505: the runtime's own reported usage, one sample per turn; each
    // field null when unreported or malformed, never estimated.
    // Claude Code reports its cost as total_cost_usd (NOT-506).
    const usage = normalizeUsage(reported && reported.cost_usd === undefined && 'total_cost_usd' in reported
      ? { ...reported, cost_usd: reported.total_cost_usd } : reported);
    appendEvent(db, { agentId: turn.agent_id, sessionRef: turn.session_ref, turnId: turn.id, type: `turn_${state}`, detail: usage ? { usage } : {}, now });
  }).immediate();
}

// Observes a turn to its terminal result. Works for any running turn the
// registry holds, including one started before a Botmancers restart: the
// provider turn id is read from the database, never from process memory.
// A signal or deadline ends the wait only; the turn stays running.
export async function observeProviderTurn(
  db: Db, agentId: string, turnRef: string, input: { signal?: AbortSignal | null; deadlineAt?: number | null; correlation?: AttemptCorrelation | null; now?: number } = {},
): Promise<ProviderTurnView> {
  const turn = requireTurn(db, agentId, turnRef);
  if (turn.state !== 'running') return turnView(db, turn);
  const ctx = await readyContext(db, agentId, input);
  const result = await ctx.provider.observeTurn({ ...callContext(input), provider_turn_id: turn.provider_turn_id });
  if (!result.ok) {
    if (result.error.code === 'cancelled' || result.error.code === 'timed_out') return turnView(db, requireTurn(db, agentId, turnRef));
    failWith(result.error);
  }
  finishTurn(db, turn, result.value, input.now ?? Date.now());
  return turnView(db, requireTurn(db, agentId, turnRef));
}

// Cancels a turn. Idempotent: a terminal turn is returned unchanged with
// outcome 'already_terminal' and the provider is not called again.
export async function cancelProviderTurn(
  db: Db, agentId: string, turnRef: string, input: { correlation?: AttemptCorrelation | null; now?: number } = {},
): Promise<{ turn: ProviderTurnView; outcome: 'cancelled' | 'already_terminal' }> {
  const turn = requireTurn(db, agentId, turnRef);
  if (turn.state !== 'running') return { turn: turnView(db, turn), outcome: 'already_terminal' };
  const ctx = await readyContext(db, agentId, input);
  requireCapability(ctx, 'cancel');
  const now = input.now ?? Date.now();
  appendEvent(db, { agentId, sessionRef: turn.session_ref, turnId: turn.id, type: 'cancel_requested', now });
  const result = await ctx.provider.cancelTurn({ ...callContext(input), provider_turn_id: turn.provider_turn_id });
  if (!result.ok) failWith(result.error);
  if (result.value === 'cancelled') {
    finishTurn(db, turn, { status: 'cancelled', provider_session_id: '', output: null, failure: { code: 'cancelled', message: '' }, finished_at: now }, now);
    return { turn: turnView(db, requireTurn(db, agentId, turnRef)), outcome: 'cancelled' };
  }
  // The provider had already finished it: record the real terminal result.
  return { turn: await observeProviderTurn(db, agentId, turnRef, input), outcome: 'already_terminal' };
}

// NOT-507: one turn by its reference, or undefined.
export function getProviderTurn(db: Db, agentId: string, turnRef: string): ProviderTurnView | undefined {
  const row = db.prepare('SELECT * FROM provider_session_turns WHERE id = ? AND agent_id = ?').get(turnRef, agentId) as TurnRow | undefined;
  return row ? turnView(db, row) : undefined;
}

export function listProviderTurns(db: Db, agentId: string, ref: string): ProviderTurnView[] {
  requireSession(db, agentId, ref);
  const rows = db.prepare('SELECT * FROM provider_session_turns WHERE session_ref = ? ORDER BY created_at ASC, id ASC').all(ref) as TurnRow[];
  return rows.map(row => turnView(db, row));
}

// ---- disclosure helpers ----

// The owner-only local debug disclosure. Never part of a normal response.
export function providerSessionDebugId(db: Db, agentId: string, ref: string): string | undefined {
  return getProviderSessionRow(db, agentId, ref)?.provider_session_id;
}

// Every private provider identifier the registry holds, for the service
// redactor (lib/service-redaction).
export function privateProviderIds(db: Db): string[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_sessions'").get()) return [];
  const sessions = db.prepare('SELECT provider_session_id AS id FROM provider_sessions').all() as { id: string }[];
  const turns = db.prepare('SELECT provider_turn_id AS id FROM provider_session_turns').all() as { id: string }[];
  return [...sessions, ...turns].map(row => row.id);
}
