// NOT-443: workspace Agent Deck server URL. Single value with a
// loopback default; invalid URLs are rejected, never stored.
import { NextResponse } from 'next/server';
import {
  DEFAULT_AGENT_DECK_SERVER_URL,
  getAgentDeckServerUrl,
  setAgentDeckServerUrl,
  InvalidAgentDeckServerUrlError,
} from '@/lib/agent-deck-settings';

export async function GET() {
  try {
    return NextResponse.json({ server_url: getAgentDeckServerUrl(), default_server_url: DEFAULT_AGENT_DECK_SERVER_URL });
  } catch (error) {
    console.error('Error reading Agent Deck settings:', error);
    return NextResponse.json({ error: 'Failed to read Agent Deck settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const raw = body.server_url ?? body.serverUrl ?? body.url;
    try {
      const server_url = setAgentDeckServerUrl(raw);
      return NextResponse.json({ server_url, default_server_url: DEFAULT_AGENT_DECK_SERVER_URL });
    } catch (error) {
      const message = error instanceof InvalidAgentDeckServerUrlError
        ? error.message
        : `Invalid Agent Deck server URL: ${JSON.stringify(String(raw ?? ''))}. Expected an http(s) URL such as ${DEFAULT_AGENT_DECK_SERVER_URL}.`;
      return NextResponse.json({ error: message }, { status: 400 });
    }
  } catch (error) {
    console.error('Error saving Agent Deck settings:', error);
    return NextResponse.json({ error: 'Failed to save Agent Deck settings' }, { status: 500 });
  }
}
