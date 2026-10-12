import { NextResponse } from 'next/server';
import { bots, groups } from '@/lib/db';

export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;
export const GROUP_SIZE_ERROR = 'Pick 2 to 6 bots.';

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

    if (!name || !botIds || !Array.isArray(botIds) || botIds.length === 0) {
      return NextResponse.json(
        { error: 'Name and botIds array are required' },
        { status: 400 }
      );
    }

    if (botIds.length < GROUP_MIN_MEMBERS || botIds.length > GROUP_MAX_MEMBERS) {
      return NextResponse.json({ error: GROUP_SIZE_ERROR }, { status: 400 });
    }

    for (const botId of botIds) {
      if (typeof botId !== 'string' || !bots.getById(botId)) {
        return NextResponse.json({ error: 'Unknown botId' }, { status: 400 });
      }
    }

    const owner = typeof ownerId === 'string' && botIds.includes(ownerId) ? ownerId : undefined;
    const group = groups.create(name, botIds, owner);
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
