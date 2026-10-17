// NOT-499: cancel one of the caller's exchanges (exchanges:create).
import { handleCancelExchange } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return handleCancelExchange(request, id);
}
