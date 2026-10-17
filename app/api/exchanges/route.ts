import { NextResponse } from 'next/server';
import db, { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { createExchangeCommand } from '@/lib/agent-conversations';
import { ExchangeError, exchangeErrorBody, exchangeInputFromBody } from '@/lib/session-exchanges';
import { EXCHANGE_STATES } from '@/lib/exchange-view';
import { listExchanges } from '@/lib/exchange-ledger';

// NOT-498: the owner's exchanges for the Agent Exchanges ledger and the
// inline thread cards (lib/exchange-ledger), newest activity first.
// ?mode=ask|continue, ?state=<state>|active, ?agent=<id> (source or
// destination), ?conversation=<id> (linked as origin, source, or
// destination). No provider session id is part of the response.
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const mode = params.get('mode');
    const state = params.get('state');
    if (mode !== null && mode !== 'ask' && mode !== 'continue') {
      return NextResponse.json({ error: { code: 'invalid_request', message: 'mode must be ask or continue.' } }, { status: 400 });
    }
    if (state !== null && state !== 'active' && !(EXCHANGE_STATES as string[]).includes(state)) {
      return NextResponse.json({ error: { code: 'invalid_request', message: 'state must be an exchange state or active.' } }, { status: 400 });
    }
    const exchanges = listExchanges(db, {
      requester: UI_OWNER_PRINCIPAL,
      mode,
      state: state as Parameters<typeof listExchanges>[1]['state'],
      agentId: params.get('agent'),
      conversationId: params.get('conversation'),
    });
    return NextResponse.json({ exchanges });
  } catch (error) {
    console.error('Error listing exchanges:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The exchanges could not be listed.' } }, { status: 500 });
  }
}

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
