// NOT-507: message a registered Agent; Botmancers resolves and pins its
// session (sessions:message; starting one: sessions:start).
import { handleMessageAgent } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  return handleMessageAgent(request, agentId);
}
