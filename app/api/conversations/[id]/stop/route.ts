import { NextResponse } from 'next/server';
import { messages, conversations } from '@/lib/db';
import { parseRun } from '@/lib/run';
import { stopPrintRun } from '@/lib/run-child';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const payload = await request.json();
    const messageId = payload?.messageId ? String(payload.messageId) : '';
    if (!messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }

    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const source = messages.getById(messageId);
    const run = source ? parseRun(source.content) : null;
    if (!source || source.conversation_id !== id || source.sender_type !== 'bot' || !run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 400 });
    }
    if (run.state !== 'running') {
      return NextResponse.json({ ok: true });
    }

    stopPrintRun(messageId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error stopping run:', error);
    return NextResponse.json({ error: 'Failed to stop run' }, { status: 500 });
  }
}
