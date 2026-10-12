import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Legacy path; use /api/marketplace-handoff. */
export async function GET() {
  return NextResponse.json(
    { error: 'Use /api/marketplace-handoff' },
    { status: 404 },
  );
}
