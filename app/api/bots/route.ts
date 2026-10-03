import { NextResponse } from 'next/server';
import { bots } from '@/lib/db';
import '@/lib/agent';

export async function GET() {
  try {
    const allBots = bots.getAll();
    return NextResponse.json(allBots);
  } catch (error) {
    console.error('Error fetching bots:', error);
    return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, title, description, avatar } = body;

    if (!name || !title || !description) {
      return NextResponse.json(
        { error: 'Name, title, and description are required' },
        { status: 400 }
      );
    }

    const bot = bots.create({ name, title, description, avatar });
    return NextResponse.json(bot);
  } catch (error) {
    console.error('Error creating bot:', error);
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 });
  }
}
