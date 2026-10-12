#!/usr/bin/env node
// NOT-395: agent-deck run adapter boundary test (deterministic, no network).
//
// Self-contained: isolated SQLite file (unused by the adapter but kept for
// parity with the other suites), injected process seam at the agent-deck
// process boundary. No dev server, no API key, no real runs.
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

  const available = await deck.listAvailableDeckRuntimes();
  assert(available.includes('codex'), 'capability probe advertises the verified codex launch path');
  assert(
    !available.includes('claude') && !available.includes('cursor') && !available.includes('muse'),
    'unverified clients are valid targets but are not advertised as available'
  );
  // Unverified clients stay valid adapter targets: the builder accepts them.
  const claudeArgv = deck.buildDeckRunStartCommand({ deck: 'planner', client: 'claude', cwd: '/repo/checkout', prompt: 'x' });
  assert(hasFlag(claudeArgv, '--client', 'claude'), 'unverified client still builds a valid adapter command');

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
