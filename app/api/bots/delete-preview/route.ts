import { NextResponse } from 'next/server';
import { bots } from '@/lib/db';
import { parseDeleteIds } from '@/lib/bot-deletion';

// NOT-459: read-only impact of DELETE /api/bots for the same body. Missing
// and blocked targets come back in the preview so the confirmation can
// explain them; nothing is written.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON object with id or ids.' }, { status: 400 });
  }
  const parsed = parseDeleteIds(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(bots.deletionPreview(parsed.ids));
  } catch (error) {
    console.error('Error previewing bot deletion:', error);
    return NextResponse.json({ error: 'Failed to preview deletion' }, { status: 500 });
  }
}
