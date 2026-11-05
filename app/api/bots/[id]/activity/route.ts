import { NextResponse } from 'next/server';
import { InvalidPageCursorError, isAgentActivityFilter, listAgentActivity, parseAgentActivityLimit } from '@/lib/agent-activity';
import { OWNER_ORIGIN_REQUIRED, ownerBoundaryRefusalFor } from '@/lib/owner-boundary';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const refusal = ownerBoundaryRefusalFor(request);
    if (refusal) return NextResponse.json({ error: { code: OWNER_ORIGIN_REQUIRED, message: refusal } }, { status: 403 });
    const { id } = await params;
    const search = new URL(request.url).searchParams;
    const filter = search.get('filter') ?? 'all';
    if (!isAgentActivityFilter(filter)) return NextResponse.json({ error: 'filter must be all, sessions, conversations, slack, or errors.' }, { status: 400 });
    let limit: number;
    try { limit = parseAgentActivityLimit(search.get('limit')); }
    catch { return NextResponse.json({ error: 'limit must be a positive integer.' }, { status: 400 }); }
    const page = listAgentActivity(id, { filter, cursor: search.get('cursor'), limit });
    if (!page) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json({ activity: page.items, next_cursor: page.next_cursor });
  } catch (error) {
    if (error instanceof InvalidPageCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Error listing Agent activity:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Failed to list Agent activity' }, { status: 500 });
  }
}
