import { NextResponse } from 'next/server';
import { bots, messages } from '@/lib/db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const message = messages.getById(id);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }
    const rows = messages.repliesBetween(message).map(row => {
      const bot = row.sender_id ? bots.getById(row.sender_id) : undefined;
      return { ...row, sender_name: bot?.name };
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Error fetching messages between bots:', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}
