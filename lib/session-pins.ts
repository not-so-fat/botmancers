// NOT-507: durable session pins (docs/core-engine.md, Session pins).
//
// A pin is one requester's multi-turn conversation held on exactly one
// session. Two address forms create one:
//
//   - exact session: the caller names a session reference (createPin);
//   - registered Agent: the caller names only the Agent (messageAgent) and
//     Botmancers resolves its configured home session, else the newest
//     eligible session in its scope, else starts a new one, only when the
//     Agent's policy allows new sessions and a default (or the single
//     explicitly selected) workspace exists. Without one the answer is
//     workspace_required: a missing workspace never means unrestricted.
//
// Every later turn (sendPinTurn) goes to the pinned session_ref and nowhere
// else, across Botmancers restarts (the pin is a row), until the requester
// detaches it or switches (a new pin that replaces it). A refused or failed
// turn leaves the pin where it was: nothing here ever retargets a pin, falls
// back to another session, or starts a fresh one for an existing pin.
//
// Actions (lib/session-actions): an ask pin runs read_only turns; a resume
// pin runs workspace_write turns, created only when the runtime enforces
// that authority, the Agent's policy allows resuming with edits, and the
// requester explicitly approved (approved_at). A turn reaches the session
// through the Agent's SessionProvider (route 'provider', lib/provider-sessions)
// or, for a Botmancers binding without one, as an Ask exchange (route
// 'engine', lib/session-exchanges). Hand off stays an exchange (Continue).
//
// Each turn's question and answer are also messages in the pin's
// conversation (the owner's chosen thread, or one conversation the service
// owns per pin), so history reads work the same for both routes. Grants are
// checked by the caller (lib/service-api for services); this module checks
// the requester owns the pin. Rows name Botmancers references only.
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import db, { bots, type Principal } from './db';
import { readStoredPolicy, readStoredScope } from './agent-registration';
import { EXCHANGE_LIMITS } from './engine-store';
import { getAgentSession, listAgentSessions, type SessionSummary } from './session-catalog';
import {
  ProviderSessionError,
  agentProviderCapabilities,
  warmAgentProvider,
  getProviderSessionRow,
  getProviderTurn,
  observeProviderTurn,
  refreshProviderSession,
  sendProviderTurn,
  startProviderSession,
  type ProviderTurnView,
} from './provider-sessions';
import { ExchangeError } from './session-exchanges';
import { dispatchExchange, exchanges } from './agent-conversations';
import { recoveryFor, sessionActions, type Recovery, type SessionActionContext, type SessionActions, type SessionRoute } from './session-actions';

export type PinAction = 'ask' | 'resume';
export type PinResolution = 'exact' | 'home' | 'newest' | 'started';
export type PinTurnState = 'running' | 'completed' | 'failed' | 'cancelled';

export type PinErrorCode =
  | 'invalid_request'
  | 'agent_not_found'
  | 'session_not_found'
  | 'conversation_not_found'
  | 'pin_not_found'
  | 'pin_detached'
  | 'workspace_required'
  | 'no_eligible_session'
  | 'session_missing'
  | 'session_ended'
  | 'session_not_resumable'
  | 'source_session_busy'
  | 'action_unavailable'
  | 'approval_required'
  | 'authority_not_allowed'
  | 'agent_unavailable'
  | 'provider_failed'
  | 'idempotency_conflict';

export const PIN_ERROR_STATUS: Record<PinErrorCode, number> = {
  invalid_request: 400,
  agent_not_found: 404,
  session_not_found: 404,
  conversation_not_found: 404,
  pin_not_found: 404,
  pin_detached: 409,
  workspace_required: 409,
  no_eligible_session: 409,
  session_missing: 410,
  session_ended: 409,
  session_not_resumable: 409,
  source_session_busy: 409,
  action_unavailable: 409,
  approval_required: 403,
  authority_not_allowed: 403,
  agent_unavailable: 409,
  provider_failed: 502,
  idempotency_conflict: 409,
};

export class PinError extends Error {
  readonly code: PinErrorCode;
  readonly recovery: Recovery | null;
  constructor(code: PinErrorCode, message: string) {
    super(message);
    this.name = 'PinError';
    this.code = code;
    this.recovery = recoveryFor(code);
  }
  get status(): number {
    return PIN_ERROR_STATUS[this.code];
  }
}

export function pinErrorBody(error: PinError): { error: { code: PinErrorCode; message: string; recovery?: Recovery } } {
  return { error: { code: error.code, message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) } };
}

export interface PinRow {
  id: string;
  requester_kind: Principal['kind'];
  requester_id: string;
  idempotency_key: string;
  request_hash: string;
  agent_id: string;
  session_ref: string;
  action: PinAction;
  authority: 'read_only' | 'workspace_write';
  resolution: PinResolution;
  route: 'provider' | 'engine';
  conversation_id: string;
  approved_at: number | null;
  state: 'attached' | 'detached';
  detach_reason: 'detached' | 'switched' | null;
  replaced_by: string | null;
  created_at: number;
  updated_at: number;
  detached_at: number | null;
}

