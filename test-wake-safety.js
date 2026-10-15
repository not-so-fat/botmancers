#!/usr/bin/env node
// NOT-475: Wake safety enforcement (lib/wake-safety, lib/wake-router,
// lib/conversation-intake, lib/coordinator-loop, lib/dispatcher,
// lib/conversation-projection, proxy.ts).
//
// Proves at the service boundary:
// - every case in docs/contracts/wake-safety-v1.fixtures.json, driven
//   through the real intake, router, grant decision, loop, and projection;
// - every runnable request records its categorized caller principal,
//   target, grant rule and grant, and policy snapshot (human, API, Agent);
// - denied, unknown, untracked, and over-limit work creates no Attempt and
//   cannot be made to launch by a direct store write or a forced state
//   change (the dispatcher refuses it);
// - the root budget holds under concurrent routing from several processes,
//   and replay / duplicate delivery (also after a restart) counts nothing;
// - global and per-target concurrency queue allowed work, FIFO, without
//   losing or failing it;
// - revoking a grant never rewrites recorded evidence;
// - a database left by the previous release (schema 12) migrates exactly
//   per the approved rule (child process, legacy fixture).
// Self-contained: isolated SQLite files, no network, no runtime launch.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const SCENARIO = process.env.WAKE_SAFETY_SCENARIO || 'main';
const DB_PATH = process.env.WAKE_SAFETY_DB || path.join(os.tmpdir(), `botmancers-wake-safety-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
if (SCENARIO === 'main' || SCENARIO === 'legacy') removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = process.env.HOME_OVERRIDE || fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-wake-safety-home-'));
delete process.env.HERMES_API_SERVER_KEY;
delete process.env.BOTMANCERS_WAKE_MAX_DEPTH;
delete process.env.BOTMANCERS_WAKE_ROOT_BUDGET;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
function finish() {
  console.log(failures === 0 ? `\n${SCENARIO}: TEST RESULT: PASS` : `\n${SCENARIO}: TEST RESULT: FAIL (${failures} assertion(s))`);
  process.exit(failures === 0 ? 0 : 1);
}
function block(envelope) {
  return '```botmancers-wake\n' + JSON.stringify(envelope) + '\n```';
}

if (SCENARIO === 'race') runRaceChild();
else if (SCENARIO === 'replay') runReplayChild();
else if (SCENARIO === 'legacy') runLegacy();
else runMain().catch(error => { console.error(error); process.exit(1); });

// ---------------------------------------------------------------------
async function runMain() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/wake-safety-v1.fixtures.json'), 'utf8'));
  const exercised = new Set();
  const fixture = name => {
    const found = fixtures.cases.find(entry => entry.name === name);
    if (!found) throw new Error(`no fixture ${name}`);
    exercised.add(name);
    return found;
  };
  const db = jiti('./lib/db.ts');
  const router = jiti('./lib/wake-router.ts');
  const loop = jiti('./lib/coordinator-loop.ts');
  const safety = jiti('./lib/wake-safety.ts');
  const intake = jiti('./lib/conversation-intake.ts');
  const api = jiti('./lib/agent-api.ts');
  const dispatcherLib = jiti('./lib/dispatcher.ts');
  const boundary = jiti('./lib/owner-boundary.ts');
  const wakeNotice = jiti('./lib/wake-notice.ts');
  const raw = db.default;
  const { bots, conversations, messages, engine, projector, UI_OWNER_PRINCIPAL } = db;

  const OWNER = { category: 'human_owner', principal: UI_OWNER_PRINCIPAL };
  const availability = new Map();
  router.setWakeAvailabilityProbe(bot => availability.get(bot.name) ?? { available: true });

  const agent = (name, kind) => bots.create({ deck_id: `deck-${name.toLowerCase()}`, name, title: name, description: name, agent: kind });
  const tank = agent('Tank', 'hermes');
  const dev = agent('Dev', 'claude');
  const reviewer = agent('Reviewer', 'codex');
  const researcher = agent('Researcher', 'hermes');
  const helper = agent('Helper', 'hermes');
  const codex = agent('Codex', 'codex');
  const tankConv = conversations.getByBotId(tank.id);

  const TABLES = ['wakes', 'work_requests', 'work_attempts', 'engine_events', 'wake_grants', 'wake_safety_decisions', 'messages', 'conversation_intakes', 'conversations'];
  const counts = () => Object.fromEntries(TABLES.map(table => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const same = (a, b) => TABLES.every(table => a[table] === b[table]);
  const attempts = requestId => raw.prepare('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ?').get(requestId).n;
  const eventTypes = requestId => engine.listEvents(requestId).map(event => event.type);
  const decisions = requestId => engine.listSafetyDecisions(requestId);
  const latest = requestId => engine.latestSafetyDecision(requestId);
  const policyOf = request => JSON.parse(request.policy_snapshot);
  let keyCounter = 0;
  // FIFO admission makes every older claimable request a blocker. Fixtures
  // leave many owner turns queued that nothing here dispatches, so a
  // controlled claim parks the unrelated ones (an eligibility far in the
  // future) and restores them afterwards.
  const PARKED_UNTIL = 8_000_000_000_000_000;
  function parkQueued(keep) {
    const ids = raw.prepare("SELECT id FROM work_requests WHERE state = 'queued' AND next_eligible_at IS NULL").all()
      .map(row => row.id).filter(id => !keep.includes(id));
    const set = raw.prepare("UPDATE work_requests SET next_eligible_at = ? WHERE id = ? AND state = 'queued'");
    for (const id of ids) set.run(PARKED_UNTIL, id);
    return () => { for (const id of ids) set.run(null, id); };
  }
  function claimAlone(worker, id) {
    const restore = parkQueued([id]);
    try { return worker.claim(id); } finally { restore(); }
  }

  // A direct owner message through the real UI intake (human_owner).
  function ownerMessage(target, content) {
    const conversation = conversations.getByBotId(target.id);
    return intake.acceptConversationMessage({
      surface: 'ui', requester: UI_OWNER_PRINCIPAL, idempotencyKey: `ui-${++keyCounter}`, conversation: { id: conversation.id },
      content, fingerprint: { content, target: target.id }, route: () => ({ deliveries: [{ agentId: target.id }] }), dispatch: () => {},
    });
  }
  // A /api/v0-style message through the real intake (api_principal).
  function apiMessage(principal, target, content) {
    return intake.acceptConversationMessage({
      surface: 'api', requester: principal, idempotencyKey: `api-${++keyCounter}`, conversation: { create: true },
      content, fingerprint: { content, target: target.id }, route: () => ({ deliveries: [{ agentId: target.id }] }), dispatch: () => {},
    });
  }
  // An Agent reply on its own dispatched turn, routed by the router.
  function reply(parent, sender, content) {
    const message = messages.create(parent.source_conversation_id, 'bot', content, sender.id);
    return { message, routed: router.routeAgentWakes({ sourceEventId: message.id, parentRequestId: parent.id }) };
  }
  // A request finished with the given reply (as the dispatcher would).
  function complete(request, sender, content) {
    const message = messages.create(request.source_conversation_id, 'bot', content, sender.id);
    engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: message.id } });
    return message;
  }
  // The thread's Wake notices (app/page.tsx) for one Wake, from the real read model.
  const noticesFor = (conversationId, wakeId) => wakeNotice.wakeNotices(projector.listConversationEvents(conversationId)).filter(n => n.wakeId === wakeId);
  const viewIds = conversationId => new Set(projector.listConversationEvents(conversationId).map(view => view.eventId));
  function newViews(conversationId, before, subject) {
    return projector.listConversationEvents(conversationId).filter(view => !before.has(view.eventId)
      && ((subject.wakeId && view.wakeId === subject.wakeId) || (subject.requestId && view.requestId === subject.requestId)));
  }
  // Ordered subsequence match of expected projection entries.
  function projectionMatches(views, expected) {
    let index = 0;
    for (const entry of expected) {
      while (index < views.length) {
        const view = views[index++];
        if (view.kind !== entry.kind) continue;
        if (entry.text !== undefined && view.text !== entry.text) continue;
        if (entry.actions !== undefined && JSON.stringify(view.data.actions ?? []) !== JSON.stringify(entry.actions)) continue;
        if (entry.data && Object.keys(entry.data).some(key => view.data[key] !== entry.data[key])) continue;
        entry.matched = true;
        break;
      }
      if (!entry.matched) return false;
      delete entry.matched;
    }
    return true;
  }
  const continuationKey = (kind, id) => raw.prepare("SELECT * FROM work_requests WHERE requester_kind = 'service' AND idempotency_key = ?").get(`continuation:v1:${kind}:${id}`);

  // Checks one fixture's expectation against the real outcome.
  function expectCase(name, { wake, request, views, auditBefore = [], continuation }) {
    const want = fixture(name).expect;
    const label = `[${name}]`;
    if (want.wake === null) assert(!wake, `${label} no Wake row`);
    else if (want.wake) {
      assert(wake && wake.status === want.wake.status && (wake.reason_code ?? null) === want.wake.reasonCode,
        `${label} Wake ${want.wake.status}/${want.wake.reasonCode} (got ${wake && wake.status}/${wake && wake.reason_code})`);
      if (want.wake.limit !== undefined) assert(wake.limit_value === want.wake.limit && wake.observed_value === want.wake.observed, `${label} limit ${want.wake.limit}, observed ${want.wake.observed}`);
    }
    if (want.workRequest === null) assert(!request, `${label} no Work Request`);
    else if (want.workRequest) {
      const w = want.workRequest;
      assert(!!request && request.state === w.state, `${label} request ${w.state} (got ${request && request.state})`);
      if (w.reason) {
        const reason = request.state === 'cancelled' ? (engine.listEvents(request.id).filter(e => e.type === 'state_changed').pop().data) : request.state_reason;
        assert((reason || '').includes(w.reason), `${label} reason ${w.reason} (got ${reason})`);
      }
      if (w.executionKind) assert(request.execution_kind === w.executionKind, `${label} execution kind ${w.executionKind}`);
      if (w.toolProfile) assert(request.tool_profile === w.toolProfile, `${label} tool profile ${w.toolProfile}`);
      if (w.wakeDepth !== undefined) assert(request.wake_depth === w.wakeDepth, `${label} wake depth ${w.wakeDepth} (got ${request.wake_depth})`);
      if (w.grantRule) assert(latest(request.id) && latest(request.id).grant_rule === w.grantRule, `${label} grant rule ${w.grantRule} (got ${latest(request.id) && latest(request.id).grant_rule})`);
      if (w.waitingFor === 'capacity') assert(request.state === 'queued' && eventTypes(request.id).includes('dispatch_deferred'), `${label} queued, waiting for capacity`);
      if (w.transition) {
        const [from, to] = w.transition.split('->');
        assert(engine.listEvents(request.id).some(e => e.type === 'state_changed' && JSON.parse(e.data).from === from && JSON.parse(e.data).to === to), `${label} transition ${w.transition}`);
      }
      if (['blocked', 'cancelled', 'queued'].includes(request.state)) assert(attempts(request.id) === 0, `${label} no Attempt`);
    }
    if (views) {
      const expected = JSON.parse(JSON.stringify(want.projection));
      assert(projectionMatches(views, expected), `${label} projection ${want.projection.map(p => p.kind).join(',')} (got ${views.map(v => `${v.kind}:${v.text}`).join(' | ')})`);
      assert(!views.some(v => ['request_running', 'request_completed', 'request_failed', 'result'].includes(v.kind)), `${label} no lifecycle that implies work ran`);
    }
    if (request) {
      const audit = eventTypes(request.id).slice(auditBefore.length).filter(type => fixtures.auditEvents.includes(type));
      assert(want.audit.every(type => audit.includes(type)) && audit.every(type => want.audit.includes(type)), `${label} audit [${want.audit}] (got [${audit}])`);
    }
    if (continuation !== undefined) {
      assert(want.continuation === false ? !continuation : !!continuation, `${label} continuation ${want.continuation}`);
    }
  }

  // =====================================================================
  console.log('Approved limits');
  assert(router.WAKE_MAX_DEPTH === 3 && router.WAKE_ROOT_BUDGET === 12 && loop.COORDINATOR_MAX_CONTINUATIONS === 24, 'depth 3, root budget 12, continuations 24');
  const defaults = dispatcherLib.DEFAULT_DISPATCH_CONFIG;
  assert(defaults.maxGlobal === fixtures.limits.globalConcurrency && defaults.maxPerTarget === fixtures.limits.perTargetConcurrency, 'dispatcher defaults: global 4, per-target 1');
  const narrowed = safety.wakeSafetyLimits({ BOTMANCERS_WAKE_MAX_DEPTH: '2', BOTMANCERS_WAKE_ROOT_BUDGET: '5' });
  const raised = safety.wakeSafetyLimits({ BOTMANCERS_WAKE_MAX_DEPTH: '9', BOTMANCERS_WAKE_ROOT_BUDGET: '500' });
  assert(narrowed.maxWakeDepth === 2 && narrowed.rootBudget === 5 && narrowed.maxContinuations === 10, 'configuration may narrow the limits');
  assert(raised.maxWakeDepth === 3 && raised.rootBudget === 12 && raised.maxContinuations === 24, 'configuration never raises the limits');

  // =====================================================================
  console.log('\nFlow A: human owner and API callers');
  {
    const before = counts();
    const accepted = ownerMessage(codex, fixture('owner_direct_message_readonly').action.content);
    const request = accepted.requests[0];
    const views = projector.listConversationEvents(accepted.conversationId).filter(v => v.requestId === request.id);
    expectCase('owner_direct_message_readonly', { request, views });
    const decision = latest(request.id);
    assert(decision.principal_type === 'human_owner' && decision.principal_kind === 'person' && decision.principal_id === 'local-owner'
      && decision.target_agent_id === codex.id && decision.decision === 'allowed' && decision.grant_rule === 'readonly_default', 'human caller: principal, target, grant rule persisted');
    assert(request.root_principal_kind === 'person' && request.root_principal_id === 'local-owner' && policyOf(request).safety_version === 1
      && policyOf(request).grant_rule === 'readonly_default' && JSON.parse(decision.policy_snapshot).root_principal.id === 'local-owner', 'human caller: root principal and policy snapshot persisted');
    assert(counts().work_requests === before.work_requests + 1, 'one request');

    const textual = ownerMessage(tank, fixture('wake_text_in_human_message_is_text').action.content);
    const tv = projector.listConversationEvents(textual.conversationId).filter(v => v.requestId === textual.requests[0].id);
    expectCase('wake_text_in_human_message_is_text', { request: textual.requests[0], views: tv });
    assert(raw.prepare('SELECT COUNT(*) AS n FROM wakes WHERE source_event_id = ?').get(textual.acceptedMessageId).n === 0, 'Wake-looking text in a human message is never a Wake');

    const ci = { kind: 'service', id: 'ci-bot' };
    const apiAccepted = apiMessage(ci, codex, 'Summarize the build.');
    const apiDecision = latest(apiAccepted.requests[0].id);
    assert(apiDecision.principal_type === 'api_principal' && apiDecision.principal_kind === 'service' && apiDecision.principal_id === 'ci-bot'
      && apiDecision.grant_rule === 'readonly_default' && apiAccepted.requests[0].root_principal_id === 'ci-bot', 'API caller: principal, target, grant rule persisted');
    const vouchedOwner = apiMessage(UI_OWNER_PRINCIPAL, codex, 'I claim to be the owner.');
    assert(latest(vouchedOwner.requests[0].id).principal_type === 'api_principal', 'an API principal vouched as person:local-owner is still an API principal');

    const unknownBefore = counts();
    let code = null;
    try {
      intake.acceptConversationMessage({
        surface: 'ui', requester: { kind: 'service', id: 'stranger' }, idempotencyKey: 'ui-stranger', conversation: { id: tankConv.id },
        content: 'hi', fingerprint: {}, route: () => ({ deliveries: [{ agentId: tank.id }] }), dispatch: () => {},
      });
    } catch (error) { code = error.code; }
    assert(code === 'unknown_principal' && same(counts(), unknownBefore), 'unknown UI caller refused before anything is written');

    const apiRequest = (headers = {}) => new Request(`http://127.0.0.1:43123/api/v0/agents/${codex.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ content: 'hello', idempotencyKey: `api-unknown-${++keyCounter}` }),
    });
    api.setAgentApiAuthenticator(null);
    let snapshot = counts();
    let response = await api.handleSendAgentMessage(apiRequest(), codex.id);
    let body = await response.json();
    assert(response.status === fixture('api_without_authenticator').expect.http.status && body.error.code === 'authentication_unavailable' && same(counts(), snapshot), '[api_without_authenticator] 503, nothing persisted');
    api.setAgentApiAuthenticator(() => null);
    snapshot = counts();
    response = await api.handleSendAgentMessage(apiRequest(), codex.id);
    body = await response.json();
    assert(response.status === fixture('api_authentication_fails').expect.http.status && body.error.code === 'unauthenticated' && same(counts(), snapshot), '[api_authentication_fails] 401, nothing persisted');
    api.setAgentApiAuthenticator(null);

    const { proxy } = jiti('./proxy.ts');
    const { NextRequest } = require('next/server');
    const given = fixture('ui_route_from_foreign_origin').given;
    snapshot = counts();
    const foreign = proxy(new NextRequest(`http://${given.host}/api/conversations/${tankConv.id}/messages`, {
      method: 'POST', headers: { host: given.host, origin: given.origin, 'content-type': 'application/json' }, body: '{"content":"hello"}',
    }));
    const foreignBody = await foreign.json();
    assert(foreign.status === 403 && foreignBody.error.code === 'owner_origin_required' && same(counts(), snapshot), '[ui_route_from_foreign_origin] 403 owner_origin_required, nothing persisted');
    const rebound = proxy(new NextRequest('http://evil.example:43123/api/bots', { headers: { host: 'evil.example:43123' } }));
    assert(rebound.status === 403, 'a non-loopback Host is refused even for reads');
    const sameOrigin = proxy(new NextRequest('http://127.0.0.1:43123/api/bots', { method: 'POST', headers: { host: '127.0.0.1:43123', origin: 'http://127.0.0.1:43123' } }));
    const crossSite = proxy(new NextRequest('http://localhost:43123/api/bots', { method: 'POST', headers: { host: 'localhost:43123', 'sec-fetch-site': 'cross-site' } }));
    const v0 = proxy(new NextRequest('http://evil.example/api/v0/agents/x/messages', { method: 'POST', headers: { host: 'evil.example' } }));
    assert(sameOrigin.status === 200 && crossSite.status === 403 && v0.status === 200, 'same-origin loopback passes; cross-site refused; /api/v0 uses its own authenticator');
    assert(boundary.ownerBoundaryRefusal({ method: 'POST', host: '[::1]:43123', origin: 'http://[::1]:43123', secFetchSite: 'same-origin', protocol: 'http:' }) === null
      && boundary.ownerBoundaryRefusal({ method: 'POST', host: '127.0.0.1.evil.example', origin: null, secFetchSite: null, protocol: 'http:' }) !== null, 'IPv6 loopback admitted; look-alike host refused');
    // Every mutation needs one approved same-origin proof.
    const mutation = (origin, secFetchSite, method = 'POST') => boundary.ownerBoundaryRefusal({ method, host: '127.0.0.1:43123', origin, secFetchSite, protocol: 'http:' });
    assert(mutation(null, null) !== null && mutation(null, 'none') !== null && mutation('http://127.0.0.1:43123', 'none') !== null
      && mutation(null, 'same-site') !== null && mutation('http://127.0.0.1:43123', 'cross-site') !== null,
    'a mutation with no proof, Sec-Fetch-Site none, or a contradicting header is refused');
    assert(mutation(null, 'same-origin') === null && mutation('http://127.0.0.1:43123', null) === null && mutation('http://127.0.0.1:43123', 'same-origin') === null
      && mutation(null, null, 'GET') === null, 'a matching Origin or Sec-Fetch-Site same-origin admits a mutation; reads need no proof');
    snapshot = counts();
    const headerless = proxy(new NextRequest(`http://127.0.0.1:43123/api/conversations/${tankConv.id}/messages`, {
      method: 'POST', headers: { host: '127.0.0.1:43123', 'content-type': 'application/json' }, body: '{"content":"hello"}',
    }));
    const typed = proxy(new NextRequest('http://127.0.0.1:43123/api/bots', { method: 'DELETE', headers: { host: '127.0.0.1:43123', 'sec-fetch-site': 'none' } }));
    assert(headerless.status === 403 && (await headerless.json()).error.code === 'owner_origin_required' && typed.status === 403 && same(counts(), snapshot),
      'a headerless or Sec-Fetch-Site none loopback mutation is refused 403 owner_origin_required, nothing persisted');
  }

  // =====================================================================
  console.log('\nFlow B: Agent principals, edit grants, owner decisions');
  const tankTurn = ownerMessage(tank, 'Implement notifications, review, and revise.').requests[0];
  let pendingWake;
  {
    const action = fixture('coordinator_edit_wake_without_grant_waits_for_owner').action;
    const before = viewIds(tankConv.id);
    const { routed } = reply(tankTurn, tank, block(action.envelope));
    pendingWake = routed[0].wake;
    const request = routed[0].request;
    expectCase('coordinator_edit_wake_without_grant_waits_for_owner', { wake: pendingWake, request, views: newViews(tankConv.id, before, { wakeId: pendingWake.id, requestId: request.id }) });
    const blockedNotices = noticesFor(tankConv.id, pendingWake.id);
    assert(blockedNotices.length === 1 && blockedNotices[0].tone === 'blocked' && blockedNotices[0].actionable
      && /needs your approval for edit work/.test(blockedNotices[0].text), 'thread: the blocked Wake shows with Allow / Deny');
    const blockedDecision = latest(request.id);
    assert(blockedDecision.principal_type === 'agent_principal' && blockedDecision.principal_id === tank.id && blockedDecision.decision === 'blocked'
      && blockedDecision.reason_code === 'grant_required' && blockedDecision.grant_id === null, 'blocked decision names the Agent caller and no grant');
    assert(safety.listWakeGrants().length === 0, 'no grant exists before the owner decides');

    console.log('  bypass: a blocked request forced to queued cannot launch');
    const forcedTurn = ownerMessage(tank, 'Another edit.').requests[0];
    const forced = reply(forcedTurn, tank, block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Sneak in.' })).routed[0];
    engine.transitionWorkRequest(forced.request.id, { from: 'blocked', to: 'queued', reason: 'forced' });
    const worker = dispatcherLib.createDispatcher(raw, engine, { owner: 'bypass-worker' });
    const refused = worker.claim(forced.request.id);
    const forcedAfter = engine.getWorkRequest(forced.request.id);
    assert(!refused.ok && refused.reason === 'not_authorized' && forcedAfter.state === 'failed' && forcedAfter.error_code === 'not_authorized' && attempts(forced.request.id) === 0,
      'claim refuses a request whose latest decision is not allowed (failed not_authorized, no Attempt)');

    console.log('  bypass: a request written without a safety decision cannot launch');
    const ask = messages.create(tankConv.id, 'user', 'direct store write');
    const { request: rogue } = engine.createOrGetWorkRequest({
      sourceConversationId: tankConv.id, sourceEventId: ask.id, requester: { kind: 'bot', id: tank.id }, targetAgentId: dev.id,
      intent: 'edit everything', executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: 'rogue-1',
    });
    const rogueClaim = worker.claim(rogue.id);
    assert(!rogueClaim.ok && rogueClaim.reason === 'not_authorized' && attempts(rogue.id) === 0, 'claim refuses a request with no recorded decision');

    console.log('  API and Agent principals cannot decide grants');
    const snapshot = counts();
    let denied = null;
    try { router.decideWakeGrant({ wakeId: pendingWake.id, decision: 'allow', caller: { category: 'api_principal', principal: { kind: 'service', id: 'ci-bot' } } }); }
    catch (error) { denied = error; }
    const still = router.getWake(pendingWake.id);
    assert(denied && denied.code === 'owner_required' && denied.status === fixture('api_principal_cannot_decide_grants').expect.http.status && same(counts(), snapshot)
      && still.reason_code === 'grant_required' && engine.getWorkRequest(still.work_request_id).state === 'blocked', '[api_principal_cannot_decide_grants] 403 owner_required, state unchanged');
    let agentDecides = null;
    try { router.decideWakeGrant({ wakeId: pendingWake.id, decision: 'allow', caller: { category: 'agent_principal', principal: { kind: 'bot', id: tank.id } } }); }
    catch (error) { agentDecides = error; }
    assert(agentDecides && agentDecides.code === 'owner_required', 'an Agent cannot approve its own grant');
  }
  let editGrant;
  let grantedImpl;
  {
    // Owner Allow on the pending Wake.
    const request = engine.getWorkRequest(pendingWake.work_request_id);
    const auditBefore = eventTypes(request.id);
    const before = viewIds(tankConv.id);
    const result = router.decideWakeGrant({ wakeId: pendingWake.id, decision: 'allow', caller: OWNER });
    editGrant = result.grant;
    grantedImpl = engine.getWorkRequest(request.id);
    const want = fixture('owner_allows_edit_grant').expect.grant;
    assert(editGrant && editGrant.caller_agent_id === tank.id && editGrant.target_agent_id === dev.id && editGrant.authority === want.authority
      && `${editGrant.granted_by_kind}:${editGrant.granted_by_id}` === want.grantedBy && editGrant.source_wake_id === pendingWake.id, '[owner_allows_edit_grant] durable pair grant by the owner');
    expectCase('owner_allows_edit_grant', { wake: router.getWake(pendingWake.id), request: grantedImpl, views: newViews(tankConv.id, before, { requestId: request.id }), auditBefore });
    const allowed = latest(request.id);
    assert(allowed.decision === 'allowed' && allowed.grant_rule === 'edit_grant' && allowed.grant_id === editGrant.id && allowed.principal_type === 'agent_principal'
      && allowed.principal_id === tank.id && allowed.target_agent_id === dev.id, 'Agent caller: principal, target, matched grant persisted on acceptance');
    assert(decisions(request.id).map(d => d.decision).join(',') === 'blocked,allowed', 'the blocked evaluation is kept beside the allowed one');
    const allowedNotices = noticesFor(tankConv.id, pendingWake.id);
    assert(allowedNotices.map(n => `${n.tone}:${n.actionable}`).join(',') === 'blocked:false,allowed:false', 'thread: after Allow the block keeps no actions and the Wake shows allowed');
    const replayed = router.decideWakeGrant({ wakeId: pendingWake.id, decision: 'allow', caller: OWNER });
    assert(!replayed.runnable && safety.listWakeGrants().length === 1 && decisions(request.id).length === 2, 'repeating Allow changes nothing');
    let late = null;
    try { router.decideWakeGrant({ wakeId: pendingWake.id, decision: 'deny', caller: OWNER }); } catch (error) { late = error; }
    assert(late && late.code === 'not_pending' && engine.getWorkRequest(request.id).state === 'queued', 'Deny after Allow is refused; the request stays queued');
  }
  {
    // Grant exists: a revision routes without asking.
    const action = fixture('coordinator_edit_wake_with_grant_routes').action;
    const envelope = { ...action.envelope, resumeWorkRequest: grantedImpl.id };
    const before = viewIds(tankConv.id);
    const { routed } = reply(tankTurn, tank, block(envelope));
    expectCase('coordinator_edit_wake_with_grant_routes', { wake: routed[0].wake, request: routed[0].request, views: newViews(tankConv.id, before, { requestId: routed[0].request.id }) });
    assert(policyOf(routed[0].request).grant_id === editGrant.id && latest(routed[0].request.id).grant_id === editGrant.id, 'matched grant id in policy snapshot and decision');

    const reviewAction = fixture('readonly_review_wake_needs_no_grant').action;
    const before2 = viewIds(tankConv.id);
    const review = reply(tankTurn, tank, block({ ...reviewAction.envelope, contextWorkRequests: [grantedImpl.id] })).routed[0];
    expectCase('readonly_review_wake_needs_no_grant', { wake: review.wake, request: review.request, views: newViews(tankConv.id, before2, { requestId: review.request.id }) });
  }
  {
    // Deny on a second pending Wake (another pair).
    const helperTurn = ownerMessage(helper, 'Ask Dev to build it.').requests[0];
    const helperConv = conversations.getByBotId(helper.id);
    const { routed, message } = reply(helperTurn, helper, block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Build it.' }));
    complete(helperTurn, helper, 'routed already');
    const request = routed[0].request;
    const auditBefore = eventTypes(request.id);
    const before = viewIds(helperConv.id);
    const result = router.decideWakeGrant({ wakeId: routed[0].wake.id, decision: 'deny', caller: OWNER });
    assert(result.ended && result.grant === null && safety.activeEditGrant(helper.id, dev.id) === undefined, '[owner_denies_edit_grant] no grant created');
    const queuedNext = loop.continueAfterTerminal(request.id);
    const resultContinuation = continuationKey('result', request.id);
    expectCase('owner_denies_edit_grant', {
      wake: router.getWake(routed[0].wake.id), request: engine.getWorkRequest(request.id),
      views: newViews(helperConv.id, before, { requestId: request.id }), auditBefore, continuation: resultContinuation,
    });
    assert(noticesFor(helperConv.id, routed[0].wake.id).map(n => `${n.tone}:${n.actionable}`).join(',') === 'blocked:false,denied:false', 'thread: after Deny the block keeps no actions and the Wake shows denied');
    assert(queuedNext.includes(resultContinuation.id) && /grant_denied/.test(resultContinuation.intent), 'the coordinator is told, in one continuation, that no work ran');
    assert(latest(request.id).decision === 'denied' && latest(request.id).principal_type === 'human_owner', 'the denial is a recorded owner decision');
    assert(loop.continueAfterTerminal(request.id).length === 0 && !router.decideWakeGrant({ wakeId: routed[0].wake.id, decision: 'deny', caller: OWNER }).runnable, 'duplicate delivery and a repeated Deny create nothing');
    assert(router.retryWake(routed[0].wake.id).wake.reason_code === 'grant_denied' && attempts(request.id) === 0, 'a denied Wake is never retried and never ran');
    assert(message.sender_id === helper.id, 'the Wake came from the helper turn');
  }
  {
    // Self-wake: owner-direct exempt, API-rooted needs a grant.
    const direct = ownerMessage(dev, 'Please implement the change.').requests[0];
    const devConv = conversations.getByBotId(dev.id);
    const before = viewIds(devConv.id);
    const self = reply(direct, dev, block(fixture('owner_direct_self_wake_is_exempt').action.envelope)).routed[0];
    expectCase('owner_direct_self_wake_is_exempt', { wake: self.wake, request: self.request, views: newViews(devConv.id, before, { requestId: self.request.id }) });

    const ciRoot = apiMessage({ kind: 'service', id: 'ci-bot' }, dev, 'Implement the change.');
    const ciTurn = ciRoot.requests[0];
    const before2 = viewIds(ciRoot.conversationId);
    const ciSelf = reply(ciTurn, dev, block(fixture('api_rooted_self_wake_needs_grant').action.envelope)).routed[0];
    expectCase('api_rooted_self_wake_needs_grant', { wake: ciSelf.wake, request: ciSelf.request, views: newViews(ciRoot.conversationId, before2, { requestId: ciSelf.request.id }) });

    // An API principal vouched as person:local-owner gets no exemption.
    const vouched = apiMessage(UI_OWNER_PRINCIPAL, dev, 'Implement the change.');
    const vouchedSelf = reply(vouched.requests[0], dev, block(fixture('api_rooted_self_wake_needs_grant').action.envelope)).routed[0];
    assert(vouchedSelf.wake.reason_code === 'grant_required', 'self-wake exemption requires a human_owner intake, not a vouched API id');

    // A Wake-rooted self-wake (depth 1) needs a grant too.
    const nested = reply(grantedImpl, dev, block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'More.' })).routed[0];
    assert(nested.wake.reason_code === 'grant_required', 'a Wake-rooted self-wake needs a grant');
  }
  {
    // Revocation: asks again; accepted work keeps its evidence.
    const evidenceBefore = JSON.stringify(decisions(grantedImpl.id));
    const policyBefore = engine.getWorkRequest(grantedImpl.id).policy_snapshot;
    const revoked = safety.revokeWakeGrant(editGrant.id, OWNER);
    assert(revoked.revoked && revoked.grant.revoked_by_id === 'local-owner' && eventTypes(grantedImpl.id).includes('grant_revoked'), 'owner revokes the grant (audited)');
    let apiRevoke = null;
    try { safety.revokeWakeGrant(editGrant.id, { category: 'api_principal', principal: { kind: 'service', id: 'ci-bot' } }); } catch (error) { apiRevoke = error; }
    assert(apiRevoke && apiRevoke.code === 'owner_required', 'an API principal cannot revoke');
    assert(JSON.stringify(decisions(grantedImpl.id)) === evidenceBefore && engine.getWorkRequest(grantedImpl.id).policy_snapshot === policyBefore, 'revocation does not rewrite recorded decisions or the policy snapshot');
    let rewrite = false;
    try { raw.prepare("UPDATE wake_safety_decisions SET grant_rule = 'x' WHERE request_id = ?").run(grantedImpl.id); } catch { rewrite = true; }
    let regrant = false;
    try { raw.prepare('UPDATE wake_grants SET revoked_at = NULL WHERE id = ?').run(editGrant.id); } catch { regrant = true; }
    assert(rewrite && regrant, 'decisions are append-only and a revoked grant cannot be revived');
    const worker = dispatcherLib.createDispatcher(raw, engine, { owner: 'revocation-worker' });
    const claim = claimAlone(worker, grantedImpl.id);
    assert(claim.ok, 'accepted work keeps its frozen decision and still launches after revocation');
    worker.release(claim.lease, 'test');
    engine.transitionWorkRequest(grantedImpl.id, { from: 'running', to: 'completed', result: {} });

    const action = fixture('revoked_grant_asks_again').action;
    const before = viewIds(tankConv.id);
    const again = reply(tankTurn, tank, block(action.envelope)).routed[0];
    expectCase('revoked_grant_asks_again', { wake: again.wake, request: again.request, views: newViews(tankConv.id, before, { requestId: again.request.id }) });
    // Allow again: a new grant row; the revoked one stays as history.
    router.decideWakeGrant({ wakeId: again.wake.id, decision: 'allow', caller: OWNER });
    editGrant = safety.activeEditGrant(tank.id, dev.id);
    assert(editGrant && editGrant.id !== revoked.grant.id && safety.listWakeGrants({ includeRevoked: true }).length >= 2, 're-allowing creates a new grant; the revoked one is kept');
  }

  // =====================================================================
  console.log('\nFlow C: grant before availability');
  {
    const flowTurn = ownerMessage(tank, 'Flow C.').requests[0];
    const given = fixture('flow_c_edit_wake_unlaunchable_target_asks_grant_first').given.targetAvailability;
    const quill = agent('Quill', 'codex');
    availability.set('Quill', given);
    const envelope = { ...fixture('flow_c_edit_wake_unlaunchable_target_asks_grant_first').action.envelope, target: 'Quill' };
    const expectText = text => text.replace(/Dev/g, 'Quill');
    const rename = name => {
      const want = fixture(name).expect;
      for (const entry of want.projection) if (entry.text) entry.text = expectText(entry.text);
    };
    ['flow_c_edit_wake_unlaunchable_target_asks_grant_first', 'flow_c_owner_allows_while_target_unavailable', 'flow_c_grant_revoked_while_waiting_for_target_asks_again', 'flow_c_owner_denies_while_target_unavailable'].forEach(rename);
    availability.set('Quill', { available: false, reason: expectText(given.reason) });

    let before = viewIds(tankConv.id);
    const first = reply(flowTurn, tank, block(envelope)).routed[0];
    expectCase('flow_c_edit_wake_unlaunchable_target_asks_grant_first', { wake: first.wake, request: first.request, views: newViews(tankConv.id, before, { requestId: first.request.id }) });

    let auditBefore = eventTypes(first.request.id);
    before = viewIds(tankConv.id);
    const allowed = router.decideWakeGrant({ wakeId: first.wake.id, decision: 'allow', caller: OWNER });
    assert(allowed.grant && allowed.grant.target_agent_id === quill.id && !allowed.runnable, '[flow_c_owner_allows_while_target_unavailable] grant persisted, request not runnable');
    expectCase('flow_c_owner_allows_while_target_unavailable', { wake: router.getWake(first.wake.id), request: engine.getWorkRequest(first.request.id), views: newViews(tankConv.id, before, { requestId: first.request.id }), auditBefore });

    // Revoked while waiting for the target: asks again.
    safety.revokeWakeGrant(allowed.grant.id, OWNER);
    availability.set('Quill', { available: true });
    auditBefore = eventTypes(first.request.id);
    before = viewIds(tankConv.id);
    const asked = router.retryWake(first.wake.id);
    expectCase('flow_c_grant_revoked_while_waiting_for_target_asks_again', { wake: asked.wake, request: engine.getWorkRequest(first.request.id), views: newViews(tankConv.id, before, { requestId: first.request.id }), auditBefore });

    // Allowed again, target still away, then it becomes available.
    availability.set('Quill', { available: false, reason: expectText(given.reason) });
    router.decideWakeGrant({ wakeId: first.wake.id, decision: 'allow', caller: OWNER });
    availability.set('Quill', { available: true });
    auditBefore = eventTypes(first.request.id);
    before = viewIds(tankConv.id);
    const recovered = router.retryWake(first.wake.id);
    expectCase('flow_c_target_becomes_available_after_allow', { wake: recovered.wake, request: engine.getWorkRequest(first.request.id), views: newViews(tankConv.id, before, { requestId: first.request.id }), auditBefore });

    // Deny while the target is unavailable.
    const quill2 = agent('Quill2', 'codex');
    availability.set('Quill2', { available: false, reason: 'Quill2 is not available: the Codex CLI is not installed.' });
    const second = reply(flowTurn, tank, block({ ...envelope, target: 'Quill2' })).routed[0];
    auditBefore = eventTypes(second.request.id);
    before = viewIds(tankConv.id);
    router.decideWakeGrant({ wakeId: second.wake.id, decision: 'deny', caller: OWNER });
    expectCase('flow_c_owner_denies_while_target_unavailable', { wake: router.getWake(second.wake.id), request: engine.getWorkRequest(second.request.id), views: newViews(tankConv.id, before, { requestId: second.request.id }), auditBefore });
    assert(safety.activeEditGrant(tank.id, quill2.id) === undefined, 'deny creates no grant');

    // Read-only Wake to an unlaunchable target blocks on availability.
    availability.set('Researcher', fixture('flow_c_readonly_wake_unlaunchable_target_blocks_on_availability').given.targetAvailability);
    before = viewIds(tankConv.id);
    const readonly = reply(flowTurn, tank, block(fixture('flow_c_readonly_wake_unlaunchable_target_blocks_on_availability').action.envelope)).routed[0];
    expectCase('flow_c_readonly_wake_unlaunchable_target_blocks_on_availability', { wake: readonly.wake, request: readonly.request, views: newViews(tankConv.id, before, { requestId: readonly.request.id }) });
    let notPending = null;
    try { router.decideWakeGrant({ wakeId: readonly.wake.id, decision: 'allow', caller: OWNER }); } catch (error) { notPending = error; }
    assert(notPending && notPending.code === 'not_pending', 'Allow / Deny are offered only while the reason is grant_required');
    availability.delete('Researcher');
  }

  // =====================================================================
  console.log('\nDepth, root budget, untracked lineage');
  {
    // Real chain: Tank (0) -> Helper (1) -> Reviewer (2) -> Codex (3) -> Researcher (4).
    const chainRoot = ownerMessage(tank, 'Deep chain.').requests[0];
    const hop1 = reply(chainRoot, tank, block({ version: 1, target: 'Helper', executionKind: 'conversation', objective: 'Hop 1.' })).routed[0].request;
    const hop2 = reply(hop1, helper, block({ version: 1, target: 'Reviewer', executionKind: 'conversation', objective: 'Hop 2.' })).routed[0].request;
    const hop3 = reply(hop2, reviewer, block({ version: 1, target: 'Codex', executionKind: 'conversation', objective: 'Hop 3.' })).routed[0].request;
    assert([hop1, hop2, hop3].map(r => r.wake_depth).join(',') === '1,2,3', 'wake depth counts Agent-to-Agent hops');
    const before = viewIds(tankConv.id);
    const deep = reply(hop3, codex, block(fixture('depth_limit_rejects_without_work').action.envelope));
    const deepWake = deep.routed[0].wake;
    expectCase('depth_limit_rejects_without_work', { wake: deepWake, request: deep.routed[0].request, views: newViews(tankConv.id, before, { wakeId: deepWake.id }) });
    // The hop's turn ends with that reply: the coordinator is told.
    engine.transitionWorkRequest(hop3.id, { from: 'queued', to: 'running' });
    engine.transitionWorkRequest(hop3.id, { from: 'running', to: 'completed', result: { reply_message_id: deep.message.id } });
    loop.continueAfterTerminal(hop3.id);
    const outcome = continuationKey('wakes', deep.message.id);
    assert(outcome && outcome.target_agent_id === codex.id && /deep \(limit 3\)/.test(outcome.intent), "[depth_limit_rejects_without_work] continuation 'wake_outcome'");
    const wakeView = projector.listConversationEvents(tankConv.id).find(v => v.wakeId === deepWake.id);
    const rejectedNotices = noticesFor(tankConv.id, deepWake.id);
    assert(rejectedNotices.length === 1 && rejectedNotices[0].tone === 'rejected' && !rejectedNotices[0].actionable, 'thread: a rejected Wake shows, with no actions');
    assert(wakeView.requestId === null && wakeView.engineEventId === null && wakeView.data.limit === 3 && wakeView.data.observed === 4, 'wake_rejected projects from the Wake row with limit and observed');

    // Budget: 12 Wake-created requests in one root, then refusal.
    const budgetRoot = ownerMessage(tank, 'Budget.').requests[0];
    const twelve = Array.from({ length: 12 }, (_, i) => block({ version: 1, target: 'Researcher', executionKind: 'conversation', objective: `Look ${i}.` })).join('\n');
    const filled = reply(budgetRoot, tank, twelve).routed;
    assert(filled.length === 12 && filled.every(entry => entry.wake.status === 'accepted'), 'twelve Wakes fill the root budget');
    assert(JSON.parse(filled[11].request.policy_snapshot).root_budget.used === 12 && JSON.parse(filled[11].request.policy_snapshot).root_budget.limit === 12, 'policy snapshot records root budget used/limit');
    const before2 = viewIds(tankConv.id);
    const over = reply(budgetRoot, tank, block({ ...fixture('root_budget_rejects_without_work').action.envelope, executionKind: 'conversation', resumeWorkRequest: undefined, target: 'Dev' }));
    expectCase('root_budget_rejects_without_work', { wake: over.routed[0].wake, request: over.routed[0].request, views: newViews(tankConv.id, before2, { wakeId: over.routed[0].wake.id }) });

    // The [Wake not started] continuation for refused Wakes.
    const coordinator = ownerMessage(tank, 'Refusal continuation.').requests[0];
    const refusal = messages.create(tankConv.id, 'bot', block({ version: 1, target: 'Researcher', executionKind: 'conversation', objective: 'x' }), tank.id);
    for (let i = 0; i < 12; i++) reply(coordinator, tank, block({ version: 1, target: 'Researcher', executionKind: 'conversation', objective: `Fill ${i}.` }));
    engine.transitionWorkRequest(coordinator.id, { from: 'queued', to: 'running' });
    engine.transitionWorkRequest(coordinator.id, { from: 'running', to: 'completed', result: { reply_message_id: refusal.id } });
    loop.continueAfterTerminal(coordinator.id);
    const refusedWake = router.listWakesForEvent(refusal.id)[0];
    const notice = continuationKey('wakes', refusal.id);
    assert(refusedWake.reason_code === 'root_budget_exhausted' && notice && notice.intent.startsWith('[Wake not started]'), "[root_budget_rejects_without_work] continuation 'wake_outcome' tells the coordinator");
    assert(notice.wake_depth === 0 && latest(notice.id).principal_type === 'engine' && latest(notice.id).decision === 'allowed', 'continuation: engine principal, depth of the Agent it continues');

    // Untracked lineage: recorded, never routed.
    const tracked = counts();
    const stray = messages.create(tankConv.id, 'bot', block(fixture('untracked_lineage_agent_message_does_not_route').action.envelope), tank.id);
    const before3 = viewIds(tankConv.id);
    const untracked = router.routeAgentWakes({ sourceEventId: stray.id });
    expectCase('untracked_lineage_agent_message_does_not_route', { wake: untracked[0].wake, request: untracked[0].request, views: newViews(tankConv.id, before3, { wakeId: untracked[0].wake.id }) });
    assert(counts().work_requests === tracked.work_requests && counts().wakes === tracked.wakes + 1, 'untracked lineage: one durable Wake row, no Work Request');
    let unknownSender = null;
    const humanMessage = messages.create(tankConv.id, 'user', block({ version: 1, target: 'Dev', executionKind: 'conversation', objective: 'x' }));
    const snapshot = counts();
    try { router.routeAgentWakes({ sourceEventId: humanMessage.id }); } catch (error) { unknownSender = error.code; }
    assert(unknownSender === 'invalid_input' && same(counts(), snapshot), 'a non-Agent sender is unknown: refused before persistence');
  }

  // =====================================================================
  console.log('\nRoot budget under concurrent routing (6 processes)');
  {
    const raceRoot = ownerMessage(tank, 'Race.').requests[0];
    const sources = Array.from({ length: 6 }, (_, i) => messages.create(tankConv.id, 'bot',
      Array.from({ length: 4 }, (_, j) => block({ version: 1, target: 'Researcher', executionKind: 'conversation', objective: `Race ${i}.${j}` })).join('\n'), tank.id).id);
    const startAt = Date.now() + 1500;
    const children = sources.map(source => new Promise(resolve => {
      const child = spawn(process.execPath, [__filename], {
        env: { ...process.env, WAKE_SAFETY_SCENARIO: 'race', WAKE_SAFETY_DB: DB_PATH, HOME_OVERRIDE: process.env.HOME, RACE_SOURCE: source, RACE_PARENT: raceRoot.id, RACE_START: String(startAt) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('close', status => resolve({ status, out }));
    }));
    const results = await Promise.all(children);
    assert(results.every(result => result.status === 0), `every routing process finished (${results.map(r => r.status).join(',')})`);
    for (const result of results) if (result.status !== 0) process.stdout.write(result.out);
    const created = raw.prepare('SELECT COUNT(*) AS n FROM work_requests WHERE root_request_id = ? AND wake_event_id IS NOT NULL').get(raceRoot.id).n;
    const statuses = raw.prepare(`SELECT status, reason_code, COUNT(*) AS n FROM wakes WHERE source_event_id IN (${sources.map(() => '?').join(',')}) GROUP BY status, reason_code`).all(...sources);
    const by = Object.fromEntries(statuses.map(row => [`${row.status}:${row.reason_code}`, row.n]));
    assert(created === 12, `exactly 12 Wake-created requests under concurrent routing (got ${created})`);
    assert(by['accepted:null'] === 12 && by['rejected:root_budget_exhausted'] === 12, `12 accepted, 12 refused root_budget_exhausted (got ${JSON.stringify(by)})`);

    console.log('  replay and duplicate delivery');
    const snapshot = counts();
    for (let i = 0; i < 3; i++) for (const source of sources) router.routeAgentWakes({ sourceEventId: source, parentRequestId: raceRoot.id });
    assert(same(counts(), snapshot), 'replaying every event three times writes nothing');
    const restarted = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, WAKE_SAFETY_SCENARIO: 'replay', WAKE_SAFETY_DB: DB_PATH, HOME_OVERRIDE: process.env.HOME, RACE_SOURCES: JSON.stringify(sources), RACE_PARENT: raceRoot.id },
      encoding: 'utf8',
    });
    process.stdout.write(restarted.stdout.split('\n').map(line => line && `  ${line}`).join('\n'));
    assert(restarted.status === 0 && same(counts(), snapshot), 'replay after a restart (fresh process) writes nothing');
    const extraTurn = engine.getWorkRequest(raceRoot.id);
    engine.transitionWorkRequest(extraTurn.id, { from: 'queued', to: 'running' });
    engine.transitionWorkRequest(extraTurn.id, { from: 'running', to: 'completed', result: { reply_message_id: sources[0] } });
    const beforeDelivery = counts();
    loop.continueAfterTerminal(raceRoot.id);
    const afterFirst = counts();
    const second = loop.continueAfterTerminal(raceRoot.id);
    assert(afterFirst.wakes === beforeDelivery.wakes && afterFirst.work_requests === beforeDelivery.work_requests
      + (router.listWakesForEvent(sources[0]).some(w => w.status === 'rejected') ? 1 : 0), 'terminal delivery replays the routed Wakes and adds at most the refusal continuation');
    assert(second.length === 0 && same(counts(), afterFirst), 'duplicate terminal delivery routes nothing again');
  }

  // =====================================================================
  console.log('\nConcurrency: capacity queues allowed work');
  {
    raw.prepare('DELETE FROM dispatch_leases').run();
    let clock = 10_000_000_000_000;
    const now = () => clock;
    const worker = dispatcherLib.createDispatcher(raw, engine, { owner: 'capacity-worker', now, config: { maxGlobal: 4, maxPerTarget: 1 } });
    // Everything queued so far is out of scope for this controlled run.
    const scope = new Set();
    const pool = ['P1', 'P2', 'P3', 'P4', 'P5'].map(name => agent(name, 'codex'));
    const queued = pool.map(target => ownerMessage(target, `work for ${target.name}`).requests[0]);
    const sameTarget = ownerMessage(pool[0], 'second job for P1').requests[0];
    for (const request of [...queued, sameTarget]) scope.add(request.id);
    const restoreParked = parkQueued([...scope]);
    const claimAll = () => worker.claimNext(raw.prepare(
      `SELECT id FROM work_requests WHERE state = 'queued' AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC, rowid ASC`
    ).all(JSON.stringify([...scope])).map(row => row.id));
    const leases = [];
    for (let i = 0; i < 4; i++) {
      const claimed = claimAll();
      if (claimed.ok) leases.push(claimed.lease);
    }
    assert(leases.length === 4 && leases.map(l => l.requestId).join(',') === queued.slice(0, 4).map(r => r.id).join(','), 'four oldest requests on four targets run');
    const fifth = claimAll();
    assert(!fifth.ok && fifth.reason === 'global_limit', 'the fifth waits for a global slot');
    assert(engine.getWorkRequest(queued[4].id).state === 'queued' && eventTypes(queued[4].id).includes('dispatch_deferred'), 'waiting request stays queued with a durable deferral');
    const waitingView = projector.listConversationEvents(conversations.getByBotId(pool[4].id).id).find(v => v.requestId === queued[4].id && v.kind === 'request_queued' && v.data.waiting_for === 'capacity');
    assert(!!waitingView && waitingView.text === 'Queued: waiting for capacity', 'projection shows request_queued waiting for capacity');
    worker.release(leases.shift(), 'completed');
    const afterRelease = claimAll();
    assert(afterRelease.ok && afterRelease.lease.requestId === queued[4].id, 'a released slot admits the oldest waiting request (P1 second job still waits on its target)');
    leases.push(afterRelease.lease);
    assert(engine.getWorkRequest(sameTarget.id).state === 'queued', 'the second P1 job waits');
    // P1's first job is released; its second job may now run.
    const target = claimAll();
    assert(!target.ok && target.reason === 'global_limit', 'still at the global limit');
    worker.release(leases.shift(), 'completed');
    const p1Second = worker.claim(sameTarget.id);
    assert(p1Second.ok, 'the per-target slot frees and the second job runs');
    leases.push(p1Second.lease);
    assert([...scope].every(id => engine.getWorkRequest(id).state === 'running' || engine.getWorkRequest(id).state === 'queued')
      && [...scope].every(id => engine.getWorkRequest(id).error_code === null) && [...scope].every(id => engine.getWorkRequest(id).attempt_count <= 1), 'no allowed request was lost, failed, or claimed twice');

    // Per-target fixture: a review to a target already running.
    for (const lease of leases.splice(0)) worker.release(lease, 'completed');
    const reviewerJob = ownerMessage(reviewer, 'busy').requests[0];
    const busy = worker.claim(reviewerJob.id);
    const capTurn = ownerMessage(tank, 'Capacity fixture.').requests[0];
    const before = viewIds(tankConv.id);
    const capWake = reply(capTurn, tank, block(fixture('per_target_capacity_queues_not_denies').action.envelope)).routed[0];
    const capClaim = worker.claim(capWake.request.id);
    assert(busy.ok && !capClaim.ok && capClaim.reason === 'target_limit', 'per-target limit defers the Wake-created request');
    expectCase('per_target_capacity_queues_not_denies', { wake: capWake.wake, request: engine.getWorkRequest(capWake.request.id), views: newViews(tankConv.id, before, { requestId: capWake.request.id }) });
    worker.release(busy.lease, 'completed');

    // Global fixture: four running elsewhere.
    const others = ['G1', 'G2', 'G3', 'G4'].map(name => agent(name, 'codex')).map(t => ownerMessage(t, 'fill').requests[0]);
    const globalLeases = others.map(r => claimAlone(worker, r.id)).filter(c => c.ok).map(c => c.lease);
    const before2 = viewIds(tankConv.id);
    const globalWake = reply(capTurn, tank, block(fixture('global_capacity_queues_not_denies').action.envelope)).routed[0];
    const globalClaim = worker.claim(globalWake.request.id);
    assert(globalLeases.length === 4 && !globalClaim.ok && globalClaim.reason === 'global_limit', 'global limit defers the Wake-created request');
    expectCase('global_capacity_queues_not_denies', { wake: globalWake.wake, request: engine.getWorkRequest(globalWake.request.id), views: newViews(tankConv.id, before2, { requestId: globalWake.request.id }) });
    globalLeases.forEach(lease => worker.release(lease, 'completed'));
    const finally_ = claimAlone(worker, globalWake.request.id);
    assert(finally_.ok, 'once capacity frees, the queued Wake runs');
    worker.release(finally_.lease, 'completed');
    clock += 1;
    restoreParked();
  }

  // =====================================================================
  console.log('\nConcurrency: FIFO admission across direct claims');
  {
    raw.prepare('DELETE FROM dispatch_leases').run();
    const restoreParked = parkQueued([]);
    const one = dispatcherLib.createDispatcher(raw, engine, { owner: 'fifo-worker', config: { maxGlobal: 1, maxPerTarget: 1 } });
    const [f1, f2, f3] = ['F1', 'F2', 'F3'].map(name => agent(name, 'codex'));
    const first = ownerMessage(f1, 'first').requests[0];
    const held = one.claim(first.id);
    const older = ownerMessage(f2, 'older waiting').requests[0];
    const olderRefused = one.claim(older.id);
    assert(held.ok && !olderRefused.ok && olderRefused.reason === 'global_limit', 'the global slot is taken; the older request waits');
    one.release(held.lease, 'completed');
    const younger = ownerMessage(f3, 'younger, on a free target').requests[0];
    const jump = one.claim(younger.id);
    const deferral = engine.listEvents(younger.id).filter(e => e.type === 'dispatch_deferred').map(e => JSON.parse(e.data)).pop();
    assert(!jump.ok && jump.reason === 'older_waiting' && jump.blockedBy === older.id && engine.getWorkRequest(younger.id).state === 'queued'
      && attempts(younger.id) === 0 && deferral && deferral.reason === 'older_waiting' && deferral.waiting_behind === older.id,
    'a direct claim of a newer request cannot take the free slot from older waiting work (durable older_waiting deferral, no Attempt)');
    const next = one.claimNext([younger.id, older.id]);
    assert(next.ok && next.lease.requestId === older.id, 'the freed slot goes to the oldest waiting request');
    one.release(next.lease, 'completed');
    const later = one.claim(younger.id);
    assert(later.ok && engine.getWorkRequest(younger.id).attempt_count === 1, 'the younger request runs next, not lost or failed');
    one.release(later.lease, 'completed');

    // A busy target does not block other targets.
    const wide = dispatcherLib.createDispatcher(raw, engine, { owner: 'fifo-wide', config: { maxGlobal: 4, maxPerTarget: 1 } });
    const running = ownerMessage(f1, 'running on F1').requests[0];
    const runningLease = wide.claim(running.id);
    const behindBusy = ownerMessage(f1, 'second for F1').requests[0];
    const busyRefused = wide.claim(behindBusy.id);
    const otherTarget = ownerMessage(f2, 'F2 work').requests[0];
    const otherClaim = wide.claim(otherTarget.id);
    assert(runningLease.ok && !busyRefused.ok && busyRefused.reason === 'target_limit' && otherClaim.ok,
      'an older request whose target is busy does not hold back a request on a free target');
    for (const lease of [runningLease.lease, otherClaim.lease]) wide.release(lease, 'completed');
    const resumed = wide.claim(behindBusy.id);
    assert(resumed.ok, 'the per-target waiter runs once its target frees');
    wide.release(resumed.lease, 'completed');
    restoreParked();
  }

  // =====================================================================
  console.log('\nContinuation cap stops the lineage');
  {
    const capRoot = ownerMessage(tank, 'Loop forever.').requests[0];
    const specialist = reply(capRoot, tank, block({ version: 1, target: 'Researcher', executionKind: 'conversation', objective: 'Once.' })).routed[0].request;
    const ask = messages.create(tankConv.id, 'user', 'filler');
    for (let i = 0; i < 24; i++) {
      engine.createOrGetWorkRequest({
        sourceConversationId: tankConv.id, sourceEventId: ask.id, requester: loop.ENGINE_REQUESTER, targetAgentId: tank.id,
        intent: 'filler', executionKind: 'conversation', toolProfile: 'readonly', idempotencyKey: `filler-${i}`, parentRequestId: capRoot.id,
        policy: { source: 'coordinator_continuation', continues: 'wake_outcome', work_requests: [] },
      });
    }
    complete(specialist, researcher, 'Found it.');
    const before = viewIds(tankConv.id);
    const next = loop.continueAfterTerminal(specialist.id);
    const views = newViews(tankConv.id, before, { requestId: specialist.id }).filter(view => view.kind === 'lineage_stopped');
    expectCase('continuation_cap_stops_lineage', { request: null, views, continuation: continuationKey('result', specialist.id) });
    assert(next.length === 0 && eventTypes(specialist.id).filter(t => t === 'lineage_stopped').length === 1, 'lineage_stopped recorded once; nothing continued');
  }

  router.setWakeAvailabilityProbe(null);
  const missed = fixtures.cases.map(entry => entry.name).filter(name => !exercised.has(name));
  assert(missed.length === 0, `every safety fixture case is exercised (missing: ${missed.join(', ') || 'none'})`);

  // =====================================================================
  console.log('\nMigration of a schema-12 database');
  const legacyDb = path.join(os.tmpdir(), `botmancers-wake-safety-legacy-${process.pid}.db`);
  const legacy = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, WAKE_SAFETY_SCENARIO: 'legacy', WAKE_SAFETY_DB: legacyDb },
    encoding: 'utf8',
  });
  process.stdout.write(legacy.stdout.split('\n').map(line => line && `  ${line}`).join('\n'));
  if (legacy.stderr) process.stderr.write(legacy.stderr);
  assert(legacy.status === 0, `legacy migration scenario passed (status ${legacy.status})`);
  removeDb(legacyDb);

  removeDb(DB_PATH);
  finish();
}

