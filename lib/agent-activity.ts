// NOT-553: the owner's Agent-scoped operational timeline. This is a read
// projection over canonical rows only; it owns no table and never reads
// provider transcripts, message content, runtime payloads, external provider
// ids, credentials, or filesystem paths.
import type Database from 'better-sqlite3';
import db, { type Bot } from './db';
import { resolveAgent } from './bot-definition';
import { InvalidPageCursorError, paginateRows, type Page } from './page-cursor';
import { AGENT_ACTIVITY_FILTERS, type AgentActivityFilter, type AgentActivityItem } from './agent-activity-view';

export { InvalidPageCursorError };
export type { AgentActivityCategory, AgentActivityFilter, AgentActivityItem, AgentActivitySeverity } from './agent-activity-view';

export type AgentActivityPage = Page<AgentActivityItem>;

const FILTERS = new Set(AGENT_ACTIVITY_FILTERS.map(row => row.value));
export function isAgentActivityFilter(value: unknown): value is AgentActivityFilter {
  return typeof value === 'string' && FILTERS.has(value as AgentActivityFilter);
}

export function parseAgentActivityLimit(value: string | null): number {
  if (value === null || value === '') return 20;
  if (!/^\d+$/.test(value)) throw new RangeError('limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit');
  return Math.min(limit, 100);
}

