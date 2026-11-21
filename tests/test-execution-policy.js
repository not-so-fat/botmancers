#!/usr/bin/env node
// NOT-471: explicit execution kinds and tool policy (lib/execution-policy).
//
// Table-driven across entry point (UI, /api/v0, structured and legacy
// Wake), Agent type, execution kind, and tool profile. Proves:
// - the central kind -> profile map and fail-closed selection/validation;
// - canonical requests persist one validated execution policy snapshot
//   and a policy_selected audit event;
// - a normal direct message to every supported coding Agent creates one
//   read-only Work Request with exactly one read-only Attempt and no
//   review/resume children, from both the UI and /api/v0;
// - edit authority appears only for explicit structured implementation or
//   revision Wakes, never for direct or explanation messages or legacy WAKE;
// - unknown kinds, unsupported authority, and malformed snapshots fail
//   before any adapter call, with the reason persisted;
// - the composite implement/review/resume path is removed (NOT-477).
// Self-contained: isolated SQLite file, scripted in-process direct
// SessionProviders (one per runtime connection), no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-execution-policy-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-execution-policy-home-'));
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
const policy = jiti('./lib/execution-policy.ts');
const router = jiti('./lib/wake-router.ts');
const conversationsApi = jiti('./lib/agent-conversations.ts');
const providerContract = jiti('./lib/session-provider.ts');
const agent = jiti('./lib/agent.ts');
const uiRoute = jiti('./app/api/conversations/[id]/messages/route.ts');
const fake = require('./test-support/fake-session-provider.js');
const raw = db.default;
const { bots, conversations, messages, engine } = db;