interface PinTurnRow {
  id: string;
  pin_id: string;
  seq: number;
  requester_kind: string;
  requester_id: string;
  idempotency_key: string;
  request_hash: string;
  content: string;
  exchange_id: string | null;
  provider_turn_ref: string | null;
  question_message_id: string | null;
  answer_message_id: string | null;
  created_at: number;
}

export interface PinView {
  pin_ref: string;
  agent: { id: string; name: string | null };
  session: { ref: string; title: string | null };
  action: PinAction;
  authority: PinRow['authority'];
  resolution: PinResolution;
  state: PinRow['state'];
  conversation_id: string;
  approved: boolean;
  replaced_by: string | null;
  turn_count: number;
  created_at: number;
  updated_at: number;
  detached_at: number | null;
}

export interface PinTurnView {
  turn_ref: string;
  seq: number;
  state: PinTurnState;
  authority: PinRow['authority'];
  content: string;
  answer: string | null;
  failure: { code: string } | null;
  exchange_id: string | null;
  created_at: number;
  finished_at: number | null;
}

const KEY_LIMIT = 200;
const TURN_PAGE = 20;
// How long a read waits for a provider turn it observes (restart recovery);
// a turn still running after it stays running.
const OBSERVE_WAIT_MS = 25;

// ---------------------------------------------------------------------
// Helpers.

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkKey(key: unknown): string {
  if (!nonEmpty(key) || key.length > KEY_LIMIT) throw new PinError('invalid_request', `An idempotency key (1-${KEY_LIMIT} characters) is required.`);
  return key;
}

function checkContent(content: unknown): string {
  if (!nonEmpty(content)) throw new PinError('invalid_request', 'content is required.');
  if (content.length > EXCHANGE_LIMITS.instructionChars) {
    throw new PinError('invalid_request', `content exceeds ${EXCHANGE_LIMITS.instructionChars} characters.`);
  }
  return content;
}

function fromProvider(error: ProviderSessionError): PinError {
  switch (error.code) {
    case 'agent_not_found': return new PinError('agent_not_found', 'No such Agent.');
    case 'session_not_found': return new PinError('session_not_found', 'No session with that reference.');
    case 'session_missing': return new PinError('session_missing', 'The runtime no longer has this session. The pin stays on it; detach it or switch to another session.');
    case 'not_resumable': return new PinError('session_not_resumable', 'The runtime cannot resume this session now. The pin stays on it; detach it or switch to another session.');
    case 'out_of_scope': return new PinError('session_not_resumable', 'The session is outside the Agent’s session scope.');
    case 'busy': return new PinError('source_session_busy', 'A turn is already running in this session; wait for it, then send again.');
    case 'authority_not_allowed': return new PinError('authority_not_allowed', `The Agent’s policy or runtime refused this authority: ${error.message}`);
    case 'new_sessions_not_allowed': return new PinError('no_eligible_session', 'The Agent’s policy does not allow new sessions.');
    case 'unsupported': return new PinError('action_unavailable', 'The Agent’s runtime does not support this action.');
    case 'scope_missing': return new PinError('agent_unavailable', 'The Agent has no session scope; the owner must choose one.');
    case 'provider_unavailable': return new PinError('agent_unavailable', 'The Agent’s runtime connection is not available.');
    case 'idempotency_conflict': return new PinError('idempotency_conflict', 'That idempotency key was used for a different turn.');
    case 'invalid_input': return new PinError('invalid_request', error.message);
    default: return new PinError('provider_failed', 'The runtime failed this turn. The pin stays on the same session; retry later.');
  }
}

function fromExchange(error: ExchangeError): PinError {
  switch (error.code) {
    case 'session_not_found': return new PinError('session_not_found', 'No session with that reference.');
    case 'agent_not_found': return new PinError('agent_not_found', 'No such Agent.');
    case 'conversation_not_found': return new PinError('conversation_not_found', 'No conversation with that id is visible.');
    case 'session_ended': return new PinError('session_ended', 'This session has ended. The pin stays on it; detach it or switch to another session.');
    case 'session_not_resumable': return new PinError('session_not_resumable', 'Botmancers cannot resume this session under the Agent’s current runtime.');
    case 'source_session_busy': return new PinError('source_session_busy', 'This session already has a turn in progress; wait for it, then send again.');
    case 'agent_unavailable': return new PinError('agent_unavailable', error.message);
    case 'idempotency_conflict': return new PinError('idempotency_conflict', 'That idempotency key was used for a different turn.');
    default: return new PinError('invalid_request', error.message);
  }
}

function rethrow(error: unknown): never {
  if (error instanceof PinError) throw error;
  if (error instanceof ProviderSessionError) throw fromProvider(error);
  if (error instanceof ExchangeError) throw fromExchange(error);
  throw error;
}

function event(pinId: string, type: string, data: Record<string, unknown>, at: number): void {
  db.prepare(`
    INSERT INTO session_pin_events (id, pin_id, sequence, type, data, created_at)
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM session_pin_events WHERE pin_id = ?
  `).run(randomUUID(), pinId, type, JSON.stringify(data), at, pinId);
}

function pinRow(id: string): PinRow | undefined {
  return db.prepare('SELECT * FROM session_pins WHERE id = ?').get(id) as PinRow | undefined;
}