function enc(value: string): string { return encodeURIComponent(value); }
function sessionsHref(agentId: string, ref?: string | null): string {
  return `/agents/${enc(agentId)}/sessions${ref ? `?session=${enc(ref)}` : ''}`;
}
function conversationsHref(agentId: string, conversationId: string): string {
  return `/agents/${enc(agentId)}/conversations/${enc(conversationId)}`;
}
function safeJson(value: string | null): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(value) ? value : null;
}
function add(items: AgentActivityItem[], item: AgentActivityItem): void { items.push(item); }
function hasTable(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

interface SessionEventRow { id: string; session_ref: string | null; turn_id: string | null; type: string; detail: string | null; created_at: number }
function sessionEvents(database: Database.Database, agentId: string, items: AgentActivityItem[]): void {
  const known = database.prepare(`
    SELECT id, origin, created_at FROM provider_sessions WHERE agent_id = ? AND origin = 'discovered'
  `).all(agentId) as Array<{ id: string; origin: string; created_at: number }>;
  for (const row of known) add(items, {
    id: `provider-session:${row.id}:discovered`, kind: 'session.discovered', category: 'sessions', occurred_at: row.created_at,
    summary: 'Session discovered', target: { href: sessionsHref(agentId, row.id), label: 'Open session' },
    severity: 'info', attention: false, details: { source: 'provider discovery', session_ref: row.id },
  });
  const rows = database.prepare(`
    SELECT id, session_ref, turn_id, type, detail, created_at
    FROM provider_session_events WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC
  `).all(agentId) as SessionEventRow[];
  for (const row of rows) {
    const detail = safeJson(row.detail);
    const session = { href: sessionsHref(agentId, row.session_ref), label: row.session_ref ? 'Open session' : 'Open sessions' };
    const base = { id: `provider-session-event:${row.id}`, category: 'sessions' as const, occurred_at: row.created_at, target: session };
    if (row.type === 'session_started') add(items, { ...base, kind: 'session.started', summary: 'Session started', severity: 'success', attention: false, details: { source: 'runtime' } });
    else if (row.type === 'session_synced') add(items, { ...base, kind: 'session.discovered', summary: 'Session discovered or refreshed', severity: 'info', attention: false, details: { source: 'provider sync' } });
    else if (row.type === 'session_missing') add(items, { ...base, kind: 'session.missing', summary: 'Session is no longer available from its runtime', severity: 'warning', attention: true, details: { availability: 'missing' } });
    else if (row.type === 'turn_started') add(items, { ...base, kind: 'session.turn_started', summary: detail.kind === 'start' ? 'New session work started' : 'Session work resumed', severity: 'info', attention: false, details: { action: detail.kind === 'start' ? 'start' : 'resume', authority: detail.authority === 'workspace_write' ? 'workspace write' : 'read only' } });
    else if (row.type === 'turn_completed') add(items, { ...base, kind: 'session.turn_completed', summary: 'Session work completed', severity: 'success', attention: false, details: { outcome: 'completed' } });
    else if (row.type === 'turn_cancelled') add(items, { ...base, kind: 'session.turn_cancelled', summary: 'Session work was cancelled', severity: 'warning', attention: false, details: { outcome: 'cancelled' } });
    else if (row.type === 'turn_failed') add(items, { ...base, kind: 'session.turn_failed', summary: 'Session work failed', severity: 'error', attention: true, details: { outcome: 'failed' } });
    else if (row.type === 'sync_failed') add(items, { ...base, kind: 'session.sync_failed', summary: 'Session history could not be refreshed', severity: 'error', attention: true, details: { error_code: safeCode(detail.error_code) ?? 'provider_failed' } });
  }

  const bindings = database.prepare('SELECT id, created_at, released_at FROM session_bindings WHERE agent_id = ?').all(agentId) as Array<{ id: string; created_at: number; released_at: number | null }>;
  for (const row of bindings) {
    add(items, { id: `session-binding:${row.id}:created`, kind: 'session.active', category: 'sessions', occurred_at: row.created_at, summary: 'Session became active', target: { href: sessionsHref(agentId, row.id), label: 'Open session' }, severity: 'info', attention: false, details: { status: 'active', session_ref: row.id } });
    if (row.released_at !== null) add(items, { id: `session-binding:${row.id}:ended`, kind: 'session.ended', category: 'sessions', occurred_at: row.released_at, summary: 'Session ended', target: { href: sessionsHref(agentId, row.id), label: 'Open session' }, severity: 'info', attention: false, details: { status: 'ended', session_ref: row.id } });
  }
}

interface ConversationRow { id: string; created_at: number; type: string }
interface ConversationEventRow { id: string; conversation_id: string; kind: string; state: string | null; created_at: number }
function conversationEvents(database: Database.Database, agentId: string, items: AgentActivityItem[]): void {
  const conversations = database.prepare(`
    SELECT c.id, c.created_at, c.type FROM conversations c
    JOIN conversation_participants p ON p.conversation_id = c.id
      AND p.participant_kind = 'bot' AND p.participant_id = ?
  `).all(agentId) as ConversationRow[];
  const ids = new Set(conversations.map(row => row.id));
  for (const row of conversations) add(items, {
    id: `conversation:${row.id}:created`, kind: 'conversation.created', category: 'conversations', occurred_at: row.created_at,
    summary: row.type === 'agent' ? 'Agent conversation opened' : row.type === 'group' ? 'Group conversation opened' : 'Direct conversation opened',
    target: { href: conversationsHref(agentId, row.id), label: 'Open conversation' }, severity: 'info', attention: false,
    details: { conversation_type: row.type === 'agent' ? 'agent' : row.type === 'group' ? 'group' : 'direct' },
  });
  if (!ids.size) return;
  const rows = database.prepare(`
    SELECT id, conversation_id, kind, state, created_at FROM conversation_events
    WHERE conversation_id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify([...ids])) as ConversationEventRow[];
  for (const row of rows) {
    const target = { href: conversationsHref(agentId, row.conversation_id), label: 'Open conversation' };
    const base = { id: `conversation-event:${row.id}`, category: 'conversations' as const, occurred_at: row.created_at, target };
    if (row.kind === 'request_queued') add(items, { ...base, kind: 'conversation.request_queued', summary: 'Conversation work was queued', severity: 'info', attention: false, details: { state: row.state ?? 'queued' } });
    else if (row.kind === 'request_running') add(items, { ...base, kind: 'conversation.request_running', summary: 'Conversation work started', severity: 'info', attention: false, details: { state: row.state ?? 'running' } });
    else if (row.kind === 'request_waiting') add(items, { ...base, kind: 'conversation.request_waiting', summary: 'Conversation work needs an answer', severity: 'warning', attention: true, details: { state: row.state ?? 'waiting' } });
    else if (row.kind === 'request_completed') add(items, { ...base, kind: 'conversation.request_completed', summary: 'Conversation work completed', severity: 'success', attention: false, details: { state: row.state ?? 'completed' } });
    else if (row.kind === 'request_failed' || row.kind === 'finalization_failed' || row.kind === 'finalization_blocked') add(items, { ...base, kind: `conversation.${row.kind}`, summary: row.kind === 'finalization_blocked' ? 'Conversation finalization was blocked' : 'Conversation work failed', severity: 'error', attention: true, details: { state: row.state ?? 'failed' } });
    else if (row.kind === 'request_cancelled') add(items, { ...base, kind: 'conversation.request_cancelled', summary: 'Conversation work was cancelled', severity: 'warning', attention: false, details: { state: row.state ?? 'cancelled' } });
  }
}

interface ExchangeEventRow { id: string; exchange_id: string; mode: string; type: string; data: string | null; created_at: number }
function exchangeEvents(database: Database.Database, agentId: string, items: AgentActivityItem[]): void {
  const rows = database.prepare(`
    SELECT e.id, e.exchange_id, x.mode, e.type, e.data, e.created_at
    FROM session_exchange_events e JOIN session_exchanges x ON x.id = e.exchange_id
    WHERE x.source_agent_id = ? OR x.destination_agent_id = ?
  `).all(agentId, agentId) as ExchangeEventRow[];
  for (const row of rows) {
    const data = safeJson(row.data);
    const target = { href: `/exchanges?id=${enc(row.exchange_id)}`, label: 'Open exchange' };
    const base = { id: `exchange-event:${row.id}`, category: 'conversations' as const, occurred_at: row.created_at, target };
    if (row.type === 'created') add(items, { ...base, kind: 'exchange.created', summary: row.mode === 'continue' ? 'Session handoff created' : 'Session question created', severity: 'info', attention: false, details: { mode: row.mode, exchange_ref: row.exchange_id } });
    else if (row.type === 'hop_queued') add(items, { ...base, kind: 'exchange.queued', summary: 'Exchange step queued', severity: 'info', attention: false, details: { mode: row.mode, step: safeCode(data.hop) ?? 'work' } });
    else if (row.type === 'hop_started') add(items, { ...base, kind: 'exchange.started', summary: 'Exchange step started', severity: 'info', attention: false, details: { mode: row.mode, step: safeCode(data.hop) ?? 'work' } });
    else if (row.type === 'state_changed') {
      const state = safeCode(data.to) ?? 'changed';
      const failed = state === 'failed';
      add(items, { ...base, kind: `exchange.${state}`, summary: failed ? 'Exchange failed' : state === 'completed' ? 'Exchange completed' : state === 'cancelled' ? 'Exchange was cancelled' : 'Exchange progressed', severity: failed ? 'error' : state === 'completed' ? 'success' : state === 'cancelled' ? 'warning' : 'info', attention: failed, details: { mode: row.mode, state } });
    } else if (row.type === 'packet_rejected' || row.type === 'destination_session_rejected') add(items, { ...base, kind: `exchange.${row.type}`, summary: row.type === 'packet_rejected' ? 'Handoff packet was refused' : 'Handoff destination session was refused', severity: 'error', attention: true, details: { mode: row.mode } });
  }
}

interface ShareEventRow { id: number; share_ref: string; session_ref: string; type: string; code: string | null; at: number }
function slackEvents(database: Database.Database, agentId: string, items: AgentActivityItem[]): void {
  if (!hasTable(database, 'session_shares') || !hasTable(database, 'session_share_events')) return;
  const rows = database.prepare(`
    SELECT e.id, e.share_ref, s.session_ref, e.type, e.code, e.at
    FROM session_share_events e JOIN session_shares s ON s.id = e.share_ref WHERE s.agent_id = ?
  `).all(agentId) as ShareEventRow[];
  const target = { href: `/agents/${enc(agentId)}/slack`, label: 'Open Slack' };
  for (const row of rows) {
    const base = { id: `share-event:${row.id}`, category: 'slack' as const, occurred_at: row.at, target };
    const details = { share_ref: row.share_ref, session_ref: row.session_ref };
    if (row.type === 'created') add(items, { ...base, kind: 'slack.share_created', summary: 'Slack session share created', severity: 'info', attention: false, details });
    else if (row.type === 'revoked') add(items, { ...base, kind: 'slack.share_revoked', summary: 'Slack session share revoked', severity: 'warning', attention: false, details });
    else if (row.type === 'turn_sent') add(items, { ...base, kind: 'slack.question_sent', summary: 'Slack question sent to the owning session', severity: 'info', attention: false, details });
    else if (row.type === 'turn_refused') add(items, { ...base, kind: 'slack.question_refused', summary: 'Slack question was refused', severity: 'error', attention: true, details: { ...details, error_code: safeCode(row.code) ?? 'refused' } });
  }
  const shares = database.prepare("SELECT id, session_ref, expires_at FROM session_shares WHERE agent_id = ? AND state = 'active' AND expires_at <= ?").all(agentId, Date.now()) as Array<{ id: string; session_ref: string; expires_at: number }>;
  for (const row of shares) add(items, { id: `share:${row.id}:expired`, kind: 'slack.share_expired', category: 'slack', occurred_at: row.expires_at, summary: 'Slack session share expired', target, severity: 'info', attention: false, details: { share_ref: row.id, session_ref: row.session_ref } });
  if (hasTable(database, 'slack_share_threads')) {
    const posted = database.prepare(`
      SELECT t.share_ref, t.created_at FROM slack_share_threads t JOIN session_shares s ON s.id = t.share_ref WHERE s.agent_id = ?
    `).all(agentId) as Array<{ share_ref: string; created_at: number }>;
    for (const row of posted) add(items, { id: `share:${row.share_ref}:posted`, kind: 'slack.thread_posted', category: 'slack', occurred_at: row.created_at, summary: 'Slack share thread posted', target, severity: 'success', attention: false, details: { share_ref: row.share_ref } });
  }
}

function availabilityEvent(database: Database.Database, agentId: string, items: AgentActivityItem[]): void {
  const bot = database.prepare('SELECT * FROM bots WHERE id = ?').get(agentId) as Bot | undefined;
  if (!bot) return;
  const runtime = resolveAgent(bot);
  const blocker = runtime.launch_blocker ?? 'configuration';
  add(items, {
    id: `agent:${agentId}:availability`,
    kind: runtime.launchable ? 'availability.ready' : 'availability.setup_required',
    category: 'sessions',
    occurred_at: bot.last_seen ?? bot.created_at,
    summary: runtime.launchable ? 'Agent runtime is available' : 'Agent runtime needs setup',
    target: { href: `/bots/${enc(agentId)}/config`, label: 'Open Config' },
    severity: runtime.launchable ? 'info' : 'error',
    attention: !runtime.launchable,
    details: runtime.launchable ? { availability: 'available' } : { availability: 'unavailable', blocker },
  });
}

export function listAgentActivity(agentId: string, input: { filter: AgentActivityFilter; cursor: string | null; limit: number }, database: Database.Database = db): AgentActivityPage | null {
  if (!database.prepare('SELECT 1 FROM bots WHERE id = ?').get(agentId)) return null;
  const items: AgentActivityItem[] = [];
  sessionEvents(database, agentId, items);
  conversationEvents(database, agentId, items);
  exchangeEvents(database, agentId, items);
  slackEvents(database, agentId, items);
  availabilityEvent(database, agentId, items);
  const filtered = input.filter === 'all' ? items : input.filter === 'errors' ? items.filter(item => item.severity === 'error') : items.filter(item => item.category === input.filter);
  return paginateRows(`agent-activity:${agentId}:${input.filter}`, filtered, item => ({ at: item.occurred_at, tie: 0, id: item.id }), input.cursor, input.limit);
}
