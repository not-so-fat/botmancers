import { NextResponse } from 'next/server';
import { conversations, messages } from '@/lib/db';
import { parseApprovalCode } from '@/lib/draft';
import {
  createApprovalRequest,
  decideApproval,
  getApprovalByCode,
} from '@/lib/approvals';

// Approve the pending approval request in this thread. Idempotent: approving
// runs the pending action exactly once, and repeating the call (or approving
// after a deny) returns the stored status without running anything.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = conversations.getUiById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const { messageId } = body ?? {};
    let { code } = body ?? {};

    if (typeof messageId === 'string' && messageId) {
      const message = messages.getById(messageId);
      if (!message || message.conversation_id !== id) {
        return NextResponse.json({ error: 'Message not found' }, { status: 400 });
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

    let row = getApprovalByCode(id, code);
    if (!row) {
      const match = messages
        .getByConversation(id)
        .find(message => parseApprovalCode(message.content) === code);
      if (!match) {
        return NextResponse.json({ error: 'Approval code not found' }, { status: 404 });
      }
      row = createApprovalRequest({
        conversationId: id,
        botId: match.sender_id ?? null,
        code,
        messageId: match.id,
      });
    }

    const outcome = decideApproval(id, row.code, 'approve');
    if (outcome.refused) {
      return NextResponse.json({ error: outcome.refused, status: outcome.status }, { status: 400 });
    }
    return NextResponse.json({ status: outcome.status, code, ran: outcome.ran });
  } catch (error) {
    console.error('Error approving request:', error);
    return NextResponse.json({ error: 'Failed to approve request' }, { status: 500 });
  }
}
