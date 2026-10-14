// NOT-465: the one conversation intake service (docs/core-engine.md, One
// engine). The web UI message route and POST /api/v0/agents/{id}/messages
// both accept messages here:
//
//   validate conversation and requester
//     -> append the source conversation event (message)
//     -> create one canonical Work Request per resolved target
//     -> record the intake under the requester's idempotency key
//
// all in one transaction, then hand the accepted requests to the runtime
// dispatch seam. Nothing here writes processing_queue or agent_requests;
// the caller's dispatcher decides how accepted work is executed, and tests
// replace it with setIntakeDispatcher.
//
// Idempotency: (requester kind, requester id, idempotency key) is unique
// across surfaces. An exact retry (same surface and payload fingerprint)
// returns the original conversation, source event, and request ids and
// writes nothing; the same key with a different payload fails with
// idempotency_conflict and writes nothing.
//
// Failures use one normalized category (IntakeErrorCode). Each entry
// point translates it into its documented response shape.
import { createHash, randomUUID } from 'crypto';
import db, { bots, engine, type Conversation, type Message, type Principal } from './db';
import { EngineStoreError, type WorkRequest } from './engine-store';
import { selectExecutionPolicy } from './execution-policy';

export type IntakeSurface = 'ui' | 'api';

export type IntakeErrorCode =
  | 'invalid_request'
  | 'conversation_not_found'
  | 'conversation_not_writable'
  | 'target_not_found'
  | 'idempotency_conflict'
  | 'intake_failed';

export const INTAKE_ERROR_STATUS: Record<IntakeErrorCode, number> = {
  invalid_request: 400,
  conversation_not_found: 404,
  conversation_not_writable: 409,
  target_not_found: 404,
  idempotency_conflict: 409,
  intake_failed: 500,
};

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
  get status(): number {
    return INTAKE_ERROR_STATUS[this.code];
  }
}

// Conversation types each surface may write. UI threads stay writable
// only through the UI route; agent conversations only through /api/v0.
const WRITABLE_TYPES: Record<IntakeSurface, Conversation['type'][]> = {
  ui: ['bot', 'group'],
  api: ['agent'],
};

// One target turn. conversationId defaults to the source conversation; a
// different conversation (a UI @mention of a bot outside the thread)
// receives a copy of the message as its own source event.
export interface IntakeDelivery {
  agentId: string;
  conversationId?: string;
}

export interface IntakeRouting {
  deliveries: IntakeDelivery[];
  handoffTargets?: string[];
}

export interface ConversationIntakeInput {
  surface: IntakeSurface;
  requester: Principal;
  idempotencyKey: string;
  // An existing conversation, or a new agent conversation originated by
  // the requester (API only).
  conversation: { id: string } | { create: true };
  content: string;
  // Stable caller payload identity; an exact retry must repeat it.
  fingerprint: unknown;
  // Target resolution runs inside the intake transaction, after the
  // conversation is validated, and only for new (non-replayed) intake.
  route: (conversation: Conversation) => IntakeRouting;
  // The caller's production runtime path for accepted work. Replaced
  // wholesale by setIntakeDispatcher in tests.
  dispatch: IntakeDispatcher;
}

export interface AcceptedIntake {
  surface: IntakeSurface;
  conversationId: string;
  acceptedMessageId: string;
  requestIds: string[];
  requests: WorkRequest[];
  replayed: boolean;
}

export type IntakeDispatcher = (accepted: AcceptedIntake) => Promise<void> | void;

let dispatchOverride: IntakeDispatcher | null = null;

// Test seam: every entry point's accepted intake reaches this dispatcher
// instead of its runtime path. Pass null to restore the callers' own.
export function setIntakeDispatcher(next: IntakeDispatcher | null): void {
  dispatchOverride = next;
}

