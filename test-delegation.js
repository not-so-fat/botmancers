#!/usr/bin/env node
// NOT-395: conversational delegation from one chat message (caller-managed),
// with depth + budget limits and a working Stop.
//
// Self-contained: isolated SQLite file, deterministic stub model injected at
// the model-call boundary. No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-delegation-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
delete process.env.OPENAI_API_KEY;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');

const { bots, conversations, messages, queue } = db;

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
  while (processed < cap && await agent.processNextQueueItem()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

function chainAfter(convId, userMessageId) {
  const all = messages.getByConversation(convId);
  const idx = all.findIndex(m => m.id === userMessageId);
  return all.slice(idx + 1);
}

async function main() {
  log('NOT-395 delegation test (stub model, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log(`OPENAI_API_KEY set: ${Boolean(process.env.OPENAI_API_KEY)} (stub must work without it)`);

  const MAX_DEPTH = agent.DELEGATION_MAX_DEPTH;
  const MAX_TURNS = agent.DELEGATION_MAX_DELEGATED_TURNS;
  assert(typeof MAX_DEPTH === 'number' && MAX_DEPTH > 0, `depth constant imported (DELEGATION_MAX_DEPTH=${MAX_DEPTH})`);
  assert(typeof MAX_TURNS === 'number' && MAX_TURNS > 0, `budget constant imported (DELEGATION_MAX_DELEGATED_TURNS=${MAX_TURNS})`);

  const origin = bots.create({ name: 'Origin', title: 'Caller', description: 'Originates delegations.' });
  const botA = bots.create({ name: 'A', title: 'Drafter', description: 'Drafts.' });
  const botB = bots.create({ name: 'B', title: 'Checker', description: 'Checks drafts.' });
  const conv = conversations.getByBotId(origin.id);
  assert(!!conv, 'origin thread exists');

  // Scenario 1: one message naming A and B -> A draft, B check, report, same thread.
  log('\nScenario 1: A-then-B in one thread');
  const seenBy = {};
  const calls1 = {};
  agent.setDelegationChatStub(ctx => {
    calls1[ctx.botName] = (calls1[ctx.botName] || 0) + 1;
    seenBy[ctx.botName] = ctx.sent.map(part => part.content).join('\n---\n');
    // Caller-managed: only Origin issues WAKE. A and B reply with results
    // (no WAKE); the runtime returns control to Origin after each delegate.
    if (ctx.botName === 'Origin' && calls1.Origin === 1) return 'WAKE A: Please draft the launch note.';
    if (ctx.botName === 'Origin' && calls1.Origin === 2) return 'WAKE B: Please check this draft: Launch Friday at 9am.';
    if (ctx.botName === 'Origin') return 'REPORT: A draft: Launch Friday at 9am. B check: add the venue. Done.';
    if (ctx.botName === 'A') return 'DRAFT from A: Launch Friday at 9am.';
    if (ctx.botName === 'B') return 'CHECK from B: Looks good; add the venue.';
    return 'No response';
  });
  const user1 = messages.create(conv.id, 'user', 'Get A to draft the launch note and B to check it.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  const thread1 = messages.getByConversation(conv.id);
  const draft = thread1.find(m => m.sender_type === 'bot' && m.sender_id === botA.id && m.content.includes('DRAFT from A'));
  const check = thread1.find(m => m.sender_type === 'bot' && m.sender_id === botB.id && m.content.includes('CHECK from B'));
  const report = thread1.find(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('REPORT:'));
  log(`  draft : ${draft ? JSON.stringify(draft.content.split('\n')[0]) : '(missing)'}`);
  log(`  check : ${check ? JSON.stringify(check.content.split('\n')[0]) : '(missing)'}`);
  log(`  report: ${report ? JSON.stringify(report.content) : '(missing)'}`);
  assert(!!draft && !!check && !!report, 'three messages present (A draft, B check, report)');
  assert(
    !!draft && !!check && !!report &&
    thread1.indexOf(draft) < thread1.indexOf(check) &&
    thread1.indexOf(check) < thread1.indexOf(report),
    'order in thread: draft, then check, then report'
  );
  assert(
    !!draft && !!check && !!report &&
    draft.conversation_id === conv.id && check.conversation_id === conv.id && report.conversation_id === conv.id,
    'all three in the same thread as the request'
  );
  assert((seenBy.B || '').includes('Launch Friday at 9am'), "B received A's draft in its context");
  assert((seenBy.Origin || '').includes('add the venue'), "Origin's report turn saw B's check");
  assert(calls1.Origin === 3 && calls1.A === 1 && calls1.B === 1, `caller-managed sequence Origin->A, back, Origin->B, back, report (Origin=${calls1.Origin || 0}, A=${calls1.A || 0}, B=${calls1.B || 0})`);
  assert((seenBy.A || '').includes('delegated by @Origin'), 'A was told Origin delegated it');
  assert((seenBy.B || '').includes('delegated by @Origin'), 'B was told Origin delegated it');
  assert(queue.countPending(conv.id) === 0, 'queue drained after report');

  // Scenario 2: handoff beyond the depth constant is refused with a reason.
  log('\nScenario 2: depth limit');
  const next = { Origin: 'A', A: 'B', B: 'A' };
  agent.setDelegationChatStub(ctx => `WAKE ${next[ctx.botName] || 'A'}: continue the depth probe.`);
  const user2 = messages.create(conv.id, 'user', 'Depth probe: keep handing off.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  const thread2 = chainAfter(conv.id, user2.id);
  const handoffs = thread2.filter(m => m.sender_type === 'bot' && m.content.includes('[Handing off to'));
  const depthReason = thread2.find(m => m.sender_type === 'bot' && m.content.includes('Depth limit'));
  log(`  handoffs performed: ${handoffs.length} (constant MAX_DEPTH=${MAX_DEPTH})`);
  log(`  reason: ${depthReason ? JSON.stringify(depthReason.content) : '(missing)'}`);
  assert(!!depthReason, 'explicit depth reason posted');
  assert(!!depthReason && depthReason.content.includes(String(MAX_DEPTH)), 'depth reason names the constant');
  assert(handoffs.length === MAX_DEPTH, `handoffs stop at the constant (${MAX_DEPTH})`);
  assert(queue.countPending(conv.id) === 0, 'no further handoff queued after depth refusal');

  // Scenario 3: delegated turn beyond the budget constant is refused.
  log('\nScenario 3: budget limit');
  agent.setDelegationChatStub(() => 'budget-turn-ok');
  const user3 = messages.create(conv.id, 'user', 'Budget probe: many turns.');
  for (let i = 0; i < MAX_TURNS + 2; i++) {
    queue.enqueue(conv.id, origin.id);
    await sleep(2);
  }
  await drain();

  const thread3 = chainAfter(conv.id, user3.id);
  const botMsgs3 = thread3.filter(m => m.sender_type === 'bot');
  const budgetReason = botMsgs3.find(m => m.content.includes('Budget limit'));
  log(`  bot turns posted: ${botMsgs3.length} (constant MAX_TURNS=${MAX_TURNS})`);
  log(`  reason: ${budgetReason ? JSON.stringify(budgetReason.content) : '(missing)'}`);
  assert(!!budgetReason, 'explicit budget reason posted');
  assert(!!budgetReason && budgetReason.content.includes(String(MAX_TURNS)), 'budget reason names the constant');
  assert(botMsgs3.length === MAX_TURNS + 1, `turns stop at constant + reason (${MAX_TURNS} + 1)`);
  assert(queue.countPending(conv.id) === 0, 'queued turns cancelled after budget refusal');

  // Scenario 4: Stop mid-chain -> zero new messages after Stop.
  log('\nScenario 4: Stop');
  const calls4 = {};
  agent.setDelegationChatStub(ctx => {
    calls4[ctx.botName] = (calls4[ctx.botName] || 0) + 1;
    // Caller-managed: only Origin issues WAKE.
    if (ctx.botName === 'Origin' && calls4.Origin === 1) return 'WAKE A: Please draft the launch note.';
    if (ctx.botName === 'Origin' && calls4.Origin === 2) return 'WAKE B: should never run.';
    if (ctx.botName === 'Origin') return 'REPORT: should never run.';
    if (ctx.botName === 'A') return 'DRAFT from A: Launch Friday at 9am.';
    if (ctx.botName === 'B') return 'CHECK from B: should never run.';
    return 'No response';
  });
  const user4 = messages.create(conv.id, 'user', 'Get A to draft and B to check, then stop.');
  queue.enqueue(conv.id, origin.id);
  await agent.processNextQueueItem(); // Origin -> handoff to A
  await sleep(3);
  await agent.processNextQueueItem(); // A -> draft, runtime returns to Origin
  await sleep(3);

  const midChain = chainAfter(conv.id, user4.id);
  assert(midChain.some(m => m.content.includes('DRAFT from A')), 'draft posted before Stop');
  assert(!midChain.some(m => m.content.includes('CHECK from B')), 'check not yet posted before Stop');
  assert(queue.countPending(conv.id) === 1, 'one caller return queued before Stop');
  const pendingBeforeStop = queue.getNext();
  assert(!!pendingBeforeStop && pendingBeforeStop.bot_id === origin.id, 'queued return is the caller (Origin)');

  const stopped = agent.stopDelegation(conv.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  const afterStop = messages.getByConversation(conv.id);
  const stopNotice = afterStop[afterStop.length - 1];
  assert(stopNotice.content.includes('Delegation stopped'), 'explicit stopped message in thread');
  const countAfterStop = afterStop.length;

  await drain();
  const final = messages.getByConversation(conv.id);
  log(`  messages after Stop: ${final.length - countAfterStop} new (expected 0)`);
  assert(final.length === countAfterStop, 'zero new messages after Stop');
  assert(queue.countPending(conv.id) === 0, 'queued delegated turn cancelled');
  const thread4 = chainAfter(conv.id, user4.id);
  assert(!thread4.some(m => m.content.includes('CHECK from B')), 'no B turn produced after Stop');
  assert(!thread4.some(m => m.content.includes('REPORT: should never run')), 'no report produced after Stop');
  assert(agent.stopDelegation(conv.id) === false, 'second Stop is a no-op without duplicate notice');
  assert(messages.getByConversation(conv.id).length === countAfterStop, 'no duplicate stopped notice');

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
    console.error('delegation test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
