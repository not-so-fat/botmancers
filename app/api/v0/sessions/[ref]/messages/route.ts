// NOT-499: one read-only turn on an exact active session (sessions:message).
import { handleSendSessionMessage } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params;
  return handleSendSessionMessage(request, ref);
}
