#!/usr/bin/env node
// NOT-544: registration syncs past-session history for every provider that
// can list (lib/provider-sessions syncHistoryAtRegistration, called by
// POST /api/bots without branching on the provider name).
// Proves: for each provider kind (claude, codex, cursor, muse) a fake
// provider with 3 sessions and an Agent registered with
// all_provider_sessions leaves 3 provider_sessions rows and a non-empty
// session catalog; a provider without `list` leaves 0 rows and reports
// outcome 'unsupported' without calling the provider; Hermes (no session
// provider) is skipped the same way; a provider whose listing throws
// reports outcome 'failed' while the Agent stays registered; a
// `workspaces` scope imports only in-scope sessions and reports the rest
// in rejected_out_of_scope; a provider that reports list=false until
// ready() resolves is probed first and still syncs (Codex-shaped); a
// ready refusal of unsupported stays unsupported while any other ready
// failure is failed with its error_code. Discovery stays read-only.
// Self-contained: isolated SQLite and state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const TAG = process.env.NOT544_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-registration-sync-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
// No transport may reach the network: every fetch is counted and refused.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const catalog = jiti('../lib/session-catalog.ts');
const reg = jiti('../lib/agent-registration.ts');
const botsRoute = jiti('../app/api/bots/route.ts');
const sessionsRoute = jiti('../app/api/bots/[id]/sessions/route.ts');
const fake = require('./support/fake-session-provider');

const db = dbModule.default;
const { bots, runtimeConnections } = dbModule;
// Never touch a real runtime: only per-connection fakes below.
contract.clearSessionProviders({ builtins: true });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const sessionRows = agentId => count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', agentId);
const READ_ONLY = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };

