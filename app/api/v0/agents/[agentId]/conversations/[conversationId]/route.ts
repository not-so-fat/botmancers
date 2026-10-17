// NOT-499: one conversation of a granted Agent (conversations:read).
import { handleGetConversation } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string; conversationId: string }> }
) {
  const { agentId, conversationId } = await params;
  return handleGetConversation(request, agentId, conversationId);
}
