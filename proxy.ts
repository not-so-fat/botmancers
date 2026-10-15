// NOT-475: the owner boundary for every UI route (lib/owner-boundary).
// A request from a non-loopback host, or a mutating request from another
// origin, is refused with 403 owner_origin_required before any route reads
// its body. /api/v0 authenticates through its own authenticator.
import { NextResponse, type NextRequest } from 'next/server';
import { OWNER_ORIGIN_REQUIRED, ownerBoundaryRefusalFor } from './lib/owner-boundary';

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/v0/')) return NextResponse.next();
  const refusal = ownerBoundaryRefusalFor(request);
  if (refusal) {
    console.warn(`Refused ${request.method} ${request.nextUrl.pathname}: ${refusal}`);
    return NextResponse.json({ error: { code: OWNER_ORIGIN_REQUIRED, message: refusal } }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
