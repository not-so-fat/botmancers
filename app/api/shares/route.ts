import { NextResponse } from 'next/server';
import { listOwnerShares, ownerShareErrorBody, requireOwnerCaller } from '@/lib/session-share-owner';
import { sweepExpiredShares } from '@/lib/session-shares';

// NOT-519: the owner's list of every temporary session share
// (lib/session-share-owner), newest first: ?session_ref, ?agent_id, ?state,
// ?cursor, ?limit. Safe fields only (no provider id, workspace, or token).
// Behind the owner boundary; a request with a service credential is refused.
export async function GET(request: Request) {
  try {
    requireOwnerCaller(request);
    sweepExpiredShares();
    return NextResponse.json(listOwnerShares(new URL(request.url).searchParams), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}
