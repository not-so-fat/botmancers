import { NextResponse } from 'next/server';
import { mcpServers } from '@/lib/db';

export async function GET() {
  try {
    const rows = mcpServers.list().map(row => ({
      ...row,
      args: JSON.parse(row.args) as string[],
    }));
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Error listing MCP servers:', error);
    return NextResponse.json({ error: 'Failed to list MCP servers' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = body.name ? String(body.name).trim() : '';
    const command = body.command ? String(body.command).trim() : '';
    const args = Array.isArray(body.args) ? body.args.map((part: unknown) => String(part)) : [];
    if (!name || !command) {
      return NextResponse.json({ error: 'Name and command are required' }, { status: 400 });
    }
    const row = mcpServers.create(name, command, args);
    return NextResponse.json({ ...row, args });
  } catch (error) {
    console.error('Error storing MCP server:', error);
    return NextResponse.json({ error: 'Failed to store MCP server' }, { status: 500 });
  }
}
