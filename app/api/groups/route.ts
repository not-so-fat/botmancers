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
    const { name, botIds, ownerId } = body;

    if (!name || !botIds || !Array.isArray(botIds) || botIds.length < 2 || botIds.length > 6) {
      return NextResponse.json(
        { error: 'A group needs a name and 2 to 6 bots' },
        { status: 400 }
      );
    }

    const group = groups.create(String(name), botIds.map(String), ownerId ? String(ownerId) : undefined);
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
    const body = await request.json();
    const id = body.id ? String(body.id) : '';
    const name = body.name ? String(body.name).trim() : '';
    if (!id || !name) {
      return NextResponse.json({ error: 'Group id and name are required' }, { status: 400 });
    }
    groups.rename(id, name);
    const group = groups.getAll().find(item => item.id === id);
    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }
    return NextResponse.json({ ...group, members: groups.getMembers(id) });
  } catch (error) {
    console.error('Error renaming group:', error);
    return NextResponse.json({ error: 'Failed to rename group' }, { status: 500 });
  }
}
