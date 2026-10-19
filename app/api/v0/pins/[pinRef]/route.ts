// NOT-507: one of the caller's pins and its newest turns.
import { handleReadPin } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pinRef: string }> }
) {
  const { pinRef } = await params;
  return handleReadPin(request, pinRef);
}
