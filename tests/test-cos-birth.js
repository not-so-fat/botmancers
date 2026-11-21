#!/usr/bin/env node
// NOT-414: chief-of-staff creates or duplicates a specialist from chat.
// Self-contained: isolated SQLite file, stub model + stub market, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-cos-birth-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
delete process.env.CLONE_MARKET_SEARCH_URL;
process.env.CLONE_MARKET_URL = 'https://market.example';

// No network: any fetch is a test failure.
const realFetch = global.fetch;
global.fetch = () => { throw new Error('network disabled in test:cos-birth'); };

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const agent = jiti('../lib/agent.ts');
const birth = jiti('../lib/birth.ts');
const skills = jiti('../lib/skills.ts');

const { bots, conversations, messages, oneShots, routines } = db;
const { uiTurns } = jiti('../lib/ui-turns.ts');

let failures = 0;
const skillNames = [];

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drain(cap = 40) {
  let processed = 0;
  while (processed < cap && await agent.processNextUiTurn()) {
    processed++;
    await sleep(3);
  }
  return processed;
}

function lastCosReply(convId, cosId) {
  const all = messages.getByConversation(convId);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].sender_type === 'bot' && all[i].sender_id === cosId) return all[i];
  }
  return null;
}

function trackSkill(name) {
  if (!skillNames.includes(name)) skillNames.push(name);
}

