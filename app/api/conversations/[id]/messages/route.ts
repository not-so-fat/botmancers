import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { messages, conversations, queue, groups, bots, draftActions, approvals, memories, UI_OWNER_PRINCIPAL } from '@/lib/db';
import type { Bot, Conversation } from '@/lib/db';
import {
  IntakeError,
  acceptConversationMessage,
  getAcceptedMessage,
  type AcceptedIntake,
  type IntakeDelivery,
  type IntakeRouting,
} from '@/lib/conversation-intake';
import { getApprovalByCode } from '@/lib/approvals';
import { parseDraft, parseApprovalCode } from '@/lib/draft';
import { resumeBotIdsForConversation } from '@/lib/ask';
import { processQueue } from '@/lib/agent';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = conversations.getUiById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    const conversationMessages = messages.getByConversation(id);

    const enrichedMessages = conversationMessages.map(msg => {
      const draft = parseDraft(msg.content);
      const draftRow = draft ? draftActions.get(msg.id) : undefined;
      const code = parseApprovalCode(msg.content);
      const requestRow = code ? getApprovalByCode(id, code) : undefined;
      const legacyRow = !requestRow && code ? approvals.get(id, code) : undefined;
      const approvalStatus = requestRow
        ? (requestRow.status === 'executed' ? 'approved' : requestRow.status)
        : (legacyRow?.status ?? (code ? 'pending' : null));
      const cardStatus = {
        draftStatus: draft ? (draft.state !== 'open' ? draft.state : (draftRow?.status ?? 'open')) : null,
        approvalStatus,
      };
      if (msg.sender_type === 'bot' && msg.sender_id) {
        const bot = bots.getById(msg.sender_id);
        return {
          ...msg,
          ...cardStatus,
          sender_name: bot?.name,
        };
      }
      return { ...msg, ...cardStatus };
    });

    if (conversation.type === 'bot' && conversation.bot_id) {
      bots.markRead(conversation.bot_id);
    }

    return NextResponse.json(enrichedMessages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { content, mentionedBotId } = body;

    if (!content) {
      return NextResponse.json({ error: 'Content is required', code: 'invalid_request' }, { status: 400 });
    }

    // NOT-465: the UI accepts through the same conversation intake as
    // /api/v0. The client sends one key per submission so a resend
    // replays; a request without one is a distinct submission.
    const clientKey = request.headers.get('idempotency-key')
      ?? (typeof body.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey : randomUUID());
    const intake = acceptConversationMessage({
      surface: 'ui',
      requester: UI_OWNER_PRINCIPAL,
      idempotencyKey: `ui:${clientKey}`,
      conversation: { id },
      content: String(content),
      fingerprint: [id, String(content), mentionedBotId ? String(mentionedBotId) : null],
      route: conversation => uiRouting(conversation, String(content), mentionedBotId ? String(mentionedBotId) : undefined),
      dispatch: enqueueUiTurns,
    });

    // Per-bot memory (NOT-411): a direct thread teaches its own bot, unless
    // the message addresses another bot or carries a WAKE handoff (reference
    // guard). Learning never breaks sending.
    const conversation = conversations.getUiById(id);
    const handoffIds = addressedBots(String(content), mentionedBotId ? String(mentionedBotId) : undefined, false).map(bot => bot.id);
    const wakeLineCount = String(content).split(/\r?\n/).filter(line => /WAKE\s+\w+\s*:/.test(line)).length;
    if (!intake.replayed && conversation?.type === 'bot' && conversation.bot_id && handoffIds.length === 0 && wakeLineCount < 2) {
      try {
        memories.rememberStatement(conversation.bot_id, String(content));
      } catch (error) {
        console.error('Error remembering statement:', error);
      }
    }

    const message = getAcceptedMessage(intake.acceptedMessageId);
    return NextResponse.json({
      ...message,
      intake: {
        conversationId: intake.conversationId,
        acceptedMessageId: intake.acceptedMessageId,
        requestIds: intake.requestIds,
        replayed: intake.replayed,
      },
    });
  } catch (error) {
    if (error instanceof IntakeError) return uiIntakeError(error);
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message', code: 'intake_failed' }, { status: 500 });
  }
}

