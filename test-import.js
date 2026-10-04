#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 43123;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = 'botmancers-test-migration.db';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function createPreChangeDatabaseFixture() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      color TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      owner_bot_id TEXT
    );

    CREATE TABLE group_members (
      group_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      PRIMARY KEY (group_id, bot_id),
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (bot_id) REFERENCES bots(id)
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      bot_id TEXT,
      group_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (bot_id) REFERENCES bots(id),
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      handoff_targets TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE TABLE processing_queue (
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
  `);

  const now = Date.now();
  const botId = 'test-bot-1';
  const conversationId = 'test-conv-1';
  const groupId = 'test-group-1';
  const groupConvId = 'test-group-conv-1';
  const messageId = 'test-msg-1';
  const queueId = 'test-queue-1';

  db.prepare(
    'INSERT INTO bots (id, name, title, description, avatar, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(botId, 'TestBot', 'Test Bot', 'A test bot', null, '#C6F54A', now);

  db.prepare(
    'INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(conversationId, 'bot', botId, now);

  db.prepare(
    'INSERT INTO groups (id, name, owner_bot_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(groupId, 'Test Group', botId, now);

  db.prepare(
    'INSERT INTO group_members (group_id, bot_id) VALUES (?, ?)'
  ).run(groupId, botId);

  db.prepare(
    'INSERT INTO conversations (id, type, group_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(groupConvId, 'group', groupId, now);

  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(messageId, conversationId, 'user', null, 'Test message', now);

  db.prepare(
    'INSERT INTO processing_queue (id, conversation_id, bot_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(queueId, conversationId, botId, 'pending', now);

  db.close();

  console.log(`✓ Created pre-change fixture database: ${TEST_DB_PATH}`);
  console.log(`  - 1 bot, 1 group, 2 conversations, 1 message, 1 queue item\n`);
}

function testMigration() {
  console.log('TEST: Database migration preserves existing data\n');

  if (!fs.existsSync(TEST_DB_PATH)) {
    console.log('❌ Test database not found. Run createPreChangeDatabaseFixture first.\n');
    return false;
  }

  const db = new Database(TEST_DB_PATH);

  const botColumns = db.prepare('PRAGMA table_info(bots)').all();
  if (!botColumns.some(col => col.name === 'source_provider')) {
    db.exec('ALTER TABLE bots ADD COLUMN source_provider TEXT');
  }
  if (!botColumns.some(col => col.name === 'template_id')) {
    db.exec('ALTER TABLE bots ADD COLUMN template_id TEXT');
  }
  if (!botColumns.some(col => col.name === 'template_url')) {
    db.exec('ALTER TABLE bots ADD COLUMN template_url TEXT');
  }
  if (!botColumns.some(col => col.name === 'import_schema_version')) {
    db.exec('ALTER TABLE bots ADD COLUMN import_schema_version TEXT');
  }
  if (!botColumns.some(col => col.name === 'import_operation_id')) {
    db.exec('ALTER TABLE bots ADD COLUMN import_operation_id TEXT');
  }
  if (!botColumns.some(col => col.name === 'import_timestamp')) {
    db.exec('ALTER TABLE bots ADD COLUMN import_timestamp INTEGER');
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_import_operation 
    ON bots(import_operation_id) WHERE import_operation_id IS NOT NULL
  `);

  console.log('✓ Ran migration SQL\n');

  const bots = db.prepare('SELECT COUNT(*) as count FROM bots').get();
  const groups = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  const conversations = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const queue = db.prepare('SELECT COUNT(*) as count FROM processing_queue').get();

  console.log('Data preservation check:');
  console.log(`  Bots:         ${bots.count} (expected 1)`);
  console.log(`  Groups:       ${groups.count} (expected 1)`);
  console.log(`  Conversations: ${conversations.count} (expected 2)`);
  console.log(`  Messages:     ${messages.count} (expected 1)`);
  console.log(`  Queue items:  ${queue.count} (expected 1)\n`);

  const columnsAfter = db.prepare('PRAGMA table_info(bots)').all();
  const newColumns = columnsAfter.filter(col => 
    ['source_provider', 'template_id', 'template_url', 'import_schema_version', 
     'import_operation_id', 'import_timestamp'].includes(col.name)
  );

  console.log('New columns added:');
  newColumns.forEach(col => {
    console.log(`  - ${col.name} (${col.type || 'TEXT'})`);
  });
  console.log();

  db.close();

  const pass = bots.count === 1 && groups.count === 1 && conversations.count === 2 && 
               messages.count === 1 && queue.count === 1 && newColumns.length === 6;

  if (pass) {
    console.log('✅ Migration test PASSED\n');
  } else {
    console.log('❌ Migration test FAILED\n');
  }

  return pass;
}

