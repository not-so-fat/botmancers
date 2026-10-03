import { NextResponse } from 'next/server';
import { conversations } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const botId = searchParams.get('botId');
    const groupId = searchParams.get('groupId');

    let conversation;
    if (botId) {
      conversation = conversations.getByBotId(botId);
    } else if (groupId) {
      conversation = conversations.getByGroupId(groupId);
    }

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return NextResponse.json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    return NextResponse.json({ error: 'Failed to fetch conversation' }, { status: 500 });
  }
}
