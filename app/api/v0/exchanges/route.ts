// NOT-499: the caller's exchanges (exchanges:read) and new ones (exchanges:create).
import { handleCreateExchange, handleListExchanges } from '@/lib/service-api-http';

export async function GET(request: Request) {
  return handleListExchanges(request);
}

export async function POST(request: Request) {
  return handleCreateExchange(request);
}
