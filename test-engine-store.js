#!/usr/bin/env node
// NOT-463: canonical core-engine persistence contract (lib/engine-store).
// Proves: a fresh database gets distinct work_requests, work_attempts,
// session_bindings, and engine_events with keys, indexes, and enforced
// foreign keys; create-or-get is idempotent (also across connections);
// state transitions are compare-and-set, reject invalid/stale moves, and
// roll back without partial writes; per-request event sequences are
// unique and contiguous; attempts keep launch snapshots and opaque
// external ids verbatim. A child process opens a populated legacy
// database and checks history is preserved and terminal agent_requests
// are backfilled once. Self-contained: isolated SQLite files, no network.
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
  for (const name of ['processing_queue', 'agent_requests', 'agent_request_events']) {
    assert(tables.has(name), `legacy table ${name} is kept`);
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
    'error_message', 'version', 'legacy_agent_request_id', 'created_at', 'updated_at', 'terminal_at',
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
  assert(migrations.map(m => m.version).join(',') === '1,2,3,4,5,6,7,8' && store.ENGINE_SCHEMA_VERSION === 8, `schema_migrations records versions 1..${store.ENGINE_SCHEMA_VERSION}`);
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
    CREATE TABLE processing_queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
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
  const msg = legacy.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  msg.run('m-ui-1', 'conv-ui', 'user', null, 'hello from the UI', t + 1, null, null);
  msg.run('m-ui-2', 'conv-ui', 'bot', 'bot-codex', 'hi back', t + 2, null, null);
  msg.run('m-1', 'conv-api', 'user', 'svc-1', 'Explain the queue', t + 11, 'service', 'req-completed');
  msg.run('m-1r', 'conv-api', 'bot', 'bot-codex', 'The queue is…', t + 12, 'bot', 'req-completed');
  msg.run('m-2', 'conv-api', 'user', 'svc-1', 'Do the thing', t + 13, 'service', 'req-failed');
  msg.run('m-3', 'conv-api', 'user', 'svc-1', 'Pending', t + 14, 'service', 'req-accepted');
  msg.run('m-4', 'conv-api', 'user', 'svc-1', 'In flight', t + 15, 'service', 'req-dispatched');
  msg.run('m-5', 'conv-api', 'user', 'svc-1', 'For a deleted agent', t + 16, 'service', 'req-no-bot');
  legacy.prepare("INSERT INTO processing_queue VALUES ('q-1', 'conv-ui', 'bot-codex', 'completed', ?, ?, ?)").run(t + 1, t + 1, t + 2);
  const req = legacy.prepare(`INSERT INTO agent_requests VALUES (?, 'service', 'svc-1', 'send_message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  req.run('req-completed', 'k-1', 'hash-1', 'conv-api', 'bot-codex', 'm-1', 'codex', 'completed', 'm-1r', null, null, t + 11, t + 12);
  req.run('req-failed', 'k-2', 'hash-2', 'conv-api', 'bot-claude', 'm-2', 'claude', 'failed', null, 'runtime_failed', 'The agent runtime did not complete the turn.', t + 13, t + 14);
  req.run('req-accepted', 'k-3', 'hash-3', 'conv-api', 'bot-codex', 'm-3', null, 'accepted', null, null, null, t + 14, t + 14);
  req.run('req-dispatched', 'k-4', 'hash-4', 'conv-api', 'bot-codex', 'm-4', 'codex', 'dispatched', null, null, null, t + 15, t + 15);
  req.run('req-no-bot', 'k-5', 'hash-5', 'conv-api', 'bot-deleted', 'm-5', 'codex', 'completed', null, null, null, t + 16, t + 17);
  req.run('req-no-conv', 'k-6', 'hash-6', 'conv-deleted', 'bot-codex', 'm-x', 'codex', 'completed', null, null, null, t + 18, t + 19);
  req.run('req-no-msg', 'k-7', 'hash-7', 'conv-api', 'bot-codex', 'm-missing', 'codex', 'completed', null, null, null, t + 20, t + 21);
  // Same principal and key under two legacy operations: legal there,
  // one identity canonically. The older row wins; the newer stays legacy-only.
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

  const snapshotRows = (dbh, sql) => JSON.stringify(dbh.prepare(sql).all());
  const before = {
    conversations: snapshotRows(legacy, 'SELECT id, type, bot_id, group_id, created_at FROM conversations ORDER BY id'),
    messages: snapshotRows(legacy, 'SELECT id, conversation_id, sender_type, sender_id, content, created_at, request_id FROM messages ORDER BY id'),
    agent_requests: snapshotRows(legacy, 'SELECT * FROM agent_requests ORDER BY id'),
    agent_request_events: snapshotRows(legacy, 'SELECT * FROM agent_request_events ORDER BY id'),
    processing_queue: snapshotRows(legacy, 'SELECT * FROM processing_queue ORDER BY id'),
  };
  legacy.close();

  console.log('Open the legacy database through lib/db.ts');
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
  const store = jiti('./lib/engine-store.ts');
  const count = (sql, ...args) => sqlite.prepare(sql).get(...args).n;

  for (const [name, sql] of Object.entries({
    conversations: 'SELECT id, type, bot_id, group_id, created_at FROM conversations ORDER BY id',
    messages: 'SELECT id, conversation_id, sender_type, sender_id, content, created_at, request_id FROM messages ORDER BY id',
    agent_requests: 'SELECT * FROM agent_requests ORDER BY id',
    agent_request_events: 'SELECT * FROM agent_request_events ORDER BY id',
    processing_queue: 'SELECT * FROM processing_queue ORDER BY id',
  })) {
    assert(snapshotRows(sqlite, sql) === before[name], `${name} rows are unchanged`);
  }

  console.log('\nBackfill of terminal agent_requests');
  const rows = sqlite.prepare('SELECT * FROM work_requests ORDER BY created_at').all();
  assert(rows.map(row => row.legacy_agent_request_id).join(',') === 'req-completed,req-failed,req-op-a', 'only mappable terminal requests are backfilled');
  assert(count("SELECT COUNT(*) AS n FROM work_requests WHERE legacy_agent_request_id = 'req-op-b'") === 0, 'a key collision across legacy operations keeps the oldest row and skips the newer one');
  const done = rows[0];
  assert(done.state === 'completed' && JSON.parse(done.result).reply_message_id === 'm-1r' && done.terminal_at === t + 12, 'completed request maps state, result, and terminal time');
  assert(done.source_conversation_id === 'conv-api' && done.source_event_id === 'm-1' && done.intent === 'Explain the queue', 'source conversation, event, and intent map from the accepted message');
  assert(done.requester_kind === 'service' && done.requester_id === 'svc-1' && done.target_agent_id === 'bot-codex', 'requester and target map verbatim');
  const canonicalHash = store.workRequestHash({
    sourceConversationId: 'conv-api', sourceEventId: 'm-1', targetAgentId: 'bot-codex', intent: 'Explain the queue',
    executionKind: 'conversation', toolProfile: 'readonly',
  });
  assert(done.idempotency_key === 'k-1' && done.request_hash === canonicalHash, 'idempotency key carried over; request hash is the canonical intake hash');
  assert(done.execution_kind === 'conversation' && done.tool_profile === 'readonly' && done.root_request_id === done.id && done.depth === 0, 'legacy turns map to read-only conversation roots');
  const policy = JSON.parse(done.policy_snapshot);
  assert(policy.source === 'legacy_agent_requests' && policy.legacy_runtime === 'codex' && policy.legacy_operation === 'send_message', 'policy snapshot records legacy provenance');
  const failed = rows[1];
  assert(failed.state === 'failed' && failed.error_code === 'runtime_failed' && failed.error_message.startsWith('The agent runtime'), 'failed request maps its error');
  const events = engine.listEvents(done.id);
  assert(events.map(e => `${e.sequence}:${e.type}`).join(',') === '1:accepted,2:dispatched,3:runtime_started,4:completed,5:backfilled', 'legacy events copied in order, then a backfilled marker');
  assert(events[1].data === '{"agent":"codex"}', 'legacy event data copied verbatim');
  assert(count('SELECT COUNT(*) AS n FROM work_attempts') === 0, 'no attempts are synthesized for legacy rows');

  console.log('\nBackfill is idempotent and picks up rows that finish later');
  store.migrateEngineSchema(new Database(DB_PATH));
  assert(count('SELECT COUNT(*) AS n FROM work_requests') === 3, 'reopening does not duplicate backfilled rows');
  sqlite.prepare("UPDATE agent_requests SET state = 'completed', reply_message_id = 'm-x', updated_at = ? WHERE id = 'req-dispatched'").run(t + 30);
  store.migrateEngineSchema(new Database(DB_PATH));
  assert(count("SELECT COUNT(*) AS n FROM work_requests WHERE legacy_agent_request_id = 'req-dispatched'") === 1, 'a legacy row that later completes is backfilled on the next open');
  assert(count('SELECT COUNT(*) AS n FROM schema_migrations') === store.ENGINE_SCHEMA_VERSION, 'schema migrations applied once');

  console.log('\nBackfilled rows share the canonical idempotency scope');
  const replayInput = {
    sourceConversationId: 'conv-api', sourceEventId: 'm-1', requester: { kind: 'service', id: 'svc-1' },
    targetAgentId: 'bot-codex', intent: 'Explain the queue', executionKind: 'conversation', toolProfile: 'readonly',
    idempotencyKey: 'k-1',
  };
  const eventsBeforeReplay = engine.listEvents(done.id).length;
  const replay = engine.createOrGetWorkRequest(replayInput);
  assert(replay.created === false && replay.request.id === done.id, 'an exact replay of a backfilled request returns the backfilled row');
  assert(engine.listEvents(done.id).length === eventsBeforeReplay, 'replay appends no events');
  throwsCode(() => engine.createOrGetWorkRequest({ ...replayInput, sourceEventId: 'm-new' }), 'idempotency_conflict', 'a reused legacy key with a different payload is a conflict');
  assert(count("SELECT COUNT(*) AS n FROM work_requests WHERE idempotency_key = 'k-1'") === 1, 'still one request for the legacy key');

  console.log('\nA canonical request that already holds a legacy key wins');
  const native = engine.createOrGetWorkRequest({ ...replayInput, sourceEventId: 'm-3', intent: 'Pending', idempotencyKey: 'k-3' }).request;
  sqlite.prepare("UPDATE agent_requests SET state = 'completed', reply_message_id = 'm-y', updated_at = ? WHERE id = 'req-accepted'").run(t + 40);
  let reopened = true;
  try { store.migrateEngineSchema(new Database(DB_PATH)); } catch { reopened = false; }
  assert(reopened, 'reopening with a colliding legacy row succeeds');
  assert(count("SELECT COUNT(*) AS n FROM work_requests WHERE legacy_agent_request_id = 'req-accepted'") === 0
    && count("SELECT COUNT(*) AS n FROM work_requests WHERE idempotency_key = 'k-3'") === 1
    && engine.getWorkRequest(native.id).legacy_agent_request_id === null, 'the colliding legacy row stays legacy-only');
  assert(count("SELECT COUNT(*) AS n FROM agent_requests WHERE id IN ('req-op-b', 'req-accepted')") === 2, 'skipped legacy rows are kept');

  finish();
}
