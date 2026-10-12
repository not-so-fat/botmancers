import { NextResponse } from 'next/server';
import { bots } from '@/lib/db';
import { readSkillState, writeSkillForBot } from '@/lib/skills';
import { buildSnapshotInput, hashSnapshot } from '@/lib/snapshot';

function currentHashFor(botId: string) {
  const bot = bots.getById(botId);
  if (!bot) return null;
  const skill = readSkillState(bot.name);
  return { bot, skill, currentHash: hashSnapshot(buildSnapshotInput(bot, skill)) };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    const body = await request.json();
    const content = body.content === undefined || body.content === null ? '' : String(body.content);
    try {
      writeSkillForBot(bot.name, content);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to save skill' },
        { status: 400 }
      );
    }
    return NextResponse.json(currentHashFor(id));
  } catch (error) {
    console.error('Error saving skill:', error);
    return NextResponse.json({ error: 'Failed to save skill' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    try {
      writeSkillForBot(bot.name, '');
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to delete skill' },
        { status: 400 }
      );
    }
    return NextResponse.json(currentHashFor(id));
  } catch (error) {
    console.error('Error deleting skill:', error);
    return NextResponse.json({ error: 'Failed to delete skill' }, { status: 500 });
  }
}
