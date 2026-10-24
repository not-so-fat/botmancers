// NOT-515: the caller's own session shares (shares:create).
import { handleListShares } from '@/lib/service-api-http';

export async function GET(request: Request) {
  return handleListShares(request);
}
