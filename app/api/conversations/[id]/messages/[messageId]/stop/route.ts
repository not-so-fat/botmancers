import { NextResponse } from 'next/server';
import { stopFileReadRun, stopPublicPageReadRun } from '@/lib/run-child';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { messageId } = await params;
    
    stopFileReadRun(messageId);
    stopPublicPageReadRun(messageId);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error stopping run:', error);
    return NextResponse.json({ error: 'Failed to stop run' }, { status: 500 });
  }
}
