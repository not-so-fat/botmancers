#!/usr/bin/env node
// NOT-415: ask-and-wait (a bot asks the person one question, waits, and
// resumes with the answer).
//
// Self-contained: isolated SQLite file, deterministic stub model injected at
// the model-call boundary. No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-ask-and-wait-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const ask = jiti('./lib/ask.ts');

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

async function drain(cap = 40) {
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

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

// Stub model shared by the marker tests: asks until the resume context
// arrives, then continues the parked task with the answer exactly once.
function askThenResumeStub(resultWord) {
  return ctx => {
    const sent = ctx.sent.map(part => part.content).join('\n---\n');
    if (sent.includes('[ask-resume]')) return `${resultWord}: Lisbon.`;
    return '[ASK] which city?';
  };
}

async function main() {
  log('NOT-415 ask-and-wait test (stub model, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log('Deterministic stub serves all turns (no external model key required)');

  // Case 1: ask then answer resumes once (model-marker path, direct thread).
  log('\nCase 1: ask then answer resumes once');
  let caseFailures = failures;
  const tripA = bots.create({ name: 'TripA', title: 'Planner', description: 'Plans trips.' });
  const convA = conversations.getByBotId(tripA.id);
  const unrelated = bots.create({ name: 'Unrelated', title: 'Other', description: 'Untouched.' });
  const convOther = conversations.getByBotId(unrelated.id);
  const otherBefore = messages.getByConversation(convOther.id).length;
  agent.setDelegationChatStub(askThenResumeStub('Trip booked'));
  const task1 = messages.create(convA.id, 'user', 'Plan my trip.');
  await sleep(5);
  queue.enqueue(convA.id, tripA.id);
  await drain();
  const afterAsk = chainAfter(convA.id, task1.id);
  const question1 = afterAsk.find(m => m.sender_type === 'bot' && m.sender_id === tripA.id);
  log(`  question: ${question1 ? JSON.stringify(question1.content) : '(missing)'}`);
  assert(!!question1 && question1.content === 'which city?', 'question posted as an ordinary bot card');
  assert(!!question1 && !question1.content.includes('[ASK]'), 'raw marker never posted');
  assert(afterAsk.filter(m => m.sender_type === 'bot').length === 1, 'exactly one bot message for the ask');
  const pending1 = ask.listAskedForConversation(convA.id);
  assert(pending1.length === 1 && pending1[0].bot_id === tripA.id, 'one asked row for the asking bot');
  assert(pending1[0] && pending1[0].question === 'which city?', 'row stores the question text');
  assert(pending1[0] && pending1[0].task_message_id === task1.id, 'row stores the originating task message');
  assert(pending1[0] && pending1[0].status === 'asked', 'row status is asked');
  assert(ask.resumeBotIdsForConversation(convA.id)?.join() === tripA.id, 'routing helper names only the asked bot');

  const answer1 = messages.create(convA.id, 'user', 'Lisbon');
  await sleep(5);
  for (const botId of ask.resumeBotIdsForConversation(convA.id) || [tripA.id]) {
    queue.enqueue(convA.id, botId);
  }
  await drain();
  const afterAnswer = chainAfter(convA.id, answer1.id);
  const botReplies1 = afterAnswer.filter(m => m.sender_type === 'bot');
  log(`  resume: ${botReplies1.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(botReplies1.length === 1, 'exactly one bot reply after the answer');
  assert(botReplies1[0] && botReplies1[0].sender_id === tripA.id, 'the same bot resumes');
  assert(botReplies1[0] && botReplies1[0].content.includes('Lisbon'), 'the answer is used in the resumed turn');
  assert(botReplies1[0] && countOccurrences(botReplies1[0].content, 'Lisbon') === 1, 'Lisbon appears exactly once');
  assert(ask.listAskedForConversation(convA.id).length === 0, 'no asked row remains after resume');
  const answered1 = ask.listForConversation(convA.id);
  assert(answered1.length === 1 && answered1[0].status === 'answered', 'row status is answered');
  assert(answered1[0] && answered1[0].answer === 'Lisbon', 'row stores the answer');
  const countBeforeRedrain = messages.getByConversation(convA.id).length;
  await drain();
  assert(messages.getByConversation(convA.id).length === countBeforeRedrain, 'no double reply on redrain');
  assert(messages.getByConversation(convOther.id).length === otherBefore, 'unrelated thread untouched');
  assert(queue.countPending(convA.id) === 0, 'queue drained');
  if (failures === caseFailures) log('PASS: Case 1: ask then answer resumes once');

  // Case 2: restart persistence (pending row survives in-memory reset).
  log('\nCase 2: restart persistence');
  caseFailures = failures;
  const tripB = bots.create({ name: 'TripB', title: 'Planner', description: 'Plans trips.' });
  const convB = conversations.getByBotId(tripB.id);
  agent.setDelegationChatStub(askThenResumeStub('Trip booked'));
  const task2 = messages.create(convB.id, 'user', 'Plan my trip.');
  await sleep(5);
  queue.enqueue(convB.id, tripB.id);
  await drain();
  assert(ask.listAskedForConversation(convB.id).length === 1, 'question parked before restart');
  agent.resetDelegationForTests(); // drops all in-memory chains/stubs; DB rows remain
  assert(ask.listAskedForConversation(convB.id).length === 1, 'asked row still in DB after restart');
  agent.setDelegationChatStub(askThenResumeStub('Trip booked'));
  const answer2 = messages.create(convB.id, 'user', 'Lisbon');
  await sleep(5);
  for (const botId of ask.resumeBotIdsForConversation(convB.id) || [tripB.id]) {
    queue.enqueue(convB.id, botId);
  }
  await drain();
  const botReplies2 = chainAfter(convB.id, answer2.id).filter(m => m.sender_type === 'bot');
  log(`  resume: ${botReplies2.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(botReplies2.length === 1 && !!botReplies2[0].content.includes('Lisbon'), 'flow resumes after restart with the answer');
  assert(botReplies2[0] && countOccurrences(botReplies2[0].content, 'Lisbon') === 1, 'Lisbon appears exactly once after restart');
  if (failures === caseFailures) log('PASS: Case 2: restart persistence');

  // Case 3: two bots in one group, only the asked bot resumes.
  log('\nCase 3: two bots in one group, only the asked bot resumes');
  caseFailures = failures;
  const g1 = bots.create({ name: 'GroupA', title: 'Planner', description: 'Plans trips.' });
  const g2 = bots.create({ name: 'GroupB', title: 'Watcher', description: 'Watches quietly.' });
  const group = groups.create('TripGroup', [g1.id, g2.id]);
  const convG = conversations.getByGroupId(group.id);
  agent.setDelegationChatStub(ctx => {
    const sent = ctx.sent.map(part => part.content).join('\n---\n');
    if (sent.includes('[ask-resume]')) return 'Group trip booked: Lisbon.';
    if (ctx.botName === 'GroupA') return '[ASK] which city?';
    return 'GroupB here: noted.';
  });
  const task3 = messages.create(convG.id, 'user', 'Plan our trip.');
  await sleep(5);
  queue.enqueue(convG.id, g1.id);
  await sleep(5);
  queue.enqueue(convG.id, g2.id);
  await drain();
  const groupAsked = ask.listAskedForConversation(convG.id);
  assert(groupAsked.length === 1 && groupAsked[0].bot_id === g1.id, 'only the asking bot holds a pending row');
  const g2Asks = chainAfter(convG.id, task3.id).filter(m => m.sender_type === 'bot' && m.sender_id === g2.id);
  assert(g2Asks.length === 1, 'the other bot replies normally once on the open ask turn');
  const resumeIds = ask.resumeBotIdsForConversation(convG.id);
  assert(Array.isArray(resumeIds) && resumeIds.length === 1 && resumeIds[0] === g1.id, 'routing helper names only the asked bot');
  const answer3 = messages.create(convG.id, 'user', 'Lisbon');
  await sleep(5);
  for (const botId of resumeIds) queue.enqueue(convG.id, botId);
  await drain();
  const afterGroupAnswer = chainAfter(convG.id, answer3.id);
  const groupReplies = afterGroupAnswer.filter(m => m.sender_type === 'bot');
  log(`  resume: ${groupReplies.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(groupReplies.length === 1, 'exactly one bot reply in the group after the answer');
  assert(groupReplies[0] && groupReplies[0].sender_id === g1.id, 'only the asked bot resumes');
  assert(afterGroupAnswer.filter(m => m.sender_type === 'bot' && m.sender_id === g2.id).length === 0, 'the other bot posts nothing after the answer');
  assert(groupReplies[0] && countOccurrences(groupReplies[0].content, 'Lisbon') === 1, 'answer used exactly once');
  if (failures === caseFailures) log('PASS: Case 3: two bots in one group, only the asked bot resumes');

  // Case 4: Stop clears pending.
  log('\nCase 4: Stop clears pending');
  caseFailures = failures;
  const tripC = bots.create({ name: 'TripC', title: 'Planner', description: 'Plans trips.' });
  const convC = conversations.getByBotId(tripC.id);
  let sawResume4 = false;
  agent.setDelegationChatStub(ctx => {
    const sent = ctx.sent.map(part => part.content).join('\n---\n');
    if (sent.includes('[ask-resume]')) {
      sawResume4 = true;
      return 'RESUMED: should never happen after Stop.';
    }
    if (sent.includes('Lisbon')) return 'NORMAL: fresh turn.';
    return '[ASK] which city?';
  });
  const task4 = messages.create(convC.id, 'user', 'Plan my trip.');
  await sleep(5);
  queue.enqueue(convC.id, tripC.id);
  await drain();
  assert(ask.listAskedForConversation(convC.id).length === 1, 'question parked before Stop');
  const stopped = agent.stopDelegation(convC.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  assert(ask.listAskedForConversation(convC.id).length === 0, 'no asked row remains after Stop');
  const cleared = ask.listForConversation(convC.id);
  assert(cleared.length === 1 && cleared[0].status === 'expired', 'pending row expired by Stop');
  const answer4 = messages.create(convC.id, 'user', 'Lisbon');
  await sleep(5);
  queue.enqueue(convC.id, tripC.id);
  await drain();
  const botReplies4 = chainAfter(convC.id, answer4.id).filter(m => m.sender_type === 'bot');
  log(`  after-stop: ${botReplies4.map(m => JSON.stringify(m.content)).join(' | ') || '(missing)'}`);
  assert(sawResume4 === false, 'resumed context never built after Stop');
  assert(botReplies4.length === 1 && botReplies4[0].content.startsWith('NORMAL:'), 'answer becomes a normal turn after Stop');
  if (failures === caseFailures) log('PASS: Case 4: Stop clears pending');

  // Case 5: expired question ignored.
  log('\nCase 5: expired question ignored');
  caseFailures = failures;
  const tripD = bots.create({ name: 'TripD', title: 'Planner', description: 'Plans trips.' });
  const convD = conversations.getByBotId(tripD.id);
  let sawResume5 = false;
  agent.setDelegationChatStub(ctx => {
    const sent = ctx.sent.map(part => part.content).join('\n---\n');
    if (sent.includes('[ask-resume]')) {
      sawResume5 = true;
      return 'RESUMED: should never happen when expired.';
    }
    if (sent.includes('Lisbon')) return 'NORMAL: fresh turn.';
    return '[ASK] which city?';
  });
  const task5 = messages.create(convD.id, 'user', 'Plan my trip.');
  await sleep(5);
  queue.enqueue(convD.id, tripD.id);
  await drain();
  const pending5 = ask.listAskedForConversation(convD.id);
  assert(pending5.length === 1, 'question parked before expire');
  assert(ask.expireQuestion(pending5[0].id) === true, 'expire flips asked to expired');
  assert(ask.expireQuestion(pending5[0].id) === false, 'second expire is a no-op');
  const answer5 = messages.create(convD.id, 'user', 'Lisbon');
  await sleep(5);
  queue.enqueue(convD.id, tripD.id);
  await drain();
  const botReplies5 = chainAfter(convD.id, answer5.id).filter(m => m.sender_type === 'bot');
  assert(sawResume5 === false, 'resumed context never built for an expired question');
  assert(botReplies5.length === 1 && botReplies5[0].content.startsWith('NORMAL:'), 'answer becomes a normal turn when expired');
  if (failures === caseFailures) log('PASS: Case 5: expired question ignored');

  // Case 6: snapshot sentence and two paraphrases accepted (ask-first path).
  log('\nCase 6: snapshot sentence and two paraphrases accepted');
  caseFailures = failures;
  const SNAPSHOT = 'ask me one question: which city? then wait';
  const PARA1 = 'Could you ask me this first \u2014 which city? \u2014 then wait for my answer';
  const PARA2 = 'Ask me first: which city? and wait';
  assert((ask.parseAskRequest(SNAPSHOT) || '').includes('which city'), 'snapshot sentence parsed');
  assert((ask.parseAskRequest(PARA1) || '').includes('which city'), 'paraphrase 1 parsed');
  assert((ask.parseAskRequest(PARA2) || '').includes('which city'), 'paraphrase 2 parsed');
  assert(ask.parseAskRequest('Hello, how are you?') === null, 'normal message is not an ask request');
  assert(ask.parseAskRequest('Please wait a moment') === null, 'wait without ask is not a request');
  assert(ask.parseAskRequest('Can you ask me about Lisbon?') === null, 'ask without wait is not a request');
  assert(ask.parseAskMarker('[ASK] which city?') === 'which city?', 'bracket marker parsed');
  assert(ask.parseAskMarker('<ask>which city?</ask>') === 'which city?', 'tag marker parsed');
  assert(ask.parseAskMarker('I will ask you later') === null, 'plain prose is not a marker');

  const tripE = bots.create({ name: 'TripE', title: 'Planner', description: 'Plans trips.' });
  const convE = conversations.getByBotId(tripE.id);
  let modelCalls6 = 0;
  agent.setDelegationChatStub(ctx => {
    modelCalls6++;
    const sent = ctx.sent.map(part => part.content).join('\n---\n');
    if (sent.includes('[ask-resume]')) return 'Trip booked: Lisbon.';
    return 'UNEXPECTED-MODEL-CALL';
  });
  for (const [label, phrase] of [['snapshot', SNAPSHOT], ['paraphrase 1', PARA1], ['paraphrase 2', PARA2]]) {
    const callsBefore = modelCalls6;
    const task = messages.create(convE.id, 'user', `Plan my trip. ${phrase}`);
    await sleep(5);
    queue.enqueue(convE.id, tripE.id);
    await drain();
    const asked = chainAfter(convE.id, task.id).filter(m => m.sender_type === 'bot');
    assert(asked.length === 1 && asked[0].content.includes('which city'), `${label}: question posted without the model`);
    assert(modelCalls6 === callsBefore, `${label}: no model call for the ask`);
    const answer = messages.create(convE.id, 'user', 'Lisbon');
    await sleep(5);
    for (const botId of ask.resumeBotIdsForConversation(convE.id) || [tripE.id]) {
      queue.enqueue(convE.id, botId);
    }
    await drain();
    const resumed = chainAfter(convE.id, answer.id).filter(m => m.sender_type === 'bot');
    assert(resumed.length === 1 && resumed[0].content.includes('Lisbon'), `${label}: answer resumes once with Lisbon`);
    assert(modelCalls6 === callsBefore + 1, `${label}: exactly one model call for the resume`);
  }
  if (failures === caseFailures) log('PASS: Case 6: snapshot sentence and two paraphrases accepted');

  // Case 7: normal message with nothing pending is a normal turn.
  log('\nCase 7: normal message with nothing pending is a normal turn');
  caseFailures = failures;
  const tripF = bots.create({ name: 'TripF', title: 'Planner', description: 'Plans trips.' });
  const convF = conversations.getByBotId(tripF.id);
  agent.setDelegationChatStub(() => 'NORMAL-REPLY-7');
  const task7 = messages.create(convF.id, 'user', 'Hello, how are you?');
  await sleep(5);
  queue.enqueue(convF.id, tripF.id);
  await drain();
  const replies7 = chainAfter(convF.id, task7.id).filter(m => m.sender_type === 'bot');
  assert(replies7.length === 1 && replies7[0].content === 'NORMAL-REPLY-7', 'plain message gets a plain model reply');
  assert(ask.listForConversation(convF.id).length === 0, 'no pending row created');
  assert(ask.resumeBotIdsForConversation(convF.id) === null, 'routing helper is null with nothing pending');
  if (failures === caseFailures) log('PASS: Case 7: normal message with nothing pending is a normal turn');

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
    console.error('ask-and-wait test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
