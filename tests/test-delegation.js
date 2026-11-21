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

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const agent = jiti('../lib/agent.ts');
const providerContract = jiti('../lib/session-provider.ts');
const fake = require('./support/fake-session-provider');

const { bots, conversations, messages } = db;
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

function chainAfter(convId, userMessageId) {
  const all = messages.getByConversation(convId);
  const idx = all.findIndex(m => m.id === userMessageId);
  return all.slice(idx + 1);
}

async function main() {
  log('NOT-395 delegation test (stub model, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log('Deterministic stub serves all turns (no external model key required)');

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
  uiTurns.enqueue(conv.id, origin.id);
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
  assert(!(seenBy.A || '').includes('DECK'), 'delegate prompt never presents a DECK directive to the model');
  assert(!(seenBy.A || '').includes('agent-deck'), 'delegate prompt names no Agent Deck launch path (routing is stored, not prompted)');
  assert(uiTurns.countPending(conv.id) === 0, 'queue drained after report');

  // Scenario 2: handoff beyond the depth constant is refused with a reason.
  log('\nScenario 2: depth limit');
  const next = { Origin: 'A', A: 'B', B: 'A' };
  agent.setDelegationChatStub(ctx => `WAKE ${next[ctx.botName] || 'A'}: continue the depth probe.`);
  const user2 = messages.create(conv.id, 'user', 'Depth probe: keep handing off.');
  uiTurns.enqueue(conv.id, origin.id);
  await drain();

  const thread2 = chainAfter(conv.id, user2.id);
  const handoffs = thread2.filter(m => m.sender_type === 'bot' && m.content.includes('[Handing off to'));
  const depthReason = thread2.find(m => m.sender_type === 'bot' && m.content.includes('Depth limit'));
  log(`  handoffs performed: ${handoffs.length} (constant MAX_DEPTH=${MAX_DEPTH})`);
  log(`  reason: ${depthReason ? JSON.stringify(depthReason.content) : '(missing)'}`);
  assert(!!depthReason, 'explicit depth reason posted');
  assert(!!depthReason && depthReason.content.includes(String(MAX_DEPTH)), 'depth reason names the constant');
  assert(handoffs.length === MAX_DEPTH, `handoffs stop at the constant (${MAX_DEPTH})`);
  assert(uiTurns.countPending(conv.id) === 0, 'no further handoff queued after depth refusal');

  // Scenario 3: delegated turn beyond the budget constant is refused.
  log('\nScenario 3: budget limit');
  agent.setDelegationChatStub(() => 'budget-turn-ok');
  const user3 = messages.create(conv.id, 'user', 'Budget probe: many turns.');
  for (let i = 0; i < MAX_TURNS + 2; i++) {
    uiTurns.enqueue(conv.id, origin.id);
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
  assert(uiTurns.countPending(conv.id) === 0, 'queued turns cancelled after budget refusal');

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
  uiTurns.enqueue(conv.id, origin.id);
  await agent.processNextUiTurn(); // Origin -> handoff to A
  await sleep(3);
  await agent.processNextUiTurn(); // A -> draft, runtime returns to Origin
  await sleep(3);

  const midChain = chainAfter(conv.id, user4.id);
  assert(midChain.some(m => m.content.includes('DRAFT from A')), 'draft posted before Stop');
  assert(!midChain.some(m => m.content.includes('CHECK from B')), 'check not yet posted before Stop');
  assert(uiTurns.countPending(conv.id) === 1, 'one caller return queued before Stop');
  const pendingBeforeStop = uiTurns.next();
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
  assert(uiTurns.countPending(conv.id) === 0, 'queued delegated turn cancelled');
  const thread4 = chainAfter(conv.id, user4.id);
  assert(!thread4.some(m => m.content.includes('CHECK from B')), 'no B turn produced after Stop');
  assert(!thread4.some(m => m.content.includes('REPORT: should never run')), 'no report produced after Stop');
  assert(agent.stopDelegation(conv.id) === false, 'second Stop is a no-op without duplicate notice');
  assert(messages.getByConversation(conv.id).length === countAfterStop, 'no duplicate stopped notice');

  // Scenario 6: single-runtime direct dispatch. An ordinary message to
  // a codex bot launches a direct local provider Session from the queue
  // loop (no Hermes turn first, no model-reply directive parsed); a
  // Hermes reply that literally contains `DECK codex: ...` is posted as
  // ordinary text and launches nothing.
  log('\nScenario 6: direct dispatch from the stored runtime via the queue');
  const coderWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-coder-workdir-'));
  const coder = bots.create({
    name: 'Coder', title: 'Coder', description: 'Builds widgets.', agent: 'codex',
    runtime_connection_id: db.runtimeConnections.ensureLocal('codex'),
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([coderWorkdir]),
    default_workspace: coderWorkdir, policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const coderState = path.join(os.tmpdir(), `botmancers-delegation-provider-${process.pid}.json`);
  try { fs.rmSync(coderState, { force: true }); } catch { /* fresh start */ }
  providerContract.registerSessionProvider(
    { connectionId: coder.runtime_connection_id },
    () => fake.createFakeSessionProvider({ statePath: coderState, kind: 'delegation-coder' }),
  );
  const coderConv = conversations.getByBotId(coder.id);
  agent.setDelegationChatStub(() => {
    throw new Error('Hermes adapter must not run for a direct coding turn');
  });
  const user6 = messages.create(coderConv.id, 'user', 'Build the widget through the coding agent.');
  uiTurns.enqueue(coderConv.id, coder.id);
  await drain();

  const thread6 = chainAfter(coderConv.id, user6.id);
  const observed6 = thread6
    .filter(m => m.sender_type === 'bot' && m.sender_id === coder.id)
    .map(m => (m.content.match(/^\[(Deck [a-z]+)\]/) || [])[1])
    .filter(Boolean);
  log(`  observation types: ${observed6.join(' -> ')}`);
  // NOT-471: an ordinary message is one Agent turn, not the composite
  // implement/review/resume sequence.
  assert(observed6.length === 0, 'direct dispatch posts no composite observations');
  const replies6 = thread6.filter(m => m.sender_type === 'bot' && m.sender_id === coder.id);
  assert(replies6.length === 1 && /^fake reply #\d+: Build the widget through the coding agent\./.test(replies6[0].content), 'direct dispatch posts the one turn\'s reply');
  const calls6 = fake.loadFakeState(coderState).calls;
  const starts6 = calls6.filter(call => call.op === 'startSession');
  assert(
    starts6.length === 1 && starts6[0].workspace === coderWorkdir && starts6[0].authority === 'read_only',
    'direct dispatch starts one readonly turn in the Agent’s default workspace without parsing a directive'
  );
  assert(!calls6.some(call => call.op === 'sendTurn'), 'direct dispatch never resumes a session');
  const chain6 = agent.getDelegationState(coderConv.id);
  assert(!!chain6 && chain6.handoffs === 0 && chain6.turns === 1, `direct dispatch consumes a turn, not a handoff (handoffs=${chain6 ? chain6.handoffs : '?'}, turns=${chain6 ? chain6.turns : '?'})`);
  assert(thread6.every(m => m.conversation_id === coderConv.id), 'all direct-dispatch observations stay in the originating thread');
  assert(uiTurns.countPending(coderConv.id) === 0, 'queue drained after the direct-dispatch sequence');

  // A Hermes reply carrying directive-shaped text is conversational, not
  // routing: it posts verbatim and starts no provider turn.
  const callsBefore6b = fake.loadFakeState(coderState).calls.length;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') return 'DECK codex: Implement the widget.';
    return 'No response';
  });
  const user6b = messages.create(conv.id, 'user', 'What would the coding agent do?');
  uiTurns.enqueue(conv.id, origin.id);
  await drain();
  const thread6b = chainAfter(conv.id, user6b.id);
  assert(
    thread6b.some(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('DECK codex: Implement the widget.')),
    'directive-shaped Hermes reply posts as ordinary text'
  );
  assert(
    !thread6b.some(m => m.sender_type === 'bot' && m.content.startsWith('[Deck')),
    'directive-shaped Hermes reply posts no runtime observations'
  );
  assert(fake.loadFakeState(coderState).calls.length === callsBefore6b, 'directive-shaped Hermes reply starts no provider turn');
  assert(uiTurns.countPending(conv.id) === 0, 'queue drained after the directive-shaped reply');
  try { fs.rmSync(coderWorkdir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(coderState, { force: true }); } catch { /* best effort */ }

  // Scenario 9: an unconfigured bot cannot launch, so the notice names
  // the missing scope and the caller still returns to report instead of
  // stalling with its frame on the stack. No provider turn starts.
  log('\nScenario 9: unconfigured Agent returns to the caller');
  const stuck = bots.create({
    name: 'Stuck', title: 'Stuck', description: 'Never configured a scope.',
    agent: 'codex',
  });
  db.default.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(stuck.id);
  const stuckRow = bots.getById(stuck.id);
  assert(
    !!stuckRow && stuckRow.session_scope_kind === null,
    'unconfigured row stores no session scope'
  );
  const stuckState = path.join(os.tmpdir(), `botmancers-delegation-stuck-${process.pid}.json`);
  try { fs.rmSync(stuckState, { force: true }); } catch { /* fresh start */ }
  providerContract.registerSessionProvider(
    { connectionId: stuckRow.runtime_connection_id },
    () => fake.createFakeSessionProvider({ statePath: stuckState, kind: 'delegation-stuck' }),
  );
  const calls9 = {};
  agent.setDelegationChatStub(ctx => {
    calls9[ctx.botName] = (calls9[ctx.botName] || 0) + 1;
    if (ctx.botName === 'Origin' && calls9.Origin === 1) return 'WAKE Stuck: Please build the widget.';
    if (ctx.botName === 'Origin') return 'REPORT: runtime unavailable, proceeding manually.';
    return 'No response';
  });
  const user9 = messages.create(conv.id, 'user', 'Build the widget through the coding agent.');
  uiTurns.enqueue(conv.id, origin.id);
  await drain();
  const thread9 = chainAfter(conv.id, user9.id);
  assert(
    thread9.some(m => m.sender_type === 'bot' && m.sender_id === stuck.id && m.content.startsWith('[Session scope needed]')),
    'unconfigured Agent posts [Session scope needed]'
  );
  assert(fake.loadFakeState(stuckState).calls.length === 0, 'unconfigured Agent starts no provider turn');
  assert(
    thread9.some(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('REPORT: runtime unavailable')),
    'caller still reports after the refused launch (caller-managed return)'
  );
  assert(uiTurns.countPending(conv.id) === 0, 'queue drained after the refused launch');
  try { fs.rmSync(stuckState, { force: true }); } catch { /* best effort */ }

  // Scenario 10: a WAKE handoff carrying deck-mentioning text is not
  // hijacked. 'WAKE B: update the deck notes: ...' contains 'deck
  // <word>:' but must route as a WAKE handoff, not a deck directive.
  log('\nScenario 10: WAKE handoff mentioning the deck is not a directive');
  const calls10 = {};
  agent.setDelegationChatStub(ctx => {
    calls10[ctx.botName] = (calls10[ctx.botName] || 0) + 1;
    if (ctx.botName === 'Origin' && calls10.Origin === 1) return 'WAKE A: Please write the release note.';
    if (ctx.botName === 'A' && calls10.A === 1) return 'WAKE B: update the deck notes: venue added.';
    if (ctx.botName === 'B') return 'NOTED: deck notes updated.';
    if (ctx.botName === 'A') return 'Done, notes updated.';
    if (ctx.botName === 'Origin') return 'REPORT: note done.';
    return 'No response';
  });
  const user10 = messages.create(conv.id, 'user', 'Write the release note.');
  uiTurns.enqueue(conv.id, origin.id);
  await drain();
  const thread10 = chainAfter(conv.id, user10.id);
  assert(!thread10.some(m => m.content.startsWith('[Deck')), 'no deck observations for the deck-mentioning handoff');
  assert(
    thread10.some(m => m.sender_type === 'bot' && m.sender_id === botB.id && m.content.includes('NOTED: deck notes updated.')),
    'WAKE handoff mentioning the deck still reaches its delegate'
  );
  assert(
    thread10.some(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('REPORT: note done.')),
    'caller still reports after the deck-mentioning handoff'
  );
  assert(uiTurns.countPending(conv.id) === 0, 'queue drained after the deck-mentioning handoff');

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
