import { NextResponse } from 'next/server';
import { listOwnerConversations, parseOwnerConversationLimit, InvalidPageCursorError } from '@/lib/owner-conversations';
import { OWNER_ORIGIN_REQUIRED, ownerBoundaryRefusalFor } from '@/lib/owner-boundary';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const refusal = ownerBoundaryRefusalFor(request);
    if (refusal) return NextResponse.json({ error: { code: OWNER_ORIGIN_REQUIRED, message: refusal } }, { status: 403 });
    const { id } = await params;
    const search = new URL(request.url).searchParams;
    let limit: number;
    try { limit = parseOwnerConversationLimit(search.get('limit')); }
    catch { return NextResponse.json({ error: 'limit must be a positive integer.' }, { status: 400 }); }
    const page = listOwnerConversations(id, { q: search.get('q'), cursor: search.get('cursor'), limit });
    if (!page) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json({ conversations: page.items, next_cursor: page.next_cursor });
  } catch (error) {
    if (error instanceof InvalidPageCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Error listing owner conversations:', error);
    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}
