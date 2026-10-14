// NOT-446: runtime-neutral agent conversation service.
//
// An authenticated principal (person|bot|service) names a registered
// agent, opens or continues a durable conversation, and later reads the
// ordered history and the agent's reply. Bot-to-bot team conversations and
// external-caller conversations use the same rows: one conversation, its
// explicit participants and origin principal, ordered messages, and one
// request per accepted message reported in a runtime-neutral state
// (accepted -> dispatched -> completed|failed) plus durable events.
//
// NOT-465: messages are accepted through the shared conversation intake
// (./conversation-intake), the same service the web UI route uses. Each
// accepted message is one canonical Work Request (./engine-store); the
// request id is the Work Request id and its lifecycle is the canonical
// state machine shown in the documented API vocabulary. agent_requests
// is read only, for requests and idempotency keys accepted before NOT-465.
//
// Idempotency: (principal kind, principal id, idempotency key) is unique.
// An exact retry returns the original request; the same key with a
// different payload fails with idempotency_conflict and writes nothing.
// No retry policy runs here: a failed request stays failed.
//
// Existing UI threads ('bot'/'group' conversations) are readable here
// through the compatibility participants bound in ./db; they stay
// writable only through the UI routes, whose agent loop owns their turns.
import { createHash, randomUUID } from 'crypto';
import db, { bots, engine, type Bot, type Principal, type PrincipalKind } from './db';
import { DispatchFailure, agentForDispatch, dispatchToAgent, type DispatchHistoryEntry } from './agent-dispatch';
import { EngineStoreError, type EngineEvent, type WorkRequest, type WorkRequestState } from './engine-store';
import { IntakeError, acceptConversationMessage, type AcceptedIntake, type IntakeErrorCode } from './conversation-intake';

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
  | 'idempotency_conflict'
  | 'internal_error';

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
  internal_error: 500,
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

function acceptedView(row: AgentRequestRow, replayed: boolean): AcceptedAgentRequest {
  return {
    requestId: row.id,
    conversationId: row.conversation_id,
    acceptedMessageId: row.accepted_message_id,
    state: row.state,
    replayed,
  };
}

