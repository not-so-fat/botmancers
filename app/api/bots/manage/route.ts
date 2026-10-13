import { NextResponse } from 'next/server';
import { bots } from '@/lib/db';
import { serializeBot } from '@/lib/bot-definition';

// NOT-459: Manage agents list — every agent, hidden included.
export async function GET() {
  try {
    const rows = bots.managementRows().map(row => {
      const bot = serializeBot(row.bot) as unknown as {
        agent: string;
        deck_id: string | null;
        deck_name: string | null;
        needs_deck_selection: boolean;
      };
      return {
        id: row.bot.id,
        name: row.bot.name,
        hidden: row.bot.hidden ? 1 : 0,
        agent: bot.agent,
        deck_id: bot.deck_id,
        deck_name: bot.deck_name,
        needs_deck_selection: bot.needs_deck_selection,
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