// Normalized intake failures in the UI route's response shape. Agent
// conversations stay invisible to the UI routes, so not-writable is 404.
function uiIntakeError(error: IntakeError) {
  switch (error.code) {
    case 'conversation_not_found':
    case 'conversation_not_writable':
      return NextResponse.json({ error: 'Conversation not found', code: 'conversation_not_found' }, { status: 404 });
    case 'intake_failed':
      return NextResponse.json({ error: 'Failed to send message', code: error.code }, { status: 500 });
    default:
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

// UI target resolution (unchanged routing rules): ask-and-wait resume,
// then addressed bots (group members turn in the group; others in their
// direct thread), then the thread's own bot or every group member.
function uiRouting(conversation: Conversation, content: string, mentionedBotId: string | undefined): IntakeRouting {
  const isGroupThread = conversation.type === 'group';
  const members = isGroupThread && conversation.group_id ? groups.getMembers(conversation.group_id) : [];
  const addressed = addressedBots(content, mentionedBotId, isGroupThread, members);
  const handoffTargets = addressed.map(bot => bot.id);
  const deliveries: IntakeDelivery[] = [];

  // Ask-and-wait resume (NOT-415): when the thread holds parked questions,
  // this user message is their answer, so only the asked bots resume. With
  // nothing pending this block is skipped and routing is unchanged.
  const resumeBotIds = resumeBotIdsForConversation(conversation.id);
  if (resumeBotIds && resumeBotIds.length > 0) {
    for (const botId of resumeBotIds) deliveries.push({ agentId: botId });
  } else if (addressed.length > 0) {
    for (const bot of addressed) {
      if (isGroupThread && members.some(member => member.id === bot.id)) {
        deliveries.push({ agentId: bot.id });
        continue;
      }
      const target = conversations.getByBotId(bot.id);
      if (target) deliveries.push({ agentId: bot.id, conversationId: target.id });
    }
  } else if (conversation.type === 'bot' && conversation.bot_id) {
    deliveries.push({ agentId: conversation.bot_id });
  } else if (isGroupThread) {
    // No fixed member. Every member is queued and decides in the agent.
    for (const member of members) deliveries.push({ agentId: member.id });
  }
  return { deliveries, handoffTargets };
}

// The UI agent loop (lib/agent processQueue) still executes UI turns: each
// newly accepted Work Request becomes one queue item for its target and
// conversation, naming that request (NOT-471: a coding-Agent turn
// dispatches it as one read-only Attempt). Replays enqueue nothing.
function enqueueUiTurns(accepted: AcceptedIntake): void {
  if (accepted.replayed) return;
  for (const request of accepted.requests) queue.enqueue(request.source_conversation_id, request.target_agent_id, request.id);
  processQueue().catch(console.error);
}

function mentionAt(content: string, name: string): boolean {
  const needle = '@' + name;
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf(needle, from);
    if (at < 0) return false;
    const after = content[at + needle.length];
    if (!after || /[\s.,!?:;]/.test(after)) return true;
    from = at + needle.length;
  }
  return false;
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nameAsWord(content: string, name: string): boolean {
  if (!name.trim()) return false;
  const pattern = new RegExp('(^|[^\\p{L}\\p{N}_])' + escapeName(name) + '(?![\\p{L}\\p{N}_])', 'iu');
  return pattern.test(content);
}

// Bare-name addressing rule (NOT-418):
// - Group conversations only: callers pass bareNames=true with the group's
//   members as bareNameBots; direct threads pass false and no bare match.
// - Word boundaries (unicode letters/numbers/underscore): substrings never
//   match, so "Ann" in "Annalise" is not an address.
// - Two or more bare member names address them all; a single bare name
//   never addresses (prevents common words from waking bots).
// - Only names in the explicit bareNameBots allowlist are checked, never
//   all bots implicitly.
// @-mentions and the explicit picker id address in any thread.
export function addressedBots(content: string, explicitId?: string, bareNames = false, bareNameBots: Bot[] = []) {
  const all = bots.getAll();
  const found = new Map<string, (typeof all)[number]>();
  if (explicitId) {
    const explicit = all.find(bot => bot.id === explicitId);
    if (explicit) found.set(explicit.id, explicit);
  }
  const sorted = [...all].sort((a, b) => b.name.length - a.name.length);
  for (const bot of sorted) {
    if (mentionAt(content, bot.name)) found.set(bot.id, bot);
  }
  if (bareNames && bareNameBots.length > 0) {
    const candidates = [...bareNameBots].sort((a, b) => b.name.length - a.name.length);
    const named: Bot[] = [];
    for (const bot of candidates) {
      if (nameAsWord(content, bot.name)) named.push(bot);
    }
    if (named.length >= 2) {
      for (const bot of named) found.set(bot.id, bot);
    }
  }
  return [...found.values()];
}
