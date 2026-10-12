#!/usr/bin/env node
// NOT-413: Hermes gateway wake path (one gateway, specialists wait inside it).
//
// Self-contained: isolated SQLite file, stub gateway HTTP server on an
// ephemeral port, deterministic caller stub at the model-call boundary.
// No dev server, no API key, no network beyond loopback.
//
// Covers: session header sent, two pokes overlap in time, failed poke marks
// the queue row failed and logs wait_failed, Stop aborts, no key falls back
// to main's path, reply appears once per thread, a paraphrased wake message
// also works.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-hermes-wake-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
delete process.env.OPENAI_API_KEY;

const WAIT_LOG = path.join(os.tmpdir(), `botmancers-hermes-waits-${process.pid}.jsonl`);
try { fs.rmSync(WAIT_LOG, { force: true }); } catch { /* fresh start */ }
process.env.HERMES_WAIT_LOG_PATH = WAIT_LOG;
process.env.HERMES_API_SERVER_KEY = 'test-key';
delete process.env.HERMES_PROFILE_PATH;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const hermes = jiti('./lib/hermes.ts');

const { bots, conversations, messages, queue, launchSnapshots } = db;

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

function readWaitLog() {
  if (!fs.existsSync(WAIT_LOG)) return [];
  return fs.readFileSync(WAIT_LOG, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function countIn(thread, senderId, snippet) {
  return thread.filter(m => m.sender_type === 'bot' && m.sender_id === senderId && m.content.includes(snippet)).length;
}

// Stub gateway: records every request, overlaps in time under concurrency,
// fails tasks containing FAIL, and answers per specialist by session id.
function startStubGateway(botNameById) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = { delayMs: 120, requests };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const startedAt = Date.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const record = {
        path: req.url,
        sessionId: req.headers['x-hermes-session-id'] || null,
        auth: req.headers.authorization || null,
        body,
        startedAt,
        finishedAt: null,
      };
      requests.push(record);
      const task = (body && body.messages || []).map(m => m.content).join('\n');
      const fail = task.includes('FAIL');
      setTimeout(() => {
        inFlight--;
        record.finishedAt = Date.now();
        try {
          if (fail) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'stub failure' } }));
            return;
          }
          const sessionId = String(record.sessionId || '');
          const botId = Object.keys(botNameById).find(id => sessionId.endsWith(id));
          const name = (botId && botNameById[botId]) || 'specialist';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: `GATEWAY-REPLY from ${name}: done.` } }],
          }));
        } catch {
          // Client aborted (Stop test); nothing to send back to.
        }
      }, state.delayMs);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server, state,
        baseUrl: `http://127.0.0.1:${port}`,
        maxInFlight: () => maxInFlight,
        resetOverlap: () => { maxInFlight = inFlight; },
      });
    });
  });
}

