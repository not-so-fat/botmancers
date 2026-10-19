// NOT-507: pin an exact session to Ask from it (sessions:message) or Resume
// work in it (sessions:resume, explicitly approved).
import { handlePinSession } from '@/lib/service-api-http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params;
  return handlePinSession(request, ref);
}
