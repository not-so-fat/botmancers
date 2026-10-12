import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isSafeFileName } from '@/lib/draft';
import { filesRoot } from '@/lib/artifacts';

// Download a `[file]` artifact. Only simple names inside the files directory
// are servable; anything else is rejected before touching disk.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    if (!isSafeFileName(name)) {
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 });
    }
    const dir = filesRoot();
    const filePath = path.join(dir, name);
    if (!filePath.startsWith(dir + path.sep)) {
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 });
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    const data = fs.readFileSync(filePath);
    const contentType = name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch (error) {
    console.error('Error serving file:', error);
    return NextResponse.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
