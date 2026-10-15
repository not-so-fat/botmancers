#!/usr/bin/env node
// NOT-416: approval requests (approval codes, Approve/Deny, approval-gated
// actions).
//
// Self-contained like test-thread-actions.js: isolated SQLite file, stub model
// at the model-call boundary, real route handlers invoked in-process. No dev
// server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-approvals-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const engine = jiti('./lib/approvals.ts');
const draftLib = jiti('./lib/draft.ts');

const approveRoute = jiti('./app/api/conversations/[id]/approve/route.ts');
const denyRoute = jiti('./app/api/conversations/[id]/deny/route.ts');
const messagesRoute = jiti('./app/api/conversations/[id]/messages/route.ts');

const { bots, conversations, messages } = db;

let failures = 0;
const tempFiles = [];
const tempSkills = [];

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

function trackTempFile(name) {
  tempFiles.push(path.join(process.cwd(), 'files', name));
}

function writeFixture(name, contents) {
  trackTempFile(name);
  fs.mkdirSync(path.join(process.cwd(), 'files'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'files', name), contents);
}

function writeSkill(botName, contents) {
  const dir = path.join(process.cwd(), 'skills', botName);
  const file = path.join(dir, 'SKILL.md');
  tempSkills.push(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, contents);
}

async function ask(bot, conv, text) {
  messages.create(conv.id, 'user', text);
  jiti('./lib/ui-turns.ts').uiTurns.enqueue(conv.id, bot.id);
  await drain();
  return messages.getByConversation(conv.id);
}

function latestCard(thread) {
  const cards = thread.filter(
    m => m.sender_type === 'bot' && draftLib.parseApprovalCode(m.content)
  );
  return cards[cards.length - 1];
}

function countWhere(thread, predicate) {
  return thread.filter(predicate).length;
}

