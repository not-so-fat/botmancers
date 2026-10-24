// NOT-517: share the session this Botmancers launch is bound to, by its
// Botmancers-Session-Context header (lib/session-context).
import { handleShareCurrent } from '@/lib/service-api-http';

export async function POST(request: Request) {
  return handleShareCurrent(request);
}
