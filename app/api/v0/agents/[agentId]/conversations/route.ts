// NOT-499: a granted Agent's conversations (conversations:read).
import { handleListConversations } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  return handleListConversations(request, agentId);
}
