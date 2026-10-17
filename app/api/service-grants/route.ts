import { NextResponse } from 'next/server';
import { bots, serviceAudit } from '@/lib/db';
import { SERVICE_CAPABILITIES, loadServiceGrants } from '@/lib/service-grants';

// NOT-499: the owner's view of the service-grants document
// (docs/service-grants.md): whether it loaded, the first problem when it
// did not, the effective grants, and the latest service audit events.
// Read-only; the owner edits the file itself. Behind the owner boundary.
export async function GET() {
  try {
    const loaded = loadServiceGrants();
    const services = loaded.state === 'loaded'
      ? [...loaded.grants.entries()].map(([service, agents]) => ({
        service,
        agents: [...agents.entries()].map(([agentId, caps]) => ({
          agent_id: agentId,
          agent_name: bots.getById(agentId)?.name ?? null,
          capabilities: SERVICE_CAPABILITIES.filter(cap => caps.has(cap)),
        })),
      }))
      : [];
    return NextResponse.json({
      state: loaded.state,
      path: loaded.path,
      reason: loaded.state === 'invalid' ? loaded.reason : null,
      services,
      audit: serviceAudit.list({ limit: 50 }),
    });
  } catch (error) {
    console.error('Error reading service grants:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: { code: 'internal_error', message: 'The service grants could not be read.' } }, { status: 500 });
  }
}
