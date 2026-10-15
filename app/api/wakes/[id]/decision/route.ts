import { NextResponse } from 'next/server';
import { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { decideWakeGrantCommand } from '@/lib/agent-conversations';
import { WakeSafetyError } from '@/lib/wake-safety';
import { WakeRouterError } from '@/lib/wake-router';

// NOT-475: the owner's Allow / Deny of a Wake waiting for an edit grant.
// proxy.ts admitted the caller through the loopback owner boundary, so it
// is the human owner. Body: { decision: 'allow' | 'deny' }.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'allow' && decision !== 'deny') {
    return NextResponse.json({ error: { code: 'invalid_request', message: 'decision must be allow or deny.' } }, { status: 400 });
  }
  try {
    const result = decideWakeGrantCommand(id, decision, { category: 'human_owner', principal: UI_OWNER_PRINCIPAL });
    return NextResponse.json({
      wakeId: result.wake.id,
      status: result.wake.status,
      reasonCode: result.wake.reason_code,
      requestId: result.request?.id ?? null,
      requestState: result.request?.state ?? null,
      grantId: result.grant?.id ?? null,
    });
  } catch (error) {
    if (error instanceof WakeSafetyError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    if (error instanceof WakeRouterError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.code === 'not_found' ? 404 : 400 });
    }
    console.error('Wake grant decision failed:', error);
    return NextResponse.json({ error: { code: 'internal_error', message: 'The decision could not be recorded.' } }, { status: 500 });
  }
}
