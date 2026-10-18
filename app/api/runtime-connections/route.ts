// NOT-502: runtime connections. One connection is one runtime
// installation/account on one host ("Codex on this computer"); several
// registered Agents may share it. A connection stores a provider, a
// name, and a host label only: runtime credentials stay with the runtime
// and are rejected here.
import { NextResponse } from 'next/server';
import { runtimeConnections } from '@/lib/db';
import { AGENTS } from '@/lib/bot-definition';
import { validateConnectionInput } from '@/lib/agent-registration';

function view(connection: ReturnType<typeof runtimeConnections.getAll>[number]) {
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    host: connection.host,
    agent_count: runtimeConnections.agentCount(connection.id),
  };
}

export async function GET() {
  try {
    const connections = runtimeConnections.getAll().filter(connection => (AGENTS as readonly string[]).includes(connection.provider));
    return NextResponse.json({ connections: connections.map(view) });
  } catch (error) {
    console.error('Error listing runtime connections:', error);
    return NextResponse.json({ error: 'Failed to list runtime connections' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON object.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected a JSON object.' }, { status: 400 });
  }
  const parsed = validateConnectionInput(body as Record<string, unknown>);
  if (!parsed.fields) return NextResponse.json({ error: parsed.errors[0], errors: parsed.errors }, { status: 400 });
  try {
    return NextResponse.json(view(runtimeConnections.create(parsed.fields)));
  } catch (error) {
    console.error('Error creating runtime connection:', error);
    return NextResponse.json({ error: 'Failed to create runtime connection' }, { status: 500 });
  }
}
