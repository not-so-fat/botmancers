import { NextResponse } from 'next/server';
import { messages, conversations, bots } from '@/lib/db';
import { localSkillForBot } from '@/lib/skills';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const messageId = body?.messageId ? String(body.messageId) : '';
    if (!messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }

    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const history = messages.getByConversation(id);
    const source = history.find(msg => msg.id === messageId);
    const code = source ? approvalCodeIn(source.content) : null;
    if (!source || source.sender_type !== 'bot' || !source.sender_id || !code) {
      return NextResponse.json({ error: 'Approval request not found' }, { status: 400 });
    }

    const already = history.some(msg =>
      msg.sender_type === 'bot' &&
      msg.created_at > source.created_at &&
      (msg.content.startsWith('Denied') || msg.content.startsWith('[tool result]'))
    );
    if (!already) {
      const bot = bots.getById(source.sender_id);
      const token = bot ? skillEndToken(bot.name) : null;
      const reply = token ? 'Denied\n' + token : 'Denied';
      messages.create(id, 'bot', reply, source.sender_id);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error denying:', error);
    return NextResponse.json({ error: 'Failed to deny' }, { status: 500 });
  }
}

function approvalCodeIn(content: string): string | null {
  const match = content.trim().match(/^approve using the code\s+(\S+)/i);
  if (!match) return null;
  const code = match[1].replace(/[^A-Za-z0-9_-]+$/, '');
  return code || null;
}

function skillEndToken(botName: string): string | null {
  const skill = localSkillForBot(botName);
  if (!skill) return null;
  const match = skill.match(/ends with the exact token\s+(\S+)/i);
  return match ? match[1] : null;
}
