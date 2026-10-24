// NOT-499: granted service access to Agents, sessions, conversations, and
// exchanges (docs/service-grants.md).
//
// A service principal sees only what the owner granted it in the
// service-grants document (lib/service-grants), per Agent and capability:
//
//   agents:read          discover the Agent
//   sessions:read        list and read the Agent's sessions (lib/session-catalog)
//   conversations:read   list and read the Agent's conversations
//   sessions:message     send one read-only turn to an exact active session
//   exchanges:read       read the exchanges it started (lib/session-exchanges)
//   exchanges:create     start and cancel an Ask or Continue exchange
//   sessions:start       NOT-507: let a registered-Agent message start a new
//                        read-only session when the Agent has none to take it
//   sessions:resume      NOT-507: pin a session to resume work in it with
//                        workspace-write authority (explicitly approved)
//   shares:create        NOT-515: create, read, list, and revoke the caller's
//                        own temporary ask-only shares of the Agent's
//                        sessions (lib/session-shares)
//
// Every service here reads the canonical stores and writes only through
// them; nothing is copied. A target outside the caller's grants is refused
// with exactly the error (code and message) of a target that does not
// exist. A view never carries a provider session or run id, a Deck
// credential or selection, a working directory, or a tool profile choice.
import { randomUUID } from 'crypto';
import db, { bots, type Bot, type Principal, type PrincipalKind } from './db';
import { resolveAgent } from './bot-definition';
import { readStoredPolicy } from './agent-registration';
import { EXCHANGE_LIMITS, type SessionBinding } from './engine-store';
import { getAgentSession, isSessionFilter, listAgentSessions, type SessionDetail, type SessionFilter, type SessionSummary } from './session-catalog';
import { ExchangeError, cancelReasonFromBody, type CreateExchangeInput, type ExchangeMode, type ExchangeView, type SessionExchange } from './session-exchanges';
import { apiStateOf, cancelExchangeCommand, dispatchExchange, exchanges, getExchangeView } from './agent-conversations';
import { EXCHANGE_KEY_PREFIX, MESSAGE_KEY_PREFIX, SERVICE_CAPABILITIES, loadServiceGrants, type ServiceCapability } from './service-grants';
import { serviceRedactor } from './service-redaction';
import { recoveryFor, type Recovery, type SessionActions } from './session-actions';
import { warmAgentProvider } from './provider-sessions';
import {
  ShareError,
  createShare,
  isSlackAudience,
  revokeShare,
  shareRow,
  shareView,
  sharesCreatedBy,
  type ShareRow,
  type ShareState,
  type ShareView,
  type SlackAudience,
} from './session-shares';
import {
  PinError,
  createPin,
  detachPin,
  messageAgent,
  pinView,
  readPin,
  requirePin,
  sendPinTurn,
  sessionOwner,
  sessionsWithActions,
  type PinAction,
  type PinResolution,
  type PinRow,
  type SessionWithActions,
} from './session-pins';

export type ServiceApiErrorCode =
  | 'invalid_request'
  | 'unsupported_field'
  | 'authority_not_allowed'
  | 'principal_not_allowed'
  | 'grant_required'
  | 'grants_unavailable'
  | 'agent_not_found'
  | 'session_not_found'
  | 'conversation_not_found'
  | 'exchange_not_found'
  | 'session_ended'
  | 'session_not_resumable'
  | 'source_session_busy'
  | 'agent_unavailable'
  | 'destination_invalid'
  | 'recursive_exchange'
  | 'idempotency_conflict'
  | 'exchange_terminal'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  // NOT-507: registered-Agent messaging and session pins.
  | 'pin_not_found'
  | 'pin_detached'
  | 'workspace_required'
  | 'no_eligible_session'
  | 'session_missing'
  | 'action_unavailable'
  | 'approval_required'
  | 'provider_failed'
  // NOT-515: session shares.
  | 'share_not_found'
  | 'share_expired'
  | 'share_revoked'
  | 'share_turn_in_progress'
  | 'share_turn_limit'
  | 'audience_not_allowed';

export const SERVICE_API_ERROR_STATUS: Record<ServiceApiErrorCode, number> = {
  invalid_request: 400,
  unsupported_field: 400,
  authority_not_allowed: 403,
  principal_not_allowed: 403,
  grant_required: 403,
  grants_unavailable: 503,
  agent_not_found: 404,
  session_not_found: 404,
  conversation_not_found: 404,
  exchange_not_found: 404,
  session_ended: 409,
  session_not_resumable: 409,
  source_session_busy: 409,
  agent_unavailable: 409,
  destination_invalid: 400,
  recursive_exchange: 403,
  idempotency_conflict: 409,
  exchange_terminal: 409,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  pin_not_found: 404,
  pin_detached: 409,
  workspace_required: 409,
  no_eligible_session: 409,
  session_missing: 410,
  action_unavailable: 409,
  approval_required: 403,
  provider_failed: 502,
  share_not_found: 404,
  share_expired: 410,
  share_revoked: 410,
  share_turn_in_progress: 409,
  share_turn_limit: 409,
  audience_not_allowed: 403,
};

// denied: the caller may not see or do it (a refusal indistinguishable
// from a missing target). rejected: the input or the target state.
const DENIED_CODES: ServiceApiErrorCode[] = [
  'principal_not_allowed', 'grant_required', 'grants_unavailable', 'agent_not_found', 'session_not_found', 'conversation_not_found', 'exchange_not_found', 'rate_limited',
  'pin_not_found', 'share_not_found', 'audience_not_allowed',
];

export class ServiceApiError extends Error {
  readonly code: ServiceApiErrorCode;
  // Internal only (the audit trail): a refusal because of the grants,
  // reported to the caller exactly like a missing target.
  readonly notGranted: boolean;
  // The offending input fields, when a caller-side validation names them
  // (the MCP bridge's tool arguments).
  readonly fields: string[] | undefined;
  // NOT-507: what the caller can do next (lib/session-actions recoveryFor).
  readonly recovery: Recovery | null;
  constructor(code: ServiceApiErrorCode, message: string, options: { notGranted?: boolean; fields?: string[] } = {}) {
    super(message);
    this.name = 'ServiceApiError';
    this.code = code;
    this.notGranted = options.notGranted === true;
    this.fields = options.fields;
    this.recovery = recoveryFor(code);
  }
  get status(): number {
    return SERVICE_API_ERROR_STATUS[this.code];
  }
  get denied(): boolean {
    return DENIED_CODES.includes(this.code);
  }
}

// The one message per missing-or-not-granted target.
const NOT_FOUND = {
  pin: () => new ServiceApiError('pin_not_found', 'No pin with that reference is visible to this principal.'),
  share: () => new ServiceApiError('share_not_found', 'No share with that reference is visible to this principal.'),
  agent: () => new ServiceApiError('agent_not_found', 'No Agent with that id is visible to this principal.'),
  session: () => new ServiceApiError('session_not_found', 'No session with that reference is visible to this principal.'),
  conversation: () => new ServiceApiError('conversation_not_found', 'No conversation with that id is visible to this principal.'),
  exchange: () => new ServiceApiError('exchange_not_found', 'No exchange with that id is visible to this principal.'),
};

