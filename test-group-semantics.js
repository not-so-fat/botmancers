#!/usr/bin/env node
// NOT-418: group conversation semantics (explicit in-group handoff, bare-name
// addressing, group size and owner rules).
//
// Self-contained: isolated SQLite file, deterministic stub model injected at
// the model-call boundary, real route handlers invoked in-process. No dev
// server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-group-semantics-test-${process.pid}.db`);
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
const groupsRoute = jiti('./app/api/groups/route.ts');
const messagesRoute = jiti('./app/api/conversations/[id]/messages/route.ts');

const { bots, conversations, messages, queue, groups } = db;

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drain(cap = 60) {
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

function postGroups(body) {
  return groupsRoute.POST(new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function postMessage(convId, body) {
  return messagesRoute.POST(new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: convId }) });
}

async function bodyJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function handoffIdsOf(msg) {
  if (!msg || !msg.handoff_targets) return [];
  try {
    const parsed = JSON.parse(msg.handoff_targets);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function main() {
  log('NOT-418 group-semantics test (stub model, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log('Deterministic stub serves all turns (no external model key required)');
  agent.resetDelegationForTests();

  // Case 1: snapshot handoff sentence posts once; rerun posts nothing more.
  log('\nCase 1: handoff once, no double reply on queue rerun');
  let caseFailures = failures;
  const ana = bots.create({ name: 'Ana', title: 'Planner', description: 'Plans.' });
  const ben = bots.create({ name: 'Ben', title: 'Writer', description: 'Writes.' });
  const cara = bots.create({ name: 'Cara', title: 'Watcher', description: 'Watches.' });
  const trio = groups.create('Trio', [ana.id, ben.id, cara.id]);
  const convTrio = conversations.getByGroupId(trio.id);
  assert(!!convTrio, 'three-bot group conversation exists');
  const SNAPSHOT_HANDOFF = '@Ana hand this to Ben: reply with exactly the word PLUM';
  const parsedSnapshot = agent.parseGroupHandoff(SNAPSHOT_HANDOFF);
  assert(
    !!parsedSnapshot && parsedSnapshot.fromName === 'Ana' && parsedSnapshot.toName === 'Ben' &&
    parsedSnapshot.task === 'reply with exactly the word PLUM',
    'snapshot sentence parses as a general handoff'
  );
  assert(agent.parseGroupHandoff('Hello everyone') === null, 'plain message is not a handoff');
  assert(agent.parseGroupHandoff('@Ana reply with exactly the word PLUM') === null, 'exact-word ask is not a handoff');
  let stubCalls1 = 0;
  agent.setDelegationChatStub(() => { stubCalls1++; return 'UNEXPECTED-MODEL-CALL'; });
  const user1 = messages.create(convTrio.id, 'user', SNAPSHOT_HANDOFF, undefined, [ana.id, ben.id]);
  await sleep(5);
  queue.enqueue(convTrio.id, ana.id);
  await sleep(5);
  queue.enqueue(convTrio.id, ben.id);
  await drain();
  const after1 = chainAfter(convTrio.id, user1.id);
  const handoffs1 = after1.filter(m =>
    m.sender_type === 'bot' && m.sender_id === ana.id && m.content.startsWith('[Handing off to Ben]')
  );
  const plums1 = after1.filter(m => m.sender_type === 'bot' && m.sender_id === ben.id && m.content === 'PLUM');
  const cara1 = after1.filter(m => m.sender_type === 'bot' && m.sender_id === cara.id);
  log(`  handoff: ${handoffs1.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  log(`  reply: ${plums1.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(handoffs1.length === 1, 'Ana posts one handoff');
  assert(handoffs1[0] && handoffs1[0].content === '[Handing off to Ben]\nreply with exactly the word PLUM', 'handoff marker carries the task');
  assert(plums1.length === 1, 'Ben replies PLUM once');
  assert(cara1.length === 0, 'third member posts nothing');
  assert(stubCalls1 === 0, 'snapshot handoff answers without calling the model');
  assert(queue.countPending(convTrio.id) === 0, 'queue drained after handoff');
  queue.enqueue(convTrio.id, ana.id);
  await sleep(5);
  queue.enqueue(convTrio.id, ben.id);
  await drain();
  const afterRerun = chainAfter(convTrio.id, user1.id);
  assert(afterRerun.filter(m => m.sender_type === 'bot' && m.sender_id === ana.id && m.content.startsWith('[Handing off to Ben]')).length === 1, 'rerun posts no second handoff');
  assert(afterRerun.filter(m => m.sender_type === 'bot' && m.sender_id === ben.id && m.content === 'PLUM').length === 1, 'rerun posts no second PLUM');
  if (failures === caseFailures) log('PASS: Case 1: handoff once, no double reply on queue rerun');

  // Case 2: general handoff task falls through to the model once.
  log('\nCase 2: general handoff task via the model');
  caseFailures = failures;
  assert(
    (agent.parseGroupHandoff('@Ana hand off to Ben: do the summary') || {}).task === 'do the summary',
    'hand off to variant parses'
  );
  assert(
    (agent.parseGroupHandoff('@Ana pass this to Ben: do the summary') || {}).task === 'do the summary',
    'pass this to variant parses'
  );
  let anaCalls2 = 0;
  let benCalls2 = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Ben') { benCalls2++; return 'Launch summary: Friday.'; }
    anaCalls2++;
    return 'UNEXPECTED-MODEL-CALL';
  });
  const user2 = messages.create(convTrio.id, 'user', '@Ana hand this to Ben: summarize the launch plan', undefined, [ana.id, ben.id]);
  await sleep(5);
  queue.enqueue(convTrio.id, ana.id);
  await sleep(5);
  queue.enqueue(convTrio.id, ben.id);
  await drain();
  const after2 = chainAfter(convTrio.id, user2.id);
  const handoffs2 = after2.filter(m => m.sender_type === 'bot' && m.sender_id === ana.id && m.content.startsWith('[Handing off to Ben]'));
  const summaries2 = after2.filter(m => m.sender_type === 'bot' && m.sender_id === ben.id);
  log(`  handoff: ${handoffs2.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  log(`  reply: ${summaries2.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(handoffs2.length === 1 && handoffs2[0].content === '[Handing off to Ben]\nsummarize the launch plan', 'general handoff posts one marker with the task');
  assert(summaries2.length === 1 && summaries2[0].content === 'Launch summary: Friday.', 'target answers the general task once via the model');
  assert(anaCalls2 === 0 && benCalls2 === 1, 'only the target calls the model, exactly once');
  queue.enqueue(convTrio.id, ana.id);
  await sleep(5);
  queue.enqueue(convTrio.id, ben.id);
  await drain();
  const after2Rerun = chainAfter(convTrio.id, user2.id);
  assert(after2Rerun.filter(m => m.sender_type === 'bot' && m.sender_id === ana.id && m.content.startsWith('[Handing off to Ben]')).length === 1, 'rerun posts no second general handoff');
  assert(after2Rerun.filter(m => m.sender_type === 'bot' && m.sender_id === ben.id).length === 1, 'rerun posts no second general reply');
  if (failures === caseFailures) log('PASS: Case 2: general handoff task via the model');

  // Case 3: bare names address only on word boundaries, only when two or
  // more member names appear, and only in group threads.
  log('\nCase 3: bare-name addressing');
  caseFailures = failures;
  const membersTrio = groups.getMembers(trio.id);
  assert(membersTrio.length === 3, 'trio has three members for bare-name checks');
  assert(messagesRoute.nameAsWord('Ana and Ben met', 'Ana') === true, 'bare Ana matches on word boundaries');
  assert(messagesRoute.nameAsWord('Anagram and Ben met', 'Ana') === false, 'Ana inside Anagram is a substring, not a word');
  assert(messagesRoute.nameAsWord('Ana, Ben and Cara met', 'Ben') === true, 'bare Ben matches beside punctuation');
  const bareTwo = messagesRoute.addressedBots('Ana and Ben met', undefined, true, membersTrio);
  assert(bareTwo.length === 2, 'two bare member names address both');
  assert(bareTwo.some(b => b.id === ana.id) && bareTwo.some(b => b.id === ben.id), 'bare pair names Ana and Ben');
  const bareSingle = messagesRoute.addressedBots('Ana met Cara', undefined, true, [ana]);
  assert(bareSingle.length === 0, 'single bare name never addresses (explicit allowlist of one)');
  const bareOneOfThree = messagesRoute.addressedBots('Ana went home', undefined, true, membersTrio);
  assert(bareOneOfThree.length === 0, 'one bare name among three members addresses nobody');
  const bareSubstring = messagesRoute.addressedBots('Anagram and Ben met', undefined, true, membersTrio);
  assert(bareSubstring.length === 0, 'substring Ana plus single Ben addresses nobody');
  const bareThree = messagesRoute.addressedBots('Ana, Ben and Cara met', undefined, true, membersTrio);
  assert(bareThree.length === 3, 'three bare member names address all three');
  assert(messagesRoute.addressedBots('Ana and Ben met', undefined, false, membersTrio).length === 0, 'bare names disabled addresses nobody');
  assert(messagesRoute.addressedBots('Ana and Ben met', undefined, true, []).length === 0, 'empty allowlist addresses nobody');
  const atSingle = messagesRoute.addressedBots('@Ana hello', undefined, false, []);
  assert(atSingle.length === 1 && atSingle[0].id === ana.id, '@-mention addresses a single bot without bare names');
  const explicitSingle = messagesRoute.addressedBots('hello', ana.id, false, []);
  assert(explicitSingle.length === 1 && explicitSingle[0].id === ana.id, 'explicit picker id addresses without bare names');

  agent.setDelegationChatStub(() => 'noted.');
  const bareRes = await postMessage(convTrio.id, { content: 'Ana and Ben met' });
  assert(bareRes.status === 200, `group bare-pair POST returns 200 (got ${bareRes.status})`);
  const bareMsg = await bodyJson(bareRes);
  const bareIds = handoffIdsOf(bareMsg);
  assert(bareIds.length === 2 && bareIds.includes(ana.id) && bareIds.includes(ben.id), 'group POST with two bare names stores both handoff targets');
  await drain();
  const singleRes = await postMessage(convTrio.id, { content: 'Ana went home' });
  const singleMsg = await bodyJson(singleRes);
  assert(handoffIdsOf(singleMsg).length === 0, 'group POST with one bare name stores no handoff targets');
  await drain();
  const convAnaDirect = conversations.getByBotId(ana.id);
  const directRes = await postMessage(convAnaDirect.id, { content: 'Ana and Ben met' });
  const directMsg = await bodyJson(directRes);
  assert(handoffIdsOf(directMsg).length === 0, 'direct POST with two bare names stores no targets (group only)');
  await drain();
  if (failures === caseFailures) log('PASS: Case 3: bare-name addressing');

  // Case 4: group size validation and owner rules.
  log('\nCase 4: group size and owner validation');
  caseFailures = failures;
  const sizeBots = [];
  for (let i = 0; i < 7; i++) {
    sizeBots.push(bots.create({ name: `Size${i}`, title: '', description: `Size probe ${i}.` }));
  }
  const oneRes = await postGroups({ name: 'Solo', botIds: [sizeBots[0].id] });
  assert(oneRes.status === 400, `1-member group rejected with 400 (got ${oneRes.status})`);
  assert(((await bodyJson(oneRes)) || {}).error === 'Pick 2 to 6 bots.', '1-member error line matches the UI');
  const sevenRes = await postGroups({ name: 'Crowd', botIds: sizeBots.map(b => b.id) });
  assert(sevenRes.status === 400, `7-member group rejected with 400 (got ${sevenRes.status})`);
  assert(((await bodyJson(sevenRes)) || {}).error === 'Pick 2 to 6 bots.', '7-member error line matches the UI');
  const twoRes = await postGroups({ name: 'Pair', botIds: [sizeBots[0].id, sizeBots[1].id] });
  assert(twoRes.status === 200, `2-member group accepted (got ${twoRes.status})`);
  const twoGroup = await bodyJson(twoRes);
  assert(twoGroup && twoGroup.members.length === 2, '2-member group stores both members');
  assert(twoGroup && twoGroup.owner_bot_id === sizeBots[0].id, 'missing owner defaults to the first pick');
  const sixRes = await postGroups({ name: 'Half dozen', botIds: sizeBots.slice(0, 6).map(b => b.id) });
  assert(sixRes.status === 200, `6-member group accepted (got ${sixRes.status})`);
  const ownerRes = await postGroups({ name: 'Owned', botIds: [sizeBots[0].id, sizeBots[1].id, sizeBots[2].id], ownerId: sizeBots[1].id });
  const ownerGroup = await bodyJson(ownerRes);
  assert(ownerRes.status === 200, `explicit owner accepted (got ${ownerRes.status})`);
  assert(ownerGroup && ownerGroup.owner_bot_id === sizeBots[1].id, 'explicit owner persists');
  const fallbackRes = await postGroups({ name: 'Fallback', botIds: [sizeBots[0].id, sizeBots[1].id], ownerId: sizeBots[6].id });
  const fallbackGroup = await bodyJson(fallbackRes);
  assert(fallbackRes.status === 200 && fallbackGroup.owner_bot_id === sizeBots[0].id, 'owner outside members falls back to the first pick');
  const unknownRes = await postGroups({ name: 'Unknown', botIds: [sizeBots[0].id, 'missing-bot'] });
  assert(unknownRes.status === 400, `unknown botId rejected with 400 (got ${unknownRes.status})`);
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert(pageSource.includes('Pick 2 to 6 bots.'), 'UI group tab shows the Pick 2 to 6 bots. error line');
  assert(pageSource.includes('picked.length < 2 || picked.length > 6'), 'UI group tab enforces 2 to 6 picks');
  assert(pageSource.includes('ownerId: picked[0].id'), 'UI group tab sends the first pick as owner');
  if (failures === caseFailures) log('PASS: Case 4: group size and owner validation');

  // Case 5: delegation depth stops an in-group handoff loop; Stop stops a
  // pending handoff target.
  log('\nCase 5: depth limit stops a handoff loop, Stop stops handoffs');
  caseFailures = failures;
  const MAX_DEPTH = agent.DELEGATION_MAX_DEPTH;
  assert(typeof MAX_DEPTH === 'number' && MAX_DEPTH > 0, `depth constant imported (DELEGATION_MAX_DEPTH=${MAX_DEPTH})`);
  const loopA = bots.create({ name: 'LoopA', title: '', description: 'Loops.' });
  const loopB = bots.create({ name: 'LoopB', title: '', description: 'Loops.' });
  const loopGroup = groups.create('Loop', [loopA.id, loopB.id]);
  const convLoop = conversations.getByGroupId(loopGroup.id);
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'LoopB') return 'WAKE LoopA: continue loop.';
    if (ctx.botName === 'LoopA') return 'WAKE LoopB: continue loop.';
    return 'noted.';
  });
  const userLoop = messages.create(convLoop.id, 'user', '@LoopA hand this to LoopB: start loop', undefined, [loopA.id, loopB.id]);
  await sleep(5);
  queue.enqueue(convLoop.id, loopA.id);
  await sleep(5);
  queue.enqueue(convLoop.id, loopB.id);
  await drain();
  const afterLoop = chainAfter(convLoop.id, userLoop.id);
  const loopHandoffs = afterLoop.filter(m => m.sender_type === 'bot' && m.content.includes('[Handing off to'));
  const loopDepth = afterLoop.find(m => m.sender_type === 'bot' && m.content.includes('Depth limit'));
  log(`  handoffs performed: ${loopHandoffs.length} (constant MAX_DEPTH=${MAX_DEPTH})`);
  log(`  reason: ${loopDepth ? JSON.stringify(loopDepth.content) : '(missing)'}`);
  assert(!!loopDepth, 'explicit depth reason posted for the handoff loop');
  assert(!!loopDepth && loopDepth.content.includes(String(MAX_DEPTH)), 'depth reason names the constant');
  assert(loopHandoffs.length === MAX_DEPTH, `handoffs stop at the constant (${MAX_DEPTH})`);
  assert(queue.countPending(convLoop.id) === 0, 'no further handoff queued after depth refusal');

  agent.setDelegationChatStub(() => 'UNEXPECTED-MODEL-CALL');
  const userStop = messages.create(convLoop.id, 'user', '@LoopA hand this to LoopB: reply with exactly the word STOPTEST', undefined, [loopA.id]);
  await sleep(5);
  queue.enqueue(convLoop.id, loopA.id);
  await agent.processNextQueueItem();
  await sleep(5);
  const midStop = chainAfter(convLoop.id, userStop.id);
  assert(midStop.some(m => m.sender_type === 'bot' && m.sender_id === loopA.id && m.content.startsWith('[Handing off to LoopB]')), 'handoff posted before Stop');
  assert(queue.countPending(convLoop.id) === 1, 'handoff target queued before Stop');
  const stopped = agent.stopDelegation(convLoop.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  const countAfterStop = messages.getByConversation(convLoop.id).length;
  await drain();
  const finalStop = messages.getByConversation(convLoop.id);
  assert(finalStop.length === countAfterStop, 'zero new messages after Stop');
  assert(!chainAfter(convLoop.id, userStop.id).some(m => m.sender_type === 'bot' && m.sender_id === loopB.id), 'handoff target never replies after Stop');
  if (failures === caseFailures) log('PASS: Case 5: depth limit stops a handoff loop, Stop stops handoffs');

  // Case 6: existing PASS, canned-handoff, exact-word and WAKE GROUP behavior unchanged.
  log('\nCase 6: existing PASS and exact-word behavior unchanged');
  caseFailures = failures;
  const passA = bots.create({ name: 'PassA', title: 'Helper', description: 'Helps.' });
  const passB = bots.create({ name: 'PassB', title: 'Helper', description: 'Helps.' });
  const passGroup = groups.create('PassGroup', [passA.id, passB.id]);
  const convPass = conversations.getByGroupId(passGroup.id);
  agent.setDelegationChatStub(() => 'PASS');
  const userPass = messages.create(convPass.id, 'user', 'Hello everyone');
  await sleep(5);
  queue.enqueue(convPass.id, passA.id);
  await sleep(5);
  queue.enqueue(convPass.id, passB.id);
  await drain();
  assert(chainAfter(convPass.id, userPass.id).filter(m => m.sender_type === 'bot').length === 0, 'open-group PASS replies are discarded');
  agent.setDelegationChatStub(() => 'WAKE PassB: Please review my research.');
  const userCanned = messages.create(convPass.id, 'user', 'Hello again');
  await sleep(5);
  queue.enqueue(convPass.id, passA.id);
  await sleep(5);
  queue.enqueue(convPass.id, passB.id);
  await drain();
  assert(chainAfter(convPass.id, userCanned.id).filter(m => m.sender_type === 'bot').length === 0, 'open-group canned handoffs are discarded');

  const plainA = bots.create({ name: 'PlainA', title: '', description: 'Answers plainly.' });
  const hookB = bots.create({ name: 'HookB', title: '', description: 'When asked, use WAKE PlainA: Please review my research.' });
  const exactGroup = groups.create('ExactGroup', [plainA.id, hookB.id]);
  const convExact = conversations.getByGroupId(exactGroup.id);
  let exactCalls = 0;
  agent.setDelegationChatStub(() => { exactCalls++; return 'UNEXPECTED-MODEL-CALL'; });
  const userExact = messages.create(convExact.id, 'user', 'reply with exactly the word MINT');
  await sleep(5);
  queue.enqueue(convExact.id, plainA.id);
  await sleep(5);
  queue.enqueue(convExact.id, hookB.id);
  await drain();
  const afterExact = chainAfter(convExact.id, userExact.id);
  assert(afterExact.filter(m => m.sender_type === 'bot' && m.sender_id === plainA.id && m.content === 'MINT').length === 1, 'plain member says the exact word');
  assert(afterExact.filter(m => m.sender_type === 'bot' && m.sender_id === hookB.id).length === 0, 'handoff member stays silent on unnamed exact-word ask');
  assert(exactCalls === 0, 'open-group exact-word answers without the model');
  const userNamed = messages.create(convExact.id, 'user', 'HookB, reply with exactly the word MINT');
  await sleep(5);
  queue.enqueue(convExact.id, plainA.id);
  await sleep(5);
  queue.enqueue(convExact.id, hookB.id);
  await drain();
  const afterNamed = chainAfter(convExact.id, userNamed.id);
  assert(afterNamed.filter(m => m.sender_type === 'bot' && m.sender_id === hookB.id && m.content === 'MINT').length === 1, 'named member says the exact word');
  assert(afterNamed.filter(m => m.sender_type === 'bot' && m.sender_id === plainA.id).length === 0, 'unnamed member stays silent on named exact-word ask');

  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'PassA') return 'WAKE GROUP: hello all';
    return 'noted.';
  });
  const userWakeGroup = messages.create(convPass.id, 'user', '@PassA hello', undefined, [passA.id]);
  await sleep(5);
  queue.enqueue(convPass.id, passA.id);
  await drain();
  const afterWakeGroup = chainAfter(convPass.id, userWakeGroup.id);
  assert(afterWakeGroup.some(m => m.sender_type === 'bot' && m.sender_id === passA.id && m.content === 'hello all'), 'WAKE GROUP posts its message');
  assert(afterWakeGroup.some(m => m.sender_type === 'bot' && m.sender_id === passB.id), 'WAKE GROUP wakes another member');
  if (failures === caseFailures) log('PASS: Case 6: existing PASS and exact-word behavior unchanged');

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
    console.error('group-semantics test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
