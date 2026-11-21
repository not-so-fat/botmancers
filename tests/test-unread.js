#!/usr/bin/env node
// NOT-409: unread marker persistence.
// Proves: a bot message landing in a closed thread sets unread; opening the
// thread (GET messages marks read) clears it; the cleared state survives a
// reload; "mark unread" sets it again. Self-contained: isolated SQLite file,
// no dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-unread-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');

const { bots, conversations, messages } = db;

let failures = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

const avery = bots.create({ deck_id: 'deck-test', name: 'Avery', title: '', description: '' });
const blake = bots.create({ deck_id: 'deck-test', name: 'Blake', title: '', description: '' });
const convA = conversations.getByBotId(avery.id).id;

// 1. Fresh bots start read.
assert(bots.getById(avery.id).unread === 0, 'new bot starts with unread=0');

// 2. A bot message landing in the closed thread sets unread on the sender.
messages.create(convA, 'bot', 'hello from Avery', avery.id);
assert(bots.getById(avery.id).unread === 1, 'bot message in closed thread sets unread=1');

// 3. A foreign bot reply marks both the sender and the thread owner.
messages.create(convA, 'bot', 'hello from Blake', blake.id);
assert(bots.getById(blake.id).unread === 1, 'foreign sender is marked unread');
assert(bots.getById(avery.id).unread === 1, 'thread owner stays unread');

// 4. Opening the thread clears it (GET /api/conversations/[id]/messages calls
// bots.markRead for the thread owner).
bots.markRead(avery.id);
assert(bots.getById(avery.id).unread === 0, 'opening the thread clears unread to 0');

// 5. A reload keeps the cleared state.
const Database = require('better-sqlite3');
const fresh = new Database(DB_PATH, { readonly: true });
const reloaded = fresh.prepare('SELECT unread FROM bots WHERE id = ?').get(avery.id);
fresh.close();
assert(reloaded.unread === 0, 'reload keeps unread=0');

// 6. "Mark as Unread" sets it again.
bots.markUnread(avery.id);
assert(bots.getById(avery.id).unread === 1, 'mark unread sets unread=1');

for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
}

if (failures > 0) {
  console.log(`FAIL: ${failures} unread assertion(s) failed`);
  process.exit(1);
}
console.log('PASS: unread persists across arrival, open, and reload');
