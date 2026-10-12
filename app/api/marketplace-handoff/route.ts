import { NextResponse } from 'next/server';
import {
  buildHandoffDestination,
  cleanReturnUrl,
  invalidHandoffQuery,
  isMarketConfigured,
} from '@/lib/market-handoff';

export const dynamic = 'force-dynamic';

/** Prefer Host / X-Forwarded-* so 127.0.0.1 and localhost are not mixed by the runtime. */
function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (!host) return url.origin;
  const protoHeader = request.headers.get('x-forwarded-proto');
  const proto = (protoHeader || url.protocol.replace(':', '') || 'http').split(',')[0].trim();
  return `${proto}://${host.split(',')[0].trim()}`;
}

export async function GET(request: Request) {
  if (invalidHandoffQuery(request)) {
    return NextResponse.json(
      { error: 'Exactly one query parameter named return is required' },
      { status: 400 },
    );
  }

  const returnRaw = new URL(request.url).searchParams.get('return');
  if (!returnRaw) {
    return NextResponse.json(
      { error: 'Exactly one query parameter named return is required' },
      { status: 400 },
    );
  }

  const cleanedReturn = cleanReturnUrl(returnRaw);
  const origin = requestOrigin(request);
  if (!cleanedReturn || cleanedReturn.origin !== origin) {
    return NextResponse.json(
      { error: 'return must be a valid same-origin URL' },
      { status: 400 },
    );
  }

  if (!isMarketConfigured()) {
    return NextResponse.json(
      { error: 'CLONE_MARKET_URL is not set.' },
      { status: 404 },
    );
  }

  const destination = buildHandoffDestination(cleanedReturn);
  if (!destination) {
    return NextResponse.json(
      { error: 'CLONE_MARKET_URL is not set.' },
      { status: 404 },
    );
  }

  return NextResponse.redirect(destination, 307);
}
