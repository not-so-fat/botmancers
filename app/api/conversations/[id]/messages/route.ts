import { NextResponse } from 'next/server';
import { messages, conversations, queue, groups, bots, draftActions, approvals, memories } from '@/lib/db';
import type { Bot } from '@/lib/db';
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
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    const conversation = conversations.getUiById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const isGroupThread = conversation.type === 'group';
    const bareNameBots = isGroupThread && conversation.group_id ? groups.getMembers(conversation.group_id) : [];
    const addressed = addressedBots(
      String(content),
      mentionedBotId ? String(mentionedBotId) : undefined,
      isGroupThread,
      bareNameBots
    );
    const handoffIds = addressed.map(bot => bot.id);
    const message = messages.create(id, 'user', content, undefined, handoffIds);
    const queued = new Set<string>();
    const enqueueBot = (conversationId: string, botId: string) => {
      const key = conversationId + ':' + botId;
      if (queued.has(key)) return;
      queued.add(key);
      queue.enqueue(conversationId, botId);
    };

    // Ask-and-wait resume (NOT-415): when the thread holds parked questions,
    // this user message is their answer, so only the asked bots resume. With
    // nothing pending this block is skipped and routing is unchanged.
    const resumeBotIds = resumeBotIdsForConversation(id);
    if (resumeBotIds && resumeBotIds.length > 0) {
      for (const botId of resumeBotIds) enqueueBot(id, botId);
    } else if (addressed.length > 0) {
      if (conversation.type === 'group' && conversation.group_id) {
        const members = groups.getMembers(conversation.group_id);
        for (const bot of addressed) {
          if (members.some(member => member.id === bot.id)) {
            enqueueBot(id, bot.id);
          } else {
            const target = conversations.getByBotId(bot.id);
            if (!target) continue;
            if (target.id !== id) messages.create(target.id, 'user', content, undefined, handoffIds);
            enqueueBot(target.id, bot.id);
          }
        }
      } else {
        for (const bot of addressed) {
          const target = conversations.getByBotId(bot.id);
          if (!target) continue;
          if (target.id !== id) messages.create(target.id, 'user', content, undefined, handoffIds);
          enqueueBot(target.id, bot.id);
        }
      }
    } else if (conversation.type === 'bot' && conversation.bot_id) {
      enqueueBot(id, conversation.bot_id);
    } else if (conversation.type === 'group' && conversation.group_id) {
      // No fixed member. Every member is queued and decides in the agent.
      const members = groups.getMembers(conversation.group_id);
      for (const member of members) enqueueBot(id, member.id);
    }

    // Per-bot memory (NOT-411): a direct thread teaches its own bot, unless
    // the message addresses another bot or carries a WAKE handoff (reference
    // guard). Learning never breaks sending.
    const wakeLineCount = String(content).split(/\r?\n/).filter(line => /WAKE\s+\w+\s*:/.test(line)).length;
    if (conversation.type === 'bot' && conversation.bot_id && handoffIds.length === 0 && wakeLineCount < 2) {
      try {
        memories.rememberStatement(conversation.bot_id, String(content));
      } catch (error) {
        console.error('Error remembering statement:', error);
      }
    }

    processQueue().catch(console.error);

    return NextResponse.json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
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
