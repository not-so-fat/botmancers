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
  // NOT-462: the low-level builder stays fail-safe for unrelated callers.
  const defaulted = deck.buildDeckRunStartCommand({
    deck: 'planner',
    client: 'codex',
    cwd: '/repo/checkout',
    prompt: 'Explain the widget.',
  });
  assert(hasFlag(defaulted, '--tools', 'readonly'), 'start command defaults to readonly when no profile is given');

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
    agent: 'codex', deck_id: 'stored-deck-id', working_directory: workdir,
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
  const herald = loopDb.bots.create({ deck_id: 'deck-test',
    name: 'HeraldDirect', title: 'Herald', description: 'Answers directly.', agent: 'hermes',
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

  // NOT-443: per-bot default workdir (~/.botmancers/{agentID}) created
  // on demand before launch; a stored override wins.
  log('\nDefault workdir resolution and on-demand creation (isolated home)');
  const widSettings = jitiLoop('./lib/agent-deck-settings.ts');
  const fsExtra = require('fs');
  const pathExtra = require('path');
  const osExtra = require('os');
  const savedHome = process.env.HOME;
  const isolatedHome = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), 'botmancers-home-'));
  process.env.HOME = isolatedHome;
  try {
    widSettings.setAgentDeckServerUrl('http://127.0.0.1:1111');
    const defaultPath = widSettings.defaultBotWorkdir('bot-abc', isolatedHome);
    log(`default workdir fixture: agentID=bot-abc home=${isolatedHome} resolved=${defaultPath}`);
    assert(pathExtra.isAbsolute(defaultPath), 'default workdir is an absolute path');
    assert(defaultPath === pathExtra.join(isolatedHome, '.botmancers', 'bot-abc'), 'default workdir is ~/.botmancers/{agentID}');

    const overrideKept = widSettings.resolveBotWorkdir('bot-abc', '/tmp/custom-override', isolatedHome);
    log(`override fixture: override=/tmp/custom-override resolved=${overrideKept}`);
    assert(overrideKept === '/tmp/custom-override', 'explicit override is preserved and used');

    const ensured = widSettings.resolveAndEnsureBotWorkdir('bot-ensure-1', null, isolatedHome);
    const ensuredExists = fsExtra.existsSync(ensured) && fsExtra.statSync(ensured).isDirectory();
    log(`on-demand creation fixture: resolved=${ensured} exists=${ensuredExists}`);
    assert(ensuredExists, 'default workdir is created on demand');

    // Pre-launch existence through the real queue loop: a bot without an
    // override launches with its default workdir, already on disk when
    // `agent-deck run` is spawned.
    let preLaunchExists = null;
    let defaultLaunchedArgv = null;
    deck.setDeckRunProcess(async argv => {
      if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
        const runId = argv[3];
        return { stdout: JSON.stringify({ runId, deck: 'deck-default', client: 'codex', state: 'ended', sessionId: `ses-for-${runId}`, logPath: `/tmp/fake/${runId}.jsonl` }), stderr: '', exitCode: 0 };
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
        const cwdFlag = argv[argv.indexOf('--cwd') + 1];
        try { preLaunchExists = fsExtra.existsSync(cwdFlag) && fsExtra.statSync(cwdFlag).isDirectory(); } catch { preLaunchExists = false; }
        if (!defaultLaunchedArgv) defaultLaunchedArgv = argv.slice();
        return { stdout: 'run run-default-1 detached: pid 4242 log /tmp/fake/run-default-1/run.jsonl\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected: ${argv.join(' ')}`, exitCode: 1 };
    });
    const defaultBot = loopDb.bots.create({
      name: 'DefaultWorkdir', title: 'Default', description: 'Uses the default workdir.',
      agent: 'codex', deck_id: 'deck-default',
    });
    const expectedDefault = widSettings.defaultBotWorkdir(defaultBot.id, isolatedHome);
    const defaultConv = loopDb.conversations.getByBotId(defaultBot.id);
    loopDb.messages.create(defaultConv.id, 'user', 'Build the widget in the default dir.');
    loopDb.queue.enqueue(defaultConv.id, defaultBot.id);
    processed = 0;
    while (processed < 20 && await loopAgent.processNextQueueItem()) processed += 1;
    const defaultCwd = defaultLaunchedArgv ? defaultLaunchedArgv[defaultLaunchedArgv.indexOf('--cwd') + 1] : null;
    log(`pre-launch default fixture: expected=${expectedDefault} launchedCwd=${defaultCwd} existedBeforeSpawn=${preLaunchExists}`);
    assert(!!defaultLaunchedArgv, 'bot without an override launches a deck run');
    assert(defaultCwd === expectedDefault, 'bot without an override resolves to ~/.botmancers/{agentID}');
    assert(preLaunchExists === true, 'pre-launch directory existence assertion: default workdir exists before `agent-deck run` spawns');

    // Override preserved through the real queue loop.
    const overrideDir = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), 'botmancers-override-'));
    let overrideLaunchedArgv = null;
    deck.setDeckRunProcess(async argv => {
      if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
        const runId = argv[3];
        return { stdout: JSON.stringify({ runId, deck: 'deck-default', client: 'codex', state: 'ended', sessionId: `ses-for-${runId}`, logPath: `/tmp/fake/${runId}.jsonl` }), stderr: '', exitCode: 0 };
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
        if (!overrideLaunchedArgv) overrideLaunchedArgv = argv.slice();
        return { stdout: 'run run-override-1 detached: pid 4242 log /tmp/fake/run-override-1/run.jsonl\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected: ${argv.join(' ')}`, exitCode: 1 };
    });
    const overrideBot = loopDb.bots.create({
      name: 'OverrideWorkdir', title: 'Override', description: 'Uses an override.',
      agent: 'codex', deck_id: 'deck-default', working_directory: overrideDir,
    });
    const overrideConv = loopDb.conversations.getByBotId(overrideBot.id);
    loopDb.messages.create(overrideConv.id, 'user', 'Build the widget in the override dir.');
    loopDb.queue.enqueue(overrideConv.id, overrideBot.id);
    processed = 0;
    while (processed < 20 && await loopAgent.processNextQueueItem()) processed += 1;
    const overrideCwd = overrideLaunchedArgv ? overrideLaunchedArgv[overrideLaunchedArgv.indexOf('--cwd') + 1] : null;
    log(`override launch fixture: override=${overrideDir} launchedCwd=${overrideCwd}`);
    assert(overrideCwd === overrideDir, 'explicit override is preserved and used at launch');
    try { fsExtra.rmSync(overrideDir, { recursive: true, force: true }); } catch { /* best effort */ }

    // NOT-443: non-local servers never trigger a local run.
    log('\nNon-local server guard (no remote launch implied)');
    widSettings.setAgentDeckServerUrl('http://192.168.1.10:1111');
    let remoteRunSpawns = 0;
    deck.setDeckRunProcess(async argv => {
      if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] !== 'status' && argv[2] !== 'log') {
        remoteRunSpawns += 1;
        return { stdout: 'run run-remote-1 detached: pid 4242 log /tmp/fake/run-remote-1/run.jsonl\n', stderr: '', exitCode: 0 };
      }
      if (argv[0] === 'agent-deck' && argv[1] === 'run') {
        return { stdout: '', stderr: 'no runs expected on the non-local path', exitCode: 1 };
      }
      return { stdout: '', stderr: `unexpected: ${argv.join(' ')}`, exitCode: 1 };
    });
    const remoteBot = loopDb.bots.create({
      name: 'RemoteGuard', title: 'Remote', description: 'Must not launch remotely.',
      agent: 'codex', deck_id: 'deck-default',
    });
    const remoteConv = loopDb.conversations.getByBotId(remoteBot.id);
    loopDb.messages.create(remoteConv.id, 'user', 'Build the widget against the remote server.');
    loopDb.queue.enqueue(remoteConv.id, remoteBot.id);
    processed = 0;
    while (processed < 20 && await loopAgent.processNextQueueItem()) processed += 1;
    const threadTexts = loopDb.messages.getByConversation(remoteConv.id).map(m => m.content);
    const visibleFailure = threadTexts.reverse().find(t => t.includes('Remote Agent Deck launch is not supported'));
    log(`non-local fixture: server_url=http://192.168.1.10:1111 agent-deck run spawns=${remoteRunSpawns}`);
    log(`user-visible failure: ${JSON.stringify((visibleFailure || '').slice(0, 240))}`);
    assert(remoteRunSpawns === 0, 'non-local fixture proves no `agent-deck run` child was started');
    assert(!!visibleFailure && visibleFailure.includes('unconfirmed'), 'non-local launch records the explicit unsupported/unconfirmed failure');
    widSettings.setAgentDeckServerUrl('http://127.0.0.1:1111');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { fsExtra.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  loopAgent.setDelegationChatStub(null);
  loopAgent.resetDelegationForTests();

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
