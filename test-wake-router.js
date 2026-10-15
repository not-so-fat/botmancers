#!/usr/bin/env node
// NOT-466: Wake router service test (lib/wake-router, lib/wake).
//
// Proves at the service boundary: one accepted structured Wake creates
// exactly one Work Request with requester, target, source, parent/root
// lineage, depth, outcome, execution kind, and policy snapshot;
// reprocessing the same event creates nothing new (repeatedly, and from a
// fresh process that reopens the database); missing, unconfigured, and
// temporarily unavailable targets are recorded as unavailable/blocked
// with a persisted reason and recover from durable state; legacy WAKE is
// translated through the same validator and never gains authority; and
// lineage survives a restart without the in-memory delegation chain.
// Self-contained: isolated SQLite file, no network, no runtime launch.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SCENARIO = process.env.WAKE_ROUTER_SCENARIO || 'main';
const DB_PATH = process.env.WAKE_ROUTER_DB || path.join(os.tmpdir(), `botmancers-wake-router-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
if (SCENARIO === 'main') removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-wake-router-home-'));
delete process.env.HERMES_API_SERVER_KEY;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
function throwsCode(fn, code, label) {
  try {
    fn();
  } catch (error) {
    return assert(error && error.code === code, `${label} (got ${error && error.code}: ${error && error.message})`);
  }
  return assert(false, `${label} (did not throw)`);
}

const db = jiti('./lib/db.ts');
const router = jiti('./lib/wake-router.ts');
const wake = jiti('./lib/wake.ts');
const raw = db.default;
const { bots, conversations, messages, groups, engine } = db;

const TABLES = ['wakes', 'work_requests', 'engine_events'];
function counts() {
  return {
    ...Object.fromEntries(TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])),
    ui_turns: raw.prepare("SELECT COUNT(*) AS n FROM work_requests WHERE executor <> 'dispatcher'").get().n,
  };
}
function sameCounts(a, b) {
  return TABLES.every(table => a[table] === b[table]);
}
function block(envelope) {
  return '```botmancers-wake\n' + JSON.stringify(envelope, null, 2) + '\n```';
}
const available = () => ({ available: true });

if (SCENARIO === 'restart') runRestart();
else runMain();

function runMain() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/wake-v1.fixtures.json'), 'utf8'));
  router.setWakeAvailabilityProbe(available);

  const tank = bots.create({ deck_id: 'deck-tank', name: 'Tank', title: 'Coordinator', description: 'Coordinates.', agent: 'hermes' });
  const dev = bots.create({ deck_id: 'deck-dev', name: 'Dev', title: 'Developer', description: 'Implements.', agent: 'claude' });
  const reviewer = bots.create({ deck_id: 'deck-review', name: 'Reviewer', title: 'Reviewer', description: 'Reviews.', agent: 'codex' });
  const unconfigured = bots.create({ name: 'Unconfigured', title: 'Idle', description: 'No deck yet.', agent: 'cursor' });
  const flaky = bots.create({ deck_id: 'deck-flaky', name: 'Flaky', title: 'Sometimes away', description: 'Flaky.', agent: 'hermes' });
  groups.create('Team', [dev.id, reviewer.id]);
  const conversation = conversations.getByBotId(tank.id);

  // The coordinator's own turn: a person asks Tank, one canonical request.
  const ask = messages.create(conversation.id, 'user', 'Implement notifications and have Reviewer check them.');
  const { request: root } = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id,
    sourceEventId: ask.id,
    requester: { kind: 'person', id: 'owner' },
    targetAgentId: tank.id,
    intent: ask.content,
    executionKind: 'conversation',
    toolProfile: 'readonly',
    idempotencyKey: 'ask-1',
  });
  // NOT-475: edit Wakes need an owner-approved pair grant (lib/wake-safety;
  // test-wake-safety.js covers asking for one).
  const safety = jiti('./lib/wake-safety.ts');
  for (const target of [dev, unconfigured]) {
    safety.ensureEditGrant({ callerAgentId: tank.id, targetAgentId: target.id, grantedBy: safety.OWNER_PRINCIPAL, sourceWakeId: null, now: Date.now() });
  }

  console.log('Accepted structured Wake');
  const implEnvelope = fixtures.valid.find(f => f.name === 'tank_wakes_developer').envelope;
  const m1 = messages.create(conversation.id, 'bot', `On it.\n${block(implEnvelope)}\nI will report back.`, tank.id);
  const before1 = counts();
  const first = router.routeAgentWakes({ sourceEventId: m1.id, parentRequestId: root.id });
  const after1 = counts();
  assert(first.length === 1 && first[0].created, 'one Wake routed and created');
  const w1 = first[0].wake;
  const r1 = first[0].request;
  assert(w1.status === 'accepted' && w1.reason_code === null, 'Wake is accepted');
  assert(after1.wakes - before1.wakes === 1 && after1.work_requests - before1.work_requests === 1, 'exactly one wakes row and one work_requests row');
  assert(after1.ui_turns === before1.ui_turns, 'no UI turn (no UI dispatch)');
  const row = raw.prepare('SELECT * FROM work_requests WHERE id = ?').get(r1.id);
  assert(row.requester_kind === 'bot' && row.requester_id === tank.id, 'requester is the sending Agent (derived from the source event)');
  assert(row.target_agent_id === dev.id, 'target is the resolved Agent ID');
  assert(row.source_conversation_id === conversation.id && row.source_event_id === m1.id, 'source conversation and event recorded');
  assert(row.parent_request_id === root.id && row.root_request_id === root.id && row.depth === 1, 'parent, root, and depth recorded');
  assert(row.wake_event_id === w1.id && w1.work_request_id === r1.id, 'request and Wake reference each other');
  assert(row.intent === implEnvelope.objective, 'intent is the requested outcome');
  assert(row.execution_kind === 'implementation' && row.tool_profile === 'edit', 'execution kind and derived tool profile');
  assert(row.state === 'queued' && row.idempotency_key === w1.idempotency_key, 'queued under the Wake idempotency key');
  assert(w1.idempotency_key.startsWith(`wake:v1:${m1.id}:0:`), 'idempotency key derives from source event and position');
  const policy = JSON.parse(row.policy_snapshot);
  assert(policy.source === 'wake' && policy.wake_version === 1 && policy.wake_syntax === 'structured', 'policy snapshot names the Wake contract');
  assert(policy.tool_profile === 'edit' && policy.target_name_snapshot === 'Dev' && policy.requested_target === 'Dev', 'policy snapshot keeps authority and target snapshot');
  assert(policy.limits.maxAttempts === 3 && policy.root_wake_id === w1.id, 'policy snapshot keeps limits and root Wake');
  assert(w1.root_wake_id === w1.id && w1.parent_request_id === root.id && w1.root_request_id === root.id && w1.depth === 1, 'Wake row carries durable lineage');
  const events1 = engine.listEvents(r1.id);
  assert(events1.map(e => e.type).join(',') === 'accepted,policy_selected', 'one accepted engine event plus its policy selection');

  console.log('Duplicate processing');
  for (let i = 0; i < 3; i++) {
    const again = router.routeAgentWakes({ sourceEventId: m1.id, parentRequestId: root.id });
    assert(again.length === 1 && !again[0].created && again[0].wake.id === w1.id && again[0].request.id === r1.id, `reprocess ${i + 1} returns the same Wake and request`);
  }
  assert(sameCounts(counts(), after1), 'reprocessing wrote no rows');
  assert(engine.listEvents(r1.id).length === 2, 'no duplicate accepted event');
  const reordered = messages.create(conversation.id, 'bot', block({ objective: implEnvelope.objective, executionKind: 'implementation', limits: { maxAttempts: 3 }, target: 'Dev', version: 1 }), tank.id);
  const keyA = wake.wakeIdempotencyKey(m1.id, wake.parseWakes(m1.content)[0]).split(':').pop();
  const keyB = wake.wakeIdempotencyKey(reordered.id, wake.parseWakes(reordered.content)[0]).split(':').pop();
  assert(keyA === keyB, 'payload digest ignores key order');

  console.log('Multiple Wakes in source order, mixed syntax');
  const m2 = messages.create(conversation.id, 'bot', [
    'Two things.',
    block({ version: 1, target: 'reviewer', executionKind: 'review', objective: 'Review the implementation.', contextWorkRequests: [r1.id] }),
    'WAKE Dev: summarize what changed for the changelog.',
  ].join('\n'), tank.id);
  const second = router.routeAgentWakes({ sourceEventId: m2.id, parentRequestId: root.id });
  assert(second.length === 2 && second.every(entry => entry.wake.status === 'accepted'), 'both Wakes accepted');
  assert(second[0].wake.position === 0 && second[0].wake.syntax === 'structured' && second[0].request.target_agent_id === reviewer.id, 'structured review first, resolved case-insensitively');
  assert(second[0].wake.target_name_snapshot === 'Reviewer' && second[0].request.tool_profile === 'readonly', 'review is read-only with display snapshot');
  assert(second[1].wake.position === 1 && second[1].wake.syntax === 'legacy' && second[1].request.execution_kind === 'conversation', 'legacy directive second, as conversation');

  console.log('Target resolution failures');
  const before3 = counts();
  const m3 = messages.create(conversation.id, 'bot', [
    block({ version: 1, target: 'Ghost', executionKind: 'conversation', objective: 'Are you there?' }),
    block({ version: 1, target: 'Unconfigured', executionKind: 'implementation', objective: 'Build it.' }),
    block({ version: 1, target: 'Flaky', executionKind: 'conversation', objective: 'Explain the flake.' }),
    block({ version: 1, target: 'Team', executionKind: 'conversation', objective: 'Everyone look.' }),
  ].join('\n'), tank.id);
  router.setWakeAvailabilityProbe(bot => bot.id === flaky.id ? { available: false, reason: 'Flaky is restarting.' } : { available: true });
  const third = router.routeAgentWakes({ sourceEventId: m3.id, parentRequestId: root.id });
  const [missing, blockedConfig, blockedTemp, groupWake] = third.map(entry => entry.wake);
  assert(third.length === 4, 'every Wake recorded, none dropped');
  assert(missing.status === 'unavailable' && missing.reason_code === 'target_not_found' && /Ghost/.test(missing.reason) && missing.work_request_id === null, 'missing target: unavailable with persisted reason');
  assert(missing.depth === 1 && missing.root_request_id === root.id, 'missing target keeps lineage');
  const configReq = engine.getWorkRequest(blockedConfig.work_request_id);
  assert(blockedConfig.status === 'blocked' && blockedConfig.reason_code === 'target_unconfigured' && blockedConfig.target_agent_id === unconfigured.id, 'unconfigured target: blocked Wake');
  assert(configReq.state === 'blocked' && /^target_unconfigured: .*Agent Deck/.test(configReq.state_reason), 'unconfigured target: blocked Work Request with reason');
  const tempReq = engine.getWorkRequest(blockedTemp.work_request_id);
  assert(blockedTemp.status === 'blocked' && blockedTemp.reason_code === 'target_unavailable' && tempReq.state === 'blocked' && tempReq.state_reason === 'target_unavailable: Flaky is restarting.', 'temporarily unavailable target: blocked with reason');
  assert(engine.listEvents(tempReq.id).map(e => e.type).join(',') === 'accepted,policy_selected,state_changed', 'blocked request records accepted, policy, then blocked');
  assert(groupWake.status === 'rejected' && groupWake.reason_code === 'target_is_group' && groupWake.work_request_id === null, 'a Group is never a Wake target');
  assert(third.every(entry => entry.wake.status !== 'accepted' && (entry.request === null || entry.request.state !== 'queued')), 'no failure is reported as success');
  const after3 = counts();
  assert(after3.work_requests - before3.work_requests === 2 && after3.wakes - before3.wakes === 4, 'two blocked requests, four Wake rows');
  const replay3 = router.routeAgentWakes({ sourceEventId: m3.id, parentRequestId: root.id });
  assert(replay3.every(entry => !entry.created) && sameCounts(counts(), after3), 'reprocessing failures writes nothing');

  console.log('Default availability check');
  router.setWakeAvailabilityProbe(null);
  const m3b = messages.create(conversation.id, 'bot', block({ version: 1, target: 'Flaky', executionKind: 'conversation', objective: 'Ping.' }), tank.id);
  const noGateway = router.routeAgentWakes({ sourceEventId: m3b.id, parentRequestId: root.id })[0];
  assert(noGateway.wake.status === 'blocked' && noGateway.wake.reason_code === 'target_unavailable' && /Hermes gateway/.test(noGateway.wake.reason), 'Hermes target without a gateway is blocked, not dropped');
  router.setWakeAvailabilityProbe(available);

  console.log('Recovery from durable state');
  const stillMissing = router.retryWake(missing.id);
  assert(!stillMissing.created && stillMissing.wake.status === 'unavailable', 'retry before the target exists changes nothing');
  const ghost = bots.create({ deck_id: 'deck-ghost', name: 'Ghost', title: 'Late', description: 'Arrives late.', agent: 'hermes' });
  const found = router.retryWake(missing.id);
  assert(found.created && found.wake.status === 'accepted' && found.wake.target_agent_id === ghost.id && found.request.state === 'queued', 'missing target recovers into one queued request');
  assert(found.request.parent_request_id === root.id && found.request.depth === 1 && found.request.wake_event_id === missing.id, 'recovered request keeps lineage');
  assert(!router.retryWake(missing.id).created, 'retrying a recovered Wake is a no-op');
  const tempRecovered = router.retryWake(blockedTemp.id);
  assert(tempRecovered.wake.status === 'accepted' && tempRecovered.request.state === 'queued' && tempRecovered.request.id === tempReq.id, 'temporarily unavailable target recovers: blocked -> queued, same request');
  assert(router.retryWake(blockedConfig.id).request.state === 'blocked', 'unconfigured target stays blocked until configured');
  bots.updateAgentSelection(unconfigured.id, { deck_id: 'deck-now' });
  const configRecovered = router.retryWake(blockedConfig.id);
  assert(configRecovered.wake.status === 'accepted' && configRecovered.request.state === 'queued', 'configured target recovers');
  assert(router.retryWake(groupWake.id).wake.status === 'rejected', 'rejected Wakes are not retried');
  const mLate = messages.create(conversation.id, 'bot', block({ version: 1, target: 'Later', executionKind: 'conversation', objective: 'Anyone?' }), tank.id);
  const lateWake = router.routeAgentWakes({ sourceEventId: mLate.id, parentRequestId: root.id })[0].wake;
  assert(lateWake.status === 'unavailable' && lateWake.reason_code === 'target_not_found', 'Later starts unavailable');
  groups.create('Later', [dev.id]);
  const lateRetry = router.retryWake(lateWake.id);
  assert(!lateRetry.created && lateRetry.wake.status === 'rejected' && lateRetry.wake.reason_code === 'target_is_group' && lateRetry.wake.work_request_id === null, 'unavailable Wake whose name becomes a Group is rejected, not left unavailable');
  assert(router.retryWake(lateWake.id).wake.status === 'rejected', 'rejected after retry stays rejected');

  console.log('Blocked retry checks the stored target, not the name');
  const idle = bots.create({ name: 'Idle', title: 'Idle', description: 'No deck yet.', agent: 'cursor' });
  const mIdle = messages.create(conversation.id, 'bot', block({ version: 1, target: 'Idle', executionKind: 'conversation', objective: 'Wake up.' }), tank.id);
  const idleWake = router.routeAgentWakes({ sourceEventId: mIdle.id, parentRequestId: root.id })[0].wake;
  assert(idleWake.status === 'blocked' && idleWake.target_agent_id === idle.id, 'unconfigured Idle is blocked');
  bots.updateIdentity(idle.id, 'Idle Old', idle.title, idle.description);
  const impostor = bots.create({ deck_id: 'deck-impostor', name: 'Idle', title: 'New', description: 'Took the name.', agent: 'hermes' });
  const renamedRetry = router.retryWake(idleWake.id);
  assert(!renamedRetry.created && renamedRetry.wake.status === 'blocked' && renamedRetry.request.state === 'blocked', 'launchable Agent holding the old name does not unblock the request');
  assert(renamedRetry.wake.target_agent_id === idle.id && renamedRetry.request.target_agent_id === idle.id && impostor.id !== idle.id, 'Wake and request keep the stored target');
  router.setWakeAvailabilityProbe(bot => bot.id === idle.id ? { available: false, reason: 'Idle is restarting.' } : { available: true });
  bots.updateAgentSelection(idle.id, { deck_id: 'deck-idle' });
  const idleStillBlocked = router.retryWake(idleWake.id);
  assert(idleStillBlocked.request.state === 'blocked', 'stored target configured but unavailable stays blocked');
  assert(idleStillBlocked.wake.status === 'blocked' && idleStillBlocked.wake.reason_code === 'target_unavailable' && idleStillBlocked.wake.reason === 'Idle is restarting.', 'still-blocked retry records the current reason');
  router.setWakeAvailabilityProbe(available);
  const idleRecovered = router.retryWake(idleWake.id);
  assert(idleRecovered.wake.status === 'accepted' && idleRecovered.request.state === 'queued' && idleRecovered.request.target_agent_id === idle.id, 'stored target recovers under its new name');

  console.log('Legacy WAKE compatibility');
  for (const fixture of fixtures.valid) {
    assert(wake.validateWakeEnvelope(fixture.envelope).ok, `valid fixture: ${fixture.name}`);
  }
  const m4 = messages.create(conversation.id, 'bot', [
    'WAKE Dev: please explain the module.',
    'WAKE Dev: {"version":1,"target":"Dev","executionKind":"implementation","objective":"x","resumeWorkRequest":"' + r1.id + '"}',
    'WAKE GROUP: everyone review.',
    'WAKE Reviewer:',
  ].join('\n'), tank.id);
  const legacy = wake.parseWakes(m4.content);
  assert(legacy.length === 4 && legacy.every(candidate => candidate.syntax === 'legacy'), 'four legacy directives parsed');
  assert(JSON.stringify(legacy[0].validation) === JSON.stringify(wake.validateWakeEnvelope(wake.legacyWakeEnvelope('Dev', 'please explain the module.'))), 'legacy goes through the structured validator');
  const legacyRouted = router.routeAgentWakes({ sourceEventId: m4.id, parentRequestId: root.id });
  assert(legacyRouted[0].request.execution_kind === 'conversation' && legacyRouted[0].request.tool_profile === 'readonly', 'legacy Wake is a read-only conversation');
  const smuggled = legacyRouted[1].request;
  assert(smuggled.execution_kind === 'conversation' && smuggled.tool_profile === 'readonly', 'legacy text cannot request implementation or edit');
  assert(JSON.parse(smuggled.policy_snapshot).resume_work_request === null && JSON.parse(smuggled.policy_snapshot).wake_syntax === 'legacy', 'legacy text cannot request a resume');
  assert(legacyRouted[2].wake.status === 'rejected' && legacyRouted[2].wake.reason_code === 'invalid_envelope', 'legacy WAKE GROUP is rejected');
  assert(legacyRouted[3].wake.status === 'rejected', 'legacy WAKE without a message is rejected');
  const inside = wake.parseWakes(block({ version: 1, target: 'Dev', executionKind: 'conversation', objective: 'WAKE Reviewer: do not parse me' }));
  assert(inside.length === 1 && inside[0].syntax === 'structured', 'legacy syntax inside a structured block is not a second Wake');

  console.log('Structured negative fixtures');
  const m5 = messages.create(conversation.id, 'bot', [
    ...fixtures.invalid.map(fixture => block(fixture.envelope)),
    '```botmancers-wake\n{not json\n```',
  ].join('\n'), tank.id);
  const before5 = counts();
  const rejected = router.routeAgentWakes({ sourceEventId: m5.id, parentRequestId: root.id });
  assert(rejected.length === fixtures.invalid.length + 1 && rejected.every(entry => entry.wake.status === 'rejected' && entry.wake.reason_code === 'invalid_envelope' && entry.request === null), 'every invalid envelope is recorded as rejected and launches nothing');
  assert(/unknown field tools/.test(rejected[0].wake.reason), 'tool escalation rejected with reason');
  assert(counts().work_requests === before5.work_requests, 'no Work Request for invalid envelopes');

  console.log('References and revision');
  const m6 = messages.create(conversation.id, 'bot', [
    block({ version: 1, target: 'Dev', executionKind: 'revision', objective: 'Address the findings.', resumeWorkRequest: r1.id, contextWorkRequests: [second[0].request.id] }),
    block({ version: 1, target: 'Reviewer', executionKind: 'revision', objective: 'Take over.', resumeWorkRequest: r1.id }),
    block({ version: 1, target: 'Dev', executionKind: 'review', objective: 'Look.', contextWorkRequests: ['work-elsewhere'] }),
  ].join('\n'), tank.id);
  const refs = router.routeAgentWakes({ sourceEventId: m6.id, parentRequestId: root.id });
  assert(refs[0].wake.status === 'accepted' && refs[0].request.execution_kind === 'revision' && refs[0].request.tool_profile === 'edit', 'revision of the same developer accepted with edit');
  assert(refs[1].wake.status === 'rejected' && refs[1].wake.reason_code === 'invalid_reference', 'revision cannot move a session to another Agent');
  assert(refs[2].wake.status === 'rejected' && refs[2].wake.reason_code === 'invalid_reference', 'reference outside the lineage rejected');

  console.log('Caller identity and parent checks');
  throwsCode(() => router.routeAgentWakes({ sourceEventId: ask.id }), 'invalid_input', 'a person message is not a Wake source');
  throwsCode(() => router.routeAgentWakes({ sourceEventId: m1.id, parentRequestId: r1.id }), 'parent_mismatch', 'parent must be the requester’s own request');
  throwsCode(() => router.routeAgentWakes({ sourceEventId: 'nope' }), 'source_not_found', 'unknown source event');

  console.log('Nested lineage');
  const m7 = messages.create(conversation.id, 'bot', block({ version: 1, target: 'Reviewer', executionKind: 'review', objective: 'Check my work.', contextWorkRequests: [r1.id] }), dev.id);
  const nested = router.routeAgentWakes({ sourceEventId: m7.id, parentRequestId: r1.id })[0];
  assert(nested.request.parent_request_id === r1.id && nested.request.root_request_id === root.id && nested.request.depth === 2, 'nested Wake: depth 2 under the same root');
  assert(nested.wake.root_wake_id === w1.id && nested.request.requester_id === dev.id, 'nested Wake keeps the root Wake');

  console.log('Restart (fresh process, reopened database)');
  const afterAll = counts();
  const child = spawnSync(process.execPath, [__filename], {
    env: {
      ...process.env,
      WAKE_ROUTER_SCENARIO: 'restart',
      WAKE_ROUTER_DB: DB_PATH,
      WAKE_ROUTER_IDS: JSON.stringify({
        conversation: conversation.id, root: root.id, r1: r1.id, w1: w1.id, m1: m1.id, m3: m3.id, m7: m7.id,
        nested: nested.request.id, nestedWake: nested.wake.id, counts: afterAll,
      }),
    },
    encoding: 'utf8',
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert(child.status === 0, 'restart scenario passed');
  assert(sameCounts(counts(), afterAll), 'restart reprocessing wrote no rows');

  console.log('Deletion keeps referential integrity');
  const scout = bots.create({ deck_id: 'deck-scout', name: 'Scout', title: 'Scout', description: 'Scouts.', agent: 'hermes' });
  const scoutConversation = conversations.getByBotId(scout.id);
  const mScout = messages.create(scoutConversation.id, 'bot', [
    block({ version: 1, target: 'Dev', executionKind: 'conversation', objective: 'Look at this.' }),
    block({ version: 1, target: 'Nobody', executionKind: 'conversation', objective: 'Hello?' }),
  ].join('\n'), scout.id);
  const scoutAsk = messages.create(scoutConversation.id, 'user', 'Scout around.');
  const { request: scoutRoot } = engine.createOrGetWorkRequest({
    sourceConversationId: scoutConversation.id, sourceEventId: scoutAsk.id, requester: { kind: 'person', id: 'owner' },
    targetAgentId: scout.id, intent: scoutAsk.content, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'scout-ask',
  });
  const [scoutRouted, scoutUnrouted] = router.routeAgentWakes({ sourceEventId: mScout.id, parentRequestId: scoutRoot.id }).map(entry => entry.wake);
  raw.transaction(() => jiti('./lib/engine-store.ts').deleteEngineRecordsForAgent(raw, scout.id))();
  // NOT-475: a Wake routes only from a tracked turn of the requester, so
  // its request descends from the requester's own request and goes with it.
  assert(!engine.getWorkRequest(scoutRouted.work_request_id) && !router.getWake(scoutRouted.id), 'deleting the requester removes its lineage and the Wakes in it');
  assert(!router.getWake(scoutUnrouted.id), "deleting the requester removes its unrouted Wakes");
  raw.transaction(() => jiti('./lib/engine-store.ts').deleteEngineRecordsForConversation(raw, scoutConversation.id))();
  raw.transaction(() => jiti('./lib/engine-store.ts').deleteEngineRecordsForConversation(raw, conversation.id))();
  assert(raw.prepare('SELECT COUNT(*) AS n FROM wakes').get().n === 0, 'deleting the conversation removes its Wakes');

  router.setWakeAvailabilityProbe(null);
  finish();
}

function runRestart() {
  const ids = JSON.parse(process.env.WAKE_ROUTER_IDS);
  router.setWakeAvailabilityProbe(available);
  const source = fs.readFileSync(path.join(ROOT, 'lib/wake-router.ts'), 'utf8');
  assert(!/from '\.\/agent'/.test(source) && !/delegationChain|getDelegationState/.test(source), 'router does not read the in-memory delegation chain');

  const chain = router.walkLineage(ids.nested);
  assert(chain.map(request => request.id).join('>') === [ids.nested, ids.r1, ids.root].join('>'), 'walked parent references nested -> r1 -> root');
  assert(chain.every(request => request.root_request_id === ids.root), 'every request names the durable root');
  assert(chain.map(request => request.depth).join(',') === '2,1,0', 'depth is durable');
  const nestedWake = router.getWake(ids.nestedWake);
  assert(nestedWake.root_wake_id === ids.w1 && router.getWake(ids.w1).work_request_id === ids.r1, 'root Wake reference is durable');

  for (const event of [ids.m1, ids.m3, ids.m7]) {
    const again = router.routeAgentWakes({ sourceEventId: event, parentRequestId: event === ids.m7 ? ids.r1 : ids.root });
    assert(again.length > 0 && again.every(entry => !entry.created), `reprocessing ${event.slice(0, 8)} after restart creates nothing`);
  }
  assert(router.routeAgentWakes({ sourceEventId: ids.m1, parentRequestId: ids.root })[0].request.id === ids.r1, 'same request after restart');
  assert(sameCounts(counts(), ids.counts), 'no rows written after restart');
  assert(engine.listEvents(ids.r1).filter(event => event.type === 'accepted').length === 1, 'still one accepted event');

  const agent = jiti('./lib/agent.ts');
  assert(agent.getDelegationState(ids.conversation) === null, 'a routed Wake writes no UI delegation chain');
  finish();
}

function finish() {
  if (SCENARIO === 'main') removeDb(DB_PATH);
  if (failures > 0) {
    console.log(`\n${SCENARIO}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`\n${SCENARIO}: all checks passed`);
}
