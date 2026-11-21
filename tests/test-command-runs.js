#!/usr/bin/env node
// NOT-419: bounded command runs with Stop, the `page` run payload and
// computer assets.
//
// Self-contained like test-approvals.js: isolated SQLite file, real agent
// queue and route handlers invoked in-process, local child processes only
// (/bin/sleep, /usr/bin/printf). No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-command-runs-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const agent = jiti('../lib/agent.ts');
const runLib = jiti('../lib/run.ts');
const runChild = jiti('../lib/run-child.ts');
const commands = jiti('../lib/commands.ts');
const engine = jiti('../lib/approvals.ts');

const stopRoute = jiti('../app/api/conversations/[id]/stop/route.ts');
const messageStopRoute = jiti('../app/api/conversations/[id]/messages/[messageId]/stop/route.ts');

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
  return condition;
}

function post(route, params, body) {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return route.POST(new Request('http://localhost/test', init), { params: Promise.resolve(params) });
}

async function bodyJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drain(cap = 20) {
  let processed = 0;
  while (processed < cap && await agent.processNextUiTurn()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

async function waitForState(messageId, want, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const current = messages.getById(messageId);
    const parsed = current ? runLib.parseRun(current.content) : null;
    if (parsed && parsed.state === want) return parsed;
    if (Date.now() - started > timeoutMs) return parsed;
    await sleep(50);
  }
}

function startRun(convId, botId, request, opts) {
  const msg = messages.create(convId, 'bot', runLib.serializeRun({ state: 'running' }), botId);
  runChild.beginCommandRun(msg.id, request, opts);
  return msg.id;
}

async function main() {
  log('NOT-419 command runs test (real handlers, isolated DB, no network)');
  log(`DB: ${DB_PATH}`);

  const cos = bots.create({ deck_id: 'deck-test', name: 'chief-of-staff', title: '', description: 'Runs commands.' });
  const conv = conversations.getByBotId(cos.id);
  assert(!!conv, 'thread exists for chief-of-staff');

  // Case 1: snapshot wait-phrasing forms, default, range and paraphrases.
  log('\nCase 1: snapshot phrases and paraphrases accepted');
  const forms = [
    ['Print the word boxmint1', 4],
    ['Print the word boxmint1 wait 5 seconds', 5],
    ['Print the word boxmint1 and wait 5 seconds', 5],
    ['Print the word boxmint1 wait for 5 seconds', 5],
    ['Print the word boxmint1 and wait for 5 seconds', 5],
    ['Print the word boxmint1 then wait 5 seconds', 5],
    ['Print the word boxmint1, wait 5 seconds.', 5],
    ['please print the word boxmint1 and wait 5 seconds', 5],
    ['Output the word boxmint1 and wait 2 seconds', 2],
    ['Display the word boxmint1 wait 1 second', 1],
    ['Show the word boxmint1 and wait for 30 seconds', 30],
    ['Print the word boxmint1 and wait 1 second', 1],
  ];
  for (const [phrase, seconds] of forms) {
    const ask = commands.parseCommandAsk(phrase);
    assert(
      !!ask && ask.command === 'printf' && ask.args.word === 'boxmint1' && ask.waitSeconds === seconds,
      `${JSON.stringify(phrase)} -> printf boxmint1 wait ${seconds}s`
    );
  }
  const negatives = [
    'Print the word boxmint1 and wait 0 seconds',
    'Print the word boxmint1 and wait 31 seconds',
    'Print the word boxmint1 and wait five seconds',
    'run a command that prints the word boxmint1',
    'please execute a command to print the word boxmint1',
    'run rm -rf /',
    'print hello world',
    'Print the word "a b"',
    'install the package leftpad',
    'curl https://example.com',
  ];
  for (const phrase of negatives) {
    assert(commands.parseCommandAsk(phrase) === null, `${JSON.stringify(phrase)} is not a command ask`);
  }

  // Case 2: output captured and the wait honored.
  log('\nCase 2: output captured, wait honored');
  const started2 = Date.now();
  const id2 = startRun(conv.id, cos.id, { command: 'printf', args: { word: 'boxmint2' }, waitSeconds: 1 });
  const running2 = runLib.parseRun(messages.getById(id2).content);
  assert(running2 && running2.state === 'running', 'run starts running');
  assert(
    !!running2 && typeof running2.page === 'string' && running2.page.includes('printf %s boxmint2'),
    'running run publishes its computer page as `page`'
  );
  assert(runLib.runLine(running2) === 'The command is running', 'running line with Stop reads `The command is running`');
  const done2 = await waitForState(id2, 'done');
  const elapsed2 = Date.now() - started2;
  assert(done2 && done2.state === 'done' && done2.output === 'boxmint2', 'run completes with the printed word');
  assert(elapsed2 >= 1000, `wait honored (elapsed ${elapsed2}ms >= 1000ms)`);
  assert(
    !!done2 && typeof done2.page === 'string' && done2.page.includes('boxmint2'),
    'done run keeps its computer page'
  );

  // Case 3: the hard timeout kills the run.
  log('\nCase 3: timeout kills');
  const id3 = startRun(
    conv.id, cos.id,
    { command: 'printf', args: { word: 'boxmint3' }, waitSeconds: 5 },
    { timeoutMs: 150 }
  );
  const timedOut = await waitForState(id3, 'stopped', 5000);
  assert(timedOut && timedOut.state === 'stopped', 'timed-out run is stopped');
  assert(runLib.runLine(timedOut) === 'The command was stopped.', 'timed-out line reads `The command was stopped.`');

  // Case 4: Stop mid-run kills the child.
  log('\nCase 4: Stop kills');
  const id4 = startRun(conv.id, cos.id, { command: 'printf', args: { word: 'boxmint4' }, waitSeconds: 5 });
  await sleep(200);
  assert(runLib.parseRun(messages.getById(id4).content)?.state === 'running', 'run still running before Stop');
  runChild.stopCommandRun(id4);
  const stopped4 = runLib.parseRun(messages.getById(id4).content);
  assert(stopped4 && stopped4.state === 'stopped', 'Stop marks the run stopped');
  assert(runLib.runLine(stopped4) === 'The command was stopped.', 'stopped line reads `The command was stopped.`');
  await sleep(300);
  assert(
    runLib.parseRun(messages.getById(id4).content)?.state === 'stopped',
    'stopped run never completes afterwards'
  );

  // Case 5: captured output is capped.
  log('\nCase 5: output cap');
  const id5 = startRun(
    conv.id, cos.id,
    { command: 'printf', args: { word: 'boxmint5-long-word' }, waitSeconds: 1 },
    { outputMaxBytes: 4 }
  );
  const done5 = await waitForState(id5, 'done');
  assert(done5 && done5.state === 'done', 'capped run still completes');
  assert(
    !!done5 && Buffer.byteLength(done5.output || '', 'utf8') <= 4,
    `capped output is at most 4 bytes (got ${JSON.stringify(done5 && done5.output)})`
  );

  // Case 6: anything outside the allowlist is refused.
  log('\nCase 6: disallowed command refused');
  const refusals = [
    () => commands.resolveCommand({ command: 'rm', args: { word: 'x' } }),
    () => commands.resolveCommand({ command: 'sh', args: { word: 'x' } }),
    () => commands.resolveCommand({ command: 'printf', args: { word: 'a b' } }),
    () => commands.resolveCommand({ command: 'printf', args: { word: 'a;rm' } }),
    () => commands.resolveCommand({ command: 'printf', format: '%s%s', word: 'x' }),
    () => commands.resolveCommand({ command: 'printf', args: { word: 'x'.repeat(65) } }),
    () => commands.validateCommandRequest({ command: 'printf', args: { word: 'x' }, waitSeconds: 0 }),
    () => commands.validateCommandRequest({ command: 'printf', args: { word: 'x' }, waitSeconds: 31 }),
    () => commands.validateCommandRequest({ command: 'curl', args: { word: 'x' }, waitSeconds: 1 }),
  ];
  for (const attempt of refusals) {
    let refused = false;
    try {
      attempt();
    } catch (error) {
      refused = /refused/.test(String(error && error.message));
    }
    assert(refused, 'outside-allowlist request throws a refusal');
  }
  let approvalRefused = false;
  try {
    engine.createApprovalRequest({
      conversationId: conv.id, botId: cos.id, code: 'cmd-never',
      actionType: 'run_command', actionArgs: { command: 'rm', word: 'x' },
    });
  } catch (error) {
    approvalRefused = /refused/.test(String(error && error.message));
  }
  assert(approvalRefused, 'approval engine refuses a non-allowlisted run_command');
  assert(!engine.getApprovalByCode(conv.id, 'cmd-never'), 'refused approval stores nothing');
  let threwBeforeSpawn = false;
  const id6 = messages.create(conv.id, 'bot', runLib.serializeRun({ state: 'running' }), cos.id).id;
  try {
    runChild.beginCommandRun(id6, { command: 'rm', args: { word: 'x' }, waitSeconds: 1 });
  } catch {
    threwBeforeSpawn = true;
  }
  assert(threwBeforeSpawn, 'beginCommandRun refuses before any child spawns');
  assert(
    runLib.parseRun(messages.getById(id6).content)?.state === 'running',
    'refused begin leaves the message untouched'
  );

  // Case 7: `html` and `page` payloads both parse; writers emit `page`.
  log('\nCase 7: html and page payloads both parsed');
  const legacy = runLib.parseRun('[run]\n{"state":"done","output":"w","html":"<p>old</p>"}');
  assert(legacy && legacy.state === 'done' && legacy.output === 'w', 'legacy html payload parses');
  assert(legacy && legacy.page === '<p>old</p>', 'legacy html is exposed as page');
  const modern = runLib.parseRun('[run]\n{"state":"done","output":"w","page":"<p>new</p>"}');
  assert(modern && modern.page === '<p>new</p>', 'page payload parses');
  const both = runLib.parseRun('[run]\n{"state":"done","output":"w","page":"<p>new</p>","html":"<p>old</p>"}');
  assert(both && both.page === '<p>new</p>', 'page wins when both fields are present');
  const runningLegacy = runLib.parseRun('[run]\n{"state":"running","html":"<p>old</p>"}');
  assert(runningLegacy && runningLegacy.state === 'running' && runningLegacy.page === '<p>old</p>', 'legacy running payload parses');
  const written = runLib.serializeRun({ state: 'done', output: 'w', page: '<p>new</p>' });
  assert(written.includes('"page"') && !written.includes('"html"'), 'writer emits one field: page');
  const migrated = runLib.serializeRun({ state: 'done', output: 'w', html: '<p>old</p>' });
  assert(migrated.includes('"page":"<p>old</p>"'), 'old call sites passing html are written as page');
  assert(
    runLib.parseRun(migrated)?.page === '<p>old</p>',
    'migrated payload round-trips through the reader'
  );

  // Case 8: chief-of-staff prints a word end to end through the queue.
  log('\nCase 8: chief-of-staff command run end to end');
  messages.create(conv.id, 'user', 'Print the word boxmint8 and wait 1 second');
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const thread8 = messages.getByConversation(conv.id);
  const run8 = [...thread8].reverse().find(m => m.sender_type === 'bot' && runLib.parseRun(m.content));
  assert(!!run8, 'command ask posts a [run] message');
  const parsed8 = run8 ? runLib.parseRun(run8.content) : null;
  assert(
    !!parsed8 && (parsed8.state === 'running' || parsed8.state === 'done') && typeof parsed8.page === 'string',
    'run message carries the computer page while running'
  );
  const done8 = await waitForState(run8.id, 'done');
  assert(done8 && done8.output === 'boxmint8', 'end-to-end run completes with the printed word');

  // Case 9: both Stop routes stop a command run; delegation Stop unchanged.
  log('\nCase 9: Stop routes');
  const id9 = startRun(conv.id, cos.id, { command: 'printf', args: { word: 'boxmint9' }, waitSeconds: 5 });
  await sleep(150);
  const convStop = await post(stopRoute, { id: conv.id }, { messageId: id9 });
  assert(convStop.status === 200, `conversation stop with messageId returns 200 (got ${convStop.status})`);
  assert((await bodyJson(convStop)).stopped === true, 'conversation stop with messageId reports stopped');
  assert(
    runLib.parseRun(messages.getById(id9).content)?.state === 'stopped',
    'conversation stop with messageId stops the run'
  );
  const id9b = startRun(conv.id, cos.id, { command: 'printf', args: { word: 'boxmint9b' }, waitSeconds: 5 });
  await sleep(150);
  const msgStop = await post(messageStopRoute, { id: conv.id, messageId: id9b });
  assert(msgStop.status === 200, `per-message stop returns 200 (got ${msgStop.status})`);
  assert(
    runLib.parseRun(messages.getById(id9b).content)?.state === 'stopped',
    'per-message stop stops the run'
  );
  const delegationStop = await post(stopRoute, { id: conv.id });
  assert(delegationStop.status === 200, 'conversation stop without a body still returns 200');
  const delegationBody = await bodyJson(delegationStop);
  assert(
    delegationBody && delegationBody.success === true && typeof delegationBody.stopped === 'boolean',
    'delegation Stop keeps its { success, stopped } contract'
  );
  assert((await post(stopRoute, { id: 'nope' }, { messageId: id9b })).status === 404, 'stop on unknown conversation -> 404');

  // Case 10: computer assets served from /computer/, old paths kept.
  log('\nCase 10: computer assets');
  for (const name of ['dock-chrome.png', 'dock-gray.png', 'dock-terminal.png', 'wallpaper.png']) {
    const file = path.join(ROOT, 'public', 'computer', name);
    assert(fs.existsSync(file) && fs.statSync(file).size > 0, `/computer/${name} exists and is non-empty`);
  }
  for (const name of ['dock-chrome_c5c1.png', 'dock-gray_6226.png', 'dock-terminal_166d.png', 'wallpaper_1c49.png']) {
    assert(fs.existsSync(path.join(ROOT, 'public', name)), `legacy /${name} kept so stored messages still render`);
  }
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert(
    pageSource.includes('/computer/dock-chrome.png') &&
    pageSource.includes('/computer/dock-gray.png') &&
    pageSource.includes('/computer/dock-terminal.png'),
    'thread UI loads dock icons from /computer/'
  );
  const cssSource = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  assert(cssSource.includes('/computer/wallpaper.png'), 'computer desk loads its wallpaper from /computer/');
  const sameBytes = (a, b) =>
    fs.readFileSync(path.join(ROOT, 'public', a)).equals(fs.readFileSync(path.join(ROOT, 'public', b)));
  assert(
    sameBytes('dock-chrome_c5c1.png', 'computer/dock-chrome.png') &&
    sameBytes('wallpaper_1c49.png', 'computer/wallpaper.png'),
    '/computer/ assets are byte-identical to the legacy files'
  );

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
    console.error('command runs test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
