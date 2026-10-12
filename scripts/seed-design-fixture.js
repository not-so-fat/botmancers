#!/usr/bin/env node
// NOT-409: seed an isolated design-fixture DB showing the same screens as the
// six reference screenshots: a chief-of-staff card, colored bots, one pinned,
// one unread, one group, and threads with user + bot message cards.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/design-fixture.db.
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db node scripts/seed-design-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'design-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const { serializeRun } = jiti('../lib/run.ts');

const { bots, conversations, groups, messages } = db;

function makeBot(name, title, description) {
  return bots.create({ name, title, description });
}

// Creation order fixes colors (count-based): LaunchMint green, OvernightMint
// orange, Pine red, Cedar purple, chief-of-staff yellow, Bob green, Alice orange.
const launchMint = makeBot('LaunchMint', '', 'Launch helper.');
const overnightMint = makeBot('OvernightMint', '', 'Overnight helper.');
const pine = makeBot('Pine', '', 'Grove bot. Replies with grove text only.');
const cedar = makeBot('Cedar', 'Grove note', 'Grove bot. Rowmint3 is crucial for understanding growth patterns.');
const chiefOfStaff = makeBot('chief-of-staff', 'Chief of staff', 'The project code is leadmint4.');
const bob = makeBot('Bob', '', 'Hands off to Alice.');
const alice = makeBot('Alice', '', 'Replies handmint3.');

bots.setPinned(cedar.id, true);

function threadOf(bot) {
  const conv = conversations.getByBotId(bot.id);
  if (!conv) throw new Error(`missing conversation for ${bot.name}`);
  return conv.id;
}

function seedThread(bot, pairs) {
  const convId = threadOf(bot);
  for (const [userText, botText] of pairs) {
    messages.create(convId, 'user', userText);
    messages.create(convId, 'bot', botText, bot.id);
  }
  return convId;
}

seedThread(launchMint, [
  ['Reply with one short sentence that includes the word rowmint3.', 'The boat sailed smoothly across the rowmint3. skillmint441'],
  ['Set a one-shot that posts routinemint8 later.', 'routinemint8\nskillmint441'],
]);
seedThread(overnightMint, [
  ['What is the gate code?', 'The gate code is oakmint7.'],
]);
seedThread(pine, [
  ['Say something grovy.', 'grove text only'],
]);
seedThread(cedar, [
  ['Reply with exactly the word launched.', 'Launched.'],
  ['Reply with one short sentence that includes the word rowmint3.', 'The process involving rowmint3 is essential for understanding growth patterns.'],
  ['Reply with one short sentence that includes the word leadmint4.', 'Rowmint3 is crucial for understanding growth patterns in forests.'],
]);
seedThread(bob, [
  ['Reply with exactly handmint3.', '[Handing off to Alice] reply with exactly handmint3'],
]);
seedThread(alice, [
  ['Say handmint3.', 'handmint3'],
]);

// Chief-of-staff thread: a finished [run] with html drives the computer preview.
const cosConv = threadOf(chiefOfStaff);
messages.create(cosConv, 'user', 'Reply with one short sentence that includes the word leadmint4.');
messages.create(
  cosConv,
  'bot',
  serializeRun({
    state: 'done',
    output: 'The project code is leadmint4.',
    html: '<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff;color:#111;font-family:sans-serif"><h1>The project code is leadmint4.</h1></body></html>',
  }),
  chiefOfStaff.id
);

// One group labelled "<name> @<owner>".
const grove = groups.create('ClickproofGrove', [pine.id, cedar.id], pine.id);
const groveConv = conversations.getByGroupId(grove.id);
messages.create(groveConv.id, 'user', 'Hello team.');
messages.create(groveConv.id, 'bot', 'Groving.', pine.id);

// Heartbeat fresh for all but Bob (Bob shows Stopped); only Alice keeps unread.
bots.touchSeen();
for (const bot of bots.getAll()) bots.markRead(bot.id);
bots.markUnread(alice.id);
const Database = require('better-sqlite3');
const raw = new Database(DB_PATH);
raw.prepare('UPDATE bots SET last_seen = ? WHERE id = ?').run(Date.now() - 60000, bob.id);
raw.close();

console.log(`Seeded design fixture: ${DB_PATH}`);
for (const bot of bots.getAll()) {
  const beat = bot.last_seen && Date.now() - bot.last_seen < 15000 ? 'Heartbeat' : 'Stopped';
  console.log(`  - ${bot.name} color=${bot.color} pinned=${bot.pinned ? 1 : 0} unread=${bot.unread ? 1 : 0} hidden=${bot.hidden ? 1 : 0} ${beat}`);
}
console.log(`  - group ClickproofGrove @Pine (${grove.id})`);
console.log('Working state is client-side: open the chief-of-staff thread and send a message to capture it.');
console.log(`Run: BOTMANCERS_DB_PATH=${DB_PATH} npm run dev`);
