import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'Bad file name' }, { status: 400 });
  }
  const root = path.resolve(process.cwd(), 'files');
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
  const bytes = fs.readFileSync(file);
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  });
}
