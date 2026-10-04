import { NextResponse } from 'next/server';
import { URL } from 'url';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  
  const paramKeys = Array.from(searchParams.keys());
  if (paramKeys.length !== 1 || !paramKeys.includes('return')) {
    return NextResponse.json(
      { error: 'Only return parameter is allowed' },
      { status: 400 }
    );
  }
  
  const returnPath = searchParams.get('return');

  if (!returnPath) {
    return NextResponse.json(
      { error: 'Return path is required' },
      { status: 400 }
    );
  }

  let cleanedReturnPath: string;
  try {
    const returnUrl = new URL(returnPath);
    const requestUrl = new URL(request.url);
    
    if (returnUrl.origin !== requestUrl.origin) {
      return NextResponse.json(
        { error: 'Return path must be same-origin' },
        { status: 400 }
      );
    }
    
    returnUrl.username = '';
    returnUrl.password = '';
    returnUrl.hash = '';
    cleanedReturnPath = returnUrl.toString();
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid return path' },
      { status: 400 }
    );
  }

  const cloneMarketUrl = process.env.CLONE_MARKET_URL;
  
  if (!cloneMarketUrl) {
    return NextResponse.json(
      { error: 'CLONE_MARKET_URL is not configured' },
      { status: 404 }
    );
  }

  try {
    const marketplaceUrl = new URL(cloneMarketUrl);
    
    marketplaceUrl.username = '';
    marketplaceUrl.password = '';
    marketplaceUrl.hash = '';
    marketplaceUrl.search = '';
    
    marketplaceUrl.searchParams.set('target', 'botmancers');
    marketplaceUrl.searchParams.set('return', cleanedReturnPath);
    
    return NextResponse.redirect(marketplaceUrl.toString());
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid CLONE_MARKET_URL configuration' },
      { status: 500 }
    );
  }
}
