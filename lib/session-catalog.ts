import type Database from 'better-sqlite3';
import { resolveAgent } from './bot-definition';
import type { ExecutionKind, SessionBinding, WorkRequestState } from './engine-store';
import type { UsageSummary } from './usage';
import { emptyUsage, agentSessionUsage, sessionUsageSamples, type SessionUsageSampleView } from './usage-samples';

// NOT-496: the Agent session catalog. A read model over the canonical
// session_bindings table (lib/engine-store) joined with the Conversation,
// Work Request, Attempts, and the source Attempt's launch snapshot that
// already exist. It owns no table and writes nothing: a session reference
// is the binding's own Botmancers id, and its status is the binding's
// released_at.
//
// NOT-503: it also reads the provider-session registry (provider_sessions,
// lib/provider-sessions). A binding shows its registry row's provider facts;
// a native session the runtime held before Botmancers (no binding) is
// listed under its own registry reference. Both kinds share one reference
// space and one shape. `state` carries the independent facts:
// availability (available|missing), lifecycle (open|archived), provider
// resumability (null until the provider was asked), and busy. They are
// never folded into `status`: a released binding may still be resumable
// by its provider, and a missing session is reported, never dropped.
//
// NOT-509: every summary carries `usage`, the provider-reported input
// tokens, output tokens, and cost aggregated over the session's usage
// samples (lib/usage-samples), each with its own known/total coverage and
// quality; a detail adds the per-Attempt/turn samples. Unknown is never 0.
//
// The opaque external provider session id never appears in a summary or a
// detail. sessionDebugExternalId is the one exception, for the explicitly
// labeled local debug disclosure (docs/core-engine.md, Session catalog).

type Db = Database.Database;

export type SessionStatus = 'active' | 'ended';
export type SessionFilter = SessionStatus | 'all';
export const SESSION_FILTERS: SessionFilter[] = ['active', 'ended', 'all'];

export function isSessionFilter(value: unknown): value is SessionFilter {
  return typeof value === 'string' && (SESSION_FILTERS as string[]).includes(value);
}

export interface SessionOriginConversation {
  id: string;
  kind: 'direct' | 'group' | 'agent_api';
  label: string;
  // The Agent whose direct thread this is: the UI opens it. Null when the
  // conversation has no owner thread (a group or an agent API conversation).
  thread_agent_id: string | null;
}

export interface SessionOriginWorkRequest {
  id: string;
  execution_kind: ExecutionKind;
  state: WorkRequestState;
}

export interface SessionState {
  availability: 'available' | 'missing';
  lifecycle: 'open' | 'archived';
  // What the provider last said about continuing the session; null when
  // it was never asked (a binding no provider has synced yet).
  resumable: boolean | null;
  busy: boolean;
  // Last successful provider sync, or null.
  synced_at: number | null;
}

export interface SessionSummary {
  ref: string;
  // botmancers: a Session Binding the engine created; native: a session
  // imported from (or started through) the Agent's session provider.
  source: 'botmancers' | 'native';
  agent: { id: string; name: string; adapter: string; transport: string | null };
  title: string;
  status: SessionStatus;
  // NOT-496 contract, unchanged: exactly the binding a revision (or a
  // session message) would resume. Always false for a native session,
  // which those engine paths do not reach; the provider's own answer is
  // state.resumable (lib/provider-sessions sendProviderTurn).
  resumable: boolean;
  state: SessionState;
  created_at: number;
  ended_at: number | null;
  last_activity_at: number;
  origin: { conversation: SessionOriginConversation | null; work_request: SessionOriginWorkRequest | null };
  // Only what the source Attempt's stored launch snapshot recorded.
  context: { workspace: string | null };
  // NOT-509: additive. Provider-reported usage with explicit coverage.
  usage: UsageSummary;
}

