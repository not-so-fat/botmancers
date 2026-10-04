import { NextRequest, NextResponse } from 'next/server';
import { runningCommands } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const conversationId = params.id;
  const activeCommand = runningCommands.getActiveByConversation(conversationId);
  
  if (activeCommand) {
    return NextResponse.json({
      hasRunningCommand: true,
      commandId: activeCommand.id,
      commandType: activeCommand.command_type,
    });
  }
  
  return NextResponse.json({ hasRunningCommand: false });
}
