import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const db = new Database('botmancers.db');
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

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_queue_status ON processing_queue(status, created_at);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
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
  created_at: number;
  source_provider?: string | null;
  template_id?: string | null;
  template_url?: string | null;
  import_schema_version?: string | null;
  import_operation_id?: string | null;
  import_timestamp?: number | null;
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
  create: (data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned'>): Bot => {
    const bot: Bot = {
      id: randomUUID(),
      ...data,
      color: nextBotColor(),
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO bots (id, name, title, description, avatar, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(bot.id, bot.name, bot.title, bot.description, bot.avatar || null, bot.color, bot.created_at);
    
    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    
    return bot;
  },

  createFromImport: (
    data: Omit<Bot, 'id' | 'created_at' | 'color' | 'pinned' | 'source_provider' | 'template_id' | 'template_url' | 'import_schema_version' | 'import_operation_id' | 'import_timestamp'>,
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

  remove: (id: string): void => {
    const conversations = db.prepare('SELECT id FROM conversations WHERE bot_id = ?').all(id) as { id: string }[];
    db.transaction(() => {
      for (const conversation of conversations) {
        db.prepare('DELETE FROM processing_queue WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation.id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
      }
      db.prepare('DELETE FROM processing_queue WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM group_members WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    })();
  },
};

export const groups = {
  create: (name: string, botIds: string[], ownerId?: string): Group => {
    const owner = ownerId && botIds.includes(ownerId) ? ownerId : botIds[0];
    const group: Group = {
      id: randomUUID(),
      name,
      owner_bot_id: owner,
      created_at: Date.now(),
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
    
    return message;
  },
  
  getByConversation: (conversationId: string): Message[] => {
    return db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as Message[];
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

export const queue = {
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

export default db;
