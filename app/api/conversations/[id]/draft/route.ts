import { NextResponse } from 'next/server';
import { messages, conversations } from '@/lib/db';
import { parseDraft, serializeDraft } from '@/lib/draft';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const payload = await request.json();
    const messageId = payload?.messageId ? String(payload.messageId) : '';
    const action = payload?.action === 'send' || payload?.action === 'discard' ? payload.action : '';
    if (!messageId || !action) {
      return NextResponse.json({ error: 'messageId and action are required' }, { status: 400 });
    }
    if (typeof payload.recipient !== 'string' || typeof payload.body !== 'string') {
      return NextResponse.json({ error: 'recipient and body are required' }, { status: 400 });
    }

    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const source = messages.getById(messageId);
    const draft = source ? parseDraft(source.content) : null;
    if (!source || source.conversation_id !== id || source.sender_type !== 'bot' || !draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 400 });
    }
    if (draft.state !== 'open') {
      return NextResponse.json({ ok: true });
    }
    if (action === 'send' && payload.recipient.trim() === '') {
      return NextResponse.json({ ok: true });
    }

    messages.replaceContent(messageId, serializeDraft({
      channel: draft.channel,
      recipient: payload.recipient,
      body: payload.body,
      state: action === 'send' ? 'sent' : 'discarded',
    }));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error updating draft:', error);
    return NextResponse.json({ error: 'Failed to update draft' }, { status: 500 });
  }
}
