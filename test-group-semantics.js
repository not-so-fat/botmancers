#!/usr/bin/env node
// NOT-418: group conversation semantics (explicit in-group handoff, bare-name
// addressing, group size and owner rules).
//
// Self-contained: isolated SQLite file, deterministic stub model injected at
// the model-call boundary, real route handlers invoked in-process. No dev
// server, no API key, no network.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
const botsRoute = jiti('./app/api/bots/route.ts');
const conversationsRoute = jiti('./app/api/conversations/route.ts');

const { bots, conversations, messages, groups } = db;
const { uiTurns } = jiti('./lib/ui-turns.ts');

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
  while (processed < cap && await agent.processNextUiTurn()) {
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

function patchGroups(body) {
  return groupsRoute.PATCH(new Request('http://localhost/test', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function patchBots(body) {
  return botsRoute.PATCH(new Request('http://localhost/test', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// NOT-461: every stored group row plus the records its conversations own.
function groupDigest() {
  const raw = db.default;
  const groupConvs = "SELECT id FROM conversations WHERE type = 'group'";
  const tables = {
    groups: raw.prepare('SELECT * FROM groups ORDER BY id').all(),
    group_members: raw.prepare('SELECT * FROM group_members ORDER BY group_id, bot_id').all(),
    conversations: raw.prepare("SELECT * FROM conversations WHERE type = 'group' ORDER BY id").all(),
    messages: raw.prepare(`SELECT * FROM messages WHERE conversation_id IN (${groupConvs}) ORDER BY id`).all(),
    conversation_participants: raw.prepare(
      `SELECT * FROM conversation_participants WHERE conversation_id IN (${groupConvs}) ORDER BY conversation_id, participant_kind, participant_id`
    ).all(),
  };
  const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  const hash = crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex');
  return { hash, counts, tables };
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
  const ana = bots.create({ deck_id: 'deck-test', name: 'Ana', title: 'Planner', description: 'Plans.' });
  const ben = bots.create({ deck_id: 'deck-test', name: 'Ben', title: 'Writer', description: 'Writes.' });
  const cara = bots.create({ deck_id: 'deck-test', name: 'Cara', title: 'Watcher', description: 'Watches.' });
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
  uiTurns.enqueue(convTrio.id, ana.id);
  await sleep(5);
  uiTurns.enqueue(convTrio.id, ben.id);
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
  assert(uiTurns.countPending(convTrio.id) === 0, 'queue drained after handoff');
  uiTurns.enqueue(convTrio.id, ana.id);
  await sleep(5);
  uiTurns.enqueue(convTrio.id, ben.id);
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
  uiTurns.enqueue(convTrio.id, ana.id);
  await sleep(5);
  uiTurns.enqueue(convTrio.id, ben.id);
  await drain();
  const after2 = chainAfter(convTrio.id, user2.id);
  const handoffs2 = after2.filter(m => m.sender_type === 'bot' && m.sender_id === ana.id && m.content.startsWith('[Handing off to Ben]'));
  const summaries2 = after2.filter(m => m.sender_type === 'bot' && m.sender_id === ben.id);
  log(`  handoff: ${handoffs2.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  log(`  reply: ${summaries2.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(handoffs2.length === 1 && handoffs2[0].content === '[Handing off to Ben]\nsummarize the launch plan', 'general handoff posts one marker with the task');
  assert(summaries2.length === 1 && summaries2[0].content === 'Launch summary: Friday.', 'target answers the general task once via the model');
  assert(anaCalls2 === 0 && benCalls2 === 1, 'only the target calls the model, exactly once');
  uiTurns.enqueue(convTrio.id, ana.id);
  await sleep(5);
  uiTurns.enqueue(convTrio.id, ben.id);
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
    sizeBots.push(bots.create({ deck_id: 'deck-test', name: `Size${i}`, title: '', description: `Size probe ${i}.` }));
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
  // NOT-461: the UI no longer creates groups; the API keeps the 2-6 rule.
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert(!pageSource.includes('Pick 2 to 6 bots.') && !pageSource.includes('/api/groups'), 'UI has no group tab or group create call');
  if (failures === caseFailures) log('PASS: Case 4: group size and owner validation');

  // Case 5: delegation depth stops an in-group handoff loop; Stop stops a
  // pending handoff target.
  log('\nCase 5: depth limit stops a handoff loop, Stop stops handoffs');
  caseFailures = failures;
  const MAX_DEPTH = agent.DELEGATION_MAX_DEPTH;
  assert(typeof MAX_DEPTH === 'number' && MAX_DEPTH > 0, `depth constant imported (DELEGATION_MAX_DEPTH=${MAX_DEPTH})`);
  const loopA = bots.create({ deck_id: 'deck-test', name: 'LoopA', title: '', description: 'Loops.' });
  const loopB = bots.create({ deck_id: 'deck-test', name: 'LoopB', title: '', description: 'Loops.' });
  const loopGroup = groups.create('Loop', [loopA.id, loopB.id]);
  const convLoop = conversations.getByGroupId(loopGroup.id);
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'LoopB') return 'WAKE LoopA: continue loop.';
    if (ctx.botName === 'LoopA') return 'WAKE LoopB: continue loop.';
    return 'noted.';
  });
  const userLoop = messages.create(convLoop.id, 'user', '@LoopA hand this to LoopB: start loop', undefined, [loopA.id, loopB.id]);
  await sleep(5);
  uiTurns.enqueue(convLoop.id, loopA.id);
  await sleep(5);
  uiTurns.enqueue(convLoop.id, loopB.id);
  await drain();
  const afterLoop = chainAfter(convLoop.id, userLoop.id);
  const loopHandoffs = afterLoop.filter(m => m.sender_type === 'bot' && m.content.includes('[Handing off to'));
  const loopDepth = afterLoop.find(m => m.sender_type === 'bot' && m.content.includes('Depth limit'));
  log(`  handoffs performed: ${loopHandoffs.length} (constant MAX_DEPTH=${MAX_DEPTH})`);
  log(`  reason: ${loopDepth ? JSON.stringify(loopDepth.content) : '(missing)'}`);
  assert(!!loopDepth, 'explicit depth reason posted for the handoff loop');
  assert(!!loopDepth && loopDepth.content.includes(String(MAX_DEPTH)), 'depth reason names the constant');
  assert(loopHandoffs.length === MAX_DEPTH, `handoffs stop at the constant (${MAX_DEPTH})`);
  assert(uiTurns.countPending(convLoop.id) === 0, 'no further handoff queued after depth refusal');

  agent.setDelegationChatStub(() => 'UNEXPECTED-MODEL-CALL');
  const userStop = messages.create(convLoop.id, 'user', '@LoopA hand this to LoopB: reply with exactly the word STOPTEST', undefined, [loopA.id]);
  await sleep(5);
  uiTurns.enqueue(convLoop.id, loopA.id);
  await agent.processNextUiTurn();
  await sleep(5);
  const midStop = chainAfter(convLoop.id, userStop.id);
  assert(midStop.some(m => m.sender_type === 'bot' && m.sender_id === loopA.id && m.content.startsWith('[Handing off to LoopB]')), 'handoff posted before Stop');
  assert(uiTurns.countPending(convLoop.id) === 1, 'handoff target queued before Stop');
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
  const passA = bots.create({ deck_id: 'deck-test', name: 'PassA', title: 'Helper', description: 'Helps.' });
  const passB = bots.create({ deck_id: 'deck-test', name: 'PassB', title: 'Helper', description: 'Helps.' });
  const passGroup = groups.create('PassGroup', [passA.id, passB.id]);
  const convPass = conversations.getByGroupId(passGroup.id);
  agent.setDelegationChatStub(() => 'PASS');
  const userPass = messages.create(convPass.id, 'user', 'Hello everyone');
  await sleep(5);
  uiTurns.enqueue(convPass.id, passA.id);
  await sleep(5);
  uiTurns.enqueue(convPass.id, passB.id);
  await drain();
  assert(chainAfter(convPass.id, userPass.id).filter(m => m.sender_type === 'bot').length === 0, 'open-group PASS replies are discarded');
  agent.setDelegationChatStub(() => 'WAKE PassB: Please review my research.');
  const userCanned = messages.create(convPass.id, 'user', 'Hello again');
  await sleep(5);
  uiTurns.enqueue(convPass.id, passA.id);
  await sleep(5);
  uiTurns.enqueue(convPass.id, passB.id);
  await drain();
  assert(chainAfter(convPass.id, userCanned.id).filter(m => m.sender_type === 'bot').length === 0, 'open-group canned handoffs are discarded');

  const plainA = bots.create({ deck_id: 'deck-test', name: 'PlainA', title: '', description: 'Answers plainly.' });
  const hookB = bots.create({ deck_id: 'deck-test', name: 'HookB', title: '', description: 'When asked, use WAKE PlainA: Please review my research.' });
  const exactGroup = groups.create('ExactGroup', [plainA.id, hookB.id]);
  const convExact = conversations.getByGroupId(exactGroup.id);
  let exactCalls = 0;
  agent.setDelegationChatStub(() => { exactCalls++; return 'UNEXPECTED-MODEL-CALL'; });
  const userExact = messages.create(convExact.id, 'user', 'reply with exactly the word MINT');
  await sleep(5);
  uiTurns.enqueue(convExact.id, plainA.id);
  await sleep(5);
  uiTurns.enqueue(convExact.id, hookB.id);
  // Let the clock pass the last enqueue so a peer reply drained next can
  // never share its millisecond (open-group turns compare created_at).
  await sleep(5);
  await drain();
  const afterExact = chainAfter(convExact.id, userExact.id);
  assert(afterExact.filter(m => m.sender_type === 'bot' && m.sender_id === plainA.id && m.content === 'MINT').length === 1, 'plain member says the exact word');
  assert(afterExact.filter(m => m.sender_type === 'bot' && m.sender_id === hookB.id).length === 0, 'handoff member stays silent on unnamed exact-word ask');
  assert(exactCalls === 0, 'open-group exact-word answers without the model');
  const userNamed = messages.create(convExact.id, 'user', 'HookB, reply with exactly the word MINT');
  await sleep(5);
  uiTurns.enqueue(convExact.id, plainA.id);
  await sleep(5);
  uiTurns.enqueue(convExact.id, hookB.id);
  // Let the clock pass the last enqueue so a peer reply drained next can
  // never share its millisecond (open-group turns compare created_at).
  await sleep(5);
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
  uiTurns.enqueue(convPass.id, passA.id);
  await drain();
  const afterWakeGroup = chainAfter(convPass.id, userWakeGroup.id);
  assert(afterWakeGroup.some(m => m.sender_type === 'bot' && m.sender_id === passA.id && m.content === 'hello all'), 'WAKE GROUP posts its message');
  assert(afterWakeGroup.some(m => m.sender_type === 'bot' && m.sender_id === passB.id), 'WAKE GROUP wakes another member');
  if (failures === caseFailures) log('PASS: Case 6: existing PASS and exact-word behavior unchanged');

  // Case 7 (NOT-459): agent deletion reconciles groups in one transaction.
  log('\nCase 7: deletion keeps groups at two or more members with a deterministic owner');
  caseFailures = failures;
  const t0 = 1_800_000_000_000;
  const mk = (name, at, id) => bots.create({ deck_id: 'deck-test', name, title: '', description: '' }, { id, created_at: at });
  const dOwner = mk('DelOwner', t0);
  const dLate = mk('DelLate', t0 + 30);
  const dTieB = mk('DelTieB', t0 + 20, 'tie-bbbb');
  const dTieA = mk('DelTieA', t0 + 20, 'tie-aaaa');
  const quadGroup = groups.create('OwnerQuad', [dOwner.id, dLate.id, dTieB.id, dTieA.id], dOwner.id);
  const ownerPreview = bots.deletionPreview([dOwner.id]);
  const ownerImpact = ownerPreview.groups.find(g => g.id === quadGroup.id);
  assert(ownerImpact && ownerImpact.outcome === 'reassigned' && ownerImpact.newOwner.id === 'tie-aaaa', 'preview reassigns to earliest created_at, id tie-break');
  bots.removeMany([dOwner.id]);
  const afterOwner = groups.getById(quadGroup.id);
  assert(afterOwner && afterOwner.owner_bot_id === 'tie-aaaa', 'deleted owner passes to the earliest-created member (tie broken by id)');
  assert(groups.getMembers(quadGroup.id).length === 3, 'three members remain');
  const ownerConv = conversations.getByGroupId(quadGroup.id);
  const ownerParticipants = db.default.prepare(
    "SELECT participant_id FROM conversation_participants WHERE conversation_id = ? AND participant_kind = 'bot'"
  ).all(ownerConv.id).map(row => row.participant_id);
  assert(!ownerParticipants.includes(dOwner.id) && ownerParticipants.length === 3, 'deleted agent leaves the group conversation participants');

  const pairA = mk('PairA', t0 + 40);
  const pairB = mk('PairB', t0 + 41);
  const delPairGroup = groups.create('Pair', [pairA.id, pairB.id], pairA.id);
  const pairConv = conversations.getByGroupId(delPairGroup.id);
  messages.create(pairConv.id, 'user', 'pair hello');
  messages.create(pairConv.id, 'bot', 'pair reply', pairB.id);
  const pairTurn = uiTurns.enqueue(pairConv.id, pairB.id);
  uiTurns.start(pairTurn.id);
  uiTurns.finish(pairTurn.id, 'completed');
  const pairPreview = bots.deletionPreview([pairA.id]);
  assert(pairPreview.groups.find(g => g.id === delPairGroup.id).outcome === 'removed', 'preview removes a two-member group losing one');
  bots.removeMany([pairA.id]);
  assert(!groups.getById(delPairGroup.id), 'two-member group is deleted when one member goes');
  assert(!conversations.getById(pairConv.id), 'its conversation is deleted');
  assert(messages.getByConversation(pairConv.id).length === 0, 'its messages are deleted');
  assert(uiTurns.listByConversation(pairConv.id).length === 0, 'its UI turns are deleted');
  assert(bots.getById(pairB.id) && conversations.getByBotId(pairB.id), 'surviving member and its direct conversation stay');

  const m1 = mk('Multi1', t0 + 50);
  const m2 = mk('Multi2', t0 + 51);
  const m3 = mk('Multi3', t0 + 52);
  const m4 = mk('Multi4', t0 + 53);
  const m5 = mk('Multi5', t0 + 54);
  const keepGroup = groups.create('MultiKeep', [m1.id, m2.id, m3.id, m4.id, m5.id], m3.id);
  const dropGroup = groups.create('MultiDrop', [m1.id, m2.id, m4.id], m4.id);
  const reassignGroup = groups.create('MultiReassign', [m2.id, m4.id, m5.id, m1.id], m1.id);
  const multiPreview = bots.deletionPreview([m1.id, m2.id]);
  const outcome = id => multiPreview.groups.find(g => g.id === id);
  assert(outcome(keepGroup.id).outcome === 'shrunk' && outcome(keepGroup.id).remaining === 3, 'preview: owner kept, three remain');
  assert(outcome(dropGroup.id).outcome === 'removed', 'preview: group left with one member is removed');
  assert(outcome(reassignGroup.id).outcome === 'reassigned' && outcome(reassignGroup.id).newOwner.id === m4.id, 'preview: owner reassigned to the earliest remaining member');
  bots.removeMany([m1.id, m2.id]);
  assert(groups.getById(keepGroup.id).owner_bot_id === m3.id && groups.getMembers(keepGroup.id).length === 3, 'multi-delete: surviving owner kept, three members remain');
  assert(!groups.getById(dropGroup.id), 'multi-delete: group with one member left is removed');
  assert(groups.getById(reassignGroup.id).owner_bot_id === m4.id && groups.getMembers(reassignGroup.id).length === 2, 'multi-delete: owner reassigned and two members remain');
  const undersized = db.default.prepare(
    'SELECT g.id FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id GROUP BY g.id HAVING COUNT(gm.bot_id) < 2'
  ).all();
  assert(undersized.length === 0, 'no surviving group has fewer than two members');
  if (failures === caseFailures) log('PASS: Case 7: deletion keeps groups at two or more members with a deterministic owner');

  // Case 8 (NOT-461): the agent-only UI hides stored groups without
  // touching them, and the /api/groups contract is unchanged.
  log('\nCase 8: stored groups survive schema init and an agent-only UI session byte-for-byte');
  caseFailures = failures;
  const keepA = bots.create({ deck_id: 'deck-test', name: 'KeepA', title: '', description: 'Keeps.' });
  const keepB = bots.create({ deck_id: 'deck-test', name: 'KeepB', title: '', description: 'Keeps.' });
  const createRes = await postGroups({ name: 'Legacy Crew', botIds: [keepA.id, keepB.id], ownerId: keepB.id });
  const legacy = await bodyJson(createRes);
  assert(createRes.status === 200 && legacy.owner_bot_id === keepB.id && legacy.members.length === 2, 'POST /api/groups still creates a group with owner and members');
  const renameRes = await patchGroups({ id: legacy.id, name: 'Legacy Crew Renamed' });
  assert(renameRes.status === 200 && (await bodyJson(renameRes)).name === 'Legacy Crew Renamed', 'PATCH /api/groups still renames');
  const listed = await bodyJson(await groupsRoute.GET());
  assert(Array.isArray(listed) && listed.some(g => g.id === legacy.id && g.members.length === 2), 'GET /api/groups still lists groups with members');
  const legacyConvRes = await conversationsRoute.GET(new Request(`http://localhost/api/conversations?groupId=${legacy.id}`));
  const legacyConv = await bodyJson(legacyConvRes);
  assert(legacyConvRes.status === 200 && legacyConv.type === 'group', 'GET /api/conversations?groupId= still resolves the group conversation');
  const legacyPost = await postMessage(legacyConv.id, { content: 'legacy hello', idempotencyKey: crypto.randomUUID() });
  assert(legacyPost.status === 200 || legacyPost.status === 201, `group message POST still accepted (got ${legacyPost.status})`);
  // Settle the replies earlier cases and this post queued so the digest
  // captures stored data only.
  await drain();
  await sleep(50);
  await drain();

  const before = groupDigest();
  log(`  before: sha256=${before.hash} ${JSON.stringify(before.counts)}`);
  assert(before.counts.groups > 0 && before.counts.group_members > 0 && before.counts.messages > 0 && before.counts.conversation_participants > 0, 'fixture holds groups, memberships, messages, and participants');

  execFileSync(process.execPath, ['-e', "require('jiti').createJiti(process.cwd() + '/x.js', { alias: { '@': process.cwd() } })('./lib/db.ts')"], {
    cwd: ROOT,
    env: { ...process.env, BOTMANCERS_DB_PATH: DB_PATH, BOTMANCERS_NO_AUTOPROCESS: '1' },
    stdio: 'ignore',
  });
  const afterInit = groupDigest();
  log(`  after schema init: sha256=${afterInit.hash}`);
  assert(afterInit.hash === before.hash, 'schema initialization leaves group records byte-for-byte unchanged');

  // The calls app/page.tsx makes in an agent-only session; the group
  // digest is rechecked after each one.
  const unchanged = label => {
    const now = groupDigest();
    if (!assert(now.hash === before.hash, `${label}: group records byte-for-byte unchanged`)) {
      for (const name of Object.keys(now.tables)) {
        const was = new Set(before.tables[name].map(row => JSON.stringify(row)));
        for (const row of now.tables[name]) if (!was.has(JSON.stringify(row))) log(`    changed ${name}: ${JSON.stringify(row).slice(0, 300)}`);
      }
    }
  };
  const roster = await bodyJson(await botsRoute.GET());
  assert(Array.isArray(roster) && roster.some(b => b.id === keepA.id), 'GET /api/bots lists agents');
  unchanged('GET /api/bots');
  const agentConv = await bodyJson(await conversationsRoute.GET(new Request(`http://localhost/api/conversations?botId=${keepA.id}`)));
  unchanged('GET /api/conversations?botId=');
  const agentPost = await postMessage(agentConv.id, { content: '@KeepA hello', mentionedBotId: keepA.id, idempotencyKey: crypto.randomUUID() });
  assert(agentPost.status === 200 || agentPost.status === 201, `agent message POST accepted (got ${agentPost.status})`);
  unchanged('POST agent message');
  await drain();
  await sleep(20);
  unchanged('agent turn processed');
  await messagesRoute.GET(new Request('http://localhost/test'), { params: Promise.resolve({ id: agentConv.id }) });
  unchanged('GET agent messages');
  assert((await patchBots({ id: keepA.id, pinned: 1 })).status === 200, 'pin agent');
  assert((await patchBots({ id: keepA.id, hidden: 1 })).status === 200 && (await patchBots({ id: keepA.id, hidden: 0 })).status === 200, 'hide and unhide agent');
  assert((await patchBots({ id: keepA.id, unread: 1 })).status === 200, 'mark agent unread');
  unchanged('pin, hide, unhide, mark unread');
  assert((await patchBots({ id: keepA.id, name: 'KeepAlpha' })).status === 200, 'rename agent');
  unchanged('rename agent');
  const keepConn = db.runtimeConnections.ensureLocal('codex');
  const createdAgent = await botsRoute.POST(new Request('http://localhost/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'KeepNew',
      runtime_connection_id: keepConn,
      session_scope: { kind: 'all_provider_sessions' },
      policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    }),
  }));
  assert(createdAgent.status === 200 || createdAgent.status === 201, `create agent (got ${createdAgent.status})`);
  unchanged('create agent');
  if (failures === caseFailures) log('PASS: Case 8: stored groups survive schema init and an agent-only UI session byte-for-byte');

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
