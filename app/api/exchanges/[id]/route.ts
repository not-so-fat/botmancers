import { NextResponse } from 'next/server';
import db, { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { getExchangeView } from '@/lib/agent-conversations';
import { ExchangeError, exchangeErrorBody } from '@/lib/session-exchanges';
import { exchangeDetail } from '@/lib/exchange-ledger';

// NOT-497: one exchange of the owner: state, causal Work Request and
// Attempt references, answer or packet, failure, and its event log.
// NOT-498: `detail` is the same exchange as the ledger presents it
// (lib/exchange-ledger): readable participants and every linked thread.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const exchange = getExchangeView(id);
    if (exchange.requester.kind !== UI_OWNER_PRINCIPAL.kind || exchange.requester.id !== UI_OWNER_PRINCIPAL.id) {
      throw new ExchangeError('exchange_not_found', `No exchange ${id}.`);
    }
    return NextResponse.json({ exchange, detail: exchangeDetail(db, exchange) });
  } catch (error) {
    if (error instanceof ExchangeError) return NextResponse.json(exchangeErrorBody(error), { status: error.status });
    console.error('Error reading exchange:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The exchange could not be read.' } }, { status: 500 });
  }
}