interface IntakeRow {
  requester_kind: string;
  requester_id: string;
  idempotency_key: string;
  request_hash: string;
  surface: IntakeSurface;
  conversation_id: string;
  source_event_id: string;
  work_request_ids: string;
  created_at: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function intakeHash(surface: IntakeSurface, fingerprint: unknown): string {
  return createHash('sha256').update(JSON.stringify([surface, fingerprint ?? null])).digest('hex');
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

// UI messages keep the legacy null sender id (the UI owner is implied by
// the thread origin); API messages name their principal.
function insertMessage(surface: IntakeSurface, conversationId: string, requester: Principal, content: string, handoffTargets: string[] | undefined, at: number): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, content, handoff_targets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    conversationId,
    requester.kind === 'bot' ? 'bot' : 'user',
    surface === 'ui' ? null : requester.id,
    requester.kind,
    content,
    handoffTargets && handoffTargets.length > 0 ? JSON.stringify(handoffTargets) : null,
    at
  );
  return id;
}

function loadRequests(ids: string[]): WorkRequest[] {
  return ids.map(id => engine.getWorkRequest(id)).filter((row): row is WorkRequest => !!row);
}

function replay(existing: IntakeRow, hash: string): AcceptedIntake {
  if (existing.request_hash !== hash) {
    throw new IntakeError('idempotency_conflict', 'The idempotency key was already used with a different payload.');
  }
  const ids = JSON.parse(existing.work_request_ids) as string[];
  return {
    surface: existing.surface,
    conversationId: existing.conversation_id,
    acceptedMessageId: existing.source_event_id,
    requestIds: ids,
    requests: loadRequests(ids),
    replayed: true,
  };
}

