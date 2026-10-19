import { NextResponse } from 'next/server';
import { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { PinError, createPin, pinErrorBody, pinView, sendPinTurn, type PinAction } from '@/lib/session-pins';

// NOT-507: the owner's Ask from this context or Resume work here on one
// session of the selected Agent (lib/session-pins). Creates the pin in the
// thread the Sessions drawer was opened from and sends its first turn;
// every turn goes to exactly this session. Resume needs approve_write: true
// (the owner's explicit approval of edits). 202 with the pin and the turn;
// a replay of the same idempotency key returns the original.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; ref: string }> }
) {
  try {
    const { id, ref } = await params;
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new PinError('invalid_request', 'The body must be a JSON object.');
    }
    const unknown = Object.keys(body).find(key => !['action', 'approve_write', 'content', 'conversation_id', 'idempotency_key'].includes(key));
    if (unknown) throw new PinError('invalid_request', `Unsupported field ${unknown}.`);
    if (body.action !== 'ask' && body.action !== 'resume') throw new PinError('invalid_request', 'action must be "ask" or "resume".');
    if (typeof body.conversation_id !== 'string' || !body.conversation_id) throw new PinError('invalid_request', 'conversation_id is required.');
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    const { pin } = await createPin({
      requester: UI_OWNER_PRINCIPAL, sessionRef: ref, agentId: id, action: body.action as PinAction,
      approveWrite: body.approve_write === true, idempotencyKey: key, conversationId: body.conversation_id,
    });
    const sent = await sendPinTurn({ requester: UI_OWNER_PRINCIPAL, pinRef: pin.id, content: body.content as string, idempotencyKey: key });
    return NextResponse.json({ pin: pinView(sent.pin), turn: sent.turn, replayed: sent.replayed }, { status: sent.replayed ? 200 : 202 });
  } catch (error) {
    if (error instanceof PinError) return NextResponse.json(pinErrorBody(error), { status: error.status });
    console.error('Error pinning session:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The session could not be reached.' } }, { status: 500 });
  }
}
