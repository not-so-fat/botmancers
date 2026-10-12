import { NextResponse } from 'next/server';
import { conversations } from '@/lib/db';
import { stopDelegation } from '@/lib/agent';
import {
  stopCodingLimbRun,
  stopCommandRun,
  stopFileReadRun,
  stopPublicPageReadRun,
} from '@/lib/run-child';

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
    // Snapshot contract (NOT-419): { messageId } stops one running run.
    // Without a body this stays the delegation Stop; both contracts work.
    let messageId: unknown = null;
    try {
      const body = await request.json();
      messageId = (body as Record<string, unknown> | null)?.messageId ?? null;
    } catch {
      messageId = null;
    }
    if (typeof messageId === 'string' && messageId) {
      stopFileReadRun(messageId);
      stopPublicPageReadRun(messageId);
      stopCodingLimbRun(messageId);
      stopCommandRun(messageId);
      return NextResponse.json({ success: true, stopped: true });
    }
    const stopped = stopDelegation(id);
    return NextResponse.json({ success: true, stopped });
  } catch (error) {
    console.error('Error stopping delegation:', error);
    return NextResponse.json({ error: 'Failed to stop delegation' }, { status: 500 });
  }
}