function pinByKey(requester: Principal, key: string): PinRow | undefined {
  return db.prepare('SELECT * FROM session_pins WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?')
    .get(requester.kind, requester.id, key) as PinRow | undefined;
}

function turnByKey(requester: Principal, key: string): PinTurnRow | undefined {
  return db.prepare('SELECT * FROM session_pin_turns WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?')
    .get(requester.kind, requester.id, key) as PinTurnRow | undefined;
}

// The requester's own pin; anyone else's is indistinguishable from none.
export function requirePin(requester: Principal, pinRef: string): PinRow {
  const row = typeof pinRef === 'string' && pinRef.length <= KEY_LIMIT ? pinRow(pinRef) : undefined;
  if (!row || row.requester_kind !== requester.kind || row.requester_id !== requester.id) {
    throw new PinError('pin_not_found', 'No pin with that reference is visible to this requester.');
  }
  return row;
}

// The Agent owning a session reference (binding or registry row), or null.
export function sessionOwner(ref: string): string | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > KEY_LIMIT) return null;
  const binding = db.prepare('SELECT agent_id FROM session_bindings WHERE id = ?').get(ref) as { agent_id: string } | undefined;
  if (binding) return binding.agent_id;
  const native = db.prepare('SELECT agent_id FROM provider_sessions WHERE id = ?').get(ref) as { agent_id: string } | undefined;
  return native?.agent_id ?? null;
}

function expandHome(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return `${os.homedir()}/${path.slice(2)}`;
  return path.startsWith('/') ? path : null;
}

// ---------------------------------------------------------------------
// Session routes and action availability.

interface AgentFacts {
  bot: NonNullable<ReturnType<typeof bots.getById>>;
  provider: ReturnType<typeof agentProviderCapabilities>;
  connectionId: string | null;
  policy: ReturnType<typeof readStoredPolicy>;
}

function agentFacts(agentId: string): AgentFacts {
  const bot = bots.getById(agentId);
  if (!bot) throw new PinError('agent_not_found', 'No such Agent.');
  return {
    bot,
    provider: agentProviderCapabilities(db, agentId),
    connectionId: bot.runtime_connection_id ?? null,
    policy: readStoredPolicy(bot),
  };
}

function routeOf(facts: AgentFacts, summary: SessionSummary): SessionRoute {
  if (facts.provider?.resume) {
    const row = getProviderSessionRow(db, facts.bot.id, summary.ref);
    if (row && row.runtime_connection_id === facts.connectionId) return 'provider';
  }
  return summary.source === 'botmancers' ? 'engine' : null;
}

function contextFor(facts: AgentFacts, summary: SessionSummary): SessionActionContext {
  return {
    route: routeOf(facts, summary),
    provider: facts.provider ? { resume: facts.provider.resume, authorities: [...facts.provider.authorities] } : null,
    policy: facts.policy ? { mode: facts.policy.mode, allow_resume_with_edits: facts.policy.allow_resume_with_edits } : null,
  };
}

export interface SessionWithActions extends SessionSummary {
  route: SessionRoute;
  home: boolean;
  actions: SessionActions;
}

// The catalog rows of one Agent with what each action can do now.
export function sessionsWithActions(agentId: string, sessions: SessionSummary[]): SessionWithActions[] {
  const facts = agentFacts(agentId);
  return sessions.map(summary => {
    const ctx = contextFor(facts, summary);
    return { ...summary, route: ctx.route, home: facts.bot.home_session_id === summary.ref, actions: sessionActions(summary, ctx) };
  });
}

// Refreshes a provider-route session's facts first, so availability is the
// runtime's current answer (also after a restart). A provider failure is an
// error, never a reason to pick another session.
async function freshSummary(facts: AgentFacts, ref: string): Promise<SessionSummary | undefined> {
  const summary = getAgentSession(db, facts.bot.id, ref);
  if (!summary || routeOf(facts, summary) !== 'provider') return summary;
  try {
    await refreshProviderSession(db, facts.bot.id, ref);
  } catch (error) {
    rethrow(error);
  }
  return getAgentSession(db, facts.bot.id, ref);
}

// ---------------------------------------------------------------------
// Conversations.

function openConversation(requester: Principal, agentId: string, at: number): string {
  const id = randomUUID();
  db.prepare('INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'agent', requester.kind, requester.id, at);
  const participant = db.prepare(
    'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)'
  );
  participant.run(id, requester.kind, requester.id, at);
  participant.run(id, 'bot', agentId, at);
  return id;
}

function requireVisibleConversation(requester: Principal, conversationId: string): void {
  const visible = db.prepare(`
    SELECT 1 FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
    WHERE c.id = ? AND p.participant_kind = ? AND p.participant_id = ?
  `).get(conversationId, requester.kind, requester.id);
  if (!visible) throw new PinError('conversation_not_found', 'No conversation with that id is visible to this requester.');
}

function insertMessage(conversationId: string, sender: { type: 'user' | 'bot'; id: string; kind: Principal['kind'] }, content: string, at: number): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, conversationId, sender.type, sender.id, sender.kind, null, content, at);
  return id;
}

