import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { agentExists, getAgentSession, sessionDebugExternalId } from '@/lib/session-catalog';

// NOT-496: one session of the selected Agent by its Botmancers reference.
// A reference that is unknown or belongs to another Agent is 404 either
// way. ?debug=external_session_id adds the provider session id under
// `debug` for the labeled local debug disclosure only.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; ref: string }> }
) {
  try {
    const { id, ref } = await params;
    if (!agentExists(db, id)) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const session = getAgentSession(db, id, ref);
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (new URL(request.url).searchParams.get('debug') === 'external_session_id') {
      return NextResponse.json({ session, debug: { external_session_id: sessionDebugExternalId(db, id, ref) ?? null } });
    }
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Error reading agent session:', error);
    return NextResponse.json({ error: 'Failed to read session' }, { status: 500 });
  }
}
