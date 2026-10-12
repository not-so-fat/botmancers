import { NextResponse } from 'next/server';
import { conversations, messages, approvals } from '@/lib/db';
import { parseApprovalCode } from '@/lib/draft';

// Deny the pending approval-code request in this thread. One-shot: a code
// resolves exactly once; denying or approving it again is rejected.
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
    const { messageId } = body ?? {};
    let { code } = body ?? {};

    if (typeof messageId === 'string' && messageId) {
      const message = messages.getById(messageId);
      if (!message || message.conversation_id !== id) {
        return NextResponse.json({ error: 'Message not found' }, { status: 404 });
      }
      const found = parseApprovalCode(message.content);
      if (!found) {
        return NextResponse.json({ error: 'Message has no approval code' }, { status: 400 });
      }
      if (typeof code === 'string' && code && code !== found) {
        return NextResponse.json({ error: 'code does not match message' }, { status: 400 });
      }
      code = found;
    }
    if (typeof code !== 'string' || !code) {
      return NextResponse.json({ error: 'code is required' }, { status: 400 });
    }

    let row = approvals.get(id, code);
    if (!row) {
      const match = messages
        .getByConversation(id)
        .find(message => parseApprovalCode(message.content) === code);
      if (!match) {
        return NextResponse.json({ error: 'Approval code not found' }, { status: 404 });
      }
      row = approvals.recordPending(id, code, match.id);
    }
    if (row.status !== 'pending') {
      return NextResponse.json(
        { error: `Already ${row.status}`, status: row.status },
        { status: 409 }
      );
    }

    const resolved = approvals.resolve(id, code, 'denied');
    if (!resolved) {
      const current = approvals.get(id, code);
      return NextResponse.json(
        { error: `Already ${current?.status ?? 'resolved'}`, status: current?.status ?? 'resolved' },
        { status: 409 }
      );
    }
    const requester = row.message_id ? messages.getById(row.message_id)?.sender_id : undefined;
    const recorded = messages.create(id, 'bot', `[Denied ${code}]`, requester ?? undefined);
    return NextResponse.json({ status: 'denied', code, message: recorded });
  } catch (error) {
    console.error('Error denying request:', error);
    return NextResponse.json({ error: 'Failed to deny request' }, { status: 500 });
  }
}
