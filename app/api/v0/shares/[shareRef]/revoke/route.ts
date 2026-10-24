// NOT-515: revoke one of the caller's session shares (idempotent).
import { handleRevokeShare } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ shareRef: string }> }
) {
  const { shareRef } = await params;
  return handleRevokeShare(request, shareRef);
}
