// NOT-499: the caller's service grants (lib/service-api-http).
import { handleGetCapabilities } from '@/lib/service-api-http';

export async function GET(request: Request) {
  return handleGetCapabilities(request);
}