// ---------------------------------------------------------------------
// Views.

function turnState(row: PinTurnRow): { state: PinTurnState; answer: string | null; failure: { code: string } | null; finished_at: number | null } {
  if (row.provider_turn_ref) {
    const pin = pinRow(row.pin_id) as PinRow;
    const turn = getProviderTurn(db, pin.agent_id, row.provider_turn_ref);
    if (!turn) return { state: 'failed', answer: null, failure: { code: 'turn_missing' }, finished_at: null };
    return {
      state: turn.state,
      answer: turn.state === 'completed' ? turn.output : null,
      failure: turn.state === 'failed' || turn.state === 'cancelled' ? { code: turn.failure_code ?? turn.state } : null,
      finished_at: turn.finished_at,
    };
  }
  const exchange = exchanges.get(row.exchange_id as string);
  if (!exchange) return { state: 'failed', answer: null, failure: { code: 'turn_missing' }, finished_at: null };
  const state: PinTurnState = exchange.state === 'completed' ? 'completed' : exchange.state === 'failed' ? 'failed'
    : exchange.state === 'cancelled' ? 'cancelled' : 'running';
  const answer = exchange.answer_message_id
    ? (db.prepare('SELECT content FROM messages WHERE id = ?').get(exchange.answer_message_id) as { content: string } | undefined)?.content ?? null
    : null;
  return {
    state,
    answer: state === 'completed' ? answer : null,
    failure: state === 'failed' ? { code: exchange.failure_code ?? 'failed' } : state === 'cancelled' ? { code: 'cancelled' } : null,
    finished_at: exchange.terminal_at,
  };
}

function turnViewOf(pin: PinRow, row: PinTurnRow): PinTurnView {
  const live = turnState(row);
  return {
    turn_ref: row.id,
    seq: row.seq,
    state: live.state,
    authority: pin.authority,
    content: row.content,
    answer: live.answer,
    failure: live.failure,
    exchange_id: row.exchange_id,
    created_at: row.created_at,
    finished_at: live.finished_at,
  };
}

export function pinView(pin: PinRow): PinView {
  const session = getAgentSession(db, pin.agent_id, pin.session_ref);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM session_pin_turns WHERE pin_id = ?').get(pin.id) as { n: number }).n;
  return {
    pin_ref: pin.id,
    agent: { id: pin.agent_id, name: bots.getById(pin.agent_id)?.name ?? null },
    session: { ref: pin.session_ref, title: session?.title ?? null },
    action: pin.action,
    authority: pin.authority,
    resolution: pin.resolution,
    state: pin.state,
    conversation_id: pin.conversation_id,
    approved: pin.approved_at !== null,
    replaced_by: pin.replaced_by,
    turn_count: count,
    created_at: pin.created_at,
    updated_at: pin.updated_at,
    detached_at: pin.detached_at,
  };
}

// ---------------------------------------------------------------------
// Creating a pin on an exact session.

export interface CreatePinInput {
  requester: Principal;
  sessionRef: string;
  // Optional check: the Agent the caller expects to own the session.
  agentId?: string | null;
  action: PinAction;
  // Explicit approval of workspace-write turns; required for resume.
  approveWrite?: boolean;
  idempotencyKey: string;
  // The owner names the thread that holds the turns; a service gets a
  // conversation of its own (null).
  conversationId?: string | null;
  // Switch: detach this pin of the same requester in the same commit.
  replacePinRef?: string | null;
  now?: number;
  // Runs inside the commit (the service audit's allowed event).
  onCommit?: (pin: PinRow) => void;
}

function requireAction(facts: AgentFacts, summary: SessionSummary, action: PinAction): SessionRoute {
  const ctx = contextFor(facts, summary);
  const availability = sessionActions(summary, ctx)[action];
  // A pin is a handle: a busy session can still be pinned (its next turn
  // waits for the running one).
  if (!availability.available && availability.code !== 'source_session_busy') {
    throw new PinError(availability.code, availability.reason);
  }
  return ctx.route;
}

