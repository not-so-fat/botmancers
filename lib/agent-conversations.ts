// NOT-446: runtime-neutral agent conversation service.
//
// An authenticated principal (person|bot|service) names a registered
// agent, opens or continues a durable conversation, and later reads the
// ordered history and the agent's reply. Bot-to-bot team conversations and
// external-caller conversations use the same rows: one conversation, its
// explicit participants and origin principal, ordered messages, and one
// agent request per accepted message carrying a runtime-neutral state
// (accepted -> dispatched -> completed|failed) plus durable events.
//
// Idempotency: (principal kind, principal id, operation, idempotency key)
// is unique. An exact retry returns the original request; the same key
// with a different payload fails with idempotency_conflict and writes
// nothing. No retry policy runs here: a failed request stays failed.
//
// Existing UI threads ('bot'/'group' conversations) are readable here
// through the compatibility participants bound in ./db; they stay
// writable only through the UI routes, whose agent loop owns their turns.
import { createHash, randomUUID } from 'crypto';
import db, { bots, type Bot, type Principal, type PrincipalKind } from './db';
import { DispatchFailure, dispatchToAgent, runtimeForDispatch, type DispatchHistoryEntry } from './agent-dispatch';

export const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['person', 'bot', 'service'];

export const SEND_MESSAGE_OPERATION = 'send_message';

export type AgentApiErrorCode =
  | 'authentication_unavailable'
  | 'unauthenticated'
  | 'principal_mismatch'
  | 'invalid_request'
  | 'agent_not_found'
  | 'conversation_not_found'
  | 'conversation_not_writable'
  | 'request_not_found'
  | 'idempotency_conflict';

export const AGENT_API_ERROR_STATUS: Record<AgentApiErrorCode, number> = {
  authentication_unavailable: 503,
  unauthenticated: 401,
  principal_mismatch: 403,
  invalid_request: 400,
  agent_not_found: 404,
  conversation_not_found: 404,
  conversation_not_writable: 409,
  request_not_found: 404,
  idempotency_conflict: 409,
};

export class AgentApiError extends Error {
  readonly code: AgentApiErrorCode;
  constructor(code: AgentApiErrorCode, message: string) {
    super(message);
    this.name = 'AgentApiError';
    this.code = code;
  }
  get status(): number {
    return AGENT_API_ERROR_STATUS[this.code];
  }
}

export type AgentRequestState = 'accepted' | 'dispatched' | 'completed' | 'failed';

interface AgentRequestRow {
  id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  operation: string;
  idempotency_key: string;
  payload_hash: string;
  conversation_id: string;
  target_bot_id: string;
  accepted_message_id: string;
  runtime: string | null;
  state: AgentRequestState;
  reply_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: 'user' | 'bot';
  sender_id: string | null;
  sender_kind: PrincipalKind | null;
  request_id: string | null;
  content: string;
  created_at: number;
}

export interface SendAgentMessageInput {
  agentId: string;
  content: string;
  idempotencyKey: string;
  conversationId?: string | null;
}

export interface AcceptedAgentRequest {
  requestId: string;
  conversationId: string;
  acceptedMessageId: string;
  state: AgentRequestState;
  replayed: boolean;
}

export interface AgentRequestView {
  requestId: string;
  conversationId: string;
  agentId: string;
  acceptedMessageId: string;
  state: AgentRequestState;
  reply: { messageId: string; content: string } | null;
  failure: { code: string; message: string } | null;
  events: { type: string; at: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessageView {
  messageId: string;
  seq: number;
  sender: Principal;
  content: string;
  requestId: string | null;
  createdAt: number;
}

export interface ConversationView {
  conversationId: string;
  type: 'agent' | 'direct' | 'group';
  origin: Principal | null;
  participants: (Principal & { joinedAt: number })[];
  messages: ConversationMessageView[];
}

export function isPrincipalKind(value: unknown): value is PrincipalKind {
  return typeof value === 'string' && (PRINCIPAL_KINDS as readonly string[]).includes(value);
}

export function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function payloadHash(input: SendAgentMessageInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.agentId, input.conversationId ?? null, input.content]))
    .digest('hex');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isParticipant(conversationId: string, principal: Principal): boolean {
  return !!db.prepare(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND participant_kind = ? AND participant_id = ?'
  ).get(conversationId, principal.kind, principal.id);
}

