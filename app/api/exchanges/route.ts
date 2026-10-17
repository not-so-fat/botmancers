import { NextResponse } from 'next/server';
import { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { createExchangeCommand } from '@/lib/agent-conversations';
import { ExchangeError, exchangeErrorBody, exchangeInputFromBody } from '@/lib/session-exchanges';

// NOT-497: the owner starts a session-targeted Ask or Continue
// (lib/session-exchanges). 201 with the new exchange, 200 for an exact
// replay of the same idempotency key. The response names Botmancers ids
// only, never a provider session id.
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ExchangeError('invalid_request', 'The body must be a JSON object.');
    }
    const { exchange, created } = createExchangeCommand(exchangeInputFromBody(body, UI_OWNER_PRINCIPAL));
    return NextResponse.json({ exchange, replayed: !created }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ExchangeError) return NextResponse.json(exchangeErrorBody(error), { status: error.status });
    console.error('Error creating exchange:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The exchange could not be created.' } }, { status: 500 });
  }
}
