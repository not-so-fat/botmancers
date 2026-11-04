#!/usr/bin/env node
// NOT-547: Botmancers sessions show sync status, Refresh, and truthful
// empty states in the Sessions drawer.
// Proves: emptySessionsCopy returns four distinct messages (never synced,
// last sync failed with reason, none in scope with the count, none exist);
// GET /api/bots/:id/sessions returns sync.synced_at, sync.last_error_code
// and sync.out_of_scope_count; registration includes session_sync;
// Refresh updates the out-of-scope count and the last-synced time; the
// Refresh button and Retry are native buttons with the result announced
// via role="status" (source contract, as in test-session-catalog.js).
// Self-contained: isolated SQLite and state files, no network, no listen.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TAG = process.env.NOT547_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-sync-ui-${TAG}`);
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
const view = jiti('./lib/session-view.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
const sessionsRoute = jiti('./app/api/bots/[id]/sessions/route.ts');
const syncRoute = jiti('./app/api/bots/[id]/sessions/sync/route.ts');
const fake = require('./test-support/fake-session-provider');

const db = dbModule.default;
const { bots, runtimeConnections } = dbModule;
contract.clearSessionProviders({ builtins: true });

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const READ_ONLY = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };

function jsonRequest(url, method, body) {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function registerAgent(body) {
  const res = await botsRoute.POST(jsonRequest('http://localhost:43123/api/bots', 'POST', body));
  return { status: res.status, json: await res.json() };
}
async function listSessions(agentId, status = 'all') {
  const res = await sessionsRoute.GET(
    new Request(`http://localhost:43123/api/bots/${agentId}/sessions?status=${status}`),
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
  console.log('\nemptySessionsCopy distinguishes the four empty states');
  const now = Date.now();
  const never = view.emptySessionsCopy('all', 'Dev', { synced_at: null, last_error_code: null, out_of_scope_count: null });
  const failed = view.emptySessionsCopy('all', 'Dev', { synced_at: null, last_error_code: 'provider_unavailable', out_of_scope_count: null }, 'Codex');
  const scoped = view.emptySessionsCopy('all', 'Dev', { synced_at: now, last_error_code: null, out_of_scope_count: 5 });
  const empty = view.emptySessionsCopy('all', 'Dev', { synced_at: now, last_error_code: null, out_of_scope_count: 0 });
  assert(/has not synced sessions yet/.test(never) && /Refresh/.test(never), `never synced says so with Refresh (${never})`);
  assert(/Could not read Codex sessions/.test(failed) && /codex is not installed/.test(failed) && /Retry/.test(failed),
    `failed names the reason and Retry (${failed})`);
  assert(/5 sessions exist outside/.test(scoped) && /scope/.test(scoped), `none in scope names the count (${scoped})`);
  assert(/has no sessions yet/.test(empty), `none exist keeps the original copy (${empty})`);
  assert(new Set([never, failed, scoped, empty]).size === 4, 'the four messages are distinct');
  assert(/no active sessions/.test(view.emptySessionsCopy('active', 'Dev')) && /no ended sessions/.test(view.emptySessionsCopy('ended', 'Dev')),
    'active and ended filters keep their copy');
  assert(view.emptySessionsCopy('all', 'Dev') === view.emptySessionsCopy('all', 'Dev', null), 'no sync state falls back to the original copy');

  console.log('\nSync helpers: relative time, error copy, registration line');
  assert(view.formatSyncRelativeTime(null) === 'never', 'never synced formats as never');
  assert(view.formatSyncRelativeTime(now, now) === 'just now', 'a fresh sync is just now');
  assert(view.formatSyncRelativeTime(now - 5 * 60_000, now) === '5 minutes ago', 'minutes ago');
  assert(view.formatSyncRelativeTime(now - 2 * 3600_000, now) === '2 hours ago', 'hours ago');
  assert(view.formatSyncRelativeTime(now - 3 * 86400_000, now) === '3 days ago', 'days ago');
  const err = view.sessionSyncErrorCopy('provider_unavailable', 'Codex');
  assert(/codex is not installed/.test(err.reason) && /Retry/.test(err.fix), `Codex unavailable names codex and the fix (${JSON.stringify(err)})`);
  assert(view.registrationSessionSyncCopy({ outcome: 'synced', imported: 259, rejected_out_of_scope: 0, complete: true }, 'Codex') === 'Loaded 259 sessions.',
    'synced line loads the count');
  assert(view.registrationSessionSyncCopy({ outcome: 'synced', imported: 1, rejected_out_of_scope: 0, complete: true }, 'Codex') === 'Loaded 1 session.',
    'synced line singularizes');
  assert(/2 outside the scope/.test(view.registrationSessionSyncCopy({ outcome: 'synced', imported: 3, rejected_out_of_scope: 2, complete: true }, 'Codex')),
    'synced line names out-of-scope sessions');
  assert(/Could not read Codex sessions/.test(view.registrationSessionSyncCopy(
    { outcome: 'failed', imported: 0, rejected_out_of_scope: 0, complete: false, error_code: 'provider_unavailable' }, 'Codex')),
    'failed line names the provider and reason');
  assert(/not available for Hermes/.test(view.registrationSessionSyncCopy({ outcome: 'unsupported', imported: 0, rejected_out_of_scope: 0, complete: true }, 'Hermes')),
    'unsupported line says so');

  console.log('\nRegistration returns the sync outcome (session_sync)');
  const scopedState = path.join(TMP, 'scoped.json');
  fake.seedFakeProvider(scopedState, [
    { id: 'ui-in-1-SECRET', title: 'In one', workspace: '/work/alpha/one' },
    { id: 'ui-in-2-SECRET', title: 'In two', workspace: '/work/alpha/two' },
    { id: 'ui-out-1-SECRET', title: 'Out', workspace: '/work/beta/other' },
  ]);
  const scopedConn = runtimeConnections.create({ provider: 'codex', label: 'codex scoped', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: scopedConn },
    () => fake.createFakeSessionProvider({ statePath: scopedState, ignoreScope: true }));
  const scopedReg = await registerAgent({
    name: 'SyncUI scoped', runtime_connection_id: scopedConn,
    session_scope: { kind: 'workspaces', workspaces: ['/work/alpha'] }, policy: READ_ONLY,
  });
  const scopedId = scopedReg.json && scopedReg.json.id;
  assert(scopedReg.status === 200 && scopedReg.json.session_sync
    && scopedReg.json.session_sync.outcome === 'synced' && scopedReg.json.session_sync.imported === 2
    && scopedReg.json.session_sync.rejected_out_of_scope === 1 && scopedReg.json.session_sync.complete === true
    && !('error_code' in scopedReg.json.session_sync),
    `synced registration includes session_sync (${JSON.stringify(scopedReg.json.session_sync)})`);

  const throwingConn = runtimeConnections.create({ provider: 'codex', label: 'codex throwing', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: throwingConn }, () => ({
    kind: 'fake-throwing',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async listSessions() { throw new Error('boom'); },
  }));
  const throwingReg = await registerAgent({
    name: 'SyncUI throwing', runtime_connection_id: throwingConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const throwingId = throwingReg.json && throwingReg.json.id;
  assert(throwingReg.status === 200 && throwingReg.json.session_sync
    && throwingReg.json.session_sync.outcome === 'failed' && typeof throwingReg.json.session_sync.error_code === 'string',
    `failed registration includes session_sync with error_code (${JSON.stringify(throwingReg.json.session_sync)})`);
  assert(bots.getById(throwingId) !== undefined, 'the failed Agent stays registered');

  const limitedConn = runtimeConnections.create({ provider: 'codex', label: 'codex no-list', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: limitedConn }, () => fake.createFakeSessionProvider({
    statePath: path.join(TMP, 'limited.json'),
    capabilities: { list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: ['read_only'] },
  }));
  const limitedReg = await registerAgent({
    name: 'SyncUI no-list', runtime_connection_id: limitedConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  assert(limitedReg.status === 200 && limitedReg.json.session_sync && limitedReg.json.session_sync.outcome === 'unsupported',
    `unsupported registration includes session_sync (${JSON.stringify(limitedReg.json.session_sync)})`);

  console.log('\nGET /api/bots/:id/sessions returns sync.synced_at, last_error_code, out_of_scope_count');
  const scopedList = await listSessions(scopedId);
  assert(scopedList.status === 200 && scopedList.json.sync
    && typeof scopedList.json.sync.synced_at === 'number' && scopedList.json.sync.last_error_code === null
    && scopedList.json.sync.out_of_scope_count === 1 && scopedList.json.sessions.length === 2,
    `synced Agent reports its outcome (${JSON.stringify(scopedList.json.sync)})`);
  const throwingList = await listSessions(throwingId);
  assert(throwingList.status === 200 && throwingList.json.sync
    && typeof throwingList.json.sync.last_error_code === 'string' && throwingList.json.sync.synced_at === null
    && throwingList.json.sync.out_of_scope_count === null && throwingList.json.sessions.length === 0,
    `failed Agent reports its error (${JSON.stringify(throwingList.json.sync)})`);
  const failedCopy = view.emptySessionsCopy('all', 'SyncUI throwing', throwingList.json.sync, 'Codex');
  assert(/Could not read Codex sessions/.test(failedCopy), 'the failed sync state renders the failure reason');

  const direct = bots.create({
    name: 'SyncUI never', title: '', description: '', agent: 'codex', runtime_connection_id: scopedConn,
    session_scope_kind: 'all_provider_sessions', session_scope_items: JSON.stringify([]),
    policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const neverList = await listSessions(direct.id);
  assert(neverList.status === 200 && neverList.json.sync
    && neverList.json.sync.synced_at === null && neverList.json.sync.last_error_code === null
    && neverList.json.sync.out_of_scope_count === null,
    `never-synced Agent reports nulls (${JSON.stringify(neverList.json.sync)})`);

  const emptyState = path.join(TMP, 'empty.json');
  fake.seedFakeProvider(emptyState, []);
  const emptyConn = runtimeConnections.create({ provider: 'codex', label: 'codex empty', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: emptyConn }, () => fake.createFakeSessionProvider({ statePath: emptyState }));
  const emptyReg = await registerAgent({
    name: 'SyncUI empty', runtime_connection_id: emptyConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const emptyList = await listSessions(emptyReg.json.id);
  assert(emptyList.status === 200 && emptyList.json.sync
    && typeof emptyList.json.sync.synced_at === 'number' && emptyList.json.sync.last_error_code === null
    && emptyList.json.sync.out_of_scope_count === 0 && emptyList.json.sessions.length === 0,
    `empty Agent reports a completed sync with zero out of scope (${JSON.stringify(emptyList.json.sync)})`);

  console.log('\nExit predicate: an excluding scope shows the out-of-scope count');
  const excludingState = path.join(TMP, 'excluding.json');
  fake.seedFakeProvider(excludingState, [
    { id: 'ex-out-1-SECRET', title: 'Out one', workspace: '/work/real/one' },
    { id: 'ex-out-2-SECRET', title: 'Out two', workspace: '/work/real/two' },
    { id: 'ex-out-3-SECRET', title: 'Out three', workspace: '/work/real/three' },
  ]);
  const excludingConn = runtimeConnections.create({ provider: 'codex', label: 'codex excluding', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: excludingConn },
    () => fake.createFakeSessionProvider({ statePath: excludingState, ignoreScope: true }));
  const excludingReg = await registerAgent({
    name: 'SyncUI excluding', runtime_connection_id: excludingConn,
    session_scope: { kind: 'workspaces', workspaces: ['/work/empty'] }, policy: READ_ONLY,
  });
  const excludingId = excludingReg.json && excludingReg.json.id;
  assert(excludingReg.json.session_sync.outcome === 'synced' && excludingReg.json.session_sync.imported === 0
    && excludingReg.json.session_sync.rejected_out_of_scope === 3, 'excluding scope imports nothing and rejects 3');
  const excludingList = await listSessions(excludingId);
  assert(excludingList.json.sessions.length === 0 && excludingList.json.sync.out_of_scope_count === 3,
    'the drawer state is empty with 3 outside the scope');
  const excludingCopy = view.emptySessionsCopy('all', 'SyncUI excluding', excludingList.json.sync);
  assert(/3 sessions exist outside/.test(excludingCopy), `the none-in-scope message names the 3 (${excludingCopy})`);

  console.log('\nRefresh updates the count and the last-synced time');
  const before = excludingList.json.sync.synced_at;
  fake.seedFakeProvider(excludingState, [
    { id: 'ex-out-4-SECRET', title: 'Out four', workspace: '/work/real/four' },
  ]);
  await sleep(15);
  const manual = await postSync(excludingId);
  assert(manual.status === 200 && Array.isArray(manual.json.imported) && Array.isArray(manual.json.updated),
    `manual sync returns imported and updated arrays (${JSON.stringify({ imported: manual.json.imported, updated: manual.json.updated })})`);
  assert(manual.json.rejected_out_of_scope === 4, 'manual sync reports 4 rejected out of scope');
  const afterRefresh = await listSessions(excludingId);
  assert(afterRefresh.json.sync.out_of_scope_count === 4, 'Refresh updates the out-of-scope count to 4');
  assert(typeof afterRefresh.json.sync.synced_at === 'number' && afterRefresh.json.sync.synced_at > before,
    'Refresh updates the last-synced time');

  console.log('\nRetry with an unavailable CLI keeps the failure state');
  const missingCliConn = runtimeConnections.create({ provider: 'codex', label: 'codex missing cli', host: 'Test' }).id;
  contract.registerSessionProvider({ connectionId: missingCliConn }, () => ({
    kind: 'fake-missing-cli',
    capabilities: () => ({ list: true, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: [], max_page_size: 25 }),
    async ready() { return { ok: false, error: { code: 'unavailable', message: 'codex is not installed' } }; },
    async listSessions() { throw new Error('must not list when the CLI is missing'); },
  }));
  const missingCliReg = await registerAgent({
    name: 'SyncUI missing CLI', runtime_connection_id: missingCliConn,
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  const missingCliId = missingCliReg.json && missingCliReg.json.id;
  assert(missingCliReg.status === 200 && missingCliReg.json.session_sync
    && missingCliReg.json.session_sync.outcome === 'failed' && missingCliReg.json.session_sync.error_code === 'provider_unavailable',
    `missing CLI registers failed with provider_unavailable (${JSON.stringify(missingCliReg.json.session_sync)})`);
  const missingCliList = await listSessions(missingCliId);
  assert(missingCliList.status === 200 && missingCliList.json.sync.last_error_code === 'provider_unavailable'
    && missingCliList.json.sessions.length === 0,
    `missing CLI lists empty with its error (${JSON.stringify(missingCliList.json.sync)})`);
  const retry = await postSync(missingCliId);
  assert(retry.status === 500, `Retry answers 500, not an empty success (${retry.status} ${JSON.stringify(retry.json)})`);
  const afterRetry = await listSessions(missingCliId);
  assert(afterRetry.json.sync.last_error_code === 'provider_unavailable' && afterRetry.json.sync.synced_at === null
    && afterRetry.json.sync.out_of_scope_count === null && afterRetry.json.sessions.length === 0,
    `Retry preserves the failure state (${JSON.stringify(afterRetry.json.sync)})`);
  const retryCopy = view.emptySessionsCopy('all', 'SyncUI missing CLI', afterRetry.json.sync, 'Codex');
  assert(/Could not read Codex sessions/.test(retryCopy) && /codex is not installed/.test(retryCopy),
    `the drawer still shows the reason after Retry (${retryCopy})`);

  console.log('\nA missing scope is a failure, never an empty success');
  const unscoped = bots.create({
    name: 'SyncUI unscoped', title: '', description: '', agent: 'codex', runtime_connection_id: scopedConn,
    session_scope_kind: 'all_provider_sessions', session_scope_items: JSON.stringify([]),
    policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  db.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(unscoped.id);
  const unscopedSync = await postSync(unscoped.id);
  assert(unscopedSync.status === 500, `unscoped Refresh answers 500 (${unscopedSync.status})`);
  const unscopedList = await listSessions(unscoped.id);
  assert(unscopedList.json.sync.last_error_code === 'scope_missing' && unscopedList.json.sessions.length === 0,
    `unscoped Agent reports scope_missing (${JSON.stringify(unscopedList.json.sync)})`);
  assert(/no session scope is set/.test(view.emptySessionsCopy('all', 'SyncUI unscoped', unscopedList.json.sync)),
    'the drawer keeps its no-scope copy after Refresh');

  console.log('\nAn Agent with no session provider still syncs empty');
  const hermesSync = await postSync(emptyReg.json.id);
  assert(hermesSync.status === 200 && Array.isArray(hermesSync.json.imported) && hermesSync.json.imported.length === 0
    && Array.isArray(hermesSync.json.updated) && hermesSync.json.updated.length === 0,
    `Hermes Refresh is an empty success (${hermesSync.status} ${JSON.stringify({ imported: hermesSync.json.imported, updated: hermesSync.json.updated })})`);

  console.log('\nKeyboard and announcement contract (source)');
  const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const panel = read('app/components/SessionsPanel.tsx');
  const page = read('app/page.tsx');
  assert(/<button type="button"[\s\S]*?disabled=\{syncing\}[\s\S]*?\{syncing \? 'Refreshing/.test(panel),
    'the header Refresh is a native button, disabled while a sync runs');
  assert(/Last synced \{formatSyncRelativeTime/.test(panel), 'the header shows Last synced with relative time');
  assert(/<div className="exchange-started" role="status">\s*\{syncResult\}/.test(panel),
    'the imported and updated counts are announced via role="status"');
  assert(/emptySessionsCopy\(filter, agentName, sync, providerLabel\)/.test(panel), 'the empty state reads the sync truth');
  assert(/sync\?\.last_error_code \? \(/.test(panel) && /disabled=\{syncing\}[^]*\{\s*syncing \? 'Retrying/.test(panel),
    'the failed empty state offers a native Retry, disabled while syncing');
  assert(/out_of_scope_count \?\? 0\) > 0/.test(panel) && /Widen the scope in Config/.test(panel)
    && /href=\{`\/bots\/\$\{encodeURIComponent\(agentId\)\}\/config`\}/.test(panel),
    'the none-in-scope empty state links to widening the scope in Config');
  assert(/onClick=\{\(\) => \{ void doRefresh\(\); \}\} disabled=\{syncing\}/.test(panel),
    'Refresh and Retry share one refresh path that cannot double-fire');
  assert(/registrationSessionSyncCopy\(sync, provider\)/.test(page) && /<p role="status">\{createdSync\.agentName\} created\. \{createdSync\.line\}<\/p>/.test(page),
    'the New Agent flow announces its one-line sync result via role="status"');
  assert(/<button ref=\{doneRef\} type="button" className="create-btn" onClick=\{onCreated\}>/.test(page)
    && /doneRef\.current\?\.focus\(\)/.test(page),
    'the New Agent result is dismissed with a focused native Done button');

  fs.rmSync(TMP, { recursive: true, force: true });
  assert(fetchCalls === 0, 'no network call during the sync UI suite');
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session sync UI checks passed.');
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