function addParticipant(conversationId: string, principal: Principal, at: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)'
  ).run(conversationId, principal.kind, principal.id, at);
}

function recordEvent(requestId: string, type: string, data?: Record<string, unknown>): void {
  db.prepare(
    'INSERT INTO agent_request_events (id, request_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), requestId, type, data ? JSON.stringify(data) : null, Date.now());
}

function insertMessage(args: {
  conversationId: string;
  sender: Principal;
  content: string;
  requestId: string;
  at: number;
}): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    args.conversationId,
    args.sender.kind === 'bot' ? 'bot' : 'user',
    args.sender.id,
    args.sender.kind,
    args.requestId,
    args.content,
    args.at
  );
  return id;
}

function getRequestRow(requestId: string): AgentRequestRow | undefined {
  return db.prepare('SELECT * FROM agent_requests WHERE id = ?').get(requestId) as AgentRequestRow | undefined;
}

function acceptedView(row: AgentRequestRow, replayed: boolean): AcceptedAgentRequest {
  return {
    requestId: row.id,
    conversationId: row.conversation_id,
    acceptedMessageId: row.accepted_message_id,
    state: row.state,
    replayed,
  };
}

// Principals the authenticator vouched for still have to name something
// this engine knows: a bot principal must be a registered bot.
export function assertKnownPrincipal(principal: Principal): void {
  if (!isPrincipalKind(principal.kind) || !nonEmptyString(principal.id)) {
    throw new AgentApiError('unauthenticated', 'Authentication failed.');
  }
  if (principal.kind === 'bot' && !bots.getById(principal.id)) {
    throw new AgentApiError('unauthenticated', 'Authentication failed.');
  }
}

export function sendAgentMessage(principal: Principal, input: SendAgentMessageInput): AcceptedAgentRequest {
  assertKnownPrincipal(principal);
  if (!nonEmptyString(input.agentId)) throw new AgentApiError('invalid_request', 'agentId is required.');
  if (!nonEmptyString(input.content)) throw new AgentApiError('invalid_request', 'content is required.');
  if (!nonEmptyString(input.idempotencyKey) || input.idempotencyKey.length > 200) {
    throw new AgentApiError('invalid_request', 'An idempotency key (1-200 characters) is required.');
  }
  if (input.conversationId !== undefined && input.conversationId !== null && !nonEmptyString(input.conversationId)) {
    throw new AgentApiError('invalid_request', 'conversationId must be a non-empty string when present.');
  }
  const hash = payloadHash(input);

  return db.transaction((): AcceptedAgentRequest => {
    const existing = db.prepare(
      'SELECT * FROM agent_requests WHERE principal_kind = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?'
    ).get(principal.kind, principal.id, SEND_MESSAGE_OPERATION, input.idempotencyKey) as AgentRequestRow | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        throw new AgentApiError('idempotency_conflict', 'The idempotency key was already used with a different payload.');
      }
      return acceptedView(existing, true);
    }

    const target = bots.getById(input.agentId);
    if (!target) throw new AgentApiError('agent_not_found', 'No registered agent has that id.');
    if (principal.kind === 'bot' && principal.id === target.id) {
      throw new AgentApiError('invalid_request', 'An agent cannot address itself.');
    }

    const now = Date.now();
    let conversationId: string;
    if (input.conversationId) {
      const conversation = db.prepare('SELECT id, type FROM conversations WHERE id = ?').get(input.conversationId) as
        | { id: string; type: string }
        | undefined;
      if (!conversation || !isParticipant(conversation.id, principal)) {
        throw new AgentApiError('conversation_not_found', 'No conversation with that id is visible to this principal.');
      }
      if (conversation.type !== 'agent') {
        throw new AgentApiError('conversation_not_writable', 'UI conversations are written through the UI compatibility routes.');
      }
      conversationId = conversation.id;
    } else {
      conversationId = randomUUID();
      db.prepare(
        'INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(conversationId, 'agent', principal.kind, principal.id, now);
      addParticipant(conversationId, principal, now);
    }
    addParticipant(conversationId, { kind: 'bot', id: target.id }, now);

    const requestId = randomUUID();
    const acceptedMessageId = insertMessage({ conversationId, sender: principal, content: input.content, requestId, at: now });
    db.prepare(
      `INSERT INTO agent_requests (
        id, principal_kind, principal_id, operation, idempotency_key, payload_hash,
        conversation_id, target_bot_id, accepted_message_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`
    ).run(
      requestId, principal.kind, principal.id, SEND_MESSAGE_OPERATION, input.idempotencyKey, hash,
      conversationId, target.id, acceptedMessageId, now, now
    );
    recordEvent(requestId, 'accepted');
    return acceptedView(getRequestRow(requestId) as AgentRequestRow, false);
  })();
}

