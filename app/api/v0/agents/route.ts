// NOT-499: the Agents granted to the caller (agents:read).
import { handleListAgents } from '@/lib/service-api-http';

export async function GET(request: Request) {
  return handleListAgents(request);
}
