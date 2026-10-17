// NOT-499: a granted Agent's sessions (sessions:read).
import { handleListSessions } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  return handleListSessions(request, agentId);
}
