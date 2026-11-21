#!/usr/bin/env node
// NOT-477: UI thread delegation continuity across process restarts.
//
// Proves, with three separate processes sharing one SQLite file (each a
// restart: no process memory survives), that caller-managed delegation in
// a UI thread depends only on durable rows:
//
//   phase 1  a user message is a UI turn (Work Request); Origin hands off
//            to Helper. The handoff turn, the caller frame, the handoff
//            count, and the delegated-turn count are durable. A second
//            turn is left running (the process "dies" mid-turn).
//   phase 2  restart: the production startup recovery sequence (UI
//            interruption recovery, then recoverCoordinatorLoops) runs
//            twice and routes the completed UI WAKE no second time; the
//            interrupted turn fails (ui_turn_interrupted)
//            and is not re-run; Helper's queued turn runs and its reply
//            returns to Origin through the durable caller frame (one
//            report-back turn, parented to Helper's turn). Stop is then
//            pressed: the queued report-back is cancelled and the chain
//            is stopped.
//   phase 3  restart: Stop still holds (a new turn for the same user
//            message stays silent and nothing is posted); a later user
//            message starts a fresh chain and runs; a delegated-turn count
//            read back from the database refuses the next turn.
//
// Also checks there is no processing_queue table and no in-memory chain
// map in lib/agent.ts. Deterministic stub model; no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = require('./support/repo-root');
const PHASE = process.env.UI_RESTART_PHASE || 'main';
const DB_PATH = process.env.UI_RESTART_DB || path.join(os.tmpdir(), `botmancers-ui-restart-${process.pid}.db`);

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
}

function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* best effort */ }
  }
}

function load() {
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  delete process.env.HERMES_API_SERVER_KEY;
  const jiti = require('jiti').createJiti(__filename);
  return {
    db: jiti('../lib/db.ts'),
    agent: jiti('../lib/agent.ts'),
    ui: jiti('../lib/ui-turns.ts'),
    conversations: jiti('../lib/agent-conversations.ts'),
  };
}

function stubFor(agent) {
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      const sawHelper = ctx.sent.some(entry => entry.content.includes('HELPER RESULT'));
      return sawHelper ? 'REPORT: done.' : 'WAKE Helper: Summarize the plan.';
    }
    if (ctx.botName === 'Helper') return 'HELPER RESULT: the plan has three steps.';
    return 'No response';
  });
}

// What production startup runs (lib/agent.ts, AUTO_PROCESS) before the
// executor picks anything: UI interruption recovery, then coordinator
// follow-up recovery.
async function startupRecovery(ui, conversations) {
  const failed = ui.uiTurns.recoverInterrupted();
  await conversations.recoverCoordinatorLoops();
  return failed;
}

// A completed UI WAKE is routed once, by the UI executor: one handoff turn
// for Helper, no canonical Wake or dispatcher request, and no open
// coordinator follow-up for any UI-owned request.
function assertWakeRoutedOnce(raw, ids, label) {
  const handoffs = raw.prepare(
    "SELECT COUNT(*) AS n FROM work_requests WHERE source_conversation_id = ? AND target_agent_id = ? AND intent = 'handoff'"
  ).get(ids.conv, ids.helper).n;
  const wakes = raw.prepare('SELECT COUNT(*) AS n FROM wakes WHERE source_conversation_id = ?').get(ids.conv).n;
  const dispatched = raw.prepare("SELECT COUNT(*) AS n FROM work_requests WHERE source_conversation_id = ? AND executor = 'dispatcher'").get(ids.conv).n;
  const open = raw.prepare(`
    SELECT COUNT(*) AS n FROM terminal_followups f JOIN work_requests w ON w.id = f.request_id
    WHERE w.executor IN ('ui_message', 'ui_continuation') AND f.done_at IS NULL
  `).get().n;
  assert(handoffs === 1 && wakes === 0 && dispatched === 0 && open === 0,
    `${label}: Origin's WAKE routed once (handoffs ${handoffs}, wakes ${wakes}, dispatcher requests ${dispatched}, open UI follow-ups ${open})`);
}

function turnRows(raw, conversationId) {
  return raw.prepare(`
    SELECT id, target_agent_id, executor, state, state_reason, parent_request_id, intent FROM work_requests
    WHERE source_conversation_id = ? AND executor <> 'dispatcher' ORDER BY created_at ASC, rowid ASC
  `).all(conversationId);
}