// Direct providers: one scripted fake per runtime connection (local
// connections are one per agent type). Every canonical launch is recorded
// as { agent, kind, authority }: kind start (fresh) or send (resume).
let launches = [];
const providerStates = new Map();
const registeredConnections = new Set();
function registerDirectProvider(agentType) {
  const connectionId = db.runtimeConnections.ensureLocal(agentType);
  if (registeredConnections.has(connectionId)) return connectionId;
  registeredConnections.add(connectionId);
  const statePath = path.join(os.tmpdir(), `botmancers-exec-policy-${agentType}-${process.pid}.json`);
  fs.rmSync(statePath, { force: true });
  providerStates.set(agentType, statePath);
  primeResults(agentType);
  providerContract.registerSessionProvider({ connectionId }, () => {
    const inner = fake.createFakeSessionProvider({ statePath, kind: `exec-${agentType}` });
    return {
      ...inner,
      startSession: async input => {
        launches.push({ agent: agentType, kind: 'start', authority: input.authority });
        return inner.startSession(input);
      },
      sendTurn: async input => {
        launches.push({ agent: agentType, kind: 'send', authority: input.authority });
        return inner.sendTurn(input);
      },
    };
  });
  return connectionId;
}
function queueResults(agentType, ...results) {
  fake.mutateFakeProvider(providerStates.get(agentType), state => { state.results = [...(state.results ?? []), ...results]; });
}
// Benign verbatim outputs so no turn falls back to the echo reply (an
// echoed Wake block would route a second Wake, which this suite never
// intends). Primed far beyond the turns each connection runs.
function primeResults(agentType, count = 50) {
  fake.mutateFakeProvider(providerStates.get(agentType), state => {
    const have = state.results ?? [];
    state.results = [...have, ...Array.from({ length: Math.max(0, count - have.length) }, () => `ok ${agentType} turn`)];
  });
}
function queueNext(agentType, result) {
  fake.mutateFakeProvider(providerStates.get(agentType), state => { state.results = [result, ...(state.results ?? [])]; });
}
function makeCodingBot(name, agentType, { policyMode = 'read_only' } = {}) {
  const created = bots.create({ name, title: 'Coder', description: 'Codes.', agent: agentType });
  db.bots.updateRegistration(created.id, agentType, {
    runtime_connection_id: registerDirectProvider(agentType),
    session_scope: { kind: 'workspaces', workspaces: [workdir], sessions: [] },
    default_workspace: workdir,
    policy: { mode: policyMode, allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  return bots.getById(created.id);
}
router.setWakeAvailabilityProbe(() => ({ available: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(5);
  }
  return assert(false, `${label} (timed out)`);
}
function block(envelope) {
  return '```botmancers-wake\n' + JSON.stringify(envelope) + '\n```';
}
function requestsIn(conversationId) {
  return raw.prepare('SELECT * FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at, rowid').all(conversationId);
}
function storedPolicy(request) {
  return JSON.parse(request.policy_snapshot).execution_policy;
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-execution-policy-wd-'));
const CODING_AGENTS = ['cursor', 'claude', 'codex', 'muse'];

async function main() {
  console.log('NOT-471 execution policy test (isolated DB, scripted direct providers)');

  // ---------------------------------------------------------------
  console.log('\nCentral kind -> tool profile map');
  const MAP = [
    ['conversation', 'readonly'],
    ['implementation', 'edit'],
    ['review', 'readonly'],
    ['revision', 'edit'],
  ];
  for (const [kind, profile] of MAP) {
    assert(policy.TOOL_PROFILE_FOR_KIND[kind] === profile, `${kind} -> ${profile}`);
  }
  assert(Object.keys(policy.TOOL_PROFILE_FOR_KIND).length === 4 && Object.isFrozen(policy.TOOL_PROFILE_FOR_KIND), 'exactly four kinds, frozen');
  assert(engine && jiti('./lib/engine-store.ts').TOOL_PROFILE_FOR_KIND === policy.TOOL_PROFILE_FOR_KIND, 'engine store uses the same central map');

  // ---------------------------------------------------------------
  console.log('\nSelection table: entry point x syntax x kind');
  const SELECTION = [
    // entry, syntax, kind, resumes, expected profile | error code
    ['ui', undefined, 'conversation', false, 'readonly'],
    ['api', undefined, 'conversation', false, 'readonly'],
    ['ui', undefined, 'implementation', false, 'unsupported_authority'],
    ['api', undefined, 'implementation', false, 'unsupported_authority'],
    ['ui', undefined, 'review', false, 'unsupported_authority'],
    ['api', undefined, 'revision', true, 'unsupported_authority'],
    ['wake', 'structured', 'conversation', false, 'readonly'],
    ['wake', 'structured', 'implementation', false, 'edit'],
    ['wake', 'structured', 'review', false, 'readonly'],
    ['wake', 'structured', 'revision', true, 'edit'],
    ['wake', 'structured', 'revision', false, 'unsupported_authority'],
    ['wake', 'structured', 'implementation', true, 'unsupported_authority'],
    ['wake', 'structured', 'review', true, 'unsupported_authority'],
    ['wake', 'legacy', 'conversation', false, 'readonly'],
    ['wake', 'legacy', 'implementation', false, 'unsupported_authority'],
    ['wake', 'legacy', 'revision', true, 'unsupported_authority'],
    ['wake', undefined, 'implementation', false, 'unsupported_authority'],
    ['cli', undefined, 'conversation', false, 'unsupported_authority'],
    ['wake', 'structured', 'deploy', false, 'unknown_execution_kind'],
    ['ui', undefined, 'Conversation', false, 'unknown_execution_kind'],
    ['ui', undefined, 'toString', false, 'unknown_execution_kind'],
    ['ui', undefined, '', false, 'unknown_execution_kind'],
    ['ui', undefined, null, false, 'unknown_execution_kind'],
  ];
  for (const [entryPoint, wakeSyntax, executionKind, resumesWorkRequest, expected] of SELECTION) {
    const got = policy.selectExecutionPolicy({ entryPoint, wakeSyntax, executionKind, resumesWorkRequest });
    const label = `${entryPoint}/${wakeSyntax ?? '-'}/${String(executionKind)}${resumesWorkRequest ? '+resume' : ''} -> ${expected}`;
    if (expected === 'readonly' || expected === 'edit') {
      assert(got.ok && got.policy.tool_profile === expected && got.policy.execution_kind === executionKind &&
        policy.validateExecutionPolicy(got.policy).ok, label);
    } else {
      assert(!got.ok && got.code === expected && typeof got.reason === 'string' && got.reason.length > 0, label);
    }
  }

  console.log('\nSnapshot validation table');
  const good = policy.selectExecutionPolicy({ entryPoint: 'wake', wakeSyntax: 'structured', executionKind: 'implementation' }).policy;
  const SNAPSHOTS = [
    ['valid structured implementation', { ...good }, true],
    ['missing', undefined, 'malformed_policy'],
    ['array', [], 'malformed_policy'],
    ['extra field', { ...good, grant: 'all' }, 'malformed_policy'],
    ['missing field', { policy_version: 1, execution_kind: 'implementation', tool_profile: 'edit', entry_point: 'wake' }, 'malformed_policy'],
    ['unknown version', { ...good, policy_version: 2 }, 'malformed_policy'],
    ['unknown kind', { ...good, execution_kind: 'deploy' }, 'unknown_execution_kind'],
    ['unknown profile', { ...good, tool_profile: 'admin' }, 'unsupported_authority'],
    ['implementation with readonly', { ...good, tool_profile: 'readonly' }, 'unsupported_authority'],
    ['conversation with edit', { ...good, execution_kind: 'conversation', tool_profile: 'edit' }, 'unsupported_authority'],
    ['direct-message rule granting implementation', { ...good, entry_point: 'ui', rule: 'direct_message_conversation' }, 'unsupported_authority'],
    ['legacy rule granting implementation', { ...good, rule: 'legacy_wake_conversation' }, 'unsupported_authority'],
    ['structured rule from ui', { ...good, entry_point: 'ui' }, 'malformed_policy'],
    ['unknown rule', { ...good, rule: 'operator_override' }, 'malformed_policy'],
  ];
  for (const [label, snapshot, expected] of SNAPSHOTS) {
    const got = policy.validateExecutionPolicy(snapshot);
    assert(expected === true ? got.ok : (!got.ok && got.code === expected), `${label} -> ${expected === true ? 'ok' : expected}`);
  }

  // ---------------------------------------------------------------
  console.log('\nCanonical request creation persists one validated policy');
  const host = makeCodingBot('Host', 'codex');
  const hostConv = conversations.getByBotId(host.id);
  const hostMsg = messages.create(hostConv.id, 'user', 'fixture');
  const base = {
    sourceConversationId: hostConv.id, sourceEventId: hostMsg.id, requester: { kind: 'person', id: 'owner' },
    targetAgentId: host.id, intent: 'x',
  };
  for (const [kind, profile] of MAP) {
    const selection = policy.selectExecutionPolicy({ entryPoint: 'wake', wakeSyntax: 'structured', executionKind: kind, resumesWorkRequest: kind === 'revision' });
    const { request } = engine.createOrGetWorkRequest({
      ...base, executionKind: kind, toolProfile: profile, idempotencyKey: `create-${kind}`, executionPolicy: selection.policy,
    });
    const stored = storedPolicy(request);
    const events = engine.listEvents(request.id);
    assert(request.execution_kind === kind && request.tool_profile === profile &&
      stored.execution_kind === kind && stored.tool_profile === profile && policy.authorizeWorkRequest(request).ok,
    `${kind}: row and snapshot agree on ${profile}`);
    const selected = events.find(e => e.type === 'policy_selected');
    assert(!!selected && JSON.stringify(Object.keys(JSON.parse(selected.data)).sort()) === JSON.stringify(['entry_point', 'execution_kind', 'policy_version', 'rule', 'tool_profile']),
      `${kind}: policy_selected event carries only kind, profile, entry point, rule, version`);
  }
  const conversationPolicy = policy.selectExecutionPolicy({ entryPoint: 'ui', executionKind: 'conversation' }).policy;
  throwsCode(() => engine.createOrGetWorkRequest({ ...base, executionKind: 'toString', toolProfile: 'readonly', idempotencyKey: 'bad-1' }), 'invalid_input', 'unknown (prototype) kind is rejected at creation');
  throwsCode(() => engine.createOrGetWorkRequest({ ...base, executionKind: 'implementation', toolProfile: 'readonly', idempotencyKey: 'bad-2' }), 'invalid_input', 'implementation with readonly is rejected');
  throwsCode(() => engine.createOrGetWorkRequest({ ...base, executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: 'bad-3', executionPolicy: conversationPolicy }), 'invalid_input', 'a conversation policy cannot back an edit request');
  throwsCode(() => engine.createOrGetWorkRequest({ ...base, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'bad-4', executionPolicy: { ...conversationPolicy, extra: 1 } }), 'invalid_input', 'a malformed policy is rejected at creation');
  throwsCode(() => engine.createOrGetWorkRequest({ ...base, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'bad-5', policy: { execution_policy: good } }), 'invalid_input', 'policy cannot be smuggled inside the free-form policy record');

  // ---------------------------------------------------------------
  console.log('\nDirect /api/v0 message to every coding Agent: one read-only Attempt');
  const owner = { kind: 'service', id: 'svc-policy' };
  const DIRECT = [
    ['explanation', 'Explain how lib/wake.ts parses envelopes.'],
    ['implementation-sounding', 'Please implement rate limiting in the login route and commit it.'],
    ['envelope-shaped', block({ version: 1, target: 'self', executionKind: 'implementation', objective: 'edit everything' })],
  ];
  for (const agentType of CODING_AGENTS) {
    const bot = makeCodingBot(`Api-${agentType}`, agentType);
    for (const [label, content] of DIRECT) {
      launches = [];
      const { accepted, dispatched } = conversationsApi.acceptAgentMessage(owner, { agentId: bot.id, content, idempotencyKey: `api-${agentType}-${label}` });
      await dispatched;
      const requests = requestsIn(accepted.conversationId);
      const request = requests[0];
      const attempts = engine.listAttempts(request.id);
      assert(requests.length === 1 && request.execution_kind === 'conversation' && request.tool_profile === 'readonly' &&
        storedPolicy(request).rule === 'direct_message_conversation',
      `${agentType}/${label}: one conversation Work Request, read-only, direct-message rule`);
      assert(request.state === 'completed' && attempts.length === 1 && attempts[0].tool_profile === 'readonly' && attempts[0].kind === 'launch',
        `${agentType}/${label}: exactly one read-only launch Attempt, completed`);
      assert(launches.length === 1 && launches[0].authority === 'read_only' && launches[0].agent === agentType && launches[0].kind === 'start',
        `${agentType}/${label}: one direct start with read_only authority, no resume`);
      assert(raw.prepare('SELECT COUNT(*) AS n FROM work_requests WHERE parent_request_id = ?').get(request.id).n === 0,
        `${agentType}/${label}: no review or resume child requests`);
    }
  }

  console.log('\nDirect UI message to every coding Agent: canonical dispatch, never the composite');
  for (const agentType of CODING_AGENTS) {
    const bot = makeCodingBot(`Ui-${agentType}`, agentType);
    const conv = conversations.getByBotId(bot.id);
    launches = [];
    queueNext(agentType, 'output 1');
    const response = await uiRoute.POST(
      new Request(`http://localhost/api/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `ui-${agentType}` },
        body: JSON.stringify({ content: 'Implement the widget and then review it.' }),
      }),
      { params: Promise.resolve({ id: conv.id }) }
    );
    const body = await response.json();
    const requestId = body.intake.requestIds[0];
    await waitFor(() => engine.getWorkRequest(requestId).state === 'completed', `${agentType}: UI request completes`);
    while (await agent.processNextUiTurn()) { /* drain */ }
    const request = engine.getWorkRequest(requestId);
    const attempts = engine.listAttempts(requestId);
    const thread = messages.getByConversation(conv.id).filter(m => m.sender_type === 'bot');
    assert(response.status === 200 && requestsIn(conv.id).length === 1 && request.tool_profile === 'readonly' && storedPolicy(request).entry_point === 'ui',
      `${agentType}: UI message creates one read-only Work Request`);
    assert(attempts.length === 1 && attempts[0].tool_profile === 'readonly', `${agentType}: exactly one read-only Attempt`);
    assert(launches.length === 1 && launches[0].authority === 'read_only' && launches[0].kind === 'start',
      `${agentType}: one readonly start, no resume (got ${launches.map(l => l.authority).join(',')})`);
    assert(thread.length === 1 && thread[0].content === 'output 1' && !thread.some(m => /^\[Deck (handoff|review|resume|result)\]/.test(m.content)),
      `${agentType}: one reply, no composite observations`);
  }

  console.log('\nComposite path: retired (code reference)');
  const agentSource = fs.readFileSync(path.join(ROOT, 'lib/agent.ts'), 'utf8');
  const conversationsSource = fs.readFileSync(path.join(ROOT, 'lib/agent-conversations.ts'), 'utf8');
  assert(![agentSource, conversationsSource].some(source => source.includes('delegateCodingViaDeck') || source.includes('runCompositeCompatibility')),
    'NOT-477: no engine module defines or reaches the composite implement/review/resume helper');
  assert(!fs.existsSync(path.join(ROOT, 'lib/agent-deck-run.ts')), 'NOT-543: lib/agent-deck-run.ts is removed (no composite fallback to inspect)');

  // ---------------------------------------------------------------
  console.log('\nWake fixtures: edit only for explicit implementation or revision');
  const tank = makeCodingBot('Tank', 'codex');
  const dev = makeCodingBot('Dev', 'claude', { policyMode: 'workspace_write' });
  makeCodingBot('Rev', 'cursor');
  const tankConv = conversations.getByBotId(tank.id);
  // NOT-475: Wakes route from a tracked turn: each sender's own direct
  // owner message in this conversation. The owner already allowed Tank's
  // edit Wakes to Dev; Dev's self-addressed implementation is the
  // owner-direct self-wake exemption.
  const safety = jiti('./lib/wake-safety.ts');
  safety.ensureEditGrant({ callerAgentId: tank.id, targetAgentId: dev.id, grantedBy: safety.OWNER_PRINCIPAL, sourceWakeId: null, now: Date.now() });
  const turns = new Map();
  const turnOf = sender => {
    if (!turns.has(sender.id)) {
      const ask = messages.create(tankConv.id, 'user', `Owner asks ${sender.name}.`);
      const snapshot = { safety_version: 1, wake_depth: 0, grant_rule: 'readonly_default' };
      turns.set(sender.id, engine.createOrGetWorkRequest({
        sourceConversationId: tankConv.id, sourceEventId: ask.id, requester: { kind: 'person', id: 'local-owner' }, targetAgentId: sender.id,
        intent: ask.content, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: `owner-turn-${sender.id}`,
        safety: { principalType: 'human_owner', principal: { kind: 'person', id: 'local-owner' }, decision: 'allowed', grantRule: 'readonly_default', snapshot },
      }).request);
    }
    return turns.get(sender.id);
  };
  const routeFrom = (sender, content) => router.routeAgentWakes({ sourceEventId: messages.create(tankConv.id, 'bot', content, sender.id).id, parentRequestId: turnOf(sender).id });

  const implWake = routeFrom(tank, block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Add the rate limiter.' }))[0];
  const implementation = implWake.request;
  const WAKES = [
    ['structured implementation', implWake, 'implementation', 'edit'],
    ['structured review', routeFrom(tank, block({ version: 1, target: 'Rev', executionKind: 'review', objective: 'Review it.', contextWorkRequests: [implementation.id] }))[0], 'review', 'readonly'],
    ['structured revision', routeFrom(tank, block({ version: 1, target: 'Dev', executionKind: 'revision', objective: 'Address findings.', resumeWorkRequest: implementation.id }))[0], 'revision', 'edit'],
    ['structured conversation', routeFrom(tank, block({ version: 1, target: 'Dev', executionKind: 'conversation', objective: 'How is it going?' }))[0], 'conversation', 'readonly'],
    // Accepted direct-message rule: a coding Agent asked directly to
    // implement wakes itself visibly; that Wake carries the authority.
    ['self-addressed implementation', routeFrom(dev, block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Do what the person asked.' }))[0], 'implementation', 'edit'],
    ['legacy WAKE asking to implement', routeFrom(tank, 'WAKE Dev: please implement and commit the rate limiter')[0], 'conversation', 'readonly'],
  ];
  for (const [label, routed, kind, profile] of WAKES) {
    const request = routed.request;
    assert(routed.wake.status === 'accepted' && request && request.execution_kind === kind && request.tool_profile === profile &&
      storedPolicy(request).tool_profile === profile && policy.authorizeWorkRequest(request).ok,
    `${label}: ${kind} -> ${profile}`);
  }
  assert(storedPolicy(WAKES[5][1].request).rule === 'legacy_wake_conversation', 'legacy WAKE records the legacy conversation rule');
  const NEGATIVE_WAKES = [
    ['tool profile smuggled', block({ version: 1, target: 'Dev', executionKind: 'conversation', objective: 'x', toolProfile: 'edit' }), 'invalid_envelope'],
    ['unknown kind', block({ version: 1, target: 'Dev', executionKind: 'deploy', objective: 'x' }), 'invalid_envelope'],
    ['review that resumes', block({ version: 1, target: 'Dev', executionKind: 'review', objective: 'x', resumeWorkRequest: implementation.id }), 'invalid_envelope'],
    ['revision of a review request', block({ version: 1, target: 'Rev', executionKind: 'revision', objective: 'x', resumeWorkRequest: WAKES[1][1].request.id }), 'invalid_reference'],
  ];
  for (const [label, content, code] of NEGATIVE_WAKES) {
    const routed = routeFrom(tank, content)[0];
    assert(routed.wake.status === 'rejected' && routed.wake.reason_code === code && routed.request === null, `${label}: rejected (${code}), no Work Request`);
  }

  console.log('\nDispatching explicit Wakes launches their mapped profile');
  for (const [label, routed, , profile] of WAKES.slice(0, 2)) {
    launches = [];
    // FIFO admission (NOT-475) would run the other routed Wakes first; park
    // them (eligible only in the far future) while this one dispatches.
    const parked = raw.prepare("SELECT id FROM work_requests WHERE state = 'queued' AND next_eligible_at IS NULL AND id <> ?").all(routed.request.id).map(row => row.id);
    const park = raw.prepare("UPDATE work_requests SET next_eligible_at = ? WHERE id = ? AND state = 'queued'");
    for (const id of parked) park.run(8_000_000_000_000_000, id);
    await conversationsApi.startAgentDispatch(routed.request.id);
    // NOT-472: the result then returns to the waking Agent as one
    // read-only continuation turn; it launches after the request's own.
    await conversationsApi.waitForAgentDispatchIdle();
    for (const id of parked) park.run(null, id);
    const attempts = engine.listAttempts(routed.request.id);
    const authority = profile === 'edit' ? 'workspace_write' : 'read_only';
    assert(launches.length >= 1 && launches[0].authority === authority && attempts.length === 1 && attempts[0].tool_profile === profile,
      `${label}: one Attempt launched with ${authority} authority`);
    assert(launches.slice(1).every(launch => launch.authority === 'read_only'), `${label}: follow-up turns are read-only`);
  }

  // ---------------------------------------------------------------
  console.log('\nFail before launch: unknown kind, unsupported authority, malformed snapshot');
  const insert = raw.prepare(`
    INSERT INTO work_requests (
      id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id, intent,
      execution_kind, tool_profile, root_request_id, depth, idempotency_key, request_hash, policy_snapshot,
      state, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'person', 'owner', ?, 'x', ?, ?, ?, 0, ?, 'h', ?, 'queued', 0, ?, ?)
  `);
  const snapshotFor = (execution_policy, extra = {}) => JSON.stringify({ source: 'fixture', ...extra, ...(execution_policy === undefined ? {} : { execution_policy }), tool_profile: extra.tool_profile ?? (execution_policy && execution_policy.tool_profile) ?? 'readonly' });
  const FAIL_CLOSED = [
    ['no policy snapshot', 'conversation', 'readonly', snapshotFor(undefined), 'malformed_policy'],
    ['snapshot not JSON', 'conversation', 'readonly', '{not json', 'malformed_policy'],
    ['snapshot unknown kind', 'conversation', 'readonly', snapshotFor({ ...conversationPolicy, execution_kind: 'deploy' }), 'unknown_execution_kind'],
    ['snapshot unsupported profile', 'conversation', 'readonly', snapshotFor({ ...conversationPolicy, tool_profile: 'admin' }), 'unsupported_authority'],
    ['edit row backed by a conversation policy', 'implementation', 'edit', snapshotFor(conversationPolicy, { tool_profile: 'edit' }), 'unsupported_authority'],
    ['direct-message rule claiming implementation', 'implementation', 'edit', snapshotFor({ ...conversationPolicy, execution_kind: 'implementation', tool_profile: 'edit' }), 'unsupported_authority'],
    ['snapshot top-level profile disagrees', 'conversation', 'readonly', snapshotFor(conversationPolicy, { tool_profile: 'edit' }), 'malformed_policy'],
  ];
  for (const [label, kind, profile, snapshot, code] of FAIL_CLOSED) {
    const id = `fail-${label.replace(/\W+/g, '-')}`;
    const at = Date.now();
    insert.run(id, hostConv.id, hostMsg.id, host.id, kind, profile, id, id, snapshot, at, at);
    launches = [];
    await conversationsApi.startAgentDispatch(id);
    const request = engine.getWorkRequest(id);
    const failed = engine.listEvents(id).find(e => e.type === 'state_changed');
    assert(launches.length === 0 && engine.listAttempts(id).length === 0, `${label}: zero adapter calls, zero Attempts`);
    assert(request.state === 'failed' && request.error_code === code && request.error_message && request.state_reason === 'policy_rejected' &&
      failed && JSON.parse(failed.data).reason === 'policy_rejected',
    `${label}: persisted failure ${code}`);
  }
  {
    launches = [];
    const { request } = engine.createOrGetWorkRequest({ ...base, executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: 'no-policy' });
    await conversationsApi.startAgentDispatch(request.id);
    const after = engine.getWorkRequest(request.id);
    assert(launches.length === 0 && after.state === 'failed' && after.error_code === 'malformed_policy',
      'a store-created request without a selected policy never launches');
  }

  router.setWakeAvailabilityProbe(null);
  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

main()
  .then(ok => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
    for (const statePath of providerStates.values()) {
      try { fs.rmSync(statePath, { force: true }); } catch { /* best effort */ }
    }
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
