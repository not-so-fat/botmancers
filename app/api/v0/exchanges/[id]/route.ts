// NOT-499: one of the caller's exchanges (exchanges:read).
import { handleGetExchange } from '@/lib/service-api-http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return handleGetExchange(request, id);
}
