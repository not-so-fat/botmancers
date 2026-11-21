#!/usr/bin/env node
// NOT-545: the session catalog stays fresh without re-registration (the
// server's sync loop in lib/session-sync-refresh, started from
// instrumentation.ts, plus the owner's POST /api/bots/:id/sessions/sync).
// Proves: a fake provider gains a session after registration and (a) one
// loop tick imports it, (b) POST .../sessions/sync imports it immediately;
// a second concurrent call gets 409 sync_in_progress while the first is in
// flight; the loop skips an Agent with a sync in flight; interval 0 runs
// no timers; one Agent whose listing throws does not stop another Agent's
// sync; a sync never calls startSession or sendTurn on the provider; GET
// .../sessions reports the newest last_synced_at as top-level synced_at
// (null when the Agent has no rows); unknown Agents are 404; the loop
// leaves no open handle (stopping clears the timer and this process exits
// on its own: no forced process.exit anywhere below).
// Self-contained: isolated SQLite and state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const TAG = process.env.NOT545_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-sync-refresh-${TAG}`);
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
const refresh = jiti('../lib/session-sync-refresh.ts');
const botsRoute = jiti('../app/api/bots/route.ts');
const sessionsRoute = jiti('../app/api/bots/[id]/sessions/route.ts');
const syncRoute = jiti('../app/api/bots/[id]/sessions/sync/route.ts');
const boundary = jiti('../lib/owner-boundary.ts');
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const READ_ONLY = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };
const QUIET = { log: () => {} };

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
async function postSync(agentId) {
  const res = await syncRoute.POST(
    new Request(`http://localhost:43123/api/bots/${agentId}/sessions/sync`, { method: 'POST' }),
    { params: Promise.resolve({ id: agentId }) },
  );
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log('\nRegistration still imports the history (baseline)');
  const alphaState = path.join(TMP, 'alpha.json');
  fake.seedFakeProvider(alphaState, [
    { id: 'alpha-one-SECRET', title: 'Alpha one', workspace: '/work/alpha/one' },
  ]);
  const alphaConn = runtimeConnections.create({ provider: 'codex', label: 'alpha', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: alphaConn }, () => fake.createFakeSessionProvider({ statePath: alphaState }));
  const alpha = await registerAgent({
    name: 'SyncRefresh alpha', runtime_connection_id: alphaConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const alphaId = alpha.json && alpha.json.id;
  assert(alpha.status === 200 && sessionRows(alphaId) === 1, 'alpha registers with its 1 past session imported');

  console.log('\n(a) One loop tick imports a session created after registration');
  fake.seedFakeProvider(alphaState, [
    { id: 'alpha-two-SECRET', title: 'Alpha two arrives late', workspace: '/work/alpha/two' },
  ]);
  const before = await listSessions(alphaId);
  assert(before.status === 200 && before.json.sessions.length === 1, 'the late session is not in the catalog before the tick');
  const tick = await refresh.runSessionSyncTick(db, QUIET);
  assert(tick.synced.includes(alphaId) && sessionRows(alphaId) === 2, 'one loop tick imports the late session');
  const after = await listSessions(alphaId);
  assert(after.status === 200 && after.json.sessions.length === 2
    && after.json.sessions.some(s => s.title === 'Alpha two arrives late'),
    'GET /api/bots/<id>/sessions lists the late session by title (exit predicate)');
  assert(typeof after.json.synced_at === 'number' && after.json.synced_at > 0,
    `GET reports a top-level synced_at (${JSON.stringify(after.json.synced_at)})`);
  const newest = db.prepare('SELECT MAX(last_synced_at) AS n FROM provider_sessions WHERE agent_id = ?').get(alphaId).n;
  assert(after.json.synced_at === newest, 'synced_at is the newest last_synced_at of the Agent rows');

  console.log('\n(b) POST .../sessions/sync imports immediately');
  fake.seedFakeProvider(alphaState, [
    { id: 'alpha-three-SECRET', title: 'Alpha three on demand', workspace: '/work/alpha/three' },
  ]);
  const manual = await postSync(alphaId);
  assert(manual.status === 200 && Array.isArray(manual.json.imported) && manual.json.imported.length === 1,
    `manual sync imports the new session (${JSON.stringify({ imported: manual.json.imported, updated: manual.json.updated })})`);
  assert(manual.json.rejected_out_of_scope === 0 && manual.json.complete === true
    && typeof manual.json.synced_at === 'number',
    `manual sync returns rejected_out_of_scope, complete, synced_at (${JSON.stringify(manual.json)})`);
  const afterManual = await listSessions(alphaId);
  assert(afterManual.json.sessions.length === 3
    && afterManual.json.sessions.some(s => s.title === 'Alpha three on demand'),
    'the on-demand session is listed right after the sync route is called');

  console.log('\nA second concurrent sync gets 409 sync_in_progress');
  const bravoState = path.join(TMP, 'bravo.json');
  fake.seedFakeProvider(bravoState, [
    { id: 'bravo-one-SECRET', title: 'Bravo one', workspace: '/work/bravo/one' },
  ]);
  const bravoConn = runtimeConnections.create({ provider: 'codex', label: 'bravo', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: bravoConn }, () => fake.createFakeSessionProvider({ statePath: bravoState }));
  const bravo = await registerAgent({
    name: 'SyncRefresh bravo', runtime_connection_id: bravoConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const bravoId = bravo.json && bravo.json.id;
  assert(bravo.status === 200 && sessionRows(bravoId) === 1, 'bravo registers with its past session imported');
  // A listing that stays in flight until released.
  const bravoInner = fake.createFakeSessionProvider({ statePath: bravoState });
  let entered = false;
  let releaseGate = () => {};
  const gate = new Promise(resolve => { releaseGate = resolve; });
  contract.registerSessionProvider({ connectionId: bravoConn }, () => ({
    ...bravoInner,
    async listSessions(input) { entered = true; await gate; return bravoInner.listSessions(input); },
  }));
  fake.seedFakeProvider(bravoState, [
    { id: 'bravo-two-SECRET', title: 'Bravo two gated', workspace: '/work/bravo/two' },
  ]);
  const first = postSync(bravoId);
  for (let i = 0; i < 400 && !entered; i++) await sleep(5);
  assert(entered, 'the first sync reached the provider and is in flight');
  assert(refresh.isAgentSyncing(bravoId), 'the guard reports bravo as syncing while the first call runs');
  const second = await postSync(bravoId);
  assert(second.status === 409 && second.json.error && second.json.error.code === 'sync_in_progress',
    `a second concurrent call gets 409 sync_in_progress (${second.status} ${JSON.stringify(second.json.error)})`);
  releaseGate();
  const firstDone = await first;
  assert(firstDone.status === 200 && firstDone.json.imported.length === 1, 'the first sync completes once released');
  assert(!refresh.isAgentSyncing(bravoId), 'the guard is released after the sync finishes');
  assert(sessionRows(bravoId) === 2, 'the gated session was imported exactly once');

  console.log('\nThe loop skips an Agent with a sync in flight');
  const alphaCalls = fake.providerCalls(alphaState);
  assert(refresh.tryBeginAgentSync(alphaId), 'test holds alpha sync guard');
  const skippedTick = await refresh.runSessionSyncTick(db, QUIET);
  assert(skippedTick.skipped_inflight.includes(alphaId), 'the tick reports alpha as skipped_inflight');
  assert(fake.providerCalls(alphaState) === alphaCalls, 'the tick made no provider call for the guarded Agent');
  refresh.endAgentSync(alphaId);

  console.log('\nInterval 0 runs no timers, anything else parses sanely');
  assert(refresh.sessionSyncIntervalMs({}) === 900000, 'the default interval is 900000');
  assert(refresh.sessionSyncIntervalMs({ BOTMANCERS_SESSION_SYNC_INTERVAL_MS: '0' }) === 0, 'interval 0 parses to 0');
  assert(refresh.sessionSyncIntervalMs({ BOTMANCERS_SESSION_SYNC_INTERVAL_MS: '60000' }) === 60000, 'a valid override is honored');
  assert(refresh.sessionSyncIntervalMs({ BOTMANCERS_SESSION_SYNC_INTERVAL_MS: 'soon' }) === 900000, 'garbage falls back to the default');
  assert(refresh.sessionSyncIntervalMs({ BOTMANCERS_SESSION_SYNC_INTERVAL_MS: '-5' }) === 900000, 'a negative interval falls back to the default');
  const disabled = refresh.startSessionSyncLoop({ intervalMs: 0, ...QUIET });
  assert(disabled.running === false, 'starting with interval 0 starts no timer');
  assert(refresh.sessionSyncLoopStatus().running === false, 'the loop reports itself as not running');
  process.env.BOTMANCERS_SESSION_SYNC_INTERVAL_MS = '0';
  const disabledEnv = refresh.startSessionSyncLoop(QUIET);
  delete process.env.BOTMANCERS_SESSION_SYNC_INTERVAL_MS;
  assert(disabledEnv.running === false && refresh.sessionSyncLoopStatus().running === false,
    'BOTMANCERS_SESSION_SYNC_INTERVAL_MS=0 disables the loop too');

  console.log('\nThe loop leaves no open handle');
  const live = refresh.startSessionSyncLoop({ intervalMs: 25, ...QUIET });
  assert(live.running === true && live.interval_ms === 25, 'the loop starts with a short interval');
  await sleep(80);
  const stopped = refresh.stopSessionSyncLoop();
  assert(stopped.running === false && refresh.sessionSyncLoopStatus().running === false,
    'stopping the loop clears the timer');

  console.log('\nOne Agent whose listing throws does not stop another Agent');
  const throwingConn = runtimeConnections.create({ provider: 'codex', label: 'throwing', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: throwingConn }, () => ({
    kind: 'fake-throwing',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions() { throw new Error('boom'); },
  }));
  const throwing = await registerAgent({
    name: 'SyncRefresh throwing', runtime_connection_id: throwingConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const throwingId = throwing.json && throwing.json.id;
  assert(throwing.status === 200 && sessionRows(throwingId) === 0, 'the throwing Agent registers with 0 rows');
  const deltaState = path.join(TMP, 'delta.json');
  fake.seedFakeProvider(deltaState, [
    { id: 'delta-one-SECRET', title: 'Delta one', workspace: '/work/delta/one' },
  ]);
  const deltaConn = runtimeConnections.create({ provider: 'codex', label: 'delta', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: deltaConn }, () => fake.createFakeSessionProvider({ statePath: deltaState }));
  const delta = await registerAgent({
    name: 'SyncRefresh delta', runtime_connection_id: deltaConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const deltaId = delta.json && delta.json.id;
  fake.seedFakeProvider(deltaState, [
    { id: 'delta-two-SECRET', title: 'Delta two survives', workspace: '/work/delta/two' },
  ]);
  const mixed = await refresh.runSessionSyncTick(db, QUIET);
  assert(mixed.failed.some(f => f.agent_id === throwingId && typeof f.error_code === 'string'),
    `the throwing Agent is reported failed (${JSON.stringify(mixed.failed)})`);
  assert(mixed.synced.includes(deltaId) && sessionRows(deltaId) === 2, 'the healthy Agent still syncs in the same pass');

  console.log('\nAgents with no listable history sync to an empty result');
  const limitedConn = runtimeConnections.create({ provider: 'codex', label: 'no-list', host: 'Test' }).id;
  const limitedState = path.join(TMP, 'limited.json');
  fake.seedFakeProvider(limitedState, [
    { id: 'limited-s1-SECRET', title: 'One', workspace: '/work/alpha' },
  ]);
  contract.registerSessionProvider({ connectionId: limitedConn }, () => fake.createFakeSessionProvider({
    statePath: limitedState,
    capabilities: { list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: ['read_only'] },
  }));
  const limited = await registerAgent({
    name: 'SyncRefresh no-list', runtime_connection_id: limitedConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const limitedId = limited.json && limited.json.id;
  assert(limited.status === 200 && sessionRows(limitedId) === 0, 'a no-list Agent registers with 0 rows');
  const limitedTick = await refresh.runSessionSyncTick(db, QUIET);
  assert(limitedTick.unsupported.includes(limitedId), 'the tick reports the no-list Agent as unsupported');
  const limitedManual = await postSync(limitedId);
  assert(limitedManual.status === 200 && limitedManual.json.imported.length === 0
    && limitedManual.json.updated.length === 0 && limitedManual.json.complete === true
    && limitedManual.json.synced_at === null,
    `manual sync of a no-list Agent is an empty success (${JSON.stringify(limitedManual.json)})`);
  const limitedList = await listSessions(limitedId);
  assert(limitedList.status === 200 && limitedList.json.sessions.length === 0 && limitedList.json.synced_at === null,
    'GET for an Agent with no rows reports sessions [] and synced_at null');

  console.log('\nA selected-sessions scope fetches only its selected ids');
  const echoState = path.join(TMP, 'echo.json');
  fake.seedFakeProvider(echoState, [
    { id: 'echo-s1-SECRET', title: 'Echo one', workspace: '/work/echo/one' },
    { id: 'echo-s2-SECRET', title: 'Echo two', workspace: '/work/echo/two' },
  ]);
  const echoConn = runtimeConnections.create({ provider: 'codex', label: 'echo', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: echoConn }, () => fake.createFakeSessionProvider({ statePath: echoState }));
  const echoReg = await registerAgent({
    name: 'SyncRefresh echo', runtime_connection_id: echoConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const echoId = echoReg.json && echoReg.json.id;
  assert(echoReg.status === 200 && sessionRows(echoId) === 2, 'echo registers with its 2 past sessions imported');
  // Narrow to one selected session, then add a session the scope excludes.
  const selected = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? ORDER BY id LIMIT 1').get(echoId).id;
  db.prepare("UPDATE bots SET session_scope_kind = 'sessions', session_scope_items = ? WHERE id = ?").run(JSON.stringify([selected]), echoId);
  fake.seedFakeProvider(echoState, [
    { id: 'echo-s3-SECRET', title: 'Echo three out of scope', workspace: '/work/echo/three' },
  ]);
  const echoTick = await refresh.runSessionSyncTick(db, QUIET);
  assert(echoTick.synced.includes(echoId) && sessionRows(echoId) === 2,
    'a tick imports nothing outside the selected ids');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE provider_session_id = ?', 'echo-s3-SECRET') === 0,
    'the unselected session is never stored');
  const echoManual = await postSync(echoId);
  assert(echoManual.status === 200 && echoManual.json.imported.length === 0
    && echoManual.json.updated.length === 1 && echoManual.json.complete === true,
    `a manual sync refreshes only the selected session (${JSON.stringify(echoManual.json)})`);

  console.log('\nUnknown Agents are 404');
  const missingSync = await postSync('agent-that-does-not-exist');
  assert(missingSync.status === 404, 'POST .../sessions/sync for an unknown Agent is 404');
  const missingList = await listSessions('agent-that-does-not-exist');
  assert(missingList.status === 404, 'GET .../sessions for an unknown Agent is 404');

  console.log('\nThe sync route sits behind the owner boundary');
  const bare = new Request('http://127.0.0.1:3333/api/bots/x/sessions/sync', { method: 'POST' });
  assert(typeof boundary.ownerBoundaryRefusalFor(bare) === 'string', 'a POST with no same-origin proof is refused');
  const proven = new Request('http://127.0.0.1:3333/api/bots/x/sessions/sync', {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:3333' },
  });
  assert(boundary.ownerBoundaryRefusalFor(proven) === null, 'a POST with matching Origin passes the boundary');

  console.log('\nDiscovery stays read-only');
  for (const [label, statePath] of [['alpha', alphaState], ['bravo', bravoState], ['delta', deltaState], ['echo', echoState]]) {
    const ops = fake.loadFakeState(statePath).calls.map(call => call.op);
    assert(ops.length > 0 && !ops.includes('startSession') && !ops.includes('sendTurn'),
      `${label}: no sync called startSession or sendTurn (${ops.join(',') || 'none'})`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  assert(fetchCalls === 0, 'no network call during sync refresh');
  // No process.exit: reaching the end with no open handle is the proof the
  // loop was stopped. Failures set the exit code instead.
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll session sync refresh checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