function speakerLabel(row: MessageRow): string {
  if (row.sender_kind === 'bot' && row.sender_id) {
    const bot = bots.getById(row.sender_id);
    return bot ? bot.name : `bot:${row.sender_id}`;
  }
  return `${row.sender_kind ?? 'person'}:${row.sender_id ?? 'unknown'}`;
}

function historyFor(row: AgentRequestRow, bot: Bot): DispatchHistoryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ?
       AND rowid <= (SELECT rowid FROM messages WHERE id = ?)
     ORDER BY rowid ASC`
  ).all(row.conversation_id, row.accepted_message_id) as MessageRow[];
  return rows.map(message => ({
    speakerLabel: speakerLabel(message),
    fromAgent: message.sender_kind === 'bot' && message.sender_id === bot.id,
    content: message.content,
  }));
}

function failRequest(requestId: string, code: string, message: string): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE agent_requests SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ? AND state IN ('accepted', 'dispatched')"
    ).run(code, message, Date.now(), requestId);
    recordEvent(requestId, 'failed', { code });
  })();
}

async function runDispatch(requestId: string): Promise<void> {
  const row = getRequestRow(requestId);
  if (!row || row.state !== 'accepted') return;
  const bot = bots.getById(row.target_bot_id);
  if (!bot) {
    failRequest(requestId, 'agent_unavailable', 'The agent is no longer registered.');
    return;
  }
  const runtime = runtimeForDispatch(bot);
  const claimed = db.transaction(() => {
    const result = db.prepare(
      "UPDATE agent_requests SET state = 'dispatched', runtime = ?, updated_at = ? WHERE id = ? AND state = 'accepted'"
    ).run(runtime, Date.now(), requestId);
    if (result.changes !== 1) return false;
    recordEvent(requestId, 'dispatched', { runtime });
    return true;
  })();
  if (!claimed) return;

  let reply: string;
  try {
    reply = await dispatchToAgent(
      { bot, history: historyFor(row, bot) },
      { onStarted: () => recordEvent(requestId, 'runtime_started') }
    );
  } catch (error) {
    if (error instanceof DispatchFailure) {
      failRequest(requestId, error.code, error.message);
    } else {
      failRequest(requestId, 'runtime_failed', 'The agent runtime did not complete the turn.');
    }
    return;
  }

  db.transaction(() => {
    const now = Date.now();
    const replyId = insertMessage({
      conversationId: row.conversation_id,
      sender: { kind: 'bot', id: bot.id },
      content: reply,
      requestId,
      at: now,
    });
    db.prepare(
      "UPDATE agent_requests SET state = 'completed', reply_message_id = ?, updated_at = ? WHERE id = ? AND state = 'dispatched'"
    ).run(replyId, now, requestId);
    recordEvent(requestId, 'completed');
  })();
}

const inFlight = new Map<string, Promise<void>>();

// Starts (or joins) the dispatch of one accepted request. Requests past
// 'accepted' are never re-dispatched, so exact retries launch nothing.
export function startAgentDispatch(requestId: string): Promise<void> {
  const running = inFlight.get(requestId);
  if (running) return running;
  const promise = runDispatch(requestId)
    .catch(error => {
      console.error('Agent dispatch failed unexpectedly:', error);
    })
    .finally(() => {
      inFlight.delete(requestId);
    });
  inFlight.set(requestId, promise);
  return promise;
}

export function getAgentRequest(principal: Principal, requestId: string): AgentRequestView {
  assertKnownPrincipal(principal);
  const row = getRequestRow(requestId);
  if (!row || !isParticipant(row.conversation_id, principal)) {
    throw new AgentApiError('request_not_found', 'No request with that id is visible to this principal.');
  }
  const reply = row.reply_message_id
    ? (db.prepare('SELECT id, content FROM messages WHERE id = ?').get(row.reply_message_id) as { id: string; content: string } | undefined)
    : undefined;
  const events = db.prepare(
    'SELECT type, created_at FROM agent_request_events WHERE request_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(row.id) as { type: string; created_at: number }[];
  return {
    requestId: row.id,
    conversationId: row.conversation_id,
    agentId: row.target_bot_id,
    acceptedMessageId: row.accepted_message_id,
    state: row.state,
    reply: reply ? { messageId: reply.id, content: reply.content } : null,
    failure: row.failure_code ? { code: row.failure_code, message: row.failure_message ?? '' } : null,
    events: events.map(event => ({ type: event.type, at: event.created_at })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CONVERSATION_TYPE_VIEW: Record<string, ConversationView['type']> = {
  agent: 'agent',
  bot: 'direct',
  group: 'group',
};

export function getConversation(principal: Principal, conversationId: string): ConversationView {
  assertKnownPrincipal(principal);
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | { id: string; type: string; origin_kind: PrincipalKind | null; origin_id: string | null }
    | undefined;
  if (!conversation || !isParticipant(conversation.id, principal)) {
    throw new AgentApiError('conversation_not_found', 'No conversation with that id is visible to this principal.');
  }
  const participants = db.prepare(
    'SELECT participant_kind, participant_id, joined_at FROM conversation_participants WHERE conversation_id = ? ORDER BY joined_at ASC, rowid ASC'
  ).all(conversation.id) as { participant_kind: PrincipalKind; participant_id: string; joined_at: number }[];
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC'
  ).all(conversation.id) as MessageRow[];
  return {
    conversationId: conversation.id,
    type: CONVERSATION_TYPE_VIEW[conversation.type] ?? 'agent',
    origin: conversation.origin_kind && conversation.origin_id
      ? { kind: conversation.origin_kind, id: conversation.origin_id }
      : null,
    participants: participants.map(row => ({ kind: row.participant_kind, id: row.participant_id, joinedAt: row.joined_at })),
    messages: rows.map((row, index) => ({
      messageId: row.id,
      seq: index + 1,
      sender: senderOf(row, conversation),
      content: row.content,
      requestId: row.request_id,
      createdAt: row.created_at,
    })),
  };
}

// Legacy UI user messages carry no sender id; they were written by the
// conversation's UI owner origin.
function senderOf(row: MessageRow, conversation: { origin_kind: PrincipalKind | null; origin_id: string | null }): Principal {
  const kind: PrincipalKind = row.sender_kind ?? (row.sender_type === 'bot' ? 'bot' : 'person');
  if (row.sender_id) return { kind, id: row.sender_id };
  if (kind !== 'bot' && conversation.origin_kind === kind && conversation.origin_id) {
    return { kind, id: conversation.origin_id };
  }
  return { kind, id: 'unknown' };
}
