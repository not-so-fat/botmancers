import { NextResponse } from 'next/server';
import { isMarketConfigured } from '@/lib/market-handoff';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ configured: isMarketConfigured() });
}
