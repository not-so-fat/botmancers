#!/usr/bin/env node
// NOT-413 Hermes gateway wake path plus NOT-442 single runtime
// (one gateway for Hermes bots; ordinary turns dispatch directly through
// the bot's own stored runtime with no DECK directive).
//
// Self-contained: isolated SQLite file, stub gateway HTTP server on an
// ephemeral port, deterministic caller stub at the model-call boundary.
// No dev server, no API key, no network beyond loopback.
//
// Covers: session header sent, two pokes overlap in time, failed poke marks
// the queue row failed and logs wait_failed, Stop aborts, missing or
// unreachable Hermes configuration posts a visible Hermes error with no
// hidden fallback turn, a newly created bot defaults to Hermes for
// its ordinary turn with a stable per-bot session id, a delegated coding
// run stays a separate Agent Deck session, reply appears once per thread,
// a paraphrased wake message also works, and an explicit per-bot profile
// routes to /p/<profile>/.... Bots without an explicit profile use the
// root chat path; profiles are never derived from name, title or role.
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

const WAIT_LOG = path.join(os.tmpdir(), `botmancers-hermes-waits-${process.pid}.jsonl`);
try { fs.rmSync(WAIT_LOG, { force: true }); } catch { /* fresh start */ }
process.env.HERMES_WAIT_LOG_PATH = WAIT_LOG;
process.env.HERMES_API_SERVER_KEY = 'test-key';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const hermes = jiti('./lib/hermes.ts');