// Canonical lifecycle seen through the documented API vocabulary.
export function apiStateOf(state: WorkRequestState): AgentRequestState {
  switch (state) {
    case 'running':
    case 'waiting':
      return 'dispatched';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'accepted';
  }
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

// Normalized intake categories in the documented /api/v0 envelope.
const INTAKE_TO_API: Record<IntakeErrorCode, AgentApiErrorCode> = {
  invalid_request: 'invalid_request',
  conversation_not_found: 'conversation_not_found',
  conversation_not_writable: 'conversation_not_writable',
  target_not_found: 'agent_not_found',
  idempotency_conflict: 'idempotency_conflict',
  intake_failed: 'internal_error',
};

export function agentApiErrorFromIntake(error: IntakeError): AgentApiError {
  return new AgentApiError(INTAKE_TO_API[error.code], error.code === 'intake_failed' ? 'The request could not be processed.' : error.message);
}

// Accepted API work runs through the canonical request dispatcher; it is
// idempotent, so exact replays may call it again.
function dispatchAccepted(accepted: AcceptedIntake): Promise<void> {
  return Promise.all(accepted.requestIds.map(startAgentDispatch)).then(() => undefined);
}

// Accepts through the shared conversation intake (lib/conversation-intake).
// A key first used before NOT-465 still replays its legacy agent request
// (compatibility read); new acceptance never writes agent_requests.
export function acceptAgentMessage(principal: Principal, input: SendAgentMessageInput): { accepted: AcceptedAgentRequest; dispatched: Promise<void> } {
  assertKnownPrincipal(principal);
  if (!nonEmptyString(input.agentId)) throw new AgentApiError('invalid_request', 'agentId is required.');
  if (!nonEmptyString(input.content)) throw new AgentApiError('invalid_request', 'content is required.');
  if (!nonEmptyString(input.idempotencyKey) || input.idempotencyKey.length > 200) {
    throw new AgentApiError('invalid_request', 'An idempotency key (1-200 characters) is required.');
  }
  if (input.conversationId !== undefined && input.conversationId !== null && !nonEmptyString(input.conversationId)) {
    throw new AgentApiError('invalid_request', 'conversationId must be a non-empty string when present.');
  }

  const legacy = db.prepare(
    'SELECT * FROM agent_requests WHERE principal_kind = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?'
  ).get(principal.kind, principal.id, SEND_MESSAGE_OPERATION, input.idempotencyKey) as AgentRequestRow | undefined;
  if (legacy) {
    if (legacy.payload_hash !== payloadHash(input)) {
      throw new AgentApiError('idempotency_conflict', 'The idempotency key was already used with a different payload.');
    }
    return { accepted: acceptedView(legacy, true), dispatched: Promise.resolve() };
  }

  let intake: ReturnType<typeof acceptConversationMessage>;
  try {
    intake = acceptConversationMessage({
      surface: 'api',
      requester: principal,
      idempotencyKey: input.idempotencyKey,
      conversation: input.conversationId ? { id: input.conversationId } : { create: true },
      content: input.content,
      fingerprint: [input.agentId, input.conversationId ?? null, input.content],
      route: () => ({ deliveries: [{ agentId: input.agentId }] }),
      dispatch: dispatchAccepted,
    });
  } catch (error) {
    if (error instanceof IntakeError) throw agentApiErrorFromIntake(error);
    throw error;
  }
  const request = intake.requests[0];
  return {
    accepted: {
      requestId: intake.requestIds[0],
      conversationId: intake.conversationId,
      acceptedMessageId: intake.acceptedMessageId,
      state: request ? apiStateOf(request.state) : 'accepted',
      replayed: intake.replayed,
    },
    dispatched: intake.dispatched,
  };
}

export function sendAgentMessage(principal: Principal, input: SendAgentMessageInput): AcceptedAgentRequest {
  return acceptAgentMessage(principal, input).accepted;
}

function speakerLabel(row: MessageRow): string {
  if (row.sender_kind === 'bot' && row.sender_id) {
    const bot = bots.getById(row.sender_id);
    return bot ? bot.name : `bot:${row.sender_id}`;
  }
  return `${row.sender_kind ?? 'person'}:${row.sender_id ?? 'unknown'}`;
}

function historyFor(request: WorkRequest, bot: Bot): DispatchHistoryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ?
       AND rowid <= (SELECT rowid FROM messages WHERE id = ?)
     ORDER BY rowid ASC`
  ).all(request.source_conversation_id, request.source_event_id) as MessageRow[];
  return rows.map(message => ({
    speakerLabel: speakerLabel(message),
    fromAgent: message.sender_kind === 'bot' && message.sender_id === bot.id,
    content: message.content,
  }));
}

function failRequest(requestId: string, attemptId: string | null, code: string, message: string): void {
  engine.transaction(() => {
    if (attemptId) engine.finishAttempt(attemptId, { outcome: 'failed', errorCategory: code, errorMessage: message });
    const current = engine.getWorkRequest(requestId);
    if (!current || (current.state !== 'queued' && current.state !== 'running')) return;
    engine.transitionWorkRequest(requestId, { from: current.state, to: 'failed', errorCode: code, errorMessage: message });
  });
}

// One read-only conversation turn for a queued canonical request: claim
// it (queued -> running) with one launch Attempt, run the selected agent
// through the existing dispatch adapter, then project the reply into the
// source conversation and complete, or fail with a typed code.
async function runDispatch(requestId: string): Promise<void> {
  const request = engine.getWorkRequest(requestId);
  if (!request || request.state !== 'queued') return;
  const bot = bots.getById(request.target_agent_id);
  if (!bot) {
    failRequest(requestId, null, 'agent_unavailable', 'The agent is no longer registered.');
    return;
  }
  // NOT-456: the attempt adapter records the dispatched agent identity
  // (hermes|cursor|claude|codex|muse), never Agent Deck.
  const agent = agentForDispatch(bot);
  let attemptId: string;
  try {
    attemptId = engine.transaction(() => {
      engine.transitionWorkRequest(requestId, { from: 'queued', to: 'running', expectedVersion: request.version, data: { agent } });
      return engine.createAttempt(requestId, {
        kind: 'launch',
        adapter: agent,
        toolProfile: request.tool_profile,
        launchSnapshot: { agent, agent_id: bot.id, execution_kind: request.execution_kind, tool_profile: request.tool_profile },
      }).id;
    });
  } catch (error) {
    if (error instanceof EngineStoreError && error.code === 'stale_state') return;
    throw error;
  }

  let reply: string;
  try {
    reply = await dispatchToAgent(
      { bot, history: historyFor(request, bot) },
      { onStarted: () => { engine.appendEvent(requestId, { type: 'runtime_started', attemptId }); } }
    );
  } catch (error) {
    if (error instanceof DispatchFailure) {
      failRequest(requestId, attemptId, error.code, error.message);
    } else {
      failRequest(requestId, attemptId, 'runtime_failed', 'The agent runtime did not complete the turn.');
    }
    return;
  }

  engine.transaction(() => {
    const now = Date.now();
    const replyId = randomUUID();
    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(replyId, request.source_conversation_id, 'bot', bot.id, 'bot', requestId, reply, now);
    engine.finishAttempt(attemptId, { outcome: 'succeeded', now });
    engine.transitionWorkRequest(requestId, { from: 'running', to: 'completed', result: { reply_message_id: replyId }, now });
  });
}

const inFlight = new Map<string, Promise<void>>();

// Starts (or joins) the dispatch of one queued request. Requests past
// 'queued' are never re-dispatched, so exact retries launch nothing.
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

// Engine event types in the documented request event vocabulary
// (accepted > dispatched > runtime_started > completed|failed). Attempt
// bookkeeping stays internal.
function apiEventType(event: EngineEvent): string | null {
  if (event.type === 'state_changed') {
    const to = event.data ? (JSON.parse(event.data) as { to?: WorkRequestState }).to : undefined;
    if (to === 'running') return 'dispatched';
    if (to === 'completed') return 'completed';
    if (to === 'failed' || to === 'cancelled') return 'failed';
    return to ?? null;
  }
  if (['attempt_started', 'attempt_finished', 'session_bound', 'backfilled'].includes(event.type)) return null;
  return event.type;
}

function workRequestView(request: WorkRequest): AgentRequestView {
  const result = request.result ? (JSON.parse(request.result) as { reply_message_id?: string }) : null;
  const reply = result?.reply_message_id
    ? (db.prepare('SELECT id, content FROM messages WHERE id = ?').get(result.reply_message_id) as { id: string; content: string } | undefined)
    : undefined;
  const failed = request.state === 'failed' || request.state === 'cancelled';
  return {
    requestId: request.id,
    conversationId: request.source_conversation_id,
    agentId: request.target_agent_id,
    acceptedMessageId: request.source_event_id,
    state: apiStateOf(request.state),
    reply: reply ? { messageId: reply.id, content: reply.content } : null,
    failure: failed ? { code: request.error_code ?? request.state, message: request.error_message ?? '' } : null,
    events: engine.listEvents(request.id).flatMap(event => {
      const type = apiEventType(event);
      return type ? [{ type, at: event.created_at }] : [];
    }),
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

// Pre-NOT-465 agent requests stay readable (compatibility read).
function legacyRequestView(row: AgentRequestRow): AgentRequestView {
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

export function getAgentRequest(principal: Principal, requestId: string): AgentRequestView {
  assertKnownPrincipal(principal);
  const request = engine.getWorkRequest(requestId);
  if (request) {
    if (!isParticipant(request.source_conversation_id, principal)) {
      throw new AgentApiError('request_not_found', 'No request with that id is visible to this principal.');
    }
    return workRequestView(request);
  }
  const row = db.prepare('SELECT * FROM agent_requests WHERE id = ?').get(requestId) as AgentRequestRow | undefined;
  if (!row || !isParticipant(row.conversation_id, principal)) {
    throw new AgentApiError('request_not_found', 'No request with that id is visible to this principal.');
  }
  return legacyRequestView(row);
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
