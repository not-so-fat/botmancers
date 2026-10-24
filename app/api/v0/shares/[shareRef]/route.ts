// NOT-515: one of the caller's session shares.
import { handleGetShare } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ shareRef: string }> }
) {
  const { shareRef } = await params;
  return handleGetShare(request, shareRef);
}
