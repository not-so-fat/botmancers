import { handleGetAgentRequest } from '@/lib/agent-api';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return handleGetAgentRequest(request, id);
}