// ---------------------------------------------------------------------
// One routing process of the race: waits for the shared start time, then
// routes its reply on the shared root.
function runRaceChild() {
  const db = jiti('./lib/db.ts');
  const router = jiti('./lib/wake-router.ts');
  router.setWakeAvailabilityProbe(() => ({ available: true }));
  const startAt = Number(process.env.RACE_START);
  while (Date.now() < startAt) { /* barrier */ }
  const routed = router.routeAgentWakes({ sourceEventId: process.env.RACE_SOURCE, parentRequestId: process.env.RACE_PARENT });
  void db;
  console.log(`routed ${routed.length}: ${routed.map(entry => entry.wake.status).join(',')}`);
  process.exit(0);
}

function runReplayChild() {
  jiti('./lib/db.ts');
  const router = jiti('./lib/wake-router.ts');
  router.setWakeAvailabilityProbe(() => ({ available: true }));
  const sources = JSON.parse(process.env.RACE_SOURCES);
  const fresh = sources.flatMap(source => router.routeAgentWakes({ sourceEventId: source, parentRequestId: process.env.RACE_PARENT })).filter(entry => entry.created);
  assert(fresh.length === 0, 'restarted process: every replayed Wake already recorded');
  finish();
}

// ---------------------------------------------------------------------
// A database exactly as the previous release (engine schema 12) left it,
// opened by this release.
function runLegacy() {
  const Database = require('better-sqlite3');
  const store = jiti('./lib/engine-store.ts');
  const legacy = new Database(DB_PATH);
  // As the app's shared connection: foreign keys enforced by triggers only.
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE group_members (group_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (group_id, bot_id));
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, bot_id TEXT, group_id TEXT, created_at INTEGER NOT NULL, origin_kind TEXT, origin_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL, sender_kind TEXT, request_id TEXT);
    CREATE TABLE processing_queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_kind TEXT NOT NULL, participant_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, participant_kind, participant_id));
  `);
  store.migrateEngineSchema(legacy, { through: 12 });
  const t = 1_700_000_000_000;
  const bot = legacy.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, NULL, ?)');
  bot.run('bot-tank', 'Tank', 'Coordinator', 'd', t);
  bot.run('bot-dev', 'Dev', 'Developer', 'd', t + 1);
  legacy.prepare("INSERT INTO conversations VALUES ('conv-tank', 'bot', 'bot-tank', NULL, ?, NULL, NULL)").run(t);
  legacy.prepare("INSERT INTO conversations VALUES ('conv-api', 'agent', NULL, NULL, ?, 'service', 'ci-bot')").run(t);
  const msg = legacy.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  msg.run('m-ask', 'conv-tank', 'user', null, 'Build it.', t + 10, 'person');
  msg.run('m-tank', 'conv-tank', 'bot', 'bot-tank', 'Waking Dev.', t + 20, 'bot');
  msg.run('m-dev', 'conv-tank', 'bot', 'bot-dev', 'Done.', t + 30, 'bot');
  msg.run('m-api', 'conv-api', 'user', 'ci-bot', 'Lint.', t + 40, 'service');
  const policy = value => JSON.stringify(value);
  const request = legacy.prepare(`
    INSERT INTO work_requests (id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id, intent, execution_kind,
      tool_profile, parent_request_id, root_request_id, wake_event_id, depth, idempotency_key, request_hash, policy_snapshot, state, state_reason,
      result, version, created_at, updated_at, terminal_at, retry_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'h', ?, ?, ?, ?, 0, ?, ?, ?, '{"max_attempts":1}')
  `);
  // r0: completed owner turn. r1: running implementation Wake (accepted
  // before the upgrade, no grant). r2: completed conversation Wake. c2: its
  // queued result continuation. r3: blocked edit Wake. a1: queued API turn.
  request.run('r0', 'conv-tank', 'm-ask', 'person', 'local-owner', 'bot-tank', 'Build it.', 'conversation', 'readonly', null, 'r0', null, 0, 'ui-1',
    policy({ source: 'conversation_intake', surface: 'ui', tool_profile: 'readonly' }), 'completed', null, policy({ reply_message_id: 'm-tank' }), t + 10, t + 20, t + 20);
  request.run('r1', 'conv-tank', 'm-tank', 'bot', 'bot-tank', 'bot-dev', 'Implement.', 'implementation', 'edit', 'r0', 'r0', 'w1', 1, 'wake-1',
    policy({ source: 'wake', tool_profile: 'edit', return_to: { agent_id: 'bot-tank', conversation_id: 'conv-tank' } }), 'running', null, null, t + 21, t + 22, null);
  request.run('r2', 'conv-tank', 'm-tank', 'bot', 'bot-tank', 'bot-dev', 'Explain.', 'conversation', 'readonly', 'r0', 'r0', 'w2', 1, 'wake-2',
    policy({ source: 'wake', tool_profile: 'readonly', return_to: { agent_id: 'bot-tank', conversation_id: 'conv-tank' } }), 'completed', null, policy({ reply_message_id: 'm-dev' }), t + 21, t + 30, t + 30);
  request.run('c2', 'conv-tank', 'm-dev', 'service', 'botmancers-engine', 'bot-tank', '[Work Request result]', 'conversation', 'readonly', 'r2', 'r0', null, 2, 'continuation:v1:result:r2',
    policy({ source: 'coordinator_continuation', continues: 'result', tool_profile: 'readonly' }), 'queued', null, null, t + 31, t + 31, null);
  request.run('r3', 'conv-tank', 'm-tank', 'bot', 'bot-tank', 'bot-dev', 'Implement more.', 'implementation', 'edit', 'r0', 'r0', 'w3', 1, 'wake-3',
    policy({ source: 'wake', tool_profile: 'edit', return_to: { agent_id: 'bot-tank', conversation_id: 'conv-tank' } }), 'blocked', 'target_unavailable: Dev is restarting.', null, t + 21, t + 21, null);
  request.run('a1', 'conv-api', 'm-api', 'service', 'ci-bot', 'bot-dev', 'Lint.', 'conversation', 'readonly', null, 'a1', null, 0, 'api-1',
    policy({ source: 'conversation_intake', surface: 'api', tool_profile: 'readonly' }), 'queued', null, null, t + 40, t + 40, null);
  // u1: a row whose parent is gone (written around the FK trigger).
  const fk = legacy.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_work_requests_fk_insert'").get().sql;
  legacy.exec('DROP TRIGGER trg_work_requests_fk_insert');
  request.run('u1', 'conv-tank', 'm-ask', 'bot', 'bot-dev', 'bot-tank', 'Orphan.', 'conversation', 'readonly', 'gone', 'gone', null, 3, 'orphan-1',
    policy({ source: 'wake', tool_profile: 'readonly' }), 'queued', null, null, t + 50, t + 50, null);
  // Rows whose immediate parent and declared root exist but whose deeper
  // chain does not resolve: u2 -> u3 -> (missing), the cycle y1 <-> y2,
  // and x1 declaring root a1 while its chain ends at r0.
  const broken = (id, parent, root, at) => request.run(id, 'conv-tank', 'm-tank', 'bot', 'bot-tank', 'bot-dev', `Broken ${id}.`, 'conversation', 'readonly',
    parent, root, null, 1, `broken-${id}`, policy({ source: 'wake', tool_profile: 'readonly' }), 'cancelled', 'test', null, at, at, at);
  broken('u3', 'gone', 'r0', t + 51);
  broken('u2', 'u3', 'r0', t + 52);
  broken('y1', 'y2', 'r0', t + 53);
  broken('y2', 'y1', 'r0', t + 54);
  broken('x1', 'r2', 'a1', t + 55);
  legacy.exec(fk);
  const wake = legacy.prepare(`
    INSERT INTO wakes (id, idempotency_key, source_conversation_id, source_event_id, position, syntax, payload, requester_agent_id, requested_target,
      target_agent_id, target_name_snapshot, execution_kind, parent_request_id, root_request_id, root_wake_id, depth, status, reason_code, reason,
      work_request_id, created_at, updated_at)
    VALUES (?, ?, 'conv-tank', 'm-tank', ?, 'structured', ?, 'bot-tank', 'Dev', 'bot-dev', 'Dev', ?, 'r0', 'r0', ?, 1, ?, ?, ?, ?, ?, ?)
  `);
  const payload = (kind, objective) => JSON.stringify({ envelope: { executionKind: kind, objective, target: 'Dev', version: 1 }, syntax: 'structured' });
  wake.run('w1', 'k1', 0, payload('implementation', 'Implement.'), 'implementation', 'w1', 'accepted', null, null, 'r1', t + 21, t + 21);
  wake.run('w2', 'k2', 1, payload('conversation', 'Explain.'), 'conversation', 'w2', 'accepted', null, null, 'r2', t + 21, t + 21);
  wake.run('w3', 'k3', 2, payload('implementation', 'Implement more.'), 'implementation', 'w3', 'blocked', 'target_unavailable', 'Dev is restarting.', 'r3', t + 21, t + 21);
  legacy.prepare(`INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at) VALUES ('e-r0', 'r0', 1, NULL, 'accepted', '{"state":"queued"}', ?)`).run(t + 10);
  legacy.prepare(`INSERT INTO conversation_events (id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id, kind, state, text, data, sort_at, request_created_at, created_at)
    VALUES ('e-r0:0', 'conv-tank', 'e-r0', 0, 'r0', 1, NULL, NULL, 'request_queued', 'queued', 'Queued', '{}', ?, ?, ?)`).run(t + 10, t + 10, t + 10);
  const before = legacy.prepare('SELECT * FROM work_requests ORDER BY id').all();
  const version = legacy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  legacy.close();
  assert(version === 12 && before.length === 12, 'legacy fixture: schema 12 with twelve requests');

  // Upgrade: this release opens the database.
  const db = jiti('./lib/db.ts');
  const raw = db.default;
  const router = jiti('./lib/wake-router.ts');
  const dispatcherLib = jiti('./lib/dispatcher.ts');
  const { engine } = db;
  assert(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v === 13, 'migrated to schema 13');
  assert(raw.prepare('SELECT COUNT(*) AS n FROM wake_grants').get().n === 0, 'no grants are seeded from history');
  const after = Object.fromEntries(raw.prepare('SELECT * FROM work_requests ORDER BY id').all().map(row => [row.id, row]));
  const unchanged = ['state', 'policy_snapshot', 'request_hash', 'depth', 'state_reason', 'result', 'version', 'terminal_at'];
  assert(before.every(row => unchanged.every(key => after[row.id][key] === row[key])), 'existing request identity, state, policy, and history are unchanged');
  const depths = Object.fromEntries(Object.values(after).map(row => [row.id, row.wake_depth]));
  assert(JSON.stringify(depths) === JSON.stringify({ a1: 0, c2: 0, r0: 0, r1: 1, r2: 1, r3: 1, u1: 0, u2: 0, u3: 0, x1: 0, y1: 0, y2: 0 }), `wake depth backfilled from lineage (${JSON.stringify(depths)})`);
  const principal = id => `${after[id].root_principal_kind}:${after[id].root_principal_id}`;
  assert(['r0', 'r1', 'r2', 'c2', 'r3'].every(id => principal(id) === 'person:local-owner') && principal('a1') === 'service:ci-bot' && principal('u1') === 'unknown:unknown',
    'root principal from the root requester; unresolvable rows are unknown');
  assert(['u2', 'u3', 'y1', 'y2', 'x1'].every(id => principal(id) === 'unknown:unknown'),
    'a missing ancestor, a parent cycle, or a chain ending outside the declared root resolves to depth 0 and root principal unknown');
  const migrated = Object.fromEntries(raw.prepare('SELECT * FROM wake_safety_decisions').all().map(row => [row.request_id, row]));
  assert(Object.keys(migrated).sort().join(',') === 'a1,c2,r1,u1', 'only runnable requests (queued, running, waiting) get a migration decision');
  assert(migrated.r1.principal_type === 'agent_principal' && migrated.c2.principal_type === 'engine' && migrated.a1.principal_type === 'api_principal'
    && Object.values(migrated).every(row => row.decision === 'allowed' && row.grant_rule === 'pre_safety_migration'), 'in-flight work keeps running under a pre_safety_migration decision');
  assert(raw.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE id = 'e-r0:0'").get().n === 1, 'projected history is kept');
  let terminalGuard = false;
  try { raw.prepare("UPDATE work_requests SET state_reason = 'x' WHERE id = 'r0'").run(); } catch { terminalGuard = true; }
  assert(terminalGuard, 'terminal requests are immutable again after the backfill');

  const worker = dispatcherLib.createDispatcher(raw, engine, { owner: 'legacy-worker' });
  const c2 = worker.claim('c2');
  assert(c2.ok, 'a pre-upgrade queued continuation still launches');
  worker.release(c2.lease, 'test');
  router.setWakeAvailabilityProbe(() => ({ available: true }));
  const recovered = router.retryWake('w3');
  assert(recovered.wake.status === 'blocked' && recovered.wake.reason_code === 'grant_required' && engine.getWorkRequest('r3').state === 'blocked',
    'a pre-upgrade blocked edit Wake goes through the new grant check on recovery');
  const second = spawnSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_DB_PATH = ${JSON.stringify(DB_PATH)}; process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti'); const jiti = createJiti(${JSON.stringify(__filename)}, { alias: { '@': ${JSON.stringify(ROOT)} } });
    const raw = jiti('./lib/db.ts').default;
    process.stdout.write(String(raw.prepare('SELECT COUNT(*) AS n FROM wake_safety_decisions').get().n));
  `], { encoding: 'utf8', env: process.env });
  assert(second.status === 0 && Number(second.stdout) === raw.prepare('SELECT COUNT(*) AS n FROM wake_safety_decisions').get().n, 'reopening applies nothing again');
  finish();
}
