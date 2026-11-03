import { NextResponse } from 'next/server';
import db, { BotDeletionError, bots, conversations, messages, registrationContext, serializeAgent } from '@/lib/db';
import { uiTurns } from '@/lib/ui-turns';
import { blockedReasonCopy, parseDeleteIds, type DeletePreview } from '@/lib/bot-deletion';
import { processUiTurns } from '@/lib/agent';
import { LEGACY_RUNTIME_FIELD_ERROR, REMOVED_LAUNCH_FIELD_ERROR } from '@/lib/bot-definition';
import {
  hasRegistrationUpdate,
  validateCreateRegistration,
  validateUpdateRegistration,
} from '@/lib/agent-registration';
import { validateAvatarInput } from '@/lib/avatar';
import { AgentNameConflictError, agentNameConflictBody } from '@/lib/agent-names';
import { syncAgentSessionHistory } from '@/lib/provider-sessions';

export async function GET() {
  try {
    const allBots = bots.getAll().map(bot => ({ ...serializeAgent(bot), unread: bot.unread ? 1 : 0, hidden: bot.hidden ? 1 : 0, latest: messages.latestFromBot(bot.id) }));
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

    // NOT-543: the registered Agent, direct-only: a runtime connection,
    // an explicit session scope, an optional default workspace, and a
    // launch policy. Removed launch fields (launch profile, deck,
    // working-directory override) and legacy runtime fields are
    // rejected. Every field is validated before anything is written.
    const legacyErrors: string[] = [];
    if (body.runtime !== undefined || body.agent_client !== undefined) legacyErrors.push(LEGACY_RUNTIME_FIELD_ERROR);
    if (body.launch_profile !== undefined || body.deck_id !== undefined || body.deck_name !== undefined || body.working_directory !== undefined) {
      legacyErrors.push(REMOVED_LAUNCH_FIELD_ERROR);
    }
    if (legacyErrors.length > 0) return NextResponse.json({ error: legacyErrors[0], errors: legacyErrors }, { status: 400 });
    const selection = validateCreateRegistration(body, registrationContext);
    if (selection.errors.length > 0 || !selection.registration || !selection.provider) {
      return NextResponse.json(
        { error: selection.errors[0], errors: selection.errors },
        { status: 400 }
      );
    }
    const registration = selection.registration;

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
      agent: selection.provider,
      runtime_connection_id: registration.runtime_connection_id,
      session_scope_kind: registration.session_scope.kind,
      session_scope_items: JSON.stringify(
        registration.session_scope.kind === 'workspaces' ? registration.session_scope.workspaces : registration.session_scope.sessions
      ),
      default_workspace: registration.default_workspace,
      policy_mode: registration.policy.mode,
      allow_new_sessions: registration.policy.allow_new_sessions ? 1 : 0,
      allow_resume_with_edits: registration.policy.allow_resume_with_edits ? 1 : 0,
      home_session_id: registration.home_session_id,
      avatar_color: avatarConfig.fields.avatar_color ?? null,
      avatar_eyes: avatarConfig.fields.avatar_eyes ?? null,
      avatar_hands: avatarConfig.fields.avatar_hands ?? null,
      avatar_accessory: avatarConfig.fields.avatar_accessory ?? null,
    });

    // Claude Code keeps past conversations in its local session store. Load
    // every in-scope page as part of registration so the new Agent's Sessions
    // drawer and message routing can use that history immediately. Discovery
    // is read-only and never starts Claude; a missing/unavailable store must
    // not roll back an otherwise valid Agent registration.
    if (selection.provider === 'claude') {
      try {
        await syncAgentSessionHistory(db, bot.id);
      } catch (error) {
        console.warn('Claude session history was not available during Agent registration.', error);
      }
    }
    const conversation = conversations.getByBotId(bot.id);
    if (conversation) {
      uiTurns.enqueue(conversation.id, bot.id, { reason: 'greeting' });
      processUiTurns().catch(console.error);
    }
    const created = bots.getById(bot.id);
    return NextResponse.json(created ? serializeAgent(created) : null);
  } catch (error) {
    if (error instanceof AgentNameConflictError) return NextResponse.json(agentNameConflictBody(error), { status: 409 });
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
    // Validate every supplied field before writing anything, then apply
    // all writes in one transaction: a rejected request changes nothing.
    const reject = (errors: string[]) =>
      NextResponse.json({ error: errors[0], errors }, { status: 400 });
    let avatarConfig: ReturnType<typeof validateAvatarInput> | null = null;
    let avatarImage: string | null | undefined;
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') {
        avatarImage = null;
      } else if (typeof body.avatar === 'object' && !Array.isArray(body.avatar)) {
        // NOT-431: nested avatar config object (color/eyes/hands/accessory).
        avatarConfig = validateAvatarInput(body.avatar);
        if (avatarConfig.errors.length > 0) return reject(avatarConfig.errors);
      } else {
        const avatar = String(body.avatar);
        if (!avatar.startsWith('data:image/')) {
          return NextResponse.json({ error: 'Image is required' }, { status: 400 });
        }
        avatarImage = avatar;
      }
    }
    let identity: { name: string; title: string; description: string } | null = null;
    if (body.name !== undefined || body.title !== undefined || body.description !== undefined) {
      const name = body.name !== undefined ? String(body.name).trim() : bot.name;
      if (!name) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 });
      }
      const title = body.title !== undefined ? String(body.title) : bot.title;
      const description = body.description !== undefined ? String(body.description) : bot.description;
      identity = { name, title, description };
    }
    // NOT-543: registration fields (and agent alone, which moves the Agent
    // to that provider's local connection) merge over the stored
    // registration and the whole candidate is validated: an invalid
    // combination writes nothing. Legacy runtime fields and removed
    // launch fields are rejected.
    const legacyErrors: string[] = [];
    if (body.runtime !== undefined || body.agent_client !== undefined) legacyErrors.push(LEGACY_RUNTIME_FIELD_ERROR);
    if (body.launch_profile !== undefined || body.deck_id !== undefined || body.deck_name !== undefined || body.working_directory !== undefined) {
      legacyErrors.push(REMOVED_LAUNCH_FIELD_ERROR);
    }
    if (legacyErrors.length > 0) return reject(legacyErrors);
    const selection = (body.agent !== undefined || hasRegistrationUpdate(body))
      ? validateUpdateRegistration(id, bot, body, registrationContext)
      : null;
    if (selection && (selection.errors.length > 0 || !selection.registration || !selection.provider)) return reject(selection.errors);

    db.transaction(() => {
      if (avatarImage !== undefined) bots.setAvatar(id, avatarImage);
      if (avatarConfig) bots.updateAvatarConfig(id, avatarConfig.fields);
      if (body.pinned !== undefined) bots.setPinned(id, Boolean(body.pinned));
      if (body.hidden !== undefined) bots.setHidden(id, Boolean(body.hidden));
      if (body.unread !== undefined) {
        if (body.unread) bots.markUnread(id);
        else bots.markRead(id);
      }
      if (identity) bots.updateIdentity(id, identity.name, identity.title, identity.description);
      if (selection?.registration && selection.provider) bots.updateRegistration(id, selection.provider, selection.registration);
    })();
    const updated = bots.getById(id);
    return NextResponse.json(updated ? serializeAgent(updated) : updated);
  } catch (error) {
    if (error instanceof AgentNameConflictError) return NextResponse.json(agentNameConflictBody(error), { status: 409 });
    console.error('Error setting avatar:', error);
    return NextResponse.json({ error: 'Failed to set avatar' }, { status: 500 });
  }
}

function deletionErrorResponse(preview: DeletePreview) {
  if (preview.missing.length > 0) {
    return NextResponse.json({ error: 'Bot not found', missing: preview.missing }, { status: 404 });
  }
  const reasons = preview.blocked.map(item => `${item.name} — ${blockedReasonCopy(item.reason)}`).join(' ');
  return NextResponse.json(
    {
      error: `Nothing was deleted. ${reasons}`,
      blocked: preview.blocked.map(item => ({ ...item, message: blockedReasonCopy(item.reason) })),
    },
    { status: 409 }
  );
}

// NOT-459: legacy `{ id }` or bulk `{ ids }`. 400 for malformed input,
// 404 when any target is missing, 409 when any target is the Chief of
// Staff or has a queued or running UI turn; the batch is atomic.
export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON object with id or ids.' }, { status: 400 });
  }
  const parsed = parseDeleteIds(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const preview = bots.removeMany(parsed.ids);
    return NextResponse.json({ ok: true, deleted: preview.agents, groups: preview.groups });
  } catch (error) {
    if (error instanceof BotDeletionError) return deletionErrorResponse(error.preview);
    console.error('Error deleting bot:', error);
    return NextResponse.json({ error: 'Failed to delete bot' }, { status: 500 });
  }
}