async function testImportCapabilities() {
  console.log('TEST: GET /api/import-capabilities\n');

  const response = await request('GET', '/api/import-capabilities');

  console.log(`Status: ${response.status}`);
  console.log(`Response:\n${JSON.stringify(response.body, null, 2)}\n`);

  const expected = {
    schema_version: '1.0.0',
    supported: {
      identity: true,
      description: true,
      avatar: true,
      verification: true,
    },
    unsupported: {
      memories: true,
      skills: true,
      routines: true,
      integrations: true,
    },
  };

  const matches = JSON.stringify(response.body) === JSON.stringify(expected);

  if (matches && response.status === 200) {
    console.log('✅ Import capabilities test PASSED\n');
    return true;
  } else {
    console.log('❌ Import capabilities test FAILED\n');
    return false;
  }
}

async function testBotImport() {
  console.log('TEST: POST /api/bots/import creates bot with provenance\n');

  const importRequest = {
    schema_version: '1.0.0',
    operation_id: 'import-op-12345',
    source_provider: 'grok-marketplace',
    template_id: 'template-abc',
    template_url: 'https://example.com/template/abc',
    bot: {
      name: 'Imported Bot',
      title: 'Import Test Bot',
      description: 'This bot was imported for testing',
      avatar: 'data:image/png;base64,test',
    },
  };

  const response = await request('POST', '/api/bots/import', importRequest);

  console.log(`Status: ${response.status}`);
  console.log(`Response:\n${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 200 && response.body.created === true) {
    const bot = response.body.bot;
    const verification = response.body.verification;

    const checks = [
      { name: 'Bot created', pass: bot.id !== undefined },
      { name: 'Name matches', pass: bot.name === importRequest.bot.name },
      { name: 'Title matches', pass: bot.title === importRequest.bot.title },
      { name: 'Description matches', pass: bot.description === importRequest.bot.description },
      { name: 'Avatar matches', pass: bot.avatar === importRequest.bot.avatar },
      { name: 'Source provider set', pass: bot.source_provider === importRequest.source_provider },
      { name: 'Template ID set', pass: bot.template_id === importRequest.template_id },
      { name: 'Template URL set', pass: bot.template_url === importRequest.template_url },
      { name: 'Schema version set', pass: bot.import_schema_version === importRequest.schema_version },
      { name: 'Operation ID set', pass: bot.import_operation_id === importRequest.operation_id },
      { name: 'Import timestamp set', pass: bot.import_timestamp !== undefined && bot.import_timestamp !== null },
      { name: 'Verification matches', pass: verification.matches === true },
    ];

    console.log('Checks:');
    checks.forEach(check => {
      console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
    });
    console.log();

    if (checks.every(c => c.pass)) {
      console.log('✅ Bot import test PASSED\n');
      return { pass: true, botId: bot.id, operationId: importRequest.operation_id };
    }
  }

  console.log('❌ Bot import test FAILED\n');
  return { pass: false };
}

async function testIdempotency(operationId) {
  console.log('TEST: Idempotency - same operation_id + same body returns same bot\n');

  const importRequest = {
    schema_version: '1.0.0',
    operation_id: operationId,
    source_provider: 'grok-marketplace',
    template_id: 'template-abc',
    template_url: 'https://example.com/template/abc',
    bot: {
      name: 'Imported Bot',
      title: 'Import Test Bot',
      description: 'This bot was imported for testing',
      avatar: 'data:image/png;base64,test',
    },
  };

  const response = await request('POST', '/api/bots/import', importRequest);

  console.log(`Status: ${response.status}`);
  console.log(`Created: ${response.body.created}`);
  console.log(`Bot ID: ${response.body.bot?.id}\n`);

  if (response.status === 200 && response.body.created === false) {
    console.log('✅ Idempotency test PASSED\n');
    return true;
  } else {
    console.log('❌ Idempotency test FAILED\n');
    return false;
  }
}

async function testConflictDetection(operationId) {
  console.log('TEST: Conflict detection - same operation_id + different body returns 409\n');

  const importRequest = {
    schema_version: '1.0.0',
    operation_id: operationId,
    source_provider: 'grok-marketplace',
    template_id: 'template-abc',
    template_url: 'https://example.com/template/abc',
    bot: {
      name: 'Different Name',
      title: 'Different Title',
      description: 'Different description',
    },
  };

  const response = await request('POST', '/api/bots/import', importRequest);

  console.log(`Status: ${response.status}`);
  console.log(`Response:\n${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 409) {
    console.log('✅ Conflict detection test PASSED\n');
    return true;
  } else {
    console.log('❌ Conflict detection test FAILED\n');
    return false;
  }
}

async function testValidation() {
  console.log('TEST: Validation - raw Grok fields or unknown schema version returns 400\n');

  console.log('Test 1: Unknown schema version\n');
  const test1 = await request('POST', '/api/bots/import', {
    schema_version: '99.0.0',
    operation_id: 'test-validation-1',
    source_provider: 'grok-marketplace',
    template_id: 'template-xyz',
    template_url: 'https://example.com/template/xyz',
    bot: {
      name: 'Test Bot',
    },
  });

  console.log(`  Status: ${test1.status}`);
  console.log(`  Errors: ${JSON.stringify(test1.body.details)}\n`);

  const test1Pass = test1.status === 400 && 
    test1.body.details?.some(e => e.includes('Unknown schema version'));

  console.log(test1Pass ? '  ✓ Unknown schema version rejected\n' : '  ✗ Failed\n');

  console.log('Test 2: Raw Grok field (unsupported)\n');
  const test2 = await request('POST', '/api/bots/import', {
    schema_version: '1.0.0',
    operation_id: 'test-validation-2',
    source_provider: 'grok-marketplace',
    template_id: 'template-xyz',
    template_url: 'https://example.com/template/xyz',
    bot: {
      name: 'Test Bot',
      skills: ['skill1', 'skill2'],
    },
  });

  console.log(`  Status: ${test2.status}`);
  console.log(`  Errors: ${JSON.stringify(test2.body.details)}\n`);

  const test2Pass = test2.status === 400 && 
    test2.body.details?.some(e => e.includes('skills') && e.includes('not supported'));

  console.log(test2Pass ? '  ✓ Unsupported field rejected\n' : '  ✗ Failed\n');

  console.log('Test 3: Missing required field\n');
  const test3 = await request('POST', '/api/bots/import', {
    schema_version: '1.0.0',
    operation_id: 'test-validation-3',
    source_provider: 'grok-marketplace',
    template_id: 'template-xyz',
    template_url: 'https://example.com/template/xyz',
    bot: {},
  });

  console.log(`  Status: ${test3.status}`);
  console.log(`  Errors: ${JSON.stringify(test3.body.details)}\n`);

  const test3Pass = test3.status === 400 && 
    test3.body.details?.some(e => e.includes('bot.name') && e.includes('required'));

  console.log(test3Pass ? '  ✓ Missing field rejected\n' : '  ✗ Failed\n');

  if (test1Pass && test2Pass && test3Pass) {
    console.log('✅ Validation test PASSED\n');
    return true;
  } else {
    console.log('❌ Validation test FAILED\n');
    return false;
  }
}

async function testExistingBotCreation() {
  console.log('TEST: Existing POST /api/bots still works\n');

  const response = await request('POST', '/api/bots', {
    name: 'Manual Bot',
    title: 'Manually Created',
    description: 'Created via original endpoint',
    avatar: null,
  });

  console.log(`Status: ${response.status}`);
  console.log(`Response:\n${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 200 && response.body.id && response.body.name === 'Manual Bot') {
    console.log('✅ Existing bot creation test PASSED\n');
    return true;
  } else {
    console.log('❌ Existing bot creation test FAILED\n');
    return false;
  }
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Botmancers Import Boundary — Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results = {};

  console.log('SETUP: Creating pre-change database fixture\n');
  createPreChangeDatabaseFixture();

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.migration = testMigration();

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.capabilities = await testImportCapabilities();

  console.log('═══════════════════════════════════════════════════════════════\n');
  const importResult = await testBotImport();
  results.import = importResult.pass;

  if (importResult.pass) {
    console.log('═══════════════════════════════════════════════════════════════\n');
    results.idempotency = await testIdempotency(importResult.operationId);

    console.log('═══════════════════════════════════════════════════════════════\n');
    results.conflict = await testConflictDetection(importResult.operationId);
  } else {
    results.idempotency = false;
    results.conflict = false;
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.validation = await testValidation();

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.existingApi = await testExistingBotCreation();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  Object.entries(results).forEach(([name, pass]) => {
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
  });

  console.log();

  const allPassed = Object.values(results).every(r => r === true);

  if (allPassed) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('ALL TESTS PASSED ✅');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return true;
  } else {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('SOME TESTS FAILED ❌');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return false;
  }
}

async function main() {
  try {
    const passed = await runAllTests();
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    console.error('\nMake sure the dev server is running: npm run dev\n');
    process.exit(1);
  }
}

main();
