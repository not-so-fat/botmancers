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
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const deckRun = jiti('./lib/agent-deck-run.ts');

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
  log('Deterministic stub serves all turns (no external model key required)');

  const MAX_DEPTH = agent.DELEGATION_MAX_DEPTH;
  const MAX_TURNS = agent.DELEGATION_MAX_DELEGATED_TURNS;
  assert(typeof MAX_DEPTH === 'number' && MAX_DEPTH > 0, `depth constant imported (DELEGATION_MAX_DEPTH=${MAX_DEPTH})`);
  assert(typeof MAX_TURNS === 'number' && MAX_TURNS > 0, `budget constant imported (DELEGATION_MAX_DELEGATED_TURNS=${MAX_TURNS})`);

  const origin = bots.create({ deck_id: 'deck-test', name: 'Origin', title: 'Caller', description: 'Originates delegations.' });
  const botA = bots.create({ deck_id: 'deck-test', name: 'A', title: 'Drafter', description: 'Drafts.' });
  const botB = bots.create({ deck_id: 'deck-test', name: 'B', title: 'Checker', description: 'Checks drafts.' });
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
  assert(!(seenBy.A || '').includes('DECK'), 'delegate prompt never presents a DECK directive to the model');
  assert(!(seenBy.A || '').includes('agent-deck'), 'delegate prompt names no Agent Deck launch path (routing is stored, not prompted)');
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

  // Scenario 5: agent-deck coding delegation (NOT-395 adapter). From the same
  // conversation the caller drives an implementation run, a reviewer run,
  // and a resume of the original session through the injected agent-deck
  // process boundary. No manual prompt or session-ID copying: the resume
  // receives the original session ID straight from the bound run's status.
  log('\nScenario 5: agent-deck implement/review/resume in the originating thread');
  const deckRecorded = [];
  let deckRuns = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded.push(argv);
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      // The implementation run owns the stable fixture session ID, and the
      // resumed run reports that ORIGINAL session ID back: resume never
      // forks the session.
      const sessionId = runId === 'run-deck-2' ? `ses-for-${runId}` : 'ses-deck-impl';
      return {
        stdout: JSON.stringify({
          runId,
          deck: 'deck-id-9',
          client: 'codex',
          state: 'ended',
          sessionId,
          startedAt: '2026-10-12T00:00:00.000Z',
          lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const body = runId === 'run-deck-2' ? 'review says: add the venue' : `output of ${runId}`;
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: body }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      deckRuns++;
      const runId = `run-deck-${deckRuns}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  const user5 = messages.create(conv.id, 'user', 'Build the widget via the coding agent.');
  const delegation = await deckRun.delegateCodingViaDeck({
    conversationId: conv.id,
    botId: origin.id,
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    task: 'Implement the widget.',
    reviewFocus: 'Check the edge cases.',
  });
  deckRun.setDeckRunProcess(null);

  const thread5 = chainAfter(conv.id, user5.id);
  const observedTypes = thread5
    .filter(m => m.sender_type === 'bot' && m.sender_id === origin.id)
    .map(m => (m.content.match(/^\[(Deck [a-z]+)\]/) || [])[1])
    .filter(Boolean);
  log(`  observation types: ${observedTypes.join(' -> ')}`);
  assert(
    JSON.stringify(observedTypes) === JSON.stringify(['Deck handoff', 'Deck run', 'Deck review', 'Deck resume', 'Deck result']),
    'ordered observations: handoff, session-bound run, review, resume, final result'
  );
  assert(
    thread5.every(m => m.conversation_id === conv.id),
    'all deck observations live in the originating thread'
  );
  const resumeStart = deckRecorded.find(a => a[1] === 'run' && a.includes('--resume'));
  assert(
    !!resumeStart && resumeStart.includes('ses-deck-impl'),
    'resume receives the original session ID (session-reuse)'
  );
  assert(!!delegation, 'delegation completes with a result');
  // NOT-462: phase authority is fixed at the composite boundary:
  // implementation edits, review is read-only, revision edits again.
  const toolsOf = argv => argv[argv.indexOf('--tools') + 1];
  const launches5 = deckRecorded.filter(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'planner');
  log(`  launch tools: ${launches5.map(toolsOf).join(' -> ')}`);
  assert(launches5.length === 3, 'three Agent Deck launches: implement, review, resume');
  assert(
    !!launches5[0] && toolsOf(launches5[0]) === 'edit' && !launches5[0].includes('--resume') &&
    launches5[0].includes('Implement the widget.'),
    'implementation launch uses --tools edit'
  );
  assert(
    !!launches5[1] && toolsOf(launches5[1]) === 'readonly' && !launches5[1].includes('--resume'),
    'review launch uses --tools readonly'
  );
  assert(
    !!launches5[2] && toolsOf(launches5[2]) === 'edit' &&
    launches5[2][launches5[2].indexOf('--resume') + 1] === 'ses-deck-impl',
    'revision resumes the original builder session with --tools edit'
  );
  assert(
    deckRun.DECK_DELEGATION_PHASE_TOOLS.implement === 'edit' &&
    deckRun.DECK_DELEGATION_PHASE_TOOLS.review === 'readonly' &&
    deckRun.DECK_DELEGATION_PHASE_TOOLS.revise === 'edit' &&
    Object.isFrozen(deckRun.DECK_DELEGATION_PHASE_TOOLS),
    'delegation phase profiles are frozen constants (edit -> readonly -> edit)'
  );
  const followArgv = deckRecorded.find(a => a[1] === 'run' && a[2] === 'log' && a.includes('--follow'));
  assert(!!followArgv, 'completion comes from run log --follow, not adapter polling');
  assert(
    !!deckRecorded.find(a => a[1] === 'run' && a[2] === 'status' && a[3] === 'run-deck-3'),
    'resume run status is read, so the session is honored from status rather than the fallback'
  );
  assert(
    delegation.implSessionId === 'ses-deck-impl' && delegation.resumedSessionId === 'ses-deck-impl',
    'resumed session ID is unchanged from the implementation session ID'
  );
  assert(
    !!thread5.find(m => m.content.startsWith('[Deck run]') && m.content.includes('run-deck-1') && m.content.includes('ses-deck-impl')),
    'bound run/session observation correlates run ID and session ID'
  );
  assert(queue.countPending(conv.id) === 0, 'no queue residue from the deck delegation');

  // NOT-462 negative: a stale caller still passing the removed delegation
  // `tools` option cannot downgrade implementation/revision or broaden review.
  const deckRecorded5b = [];
  let deckRuns5b = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded5b.push(argv);
    if (argv[2] === 'status') {
      return { stdout: JSON.stringify({ runId: argv[3], deck: 'planner', client: 'codex', state: 'ended', sessionId: 'ses-5b' }), stderr: '', exitCode: 0 };
    }
    if (argv[2] === 'log') {
      const lines = [
        JSON.stringify({ t: 'result', sessionId: 'ses-5b', subtype: 'success', result: `output of ${argv[3]}` }),
        JSON.stringify({ t: 'end', sessionId: 'ses-5b' }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    deckRuns5b++;
    return { stdout: `run run-5b-${deckRuns5b} detached: pid 1 log /tmp/fake-deck/5b/run.jsonl\n`, stderr: '', exitCode: 0 };
  });
  for (const staleTools of ['readonly', 'edit']) {
    deckRecorded5b.length = 0;
    await deckRun.delegateCodingViaDeck({
      conversationId: conv.id,
      botId: origin.id,
      deck: 'planner',
      client: 'codex',
      cwd: '/repo/checkout',
      task: 'Implement the widget again.',
      reviewFocus: 'Check the edge cases.',
      tools: staleTools,
    });
    const tools5b = deckRecorded5b.filter(a => a[2] === 'planner').map(toolsOf);
    assert(
      JSON.stringify(tools5b) === JSON.stringify(['edit', 'readonly', 'edit']),
      `stale delegation tools=${staleTools} is ignored (got ${tools5b.join(' -> ')})`
    );
  }
  deckRun.setDeckRunProcess(null);

  // NOT-483: an Agent Deck 2.1.1 run that ends successfully with an object
  // in the terminal result payload fails closed at that run: one bounded
  // [Deck failed] naming the run ID, no empty [Deck review], no later phase.
  for (const [phase, badRunIndex] of [['implementation', 1], ['review', 2]]) {
    const recorded5c = [];
    let runs5c = 0;
    const badRunId = `run-5c-${phase}-${badRunIndex}`;
    deckRun.setDeckRunProcess(async argv => {
      recorded5c.push(argv);
      if (argv[2] === 'status') {
        return { stdout: JSON.stringify({ runId: argv[3], deck: 'planner', client: 'codex', state: 'ended', sessionId: 'ses-5c' }), stderr: '', exitCode: 0 };
      }
      if (argv[2] === 'log') {
        const result = argv[3] === badRunId ? { type: 'text', text: 'final answer' } : `output of ${argv[3]}`;
        const lines = [
          JSON.stringify({ t: 'text', ts: '2026-10-14T00:41:40.000Z', text: 'final answer' }),
          JSON.stringify({ t: 'result', sessionId: 'ses-5c', subtype: 'success', result }),
          JSON.stringify({ t: 'end', sessionId: 'ses-5c' }),
        ].join('\n') + '\n';
        return { stdout: lines, stderr: '', exitCode: 0 };
      }
      runs5c++;
      return { stdout: `run run-5c-${phase}-${runs5c} detached: pid 1 log /tmp/fake-deck/5c/run.jsonl\n`, stderr: '', exitCode: 0 };
    });
    const user5c = messages.create(conv.id, 'user', `Build the widget (${phase} result is malformed).`);
    let error5c = null;
    try {
      await deckRun.delegateCodingViaDeck({
        conversationId: conv.id,
        botId: origin.id,
        deck: 'planner',
        client: 'codex',
        cwd: '/repo/checkout',
        task: 'Implement the widget.',
        reviewFocus: 'Check the edge cases.',
      });
    } catch (error) {
      error5c = String(error);
    }
    deckRun.setDeckRunProcess(null);
    const thread5c = chainAfter(conv.id, user5c.id);
    const launches5c = recorded5c.filter(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'planner');
    const failed5c = thread5c.filter(m => m.content.startsWith('[Deck failed]'));
    assert(
      !!error5c && error5c.includes(badRunId) && error5c.includes('result contract mismatch') && !error5c.includes('--prompt'),
      `${phase} object result fails at its own run boundary (${error5c})`
    );
    assert(
      launches5c.length === badRunIndex && !launches5c.some(a => a.includes('--resume')),
      `${phase} object result launches no later phase (launches=${launches5c.length})`
    );
    assert(
      failed5c.length === 1 && failed5c[0].content.includes(badRunId) &&
      failed5c[0].content.includes('got object') && failed5c[0].content.length <= 400,
      `${phase} object result records one bounded [Deck failed] with the run ID`
    );
    assert(
      !thread5c.some(m => m.content.startsWith('[Deck review]') || m.content.startsWith('[Deck resume]') || m.content.startsWith('[Deck result]')),
      `${phase} object result records no successful review, resume, or result`
    );
  }

  // Scenario 6: single-runtime direct dispatch. An ordinary message to
  // an agent-deck bot launches the stored agent/deck/workdir directly
  // from the queue loop (no Hermes turn first, no model-reply directive
  // parsed); a Hermes reply that literally contains `DECK codex: ...`
  // is posted as ordinary text and launches nothing.
  log('\nScenario 6: direct dispatch from the stored runtime via the queue');
  const coder = bots.create({ deck_id: 'deck-test', name: 'Coder', title: 'Coder', description: 'Builds widgets.' });
  const coderWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-coder-workdir-'));
  db.bots.updateAgentSelection(coder.id, {
    agent: 'codex', deck_id: 'deck-id-9', working_directory: coderWorkdir,
  });
  const coderConv = conversations.getByBotId(coder.id);
  const deckRecorded6 = [];
  let deckRuns6 = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded6.push(argv);
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      const sessionId = runId === 'run-deck-2' ? `ses-for-${runId}` : 'ses-deck-impl';
      return {
        stdout: JSON.stringify({
          runId, deck: 'deck-id-9', client: 'codex', state: 'ended', sessionId,
          startedAt: '2026-10-12T00:00:00.000Z', lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const body = runId === 'run-deck-2' ? 'review says: add the venue' : `output of ${runId}`;
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: body }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      deckRuns6++;
      const runId = `run-deck-${deckRuns6}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  agent.setDelegationChatStub(() => {
    throw new Error('Hermes adapter must not run for an agent-deck turn');
  });
  const user6 = messages.create(coderConv.id, 'user', 'Build the widget through the coding agent.');
  queue.enqueue(coderConv.id, coder.id);
  await drain();
  deckRun.setDeckRunProcess(null);

  const thread6 = chainAfter(coderConv.id, user6.id);
  const observed6 = thread6
    .filter(m => m.sender_type === 'bot' && m.sender_id === coder.id)
    .map(m => (m.content.match(/^\[(Deck [a-z]+)\]/) || [])[1])
    .filter(Boolean);
  log(`  observation types: ${observed6.join(' -> ')}`);
  assert(
    JSON.stringify(observed6) === JSON.stringify(['Deck handoff', 'Deck run', 'Deck review', 'Deck resume', 'Deck result']),
    'direct dispatch posts the ordered deck observations'
  );
  const implStart6 = deckRecorded6.find(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'deck-id-9');
  assert(
    !!implStart6 && implStart6.includes('--client') && implStart6.includes('codex') &&
    implStart6.includes('--cwd') && implStart6.includes(coderWorkdir),
    'direct dispatch launches the stored agent/deck/workdir without parsing a directive'
  );
  const launches6 = deckRecorded6.filter(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'deck-id-9');
  assert(
    JSON.stringify(launches6.map(a => a[a.indexOf('--tools') + 1])) === JSON.stringify(['edit', 'readonly', 'edit']),
    'queue-driven composite workflow launches edit -> readonly -> edit'
  );
  const resumeStart6 = deckRecorded6.find(a => a[1] === 'run' && a.includes('--resume'));
  assert(!!resumeStart6 && resumeStart6.includes('ses-deck-impl'), 'direct dispatch resume reuses the original session ID');
  const chain6 = agent.getDelegationState(coderConv.id);
  assert(!!chain6 && chain6.handoffs === 0 && chain6.turns === 1, `direct dispatch consumes a turn, not a handoff (handoffs=${chain6 ? chain6.handoffs : '?'}, turns=${chain6 ? chain6.turns : '?'})`);
  assert(thread6.every(m => m.conversation_id === coderConv.id), 'all direct-dispatch observations stay in the originating thread');
  assert(queue.countPending(coderConv.id) === 0, 'queue drained after the direct-dispatch sequence');

  // A Hermes reply carrying directive-shaped text is conversational, not
  // routing: it posts verbatim and starts no deck run.
  const deckRecorded6b = [];
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded6b.push(argv);
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') return 'DECK codex: Implement the widget.';
    return 'No response';
  });
  const user6b = messages.create(conv.id, 'user', 'What would the coding agent do?');
  queue.enqueue(conv.id, origin.id);
  await drain();
  deckRun.setDeckRunProcess(null);
  const thread6b = chainAfter(conv.id, user6b.id);
  assert(
    thread6b.some(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('DECK codex: Implement the widget.')),
    'directive-shaped Hermes reply posts as ordinary text'
  );
  assert(
    !thread6b.some(m => m.sender_type === 'bot' && m.content.startsWith('[Deck')),
    'directive-shaped Hermes reply posts no deck observations'
  );
  assert(deckRecorded6b.length === 0, 'directive-shaped Hermes reply starts no deck run');
  assert(queue.countPending(conv.id) === 0, 'queue drained after the directive-shaped reply');
  try { fs.rmSync(coderWorkdir, { recursive: true, force: true }); } catch { /* best effort */ }

  // Scenario 7: Stop halts an in-flight deck sequence. The status wait is
  // gated; Stop lands while it is gated; the sequence returns null
  // silently with no review/resume runs and no late observations.
  log('\nScenario 7: Stop during a deck sequence');
  let gateResolve7 = null;
  const gate7 = new Promise(resolve => { gateResolve7 = resolve; });
  let gateOpen7 = false;
  const deckRecorded7 = [];
  let deckRuns7 = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded7.push(argv);
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      if (!gateOpen7) await gate7;
      const runId = argv[3];
      return {
        stdout: JSON.stringify({
          runId, deck: 'planner', client: 'codex', state: 'ended', sessionId: 'ses-deck-impl',
          startedAt: '2026-10-12T00:00:00.000Z', lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: `output of ${runId}` }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      deckRuns7++;
      const runId = `run-deck-${deckRuns7}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  const user7 = messages.create(conv.id, 'user', 'Build the slow widget via the coding agent.');
  queue.enqueue(conv.id, origin.id); // gives Stop something queued to cancel, like a real mid-chain Stop
  const pending7 = deckRun.delegateCodingViaDeck({
    conversationId: conv.id,
    botId: origin.id,
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    task: 'Implement the slow widget.',
    reviewFocus: 'Check the edge cases.',
    isStopped: () => (agent.getDelegationState(conv.id)?.stopped ?? false),
  });
  for (let i = 0; i < 400 && !deckRecorded7.some(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'planner'); i++) {
    await sleep(5);
  }
  assert(deckRecorded7.some(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] === 'planner'), 'implementation run started before Stop');
  const stopped7 = agent.stopDelegation(conv.id);
  assert(stopped7 === true, 'stopDelegation reports something stopped');
  gateOpen7 = true;
  gateResolve7();
  const delegation7 = await pending7;
  deckRun.setDeckRunProcess(null);
  assert(delegation7 === null, 'stopped deck sequence returns null silently');
  const starts7 = deckRecorded7.filter(a => a[0] === 'agent-deck' && a[1] === 'run' && a[2] !== 'status' && a[2] !== 'log');
  assert(starts7.length === 1, `no review/resume run starts after Stop (starts=${starts7.length})`);
  const thread7 = chainAfter(conv.id, user7.id);
  const deckMsgs7 = thread7.filter(m => m.sender_type === 'bot' && m.content.startsWith('[Deck'));
  assert(
    deckMsgs7.length === 1 && deckMsgs7[0].content.startsWith('[Deck handoff]'),
    'only the handoff predates Stop; Stop promises no late messages'
  );
  assert(thread7.some(m => m.content.includes('Delegation stopped')), 'stopped notice in thread');
  await drain();
  assert(queue.countPending(conv.id) === 0, 'queue drained after Stop');

  // Scenario 8: a resumed run that forks the session fails closed: the
  // adapter throws, posts [Deck failed] naming the fork, and posts no
  // resume observation and no final result.
  log('\nScenario 8: resumed session fork fails closed');
  const deckRecorded8 = [];
  let deckRuns8 = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded8.push(argv);
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      const sessionId = runId === 'run-deck-3' ? 'ses-FORKED' : 'ses-deck-impl';
      return {
        stdout: JSON.stringify({
          runId, deck: 'planner', client: 'codex', state: 'ended', sessionId,
          startedAt: '2026-10-12T00:00:00.000Z', lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: `output of ${runId}` }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      deckRuns8++;
      const runId = `run-deck-${deckRuns8}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  const user8 = messages.create(conv.id, 'user', 'Build the forking widget via the coding agent.');
  let forkError = null;
  try {
    await deckRun.delegateCodingViaDeck({
      conversationId: conv.id,
      botId: origin.id,
      deck: 'planner',
      client: 'codex',
      cwd: '/repo/checkout',
      task: 'Implement the forking widget.',
      reviewFocus: 'Check the edge cases.',
    });
  } catch (error) {
    forkError = error;
  }
  deckRun.setDeckRunProcess(null);
  assert(!!forkError && /fork/i.test(String(forkError)), 'forked resume throws a session-fork error');
  const thread8 = chainAfter(conv.id, user8.id);
  assert(
    thread8.some(m => m.content.startsWith('[Deck failed]') && /fork/i.test(m.content)),
    '[Deck failed] names the fork'
  );
  assert(!thread8.some(m => m.content.startsWith('[Deck resume]')), 'no resume observation after a fork');
  assert(!thread8.some(m => m.content.startsWith('[Deck result]')), 'no final result after a fork');

  // Scenario 9: a bot that still needs Agent Deck selection cannot launch,
  // so the notice names the legacy deck and the caller still returns to
  // report instead of stalling with its frame on the stack. No deck run
  // starts and no deck ID is guessed from the legacy name.
  log('\nScenario 9: needs-deck-selection returns to the caller');
  const stuck = bots.create({
    name: 'Stuck', title: 'Stuck', description: 'Migrated before a deck was selected.',
    agent: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/stuck-work',
  });
  const stuckRow = bots.getById(stuck.id);
  assert(
    !!stuckRow && stuckRow.deck_id === null && Number(stuckRow.needs_deck_selection) === 1,
    'needs-deck-selection row stores no deck ID with the marker set'
  );
  const deckRecorded9 = [];
  deckRun.setDeckRunProcess(async argv => {
    deckRecorded9.push(argv);
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  const calls9 = {};
  agent.setDelegationChatStub(ctx => {
    calls9[ctx.botName] = (calls9[ctx.botName] || 0) + 1;
    if (ctx.botName === 'Origin' && calls9.Origin === 1) return 'WAKE Stuck: Please build the widget.';
    if (ctx.botName === 'Origin') return 'REPORT: deck unavailable, proceeding manually.';
    return 'No response';
  });
  const user9 = messages.create(conv.id, 'user', 'Build the widget through the coding agent.');
  queue.enqueue(conv.id, origin.id);
  await drain();
  deckRun.setDeckRunProcess(null);
  const thread9 = chainAfter(conv.id, user9.id);
  assert(
    thread9.some(m => m.sender_type === 'bot' && m.sender_id === stuck.id && m.content.startsWith('[Deck needs selection]') && m.content.includes('relay-deck')),
    'unresolved deck posts [Deck needs selection] naming the legacy deck'
  );
  assert(deckRecorded9.length === 0, 'unresolved deck starts no deck run and guesses no deck ID');
  assert(
    thread9.some(m => m.sender_type === 'bot' && m.sender_id === origin.id && m.content.includes('REPORT: deck unavailable')),
    'caller still reports after the refused launch (caller-managed return)'
  );
  assert(queue.countPending(conv.id) === 0, 'queue drained after the refused launch');

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
  queue.enqueue(conv.id, origin.id);
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
  assert(queue.countPending(conv.id) === 0, 'queue drained after the deck-mentioning handoff');

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
