import { NextResponse } from 'next/server';
import { conversations, messages, draftActions } from '@/lib/db';
import { parseDraft } from '@/lib/draft';

// One-shot draft actions. Send records the send in the thread only (no real
// external message); Discard only closes the card. Either way the card goes
// read-only and a second action on the same draft is rejected.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const { messageId, action, recipient, body: draftBody } = body ?? {};

    if (typeof messageId !== 'string' || !messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }
    if (action !== 'send' && action !== 'discard') {
      return NextResponse.json({ error: "action must be 'send' or 'discard'" }, { status: 400 });
    }

    const message = messages.getById(messageId);
    if (!message || message.conversation_id !== id) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }
    const draft = parseDraft(message.content);
    if (!draft) {
      return NextResponse.json({ error: 'Message is not a draft' }, { status: 400 });
    }

    const existing = draftActions.get(messageId);
    if (existing) {
      return NextResponse.json(
        { error: `Draft already ${existing.status}`, status: existing.status },
        { status: 409 }
      );
    }

    if (action === 'send') {
      const to = typeof recipient === 'string' && recipient.trim() ? recipient.trim() : draft.recipient;
      const text = typeof draftBody === 'string' && draftBody.trim() ? draftBody : draft.body;
      if (!to) {
        return NextResponse.json({ error: 'recipient is required' }, { status: 400 });
      }
      if (!text || !text.trim()) {
        return NextResponse.json({ error: 'body is required' }, { status: 400 });
      }
      const recorded = draftActions.record(messageId, 'sent', to);
      if (!recorded) {
        return NextResponse.json({ error: 'Draft already acted on', status: 'sent' }, { status: 409 });
      }
      const sent = messages.create(id, 'bot', `[Sent to ${to}]\n${text}`, message.sender_id ?? undefined);
      return NextResponse.json({ status: 'sent', message: sent });
    }

    const recorded = draftActions.record(messageId, 'discarded', draft.recipient);
    if (!recorded) {
      return NextResponse.json({ error: 'Draft already acted on', status: 'discarded' }, { status: 409 });
    }
    return NextResponse.json({ status: 'discarded' });
  } catch (error) {
    console.error('Error acting on draft:', error);
    return NextResponse.json({ error: 'Failed to act on draft' }, { status: 500 });
  }
}