function insertPin(fields: {
  requester: Principal; key: string; hash: string; agentId: string; sessionRef: string; action: PinAction; resolution: PinResolution;
  route: 'provider' | 'engine'; conversationId: string; approved: boolean; now: number;
}): PinRow {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO session_pins (
      id, requester_kind, requester_id, idempotency_key, request_hash, agent_id, session_ref, action, authority, resolution, route,
      conversation_id, approved_at, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?)
  `).run(
    id, fields.requester.kind, fields.requester.id, fields.key, fields.hash, fields.agentId, fields.sessionRef, fields.action,
    fields.action === 'ask' ? 'read_only' : 'workspace_write', fields.resolution, fields.route, fields.conversationId,
    fields.approved ? fields.now : null, fields.now, fields.now,
  );
  event(id, 'created', {
    agent_id: fields.agentId, session_ref: fields.sessionRef, action: fields.action, resolution: fields.resolution, route: fields.route,
    authority: fields.action === 'ask' ? 'read_only' : 'workspace_write', approved: fields.approved,
  }, fields.now);
  return pinRow(id) as PinRow;
}

function detachRow(pin: PinRow, reason: 'detached' | 'switched', replacedBy: string | null, at: number): void {
  db.prepare("UPDATE session_pins SET state = 'detached', detach_reason = ?, replaced_by = ?, detached_at = ?, updated_at = ? WHERE id = ? AND state = 'attached'")
    .run(reason, replacedBy, at, at, pin.id);
  event(pin.id, reason, replacedBy ? { replaced_by: replacedBy } : {}, at);
}

export async function createPin(input: CreatePinInput): Promise<{ pin: PinRow; created: boolean; replaced: PinRow | null }> {
  const key = `pin:${checkKey(input.idempotencyKey)}`;
  if (input.action !== 'ask' && input.action !== 'resume') throw new PinError('invalid_request', 'action must be "ask" or "resume".');
  const hash = sha256(['pin', input.sessionRef, input.agentId ?? null, input.action, input.approveWrite === true, input.conversationId ?? null, input.replacePinRef ?? null]);
  const replay = pinByKey(input.requester, key);
  if (replay) {
    if (replay.request_hash !== hash) throw new PinError('idempotency_conflict', 'That idempotency key was used for a different pin.');
    return { pin: replay, created: false, replaced: null };
  }
  const agentId = sessionOwner(input.sessionRef);
  if (!agentId || (input.agentId && input.agentId !== agentId)) throw new PinError('session_not_found', 'No session with that reference.');
  await warmAgentProvider(db, agentId, { onlyWithSessions: true });
  const facts = agentFacts(agentId);
  const summary = await freshSummary(facts, input.sessionRef);
  if (!summary) throw new PinError('session_not_found', 'No session with that reference.');
  const route = requireAction(facts, summary, input.action);
  if (input.action === 'resume' && input.approveWrite !== true) {
    throw new PinError('approval_required', 'Resume work here runs with workspace-write authority. Ask the person you act for to approve edits, then pin again with approve_write: true.');
  }
  const replacing = input.replacePinRef ? requirePin(input.requester, input.replacePinRef) : null;
  if (replacing && replacing.state !== 'attached') throw new PinError('pin_detached', 'The pin to replace is already detached.');
  if (input.conversationId) requireVisibleConversation(input.requester, input.conversationId);
  else if (input.requester.kind !== 'service') throw new PinError('invalid_request', 'conversation_id is required: the thread that holds this conversation.');
  return db.transaction(() => {
    const raced = pinByKey(input.requester, key);
    if (raced) return { pin: raced, created: false, replaced: null };
    const now = input.now ?? Date.now();
    const pin = insertPin({
      requester: input.requester, key, hash, agentId, sessionRef: summary.ref, action: input.action, resolution: 'exact',
      route: route as 'provider' | 'engine', conversationId: input.conversationId ?? openConversation(input.requester, agentId, now),
      approved: input.action === 'resume', now,
    });
    if (replacing) detachRow(replacing, 'switched', pin.id, now);
    input.onCommit?.(pin);
    return { pin, created: true, replaced: replacing ? pinRow(replacing.id) as PinRow : null };
  }).immediate();
}

// ---------------------------------------------------------------------
// Turns.

export interface SendPinTurnInput {
  requester: Principal;
  pinRef: string;
  content: string;
  idempotencyKey: string;
  now?: number;
  onCommit?: (pin: PinRow, turn: PinTurnRow) => void;
}

export interface PinTurnResult {
  pin: PinRow;
  turn: PinTurnView;
  replayed: boolean;
  // Resolves once the turn's result is recorded (tests and the owner
  // routes await nothing; the dispatcher and observer run on their own).
  settled: Promise<void>;
}

function refused(pin: PinRow, error: unknown, at: number): never {
  let mapped: unknown = error;
  try {
    rethrow(error);
  } catch (caught) {
    mapped = caught;
  }
  if (mapped instanceof PinError) {
    const code = mapped.code;
    // Recorded, and the pin stays exactly where it was.
    db.transaction(() => event(pin.id, 'turn_refused', { code, session_ref: pin.session_ref }, at)).immediate();
  }
  throw mapped;
}

// The key a pin turn uses on the provider or the exchange store: derived
// and bounded, so a caller key of any allowed length fits their limits.
function innerKey(pinId: string, key: string): string {
  return `pin-${createHash('sha256').update(`${pinId}\n${key}`).digest('hex').slice(0, 40)}`;
}

function nextSeq(pinId: string): number {
  return ((db.prepare('SELECT MAX(seq) AS n FROM session_pin_turns WHERE pin_id = ?').get(pinId) as { n: number | null }).n ?? 0) + 1;
}

function insertTurn(pin: PinRow, requester: Principal, key: string, hash: string, content: string, link: { exchangeId?: string; providerTurnRef?: string }, now: number): PinTurnRow {
  const id = randomUUID();
  const questionId = link.exchangeId
    ? null
    : insertMessage(pin.conversation_id, { type: 'user', id: requester.id, kind: requester.kind }, content, now);
  db.prepare(`
    INSERT INTO session_pin_turns (
      id, pin_id, seq, requester_kind, requester_id, idempotency_key, request_hash, content, exchange_id, provider_turn_ref,
      question_message_id, answer_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(id, pin.id, nextSeq(pin.id), requester.kind, requester.id, key, hash, content, link.exchangeId ?? null, link.providerTurnRef ?? null, questionId, now);
  db.prepare('UPDATE session_pins SET updated_at = ? WHERE id = ?').run(now, pin.id);
  event(pin.id, 'turn_sent', { turn_ref: id, session_ref: pin.session_ref, authority: pin.authority, route: pin.route }, now);
  return db.prepare('SELECT * FROM session_pin_turns WHERE id = ?').get(id) as PinTurnRow;
}

// Records a provider turn's answer in the pin conversation, once.
function recordAnswer(turnId: string): void {
  db.transaction(() => {
    const turn = db.prepare('SELECT * FROM session_pin_turns WHERE id = ?').get(turnId) as PinTurnRow | undefined;
    if (!turn || !turn.provider_turn_ref || turn.answer_message_id) return;
    const pin = pinRow(turn.pin_id) as PinRow;
    const view = getProviderTurn(db, pin.agent_id, turn.provider_turn_ref);
    if (!view || view.state === 'running') return;
    if (view.state === 'completed' && view.output !== null) {
      const now = Date.now();
      const messageId = insertMessage(pin.conversation_id, { type: 'bot', id: pin.agent_id, kind: 'bot' }, view.output, now);
      db.prepare('UPDATE session_pin_turns SET answer_message_id = ? WHERE id = ? AND answer_message_id IS NULL').run(messageId, turn.id);
      event(pin.id, 'turn_answered', { turn_ref: turn.id }, now);
    }
  }).immediate();
}

async function observe(pin: PinRow, turn: PinTurnRow, waitMs: number | null): Promise<void> {
  if (!turn.provider_turn_ref) return;
  try {
    const view: ProviderTurnView = await observeProviderTurn(db, pin.agent_id, turn.provider_turn_ref, waitMs === null ? {} : { deadlineAt: Date.now() + waitMs });
    if (view.state !== 'running') recordAnswer(turn.id);
  } catch (error) {
    // The turn stays as the provider last reported it; a later read
    // observes again.
    console.error('Pin turn observe failed:', error instanceof Error ? error.message : 'unknown error');
  }
}

async function sendOn(pin: PinRow, requester: Principal, key: string, hash: string, content: string, now: number, onCommit?: SendPinTurnInput['onCommit']): Promise<PinTurnResult> {
  if (pin.route === 'provider') {
    let sent: Awaited<ReturnType<typeof sendProviderTurn>>;
    try {
      sent = await sendProviderTurn(db, pin.agent_id, pin.session_ref, {
        prompt: content, authority: pin.authority, idempotencyKey: innerKey(pin.id, key), requester,
      });
    } catch (error) {
      refused(pin, error, now);
    }
    const turn = db.transaction(() => {
      const raced = turnByKey(requester, key);
      if (raced) return raced;
      const row = insertTurn(pin, requester, key, hash, content, { providerTurnRef: sent.turn.turn_ref }, now);
      onCommit?.(pin, row);
      return row;
    }).immediate();
    return { pin: pinRow(pin.id) as PinRow, turn: turnViewOf(pin, turn), replayed: false, settled: observe(pin, turn, null) };
  }
  let turn: PinTurnRow;
  try {
    turn = db.transaction(() => {
      const raced = turnByKey(requester, key);
      if (raced) return raced;
      const { exchange } = exchanges.create({
        requester, serviceGrant: requester.kind === 'service', idempotencyKey: innerKey(pin.id, key), mode: 'ask',
        originConversationId: pin.conversation_id, sourceAgentId: pin.agent_id, sessionRef: pin.session_ref, instruction: content, now,
      });
      // The question, as the requester's message in the pin conversation.
      db.prepare(
        'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), pin.conversation_id, 'user', requester.id, requester.kind, exchange.source_request_id, content, now);
      const row = insertTurn(pin, requester, key, hash, content, { exchangeId: exchange.id }, now);
      onCommit?.(pin, row);
      return row;
    }).immediate();
  } catch (error) {
    refused(pin, error, now);
  }
  return { pin: pinRow(pin.id) as PinRow, turn: turnViewOf(pin, turn), replayed: false, settled: dispatchExchange(turn.exchange_id as string) };
}

// One turn on exactly the pinned session.
export async function sendPinTurn(input: SendPinTurnInput): Promise<PinTurnResult> {
  const key = `turn:${checkKey(input.idempotencyKey)}`;
  const content = checkContent(input.content);
  const pin = requirePin(input.requester, input.pinRef);
  const hash = sha256(['turn', pin.id, content]);
  const replay = turnByKey(input.requester, key);
  if (replay) {
    if (replay.request_hash !== hash) throw new PinError('idempotency_conflict', 'That idempotency key was used for a different turn.');
    return { pin, turn: turnViewOf(pin, replay), replayed: true, settled: Promise.resolve() };
  }
  if (pin.state !== 'attached') {
    throw new PinError('pin_detached', `This pin was ${pin.detach_reason === 'switched' ? 'switched to another pin' : 'detached'}; it no longer sends. Pin a session again.`);
  }
  return sendOn(pin, input.requester, key, hash, content, input.now ?? Date.now(), input.onCommit);
}

// ---------------------------------------------------------------------
// Registered-Agent messaging.

export interface MessageAgentInput {
  requester: Principal;
  agentId: string;
  content: string;
  idempotencyKey: string;
  conversationId?: string | null;
  now?: number;
  // Called with the resolved target before anything is written (the
  // service audit target), and inside the commit.
  onResolved?: (target: { agentId: string; sessionRef: string | null; resolution: PinResolution | null }) => void;
  onCommit?: (pin: PinRow) => void;
}

export interface MessageAgentResult extends PinTurnResult {
  resolution: PinResolution;
}

type Resolved = { kind: 'session'; summary: SessionSummary; route: 'provider' | 'engine'; resolution: 'home' | 'newest' } | { kind: 'start'; workspace: string };

// Bounded: the newest candidates checked against the runtime before a
// registered-Agent message gives up on existing sessions.
const CANDIDATE_LIMIT = 10;

async function resolveTarget(facts: AgentFacts): Promise<Resolved> {
  const agentId = facts.bot.id;
  let sawBusy = false;
  const consider = async (ref: string): Promise<{ summary: SessionSummary; route: 'provider' | 'engine' } | 'busy' | null> => {
    const summary = await freshSummary(facts, ref);
    if (!summary) return null;
    const ctx = contextFor(facts, summary);
    const ask = sessionActions(summary, ctx).ask;
    if (ask.available) return { summary, route: ctx.route as 'provider' | 'engine' };
    return ask.code === 'source_session_busy' ? 'busy' : null;
  };
  const home = facts.bot.home_session_id;
  if (home && getAgentSession(db, agentId, home)) {
    const chosen = await consider(home);
    // The configured home session is busy: wait for it, never go around it.
    if (chosen === 'busy') throw new PinError('source_session_busy', 'The Agent’s home session has a turn in progress; send again when it finishes.');
    if (chosen) return { kind: 'session', ...chosen, resolution: 'home' };
  }
  const candidates = listAgentSessions(db, agentId, 'all')
    .filter(summary => summary.ref !== home)
    .filter(summary => {
      const ctx = contextFor(facts, summary);
      const ask = sessionActions(summary, ctx).ask;
      return ask.available || ask.code === 'source_session_busy' || (ctx.route === 'provider' && summary.state.resumable === null);
    })
    .slice(0, CANDIDATE_LIMIT);
  for (const candidate of candidates) {
    const chosen = await consider(candidate.ref);
    if (chosen === 'busy') sawBusy = true;
    else if (chosen) return { kind: 'session', ...chosen, resolution: 'newest' };
  }
  if (sawBusy) throw new PinError('source_session_busy', 'Every eligible session of this Agent has a turn in progress; send again when one finishes.');
  // No eligible session: start one only under policy, with a workspace.
  if (!facts.policy?.allow_new_sessions) {
    throw new PinError('no_eligible_session', 'This Agent has no session that can take a message, and its policy does not allow new sessions. Pin one of its sessions, or ask the owner to allow new sessions.');
  }
  if (!facts.provider?.start) {
    throw new PinError('no_eligible_session', 'This Agent has no session that can take a message, and its runtime cannot start a new one from here.');
  }
  const scope = readStoredScope(facts.bot);
  if (!scope) throw new PinError('agent_unavailable', 'The Agent has no session scope; the owner must choose one.');
  if (scope.kind === 'sessions') {
    throw new PinError('no_eligible_session', 'This Agent is limited to selected sessions and none can take a message now; it cannot start a new one.');
  }
  const workspace = expandHome(facts.bot.default_workspace)
    ?? (scope.kind === 'workspaces' && scope.workspaces.length === 1 ? expandHome(scope.workspaces[0]) : null);
  if (!workspace) {
    throw new PinError('workspace_required', 'This Agent has no session that can take a message, and no default workspace for a new one. Ask the owner to set a default workspace, or pin one of its sessions.');
  }
  return { kind: 'start', workspace };
}

export async function messageAgent(input: MessageAgentInput): Promise<MessageAgentResult> {
  const keyText = checkKey(input.idempotencyKey);
  const pinKey = `agent:${keyText}`;
  const turnKey = `agent:${keyText}`;
  const content = checkContent(input.content);
  const hash = sha256(['agent', input.agentId, content, input.conversationId ?? null]);
  const replay = pinByKey(input.requester, pinKey);
  if (replay) {
    if (replay.request_hash !== hash) throw new PinError('idempotency_conflict', 'That idempotency key was used for a different message.');
    input.onResolved?.({ agentId: replay.agent_id, sessionRef: replay.session_ref, resolution: replay.resolution });
    const first = turnByKey(input.requester, turnKey);
    if (first) return { pin: replay, turn: turnViewOf(replay, first), replayed: true, resolution: replay.resolution, settled: Promise.resolve() };
    // The pin exists but its first turn was refused: retry it on the same
    // pinned session, never a newly resolved one.
    if (replay.state !== 'attached') throw new PinError('pin_detached', 'This pin was detached before its first turn ran. Message the Agent again with a new key.');
    const retried = await sendOn(replay, input.requester, turnKey, sha256(['turn', replay.id, content]), content, input.now ?? Date.now());
    return { ...retried, resolution: replay.resolution };
  }
  if (input.conversationId) requireVisibleConversation(input.requester, input.conversationId);
  else if (input.requester.kind !== 'service') throw new PinError('invalid_request', 'conversation_id is required: the thread that holds this conversation.');
  if (bots.getById(input.agentId)) await warmAgentProvider(db, input.agentId);
  const facts = agentFacts(input.agentId);
  const target = await resolveTarget(facts);
  const now = input.now ?? Date.now();
  if (target.kind === 'session') {
    input.onResolved?.({ agentId: input.agentId, sessionRef: target.summary.ref, resolution: target.resolution });
    const pin = db.transaction(() => {
      const raced = pinByKey(input.requester, pinKey);
      if (raced) return raced;
      const row = insertPin({
        requester: input.requester, key: pinKey, hash, agentId: input.agentId, sessionRef: target.summary.ref, action: 'ask',
        resolution: target.resolution, route: target.route,
        conversationId: input.conversationId ?? openConversation(input.requester, input.agentId, now), approved: false, now,
      });
      input.onCommit?.(row);
      return row;
    }).immediate();
    const sent = await sendOn(pin, input.requester, turnKey, sha256(['turn', pin.id, content]), content, now);
    return { ...sent, resolution: target.resolution };
  }
  input.onResolved?.({ agentId: input.agentId, sessionRef: null, resolution: 'started' });
  let started: Awaited<ReturnType<typeof startProviderSession>>;
  try {
    started = await startProviderSession(db, input.agentId, {
      workspace: target.workspace, prompt: content, authority: 'read_only', idempotencyKey: innerKey(input.agentId, turnKey), requester: input.requester,
    });
  } catch (error) {
    rethrow(error);
  }
  input.onResolved?.({ agentId: input.agentId, sessionRef: started.turn.session_ref, resolution: 'started' });
  const { pin, turn } = db.transaction(() => {
    const raced = pinByKey(input.requester, pinKey);
    if (raced) return { pin: raced, turn: turnByKey(input.requester, turnKey) as PinTurnRow };
    const row = insertPin({
      requester: input.requester, key: pinKey, hash, agentId: input.agentId, sessionRef: started.turn.session_ref, action: 'ask',
      resolution: 'started', route: 'provider',
      conversationId: input.conversationId ?? openConversation(input.requester, input.agentId, now), approved: false, now,
    });
    const first = insertTurn(row, input.requester, turnKey, sha256(['turn', row.id, content]), content, { providerTurnRef: started.turn.turn_ref }, now);
    input.onCommit?.(row);
    return { pin: row, turn: first };
  }).immediate();
  return { pin, turn: turnViewOf(pin, turn), replayed: false, resolution: 'started', settled: observe(pin, turn, null) };
}

// ---------------------------------------------------------------------
// Reading and detaching.

// The pin and its newest turns (oldest first). Running provider turns are
// observed briefly first, so a read after a restart records what finished.
export async function readPin(requester: Principal, pinRef: string): Promise<{ pin: PinRow; turns: PinTurnView[] }> {
  const pin = requirePin(requester, pinRef);
  const rows = (db.prepare('SELECT * FROM session_pin_turns WHERE pin_id = ? ORDER BY seq DESC LIMIT ?').all(pin.id, TURN_PAGE) as PinTurnRow[]).reverse();
  for (const row of rows) {
    if (!row.provider_turn_ref || row.answer_message_id) continue;
    if (turnState(row).state === 'running') await observe(pin, row, OBSERVE_WAIT_MS);
    else recordAnswer(row.id);
  }
  return { pin, turns: rows.map(row => turnViewOf(pin, db.prepare('SELECT * FROM session_pin_turns WHERE id = ?').get(row.id) as PinTurnRow)) };
}

// Idempotent: detaching a detached pin changes nothing (replayed).
export function detachPin(requester: Principal, pinRef: string, options: { now?: number; onCommit?: (pin: PinRow) => void } = {}): { pin: PinRow; replayed: boolean } {
  return db.transaction(() => {
    const pin = requirePin(requester, pinRef);
    if (pin.state === 'detached') {
      options.onCommit?.(pin);
      return { pin, replayed: true };
    }
    detachRow(pin, 'detached', null, options.now ?? Date.now());
    const updated = pinRow(pin.id) as PinRow;
    options.onCommit?.(updated);
    return { pin: updated, replayed: false };
  }).immediate();
}

export function pinEvents(pinId: string): { sequence: number; type: string; data: Record<string, unknown>; at: number }[] {
  return (db.prepare('SELECT sequence, type, data, created_at FROM session_pin_events WHERE pin_id = ? ORDER BY sequence ASC').all(pinId) as
    { sequence: number; type: string; data: string; created_at: number }[])
    .map(row => ({ sequence: row.sequence, type: row.type, data: JSON.parse(row.data) as Record<string, unknown>, at: row.created_at }));
}
