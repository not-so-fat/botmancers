import { NextResponse } from 'next/server';

export async function GET() {
  const cloneMarketUrl = process.env.CLONE_MARKET_URL;
  
  return NextResponse.json({
    configured: !!cloneMarketUrl,
  });
}
