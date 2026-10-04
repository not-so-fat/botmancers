import { NextRequest, NextResponse } from 'next/server';
import { runningCommands } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;
  
  const activeCommand = runningCommands.getActiveByConversation(conversationId);
  if (activeCommand) {
    runningCommands.markStopped(activeCommand.id);
    return NextResponse.json({ success: true });
  }
  
  return NextResponse.json({ success: false, error: 'No running command found' }, { status: 404 });
}