async function phase1() {
  const { db, agent, ui } = load();
  const { bots, conversations, messages } = db;
  const raw = db.default;
  stubFor(agent);
  const origin = bots.create({ deck_id: 'deck-test', name: 'Origin', title: 'Caller', description: 'Delegates.' });
  const helper = bots.create({ deck_id: 'deck-test', name: 'Helper', title: 'Helper', description: 'Helps.' });
  const conv = conversations.getByBotId(origin.id);
  const user = messages.create(conv.id, 'user', 'Ask Helper to summarize the plan, then report.');
  const first = ui.uiTurns.enqueue(conv.id, origin.id);
  assert(await agent.processNextUiTurn(), 'Origin turn ran');

  const chain = agent.getDelegationState(conv.id);
  assert(!!chain && chain.userMessageId === user.id && chain.handoffs === 1 && chain.turns === 1, `durable chain: 1 handoff, 1 turn (got ${JSON.stringify(chain)})`);
  assert(!!chain && chain.frames.length === 1 && chain.frames[0].delegateId === helper.id && chain.frames[0].callerId === origin.id, 'durable caller frame: Helper returns to Origin');
  const rows = turnRows(raw, conv.id);
  const handoff = rows.find(row => row.target_agent_id === helper.id);
  assert(rows[0].id === first.id && rows[0].state === 'completed', "Origin's turn is a completed Work Request");
  assert(!!handoff && handoff.state === 'queued' && handoff.intent === 'handoff' && handoff.parent_request_id === first.id && handoff.executor === 'ui_continuation',
    "Helper's handoff turn is a queued Work Request parented to Origin's turn");

  // A turn in flight when the process dies.
  const inflight = ui.uiTurns.enqueue(conv.id, helper.id, { reason: 'tick' });
  ui.uiTurns.start(inflight.id);
  return { conv: conv.id, user: user.id, origin: origin.id, helper: helper.id, first: first.id, handoff: handoff && handoff.id, inflight: inflight.id };
}

async function phase2(ids) {
  const { db, agent, ui, conversations } = load();
  const { messages, engine } = db;
  stubFor(agent);
  const raw = db.default;
  assert(engine.getWorkRequest(ids.inflight).state === 'running', 'after restart: the in-flight turn is still running in the database');
  assertWakeRoutedOnce(raw, ids, 'before startup recovery');
  assert(await startupRecovery(ui, conversations) === 1, 'startup reconciliation fails exactly the one interrupted UI turn');
  assertWakeRoutedOnce(raw, ids, 'after startup recovery');
  assert(await startupRecovery(ui, conversations) === 0, 'a repeated startup recovery fails nothing more');
  assertWakeRoutedOnce(raw, ids, 'after a repeated startup recovery');
  const interrupted = engine.getWorkRequest(ids.inflight);
  assert(interrupted.state === 'failed' && interrupted.error_code === 'ui_turn_interrupted', 'the interrupted turn is failed (ui_turn_interrupted), not re-run');

  const chain = agent.getDelegationState(ids.conv);
  assert(!!chain && chain.handoffs === 1 && chain.turns === 1 && chain.frames.length === 1, 'after restart: handoffs, turns, and the caller frame are intact');

  assert(await agent.processNextUiTurn(), "Helper's handoff turn runs after the restart");
  const helperReply = messages.getByConversation(ids.conv).find(m => m.sender_id === ids.helper && m.content.startsWith('HELPER RESULT'));
  assert(!!helperReply, 'Helper replied in the same thread');
  const afterHelper = agent.getDelegationState(ids.conv);
  assert(afterHelper.frames.length === 0 && afterHelper.turns === 2, 'the caller frame was consumed and the delegated turn counted');
  const reportBack = turnRows(raw, ids.conv).find(row => row.intent === 'report_back');
  assert(!!reportBack && reportBack.target_agent_id === ids.origin && reportBack.parent_request_id === ids.handoff && reportBack.state === 'queued',
    "the reply returns to Origin: one queued report-back turn parented to Helper's turn");
  assert(engine.getWorkRequest(ids.handoff).state === 'completed', "Helper's turn completed");

  const before = messages.getByConversation(ids.conv).length;
  assert(agent.stopDelegation(ids.conv) === true, 'Stop reports something stopped');
  assert(engine.getWorkRequest(reportBack.id).state === 'cancelled' && engine.getWorkRequest(reportBack.id).state_reason === 'stopped', 'Stop cancels the queued report-back turn (reason stopped)');
  assert(agent.getDelegationState(ids.conv).stopped === true, 'the chain is stopped in the database');
  assert(messages.getByConversation(ids.conv).length === before + 1, 'Stop posts exactly its notice');
  return { ...ids, reportBack: reportBack && reportBack.id };
}

