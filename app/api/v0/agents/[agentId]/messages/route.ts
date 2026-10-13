import { handleSendAgentMessage } from '@/lib/agent-api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  return handleSendAgentMessage(request, agentId);
}
