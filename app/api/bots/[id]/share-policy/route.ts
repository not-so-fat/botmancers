import { NextResponse } from 'next/server';
import { ownerShareErrorBody, requireOwnerCaller, sharePolicyView, updateSharePolicy } from '@/lib/session-share-owner';

// NOT-519: the share policy as Agent Config shows it: the owner's Slack
// audience allowlist (every Agent's shares) and this Agent's share_from_turn
// (config/session-shares.json). PUT { revision, share_from_turn?,
// audiences? } validates the whole document before writing it (fail closed)
// and refuses a stale revision (409 policy_conflict). Turning
// share_from_turn off revokes the Agent's live session contexts at once.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwnerCaller(request);
    const { id } = await params;
    return NextResponse.json({ policy: sharePolicyView(id) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwnerCaller(request);
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const { view, revoked_contexts } = updateSharePolicy(id, body);
    return NextResponse.json({ policy: view, revoked_contexts });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}
