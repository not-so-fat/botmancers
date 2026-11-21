#!/usr/bin/env node
// NOT-496: the Agent session catalog (lib/session-catalog) and its owner
// routes (GET /api/bots/:id/sessions, GET /api/bots/:id/sessions/:ref).
// Proves: summaries derive from the canonical session_bindings plus the
// Conversation, Work Request, Attempts, and stored launch snapshot (no
// parallel table); active/released maps to active/ended; newest-activity
// ordering is deterministic; active|ended|all filtering; unknown Agents and
// unknown or foreign references are 404; external provider session ids
// never appear in normal JSON, only behind the labeled debug parameter.
// The routes run behind the real owner boundary (proxy.ts) on loopback.
// NOT-503: native sessions from a fake direct provider share the catalog;
// availability, lifecycle, provider resumability, and busy are independent
// (released, archived, missing, resumable combinations), on the owner
// routes and the service API, without disclosing provider ids.
// Self-contained: isolated SQLite file, no network.
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const DB_PATH = path.join(os.tmpdir(), `botmancers-session-catalog-${process.pid}.db`);
function removeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
// NOT-507: the session list probes an Agent's runtime; never this machine's codex.
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const catalog = jiti('../lib/session-catalog.ts');
const { startRouteHost } = require('./support/acceptance/route-host');
const { BASE, MIN, EXTERNAL_IDS, seedSessionCatalog } = require('./support/session-catalog-fixture');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const leaks = text => Object.values(EXTERNAL_IDS).filter(id => text.includes(id));

