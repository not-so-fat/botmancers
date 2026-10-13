#!/usr/bin/env node
// NOT-410: reference-only thread features (draft cards, approve/deny, file
// artifacts, handoff reveal, group rename).
//
// Self-contained like test-delegation.js: isolated SQLite file, stub model at
// the model-call boundary, real route handlers invoked in-process. No dev
// server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-thread-actions-test-${process.pid}.db`);
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
const draftLib = jiti('./lib/draft.ts');
const approvalsEngine = jiti('./lib/approvals.ts');

const draftRoute = jiti('./app/api/conversations/[id]/draft/route.ts');
const approveRoute = jiti('./app/api/conversations/[id]/approve/route.ts');
const denyRoute = jiti('./app/api/conversations/[id]/deny/route.ts');
const filesRoute = jiti('./app/api/files/[name]/route.ts');
const betweenRoute = jiti('./app/api/messages/[id]/between/route.ts');
const groupsRoute = jiti('./app/api/groups/route.ts');
const messagesRoute = jiti('./app/api/conversations/[id]/messages/route.ts');

const { bots, conversations, groups, messages, draftActions } = db;

let failures = 0;
const tempFiles = [];

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

function post(route, params, body) {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return route.POST(new Request('http://localhost/test', init), { params: Promise.resolve(params) });
}

function get(route, params, url = 'http://localhost/test') {
  return route.GET(new Request(url), { params: Promise.resolve(params) });
}

