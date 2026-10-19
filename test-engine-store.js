#!/usr/bin/env node
// NOT-463: canonical core-engine persistence contract (lib/engine-store).
// Proves: a fresh database gets distinct work_requests, work_attempts,
// session_bindings, and engine_events with keys, indexes, and enforced
// foreign keys; create-or-get is idempotent (also across connections);
// state transitions are compare-and-set, reject invalid/stale moves, and
// roll back without partial writes; per-request event sequences are
// unique and contiguous; attempts keep launch snapshots and opaque
// external ids verbatim. A child process upgrades a populated legacy
// database (pre-NOT-463 tables, then the last pre-NOT-477 engine schema
// with live canonical records) and reconciles every record before and
// after: conversations, messages, canonical requests, attempts, session
// bindings, and events are unchanged, every agent_requests row is either
// copied with its outcome or kept in the archive for a named reason, every
// processing_queue row is reconciled into its Work Request (or a new UI
// continuation turn) or kept in the archive for a named reason, and both
// archives hold every original row verbatim (NOT-477). Self-contained:
// isolated SQLite files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SCENARIO = process.env.ENGINE_STORE_SCENARIO || 'fresh';
const DB_PATH = path.join(os.tmpdir(), `botmancers-engine-store-${SCENARIO}-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb(DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const Database = require('better-sqlite3');
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
function throwsMatching(fn, pattern, label) {
  try {
    fn();
  } catch (error) {
    return assert(pattern.test(String(error && error.message)), `${label} (got: ${error && error.message})`);
  }
  return assert(false, `${label} (did not throw)`);
}

function finish() {
  removeDb(DB_PATH);
  if (failures > 0) {
    console.log(`\n${SCENARIO}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`\n${SCENARIO}: all checks passed`);
}

if (SCENARIO === 'legacy') runLegacy();
else runFresh();