function intakeTransaction(input: ConversationIntakeInput, hash: string): AcceptedIntake {
  const { surface, requester } = input;
  return db.transaction((): AcceptedIntake => {
    const existing = db.prepare(
      'SELECT * FROM conversation_intakes WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?'
    ).get(requester.kind, requester.id, input.idempotencyKey) as IntakeRow | undefined;
    if (existing) return replay(existing, hash);

    const now = Date.now();
    let conversation: Conversation;
    if ('id' in input.conversation) {
      const found = db.prepare('SELECT * FROM conversations WHERE id = ?').get(input.conversation.id) as Conversation | undefined;
      if (!found || !isParticipant(found.id, requester)) {
        throw new IntakeError('conversation_not_found', 'No conversation with that id is visible to this requester.');
      }
      if (!WRITABLE_TYPES[surface].includes(found.type)) {
        throw new IntakeError('conversation_not_writable', surface === 'api'
          ? 'UI conversations are written through the UI compatibility routes.'
          : 'Agent conversations are written through the agent conversation API.');
      }
      conversation = found;
    } else {
      if (surface !== 'api') throw new IntakeError('invalid_request', 'Only the agent conversation API opens new conversations.');
      conversation = { id: randomUUID(), type: 'agent', origin_kind: requester.kind, origin_id: requester.id, created_at: now };
      db.prepare(
        'INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(conversation.id, conversation.type, requester.kind, requester.id, now);
      addParticipant(conversation.id, requester, now);
    }

    const routing = input.route(conversation);
    const seen = new Set<string>();
    const deliveries: { agentId: string; conversationId: string }[] = [];
    for (const delivery of routing.deliveries) {
      const conversationId = delivery.conversationId ?? conversation.id;
      const key = `${conversationId}:${delivery.agentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!nonEmpty(delivery.agentId) || !bots.getById(delivery.agentId)) {
        throw new IntakeError('target_not_found', 'No registered agent has that id.');
      }
      if (requester.kind === 'bot' && requester.id === delivery.agentId) {
        throw new IntakeError('invalid_request', 'An agent cannot address itself.');
      }
      if (conversationId !== conversation.id && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
        throw new IntakeError('target_not_found', 'The target conversation does not exist.');
      }
      deliveries.push({ agentId: delivery.agentId, conversationId });
    }

    // The source event, plus one copy per other conversation a target
    // turn runs in.
    const sourceEvents = new Map<string, string>();
    sourceEvents.set(conversation.id, insertMessage(surface, conversation.id, requester, input.content, routing.handoffTargets, now));
    for (const delivery of deliveries) {
      if (!sourceEvents.has(delivery.conversationId)) {
        sourceEvents.set(delivery.conversationId, insertMessage(surface, delivery.conversationId, requester, input.content, routing.handoffTargets, now));
      }
    }

    // NOT-471: a direct message is one read-only conversation turn for
    // every target, whatever the message says or which Agent type it
    // addresses (lib/execution-policy).
    const selection = selectExecutionPolicy({ entryPoint: surface, executionKind: 'conversation' });
    if (!selection.ok) throw new IntakeError('invalid_request', selection.reason);
    const executionPolicy = selection.policy;

    const requestIds: string[] = [];
    for (const delivery of deliveries) {
      addParticipant(delivery.conversationId, { kind: 'bot', id: delivery.agentId }, now);
      // A single-target intake keeps the caller's key on its request (the
      // same key a legacy agent request carried); fan-out derives one key
      // per target turn.
      const idempotencyKey = deliveries.length === 1
        ? input.idempotencyKey
        : `${input.idempotencyKey}#${delivery.conversationId}:${delivery.agentId}`;
      const { request } = engine.createOrGetWorkRequest({
        sourceConversationId: delivery.conversationId,
        sourceEventId: sourceEvents.get(delivery.conversationId) as string,
        requester,
        targetAgentId: delivery.agentId,
        intent: input.content,
        executionKind: executionPolicy.execution_kind,
        toolProfile: executionPolicy.tool_profile,
        idempotencyKey,
        policy: { source: 'conversation_intake', surface },
        executionPolicy,
        now,
      });
      requestIds.push(request.id);
    }

    // A source event that started exactly one request names it.
    for (const [conversationId, messageId] of sourceEvents) {
      const owned = deliveries.flatMap((delivery, index) => delivery.conversationId === conversationId ? [requestIds[index]] : []);
      if (owned.length === 1) db.prepare('UPDATE messages SET request_id = ? WHERE id = ?').run(owned[0], messageId);
    }

    db.prepare(`
      INSERT INTO conversation_intakes (
        requester_kind, requester_id, idempotency_key, request_hash, surface,
        conversation_id, source_event_id, work_request_ids, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requester.kind, requester.id, input.idempotencyKey, hash, surface,
      conversation.id, sourceEvents.get(conversation.id), JSON.stringify(requestIds), now
    );

    return {
      surface,
      conversationId: conversation.id,
      acceptedMessageId: sourceEvents.get(conversation.id) as string,
      requestIds,
      requests: loadRequests(requestIds),
      replayed: false,
    };
  }).immediate();
}

// Accepts one conversation message. On success the dispatcher (the test
// override, else the caller's) receives the accepted intake, including
// exact replays; dispatchers must be idempotent or skip replays.
// `dispatched` settles when that dispatcher does and never rejects.
export function acceptConversationMessage(input: ConversationIntakeInput): AcceptedIntake & { dispatched: Promise<void> } {
  if (!input.requester || !['person', 'bot', 'service'].includes(input.requester.kind) || !nonEmpty(input.requester.id)) {
    throw new IntakeError('invalid_request', 'A requester principal is required.');
  }
  if (!nonEmpty(input.content)) throw new IntakeError('invalid_request', 'content is required.');
  if (!nonEmpty(input.idempotencyKey) || input.idempotencyKey.length > 200) {
    throw new IntakeError('invalid_request', 'An idempotency key (1-200 characters) is required.');
  }
  const hash = intakeHash(input.surface, input.fingerprint);

  let accepted: AcceptedIntake;
  try {
    accepted = intakeTransaction(input, hash);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    if (error instanceof EngineStoreError && error.code === 'idempotency_conflict') {
      throw new IntakeError('idempotency_conflict', 'The idempotency key was already used with a different payload.');
    }
    console.error('Conversation intake failed:', error);
    throw new IntakeError('intake_failed', 'The message could not be accepted.');
  }

  // Called synchronously so a dispatcher's own durable writes land before
  // the caller responds.
  const dispatcher = dispatchOverride ?? input.dispatch;
  let pending: Promise<void> | void;
  try {
    pending = dispatcher(accepted);
  } catch (error) {
    pending = Promise.reject(error);
  }
  const dispatched = Promise.resolve(pending).catch(error => {
    console.error('Intake dispatch failed:', error);
  });
  return { ...accepted, dispatched };
}

export function getAcceptedMessage(messageId: string): Message | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Message | undefined;
}
