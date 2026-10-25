import { NextResponse } from 'next/server';
import { OwnerShareError, createOwnerShare, listOwnerShares, ownerShareErrorBody, requireOwnerCaller } from '@/lib/session-share-owner';
import { sweepExpiredShares } from '@/lib/session-shares';

// NOT-519: the shares of one session of the selected Agent (GET), and the
// owner's Share to Slack on it (POST { audience, ttl_seconds?, max_turns?,
// idempotency_key }): one read-only Ask share on exactly this session_ref,
// to one allowlisted Slack channel (lib/session-shares createShare). 201
// created; an exact replay of the key is 200 with the same share.
export async function GET(request: Request, { params }: { params: Promise<{ id: string; ref: string }> }) {
  try {
    requireOwnerCaller(request);
    const { id, ref } = await params;
    sweepExpiredShares();
    const query = new URL(request.url).searchParams;
    const scoped = new URLSearchParams({ session_ref: ref, agent_id: id });
    for (const [name, value] of query) {
      if (!['state', 'cursor', 'limit'].includes(name)) throw new OwnerShareError('invalid_request', `${name} is not a parameter of this list.`, 400);
      scoped.append(name, value);
    }
    return NextResponse.json(listOwnerShares(scoped), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; ref: string }> }) {
  try {
    requireOwnerCaller(request);
    const { id, ref } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const result = await createOwnerShare(id, ref, body);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    const { body, status } = ownerShareErrorBody(error);
    return NextResponse.json(body, { status });
  }
}
