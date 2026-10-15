import { NextResponse } from 'next/server';
import { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { revokeWakeGrantCommand } from '@/lib/agent-conversations';
import { WakeSafetyError } from '@/lib/wake-safety';

// NOT-475: the owner revokes an edit grant (owner boundary: proxy.ts).
// Wakes not yet accepted ask again; accepted work keeps its decision.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { grant, revoked } = revokeWakeGrantCommand(id, { category: 'human_owner', principal: UI_OWNER_PRINCIPAL });
    return NextResponse.json({ grantId: grant.id, revoked, revokedAt: grant.revoked_at });
  } catch (error) {
    if (error instanceof WakeSafetyError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    console.error('Wake grant revoke failed:', error);
    return NextResponse.json({ error: { code: 'internal_error', message: 'The grant could not be revoked.' } }, { status: 500 });
  }
}
