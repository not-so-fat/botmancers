// NOT-478: instance-unique Agent names. One Agent name per Botmancers
// instance after trimming and case-insensitive comparison; the display
// name keeps its casing. The canonical key is computed here (JavaScript
// handles Unicode case, which SQLite lower() does not) and stored in
// bots.name_key under a unique index, so the database is the final
// arbiter. Pure helpers only: no database access.

export const AGENT_NAME_CONFLICT_CODE = 'agent_name_conflict';

// Stored display name: surrounding whitespace (Unicode included) removed,
// casing and inner spacing preserved.
export function agentDisplayName(name: unknown): string {
  return String(name ?? '').trim();
}

// Canonical uniqueness key: trimmed, lower-cased, NFC-normalized so
// composed and decomposed forms of the same letter collide.
export function agentNameKey(name: unknown): string {
  return agentDisplayName(name).normalize('NFC').toLowerCase().normalize('NFC');
}

export function agentNameConflictMessage(name: string): string {
  return `An Agent named "${agentDisplayName(name)}" already exists. Agent names must be unique, ignoring case and surrounding spaces.`;
}

export class AgentNameConflictError extends Error {
  readonly code = AGENT_NAME_CONFLICT_CODE;
  readonly requestedName: string;
  readonly conflictingAgentId: string | null;
  constructor(requestedName: string, conflictingAgentId: string | null) {
    super(agentNameConflictMessage(requestedName));
    this.name = 'AgentNameConflictError';
    this.requestedName = agentDisplayName(requestedName);
    this.conflictingAgentId = conflictingAgentId;
  }
}

export interface AgentNameConflictBody {
  error: string;
  code: typeof AGENT_NAME_CONFLICT_CODE;
  field: string;
  name: string;
  conflicting_agent_id: string | null;
}

// The one HTTP 409 body every Agent write path returns on a name
// conflict. field is the request field that carried the name.
export function agentNameConflictBody(error: AgentNameConflictError, field = 'name'): AgentNameConflictBody {
  return {
    error: error.message,
    code: AGENT_NAME_CONFLICT_CODE,
    field,
    name: error.requestedName,
    conflicting_agent_id: error.conflictingAgentId,
  };
}

export interface NameMigrationRow {
  id: string;
  name: string;
  created_at: number;
  name_key: string | null;
}

export interface NameMigrationRename {
  bot_id: string;
  previous_name: string;
  new_name: string;
  name_key: string;
  kept_bot_id: string;
}

export interface NameMigrationPlan {
  // Every row whose stored name or name_key must change.
  updates: { id: string; name: string; name_key: string }[];
  // Only automatic duplicate renames (reported to the owner).
  renames: NameMigrationRename[];
}

// Deterministic duplicate resolution. Rows are ranked oldest first
// (created_at, then id). Every row first claims its own key in rank
// order; a row whose key is already held keeps its ID and is renamed to
// "<display>-N" with the smallest N >= 2 whose key is free, so a suffix
// never lands on another Agent's existing name. Rows that only lacked a
// stored key are backfilled without a rename.
export function planNameMigration(rows: NameMigrationRow[]): NameMigrationPlan {
  const ranked = [...rows].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const owner = new Map<string, string>();
  const deferred: NameMigrationRow[] = [];
  const updates: NameMigrationPlan['updates'] = [];
  for (const row of ranked) {
    const key = agentNameKey(row.name);
    if (owner.has(key)) {
      deferred.push(row);
      continue;
    }
    owner.set(key, row.id);
    if (row.name_key !== key) updates.push({ id: row.id, name: row.name, name_key: key });
  }
  const renames: NameMigrationRename[] = [];
  for (const row of deferred) {
    const original = agentNameKey(row.name);
    const base = agentDisplayName(row.name) || 'Agent';
    let n = 2;
    while (owner.has(agentNameKey(`${base}-${n}`))) n++;
    const name = `${base}-${n}`;
    const key = agentNameKey(name);
    owner.set(key, row.id);
    updates.push({ id: row.id, name, name_key: key });
    renames.push({ bot_id: row.id, previous_name: row.name, new_name: name, name_key: original, kept_bot_id: owner.get(original)! });
  }
  return { updates, renames };
}
