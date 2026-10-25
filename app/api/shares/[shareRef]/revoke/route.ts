import { NextResponse } from 'next/server';
import { ownerShareErrorBody, requireOwnerCaller, revokeOwnerShare } from '@/lib/session-share-owner';

// NOT-519: the owner revokes one share (idempotent: a revoked share answers
// 200 replayed). Its Ask pin is detached in the same commit, so the next
// Slack question in its thread gets the fixed share_revoked notice.
export async function POST(request: Request, { params }: { params: Promise<{ shareRef: string }> }) {
  try {
    requireOwnerCaller(request);
    const { shareRef } = await params;
    const result = revokeOwnerShare(shareRef);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}