function patch(route, body) {
  return route.PATCH(new Request('http://localhost/test', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
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
  while (processed < cap && await agent.processNextQueueItem()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

function trackTempFile(name) {
  tempFiles.push(path.join(process.cwd(), 'files', name));
}

async function main() {
  log('NOT-410 thread-actions test (real handlers, isolated DB, stub model)');
  log(`DB: ${DB_PATH}`);

  const drafter = bots.create({ deck_id: 'deck-test', name: 'Drafter', title: '', description: 'Writes drafts.' });
  const checker = bots.create({ deck_id: 'deck-test', name: 'Checker', title: '', description: 'Checks drafts.' });
  const conv = conversations.getByBotId(drafter.id);
  const conv2 = conversations.getByBotId(checker.id);
  assert(!!conv && !!conv2, 'threads exist for both bots');

  // Case 1: draft send once.
  log('\nCase 1: draft send once');
  const draftMsg = messages.create(
    conv.id, 'bot', draftLib.serializeDraft({ channel: 'email', recipient: 'alice@example.com', body: 'Hello Alice', state: 'open' }), drafter.id
  );
  const parsed1 = draftLib.parseDraft(draftMsg.content);
  assert(parsed1 && parsed1.channel === 'email' && parsed1.recipient === 'alice@example.com', 'draft parses with channel and recipient');
  assert(draftLib.draftTitle('email') === 'New Email', 'email draft title renders');
  assert(draftLib.draftTitle('slack') === 'New Slack Message', 'slack draft title renders');
  const sendRes = await post(draftRoute, { id: conv.id }, {
    messageId: draftMsg.id, action: 'send', recipient: 'bob@example.com', body: 'Hi Bob',
  });
  assert(sendRes.status === 200, `send returns 200 (got ${sendRes.status})`);
  assert((await bodyJson(sendRes)).status === 'sent', 'send returns status sent');
  assert(draftLib.parseDraft(messages.getById(draftMsg.id).content).state === 'sent', 'send flips stored draft to sent');
  const thread1 = messages.getByConversation(conv.id);
  const sent = thread1.filter(m => m.content.startsWith('[Sent to bob@example.com]'));
  assert(sent.length === 1 && sent[0].content.includes('Hi Bob'), 'send records edited send in the thread only');
  const sendAgain = await post(draftRoute, { id: conv.id }, { messageId: draftMsg.id, action: 'send' });
  assert(sendAgain.status === 409, `second send rejected with 409 (got ${sendAgain.status})`);
  assert(draftActions.get(draftMsg.id).status === 'sent', 'draft send state persists server-side');
  const enriched1 = await (await get(messagesRoute, { id: conv.id })).json();
  assert(enriched1.find(m => m.id === draftMsg.id).draftStatus === 'sent', 'messages GET reports draft sent');

  // Case 2: draft discard once.
  log('\nCase 2: draft discard once');
  const draftMsg2 = messages.create(
    conv.id, 'bot', draftLib.serializeDraft({ channel: 'slack', recipient: 'carol', body: 'Hello Carol', state: 'open' }), drafter.id
  );
  const discardRes = await post(draftRoute, { id: conv.id }, { messageId: draftMsg2.id, action: 'discard', recipient: 'carol', body: 'Hello Carol' });
  assert(discardRes.status === 200, `discard returns 200 (got ${discardRes.status})`);
  assert((await bodyJson(discardRes)).status === 'discarded', 'discard returns status discarded');
  assert(draftLib.parseDraft(messages.getById(draftMsg2.id).content).state === 'discarded', 'discard flips stored draft to discarded');
  const discardAgain = await post(draftRoute, { id: conv.id }, { messageId: draftMsg2.id, action: 'discard' });
  assert(discardAgain.status === 409, `second discard rejected with 409 (got ${discardAgain.status})`);
  const sendAfterDiscard = await post(draftRoute, { id: conv.id }, { messageId: draftMsg2.id, action: 'send' });
  assert(sendAfterDiscard.status === 409, `send after discard rejected with 409 (got ${sendAfterDiscard.status})`);

  // Case 3: draft validation.
  log('\nCase 3: draft validation');
  const plain = messages.create(conv.id, 'bot', 'just a reply', drafter.id);
  assert((await post(draftRoute, { id: 'nope' }, { messageId: draftMsg.id, action: 'send' })).status === 404, 'unknown conversation -> 404');
  assert((await post(draftRoute, { id: conv.id }, { messageId: 'nope', action: 'send' })).status === 404, 'unknown message -> 404');
  assert((await post(draftRoute, { id: conv.id }, { messageId: plain.id, action: 'send' })).status === 400, 'non-draft message -> 400');
  assert((await post(draftRoute, { id: conv.id }, { messageId: draftMsg2.id, action: 'explode' })).status === 400, 'bad action -> 400');

  // Case 4: approve vs deny.
  log('\nCase 4: approve vs deny');
  const approvalMsg = messages.create(
    conv.id, 'bot', 'Please approve using the code gate42 to continue.', drafter.id
  );
  assert(draftLib.parseApprovalCode(approvalMsg.content) === 'gate42', 'approval code parses');
  const approveRes = await post(approveRoute, { id: conv.id }, { code: 'gate42' });
  assert(approveRes.status === 200, `approve returns 200 (got ${approveRes.status})`);
  assert((await bodyJson(approveRes)).status === 'approved', 'approve returns status approved');
  assert(
    messages.getByConversation(conv.id).filter(m => m.content === 'gate42').length === 1,
    'approval recorded in the thread'
  );
  const threadBeforeRepeat = messages.getByConversation(conv.id).length;
  const approveRepeat = await post(approveRoute, { id: conv.id }, { code: 'gate42' });
  assert(approveRepeat.status === 200, `second approve no-ops with 200 (got ${approveRepeat.status})`);
  assert((await bodyJson(approveRepeat)).status === 'approved', 'second approve reports stored status');
  assert(messages.getByConversation(conv.id).length === threadBeforeRepeat, 'second approve posts nothing');
  const denyAfterApprove = await post(denyRoute, { id: conv.id }, { code: 'gate42' });
  assert(denyAfterApprove.status === 200, `deny after approve no-ops with 200 (got ${denyAfterApprove.status})`);
  assert(messages.getByConversation(conv.id).length === threadBeforeRepeat, 'deny after approve posts nothing');
  const enriched2 = await (await get(messagesRoute, { id: conv.id })).json();
  assert(enriched2.find(m => m.id === approvalMsg.id).approvalStatus === 'approved', 'messages GET reports approval approved');

  const denyMsg = messages.create(
    conv.id, 'bot', 'Please approve using the code gate43 to continue.', drafter.id
  );
  const denyRes = await post(denyRoute, { id: conv.id }, { messageId: denyMsg.id });
  assert(denyRes.status === 200, `deny by messageId returns 200 (got ${denyRes.status})`);
  assert((await bodyJson(denyRes)).status === 'denied', 'deny returns status denied');
  assert(
    messages.getByConversation(conv.id).filter(m => m.content.startsWith('Denied') && m.content.includes('gate43')).length === 1,
    'denial recorded in the thread'
  );
  const threadBeforeAfterDeny = messages.getByConversation(conv.id).length;
  const approveAfterDeny = await post(approveRoute, { id: conv.id }, { code: 'gate43' });
  assert(approveAfterDeny.status === 200, `approve after deny no-ops with 200 (got ${approveAfterDeny.status})`);
  assert((await bodyJson(approveAfterDeny)).status === 'denied', 'approve after deny reports denied');
  assert(messages.getByConversation(conv.id).length === threadBeforeAfterDeny, 'approve after deny posts nothing');
  assert((await post(approveRoute, { id: conv.id }, { code: 'missing99' })).status === 404, 'unknown code -> 404');
  assert((await post(approveRoute, { id: conv.id }, {})).status === 400, 'missing code -> 400');
  assert((await post(approveRoute, { id: conv.id }, { messageId: 'nope' })).status === 400, 'unknown message -> 400');
  assert((await post(denyRoute, { id: 'nope' }, { code: 'gate42' })).status === 404, 'unknown conversation -> 404');

  // Case 5: file artifacts.
  log('\nCase 5: file artifacts');
  const probeName = `thread-actions-probe-${process.pid}.txt`;
  trackTempFile(probeName);
  fs.writeFileSync(path.join(process.cwd(), 'files', probeName), 'probe-bytes');
  const fileRes = await get(filesRoute, { name: probeName });
  assert(fileRes.status === 200, `existing file returns 200 (got ${fileRes.status})`);
  assert(
    (fileRes.headers.get('Content-Disposition') || '').startsWith('attachment'),
    'Content-Disposition is attachment'
  );
  assert((await fileRes.text()) === 'probe-bytes', 'file bytes served');
  const seedRes = await get(filesRoute, { name: 'filemint6.txt' });
  assert(seedRes.status === 200 && (await seedRes.text()).includes('filemint6'), 'seed file filemint6.txt downloads');
  assert(draftLib.parseFileNames('[file] filemint6.txt\nsee attached').includes('filemint6.txt'), '[file] marker parses');
  const traversal = await get(filesRoute, { name: '../../etc/passwd' });
  assert(traversal.status === 400, `GET /api/files/..%2F..%2Fetc%2Fpasswd rejected (got ${traversal.status})`);
  assert((await get(filesRoute, { name: '..' })).status === 400, 'dot name rejected');
  assert((await get(filesRoute, { name: `missing-${process.pid}.txt` })).status === 404, 'missing file -> 404');

  // Case 6: between returns only messages between the two anchors.
  log('\nCase 6: handoff reveal (between)');
  const start = messages.create(conv2.id, 'user', 'start');
  const handoff = messages.create(conv2.id, 'bot', '[Handing off to Checker]\nplease check', drafter.id);
  const between1 = messages.create(conv2.id, 'bot', 'filler one', drafter.id);
  const between2 = messages.create(conv2.id, 'bot', 'filler two', drafter.id);
  const target = messages.create(conv2.id, 'bot', 'checked ok', checker.id);
  assert(draftLib.parseHandoff(handoff.content) === 'Checker', 'handoff target parses');
  const betweenRes = await get(betweenRoute, { id: handoff.id }, `http://localhost/x?other=${target.id}`);
  assert(betweenRes.status === 200, `between returns 200 (got ${betweenRes.status})`);
  const betweenIds = (await betweenRes.json()).map(m => m.id);
  assert(
    betweenIds.length === 2 && betweenIds[0] === between1.id && betweenIds[1] === between2.id,
    'between returns only the messages between the two anchors, in order'
  );
  const reversed = await (await get(betweenRoute, { id: target.id }, `http://localhost/x?to=${handoff.id}`)).json();
  assert(reversed.map(m => m.id).join(',') === betweenIds.join(','), 'reversed anchors return the same set');
  const empty = await (await get(betweenRoute, { id: start.id }, `http://localhost/x?other=${start.id}`)).json();
  assert(Array.isArray(empty) && empty.length === 0, 'same anchor twice returns empty');
  assert((await get(betweenRoute, { id: 'nope' }, `http://localhost/x?other=${target.id}`)).status === 404, 'unknown anchor -> 404');
  assert((await get(betweenRoute, { id: handoff.id })).status === 400, 'missing other param -> 400');
  const foreign = messages.create(conv.id, 'user', 'other thread');
  assert(
    (await get(betweenRoute, { id: handoff.id }, `http://localhost/x?other=${foreign.id}`)).status === 400,
    'cross-conversation anchors -> 400'
  );

  // Case 7: group rename.
  log('\nCase 7: group rename');
  const group = groups.create('Old Name', [drafter.id, checker.id]);
  const renameRes = await patch(groupsRoute, { id: group.id, name: 'New Name' });
  assert(renameRes.status === 200, `PATCH rename returns 200 (got ${renameRes.status})`);
  assert(groups.getById(group.id).name === 'New Name', 'renamed name persists');
  const fresh = new (require('better-sqlite3'))(DB_PATH, { readonly: true });
  const reloaded = fresh.prepare('SELECT name FROM groups WHERE id = ?').get(group.id);
  fresh.close();
  assert(reloaded.name === 'New Name', 'renamed name survives reload');
  assert((await patch(groupsRoute, { id: 'nope', name: 'X' })).status === 404, 'unknown group -> 404');
  assert((await patch(groupsRoute, { id: group.id, name: '  ' })).status === 400, 'blank name -> 400');
  assert((await patch(groupsRoute, { name: 'X' })).status === 400, 'missing id -> 400');

  // Case 8: agent-loop hooks (stub model, no network).
  log('\nCase 8: agent-loop hooks');
  const hookFile = `hook-probe-${process.pid}.txt`;
  trackTempFile(hookFile);
  agent.setDelegationChatStub(() =>
    `[file] ${hookFile}\n\`\`\`text\nartifact-bytes\n\`\`\`\nPlease approve using the code hook99 to continue.`
  );
  messages.create(conv.id, 'user', 'Produce a file and an approval request.');
  const hookCount = db.queue.countPending(conv.id);
  db.queue.enqueue(conv.id, drafter.id);
  assert(db.queue.countPending(conv.id) === hookCount + 1, 'hook turn queued');
  await drain();
  const hookThread = messages.getByConversation(conv.id);
  const hookMsg = hookThread.find(m => m.sender_type === 'bot' && m.content.includes('[file]'));
  assert(!!hookMsg, 'bot reply with markers stored in thread');
  assert(approvalsEngine.getApprovalByCode(conv.id, 'hook99')?.status === 'pending', 'agent run records pending approval');
  const hookPath = path.join(process.cwd(), 'files', hookFile);
  assert(fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8') === 'artifact-bytes\n', 'agent run materializes the [file] payload');
  const hookApprove = await post(approveRoute, { id: conv.id }, { code: 'hook99' });
  assert(hookApprove.status === 200, `agent-recorded approval approves once (got ${hookApprove.status})`);
  agent.setDelegationChatStub(() => `[file] ../../evil-${process.pid}.txt\n\`\`\`text\nnope\n\`\`\``);
  messages.create(conv.id, 'user', 'Produce an unsafe file marker.');
  db.queue.enqueue(conv.id, drafter.id);
  await drain();
  assert(!fs.existsSync(path.join(process.cwd(), `evil-${process.pid}.txt`)), 'unsafe [file] name never written');
  assert(!fs.existsSync(path.join(process.cwd(), 'files', `evil-${process.pid}.txt`)), 'unsafe [file] name never materialized');
  agent.setDelegationChatStub(null);

  // Case 9: agent-loop draft hook (no stub output consumed).
  log('\nCase 9: agent-loop draft hook');
  assert(draftLib.outboundDraftFromUser('Please email Alice that says hello there')?.channel === 'email', 'email ask maps to email draft');
  assert(draftLib.outboundDraftFromUser('Please slack Bob saying standup moved')?.channel === 'slack', 'slack ask maps to slack draft');
  assert(draftLib.outboundDraftFromUser('Just say hi.') === null, 'plain ask creates no draft');
  let stubCalls = 0;
  agent.setDelegationChatStub(() => { stubCalls++; return 'should not be used'; });
  const hookBot = bots.create({ deck_id: 'deck-test', name: 'HookDrafter', title: '', description: 'Draft hook.' });
  const hookConv = conversations.getByBotId(hookBot.id);
  messages.create(hookConv.id, 'user', 'Please email Alice that says hello there');
  db.queue.enqueue(hookConv.id, hookBot.id);
  await drain();
  const hookDrafts = messages.getByConversation(hookConv.id).filter(m => draftLib.parseDraft(m.content));
  assert(hookDrafts.length === 1, 'email ask creates exactly one draft card');
  assert(hookDrafts[0] && draftLib.parseDraft(hookDrafts[0].content).body.includes('hello there'), 'draft body comes from the ask');
  assert(stubCalls === 0, 'draft hook answers without calling the model');
  db.queue.enqueue(hookConv.id, hookBot.id);
  await drain();
  assert(messages.getByConversation(hookConv.id).filter(m => draftLib.parseDraft(m.content)).length === 1, 'draft hook never fires twice for the same ask');
  agent.setDelegationChatStub(null);

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const file of tempFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('thread-actions test crashed:', error);
    for (const file of tempFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