function jsonRequest(url, method, body) {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function registerAgent(body) {
  const res = await botsRoute.POST(jsonRequest('http://localhost:43123/api/bots', 'POST', body));
  return { status: res.status, json: await res.json() };
}
async function listSessions(agentId) {
  const res = await sessionsRoute.GET(
    new Request(`http://localhost:43123/api/bots/${agentId}/sessions`),
    { params: Promise.resolve({ id: agentId }) },
  );
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log('\nEvery list-capable provider syncs history at registration');
  const kinds = ['claude', 'codex', 'cursor', 'muse'];
  const byKind = {};
  for (const kind of kinds) {
    const statePath = path.join(TMP, `${kind}.json`);
    fake.seedFakeProvider(statePath, [
      { id: `${kind}-s1-SECRET`, title: `${kind} session one`, workspace: '/work/alpha/one' },
      { id: `${kind}-s2-SECRET`, title: `${kind} session two`, workspace: '/work/alpha/two' },
      { id: `${kind}-s3-SECRET`, title: `${kind} session three`, workspace: '/work/alpha/three' },
    ]);
    const connectionId = runtimeConnections.create({ provider: kind, label: `${kind} test`, host: 'Test' }).id;
    contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath, kind: `fake-${kind}` }));
    const created = await registerAgent({
      name: `RegSync ${kind}`, runtime_connection_id: connectionId,
      session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
    });
    byKind[kind] = { connectionId, statePath, agentId: created.json && created.json.id };
    assert(created.status === 200 && created.json.agent === kind, `${kind}: Agent registers on its runtime connection`);
    assert(sessionRows(byKind[kind].agentId) === 3, `${kind}: 3 past sessions imported at registration`);
    assert(catalog.listAgentSessions(db, byKind[kind].agentId, 'all').length === 3, `${kind}: session catalog is not empty`);
  }

  console.log('\nSessions route serves the imported history (exit predicate)');
  const codexList = await listSessions(byKind.codex.agentId);
  assert(codexList.status === 200 && Array.isArray(codexList.json.sessions) && codexList.json.sessions.length === 3,
    'GET /api/bots/<codex id>/sessions returns the 3 imported sessions');

  console.log('\nHelper reports the sync outcome directly');
  const directConn = runtimeConnections.create({ provider: 'codex', label: 'codex direct', host: 'Test' }).id;
  const directState = path.join(TMP, 'direct.json');
  fake.seedFakeProvider(directState, [
    { id: 'direct-s1-SECRET', title: 'One', workspace: '/work/alpha' },
    { id: 'direct-s2-SECRET', title: 'Two', workspace: '/work/alpha' },
    { id: 'direct-s3-SECRET', title: 'Three', workspace: '/work/alpha' },
  ]);
  contract.registerSessionProvider({ connectionId: directConn }, () => fake.createFakeSessionProvider({ statePath: directState }));
  const direct = bots.create({
    name: 'RegSync direct', title: '', description: '', agent: 'codex', runtime_connection_id: directConn,
    session_scope_kind: 'all_provider_sessions', session_scope_items: JSON.stringify([]),
    policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const directResult = await ps.syncHistoryAtRegistration(db, direct.id);
  assert(directResult.outcome === 'synced' && directResult.imported === 3
    && directResult.rejected_out_of_scope === 0 && directResult.complete === true && !('error_code' in directResult),
    `syncHistoryAtRegistration returns a synced outcome (${JSON.stringify(directResult)})`);
  assert(sessionRows(direct.id) === 3, 'direct helper call leaves 3 rows');

  console.log('\nProviders without list are skipped without error');
  const limitedConn = runtimeConnections.create({ provider: 'codex', label: 'codex no-list', host: 'Test' }).id;
  const limitedState = path.join(TMP, 'limited.json');
  fake.seedFakeProvider(limitedState, [
    { id: 'limited-s1-SECRET', title: 'One', workspace: '/work/alpha' },
    { id: 'limited-s2-SECRET', title: 'Two', workspace: '/work/alpha' },
    { id: 'limited-s3-SECRET', title: 'Three', workspace: '/work/alpha' },
  ]);
  contract.registerSessionProvider({ connectionId: limitedConn }, () => fake.createFakeSessionProvider({
    statePath: limitedState, kind: 'fake-no-list',
    capabilities: { list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: ['read_only'] },
  }));
  const limited = await registerAgent({
    name: 'RegSync no-list', runtime_connection_id: limitedConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(limited.status === 200, 'registration on a no-list provider still succeeds');
  assert(sessionRows(limited.json.id) === 0, 'a provider without list leaves 0 rows');
  const limitedResult = await ps.syncHistoryAtRegistration(db, limited.json.id);
  assert(limitedResult.outcome === 'unsupported' && limitedResult.imported === 0 && limitedResult.rejected_out_of_scope === 0,
    `no-list provider returns outcome unsupported (${JSON.stringify(limitedResult)})`);
  assert(fake.providerCalls(limitedState) === 0, 'the no-list provider received no call at all');

  console.log('\nA provider that learns list only once ready is probed first');
  const lazyConn = runtimeConnections.create({ provider: 'codex', label: 'codex lazy-list', host: 'Test' }).id;
  const lazyState = path.join(TMP, 'lazy.json');
  fake.seedFakeProvider(lazyState, [
    { id: 'lazy-s1-SECRET', title: 'One', workspace: '/work/alpha' },
    { id: 'lazy-s2-SECRET', title: 'Two', workspace: '/work/alpha' },
    { id: 'lazy-s3-SECRET', title: 'Three', workspace: '/work/alpha' },
  ]);
  // Codex-shaped: capabilities report list=false until ready() resolves.
  const lazyInner = fake.createFakeSessionProvider({ statePath: lazyState, kind: 'fake-lazy-list' });
  let lazyReadyCalls = 0;
  let lazyProbed = false;
  contract.registerSessionProvider({ connectionId: lazyConn }, () => ({
    ...lazyInner,
    capabilities: () => ({ ...lazyInner.capabilities(), list: lazyProbed }),
    async ready() { lazyReadyCalls++; lazyProbed = true; return { ok: true, value: undefined }; },
  }));
  const lazy = await registerAgent({
    name: 'RegSync lazy-list', runtime_connection_id: lazyConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(lazy.status === 200, 'registration on a lazy-list provider succeeds');
  assert(lazyReadyCalls > 0, 'registration probed readiness before judging list');
  assert(lazy.status === 200 && sessionRows(lazy.json.id) === 3, 'lazy-list provider imports 3 sessions after its probe');
  if (lazy.status === 200) {
    const lazyResult = await ps.syncHistoryAtRegistration(db, lazy.json.id);
    assert(lazyResult.outcome === 'synced' && lazyResult.imported === 0,
      `lazy-list provider reports synced on re-sync (${JSON.stringify(lazyResult)})`);
  }

  console.log('\nReady failures map to unsupported or failed');
  const unsupportedReadyConn = runtimeConnections.create({ provider: 'codex', label: 'codex unsupported-ready', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: unsupportedReadyConn }, () => ({
    kind: 'fake-unsupported-ready',
    capabilities: () => ({ list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async ready() { return { ok: false, error: { code: 'unsupported', message: 'no thread/list' } }; },
    async listSessions() { throw new Error('must not be called'); },
  }));
  const unsupportedReady = await registerAgent({
    name: 'RegSync unsupported-ready', runtime_connection_id: unsupportedReadyConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(unsupportedReady.status === 200, 'registration succeeds when ready reports unsupported');
  assert(unsupportedReady.status === 200 && sessionRows(unsupportedReady.json.id) === 0, 'unsupported ready leaves 0 rows');
  if (unsupportedReady.status === 200) {
    const unsupportedReadyResult = await ps.syncHistoryAtRegistration(db, unsupportedReady.json.id);
    assert(unsupportedReadyResult.outcome === 'unsupported',
      `unsupported ready returns outcome unsupported (${JSON.stringify(unsupportedReadyResult)})`);
  }
  const unavailableReadyConn = runtimeConnections.create({ provider: 'codex', label: 'codex unavailable-ready', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: unavailableReadyConn }, () => ({
    kind: 'fake-unavailable-ready',
    capabilities: () => ({ list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async ready() { return { ok: false, error: { code: 'unavailable', message: 'app-server down' } }; },
    async listSessions() { throw new Error('must not be called'); },
  }));
  const unavailableReady = await registerAgent({
    name: 'RegSync unavailable-ready', runtime_connection_id: unavailableReadyConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(unavailableReady.status === 200, 'registration succeeds when ready reports unavailable');
  assert(unavailableReady.status === 200 && bots.getById(unavailableReady.json.id) !== undefined, 'the Agent stays registered after an unavailable ready');
  if (unavailableReady.status === 200) {
    const unavailableReadyResult = await ps.syncHistoryAtRegistration(db, unavailableReady.json.id);
    assert(unavailableReadyResult.outcome === 'failed' && unavailableReadyResult.error_code === 'provider_unavailable',
      `unavailable ready returns outcome failed with its error_code (${JSON.stringify(unavailableReadyResult)})`);
  }

  console.log('\nHermes (no session provider) is skipped without error');
  const hermes = await registerAgent({
    name: 'RegSync hermes', runtime_connection_id: reg.localConnectionId('hermes'),
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(hermes.status === 200, 'Hermes Agent still registers');
  assert(hermes.status === 200 && sessionRows(hermes.json.id) === 0, 'Hermes leaves 0 provider_sessions rows');
  if (hermes.status === 200) {
    const hermesResult = await ps.syncHistoryAtRegistration(db, hermes.json.id);
    assert(hermesResult.outcome === 'unsupported', `Hermes returns outcome unsupported (${JSON.stringify(hermesResult)})`);
  }

  console.log('\nA listing failure never rolls back the registration');
  const throwingConn = runtimeConnections.create({ provider: 'codex', label: 'codex throwing', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: throwingConn }, () => ({
    kind: 'fake-throwing',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions() { throw new Error('boom'); },
  }));
  const throwing = await registerAgent({
    name: 'RegSync throwing', runtime_connection_id: throwingConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(throwing.status === 200, 'registration succeeds even when the listing throws');
  assert(throwing.status === 200 && bots.getById(throwing.json.id) !== undefined, 'the Agent stays registered after a listing failure');
  assert(throwing.status === 200 && sessionRows(throwing.json.id) === 0, 'a failed listing leaves 0 rows');
  if (throwing.status === 200) {
    const failedResult = await ps.syncHistoryAtRegistration(db, throwing.json.id);
    assert(failedResult.outcome === 'failed' && typeof failedResult.error_code === 'string',
      `a throwing provider returns outcome failed (${JSON.stringify(failedResult)})`);
    assert(bots.getById(throwing.json.id) !== undefined, 'the Agent is still registered after the failed sync');
  }

  console.log('\nWorkspace scope imports only what is in scope');
  const scopedConn = runtimeConnections.create({ provider: 'codex', label: 'codex scoped', host: 'Test' }).id;
  const scopedState = path.join(TMP, 'scoped.json');
  fake.seedFakeProvider(scopedState, [
    { id: 'scoped-in-1-SECRET', title: 'In one', workspace: '/work/alpha/one' },
    { id: 'scoped-in-2-SECRET', title: 'In two', workspace: '/work/alpha/two' },
    { id: 'scoped-out-1-SECRET', title: 'Out', workspace: '/work/beta/other' },
  ]);
  // ignoreScope: the provider returns everything so Botmancers' own scope
  // check (and its rejected count) is exercised.
  contract.registerSessionProvider({ connectionId: scopedConn },
    () => fake.createFakeSessionProvider({ statePath: scopedState, ignoreScope: true }));
  const scoped = await registerAgent({
    name: 'RegSync scoped', runtime_connection_id: scopedConn,
    session_scope: { kind: 'workspaces', workspaces: ['/work/alpha'] }, policy: READ_ONLY,
  });
  assert(scoped.status === 200, 'scoped Agent registers');
  assert(scoped.status === 200 && sessionRows(scoped.json.id) === 2, 'workspaces scope imports only the 2 in-scope sessions');
  const scopedSecond = bots.create({
    name: 'RegSync scoped direct', title: '', description: '', agent: 'codex', runtime_connection_id: scopedConn,
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify(['/work/alpha']),
    policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const scopedResult = await ps.syncHistoryAtRegistration(db, scopedSecond.id);
  assert(scopedResult.outcome === 'synced' && scopedResult.imported === 2 && scopedResult.rejected_out_of_scope === 1,
    `out-of-scope sessions are reported, not stored (${JSON.stringify(scopedResult)})`);
  assert(sessionRows(scopedSecond.id) === 2, 'direct scoped sync leaves 2 rows');
  assert(count("SELECT COUNT(*) AS n FROM provider_sessions WHERE provider_session_id = 'scoped-out-1-SECRET'") === 0,
    'the out-of-scope session is never stored');

  console.log('\nRead-only discovery');
  for (const kind of kinds) {
    const ops = fake.loadFakeState(byKind[kind].statePath).calls.map(call => call.op);
    assert(ops.length > 0 && ops.every(op => op === 'listSessions'), `${kind}: registration only listed sessions (${ops.join(',') || 'none'})`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  assert(fetchCalls === 0, 'no network call during registration sync');
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll registration session sync checks passed.');
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
