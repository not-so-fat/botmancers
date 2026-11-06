import type Database from 'better-sqlite3';
import { conversationRef, sessionTitle } from './session-catalog';
import { EXCHANGE_TERMINAL_STATES, type ExchangeState } from './engine-store';
import type { ExchangeView, SessionExchange } from './session-exchanges';
import type {
  ExchangeConversationRef,
  ExchangeDetail,
  ExchangeLink,
  ExchangeLinkRole,
  ExchangeMode,
  ExchangeSummary,
} from './exchange-view';

// NOT-498: the Agent Exchanges read model. A read-only projection over the
// canonical session_exchanges rows and events (lib/session-exchanges) for
// the inline exchange cards and the global ledger: human-readable
// participants, session titles from the session catalog, every linked
// thread, and whether the API allows Cancel. It owns no table and writes
// nothing; state is the row's state. No provider session id, Work Request,
// or Attempt id is part of a summary.

type Db = Database.Database;

export interface ExchangeListQuery {
  requester: { kind: string; id: string };
  mode?: ExchangeMode | null;
  state?: ExchangeState | 'active' | null;
  agentId?: string | null;
  conversationId?: string | null;
}

const OUTCOME_CHARS = 600;

function bounded(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.length > OUTCOME_CHARS ? `${text.slice(0, OUTCOME_CHARS - 1).trimEnd()}…` : text;
}

function agentName(db: Db, id: string): string {
  return (db.prepare('SELECT name FROM bots WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'Removed agent';
}

function messageContent(db: Db, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return (db.prepare('SELECT content FROM messages WHERE id = ?').get(id) as { content: string } | undefined)?.content ?? null;
}

function sourceConversationOf(db: Db, row: SessionExchange): string | null {
  if (row.source_request_id) {
    const request = db.prepare('SELECT source_conversation_id FROM work_requests WHERE id = ?').get(row.source_request_id) as { source_conversation_id: string | null } | undefined;
    if (request?.source_conversation_id) return request.source_conversation_id;
  }
  const binding = db.prepare('SELECT conversation_id FROM session_bindings WHERE id = ?').get(row.source_binding_id) as { conversation_id: string | null } | undefined;
  return binding?.conversation_id ?? null;
}

function packetObjective(packet: string | null): string | null {
  if (!packet) return null;
  try {
    const parsed = JSON.parse(packet) as { objective?: unknown };
    return typeof parsed.objective === 'string' ? parsed.objective : null;
  } catch {
    return null;
  }
}

function replyMessageId(db: Db, exchangeId: string): unknown {
  const event = db.prepare(
    "SELECT data FROM session_exchange_events WHERE exchange_id = ? AND type = 'destination_replied' ORDER BY sequence DESC LIMIT 1"
  ).get(exchangeId) as { data: string | null } | undefined;
  try {
    return event?.data ? (JSON.parse(event.data) as { message_id?: unknown }).message_id : null;
  } catch {
    return null;
  }
}

export function summarizeExchange(db: Db, row: SessionExchange): ExchangeSummary {
  const ref = (id: string | null): ExchangeConversationRef | null => (id ? conversationRef(db, id) : null);
  const origin = ref(row.origin_conversation_id);
  const sourceConversation = ref(sourceConversationOf(db, row));
  const destinationConversation = ref(row.destination_conversation_id);
  const links: ExchangeLink[] = [];
  const link = (conversation: ExchangeConversationRef | null, role: ExchangeLinkRole) => {
    if (!conversation) return;
    const existing = links.find(item => item.id === conversation.id);
    if (existing) existing.roles.push(role);
    else links.push({ ...conversation, roles: [role] });
  };
  link(origin, 'origin');
  link(sourceConversation, 'source');
  link(destinationConversation, 'destination');
  const terminal = EXCHANGE_TERMINAL_STATES.includes(row.state);
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    terminal,
    // The cancel route refuses a terminal exchange; a repeat while one is
    // pending changes nothing.
    can_cancel: !terminal && row.cancel_requested_at === null,
    cancel_requested: row.cancel_requested_at !== null,
    instruction: row.instruction,
    source: {
      agent_id: row.source_agent_id,
      agent_name: agentName(db, row.source_agent_id),
      session_title: sessionTitle(db, row.source_agent_id, row.source_binding_id) ?? 'Session',
      conversation: sourceConversation,
    },
    destination: row.mode === 'continue' && row.destination_agent_id
      ? {
        agent_id: row.destination_agent_id,
        agent_name: agentName(db, row.destination_agent_id),
        session_title: row.destination_binding_id ? sessionTitle(db, row.destination_agent_id, row.destination_binding_id) : null,
        conversation: destinationConversation,
      }
      : null,
    origin,
    links,
    outcome: {
      answer: bounded(messageContent(db, row.answer_message_id)),
      objective: bounded(packetObjective(row.packet)),
      reply: bounded(messageContent(db, replyMessageId(db, row.id))),
    },
    failure: row.state === 'failed' ? { code: row.failure_code ?? 'failed', message: row.failure_message ?? '' } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    terminal_at: row.terminal_at,
  };
}

// The requester's exchanges, newest activity first (ties by newest
// creation, then id). `conversationId` keeps the exchanges linked to that
// thread as origin, source, or destination.
export function listExchanges(db: Db, query: ExchangeListQuery): ExchangeSummary[] {
  const rows = db.prepare(
    'SELECT * FROM session_exchanges WHERE requester_kind = ? AND requester_id = ? ORDER BY updated_at DESC, created_at DESC, id ASC'
  ).all(query.requester.kind, query.requester.id) as SessionExchange[];
  return rows
    .filter(row => !query.mode || row.mode === query.mode)
    .filter(row => !query.state || (query.state === 'active' ? !EXCHANGE_TERMINAL_STATES.includes(row.state) : row.state === query.state))
    .filter(row => !query.agentId || row.source_agent_id === query.agentId || row.destination_agent_id === query.agentId)
    .map(row => summarizeExchange(db, row))
    .filter(summary => !query.conversationId || summary.links.some(item => item.id === query.conversationId));
}

// Timeline data keeps what the wording needs (hop, states, reason, flags)
// and drops every reference: Work Request, Attempt, message, binding, and
// actor ids stay in the exchange API, not the ledger.
function timelineData(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  return Object.fromEntries(Object.entries(data).filter(([key]) => !key.endsWith('_id') && key !== 'session_ref' && key !== 'by'));
}

export function exchangeDetail(db: Db, view: ExchangeView): ExchangeDetail {
  const row = db.prepare('SELECT * FROM session_exchanges WHERE id = ?').get(view.id) as SessionExchange;
  return {
    summary: summarizeExchange(db, row),
    events: view.events.map(event => ({ ...event, data: timelineData(event.data) })),
    packet: view.packet,
    answer: view.answer?.content ?? null,
  };
}
