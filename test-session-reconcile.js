#!/usr/bin/env node
// NOT-546: sessions the provider no longer reports are marked missing by the
// full-history sync (lib/provider-sessions syncAgentSessionHistory), so they
// stop being offered as available.
// Proves: with 5 stored discovered sessions and a provider that drops 2, a
// complete sync marks exactly those 2 missing with session_missing events;
// a provider that reports one again returns it to available; an incomplete
// sync (page cap) marks 0; a listing error marks 0; an empty listing with
// stored rows marks 0 and records sync_empty_guarded; binding, started, and
// out-of-scope rows are untouched; a sessions-scope Agent is not reconciled;
// asking a missing session is refused with the existing missing-session
// error before any sendTurn provider call.
// Self-contained: isolated SQLite and state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TAG = process.env.NOT546_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-reconcile-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const catalog = jiti('./lib/session-catalog.ts');
const sessionsRoute = jiti('./app/api/bots/[id]/sessions/route.ts');
const fake = require('./test-support/fake-session-provider');

const db = dbModule.default;
const { bots, runtimeConnections, engine, conversations } = dbModule;
contract.clearSessionProviders({ builtins: true });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
async function rejects(promise, code, label) {
  try {
    await promise;
    return assert(false, `${label} (did not throw)`);
  } catch (error) {
    return assert(error && error.code === code, `${label} (got: ${error && (error.code || error.message)})`);
  }
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const owner = { kind: 'person', id: 'local-owner' };
const READ_ONLY = { mode: 'read_only', newSessions: true, resumeEdits: false };

function makeAgent(name, connectionId, scope, policy = READ_ONLY) {
  return bots.create({
    name, title: 'Native', description: 'Reconcile', agent: 'codex',
    runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: scope.kind, session_scope_items: JSON.stringify(scope.items ?? []),
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0,
    allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}
function refOf(agentId, providerId) {
  return db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(agentId, providerId).id;
}
function availabilityOf(ref) {
  return db.prepare('SELECT availability FROM provider_sessions WHERE id = ?').get(ref).availability;
}
function missingEvents(agentId, ref = null) {
  return ref === null
    ? count("SELECT COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? AND type = 'session_missing'", agentId)
    : count("SELECT COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? AND type = 'session_missing' AND session_ref = ?", agentId, ref);
}
function guardEvents(agentId, type) {
  return count('SELECT COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? AND type = ?', agentId, type);
}
async function listViaRoute(agentId) {
  const res = await sessionsRoute.GET(
    new Request(`http://localhost:43123/api/bots/${agentId}/sessions`),
    { params: Promise.resolve({ id: agentId }) },
  );
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log('\nComplete sync marks exactly the dropped sessions missing');
  const mainState = path.join(TMP, 'main.json');
  fake.seedFakeProvider(mainState, [
    { id: 'rec-s1-SECRET', title: 'Keep one', workspace: '/work/rec/one' },
    { id: 'rec-s2-SECRET', title: 'Keep two', workspace: '/work/rec/two' },
    { id: 'rec-s3-SECRET', title: 'Keep three', workspace: '/work/rec/three' },
    { id: 'rec-s4-SECRET', title: 'Drop four', workspace: '/work/rec/four' },
    { id: 'rec-s5-SECRET', title: 'Drop five', workspace: '/work/rec/five' },
  ]);
  const mainConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-main', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: mainConn }, () => fake.createFakeSessionProvider({ statePath: mainState }));
  const main = makeAgent('Reconcile main', mainConn, { kind: 'all_provider_sessions' });
  const first = await ps.syncAgentSessionHistory(db, main.id);
  assert(first.complete === true && first.imported.length === 5, `initial history imports 5 (${JSON.stringify({ imported: first.imported.length, complete: first.complete })})`);
  assert(missingEvents(main.id) === 0, 'no session_missing after the initial import');
  const s1 = refOf(main.id, 'rec-s1-SECRET');
  const s2 = refOf(main.id, 'rec-s2-SECRET');
  const s3 = refOf(main.id, 'rec-s3-SECRET');
  const s4 = refOf(main.id, 'rec-s4-SECRET');
  const s5 = refOf(main.id, 'rec-s5-SECRET');
  fake.mutateFakeProvider(mainState, state => {
    state.sessions['rec-s4-SECRET'].deleted = true;
    state.sessions['rec-s5-SECRET'].deleted = true;
  });
  const dropped = await ps.syncAgentSessionHistory(db, main.id);
  assert(dropped.complete === true, 'the sync that drops 2 still completes');
  const avail = [s1, s2, s3, s4, s5].map(availabilityOf);
  assert(JSON.stringify(avail) === JSON.stringify(['available', 'available', 'available', 'missing', 'missing']),
    `exactly the 2 dropped sessions are missing (${JSON.stringify(avail)})`);
  assert(missingEvents(main.id) === 2 && missingEvents(main.id, s4) === 1 && missingEvents(main.id, s5) === 1,
    'one session_missing event per dropped row');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', main.id) === 5, 'missing rows stay (5 rows, none deleted)');
  const listed = catalog.listAgentSessions(db, main.id, 'all');
  const byRef = Object.fromEntries(listed.map(s => [s.ref, s]));
  assert(byRef[s4].state.availability === 'missing' && byRef[s5].state.availability === 'missing'
    && byRef[s1].state.availability === 'available' && listed.length === 5,
    'the catalog lists the missing rows with availability missing (exit predicate)');
  const viaGet = await listViaRoute(main.id);
  const missingInGet = viaGet.json.sessions.filter(s => s.state.availability === 'missing').map(s => s.ref).sort();
  assert(viaGet.status === 200 && JSON.stringify(missingInGet) === JSON.stringify([s4, s5].sort()),
    'GET /api/bots/<id>/sessions reports the same 2 missing');

  console.log('\nA session the provider reports again returns to available');
  fake.mutateFakeProvider(mainState, state => { state.sessions['rec-s4-SECRET'].deleted = false; });
  const back = await ps.syncAgentSessionHistory(db, main.id);
  assert(back.complete === true && availabilityOf(s4) === 'available' && availabilityOf(s5) === 'missing',
    'the re-reported session is available again; the still-absent one stays missing');
  assert(missingEvents(main.id) === 2, 'no new session_missing when a session returns (still 2 total)');

  console.log('\nBinding and started rows are never touched');
  const mainConv = conversations.getByBotId(main.id);
  const binding = engine.bindSession({ agentId: main.id, adapter: 'codex', externalSessionId: 'rec-bound-never-reported-SECRET', conversationId: mainConv.id });
  const started = await ps.startProviderSession(db, main.id, {
    workspace: '/work/rec/new', prompt: 'Started work', authority: 'read_only', idempotencyKey: 'rec-start-1', requester: owner,
  });
  const startedRef = started.turn.session_ref;
  const startedProviderId = db.prepare('SELECT provider_session_id FROM provider_sessions WHERE id = ?').get(startedRef).provider_session_id;
  fake.mutateFakeProvider(mainState, state => { state.sessions[startedProviderId].deleted = true; });
  await ps.syncAgentSessionHistory(db, main.id);
  assert(availabilityOf(binding.id) === 'available' && missingEvents(main.id, binding.id) === 0,
    'a binding row the provider never reported stays available');
  assert(availabilityOf(startedRef) === 'available' && missingEvents(main.id, startedRef) === 0,
    'a started row the provider no longer reports stays available');
  assert(availabilityOf(s5) === 'missing', 'the genuinely missing discovered row is still missing');

  console.log('\nOut-of-scope rows are untouched');
  const scopeState = path.join(TMP, 'scope.json');
  fake.seedFakeProvider(scopeState, [
    { id: 'scope-in-SECRET', title: 'In scope', workspace: '/work/alpha/in' },
  ]);
  const scopeConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-scope', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: scopeConn }, () => fake.createFakeSessionProvider({ statePath: scopeState, ignoreScope: true }));
  const scoped = makeAgent('Reconcile scoped', scopeConn, { kind: 'workspaces', items: ['/work/alpha'] });
  await ps.syncAgentSessionHistory(db, scoped.id);
  const oosId = require('crypto').randomUUID();
  db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, workspace, availability, lifecycle, resumable, created_at, updated_at)
    VALUES (?, ?, ?, 'fake-direct', 'scope-out-SECRET', 'discovered', '/work/beta/outside', 'available', 'open', 1, 0, 0)`)
    .run(oosId, scoped.id, scopeConn);
  await ps.syncAgentSessionHistory(db, scoped.id);
  assert(availabilityOf(oosId) === 'available' && missingEvents(scoped.id, oosId) === 0,
    'a discovered row outside the workspaces scope stays available');
  assert(availabilityOf(refOf(scoped.id, 'scope-in-SECRET')) === 'available', 'the in-scope row stays available');

  console.log('\nA sessions-scope Agent is not reconciled');
  const selState = path.join(TMP, 'selected.json');
  fake.seedFakeProvider(selState, [
    { id: 'sel-s1-SECRET', title: 'Selected one', workspace: '/work/sel/one' },
    { id: 'sel-s2-SECRET', title: 'Selected two', workspace: '/work/sel/two' },
    { id: 'sel-s3-SECRET', title: 'Selected three', workspace: '/work/sel/three' },
  ]);
  const selConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-selected', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: selConn }, () => fake.createFakeSessionProvider({ statePath: selState }));
  const sel = makeAgent('Reconcile selected', selConn, { kind: 'all_provider_sessions' });
  await ps.syncAgentSessionHistory(db, sel.id);
  const selKeep = refOf(sel.id, 'sel-s1-SECRET');
  const selDrop1 = refOf(sel.id, 'sel-s2-SECRET');
  const selDrop2 = refOf(sel.id, 'sel-s3-SECRET');
  db.prepare("UPDATE bots SET session_scope_kind = 'sessions', session_scope_items = ? WHERE id = ?").run(JSON.stringify([selKeep]), sel.id);
  fake.mutateFakeProvider(selState, state => {
    state.sessions['sel-s2-SECRET'].deleted = true;
    state.sessions['sel-s3-SECRET'].deleted = true;
  });
  const selSync = await ps.syncAgentSessionHistory(db, sel.id);
  assert(selSync.complete === true, 'the sessions-scope sync completes');
  assert(availabilityOf(selDrop1) === 'available' && availabilityOf(selDrop2) === 'available' && missingEvents(sel.id) === 0,
    'unreported sessions under a sessions scope stay available with no session_missing');

  console.log('\nAn incomplete sync (page cap) marks 0');
  const capConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-cap', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: capConn }, () => ({
    kind: 'fake-endless',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions(input) {
      const at = Date.UTC(2026, 9, 1, 8, 0, 0);
      return { ok: true, value: {
        items: [{ provider_session_id: 'cap-same-SECRET', title: 'Endless', workspace: '/work/cap', created_at: at, updated_at: at, lifecycle: 'open', resumable: true, busy: false }],
        next_cursor: String((Number(input.cursor ?? '0')) + 1),
      } };
    },
  }));
  const capped = makeAgent('Reconcile capped', capConn, { kind: 'all_provider_sessions' });
  const capPre1 = require('crypto').randomUUID();
  const capPre2 = require('crypto').randomUUID();
  for (const [id, providerId] of [[capPre1, 'cap-pre-1-SECRET'], [capPre2, 'cap-pre-2-SECRET']]) {
    db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, workspace, availability, lifecycle, resumable, created_at, updated_at)
      VALUES (?, ?, ?, 'fake-endless', ?, 'discovered', '/work/cap', 'available', 'open', 1, 0, 0)`).run(id, capped.id, capConn, providerId);
  }
  const cappedSync = await ps.syncAgentSessionHistory(db, capped.id, { limit: 1 });
  assert(cappedSync.complete === false && cappedSync.pages === 1000, `an endless listing stops at the page cap (${JSON.stringify({ complete: cappedSync.complete, pages: cappedSync.pages })})`);
  assert(availabilityOf(capPre1) === 'available' && availabilityOf(capPre2) === 'available' && missingEvents(capped.id) === 0,
    'page cap: 0 marked, the unreported pre-stored rows stay available');
  assert(guardEvents(capped.id, 'sync_incomplete_guarded') === 1, 'page cap records sync_incomplete_guarded');

  console.log('\nAn incomplete sync (cursor loop) marks 0');
  const loopConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-loop', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: loopConn }, () => ({
    kind: 'fake-loop',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions() {
      const at = Date.UTC(2026, 9, 1, 8, 0, 0);
      return { ok: true, value: {
        items: [{ provider_session_id: 'loop-s1-SECRET', title: 'Loop', workspace: '/work/loop', created_at: at, updated_at: at, lifecycle: 'open', resumable: true, busy: false }],
        next_cursor: 'loop',
      } };
    },
  }));
  const looped = makeAgent('Reconcile looped', loopConn, { kind: 'all_provider_sessions' });
  const loopPre = require('crypto').randomUUID();
  db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, workspace, availability, lifecycle, resumable, created_at, updated_at)
    VALUES (?, ?, ?, 'fake-loop', 'loop-pre-SECRET', 'discovered', '/work/loop', 'available', 'open', 1, 0, 0)`).run(loopPre, looped.id, loopConn);
  const loopedSync = await ps.syncAgentSessionHistory(db, looped.id);
  assert(loopedSync.complete === false, 'a repeating cursor returns complete:false');
  assert(availabilityOf(loopPre) === 'available' && missingEvents(looped.id) === 0, 'cursor loop: 0 marked');
  assert(guardEvents(looped.id, 'sync_incomplete_guarded') === 1, 'cursor loop records sync_incomplete_guarded');

  console.log('\nA listing error marks 0');
  const errState = path.join(TMP, 'err.json');
  fake.seedFakeProvider(errState, [
    { id: 'err-s1-SECRET', title: 'Err one', workspace: '/work/err/one' },
    { id: 'err-s2-SECRET', title: 'Err two', workspace: '/work/err/two' },
  ]);
  const errConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-err', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: errConn }, () => fake.createFakeSessionProvider({ statePath: errState }));
  const errAgent = makeAgent('Reconcile err', errConn, { kind: 'all_provider_sessions' });
  await ps.syncAgentSessionHistory(db, errAgent.id);
  const errRef1 = refOf(errAgent.id, 'err-s1-SECRET');
  const errRef2 = refOf(errAgent.id, 'err-s2-SECRET');
  contract.registerSessionProvider({ connectionId: errConn }, () => ({
    kind: 'fake-broken',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions() { return { ok: false, error: { code: 'unavailable', message: 'runtime down' } }; },
  }));
  await rejects(ps.syncAgentSessionHistory(db, errAgent.id), 'provider_unavailable', 'the broken listing still throws its provider error');
  assert(availabilityOf(errRef1) === 'available' && availabilityOf(errRef2) === 'available' && missingEvents(errAgent.id) === 0,
    'listing error: 0 marked, both stored rows stay available');
  assert(guardEvents(errAgent.id, 'sync_error_guarded') === 1, 'listing error records sync_error_guarded');

  console.log('\nAn empty listing with stored rows marks 0 and records sync_empty_guarded');
  const emptyState = path.join(TMP, 'empty.json');
  fake.seedFakeProvider(emptyState, [
    { id: 'empty-s1-SECRET', title: 'Empty one', workspace: '/work/empty/one' },
    { id: 'empty-s2-SECRET', title: 'Empty two', workspace: '/work/empty/two' },
    { id: 'empty-s3-SECRET', title: 'Empty three', workspace: '/work/empty/three' },
    { id: 'empty-s4-SECRET', title: 'Empty four', workspace: '/work/empty/four' },
    { id: 'empty-s5-SECRET', title: 'Empty five', workspace: '/work/empty/five' },
  ]);
  const emptyConn = runtimeConnections.create({ provider: 'codex', label: 'reconcile-empty', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: emptyConn }, () => fake.createFakeSessionProvider({ statePath: emptyState }));
  const emptied = makeAgent('Reconcile empty', emptyConn, { kind: 'all_provider_sessions' });
  await ps.syncAgentSessionHistory(db, emptied.id);
  fake.mutateFakeProvider(emptyState, state => {
    for (const id of Object.keys(state.sessions)) state.sessions[id].deleted = true;
  });
  const emptySync = await ps.syncAgentSessionHistory(db, emptied.id);
  assert(emptySync.complete === true, 'the empty listing still completes');
  const emptyRefs = [1, 2, 3, 4, 5].map(n => refOf(emptied.id, `empty-s${n}-SECRET`));
  assert(emptyRefs.every(ref => availabilityOf(ref) === 'available') && missingEvents(emptied.id) === 0,
    'empty listing: 0 marked, all 5 stored rows stay available');
  assert(guardEvents(emptied.id, 'sync_empty_guarded') === 1, 'empty listing records sync_empty_guarded');
  const emptyDetail = db.prepare("SELECT detail FROM provider_session_events WHERE agent_id = ? AND type = 'sync_empty_guarded'").get(emptied.id);
  assert(JSON.parse(emptyDetail.detail).stored === 5, 'sync_empty_guarded names the 5 stored rows');

  console.log('\nAsking a missing session is refused before any provider sendTurn');
  const sendsBefore = fake.providerCalls(mainState, 'sendTurn');
  await rejects(
    ps.sendProviderTurn(db, main.id, s5, { prompt: 'Are you still there?', authority: 'read_only', idempotencyKey: 'rec-ask-missing', requester: owner }),
    'session_missing', 'an Ask on the missing session is the existing missing-session error',
  );
  assert(fake.providerCalls(mainState, 'sendTurn') === sendsBefore, `no sendTurn reached the provider (${fake.providerCalls(mainState, 'sendTurn') - sendsBefore} new calls)`);
  assert(count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE agent_id = ? AND session_ref = ?', main.id, s5) === 0,
    'the refused Ask recorded no turn');

  fs.rmSync(TMP, { recursive: true, force: true });
  assert(fetchCalls === 0, 'no network call during reconcile');
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session reconcile checks passed.');
}

main().catch(error => { console.error(error); process.exit(1); });
