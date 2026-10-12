#!/usr/bin/env node
// NOT-409: seed an isolated design-fixture DB showing the same screens as the
// six reference screenshots: a chief-of-staff card, colored bots, one pinned,
// one unread, groups, and threads with user + bot message cards.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/design-fixture.db
// (.temporal/design-fixture-nogroups.db with --no-groups).
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db node scripts/seed-design-fixture.js
//        node scripts/seed-design-fixture.js --no-groups   (roster-nogroups screen)
//        node scripts/seed-design-fixture.js --thread-cards (NOT-410 card demo thread)
//        BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
'use strict';

const fs = require('fs');
const path = require('path');

const NO_GROUPS = process.argv.includes('--no-groups') || process.env.SEED_NO_GROUPS === '1';

const DEFAULT_PATH = NO_GROUPS
  ? path.join('.temporal', 'design-fixture-nogroups.db')
  : path.join('.temporal', 'design-fixture.db');
const DB_PATH = process.env.BOTMANCERS_DB_PATH || DEFAULT_PATH;
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
const { serializeDraft } = jiti('../lib/draft.ts');

const { bots, conversations, groups, messages, routines, launchSnapshots } = db;

// Same hardcoded IDs as lib/db.ts: only these rows keep the lime (Cedar) and
// orange (Pine) colors when the module-load recolor runs under `npm run dev`.
const CEDAR_ID = '9e363764-e0d5-4fff-8ebd-ccbc46ba0ba5';
const PINE_ID = '5fbe32c2-79cb-452e-9d9b-f8c9eb63b99b';

// Strictly increasing created_at (1s apart) in an order that yields both the
// reference palette and the reference roster order:
// - Recolor assigns non-Cedar/Pine bots red, purple, yellow, lime, orange in
//   created_at ASC order, so Alice < Bob < chief-of-staff < OvernightMint
//   < LaunchMint gives red Alice, purple Bob, yellow lead, lime OvernightMint,
//   orange LaunchMint.
// - The roster shows the lead card first, then the pinned bot, then the rest
//   in created_at DESC order, so pinning LaunchMint with Pine and Cedar
//   between OvernightMint and Bob renders LaunchMint, OvernightMint, Pine,
//   Cedar, Bob, Alice.
const T0 = Date.now();
function makeBot(name, title, description, slot, id) {
  return bots.create({ name, title, description }, { id, created_at: T0 + slot * 1000 });
}

const alice = makeBot('Alice', '', 'Replies handmint3.', 0);
const bob = makeBot('Bob', '', 'Hands off to Alice.', 1);
const chiefOfStaff = makeBot('chief-of-staff', 'Chief of staff', 'The project code is leadmint4.', 2);
const cedar = makeBot('Cedar', 'Grove note', 'Grove bot. Rowmint3 is crucial for understanding growth patterns.', 3, CEDAR_ID);
const pine = makeBot('Pine', '', 'Grove bot. Replies with grove text only.', 4, PINE_ID);
const overnightMint = makeBot('OvernightMint', '', 'Overnight helper.', 5);
const launchMint = makeBot('LaunchMint', '', 'Launch helper.', 6);

bots.setPinned(launchMint.id, true);

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

// NOT-411: a taught-style routine row on the chief-of-staff thread (the
// reference taught routinemint2 there). No new bots or messages, so the
// NOT-409 screens seed identically; on `npm run dev` the loop arms it and
// posts `[routine] routinemint2` ~8s after start, then every 60s.
routines.create(cosConv, chiefOfStaff.id, 'routinemint2', Date.now() + 8000, 60000);

// Two groups, newest first: "ClickproofGrove @Pine" then "Research Team".
// Research Team keeps a null owner so the row renders the plain group name.
let grove = null;
let research = null;
if (!NO_GROUPS) {
  research = groups.create('Research Team', [bob.id, alice.id], bob.id, { created_at: T0 + 7000 });
  grove = groups.create('ClickproofGrove', [pine.id, cedar.id], pine.id, { created_at: T0 + 8000 });
  const groveConv = conversations.getByGroupId(grove.id);
  messages.create(groveConv.id, 'user', 'Hello team.');
  messages.create(groveConv.id, 'bot', 'Groving.', pine.id);
  const researchConv = conversations.getByGroupId(research.id);
  messages.create(researchConv.id, 'user', 'Hello researchers.');
  messages.create(researchConv.id, 'bot', 'Researching.', bob.id);
}

// NOT-410: opt-in thread-card demo (draft, approval, file, handoff reveal).
// Off by default so the six NOT-409 screens seed byte-identically; the extra
// bot takes the latest created_at slot so existing colors and roster order
// are unchanged when the flag is on.
const THREAD_CARDS = process.argv.includes('--thread-cards') || process.env.SEED_THREAD_CARDS === '1';
let cardMint = null;
if (THREAD_CARDS) {
  cardMint = makeBot('CardMint', '', 'Thread-card demo.', 7);
  const convId = threadOf(cardMint);
  messages.create(convId, 'user', 'Show me the thread cards.');
  messages.create(convId, 'bot', serializeDraft({ channel: 'email', recipient: 'Alice', body: 'Hello Alice, this draft is ready to send.', state: 'open' }), cardMint.id);
  messages.create(convId, 'bot', 'Please approve using the code cardmint1 to continue.', cardMint.id);
  messages.create(convId, 'bot', '[file] filemint6.txt\nThe launch code is filemint6.', cardMint.id);
  messages.create(convId, 'user', 'Ask Alice to check this.');
  messages.create(convId, 'bot', '[Handing off to Alice]\nplease check the cards', cardMint.id);
  messages.create(convId, 'bot', 'A reply between the handoff and the answer.', cardMint.id);
  messages.create(convId, 'bot', 'Cards checked.', alice.id);
}

