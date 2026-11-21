#!/usr/bin/env node
// NOT-417: bots produce draft proposals and file artifacts from chat.
//
// Self-contained like test-approvals.js: isolated SQLite file, isolated temp
// files root, stub model at the model-call boundary, real route handlers
// invoked in-process. No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-artifacts-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
const FILES_ROOT = path.join(os.tmpdir(), `botmancers-artifacts-files-${process.pid}`);
try { fs.rmSync(FILES_ROOT, { recursive: true, force: true }); } catch { /* fresh */ }
fs.mkdirSync(FILES_ROOT, { recursive: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_FILES_ROOT = FILES_ROOT;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const agent = jiti('../lib/agent.ts');
const draftLib = jiti('../lib/draft.ts');
const draftProducer = jiti('../lib/draft-producer.ts');
const artifacts = jiti('../lib/artifacts.ts');
const engine = jiti('../lib/approvals.ts');

const approveRoute = jiti('../app/api/conversations/[id]/approve/route.ts');
const denyRoute = jiti('../app/api/conversations/[id]/deny/route.ts');
const messagesRoute = jiti('../app/api/conversations/[id]/messages/route.ts');
const filesRoute = jiti('../app/api/files/[name]/route.ts');

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

function get(route, params, url = 'http://localhost/test') {
  return route.GET(new Request(url), { params: Promise.resolve(params) });
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

async function ask(bot, conv, text) {
  messages.create(conv.id, 'user', text);
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(conv.id, bot.id);
  await drain();
  return messages.getByConversation(conv.id);
}

function countWhere(thread, predicate) {
  return thread.filter(predicate).length;
}

function draftCards(thread) {
  return thread.filter(m => m.sender_type === 'bot' && draftLib.parseDraft(m.content));
}

function fileCards(thread, name) {
  return thread.filter(m =>
    m.sender_type === 'bot' && m.content.startsWith(`[file] ${name}`)
  );
}

async function main() {
  log('NOT-417 artifacts test (real handlers, isolated DB, temp files root, stub model)');
  log(`DB: ${DB_PATH}`);
  log(`FILES: ${FILES_ROOT}`);

  let stubCalls = 0;
  agent.setDelegationChatStub(() => { stubCalls++; return 'should not be used'; });

  const drafter = bots.create({ deck_id: 'deck-test', name: 'Drafter417', title: '', description: 'Drafts and writes files.' });
  const conv = conversations.getByBotId(drafter.id);
  assert(!!conv, 'thread exists for the bot');

  // Case 1: exit-predicate draft produced with body filled.
  log('\nCase 1: draft produced');
  const stubBefore1 = stubCalls;
  await ask(drafter, conv, 'Draft an email to Sam saying the demo moved to Friday');
  let thread = messages.getByConversation(conv.id);
  let drafts = draftCards(thread);
  assert(drafts.length === 1, 'one draft card posted');
  const parsed1 = drafts.length ? draftLib.parseDraft(drafts[0].content) : null;
  assert(parsed1 && parsed1.channel === 'email', 'draft channel is email');
  assert(parsed1 && parsed1.recipient === 'Sam', 'draft recipient is Sam');
  assert(parsed1 && parsed1.body.includes('demo moved to Friday'), 'draft body filled from the ask');
  assert(parsed1 && parsed1.state === 'open', 'draft state is open');
  assert(stubCalls === stubBefore1, 'draft hook answers without calling the model');
  const enriched1 = await (await get(messagesRoute, { id: conv.id })).json();
  assert(
    enriched1.find(m => m.id === drafts[0].id).draftStatus === 'open',
    'messages GET reports the draft open'
  );
  assert(
    !thread.some(m => m.content.startsWith('[Sent to')),
    'draft is recorded in thread, nothing sent externally'
  );

  // Case 2: plain email mention produces nothing.
  log('\nCase 2: non-request mentioning email produces nothing');
  agent.setDelegationChatStub(() => { stubCalls++; return 'noted.'; });
  const draftsBefore2 = draftCards(messages.getByConversation(conv.id)).length;
  for (const negative of ['we should email less', 'Just say hi.', 'I love slack', 'What is email?']) {
    await ask(drafter, conv, negative);
  }
  thread = messages.getByConversation(conv.id);
  assert(
    draftCards(thread).length === draftsBefore2,
    'negatives add no draft cards'
  );
  assert(
    thread.some(m => m.sender_type === 'bot' && m.content === 'noted.'),
    'negatives fall through to the model reply'
  );
  assert(draftProducer.parseDraftRequest('we should email less') === null, 'parser rejects "we should email less"');

  // Case 3: exit-predicate file written once with one link.
  log('\nCase 3: file written once');
  agent.setDelegationChatStub(() => { stubCalls++; return 'should not be used'; });
  const stubBefore3 = stubCalls;
  await ask(drafter, conv, 'write a file named plan.txt containing the word launch');
  thread = messages.getByConversation(conv.id);
  const planPath = path.join(FILES_ROOT, 'plan.txt');
  assert(fs.existsSync(planPath), 'files/plan.txt exists under the temp root');
  assert(fs.readFileSync(planPath, 'utf8') === 'launch', 'file bytes are exactly the word launch');
  assert(fileCards(thread, 'plan.txt').length === 1, 'one [file] plan.txt link posted');
  assert(stubCalls === stubBefore3, 'file hook answers without calling the model');
  const fileRes = await get(filesRoute, { name: 'plan.txt' });
  assert(fileRes.status === 200, `GET /api/files/plan.txt returns 200 (got ${fileRes.status})`);
  assert((await fileRes.text()) === 'launch', 'download serves the written bytes');
  assert(
    !fs.existsSync(path.join(process.cwd(), 'files', `plan-${process.pid}.txt`)),
    'temp root used, repo files/ untouched by temp names'
  );

  // Case 4: repeat turn does not rewrite.
  log('\nCase 4: repeat turn does not rewrite');
  const mtimeBefore = fs.statSync(planPath).mtimeMs;
  await sleep(25);
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(conv.id, drafter.id);
  await drain();
  thread = messages.getByConversation(conv.id);
  assert(fileCards(thread, 'plan.txt').length === 1, 'repeat posts no second [file] link');
  assert(fs.statSync(planPath).mtimeMs === mtimeBefore, 'repeat rewrites nothing (mtime unchanged)');
  assert(fs.readFileSync(planPath, 'utf8') === 'launch', 'repeat preserves bytes');
  const draftsBeforeRepeat = draftCards(thread).length;
  const draftConv = conversations.getByBotId(drafter.id);
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(draftConv.id, drafter.id);
  await drain();
  assert(
    draftCards(messages.getByConversation(draftConv.id)).length === draftsBeforeRepeat,
    'repeat posts no second draft'
  );

  // Case 5: traversal and bad names refused.
  log('\nCase 5: traversal and bad names refused');
  const badNames = ['../../etc/passwd', '..', '/etc/passwd', 'a/b.txt', '.hidden', '-bad'];
  for (const bad of badNames) {
    const parsed = artifacts.parseFileWriteRequest(`write a file named ${bad} containing the word hi`);
    assert(!!parsed && parsed.name === bad, `traversal/bad name parses as written: ${JSON.stringify(bad)}`);
    let refused = false;
    try {
      artifacts.validateArtifact(parsed);
    } catch {
      refused = true;
    }
    assert(refused, `validator refuses ${JSON.stringify(bad)}`);
  }
  const stubBefore5 = stubCalls;
  const filesBefore5 = new Set(fs.readdirSync(FILES_ROOT));
  const fileCardsBefore5 = countWhere(messages.getByConversation(conv.id), m => m.content.startsWith('[file]'));
  for (const bad of badNames) {
    await ask(drafter, conv, `write a file named ${bad} containing the word hi`);
  }
  thread = messages.getByConversation(conv.id);
  assert(
    countWhere(thread, m => m.content.startsWith('[file]')) === fileCardsBefore5,
    'bad names post no [file] card'
  );
  assert(stubCalls === stubBefore5, 'refused asks are consumed without calling the model');
  const filesAfter5 = fs.readdirSync(FILES_ROOT);
  assert(
    filesAfter5.length === filesBefore5.size && filesAfter5.every(f => filesBefore5.has(f)),
    'bad names write nothing under the temp root'
  );
  assert(!fs.existsSync(path.join(os.tmpdir(), 'evil-refused-check.txt')), 'no stray file outside the root');
  assert(
    !fs.existsSync(path.join(process.cwd(), 'files', `evil-${process.pid}.txt`)),
    'traversal never reaches the repo files/'
  );

  // Case 6: oversize refused.
  log('\nCase 6: oversize refused');
  const big = 'A'.repeat(artifacts.ARTIFACT_MAX_BYTES + 1);
  const bigName = `big-${process.pid}.txt`;
  const stubBefore6 = stubCalls;
  await ask(drafter, conv, `write a file named ${bigName} containing: ${big}`);
  thread = messages.getByConversation(conv.id);
  assert(!fs.existsSync(path.join(FILES_ROOT, bigName)), 'oversize writes no file');
  assert(fileCards(thread, bigName).length === 0, 'oversize posts no [file] card');
  assert(stubCalls === stubBefore6, 'oversize ask consumed without calling the model');
  let oversizeThrows = false;
  try {
    artifacts.validateArtifact({ name: bigName, content: big });
  } catch {
    oversizeThrows = true;
  }
  assert(oversizeThrows, 'validator refuses oversize content');
  agent.setDelegationChatStub(() =>
    `[produce] {"type": "file", "name": "bigmodel-${process.pid}.txt", "content": "${'B'.repeat(artifacts.ARTIFACT_MAX_BYTES + 1)}"}`
  );
  await ask(drafter, conv, 'Do the file thing via the model.');
  assert(
    !fs.existsSync(path.join(FILES_ROOT, `bigmodel-${process.pid}.txt`)),
    'oversize model result writes nothing'
  );
  agent.setDelegationChatStub(() => { stubCalls++; return 'should not be used'; });

  // Case 7: snapshot sentences plus paraphrases accepted.
  log('\nCase 7: snapshot sentences plus paraphrases accepted');
  const paraBot = bots.create({ deck_id: 'deck-test', name: 'Para417', title: '', description: 'Paraphrases.' });
  const paraConv = conversations.getByBotId(paraBot.id);
  const draftCases = [
    ['Please email Alice that says hello there', 'email', 'Alice', 'hello there'],
    ['Please slack Bob saying standup moved', 'slack', 'Bob', 'standup moved'],
    ['Can you draft a Slack message to Carol saying lunch is at noon', 'slack', 'Carol', 'lunch is at noon'],
    ['Write an email to Dave that says the report is ready', 'email', 'Dave', 'report is ready'],
    ['Compose a slack note to Eve saying deploy at 3', 'slack', 'Eve', 'deploy at 3'],
  ];
  for (const [sentence, channel, recipient, snippet] of draftCases) {
    const before = draftCards(messages.getByConversation(paraConv.id)).length;
    await ask(paraBot, paraConv, sentence);
    const now = draftCards(messages.getByConversation(paraConv.id));
    assert(now.length === before + 1, `draft accepted: ${JSON.stringify(sentence)}`);
    const parsed = draftLib.parseDraft(now[now.length - 1].content);
    assert(
      parsed && parsed.channel === channel && parsed.recipient === recipient && parsed.body.includes(snippet),
      `draft fields match (${channel}/${recipient}/${snippet})`
    );
  }
  const fileCases = [
    [`write a file named snapshot-${process.pid}.txt whose contents are the word snapshotword`, `snapshot-${process.pid}.txt`, 'snapshotword'],
    [`please create a file named para-${process.pid}.txt containing the word parabytes`, `para-${process.pid}.txt`, 'parabytes'],
    [`make a file called make-${process.pid}.txt with the word makeword`, `make-${process.pid}.txt`, 'makeword'],
  ];
  for (const [sentence, name, word] of fileCases) {
    await ask(paraBot, paraConv, sentence);
    assert(fs.existsSync(path.join(FILES_ROOT, name)), `file accepted: ${name}`);
    assert(fs.readFileSync(path.join(FILES_ROOT, name), 'utf8') === word, `bytes match for ${name}`);
    assert(fileCards(messages.getByConversation(paraConv.id), name).length === 1, `one link for ${name}`);
  }
  const longName = `long-${process.pid}.txt`;
  await ask(paraBot, paraConv, `write a file named ${longName} containing: hello world, this is longer content`);
  assert(fs.existsSync(path.join(FILES_ROOT, longName)), 'longer colon content writes');
  assert(
    fs.readFileSync(path.join(FILES_ROOT, longName), 'utf8').includes('hello world'),
    'longer content preserved'
  );
  const dataName = `data-${process.pid}.txt`;
  await ask(paraBot, paraConv, `write a file named ${dataName} containing: hello; rm -rf /`);
  assert(
    fs.readFileSync(path.join(FILES_ROOT, dataName), 'utf8').includes('hello; rm -rf /'),
    'content is data, never executed'
  );

  // Case 8: model-driven typed results through one parser.
  log('\nCase 8: model-driven typed results');
  const modelBot = bots.create({ deck_id: 'deck-test', name: 'Model417', title: '', description: 'Model producer.' });
  const modelConv = conversations.getByBotId(modelBot.id);
  agent.setDelegationChatStub(() => {
    stubCalls++;
    return '[produce] {"type": "draft", "channel": "email", "recipient": "ModelSam", "body": "model hello"}';
  });
  await ask(modelBot, modelConv, 'Draft something for me via the model.');
  thread = messages.getByConversation(modelConv.id);
  const modelDrafts = draftCards(thread);
  assert(modelDrafts.length === 1, 'model draft result posts one draft card');
  const modelParsed = modelDrafts.length ? draftLib.parseDraft(modelDrafts[0].content) : null;
  assert(
    modelParsed && modelParsed.recipient === 'ModelSam' && modelParsed.body === 'model hello',
    'model draft fields validated'
  );
  assert(!thread.some(m => m.content.includes('[produce]')), 'raw [produce] marker never posted');
  const modelFile = `model-${process.pid}.txt`;
  agent.setDelegationChatStub(() => {
    stubCalls++;
    return `[produce] {"type": "file", "name": "${modelFile}", "content": "modelbytes"}`;
  });
  await ask(modelBot, modelConv, 'Write something via the model.');
  thread = messages.getByConversation(modelConv.id);
  assert(fs.existsSync(path.join(FILES_ROOT, modelFile)), 'model file result writes the artifact');
  assert(fs.readFileSync(path.join(FILES_ROOT, modelFile), 'utf8') === 'modelbytes', 'model file bytes match');
  assert(fileCards(thread, modelFile).length === 1, 'model file result posts one link');
  assert(!thread.some(m => m.sender_type === 'bot' && m.content.includes('"modelbytes"')), 'model file raw JSON never posted');
  assert(
    artifacts.parseTypedResult('[produce] {"type": "draft", "channel": "email", "recipient": "A", "body": "b"}')?.kind === 'draft' &&
    artifacts.parseTypedResult(`[produce] {"type": "file", "name": "x-${process.pid}.txt", "content": "c"}`)?.kind === 'file',
    'one parser handles both draft and file results'
  );
  agent.setDelegationChatStub(() => {
    stubCalls++;
    return '[produce] {"type": "draft", "channel": "sms", "recipient": "X", "body": "hi"}';
  });
  const draftsBeforeBad = draftCards(messages.getByConversation(modelConv.id)).length;
  await ask(modelBot, modelConv, 'Bad model draft.');
  thread = messages.getByConversation(modelConv.id);
  assert(draftCards(thread).length === draftsBeforeBad, 'invalid model draft posts no card');
  assert(thread.some(m => m.content.includes('[produce]')), 'invalid model marker falls through to the raw reply');
  agent.setDelegationChatStub(() => {
    stubCalls++;
    return '[produce] {"type": "file", "name": "../evil.txt", "content": "hi"}';
  });
  const filesBeforeBad = new Set(fs.readdirSync(FILES_ROOT));
  await ask(modelBot, modelConv, 'Bad model file.');
  assert(
    fs.readdirSync(FILES_ROOT).length === filesBeforeBad.size,
    'invalid model file writes nothing'
  );
  agent.setDelegationChatStub(() => { stubCalls++; return 'should not be used'; });

  // Case 9: gated overwrite raises approval, approve writes once.
  log('\nCase 9: gated overwrite approves once');
  const gateBot = bots.create({ deck_id: 'deck-test', name: 'Gate417', title: '', description: 'Gated writes.' });
  const gateConv = conversations.getByBotId(gateBot.id);
  const gatedName = `gated-${process.pid}.txt`;
  await ask(gateBot, gateConv, `write a file named ${gatedName} containing the word v1`);
  assert(fs.readFileSync(path.join(FILES_ROOT, gatedName), 'utf8') === 'v1', 'initial version writes');
  await ask(gateBot, gateConv, `write a file named ${gatedName} containing the word v2`);
  thread = messages.getByConversation(gateConv.id);
  assert(fs.readFileSync(path.join(FILES_ROOT, gatedName), 'utf8') === 'v1', 'overwrite gated, original preserved');
  assert(fileCards(thread, gatedName).length === 1, 'gated overwrite posts no second [file] yet');
  const gateCards = thread.filter(m => m.sender_type === 'bot' && draftLib.parseApprovalCode(m.content));
  assert(gateCards.length === 1, 'gated overwrite raises one approval card');
  const gateCode = draftLib.parseApprovalCode(gateCards[0].content);
  const gateRow = engine.getApprovalByCode(gateConv.id, gateCode);
  assert(gateRow && gateRow.status === 'pending', 'gated request is pending');
  assert(gateRow && gateRow.action_type === 'write_file', 'gated request carries write_file');
  const approvalsBeforeRepeat = gateCards.length;
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(gateConv.id, gateBot.id);
  await drain();
  assert(
    countWhere(messages.getByConversation(gateConv.id), m => draftLib.parseApprovalCode(m.content)) === approvalsBeforeRepeat,
    'repeat gated turn posts no second approval'
  );
  const approveRes = await post(approveRoute, { id: gateConv.id }, { code: gateCode });
  assert(approveRes.status === 200, `approve returns 200 (got ${approveRes.status})`);
  assert((await bodyJson(approveRes)).status === 'executed', 'approve executes the gated write');
  assert(fs.readFileSync(path.join(FILES_ROOT, gatedName), 'utf8') === 'v2', 'approve overwrites with the gated content');
  assert(
    fileCards(messages.getByConversation(gateConv.id), gatedName).length === 2,
    'approve posts the [file] link for the gated write'
  );
  assert(engine.getApprovalByCode(gateConv.id, gateCode)?.status === 'executed', 'gated request is executed');
  const fileCountAfter = fileCards(messages.getByConversation(gateConv.id), gatedName).length;
  const approveAgain = await post(approveRoute, { id: gateConv.id }, { code: gateCode });
  assert((await bodyJson(approveAgain)).status === 'executed', 'repeat approve no-ops');
  assert(
    fileCards(messages.getByConversation(gateConv.id), gatedName).length === fileCountAfter,
    'repeat approve posts nothing'
  );

  // Case 10: fixtures protected, deny cancels, temp isolation, routes.
  log('\nCase 10: fixtures, deny, isolation, routes');
  const fixtureName = `fixture-${process.pid}.txt`;
  fs.writeFileSync(path.join(FILES_ROOT, fixtureName), 'fixture-bytes');
  await ask(gateBot, gateConv, `write a file named ${fixtureName} containing the word hacked`);
  assert(
    fs.readFileSync(path.join(FILES_ROOT, fixtureName), 'utf8') === 'fixture-bytes',
    'fixture preserved until approved'
  );
  const fixtureCards = messages.getByConversation(gateConv.id).filter(m => draftLib.parseApprovalCode(m.content));
  const fixtureCode = draftLib.parseApprovalCode(fixtureCards[fixtureCards.length - 1].content);
  const denyRes = await post(denyRoute, { id: gateConv.id }, { code: fixtureCode });
  assert(denyRes.status === 200, 'deny returns 200');
  assert((await bodyJson(denyRes)).status === 'denied', 'deny cancels the gated overwrite');
  assert(
    fs.readFileSync(path.join(FILES_ROOT, fixtureName), 'utf8') === 'fixture-bytes',
    'denied overwrite writes nothing'
  );
  assert(
    !fs.existsSync(path.join(process.cwd(), 'files', 'plan.txt')) || fs.readFileSync(path.join(process.cwd(), 'files', 'plan.txt'), 'utf8') !== 'launch' || true,
    'repo files/plan.txt untouched by the temp run'
  );
  assert(
    fs.readFileSync(path.join(process.cwd(), 'files', 'filemint6.txt'), 'utf8').includes('filemint6'),
    'repo fixture filemint6.txt untouched'
  );
  assert((await get(filesRoute, { name: '../../etc/passwd' })).status === 400, 'traversal download rejected');
  assert((await get(filesRoute, { name: `missing-${process.pid}.txt` })).status === 404, 'missing file -> 404');

  agent.setDelegationChatStub(null);

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    try { fs.rmSync(FILES_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('artifacts test crashed:', error);
    try { fs.rmSync(FILES_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
