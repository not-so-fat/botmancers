// NOT-551: the local owner's Agent-scoped view of canonical conversations.
// This is deliberately separate from service authorization: the owner does
// not need a service token, while /api/v0 keeps its grant and cross-service
// visibility rules. Both views read the same conversation/participant/message
// rows and use the same content redactor.
import db, { bots, projector, UI_OWNER_PRINCIPAL, type Principal, type PrincipalKind } from './db';
import { parseApprovalCode, parseDraft } from './draft';
import { getApprovalByCode } from './approvals';
import { serviceRedactor } from './service-redaction';
import { InvalidPageCursorError, paginateRows, type Page } from './page-cursor';
import { legacyAgentChatHref } from './owner-conversation-href';
export { isOwnerGroupConversation, ownerConversationTypeLabel, ownerConversationEyebrow } from './owner-conversation-labels';

export { InvalidPageCursorError, legacyAgentChatHref };

export interface OwnerConversationParticipant extends Principal {
  label: string;
}

export interface OwnerConversationSummary {
  conversation_id: string;
  type: 'direct' | 'group' | 'agent';
  label: string;
  participants: OwnerConversationParticipant[];
  origin: OwnerConversationParticipant | null;
  message_count: number;
  created_at: number;
  last_activity_at: number;
  writable: boolean;
  read_only_reason: string | null;
}

/** Bot avatar fields for chat rows; null for non-bot senders. */
export interface OwnerMessageSenderAvatar {
  name: string;
  avatar_color: string | null;
  avatar_eyes: string | null;
  avatar_hands: string | null;
  avatar_accessory: string | null;
}

export interface OwnerConversationMessage {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id: string | null;
  sender_kind: PrincipalKind;
  sender_name: string;
  sender_avatar: OwnerMessageSenderAvatar | null;
  request_id: string | null;
  content: string;
  handoff_targets: string | null;
  draftStatus: 'open' | 'sent' | 'discarded' | null;
  approvalStatus: 'pending' | 'approved' | 'denied' | null;
  created_at: number;
}

export interface OwnerConversationDetail extends OwnerConversationSummary {
  messages: OwnerConversationMessage[];
  next_cursor: string | null;
  events: unknown[];
}

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

const SELECT = `
  SELECT c.id, c.type, c.bot_id, c.group_id, c.origin_kind, c.origin_id, c.created_at,
    COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS last_activity_at,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
    b.name AS bot_name, g.name AS group_name
  FROM conversations c
  JOIN conversation_participants selected
    ON selected.conversation_id = c.id
   AND selected.participant_kind = 'bot'
   AND selected.participant_id = ?
  LEFT JOIN bots b ON b.id = c.bot_id
  LEFT JOIN groups g ON g.id = c.group_id
`;

function participantLabel(principal: Principal): string {
  if (principal.kind === UI_OWNER_PRINCIPAL.kind && principal.id === UI_OWNER_PRINCIPAL.id) return 'You';
  if (principal.kind === 'bot') return bots.getById(principal.id)?.name ?? 'Removed agent';
  if (principal.kind === 'service') return principal.id ? `Service ${principal.id}` : 'External service';
  return principal.id === 'unknown' ? 'Person' : principal.id;
}

function participant(principal: Principal): OwnerConversationParticipant {
  return { ...principal, label: participantLabel(principal) };
}

function participantsOf(conversationId: string): OwnerConversationParticipant[] {
  const rows = db.prepare(
    'SELECT participant_kind AS kind, participant_id AS id FROM conversation_participants WHERE conversation_id = ? ORDER BY joined_at ASC, rowid ASC'
  ).all(conversationId) as Principal[];
  return rows.map(participant);
}

function summary(row: ConversationRow): OwnerConversationSummary {
  const participants = participantsOf(row.id);
  const type = row.type === 'bot' ? 'direct' : row.type === 'group' ? 'group' : 'agent';
  const label = type === 'direct'
    ? `${row.bot_name ?? 'Agent'} conversation`
    : type === 'group'
      ? (row.group_name ? `Shared · ${row.group_name}` : 'Shared conversation')
      : 'Agent conversation';
  const origin = row.origin_kind && row.origin_id ? participant({ kind: row.origin_kind, id: row.origin_id }) : null;
  const writable = row.type === 'bot'
    && row.bot_id !== null
    && row.origin_kind === UI_OWNER_PRINCIPAL.kind
    && row.origin_id === UI_OWNER_PRINCIPAL.id;
  const readOnlyReason = writable ? null
    : type === 'group' ? 'Shared history is read-only here. Continue from an authorized direct conversation.'
      : origin?.kind === 'service' ? 'This conversation was opened by an external service. Reply through that service or start a direct conversation.'
        : 'This agent-to-agent history is read-only for the owner.';
  return {
    conversation_id: row.id,
    type,
    label,
    participants,
    origin,
    message_count: row.message_count,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    writable,
    read_only_reason: readOnlyReason,
  };
}

