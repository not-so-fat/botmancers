import { NextResponse } from 'next/server';
import { getAgentOverview } from '@/lib/agent-overview';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const overview = getAgentOverview(id);
    if (!overview) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    return NextResponse.json(overview);
  } catch (error) {
    console.error('Error fetching Agent overview:', error);
    return NextResponse.json({ error: 'Failed to fetch Agent overview' }, { status: 500 });
  }
}
