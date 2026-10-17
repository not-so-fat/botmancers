import type Database from 'better-sqlite3';
import type { ExecutionKind, SessionBinding, WorkRequestState } from './engine-store';

// NOT-496: the Agent session catalog. A read model over the canonical
// session_bindings table (lib/engine-store) joined with the Conversation,
// Work Request, Attempts, and the source Attempt's launch snapshot that
// already exist. It owns no table and writes nothing: a session reference
// is the binding's own Botmancers id, and its state is the binding's
// released_at.
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

export interface SessionSummary {
  ref: string;
  agent: { id: string; name: string; adapter: string; transport: string | null };
  title: string;
  status: SessionStatus;
  resumable: boolean;
  created_at: number;
  ended_at: number | null;
  last_activity_at: number;
  origin: { conversation: SessionOriginConversation | null; work_request: SessionOriginWorkRequest | null };
  // Only what the source Attempt's stored launch snapshot recorded.
  context: { workspace: string | null; deck: string | null };
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
}

interface CatalogRow extends SessionBinding {
  agent_name: string;
  conversation_type: string | null;
  conversation_bot_id: string | null;
  thread_agent_name: string | null;
  group_name: string | null;
  request_intent: string | null;
  request_kind: ExecutionKind | null;
  request_state: WorkRequestState | null;
  source_snapshot: string | null;
  source_finished_at: number | null;
  resumed_last_at: number | null;
}

const TITLE_LIMIT = 80;
// A revision resumes the binding of an implementation or revision
// (lib/coordinator-loop resumeBindingFor); nothing else is resumed.
const RESUMABLE_KINDS: ExecutionKind[] = ['implementation', 'revision'];

// Activity is the newest of: the binding, its release, the Attempt that
// produced it, and every Attempt that resumed it.
const SELECT = `
  SELECT b.*, bot.name AS agent_name,
    c.type AS conversation_type, c.bot_id AS conversation_bot_id, tb.name AS thread_agent_name, g.name AS group_name,
    r.intent AS request_intent, r.execution_kind AS request_kind, r.state AS request_state,
    sa.launch_snapshot AS source_snapshot, sa.finished_at AS source_finished_at,
    (SELECT MAX(COALESCE(ra.finished_at, ra.started_at)) FROM work_attempts ra WHERE ra.resumed_session_binding_id = b.id) AS resumed_last_at
  FROM session_bindings b
  JOIN bots bot ON bot.id = b.agent_id
  LEFT JOIN conversations c ON c.id = b.conversation_id
  LEFT JOIN bots tb ON tb.id = c.bot_id
  LEFT JOIN groups g ON g.id = c.group_id
  LEFT JOIN work_requests r ON r.id = b.request_id
  LEFT JOIN work_attempts sa ON sa.id = b.source_attempt_id
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
  if (!row.conversation_id) return null;
  if (row.conversation_type === 'group') {
    return { id: row.conversation_id, kind: 'group', label: row.group_name ? `Group ${row.group_name}` : 'Group thread', thread_agent_id: null };
  }
  if (row.conversation_type === 'bot' && row.conversation_bot_id) {
    return {
      id: row.conversation_id, kind: 'direct',
      label: row.thread_agent_name ? `${row.thread_agent_name} thread` : 'Agent thread',
      thread_agent_id: row.thread_agent_name ? row.conversation_bot_id : null,
    };
  }
  return { id: row.conversation_id, kind: 'agent_api', label: 'Agent API conversation', thread_agent_id: null };
}

function summarize(row: CatalogRow): SessionSummary {
  let snapshot: Record<string, unknown> | null = null;
  try { snapshot = row.source_snapshot ? JSON.parse(row.source_snapshot) as Record<string, unknown> : null; } catch { /* no context */ }
  const conversation = originConversation(row);
  const status: SessionStatus = row.released_at === null ? 'active' : 'ended';
  const title = excerpt(row.request_intent)
    ?? (conversation?.kind === 'group' ? conversation.label : null)
    ?? `${row.agent_name} · ${formatSessionTime(row.created_at)}`;
  return {
    ref: row.id,
    agent: { id: row.agent_id, name: row.agent_name, adapter: row.adapter, transport: snapshotField(snapshot, 'transport') },
    title,
    status,
    resumable: status === 'active' && row.request_kind !== null && RESUMABLE_KINDS.includes(row.request_kind),
    created_at: row.created_at,
    ended_at: row.released_at,
    last_activity_at: Math.max(row.created_at, row.released_at ?? 0, row.source_finished_at ?? 0, row.resumed_last_at ?? 0),
    origin: {
      conversation,
      work_request: row.request_id && row.request_kind && row.request_state
        ? { id: row.request_id, execution_kind: row.request_kind, state: row.request_state }
        : null,
    },
    context: { workspace: snapshotField(snapshot, 'cwd'), deck: snapshotField(snapshot, 'deck') },
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
  return rows.map(summarize).sort(byActivity);
}

function agentRow(db: Db, agentId: string, ref: string): CatalogRow | undefined {
  return db.prepare(`${SELECT} WHERE b.id = ? AND b.agent_id = ?`).get(ref, agentId) as CatalogRow | undefined;
}

// Undefined for an unknown reference and for one that belongs to another
// Agent: the two are indistinguishable to the caller.
export function getAgentSession(db: Db, agentId: string, ref: string): SessionDetail | undefined {
  const row = agentRow(db, agentId, ref);
  if (!row) return undefined;
  const attempts = db.prepare(`
    SELECT a.attempt_number, a.kind, a.request_id, a.outcome, a.started_at, a.finished_at,
      CASE WHEN a.id = ? THEN 'source' ELSE 'resume' END AS role
    FROM work_attempts a
    WHERE a.id = ? OR a.resumed_session_binding_id = ?
    ORDER BY a.started_at ASC, a.id ASC
  `).all(row.source_attempt_id, row.source_attempt_id, row.id) as SessionAttemptView[];
  return { ...summarize(row), attempts };
}

// The local debug disclosure only. Never part of a summary or a detail.
export function sessionDebugExternalId(db: Db, agentId: string, ref: string): string | undefined {
  return agentRow(db, agentId, ref)?.external_session_id;
}