function notGranted(kind: keyof typeof NOT_FOUND): ServiceApiError {
  const base = NOT_FOUND[kind]();
  return new ServiceApiError(base.code, base.message, { notGranted: true });
}

// Exchange store refusals in this envelope. The store's messages name only
// targets the caller was granted, or the caller's own input.
export function serviceErrorFromExchange(error: ExchangeError): ServiceApiError {
  switch (error.code) {
    case 'exchange_not_found': return NOT_FOUND.exchange();
    case 'session_not_found': return NOT_FOUND.session();
    case 'agent_not_found': return NOT_FOUND.agent();
    case 'conversation_not_found': return NOT_FOUND.conversation();
    case 'invalid_transition': return new ServiceApiError('conflict', 'The exchange changed concurrently; read it and retry.');
    default:
      return error.code in SERVICE_API_ERROR_STATUS
        ? new ServiceApiError(error.code as ServiceApiErrorCode, error.message)
        : new ServiceApiError('invalid_request', error.message);
  }
}

// ---------------------------------------------------------------------
// Grants

export interface ServiceContext {
  principal: Principal;
  mode: 'granted' | 'narrow';
  agents: ReadonlyMap<string, ReadonlySet<ServiceCapability>>;
}

const EMPTY: ReadonlyMap<string, ReadonlySet<ServiceCapability>> = new Map();

// The caller's grants. Only service principals have any. A malformed
// document grants nothing to anyone (grants_unavailable); a missing one is
// the narrow mode with no Agents.
export function serviceContext(principal: Principal): ServiceContext {
  if (principal.kind !== 'service') {
    throw new ServiceApiError('principal_not_allowed', 'The granted service API accepts only service principals.');
  }
  const loaded = loadServiceGrants();
  if (loaded.state === 'invalid') {
    throw new ServiceApiError('grants_unavailable', 'The service grants are not available; the owner must fix the grants document.');
  }
  if (loaded.state === 'absent') return { principal, mode: 'narrow', agents: EMPTY };
  return { principal, mode: 'granted', agents: loaded.grants.get(principal.id) ?? EMPTY };
}

// Granted and the Agent still exists.
export function holds(ctx: ServiceContext, agentId: string | null | undefined, capability: ServiceCapability): boolean {
  return typeof agentId === 'string' && !!ctx.agents.get(agentId)?.has(capability) && !!bots.getById(agentId);
}

function requireAgent(ctx: ServiceContext, agentId: string, capability: ServiceCapability): Bot {
  const bot = bots.getById(agentId);
  if (!bot) throw NOT_FOUND.agent();
  if (!holds(ctx, agentId, capability)) throw notGranted('agent');
  return bot;
}

// ---------------------------------------------------------------------
// Pagination: newest activity first, ties by newer creation, then id
// ascending; the cursor is the last row's key, bound to the list it came
// from.

export const PAGE_LIMITS = Object.freeze({ default: 20, max: 100, messagesDefault: 50, messagesMax: 200 });

interface PageKey { at: number; tie: number; id: string }

function compareKeys(a: PageKey, b: PageKey): number {
  return b.at - a.at || b.tie - a.tie || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function encodeCursor(scope: string, key: PageKey): string {
  return Buffer.from(JSON.stringify({ s: scope, a: key.at, t: key.tie, i: key.id }), 'utf8').toString('base64url');
}

function decodeCursor(scope: string, cursor: string | null): PageKey | null {
  if (cursor === null || cursor === '') return null;
  const invalid = new ServiceApiError('invalid_request', 'cursor is not a cursor of this list.');
  if (cursor.length > 1024) throw invalid;
  let value: { s?: unknown; a?: unknown; t?: unknown; i?: unknown };
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (!value || value.s !== scope || typeof value.a !== 'number' || typeof value.t !== 'number' || typeof value.i !== 'string') throw invalid;
  return { at: value.a, tie: value.t, id: value.i };
}

export function parseLimit(value: string | null, fallback: number = PAGE_LIMITS.default, max: number = PAGE_LIMITS.max): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new ServiceApiError('invalid_request', `limit must be an integer from 1 to ${max}.`);
  }
  return Number(value);
}

export interface Page<T> { items: T[]; next_cursor: string | null }

function paginate<T>(scope: string, rows: T[], keyOf: (row: T) => PageKey, cursor: string | null, limit: number): Page<T> {
  const after = decodeCursor(scope, cursor);
  const sorted = [...rows].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const remaining = after ? sorted.filter(row => compareKeys(keyOf(row), after) > 0) : sorted;
  const items = remaining.slice(0, limit);
  const next = remaining.length > limit ? encodeCursor(scope, keyOf(items[items.length - 1])) : null;
  return { items, next_cursor: next };
}

export interface ListQuery { cursor: string | null; limit: number }

// ---------------------------------------------------------------------
// Capabilities and Agents

export function capabilitiesView(ctx: ServiceContext) {
  const agents = [...ctx.agents.entries()]
    .filter(([agentId]) => !!bots.getById(agentId))
    .map(([agentId, caps]) => ({ agent_id: agentId, capabilities: SERVICE_CAPABILITIES.filter(cap => caps.has(cap)) }))
    .sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0));
  return {
    principal: { kind: ctx.principal.kind, id: ctx.principal.id },
    mode: ctx.mode,
    vocabulary: SERVICE_CAPABILITIES,
    agents,
    limits: {
      page: PAGE_LIMITS,
      content_chars: EXCHANGE_LIMITS.instructionChars,
      message_content_chars: MESSAGE_CONTENT_LIMIT,
    },
  };
}

export interface ServiceAgentView {
  agent_id: string;
  name: string;
  title: string;
  runtime: string;
  available: boolean;
  capabilities: ServiceCapability[];
  // NOT-507: additive. How a message to this Agent (POST
  // /agents/{id}/messages) resolves: its configured home session, if any,
  // and whether its policy lets it start a new session in its default
  // workspace. The workspace itself is never shown or chosen by a caller.
  messaging: { home_session_ref: string | null; new_sessions_allowed: boolean; default_workspace_set: boolean };
  created_at: number;
  last_activity_at: number;
}

function agentActivity(bot: Bot): number {
  const row = db.prepare(`
    SELECT MAX(m.created_at) AS at FROM messages m
    JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.participant_kind = 'bot' AND p.participant_id = ?
  `).get(bot.id) as { at: number | null };
  return Math.max(bot.created_at, row.at ?? 0);
}

function agentView(ctx: ServiceContext, bot: Bot): ServiceAgentView {
  const resolved = resolveAgent(bot);
  const caps = ctx.agents.get(bot.id) ?? new Set<ServiceCapability>();
  return {
    agent_id: bot.id,
    name: bot.name,
    title: bot.title,
    runtime: resolved.agent,
    available: resolved.launchable,
    capabilities: SERVICE_CAPABILITIES.filter(cap => caps.has(cap)),
    messaging: {
      home_session_ref: bot.home_session_id ?? null,
      new_sessions_allowed: readStoredPolicy(bot)?.allow_new_sessions === true,
      default_workspace_set: !!bot.default_workspace,
    },
    created_at: bot.created_at,
    last_activity_at: agentActivity(bot),
  };
}

