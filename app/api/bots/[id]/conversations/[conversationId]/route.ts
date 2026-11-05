import { NextResponse } from 'next/server';
import { getOwnerConversation, parseOwnerConversationLimit, InvalidPageCursorError } from '@/lib/owner-conversations';
import { OWNER_ORIGIN_REQUIRED, ownerBoundaryRefusalFor } from '@/lib/owner-boundary';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; conversationId: string }> }) {
  try {
    const refusal = ownerBoundaryRefusalFor(request);
    if (refusal) return NextResponse.json({ error: { code: OWNER_ORIGIN_REQUIRED, message: refusal } }, { status: 403 });
    const { id, conversationId } = await params;
    const search = new URL(request.url).searchParams;
    let limit: number;
    try { limit = parseOwnerConversationLimit(search.get('limit')); }
    catch { return NextResponse.json({ error: 'limit must be a positive integer.' }, { status: 400 }); }
    const detail = getOwnerConversation(id, conversationId, { cursor: search.get('cursor'), limit });
    if (!detail) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    if (error instanceof InvalidPageCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Error reading owner conversation:', error);
    return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 });
  }
}