async function phase3(ids) {
  const { db, agent, ui, conversations } = load();
  const { messages, engine } = db;
  stubFor(agent);
  const raw = db.default;
  await startupRecovery(ui, conversations);
  assertWakeRoutedOnce(raw, ids, 'after the second restart');
  assert(agent.getDelegationState(ids.conv).stopped === true, 'after restart: Stop still holds');
  const before = messages.getByConversation(ids.conv).length;
  const again = ui.uiTurns.enqueue(ids.conv, ids.origin, { reason: 'tick' });
  await agent.processNextUiTurn();
  assert(messages.getByConversation(ids.conv).length === before, 'a turn for the stopped user message stays silent after the restart');
  assert(engine.getWorkRequest(again.id).state === 'completed', 'the silent turn still finishes its Work Request');

  // The budget is read from the database on every turn: a count written
  // to the fresh chain's row is enforced on the next turn.
  const fresh = messages.create(ids.conv, 'user', 'Report the plan now.');
  ui.uiTurns.enqueue(ids.conv, ids.origin);
  await agent.processNextUiTurn();
  const chain = agent.getDelegationState(ids.conv);
  assert(chain.userMessageId === fresh.id && chain.stopped === false, 'a later user message starts a fresh, unstopped chain');
  const old = raw.prepare('SELECT * FROM delegation_chains WHERE conversation_id = ? AND user_message_id = ?').get(ids.conv, ids.user);
  assert(old && old.stopped === 1 && old.turns === 2 && old.handoffs === 1, 'the earlier chain row is kept as it was');
  raw.prepare('UPDATE delegation_chains SET turns = ? WHERE conversation_id = ? AND user_message_id = ?').run(agent.DELEGATION_MAX_DELEGATED_TURNS, ids.conv, fresh.id);
  const spent = messages.getByConversation(ids.conv).length;
  ui.uiTurns.enqueue(ids.conv, ids.origin);
  await agent.processNextUiTurn();
  const after = messages.getByConversation(ids.conv);
  assert(after.length === spent + 1 && after[after.length - 1].content === agent.DELEGATION_BUDGET_REASON, 'a durable budget count refuses the next turn with the budget reason');
  assert(ui.uiTurns.countPending(ids.conv) === 0, 'nothing is left queued');
  await startupRecovery(ui, conversations);
  assertWakeRoutedOnce(raw, ids, 'after every turn and a final startup recovery');
}

async function runChild(phase, ids) {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: ROOT,
    env: { ...process.env, UI_RESTART_PHASE: phase, UI_RESTART_DB: DB_PATH, UI_RESTART_IDS: JSON.stringify(ids || {}) },
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    failures++;
    console.log(`  FAIL: ${phase} exited ${result.status}`);
    return null;
  }
  const marker = result.stdout.split('\n').find(line => line.startsWith('IDS '));
  return marker ? JSON.parse(marker.slice(4)) : ids;
}

async function main() {
  if (PHASE !== 'main') {
    const ids = JSON.parse(process.env.UI_RESTART_IDS || '{}');
    const next = PHASE === 'phase1' ? await phase1() : PHASE === 'phase2' ? await phase2(ids) : await phase3(ids);
    if (next) console.log(`IDS ${JSON.stringify(next)}`);
    process.exit(failures > 0 ? 1 : 0);
  }
  removeDb(DB_PATH);
  console.log('NOT-477 UI thread delegation across restarts');
  const source = fs.readFileSync(path.join(ROOT, 'lib/agent.ts'), 'utf8');
  assert(!/new Map<string, DelegationChain>|delegationChains/.test(source), 'lib/agent.ts holds no in-memory delegation chain map');
  console.log('\nPhase 1');
  const ids1 = await runChild('phase1');
  console.log('\nPhase 2 (restart)');
  const ids2 = ids1 && await runChild('phase2', ids1);
  console.log('\nPhase 3 (restart)');
  if (ids2) await runChild('phase3', ids2);
  const Database = require('better-sqlite3');
  const check = new Database(DB_PATH, { readonly: true });
  assert(!check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'processing_queue'").get(), 'no processing_queue table exists');
  check.close();
  removeDb(DB_PATH);
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