// NOT-412: two consistent launch snapshots for LaunchMint (manual bot, null
// provenance) so the config page C1/C7 states capture from real data with
// no route-interception mock. Newer matches the current config; older has
// previous rules so it reads "Config changed since".
const { randomUUID } = require('crypto');
const { buildSnapshotInput, hashSnapshot } = require('../lib/snapshot');
{
  const skillPath = path.join('skills', 'LaunchMint', 'SKILL.md');
  const skillContent = fs.readFileSync(skillPath, 'utf8');
  const skillState = { path: skillPath, present: true, content: skillContent };
  const botRow = bots.getById(launchMint.id);
  const currentInput = buildSnapshotInput(botRow, skillState, []);
  const olderInput = buildSnapshotInput(
    { ...botRow, description: 'Launch helper. (previous rules)' },
    skillState,
    []
  );
  const olderId = randomUUID();
  const currentId = randomUUID();
  launchSnapshots.record(olderId, launchMint.id, hashSnapshot(olderInput), JSON.stringify(olderInput), 'hermes-gateway');
  launchSnapshots.record(currentId, launchMint.id, hashSnapshot(currentInput), JSON.stringify(currentInput), 'hermes-gateway');
  const DatabaseEarly = require('better-sqlite3');
  const fixTime = new DatabaseEarly(DB_PATH);
  fixTime.prepare('UPDATE launch_snapshots SET created_at = ? WHERE id = ?').run(T0 - 86400000, olderId);
  fixTime.prepare('UPDATE launch_snapshots SET created_at = ? WHERE id = ?').run(T0, currentId);
  fixTime.close();
}

// Heartbeat fresh for all but Bob (Bob shows Stopped); only Alice keeps unread.
bots.touchSeen();
for (const bot of bots.getAll()) bots.markRead(bot.id);
bots.markUnread(alice.id);
const Database = require('better-sqlite3');
const raw = new Database(DB_PATH);
raw.prepare('UPDATE bots SET last_seen = ? WHERE id = ?').run(Date.now() - 60000, bob.id);
if (research) raw.prepare('UPDATE groups SET owner_bot_id = NULL WHERE id = ?').run(research.id);

// Apply the same final colors lib/db.ts computes on module load (Cedar lime,
// Pine orange, the rest red/purple/yellow/lime/orange by created_at ASC) so
// the colors printed below are exactly what `npm run dev` renders.
const BOT_COLORS = ['#C6F54A', '#F0A05A', '#E85D75', '#C9A0FF', '#F2E36B'];
raw.prepare('UPDATE bots SET color = ? WHERE id = ?').run(BOT_COLORS[0], CEDAR_ID);
raw.prepare('UPDATE bots SET color = ? WHERE id = ?').run(BOT_COLORS[1], PINE_ID);
const others = raw.prepare(
  'SELECT id FROM bots WHERE id NOT IN (?, ?) ORDER BY created_at ASC'
).all(CEDAR_ID, PINE_ID);
const setColor = raw.prepare('UPDATE bots SET color = ? WHERE id = ?');
others.forEach((bot, index) => {
  setColor.run(BOT_COLORS[(index + 2) % BOT_COLORS.length], bot.id);
});

const rows = raw.prepare('SELECT name, color, pinned, unread, hidden, last_seen FROM bots ORDER BY created_at DESC').all();
raw.close();

console.log(`Seeded design fixture: ${DB_PATH}${NO_GROUPS ? ' (no groups)' : ''}`);
for (const bot of rows) {
  const beat = bot.last_seen && Date.now() - bot.last_seen < 15000 ? 'Heartbeat' : 'Stopped';
  console.log(`  - ${bot.name} color=${bot.color} pinned=${bot.pinned ? 1 : 0} unread=${bot.unread ? 1 : 0} hidden=${bot.hidden ? 1 : 0} ${beat}`);
}
if (grove) {
  console.log(`  - group ClickproofGrove @Pine (${grove.id})`);
  console.log(`  - group Research Team (${research.id})`);
}
if (cardMint) {
  console.log(`  - thread-card demo thread on CardMint (${cardMint.id}): draft, approval cardmint1, file, handoff reveal`);
}
console.log('  - routine routinemint2 on chief-of-staff (posts ~8s after dev start, every 60s)');
console.log(`  - 2 launch snapshots on LaunchMint (${launchMint.id}): newest matches current, older changed`);
console.log('Working state is client-side: open the chief-of-staff thread and send a message to capture it.');
console.log(`Run: BOTMANCERS_DB_PATH=${DB_PATH} npm run dev`);
