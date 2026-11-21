#!/usr/bin/env node
// NOT-411: reference-only agent-loop extras behind main's launch snapshot:
// per-bot remembered facts, one-shot timed wakes, and recurring routines.
//
// Self-contained: isolated SQLite file, deterministic stub model injected at
// the model-call boundary, short real intervals. No dev server, no API key,
// no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-loop-extras-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const agent = jiti('../lib/agent.ts');

const { bots, conversations, messages, memories, oneShots, routines, launchSnapshots } = db;
const { uiTurns } = jiti('../lib/ui-turns.ts');

let failures = 0;

function log(line) {
  console.log(line);
}

function assert(condition, label) {
  if (condition) {
    log(`  PASS: ${label}`);
  } else {
    failures++;
    log(`  FAIL: ${label}`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drain(cap = 40) {
  let processed = 0;
  while (processed < cap && await agent.processNextUiTurn()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

function botMessages(convId) {
  return messages.getByConversation(convId).filter(m => m.sender_type === 'bot');
}

async function main() {
  log('NOT-411 agent-loop extras test (stub model, isolated DB)');
  log(`DB: ${DB_PATH}`);
  agent.resetDelegationForTests();

  // Scenario 1: a remembered fact is injected into the prompt and recorded
  // in the launch snapshot; questions are not remembered; deleting the bot
  // deletes its memory rows.
  log('\nScenario 1: fact injected');
  const memBot = bots.create({ deck_id: 'deck-test', name: 'MemBot', title: 'Keeper', description: 'Keeps facts.' });
  const memConv = conversations.getByBotId(memBot.id);
  assert(!!memConv, 'memory thread exists');
  memories.rememberStatement(memBot.id, 'I like green tea.');
  memories.rememberStatement(memBot.id, 'What is the gate code?');
  assert(
    JSON.stringify(memories.latestFacts(memBot.id)) === JSON.stringify(['I like green tea.']),
    'statement remembered, question filtered'
  );
  let memSent = '';
  agent.setDelegationChatStub(ctx => {
    memSent = ctx.sent.map(part => part.content).join('\n---\n');
    return 'You like green tea.';
  });
  messages.create(memConv.id, 'user', 'What do I like?');
  uiTurns.enqueue(memConv.id, memBot.id);
  await drain();
  assert(memSent.includes('Remembered facts:'), 'prompt carries the remembered-facts block');
  assert(memSent.includes('- I like green tea.'), 'prompt carries the exact fact');
  assert(!memSent.includes('gate code'), 'filtered question never reaches the prompt');
  const memSnapshots = launchSnapshots.listByBot(memBot.id);
  const memInput = memSnapshots.length > 0 ? JSON.parse(memSnapshots[0].snapshot) : null;
  assert(
    !!memInput && JSON.stringify(memInput.memories) === JSON.stringify(['I like green tea.']),
    'launch snapshot input records the injected fact'
  );
  bots.remove(memBot.id);
  assert(memories.latestFacts(memBot.id).length === 0, 'deleting the bot deletes its memory rows');

  // Scenario 2: a due one-shot fires exactly once.
  log('\nScenario 2: one-shot fires once');
  agent.setDelegationChatStub(() => 'noted.');
  const onceBot = bots.create({ deck_id: 'deck-test', name: 'OnceBot', title: 'Waker', description: 'Wakes once.' });
  const onceConv = conversations.getByBotId(onceBot.id);
  messages.create(onceConv.id, 'user', 'Hello.');
  uiTurns.enqueue(onceConv.id, onceBot.id);
  await drain();
  oneShots.create(onceConv.id, onceBot.id, Date.now() + 60);
  agent.resumeLoopTimers();
  await sleep(200);
  await drain();
  const onceFired = botMessages(onceConv.id).filter(m => m.content === agent.ONE_SHOT_MESSAGE);
  assert(onceFired.length === 1, `one-shot posted exactly once (got ${onceFired.length})`);
  assert(oneShots.pending(onceConv.id) === undefined, 'one-shot row claimed after firing');
  assert(uiTurns.countPending(onceConv.id) === 0, 'queue drained after one-shot');
  await sleep(200);
  agent.resumeLoopTimers();
  await drain();
  const onceAgain = botMessages(onceConv.id).filter(m => m.content === agent.ONE_SHOT_MESSAGE);
  assert(onceAgain.length === 1, `one-shot still exactly once after re-arm (got ${onceAgain.length})`);

  // Scenario 3: a taught routine posts twice over two intervals, never
  // touches the model for its ticks, and stops after Stop.
  log('\nScenario 3: routine twice, then Stop');
  let stubCalls = 0;
  agent.setDelegationChatStub(() => {
    stubCalls++;
    return 'routine armed.';
  });
  const routineBot = bots.create({ deck_id: 'deck-test', name: 'RoutineBot', title: 'Ticker', description: 'Ticks.' });
  const routineConv = conversations.getByBotId(routineBot.id);
  messages.create(routineConv.id, 'user', 'Teach me a routine.');
  uiTurns.enqueue(routineConv.id, routineBot.id);
  await drain();
  assert(stubCalls === 1, 'user turn answered once by the model');
  const WORD = 'stretch';
  const EVERY_MS = 60;
  routines.create(routineConv.id, routineBot.id, WORD, Date.now() + EVERY_MS, EVERY_MS);
  const routinePosts = () =>
    botMessages(routineConv.id).filter(m => m.content === `[routine]\n${WORD}`);
  agent.resumeLoopTimers();
  await sleep(200);
  await drain();
  assert(routinePosts().length === 1, `routine posted after the first interval (got ${routinePosts().length})`);
  agent.resumeLoopTimers();
  await sleep(200);
  await drain();
  assert(routinePosts().length === 2, `routine posted after the second interval (got ${routinePosts().length})`);
  assert(stubCalls === 1, 'routine ticks never called the model');
  assert(uiTurns.countPending(routineConv.id) === 0, 'queue drained after routine ticks');
  const stopped = agent.stopDelegation(routineConv.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  const countAfterStop = messages.getByConversation(routineConv.id).length;
  agent.resumeLoopTimers();
  await sleep(200);
  await drain();
  const final = messages.getByConversation(routineConv.id);
  assert(routinePosts().length === 2, `no routine post after Stop (got ${routinePosts().length})`);
  assert(final.length === countAfterStop, 'zero new messages after Stop');
  assert(uiTurns.countPending(routineConv.id) === 0, 'no tick queued after Stop');

  // Scenario 4: a routine tick never bypasses the delegation budget. While
  // exhausted, heartbeats enqueue nothing (no post, no per-heartbeat budget
  // spam); the tick is preserved and fires on the next user message.
  log('\nScenario 4: budget binds ticks');
  const MAX_TURNS = agent.DELEGATION_MAX_DELEGATED_TURNS;
  agent.setDelegationChatStub(() => 'ok');
  const budgetBot = bots.create({ deck_id: 'deck-test', name: 'BudgetBot', title: 'Spender', description: 'Spends turns.' });
  const budgetConv = conversations.getByBotId(budgetBot.id);
  messages.create(budgetConv.id, 'user', 'Spend the budget.');
  for (let i = 0; i < MAX_TURNS + 2; i++) {
    uiTurns.enqueue(budgetConv.id, budgetBot.id);
    await sleep(2);
  }
  await drain();
  const spentReasons = botMessages(budgetConv.id).filter(m => m.content.includes('Budget limit'));
  assert(spentReasons.length === 1, `exhausting the budget posts one budget reason (got ${spentReasons.length})`);
  routines.create(budgetConv.id, budgetBot.id, 'late', Date.now(), 60000);
  agent.resumeLoopTimers();
  await sleep(150);
  await drain();
  const budgetThread = () => botMessages(budgetConv.id);
  const budgetReasons = () => budgetThread().filter(m => m.content.includes('Budget limit'));
  const lateRoutine = () => budgetThread().filter(m => m.content.startsWith('[routine]'));
  assert(lateRoutine().length === 0, 'exhausted budget defers the routine tick');
  assert(budgetReasons().length === 1, `no extra budget post while exhausted (got ${budgetReasons().length})`);
  assert(!!routines.forConversation(budgetConv.id), 'deferred tick row is preserved');
  const countBeforeBeats = messages.getByConversation(budgetConv.id).length;
  for (let i = 0; i < 3; i++) {
    agent.resumeLoopTimers();
    await sleep(120);
    await drain();
  }
  assert(
    messages.getByConversation(budgetConv.id).length === countBeforeBeats,
    'three heartbeats post nothing while the budget is exhausted'
  );
  assert(lateRoutine().length === 0, 'three heartbeats fire no routine while exhausted');
  assert(budgetReasons().length === 1, 'three heartbeats post no further budget reasons');
  assert(uiTurns.countPending(budgetConv.id) === 0, 'three heartbeats enqueue nothing while exhausted');
  messages.create(budgetConv.id, 'user', 'Thanks, go on.');
  uiTurns.enqueue(budgetConv.id, budgetBot.id);
  await drain();
  agent.resumeLoopTimers();
  await sleep(150);
  await drain();
  assert(lateRoutine().length === 1, `deferred tick fires on the fresh chain (got ${lateRoutine().length})`);

  // Scenario 5: the generalised teaching phrases arm timers through the
  // real launch path, without calling the model — and the taught timers
  // post exactly once past due. Regression cover for the silent-teaching
  // deadlock: teaching posted no reply, so the tick launch saw the user
  // turn as awaiting reply, fell through to the teaching hook, and
  // re-armed the already-due row with wait 0 in a tight loop (no post,
  // queue and launch_snapshots growing every few ms).
  log('\nScenario 5: teaching phrases arm timers');
  let teachCalls = 0;
  agent.setDelegationChatStub(() => {
    teachCalls++;
    return 'should never send';
  });
  process.env.BOTMANCERS_ROUTINE_FIRST_DUE_MS = '80';
  const teachBot = bots.create({ deck_id: 'deck-test', name: 'TeachBot', title: 'Student', description: 'Learns timers.' });
  const teachConv = conversations.getByBotId(teachBot.id);
  messages.create(teachConv.id, 'user', 'Reply with the word teacup.');
  uiTurns.enqueue(teachConv.id, teachBot.id);
  await drain();
  const taught = routines.forConversation(teachConv.id);
  assert(!!taught && taught.word === 'teacup', 'routine phrase teaches the word');
  assert(!!taught && taught.every_ms === 24 * 60 * 60 * 1000, 'taught routine repeats daily like the reference');
  assert(teachCalls === 0, 'routine teaching never calls the model');
  await sleep(300);
  await drain();
  const taughtRoutinePosts = () =>
    botMessages(teachConv.id).filter(m => m.content === '[routine]\nteacup');
  assert(taughtRoutinePosts().length === 1, `taught routine posts exactly once past due (got ${taughtRoutinePosts().length})`);
  assert(uiTurns.countPending(teachConv.id) === 0, 'no queued rows after the taught routine fires');
  assert(teachCalls === 0, 'taught routine tick never calls the model');
  const teachSnapshots = launchSnapshots.listByBot(teachBot.id).length;
  await sleep(200);
  await drain();
  assert(taughtRoutinePosts().length === 1, 'taught routine still exactly once after settling');
  assert(
    launchSnapshots.listByBot(teachBot.id).length === teachSnapshots,
    'no re-arm loop: snapshot count stable after the taught routine fires'
  );
  messages.create(teachConv.id, 'user', 'Reply with the word teacup.');
  uiTurns.enqueue(teachConv.id, teachBot.id);
  await drain();
  assert(
    routines.all().filter(row => row.conversation_id === teachConv.id).length === 1,
    'reteaching re-arms instead of duplicating the row'
  );
  delete process.env.BOTMANCERS_ROUTINE_FIRST_DUE_MS;
  const shotBot = bots.create({ deck_id: 'deck-test', name: 'ShotBot', title: 'Student', description: 'Learns one-shots.' });
  const shotConv = conversations.getByBotId(shotBot.id);
  const teachAt = Date.now();
  messages.create(shotConv.id, 'user', 'Set a one-shot in 1 second.');
  uiTurns.enqueue(shotConv.id, shotBot.id);
  await drain();
  const taughtShot = oneShots.pending(shotConv.id);
  assert(!!taughtShot, 'one-shot phrase teaches a durable one-shot');
  assert(
    !!taughtShot && Math.abs(taughtShot.due_at - (teachAt + 1000)) < 2000,
    'one-shot delay honors the taught seconds'
  );
  assert(teachCalls === 0, 'one-shot teaching never calls the model');
  await sleep(1500);
  await drain();
  const taughtShotPosts = () =>
    botMessages(shotConv.id).filter(m => m.content === agent.ONE_SHOT_MESSAGE);
  assert(taughtShotPosts().length === 1, `taught one-shot posts exactly once past due (got ${taughtShotPosts().length})`);
  assert(uiTurns.countPending(shotConv.id) === 0, 'no queued rows after the taught one-shot fires');
  assert(teachCalls === 0, 'taught one-shot tick never calls the model');
  const shotSnapshots = launchSnapshots.listByBot(shotBot.id).length;
  await sleep(200);
  await drain();
  assert(taughtShotPosts().length === 1, 'taught one-shot still exactly once after settling');
  assert(
    launchSnapshots.listByBot(shotBot.id).length === shotSnapshots,
    'no re-arm loop: snapshot count stable after the taught one-shot fires'
  );

  // Scenario 6: the tick check runs before the content hooks, so a due
  // routine posts even when the latest user message is a draft ask
  // (previously the draft hook returned first and the tick never fired).
  log('\nScenario 6: tick runs before content hooks');
  const draftTickBot = bots.create({ deck_id: 'deck-test', name: 'DraftTickBot', title: 'Ticker', description: 'Ticks past drafts.' });
  const draftTickConv = conversations.getByBotId(draftTickBot.id);
  messages.create(draftTickConv.id, 'user', 'Email Alice the summary.');
  uiTurns.enqueue(draftTickConv.id, draftTickBot.id);
  await drain();
  assert(
    botMessages(draftTickConv.id).some(m => m.content.includes('[draft]')),
    'draft ask still creates its draft card'
  );
  routines.create(draftTickConv.id, draftTickBot.id, 'tickword', Date.now(), 60000);
  agent.resumeLoopTimers();
  await sleep(150);
  await drain();
  const tickPosts = botMessages(draftTickConv.id).filter(m => m.content === '[routine]\ntickword');
  assert(tickPosts.length === 1, `due tick posts despite the draft ask (got ${tickPosts.length})`);
  assert(teachCalls === 0, 'tick past the draft hook never calls the model');

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('agent-loop-extras test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
