// NOT-507: detach one of the caller's pins (idempotent).
import { handleDetachPin } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pinRef: string }> }
) {
  const { pinRef } = await params;
  return handleDetachPin(request, pinRef);
}