export function listServiceAgents(ctx: ServiceContext, query: ListQuery): Page<ServiceAgentView> {
  const rows = [...ctx.agents.keys()]
    .filter(agentId => holds(ctx, agentId, 'agents:read'))
    .map(agentId => agentView(ctx, bots.getById(agentId) as Bot));
  return paginate(`agents:${ctx.principal.id}`, rows, row => ({ at: row.last_activity_at, tie: row.created_at, id: row.agent_id }), query.cursor, query.limit);
}

export function getServiceAgent(ctx: ServiceContext, agentId: string): ServiceAgentView {
  return agentView(ctx, requireAgent(ctx, agentId, 'agents:read'));
}

// ---------------------------------------------------------------------
// Sessions (lib/session-catalog). The catalog already omits the provider
// session id; the launch context (working directory, Deck) is dropped too.

export interface ServiceSessionView {
  ref: string;
  agent: { id: string; name: string; adapter: string; transport: string | null };
  title: string;
  status: SessionSummary['status'];
  resumable: boolean;
  // NOT-503: additive. Independent provider facts and the session's source.
  source: SessionSummary['source'];
  state: SessionSummary['state'];
  created_at: number;
  ended_at: number | null;
  last_activity_at: number;
  origin: {
    conversation: { id: string; kind: 'direct' | 'group' | 'agent_api'; label: string } | null;
    work_request: SessionSummary['origin']['work_request'];
  };
  // NOT-509: additive. Normalized provider-reported usage only (sums,
  // known/total coverage, quality); never a raw provider breakdown.
  usage: SessionSummary['usage'];
  // NOT-507: additive. Whether this is the Agent's home session, and what
  // each session action (lib/session-actions) can do now.
  home: boolean;
  actions: SessionActions;
}

function sessionView(summary: SessionWithActions): ServiceSessionView {
  const conversation = summary.origin.conversation;
  return {
    ref: summary.ref,
    agent: { ...summary.agent },
    title: summary.title,
    status: summary.status,
    resumable: summary.resumable,
    source: summary.source,
    state: { ...summary.state },
    created_at: summary.created_at,
    ended_at: summary.ended_at,
    last_activity_at: summary.last_activity_at,
    origin: {
      conversation: conversation ? { id: conversation.id, kind: conversation.kind, label: conversation.label } : null,
      work_request: summary.origin.work_request,
    },
    usage: {
      input_tokens: { ...summary.usage.input_tokens },
      output_tokens: { ...summary.usage.output_tokens },
      cost_usd: { ...summary.usage.cost_usd },
    },
    home: summary.home,
    actions: summary.actions,
  };
}

// NOT-507: after the grant check, probes the Agent's runtime so the
// sessions' action availability reflects its real capabilities.
export async function warmServiceAgent(ctx: ServiceContext, agentId: string): Promise<void> {
  requireAgent(ctx, agentId, 'sessions:read');
  await warmAgentProvider(db, agentId, { onlyWithSessions: true });
}

export function listServiceSessions(ctx: ServiceContext, agentId: string, query: ListQuery & { status: string | null }): Page<ServiceSessionView> {
  requireAgent(ctx, agentId, 'sessions:read');
  const status = query.status ?? 'all';
  if (!isSessionFilter(status)) throw new ServiceApiError('invalid_request', 'status must be active, ended, or all.');
  const redactor = serviceRedactor();
  const rows = sessionsWithActions(agentId, listAgentSessions(db, agentId, status as SessionFilter)).map(summary => redactor.deep(sessionView(summary)));
  return paginate(`sessions:${agentId}:${status}`, rows, row => ({ at: row.last_activity_at, tie: row.created_at, id: row.ref }), query.cursor, query.limit);
}

export function getServiceSession(
  ctx: ServiceContext, agentId: string, ref: string,
): ServiceSessionView & { attempts: SessionDetail['attempts']; usage_samples: SessionDetail['usage_samples'] } {
  requireAgent(ctx, agentId, 'sessions:read');
  const detail = getAgentSession(db, agentId, ref);
  if (!detail) throw NOT_FOUND.session();
  return serviceRedactor().deep({
    ...sessionView(sessionsWithActions(agentId, [detail])[0]),
    attempts: detail.attempts,
    usage_samples: detail.usage_samples.map(sample => ({ ...sample })),
  });
}

// ---------------------------------------------------------------------
// Conversations. A conversation is visible under an Agent when that Agent
// participates, every Agent participant is granted conversations:read to
// the caller, and no other service participates (one service never reads
// another's conversation). Provider session and run ids, working
// directories, Deck selections, and credentials the runtime may have
// echoed into a message are redacted.

export const MESSAGE_CONTENT_LIMIT = 16000;

