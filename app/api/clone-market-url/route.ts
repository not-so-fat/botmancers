import { NextResponse } from 'next/server';

export async function GET() {
  const cloneMarketUrl = process.env.CLONE_MARKET_URL;
  
  if (!cloneMarketUrl) {
    return NextResponse.json(
      { error: 'CLONE_MARKET_URL is not configured' },
      { status: 404 }
    );
  }
  
  return NextResponse.json({ url: cloneMarketUrl });
}
