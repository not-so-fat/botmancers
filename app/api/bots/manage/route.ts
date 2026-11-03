import { NextResponse } from 'next/server';
import { bots, serializeAgent } from '@/lib/db';

// NOT-459: Manage agents list — every agent, hidden included.
export async function GET() {
  try {
    const rows = bots.managementRows().map(row => {
      const bot = serializeAgent(row.bot) as unknown as {
        agent: string;
        launchable: boolean;
        runtime_connection: { id: string; provider: string; label: string; host: string } | null;
      };
      return {
        id: row.bot.id,
        name: row.bot.name,
        hidden: row.bot.hidden ? 1 : 0,
        agent: bot.agent,
        launchable: bot.launchable,
        runtime_connection: bot.runtime_connection,
        source_provider: row.bot.source_provider ?? null,
        created_at: row.bot.created_at,
        last_activity: row.last_activity,
        blocked: row.blocked,
      };
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Error listing agents for management:', error);
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}
