import { NextResponse } from 'next/server';
import { groups } from '@/lib/db';

export async function GET() {
  try {
    const allGroups = groups.getAll();
    const groupsWithMembers = allGroups.map(group => ({
      ...group,
      members: groups.getMembers(group.id),
    }));
    return NextResponse.json(groupsWithMembers);
  } catch (error) {
    console.error('Error fetching groups:', error);
    return NextResponse.json({ error: 'Failed to fetch groups' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, botIds } = body;

    if (!name || !botIds || !Array.isArray(botIds) || botIds.length === 0) {
      return NextResponse.json(
        { error: 'Name and botIds array are required' },
        { status: 400 }
      );
    }

    const group = groups.create(name, botIds);
    return NextResponse.json({
      ...group,
      members: groups.getMembers(group.id),
    });
  } catch (error) {
    console.error('Error creating group:', error);
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const { id, name } = body ?? {};

    if (typeof id !== 'string' || !id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const group = groups.getById(id);
    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    groups.rename(id, name.trim());
    const updated = groups.getById(id);
    return NextResponse.json({
      ...updated,
      members: groups.getMembers(id),
    });
  } catch (error) {
    console.error('Error renaming group:', error);
    return NextResponse.json({ error: 'Failed to rename group' }, { status: 500 });
  }
}