interface ConversationRow {
  id: string;
  type: string;
  bot_id: string | null;
  group_id: string | null;
  origin_kind: PrincipalKind | null;
  origin_id: string | null;
  created_at: number;
  last_activity_at: number;
  message_count: number;
  bot_name: string | null;
  group_name: string | null;
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.type, c.bot_id, c.group_id, c.origin_kind, c.origin_id, c.created_at,
    COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS last_activity_at,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
    b.name AS bot_name, g.name AS group_name
  FROM conversations c
  JOIN conversation_participants p ON p.conversation_id = c.id AND p.participant_kind = 'bot' AND p.participant_id = ?
  LEFT JOIN bots b ON b.id = c.bot_id
  LEFT JOIN groups g ON g.id = c.group_id
`;

function participantsOf(conversationId: string): Principal[] {
  return (db.prepare(
    'SELECT participant_kind AS kind, participant_id AS id FROM conversation_participants WHERE conversation_id = ? ORDER BY joined_at ASC, rowid ASC'
  ).all(conversationId) as Principal[]);
}

function conversationVisible(ctx: ServiceContext, participants: Principal[]): boolean {
  return participants.every(p => p.kind === 'bot'
    ? holds(ctx, p.id, 'conversations:read')
    : p.kind !== 'service' || p.id === ctx.principal.id);
}

export interface ServiceConversationSummary {
  conversation_id: string;
  type: 'agent' | 'direct' | 'group';
  label: string;
  participants: Principal[];
  message_count: number;
  created_at: number;
  last_activity_at: number;
}

function conversationSummary(row: ConversationRow, participants: Principal[]): ServiceConversationSummary {
  const type = row.type === 'bot' ? 'direct' : row.type === 'group' ? 'group' : 'agent';
  const label = type === 'direct' ? `${row.bot_name ?? 'Agent'} thread`
    : type === 'group' ? (row.group_name ? `Group ${row.group_name}` : 'Group thread')
      : 'Agent API conversation';
  return {
    conversation_id: row.id, type, label, participants,
    message_count: row.message_count, created_at: row.created_at, last_activity_at: row.last_activity_at,
  };
}

export function listServiceConversations(ctx: ServiceContext, agentId: string, query: ListQuery): Page<ServiceConversationSummary> {
  requireAgent(ctx, agentId, 'conversations:read');
  const rows = (db.prepare(CONVERSATION_SELECT).all(agentId) as ConversationRow[]).flatMap(row => {
    const participants = participantsOf(row.id);
    return conversationVisible(ctx, participants) ? [conversationSummary(row, participants)] : [];
  });
  return paginate(`conversations:${agentId}`, rows, row => ({ at: row.last_activity_at, tie: row.created_at, id: row.conversation_id }), query.cursor, query.limit);
}

interface MessageRow {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id: string | null;
  sender_kind: PrincipalKind | null;
  request_id: string | null;
  content: string;
  created_at: number;
  seq: number;
}

export interface ServiceConversationDetail extends ServiceConversationSummary {
  messages: {
    message_id: string;
    seq: number;
    sender: Principal;
    content: string;
    truncated: boolean;
    request_id: string | null;
    created_at: number;
  }[];
  // The next page of older messages, or null at the first message.
  next_cursor: string | null;
}

export function getServiceConversation(ctx: ServiceContext, agentId: string, conversationId: string, query: ListQuery): ServiceConversationDetail {
  requireAgent(ctx, agentId, 'conversations:read');
  const row = db.prepare(`${CONVERSATION_SELECT} WHERE c.id = ?`).get(agentId, conversationId) as ConversationRow | undefined;
  if (!row) throw NOT_FOUND.conversation();
  const participants = participantsOf(row.id);
  if (!conversationVisible(ctx, participants)) throw notGranted('conversation');
  const scope = `messages:${row.id}`;
  const before = decodeCursor(scope, query.cursor);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT m.id, m.sender_type, m.sender_id, m.sender_kind, m.request_id, m.content, m.created_at,
        ROW_NUMBER() OVER (ORDER BY m.rowid ASC) AS seq
      FROM messages m WHERE m.conversation_id = ?
    ) WHERE seq < ? ORDER BY seq DESC LIMIT ?
  `).all(row.id, before ? before.at : Number.MAX_SAFE_INTEGER, query.limit + 1) as MessageRow[];
  const page = rows.slice(0, query.limit).reverse();
  const redactor = serviceRedactor();
  return {
    ...conversationSummary(row, participants),
    messages: page.map(message => {
      const content = redactor.text(message.content);
      return {
        message_id: message.id,
        seq: message.seq,
        sender: senderOf(message, row),
        content: content.length > MESSAGE_CONTENT_LIMIT ? content.slice(0, MESSAGE_CONTENT_LIMIT) : content,
        truncated: content.length > MESSAGE_CONTENT_LIMIT,
        request_id: message.request_id,
        created_at: message.created_at,
      };
    }),
    next_cursor: rows.length > query.limit && page.length > 0 ? encodeCursor(scope, { at: page[0].seq, tie: 0, id: page[0].id }) : null,
  };
}

// Legacy UI user messages carry no sender id; they were written by the
// conversation's UI owner origin (as in lib/agent-conversations).
function senderOf(row: MessageRow, conversation: { origin_kind: PrincipalKind | null; origin_id: string | null }): Principal {
  const kind: PrincipalKind = row.sender_kind ?? (row.sender_type === 'bot' ? 'bot' : 'person');
  if (row.sender_id) return { kind, id: row.sender_id };
  if (kind !== 'bot' && conversation.origin_kind === kind && conversation.origin_id) return { kind, id: conversation.origin_id };
  return { kind, id: 'unknown' };
}

// ---------------------------------------------------------------------
// Input: only the documented fields. A field that asks for authority the
// engine owns (runtime, Deck, model, tool profile, provider session,
// grants, principal) is refused as authority_not_allowed; any other
// unknown field is invalid_request. Both before anything is written.

