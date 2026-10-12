import { NextResponse } from 'next/server';
import { messages, bots } from '@/lib/db';

// Replies strictly between two anchors in the same thread, in thread order.
// Either anchor may come first; the anchors themselves are excluded.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const anchor = messages.getById(id);
    if (!anchor) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const other =
      searchParams.get('other') ||
      searchParams.get('to') ||
      searchParams.get('target') ||
      searchParams.get('end');
    if (!other) {
      return NextResponse.json(
        { error: 'Other message id is required (other, to, target, or end)' },
        { status: 400 }
      );
    }
    const peer = messages.getById(other);
    if (!peer) {
      return NextResponse.json({ error: 'Other message not found' }, { status: 404 });
    }
    if (peer.conversation_id !== anchor.conversation_id) {
      return NextResponse.json(
        { error: 'Messages are in different conversations' },
        { status: 400 }
      );
    }

    const between = messages.getBetween(id, other) ?? [];
    const enriched = between.map(message => {
      if (message.sender_type === 'bot' && message.sender_id) {
        const bot = bots.getById(message.sender_id);
        return { ...message, sender_name: bot?.name };
      }
      return message;
    });
    return NextResponse.json(enriched);
  } catch (error) {
    console.error('Error fetching messages between:', error);
    return NextResponse.json({ error: 'Failed to fetch messages between' }, { status: 500 });
  }
}
