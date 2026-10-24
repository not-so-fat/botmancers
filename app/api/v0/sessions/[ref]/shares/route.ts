// NOT-515: share one exact session as a temporary ask-only share
// (shares:create).
import { handleCreateShare } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params;
  return handleCreateShare(request, ref);
}