async function main() {
  const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  const fixture = seedSessionCatalog(dbModule);
  const { dev, scout } = fixture.agents;
  const { implementation, replaced, direct, directNext, group, requestOnly, conversationOnly, other } = fixture.bindings;

  console.log('\nRead model over canonical session_bindings');
  const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  assert(JSON.stringify(tablesBefore) === JSON.stringify(tablesAfter), 'the catalog adds no table (no parallel session-identity store)');
  const all = catalog.listAgentSessions(db, dev.id, 'all');
  const canonical = db.prepare('SELECT id FROM session_bindings WHERE agent_id = ? ORDER BY id').all(dev.id).map(row => row.id);
  assert(JSON.stringify(all.map(s => s.ref).sort()) === JSON.stringify(canonical), 'every canonical binding of the Agent is listed once, by its binding id');
  assert(all.every(s => s.ref !== other.id), 'another Agent\'s binding is not listed');
  assert(JSON.stringify(all.map(s => s.ref)) === JSON.stringify([implementation.id, requestOnly.id, group.id, conversationOnly.id, directNext.id, direct.id, replaced.id]),
    'newest activity first; equal activity breaks by newest binding');
  const byRef = Object.fromEntries(all.map(s => [s.ref, s]));
  const impl = byRef[implementation.id];
  assert(impl.status === 'active' && impl.ended_at === null && impl.resumable === true, 'an unreleased implementation binding is active and resumable');
  assert(impl.last_activity_at === BASE + 64 * MIN, 'last activity includes the Attempt that resumed the binding');
  assert(impl.title === 'Add the session catalog read model', 'title is the owning Work Request\'s first intent line');
  assert(impl.agent.name === 'Dev' && impl.agent.adapter === 'codex' && impl.agent.transport === 'agent-deck', 'agent identity, adapter, and transport from the launch snapshot');
  assert(impl.origin.conversation.label === 'Tank thread' && impl.origin.conversation.thread_agent_id === fixture.agents.tank.id
    && impl.origin.conversation.kind === 'direct', 'origin conversation is the coordinator thread it came from');
  assert(impl.origin.work_request.id === fixture.requests.implementation.id && impl.origin.work_request.execution_kind === 'implementation'
    && impl.origin.work_request.state === 'completed', 'origin Work Request reference, kind, and state');
  assert(impl.context.workspace === '/Users/owner/work/botmancers' && !('deck' in impl.context), 'workspace comes from the stored launch snapshot; no deck in the read shape');
  const ended = byRef[replaced.id];
  assert(ended.status === 'ended' && ended.ended_at === BASE + 20 * MIN && ended.resumable === false, 'a released binding is ended, with its release time, and not resumable');
  assert(byRef[group.id].title === 'Shared · Design review' && byRef[group.id].origin.conversation.kind === 'group'
    && byRef[group.id].origin.conversation.thread_agent_id === null && byRef[group.id].resumable === false, 'a group binding is titled from its group and has no thread link');
  assert(byRef[direct.id].title === 'Dev · 2026-10-15 09:05 UTC', 'no Work Request or group: <Agent name> · <created date/time>');
  assert(byRef[directNext.id].context.workspace === null && !('deck' in byRef[directNext.id].context), 'no launch snapshot: no invented workspace, no deck key');
  const reqOnly = byRef[requestOnly.id];
  assert(reqOnly.title === 'Explain the session binding lifecycle' && reqOnly.origin.work_request.id === fixture.requests.ask.id
    && reqOnly.origin.conversation.id === fixture.conversations.devConv.id && reqOnly.origin.conversation.label === 'Dev thread'
    && reqOnly.origin.conversation.thread_agent_id === dev.id, 'a request-only binding derives its conversation from the Work Request\'s source conversation');
  assert(reqOnly.status === 'active' && reqOnly.last_activity_at === BASE + 46 * MIN && reqOnly.context.workspace === null,
    'a request-only binding without a source Attempt invents no launch context');
  const convOnly = byRef[conversationOnly.id];
  assert(convOnly.title === 'Summarize the open review threads' && convOnly.origin.work_request.id === fixture.requests.summary.id
    && convOnly.origin.work_request.execution_kind === 'review' && convOnly.origin.conversation.label === 'Tank thread',
    'a conversation-only binding derives its Work Request and title from its source Attempt');
  assert(convOnly.context.workspace === '/Users/owner/work/botmancers' && !('deck' in convOnly.context) && convOnly.agent.transport === 'agent-deck'
    && convOnly.last_activity_at === BASE + 36 * MIN && convOnly.resumable === false, 'a conversation-only binding carries its source Attempt\'s launch context and activity (no deck)');
  assert(JSON.stringify(catalog.listAgentSessions(db, dev.id, 'active').map(s => s.ref)) === JSON.stringify([implementation.id, requestOnly.id, group.id, conversationOnly.id, directNext.id]), 'active filter');
  assert(JSON.stringify(catalog.listAgentSessions(db, dev.id, 'ended').map(s => s.ref)) === JSON.stringify([direct.id, replaced.id]), 'ended filter');
  assert(leaks(JSON.stringify(all)).length === 0, 'summaries carry no external provider session id');
  const detail = catalog.getAgentSession(db, dev.id, implementation.id);
  assert(detail.attempts.length === 2 && detail.attempts[0].role === 'source' && detail.attempts[1].role === 'resume'
    && detail.attempts[1].kind === 'resume', 'detail lists the source Attempt and the Attempt that resumed it');
  assert(catalog.getAgentSession(db, dev.id, other.id) === undefined, 'detail of another Agent\'s binding is undefined');

  console.log('\nResumable matches the revision resume lookup (sparse scopes, runtime change)');
  // A separate Agent so the shared fixture's counts stay fixed. It
  // dispatches claude today; its implementation ran and bound under claude.
  const { engine, bots, conversations } = dbModule;
  const sparse = bots.create({ name: 'Sparse', title: 'Implementer', description: 'Edge cases', agent: 'claude', deck_id: 'deck-builder' });
  const sparseConv = conversations.getByBotId(sparse.id);
  const { request: sparseImpl } = engine.createOrGetWorkRequest({
    sourceConversationId: sparseConv.id, sourceEventId: 'sparse-msg-1', requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: sparse.id, intent: 'Sparse implementation', executionKind: 'implementation', toolProfile: 'edit',
    idempotencyKey: 'sparse-1', now: BASE + 70 * MIN,
  });
  engine.transitionWorkRequest(sparseImpl.id, { from: 'queued', to: 'running', now: BASE + 70 * MIN });
  const sparseAttempt = engine.createAttempt(sparseImpl.id, { kind: 'launch', adapter: 'claude', toolProfile: 'edit', launchSnapshot: {}, now: BASE + 70 * MIN });
  const bind = (fields, at) => engine.bindSession({ agentId: sparse.id, externalSessionId: `sparse-secret-${at}`, now: BASE + at * MIN, ...fields });
  const fullScope = bind({ adapter: 'claude', conversationId: sparseConv.id, requestId: sparseImpl.id, sourceAttemptId: sparseAttempt.id }, 71);
  const reqOnlyImpl = bind({ adapter: 'claude', requestId: sparseImpl.id }, 72);
  const convOnlyImpl = bind({ adapter: 'claude', conversationId: sparseConv.id, sourceAttemptId: sparseAttempt.id }, 73);
  const staleRuntime = bind({ adapter: 'codex', conversationId: sparseConv.id, requestId: sparseImpl.id }, 74);
  const sparseRows = Object.fromEntries(catalog.listAgentSessions(db, sparse.id, 'all').map(s => [s.ref, s]));
  assert(sparseRows[fullScope.id].resumable === true, 'an implementation binding scoped to its request and conversation under the current adapter is resumable');
  assert(sparseRows[reqOnlyImpl.id].status === 'active' && sparseRows[reqOnlyImpl.id].origin.work_request.execution_kind === 'implementation'
    && sparseRows[reqOnlyImpl.id].resumable === false, 'a request-only implementation binding is not resumable (the lookup also matches the conversation)');
  assert(sparseRows[convOnlyImpl.id].status === 'active' && sparseRows[convOnlyImpl.id].origin.work_request.id === sparseImpl.id
    && sparseRows[convOnlyImpl.id].resumable === false, 'a conversation-only binding deriving an implementation through its source Attempt is not resumable');
  assert(sparseRows[staleRuntime.id].status === 'active' && sparseRows[staleRuntime.id].resumable === false,
    'an active binding under an adapter the Agent no longer dispatches is not resumable');
  // Parity: resumable is true for exactly the binding resumeBindingFor's
  // getActiveSessionBinding call would return, for every listed session.
  const lookups = [dev, scout, sparse].flatMap(agent => catalog.listAgentSessions(db, agent.id, 'all').map(s => {
    const req = s.origin.work_request && engine.getWorkRequest(s.origin.work_request.id);
    const bot = bots.getById(agent.id);
    const found = req && ['implementation', 'revision'].includes(req.execution_kind) && req.target_agent_id === agent.id
      ? engine.getActiveSessionBinding({ agentId: agent.id, adapter: bot.agent, conversationId: req.source_conversation_id, requestId: req.id })
      : undefined;
    return s.resumable === (found?.id === s.ref);
  }));
  assert(lookups.length === 12 && lookups.every(Boolean), 'resumable agrees with the revision resume lookup for every session');

  console.log('\nOwner routes on loopback (real proxy.ts)');
  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const list = await host.owner('GET', `/api/bots/${dev.id}/sessions`);
    assert(list.status === 200 && list.json.status === 'all' && list.json.sessions.length === 7, 'GET /api/bots/:id/sessions defaults to all');
    assert(JSON.stringify(list.json.sessions.map(s => s.ref)) === JSON.stringify(all.map(s => s.ref)), 'route order matches the read model');
    assert(leaks(list.text).length === 0 && !list.text.includes('external_session_id'), 'list JSON omits external_session_id');
    const active = await host.owner('GET', `/api/bots/${dev.id}/sessions?status=active`);
    assert(active.status === 200 && active.json.sessions.every(s => s.status === 'active') && active.json.sessions.length === 5, '?status=active');
    const endedList = await host.owner('GET', `/api/bots/${dev.id}/sessions?status=ended`);
    assert(endedList.status === 200 && endedList.json.sessions.every(s => s.status === 'ended') && endedList.json.sessions.length === 2, '?status=ended');
    assert((await host.owner('GET', `/api/bots/${dev.id}/sessions?status=released`)).status === 400, 'an unknown status filter is 400');
    const scoutList = await host.owner('GET', `/api/bots/${scout.id}/sessions`);
    assert(scoutList.status === 200 && scoutList.json.sessions.length === 1 && scoutList.json.sessions[0].ref === other.id, 'the second Agent sees only its own session');
    assert((await host.owner('GET', '/api/bots/no-such-agent/sessions')).status === 404, 'unknown Agent list is 404');

    const one = await host.owner('GET', `/api/bots/${dev.id}/sessions/${implementation.id}`);
    assert(one.status === 200 && one.json.session.ref === implementation.id && one.json.session.attempts.length === 2, 'GET /api/bots/:id/sessions/:ref');
    assert(leaks(one.text).length === 0 && !one.text.includes('external_session_id') && one.json.debug === undefined, 'detail JSON omits external_session_id');
    const foreign = await host.owner('GET', `/api/bots/${dev.id}/sessions/${other.id}`);
    const unknown = await host.owner('GET', `/api/bots/${dev.id}/sessions/no-such-session`);
    assert(foreign.status === 404 && unknown.status === 404 && foreign.text === unknown.text, 'another Agent\'s reference is 404, indistinguishable from an unknown one');
    assert(leaks(foreign.text).length === 0, 'a foreign reference discloses nothing');
    assert((await host.owner('GET', `/api/bots/no-such-agent/sessions/${implementation.id}`)).status === 404, 'unknown Agent detail is 404');
    const debug = await host.owner('GET', `/api/bots/${dev.id}/sessions/${implementation.id}?debug=external_session_id`);
    assert(debug.status === 200 && debug.json.debug.external_session_id === EXTERNAL_IDS.implementation, 'only the explicit debug parameter returns the provider session id');
    const foreignDebug = await host.owner('GET', `/api/bots/${dev.id}/sessions/${other.id}?debug=external_session_id`);
    assert(foreignDebug.status === 404 && leaks(foreignDebug.text).length === 0, 'the debug parameter never crosses Agents');
    const remote = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: host.port, path: `/api/bots/${dev.id}/sessions`, headers: { host: 'botmancers.example' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert(remote === 403, 'a non-loopback host is refused by the owner boundary');
  } finally {
    await host.close();
  }

  console.log('\nNOT-503: native sessions and independent state');
  // A separate Agent on its own runtime connection with a fake direct
  // provider, so the fixture's Dev/Scout counts above stay fixed.
  const contract = jiti('../lib/session-provider.ts');
  const ps = jiti('../lib/provider-sessions.ts');
  const fake = require('./support/fake-session-provider');
  const statePath = path.join(os.tmpdir(), `botmancers-session-catalog-provider-${process.pid}.json`);
  fs.rmSync(statePath, { force: true });
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex native', host: 'This computer' });
  contract.registerSessionProvider({ connectionId: connection.id }, () => fake.createFakeSessionProvider({ statePath }));
  const nat = bots.create({
    name: 'Native', title: 'Implementer', description: 'Native sessions', agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const natConv = conversations.getByBotId(nat.id);
  // A released binding whose provider still resumes it, and its active
  // replacement no provider has synced yet.
  const releasedBinding = engine.bindSession({ agentId: nat.id, adapter: 'codex', externalSessionId: 'prov-released-SECRET', conversationId: natConv.id, now: BASE + 80 * MIN });
  const activeBinding = engine.bindSession({ agentId: nat.id, adapter: 'codex', externalSessionId: 'prov-active-SECRET', conversationId: natConv.id, now: BASE + 81 * MIN });
  fake.seedFakeProvider(statePath, [
    { id: 'prov-released-SECRET', title: 'Released but resumable', workspace: '/work/n', resumable: true },
    { id: 'prov-archived-SECRET', title: 'Archived but resumable', workspace: '/work/n', lifecycle: 'archived', resumable: true },
    { id: 'prov-gone-SECRET', title: 'Gone later', workspace: '/work/n', resumable: true },
    { id: 'prov-stuck-SECRET', title: 'Never resumable', workspace: '/work/n', resumable: false },
    { id: 'prov-busy-SECRET', title: 'Busy now', workspace: '/work/n', resumable: true },
  ]);
  let natCursor = null;
  do natCursor = (await ps.syncAgentSessions(db, nat.id, { cursor: natCursor })).next_cursor; while (natCursor);
  const refOf = id => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(nat.id, id).id;
  const archivedRef = refOf('prov-archived-SECRET');
  const goneRef = refOf('prov-gone-SECRET');
  const stuckRef = refOf('prov-stuck-SECRET');
  const busyRef = refOf('prov-busy-SECRET');
  assert(refOf('prov-released-SECRET') === releasedBinding.id, 'a discovered session matching a binding keeps the binding\'s reference');
  fake.mutateFakeProvider(statePath, state => { state.sessions['prov-gone-SECRET'].deleted = true; });
  await ps.refreshProviderSession(db, nat.id, goneRef);
  const busyTurn = await ps.sendProviderTurn(db, nat.id, busyRef, { prompt: '[hold] keep working', authority: 'read_only', idempotencyKey: 'busy-1', requester: { kind: 'person', id: 'local-owner' } });
  const natRows = Object.fromEntries(catalog.listAgentSessions(db, nat.id, 'all').map(s => [s.ref, s]));
  const rel = natRows[releasedBinding.id];
  assert(rel.source === 'botmancers' && rel.status === 'ended' && rel.resumable === false && rel.state.resumable === true
    && rel.state.availability === 'available' && rel.state.synced_at !== null, 'released + provider-resumable: ended, not engine-resumable, provider resumable');
  const act = natRows[activeBinding.id];
  assert(act.source === 'botmancers' && act.status === 'active' && act.state.resumable === null && act.state.synced_at === null && act.state.lifecycle === 'open',
    'active binding never synced: provider resumability unknown (null), not guessed');
  const arc = natRows[archivedRef];
  assert(arc.source === 'native' && arc.status === 'ended' && arc.state.lifecycle === 'archived' && arc.state.resumable === true && arc.resumable === false
    && arc.ended_at !== null, 'archived + resumable: ended by lifecycle, still resumable by its provider');
  assert(natRows[goneRef].state.availability === 'missing' && natRows[goneRef].status === 'active', 'missing is its own fact: listed, open, availability missing');
  assert(natRows[stuckRef].state.resumable === false && natRows[stuckRef].state.availability === 'available', 'available but not resumable');
  assert(natRows[busyRef].state.busy === true && Object.values(natRows).filter(s => s.state.busy).length === 1, 'busy only where a turn is in flight');
  assert(Object.keys(natRows).length === 6 && natRows[archivedRef].title === 'Archived but resumable' && natRows[archivedRef].context.workspace === '/work/n'
    && !('deck' in natRows[archivedRef].context) && natRows[archivedRef].origin.work_request === null, 'native rows carry provider title and workspace, no Deck or origin');
  assert(JSON.stringify(catalog.listAgentSessions(db, nat.id, 'ended').map(s => s.ref).sort()) === JSON.stringify([releasedBinding.id, archivedRef].sort()),
    'the ended filter takes released bindings and archived native sessions');
  const natLeaks = text => /SECRET/.test(text);
  assert(!natLeaks(JSON.stringify(natRows)), 'no provider id in any native or bound summary');
  const host2 = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const natList = await host2.owner('GET', `/api/bots/${nat.id}/sessions`);
    assert(natList.status === 200 && natList.json.sessions.length === 6 && !natLeaks(natList.text) && !natList.text.includes('external_session_id'),
      'GET /api/bots/:id/sessions lists native and bound sessions without provider ids');
    assert(natList.json.sessions.every(s => s.state && typeof s.state.busy === 'boolean' && ['available', 'missing'].includes(s.state.availability)),
      'route rows carry the independent state');
    const natActive = await host2.owner('GET', `/api/bots/${nat.id}/sessions?status=active`);
    assert(natActive.status === 200 && natActive.json.sessions.length === 4, '?status=active excludes released and archived');
    const natOne = await host2.owner('GET', `/api/bots/${nat.id}/sessions/${archivedRef}`);
    assert(natOne.status === 200 && natOne.json.session.ref === archivedRef && natOne.json.session.source === 'native'
      && JSON.stringify(natOne.json.session.attempts) === '[]' && !natLeaks(natOne.text), 'GET /api/bots/:id/sessions/:ref for a native reference');
    const natDebug = await host2.owner('GET', `/api/bots/${nat.id}/sessions/${archivedRef}?debug=external_session_id`);
    assert(natDebug.status === 200 && natDebug.json.debug.external_session_id === 'prov-archived-SECRET', 'the debug disclosure covers native sessions');
    const natForeign = await host2.owner('GET', `/api/bots/${dev.id}/sessions/${archivedRef}`);
    assert(natForeign.status === 404 && !natLeaks(natForeign.text), 'a native reference under another Agent is 404');
  } finally {
    await host2.close();
  }
  // The service API view is additive and redacted; its message path refuses
  // a native reference without disclosing anything.
  const serviceApi = jiti('../lib/service-api.ts');
  const ctx = serviceApi.serviceContext({ kind: 'service', id: 'svc-native' });
  const servicePage = serviceApi.listServiceSessions(ctx, nat.id, { cursor: null, limit: 2, status: 'all' });
  const servicePage2 = serviceApi.listServiceSessions(ctx, nat.id, { cursor: servicePage.next_cursor, limit: 10, status: 'all' });
  assert(servicePage.items.length === 2 && servicePage2.items.length === 4 && servicePage.items.every(item => item.state && item.source),
    'service sessions paginate across native and bound sessions with additive source/state');
  assert(!natLeaks(JSON.stringify([servicePage, servicePage2])) && servicePage.items.every(item => !('context' in item)), 'service views stay redacted');
  let serviceError = null;
  try { serviceApi.sendServiceSessionMessage(ctx, archivedRef, { content: 'hi', idempotencyKey: 'n-1' }); } catch (error) { serviceError = error; }
  assert(serviceError && serviceError.code === 'session_not_resumable', 'a session message to a native reference is session_not_resumable');
  await ps.cancelProviderTurn(db, nat.id, busyTurn.turn.turn_ref);
  contract.clearSessionProviders({ builtins: true });
  fs.rmSync(statePath, { force: true });

  console.log('\nSessions UI source contract');
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const page = read('app/page.tsx');
  const panel = read('app/components/SessionsPanel.tsx');
  const sessionsPage = read('app/agents/[id]/sessions/page.tsx');
  const bar = page.slice(page.indexOf('className="thread-bar"'), page.indexOf('{avatarStep ?'));
  assert(/href=\{\`\/agents\/\$\{encodeURIComponent\(activeConversation\.details\.id\)\}\/sessions\`\}[\s\S]*?>\s*Sessions\s*<\/Link>/.test(bar),
    'the selected-Agent thread header links to the full Sessions page');
  assert(/<SessionsPanel/.test(sessionsPage) && /agentId=\{id\}/.test(sessionsPage), 'the Sessions route is scoped to the selected Agent under the shared shell');
  assert(!/sessions-drawer|sessionsOpen|onCardKeyDown/.test(panel + page) && !/role="dialog"|aria-modal="true"/.test(panel),
    'the normal Sessions flow has no modal drawer or drawer focus trap');
  assert(/Loading sessions…/.test(panel) && /role="alert"/.test(panel) && /Retry/.test(panel) && /emptySessionsCopy\(/.test(panel), 'loading, error (with retry), and empty states');
  assert(/statusLabel\(row\)/.test(panel) && /is-\$\{row\.status\}/.test(panel) && /aria-pressed=\{filter === option\.value\}/.test(panel), 'active/ended state per row and an active|ended|all filter');
  assert(/sessionConversationHref\(conversation\)/.test(panel) && /thread_agent_id[\s\S]*?\/conversations/.test(read('lib/session-view.ts')) && /Last activity/.test(panel) && /Origin/.test(panel),
    'detail shows last activity and an Agent-scoped Conversations origin link');
  assert(/sessionOriginChips\(row\)/.test(panel), 'collapsed provenance chips come from canonical metadata');
  // NOT-548: the drawer gained a title search box. It stays the only
  // text input: nothing here takes a raw session id.
  const pageInputTags = panel.match(/<input\b[\s\S]*?\/>/gi) ?? [];
  assert(!/<textarea|contentEditable/i.test(panel) && pageInputTags.length === 1
    && /type="search"/.test(pageInputTags[0]) && /aria-label="Search sessions by title"/.test(pageInputTags[0]),
    'no raw ID entry: the Sessions page\'s only text input is the title search box');
  const externalMentions = panel.split('\n').filter(line => /external_session_id/.test(line));
  assert(externalMentions.length === 2 && externalMentions.every(line => /debug/.test(line)), 'the provider session id is read only by the debug disclosure');
  assert(/<summary>Local debug: provider session ID<\/summary>/.test(panel) && /navigator\.clipboard\.writeText/.test(panel), 'the debug disclosure is explicitly labeled and has a Copy action');
  const view = jiti('../lib/session-view.ts');
  const sample = all.find(s => s.ref === implementation.id);
  assert(view.runtimeLabel(sample) === 'codex · agent-deck' && view.workRequestLabel(sample) === 'Implementation · completed'
    && view.statusLabel(byRef[replaced.id]) === 'Ended', 'row labels for runtime, origin request, and state');
  assert(view.formatSessionDate(BASE + 5 * MIN) === '2026-10-15 09:05 UTC' && byRef[direct.id].title.endsWith(view.formatSessionDate(direct.created_at)),
    'page times use the same UTC clock as the fallback title');
  assert(/no active sessions/.test(view.emptySessionsCopy('active', 'Dev')) && /no ended sessions/.test(view.emptySessionsCopy('ended', 'Dev')), 'empty copy follows the filter');

  console.log('\nDocumentation contract');
  const core = read('docs/core-engine.md');
  const bridge = read('docs/mcp-bridge.md');
  assert(/### Session catalog/.test(core) && /Botmancers reference/.test(core) && /GET \/api\/bots\/:id\/sessions\?status=active\|ended\|all/.test(core),
    'docs/core-engine.md documents the safe session-reference contract and routes');
  assert(/Local debug: provider session ID/.test(core) && /\?debug=external_session_id/.test(core), 'docs/core-engine.md documents the debug-only external-id exception');
  assert(/Responses never include external run or\s+session ids/.test(bridge) && /the bridge never proxies it/.test(bridge),
    'docs/mcp-bridge.md keeps its non-disclosure contract and excludes the Sessions view');
  // NOT-499: /api/v0 reaches the catalog only through the grant-gated
  // service API (lib/service-api). NOT-500: so does the MCP bridge's v2
  // contract, through the same audited service operations.
  const v0SessionRoutes = ['app/api/v0/sessions/[ref]/messages/route.ts', 'app/api/v0/agents/[agentId]/sessions/route.ts', 'app/api/v0/agents/[agentId]/sessions/[ref]/route.ts'];
  assert(!/session-catalog/.test(read('lib/mcp-bridge.ts')) && !/session-catalog/.test(read('lib/mcp-bridge-v2.ts'))
    && /from '\.\/service-api-http'/.test(read('lib/mcp-bridge-v2.ts'))
    && v0SessionRoutes.every(file => /from '@\/lib\/service-api-http'/.test(read(file)) && !/session-catalog/.test(read(file))),
  'the MCP bridge reaches sessions only through the grant-gated service API, as /api/v0 does');

  removeDb();
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session catalog checks passed.');
}

main().catch(error => {
  console.error(error);
  removeDb();
  process.exit(1);
});
