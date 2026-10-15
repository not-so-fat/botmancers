import { NextResponse } from 'next/server';
import { retryWakeCommand } from '@/lib/agent-conversations';
import { WakeRouterError } from '@/lib/wake-router';

// NOT-475: re-checks a blocked or unavailable Wake against the current
// grant and target availability (owner boundary: proxy.ts).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = retryWakeCommand(id);
    return NextResponse.json({
      wakeId: result.wake.id,
      status: result.wake.status,
      reasonCode: result.wake.reason_code,
      requestId: result.request?.id ?? null,
      requestState: result.request?.state ?? null,
    });
  } catch (error) {
    if (error instanceof WakeRouterError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.code === 'not_found' ? 404 : 400 });
    }
    console.error('Wake retry failed:', error);
    return NextResponse.json({ error: { code: 'internal_error', message: 'The Wake could not be retried.' } }, { status: 500 });
  }
}