async function main() {
  log('NOT-416 approvals test (real handlers, isolated DB, stub model)');
  log(`DB: ${DB_PATH}`);

  const gatekeeper = bots.create({ deck_id: 'deck-test', name: 'Gatekeeper', title: '', description: 'Guards actions.' });
  const conv = conversations.getByBotId(gatekeeper.id);
  assert(!!conv, 'thread exists for the bot');

  // Skill end token (pre-small-items-ticket rule: localSkillForBot read).
  writeSkill('Gatekeeper', 'Always be brief.\nEvery reply ends with the exact token endmint9');

  // Case 1: gated file read posts a card; Approve runs it once.
  log('\nCase 1: gated file read approves once');
  writeFixture('notemint5.txt', 'notemint5');
  const before1 = messages.getByConversation(conv.id).length;
  await ask(gatekeeper, conv, 'read the file notemint5.txt');
  let thread = messages.getByConversation(conv.id);
  const card1 = latestCard(thread);
  assert(!!card1 && card1.content.startsWith('Approve using the code '), 'snapshot file sentence posts an approval card');
  assert(card1.content.includes('endmint9'), 'card carries the skill end token');
  const code1 = draftLib.parseApprovalCode(card1.content);
  assert(!!code1, 'card code parses');
  assert(
    engine.getApprovalByCode(conv.id, code1)?.status === 'pending',
    'request row is pending'
  );
  assert(
    engine.getApprovalByCode(conv.id, code1)?.action_type === 'read_file',
    'request carries the read_file action'
  );
  assert(
    countWhere(thread, m => m.content.startsWith('[tool result]')) === 0,
    'pending action does not run until approved'
  );
  const approve1 = await post(approveRoute, { id: conv.id }, { code: code1 });
  assert(approve1.status === 200, `approve returns 200 (got ${approve1.status})`);
  const approved1 = await bodyJson(approve1);
  assert(approved1.status === 'executed' && approved1.ran === true, 'approve executes and reports ran');
  thread = messages.getByConversation(conv.id);
  assert(
    countWhere(thread, m => m.content === '[tool result] notemint5') === 1,
    'approve returns the file contents once'
  );
  assert(
    countWhere(thread, m => m.content.startsWith('[tool call] readFile')) === 1,
    'tool call recorded once'
  );
  assert(thread.some(m => m.content === 'endmint9'), 'end token posted after execution');
  assert(
    engine.getApprovalByCode(conv.id, code1)?.status === 'executed',
    'request row is executed'
  );
  const enriched1 = await (await get(messagesRoute, { id: conv.id })).json();
  assert(
    enriched1.find(m => m.id === card1.id).approvalStatus === 'approved',
    'messages GET reports the executed card approved'
  );
  const countAfterApprove = thread.length;
  assert(countAfterApprove > before1, 'approval flow posted messages');

  // Case 2: repeat approve is a no-op.
  log('\nCase 2: repeat approve no-op');
  const approveAgain = await post(approveRoute, { id: conv.id }, { code: code1 });
  assert(approveAgain.status === 200, `repeat approve returns 200 (got ${approveAgain.status})`);
  assert((await bodyJson(approveAgain)).status === 'executed', 'repeat approve reports stored status');
  thread = messages.getByConversation(conv.id);
  assert(thread.length === countAfterApprove, 'repeat approve posts nothing');
  assert(
    countWhere(thread, m => m.content === '[tool result] notemint5') === 1,
    'action still ran exactly once'
  );

  // Case 3: deny cancels a paraphrased gated read.
  log('\nCase 3: deny cancels');
  writeFixture(`approvals-note-${process.pid}.txt`, 'paraphrase-bytes');
  await ask(gatekeeper, conv, `please show me the contents of approvals-note-${process.pid}.txt for me`);
  thread = messages.getByConversation(conv.id);
  const card3 = latestCard(thread);
  assert(!!card3 && card3.id !== card1.id, 'paraphrase posts its own approval card');
  const code3 = draftLib.parseApprovalCode(card3.content);
  const resultsBefore = countWhere(thread, m => m.content.startsWith('[tool result]'));
  const deny3 = await post(denyRoute, { id: conv.id }, { messageId: card3.id });
  assert(deny3.status === 200, `deny returns 200 (got ${deny3.status})`);
  assert((await bodyJson(deny3)).status === 'denied', 'deny reports denied');
  thread = messages.getByConversation(conv.id);
  const deniedLine = thread.find(m => m.content.startsWith('Denied') && m.content.includes(code3));
  assert(!!deniedLine, 'deny posts `Denied <code>`');
  assert(
    countWhere(thread, m => m.content.startsWith('[tool result]')) === resultsBefore,
    'denied action runs nothing'
  );
  assert(engine.getApprovalByCode(conv.id, code3)?.status === 'denied', 'request row is denied');
  const enriched3 = await (await get(messagesRoute, { id: conv.id })).json();
  assert(
    enriched3.find(m => m.id === card3.id).approvalStatus === 'denied',
    'messages GET reports the denied card denied'
  );

  // Case 4: approve after deny is a no-op; deny after execute is a no-op.
  log('\nCase 4: approve after deny no-op');
  const countBefore4 = messages.getByConversation(conv.id).length;
  const approveAfterDeny = await post(approveRoute, { id: conv.id }, { code: code3 });
  assert(approveAfterDeny.status === 200, `approve after deny returns 200 (got ${approveAfterDeny.status})`);
  assert((await bodyJson(approveAfterDeny)).status === 'denied', 'approve after deny reports denied');
  assert(messages.getByConversation(conv.id).length === countBefore4, 'approve after deny posts nothing');
  const denyAfterExecute = await post(denyRoute, { id: conv.id }, { code: code1 });
  assert(denyAfterExecute.status === 200, 'deny after execute returns 200');
  assert((await bodyJson(denyAfterExecute)).status === 'executed', 'deny after execute reports executed');
  assert(messages.getByConversation(conv.id).length === countBefore4, 'deny after execute posts nothing');

  // Case 5: unknown action type is refused, never executed.
  log('\nCase 5: unknown action refused');
  let threwUnknown = false;
  try {
    engine.createApprovalRequest({
      conversationId: conv.id, botId: gatekeeper.id, code: 'never-stored', actionType: 'teleport', actionArgs: {},
    });
  } catch (error) {
    threwUnknown = /unknown action type/.test(String(error && error.message));
  }
  assert(threwUnknown, 'creating a request with an unknown action type throws');
  assert(!engine.getApprovalByCode(conv.id, 'never-stored'), 'refused request stores nothing');
  const raw = new (require('better-sqlite3'))(DB_PATH);
  raw.prepare(
    `INSERT INTO approval_requests (id, conversation_id, bot_id, code, action_type, action_args, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    `injected-${process.pid}`, conv.id, gatekeeper.id, 'injected9', 'teleport', '{}', Date.now()
  );
  raw.close();
  const resultsBefore5 = countWhere(messages.getByConversation(conv.id), m => m.content.startsWith('[tool result]'));
  const approveUnknown = await post(approveRoute, { id: conv.id }, { code: 'injected9' });
  assert(approveUnknown.status === 400, `approve of an unknown action returns 400 (got ${approveUnknown.status})`);
  assert(/unknown action type/.test(JSON.stringify(await bodyJson(approveUnknown))), 'refusal names the unknown action');
  assert(engine.getApprovalByCode(conv.id, 'injected9')?.status === 'pending', 'refused request stays pending');
  assert(
    countWhere(messages.getByConversation(conv.id), m => m.content.startsWith('[tool result]')) === resultsBefore5,
    'unknown action never executes'
  );

  // Case 6: path traversal in read_file is refused.
  log('\nCase 6: path traversal refused');
  for (const name of ['../../etc/passwd', '..', '/etc/passwd', 'a/b.txt']) {
    let threw = false;
    try {
      engine.createApprovalRequest({
        conversationId: conv.id, botId: gatekeeper.id, code: `trav-${process.pid}-${name.length}`, actionType: 'read_file', actionArgs: { name },
      });
    } catch {
      threw = true;
    }
    assert(threw, `read_file refuses ${JSON.stringify(name)}`);
  }
  const cardsBefore6 = countWhere(messages.getByConversation(conv.id), m => draftLib.parseApprovalCode(m.content));
  await ask(gatekeeper, conv, 'read the file ../../etc/passwd');
  thread = messages.getByConversation(conv.id);
  assert(
    countWhere(thread, m => draftLib.parseApprovalCode(m.content)) === cardsBefore6,
    'traversal ask raises no approval card'
  );
  assert(
    countWhere(thread, m => m.content.startsWith('[tool result]')) === resultsBefore5,
    'traversal ask runs nothing'
  );

  // Case 7: request state persists across restart.
  log('\nCase 7: persistence across restart');
  const fresh = new (require('better-sqlite3'))(DB_PATH, { readonly: true });
  const reloaded1 = fresh.prepare('SELECT status, result FROM approval_requests WHERE conversation_id = ? AND code = ?').get(conv.id, code1);
  const reloaded3 = fresh.prepare('SELECT status FROM approval_requests WHERE conversation_id = ? AND code = ?').get(conv.id, code3);
  fresh.close();
  assert(reloaded1.status === 'executed' && reloaded1.result === 'notemint5', 'executed request and result survive reload');
  assert(reloaded3.status === 'denied', 'denied request survives reload');

  // Case 8: snapshot code sentence and a paraphrase raise; negatives do not.
  log('\nCase 8: snapshot sentence and paraphrase raise a request');
  const plainBot = bots.create({ deck_id: 'deck-test', name: 'Plainasker', title: '', description: 'Asks plainly.' });
  const plainConv = conversations.getByBotId(plainBot.id);
  agent.setDelegationChatStub(() => 'noted.');
  await ask(plainBot, plainConv, 'ask me to approve using the code gatekeep7 then wait');
  thread = messages.getByConversation(plainConv.id);
  const card8 = latestCard(thread);
  assert(!!card8 && card8.content.startsWith('Approve using the code gatekeep7'), 'snapshot sentence posts its card');
  assert(engine.getApprovalByCode(plainConv.id, 'gatekeep7')?.status === 'pending', 'snapshot sentence stores a pending request');
  await ask(plainBot, plainConv, 'please ask me to approve with the code gatekeep8 and wait');
  thread = messages.getByConversation(plainConv.id);
  assert(
    thread.some(m => m.sender_type === 'bot' && m.content.startsWith('Approve using the code gatekeep8')),
    'paraphrase posts its card'
  );
  const cardsBeforeNeg = countWhere(thread, m => draftLib.parseApprovalCode(m.content));
  await ask(plainBot, plainConv, 'approve this now');
  await ask(plainBot, plainConv, 'what is the approval code?');
  await ask(plainBot, plainConv, 'ask me to wait');
  thread = messages.getByConversation(plainConv.id);
  assert(
    countWhere(thread, m => draftLib.parseApprovalCode(m.content)) === cardsBeforeNeg,
    'negatives raise no request'
  );
  const plainApprove = await post(approveRoute, { id: plainConv.id }, { code: 'gatekeep7' });
  assert(plainApprove.status === 200, 'plain approve returns 200');
  assert((await bodyJson(plainApprove)).status === 'approved', 'plain approve records approved');
  assert(
    messages.getByConversation(plainConv.id).some(m => m.sender_type === 'bot' && m.content === 'gatekeep7'),
    'plain approve echoes the code in the thread'
  );
  agent.setDelegationChatStub(null);

  // Case 9: gated command prove action (snapshot sentence + paraphrase).
  log('\nCase 9: gated command approves once');
  await ask(gatekeeper, conv, 'run a command that prints the word boxmint8');
  thread = messages.getByConversation(conv.id);
  const card9 = latestCard(thread);
  assert(!!card9, 'snapshot command sentence posts an approval card');
  const code9 = draftLib.parseApprovalCode(card9.content);
  assert(engine.getApprovalByCode(conv.id, code9)?.action_type === 'run_command', 'request carries the run_command action');
  assert(
    countWhere(thread, m => m.content === '[tool result] boxmint8') === 0,
    'pending command does not run until approved'
  );
  const approve9 = await post(approveRoute, { id: conv.id }, { code: code9 });
  assert(approve9.status === 200, 'command approve returns 200');
  assert((await bodyJson(approve9)).status === 'executed', 'command approve executes');
  assert(
    countWhere(messages.getByConversation(conv.id), m => m.content === '[tool result] boxmint8') === 1,
    'command approve prints the word once'
  );
  const repeat9 = await post(approveRoute, { id: conv.id }, { code: code9 });
  assert(repeat9.status === 200 && (await bodyJson(repeat9)).status === 'executed', 'repeat command approve no-ops');
  assert(
    countWhere(messages.getByConversation(conv.id), m => m.content === '[tool result] boxmint8') === 1,
    'command still ran exactly once'
  );
  await ask(gatekeeper, conv, 'please execute a command to print the word hi9');
  thread = messages.getByConversation(conv.id);
  const card9b = latestCard(thread);
  assert(!!card9b && card9b.id !== card9.id, 'command paraphrase posts its own card');
  const approve9b = await post(approveRoute, { id: conv.id }, { code: draftLib.parseApprovalCode(card9b.content) });
  assert((await bodyJson(approve9b)).status === 'executed', 'command paraphrase executes');
  assert(
    messages.getByConversation(conv.id).some(m => m.content === '[tool result] hi9'),
    'command paraphrase prints its word'
  );
  const cardsBeforeCmdNeg = countWhere(messages.getByConversation(conv.id), m => draftLib.parseApprovalCode(m.content));
  agent.setDelegationChatStub(() => 'noted.');
  await ask(gatekeeper, conv, 'run a command');
  await ask(gatekeeper, conv, 'print hello');
  agent.setDelegationChatStub(null);
  assert(
    countWhere(messages.getByConversation(conv.id), m => draftLib.parseApprovalCode(m.content)) === cardsBeforeCmdNeg,
    'command negatives raise no request'
  );

  // Case 10: route validation.
  log('\nCase 10: route validation');
  assert((await post(approveRoute, { id: 'nope' }, { code: code1 })).status === 404, 'approve on unknown conversation -> 404');
  assert((await post(denyRoute, { id: 'nope' }, { code: code1 })).status === 404, 'deny on unknown conversation -> 404');
  assert((await post(approveRoute, { id: conv.id }, { messageId: 'nope' })).status === 400, 'approve on unknown message -> 400');
  assert((await post(denyRoute, { id: conv.id }, { messageId: 'nope' })).status === 400, 'deny on unknown message -> 400');
  const plainMsg = messages.create(conv.id, 'bot', 'just a reply', gatekeeper.id);
  assert((await post(approveRoute, { id: conv.id }, { messageId: plainMsg.id })).status === 400, 'approve on message without code -> 400');
  assert((await post(approveRoute, { id: conv.id }, { code: `missing-${process.pid}` })).status === 404, 'approve on unknown code -> 404');
  assert((await post(approveRoute, { id: conv.id }, {})).status === 400, 'approve without code -> 400');
  assert(
    (await post(approveRoute, { id: conv.id }, { messageId: card1.id, code: 'other-code' })).status === 400,
    'approve with mismatched code -> 400'
  );

  // Case 11: the model raises a gated request; unknown marker actions drop.
  log('\nCase 11: model-raised approval');
  writeFixture(`approvals-model-${process.pid}.txt`, 'model-bytes');
  const modelBot = bots.create({ deck_id: 'deck-test', name: 'Modelasker', title: '', description: 'Asks from the model.' });
  const modelConv = conversations.getByBotId(modelBot.id);
  agent.setDelegationChatStub(() =>
    `Approve using the code modelgate1.\n[approval-action] {"type": "read_file", "name": "approvals-model-${process.pid}.txt"}`
  );
  await ask(modelBot, modelConv, 'Do the thing that needs approval.');
  const modelRow = engine.getApprovalByCode(modelConv.id, 'modelgate1');
  assert(modelRow?.status === 'pending' && modelRow?.action_type === 'read_file', 'model marker stores a pending gated request');
  const modelApprove = await post(approveRoute, { id: modelConv.id }, { code: 'modelgate1' });
  assert((await bodyJson(modelApprove)).status === 'executed', 'model-raised request executes on approve');
  assert(
    messages.getByConversation(modelConv.id).some(m => m.content === '[tool result] model-bytes'),
    'model-raised read returns the file contents'
  );
  agent.setDelegationChatStub(() =>
    'Approve using the code modelgate2.\n[approval-action] {"type": "teleport", "where": "mars"}'
  );
  await ask(modelBot, modelConv, 'Do the other thing.');
  const droppedRow = engine.getApprovalByCode(modelConv.id, 'modelgate2');
  assert(droppedRow?.status === 'pending' && droppedRow?.action_type === null, 'unknown marker action drops to a plain request');
  const droppedApprove = await post(approveRoute, { id: modelConv.id }, { code: 'modelgate2' });
  assert((await bodyJson(droppedApprove)).status === 'approved', 'dropped-action approve records approved');
  assert(
    !messages.getByConversation(modelConv.id).some(m => m.content.startsWith('[tool result] mars')),
    'dropped action never executes'
  );
  agent.setDelegationChatStub(null);

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const file of tempFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    for (const file of tempSkills) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      try { fs.rmdirSync(path.dirname(file)); } catch { /* best effort */ }
    }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('approvals test crashed:', error);
    for (const file of tempFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    for (const file of tempSkills) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      try { fs.rmdirSync(path.dirname(file)); } catch { /* best effort */ }
    }
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
