// NOT-507: one turn on exactly the pinned session.
import { handleSendToPin } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pinRef: string }> }
) {
  const { pinRef } = await params;
  return handleSendToPin(request, pinRef);
}
