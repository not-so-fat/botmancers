import { NextResponse } from 'next/server';
import { redirect } from 'next/navigation';
import db from '@/lib/db';
import { OWNER_ORIGIN_REQUIRED, ownerBoundaryRefusalFor } from '@/lib/owner-boundary';

// NOT-551: compatibility for old direct/group/exchange backlinks. Resolve an
// Agent participant without exposing conversation existence through an API,
// then retain the target conversation and focused exchange in the new URL.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refusal = ownerBoundaryRefusalFor(request);
  if (refusal) {
    return NextResponse.json({ error: { code: OWNER_ORIGIN_REQUIRED, message: refusal } }, { status: 403 });
  }
  const { id } = await params;
  const participant = db.prepare(`
    SELECT participant_id AS id FROM conversation_participants
    WHERE conversation_id = ? AND participant_kind = 'bot'
    ORDER BY joined_at ASC, rowid ASC LIMIT 1
  `).get(id) as { id: string } | undefined;
  if (!participant) redirect('/');
  const exchange = new URL(request.url).searchParams.get('exchange');
  const query = exchange ? `?exchange=${encodeURIComponent(exchange)}` : '';
  redirect(`/agents/${encodeURIComponent(participant.id)}/conversations/${encodeURIComponent(id)}${query}`);
}
