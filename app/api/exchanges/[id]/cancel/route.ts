import { NextResponse } from 'next/server';
import { UI_OWNER_PRINCIPAL } from '@/lib/db';
import { cancelExchangeCommand, getExchangeView } from '@/lib/agent-conversations';
import { ExchangeError, exchangeErrorBody } from '@/lib/session-exchanges';

// NOT-497: the owner cancels a non-terminal exchange. A terminal exchange
// is 409 exchange_terminal and is not changed.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const current = getExchangeView(id);
    if (current.requester.kind !== UI_OWNER_PRINCIPAL.kind || current.requester.id !== UI_OWNER_PRINCIPAL.id) {
      throw new ExchangeError('exchange_not_found', `No exchange ${id}.`);
    }
    let reason: string | null = null;
    const text = await request.text();
    if (text.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ExchangeError('invalid_request', 'The body must be a JSON object.');
      }
      const value = body && typeof body === 'object' && !Array.isArray(body) ? (body as { reason?: unknown }).reason : undefined;
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 500)) {
        throw new ExchangeError('invalid_request', 'reason must be a string of at most 500 characters.');
      }
      reason = typeof value === 'string' ? value : null;
    }
    const { exchange, replayed } = await cancelExchangeCommand(id, UI_OWNER_PRINCIPAL, reason);
    return NextResponse.json({ exchange, replayed });
  } catch (error) {
    if (error instanceof ExchangeError) return NextResponse.json(exchangeErrorBody(error), { status: error.status });
    console.error('Error cancelling exchange:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The exchange could not be cancelled.' } }, { status: 500 });
  }
}
