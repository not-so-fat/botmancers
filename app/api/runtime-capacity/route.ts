import { NextResponse } from 'next/server';
import { getRuntimeCapacity } from '@/lib/capacity/service';

export async function GET() {
  try {
    const data = await getRuntimeCapacity();
    return NextResponse.json(data);
  } catch (error) {
    console.error('runtime-capacity failed:', error);
    return NextResponse.json({ error: 'Failed to read runtime capacity' }, { status: 500 });
  }
}
