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
`);

export interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar?: string;
  created_at: number;
}

export interface Group {
  id: string;
  name: string;
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
  create: (data: Omit<Bot, 'id' | 'created_at'>): Bot => {
    const bot: Bot = {
      id: randomUUID(),
      ...data,
      created_at: Date.now(),
    };
    db.prepare(
      'INSERT INTO bots (id, name, title, description, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bot.id, bot.name, bot.title, bot.description, bot.avatar || null, bot.created_at);
    
    const conversationId = randomUUID();
    db.prepare(
      'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, 'bot', bot.id, bot.created_at);
    
    return bot;
  },
  
  getAll: (): Bot[] => {
    return db.prepare('SELECT * FROM bots ORDER BY created_at DESC').all() as Bot[];
  },
  
  getById: (id: string): Bot | undefined => {
    return db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as Bot | undefined;
  },
};

export const groups = {
  create: (name: string, botIds: string[]): Group => {
    const group: Group = {
      id: randomUUID(),
      name,
      created_at: Date.now(),
    };
    
    const insertGroup = db.prepare(
      'INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO group_members (group_id, bot_id) VALUES (?, ?)'
    );
    const insertConversation = db.prepare(
      'INSERT INTO conversations (id, type, group_id, created_at) VALUES (?, ?, ?, ?)'
    );
    
    db.transaction(() => {
      insertGroup.run(group.id, group.name, group.created_at);
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
  create: (conversationId: string, senderType: 'user' | 'bot', content: string, senderId?: string): Message => {
    const message: Message = {
      id: randomUUID(),
      conversation_id: conversationId,
      sender_type: senderType,
      sender_id: senderId,
      content,
      created_at: Date.now(),
    };
    
    db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(message.id, message.conversation_id, message.sender_type, message.sender_id || null, message.content, message.created_at);
    
    return message;
  },
  
  getByConversation: (conversationId: string): Message[] => {
    return db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as Message[];
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

export default db;
