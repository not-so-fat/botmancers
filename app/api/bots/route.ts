import { NextResponse } from 'next/server';
import { bots, conversations, queue } from '@/lib/db';
import { processQueue } from '@/lib/agent';

export async function GET() {
  try {
    const allBots = bots.getAll();
    return NextResponse.json(allBots);
  } catch (error) {
    console.error('Error fetching bots:', error);
    return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, title, description, avatar } = body;

    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    const bot = bots.create({
      name: String(name).trim(),
      title: title ? String(title) : '',
      description: description ? String(description) : '',
      avatar,
    });
    const conversation = conversations.getByBotId(bot.id);
    if (conversation) {
      queue.enqueue(conversation.id, bot.id);
      processQueue().catch(console.error);
    }
    return NextResponse.json(bot);
  } catch (error) {
    console.error('Error creating bot:', error);
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = body.id ? String(body.id) : '';
    if (!id) {
      return NextResponse.json({ error: 'Bot id is required' }, { status: 400 });
    }
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        bots.setAvatar(id, null);
      } else {
        const avatar = String(body.avatar);
        if (!avatar.startsWith('data:image/')) {
          return NextResponse.json({ error: 'Image is required' }, { status: 400 });
        }
        bots.setAvatar(id, avatar);
      }
    }
    if (body.pinned !== undefined) {
      bots.setPinned(id, Boolean(body.pinned));
    }
    if (body.name !== undefined || body.title !== undefined || body.description !== undefined) {
      const name = body.name !== undefined ? String(body.name).trim() : bot.name;
      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 });
      }
      const title = body.title !== undefined ? String(body.title) : bot.title;
      const description = body.description !== undefined ? String(body.description) : bot.description;
      bots.updateIdentity(id, name, title, description);
    }
    return NextResponse.json(bots.getById(id));
  } catch (error) {
    console.error('Error setting avatar:', error);
    return NextResponse.json({ error: 'Failed to set avatar' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const id = body.id ? String(body.id) : '';
    if (!id) {
      return NextResponse.json({ error: 'Bot id is required' }, { status: 400 });
    }
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    bots.remove(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error deleting bot:', error);
    return NextResponse.json({ error: 'Failed to delete bot' }, { status: 500 });
  }
}
