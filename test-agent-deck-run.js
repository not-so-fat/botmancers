#!/usr/bin/env node
// NOT-395 adapter boundary plus NOT-442 direct dispatch (deterministic, no
// network). Ordinary messages to an agent-deck bot launch the stored
// agent/deck/workdir directly with no DECK directive parsed.
//
// Self-contained: isolated SQLite file, injected process seam at the
// agent-deck process boundary. No dev server, no API key, no real runs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-deck-run-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const deck = jiti('./lib/agent-deck-run.ts');

let failures = 0;
const seen = [];

function log(line) {
  console.log(line);
}

function assert(condition, label) {
  seen.push(label);
  if (condition) {
    log(`  PASS: ${label}`);
  } else {
    failures++;
    log(`  FAIL: ${label}`);
  }
}

function hasFlag(argv, flag, value) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] === value;
}

// Fake local machine: only the Codex launch path is installed. Every other
// runtime binary is missing, so only Codex may be advertised as available.
const recorded = [];
let runCounter = 0;

deck.setDeckRunProcess(async argv => {
  recorded.push(argv);
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
    return {
      stdout: JSON.stringify({
        runId,
        deck: 'planner-deck-id',
        client: 'codex',
        state: 'ended',
        sessionId: `ses-opaque-for-${runId}`,
        startedAt: '2026-10-12T00:00:00.000Z',
        lastLogTs: '2026-10-12T00:01:00.000Z',
        logPath: `/tmp/fake-runs/${runId}/run.jsonl`,
      }),
      stderr: '',
      exitCode: 0,
    };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
    const runId = argv[3];
    // Fail-closed fixtures: a stream with no terminal line, and a stream
    // carrying an error line. awaitDeckRunEnd must refuse both.
    if (runId === 'run-noend') {
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: 'ses-opaque-for-run-noend', subtype: 'success', result: 'partial' }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (runId === 'run-errlog') {
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'error', message: 'runtime exploded' }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    const lines = [
      JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
      JSON.stringify({ t: 'result', sessionId: `ses-opaque-for-${runId}`, subtype: 'success', result: `done by ${runId}` }),
      JSON.stringify({ t: 'end', sessionId: `ses-opaque-for-${runId}` }),
    ].join('\n') + '\n';
    return { stdout: lines, stderr: '', exitCode: 0 };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run') {
    runCounter++;
    const runId = `run-fake-${runCounter}`;
    return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-runs/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
});

