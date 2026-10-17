// NOT-499: one session of a granted Agent (sessions:read).
import { handleGetSession } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string; ref: string }> }
) {
  const { agentId, ref } = await params;
  return handleGetSession(request, agentId, ref);
}
