// NOT-459: one permanent-deletion contract shared by the Config Danger
// zone, the roster row action, and Manage agents. Pure (no db import) so
// the Next client components and the jiti tests can both load it.

export const MAX_DELETE_IDS = 500;

export const DELETE_REMOVES_COPY =
  'Permanently removes each agent with its direct conversation, messages, queue rows, approvals, ' +
  'launch snapshots, memories, one-shots, routines, and pending questions. There is no undo.';

export const DELETE_KEEPS_COPY =
  'Skill files, working directories, Hermes profiles, and imported source files stay on disk.';

export const CHIEF_BLOCK_REASON = 'Chief of Staff cannot be deleted.';
export const ACTIVE_BLOCK_REASON = 'Working now — stop it or let it finish before deleting.';

export interface DeleteAgentRef {
  id: string;
  name: string;
}

export type GroupOutcome = 'removed' | 'reassigned' | 'shrunk';

export interface DeleteGroupImpact {
  id: string;
  name: string;
  outcome: GroupOutcome;
  remaining: number;
  newOwner: DeleteAgentRef | null;
}

export interface DeleteBlocked extends DeleteAgentRef {
  reason: 'chief' | 'active';
}

// `groups` stays in the API preview for backend compatibility. The UI has no
// Group concept (NOT-461), so it discloses the impact on stored legacy data
// only through sharedConversationImpactCopy.
export interface DeletePreview {
  agents: DeleteAgentRef[];
  groups: DeleteGroupImpact[];
  missing: string[];
  blocked: DeleteBlocked[];
}

export type ParsedDeleteIds = { ok: true; ids: string[] } | { ok: false; error: string };

// Legacy `{ id }` or bulk `{ ids }` (1–500 unique non-empty strings).
// Anything else, including both keys at once, is a 400.
export function parseDeleteIds(body: unknown): ParsedDeleteIds {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a JSON object with id or ids.' };
  }
  const record = body as Record<string, unknown>;
  const hasId = record.id !== undefined;
  const hasIds = record.ids !== undefined;
  if (hasId && hasIds) return { ok: false, error: 'Send either id or ids, not both.' };
  if (hasId) {
    if (typeof record.id !== 'string' || !record.id.trim()) return { ok: false, error: 'Bot id is required' };
    return { ok: true, ids: [record.id.trim()] };
  }
  if (!hasIds) return { ok: false, error: 'Bot id is required' };
  if (!Array.isArray(record.ids)) return { ok: false, error: 'ids must be an array of agent ids.' };
  if (record.ids.length === 0) return { ok: false, error: 'Select at least one agent.' };
  if (record.ids.length > MAX_DELETE_IDS) {
    return { ok: false, error: `Delete at most ${MAX_DELETE_IDS} agents at once.` };
  }
  const ids: string[] = [];
  for (const value of record.ids) {
    if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Every id must be a non-empty string.' };
    ids.push(value.trim());
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'ids must be unique.' };
  return { ok: true, ids };
}

export function blockedReasonCopy(reason: DeleteBlocked['reason']): string {
  return reason === 'chief' ? CHIEF_BLOCK_REASON : ACTIVE_BLOCK_REASON;
}

// NOT-461: deletion still runs the backend group cascade on stored legacy
// data. Disclose it without Group terminology, and only when it applies, so
// the no-undo confirmation never understates what is destroyed.
export function sharedConversationImpactCopy(impacts: DeleteGroupImpact[]): string {
  if (impacts.length === 0) return '';
  const noun = impacts.length === 1 ? 'shared conversation' : 'shared conversations';
  const lead = `Also removes membership in ${impacts.length} ${noun} kept from an earlier version`;
  const removed = impacts.filter(impact => impact.outcome === 'removed').length;
  if (removed === 0) return `${lead}.`;
  const tail = removed === 1
    ? '1 drops below two agents and is permanently removed with its messages'
    : `${removed} drop below two agents and are permanently removed with their messages`;
  return `${lead}; ${tail}.`;
}

export function deleteConfirmLabel(count: number): string {
  return count === 1 ? 'Delete agent' : `Delete ${count} agents`;
}

export function deletedStatusLine(count: number): string {
  return count === 1 ? 'Deleted 1 agent.' : `Deleted ${count} agents.`;
}