async function main() {
  log('NOT-395 agent-deck run adapter test (injected process seam, isolated DB)');
  log(`DB: ${DB_PATH}`);

  // Command-contract assertions for Codex: start, status, log, resume.
  log('\nCommand contract (codex)');
  const start = deck.buildDeckRunStartCommand({
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    prompt: 'Implement the widget.',
    tools: 'edit',
    detach: true,
  });
  assert(
    start[0] === 'agent-deck' && start[1] === 'run' && start[2] === 'planner',
    'start command preserves the selected deck (codex)'
  );
  assert(hasFlag(start, '--client', 'codex'), 'start command preserves the codex runtime');
  assert(hasFlag(start, '--cwd', '/repo/checkout'), 'start command preserves the working directory');
  assert(hasFlag(start, '--prompt', 'Implement the widget.'), 'start command preserves the prompt');
  assert(hasFlag(start, '--tools', 'edit'), 'start command preserves the tool profile');

  const started = await deck.startDeckRun({
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    prompt: 'Implement the widget.',
    tools: 'edit',
    detach: true,
  });
  assert(started.runId === 'run-fake-1', 'start parses the detached runId from CLI output');

  const status = await deck.deckRunStatus('run-fake-1');
  const statusArgv = recorded.find(a => a[1] === 'run' && a[2] === 'status');
  assert(!!statusArgv && statusArgv[3] === 'run-fake-1' && statusArgv.includes('--json'), 'status command preserves the runId');
  assert(status.sessionId === 'ses-opaque-for-run-fake-1', 'status carries the opaque session ID through untouched');

  const logged = await deck.deckRunLog('run-fake-1');
  const logArgv = recorded.find(a => a[1] === 'run' && a[2] === 'log');
  assert(!!logArgv && logArgv[3] === 'run-fake-1' && logArgv.includes('--json'), 'log command preserves the runId');
  assert(logged.result && logged.result.result === 'done by run-fake-1', 'log result is read via the log command, not private files');
  assert(logged.result && logged.result.sessionId === 'ses-opaque-for-run-fake-1', 'log session ID matches the status session ID');

  const resumed = await deck.resumeDeckRun({
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    prompt: 'Review feedback: fix the edge case.',
    tools: 'edit',
    resume: status.sessionId,
  });
  const resumeArgv = resumed.argv;
  assert(hasFlag(resumeArgv, '--resume', 'ses-opaque-for-run-fake-1'), 'resume receives the opaque session ID unchanged');
  assert(hasFlag(resumeArgv, '--tools', 'edit'), 'resume repeats the tool profile (nothing inherited)');
  assert(resumeArgv[2] === 'planner' && hasFlag(resumeArgv, '--cwd', '/repo/checkout'), 'resume preserves the deck and working directory');

  // Runtime validation and availability assertions.
  log('\nRuntime validation and availability');
  for (const runtime of ['codex', 'claude', 'cursor', 'muse']) {
    const argv = deck.buildDeckRunStartCommand({
      deck: 'planner',
      client: runtime,
      cwd: '/repo/checkout',
      prompt: 'x',
    });
    assert(hasFlag(argv, '--client', runtime), `command generation supports ${runtime}`);
  }
  let rejected = false;
  try {
    deck.buildDeckRunStartCommand({ deck: 'planner', client: 'gpt', cwd: '/repo/checkout', prompt: 'x' });
  } catch {
    rejected = true;
  }
  assert(rejected, 'invalid runtime values fail closed');
  let probeRejected = false;
  try {
    await deck.probeDeckRuntime('gpt');
  } catch {
    probeRejected = true;
  }
  assert(probeRejected, 'capability probe fails closed on invalid runtime');

  // Completion wait and fail-closed terminal handling.
  log('\nCompletion wait (CLI --follow, no adapter polling)');
  const awaited = await deck.awaitDeckRunEnd('run-fake-1');
  const followArgv = recorded.find(a => a[1] === 'run' && a[2] === 'log' && a.includes('--follow'));
  assert(!!followArgv && followArgv[3] === 'run-fake-1', 'await reads completion through run log --follow (CLI completion signal)');
  assert(awaited.result === 'done by run-fake-1', 'awaited result comes from the followed log stream');
  assert(awaited.sessionId === 'ses-opaque-for-run-fake-1', 'awaited session ID is the opaque status value');
  assert(awaited.status.state === 'ended', 'await confirms the terminal state via run status');
  let noEndThrew = false;
  try {
    await deck.awaitDeckRunEnd('run-noend');
  } catch {
    noEndThrew = true;
  }
  assert(noEndThrew, 'await fails closed when the log never reaches a terminal event');
  let errLogThrew = false;
  try {
    await deck.awaitDeckRunEnd('run-errlog');
  } catch {
    errLogThrew = true;
  }
  assert(errLogThrew, 'await fails closed on a log error event');

  const available = await deck.listAvailableDeckRuntimes();
  assert(
    recorded.some(a => a[0] === 'agent-deck' && a[1] === '--version'),
    'capability probe verifies the agent-deck launch path alongside the runtime binary'
  );
  assert(available.includes('codex'), 'capability probe advertises the verified codex launch path');
  assert(
    !available.includes('claude') && !available.includes('cursor') && !available.includes('muse'),
    'unverified clients are valid targets but are not advertised as available'
  );
  // Unverified clients stay valid adapter targets: the builder accepts them.
  const claudeArgv = deck.buildDeckRunStartCommand({ deck: 'planner', client: 'claude', cwd: '/repo/checkout', prompt: 'x' });
  assert(hasFlag(claudeArgv, '--client', 'claude'), 'unverified client still builds a valid adapter command');

  // NOT-442: no DECK directive is parsed anywhere. The adapter exposes no
  // directive parser and advertises no directive how-to: ordinary turns
  // dispatch through the bot's own stored runtime in the conversation loop.
  log('\nNo directive path');
  assert(deck.parseDeckDirective === undefined, 'no DECK directive parser remains on the adapter');
  assert(deck.DECK_DIRECTIVE_PATTERN === undefined, 'no DECK directive pattern remains on the adapter');
  assert(deck.resolveDeckForCwd === undefined, 'no working-directory deck resolution remains on the adapter');
  assert(deck.formatDeckHowTo === undefined, 'no directive how-to remains on the adapter');

  // NOT-442 direct dispatch through the real queue loop: an ordinary
  // message to an Agent Deck bot launches the stored agent/deck/workdir
  // directly, while an ordinary message to a Hermes bot uses the Hermes
  // session. Each case proves the opposite adapter was not invoked.
  log('\nDirect dispatch (conversation loop)');
  const { createJiti } = require('jiti');
  const jitiLoop = createJiti(__filename);
  const loopDb = jitiLoop('./lib/db.ts');
  const loopAgent = jitiLoop('./lib/agent.ts');
  const workdir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'botmancers-deck-direct-'));
  let launchedArgv = null;
  deck.setDeckRunProcess(async argv => {
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      return {
        stdout: JSON.stringify({ runId, deck: 'stored-deck-id', client: 'codex', state: 'ended', sessionId: `ses-for-${runId}`, logPath: `/tmp/fake/${runId}.jsonl` }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const lines = [
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, result: `output of ${runId}` }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      if (!launchedArgv) launchedArgv = argv.slice();
      return { stdout: 'run run-direct-1 detached: pid 4242 log /tmp/fake/run-direct-1/run.jsonl\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected: ${argv.join(' ')}`, exitCode: 1 };
  });
  let hermesStubCalls = 0;
  loopAgent.setDelegationChatStub(() => {
    hermesStubCalls += 1;
    return 'Hermes stub must not run for an agent-deck turn (direct dispatch proves it).';
  });
  const relay = loopDb.bots.create({
    name: 'RelayDirect', title: 'Relay', description: 'Launches directly.',
    runtime: 'agent-deck', agent_client: 'codex', deck_id: 'stored-deck-id', working_directory: workdir,
  });
  const relayConv = loopDb.conversations.getByBotId(relay.id);
  loopDb.messages.create(relayConv.id, 'user', 'Build the widget.');
  loopDb.queue.enqueue(relayConv.id, relay.id);
  let processed = 0;
  while (processed < 20 && await loopAgent.processNextQueueItem()) processed += 1;
  assert(!!launchedArgv, 'Agent Deck direct-dispatch assertion: ordinary Agent Deck message launches the stored deck run');
  assert(
    launchedArgv && hasFlag(launchedArgv, '--client', 'codex') && launchedArgv[2] === 'stored-deck-id' && hasFlag(launchedArgv, '--cwd', workdir),
    'Agent Deck direct-dispatch assertion: launch uses the stored agent/deck/workdir without parsing a DECK directive'
  );
  assert(hermesStubCalls === 0, 'Agent Deck direct-dispatch assertion: opposite adapter (Hermes) was not invoked');
  // Hermes direct dispatch: the stub session answers and no deck run starts.
  launchedArgv = null;
  let hermesAnswered = 0;
  loopAgent.setDelegationChatStub(() => {
    hermesAnswered += 1;
    return 'Hello from the Hermes session.';
  });
  const herald = loopDb.bots.create({
    name: 'HeraldDirect', title: 'Herald', description: 'Answers directly.', runtime: 'hermes',
  });
  const heraldConv = loopDb.conversations.getByBotId(herald.id);
  loopDb.messages.create(heraldConv.id, 'user', 'Hello Herald.');
  loopDb.queue.enqueue(heraldConv.id, herald.id);
  processed = 0;
  while (processed < 20 && await loopAgent.processNextQueueItem()) processed += 1;
  assert(hermesAnswered === 1, 'Hermes direct-dispatch assertion: ordinary Hermes message uses the existing Hermes session');
  assert(launchedArgv === null, 'Hermes direct-dispatch assertion: opposite adapter (agent-deck) was not invoked');
  loopAgent.setDelegationChatStub(null);
  loopAgent.resetDelegationForTests();
  try { require('fs').rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    deck.setDeckRunProcess(null);
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('agent-deck-run test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
