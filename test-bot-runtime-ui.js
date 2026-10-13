#!/usr/bin/env node
// NOT-437: bot runtime/deck UI regression coverage.
//
// Proves, without a browser: (1) New Bot submits coding runtime, deck
// name, and working directory through the real POST /api/bots handler and
// the saved bot reads back Hermes chat runtime plus coding runtime · deck;
// (2) the picker lists only backend-ready launch paths and legacy data
// renders the honest unconfigured/unavailable states; (3) handoff, bound
// session, review, resume, final result, and failure observations render in
// order inside the originating thread via the real NOT-395 adapter.
// Self-contained: isolated SQLite file, injected process seam at the
// agent-deck boundary. No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-bot-runtime-ui-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const def = jiti('./lib/bot-definition.ts');
const agent = jiti('./lib/agent.ts');
const deck = jiti('./lib/agent-deck-run.ts');
const ui = jiti('./lib/bot-runtime-ui.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
const availabilityRoute = jiti('./app/api/bots/availability/route.ts');

const { bots, conversations, messages } = db;

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

function postBot(body) {
  return botsRoute.POST(new Request('http://localhost:43123/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// Fake local machine: only the Codex launch path plus the agent-deck CLI
// are installed, so only Codex may ever be advertised as available.
const resumeSessions = {};
let runCounter = 0;
let failImplLog = false;

deck.setDeckRunProcess(async argv => {
  if (argv[0] === 'codex' && argv[1] === '--version') {
    return { stdout: 'codex-cli 0.157.1\n', stderr: '', exitCode: 0 };
  }
  if ((argv[0] === 'claude' || argv[0] === 'cursor' || argv[0] === 'muse') && argv[1] === '--version') {
    return { stdout: '', stderr: `command not found: ${argv[0]}`, exitCode: 127 };
  }
  if (argv[0] === 'agent-deck' && argv[1] === '--version') {
    return { stdout: 'agent-deck 2.1.0\n', stderr: '', exitCode: 0 };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
    const runId = argv[3];
    const sessionId = resumeSessions[runId] || `ses-opaque-for-${runId}`;
    return {
      stdout: JSON.stringify({
        runId, deck: 'planner', client: 'codex', state: 'ended',
        sessionId, logPath: `/tmp/fake-runs/${runId}/run.jsonl`,
      }),
      stderr: '',
      exitCode: 0,
    };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
    const runId = argv[3];
    if (failImplLog) {
      const lines = [
        JSON.stringify({ t: 'text', text: 'working' }),
        JSON.stringify({ t: 'error', message: 'agent-deck run run-9f2c died' }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    const lines = [
      JSON.stringify({ t: 'text', text: 'working' }),
      JSON.stringify({ t: 'result', sessionId: resumeSessions[runId] || `ses-opaque-for-${runId}`, result: `done by ${runId}` }),
      JSON.stringify({ t: 'end', sessionId: resumeSessions[runId] || `ses-opaque-for-${runId}` }),
    ].join('\n') + '\n';
    return { stdout: lines, stderr: '', exitCode: 0 };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run') {
    runCounter++;
    const runId = `run-fake-${runCounter}`;
    const resumeIdx = argv.indexOf('--resume');
    if (resumeIdx >= 0) resumeSessions[runId] = argv[resumeIdx + 1];
    return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-runs/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
});

async function main() {
  log('NOT-437 bot runtime UI test (real handlers, isolated DB, stub deck runs)');
  log(`DB: ${DB_PATH}`);
  agent.setDelegationChatStub(async () => 'hello there');

  // 1. New Bot submits the coding path; the saved bot reads back Hermes
  // plus coding runtime · deck.
  log('\nNew Bot create/read/render');
  const readyAvailability = { status: 'ready', runtimes: ['codex'] };
  const submitBody = ui.newBotSubmitBody({
    name: 'Alice',
    availability: readyAvailability,
    codingRuntime: 'codex',
    deckName: 'planner',
    workingDirectory: '/Users/you/workspace/codes/botmancers',
  });
  assert(
    submitBody.name === 'Alice' &&
    submitBody.launchable === true &&
    submitBody.coding_runtime === 'codex' &&
    submitBody.deck_name === 'planner' &&
    submitBody.working_directory === '/Users/you/workspace/codes/botmancers',
    'create: New Bot submits coding runtime, deck name, and working directory'
  );
  const created = await postBot(submitBody);
  assert(created.status === 200, `create: POST /api/bots accepts the coding path (got ${created.status})`);
  const saved = await created.json();
  assert(saved.persistent_runtime === 'hermes', 'read: saved bot chats via Hermes');
  assert(
    saved.coding_runtime === 'codex' && saved.deck_name === 'planner' &&
    saved.working_directory === '/Users/you/workspace/codes/botmancers' &&
    saved.coding_configured === true,
    'read: saved bot stores the coding runtime, deck, and working directory'
  );
  const listed = await botsRoute.GET();
  const listedBody = await listed.json();
  const listedAlice = listedBody.find(bot => bot.id === saved.id);
  assert(
    !!listedAlice && listedAlice.persistent_runtime === 'hermes' && listedAlice.coding_configured === true,
    'read: GET /api/bots lists the Hermes chat runtime and configured coding path'
  );
  const roster = ui.rosterRuntimeLines(saved, readyAvailability);
  assert(roster.chat === 'Chat: Hermes', 'render: roster shows the Hermes chat runtime');
  assert(roster.code === 'Code: codex · planner', 'render: roster shows coding runtime · deck');
  const config = ui.configCodingPathLines(saved);
  assert(config.chat === 'Chat: Hermes (fixed)', 'render: config shows the fixed Hermes chat runtime');
  assert(config.code === 'Code: codex · planner', 'render: config shows coding runtime · deck');
  assert(config.workingDirectory === '/Users/you/workspace/codes/botmancers', 'render: config shows the working directory');

  // 2. The picker holds only backend-ready launch paths; legacy data
  // renders honest unconfigured/unavailable states.
  log('\nPicker choices and legacy states');
  const probePayload = await (await availabilityRoute.GET()).json();
  assert(
    Array.isArray(probePayload.runtimes) &&
    probePayload.runtimes.length === 1 &&
    probePayload.runtimes[0].runtime === 'codex' &&
    probePayload.runtimes[0].launchable === true,
    'ready: availability advertises only the probe-ready codex launch path'
  );
  const options = ui.runtimeOptions(probePayload);
  assert(options.length === 1 && options[0] === 'codex', 'ready: picker contains only backend-ready launch paths');
  assert(
    ui.runtimeOptions({ runtimes: [{ runtime: 'codex', launchable: true }, { runtime: 'claude', launchable: false }] }).join(',') === 'codex',
    'ready: picker mirrors exactly the launchable availability entries'
  );
  assert(
    def.buildAvailabilityPayload(['codex', 'bogus']).runtimes.length === 1,
    'ready: unknown runtimes never enter the availability payload'
  );
  const legacyRes = await postBot({ name: 'Imported Bot' });
  const legacy = await legacyRes.json();
  const legacyRoster = ui.rosterRuntimeLines(legacy, readyAvailability);
  assert(
    legacyRoster.chat === 'Chat: Hermes' && legacyRoster.code === 'Code: not set — add it in Config.',
    'legacy: roster renders the honest unconfigured state'
  );
  const legacyConfig = ui.configCodingPathLines(legacy);
  assert(
    legacyConfig.code === 'Code: not configured — this bot chats only.' && legacyConfig.workingDirectory === null,
    'legacy: config renders the honest unconfigured state'
  );
  await botsRoute.PATCH(new Request('http://localhost:43123/api/bots', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: legacy.id, coding_runtime: 'claude', deck_name: 'planner', working_directory: '/tmp/stale' }),
  }));
  const stale = bots.getById(legacy.id);
  const staleRoster = ui.rosterRuntimeLines(stale, readyAvailability);
  assert(
    staleRoster.code === 'Code: claude · planner (not verified — see Config).',
    'unavailable: roster marks the stored-but-unverified path without inventing a value'
  );
  const emptyBody = ui.newBotSubmitBody({
    name: 'Bobby', availability: { status: 'empty', runtimes: [] },
    codingRuntime: 'codex', deckName: 'typed-anyway', workingDirectory: '/tmp/typed',
  });
  assert(
    !('coding_runtime' in emptyBody) && !('deck_name' in emptyBody) &&
    !('working_directory' in emptyBody) && !('launchable' in emptyBody),
    'unavailable: empty probe submits a fully unconfigured bot (typed text discarded)'
  );
  const errorBody = ui.newBotSubmitBody({
    name: 'Casey', availability: { status: 'error', runtimes: [] },
    codingRuntime: '', deckName: '', workingDirectory: '',
  });
  assert(
    !('coding_runtime' in errorBody) && !('launchable' in errorBody),
    'unavailable: probe error submits a fully unconfigured bot'
  );

  // 3. Handoff, bound session, review, resume, final result, and failure
  // observations render in order inside the originating thread.
  log('\nSame-thread delegation trace');
  const bot = bots.create({ name: 'Delegator', title: '', description: '' });
  const conv = conversations.getByBotId(bot.id);
  const result = await deck.delegateCodingViaDeck({
    conversationId: conv.id,
    botId: bot.id,
    deck: 'planner',
    client: 'codex',
    cwd: '/tmp/fake-cwd',
    task: 'Add rate limiting to the login route',
    reviewFocus: deck.DECK_REVIEW_FOCUS_DEFAULT,
  });
  assert(!!result, 'delegation: full handoff-through-resume sequence completes');
  const thread = messages.getByConversation(conv.id).filter(m => m.sender_type === 'bot').map(m => m.content);
  const kinds = ui.orderedDeckEventKinds(thread);
  assert(
    JSON.stringify(kinds) === JSON.stringify(['handoff', 'run', 'review', 'resume', 'result']),
    `thread: handoff, bound session, review, resume, and final result render in order (${kinds.join(' > ')})`
  );
  const handoffLine = thread.find(t => t.includes('[Deck handoff]'));
  assert(
    !!handoffLine && handoffLine.includes('runtime=codex') && handoffLine.includes('deck=planner'),
    'thread: handoff carries the effective runtime and deck'
  );
  const runLine = thread.find(t => t.includes('[Deck run]'));
  assert(
    !!runLine && runLine.includes('runId=run-fake-1') && runLine.includes('sessionId=ses-opaque-for-run-fake-1'),
    'thread: bound session carries the opaque run and session ids verbatim'
  );
  const resumeLine = thread.find(t => t.includes('[Deck resume]'));
  assert(
    !!resumeLine && resumeLine.includes('sessionId=ses-opaque-for-run-fake-1'),
    'thread: resume carries the same session id as the bound run'
  );
  log(`  conversation: ${conv.id}`);
  log(`  ordered events: ${kinds.join(' > ')}`);

  const failingBot = bots.create({ name: 'Failer', title: '', description: '' });
  const failingConv = conversations.getByBotId(failingBot.id);
  failImplLog = true;
  let threw = false;
  try {
    await deck.delegateCodingViaDeck({
      conversationId: failingConv.id,
      botId: failingBot.id,
      deck: 'planner',
      client: 'codex',
      cwd: '/tmp/fake-cwd',
      task: 'Break the build',
      reviewFocus: deck.DECK_REVIEW_FOCUS_DEFAULT,
    });
  } catch {
    threw = true;
  } finally {
    failImplLog = false;
  }
  const failingThread = messages.getByConversation(failingConv.id).filter(m => m.sender_type === 'bot').map(m => m.content);
  const failingKinds = ui.orderedDeckEventKinds(failingThread);
  assert(threw, 'failure: a failed run throws after posting its observation');
  assert(
    failingKinds[0] === 'handoff' && failingKinds[failingKinds.length - 1] === 'failed' &&
    failingThread.some(t => t.includes('[Deck failed]') && t.includes('runtime=codex') && t.includes('deck=planner')),
    `failure: handoff then failure observations render in the originating thread (${failingKinds.join(' > ')})`
  );
  log(`  conversation: ${failingConv.id}`);
  log(`  ordered events: ${failingKinds.join(' > ')}`);

  deck.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
  }
}

main()
  .then(ok => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('bot-runtime-ui test crashed:', error);
    cleanup();
    process.exit(1);
  });