function cleanupSkills() {
  for (const name of skillNames) {
    const dir = path.join(ROOT, 'skills', name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main() {
  log('NOT-414 cos-birth test (stub model, stub market, isolated DB, no network)');
  log(`DB: ${DB_PATH}`);
  agent.resetDelegationForTests();
  birth.resetBirthForTests();

  // Stub market: a pricing job fits, everything else misses.
  const TEMPLATE = {
    template_id: 'tmpl-pricing-1',
    template_url: 'https://market.example/t/pricing-1',
    source_provider: 'clone-market',
    title: 'Pricing Scout',
    description: 'Tracks competitor pricing daily',
    avatar: 'data:image/png;base64,stubavatar',
  };
  birth.setMarketLookupStub(async job =>
    /pricing|competitor/i.test(job) ? { ...TEMPLATE } : null
  );

  // Normal-model stub for non-birth turns.
  let delegationCalls = 0;
  agent.setDelegationChatStub(() => {
    delegationCalls++;
    return 'noted.';
  });

  const cos = bots.create({ deck_id: 'deck-test', name: 'chief-of-staff', title: 'Chief of staff', description: 'Runs the team.' });
  const conv = conversations.getByBotId(cos.id);
  assert(!!conv, 'chief-of-staff thread exists');

  // Deterministic parser: snapshot sentences among paraphrases and negatives.
  log('\nParser: snapshot sentences, paraphrases, negatives');
  const snapshotCreate = birth.parseBirthDeterministic('Create a specialist named Scout. The job is: tracks competitor pricing');
  assert(snapshotCreate.kind === 'create' && snapshotCreate.name === 'Scout', 'snapshot create sentence parses');
  const snapshotDup = birth.parseBirthDeterministic('Duplicate Scout as Scout2');
  assert(snapshotDup.kind === 'duplicate' && snapshotDup.sourceName === 'Scout', 'snapshot duplicate sentence parses');
  const exitCreate = birth.parseBirthDeterministic('make me a specialist called Scout that tracks competitor pricing');
  assert(exitCreate.kind === 'create' && exitCreate.name === 'Scout', 'exit-predicate wording parses');
  assert(exitCreate.kind === 'create' && exitCreate.job === 'tracks competitor pricing', 'exit job extracted');
  const neg1 = birth.parseBirthDeterministic('What does a specialist do?');
  const neg2 = birth.parseBirthDeterministic('Duplicate bridge is a fun card game.');
  const neg3 = birth.parseBirthDeterministic('Tell me about Scout.');
  assert(neg1.kind === 'none' && neg2.kind === 'none' && neg3.kind === 'none', 'negatives parse as none');

  // Case 1: create with template.
  log('\nCase 1: create with template');
  messages.create(conv.id, 'user', 'make me a specialist called Scout that tracks competitor pricing');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const scout = bots.getAll().find(b => b.name === 'Scout');
  assert(!!scout, 'Scout created');
  assert(scout && scout.template_id === 'tmpl-pricing-1', 'template provenance filled');
  assert(scout && scout.source_provider === 'clone-market', 'source provider filled');
  assert(scout && scout.avatar === 'data:image/png;base64,stubavatar', 'template avatar kept');
  const reply1 = lastCosReply(conv.id, cos.id);
  assert(!!reply1 && reply1.content.includes('Path: template'), 'reply names the template path');
  assert(!!reply1 && scout && reply1.content.includes(scout.id), 'reply includes the new bot id');
  if (scout) {
    const scoutConv = conversations.getByBotId(scout.id);
    assert(!!scoutConv && uiTurns.listByConversation(scoutConv.id).filter(q => q.state === 'queued').length === 0, 'no greeting queued for the new bot');
    assert(!!scoutConv && messages.getByConversation(scoutConv.id).length === 0, 'no greeting storm in the new thread');
  }
  log('PASS: create with template');

  // Case 2: create plain (snapshot sentence, no market fit).
  log('\nCase 2: create plain');
  messages.create(conv.id, 'user', 'Create a specialist named Plainbot. The job is: water my plants');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const plain = bots.getAll().find(b => b.name === 'Plainbot');
  assert(!!plain, 'Plainbot created');
  assert(plain && plain.description === 'water my plants', 'job stored as description');
  assert(plain && !plain.template_id && !plain.source_provider, 'plain bot has no provenance');
  assert(plain && !plain.avatar, 'plain bot has no avatar');
  const reply2 = lastCosReply(conv.id, cos.id);
  assert(!!reply2 && reply2.content.includes('Path: plain'), 'reply names the plain path');
  assert(!!reply2 && plain && reply2.content.includes(plain.id), 'reply includes the new bot id');
  log('PASS: create plain');

  // Case 3: duplicate (copies title/desc/skill, new name only, avatar blank).
  log('\nCase 3: duplicate');
  trackSkill('Scout');
  trackSkill('Scout2');
  skills.writeSkillForBot('Scout', '# Scout skill\nWatch prices.');
  bots.setAvatar(scout.id, 'data:image/png;base64,sourceavatar');
  messages.create(conv.id, 'user', 'duplicate Scout as Scout2');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const scout2 = bots.getAll().find(b => b.name === 'Scout2');
  assert(!!scout2, 'Scout2 created');
  assert(!!scout2 && scout2.title === scout.title && scout2.description === scout.description, 'title and description copied');
  assert(!!scout2 && !scout2.avatar, 'avatar not copied (starts blank)');
  assert(skills.localSkillForBot('Scout2') === '# Scout skill\nWatch prices.', 'skill text copied');
  assert(!!scout2 && !scout2.template_id, 'duplicate carries no template provenance');
  const reply3 = lastCosReply(conv.id, cos.id);
  assert(!!reply3 && reply3.content.includes('Path: duplicate'), 'reply names the duplicate path');
  assert(!!reply3 && scout2 && reply3.content.includes(scout2.id), 'reply includes the new bot id');
  log('PASS: duplicate');

  // Case 4: unknown duplicate source creates nothing.
  log('\nCase 4: unknown duplicate source');
  const countBeforeUnknown = bots.getAll().length;
  messages.create(conv.id, 'user', 'Duplicate Nobody as Ghost');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  assert(bots.getAll().length === countBeforeUnknown, 'no bot created for unknown source');
  assert(!bots.getAll().some(b => b.name === 'Ghost'), 'Ghost absent from roster');
  const reply4 = lastCosReply(conv.id, cos.id);
  assert(!!reply4 && reply4.content.includes('could not find Nobody'), 'reply names the missing source');
  log('PASS: unknown duplicate source');

  // Case 5: name collision (case-insensitive) creates nothing.
  log('\nCase 5: name collision');
  const countBeforeCollision = bots.getAll().length;
  messages.create(conv.id, 'user', 'make me a specialist called scout that does more');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  assert(bots.getAll().length === countBeforeCollision, 'no bot created on collision');
  const reply5 = lastCosReply(conv.id, cos.id);
  assert(!!reply5 && reply5.content.includes('already exists'), 'reply reports the collision');
  log('PASS: name collision');

  // Case 6: paraphrase accepted (deterministic + model-assisted).
  log('\nCase 6: paraphrase accepted');
  messages.create(conv.id, 'user', 'Could you please build a new bot named Parabot to summarize meeting notes?');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const para = bots.getAll().find(b => b.name === 'Parabot');
  assert(!!para, 'deterministic paraphrase creates Parabot');
  assert(para && para.description === 'summarize meeting notes', 'paraphrase job extracted');
  // Model-assisted: deterministic sees none, the stub model extracts create.
  const modelWording = 'I need someone to watch the servers, call them Watcher';
  assert(birth.parseBirthDeterministic(modelWording).kind === 'none', 'model wording misses the deterministic parser');
  birth.setBirthModelStub(async () => ({ intent: 'create', name: 'Watcher', job: 'watch the servers' }));
  const modelIntent = await birth.extractBirthIntent(modelWording);
  assert(modelIntent.kind === 'create' && modelIntent.name === 'Watcher', 'stub model extracts the create intent');
  messages.create(conv.id, 'user', modelWording);
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const watcher = bots.getAll().find(b => b.name === 'Watcher');
  assert(!!watcher, 'model-assisted paraphrase creates Watcher');
  birth.setBirthModelStub(null);
  log('PASS: paraphrase accepted');

  // Case 7: non-request ignored (no bot, normal loop continues).
  log('\nCase 7: non-request ignored');
  const countBeforeNoise = bots.getAll().length;
  const callsBeforeNoise = delegationCalls;
  messages.create(conv.id, 'user', 'What does a specialist do?');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  assert(bots.getAll().length === countBeforeNoise, 'non-request creates nothing');
  assert(delegationCalls === callsBeforeNoise + 1, 'normal loop continues past a non-request');
  const reply7 = lastCosReply(conv.id, cos.id);
  assert(!!reply7 && !reply7.content.includes('Path:'), 'no birth reply for a non-request');
  log('PASS: non-request ignored');

  // Case 8: import idempotent on retry (same operation id + body).
  log('\nCase 8: import idempotent on retry');
  const idemTemplate = {
    template_id: 'tmpl-idem-1',
    template_url: 'https://market.example/t/idem-1',
    source_provider: 'clone-market',
    title: 'Idem Bot',
    description: 'Idempotency probe',
  };
  const first = await birth.importSpecialistFromTemplate('IdemBot', idemTemplate, { operationId: 'op-idem-123' });
  assert(first.ok && first.created === true, 'first import creates');
  const second = await birth.importSpecialistFromTemplate('IdemBot', idemTemplate, { operationId: 'op-idem-123' });
  assert(second.ok && second.created === false, 'retry with the same operation id does not create');
  assert(first.ok && second.ok && first.bot.id === second.bot.id, 'retry returns the same bot id');
  trackSkill('IdemBot');
  log('PASS: import idempotent on retry');

  // Case 9: a due timer tick posts after a birth reply (NOT-411 regression).
  // The latest user message is an already-answered birth request; the tick
  // launch must consume the tick instead of being swallowed by the birth
  // hook's already-replied guard.
  log('\nCase 9: due tick posts after a birth reply');
  messages.create(conv.id, 'user', 'make me a specialist called Tickbot that files weekly reports');
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const tickbot = bots.getAll().find(b => b.name === 'Tickbot');
  assert(!!tickbot, 'Tickbot created for the tick regression');
  const callsBeforeTick = delegationCalls;
  oneShots.create(conv.id, cos.id, Date.now() - 1000);
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const tickPosts = messages.getByConversation(conv.id).filter(m => m.sender_type === 'bot' && m.content === agent.ONE_SHOT_MESSAGE);
  assert(tickPosts.length === 1, `due one-shot posts after a birth reply (got ${tickPosts.length})`);
  assert(delegationCalls === callsBeforeTick, 'tick after birth never calls the model');
  assert(oneShots.pending(conv.id) === undefined, 'one-shot row claimed after firing');
  routines.create(conv.id, cos.id, 'tickword', Date.now() - 1000, 60000);
  uiTurns.enqueue(conv.id, cos.id);
  await drain();
  const routinePosts = messages.getByConversation(conv.id).filter(m => m.sender_type === 'bot' && m.content === '[routine]\ntickword');
  assert(routinePosts.length === 1, `due routine posts after a birth reply (got ${routinePosts.length})`);
  assert(delegationCalls === callsBeforeTick, 'routine tick after birth never calls the model');
  log('PASS: due tick after birth');

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    cleanupSkills();
    global.fetch = realFetch;
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('cos-birth test crashed:', error);
    try { cleanupSkills(); } catch { /* best effort */ }
    global.fetch = realFetch;
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
