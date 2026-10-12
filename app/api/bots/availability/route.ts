// NOT-433: coding-runtime availability.
//
// The response lists ONLY runtimes returned ready by the NOT-395
// capability probe (each runtime binary plus the agent-deck CLI verified
// present). Schema membership in codex|claude|cursor|muse never marks a
// runtime launchable: unprobed or unavailable runtimes are simply absent.
import { NextResponse } from 'next/server';
import { listAvailableDeckRuntimes } from '@/lib/agent-deck-run';
import { buildAvailabilityPayload } from '@/lib/bot-definition';

export async function GET() {
  try {
    const ready = await listAvailableDeckRuntimes();
    return NextResponse.json(buildAvailabilityPayload(ready));
  } catch (error) {
    console.error('Error probing deck runtimes:', error);
    return NextResponse.json({ error: 'Failed to probe runtimes' }, { status: 500 });
  }
}