export const AUTHORITY_FIELDS = [
  'deck', 'deck_id', 'deckId', 'deck_name', 'runtime', 'agent', 'adapter', 'transport', 'model',
  'tool_profile', 'toolProfile', 'execution_kind', 'executionKind', 'permissions',
  'provider_session_id', 'external_session_id', 'externalSessionId', 'session_id', 'sessionId', 'resume', 'resume_session', 'fresh_session',
  'external_run_id', 'run_id', 'cwd', 'working_directory', 'workspace',
  'grant', 'grants', 'capability', 'capabilities', 'principal', 'requester', 'owner',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkFields(body: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (AUTHORITY_FIELDS.includes(key)) {
      throw new ServiceApiError('authority_not_allowed', `${where}${key} is chosen by Botmancers from the session and the Agent's configuration; a caller cannot set it.`);
    }
    throw new ServiceApiError('invalid_request', `${where}${key} is not a field of this request.`);
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ServiceApiError('invalid_request', `${field} is required.`);
  if (value.length > max) throw new ServiceApiError('invalid_request', `${field} exceeds ${max} characters.`);
  return value;
}

function idempotencyKeyOf(body: Record<string, unknown>, header: string | null): string {
  const fromBody = body.idempotency_key;
  if (fromBody !== undefined && typeof fromBody !== 'string') throw new ServiceApiError('invalid_request', 'idempotency_key must be a string.');
  if (header !== null && fromBody !== undefined && header !== fromBody) {
    throw new ServiceApiError('invalid_request', 'Idempotency-Key header and body idempotency_key differ.');
  }
  const key = (fromBody as string | undefined) ?? header ?? '';
  if (key.trim().length === 0 || key.length > 160) throw new ServiceApiError('invalid_request', 'An idempotency key (1-160 characters) is required.');
  return key;
}


function existingExchange(principal: Principal, key: string): SessionExchange | undefined {
  return db.prepare('SELECT * FROM session_exchanges WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?')
    .get(principal.kind, principal.id, key) as SessionExchange | undefined;
}

// A fresh agent conversation the service opened, with the Agent it talks to.
function openServiceConversation(principal: Principal, agentId: string, at: number): string {
  const id = randomUUID();
  db.prepare('INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'agent', principal.kind, principal.id, at);
  const participant = db.prepare(
    'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)'
  );
  participant.run(id, principal.kind, principal.id, at);
  participant.run(id, 'bot', agentId, at);
  return id;
}

function bindingOf(ref: string): SessionBinding | undefined {
  return db.prepare('SELECT * FROM session_bindings WHERE id = ?').get(ref) as SessionBinding | undefined;
}

// Called inside the transaction that records a mutation, after its rows are
// written and before it commits: the HTTP boundary appends the allowed audit
// event here, so a mutation commits only together with its audit event (and
// is dispatched only after both).
export type CommitHook = (row: SessionExchange) => void;

function createThroughStore(
  build: () => { input: CreateExchangeInput; afterCreate?: (row: SessionExchange) => void },
  onCommit?: CommitHook,
): { exchange: SessionExchange; created: boolean } {
  try {
    return db.transaction(() => {
      const { input, afterCreate } = build();
      const result = exchanges.create(input);
      if (result.created && afterCreate) afterCreate(result.exchange);
      onCommit?.(result.exchange);
      return result;
    }).immediate();
  } catch (error) {
    if (error instanceof ExchangeError) throw serviceErrorFromExchange(error);
    throw error;
  }
}

// ---------------------------------------------------------------------
// Same-Agent session messaging: one read-only conversation turn on exactly
// the referenced active binding, under its owning Agent, as an Ask exchange
// (lib/session-exchanges). The Deck, runtime, and tool profile come from
// the binding and the Agent's stored configuration; the caller sends only
// content and an idempotency key. The turn's question and answer appear in
// one conversation the service owns per session (opened on the first
// message), which the caller polls through /api/v0/conversations and
// /api/v0/requests.

export interface SessionMessageAccepted {
  session_ref: string;
  agent_id: string;
  exchange_id: string;
  request_id: string;
  conversation_id: string;
  message_id: string | null;
  state: ReturnType<typeof apiStateOf>;
  replayed: boolean;
}

export function parseSessionMessageBody(body: unknown, header: string | null): { content: string; idempotencyKey: string } {
  if (!isObject(body)) throw new ServiceApiError('invalid_request', 'The body must be a JSON object.');
  checkFields(body, ['content', 'idempotency_key'], '');
  const idempotencyKey = idempotencyKeyOf(body, header);
  return { content: requireText(body.content, 'content', EXCHANGE_LIMITS.instructionChars), idempotencyKey };
}

export function sendServiceSessionMessage(
  ctx: ServiceContext, ref: string, input: { content: string; idempotencyKey: string }, onCommit?: CommitHook,
): { accepted: SessionMessageAccepted; dispatched: Promise<void> } {
  const binding = bindingOf(ref);
  if (!binding) {
    // NOT-503: a native session (no binding) is listed but cannot take a
    // session message yet; the grant check still comes first.
    const native = db.prepare('SELECT agent_id FROM provider_sessions WHERE id = ? AND binding_id IS NULL').get(ref) as { agent_id: string } | undefined;
    if (native && holds(ctx, native.agent_id, 'sessions:message')) {
      throw new ServiceApiError('session_not_resumable', 'This session is not reachable through session messages.');
    }
    throw NOT_FOUND.session();
  }
  if (!holds(ctx, binding.agent_id, 'sessions:message')) throw notGranted('session');
  const principal = ctx.principal;
  const key = `${MESSAGE_KEY_PREFIX}${input.idempotencyKey}`;
  const { exchange, created } = createThroughStore(() => {
    const now = Date.now();
    const replay = existingExchange(principal, key);
    // One conversation per (service, session): the one its first message opened.
    const standing = db.prepare(`
      SELECT origin_conversation_id FROM session_exchanges
      WHERE requester_kind = ? AND requester_id = ? AND source_binding_id = ? AND mode = 'ask' AND idempotency_key LIKE 'message:%'
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(principal.kind, principal.id, binding.id) as { origin_conversation_id: string } | undefined;
    const origin = replay?.origin_conversation_id ?? standing?.origin_conversation_id ?? openServiceConversation(principal, binding.agent_id, now);
    return {
      input: {
        requester: principal, serviceGrant: true, idempotencyKey: key, mode: 'ask', originConversationId: origin,
        sourceAgentId: binding.agent_id, sessionRef: binding.id, instruction: input.content, now,
      },
      // The question, as the service's message in its conversation.
      afterCreate: row => {
        db.prepare(
          'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), row.origin_conversation_id, 'user', principal.id, principal.kind, row.source_request_id, input.content, now);
      },
    };
  }, onCommit);
  const dispatched = dispatchExchange(exchange.id);
  const request = exchange.source_request_id ? db.prepare('SELECT state FROM work_requests WHERE id = ?').get(exchange.source_request_id) as { state: Parameters<typeof apiStateOf>[0] } | undefined : undefined;
  const message = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND request_id = ? AND sender_kind = ? ORDER BY rowid ASC LIMIT 1')
    .get(exchange.origin_conversation_id, exchange.source_request_id, principal.kind) as { id: string } | undefined;
  return {
    accepted: {
      session_ref: binding.id,
      agent_id: binding.agent_id,
      exchange_id: exchange.id,
      request_id: exchange.source_request_id as string,
      conversation_id: exchange.origin_conversation_id,
      message_id: message?.id ?? null,
      state: request ? apiStateOf(request.state) : 'accepted',
      replayed: !created,
    },
    dispatched,
  };
}

// ---------------------------------------------------------------------
// Exchanges (lib/session-exchanges): the caller's own, readable with
// exchanges:read on every Agent involved, created and cancelled with
// exchanges:create on every Agent involved.

function exchangeVisible(ctx: ServiceContext, row: SessionExchange, capability: ServiceCapability): boolean {
  return row.requester_kind === ctx.principal.kind && row.requester_id === ctx.principal.id
    && holds(ctx, row.source_agent_id, capability)
    && (row.destination_agent_id === null || holds(ctx, row.destination_agent_id, capability));
}

function requireExchange(ctx: ServiceContext, id: string, capability: ServiceCapability): SessionExchange {
  const row = exchanges.get(id);
  if (!row) throw NOT_FOUND.exchange();
  if (!exchangeVisible(ctx, row, capability)) throw notGranted('exchange');
  return row;
}

const exchangeKind = (row: SessionExchange) => (row.idempotency_key.startsWith(MESSAGE_KEY_PREFIX) ? 'session_message' as const : 'exchange' as const);

// The exchange view minus what only the engine needs: the caller's
// idempotency namespace is its own key again, and every answer, handoff
// packet, failure, and event a runtime wrote is redacted
// (lib/service-redaction).
function serviceExchangeView(view: ExchangeView, row: SessionExchange) {
  const key = row.idempotency_key.startsWith(MESSAGE_KEY_PREFIX) ? row.idempotency_key.slice(MESSAGE_KEY_PREFIX.length)
    : row.idempotency_key.startsWith(EXCHANGE_KEY_PREFIX) ? row.idempotency_key.slice(EXCHANGE_KEY_PREFIX.length) : row.idempotency_key;
  return serviceRedactor().deep({ ...view, kind: exchangeKind(row), idempotency_key: key });
}

export type ServiceExchangeView = ReturnType<typeof serviceExchangeView>;

// Status metadata only: no instruction, answer, packet, failure message,
// event data, conversation, or hop request.
export interface ServiceExchangeSummary {
  id: string;
  kind: 'session_message' | 'exchange';
  mode: ExchangeMode;
  state: string;
  source: { agent_id: string; session_ref: string };
  destination: { agent_id: string; session_ref: string | null } | null;
  failure: { code: string } | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

function exchangeSummary(row: SessionExchange): ServiceExchangeSummary {
  return {
    id: row.id,
    kind: exchangeKind(row),
    mode: row.mode,
    state: row.state,
    source: { agent_id: row.source_agent_id, session_ref: row.source_binding_id },
    destination: row.destination_agent_id ? { agent_id: row.destination_agent_id, session_ref: row.destination_binding_id } : null,
    failure: row.state === 'failed' ? { code: row.failure_code ?? 'failed' } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    terminal_at: row.terminal_at,
  };
}

// What a create or cancel returns: the full view only to a caller that may
// also read the exchange (exchanges:read on every Agent involved), else
// status metadata, so exchanges:create alone never reveals an answer or a
// handoff packet.
function mutationView(ctx: ServiceContext, id: string): ServiceExchangeView | ServiceExchangeSummary {
  const row = exchanges.require(id);
  return exchangeVisible(ctx, row, 'exchanges:read') ? serviceExchangeView(getExchangeView(id), row) : exchangeSummary(row);
}

export function listServiceExchanges(ctx: ServiceContext, query: ListQuery): Page<ServiceExchangeSummary> {
  const rows = (db.prepare('SELECT * FROM session_exchanges WHERE requester_kind = ? AND requester_id = ?')
    .all(ctx.principal.kind, ctx.principal.id) as SessionExchange[])
    .filter(row => exchangeVisible(ctx, row, 'exchanges:read'))
    .map(exchangeSummary);
  return paginate(`exchanges:${ctx.principal.id}`, rows, row => ({ at: row.updated_at, tie: row.created_at, id: row.id }), query.cursor, query.limit);
}

export function getServiceExchange(ctx: ServiceContext, id: string): ServiceExchangeView {
  const row = requireExchange(ctx, id, 'exchanges:read');
  return serviceExchangeView(getExchangeView(row.id), row);
}

export interface ServiceExchangeInput {
  mode: ExchangeMode;
  idempotencyKey: string;
  originConversationId: string | null;
  sourceAgentId: string | null;
  sessionRef: string;
  destinationAgentId: string | null;
  destinationConversationId: string | null;
  instruction: string;
}

const RECURSION_KEYS = ['exchange_id', 'parent_exchange_id'];

export function parseServiceExchangeBody(body: unknown, header: string | null): ServiceExchangeInput {
  if (!isObject(body)) throw new ServiceApiError('invalid_request', 'The body must be a JSON object.');
  if (RECURSION_KEYS.some(key => key in body)) throw new ServiceApiError('recursive_exchange', 'An exchange cannot be started from another exchange.');
  checkFields(body, ['mode', 'idempotency_key', 'origin_conversation_id', 'source', 'destination', 'instruction'], '');
  if (body.mode !== 'ask' && body.mode !== 'continue') throw new ServiceApiError('invalid_request', 'mode must be "ask" or "continue".');
  if (!isObject(body.source)) throw new ServiceApiError('invalid_request', 'source must be one object { session_ref, agent_id? }.');
  checkFields(body.source, ['session_ref', 'agent_id'], 'source.');
  let destination: Record<string, unknown> | null = null;
  if (body.destination !== undefined && body.destination !== null) {
    if (!isObject(body.destination)) throw new ServiceApiError('destination_invalid', 'destination must be one object { agent_id, conversation_id? }.');
    checkFields(body.destination, ['agent_id', 'conversation_id'], 'destination.');
    destination = body.destination;
  }
  const optional = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    return requireText(value, field, 200);
  };
  return {
    mode: body.mode,
    idempotencyKey: idempotencyKeyOf(body, header),
    originConversationId: optional(body.origin_conversation_id, 'origin_conversation_id'),
    sourceAgentId: optional(body.source.agent_id, 'source.agent_id'),
    sessionRef: requireText(body.source.session_ref, 'source.session_ref', 200),
    destinationAgentId: destination ? optional(destination.agent_id, 'destination.agent_id') : null,
    destinationConversationId: destination ? optional(destination.conversation_id, 'destination.conversation_id') : null,
    instruction: requireText(body.instruction, 'instruction', EXCHANGE_LIMITS.instructionChars),
  };
}

export function createServiceExchange(
  ctx: ServiceContext, input: ServiceExchangeInput, onCommit?: CommitHook,
): { exchange: ServiceExchangeView | ServiceExchangeSummary; created: boolean; dispatched: Promise<void> } {
  const binding = bindingOf(input.sessionRef);
  if (!binding || (input.sourceAgentId !== null && input.sourceAgentId !== binding.agent_id)) throw NOT_FOUND.session();
  if (!holds(ctx, binding.agent_id, 'exchanges:create')) throw notGranted('session');
  if (input.mode === 'ask' && (input.destinationAgentId !== null || input.destinationConversationId !== null)) {
    throw new ServiceApiError('destination_invalid', 'An Ask returns to the origin conversation and takes no destination.');
  }
  if (input.mode === 'continue') {
    if (input.destinationAgentId === null) throw new ServiceApiError('destination_invalid', 'A Continue names destination.agent_id.');
    if (!bots.getById(input.destinationAgentId)) throw NOT_FOUND.agent();
    if (!holds(ctx, input.destinationAgentId, 'exchanges:create')) throw notGranted('agent');
  }
  const principal = ctx.principal;
  const key = `${EXCHANGE_KEY_PREFIX}${input.idempotencyKey}`;
  const { exchange, created } = createThroughStore(() => {
    const now = Date.now();
    const replay = existingExchange(principal, key);
    const origin = input.originConversationId ?? replay?.origin_conversation_id ?? openServiceConversation(principal, binding.agent_id, now);
    // A Continue without a destination conversation is delivered into a
    // fresh conversation the service opens with the destination Agent,
    // never into the owner's direct thread.
    const destinationConversationId = input.mode !== 'continue' ? null
      : input.destinationConversationId ?? replay?.destination_conversation_id
        ?? openServiceConversation(principal, input.destinationAgentId as string, now);
    return {
      input: {
        requester: principal, serviceGrant: true, idempotencyKey: key, mode: input.mode, originConversationId: origin,
        sourceAgentId: binding.agent_id, sessionRef: binding.id, destinationAgentId: input.destinationAgentId,
        destinationConversationId, instruction: input.instruction, now,
      },
    };
  }, onCommit);
  const dispatched = dispatchExchange(exchange.id);
  return { exchange: mutationView(ctx, exchange.id), created, dispatched };
}

export function parseCancelBody(text: string): string | null {
  try {
    return cancelReasonFromBody(text);
  } catch (error) {
    if (error instanceof ExchangeError) throw serviceErrorFromExchange(error);
    throw error;
  }
}

export async function cancelServiceExchange(
  ctx: ServiceContext, id: string, reason: string | null, onCommit?: CommitHook,
): Promise<{ exchange: ServiceExchangeView | ServiceExchangeSummary; replayed: boolean }> {
  const row = requireExchange(ctx, id, 'exchanges:create');
  try {
    const { replayed } = await cancelExchangeCommand(row.id, ctx.principal, reason, onCommit);
    return { exchange: mutationView(ctx, row.id), replayed };
  } catch (error) {
    if (error instanceof ExchangeError) throw serviceErrorFromExchange(error);
    throw error;
  }
}

// ---------------------------------------------------------------------
// NOT-507: registered-Agent messaging and session pins (lib/session-pins).
// A message to an Agent resolves its home or newest eligible session (or
// starts one under policy) and pins it; a pin holds every follow-up on that
// exact session until the caller detaches or switches it. Grants apply to
// the resolved Agent and the pin's action: sessions:message for Ask
// (read-only) pins and Agent messages, sessions:start to let an Agent
// message start a session, sessions:resume for Resume (workspace-write)
// pins. A pin whose grant was withdrawn answers like a missing one.

const pinCapability = (action: PinAction): ServiceCapability => (action === 'resume' ? 'sessions:resume' : 'sessions:message');

function servicePinError(error: unknown): never {
  if (error instanceof PinError) {
    if (error.code === 'session_not_found') throw NOT_FOUND.session();
    if (error.code === 'agent_not_found') throw NOT_FOUND.agent();
    if (error.code === 'pin_not_found') throw NOT_FOUND.pin();
    if (error.code === 'conversation_not_found') throw NOT_FOUND.conversation();
    throw new ServiceApiError(error.code, error.message);
  }
  if (error instanceof ExchangeError) throw serviceErrorFromExchange(error);
  throw error;
}

function requireServicePin(ctx: ServiceContext, pinRef: string): PinRow {
  let pin: PinRow;
  try {
    pin = requirePin(ctx.principal, pinRef);
  } catch (error) {
    servicePinError(error);
  }
  if (!holds(ctx, pin.agent_id, pinCapability(pin.action))) throw notGranted('pin');
  return pin;
}

export interface PinAuditHooks {
  // The resolved Agent and session (and the capability the action used),
  // before anything is written.
  onTarget: (target: { agentId: string; sessionRef: string | null; capability: ServiceCapability; action: string }) => void;
  onCommit: () => void;
}

function pinBody(pin: PinRow) {
  return serviceRedactor().deep(pinView(pin));
}

export function parseAgentMessageBody(body: unknown, header: string | null): { content: string; idempotencyKey: string } {
  return parseSessionMessageBody(body, header);
}

export function parsePinBody(body: unknown, header: string | null): { action: PinAction; approveWrite: boolean; replacePinRef: string | null; idempotencyKey: string } {
  if (!isObject(body)) throw new ServiceApiError('invalid_request', 'The body must be a JSON object.');
  checkFields(body, ['action', 'approve_write', 'replace_pin_ref', 'idempotency_key'], '');
  if (body.action !== 'ask' && body.action !== 'resume') throw new ServiceApiError('invalid_request', 'action must be "ask" or "resume".');
  if (body.approve_write !== undefined && typeof body.approve_write !== 'boolean') throw new ServiceApiError('invalid_request', 'approve_write must be true or false.');
  return {
    action: body.action,
    approveWrite: body.approve_write === true,
    replacePinRef: body.replace_pin_ref === undefined || body.replace_pin_ref === null ? null : requireText(body.replace_pin_ref, 'replace_pin_ref', 200),
    idempotencyKey: idempotencyKeyOf(body, header),
  };
}

export async function messageServiceAgent(ctx: ServiceContext, agentId: string, input: { content: string; idempotencyKey: string }, hooks: PinAuditHooks) {
  requireAgent(ctx, agentId, 'sessions:message');
  try {
    const result = await messageAgent({
      requester: ctx.principal, agentId, content: input.content, idempotencyKey: input.idempotencyKey,
      mayStart: holds(ctx, agentId, 'sessions:start'),
      onResolved: target => hooks.onTarget({
        agentId: target.agentId, sessionRef: target.sessionRef,
        capability: target.resolution === 'started' ? 'sessions:start' : 'sessions:message',
        action: target.resolution === 'started' ? 'agents.message.start' : 'agents.message',
      }),
      onCommit: () => hooks.onCommit(),
    });
    return {
      body: { pin: pinBody(result.pin), turn: serviceRedactor().deep(result.turn), resolution: result.resolution as PinResolution, replayed: result.replayed },
      settled: result.settled,
    };
  } catch (error) {
    servicePinError(error);
  }
}

export async function pinServiceSession(
  ctx: ServiceContext, sessionRef: string, input: ReturnType<typeof parsePinBody>, hooks: PinAuditHooks,
) {
  const agentId = sessionOwner(sessionRef);
  if (!agentId) throw NOT_FOUND.session();
  const capability = pinCapability(input.action);
  hooks.onTarget({ agentId, sessionRef, capability, action: input.action === 'resume' ? 'pins.resume' : 'pins.ask' });
  if (!holds(ctx, agentId, capability)) throw notGranted('session');
  if (input.replacePinRef) requireServicePin(ctx, input.replacePinRef);
  try {
    const { pin, created, replaced } = await createPin({
      requester: ctx.principal, sessionRef, action: input.action, approveWrite: input.approveWrite,
      idempotencyKey: input.idempotencyKey, replacePinRef: input.replacePinRef, onCommit: () => hooks.onCommit(),
    });
    return { pin: pinBody(pin), replaced_pin_ref: replaced?.id ?? null, replayed: !created };
  } catch (error) {
    servicePinError(error);
  }
}

export async function sendServicePinMessage(ctx: ServiceContext, pinRef: string, input: { content: string; idempotencyKey: string }, hooks: PinAuditHooks) {
  const pin = requireServicePin(ctx, pinRef);
  hooks.onTarget({ agentId: pin.agent_id, sessionRef: pin.session_ref, capability: pinCapability(pin.action), action: 'pins.send' });
  try {
    const result = await sendPinTurn({
      requester: ctx.principal, pinRef: pin.id, content: input.content, idempotencyKey: input.idempotencyKey, onCommit: () => hooks.onCommit(),
    });
    return { body: { pin: pinBody(result.pin), turn: serviceRedactor().deep(result.turn), replayed: result.replayed }, settled: result.settled };
  } catch (error) {
    servicePinError(error);
  }
}

export async function readServicePin(ctx: ServiceContext, pinRef: string, hooks: Pick<PinAuditHooks, 'onTarget'>) {
  const pin = requireServicePin(ctx, pinRef);
  hooks.onTarget({ agentId: pin.agent_id, sessionRef: pin.session_ref, capability: pinCapability(pin.action), action: 'pins.read' });
  try {
    const { pin: row, turns } = await readPin(ctx.principal, pin.id);
    return { pin: pinBody(row), turns: serviceRedactor().deep(turns) };
  } catch (error) {
    servicePinError(error);
  }
}

export function detachServicePin(ctx: ServiceContext, pinRef: string, hooks: PinAuditHooks) {
  const pin = requireServicePin(ctx, pinRef);
  hooks.onTarget({ agentId: pin.agent_id, sessionRef: pin.session_ref, capability: pinCapability(pin.action), action: 'pins.detach' });
  try {
    const { pin: row, replayed } = detachPin(ctx.principal, pin.id, { onCommit: () => hooks.onCommit() });
    return { pin: pinBody(row), replayed };
  } catch (error) {
    servicePinError(error);
  }
}

// ---------------------------------------------------------------------
// NOT-515: session shares (lib/session-shares). A share is created for one
// exact session_ref the caller holds shares:create on (the owning Agent is
// resolved, never chosen); the caller then sees, lists, and revokes only its
// own shares, and only while it still holds shares:create on that Agent.
// Anything else answers share_not_found, like a missing share. A share's
// Ask turns are not a service call: the share is their only authority
// (askShare, internal).

// Fields that would select or describe a session by heuristic or provider
// identity instead of its session_ref: authority_not_allowed, like the
// NOT-499 authority fields.
export const SHARE_SELECTOR_FIELDS = [
  'provider_session_id', 'external_session_id', 'claude_session_id', 'codex_thread_id', 'cursor_chat_id', 'thread_id', 'chat_id',
  'cwd', 'workspace', 'latest', 'most_recent', 'title', 'title_match', 'active_since',
];
const SHARE_REFUSED_FIELDS = [...new Set([...AUTHORITY_FIELDS, ...SHARE_SELECTOR_FIELDS])];

function checkShareFields(body: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (SHARE_REFUSED_FIELDS.includes(key)) {
      throw new ServiceApiError('authority_not_allowed', `${where}${key} cannot select or describe a session; name it by session_ref only.`);
    }
    throw new ServiceApiError('invalid_request', `${where}${key} is not a field of this request.`);
  }
}

export interface ShareCreateInput {
  audience: SlackAudience;
  ttlSeconds: number | null;
  maxTurns: number | null;
  agentId: string | null;
  idempotencyKey: string;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ServiceApiError('invalid_request', `${field} must be an integer.`);
  return value;
}

export function parseShareCreateBody(body: unknown, header: string | null): ShareCreateInput {
  if (!isObject(body)) throw new ServiceApiError('invalid_request', 'The body must be a JSON object.');
  checkShareFields(body, ['audience', 'ttl_seconds', 'max_turns', 'agent_id', 'idempotency_key'], '');
  if (!isObject(body.audience)) throw new ServiceApiError('invalid_request', 'audience must be one object { kind: "slack", team_id, channel_id }.');
  checkShareFields(body.audience, ['kind', 'team_id', 'channel_id'], 'audience.');
  if (!isSlackAudience(body.audience)) {
    throw new ServiceApiError('invalid_request', 'audience must be { kind: "slack", team_id: "T…", channel_id: "C…" } with exact Slack ids.');
  }
  return {
    audience: { kind: 'slack', team_id: body.audience.team_id, channel_id: body.audience.channel_id },
    ttlSeconds: optionalInteger(body.ttl_seconds, 'ttl_seconds'),
    maxTurns: optionalInteger(body.max_turns, 'max_turns'),
    agentId: body.agent_id === undefined || body.agent_id === null ? null : requireText(body.agent_id, 'agent_id', 200),
    idempotencyKey: idempotencyKeyOf(body, header),
  };
}

// An empty body, or { idempotency_key? } (revoke is idempotent by itself).
export function parseShareRevokeBody(text: string): void {
  if (text.trim() === '') return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ServiceApiError('invalid_request', 'The body must be empty or a JSON object.');
  }
  if (!isObject(body)) throw new ServiceApiError('invalid_request', 'The body must be empty or a JSON object.');
  checkShareFields(body, ['idempotency_key'], '');
  if (body.idempotency_key !== undefined) requireText(body.idempotency_key, 'idempotency_key', 160);
}

const SHARE_LIST_PARAMS = ['session_ref', 'state', 'cursor', 'limit'];
const SHARE_STATES: ShareState[] = ['active', 'expired', 'revoked'];

// Query parameter names of a share list: only the documented ones.
export function checkShareListParams(names: string[]): void {
  for (const name of names) {
    if (SHARE_LIST_PARAMS.includes(name)) continue;
    if (SHARE_REFUSED_FIELDS.includes(name)) {
      throw new ServiceApiError('authority_not_allowed', `${name} cannot select a session; filter by session_ref only.`);
    }
    throw new ServiceApiError('invalid_request', `${name} is not a parameter of this list.`);
  }
}

function serviceShareError(error: unknown): never {
  if (error instanceof ShareError) {
    if (error.code === 'session_not_found') throw NOT_FOUND.session();
    if (error.code === 'share_not_found') throw NOT_FOUND.share();
    throw new ServiceApiError(error.code, error.message);
  }
  servicePinError(error);
}

function shareVisible(ctx: ServiceContext, row: ShareRow): boolean {
  return row.creator_kind === ctx.principal.kind && row.creator_id === ctx.principal.id && holds(ctx, row.agent_id, 'shares:create');
}

function requireServiceShare(ctx: ServiceContext, shareRef: string): ShareRow {
  const row = shareRow(shareRef);
  if (!row) throw NOT_FOUND.share();
  if (!shareVisible(ctx, row)) throw notGranted('share');
  return row;
}

// The share view is Botmancers references and owner-chosen ids only; it is
// redacted anyway, like every service view.
function serviceShareBody(row: ShareRow): ShareView {
  return serviceRedactor().deep(shareView(row));
}

export interface ShareAuditHooks {
  onTarget: (target: { agentId: string | null; sessionRef: string | null }) => void;
  onCommit: () => void;
}

export async function createServiceShare(ctx: ServiceContext, sessionRef: string, input: ShareCreateInput, hooks: ShareAuditHooks) {
  const agentId = sessionOwner(sessionRef);
  hooks.onTarget({ agentId, sessionRef });
  // Unknown, not granted, and another Agent's session answer alike (NOT-499).
  if (!agentId) throw NOT_FOUND.session();
  if (!holds(ctx, agentId, 'shares:create')) throw notGranted('session');
  if (input.agentId !== null && input.agentId !== agentId) throw NOT_FOUND.session();
  try {
    const { share, created } = await createShare({
      creator: ctx.principal, sessionRef, agentId: input.agentId, audience: input.audience, ttlSeconds: input.ttlSeconds,
      maxTurns: input.maxTurns, idempotencyKey: input.idempotencyKey, createdVia: 'session_ref', onCommit: () => hooks.onCommit(),
    });
    return { share: serviceShareBody(share), replayed: !created };
  } catch (error) {
    serviceShareError(error);
  }
}

export function getServiceShare(ctx: ServiceContext, shareRef: string, hooks: Pick<ShareAuditHooks, 'onTarget'>) {
  const row = requireServiceShare(ctx, shareRef);
  hooks.onTarget({ agentId: row.agent_id, sessionRef: row.session_ref });
  return { share: serviceShareBody(row) };
}

export function listServiceShares(ctx: ServiceContext, query: ListQuery & { sessionRef: string | null; state: string | null }): Page<ShareView> {
  if (query.sessionRef !== null && (query.sessionRef.trim() === '' || query.sessionRef.length > 200)) {
    throw new ServiceApiError('invalid_request', 'session_ref must be one session reference.');
  }
  if (query.state !== null && !(SHARE_STATES as string[]).includes(query.state)) {
    throw new ServiceApiError('invalid_request', 'state must be active, expired, or revoked.');
  }
  const rows = sharesCreatedBy(ctx.principal, { sessionRef: query.sessionRef })
    .filter(row => holds(ctx, row.agent_id, 'shares:create'))
    .map(serviceShareBody)
    .filter(view => query.state === null || view.state === query.state);
  return paginate(`shares:${ctx.principal.id}:${query.sessionRef ?? ''}:${query.state ?? ''}`, rows,
    row => ({ at: row.created_at, tie: row.created_at, id: row.share_ref }), query.cursor, query.limit);
}

export function revokeServiceShare(ctx: ServiceContext, shareRef: string, hooks: ShareAuditHooks) {
  const row = requireServiceShare(ctx, shareRef);
  hooks.onTarget({ agentId: row.agent_id, sessionRef: row.session_ref });
  try {
    const { share, replayed } = revokeShare(row.id, { onCommit: () => hooks.onCommit() });
    return { share: serviceShareBody(share), replayed };
  } catch (error) {
    serviceShareError(error);
  }
}