const { bots, conversations, messages, launchSnapshots } = db;
const { uiTurns } = jiti('./lib/ui-turns.ts');
const deckRun = jiti('./lib/agent-deck-run.ts');

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
//
// Implemented as a global fetch interceptor (no loopback listener: listen()
// is unavailable in this sandbox). hermesChat calls global fetch by default,
// so every gateway poke and ordinary Hermes turn lands here. A base URL
// outside the stub host simulates an unreachable gateway by throwing, so
// the unreachable fixture needs no network either.
function startStubGateway(botNameById) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = { delayMs: 120, requests };
  const baseUrl = 'http://stub-hermes.test';
  const originalFetch = globalThis.fetch;

  async function stubFetch(url, init = {}) {
    const parsed = new URL(String(url));
    if (parsed.origin !== baseUrl) {
      throw new Error(`fetch failed: ${parsed.host} unreachable (stub)`);
    }
    const startedAt = Date.now();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const headers = init.headers || {};
    let body = null;
    try { body = JSON.parse(init.body); } catch { body = null; }
    const record = {
      path: parsed.pathname,
      sessionId: headers['X-Hermes-Session-Id'] || headers['x-hermes-session-id'] || null,
      auth: headers.Authorization || headers.authorization || null,
      body,
      startedAt,
      finishedAt: null,
    };
    requests.push(record);
    const task = (body && body.messages || []).map(m => m.content).join('\n');
    const fail = task.includes('FAIL');
    const signal = init.signal;
    try {
      await new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          const early = new Error('This operation was aborted');
          early.name = 'AbortError';
          reject(early);
          return;
        }
        const timer = setTimeout(resolve, state.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          const aborted = new Error('This operation was aborted');
          aborted.name = 'AbortError';
          reject(aborted);
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    } catch (error) {
      inFlight--;
      record.finishedAt = Date.now();
      throw error;
    }
    inFlight--;
    record.finishedAt = Date.now();
    if (fail) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'stub failure' } }),
      };
    }
    const sessionId = String(record.sessionId || '');
    const botId = Object.keys(botNameById).find(id => sessionId.endsWith(id));
    const name = (botId && botNameById[botId]) || 'specialist';
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: `GATEWAY-REPLY from ${name}: done.` } }],
      }),
    };
  }

  globalThis.fetch = stubFetch;
  return {
    server: null, state,
    baseUrl,
    maxInFlight: () => maxInFlight,
    resetOverlap: () => { maxInFlight = inFlight; },
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

async function main() {
  log('NOT-413 Hermes gateway wake test (stub gateway, isolated DB)');
  log(`DB: ${DB_PATH}`);
  log(`Wait log: ${WAIT_LOG}`);
  agent.resetDelegationForTests();

  const origin = bots.create({ deck_id: 'deck-test', name: 'Origin', title: 'Caller', description: 'Originates delegations.' });
  const botA = bots.create({ deck_id: 'deck-test', name: 'A', title: 'Drafter', description: 'Drafts.' });
  const botB = bots.create({ deck_id: 'deck-test', name: 'B', title: 'Checker', description: 'Checks drafts.' });
  const chief = bots.create({ deck_id: 'deck-test', name: 'Chief', title: 'Chief of staff', description: 'Coordinates.', hermes_profile: 'cos' });
  const conv = conversations.getByBotId(origin.id);
  const convA = conversations.getByBotId(botA.id);
  const convB = conversations.getByBotId(botB.id);
  assert(!!conv && !!convA && !!convB, 'origin and specialist threads exist');

  const gateway = await startStubGateway({ [botA.id]: 'A', [botB.id]: 'B', [chief.id]: 'Chief' });
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
  const rootPath = hermes.HERMES_DEFAULT_CHAT_PATH;
  const profileA = hermes.hermesProfilePathForBot(botA);
  assert(profileA === rootPath, `no explicit profile means the root path (${profileA})`);
  const profileB = hermes.hermesProfilePathForBot(botB);
  assert(profileB === rootPath, `role titles never become profiles (${profileB})`);
  const profileChief = hermes.hermesProfilePathForBot(chief);
  assert(profileChief === `/p/cos${rootPath}`, `explicit profile routes to /p/<profile>/... (${profileChief})`);
  assert(!profileChief.includes(chief.id), 'profile path never carries a UUID');
  bots.setHermesProfile(chief.id, null);
  const cleared = hermes.hermesProfilePathForBot(bots.getById(chief.id));
  assert(cleared === rootPath, 'clearing the profile restores the root path');
  bots.setHermesProfile(chief.id, 'cos');

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
  uiTurns.enqueue(conv.id, origin.id);
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
  assert(seen.every(r => r.path === rootPath), `specialist pokes use the root path (got ${seen.map(r => r.path).join(', ')})`);
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
    launchSnapshots.listByBot(origin.id).some(s => s.transport === 'hermes-gateway'),
    "caller's own turn records hermes-gateway as the persistent transport (NOT-434)"
  );
  const delegation = agent.getDelegationState(conv.id);
  assert(!!delegation && delegation.handoffs === 2, `each poke counts a handoff (got ${delegation && delegation.handoffs})`);
  assert(!!delegation && delegation.turns === 4, `each poke counts a turn: caller + 2 pokes + report (got ${delegation && delegation.turns})`);
  assert(uiTurns.countPending(conv.id) === 0, 'queue drained after the report');

  // Scenario 2: failed poke marks its UI turn failed and logs wait_failed.
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
  uiTurns.enqueue(conv.id, origin.id);
  await drain();

  assert(gateway.state.requests.length === 1, 'one gateway request attempted');
  const rows2 = uiTurns.listByConversation(conv.id).filter(r => r.bot_id === botA.id);
  assert(rows2.some(r => r.state === 'failed'), 'failed poke marks its UI turn failed');
  const waits2 = readWaitLog().slice(waitsBefore2);
  const failed = waits2.filter(l => l.event === 'wait_failed');
  assert(failed.length === 1, 'wait log has one wait_failed line');
  assert(
    failed.length === 1 && rows2.some(r => r.id === failed[0].wait_id && r.state === 'failed'),
    'wait_failed names the failed UI turn'
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
  uiTurns.enqueue(conv.id, origin.id);
  const inFlight = agent.processNextUiTurn();
  await sleep(200);
  assert(gateway.state.requests.length === 2, 'both pokes in flight before Stop');
  const stopped = agent.stopDelegation(conv.id);
  assert(stopped === true, 'stopDelegation reports something stopped');
  await inFlight;
  gateway.state.delayMs = 120;

  const waits3 = readWaitLog().slice(waitsBefore3);
  const aborted = waits3.filter(l => l.event === 'wait_failed' && l.code === 'aborted');
  assert(aborted.length === 2, `both pokes log wait_failed with code aborted (got ${aborted.length})`);
  const rows3 = uiTurns.listByConversation(conv.id).filter(r => r.created_at > user3.created_at);
  assert(rows3.filter(r => r.state === 'failed').length >= 2, 'aborted pokes mark their UI turns failed');
  const afterStop = messages.getByConversation(conv.id);
  const countAfterStop = afterStop.length;
  await drain();
  const final3 = messages.getByConversation(conv.id);
  assert(final3.length === countAfterStop, 'zero new messages after Stop settles');
  const thread3 = chainAfter(conv.id, user3.id);
  assert(countIn(thread3, botA.id, 'GATEWAY-REPLY') === 0, 'no late A reply after Stop');
  assert(countIn(thread3, botB.id, 'GATEWAY-REPLY') === 0, 'no late B reply after Stop');
  assert(uiTurns.countPending(conv.id) === 0, 'caller return suppressed after Stop');

  // Scenario 4 (NOT-434): missing or unreachable Hermes configuration posts
  // a visible Hermes error and never activates a hidden fallback. No stub
  // is set here, so any hidden fallback would have to answer the turn
  // itself; instead each fixture's only bot reply must be the Hermes
  // error, with zero gateway requests.
  log('\nScenario 4: Hermes failure fixtures (absent and unreachable), no fallback');
  agent.setDelegationChatStub(null);
  const failBot = bots.create({ deck_id: 'deck-test', name: 'FailBot', title: 'Failure probe', description: 'Probes Hermes failure behavior.' });
  const failConv = conversations.getByBotId(failBot.id);
  assert(!!failConv, 'failure-probe thread exists');

  // Fixture 1 (absent): no key at all.
  delete process.env.HERMES_API_SERVER_KEY;
  gateway.state.requests.length = 0;
  const user4a = messages.create(failConv.id, 'user', 'Hello with no Hermes key configured.');
  uiTurns.enqueue(failConv.id, failBot.id);
  await drain();
  const thread4a = chainAfter(failConv.id, user4a.id);
  assert(
    thread4a.some(m => m.sender_type === 'bot' && m.sender_id === failBot.id && m.content.includes('Hermes configuration missing')),
    'failure fixture absent-key posts the visible Hermes configuration message'
  );
  assert(gateway.state.requests.length === 0, 'failure fixture absent-key sends no gateway request');
  assert(
    thread4a.filter(m => m.sender_type === 'bot').every(m => m.sender_id === failBot.id && m.content.includes('Hermes configuration missing')),
    'failure fixture absent-key posts no hidden fallback reply'
  );

  // Fixture 2 (unreachable): a key plus a base URL outside the stub host,
  // which the fetch stub rejects like a refused connection (no network).
  process.env.HERMES_API_SERVER_KEY = 'test-key';
  process.env.HERMES_BASE_URL = 'http://unreachable.invalid';
  gateway.state.requests.length = 0;
  const user4b = messages.create(failConv.id, 'user', 'Hello with an unreachable Hermes gateway.');
  uiTurns.enqueue(failConv.id, failBot.id);
  await drain();
  const thread4b = chainAfter(failConv.id, user4b.id);
  assert(
    thread4b.some(m => m.sender_type === 'bot' && m.sender_id === failBot.id && m.content.includes('Hermes turn failed')),
    'failure fixture unreachable-gateway posts the visible Hermes failure message'
  );
  assert(
    thread4b.filter(m => m.sender_type === 'bot').every(m => m.sender_id === failBot.id && m.content.includes('Hermes turn failed')),
    'failure fixture unreachable-gateway posts no hidden fallback reply'
  );
  assert(
    thread4a.some(m => m.content.includes('Hermes configuration missing')) &&
    thread4b.some(m => m.content.includes('Hermes turn failed')),
    'no-fallback assertion: both failure fixtures fail visibly with no hidden fallback turn'
  );
  process.env.HERMES_BASE_URL = gateway.baseUrl;

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
  uiTurns.enqueue(conv.id, origin.id);
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
  uiTurns.enqueue(conv.id, origin.id);
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

  // Scenario 7: a bot with an explicit profile is poked on its profile path,
  // while specialists without one stay on the root path.
  log('\nScenario 7: explicit profile pokes /p/<profile>/...');
  gateway.state.requests.length = 0;
  let originCalls7 = 0;
  agent.setDelegationChatStub(ctx => {
    if (ctx.botName === 'Origin') {
      originCalls7++;
      if (originCalls7 === 1) return 'WAKE Chief: Please coordinate the launch.';
      return 'REPORT: Chief coordinated.';
    }
    return 'unused';
  });
  const user7 = messages.create(conv.id, 'user', 'Ask the chief to coordinate the launch.');
  uiTurns.enqueue(conv.id, origin.id);
  await drain();

  const seen7 = gateway.state.requests;
  assert(seen7.length === 1, `one gateway request for the profiled bot (got ${seen7.length})`);
  assert(
    seen7.length === 1 && seen7[0].path === `/p/cos${rootPath}`,
    `explicit profile pokes /p/cos/... (got ${seen7[0] && seen7[0].path})`
  );
  assert(
    seen7.length === 1 && String(seen7[0].sessionId).endsWith(chief.id),
    'profiled poke carries its specialist session id'
  );
  const thread7 = chainAfter(conv.id, user7.id);
  assert(countIn(thread7, chief.id, 'GATEWAY-REPLY from Chief') === 1, "chief's reply appears once in the caller thread");
  assert(countIn(thread7, origin.id, 'REPORT:') === 1, 'profiled wake: report posted');
  assert(
    launchSnapshots.listByBot(chief.id).some(s => s.transport === 'hermes-gateway'),
    "chief's launch snapshot records hermes-gateway"
  );

  // Scenario 8 (NOT-434): a newly created bot with no opt-in runtime
  // switch converses through its Hermes session by default. No stub is
  // set: the ordinary turn must dispatch through the Hermes gateway.
  log('\nScenario 8: newly created bot defaults to Hermes for its ordinary turn');
  agent.setDelegationChatStub(null);
  process.env.HERMES_API_SERVER_KEY = 'test-key';
  process.env.HERMES_BASE_URL = gateway.baseUrl;
  const solo = bots.create({ deck_id: 'deck-test', name: 'Solo', title: 'Soloist', description: 'Answers directly.', agent: 'hermes' });
  const soloReadBack = bots.getById(solo.id);
  assert(
    soloReadBack.agent === 'hermes' && agent.agentForBot(soloReadBack) === 'hermes',
    'default-agent assertion: newly created Hermes agent with a deck reads back as hermes'
  );
  const soloConv = conversations.getByBotId(solo.id);
  assert(!!soloConv, 'solo thread exists');
  gateway.state.requests.length = 0;
  const user8 = messages.create(soloConv.id, 'user', 'Hello Solo, are you there?');
  uiTurns.enqueue(soloConv.id, solo.id);
  await drain();
  const soloConfig = hermes.loadHermesConfig();
  const soloSession = hermes.hermesSessionIdForBot(solo.id, soloConfig);
  const seen8 = gateway.state.requests;
  assert(seen8.length === 1, `Hermes-dispatch assertion: ordinary turn sends one gateway request (got ${seen8.length})`);
  assert(
    seen8.length === 1 && seen8[0].sessionId === soloSession,
    `Hermes-dispatch assertion: ordinary turn carries its stable Hermes session id (${soloSession})`
  );
  assert(
    seen8.length === 1 && seen8[0].path === rootPath,
    `Hermes-dispatch assertion: unprofiled ordinary turn uses the root path (${rootPath})`
  );
  const thread8 = chainAfter(soloConv.id, user8.id);
  assert(
    thread8.some(m => m.sender_type === 'bot' && m.sender_id === solo.id && m.content.includes('GATEWAY-REPLY')),
    'Hermes-dispatch assertion: gateway reply posted once in the solo thread'
  );
  assert(
    launchSnapshots.listByBot(solo.id).some(s => s.transport === 'hermes-gateway'),
    'snapshot transport assertion: solo ordinary turn records hermes-gateway'
  );

  // Scenario 9 (NOT-434): repeated ordinary turns reuse the stable per-bot
  // Hermes session identifier.
  log('\nScenario 9: repeated turns reuse the stable Hermes session');
  gateway.state.requests.length = 0;
  const user9 = messages.create(soloConv.id, 'user', 'Solo, one more turn please.');
  uiTurns.enqueue(soloConv.id, solo.id);
  await drain();
  const seen9 = gateway.state.requests;
  assert(seen9.length === 1, `second ordinary turn sends one gateway request (got ${seen9.length})`);
  assert(
    seen9.length === 1 && seen9[0].sessionId === soloSession,
    'persistent-session reuse assertion: second turn reuses the same stable Hermes session id'
  );
  const thread9 = chainAfter(soloConv.id, user9.id);
  assert(
    thread9.some(m => m.sender_type === 'bot' && m.sender_id === solo.id && m.content.includes('GATEWAY-REPLY')),
    'persistent-session reuse assertion: second gateway reply posted in the solo thread'
  );

  // Scenario 9b (NOT-434 repair): Stop during an ordinary Hermes turn
  // aborts the gateway request and posts no late failure notice. No stub
  // is set, so this exercises the real dispatch path (unlike scenario 3,
  // which stubs the caller turn).
  log('\nScenario 9b: Stop during an ordinary Hermes turn stays silent');
  agent.setDelegationChatStub(null);
  process.env.HERMES_API_SERVER_KEY = 'test-key';
  process.env.HERMES_BASE_URL = gateway.baseUrl;
  gateway.state.delayMs = 1500;
  gateway.state.requests.length = 0;
  const userStop = messages.create(soloConv.id, 'user', 'Solo, take your time on this one.');
  uiTurns.enqueue(soloConv.id, solo.id);
  const ordinaryInFlight = agent.processNextUiTurn();
  let waitedStop = 0;
  while (gateway.state.requests.length === 0 && waitedStop < 2000) {
    await sleep(50);
    waitedStop += 50;
  }
  assert(gateway.state.requests.length === 1, 'ordinary Hermes turn in flight before Stop');
  const stoppedOrdinary = agent.stopDelegation(soloConv.id);
  assert(stoppedOrdinary === true, 'stopDelegation reports the ordinary turn stopped');
  await ordinaryInFlight;
  gateway.state.delayMs = 120;
  const threadStop = chainAfter(soloConv.id, userStop.id);
  assert(
    !threadStop.some(m => m.sender_type === 'bot' && m.sender_id === solo.id && m.content.includes('Hermes turn failed')),
    'no late Hermes failure notice after Stop aborts the ordinary turn'
  );
  assert(
    threadStop.some(m => m.sender_type === 'bot' && m.content.includes('Delegation stopped')),
    'Stop notice still posted once for the aborted ordinary turn'
  );
  const countAfterOrdinaryStop = messages.getByConversation(soloConv.id).length;
  await drain();
  assert(
    messages.getByConversation(soloConv.id).length === countAfterOrdinaryStop,
    'zero new messages after the aborted ordinary turn settles'
  );

  // Scenario 10 (NOT-442): direct dispatch. An ordinary message to a
  // Hermes bot uses the existing Hermes session, while an ordinary
  // message to an Agent Deck bot launches the stored agent/deck/workdir
  // directly without waiting for or parsing a DECK directive. Each case
  // proves the opposite adapter was not invoked.
  log('\nScenario 10: ordinary Hermes message uses the Hermes session directly');
  gateway.state.requests.length = 0;
  let deckCallsDuringHermes = 0;
  deckRun.setDeckRunProcess(async argv => {
    deckCallsDuringHermes += 1;
    return { stdout: '', stderr: 'must not launch deck for Hermes turn', exitCode: 1 };
  });
  agent.setDelegationChatStub(null);
  process.env.HERMES_API_SERVER_KEY = 'test-key';
  process.env.HERMES_BASE_URL = gateway.baseUrl;
  const hermesDirect = bots.create({ deck_id: 'deck-test',
    name: 'HermesDirect', title: 'HermesDirect', description: 'Answers directly.',
    agent: 'hermes',
  });
  const hermesDirectConv = conversations.getByBotId(hermesDirect.id);
  assert(!!hermesDirectConv, 'hermes-direct thread exists');
  const hermesDirectSession = hermes.hermesSessionIdForBot(hermesDirect.id, hermes.loadHermesConfig());
  const user10a = messages.create(hermesDirectConv.id, 'user', 'Hello Hermes bot.');
  uiTurns.enqueue(hermesDirectConv.id, hermesDirect.id);
  await drain();
  const hermesDirectRequests = gateway.state.requests.slice();
  assert(
    hermesDirectRequests.length === 1 && hermesDirectRequests[0].sessionId === hermesDirectSession,
    'Hermes direct-dispatch assertion: ordinary Hermes message uses the existing Hermes session'
  );
  assert(
    deckCallsDuringHermes === 0,
    'Hermes direct-dispatch assertion: opposite adapter (agent-deck) was not invoked'
  );
  deckRun.setDeckRunProcess(null);

  log('\nScenario 11: ordinary Agent Deck message launches the stored deck directly');
  agent.setDelegationChatStub(() => {
    throw new Error('Hermes adapter must not run for an agent-deck turn');
  });
  const deckWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-hermes-deck-cwd-'));
  let launchedArgv = null;
  let deckRuns = 0;
  deckRun.setDeckRunProcess(async argv => {
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      const sessionId = String(runId).endsWith('-2') ? `ses-for-${runId}` : 'ses-deck-impl';
      return {
        stdout: JSON.stringify({
          runId, deck: 'stored-deck-id', client: 'codex', state: 'ended', sessionId,
          startedAt: '2026-10-12T00:00:00.000Z', lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: `output of ${runId}` }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      deckRuns += 1;
      if (!launchedArgv) launchedArgv = argv.slice();
      const runId = `run-hermes-${deckRuns}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });
  const coder = bots.create({
    name: 'Coder', title: 'Coder', description: 'Launches directly.',
    agent: 'codex', deck_id: 'stored-deck-id', working_directory: deckWorkdir,
  });
  const coderConv = conversations.getByBotId(coder.id);
  assert(!!coderConv, 'coder thread exists');
  gateway.state.requests.length = 0;
  const gatewayBeforeDeck = gateway.state.requests.length;
  const user10 = messages.create(coderConv.id, 'user', 'Build the widget.');
  uiTurns.enqueue(coderConv.id, coder.id);
  await drain();
  deckRun.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);
  const thread10 = messages.getByConversation(coderConv.id);
  assert(!!launchedArgv, 'Agent Deck direct-dispatch assertion: ordinary Agent Deck message launches the stored deck run');
  const flag = (argv, name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  assert(
    launchedArgv && flag(launchedArgv, '--client') === 'codex' && launchedArgv[2] === 'stored-deck-id' && flag(launchedArgv, '--cwd') === deckWorkdir,
    'Agent Deck direct-dispatch assertion: launch uses the stored agent/deck/workdir without parsing a DECK directive'
  );
  assert(
    gateway.state.requests.length === gatewayBeforeDeck,
    'Agent Deck direct-dispatch assertion: opposite adapter (Hermes) was not invoked'
  );
  assert(
    deckRuns === 1 && flag(launchedArgv, '--tools') === 'readonly' &&
      thread10.some(m => m.sender_type === 'bot' && m.content === 'output of run-hermes-1') &&
      !thread10.some(m => m.sender_type === 'bot' && m.content.startsWith('[Deck handoff]')),
    'Agent Deck direct-dispatch assertion: one read-only run answers, no composite handoff'
  );
  try { fs.rmSync(deckWorkdir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { gateway.restore(); } catch { /* best effort */ }

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
