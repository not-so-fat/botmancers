import { NextResponse } from 'next/server';
import { conversations } from '@/lib/db';
import { stopDelegation } from '@/lib/agent';

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
    const stopped = stopDelegation(id);
    return NextResponse.json({ success: true, stopped });
  } catch (error) {
    console.error('Error stopping delegation:', error);
    return NextResponse.json({ error: 'Failed to stop delegation' }, { status: 500 });
  }
}
