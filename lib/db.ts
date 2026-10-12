import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

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

function nextBotColor(): string {
  const row = db.prepare('SELECT COUNT(*) AS n FROM bots').get() as { n: number };
  return BOT_COLORS[row.n % BOT_COLORS.length];
}

export interface Bot {
  id: string;
  name: string;
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

// Transport that served a launch ('openai' or 'hermes-gateway'). Outside the
// hashed snapshot input: it records how the turn ran, not the effective
// configuration, so backfilled rows read 'openai'.
const snapshotColumns = db.prepare('PRAGMA table_info(launch_snapshots)').all() as { name: string }[];
if (!snapshotColumns.some(column => column.name === 'transport')) {
  db.exec("ALTER TABLE launch_snapshots ADD COLUMN transport TEXT NOT NULL DEFAULT 'openai'");
}

export interface Group {
  id: string;
  name: string;
  owner_bot_id?: string | null;
  created_at: number;
}

export interface Conversation {
  id: string;
  type: 'bot' | 'group';
  bot_id?: string;
  group_id?: string;
  created_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: 'user' | 'bot';
  sender_id?: string;
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
  create: (data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned'>, overrides?: { id?: string; created_at?: number }): Bot => {
    const bot: Bot = {
      id: overrides?.id || randomUUID(),
      ...data,
      color: nextBotColor(),
      created_at: overrides?.created_at ?? Date.now(),
    };
    db.prepare(
      'INSERT INTO bots (id, name, title, description, avatar, color, hermes_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(bot.id, bot.name, bot.title, bot.description, bot.avatar || null, bot.color, bot.hermes_profile || null, bot.created_at);
    
    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    
    return bot;
  },

  createFromImport: (
    data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned' | 'hidden' | 'last_seen' | 'unread' | 'source_provider' | 'template_id' | 'template_url' | 'import_schema_version' | 'import_operation_id' | 'import_timestamp' | 'hermes_profile'>,
    provenance: ImportProvenance
  ): Bot => {
    const bot: Bot = {
      id: randomUUID(),
      ...data,
      color: nextBotColor(),
      created_at: Date.now(),
      source_provider: provenance.source_provider,
      template_id: provenance.template_id,
      template_url: provenance.template_url,
      import_schema_version: provenance.import_schema_version,
      import_operation_id: provenance.import_operation_id,
      import_timestamp: provenance.import_timestamp,
    };
    db.prepare(
      `INSERT INTO bots (
        id, name, title, description, avatar, color, created_at,
        source_provider, template_id, template_url, import_schema_version,
        import_operation_id, import_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bot.id, bot.name, bot.title, bot.description, bot.avatar || null, bot.color, bot.created_at,
      bot.source_provider, bot.template_id, bot.template_url, bot.import_schema_version,
      bot.import_operation_id, bot.import_timestamp
    );
    
    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    
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

  updateIdentity: (id: string, name: string, title: string, description: string): void => {
    db.prepare('UPDATE bots SET name = ?, title = ?, description = ? WHERE id = ?').run(name, title, description, id);
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
    const conversations = db.prepare('SELECT id FROM conversations WHERE bot_id = ?').all(id) as { id: string }[];
    db.transaction(() => {
      for (const conversation of conversations) {
        db.prepare('DELETE FROM processing_queue WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM pending_questions WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM approval_requests WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
      }
      db.prepare('DELETE FROM processing_queue WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM launch_snapshots WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM group_members WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM memories WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM one_shots WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM routines WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM pending_questions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    })();
  },
};

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
      insertConversation.run(randomUUID(), 'group', group.id, group.created_at);
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
};

export const messages = {
  create: (conversationId: string, senderType: 'user' | 'bot', content: string, senderId?: string, handoffTargets?: string[]): Message => {
    const message: Message = {
      id: randomUUID(),
      conversation_id: conversationId,
      sender_type: senderType,
      sender_id: senderId,
      content,
      handoff_targets: handoffTargets && handoffTargets.length > 0 ? JSON.stringify(handoffTargets) : null,
      created_at: Date.now(),
    };
    
    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, handoff_targets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      message.id,
      message.conversation_id,
      message.sender_type,
      message.sender_id || null,
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
  record: (id: string, botId: string, hash: string, snapshot: string, transport = 'openai'): void => {
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

export default db;
