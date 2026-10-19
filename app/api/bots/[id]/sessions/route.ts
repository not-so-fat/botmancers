import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { agentExists, isSessionFilter, listAgentSessions } from '@/lib/session-catalog';
import { sessionsWithActions } from '@/lib/session-pins';
import { warmAgentProvider } from '@/lib/provider-sessions';

// NOT-496: the selected Agent's session catalog (lib/session-catalog).
// ?status=active|ended|all (default all), newest activity first. External
// provider session ids are never part of the response.
// NOT-507: each row adds home and what each session action can do now.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!agentExists(db, id)) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const status = new URL(request.url).searchParams.get('status') ?? 'all';
    if (!isSessionFilter(status)) {
      return NextResponse.json({ error: 'status must be active, ended, or all' }, { status: 400 });
    }
    await warmAgentProvider(db, id, { onlyWithSessions: true });
    return NextResponse.json({ status, sessions: sessionsWithActions(id, listAgentSessions(db, id, status)) });
  } catch (error) {
    console.error('Error listing agent sessions:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}