export interface SessionAttemptView {
  attempt_number: number;
  kind: 'launch' | 'resume';
  role: 'source' | 'resume';
  request_id: string;
  outcome: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface SessionDetail extends SessionSummary {
  attempts: SessionAttemptView[];
  // NOT-509: one entry per Attempt or provider turn that reached a
  // runtime, oldest first.
  usage_samples: SessionUsageSampleView[];
}

interface CatalogRow extends SessionBinding {
  agent_name: string;
  agent_runtime: string | null;
  origin_request_id: string | null;
  origin_conversation_id: string | null;
  conversation_type: string | null;
  conversation_bot_id: string | null;
  thread_agent_name: string | null;
  group_name: string | null;
  request_intent: string | null;
  request_kind: ExecutionKind | null;
  request_state: WorkRequestState | null;
  request_conversation_id: string | null;
  request_target_agent_id: string | null;
  source_snapshot: string | null;
  source_finished_at: number | null;
  resumed_last_at: number | null;
  attempt_running: number;
  ps_availability: 'available' | 'missing' | null;
  ps_lifecycle: 'open' | 'archived' | null;
  ps_resumable: number | null;
  ps_busy: number | null;
  ps_workspace: string | null;
  ps_synced_at: number | null;
  ps_running: number;
}

// A registry row with no binding: a native provider session.
interface NativeRow {
  id: string;
  agent_id: string;
  agent_name: string;
  provider_kind: string;
  title: string | null;
  workspace: string | null;
  provider_created_at: number | null;
  provider_updated_at: number | null;
  availability: 'available' | 'missing';
  lifecycle: 'open' | 'archived';
  resumable: number | null;
  busy: number;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
  turn_last_at: number | null;
  running: number;
}

const TITLE_LIMIT = 80;
// A revision resumes the binding of an implementation or revision
// (lib/coordinator-loop resumeBindingFor); nothing else is resumed.
const RESUMABLE_KINDS: ExecutionKind[] = ['implementation', 'revision'];

// The same conditions resumeBindingFor applies: the binding's own Work
// Request (not one derived through its source Attempt) is an
// implementation or revision of this Agent, the binding's scope is exactly
// that request plus its source conversation (getActiveSessionBinding
// compares both), and the adapter is the one the Agent dispatches today.
function isResumable(row: CatalogRow): boolean {
  return row.released_at === null
    && row.request_id !== null
    && row.request_kind !== null && RESUMABLE_KINDS.includes(row.request_kind)
    && row.request_target_agent_id === row.agent_id
    && (row.conversation_id ?? '') === (row.request_conversation_id ?? '')
    && row.adapter === resolveAgent({ agent: row.agent_runtime }).agent;
}

// A binding may be scoped to a Conversation, a Work Request, or both
// (lib/engine-store). Its origin is the effective one: the Work Request is
// the binding's own or its source Attempt's; the Conversation is the
// binding's own or that Work Request's source conversation.
// Activity is the newest of: the binding, its release, the Attempt that
// produced it, and every Attempt that resumed it.
const SELECT = `
  SELECT b.*, bot.name AS agent_name, bot.agent AS agent_runtime, r.id AS origin_request_id, c.id AS origin_conversation_id,
    c.type AS conversation_type, c.bot_id AS conversation_bot_id, tb.name AS thread_agent_name, g.name AS group_name,
    r.intent AS request_intent, r.execution_kind AS request_kind, r.state AS request_state,
    r.source_conversation_id AS request_conversation_id, r.target_agent_id AS request_target_agent_id,
    sa.launch_snapshot AS source_snapshot, sa.finished_at AS source_finished_at,
    (SELECT MAX(COALESCE(ra.finished_at, ra.started_at)) FROM work_attempts ra WHERE ra.resumed_session_binding_id = b.id) AS resumed_last_at,
    EXISTS (SELECT 1 FROM work_attempts oa WHERE oa.resumed_session_binding_id = b.id AND oa.finished_at IS NULL) AS attempt_running,
    ps.availability AS ps_availability, ps.lifecycle AS ps_lifecycle, ps.resumable AS ps_resumable, ps.busy AS ps_busy,
    ps.workspace AS ps_workspace, ps.last_synced_at AS ps_synced_at,
    EXISTS (SELECT 1 FROM provider_session_turns pt WHERE pt.session_ref = ps.id AND pt.state = 'running') AS ps_running
  FROM session_bindings b
  JOIN bots bot ON bot.id = b.agent_id
  LEFT JOIN provider_sessions ps ON ps.binding_id = b.id
  LEFT JOIN work_attempts sa ON sa.id = b.source_attempt_id
  LEFT JOIN work_requests r ON r.id = COALESCE(b.request_id, sa.request_id)
  LEFT JOIN conversations c ON c.id = COALESCE(b.conversation_id, r.source_conversation_id)
  LEFT JOIN bots tb ON tb.id = c.bot_id
  LEFT JOIN groups g ON g.id = c.group_id
`;

const NATIVE_SELECT = `
  SELECT ps.id, ps.agent_id, bot.name AS agent_name, ps.provider_kind, ps.title, ps.workspace,
    ps.provider_created_at, ps.provider_updated_at, ps.availability, ps.lifecycle, ps.resumable, ps.busy,
    ps.last_synced_at, ps.created_at, ps.updated_at,
    (SELECT MAX(COALESCE(t.finished_at, t.created_at)) FROM provider_session_turns t WHERE t.session_ref = ps.id) AS turn_last_at,
    EXISTS (SELECT 1 FROM provider_session_turns t WHERE t.session_ref = ps.id AND t.state = 'running') AS running
  FROM provider_sessions ps
  JOIN bots bot ON bot.id = ps.agent_id
  WHERE ps.binding_id IS NULL
`;

export function formatSessionTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function excerpt(text: string | null): string | null {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(part => part.length > 0);
  if (!line) return null;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : line;
}

function snapshotField(snapshot: Record<string, unknown> | null, key: string): string | null {
  const value = snapshot?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function originConversation(row: CatalogRow): SessionOriginConversation | null {
  const id = row.origin_conversation_id;
  if (!id) return null;
  if (row.conversation_type === 'group') {
    return { id, kind: 'group', label: row.group_name ? `Group ${row.group_name}` : 'Group thread', thread_agent_id: null };
  }
  if (row.conversation_type === 'bot' && row.conversation_bot_id) {
    return {
      id, kind: 'direct',
      label: row.thread_agent_name ? `${row.thread_agent_name} thread` : 'Agent thread',
      thread_agent_id: row.thread_agent_name ? row.conversation_bot_id : null,
    };
  }
  return { id, kind: 'agent_api', label: 'Agent API conversation', thread_agent_id: null };
}

function summarize(row: CatalogRow, usage: UsageSummary = emptyUsage()): SessionSummary {
  let snapshot: Record<string, unknown> | null = null;
  try { snapshot = row.source_snapshot ? JSON.parse(row.source_snapshot) as Record<string, unknown> : null; } catch { /* no context */ }
  const conversation = originConversation(row);
  const status: SessionStatus = row.released_at === null ? 'active' : 'ended';
  const title = excerpt(row.request_intent)
    ?? (conversation?.kind === 'group' ? conversation.label : null)
    ?? `${row.agent_name} · ${formatSessionTime(row.created_at)}`;
  return {
    ref: row.id,
    source: 'botmancers',
    agent: { id: row.agent_id, name: row.agent_name, adapter: row.adapter, transport: snapshotField(snapshot, 'transport') },
    title,
    status,
    resumable: isResumable(row),
    state: {
      availability: row.ps_availability ?? 'available',
      lifecycle: row.ps_lifecycle ?? 'open',
      resumable: row.ps_resumable === null || row.ps_resumable === undefined ? null : row.ps_resumable === 1,
      busy: row.ps_busy === 1 || !!row.attempt_running || !!row.ps_running,
      synced_at: row.ps_synced_at ?? null,
    },
    created_at: row.created_at,
    ended_at: row.released_at,
    last_activity_at: Math.max(row.created_at, row.released_at ?? 0, row.source_finished_at ?? 0, row.resumed_last_at ?? 0),
    origin: {
      conversation,
      work_request: row.origin_request_id && row.request_kind && row.request_state
        ? { id: row.origin_request_id, execution_kind: row.request_kind, state: row.request_state }
        : null,
    },
    context: { workspace: snapshotField(snapshot, 'cwd') ?? row.ps_workspace ?? null },
    usage,
  };
}

// A native session: status follows the provider lifecycle (open is
// active, archived is ended); it has no Conversation or Work Request
// origin.
function summarizeNative(row: NativeRow, usage: UsageSummary = emptyUsage()): SessionSummary {
  const created = row.provider_created_at ?? row.created_at;
  const resumable = row.resumable === null ? null : row.resumable === 1;
  const archivedAt = row.lifecycle === 'archived' ? (row.provider_updated_at ?? row.updated_at) : null;
  return {
    ref: row.id,
    source: 'native',
    agent: { id: row.agent_id, name: row.agent_name, adapter: row.provider_kind, transport: null },
    title: row.title ?? `${row.agent_name} · ${formatSessionTime(created)}`,
    status: row.lifecycle === 'open' ? 'active' : 'ended',
    resumable: false,
    state: {
      availability: row.availability,
      lifecycle: row.lifecycle,
      resumable,
      busy: row.busy === 1 || !!row.running,
      synced_at: row.last_synced_at,
    },
    created_at: created,
    ended_at: archivedAt,
    last_activity_at: Math.max(created, row.provider_updated_at ?? 0, row.turn_last_at ?? 0),
    origin: { conversation: null, work_request: null },
    context: { workspace: row.workspace },
    usage,
  };
}

// Newest activity first; ties by newest binding, then reference, so the
// order never depends on the storage engine.
function byActivity(a: SessionSummary, b: SessionSummary): number {
  return b.last_activity_at - a.last_activity_at || b.created_at - a.created_at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

export function agentExists(db: Db, agentId: string): boolean {
  return !!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(agentId);
}

export function listAgentSessions(db: Db, agentId: string, filter: SessionFilter = 'all'): SessionSummary[] {
  const where = filter === 'active' ? 'AND b.released_at IS NULL' : filter === 'ended' ? 'AND b.released_at IS NOT NULL' : '';
  const rows = db.prepare(`${SELECT} WHERE b.agent_id = ? ${where}`).all(agentId) as CatalogRow[];
  const nativeWhere = filter === 'active' ? "AND ps.lifecycle = 'open'" : filter === 'ended' ? "AND ps.lifecycle = 'archived'" : '';
  const native = db.prepare(`${NATIVE_SELECT} AND ps.agent_id = ? ${nativeWhere}`).all(agentId) as NativeRow[];
  const usage = agentSessionUsage(db, agentId);
  return [
    ...rows.map(row => summarize(row, usage.get(row.id))),
    ...native.map(row => summarizeNative(row, usage.get(row.id))),
  ].sort(byActivity);
}

function nativeRow(db: Db, agentId: string, ref: string): NativeRow | undefined {
  return db.prepare(`${NATIVE_SELECT} AND ps.id = ? AND ps.agent_id = ?`).get(ref, agentId) as NativeRow | undefined;
}

function agentRow(db: Db, agentId: string, ref: string): CatalogRow | undefined {
  return db.prepare(`${SELECT} WHERE b.id = ? AND b.agent_id = ?`).get(ref, agentId) as CatalogRow | undefined;
}

// Undefined for an unknown reference and for one that belongs to another
// Agent: the two are indistinguishable to the caller.
export function getAgentSession(db: Db, agentId: string, ref: string): SessionDetail | undefined {
  const row = agentRow(db, agentId, ref);
  if (!row) {
    const native = nativeRow(db, agentId, ref);
    if (!native) return undefined;
    const { usage, samples } = sessionUsageSamples(db, agentId, ref);
    return { ...summarizeNative(native, usage), attempts: [], usage_samples: samples };
  }
  const attempts = db.prepare(`
    SELECT a.attempt_number, a.kind, a.request_id, a.outcome, a.started_at, a.finished_at,
      CASE WHEN a.id = ? THEN 'source' ELSE 'resume' END AS role
    FROM work_attempts a
    WHERE a.id = ? OR a.resumed_session_binding_id = ?
    ORDER BY a.started_at ASC, a.id ASC
  `).all(row.source_attempt_id, row.source_attempt_id, row.id) as SessionAttemptView[];
  const { usage, samples } = sessionUsageSamples(db, agentId, ref);
  return { ...summarize(row, usage), attempts, usage_samples: samples };
}

// NOT-498: the recognizable title of one session (the same title its
// catalog row shows), for exchange cards and the Agent Exchanges ledger.
export function sessionTitle(db: Db, agentId: string, ref: string): string | null {
  const row = agentRow(db, agentId, ref);
  if (row) return summarize(row).title;
  const native = nativeRow(db, agentId, ref);
  return native ? summarizeNative(native).title : null;
}

// NOT-498: a conversation labeled the way a session's origin is.
export function conversationRef(db: Db, conversationId: string): SessionOriginConversation | null {
  const row = db.prepare(`
    SELECT c.id AS origin_conversation_id, c.type AS conversation_type, c.bot_id AS conversation_bot_id,
      tb.name AS thread_agent_name, g.name AS group_name
    FROM conversations c
    LEFT JOIN bots tb ON tb.id = c.bot_id
    LEFT JOIN groups g ON g.id = c.group_id
    WHERE c.id = ?
  `).get(conversationId) as CatalogRow | undefined;
  return row ? originConversation(row) : null;
}

// The local debug disclosure only. Never part of a summary or a detail.
export function sessionDebugExternalId(db: Db, agentId: string, ref: string): string | undefined {
  const binding = agentRow(db, agentId, ref)?.external_session_id;
  if (binding !== undefined) return binding;
  if (!nativeRow(db, agentId, ref)) return undefined;
  const row = db.prepare('SELECT provider_session_id FROM provider_sessions WHERE id = ? AND agent_id = ?').get(ref, agentId) as { provider_session_id: string } | undefined;
  return row?.provider_session_id;
}
