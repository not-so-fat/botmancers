import { NextResponse } from 'next/server';
import { bots, launchSnapshots, memories, serializeAgent } from '@/lib/db';
import { readSkillState } from '@/lib/skills';
import { buildSnapshotInput, hashSnapshot } from '@/lib/snapshot';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    const skill = readSkillState(bot.name);
    const currentHash = hashSnapshot(buildSnapshotInput(bot, skill, memories.latestFacts(bot.id)));
    const snapshots = launchSnapshots.listByBot(id).map(row => ({
      id: row.id,
      bot_id: row.bot_id,
      created_at: row.created_at,
      hash: row.hash,
      transport: row.transport,
      snapshot: JSON.parse(row.snapshot),
    }));
    return NextResponse.json({ bot: serializeAgent(bot), skill, currentHash, snapshots });
  } catch (error) {
    console.error('Error fetching bot config:', error);
    return NextResponse.json({ error: 'Failed to fetch bot config' }, { status: 500 });
  }
}
