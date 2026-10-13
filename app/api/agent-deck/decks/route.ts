// NOT-443: server-side deck-discovery proxy. Proxies exactly one
// verified request (GET <configured URL>/api/launch/decks, no
// credentials) and validates success/data/decks/id/name. Never calls
// GET /api/decks and never falls back to the local CLI.
import { NextResponse } from 'next/server';
import {
  agentDeckDecksUrl,
  getAgentDeckServerUrl,
  listAgentDecks,
  AgentDeckDiscoveryError,
} from '@/lib/agent-deck-settings';

export async function GET() {
  const serverUrl = getAgentDeckServerUrl();
  try {
    const decks = await listAgentDecks({ serverUrl });
    return NextResponse.json({ server_url: serverUrl, decks });
  } catch (error) {
    const attemptedUrls = error instanceof AgentDeckDiscoveryError && error.attemptedUrls.length > 0
      ? error.attemptedUrls
      : [agentDeckDecksUrl(serverUrl)];
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AgentDeckDiscoveryError ? error.code : 'agent-deck-discovery-failed';
    console.error('Agent Deck deck discovery failed:', message);
    return NextResponse.json({ error: message, code, attemptedUrls, server_url: serverUrl }, { status: 502 });
  }
}
