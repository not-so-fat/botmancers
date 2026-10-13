import { NextResponse } from 'next/server';
import { bots, conversations, messages, queue } from '@/lib/db';
import { processQueue } from '@/lib/agent';
import {
  serializeBot,
  validateCreateRuntimePath,
  validateUpdateRuntimePath,
} from '@/lib/bot-definition';
import { validateAvatarInput } from '@/lib/avatar';

export async function GET() {
  try {
    const allBots = bots.getAll().map(bot => ({ ...serializeBot(bot), unread: bot.unread ? 1 : 0, hidden: bot.hidden ? 1 : 0, latest: messages.latestFromBot(bot.id) }));
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

    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    // NOT-433: runtime-path contract. Unknown runtimes are rejected; a
    // manually created bot marked launchable must carry the full coding
    // path (runtime, deck name, working directory).
    const runtimePath = validateCreateRuntimePath(body);
    if (runtimePath.errors.length > 0) {
      return NextResponse.json(
        { error: runtimePath.errors[0], errors: runtimePath.errors },
        { status: 400 }
      );
    }

    // NOT-431: optional nested avatar config object. A string avatar stays
    // the legacy uploaded image; an object configures the composable avatar.
    const avatarIsConfigObject =
      body.avatar !== null && body.avatar !== undefined &&
      typeof body.avatar === 'object' && !Array.isArray(body.avatar);
    if (body.avatar !== undefined && body.avatar !== null && typeof body.avatar !== 'string' && !avatarIsConfigObject) {
      return NextResponse.json({ error: 'Invalid avatar: expected an image string or an avatar config object' }, { status: 400 });
    }
    const avatarConfig = validateAvatarInput(avatarIsConfigObject ? body.avatar : undefined);
    if (avatarConfig.errors.length > 0) {
      return NextResponse.json(
        { error: avatarConfig.errors[0], errors: avatarConfig.errors },
        { status: 400 }
      );
    }

    const bot = bots.create({
      name: String(name).trim(),
      title: title ? String(title) : '',
      description: description ? String(description) : '',
      avatar: typeof avatar === 'string' ? avatar : undefined,
      persistent_runtime: runtimePath.normalized.persistent_runtime,
      coding_runtime: runtimePath.normalized.coding_runtime,
      deck_name: runtimePath.normalized.deck_name,
      working_directory: runtimePath.normalized.working_directory,
      avatar_color: avatarConfig.fields.avatar_color ?? null,
      avatar_eyes: avatarConfig.fields.avatar_eyes ?? null,
      avatar_hands: avatarConfig.fields.avatar_hands ?? null,
      avatar_accessory: avatarConfig.fields.avatar_accessory ?? null,
    });
    const conversation = conversations.getByBotId(bot.id);
    if (conversation) {
      queue.enqueue(conversation.id, bot.id);
      processQueue().catch(console.error);
    }
    return NextResponse.json(serializeBot(bot));
  } catch (error) {
    console.error('Error creating bot:', error);
    return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = body.id ? String(body.id) : '';
    if (!id) {
      return NextResponse.json({ error: 'Bot id is required' }, { status: 400 });
    }
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        bots.setAvatar(id, null);
      } else if (typeof body.avatar === 'object' && !Array.isArray(body.avatar)) {
        // NOT-431: nested avatar config object (color/eyes/hands/accessory).
        const avatarConfig = validateAvatarInput(body.avatar);
        if (avatarConfig.errors.length > 0) {
          return NextResponse.json(
            { error: avatarConfig.errors[0], errors: avatarConfig.errors },
            { status: 400 }
          );
        }
        bots.updateAvatarConfig(id, avatarConfig.fields);
      } else {
        const avatar = String(body.avatar);
        if (!avatar.startsWith('data:image/')) {
          return NextResponse.json({ error: 'Image is required' }, { status: 400 });
        }
        bots.setAvatar(id, avatar);
      }
    }
    if (body.pinned !== undefined) {
      bots.setPinned(id, Boolean(body.pinned));
    }
    if (body.hidden !== undefined) {
      bots.setHidden(id, Boolean(body.hidden));
    }
    if (body.unread !== undefined) {
      if (body.unread) bots.markUnread(id);
      else bots.markRead(id);
    }
    if (body.name !== undefined || body.title !== undefined || body.description !== undefined) {
      const name = body.name !== undefined ? String(body.name).trim() : bot.name;
      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 });
      }
      const title = body.title !== undefined ? String(body.title) : bot.title;
      const description = body.description !== undefined ? String(body.description) : bot.description;
      bots.updateIdentity(id, name, title, description);
    }
    // NOT-433: owner-supplied runtime path. Unknown coding/persistent
    // runtimes are rejected; blank coding values clear back to unconfigured.
    if (
      body.persistent_runtime !== undefined ||
      body.coding_runtime !== undefined ||
      body.deck_name !== undefined ||
      body.working_directory !== undefined
    ) {
      const update = validateUpdateRuntimePath(body);
      if (update.errors.length > 0) {
        return NextResponse.json(
          { error: update.errors[0], errors: update.errors },
          { status: 400 }
        );
      }
      bots.updateRuntimePath(id, update.fields);
    }
    const updated = bots.getById(id);
    return NextResponse.json(updated ? serializeBot(updated) : updated);
  } catch (error) {
    console.error('Error setting avatar:', error);
    return NextResponse.json({ error: 'Failed to set avatar' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const id = body.id ? String(body.id) : '';
    if (!id) {
      return NextResponse.json({ error: 'Bot id is required' }, { status: 400 });
    }
    const bot = bots.getById(id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    bots.remove(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error deleting bot:', error);
    return NextResponse.json({ error: 'Failed to delete bot' }, { status: 500 });
  }
}
