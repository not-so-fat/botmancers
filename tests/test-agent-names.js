#!/usr/bin/env node
// NOT-478: instance-unique Agent names for deterministic Wake routing.
// Proves: (1) the canonical key trims Unicode whitespace, folds case
// (Unicode included), and NFC-normalizes; (2) the database enforces one
// key per Agent through a unique index, rejecting raw duplicate writes;
// (3) create, import, duplicate, and rename paths (HTTP routes and the
// chat birth paths) all return the same field-specific conflict; (4) Wake
// resolution yields exactly one stable Agent ID and stores its display-name
// snapshot, before and after a rename; (5) a legacy database with
// duplicate names migrates deterministically (oldest keeps its name, later
// ones get collision-safe -2/-3/...), keeps every Agent ID and all history,
// records a durable owner-visible report, and is idempotent on reload.
// Self-contained: isolated SQLite files, real route handlers in-process,
// no dev server, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = require('./support/repo-root');
const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-names-test-${process.pid}.db`);
const LEGACY_DB_PATH = path.join(os.tmpdir(), `botmancers-agent-names-legacy-${process.pid}.db`);
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-names-home-'));
for (const file of [DB_PATH, LEGACY_DB_PATH]) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HOME = HOME_DIR;

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const names = jiti('../lib/agent-names.ts');
const db = jiti('../lib/db.ts');
const birth = jiti('../lib/birth.ts');
const botsRoute = jiti('../app/api/bots/route.ts');
const importRoute = jiti('../app/api/bots/import/route.ts');
const migrationsRoute = jiti('../app/api/bots/name-migrations/route.ts');

const sqlite = db.default;
const { bots, conversations, messages, wakeTargets, resolveWakeTarget } = db;

let failures = 0;
function assert(condition, label, detail) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); }
  return condition;
}

function request(handler, method, url, body) {
  return handler(new Request(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
const json = async res => { try { return await res.json(); } catch { return null; } };

let clock = 1_700_000_000_000;
function makeBot(name) {
  clock += 1000;
  return bots.create({ name, title: '', description: '' }, { created_at: clock });
}

function expectConflict(body, field, label) {
  assert(
    !!body && body.code === 'agent_name_conflict' && body.field === field &&
      typeof body.error === 'string' && body.error.includes('already exists') && !/SQLITE|constraint/i.test(body.error),
    `${label}: field-specific agent_name_conflict on "${field}"`,
    JSON.stringify(body)
  );
}

async function main() {
  console.log('NOT-478 agent-names test (isolated DBs)');

  // ---- (1) canonical key ---------------------------------------------------
  console.log('\n(1) Canonical name key');
  const { agentNameKey, agentDisplayName } = names;
  assert(agentNameKey('  Dev  ') === agentNameKey('dev'), 'surrounding spaces and case are ignored');
  assert(agentNameKey(' Dev　') === 'dev', 'Unicode whitespace (NBSP, ideographic space) is trimmed');
  assert(agentNameKey('ÄRZTE') === agentNameKey('ärzte'), 'non-ASCII case folds');
  assert(agentNameKey('Café') === agentNameKey('Café'), 'decomposed and composed forms collide (NFC)');
  assert(agentNameKey('Dev Ops') !== agentNameKey('DevOps'), 'inner spacing still distinguishes names');
  assert(agentDisplayName('  Mixed Case ') === 'Mixed Case', 'display name keeps casing, drops surrounding spaces');

  // ---- (2) database enforcement -------------------------------------------
  console.log('\n(2) Database enforcement');
  const index = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_bots_name_key'").get();
  assert(!!index && /CREATE UNIQUE INDEX/i.test(index.sql) && /bots\s*\(\s*name_key\s*\)/i.test(index.sql), 'unique index idx_bots_name_key on bots(name_key)', index && index.sql);
  const indexInfo = sqlite.prepare("PRAGMA index_list('bots')").all().find(row => row.name === 'idx_bots_name_key');
  assert(!!indexInfo && indexInfo.unique === 1, 'PRAGMA index_list reports idx_bots_name_key as unique');

  const dev = makeBot('  Dev ');
  assert(dev.name === 'Dev' && dev.name_key === 'dev', 'create stores trimmed display name and key', JSON.stringify({ name: dev.name, key: dev.name_key }));
  for (const variant of ['dev', 'DEV', '  dEv  ', ' Dev']) {
    let error = null;
    try { makeBot(variant); } catch (e) { error = e; }
    assert(error instanceof names.AgentNameConflictError && error.conflictingAgentId === dev.id, `repository rejects ${JSON.stringify(variant)} as a conflict with Dev`);
  }
  const arzte = makeBot('Ärzte');
  let unicodeError = null;
  try { makeBot('ärzte'); } catch (e) { unicodeError = e; }
  assert(unicodeError instanceof names.AgentNameConflictError, 'repository rejects a Unicode case variant');
  let rawError = null;
  try {
    sqlite.prepare("INSERT INTO bots (id, name, name_key, title, description, created_at) VALUES ('raw-dup', 'DEV', 'dev', '', '', 1)").run();
  } catch (e) { rawError = e; }
  assert(!!rawError && /UNIQUE constraint failed: bots\.name_key/.test(rawError.message), 'database itself rejects a raw duplicate key', rawError && rawError.message);
  assert(sqlite.prepare("SELECT COUNT(*) AS n FROM bots WHERE name_key = 'dev'").get().n === 1, 'exactly one row holds key "dev"');
  assert(sqlite.prepare('SELECT COUNT(*) AS n FROM bots WHERE name_key IS NULL').get().n === 0, 'every Agent row has a name key');

  // ---- (3) write paths -----------------------------------------------------
  console.log('\n(3) Write paths return one conflict shape');
  const before = sqlite.prepare('SELECT COUNT(*) AS n FROM bots').get().n;

  const nameConn = db.runtimeConnections.ensureLocal('codex');
  const createRes = await request(botsRoute.POST, 'POST', '/api/bots', {
    name: ' dev ',
    runtime_connection_id: nameConn,
    session_scope: { kind: 'all_provider_sessions' },
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
  });
  assert(createRes.status === 409, `POST /api/bots duplicate -> 409 (got ${createRes.status})`);
  const createBody = await json(createRes);
  expectConflict(createBody, 'name', 'create');
  assert(createBody.conflicting_agent_id === dev.id, 'create conflict names the existing Agent ID');

  const other = makeBot('Reviewer');
  const renameRes = await request(botsRoute.PATCH, 'PATCH', '/api/bots', { id: other.id, name: 'DEV', title: 'Changed title' });
  assert(renameRes.status === 409, `PATCH rename onto another Agent's name -> 409 (got ${renameRes.status})`);
  expectConflict(await json(renameRes), 'name', 'rename');
  const untouched = bots.getById(other.id);
  assert(untouched.name === 'Reviewer' && untouched.title === '', 'rejected rename writes nothing (transaction rolled back)');
  const recaseRes = await request(botsRoute.PATCH, 'PATCH', '/api/bots', { id: other.id, name: '  REVIEWER ' });
  const recased = await json(recaseRes);
  assert(recaseRes.status === 200 && recased.name === 'REVIEWER', 'an Agent may re-case its own name (trimmed on save)', JSON.stringify(recased));

  const importBody = {
    schema_version: jiti('../app/api/import-capabilities/route.ts').IMPORT_SCHEMA_VERSION,
    operation_id: `op-names-${process.pid}`,
    source_provider: 'marketplace',
    template_id: 'tmpl-names',
    template_url: 'https://example.test/tmpl-names',
    bot: { name: 'dEV', title: 'Imported', description: 'Imported rules.' },
  };
  const importRes = await request(importRoute.POST, 'POST', '/api/bots/import', importBody);
  assert(importRes.status === 409, `POST /api/bots/import duplicate -> 409 (got ${importRes.status})`);
  expectConflict(await json(importRes), 'bot.name', 'import');

  const plain = await birth.createPlainSpecialist('DEV', 'Writes code.');
  assert(!plain.ok && plain.reason === 'collision', 'chat create (plain) reports collision');
  const fromTemplate = await birth.importSpecialistFromTemplate(' dev', {
    template_id: 'tmpl-chat', template_url: 'https://example.test/tmpl-chat', source_provider: 'marketplace', title: 'T', description: 'D',
  }, { operationId: `op-chat-${process.pid}` });
  assert(!fromTemplate.ok && fromTemplate.reason === 'collision', 'chat import (template) reports collision', JSON.stringify(fromTemplate));
  const dup = await birth.duplicateSpecialist('Reviewer', 'Dev');
  assert(!dup.ok && dup.reason === 'collision', 'chat duplicate reports collision');
  const dupOk = await birth.duplicateSpecialist('reviewer', '  Reviewer Two ');
  assert(dupOk.ok && dupOk.bot.name === 'Reviewer Two' && dupOk.source.id === other.id, 'chat duplicate resolves its source by key and stores a trimmed name');
  assert(sqlite.prepare('SELECT COUNT(*) AS n FROM bots').get().n === before + 2, 'only the non-conflicting writes added rows');
  assert(names.agentNameConflictMessage('dev').includes('already exists'), 'chat replies share the conflict message');

  // ---- (4) Wake resolution and persistence --------------------------------
  console.log('\n(4) Wake target resolution');
  const resolved = resolveWakeTarget('  dEv ');
  assert(resolved.ok && resolved.agentId === dev.id && resolved.displayName === 'Dev', 'resolves a case/space variant to exactly one stable ID', JSON.stringify(resolved));
  assert(!resolveWakeTarget('Nobody').ok && resolveWakeTarget('Nobody').reason === 'not_found', 'unknown name is not_found');
  assert(resolveWakeTarget('ÄRZTE').ok && resolveWakeTarget('ÄRZTE').agentId === arzte.id, 'Unicode case variant resolves');

  const callerConv = conversations.getByBotId(other.id);
  const handoff = messages.create(callerConv.id, 'bot', '[Handing off to Dev]\nImplement it.', other.id);
  const accepted = wakeTargets.accept({ conversationId: callerConv.id, requestedTarget: 'DEV', sourceBotId: other.id, sourceMessageId: handoff.id });
  assert(accepted.ok && accepted.wake.target_bot_id === dev.id && accepted.wake.target_name_snapshot === 'Dev' && accepted.wake.requested_target === 'DEV',
    'accepted Wake stores stable target ID and display-name snapshot', JSON.stringify(accepted));
  const rejected = wakeTargets.accept({ conversationId: callerConv.id, requestedTarget: 'Ghost', sourceBotId: other.id });
  assert(!rejected.ok && rejected.reason === 'not_found', 'unresolvable Wake target persists nothing');

  const devConv = conversations.getByBotId(dev.id);
  const devMsg = messages.create(devConv.id, 'bot', 'I am Dev.', dev.id);
  const renamed = await request(botsRoute.PATCH, 'PATCH', '/api/bots', { id: dev.id, name: 'Builder' });
  assert(renamed.status === 200, 'rename target Dev -> Builder');
  const afterRename = resolveWakeTarget('builder');
  assert(afterRename.ok && afterRename.agentId === dev.id && afterRename.displayName === 'Builder', 'new name resolves to the same Agent ID');
  assert(!resolveWakeTarget('Dev').ok, 'old name no longer resolves');
  const stored = wakeTargets.listByConversation(callerConv.id);
  assert(stored.length === 1 && stored[0].target_bot_id === dev.id && stored[0].target_name_snapshot === 'Dev', 'historical Wake keeps its target ID and acceptance-time snapshot');
  const later = wakeTargets.accept({ conversationId: callerConv.id, requestedTarget: 'Builder', sourceBotId: other.id });
  assert(later.ok && later.wake.target_bot_id === dev.id && later.wake.target_name_snapshot === 'Builder', 'post-rename Wake snapshots the new name for the same ID');
  assert(messages.getById(devMsg.id).sender_id === dev.id && messages.getById(devMsg.id).content === 'I am Dev.', 'historical message keeps sender ID and text after rename');
  assert(messages.getById(handoff.id).content === '[Handing off to Dev]\nImplement it.', 'historical handoff text is not rewritten');
  assert(conversations.getByBotId(dev.id).id === devConv.id, 'renamed Agent keeps its conversation');
  const reuse = makeBot('dev');
  assert(reuse.id !== dev.id && resolveWakeTarget('Dev').agentId === reuse.id, 'a released name may be taken by a new Agent');
  assert(wakeTargets.listByConversation(callerConv.id)[0].target_bot_id === dev.id, 'old Wake still points to the original Agent ID');

  // ---- (5) legacy duplicate migration -------------------------------------
  console.log('\n(5) Legacy duplicate migration');
  const Database = require('better-sqlite3');
  const legacy = new Database(LEGACY_DB_PATH);
  legacy.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, bot_id TEXT, group_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE processing_queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
  `);
  const t = 1_600_000_000_000;
  // Insertion order deliberately differs from age order.
  const fixtures = [
    { id: 'b-dev-upper', name: 'DEV', at: t + 30, expect: 'DEV-4' },
    { id: 'b-dev', name: 'Dev', at: t + 10, expect: 'Dev' },
    { id: 'b-dev-space', name: ' dev ', at: t + 20, expect: 'dev-3' },
    { id: 'b-dev-2', name: 'Dev-2', at: t + 40, expect: 'Dev-2' },
    { id: 'b-arzte', name: 'Ärzte', at: t + 50, expect: 'Ärzte' },
    { id: 'b-arzte-lower', name: 'ärzte', at: t + 60, expect: 'ärzte-2' },
    { id: 'b-tie-b', name: 'Tie', at: t + 70, expect: 'Tie-2' },
    { id: 'b-tie-a', name: 'tie', at: t + 70, expect: 'tie' },
    { id: 'b-solo', name: 'Solo', at: t + 80, expect: 'Solo' },
  ];
  for (const row of fixtures) {
    legacy.prepare('INSERT INTO bots (id, name, title, description, avatar, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(row.id, row.name, 'Legacy', 'Legacy rules.', row.at);
    legacy.prepare("INSERT INTO conversations (id, type, bot_id, created_at) VALUES (?, 'bot', ?, ?)").run(`conv-${row.id}`, row.id, row.at);
    legacy.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, 'user', NULL, ?, ?)").run(`msg-u-${row.id}`, `conv-${row.id}`, `WAKE ${row.name}: hello`, row.at);
    legacy.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, 'bot', ?, ?, ?)").run(`msg-b-${row.id}`, `conv-${row.id}`, row.id, `I am ${row.name}`, row.at + 1);
    legacy.prepare("INSERT INTO processing_queue (id, conversation_id, bot_id, status, created_at) VALUES (?, ?, ?, 'completed', ?)").run(`q-${row.id}`, `conv-${row.id}`, row.id, row.at);
  }
  // NOT-477: the queue rows end up in legacy_processing_queue_archive.
  const historyOf = (conn, queueTable) => ({
    conversations: conn.prepare('SELECT id, bot_id FROM conversations ORDER BY id').all(),
    messages: conn.prepare('SELECT id, conversation_id, sender_id, content, created_at FROM messages ORDER BY id').all(),
    queue: conn.prepare(`SELECT id, conversation_id, bot_id FROM ${queueTable} ORDER BY id`).all(),
  });
  const historyBefore = historyOf(legacy, 'processing_queue');
  const idsBefore = legacy.prepare('SELECT id, created_at FROM bots ORDER BY id').all();
  legacy.close();

  const loadLegacy = () => execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    createJiti(${JSON.stringify(path.join(ROOT, 'loader.js'))})('./lib/db.ts');
  `], { cwd: ROOT, env: { ...process.env, BOTMANCERS_DB_PATH: LEGACY_DB_PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  loadLegacy();

  const after = new Database(LEGACY_DB_PATH);
  const rows = Object.fromEntries(after.prepare('SELECT id, name, name_key, created_at FROM bots').all().map(row => [row.id, row]));
  for (const row of fixtures) {
    const got = rows[row.id];
    console.log(`  before ${row.id}: ${JSON.stringify(row.name)}  after: ${JSON.stringify(got && got.name)}`);
    assert(!!got && got.name === row.expect && got.name_key === names.agentNameKey(row.expect), `${row.id} -> ${JSON.stringify(row.expect)}`, JSON.stringify(got));
  }
  assert(JSON.stringify(after.prepare('SELECT id, created_at FROM bots ORDER BY id').all()) === JSON.stringify(idsBefore), 'every Agent ID (and created_at) survives; none merged or deleted');
  assert(JSON.stringify(historyOf(after, 'legacy_processing_queue_archive')) === JSON.stringify(historyBefore), 'conversations, messages (text included), and archived queue rows keep their Agent IDs unchanged');
  const orphans = after.prepare(
    "SELECT COUNT(*) AS n FROM messages m WHERE m.sender_type = 'bot' AND m.sender_id NOT IN (SELECT id FROM bots)"
  ).get().n + after.prepare('SELECT COUNT(*) AS n FROM conversations c WHERE c.bot_id IS NOT NULL AND c.bot_id NOT IN (SELECT id FROM bots)').get().n;
  assert(orphans === 0, 'referential integrity: no message or conversation points at a missing Agent');
  const keys = after.prepare('SELECT name_key FROM bots').all().map(row => row.name_key);
  assert(keys.every(Boolean) && new Set(keys).size === keys.length, 'every migrated Agent has one distinct name key');
  assert(!!after.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bots_name_key'").get(), 'unique index exists after migration');

  const report = after.prepare('SELECT bot_id, previous_name, new_name, name_key, kept_bot_id, reason FROM agent_name_migrations ORDER BY bot_id').all();
  const expectedReport = [
    { bot_id: 'b-arzte-lower', previous_name: 'ärzte', new_name: 'ärzte-2', name_key: 'ärzte', kept_bot_id: 'b-arzte', reason: 'duplicate_name' },
    { bot_id: 'b-dev-space', previous_name: ' dev ', new_name: 'dev-3', name_key: 'dev', kept_bot_id: 'b-dev', reason: 'duplicate_name' },
    { bot_id: 'b-dev-upper', previous_name: 'DEV', new_name: 'DEV-4', name_key: 'dev', kept_bot_id: 'b-dev', reason: 'duplicate_name' },
    { bot_id: 'b-tie-b', previous_name: 'Tie', new_name: 'Tie-2', name_key: 'tie', kept_bot_id: 'b-tie-a', reason: 'duplicate_name' },
  ];
  assert(JSON.stringify(report) === JSON.stringify(expectedReport), 'durable report lists each automatic rename with affected and kept Agent IDs', JSON.stringify(report));
  after.close();

  loadLegacy();
  const again = new Database(LEGACY_DB_PATH);
  assert(again.prepare('SELECT COUNT(*) AS n FROM agent_name_migrations').get().n === expectedReport.length, 'reloading is idempotent: no new renames or report rows');
  assert(JSON.stringify(Object.fromEntries(again.prepare('SELECT id, name FROM bots').all().map(r => [r.id, r.name]))) ===
    JSON.stringify(Object.fromEntries(Object.values(rows).map(r => [r.id, r.name]))), 'names unchanged on reload');
  again.close();

  // Owner-visible API over the same report (current instance had no renames).
  const reportRes = await migrationsRoute.GET();
  const reportBody = await json(reportRes);
  assert(reportRes.status === 200 && Array.isArray(reportBody.renames) && reportBody.renames.length === 0, 'GET /api/bots/name-migrations returns the report (empty for a clean instance)');

  // Pure planner: deterministic regardless of input order.
  const shuffled = fixtures.map(row => ({ id: row.id, name: row.name, created_at: row.at, name_key: null }));
  const planA = names.planNameMigration(shuffled);
  const planB = names.planNameMigration([...shuffled].reverse());
  assert(JSON.stringify(planA) === JSON.stringify(planB), 'migration plan is independent of row order');

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
}

main()
  .catch(error => { failures++; console.error(error); })
  .finally(() => {
    for (const file of [DB_PATH, LEGACY_DB_PATH]) {
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.rmSync(file + suffix, { force: true }); } catch { /* best effort */ }
      }
    }
    try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(failures === 0 ? 0 : 1);
  });
