import { NextResponse } from 'next/server';
import { messages, conversations, queue, groups, bots } from '@/lib/db';
import { processQueue } from '@/lib/agent';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversationMessages = messages.getByConversation(id);
    
    const enrichedMessages = conversationMessages.map(msg => {
      if (msg.sender_type === 'bot' && msg.sender_id) {
        const bot = bots.getById(msg.sender_id);
        return {
          ...msg,
          sender_name: bot?.name,
        };
      }
      return msg;
    });
    
    return NextResponse.json(enrichedMessages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { content, mentionedBotId } = body;

    if (!content) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const message = messages.create(id, 'user', content);

    if (conversation.type === 'bot' && conversation.bot_id) {
      queue.enqueue(id, conversation.bot_id);
    } else if (conversation.type === 'group' && conversation.group_id) {
      const members = groups.getMembers(conversation.group_id);
      
      if (mentionedBotId) {
        const mentioned = members.find(b => b.id === mentionedBotId);
        if (mentioned) {
          queue.enqueue(id, mentioned.id);
        }
      } else if (members.length > 0) {
        queue.enqueue(id, members[0].id);
      }
    }

    processQueue().catch(console.error);

    return NextResponse.json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
