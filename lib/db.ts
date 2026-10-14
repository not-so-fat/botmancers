import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { applyAgentUpdate, DEFAULT_AGENT, migrateLegacyAgentFields, type AgentUpdateFields } from './bot-definition';
import { isChiefOfStaffName } from './avatar';
import type { DeleteAgentRef, DeleteBlocked, DeleteGroupImpact, DeletePreview } from './bot-deletion';
import { createEngineStore, deleteEngineRecordsForAgent, deleteEngineRecordsForConversation, migrateEngineSchema } from './engine-store';
import { createConversationProjector } from './conversation-projection';
import { AgentNameConflictError, agentDisplayName, agentNameKey, planNameMigration, type NameMigrationRow } from './agent-names';

// Overridable so the stub-model delegation test uses an isolated file.
const DB_PATH = process.env.BOTMANCERS_DB_PATH || 'botmancers.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    avatar TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (group_id, bot_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    bot_id TEXT,
    group_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id),
    FOREIGN KEY (group_id) REFERENCES groups(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS processing_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE TABLE IF NOT EXISTS launch_snapshots (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    hash TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_queue_status ON processing_queue(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_snapshots_bot ON launch_snapshots(bot_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS draft_actions (
    message_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    recipient TEXT,
    acted_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approvals (
    conversation_id TEXT NOT NULL,
    code TEXT NOT NULL,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (conversation_id, code)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_bot ON memories(bot_id, created_at);

  CREATE TABLE IF NOT EXISTS one_shots (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    word TEXT NOT NULL,
    next_due_at INTEGER NOT NULL,
    every_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_questions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    question TEXT NOT NULL,
    task_message_id TEXT,
    task_content TEXT,
    question_message_id TEXT,
    answer_message_id TEXT,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'asked',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_pending_questions_conversation
    ON pending_questions(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    bot_id TEXT,
    code TEXT NOT NULL,
    action_type TEXT,
    action_args TEXT,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_conversation_code
    ON approval_requests(conversation_id, code);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_conversation
    ON approval_requests(conversation_id, status, created_at);
`);

const BOT_COLORS = ['#C6F54A', '#F0A05A', '#E85D75', '#C9A0FF', '#F2E36B'];
const CEDAR_ID = '9e363764-e0d5-4fff-8ebd-ccbc46ba0ba5';
const PINE_ID = '5fbe32c2-79cb-452e-9d9b-f8c9eb63b99b';

const botColumns = db.prepare('PRAGMA table_info(bots)').all() as { name: string }[];
if (!botColumns.some(column => column.name === 'color')) {
  db.exec('ALTER TABLE bots ADD COLUMN color TEXT');
}
if (!botColumns.some(column => column.name === 'pinned')) {
  db.exec('ALTER TABLE bots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
}
if (!botColumns.some(column => column.name === 'last_seen')) {
  db.exec('ALTER TABLE bots ADD COLUMN last_seen INTEGER');
}
if (!botColumns.some(column => column.name === 'unread')) {
  db.exec('ALTER TABLE bots ADD COLUMN unread INTEGER NOT NULL DEFAULT 0');
}
if (!botColumns.some(column => column.name === 'hidden')) {
  db.exec('ALTER TABLE bots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}
if (!botColumns.some(column => column.name === 'source_provider')) {
  db.exec('ALTER TABLE bots ADD COLUMN source_provider TEXT');
}
if (!botColumns.some(column => column.name === 'template_id')) {
  db.exec('ALTER TABLE bots ADD COLUMN template_id TEXT');
}
if (!botColumns.some(column => column.name === 'template_url')) {
  db.exec('ALTER TABLE bots ADD COLUMN template_url TEXT');
}
if (!botColumns.some(column => column.name === 'import_schema_version')) {
  db.exec('ALTER TABLE bots ADD COLUMN import_schema_version TEXT');
}
if (!botColumns.some(column => column.name === 'import_operation_id')) {
  db.exec('ALTER TABLE bots ADD COLUMN import_operation_id TEXT');
}
if (!botColumns.some(column => column.name === 'import_timestamp')) {
  db.exec('ALTER TABLE bots ADD COLUMN import_timestamp INTEGER');
}
if (!botColumns.some(column => column.name === 'hermes_profile')) {
  db.exec('ALTER TABLE bots ADD COLUMN hermes_profile TEXT');
}
// NOT-433: persisted runtime path. persistent_runtime defaults to Hermes
// for pre-migration rows (the product default, not an invented coding
// path). coding_runtime/deck_name/working_directory stay NULL until the
// owner supplies them: never guessed for existing or imported bots.
if (!botColumns.some(column => column.name === 'persistent_runtime')) {
  db.exec("ALTER TABLE bots ADD COLUMN persistent_runtime TEXT NOT NULL DEFAULT 'hermes'");
}
if (!botColumns.some(column => column.name === 'coding_runtime')) {
  db.exec('ALTER TABLE bots ADD COLUMN coding_runtime TEXT');
}
if (!botColumns.some(column => column.name === 'deck_name')) {
  db.exec('ALTER TABLE bots ADD COLUMN deck_name TEXT');
}
if (!botColumns.some(column => column.name === 'working_directory')) {
  db.exec('ALTER TABLE bots ADD COLUMN working_directory TEXT');
}
// NOT-442 single-runtime columns. Since NOT-456, runtime/agent_client/
// needs_deck_reselection are legacy migration inputs only (like
// persistent_runtime/coding_runtime): nothing reads them for dispatch or
// serialization and no new write sets them. deck_id stays live.
if (!botColumns.some(column => column.name === 'runtime')) {
  db.exec('ALTER TABLE bots ADD COLUMN runtime TEXT');
}
if (!botColumns.some(column => column.name === 'agent_client')) {
  db.exec('ALTER TABLE bots ADD COLUMN agent_client TEXT');
}
if (!botColumns.some(column => column.name === 'deck_id')) {
  db.exec('ALTER TABLE bots ADD COLUMN deck_id TEXT');
}
if (!botColumns.some(column => column.name === 'needs_deck_reselection')) {
  db.exec('ALTER TABLE bots ADD COLUMN needs_deck_reselection INTEGER NOT NULL DEFAULT 0');
}
// NOT-456: agent identity independent of the Agent Deck selection.
// agent is nullable so the migration below can tell unmigrated rows
// apart: a null agent means "not yet migrated".
if (!botColumns.some(column => column.name === 'agent')) {
  db.exec('ALTER TABLE bots ADD COLUMN agent TEXT');
}
if (!botColumns.some(column => column.name === 'needs_deck_selection')) {
  db.exec('ALTER TABLE bots ADD COLUMN needs_deck_selection INTEGER NOT NULL DEFAULT 0');
}

// NOT-456 data migration (deterministic, no network calls): every row
// without an agent is assigned exactly one agent by
// migrateLegacyAgentFields in ./bot-definition. runtime=hermes becomes
// agent=hermes; runtime=agent-deck becomes its agent_client; pre-NOT-442
// rows follow the legacy coding-path rule. deck_id, deck_name, and
// working_directory carry over verbatim; rows without a deck ID are
// marked as needing Agent Deck selection. Only the bots row's agent
// columns are written: conversations, provenance, and launch snapshots
// are untouched. Idempotent: rows that already store an agent are skipped.
{
  const unmigrated = db.prepare(
    'SELECT id, agent, runtime, agent_client, persistent_runtime, coding_runtime, deck_id, deck_name, working_directory, needs_deck_reselection, needs_deck_selection FROM bots WHERE agent IS NULL'
  ).all() as {
    id: string;
    agent: string | null;
    runtime: string | null;
    agent_client: string | null;
    persistent_runtime: string | null;
    coding_runtime: string | null;
    deck_id: string | null;
    deck_name: string | null;
    working_directory: string | null;
    needs_deck_reselection: number | null;
    needs_deck_selection: number | null;
  }[];
  const apply = db.prepare(
    'UPDATE bots SET agent = ?, deck_id = ?, deck_name = ?, working_directory = ?, needs_deck_selection = ? WHERE id = ?'
  );
  const migrateAll = db.transaction((rows: typeof unmigrated) => {
    for (const row of rows) {
      const next = migrateLegacyAgentFields(row);
      apply.run(
        next.agent,
        next.deck_id,
        next.deck_name,
        next.working_directory,
        next.needs_deck_selection ? 1 : 0,
        row.id
      );
    }
  });
  migrateAll(unmigrated);
}
// NOT-431: composable avatar configuration. Null means unconfigured and
// reads back as the defaults (purple/dots/folded/none; crown accessory
// for the Chief of Staff) via resolveAvatar in lib/avatar.
if (!botColumns.some(column => column.name === 'avatar_color')) {
  db.exec('ALTER TABLE bots ADD COLUMN avatar_color TEXT');
}
if (!botColumns.some(column => column.name === 'avatar_eyes')) {
  db.exec('ALTER TABLE bots ADD COLUMN avatar_eyes TEXT');
}
if (!botColumns.some(column => column.name === 'avatar_hands')) {
  db.exec('ALTER TABLE bots ADD COLUMN avatar_hands TEXT');
}
if (!botColumns.some(column => column.name === 'avatar_accessory')) {
  db.exec('ALTER TABLE bots ADD COLUMN avatar_accessory TEXT');
}

// NOT-478: instance-unique Agent names. name_key is the canonical
// trimmed, case-insensitive key from ./agent-names, enforced by a unique
// index. Every load reconciles stored keys (backfilling rows written
// without one) and resolves legacy duplicates deterministically: the
// oldest Agent keeps its name, later ones get "-2", "-3", ... Agent IDs,
// conversations, messages, and Wake records are never touched. Each
// automatic rename is recorded in agent_name_migrations for the owner.
if (!botColumns.some(column => column.name === 'name_key')) {
  db.exec('ALTER TABLE bots ADD COLUMN name_key TEXT');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_name_migrations (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    previous_name TEXT NOT NULL,
    new_name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kept_bot_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.transaction(() => {
  const rows = db.prepare('SELECT id, name, created_at, name_key FROM bots').all() as NameMigrationRow[];
  const plan = planNameMigration(rows);
  if (plan.updates.length === 0) return;
  // Clear first so reassigning keys never trips the unique index mid-way.
  const clear = db.prepare('UPDATE bots SET name_key = NULL WHERE id = ?');
  for (const update of plan.updates) clear.run(update.id);
  const apply = db.prepare('UPDATE bots SET name = ?, name_key = ? WHERE id = ?');
  for (const update of plan.updates) apply.run(update.name, update.name_key, update.id);
  const report = db.prepare(
    "INSERT INTO agent_name_migrations (id, bot_id, previous_name, new_name, name_key, kept_bot_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, 'duplicate_name', ?)"
  );
  const at = Date.now();
  for (const rename of plan.renames) {
    report.run(randomUUID(), rename.bot_id, rename.previous_name, rename.new_name, rename.name_key, rename.kept_bot_id, at);
    console.warn(`[botmancers] Agent ${rename.bot_id} renamed "${rename.previous_name}" -> "${rename.new_name}": name already used by Agent ${rename.kept_bot_id}.`);
  }
})();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_name_key ON bots(name_key)');

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_import_operation
  ON bots(import_operation_id) WHERE import_operation_id IS NOT NULL
`);

db.prepare('UPDATE bots SET color = ? WHERE id = ?').run(BOT_COLORS[0], CEDAR_ID);
db.prepare('UPDATE bots SET color = ? WHERE id = ?').run(BOT_COLORS[1], PINE_ID);

const otherBots = db.prepare(
  'SELECT id FROM bots WHERE id NOT IN (?, ?) ORDER BY created_at ASC'
).all(CEDAR_ID, PINE_ID) as { id: string }[];
const setColor = db.prepare('UPDATE bots SET color = ? WHERE id = ?');
otherBots.forEach((bot, index) => {
  setColor.run(BOT_COLORS[(index + 2) % BOT_COLORS.length], bot.id);
});

// NOT-478: the shared name rule for every Agent write. Returns the
// trimmed display name plus its key, or throws AgentNameConflictError
// when another Agent (not exceptId) already holds the key.
function claimAgentName(name: string, exceptId?: string): { name: string; name_key: string } {
  const display = agentDisplayName(name);
  const key = agentNameKey(display);
  const holder = db.prepare('SELECT id FROM bots WHERE name_key = ?').get(key) as { id: string } | undefined;
  if (holder && holder.id !== exceptId) throw new AgentNameConflictError(display, holder.id);
  return { name: display, name_key: key };
}

// The unique index is the final arbiter: a racing writer that slips past
// claimAgentName still surfaces as the same conflict, never a raw error.
function withNameConstraint<T>(name: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: bots\.name_key/.test(error.message)) {
      const holder = db.prepare('SELECT id FROM bots WHERE name_key = ?').get(agentNameKey(name)) as { id: string } | undefined;
      throw new AgentNameConflictError(name, holder?.id ?? null);
    }
    throw error;
  }
}

function nextBotColor(): string {
  const row = db.prepare('SELECT COUNT(*) AS n FROM bots').get() as { n: number };
  return BOT_COLORS[row.n % BOT_COLORS.length];
}

export interface Bot {
  id: string;
  name: string;
  // NOT-478: canonical unique key (see ./agent-names); written by the
  // repository, never by callers.
  name_key?: string | null;
  title: string;
  description: string;
  avatar?: string;
  color: string;
  pinned?: number;
  hidden?: number;
  last_seen?: number | null;
  unread?: number;
  created_at: number;
  source_provider?: string | null;
  template_id?: string | null;
  template_url?: string | null;
  import_schema_version?: string | null;
  import_operation_id?: string | null;
  import_timestamp?: number | null;
  hermes_profile?: string | null;
  // Legacy columns (NOT-433 dual model, NOT-442 single runtime):
  // migration inputs only, never written or serialized.
  persistent_runtime?: string | null;
  coding_runtime?: string | null;
  runtime?: string | null;
  agent_client?: string | null;
  needs_deck_reselection?: number | null;
  // NOT-456: one agent (hermes|cursor|claude|codex|muse) plus one Agent
  // Deck selection. deck_name on a row without a deck ID is the
  // unresolved legacy reference; working_directory is the optional
  // launch override; needs_deck_selection blocks launch until a deck ID
  // is selected.
  agent?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: number | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
}

export interface ImportProvenance {
  source_provider: string;
  template_id: string;
  template_url: string;
  import_schema_version: string;
  import_operation_id: string;
  import_timestamp: number;
}

const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
if (!messageColumns.some(column => column.name === 'handoff_targets')) {
  db.exec('ALTER TABLE messages ADD COLUMN handoff_targets TEXT');
}

const groupColumns = db.prepare('PRAGMA table_info(groups)').all() as { name: string }[];
if (!groupColumns.some(column => column.name === 'owner_bot_id')) {
  db.exec('ALTER TABLE groups ADD COLUMN owner_bot_id TEXT');
}

// Transport that served a launch ('hermes-gateway' for Hermes turns,
// 'agent-deck' for direct Agent Deck turns). Outside the hashed snapshot
// input: it records how the turn ran, not the effective configuration,
// so backfilled rows read 'hermes-gateway'. NOT-435 removed the embedded
// example model loop and its former transport value.
const snapshotColumns = db.prepare('PRAGMA table_info(launch_snapshots)').all() as { name: string }[];
if (!snapshotColumns.some(column => column.name === 'transport')) {
  db.exec("ALTER TABLE launch_snapshots ADD COLUMN transport TEXT NOT NULL DEFAULT 'hermes-gateway'");
}

// NOT-446: one history model for UI threads and agent API conversations.
// Participants and the origin principal are explicit rows/columns instead
// of being implied by conversations.bot_id/group_id. sender_kind carries
// the principal kind (person|bot|service) next to the legacy UI
// sender_type (user|bot); request_id links a message to the agent request
// that accepted or answered it.
const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
if (!conversationColumns.some(column => column.name === 'origin_kind')) {
  db.exec('ALTER TABLE conversations ADD COLUMN origin_kind TEXT');
}
if (!conversationColumns.some(column => column.name === 'origin_id')) {
  db.exec('ALTER TABLE conversations ADD COLUMN origin_id TEXT');
}
if (!messageColumns.some(column => column.name === 'sender_kind')) {
  db.exec('ALTER TABLE messages ADD COLUMN sender_kind TEXT');
}
if (!messageColumns.some(column => column.name === 'request_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN request_id TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL,
    participant_kind TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, participant_kind, participant_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS agent_requests (
    id TEXT PRIMARY KEY,
    principal_kind TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    target_bot_id TEXT NOT NULL,
    accepted_message_id TEXT NOT NULL,
    runtime TEXT,
    state TEXT NOT NULL,
    reply_message_id TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_requests_idempotency
    ON agent_requests(principal_kind, principal_id, operation, idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_agent_requests_conversation
    ON agent_requests(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS agent_request_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (request_id) REFERENCES agent_requests(id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_request_events_request
    ON agent_request_events(request_id, created_at);
`);

// NOT-463: canonical Work Request / Attempt / Session Binding / engine
// event persistence (lib/engine-store). Versioned migrations run after
// the legacy tables exist so terminal agent_requests history backfills.
migrateEngineSchema(db);
export const engine = createEngineStore(db);
// NOT-470: typed conversation projection of engine lifecycle events.
export const projector = createConversationProjector(db);

export type PrincipalKind = 'person' | 'bot' | 'service';

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

// The person behind the local UI. Pre-NOT-446 UI threads had no explicit
// human participant; the compatibility migration binds them to this one.
export const UI_OWNER_PRINCIPAL: Principal = { kind: 'person', id: 'local-owner' };

const insertParticipant = db.prepare(
  'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)'
);

function bindUiConversation(conversationId: string, botIds: string[], at: number): void {
  db.prepare(
    'UPDATE conversations SET origin_kind = ?, origin_id = ? WHERE id = ? AND origin_kind IS NULL'
  ).run(UI_OWNER_PRINCIPAL.kind, UI_OWNER_PRINCIPAL.id, conversationId);
  insertParticipant.run(conversationId, UI_OWNER_PRINCIPAL.kind, UI_OWNER_PRINCIPAL.id, at);
  for (const botId of botIds) insertParticipant.run(conversationId, 'bot', botId, at);
}

// Compatibility migration (idempotent, additive): existing UI threads get
// the UI owner as origin plus their bot/group members as participants,
// and existing messages get a sender_kind. Message rows are never moved,
// copied, or deleted.
db.transaction(() => {
  db.exec("UPDATE messages SET sender_kind = 'person' WHERE sender_kind IS NULL AND sender_type = 'user'");
  db.exec("UPDATE messages SET sender_kind = 'bot' WHERE sender_kind IS NULL AND sender_type = 'bot'");
  const legacy = db.prepare(
    "SELECT id, type, bot_id, group_id, created_at FROM conversations WHERE origin_kind IS NULL AND type IN ('bot', 'group')"
  ).all() as { id: string; type: string; bot_id: string | null; group_id: string | null; created_at: number }[];
  const membersOf = db.prepare('SELECT bot_id FROM group_members WHERE group_id = ?');
  for (const row of legacy) {
    const botIds = row.type === 'bot'
      ? (row.bot_id ? [row.bot_id] : [])
      : (row.group_id ? (membersOf.all(row.group_id) as { bot_id: string }[]).map(member => member.bot_id) : []);
    bindUiConversation(row.id, botIds, row.created_at);
  }
})();

export interface Group {
  id: string;
  name: string;
  owner_bot_id?: string | null;
  created_at: number;
}

export interface Conversation {
  id: string;
  // 'agent' conversations are opened through the agent conversation API.
  type: 'bot' | 'group' | 'agent';
  bot_id?: string;
  group_id?: string;
  origin_kind?: PrincipalKind | null;
  origin_id?: string | null;
  created_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: 'user' | 'bot';
  sender_id?: string;
  sender_kind?: PrincipalKind | null;
  request_id?: string | null;
  content: string;
  handoff_targets?: string | null;
  created_at: number;
}

export interface QueueItem {
  id: string;
  conversation_id: string;
  bot_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: number;
  started_at?: number;
  completed_at?: number;
}

export const bots = {
  create: (data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned' | 'name_key'>, overrides?: { id?: string; created_at?: number }): Bot => {
    const claimed = claimAgentName(data.name);
    const bot: Bot = {
      id: overrides?.id || randomUUID(),
      ...data,
      ...claimed,
      color: nextBotColor(),
      created_at: overrides?.created_at ?? Date.now(),
    };
    // NOT-456: one agent plus one deck selection. A row without a deck ID
    // is stored but cannot launch until a deck is selected; no deck is
    // ever defaulted. Legacy runtime columns are never written.
    bot.agent = bot.agent || DEFAULT_AGENT;
    bot.deck_id = bot.deck_id || null;
    bot.needs_deck_selection = !bot.deck_id || bot.needs_deck_selection ? 1 : 0;
    withNameConstraint(bot.name, () => db.prepare(
      'INSERT INTO bots (id, name, name_key, title, description, avatar, color, hermes_profile, agent, deck_id, deck_name, working_directory, needs_deck_selection, avatar_color, avatar_eyes, avatar_hands, avatar_accessory, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      bot.id, bot.name, bot.name_key, bot.title, bot.description, bot.avatar || null, bot.color,
      bot.hermes_profile || null,
      bot.agent,
      bot.deck_id,
      bot.deck_name || null,
      bot.working_directory || null,
      bot.needs_deck_selection,
      bot.avatar_color || null,
      bot.avatar_eyes || null,
      bot.avatar_hands || null,
      bot.avatar_accessory || null,
      bot.created_at
    ));

    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    bindUiConversation(conversationId, [bot.id], bot.created_at);
    
    return bot;
  },

  createFromImport: (
    data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned' | 'hidden' | 'last_seen' | 'unread' | 'source_provider' | 'template_id' | 'template_url' | 'import_schema_version' | 'import_operation_id' | 'import_timestamp' | 'hermes_profile' | 'persistent_runtime' | 'coding_runtime' | 'runtime' | 'agent_client' | 'needs_deck_reselection' | 'agent' | 'deck_id' | 'deck_name' | 'working_directory' | 'needs_deck_selection' | 'name_key'>,
    provenance: ImportProvenance
  ): Bot => {
    const claimed = claimAgentName(data.name);
    const bot: Bot = {
      id: randomUUID(),
      ...data,
      ...claimed,
      color: nextBotColor(),
      created_at: Date.now(),
      // NOT-456: imported bots get the default agent and no deck. They
      // stay readable and need an Agent Deck selected before launch.
      agent: DEFAULT_AGENT,
      deck_id: null,
      deck_name: null,
      working_directory: null,
      needs_deck_selection: 1,
      source_provider: provenance.source_provider,
      template_id: provenance.template_id,
      template_url: provenance.template_url,
      import_schema_version: provenance.import_schema_version,
      import_operation_id: provenance.import_operation_id,
      import_timestamp: provenance.import_timestamp,
    };
    withNameConstraint(bot.name, () => db.prepare(
      `INSERT INTO bots (
        id, name, name_key, title, description, avatar, color, created_at,
        source_provider, template_id, template_url, import_schema_version,
        import_operation_id, import_timestamp,
        agent, deck_id, deck_name, working_directory,
        needs_deck_selection
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bot.id, bot.name, bot.name_key, bot.title, bot.description, bot.avatar || null, bot.color, bot.created_at,
      bot.source_provider, bot.template_id, bot.template_url, bot.import_schema_version,
      bot.import_operation_id, bot.import_timestamp,
      bot.agent, bot.deck_id, bot.deck_name, bot.working_directory,
      bot.needs_deck_selection
    ));
    
    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    bindUiConversation(conversationId, [bot.id], bot.created_at);
    
    return bot;
  },

  getByImportOperationId: (operationId: string): Bot | undefined => {
    return db.prepare('SELECT * FROM bots WHERE import_operation_id = ?').get(operationId) as Bot | undefined;
  },
  
  getAll: (): Bot[] => {
    return db.prepare('SELECT * FROM bots ORDER BY created_at DESC').all() as Bot[];
  },
  
  getById: (id: string): Bot | undefined => {
    return db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as Bot | undefined;
  },

  setAvatar: (id: string, avatar: string | null): void => {
    db.prepare('UPDATE bots SET avatar = ? WHERE id = ?').run(avatar, id);
  },

  // NOT-478: Agents are addressed by name; this resolves a name to its
  // one Agent through the unique key (never "first case-insensitive match").
  getByName: (name: string): Bot | undefined => {
    const key = agentNameKey(name);
    if (!key) return undefined;
    return db.prepare('SELECT * FROM bots WHERE name_key = ?').get(key) as Bot | undefined;
  },

  // Rename keeps the Agent ID, so history and Wake records stay attached;
  // historical message text is never rewritten. Throws
  // AgentNameConflictError when another Agent holds the name.
  updateIdentity: (id: string, name: string, title: string, description: string): void => {
    const claimed = claimAgentName(name, id);
    withNameConstraint(claimed.name, () => db.prepare(
      'UPDATE bots SET name = ?, name_key = ?, title = ?, description = ? WHERE id = ?'
    ).run(claimed.name, claimed.name_key, title, description, id));
  },

  setPinned: (id: string, pinned: boolean): void => {
    db.prepare('UPDATE bots SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  },

  setHidden: (id: string, hidden: boolean): void => {
    db.prepare('UPDATE bots SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  },

  setHermesProfile: (id: string, profile: string | null): void => {
    const value = profile && profile.trim() ? profile.trim() : null;
    db.prepare('UPDATE bots SET hermes_profile = ? WHERE id = ?').run(value, id);
  },

  // NOT-456: owner-supplied agent + Agent Deck selection, merged through
  // applyAgentUpdate: selecting a deck ID resolves a pending deck
  // selection. Legacy runtime columns are never written.
  updateAgentSelection: (id: string, fields: AgentUpdateFields): void => {
    const current = bots.getById(id);
    if (!current) return;
    const next = applyAgentUpdate(current, fields);
    db.prepare(
      'UPDATE bots SET agent = ?, deck_id = ?, deck_name = ?, working_directory = ?, needs_deck_selection = ? WHERE id = ?'
    ).run(
      next.agent,
      next.deck_id,
      next.deck_name,
      next.working_directory,
      next.needs_deck_selection ? 1 : 0,
      id
    );
  },

  // NOT-431: owner-supplied avatar configuration. Only supplied fields
  // are overwritten; everything else keeps its stored value (null when
  // never configured, which reads back as the defaults).
  updateAvatarConfig: (
    id: string,
    fields: { avatar_color?: string | null; avatar_eyes?: string | null; avatar_hands?: string | null; avatar_accessory?: string | null }
  ): void => {
    const current = bots.getById(id);
    if (!current) return;
    const pick = (next: string | null | undefined, stored: string | null | undefined): string | null => {
      if (next === undefined) return stored || null;
      return next && String(next).trim() ? String(next).trim() : null;
    };
    db.prepare(
      'UPDATE bots SET avatar_color = ?, avatar_eyes = ?, avatar_hands = ?, avatar_accessory = ? WHERE id = ?'
    ).run(
      pick(fields.avatar_color, current.avatar_color),
      pick(fields.avatar_eyes, current.avatar_eyes),
      pick(fields.avatar_hands, current.avatar_hands),
      pick(fields.avatar_accessory, current.avatar_accessory),
      id
    );
  },

  touchSeen: (): void => {
    db.prepare('UPDATE bots SET last_seen = ?').run(Date.now());
  },

  markUnread: (id: string): void => {
    db.prepare('UPDATE bots SET unread = 1 WHERE id = ?').run(id);
  },

  markRead: (id: string): void => {
    db.prepare('UPDATE bots SET unread = 0 WHERE id = ?').run(id);
  },

  remove: (id: string): void => {
    bots.removeMany([id]);
  },

  // NOT-459: impact of deleting ids, computed against current rows.
  // Missing ids, the Chief of Staff, and agents with a pending or
  // processing queue row are reported; nothing is written.
  deletionPreview: (ids: string[]): DeletePreview => {
    const selected = new Set(ids);
    const agents: DeleteAgentRef[] = [];
    const missing: string[] = [];
    const blocked: DeleteBlocked[] = [];
    const activeIds = new Set(activeBotIds());
    for (const id of ids) {
      const bot = bots.getById(id);
      if (!bot) {
        missing.push(id);
        continue;
      }
      agents.push({ id: bot.id, name: bot.name });
      if (isChiefOfStaffName(bot.name)) blocked.push({ id: bot.id, name: bot.name, reason: 'chief' });
      else if (activeIds.has(bot.id)) blocked.push({ id: bot.id, name: bot.name, reason: 'active' });
    }
    return { agents, groups: groupImpacts(selected), missing, blocked };
  },

  // All-or-nothing: validation, group reconciliation, and every row
  // delete run in one transaction. Filesystem content is never touched.
  // onAgentDeleted runs inside the transaction (tests inject a failure).
  removeMany: (ids: string[], options?: { onAgentDeleted?: (id: string) => void }): DeletePreview => {
    return db.transaction(() => {
      const preview = bots.deletionPreview(ids);
      if (preview.missing.length > 0 || preview.blocked.length > 0) throw new BotDeletionError(preview);
      const selected = new Set(ids);
      for (const impact of preview.groups) {
        if (impact.outcome === 'removed') {
          deleteGroupRecords(impact.id);
          continue;
        }
        const conversationIds = (db.prepare('SELECT id FROM conversations WHERE group_id = ?').all(impact.id) as { id: string }[]).map(row => row.id);
        for (const id of selected) {
          db.prepare('DELETE FROM group_members WHERE group_id = ? AND bot_id = ?').run(impact.id, id);
          for (const conversationId of conversationIds) {
            db.prepare(
              "DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_kind = 'bot' AND participant_id = ?"
            ).run(conversationId, id);
          }
        }
        if (impact.newOwner) db.prepare('UPDATE groups SET owner_bot_id = ? WHERE id = ?').run(impact.newOwner.id, impact.id);
      }
      for (const id of ids) {
        const owned = db.prepare('SELECT id FROM conversations WHERE bot_id = ?').all(id) as { id: string }[];
        for (const conversation of owned) deleteConversationRecords(conversation.id);
        deleteEngineRecordsForAgent(db, id);
        db.prepare('DELETE FROM processing_queue WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM launch_snapshots WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM group_members WHERE bot_id = ?').run(id);
        db.prepare(
          "DELETE FROM conversation_participants WHERE participant_kind = 'bot' AND participant_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE type = 'group')"
        ).run(id);
        db.prepare('DELETE FROM memories WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM one_shots WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM routines WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM pending_questions WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM approval_requests WHERE bot_id = ?').run(id);
        db.prepare('DELETE FROM wake_targets WHERE target_bot_id = ?').run(id);
        db.prepare('DELETE FROM bots WHERE id = ?').run(id);
        options?.onAgentDeleted?.(id);
      }
      return preview;
    })();
  },

  // Manage agents: every agent (hidden included) with created date, last
  // message activity, and whether a queue row is pending/processing.
  managementRows: (): ManagementRow[] => {
    const all = db.prepare('SELECT * FROM bots ORDER BY created_at DESC, id ASC').all() as Bot[];
    const activeIds = new Set(activeBotIds());
    const last = new Map<string, number>();
    const bump = (rows: { id: string | null; at: number | null }[]) => {
      for (const row of rows) {
        if (!row.id || !row.at) continue;
        if ((last.get(row.id) ?? 0) < row.at) last.set(row.id, row.at);
      }
    };
    bump(db.prepare(
      "SELECT c.bot_id AS id, MAX(m.created_at) AS at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'bot' GROUP BY c.bot_id"
    ).all() as { id: string | null; at: number | null }[]);
    bump(db.prepare(
      "SELECT sender_id AS id, MAX(created_at) AS at FROM messages WHERE sender_type = 'bot' AND sender_id IS NOT NULL GROUP BY sender_id"
    ).all() as { id: string | null; at: number | null }[]);
    return all.map(bot => ({
      bot,
      last_activity: last.get(bot.id) ?? null,
      blocked: isChiefOfStaffName(bot.name) ? 'chief' : activeIds.has(bot.id) ? 'active' : null,
    }));
  },
};

export interface ManagementRow {
  bot: Bot;
  last_activity: number | null;
  blocked: DeleteBlocked['reason'] | null;
}

export class BotDeletionError extends Error {
  preview: DeletePreview;
  constructor(preview: DeletePreview) {
    super(preview.missing.length > 0 ? 'Agent not found' : 'Some agents cannot be deleted');
    this.preview = preview;
  }
}

function activeBotIds(): string[] {
  return (db.prepare(
    "SELECT DISTINCT bot_id FROM processing_queue WHERE status IN ('pending', 'processing')"
  ).all() as { bot_id: string }[]).map(row => row.bot_id);
}

// Groups touched by deleting `selected`: fewer than two remaining members
// removes the group; a deleted owner passes to the remaining member with
// the earliest created_at, ties broken by id.
function groupImpacts(selected: Set<string>): DeleteGroupImpact[] {
  if (selected.size === 0) return [];
  const touched = db.prepare(
    `SELECT DISTINCT g.id, g.name, g.owner_bot_id, g.created_at FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.bot_id IN (${[...selected].map(() => '?').join(', ')})
     ORDER BY g.created_at ASC, g.id ASC`
  ).all(...selected) as Group[];
  return touched.map(group => {
    const remaining = (db.prepare(
      `SELECT b.id, b.name FROM bots b JOIN group_members gm ON gm.bot_id = b.id
       WHERE gm.group_id = ? ORDER BY b.created_at ASC, b.id ASC`
    ).all(group.id) as DeleteAgentRef[]).filter(member => !selected.has(member.id));
    if (remaining.length < 2) {
      return { id: group.id, name: group.name, outcome: 'removed', remaining: remaining.length, newOwner: null };
    }
    if (group.owner_bot_id && selected.has(group.owner_bot_id)) {
      return { id: group.id, name: group.name, outcome: 'reassigned', remaining: remaining.length, newOwner: remaining[0] };
    }
    return { id: group.id, name: group.name, outcome: 'shrunk', remaining: remaining.length, newOwner: null };
  });
}

function deleteConversationRecords(conversationId: string): void {
  deleteEngineRecordsForConversation(db, conversationId);
  db.prepare('DELETE FROM draft_actions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(conversationId);
  db.prepare('DELETE FROM agent_request_events WHERE request_id IN (SELECT id FROM agent_requests WHERE conversation_id = ?)').run(conversationId);
  db.prepare('DELETE FROM agent_requests WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM processing_queue WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM pending_questions WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM approvals WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM approval_requests WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM one_shots WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM routines WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM wake_targets WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
}

function deleteGroupRecords(groupId: string): void {
  const owned = db.prepare('SELECT id FROM conversations WHERE group_id = ?').all(groupId) as { id: string }[];
  for (const conversation of owned) deleteConversationRecords(conversation.id);
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
}

export const groups = {
  create: (name: string, botIds: string[], ownerId?: string, overrides?: { created_at?: number }): Group => {
    const owner = ownerId && botIds.includes(ownerId) ? ownerId : botIds[0];
    const group: Group = {
      id: randomUUID(),
      name,
      owner_bot_id: owner,
      created_at: overrides?.created_at ?? Date.now(),
    };
    
    const insertGroup = db.prepare(
      'INSERT INTO groups (id, name, owner_bot_id, created_at) VALUES (?, ?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO group_members (group_id, bot_id) VALUES (?, ?)'
    );
    const insertConversation = db.prepare(
      'INSERT INTO conversations (id, type, group_id, created_at) VALUES (?, ?, ?, ?)'
    );
    
    db.transaction(() => {
      insertGroup.run(group.id, group.name, group.owner_bot_id || null, group.created_at);
      for (const botId of botIds) {
        insertMember.run(group.id, botId);
      }
      const conversationId = randomUUID();
      insertConversation.run(conversationId, 'group', group.id, group.created_at);
      bindUiConversation(conversationId, botIds, group.created_at);
    })();
    
    return group;
  },
  
  getAll: (): Group[] => {
    return db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all() as Group[];
  },

  getById: (id: string): Group | undefined => {
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Group | undefined;
  },

  rename: (id: string, name: string): void => {
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
  },

  getMembers: (groupId: string): Bot[] => {
    return db.prepare(`
      SELECT b.* FROM bots b
      JOIN group_members gm ON b.id = gm.bot_id
      WHERE gm.group_id = ?
    `).all(groupId) as Bot[];
  },
};

export const conversations = {
  getByBotId: (botId: string): Conversation | undefined => {
    return db.prepare('SELECT * FROM conversations WHERE bot_id = ?').get(botId) as Conversation | undefined;
  },
  
  getByGroupId: (groupId: string): Conversation | undefined => {
    return db.prepare('SELECT * FROM conversations WHERE group_id = ?').get(groupId) as Conversation | undefined;
  },
  
  getById: (id: string): Conversation | undefined => {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
  },

  // Unauthenticated UI routes must not reach 'agent' conversations; those are
  // only readable and writable through the authenticated agent API.
  getUiById: (id: string): Conversation | undefined => {
    return db.prepare("SELECT * FROM conversations WHERE id = ? AND type != 'agent'").get(id) as Conversation | undefined;
  },
};

export const messages = {
  create: (conversationId: string, senderType: 'user' | 'bot', content: string, senderId?: string, handoffTargets?: string[]): Message => {
    const message: Message = {
      id: randomUUID(),
      conversation_id: conversationId,
      sender_type: senderType,
      sender_id: senderId,
      sender_kind: senderType === 'bot' ? 'bot' : UI_OWNER_PRINCIPAL.kind,
      content,
      handoff_targets: handoffTargets && handoffTargets.length > 0 ? JSON.stringify(handoffTargets) : null,
      created_at: Date.now(),
    };
    
    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, content, handoff_targets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      message.id,
      message.conversation_id,
      message.sender_type,
      message.sender_id || null,
      message.sender_kind,
      message.content,
      message.handoff_targets || null,
      message.created_at
    );

    if (senderType === 'bot') {
      if (senderId) bots.markUnread(senderId);
      const owner = db.prepare(
        'SELECT bot_id FROM conversations WHERE id = ? AND type = ?'
      ).get(conversationId, 'bot') as { bot_id: string | null } | undefined;
      if (owner?.bot_id && owner.bot_id !== senderId) bots.markUnread(owner.bot_id);
    }

    return message;
  },

  getById: (id: string): Message | undefined => {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  },

  replaceContent: (id: string, content: string): void => {
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  },
  
  getByConversation: (conversationId: string): Message[] => {
    return db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as Message[];
  },

  // Messages strictly between two anchors in the same thread, in thread
  // order. Either anchor may come first. Null when an anchor is unknown or
  // the anchors sit in different conversations.
  getBetween: (idA: string, idB: string): Message[] | null => {
    const a = messages.getById(idA);
    const b = messages.getById(idB);
    if (!a || !b) return null;
    if (a.conversation_id !== b.conversation_id) return null;
    const all = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(a.conversation_id) as Message[];
    const indexA = all.findIndex(message => message.id === idA);
    const indexB = all.findIndex(message => message.id === idB);
    if (indexA < 0 || indexB < 0) return null;
    const [low, high] = indexA < indexB ? [indexA, indexB] : [indexB, indexA];
    return all.slice(low + 1, high);
  },

  latestFromBot: (botId: string): string => {
    const own = conversations.getByBotId(botId);
    const rows = db.prepare(
      `SELECT content, conversation_id, created_at FROM messages
       WHERE sender_type = 'bot' AND sender_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 20`
    ).all(botId) as { content: string; conversation_id: string; created_at: number }[];
    for (const row of rows) {
      if (own && row.conversation_id !== own.id) continue;
      const prior = db.prepare(
        `SELECT content FROM messages
         WHERE conversation_id = ? AND created_at < ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      ).get(row.conversation_id, row.created_at) as { content: string } | undefined;
      if (prior && prior.content.startsWith('[From ')) continue;
      return row.content;
    }
    return '';
  },

  // Prior bot sentence from the source thread of an @-handoff (not the mention text).
  priorSentenceForHandoff: (msg: Message): string | null => {
    if (!msg.handoff_targets) return null;
    let targetIds: string[] = [];
    try {
      const parsed = JSON.parse(msg.handoff_targets);
      if (!Array.isArray(parsed)) return null;
      targetIds = parsed.map(id => String(id));
    } catch {
      return null;
    }

    const rows = db.prepare(`
      SELECT m.conversation_id AS conversation_id, c.type AS type, c.bot_id AS bot_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content = ? AND m.handoff_targets = ?
      ORDER BY m.created_at ASC
    `).all(msg.content, msg.handoff_targets) as Array<{
      conversation_id: string;
      type: string;
      bot_id: string | null;
    }>;

    const sourceRow = rows.find(
      row => row.type === 'group' || !row.bot_id || !targetIds.includes(row.bot_id)
    );
    const sourceId = sourceRow?.conversation_id || msg.conversation_id;
    const sourceMessages = messages.getByConversation(sourceId);

    const handoffInSource = [...sourceMessages].reverse().find(
      m =>
        m.sender_type === 'user' &&
        m.content === msg.content &&
        m.handoff_targets === msg.handoff_targets
    );
    const before = handoffInSource ? handoffInSource.created_at : msg.created_at;

    for (let i = sourceMessages.length - 1; i >= 0; i--) {
      const m = sourceMessages[i];
      if (handoffInSource && m.id === handoffInSource.id) continue;
      if (m.created_at > before) continue;
      if (m.sender_type !== 'bot') continue;
      const text = (m.content || '').trim();
      if (!text) continue;
      return text;
    }
    return null;
  },
};

export type DraftActionStatus = 'sent' | 'discarded';

export interface DraftAction {
  message_id: string;
  status: DraftActionStatus;
  recipient?: string | null;
  acted_at: number;
}

// One-shot draft state. A draft message is open while it has no row here;
// Send or Discard inserts exactly one row, so a card can never fire twice.
export const draftActions = {
  get: (messageId: string): DraftAction | undefined => {
    return db.prepare('SELECT * FROM draft_actions WHERE message_id = ?').get(messageId) as DraftAction | undefined;
  },

  // Returns false when the draft was already acted on.
  record: (messageId: string, status: DraftActionStatus, recipient?: string): boolean => {
    const result = db.prepare(
      'INSERT OR IGNORE INTO draft_actions (message_id, status, recipient, acted_at) VALUES (?, ?, ?, ?)'
    ).run(messageId, status, recipient || null, Date.now());
    return Number(result.changes) > 0;
  },
};

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  conversation_id: string;
  code: string;
  message_id?: string | null;
  status: ApprovalStatus;
  created_at: number;
  resolved_at?: number | null;
}

export const approvals = {
  get: (conversationId: string, code: string): Approval | undefined => {
    return db.prepare(
      'SELECT * FROM approvals WHERE conversation_id = ? AND code = ?'
    ).get(conversationId, code) as Approval | undefined;
  },

  recordPending: (conversationId: string, code: string, messageId?: string): Approval => {
    db.prepare(
      'INSERT OR IGNORE INTO approvals (conversation_id, code, message_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(conversationId, code, messageId || null, 'pending', Date.now());
    return approvals.get(conversationId, code) as Approval;
  },

  // Returns false when the code was already resolved.
  resolve: (conversationId: string, code: string, status: 'approved' | 'denied'): boolean => {
    const result = db.prepare(
      "UPDATE approvals SET status = ?, resolved_at = ? WHERE conversation_id = ? AND code = ? AND status = 'pending'"
    ).run(status, Date.now(), conversationId, code);
    return Number(result.changes) > 0;
  },
};

export const queue = {
  getById: (id: string): QueueItem | undefined => {
    return db.prepare('SELECT * FROM processing_queue WHERE id = ?').get(id) as QueueItem | undefined;
  },

  listByConversation: (conversationId: string): QueueItem[] => {
    return db.prepare(
      'SELECT * FROM processing_queue WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as QueueItem[];
  },

  enqueue: (conversationId: string, botId: string): QueueItem => {
    const item: QueueItem = {
      id: randomUUID(),
      conversation_id: conversationId,
      bot_id: botId,
      status: 'pending',
      created_at: Date.now(),
    };
    
    db.prepare(
      'INSERT INTO processing_queue (id, conversation_id, bot_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(item.id, item.conversation_id, item.bot_id, item.status, item.created_at);
    
    return item;
  },
  
  getNext: (): QueueItem | undefined => {
    return db.prepare(
      'SELECT * FROM processing_queue WHERE status = ? ORDER BY created_at ASC LIMIT 1'
    ).get('pending') as QueueItem | undefined;
  },
  
  markProcessing: (id: string): void => {
    db.prepare(
      'UPDATE processing_queue SET status = ?, started_at = ? WHERE id = ?'
    ).run('processing', Date.now(), id);
  },
  
  markCompleted: (id: string, status: 'completed' | 'failed'): void => {
    db.prepare(
      'UPDATE processing_queue SET status = ?, completed_at = ? WHERE id = ?'
    ).run(status, Date.now(), id);
  },

  cancelPending: (conversationId: string): number => {
    const result = db.prepare(
      "DELETE FROM processing_queue WHERE conversation_id = ? AND status = 'pending'"
    ).run(conversationId);
    return Number(result.changes);
  },

  cancelPendingForBot: (botId: string): void => {
    db.prepare(
      "DELETE FROM processing_queue WHERE bot_id = ? AND status = 'pending'"
    ).run(botId);
  },

  countPending: (conversationId?: string): number => {
    const row = conversationId
      ? (db.prepare(
          "SELECT COUNT(*) AS n FROM processing_queue WHERE status = 'pending' AND conversation_id = ?"
        ).get(conversationId) as { n: number })
      : (db.prepare(
          "SELECT COUNT(*) AS n FROM processing_queue WHERE status = 'pending'"
        ).get() as { n: number });
    return row.n;
  },
};

export interface LaunchSnapshot {
  id: string;
  bot_id: string;
  created_at: number;
  hash: string;
  snapshot: string;
  transport: string;
}

export const launchSnapshots = {
  record: (id: string, botId: string, hash: string, snapshot: string, transport = 'hermes-gateway'): void => {
    db.prepare(
      'INSERT OR IGNORE INTO launch_snapshots (id, bot_id, created_at, hash, snapshot, transport) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, botId, Date.now(), hash, snapshot, transport);
  },

  listByBot: (botId: string): LaunchSnapshot[] => {
    return db.prepare(
      'SELECT * FROM launch_snapshots WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC'
    ).all(botId) as LaunchSnapshot[];
  },
};

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string;
  created_at: number;
}

export const mcpServers = {
  create: (name: string, command: string, args: string[]): McpServer => {
    const row: McpServer = {
      id: randomUUID(),
      name,
      command,
      args: JSON.stringify(args),
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO mcp_servers (id, name, command, args, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(row.id, row.name, row.command, row.args, row.created_at);
    return row;
  },

  list: (): McpServer[] => {
    return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as McpServer[];
  },
};

export interface Memory {
  id: string;
  bot_id: string;
  fact: string;
  created_at: number;
}

const MEMORY_CAP = 20;

function isBareQuestion(text: string): boolean {
  if (/^(who|what|when|where|why|how|which|whose|whom)\b/i.test(text)) {
    if (/^(what|how|why|where|when|who)\s+i\b/i.test(text)) return false;
    return true;
  }
  if (/^(do|does|did|can|could|would|will|should|shall|is|are|am|was|were|have|has)\s+(you|i|we|they|he|she|it|there|the|a|an|my|your|our)\b/i.test(text)) {
    return true;
  }
  if (/^(tell me|please tell)\b/i.test(text)) return true;
  return false;
}

export function isRememberableStatement(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/[?？]\s*$/.test(text)) return false;
  if (/^\[mcp\]/i.test(text)) return false;
  if (/^\[tool (?:call|result)\]/i.test(text)) return false;
  if (/^\[Handing off to\b/i.test(text)) return false;
  if (/^\[From [^\]]+\]/i.test(text)) return false;
  if (/^Peer handoff:/i.test(text)) return false;
  if (/reply with exactly\b/i.test(text)) return false;
  if (isBareQuestion(text)) return false;
  return true;
}

export const memories = {
  rememberStatement: (botId: string, content: string): void => {
    if (!botId || !isRememberableStatement(content)) return;
    const fact = content.trim();
    db.prepare(
      'INSERT INTO memories (id, bot_id, fact, created_at) VALUES (?, ?, ?, ?)'
    ).run(randomUUID(), botId, fact, Date.now());
    db.prepare(`
      DELETE FROM memories
      WHERE bot_id = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM memories
            WHERE bot_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
          )
        )
    `).run(botId, botId, MEMORY_CAP);
  },

  latestFacts: (botId: string, limit: number = MEMORY_CAP): string[] => {
    const cap = limit > 0 ? Math.min(limit, MEMORY_CAP) : MEMORY_CAP;
    const rows = db.prepare(
      'SELECT fact FROM memories WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(botId, cap) as { fact: string }[];
    return rows.map(row => row.fact).reverse();
  },
};

export interface OneShot {
  id: string;
  conversation_id: string;
  bot_id: string;
  due_at: number;
  fired: number;
  created_at: number;
}

export const oneShots = {
  create: (conversationId: string, botId: string, dueAt: number): OneShot => {
    const row: OneShot = {
      id: randomUUID(),
      conversation_id: conversationId,
      bot_id: botId,
      due_at: dueAt,
      fired: 0,
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO one_shots (id, conversation_id, bot_id, due_at, fired, created_at) VALUES (?, ?, ?, ?, 0, ?)'
    ).run(row.id, row.conversation_id, row.bot_id, row.due_at, row.created_at);
    return row;
  },

  pending: (conversationId: string): OneShot | undefined => {
    return db.prepare(
      'SELECT * FROM one_shots WHERE conversation_id = ? AND fired = 0 ORDER BY due_at ASC LIMIT 1'
    ).get(conversationId) as OneShot | undefined;
  },

  unfired: (): OneShot[] => {
    return db.prepare(
      'SELECT * FROM one_shots WHERE fired = 0 ORDER BY due_at ASC'
    ).all() as OneShot[];
  },

  claim: (id: string): boolean => {
    const result = db.prepare(
      'UPDATE one_shots SET fired = 1 WHERE id = ? AND fired = 0'
    ).run(id);
    return result.changes === 1;
  },
};

export interface Routine {
  id: string;
  conversation_id: string;
  bot_id: string;
  word: string;
  next_due_at: number;
  every_ms: number;
  created_at: number;
}

export const routines = {
  create: (conversationId: string, botId: string, word: string, nextDueAt: number, everyMs: number): Routine => {
    const row: Routine = {
      id: randomUUID(),
      conversation_id: conversationId,
      bot_id: botId,
      word,
      next_due_at: nextDueAt,
      every_ms: everyMs,
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO routines (id, conversation_id, bot_id, word, next_due_at, every_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(row.id, row.conversation_id, row.bot_id, row.word, row.next_due_at, row.every_ms, row.created_at);
    return row;
  },

  forConversation: (conversationId: string): Routine | undefined => {
    return db.prepare(
      'SELECT * FROM routines WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(conversationId) as Routine | undefined;
  },

  all: (): Routine[] => {
    return db.prepare(
      'SELECT * FROM routines ORDER BY next_due_at ASC'
    ).all() as Routine[];
  },

  postIfDue: (id: string, now: number): boolean => {
    const run = db.transaction(() => {
      const row = db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined;
      if (!row || row.next_due_at > now) return false;
      const advanced = db.prepare(
        'UPDATE routines SET next_due_at = next_due_at + every_ms WHERE id = ? AND next_due_at = ?'
      ).run(id, row.next_due_at);
      if (advanced.changes !== 1) return false;
      messages.create(row.conversation_id, 'bot', '[routine]\n' + row.word, row.bot_id);
      return true;
    });
    return run();
  },
};

// NOT-478: accepted Wake targets. A Wake names its target by display
// name; acceptance resolves that name through the unique key to exactly
// one stable Agent ID and stores the ID plus the display-name snapshot
// used at acceptance. Later renames never touch these rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS wake_targets (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    source_bot_id TEXT,
    source_message_id TEXT,
    requested_target TEXT NOT NULL,
    target_bot_id TEXT NOT NULL,
    target_name_snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (target_bot_id) REFERENCES bots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_wake_targets_conversation
    ON wake_targets(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_wake_targets_target
    ON wake_targets(target_bot_id, created_at);
`);

export type WakeTargetResolution =
  | { ok: true; agentId: string; displayName: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; requested: string };

// Exactly one Agent or a failure. 'ambiguous' cannot happen while the
// unique index holds; it is reported as a data-integrity error rather
// than silently picking a first match.
export function resolveWakeTarget(name: string): WakeTargetResolution {
  const key = agentNameKey(name);
  if (!key) return { ok: false, reason: 'not_found', requested: String(name ?? '') };
  const rows = db.prepare('SELECT id, name FROM bots WHERE name_key = ? LIMIT 2').all(key) as { id: string; name: string }[];
  if (rows.length === 0) return { ok: false, reason: 'not_found', requested: name };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous', requested: name };
  return { ok: true, agentId: rows[0].id, displayName: rows[0].name };
}

export interface WakeTarget {
  id: string;
  conversation_id: string;
  source_bot_id: string | null;
  source_message_id: string | null;
  requested_target: string;
  target_bot_id: string;
  target_name_snapshot: string;
  created_at: number;
}

export const wakeTargets = {
  // Resolve and persist in one step. Returns the stored row, or the
  // resolution failure when the name does not identify exactly one Agent.
  accept: (args: {
    conversationId: string;
    requestedTarget: string;
    sourceBotId?: string | null;
    sourceMessageId?: string | null;
  }): { ok: true; wake: WakeTarget } | Extract<WakeTargetResolution, { ok: false }> => {
    const resolved = resolveWakeTarget(args.requestedTarget);
    if (!resolved.ok) return resolved;
    const wake: WakeTarget = {
      id: randomUUID(),
      conversation_id: args.conversationId,
      source_bot_id: args.sourceBotId ?? null,
      source_message_id: args.sourceMessageId ?? null,
      requested_target: args.requestedTarget,
      target_bot_id: resolved.agentId,
      target_name_snapshot: resolved.displayName,
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO wake_targets (id, conversation_id, source_bot_id, source_message_id, requested_target, target_bot_id, target_name_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(wake.id, wake.conversation_id, wake.source_bot_id, wake.source_message_id, wake.requested_target, wake.target_bot_id, wake.target_name_snapshot, wake.created_at);
    return { ok: true, wake };
  },

  listByConversation: (conversationId: string): WakeTarget[] => {
    return db.prepare(
      'SELECT * FROM wake_targets WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(conversationId) as WakeTarget[];
  },
};

export interface AgentNameMigration {
  id: string;
  bot_id: string;
  previous_name: string;
  new_name: string;
  name_key: string;
  kept_bot_id: string;
  reason: string;
  created_at: number;
}

// Durable owner-visible report of automatic duplicate-name renames.
export const agentNameMigrations = {
  list: (): AgentNameMigration[] => {
    return db.prepare('SELECT * FROM agent_name_migrations ORDER BY created_at ASC, rowid ASC').all() as AgentNameMigration[];
  },
};

// NOT-443: single workspace-level settings store. One row per key; the
// Agent Deck server URL is the only key so far.
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export const workspaceSettings = {
  get: (key: string): string | null => {
    const row = db.prepare('SELECT value FROM workspace_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  },

  set: (key: string, value: string): void => {
    db.prepare(
      'INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  },

  clearForTests: (): void => {
    db.prepare('DELETE FROM workspace_settings').run();
  },
};

export default db;