async function main() {
  log('NOT-413 Hermes gateway wake test (stub gateway, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log(`Wait log: ${WAIT_LOG}`);
  agent.resetDelegationForTests();

  const origin = bots.create({ name: 'Origin', title: 'Caller', description: 'Originates delegations.' });
  const botA = bots.create({ name: 'A', title: 'Drafter', description: 'Drafts.' });
  const botB = bots.create({ name: 'B', title: 'Checker', description: 'Checks drafts.' });
  const conv = conversations.getByBotId(origin.id);
  const convA = conversations.getByBotId(botA.id);
  const convB = conversations.getByBotId(botB.id);
  assert(!!conv && !!convA && !!convB, 'origin and specialist threads exist');

  const gateway = await startStubGateway({ [botA.id]: 'A', [botB.id]: 'B' });
  process.env.HERMES_BASE_URL = gateway.baseUrl;
  log(`Stub gateway: ${gateway.baseUrl}`);

  // Scenario 0: configuration without hardcoded values.
  log('\nScenario 0: gateway configuration');
  assert(hermes.loadHermesConfig() !== null, 'gateway configured with a key');
  assert(hermes.loadHermesConfig({}) === null, 'no key means gateway off');
  assert(
    hermes.HERMES_DEFAULT_BASE_URL.startsWith('http://127.0.0.1:'),
    'default base URL is the documented constant'
  );
  const sessionA = hermes.hermesSessionIdForBot(botA.id, hermes.loadHermesConfig());
  assert(sessionA.endsWith(botA.id) && sessionA.length > botA.id.length, 'session id carries the bot id with a prefix');
  const profileA = hermes.hermesProfilePathForBot(botA);
  assert(!profileA.includes(botA.id), `profile path derived from role, never a UUID (${profileA})`);
  assert(profileA.includes('drafter'), `profile path reflects the role (${profileA})`);

  // Scenario 1: one message WAKEs two specialists concurrently.
  log('\nScenario 1: two concurrent pokes, distinct sessions, once per thread');
  gateway.state.requests.length = 0;
  gateway.resetOverlap();
  const waitLinesBefore = readWaitLog().length;
  let originCalls = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      originCalls++;
      if (originCalls === 1) return 'WAKE A: Please draft the launch note.\nWAKE B: Please check the draft.';
      return 'REPORT: A drafted, B checked. Done.';
    }
    return `${ctx.botName} should never run through the stub on the gateway path.`;
  });
  const user1 = messages.create(conv.id, 'user', 'Get A to draft the launch note and B to check it.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  const seen = gateway.state.requests;
  assert(seen.length === 2, `two gateway requests sent (got ${seen.length})`);
  const sessions = seen.map(r => r.sessionId);
  assert(
    sessions.includes(sessionA) && sessions.some(s => s && s.endsWith(botB.id)),
    'each poke carries its specialist session id'
  );
  assert(new Set(sessions).size === 2, 'session ids are distinct per specialist');
  assert(seen.every(r => r.auth === 'Bearer test-key'), 'Bearer key sent on both pokes');
  assert(seen.every(r => !String(r.path).includes(botA.id) && !String(r.path).includes(botB.id)), 'profile paths carry no UUID');
  assert(gateway.maxInFlight() >= 2, `two pokes overlap in time (max in-flight ${gateway.maxInFlight()})`);

  const thread1 = chainAfter(conv.id, user1.id);
  assert(countIn(thread1, botA.id, 'GATEWAY-REPLY from A') === 1, "A's reply appears once in the caller thread");
  assert(countIn(thread1, botB.id, 'GATEWAY-REPLY from B') === 1, "B's reply appears once in the caller thread");
  assert(countIn(thread1, origin.id, 'REPORT:') === 1, 'caller-managed report posted once');
  assert(countIn(thread1, origin.id, 'Handing off to A') === 1, 'one handoff line per target (A)');
  assert(countIn(thread1, origin.id, 'Handing off to B') === 1, 'one handoff line per target (B)');

  const threadA = messages.getByConversation(convA.id);
  assert(countIn(threadA, origin.id, '[From Origin]') === 1, "A's thread has one [From Origin] handoff");
  assert(countIn(threadA, botA.id, 'GATEWAY-REPLY from A') === 1, "A's thread has the reply once");
  const threadB = messages.getByConversation(convB.id);
  assert(countIn(threadB, origin.id, '[From Origin]') === 1, "B's thread has one [From Origin] handoff");
  assert(countIn(threadB, botB.id, 'GATEWAY-REPLY from B') === 1, "B's thread has the reply once");

  const waits1 = readWaitLog().slice(waitLinesBefore);
  assert(waits1.every(line => line && typeof line.event === 'string'), 'wait log holds one JSON object per line');
  assert(waits1.filter(l => l.event === 'wait_start').length === 2, 'wait log has two wait_start lines');
  assert(waits1.filter(l => l.event === 'wait_finish').length === 2, 'wait log has two wait_finish lines');

  const snapA = launchSnapshots.listByBot(botA.id);
  const snapB = launchSnapshots.listByBot(botB.id);
  assert(snapA.some(s => s.transport === 'hermes-gateway'), "A's launch snapshot records hermes-gateway");
  assert(snapB.some(s => s.transport === 'hermes-gateway'), "B's launch snapshot records hermes-gateway");
  assert(
    launchSnapshots.listByBot(origin.id).some(s => s.transport === 'openai'),
    "caller's own turn still records the main transport"
  );
  const delegation = agent.getDelegationState(conv.id);
  assert(!!delegation && delegation.handoffs === 2, `each poke counts a handoff (got ${delegation && delegation.handoffs})`);
  assert(!!delegation && delegation.turns === 4, `each poke counts a turn: caller + 2 pokes + report (got ${delegation && delegation.turns})`);
  assert(queue.countPending(conv.id) === 0, 'queue drained after the report');

  // Scenario 2: failed poke marks the queue row failed and logs wait_failed.
  log('\nScenario 2: failed poke');
  gateway.state.requests.length = 0;
  const waitsBefore2 = readWaitLog().length;
  let originCalls2 = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      originCalls2++;
      if (originCalls2 === 1) return 'WAKE A: FAIL this task please.';
      return 'REPORT: A failed, noted.';
    }
    return 'unused';
  });
  const user2 = messages.create(conv.id, 'user', 'Ask A to do the thing that fails.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  assert(gateway.state.requests.length === 1, 'one gateway request attempted');
  const rows2 = queue.listByConversation(conv.id).filter(r => r.bot_id === botA.id);
  assert(rows2.some(r => r.status === 'failed'), 'failed poke marks its queue row failed');
  const waits2 = readWaitLog().slice(waitsBefore2);
  const failed = waits2.filter(l => l.event === 'wait_failed');
  assert(failed.length === 1, 'wait log has one wait_failed line');
  assert(
    failed.length === 1 && rows2.some(r => r.id === failed[0].wait_id && r.status === 'failed'),
    'wait_failed names the failed queue row'
  );
  const thread2 = chainAfter(conv.id, user2.id);
  assert(countIn(thread2, origin.id, '[Specialist A failed:') === 1, 'one failure notice in the caller thread');
  assert(countIn(thread2, botA.id, 'GATEWAY-REPLY') === 0, 'no reply posted for the failed poke');
  assert(countIn(thread2, origin.id, 'REPORT:') === 1, 'caller still reports after a failure');

  // Scenario 3: Stop aborts in-flight pokes.
  log('\nScenario 3: Stop aborts in-flight pokes');
  gateway.state.delayMs = 1500;
  gateway.state.requests.length = 0;
  const waitsBefore3 = readWaitLog().length;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') return 'WAKE A: Take your time on this.\nWAKE B: Take your time too.';
    return 'unused';
  });
  const user3 = messages.create(conv.id, 'user', 'Ask A and B for slow work, then stop.');
  queue.enqueue(conv.id, origin.id);
  const inFlight = agent.processNextQueueItem();
  await sleep(200);
  assert(gateway.state.requests.length === 2, 'both pokes in flight before Stop');
  const stopped = agent.stopDelegation(conv.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  await inFlight;
  gateway.state.delayMs = 120;

  const waits3 = readWaitLog().slice(waitsBefore3);
  const aborted = waits3.filter(l => l.event === 'wait_failed' && l.code === 'aborted');
  assert(aborted.length === 2, `both pokes log wait_failed with code aborted (got ${aborted.length})`);
  const rows3 = queue.listByConversation(conv.id).filter(r => r.created_at > user3.created_at);
  assert(rows3.filter(r => r.status === 'failed').length >= 2, 'aborted pokes mark their queue rows failed');
  const afterStop = messages.getByConversation(conv.id);
  const countAfterStop = afterStop.length;
  await drain();
  const final3 = messages.getByConversation(conv.id);
  assert(final3.length === countAfterStop, 'zero new messages after Stop settles');
  const thread3 = chainAfter(conv.id, user3.id);
  assert(countIn(thread3, botA.id, 'GATEWAY-REPLY') === 0, 'no late A reply after Stop');
  assert(countIn(thread3, botB.id, 'GATEWAY-REPLY') === 0, 'no late B reply after Stop');
  assert(queue.countPending(conv.id) === 0, 'caller return suppressed after Stop');

  // Scenario 4: no key falls back to main's existing path.
  log('\nScenario 4: no key falls back');
  delete process.env.HERMES_API_SERVER_KEY;
  gateway.state.requests.length = 0;
  const stubTurns = {};
  agent.setDelegationChatStub(ctx => {
    stubTurns[ctx.botName] = (stubTurns[ctx.botName] || 0) + 1;
    if (ctx.botName === 'Origin' && stubTurns.Origin === 1) return 'WAKE A: Please draft the launch note.';
    if (ctx.botName === 'Origin' && stubTurns.Origin === 2) return 'WAKE B: Please check this draft: Launch Friday at 9am.';
    if (ctx.botName === 'Origin') return 'REPORT: A draft: Launch Friday at 9am. B check: add the venue. Done.';
    if (ctx.botName === 'A') return 'DRAFT from A: Launch Friday at 9am.';
    if (ctx.botName === 'B') return 'CHECK from B: Looks good; add the venue.';
    return 'No response';
  });
  const user4 = messages.create(conv.id, 'user', 'Get A to draft the launch note and B to check it.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  assert(gateway.state.requests.length === 0, 'no gateway request without a key');
  assert(stubTurns.A === 1 && stubTurns.B === 1, `specialists served by main's path (A=${stubTurns.A || 0}, B=${stubTurns.B || 0})`);
  const thread4 = chainAfter(conv.id, user4.id);
  assert(countIn(thread4, botA.id, 'DRAFT from A') === 1, 'fallback draft posted once');
  assert(countIn(thread4, botB.id, 'CHECK from B') === 1, 'fallback check posted once');
  assert(countIn(thread4, origin.id, 'REPORT:') === 1, 'fallback report posted once');

  // Scenario 5: a paraphrased wake message also works. The wake path is
  // driven by delegation directives, never by exact user wording.
  log('\nScenario 5: paraphrased wake message');
  process.env.HERMES_API_SERVER_KEY = 'test-key';
  gateway.state.requests.length = 0;
  let originCalls5 = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      originCalls5++;
      if (originCalls5 === 1) return 'wake a: kindly draft the launch note please\nwake B: kindly check the draft please';
      return 'REPORT: done via paraphrase.';
    }
    return 'unused';
  });
  const user5 = messages.create(
    conv.id,
    'user',
    'Could you kindly have A put together the launch note, and ask B to look it over?'
  );
  queue.enqueue(conv.id, origin.id);
  await drain();

  assert(gateway.state.requests.length === 2, 'paraphrased message still wakes two specialists');
  const thread5 = chainAfter(conv.id, user5.id);
  assert(countIn(thread5, botA.id, 'GATEWAY-REPLY from A') === 1, "paraphrased wake: A's reply once");
  assert(countIn(thread5, botB.id, 'GATEWAY-REPLY from B') === 1, "paraphrased wake: B's reply once");
  assert(countIn(thread5, origin.id, 'REPORT:') === 1, 'paraphrased wake: report posted');

  // Scenario 6: dedup is scoped to the delegation round. The same task text
  // in a new round posts fresh, while a retried mirror of the same round
  // stays silent in both threads.
  log('\nScenario 6: round-scoped mirroring, retried mirror silent');
  let originCalls6 = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      originCalls6++;
      if (originCalls6 === 1) return 'WAKE A: Please draft the launch note.';
      return 'REPORT: same task again.';
    }
    return 'unused';
  });
  const user6 = messages.create(conv.id, 'user', 'Same task as the first round, please.');
  queue.enqueue(conv.id, origin.id);
  await drain();

  const thread6 = chainAfter(conv.id, user6.id);
  assert(countIn(thread6, botA.id, 'GATEWAY-REPLY from A') === 1, 'same-task new round posts its reply');
  const threadA6 = messages.getByConversation(convA.id);
  assert(countIn(threadA6, botA.id, 'GATEWAY-REPLY from A') === 3, "A's thread holds one reply per round (3 rounds)");
  const replyMsg6 = thread6.find(m => m.sender_id === botA.id);
  assert(!!replyMsg6, 'same-task reply found for the retry check');
  const retry = agent.mirrorSpecialistReply({
    callerConversationId: conv.id,
    caller: origin,
    target: botA,
    taskMessage: 'Please draft the launch note.',
    reply: replyMsg6 ? replyMsg6.content : '',
  });
  assert(retry.callerMessageId === null && retry.targetMessageId === null, 'retried mirror of the same round posts nothing');

  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(WAIT_LOG, { force: true }); } catch { /* best effort */ }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('hermes-wake test crashed:', error);
    try { fs.rmSync(DB_PATH, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(WAIT_LOG, { force: true }); } catch { /* best effort */ }
    process.exit(1);
  });
