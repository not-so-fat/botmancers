import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { agentExists, isSessionFilter, listAgentSessionPage, parseSessionListLimit } from '@/lib/session-catalog';
import { InvalidPageCursorError } from '@/lib/page-cursor';
import { sessionsWithActions } from '@/lib/session-pins';
import { getAgentSyncState, warmAgentProvider } from '@/lib/provider-sessions';
import { agentSessionsSyncedAt } from '@/lib/session-sync-refresh';

// NOT-496: the selected Agent's session catalog (lib/session-catalog).
// ?status=active|ended|all (default all), newest activity first. External
// provider session ids are never part of the response.
// NOT-507: each row adds home and what each session action can do now.
// NOT-545: a top-level synced_at (the newest last_synced_at of the Agent's
// rows, or null when the Agent has none yet).
// NOT-547: a sync object so the drawer can tell empty apart: the last
// completed sync time, the last failure code (or null), and how many
// provider-reported sessions the scope excluded at the last completed
// sync (or null when no completed sync is known).
// NOT-548: paged and searchable. ?limit (default 50, clamped to 200),
// ?cursor (the previous page's next_cursor), ?q (a case-insensitive
// title substring), and ?workspace (an exact workspace path). The
// response adds next_cursor (null on the last page); status and the
// newest-activity ordering are unchanged.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!agentExists(db, id)) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const search = new URL(request.url).searchParams;
    const status = search.get('status') ?? 'all';
    if (!isSessionFilter(status)) {
      return NextResponse.json({ error: 'status must be active, ended, or all' }, { status: 400 });
    }
    let limit: number;
    try {
      limit = parseSessionListLimit(search.get('limit'));
    } catch {
      return NextResponse.json({ error: 'limit must be a positive integer.' }, { status: 400 });
    }
    let page;
    try {
      page = listAgentSessionPage(db, id, {
        status,
        q: search.get('q'),
        workspace: search.get('workspace'),
        cursor: search.get('cursor'),
        limit,
      });
    } catch (error) {
      if (error instanceof InvalidPageCursorError) {
        return NextResponse.json({ error: 'cursor is not a cursor of this list.' }, { status: 400 });
      }
      throw error;
    }
    await warmAgentProvider(db, id, { onlyWithSessions: true });
    return NextResponse.json({
      status,
      synced_at: agentSessionsSyncedAt(db, id),
      sync: getAgentSyncState(db, id),
      sessions: sessionsWithActions(id, page.sessions),
      next_cursor: page.next_cursor,
    });
  } catch (error) {
    console.error('Error listing agent sessions:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}
