#!/usr/bin/env node
// NOT-543: one-way migration of Agent Deck-backed rows to direct.
//
// Proves on a before/after fixture (deterministic, no network):
// (1) every valid agent_deck coding Agent becomes direct and retains its
//     Agent ID, runtime connection, scope, policy, home/default session,
//     conversations, Work Requests, Attempts, session bindings,
//     Wake/service grants, and history;
// (2) deck ID/name selection, the deck working-directory override,
//     deck-selection flags, and the Agent Deck launch profile cease to
//     be configuration: cleared in storage, absent from reads, rejected
//     on write;
// (3) rows without a usable scope stay readable and unlaunchable and
//     never regain Agent Deck execution;
// (4) the migration is idempotent.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = require('./support/repo-root');
const DB_PATH = path.join(os.tmpdir(), `botmancers-direct-migration-${process.pid}.db`);
const GRANTS_PATH = path.join(os.tmpdir(), `botmancers-migration-grants-${process.pid}.json`);
const MIGWS = path.join(os.tmpdir(), `botmancers-migration-ws-${process.pid}`);
process.env.BOTMANCERS_MIGRATION_WS = MIGWS;
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
fs.writeFileSync(GRANTS_PATH, '{"version":1,"services":{"svc-keep":{"agents":{"*":["sessions:read"]}}}}\n');
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SERVICE_GRANTS_PATH = GRANTS_PATH;

// Seed with the current code, then backdate the removed launch columns to
// the values the old code wrote. This runs BEFORE the parent loads the
// database below, so the parent's own load is the migration under test.
execFileSync(process.execPath, ['-e', `
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  const { createJiti } = require('jiti');
  const jiti = createJiti(${JSON.stringify(path.join(ROOT, 'seed.js'))}, { alias: { '@': ${JSON.stringify(ROOT)} } });
  const db = jiti('../lib/db.ts');
  const { seedSessionCatalog } = require('./support/session-catalog-fixture.js');
  seedSessionCatalog(db);
  const raw = db.default;
  const t = Date.now();
  const decked = db.bots.create({ name: 'Decked', title: 'Implementer', description: 'Agent Deck coding Agent.', agent: 'codex' });
  const reviewer = db.bots.create({ name: 'Reviewer', title: 'Reviewer', description: 'All-sessions scope.', agent: 'claude' });
  const pending = db.bots.create({ name: 'Pending', title: '', description: 'Needed reselection.', agent: 'cursor' });
  const invalid = db.bots.create({ name: 'Invalid', title: '', description: 'No usable scope.', agent: 'codex' });
  const conv = db.conversations.getByBotId(decked.id);
  const binding = db.engine.bindSession({ agentId: decked.id, adapter: 'codex', externalSessionId: 'prov-decked-SECRET', conversationId: conv.id, now: t });
  db.bots.updateRegistration(decked.id, 'codex', {
    runtime_connection_id: decked.runtime_connection_id,
    session_scope: { kind: 'workspaces', workspaces: [process.env.BOTMANCERS_MIGRATION_WS], sessions: [] },
    default_workspace: process.env.BOTMANCERS_MIGRATION_WS + '/app',
    policy: { mode: 'workspace_write', allow_new_sessions: true, allow_resume_with_edits: true },
    home_session_id: binding.id,
  });
  db.bots.updateRegistration(reviewer.id, 'claude', {
    runtime_connection_id: reviewer.runtime_connection_id,
    session_scope: { kind: 'all_provider_sessions', workspaces: [], sessions: [] },
    default_workspace: null,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  const { request } = db.engine.createOrGetWorkRequest({
    sourceConversationId: conv.id, sourceEventId: 'mig-msg-1', requester: { kind: 'person', id: 'local-owner' },
    targetAgentId: decked.id, intent: 'Migrate me', executionKind: 'implementation', toolProfile: 'edit', idempotencyKey: 'mig-1',
  });
  db.engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running' });
  db.engine.createAttempt(request.id, { kind: 'launch', adapter: 'codex', toolProfile: 'edit', launchSnapshot: { transport: 'agent-deck-run' } });
  raw.prepare("INSERT INTO wake_grants (id, caller_agent_id, target_agent_id, authority, granted_by_kind, granted_by_id, created_at) VALUES ('wg-mig', ?, ?, 'edit', 'person', 'local-owner', ?)").run(reviewer.id, decked.id, t);
  raw.prepare('INSERT INTO launch_snapshots (id, bot_id, created_at, hash, snapshot, transport) VALUES (?, ?, ?, ?, ?, ?)').run(
    'snap-mig', decked.id, t, 'd'.repeat(64), JSON.stringify({ deck_id: 'deck-stale' }), 'agent-deck');
  raw.prepare("UPDATE bots SET launch_profile = 'agent_deck', deck_id = 'deck-stale', working_directory = '/tmp/decked' WHERE id = ?").run(decked.id);
  raw.prepare("UPDATE bots SET launch_profile = 'agent_deck', deck_id = 'deck-review' WHERE id = ?").run(reviewer.id);
  raw.prepare("UPDATE bots SET launch_profile = 'agent_deck', deck_id = NULL, working_directory = '/tmp/pending', needs_deck_selection = 1 WHERE id = ?").run(pending.id);
  raw.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(invalid.id);
  raw.pragma('wal_checkpoint(TRUNCATE)');
`], { cwd: ROOT, env: process.env });

