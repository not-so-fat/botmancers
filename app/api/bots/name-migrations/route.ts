import { NextResponse } from 'next/server';
import { agentNameMigrations } from '@/lib/db';

// NOT-478: owner-visible report of Agents automatically renamed because
// their name duplicated an older Agent's (trimmed, case-insensitive).
export async function GET() {
  try {
    return NextResponse.json({ renames: agentNameMigrations.list() });
  } catch (error) {
    console.error('Error fetching Agent name migrations:', error);
    return NextResponse.json({ error: 'Failed to fetch Agent name migrations' }, { status: 500 });
  }
}
