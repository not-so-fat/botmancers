// NOT-499: one granted Agent (agents:read).
import { handleGetAgent } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  return handleGetAgent(request, agentId);
}