function runFresh() {
  const db = jiti('./lib/db.ts');
  const store = jiti('./lib/engine-store.ts');
  const sqlite = db.default;
  const { engine, bots, conversations } = db;
  const { EngineStoreError } = store;
  const count = (sql, ...args) => sqlite.prepare(sql).get(...args).n;

  console.log('Schema: fresh database');
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  for (const name of ['work_requests', 'work_attempts', 'session_bindings', 'engine_events', 'schema_migrations']) {
    assert(tables.has(name), `table ${name} exists`);
  }
  assert(tables.has('delegation_chains'), 'NOT-477: durable delegation_chains exists');
  for (const name of ['agent_requests', 'agent_request_events', 'legacy_agent_requests_archive', 'legacy_agent_request_events_archive', 'processing_queue', 'legacy_processing_queue_archive']) {
    assert(!tables.has(name), `NOT-477: a fresh database has no ${name} table`);
  }
  const columns = table => new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const expectColumns = (table, names) => {
    const have = columns(table);
    const missing = names.filter(name => !have.has(name));
    assert(missing.length === 0, `${table} has ${names.join(', ')}${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
  };
  expectColumns('work_requests', [
    'id', 'source_conversation_id', 'source_event_id', 'requester_kind', 'requester_id', 'target_agent_id',
    'intent', 'execution_kind', 'tool_profile', 'parent_request_id', 'root_request_id', 'wake_event_id', 'depth',
    'idempotency_key', 'request_hash', 'policy_snapshot', 'state', 'state_reason', 'result', 'error_code',
    'error_message', 'version', 'legacy_agent_request_id', 'created_at', 'updated_at', 'terminal_at', 'executor',
  ]);
  expectColumns('work_attempts', [
    'id', 'request_id', 'attempt_number', 'kind', 'adapter', 'tool_profile', 'launch_snapshot', 'launch_snapshot_hash',
    'resumed_session_binding_id', 'external_run_id', 'external_session_id', 'outcome', 'output', 'error_category',
    'error_message', 'artifacts', 'started_at', 'finished_at',
  ]);
  expectColumns('session_bindings', [
    'id', 'agent_id', 'adapter', 'conversation_id', 'request_id', 'external_session_id', 'source_attempt_id',
    'created_at', 'released_at',
  ]);
  expectColumns('engine_events', ['id', 'request_id', 'sequence', 'attempt_id', 'type', 'data', 'created_at']);

  const fks = table => sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => `${row.from}->${row.table}.${row.to}`);
  const expectFks = (table, wanted) => {
    const have = new Set(fks(table));
    assert(wanted.every(fk => have.has(fk)), `${table} declares ${wanted.join(', ')}`);
  };
  expectFks('work_requests', [
    'source_conversation_id->conversations.id', 'target_agent_id->bots.id',
    'parent_request_id->work_requests.id', 'root_request_id->work_requests.id',
  ]);
  expectFks('work_attempts', ['request_id->work_requests.id', 'resumed_session_binding_id->session_bindings.id']);
  expectFks('session_bindings', ['agent_id->bots.id', 'conversation_id->conversations.id', 'request_id->work_requests.id', 'source_attempt_id->work_attempts.id']);
  expectFks('engine_events', ['request_id->work_requests.id', 'attempt_id->work_attempts.id']);

  const uniqueIndexColumns = table => sqlite.prepare(`PRAGMA index_list(${table})`).all()
    .filter(index => index.unique)
    .map(index => ({ name: index.name, partial: index.partial, cols: sqlite.prepare(`PRAGMA index_xinfo(${index.name})`).all().filter(c => c.key).map(c => c.name === null ? 'expr' : c.name).join(',') }));
  const hasUnique = (table, cols, partial) => uniqueIndexColumns(table).some(index => index.cols === cols && (partial === undefined || !!index.partial === partial));
  assert(hasUnique('work_requests', 'requester_kind,requester_id,idempotency_key'), 'work_requests: unique (requester, idempotency_key)');
  assert(hasUnique('engine_events', 'request_id,sequence'), 'engine_events: unique (request_id, sequence)');
  assert(hasUnique('work_attempts', 'request_id,attempt_number'), 'work_attempts: unique (request_id, attempt_number)');
  assert(hasUnique('work_attempts', 'request_id', true), 'work_attempts: at most one open attempt per request (partial unique)');
  assert(hasUnique('session_bindings', 'agent_id,adapter,expr,expr', true), 'session_bindings: one active binding per scope (partial unique)');
  const migrations = sqlite.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  assert(migrations.map(m => m.version).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19' && store.ENGINE_SCHEMA_VERSION === 19, `schema_migrations records versions 1..${store.ENGINE_SCHEMA_VERSION}`);
  const edges = sqlite.prepare('SELECT from_state || \'>\' || to_state AS e FROM work_request_transitions').all().map(row => row.e);
  assert(edges.includes('queued>running') && !edges.includes('completed>running'), 'transition table seeded from WORK_REQUEST_TRANSITIONS');

  // Fixtures.
  const builder = bots.create({ deck_id: 'deck-1', name: 'Builder', title: '', description: '' });
  const reviewer = bots.create({ deck_id: 'deck-1', name: 'Reviewer', title: '', description: '' });
  const conv = conversations.getByBotId(builder.id);
  const person = { kind: 'person', id: 'local-owner' };
  let eventCounter = 0;
  const baseInput = (overrides = {}) => ({
    sourceConversationId: conv.id,
    sourceEventId: `msg-${++eventCounter}`,
    requester: person,
    targetAgentId: builder.id,
    intent: 'Explain lib/db.ts',
    executionKind: 'conversation',
    toolProfile: 'readonly',
    idempotencyKey: `key-${eventCounter}`,
    ...overrides,
  });

  console.log('\nForeign keys are enforced');
  const now = Date.now();
  const rawRequest = (id, convId, botId, parent = null) => sqlite.prepare(`
    INSERT INTO work_requests (id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
      intent, execution_kind, tool_profile, parent_request_id, root_request_id, idempotency_key, request_hash, policy_snapshot,
      state, created_at, updated_at)
    VALUES (?, ?, 'e', 'person', 'p', ?, 'i', 'conversation', 'readonly', ?, ?, ?, 'h', '{}', 'queued', ?, ?)
  `).run(id, convId, botId, parent, id, `raw-${id}`, now, now);
  throwsMatching(() => rawRequest('r-x1', 'no-such-conversation', builder.id), /source_conversation_id/, 'raw work_request with unknown conversation is rejected');
  throwsMatching(() => rawRequest('r-x2', conv.id, 'no-such-bot'), /target_agent_id/, 'raw work_request with unknown target agent is rejected');
  throwsMatching(() => rawRequest('r-x3', conv.id, builder.id, 'no-such-parent'), /parent_request_id/, 'raw work_request with unknown parent is rejected');
  throwsMatching(() => sqlite.prepare("INSERT INTO engine_events (id, request_id, sequence, type, created_at) VALUES ('ev', 'nope', 1, 't', 1)").run(), /engine_events.request_id/, 'raw engine_event for unknown request is rejected');
  throwsMatching(() => sqlite.prepare("INSERT INTO work_attempts (id, request_id, attempt_number, kind, adapter, tool_profile, launch_snapshot, launch_snapshot_hash, started_at) VALUES ('a', 'nope', 1, 'launch', 'x', 'readonly', '{}', 'h', 1)").run(), /work_attempts.request_id/, 'raw attempt for unknown request is rejected');
  throwsMatching(() => sqlite.prepare("INSERT INTO session_bindings (id, agent_id, adapter, conversation_id, external_session_id, created_at) VALUES ('b', ?, 'y', 'nope', 's', 1)").run(builder.id), /session_bindings.conversation_id/, 'raw binding for unknown conversation is rejected');
  assert(count('SELECT COUNT(*) AS n FROM work_requests') === 0, 'no rows were written by rejected inserts');
  throwsCode(() => engine.createOrGetWorkRequest(baseInput({ parentRequestId: 'missing' })), 'not_found', 'repository rejects an unknown parent request');
  throwsMatching(() => engine.createOrGetWorkRequest(baseInput({ targetAgentId: 'missing-agent' })), /target_agent_id/, 'repository rejects an unknown target agent');

  console.log('\nTool authority is explicit and fails closed');
  throwsCode(() => engine.createOrGetWorkRequest(baseInput({ executionKind: 'implementation', toolProfile: 'readonly' })), 'invalid_input', 'implementation with readonly authority is rejected');
  throwsCode(() => engine.createOrGetWorkRequest(baseInput({ executionKind: 'review', toolProfile: 'edit' })), 'invalid_input', 'review with edit authority is rejected');
  throwsCode(() => engine.createOrGetWorkRequest(baseInput({ toolProfile: undefined })), 'invalid_input', 'a missing tool profile is never defaulted');
  assert(count('SELECT COUNT(*) AS n FROM work_requests') === 0, 'no request rows after rejected intake');

  console.log('\nDuplicate intake is idempotent');
  const intake = baseInput({ idempotencyKey: 'wake:msg-a:builder', sourceEventId: 'msg-a', policy: { deck_id: 'deck-1' } });
  const first = engine.createOrGetWorkRequest(intake);
  const second = engine.createOrGetWorkRequest({ ...intake });
  assert(first.created === true && second.created === false, 'first create returns created, repeat returns existing');
  assert(first.request.id === second.request.id, 'repeat returns the same request id');
  const otherConnection = store.createEngineStore(new Database(DB_PATH));
  const third = otherConnection.createOrGetWorkRequest({ ...intake });
  assert(third.request.id === first.request.id && third.created === false, 'a second database connection gets the same request');
  assert(count("SELECT COUNT(*) AS n FROM work_requests WHERE idempotency_key = 'wake:msg-a:builder'") === 1, 'exactly one durable work_request row');
  assert(count("SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ? AND type = 'accepted'", first.request.id) === 1, 'exactly one accepted event');
  assert(count('SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ?', first.request.id) === 1, 'repeat intake appends no events');
  throwsCode(() => engine.createOrGetWorkRequest({ ...intake, intent: 'Something else' }), 'idempotency_conflict', 'same key with a different payload is an idempotency conflict');
  const otherRequester = engine.createOrGetWorkRequest({ ...intake, requester: { kind: 'bot', id: reviewer.id } });
  assert(otherRequester.created && otherRequester.request.id !== first.request.id, 'the same key from another requester is a different request');
  const r = first.request;
  assert(r.state === 'queued' && r.version === 0 && r.terminal_at === null, 'new request is queued at version 0');
  assert(r.source_conversation_id === conv.id && r.source_event_id === 'msg-a', 'source conversation and event stored');
  assert(r.requester_kind === 'person' && r.requester_id === 'local-owner' && r.target_agent_id === builder.id, 'requester and target stored');
  assert(r.root_request_id === r.id && r.depth === 0 && r.parent_request_id === null, 'a root request is its own lineage root');
  const policy = JSON.parse(r.policy_snapshot);
  assert(policy.tool_profile === 'readonly' && policy.deck_id === 'deck-1', 'policy snapshot records tool authority and supplied policy');

  console.log('\nLineage');
  const child = engine.createOrGetWorkRequest(baseInput({
    parentRequestId: r.id, wakeEventId: 'wake-evt-1', targetAgentId: reviewer.id,
    executionKind: 'review', toolProfile: 'readonly',
  })).request;
  const grandchild = engine.createOrGetWorkRequest(baseInput({
    parentRequestId: child.id, executionKind: 'revision', toolProfile: 'edit',
  })).request;
  assert(child.parent_request_id === r.id && child.root_request_id === r.id && child.depth === 1 && child.wake_event_id === 'wake-evt-1', 'child request records parent, root, depth, and wake');
  assert(grandchild.root_request_id === r.id && grandchild.depth === 2 && grandchild.tool_profile === 'edit', 'grandchild keeps the root and its own explicit authority');
  throwsMatching(() => sqlite.prepare("UPDATE work_requests SET target_agent_id = ? WHERE id = ?").run(reviewer.id, r.id), /immutable/, 'identity and lineage cannot be rewritten');
  throwsMatching(() => sqlite.prepare("UPDATE work_requests SET tool_profile = 'edit' WHERE id = ?").run(r.id), /immutable/, 'tool authority cannot be rewritten');

  console.log('\nBlocked intake');
  const blocked = engine.createOrGetWorkRequest(baseInput({ initialState: 'blocked', stateReason: 'Agent needs an Agent Deck' })).request;
  assert(blocked.state === 'blocked' && blocked.state_reason === 'Agent needs an Agent Deck', 'an unavailable target can start blocked with a visible reason');
  assert(engine.listEvents(blocked.id).map(e => e.type).join(',') === 'accepted,state_changed', 'blocked intake records accepted then state_changed');

  console.log('\nState transitions are compare-and-set');
  const life = engine.createOrGetWorkRequest(baseInput()).request;
  let current = engine.transitionWorkRequest(life.id, { from: 'queued', to: 'running', expectedVersion: 0 });
  assert(current.state === 'running' && current.version === 1, 'queued -> running at version 0');
  current = engine.transitionWorkRequest(life.id, { from: 'running', to: 'waiting', reason: 'Asked a question' });
  current = engine.transitionWorkRequest(life.id, { from: 'waiting', to: 'running' });
  current = engine.transitionWorkRequest(life.id, { from: 'running', to: 'completed', result: { reply_message_id: 'm-9' } });
  assert(current.state === 'completed' && current.version === 4 && current.terminal_at !== null, 'running -> waiting -> running -> completed');
  assert(JSON.parse(current.result).reply_message_id === 'm-9', 'terminal result stored');
  throwsCode(() => engine.transitionWorkRequest(life.id, { from: 'completed', to: 'running' }), 'invalid_transition', 'completed -> running is invalid');
  throwsMatching(() => sqlite.prepare("UPDATE work_requests SET state_reason = 'x' WHERE id = ?").run(life.id), /terminal/, 'terminal requests cannot be modified');
  const lifeEvents = engine.listEvents(life.id);
  assert(lifeEvents.map(e => e.sequence).join(',') === '1,2,3,4,5', 'every transition appended one ordered event');
  assert(lifeEvents.slice(1).every(e => e.type === 'state_changed'), 'transition events are state_changed');
  assert(JSON.parse(lifeEvents[2].data).reason === 'Asked a question', 'transition reason recorded on the event');

  const failing = engine.createOrGetWorkRequest(baseInput()).request;
  throwsCode(() => engine.transitionWorkRequest(failing.id, { from: 'queued', to: 'completed' }), 'invalid_transition', 'queued -> completed is invalid');
  throwsMatching(() => sqlite.prepare("UPDATE work_requests SET state = 'completed', terminal_at = 1 WHERE id = ?").run(failing.id), /invalid work_requests state transition/, 'raw SQL cannot bypass the state machine');
  throwsMatching(() => sqlite.prepare("INSERT INTO work_request_transitions (from_state, to_state) VALUES ('queued', 'completed')").run(), /read-only/, 'the transition allowlist cannot be widened');
  throwsMatching(() => sqlite.prepare("UPDATE work_request_transitions SET to_state = 'completed' WHERE from_state = 'queued' AND to_state = 'running'").run(), /read-only/, 'the transition allowlist cannot be rewritten');
  throwsMatching(() => sqlite.prepare("DELETE FROM work_request_transitions WHERE from_state = 'queued' AND to_state = 'running'").run(), /read-only/, 'the transition allowlist cannot be narrowed');
  assert(count('SELECT COUNT(*) AS n FROM work_request_transitions') === Object.values(store.WORK_REQUEST_TRANSITIONS).flat().length, 'transition allowlist unchanged');
  throwsMatching(() => sqlite.prepare("UPDATE work_requests SET state = 'completed', terminal_at = 1 WHERE id = ?").run(failing.id), /invalid work_requests state transition/, 'queued -> completed still rejected by raw SQL');
  engine.transitionWorkRequest(failing.id, { from: 'queued', to: 'running' });
  const eventsBefore = engine.listEvents(failing.id).length;
  throwsCode(() => engine.transitionWorkRequest(failing.id, { from: 'queued', to: 'running' }), 'stale_state', 'a stale expected state is rejected');
  throwsCode(() => engine.transitionWorkRequest(failing.id, { from: 'running', to: 'waiting', expectedVersion: 0 }), 'stale_state', 'a stale expected version is rejected');
  const unchanged = engine.getWorkRequest(failing.id);
  assert(unchanged.state === 'running' && unchanged.version === 1, 'rejected transitions leave state and version unchanged');
  assert(engine.listEvents(failing.id).length === eventsBefore, 'rejected transitions append no events');
  const stale = otherConnection.transitionWorkRequest(failing.id, { from: 'running', to: 'failed', errorCode: 'runtime_failed', errorMessage: 'boom' });
  throwsCode(() => engine.transitionWorkRequest(failing.id, { from: 'running', to: 'completed' }), 'stale_state', 'a racing writer loses after another connection moved the request');
  assert(stale.state === 'failed' && stale.error_code === 'runtime_failed' && stale.error_message === 'boom', 'failure outcome stored');

  console.log('\nRollback leaves no partial writes');
  const rollback = engine.createOrGetWorkRequest(baseInput()).request;
  const rollbackEvents = engine.listEvents(rollback.id).length;
  try {
    engine.transaction(() => {
      engine.transitionWorkRequest(rollback.id, { from: 'queued', to: 'running' });
      engine.appendEvent(rollback.id, { type: 'dispatch_note' });
      throw new Error('injected failure');
    });
  } catch { /* expected */ }
  const afterRollback = engine.getWorkRequest(rollback.id);
  assert(afterRollback.state === 'queued' && afterRollback.version === 0, 'state change rolled back');
  assert(engine.listEvents(rollback.id).length === rollbackEvents, 'events rolled back with the transition');
  const rolledIntakeKey = 'rolled-back-intake';
  try {
    engine.transaction(() => {
      engine.createOrGetWorkRequest(baseInput({ idempotencyKey: rolledIntakeKey }));
      throw new Error('injected failure');
    });
  } catch { /* expected */ }
  assert(count('SELECT COUNT(*) AS n FROM work_requests WHERE idempotency_key = ?', rolledIntakeKey) === 0, 'rolled-back intake leaves no request');

  console.log('\nPer-request event ordering');
  const a = engine.createOrGetWorkRequest(baseInput()).request;
  const b = engine.createOrGetWorkRequest(baseInput()).request;
  for (let i = 0; i < 10; i++) {
    (i % 2 ? engine : otherConnection).appendEvent(a.id, { type: 'progress', data: { i } });
    (i % 3 ? otherConnection : engine).appendEvent(b.id, { type: 'progress', data: { i } });
  }
  const seqA = engine.listEvents(a.id).map(e => e.sequence);
  const seqB = engine.listEvents(b.id).map(e => e.sequence);
  assert(seqA.join(',') === Array.from({ length: 11 }, (_, i) => i + 1).join(','), 'request A sequences are 1..11 across two connections');
  assert(seqB.join(',') === Array.from({ length: 11 }, (_, i) => i + 1).join(','), 'request B sequences are independent 1..11');
  assert(engine.listEvents(a.id).slice(1).map(e => JSON.parse(e.data).i).join(',') === '0,1,2,3,4,5,6,7,8,9', 'event data kept in append order');
  throwsMatching(() => sqlite.prepare("INSERT INTO engine_events (id, request_id, sequence, type, created_at) VALUES ('dup', ?, 1, 't', 1)").run(a.id), /UNIQUE/, 'a duplicate sequence is rejected');
  throwsMatching(() => sqlite.prepare("UPDATE engine_events SET type = 'edited' WHERE request_id = ?").run(a.id), /append-only/, 'events are append-only');
  throwsMatching(() => sqlite.prepare('DELETE FROM engine_events WHERE request_id = ? AND sequence = 5').run(a.id), /append-only/, 'a single event cannot be deleted');
  throwsMatching(() => sqlite.prepare('DELETE FROM engine_events WHERE request_id = ?').run(a.id), /append-only/, "a request's whole log cannot be deleted directly");
  // Regression: purge authority used to be a writable marker row.
  throwsMatching(() => sqlite.prepare('INSERT INTO engine_event_purges (request_id) VALUES (?)').run(a.id), /no such table/, 'no writable purge marker exists');
  throwsMatching(() => sqlite.prepare('DELETE FROM engine_events WHERE request_id = ? AND sequence = 1').run(a.id), /append-only/, 'a single event still cannot be deleted after the marker attempt');
  throwsMatching(() => sqlite.prepare('DELETE FROM engine_events WHERE request_id = ? AND sequence = 1 AND engine_event_purge_authorized(?) = 0').run(a.id, a.id), /append-only/, 'calling the authority function does not grant purge rights');
  const bareConnection = new Database(DB_PATH);
  throwsMatching(() => bareConnection.prepare('DELETE FROM engine_events WHERE request_id = ? AND sequence = 1').run(a.id), /engine_event_purge_authorized/, 'a connection without purge authority cannot delete events');
  bareConnection.close();
  assert(engine.listEvents(a.id).map(e => e.sequence).join(',') === seqA.join(','), 'rejected deletes leave the sequence gap-free');
  throwsCode(() => engine.appendEvent('missing', { type: 'x' }), 'not_found', 'appending to an unknown request fails');

  console.log('\nAttempts');
  const work = engine.createOrGetWorkRequest(baseInput({ executionKind: 'implementation', toolProfile: 'edit', intent: 'Add a button' })).request;
  const snapshot = '{ "deck_id": "deck-1",  "prompt":"Add a button", "cwd": "/tmp/x" ,"z":[3,1] }';
  throwsCode(() => engine.createAttempt(work.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: snapshot }), 'attempt_conflict', 'attempts start only on running requests');
  engine.transitionWorkRequest(work.id, { from: 'queued', to: 'running' });
  throwsCode(() => engine.createAttempt(work.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'readonly', launchSnapshot: snapshot }), 'invalid_input', 'attempt authority must match the request');
  const attempt1 = engine.createAttempt(work.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: snapshot });
  assert(attempt1.launch_snapshot === snapshot, 'launch snapshot stored byte-for-byte (not re-serialized)');
  assert(attempt1.launch_snapshot_hash === require('crypto').createHash('sha256').update(snapshot).digest('hex'), 'launch snapshot hash is sha256 of the stored text');
  assert(attempt1.attempt_number === 1 && attempt1.external_run_id === null && attempt1.external_session_id === null, 'external ids stay null until reported (never synthesized)');
  assert(attempt1.outcome === null && attempt1.finished_at === null && attempt1.artifacts === '[]', 'open attempt has no outcome');
  throwsCode(() => engine.createAttempt(work.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: snapshot }), 'attempt_conflict', 'only one open attempt per request');
  const opaqueRun = '  run:01J/ä b?c=d  ';
  engine.recordAttemptExternalIds(attempt1.id, { externalRunId: opaqueRun });
  let reread = engine.getAttempt(attempt1.id);
  assert(reread.external_run_id === opaqueRun && reread.external_session_id === null, 'opaque run id stored verbatim; session id stays null');
  throwsMatching(() => engine.recordAttemptExternalIds(attempt1.id, { externalRunId: 'other' }), /set once/, 'a recorded run id cannot be replaced');
  throwsMatching(() => sqlite.prepare("UPDATE work_attempts SET launch_snapshot = '{}' WHERE id = ?").run(attempt1.id), /immutable/, 'launch snapshot is immutable');
  const opaqueSession = 'sess_9f::{"not":"json"';
  const artifacts = [{ kind: 'diff', ref: 'artifact://abc' }, { kind: 'file', path: 'lib/x.ts' }];
  const finished1 = engine.finishAttempt(attempt1.id, {
    outcome: 'failed', errorCategory: 'runtime_exit', errorMessage: 'exit 1', artifacts, externalSessionId: opaqueSession,
  });
  assert(finished1.outcome === 'failed' && finished1.error_category === 'runtime_exit' && finished1.error_message === 'exit 1', 'outcome and error category stored');
  assert(finished1.external_session_id === opaqueSession && finished1.external_run_id === opaqueRun, 'opaque session id round-trips without parsing');
  assert(JSON.stringify(JSON.parse(finished1.artifacts)) === JSON.stringify(artifacts) && finished1.finished_at !== null, 'artifact references round-trip');
  throwsCode(() => engine.finishAttempt(attempt1.id, { outcome: 'succeeded' }), 'attempt_conflict', 'a finished attempt cannot be finished again');
  throwsMatching(() => sqlite.prepare("UPDATE work_attempts SET error_message = 'rewritten' WHERE id = ?").run(attempt1.id), /finished work_attempts are immutable/, 'finished attempts are immutable');

  console.log('\nSession bindings and resume attempts');
  throwsCode(() => engine.createAttempt(work.id, { kind: 'resume', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: snapshot }), 'invalid_input', 'a resume attempt must name a session binding');
  throwsCode(() => engine.bindSession({ agentId: builder.id, adapter: 'agent-deck', externalSessionId: 's' }), 'invalid_input', 'a binding needs a conversation or request scope');
  const binding = engine.bindSession({ agentId: builder.id, adapter: 'agent-deck', externalSessionId: opaqueSession, conversationId: conv.id, requestId: work.id, sourceAttemptId: attempt1.id });
  assert(binding.external_session_id === opaqueSession && binding.released_at === null, 'binding stores the opaque session id');
  const active = engine.getActiveSessionBinding({ agentId: builder.id, adapter: 'agent-deck', conversationId: conv.id, requestId: work.id });
  assert(active && active.id === binding.id, 'active binding resolves by scope');
  const resumeSnapshot = { deck_id: 'deck-1', resume: true, nested: { k: [1, 2] } };
  const attemptsBeforeLaunchResume = count('SELECT COUNT(*) AS n FROM work_attempts');
  throwsCode(() => engine.createAttempt(work.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: snapshot, resumedSessionBindingId: binding.id }), 'invalid_input', 'a launch attempt cannot name a resumed session binding');
  throwsMatching(() => sqlite.prepare("INSERT INTO work_attempts (id, request_id, attempt_number, kind, adapter, tool_profile, launch_snapshot, launch_snapshot_hash, resumed_session_binding_id, started_at) VALUES ('raw-l', ?, 9, 'launch', 'agent-deck', 'edit', '{}', 'h', ?, 1)").run(work.id, binding.id), /CHECK|kind does not match/, 'raw SQL cannot record a launch that resumes a binding');
  assert(count('SELECT COUNT(*) AS n FROM work_attempts') === attemptsBeforeLaunchResume, 'rejected launch-with-binding writes no attempt');
  const attempt2 = engine.createAttempt(work.id, { kind: 'resume', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: resumeSnapshot, resumedSessionBindingId: binding.id });
  assert(attempt2.attempt_number === 2 && attempt2.resumed_session_binding_id === binding.id, 'resume is a new attempt; earlier evidence is kept');
  assert(JSON.stringify(JSON.parse(attempt2.launch_snapshot)) === JSON.stringify(resumeSnapshot), 'object snapshots serialize once and round-trip');
  const finished2 = engine.finishAttempt(attempt2.id, { outcome: 'succeeded' });
  assert(finished2.external_run_id === null && finished2.external_session_id === null && finished2.artifacts === '[]', 'nullable ids and empty artifacts round-trip');
  assert(engine.listAttempts(work.id).map(x => x.outcome).join(',') === 'failed,succeeded', 'both attempts retained in order');
  const rebound = engine.bindSession({ agentId: builder.id, adapter: 'agent-deck', externalSessionId: 'sess-2', conversationId: conv.id, requestId: work.id });
  assert(engine.getActiveSessionBinding({ agentId: builder.id, adapter: 'agent-deck', conversationId: conv.id, requestId: work.id }).id === rebound.id, 'rebinding supersedes the active binding');
  assert(sqlite.prepare('SELECT released_at FROM session_bindings WHERE id = ?').get(binding.id).released_at !== null, 'superseded binding is released, not deleted');
  throwsMatching(() => sqlite.prepare("UPDATE session_bindings SET external_session_id = 'x' WHERE id = ?").run(rebound.id), /immutable/, 'binding session value is never rewritten');
  const convOnly = engine.bindSession({ agentId: reviewer.id, adapter: 'hermes-gateway', externalSessionId: 'h-1', conversationId: conv.id });
  assert(convOnly.request_id === null, 'conversation-scoped binding without a request');
  const workTypes = engine.listEvents(work.id).map(e => e.type);
  assert(['attempt_started', 'attempt_finished', 'session_bound'].every(t => workTypes.includes(t)), 'attempt and binding boundaries are recorded as events');
  assert(engine.listEvents(work.id).filter(e => e.type.startsWith('attempt_')).every(e => e.attempt_id), 'attempt events reference their attempt');
  throwsMatching(() => sqlite.prepare("INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, created_at) VALUES ('cross', ?, 99, ?, 't', 1)").run(a.id, attempt1.id), /engine_events.attempt_id/, 'an event cannot reference another request\'s attempt');
  engine.transitionWorkRequest(work.id, { from: 'running', to: 'completed', result: { artifacts } });

  console.log('\nSession bindings cannot cross unrelated scopes');
  const reviewerConv = conversations.getByBotId(reviewer.id);
  const other = engine.createOrGetWorkRequest(baseInput({ executionKind: 'implementation', toolProfile: 'edit', intent: 'Unrelated work' })).request;
  engine.transitionWorkRequest(other.id, { from: 'queued', to: 'running' });
  const otherAttempt = engine.createAttempt(other.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: '{}' });
  engine.finishAttempt(otherAttempt.id, { outcome: 'interrupted' });
  const bindingsBefore = count('SELECT COUNT(*) AS n FROM session_bindings');
  const otherEventsBefore = engine.listEvents(other.id).length;
  const bind = overrides => engine.bindSession({ agentId: builder.id, adapter: 'agent-deck', externalSessionId: 'x', ...overrides });
  throwsCode(() => bind({ requestId: other.id, sourceAttemptId: attempt1.id }), 'session_mismatch', 'a binding for request B cannot source an attempt of request A');
  throwsCode(() => bind({ agentId: reviewer.id, requestId: other.id }), 'session_mismatch', 'a binding cannot claim a request that targets another Agent');
  throwsCode(() => bind({ adapter: 'hermes-gateway', requestId: other.id, sourceAttemptId: otherAttempt.id }), 'session_mismatch', 'a binding cannot source an attempt from another adapter');
  throwsCode(() => bind({ conversationId: reviewerConv.id, requestId: other.id }), 'session_mismatch', 'a binding cannot pair a request with another conversation');
  throwsCode(() => bind({ conversationId: reviewerConv.id, sourceAttemptId: otherAttempt.id }), 'session_mismatch', 'a conversation binding cannot source an attempt from another conversation');
  throwsCode(() => bind({ agentId: 'no-such-agent', conversationId: conv.id }), 'not_found', 'a binding needs a registered Agent');
  assert(engine.getActiveSessionBinding({ agentId: builder.id, adapter: 'agent-deck', conversationId: conv.id, requestId: work.id }).id === rebound.id, 'rejected binds release nothing');
  assert(count('SELECT COUNT(*) AS n FROM session_bindings') === bindingsBefore && engine.listEvents(other.id).length === otherEventsBefore, 'rejected binds write no rows or events');
  throwsMatching(() => sqlite.prepare("INSERT INTO session_bindings (id, agent_id, adapter, request_id, external_session_id, source_attempt_id, created_at) VALUES ('raw-b', ?, 'agent-deck', ?, 's', ?, 1)").run(builder.id, other.id, attempt1.id), /source attempt/, 'raw SQL cannot bind a session across requests');
  throwsMatching(() => sqlite.prepare("INSERT INTO session_bindings (id, agent_id, adapter, conversation_id, external_session_id, created_at) VALUES ('raw-b2', 'no-such-agent', 'agent-deck', ?, 's', 1)").run(conv.id), /session_bindings.agent_id/, 'raw binding for an unknown Agent is rejected');

  const convBinding1 = bind({ conversationId: conv.id, externalSessionId: 'c-1' });
  const convBinding2 = bind({ conversationId: conv.id, externalSessionId: 'c-2' });
  const foreignConvBinding = bind({ conversationId: reviewerConv.id, externalSessionId: 'c-3' });
  const resume = (requestId, bindingId, adapter = 'agent-deck') => engine.createAttempt(requestId, { kind: 'resume', adapter, toolProfile: 'edit', launchSnapshot: '{}', resumedSessionBindingId: bindingId });
  const attemptsBefore = count('SELECT COUNT(*) AS n FROM work_attempts');
  throwsCode(() => resume(other.id, rebound.id), 'session_mismatch', 'an unrelated request cannot resume another request\'s session');
  throwsCode(() => resume(other.id, convBinding1.id), 'session_mismatch', 'a released (superseded) binding cannot be resumed');
  throwsCode(() => resume(other.id, convBinding2.id, 'hermes-gateway'), 'session_mismatch', 'a binding cannot be resumed by another adapter');
  throwsCode(() => resume(other.id, convOnly.id), 'session_mismatch', 'a binding of another Agent cannot be resumed');
  throwsCode(() => resume(other.id, foreignConvBinding.id), 'session_mismatch', 'a conversation binding cannot be resumed from another conversation');
  throwsMatching(() => sqlite.prepare("INSERT INTO work_attempts (id, request_id, attempt_number, kind, adapter, tool_profile, launch_snapshot, launch_snapshot_hash, resumed_session_binding_id, started_at) VALUES ('raw-a', ?, 9, 'resume', 'agent-deck', 'edit', '{}', 'h', ?, 1)").run(other.id, rebound.id), /resumed session binding/, 'raw SQL cannot resume an unrelated session');
  assert(count('SELECT COUNT(*) AS n FROM work_attempts') === attemptsBefore, 'rejected resumes write no attempts');
  const revision = engine.createOrGetWorkRequest(baseInput({ parentRequestId: work.id, executionKind: 'revision', toolProfile: 'edit' })).request;
  engine.transitionWorkRequest(revision.id, { from: 'queued', to: 'running' });
  const revisionAttempt = resume(revision.id, rebound.id);
  assert(revisionAttempt.resumed_session_binding_id === rebound.id, 'a revision in the same lineage resumes the original request session');
  const otherResume = resume(other.id, convBinding2.id);
  assert(otherResume.attempt_number === 2, 'a request resumes the active conversation binding of its Agent and adapter');

  console.log('\nAgent deletion removes engine rows for owned conversations');
  const temp = bots.create({ deck_id: 'deck-1', name: 'Temp', title: '', description: '' });
  const tempConv = conversations.getByBotId(temp.id);
  const tempReq = engine.createOrGetWorkRequest(baseInput({ sourceConversationId: tempConv.id, targetAgentId: temp.id })).request;
  engine.transitionWorkRequest(tempReq.id, { from: 'queued', to: 'running' });
  const tempAttempt = engine.createAttempt(tempReq.id, { kind: 'launch', adapter: 'hermes-gateway', toolProfile: 'readonly', launchSnapshot: '{}' });
  engine.bindSession({ agentId: temp.id, adapter: 'hermes-gateway', externalSessionId: 't', conversationId: tempConv.id, requestId: tempReq.id, sourceAttemptId: tempAttempt.id });
  bots.remove(temp.id);
  assert(count('SELECT COUNT(*) AS n FROM work_requests WHERE source_conversation_id = ?', tempConv.id) === 0
    && count('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id = ?', tempReq.id) === 0
    && count('SELECT COUNT(*) AS n FROM engine_events WHERE request_id = ?', tempReq.id) === 0
    && count('SELECT COUNT(*) AS n FROM session_bindings WHERE conversation_id = ?', tempConv.id) === 0, 'conversation deletion clears its engine rows');
  assert(engine.getWorkRequest(work.id) !== undefined, 'other conversations keep their requests');

  console.log('\nDelete-side foreign keys: RESTRICT plus lineage cascade');
  const engineTables = new Set(['work_requests', 'work_attempts', 'session_bindings', 'engine_events']);
  const orphans = () => sqlite.prepare('PRAGMA foreign_key_check').all().filter(row => engineTables.has(row.table));
  assert(orphans().length === 0, 'no dangling engine references (PRAGMA foreign_key_check)');
  const source = bots.create({ deck_id: 'deck-1', name: 'Source', title: '', description: '' });
  const sourceConv = conversations.getByBotId(source.id);
  const rootX = engine.createOrGetWorkRequest(baseInput({ sourceConversationId: sourceConv.id, targetAgentId: source.id })).request;
  // A child sourced from another conversation, targeting a surviving Agent.
  const childY = engine.createOrGetWorkRequest(baseInput({ parentRequestId: rootX.id, executionKind: 'implementation', toolProfile: 'edit' })).request;
  engine.transitionWorkRequest(childY.id, { from: 'queued', to: 'running' });
  const childAttempt = engine.createAttempt(childY.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'edit', launchSnapshot: '{}' });
  engine.finishAttempt(childAttempt.id, { outcome: 'succeeded', externalSessionId: 'y-1' });
  const childBinding = engine.bindSession({ agentId: builder.id, adapter: 'agent-deck', externalSessionId: 'y-1', requestId: childY.id, sourceAttemptId: childAttempt.id });
  const childResume = resume(childY.id, childBinding.id);
  const sourceBinding = engine.bindSession({ agentId: source.id, adapter: 'hermes-gateway', externalSessionId: 's-1', conversationId: sourceConv.id });
  throwsMatching(() => sqlite.prepare('DELETE FROM work_requests WHERE id = ?').run(rootX.id), /parent_request_id/, 'a parent request cannot be deleted while a child references it');
  throwsMatching(() => sqlite.prepare('DELETE FROM conversations WHERE id = ?').run(sourceConv.id), /source_conversation_id/, 'a conversation cannot be deleted while a request references it');
  throwsMatching(() => sqlite.prepare('DELETE FROM bots WHERE id = ?').run(source.id), /target_agent_id/, 'an Agent cannot be deleted while a request targets it');
  throwsMatching(() => sqlite.prepare('DELETE FROM work_attempts WHERE id = ?').run(childAttempt.id), /engine_events.attempt_id|source_attempt_id/, 'an attempt cannot be deleted while events or bindings reference it');
  throwsMatching(() => sqlite.prepare('DELETE FROM session_bindings WHERE id = ?').run(childBinding.id), /resumed_session_binding_id/, 'a binding cannot be deleted while an attempt resumes it');
  throwsMatching(() => sqlite.prepare('DELETE FROM work_requests WHERE id = ?').run(childY.id), /work_attempts.request_id/, 'a request cannot be deleted while attempts reference it');
  assert(engine.getWorkRequest(rootX.id) && engine.getAttempt(childResume.id) && orphans().length === 0, 'rejected deletes leave every row in place');
  throwsMatching(() => sqlite.prepare("UPDATE conversations SET id = 'renamed-conv' WHERE id = ?").run(sourceConv.id), /source_conversation_id/, 'a referenced conversation id cannot change');
  throwsMatching(() => sqlite.prepare("UPDATE bots SET id = 'renamed-bot' WHERE id = ?").run(source.id), /target_agent_id/, 'a referenced Agent id cannot change');
  const bindingOnly = bots.create({ deck_id: 'deck-1', name: 'BindingOnly', title: '', description: '' });
  const bindingOnlyConv = conversations.getByBotId(bindingOnly.id);
  engine.bindSession({ agentId: bindingOnly.id, adapter: 'hermes-gateway', externalSessionId: 'b-1', conversationId: bindingOnlyConv.id });
  throwsMatching(() => sqlite.prepare("UPDATE conversations SET id = 'renamed-conv' WHERE id = ?").run(bindingOnlyConv.id), /session_bindings.conversation_id/, 'a conversation id referenced by a binding cannot change');
  throwsMatching(() => sqlite.prepare("UPDATE bots SET id = 'renamed-bot' WHERE id = ?").run(bindingOnly.id), /session_bindings.agent_id/, 'an Agent id referenced by a binding cannot change');
  sqlite.prepare("UPDATE conversations SET created_at = created_at WHERE id = ?").run(sourceConv.id);
  assert(orphans().length === 0 && count('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', sourceConv.id) === 1, 'rejected parent-key updates leave nothing dangling (PRAGMA foreign_key_check)');
  bots.remove(bindingOnly.id);
  bots.remove(source.id);
  assert(!engine.getWorkRequest(rootX.id) && !engine.getWorkRequest(childY.id), 'deleting the source conversation removes the root and its cross-conversation child');
  assert(!engine.getAttempt(childAttempt.id) && !engine.getAttempt(childResume.id)
    && count('SELECT COUNT(*) AS n FROM session_bindings WHERE id IN (?, ?)', childBinding.id, sourceBinding.id) === 0
    && count('SELECT COUNT(*) AS n FROM engine_events WHERE request_id IN (?, ?)', rootX.id, childY.id) === 0, 'descendant attempts, bindings, and events are removed with them');
  assert(orphans().length === 0, 'no orphans after conversation and Agent deletion');
  throwsMatching(() => sqlite.prepare('DELETE FROM engine_events WHERE request_id = ?').run(work.id), /append-only/, 'purge authority does not outlive the aggregate cleanup');

  const target = bots.create({ deck_id: 'deck-1', name: 'Target', title: '', description: '' });
  const targeted = engine.createOrGetWorkRequest(baseInput({ targetAgentId: target.id })).request;
  const targetBinding = engine.bindSession({ agentId: target.id, adapter: 'hermes-gateway', externalSessionId: 't-1', conversationId: conv.id });
  bots.remove(target.id);
  assert(!engine.getWorkRequest(targeted.id) && count('SELECT COUNT(*) AS n FROM session_bindings WHERE id = ?', targetBinding.id) === 0, 'deleting an Agent removes requests and bindings in other conversations that reference it');
  assert(engine.getWorkRequest(work.id) && engine.getWorkRequest(other.id) && orphans().length === 0, 'unrelated requests survive and nothing dangles');

  console.log('\nRe-running migrations is a no-op');
  const before = count('SELECT COUNT(*) AS n FROM work_requests');
  store.migrateEngineSchema(new Database(DB_PATH));
  assert(count('SELECT COUNT(*) AS n FROM schema_migrations') === store.ENGINE_SCHEMA_VERSION && count('SELECT COUNT(*) AS n FROM work_requests') === before, 'second open applies nothing new');
  assert(EngineStoreError && typeof EngineStoreError === 'function', 'EngineStoreError exported');

  console.log('\nLegacy database scenario (child process)');
  const legacyRun = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, ENGINE_STORE_SCENARIO: 'legacy', BOTMANCERS_DB_PATH: '' },
    encoding: 'utf8',
  });
  process.stdout.write(legacyRun.stdout.split('\n').map(line => line && `  ${line}`).join('\n'));
  if (legacyRun.stderr) process.stderr.write(legacyRun.stderr);
  assert(legacyRun.status === 0, `legacy scenario exited 0 (status ${legacyRun.status})`);

  finish();
}

function runLegacy() {
  const { createHash } = require('crypto');
  const sha = value => createHash('sha256').update(value).digest('hex');
  // A pre-NOT-463 database: legacy bots columns (pre agent/deck
  // migrations), UI and agent conversations, messages, processing_queue,
  // and agent_requests in every legacy state, including rows whose
  // conversation, target agent, or accepted message is gone.
  const legacy = new Database(DB_PATH);
  legacy.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE group_members (group_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (group_id, bot_id));
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, bot_id TEXT, group_id TEXT, created_at INTEGER NOT NULL, origin_kind TEXT, origin_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_type TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL, sender_kind TEXT, request_id TEXT);
    CREATE TABLE processing_queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, work_request_id TEXT);
    CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_kind TEXT NOT NULL, participant_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, participant_kind, participant_id));
    CREATE TABLE agent_requests (
      id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, conversation_id TEXT NOT NULL, target_bot_id TEXT NOT NULL,
      accepted_message_id TEXT NOT NULL, runtime TEXT, state TEXT NOT NULL, reply_message_id TEXT, failure_code TEXT,
      failure_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_agent_requests_idempotency ON agent_requests(principal_kind, principal_id, operation, idempotency_key);
    CREATE TABLE agent_request_events (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);
  `);
  const t = 1_700_000_000_000;
  legacy.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, NULL, ?)').run('bot-codex', 'Codex', 't', 'd', t);
  legacy.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, NULL, ?)').run('bot-claude', 'Claude', 't', 'd', t + 1);
  legacy.prepare("INSERT INTO conversations VALUES ('conv-ui', 'bot', 'bot-codex', NULL, ?, NULL, NULL)").run(t);
  legacy.prepare("INSERT INTO conversations VALUES ('conv-api', 'agent', NULL, NULL, ?, 'service', 'svc-1')").run(t + 10);
  legacy.prepare("INSERT INTO conversation_participants VALUES ('conv-api', 'service', 'svc-1', ?)").run(t + 10);
  legacy.prepare("INSERT INTO conversation_participants VALUES ('conv-api', 'bot', 'bot-codex', ?)").run(t + 10);
  const msg = legacy.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  msg.run('m-ui-1', 'conv-ui', 'user', null, 'hello from the UI', t + 1, null, null);
  msg.run('m-ui-2', 'conv-ui', 'bot', 'bot-codex', 'hi back', t + 2, null, null);
  msg.run('m-1', 'conv-api', 'user', 'svc-1', 'Explain the queue', t + 11, 'service', 'req-completed');
  msg.run('m-1r', 'conv-api', 'bot', 'bot-codex', 'The queue is…', t + 12, 'bot', 'req-completed');
  msg.run('m-2', 'conv-api', 'user', 'svc-1', 'Do the thing', t + 13, 'service', 'req-failed');
  msg.run('m-3', 'conv-api', 'user', 'svc-1', 'Pending', t + 14, 'service', 'req-accepted');
  msg.run('m-4', 'conv-api', 'user', 'svc-1', 'In flight', t + 15, 'service', 'req-dispatched');
  msg.run('m-5', 'conv-api', 'user', 'svc-1', 'For a deleted agent', t + 16, 'service', 'req-no-bot');
  legacy.prepare("INSERT INTO processing_queue VALUES ('q-1', 'conv-ui', 'bot-codex', 'completed', ?, ?, ?, NULL)").run(t + 1, t + 1, t + 2);
  // Payload hashes as the pre-NOT-465 API stored them: [agentId,
  // conversationId ?? null, content]. k-1 named its conversation, k-2 opened
  // a new one; the other rows carry hashes that verify neither form.
  const req = legacy.prepare(`INSERT INTO agent_requests VALUES (?, 'service', 'svc-1', 'send_message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  req.run('req-completed', 'k-1', sha(JSON.stringify(['bot-codex', 'conv-api', 'Explain the queue'])), 'conv-api', 'bot-codex', 'm-1', 'codex', 'completed', 'm-1r', null, null, t + 11, t + 12);
  req.run('req-failed', 'k-2', sha(JSON.stringify(['bot-claude', null, 'Do the thing'])), 'conv-api', 'bot-claude', 'm-2', 'claude', 'failed', null, 'runtime_failed', 'The agent runtime did not complete the turn.', t + 13, t + 14);
  req.run('req-accepted', 'k-3', 'hash-3', 'conv-api', 'bot-codex', 'm-3', null, 'accepted', null, null, null, t + 14, t + 14);
  req.run('req-dispatched', 'k-4', 'hash-4', 'conv-api', 'bot-codex', 'm-4', 'codex', 'dispatched', null, null, null, t + 15, t + 15);
  req.run('req-no-bot', 'k-5', 'hash-5', 'conv-api', 'bot-deleted', 'm-5', 'codex', 'completed', null, null, null, t + 16, t + 17);
  req.run('req-no-conv', 'k-6', 'hash-6', 'conv-deleted', 'bot-codex', 'm-x', 'codex', 'completed', null, null, null, t + 18, t + 19);
  req.run('req-no-msg', 'k-7', 'hash-7', 'conv-api', 'bot-codex', 'm-missing', 'codex', 'completed', null, null, null, t + 20, t + 21);
  // Same principal and key under two legacy operations: legal there,
  // one identity canonically. The older row wins; the newer stays archive-only.
  msg.run('m-8a', 'conv-api', 'user', 'svc-1', 'Op A', t + 22, 'service', 'req-op-a');
  msg.run('m-8b', 'conv-api', 'user', 'svc-1', 'Op B', t + 23, 'service', 'req-op-b');
  const reqOp = legacy.prepare(`INSERT INTO agent_requests VALUES (?, 'service', 'svc-1', ?, 'k-8', ?, 'conv-api', 'bot-codex', ?, 'codex', 'completed', NULL, NULL, NULL, ?, ?)`);
  reqOp.run('req-op-b', 'other_operation', 'hash-8b', 'm-8b', t + 23, t + 24);
  reqOp.run('req-op-a', 'send_message', 'hash-8a', 'm-8a', t + 22, t + 23);
  const ev = legacy.prepare('INSERT INTO agent_request_events VALUES (?, ?, ?, ?, ?)');
  ev.run('e-1', 'req-completed', 'accepted', null, t + 11);
  ev.run('e-2', 'req-completed', 'dispatched', '{"agent":"codex"}', t + 11);
  ev.run('e-3', 'req-completed', 'runtime_started', null, t + 11);
  ev.run('e-4', 'req-completed', 'completed', null, t + 12);
  ev.run('e-5', 'req-failed', 'accepted', null, t + 13);
  ev.run('e-6', 'req-failed', 'failed', '{"code":"runtime_failed"}', t + 14);
  ev.run('e-7', 'req-accepted', 'accepted', null, t + 14);
  ev.run('e-8', 'req-dispatched', 'accepted', null, t + 15);
  ev.run('e-9', 'req-dispatched', 'dispatched', '{"agent":"codex"}', t + 15);

  // The last supported legacy database: the previous release's engine
  // schema (13) on top, with live canonical history (a request that already
  // holds legacy key k-3, its Attempt, Session Binding, and events).
  const store = jiti('./lib/engine-store.ts');
  store.migrateEngineSchema(legacy, { through: 13 });
  const previous = store.createEngineStore(legacy);
  // A request as the schema-13 intake wrote it (the current store also
  // writes migration-15 columns, so the row is inserted directly).
  const schema13Request = ({ conversation, event, requester, target, intent, key, at }) => {
    const id = require('crypto').randomUUID();
    legacy.prepare(`
      INSERT INTO work_requests (
        id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id, intent,
        execution_kind, tool_profile, root_request_id, idempotency_key, request_hash, policy_snapshot, state,
        created_at, updated_at, root_principal_kind, root_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', 'readonly', ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      id, conversation, event, requester.kind, requester.id, target, intent, id, key,
      store.workRequestHash({ sourceConversationId: conversation, sourceEventId: event, targetAgentId: target, intent, executionKind: 'conversation', toolProfile: 'readonly' }),
      JSON.stringify({ source: 'conversation_intake', surface: requester.kind === 'person' ? 'ui' : 'api', tool_profile: 'readonly' }),
      at, at, requester.kind, requester.id
    );
    legacy.prepare("INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at) VALUES (?, ?, 1, NULL, 'accepted', '{\"state\":\"queued\"}', ?)")
      .run(require('crypto').randomUUID(), id, at);
    return previous.getWorkRequest(id);
  };
  const native = schema13Request({
    conversation: 'conv-api', event: 'm-3', requester: { kind: 'service', id: 'svc-1' }, target: 'bot-codex', intent: 'Pending', key: 'k-3', at: t + 50,
  });
  previous.transitionWorkRequest(native.id, { from: 'queued', to: 'running', now: t + 51 });
  const nativeAttempt = previous.createAttempt(native.id, { kind: 'launch', adapter: 'agent-deck', toolProfile: 'readonly', launchSnapshot: { agent: 'codex' }, now: t + 51 });
  previous.finishAttempt(nativeAttempt.id, { outcome: 'succeeded', externalSessionId: 'ses-native', now: t + 52 });
  previous.bindSession({ agentId: 'bot-codex', adapter: 'agent-deck', externalSessionId: 'ses-native', conversationId: 'conv-api', requestId: native.id, sourceAttemptId: nativeAttempt.id, now: t + 52 });
  previous.transitionWorkRequest(native.id, { from: 'running', to: 'completed', result: { reply_message_id: 'm-1r' }, now: t + 53 });

  // The previous release's UI loop: each UI message is a queued Work
  // Request (UI intake) plus a processing_queue row naming it. The loop
  // finished Hermes turns without moving their request; a coding-Agent
  // turn went through the dispatcher. Loop-internal turns (report-backs,
  // ticks) had queue rows only.
  const uiRequest = (key, content, at) => {
    msg.run(`m-${key}`, 'conv-ui', 'user', null, content, at, null, null);
    return schema13Request({
      conversation: 'conv-ui', event: `m-${key}`, requester: { kind: 'person', id: 'owner' }, target: 'bot-codex', intent: content, key: `ui:${key}`, at,
    });
  };
  const queueRow = legacy.prepare('INSERT INTO processing_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const uiDone = uiRequest('ui-done', 'A finished Hermes turn', t + 60);
  queueRow.run('q-done', 'conv-ui', 'bot-codex', 'completed', t + 60, t + 61, t + 62, uiDone.id);
  const uiFailed = uiRequest('ui-failed', 'A turn that threw', t + 63);
  queueRow.run('q-failed', 'conv-ui', 'bot-codex', 'failed', t + 63, t + 64, t + 65, uiFailed.id);
  const uiPending = uiRequest('ui-pending', 'Not started yet', t + 66);
  queueRow.run('q-pending', 'conv-ui', 'bot-codex', 'pending', t + 66, null, null, uiPending.id);
  const uiProcessing = uiRequest('ui-processing', 'Started, never finished', t + 67);
  queueRow.run('q-processing', 'conv-ui', 'bot-codex', 'processing', t + 67, t + 68, null, uiProcessing.id);
  const uiDispatched = uiRequest('ui-dispatched', 'A coding-Agent turn', t + 69);
  previous.transitionWorkRequest(uiDispatched.id, { from: 'queued', to: 'running', now: t + 70 });
  previous.transitionWorkRequest(uiDispatched.id, { from: 'running', to: 'completed', result: { reply_message_id: 'm-ui-2' }, now: t + 71 });
  queueRow.run('q-dispatched', 'conv-ui', 'bot-codex', 'completed', t + 69, t + 70, t + 71, uiDispatched.id);
  queueRow.run('q-return', 'conv-ui', 'bot-claude', 'pending', t + 72, null, null, null);
  queueRow.run('q-tick-done', 'conv-ui', 'bot-codex', 'completed', t + 73, t + 73, t + 74, null);
  queueRow.run('q-no-bot', 'conv-ui', 'bot-deleted', 'pending', t + 75, null, null, null);
  queueRow.run('q-no-conv', 'conv-deleted', 'bot-codex', 'pending', t + 76, null, null, null);
  // Schema 13 committed a UI intake's request (and its intake row) before
  // the route wrote the queue row: a crash in between left a queued UI
  // message with no processing_queue row. The equivalent /api/v0 request,
  // also queued with no queue row, belongs to the dispatcher.
  const uiCrashed = uiRequest('ui-crashed', 'Accepted, crashed before its queue row', t + 77);
  legacy.prepare("INSERT INTO conversation_intakes VALUES ('person', 'owner', 'ui:ui-crashed', 'hash-ui-crashed', 'ui', 'conv-ui', 'm-ui-crashed', ?, ?)")
    .run(JSON.stringify([uiCrashed.id]), t + 77);
  msg.run('m-api-queued', 'conv-api', 'user', 'svc-1', 'Queued for the dispatcher', t + 78, 'service', null);
  const apiQueued = schema13Request({
    conversation: 'conv-api', event: 'm-api-queued', requester: { kind: 'service', id: 'svc-1' }, target: 'bot-codex', intent: 'Queued for the dispatcher', key: 'k-api-queued', at: t + 78,
  });
  legacy.prepare("INSERT INTO conversation_intakes VALUES ('service', 'svc-1', 'k-api-queued', 'hash-api-queued', 'api', 'conv-api', 'm-api-queued', ?, ?)")
    .run(JSON.stringify([apiQueued.id]), t + 78);
  const RECONCILED = [uiDone.id, uiFailed.id, uiPending.id, uiProcessing.id];
  assert(legacy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v === 13, 'fixture: the previous release left schema 13');

  const snapshotRows = (dbh, sql) => JSON.stringify(dbh.prepare(sql).all());
  // Schema-13 columns: what the previous release stored per request.
  const workColumns = legacy.prepare('PRAGMA table_info(work_requests)').all().map(column => column.name).join(', ');
  const notReconciled = `id NOT IN (${RECONCILED.map(id => `'${id}'`).join(', ')})`;
  const KEPT = {
    conversations: 'SELECT id, type, bot_id, group_id, created_at FROM conversations ORDER BY id',
    messages: 'SELECT id, conversation_id, sender_type, sender_id, content, created_at, request_id FROM messages ORDER BY id',
    work_requests: `SELECT ${workColumns} FROM work_requests WHERE ${notReconciled} ORDER BY id`,
    work_attempts: 'SELECT * FROM work_attempts ORDER BY id',
    session_bindings: 'SELECT * FROM session_bindings ORDER BY id',
    engine_events: 'SELECT * FROM engine_events ORDER BY id',
    conversation_intakes: 'SELECT * FROM conversation_intakes ORDER BY requester_kind, requester_id, idempotency_key',
  };
  const before = Object.fromEntries(Object.entries(KEPT).map(([name, sql]) => [name, snapshotRows(legacy, sql)]));
  const reconciledBefore = Object.fromEntries(RECONCILED.map(id => [id, legacy.prepare(`SELECT ${workColumns} FROM work_requests WHERE id = ?`).get(id)]));
  const participantsBefore = legacy.prepare('SELECT * FROM conversation_participants').all();
  const legacyRequests = legacy.prepare('SELECT * FROM agent_requests ORDER BY id').all();
  const legacyEventsBefore = snapshotRows(legacy, 'SELECT * FROM agent_request_events ORDER BY id');
  const queueBefore = snapshotRows(legacy, 'SELECT * FROM processing_queue ORDER BY id');
  legacy.close();

  console.log('Open the legacy database through lib/db.ts (migrations 14 and 15)');
  let db;
  try {
    db = jiti('./lib/db.ts');
  } catch (error) {
    assert(false, `legacy database opens (${error.message})`);
    return finish();
  }
  assert(true, 'legacy database opens');
  const sqlite = db.default;
  const { engine } = db;
  const count = (sql, ...args) => sqlite.prepare(sql).get(...args).n;
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  assert(sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v === store.ENGINE_SCHEMA_VERSION, 'migrated to the current schema');

  console.log('\nRecord-level reconciliation of retained history');
  // Rows the migrations added (copied legacy requests, UI continuation
  // turns, events after the previous last sequence) are checked below.
  const previousEventIds = JSON.parse(before.engine_events).map(row => `'${row.id}'`).join(', ');
  const KEPT_AFTER = {
    ...KEPT,
    work_requests: `SELECT ${workColumns} FROM work_requests WHERE legacy_agent_request_id IS NULL AND executor <> 'ui_continuation' AND ${notReconciled} ORDER BY id`,
    engine_events: `SELECT * FROM engine_events WHERE id IN (${previousEventIds}) ORDER BY id`,
    conversation_intakes: "SELECT * FROM conversation_intakes WHERE NOT EXISTS (SELECT 1 FROM work_requests w WHERE w.legacy_agent_request_id IS NOT NULL AND conversation_intakes.work_request_ids = json_array(w.id)) ORDER BY requester_kind, requester_id, idempotency_key",
  };
  for (const [name, sql] of Object.entries(KEPT_AFTER)) {
    assert(snapshotRows(sqlite, sql) === before[name], `${name} rows are unchanged`);
  }

  const participantKey = row => `${row.conversation_id}|${row.participant_kind}|${row.participant_id}|${row.joined_at}`;
  const participantsAfter = new Set(sqlite.prepare('SELECT * FROM conversation_participants').all().map(participantKey));
  assert(participantsBefore.every(row => participantsAfter.has(participantKey(row))), 'every conversation participant is kept (UI threads gain their bound owner)');

  console.log('\nThe agent_requests lifecycle is archived verbatim');
  assert(!tables.has('agent_requests') && !tables.has('agent_request_events'), 'agent_requests and agent_request_events no longer exist');
  assert(snapshotRows(sqlite, 'SELECT * FROM legacy_agent_requests_archive ORDER BY id') === JSON.stringify(legacyRequests), 'every agent_requests row is in legacy_agent_requests_archive verbatim');
  assert(snapshotRows(sqlite, 'SELECT * FROM legacy_agent_request_events_archive ORDER BY id') === legacyEventsBefore, 'every agent_request_events row is in legacy_agent_request_events_archive verbatim');

  console.log('\nThe processing_queue lifecycle is reconciled and archived verbatim');
  assert(!tables.has('processing_queue'), 'processing_queue no longer exists');
  assert(snapshotRows(sqlite, 'SELECT * FROM legacy_processing_queue_archive ORDER BY id') === queueBefore, 'every processing_queue row is in legacy_processing_queue_archive verbatim');
  const reconciled = id => sqlite.prepare('SELECT * FROM work_requests WHERE id = ?').get(id);
  const transitions = id => engine.listEvents(id).filter(e => e.type === 'state_changed').map(e => { const d = JSON.parse(e.data); return `${d.from}>${d.to}:${d.reason}@${e.created_at - t}`; }).join(',');
  for (const id of RECONCILED) {
    const row = reconciled(id);
    const original = reconciledBefore[id];
    const identity = ['source_conversation_id', 'source_event_id', 'requester_kind', 'requester_id', 'target_agent_id', 'intent', 'idempotency_key', 'request_hash', 'policy_snapshot', 'created_at'];
    assert(identity.every(key => row[key] === original[key]) && row.executor === 'ui_message', `${id.slice(0, 8)}: identity unchanged; owned by the UI turn executor`);
  }
  const doneTurn = reconciled(uiDone.id);
  assert(doneTurn.state === 'completed' && doneTurn.terminal_at === t + 62 && transitions(uiDone.id) === 'queued>running:null@61,running>completed:legacy_queue_turn@62',
    `a completed queue turn completes its request at the row's times (${transitions(uiDone.id)})`);
  const failedTurn = reconciled(uiFailed.id);
  assert(failedTurn.state === 'failed' && failedTurn.error_code === 'ui_turn_failed' && failedTurn.terminal_at === t + 65, 'a failed queue turn fails its request (ui_turn_failed)');
  assert(reconciled(uiPending.id).state === 'queued' && engine.listEvents(uiPending.id).length === JSON.parse(before.engine_events).filter(e => e.request_id === uiPending.id).length,
    'a pending queue turn stays queued for the UI turn executor, with no new event');
  const interruptedTurn = reconciled(uiProcessing.id);
  assert(interruptedTurn.state === 'failed' && interruptedTurn.error_code === store.UI_TURN_INTERRUPTED, 'a started, unfinished queue turn fails with ui_turn_interrupted (never re-run)');
  const dispatchedTurn = reconciled(uiDispatched.id);
  assert(dispatchedTurn.state === 'completed' && dispatchedTurn.executor === 'dispatcher' && JSON.parse(dispatchedTurn.result).reply_message_id === 'm-ui-2',
    'a turn the dispatcher already ran keeps its own outcome');
  const continuations = sqlite.prepare("SELECT * FROM work_requests WHERE executor = 'ui_continuation'").all();
  assert(continuations.length === 1, `exactly one UI continuation turn is created (got ${continuations.length})`);
  const returnTurn = continuations[0];
  assert(returnTurn && returnTurn.target_agent_id === 'bot-claude' && returnTurn.source_conversation_id === 'conv-ui' && returnTurn.state === 'queued'
    && returnTurn.created_at === t + 72 && returnTurn.idempotency_key === 'legacy-queue:q-return' && JSON.parse(returnTurn.policy_snapshot).legacy_queue_id === 'q-return',
  'a pending loop-internal turn becomes one queued UI continuation for the same Agent and thread');
  assert(returnTurn && returnTurn.source_event_id === 'm-ui-dispatched', 'the continuation names the latest message before it as its source event');
  const archiveOnlyQueue = { 'q-1': 'loop bookkeeping of a finished turn', 'q-tick-done': 'loop bookkeeping of a finished turn', 'q-no-bot': 'Agent is gone', 'q-no-conv': 'conversation is gone' };
  for (const [id, reason] of Object.entries(archiveOnlyQueue)) {
    assert(!sqlite.prepare("SELECT 1 FROM work_requests WHERE json_extract(policy_snapshot, '$.legacy_queue_id') = ?").get(id), `${id}: archive only (${reason})`);
  }

  console.log('\nA UI intake that crashed before its queue row stays a UI turn');
  const crashed = reconciled(uiCrashed.id);
  assert(crashed.state === 'queued' && crashed.executor === 'ui_message', 'a queued UI intake request with no queue row is owned by the UI turn executor');
  const apiPending = reconciled(apiQueued.id);
  assert(apiPending.state === 'queued' && apiPending.executor === 'dispatcher', 'the equivalent queued /api/v0 request stays dispatcher-owned');
  const { uiTurns } = jiti('./lib/ui-turns.ts');
  const uiQueued = sqlite.prepare("SELECT id FROM work_requests WHERE state = 'queued' AND executor IN ('ui_message', 'ui_continuation') ORDER BY created_at, rowid").all().map(row => row.id);
  assert(uiQueued.includes(uiCrashed.id) && uiTurns.get(uiCrashed.id) && uiTurns.get(uiCrashed.id).kind === 'message',
    'the UI turn executor recovers it as a message turn');
  assert(!uiTurns.get(apiQueued.id), 'the UI turn executor never picks up the /api/v0 request');
  const dispatcherProbe = jiti('./lib/dispatcher.ts').createDispatcher(sqlite, engine);
  const offered = [];
  dispatcherProbe.claim = id => { offered.push(id); return { ok: false, reason: 'not_queued' }; };
  dispatcherProbe.claimNext();
  assert(!offered.includes(uiCrashed.id) && offered.includes(apiQueued.id), 'the dispatcher never claims the UI turn; it still claims the /api/v0 request');
  assert(sqlite.prepare('SELECT COUNT(*) AS n FROM delegation_chains').get().n === 0, 'no delegation chain is invented (the old chains were process memory)');

  console.log('\nEvery legacy request is copied or kept for a named reason');
  const copied = Object.fromEntries(sqlite.prepare('SELECT * FROM work_requests WHERE legacy_agent_request_id IS NOT NULL').all().map(row => [row.legacy_agent_request_id, row]));
  const archiveOnly = {
    'req-no-bot': 'target agent is gone',
    'req-no-conv': 'conversation is gone',
    'req-no-msg': 'accepted message is gone',
    'req-op-b': 'key already claimed by an older row of another operation',
    'req-accepted': 'key already held by a canonical request',
  };
  for (const row of legacyRequests) {
    const reason = archiveOnly[row.id];
    assert(reason ? !copied[row.id] : !!copied[row.id], `${row.id}: ${reason ? `archive only (${reason})` : 'copied into work_requests'}`);
  }
  assert(Object.keys(copied).sort().join(',') === 'req-completed,req-dispatched,req-failed,req-op-a', 'no unexpected request is copied');
  for (const row of legacyRequests.filter(r => copied[r.id] && (r.state === 'completed' || r.state === 'failed'))) {
    const work = copied[row.id];
    const result = work.result ? JSON.parse(work.result) : null;
    assert(work.state === row.state && (result ? result.reply_message_id : null) === row.reply_message_id
      && work.error_code === row.failure_code && work.error_message === row.failure_message && work.terminal_at === row.updated_at,
    `${row.id}: terminal outcome (${row.state}) carried over exactly`);
    assert(work.source_conversation_id === row.conversation_id && work.source_event_id === row.accepted_message_id
      && work.requester_kind === row.principal_kind && work.requester_id === row.principal_id && work.target_agent_id === row.target_bot_id
      && work.idempotency_key === row.idempotency_key && work.created_at === row.created_at, `${row.id}: identity, source, and key carried over`);
  }
  const done = copied['req-completed'];
  const canonicalHash = store.workRequestHash({
    sourceConversationId: 'conv-api', sourceEventId: 'm-1', targetAgentId: 'bot-codex', intent: 'Explain the queue',
    executionKind: 'conversation', toolProfile: 'readonly',
  });
  assert(done.request_hash === canonicalHash && done.intent === 'Explain the queue', 'request hash is the canonical intake hash; intent is the accepted message');
  assert(done.execution_kind === 'conversation' && done.tool_profile === 'readonly' && done.root_request_id === done.id && done.depth === 0, 'legacy turns map to read-only conversation roots');
  const policy = JSON.parse(done.policy_snapshot);
  assert(policy.source === 'legacy_agent_requests' && policy.legacy_runtime === 'codex' && policy.legacy_operation === 'send_message', 'policy snapshot records legacy provenance');
  const events = engine.listEvents(done.id);
  assert(events.map(e => `${e.sequence}:${e.type}`).join(',') === '1:accepted,2:dispatched,3:runtime_started,4:completed,5:backfilled', 'legacy events copied in order, then a backfilled marker');
  assert(events[1].data === '{"agent":"codex"}', 'legacy event data copied verbatim');
  const interrupted = copied['req-dispatched'];
  assert(interrupted.state === 'failed' && interrupted.error_code === store.LEGACY_INTERRUPTED && JSON.parse(interrupted.policy_snapshot).legacy_state === 'dispatched',
    'a dispatched legacy row that can never finish becomes failed (legacy_interrupted) and keeps its original state');
  assert(engine.listEvents(interrupted.id).map(e => e.type).join(',') === 'accepted,dispatched,state_changed,backfilled', 'the interruption is an explicit event after the copied history');
  assert(count('SELECT COUNT(*) AS n FROM work_attempts WHERE request_id IN (SELECT id FROM work_requests WHERE legacy_agent_request_id IS NOT NULL)') === 0, 'no attempts are synthesized for legacy rows');

  console.log('\nThe /api/v0 surface reads only canonical tables');
  const api = jiti('./lib/agent-conversations.ts');
  const svc = { kind: 'service', id: 'svc-1' };
  const view = api.getAgentRequest(svc, 'req-completed');
  assert(view.requestId === 'req-completed' && view.state === 'completed' && view.reply && view.reply.messageId === 'm-1r', 'a pre-NOT-465 request id still reads, with its reply');
  const failedView = api.getAgentRequest(svc, 'req-dispatched');
  assert(failedView.state === 'failed' && failedView.failure.code === store.LEGACY_INTERRUPTED, 'an interrupted legacy request reads as failed with its reason');
  let missing = null;
  try { api.getAgentRequest(svc, 'req-no-bot'); } catch (error) { missing = error.code; }
  assert(missing === 'request_not_found', 'an archive-only request is not served');
  const messagesBefore = count('SELECT COUNT(*) AS n FROM messages');
  const replayed = api.sendAgentMessage(svc, { agentId: 'bot-codex', conversationId: 'conv-api', content: 'Explain the queue', idempotencyKey: 'k-1' });
  assert(replayed.replayed === true && replayed.requestId === 'req-completed' && replayed.state === 'completed', 'an exact replay of a pre-NOT-465 key (named conversation) replays it');
  const replayedNew = api.sendAgentMessage(svc, { agentId: 'bot-claude', content: 'Do the thing', idempotencyKey: 'k-2' });
  assert(replayedNew.replayed === true && replayedNew.requestId === 'req-failed' && replayedNew.state === 'failed', 'an exact replay of a pre-NOT-465 key (new conversation) replays it');
  let conflict = null;
  try { api.sendAgentMessage(svc, { agentId: 'bot-codex', conversationId: 'conv-api', content: 'Something else', idempotencyKey: 'k-1' }); } catch (error) { conflict = error.code; }
  assert(conflict === 'idempotency_conflict', 'the same pre-NOT-465 key with a different payload is a conflict');
  assert(count('SELECT COUNT(*) AS n FROM messages') === messagesBefore, 'replays and conflicts write no messages');

  console.log('\nReopening is a no-op');
  const workBefore = snapshotRows(sqlite, 'SELECT * FROM work_requests ORDER BY id');
  store.migrateEngineSchema(new Database(DB_PATH));
  assert(snapshotRows(sqlite, 'SELECT * FROM work_requests ORDER BY id') === workBefore, 'reopening changes no request');
  assert(count('SELECT COUNT(*) AS n FROM schema_migrations') === store.ENGINE_SCHEMA_VERSION, 'schema migrations applied once');

  finish();
}