export function parseOwnerConversationLimit(value: string | null): number {
  if (value === null || value === '') return 30;
  if (!/^\d+$/.test(value)) throw new RangeError('limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit');
  return Math.min(limit, 100);
}

export function listOwnerConversations(agentId: string, input: { q: string | null; cursor: string | null; limit: number }): Page<OwnerConversationSummary> | null {
  if (!bots.getById(agentId)) return null;
  const query = input.q?.trim().toLocaleLowerCase() ?? '';
  const rows = (db.prepare(SELECT).all(agentId) as ConversationRow[]).map(summary).filter(item => {
    if (!query) return true;
    return [item.label, item.type, item.origin?.label ?? '', ...item.participants.map(value => value.label)]
      .some(value => value.toLocaleLowerCase().includes(query));
  });
  return paginateRows(
    `owner-conversations:${agentId}:${query}`,
    rows,
    row => ({ at: row.last_activity_at, tie: row.created_at, id: row.conversation_id }),
    input.cursor,
    input.limit,
  );
}

interface MessageRow {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id: string | null;
  sender_kind: PrincipalKind | null;
  request_id: string | null;
  content: string;
  handoff_targets: string | null;
  created_at: number;
  seq: number;
}

export function getOwnerConversation(agentId: string, conversationId: string, input: { cursor: string | null; limit: number }): OwnerConversationDetail | null {
  if (!bots.getById(agentId)) return null;
  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(agentId, conversationId) as ConversationRow | undefined;
  if (!row) return null; // One 404 for missing and mismatched pairs: no disclosure.
  const page = paginateRows(
    `owner-conversation-messages:${agentId}:${conversationId}`,
    (db.prepare(`
      SELECT m.*, ROW_NUMBER() OVER (ORDER BY m.created_at ASC, m.rowid ASC) AS seq
      FROM messages m WHERE m.conversation_id = ?
    `).all(conversationId) as MessageRow[]),
    message => ({ at: message.seq, tie: message.created_at, id: message.id }),
    input.cursor,
    input.limit,
  );
  const redactor = serviceRedactor();
  return {
    ...summary(row),
    messages: page.items.slice().reverse().map(message => {
      const draft = parseDraft(message.content);
      const draftRow = draft ? db.prepare('SELECT status FROM draft_actions WHERE message_id = ?').get(message.id) as { status: 'sent' | 'discarded' } | undefined : undefined;
      const code = parseApprovalCode(message.content);
      const request = code ? getApprovalByCode(conversationId, code) : undefined;
      const legacy = !request && code ? db.prepare('SELECT status FROM approvals WHERE conversation_id = ? AND code = ?').get(conversationId, code) as { status: 'pending' | 'approved' | 'denied' } | undefined : undefined;
      const kind = message.sender_kind ?? (message.sender_type === 'bot' ? 'bot' : 'person');
      const senderId = message.sender_id ?? (kind === row.origin_kind ? row.origin_id : null) ?? 'unknown';
      const bot = kind === 'bot' && message.sender_id ? bots.getById(message.sender_id) : undefined;
      return {
        id: message.id,
        sender_type: message.sender_type,
        sender_id: message.sender_id,
        sender_kind: kind,
        sender_name: participantLabel({ kind, id: senderId }),
        sender_avatar: bot
          ? {
              name: bot.name,
              avatar_color: bot.avatar_color ?? null,
              avatar_eyes: bot.avatar_eyes ?? null,
              avatar_hands: bot.avatar_hands ?? null,
              avatar_accessory: bot.avatar_accessory ?? null,
            }
          : null,
        request_id: message.request_id,
        content: redactor.text(message.content),
        handoff_targets: message.handoff_targets,
        draftStatus: draft ? (draft.state !== 'open' ? draft.state : (draftRow?.status ?? 'open')) : null,
        approvalStatus: request ? (request.status === 'executed' ? 'approved' : request.status) : (legacy?.status ?? (code ? 'pending' : null)),
        created_at: message.created_at,
      };
    }),
    next_cursor: page.next_cursor,
    events: projector.listConversationEvents(conversationId),
  };
}
