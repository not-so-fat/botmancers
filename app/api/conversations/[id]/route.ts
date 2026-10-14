import { NextResponse } from 'next/server';
import { conversations, bots, groups, projector } from '@/lib/db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = conversations.getUiById(id);
    
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    let details = null;
    if (conversation.bot_id) {
      details = bots.getById(conversation.bot_id);
    } else if (conversation.group_id) {
      const group = groups.getAll().find(g => g.id === conversation.group_id);
      if (group) {
        details = {
          ...group,
          members: groups.getMembers(group.id),
        };
      }
    }

    return NextResponse.json({
      ...conversation,
      details,
      // NOT-470: the same projected lifecycle /api/v0 conversations return.
      events: projector.listConversationEvents(conversation.id),
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    return NextResponse.json({ error: 'Failed to fetch conversation' }, { status: 500 });
  }
}