const Database = require('better-sqlite3');
const tablesOf = conn => conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('bots', 'runtime_connections') ORDER BY name").all().map(r => r.name);
const dumpOf = conn => Object.fromEntries(tablesOf(conn).map(name => [name, conn.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const REGISTRATION_COLUMNS = 'runtime_connection_id, session_scope_kind, session_scope_items, default_workspace, policy_mode, allow_new_sessions, allow_resume_with_edits, home_session_id';

let failures = 0;
function assert(condition, label, detail) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}${detail ? ` -- ${detail}` : ''}`); }
}

const pre = new Database(DB_PATH);
assert(pre.prepare("SELECT COUNT(*) AS n FROM bots WHERE launch_profile = 'agent_deck'").get().n === 3, 'fixture carries three pre-NOT-543 agent_deck rows');
const beforeDump = JSON.stringify(dumpOf(pre));
const beforeReg = pre.prepare(`SELECT id, name, agent, ${REGISTRATION_COLUMNS} FROM bots ORDER BY id`).all();
const beforeIds = pre.prepare('SELECT id, name, agent FROM bots ORDER BY id').all();
const grantsBefore = fs.readFileSync(GRANTS_PATH, 'utf8');
pre.close();

// The parent's own database load runs the one-way cutover migration.
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const def = jiti('../lib/bot-definition.ts');
const dispatch = jiti('../lib/agent-dispatch.ts');
const botsRoute = jiti('../app/api/bots/route.ts');
const raw = db.default;

function jsonRequest(method, body) {
  return new Request('http://localhost:43123/api/bots', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function main() {
  console.log('\n(1) Valid rows migrate one way, identity and history kept');
  const after = raw.prepare('SELECT * FROM bots ORDER BY id').all();
  for (const row of beforeReg) {
    const got = after.find(r => r.id === row.id);
    assert(got.launch_profile === 'direct' && got.deck_id === null && got.working_directory === null && got.needs_deck_selection === 0,
      `${row.name}: direct with deck configuration cleared`);
    const kept = got.agent === row.agent && got.runtime_connection_id === row.runtime_connection_id
      && got.session_scope_kind === row.session_scope_kind && got.session_scope_items === row.session_scope_items
      && got.default_workspace === row.default_workspace && got.policy_mode === row.policy_mode
      && got.allow_new_sessions === row.allow_new_sessions && got.allow_resume_with_edits === row.allow_resume_with_edits
      && got.home_session_id === row.home_session_id;
    assert(kept, `${row.name}: Agent ID, connection, scope, policy, home/default kept`);
  }
  assert(JSON.stringify(raw.prepare('SELECT id, name, agent FROM bots ORDER BY id').all()) === JSON.stringify(beforeIds), 'Agent identity preserved verbatim');
  const decked = db.bots.getById(beforeIds.find(b => b.name === 'Decked').id);
  assert(decked.home_session_id !== null && decked.default_workspace === `${MIGWS}/app` && decked.policy_mode === 'workspace_write',
    'valid agent_deck row keeps its home session, default workspace, and write policy');
  assert(JSON.stringify(JSON.parse(decked.session_scope_items)) === JSON.stringify([MIGWS]), 'valid row keeps its exact workspace scope');
  const afterDump = dumpOf(raw);
  const beforeParsed = JSON.parse(beforeDump);
  const sharedEqual = Object.keys(beforeParsed).every(name => JSON.stringify(afterDump[name]) === JSON.stringify(beforeParsed[name]));
  // Lazily created tables (session shares/contexts) appear on first module
  // import with no rows; that is schema creation, not a data change.
  const extrasEmpty = Object.keys(afterDump).filter(name => !(name in beforeParsed)).every(name => afterDump[name].length === 0);
  assert(sharedEqual && extrasEmpty, 'every non-bots table preserved byte-for-byte (conversations, requests, attempts, bindings, grants, snapshots, events)');
  assert(raw.prepare("SELECT COUNT(*) AS n FROM session_bindings WHERE agent_id = ?").get(decked.id).n === 1, 'session binding kept');
  assert(raw.prepare("SELECT COUNT(*) AS n FROM wake_grants WHERE id = 'wg-mig'").get().n === 1, 'wake grant kept');
  assert(fs.readFileSync(GRANTS_PATH, 'utf8') === grantsBefore, 'service-grant file untouched');

  console.log('\n(2) Deck configuration ceased: absent from reads, rejected on write');
  const view = db.serializeAgent(decked);
  assert(view.launchable === true && view.launch_blocker === null, 'migrated valid row reads launchable');
  for (const key of ['launch_profile', 'deck_id', 'deck_name', 'working_directory', 'needs_deck_selection']) {
    assert(!(key in view), `read shape has no ${key}`);
  }
  const rowBefore = JSON.stringify(raw.prepare('SELECT * FROM bots WHERE id = ?').get(decked.id));
  for (const patch of [{ deck_id: 'deck-new' }, { launch_profile: 'agent_deck' }, { working_directory: '/tmp/x' }, { deck_name: 'x' }]) {
    const res = await botsRoute.PATCH(jsonRequest('PATCH', { id: decked.id, ...patch }));
    const json = await res.json();
    assert(res.status === 400 && json.errors.includes(def.REMOVED_LAUNCH_FIELD_ERROR), `migrated row rejects ${Object.keys(patch)[0]} (${res.status})`);
  }
  assert(JSON.stringify(raw.prepare('SELECT * FROM bots WHERE id = ?').get(decked.id)) === rowBefore, 'rejected deck writes changed nothing');
  const prepared = dispatch.prepareDispatch({ bot: decked, history: [] });
  assert(prepared.adapter.name === 'session-provider', 'migrated coding Agent dispatches direct');

  console.log('\n(3) Invalid rows stay readable and unlaunchable, never on Agent Deck');
  const invalid = db.bots.getById(beforeIds.find(b => b.name === 'Invalid').id);
  const invalidView = db.serializeAgent(invalid);
  assert(invalidView.launchable === false && invalidView.launch_blocker === 'session_scope' && invalidView.session_scope === null, 'invalid row reads unlaunchable with its blocker');
  assert(invalid.launch_profile === 'direct' && invalid.deck_id === null, 'invalid row carries no deck execution path');
  let failure = null;
  try {
    dispatch.prepareDispatch({ bot: invalid, history: [] });
  } catch (error) { failure = error; }
  assert(failure && failure.code === 'agent_unavailable' && failure.message === dispatch.SESSION_SCOPE_MISSING, 'invalid row dispatch fails closed with a direct-runtime reason');

  console.log('\n(4) Idempotent');
  const firstPass = JSON.stringify(raw.prepare('SELECT * FROM bots ORDER BY id').all());
  execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    createJiti(${JSON.stringify(path.join(ROOT, 'loader.js'))})('./lib/db.ts');
  `], { cwd: ROOT, env: process.env });
  const again = new Database(DB_PATH);
  assert(JSON.stringify(again.prepare('SELECT * FROM bots ORDER BY id').all()) === firstPass, 'reload changes nothing');
  again.close();

  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(GRANTS_PATH, { force: true });
  fs.rmSync(MIGWS, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\ntest:direct-migration: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\ntest:direct-migration: all assertions passing');
}

main().catch(error => {
  console.error(`FAIL: direct-migration test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
