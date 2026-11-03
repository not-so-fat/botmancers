// NOT-456: agent availability.
//
// The response lists ONLY agents whose launch adapter the capability
// probe reported ready (Hermes: gateway configured; Cursor/Claude/Codex/
// Muse Code: provider binary verified present). Enum membership never
// marks an agent launchable: unprobed or unavailable agents are simply
// absent.
import { NextResponse } from 'next/server';
import { listAvailableAgents } from '@/lib/runtime-probe';
import { buildAvailabilityPayload } from '@/lib/bot-definition';

export async function GET() {
  try {
    const ready = await listAvailableAgents();
    return NextResponse.json(buildAvailabilityPayload(ready));
  } catch (error) {
    console.error('Error probing agents:', error);
    return NextResponse.json({ error: 'Failed to probe agents' }, { status: 500 });
  }
}
