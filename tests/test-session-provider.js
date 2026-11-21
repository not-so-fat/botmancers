#!/usr/bin/env node
// NOT-503: the SessionProvider boundary (lib/session-provider), the
// provider-session registry (engine migration 17, lib/provider-sessions),
// and a deterministic fake direct provider (test-support/fake-session-provider)
// driven end to end without Agent Deck.
// Proves: the contract's capability discovery and conformance (supported
// and unsupported capabilities, authority modes); the registry backfills
// existing bindings under their own ids, imports discovery idempotently in
// the registered scope (re-sync, search, page bounds, the same provider id
// on another connection or Agent, out-of-scope and missing-scope refusal);
// transcript pages; start in an explicit workspace; send/observe/cancel with
// idempotency; resume and observe after a Botmancers restart (a second
// process on the same database); missing sessions kept, not deleted; and no
// provider id in any normal view.
// Self-contained: isolated SQLite and state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT503_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-provider-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
const STATE = { laptop: path.join(TMP, 'laptop.json'), workstation: path.join(TMP, 'workstation.json'), limited: path.join(TMP, 'limited.json') };
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
// No transport may reach the network: every fetch is counted and refused.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const catalog = jiti('./lib/session-catalog.ts');
const fake = require('./test-support/fake-session-provider');

const db = dbModule.default;
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
const SECRET = /SECRET/;
const owner = { kind: 'person', id: 'local-owner' };

function registerFakes(ids) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId: ids.laptop }, () => fake.createFakeSessionProvider({ statePath: STATE.laptop, ignoreScope: true }));
  contract.registerSessionProvider({ connectionId: ids.workstation }, () => fake.createFakeSessionProvider({ statePath: STATE.workstation }));
  contract.registerSessionProvider({ connectionId: ids.limited }, () => fake.createFakeSessionProvider({
    statePath: STATE.limited, kind: 'fake-limited',
    capabilities: { list: false, search: false, read: false, resume: false, start: false, cancel: false, usage: false, authorities: ['read_only'] },
  }));
}

function agent(name, connectionId, scope, policy) {
  return dbModule.bots.create({
    name, title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: scope.kind, session_scope_items: JSON.stringify(scope.items ?? []),
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0, allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

async function main() {
  console.log('\nContract: capability discovery and selection');
  const normalized = contract.normalizeCapabilities({ list: true, read: 'yes', authorities: ['read_only', 'root'], max_page_size: 10_000, extra: true });
  assert(normalized.list === true && normalized.read === false && normalized.resume === false && JSON.stringify(normalized.authorities) === '["read_only"]'
    && normalized.max_page_size === contract.MAX_PROVIDER_PAGE && !('extra' in normalized), 'capabilities are data: only explicit true flags, known authority modes, a clamped page size');
  assert(contract.normalizeCapabilities(null).max_page_size === contract.DEFAULT_PROVIDER_PAGE && contract.normalizeCapabilities(null).authorities.length === 0,
    'no capabilities reported means none supported');
  assert(JSON.stringify(contract.SESSION_PROVIDER_CAPABILITIES) === JSON.stringify(['list', 'search', 'read', 'resume', 'start', 'cancel', 'usage']),
    'the capability vocabulary is list, search, read, resume, start, cancel, usage');
  contract.clearSessionProviders({ builtins: true });
  assert(contract.sessionProviderFor({ id: 'rc-x', provider: 'codex' }) === null, 'no provider is registered by default (no real runtime adapter in this slice)');
  contract.registerSessionProvider({ provider: 'codex' }, () => ({ kind: 'by-provider' }));
  contract.registerSessionProvider({ connectionId: 'rc-x' }, () => ({ kind: 'by-connection' }));
  assert(contract.sessionProviderFor({ id: 'rc-x', provider: 'codex' }).kind === 'by-connection'
    && contract.sessionProviderFor({ id: 'rc-y', provider: 'codex' }).kind === 'by-provider', 'a connection registration wins over the provider-kind fallback');

  console.log('\nContract: fake provider conformance');
  const probePath = path.join(TMP, 'probe.json');
  fake.seedFakeProvider(probePath, [{ id: 'probe-1', title: 'Probe', workspace: '/w', transcript: [['user', 'hi']] }, { id: 'probe-2', workspace: '/w', resumable: false }]);
  const probe = fake.createFakeSessionProvider({ statePath: probePath });
  const correlation = { requestId: null };
  const caps = probe.capabilities();
  assert(contract.SESSION_PROVIDER_CAPABILITIES.every(key => typeof caps[key] === 'boolean') && Array.isArray(caps.authorities) && caps.max_page_size > 0,
    'capabilities() reports every flag, its authority modes, and a page bound');
  const listed = await probe.listSessions({ scope: { kind: 'all_provider_sessions', workspaces: [], provider_session_ids: [] }, limit: 1, correlation });
  assert(listed.ok && listed.value.items.length === 1 && listed.value.next_cursor !== null, 'listSessions honors the page bound and returns a continuation');
  assert((await probe.getSession({ provider_session_id: 'nope', correlation })).value === null, 'getSession of an unknown session is ok(null): missing, not an error');
  assert((await probe.readTranscript({ provider_session_id: 'nope', limit: 5, correlation })).error.code === 'not_found', 'readTranscript of an unknown session is not_found');
  const h1 = await probe.startSession({ workspace: '/w/new', prompt: 'go', authority: 'read_only', idempotency_key: 'k1', correlation });
  const h2 = await probe.startSession({ workspace: '/w/new', prompt: 'go', authority: 'read_only', idempotency_key: 'k1', correlation });
  assert(h1.ok && h1.value.provider_turn_id === h2.value.provider_turn_id, 'startSession is idempotent per key');
  const observed = await probe.observeTurn({ provider_turn_id: h1.value.provider_turn_id, correlation });
  assert(observed.ok && observed.value.status === 'completed' && /go$/.test(observed.value.output), 'observeTurn resolves to a terminal result');
  assert((await probe.cancelTurn({ provider_turn_id: h1.value.provider_turn_id, correlation })).value === 'already_terminal', 'cancelTurn of a finished turn is already_terminal');
  assert((await probe.sendTurn({ provider_session_id: 'probe-2', prompt: 'x', authority: 'read_only', idempotency_key: 'k2', correlation })).error.code === 'not_resumable',
    'sendTurn to a session the provider cannot resume is not_resumable');

  console.log('\nRegistry: Agents on runtime connections, no Agent Deck');
  const { runtimeConnections, engine, conversations } = dbModule;
  const ids = {
    laptop: runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id,
    workstation: runtimeConnections.create({ provider: 'codex', label: 'Codex workstation', host: 'Workstation' }).id,
    limited: runtimeConnections.create({ provider: 'codex', label: 'Codex limited', host: 'This computer' }).id,
    bare: runtimeConnections.create({ provider: 'codex', label: 'Codex bare', host: 'This computer' }).id,
  };
  registerFakes(ids);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const dev = agent('Dev', ids.laptop, { kind: 'workspaces', items: ['/work/alpha'] }, write);
  const twin = agent('Twin', ids.workstation, { kind: 'all_provider_sessions' }, { mode: 'read_only', newSessions: true });
  const peer = agent('Peer', ids.laptop, { kind: 'all_provider_sessions' }, { mode: 'read_only', newSessions: false });
  const limited = agent('Limited', ids.limited, { kind: 'all_provider_sessions' }, write);
  const bare = agent('Bare', ids.bare, { kind: 'all_provider_sessions' }, write);
  assert([dev, twin, peer, limited, bare].every(bot => dbModule.bots.getById(bot.id).deck_id === null && dbModule.bots.getById(bot.id).launch_profile === 'direct'),
    'every Agent here is direct with no deck selected');

  fake.seedFakeProvider(STATE.laptop, [
    { id: 'native-a1-SECRET', title: 'Refactor the parser', workspace: '/work/alpha/parser', transcript: [
      ['user', 'Refactor the parser'], ['assistant', 'Plan ready'], ['user', 'Go ahead'], ['assistant', 'Done in native-a1-SECRET'], ['user', 'Thanks'],
    ] },
    { id: 'native-a2-SECRET', title: 'Archived spike', workspace: '/work/alpha', lifecycle: 'archived', resumable: true, transcript: [['user', 'spike']] },
    { id: 'native-a3-SECRET', title: 'Old prototype', workspace: '/work/alpha/old', resumable: false },
    { id: 'native-b1-SECRET', title: 'Outside work', workspace: '/work/beta' },
    { id: 'native-n1-SECRET', title: 'No workspace' },
    { id: 'bound-x-SECRET', title: 'Launched by Botmancers', workspace: '/work/alpha' },
  ]);
  fake.seedFakeProvider(STATE.workstation, [{ id: 'native-a1-SECRET', title: 'Same id, other connection', workspace: '/work/alpha' }]);
  fake.seedFakeProvider(STATE.limited, [{ id: 'limited-1-SECRET', title: 'Limited', workspace: '/work/alpha' }]);

  // A Botmancers-launched session of Dev: its binding registers itself.
  const devConv = conversations.getByBotId(dev.id);
  const binding = engine.bindSession({ agentId: dev.id, adapter: 'codex', externalSessionId: 'bound-x-SECRET', conversationId: devConv.id });
  const bound = db.prepare('SELECT * FROM provider_sessions WHERE binding_id = ?').get(binding.id);
  assert(bound && bound.id === binding.id && bound.origin === 'binding' && bound.runtime_connection_id === ids.laptop
    && bound.provider_session_id === 'bound-x-SECRET' && bound.resumable === null && bound.last_synced_at === null,
  'bindSession registers the binding under its own id, on the Agent\'s connection, provider state unknown');

  console.log('\nMigration 17: backfill as release 16 left the database');
  const copyPath = path.join(TMP, 'release-16.db');
  db.exec(`VACUUM INTO '${copyPath}'`);
  const Database = require('better-sqlite3');
  const old = new Database(copyPath);
  old.exec(`
    DROP TABLE provider_session_events; DROP TABLE provider_session_turns; DROP TABLE provider_sessions;
    DELETE FROM schema_migrations WHERE version = 17;
  `);
  const bindingsBefore = old.prepare('SELECT id, agent_id, external_session_id FROM session_bindings ORDER BY id').all();
  const store = jiti('./lib/engine-store.ts');
  store.migrateEngineSchema(old);
  const backfilled = old.prepare('SELECT * FROM provider_sessions ORDER BY id').all();
  assert(bindingsBefore.length >= 1 && backfilled.length === bindingsBefore.length
    && backfilled.every((row, i) => row.id === bindingsBefore[i].id && row.binding_id === row.id && row.origin === 'binding'
      && row.provider_session_id === bindingsBefore[i].external_session_id && row.resumable === null && row.availability === 'available'),
  'every existing binding gets one registry row under its unchanged reference, provider id kept privately');
  assert(backfilled.find(row => row.id === binding.id).runtime_connection_id === ids.laptop, 'backfill records the Agent\'s registered runtime connection');
  store.migrateEngineSchema(old);
  assert(old.prepare('SELECT COUNT(*) AS n FROM provider_sessions').get().n === backfilled.length, 're-running migrations backfills nothing twice');
  old.close();

  console.log('\nDiscovery: bounded, idempotent, inside the registered scope');
  const page1 = await ps.syncAgentSessions(db, dev.id, { now: 1000 });
  assert(page1.imported.length === 3 && page1.updated.length === 0 && page1.rejected_out_of_scope === 0 && page1.next_cursor === '3',
    'page 1 (bounded by the provider\'s max page size) imports three pre-existing native sessions');
  const page2 = await ps.syncAgentSessions(db, dev.id, { cursor: page1.next_cursor, now: 1001 });
  assert(page2.imported.length === 0 && JSON.stringify(page2.updated) === JSON.stringify([binding.id]) && page2.rejected_out_of_scope === 2 && page2.next_cursor === null,
    'page 2: two out-of-scope sessions refused; the Botmancers-launched one maps onto its binding reference');
  const devRefs = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND binding_id IS NULL ORDER BY id").all(dev.id).map(row => row.id);
  const resync1 = await ps.syncAgentSessions(db, dev.id, { now: 2000 });
  const resync2 = await ps.syncAgentSessions(db, dev.id, { cursor: resync1.next_cursor, now: 2001 });
  assert(resync1.imported.length === 0 && resync2.imported.length === 0 && resync1.updated.length === 3 && resync2.updated.length === 1,
    're-sync imports nothing new');
  assert(JSON.stringify(db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND binding_id IS NULL ORDER BY id").all(dev.id).map(row => row.id)) === JSON.stringify(devRefs)
    && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 4, 're-sync keeps every reference and the row count (3 native + 1 binding)');
  assert(count("SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ? AND provider_session_id IN ('native-b1-SECRET', 'native-n1-SECRET')", dev.id) === 0,
    'out-of-scope sessions are never stored');
  assert(count("SELECT COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? AND type = 'sync_rejected_out_of_scope'", dev.id) === 2
    && !SECRET.test(JSON.stringify(db.prepare('SELECT * FROM provider_session_events').all())), 'refusals are audited by count; events never name a provider id');
  const bigLimit = await ps.syncAgentSessions(db, dev.id, { limit: 50, now: 2002 });
  const lastList = fake.loadFakeState(STATE.laptop).calls.filter(call => call.op === 'listSessions').pop();
  assert(lastList.limit === 3 && bigLimit.updated.length === 3, 'a larger requested limit is clamped to the provider bound');
  const search = await ps.syncAgentSessions(db, dev.id, { query: 'parser', now: 2003 });
  assert(search.updated.length === 1 && fake.loadFakeState(STATE.laptop).calls.filter(call => call.op === 'listSessions').pop().query === 'parser',
    'search passes the query to a provider with the search capability');
  let dup = null;
  try {
    db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, created_at, updated_at)
      VALUES ('dup', ?, ?, 'fake-direct', 'native-a1-SECRET', 'discovered', 0, 0)`).run(dev.id, ids.laptop);
  } catch (error) { dup = error; }
  assert(dup && /UNIQUE constraint failed/.test(dup.message), 'the unique index refuses a second unlinked row for the same (Agent, connection, provider session)');

  const twinSync = await ps.syncAgentSessions(db, twin.id, { now: 3000 });
  const peerSync1 = await ps.syncAgentSessions(db, peer.id, { now: 3001 });
  const peerSync2 = await ps.syncAgentSessions(db, peer.id, { cursor: peerSync1.next_cursor, now: 3002 });
  const a1Rows = db.prepare("SELECT id, agent_id, runtime_connection_id FROM provider_sessions WHERE provider_session_id = 'native-a1-SECRET' ORDER BY agent_id").all();
  assert(twinSync.imported.length === 1 && a1Rows.length === 3 && new Set(a1Rows.map(row => row.id)).size === 3
    && a1Rows.some(row => row.runtime_connection_id === ids.workstation), 'the same provider id on another connection (or another Agent) is another session with its own reference');
  assert(peerSync1.imported.length + peerSync2.imported.length === 6 && peerSync2.rejected_out_of_scope === 0,
    'an explicit all_provider_sessions scope imports every visible session (Peer has no binding, so bound-x is native for it)');

  // A 'sessions' scope admits exactly the selected references.
  const peerA1 = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'native-a1-SECRET'").get(peer.id).id;
  db.prepare("UPDATE bots SET session_scope_kind = 'sessions', session_scope_items = ? WHERE id = ?").run(JSON.stringify([peerA1]), peer.id);
  const picky1 = await ps.syncAgentSessions(db, peer.id, { now: 3100 });
  const picky2 = await ps.syncAgentSessions(db, peer.id, { cursor: picky1.next_cursor, now: 3101 });
  assert(JSON.stringify([...picky1.updated, ...picky2.updated]) === JSON.stringify([peerA1]) && picky1.rejected_out_of_scope + picky2.rejected_out_of_scope === 5,
    'a selected-sessions scope re-syncs only the selected reference');
  db.prepare("UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?").run(twin.id);
  const twinCallsBefore = fake.providerCalls(STATE.workstation, 'listSessions');
  await rejects(ps.syncAgentSessions(db, twin.id), 'scope_missing', 'an Agent without a stored scope imports nothing (an empty scope is never unrestricted)');
  assert(fake.providerCalls(STATE.workstation, 'listSessions') === twinCallsBefore, 'the provider is not even asked without a scope');
  await rejects(ps.syncAgentSessions(db, bare.id), 'provider_unavailable', 'a connection without a session provider is provider_unavailable');
  assert(ps.agentProviderCapabilities(db, bare.id) === null && ps.agentProviderCapabilities(db, dev.id).provider_kind === 'fake-direct',
    'capability discovery per Agent: null without a provider, the provider\'s capabilities otherwise');

  console.log('\nNOT-558: a provider that reports itself unavailable is logged, not echoed');
  const downConnection = runtimeConnections.create({ provider: 'claude', label: 'Claude down', host: 'This computer' }).id;
  contract.registerSessionProvider({ connectionId: downConnection }, () => ({
    ...fake.createFakeSessionProvider({ statePath: path.join(TMP, 'down.json') }),
    ready: async () => ({ ok: false, error: { code: 'unavailable', message: `claude --version failed\nSECRET-MARKER-123 spawn ENOENT\n${'x'.repeat(400)}` } }),
  }));
  const down = agent('Down', downConnection, { kind: 'all_provider_sessions' }, write);
  const logged = [];
  const realConsoleError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let downError = null;
  try { await ps.syncAgentSessions(db, down.id); } catch (error) { downError = error; } finally { console.error = realConsoleError; }
  assert(downError && downError.code === 'provider_unavailable'
    && downError.message === 'The Agent’s runtime reported itself unavailable (it may not be installed, signed in, or startable). The Botmancers core log has the detail.',
  'ready() unavailable maps to provider_unavailable with the Botmancers-authored message');
  assert(!/SECRET-MARKER-123/.test(downError && downError.message), 'the provider message never reaches the thrown error');
  const refused = logged.filter(line => line.startsWith('Session provider refused a call:'));
  assert(logged.length === 1 && refused.length === 1, `exactly one console.error line is written (got ${logged.length})`);
  const line = refused[0] || '';
  assert(line.includes(down.id) && line.includes('unavailable') && line.includes('SECRET-MARKER-123') && !/[\r\n]/.test(line),
    'the log line names the agent id, the provider code and the provider message on one line');
  const loggedMessage = (line.split('message=')[1] || '');
  assert(loggedMessage.length <= 300, `the logged provider message is truncated to 300 characters (got ${loggedMessage.length})`);

  console.log('\nNOT-560: a Claude Code turn that exits with no output logs the core process context');
  {
    const claude = jiti('./lib/claude-session-provider.ts');
    const ws = path.join(TMP, 'silent-ws');
    fs.mkdirSync(ws, { recursive: true });
    const claudeState = path.join(TMP, 'claude-state');
    // The real `claude --version` check runs against the stand-in CLI; each
    // turn process is replaced by a plain node script.
    const turnProcess = script => (command, args, options) => require('child_process').spawn(process.execPath, ['-e', script], options);
    const claudeProvider = script => claude.createClaudeSessionProvider({
      bin: path.join(ROOT, 'test-support', 'fake-claude-cli.js'), configDir: path.join(TMP, 'claude-config'), stateDir: claudeState,
      env: { ...process.env }, pollMs: 10, startupTimeoutMs: 10_000, spawn: turnProcess(script),
    });
    const silentConnection = runtimeConnections.create({ provider: 'claude', label: 'Claude silent', host: 'This computer' }).id;
    const silent = agent('Silent', silentConnection, { kind: 'workspaces', items: [ws] }, write);
    const capture = async (script, key) => {
      contract.registerSessionProvider({ connectionId: silentConnection }, () => claudeProvider(script));
      const lines = [];
      const original = console.error;
      console.error = (...args) => { lines.push(args.map(String).join(' ')); };
      let error = null;
      try {
        await ps.startProviderSession(db, silent.id, { workspace: ws, prompt: 'x', authority: 'read_only', idempotencyKey: key, requester: owner });
      } catch (caught) { error = caught; } finally { console.error = original; }
      return { error, lines, refused: lines.find(line => line.startsWith('Session provider refused a call:')) || '', noOutput: lines.find(line => line.startsWith('Session provider turn ended with no output:')) || '' };
    };

    const exit0 = await capture('process.exit(0)', 'silent-0');
    const turnFiles = fs.readdirSync(path.join(claudeState, 'turns'));
    const errLog = turnFiles.find(name => name.endsWith('.err.log'));
    assert(errLog && fs.statSync(path.join(claudeState, 'turns', errLog)).size === 0
      && fs.statSync(path.join(claudeState, 'turns', errLog.replace('.err.log', '.out.jsonl'))).size === 0, 'the silent turn left a zero-byte err.log and out.jsonl');
    assert(exit0.error && exit0.error.code === 'provider_unavailable', `a silent exit 0 is provider_unavailable to the caller (got ${exit0.error && exit0.error.code})`);
    assert(/message=Claude Code exited with no output \(exit 0\): no result event, empty stdout and stderr\./.test(exit0.refused),
      `the refused line names the no-output case and exit 0: ${exit0.refused}`);
    const context = ps.noOutputProcessContext();
    assert(exit0.noOutput.includes(`agent=${silent.id}`) && exit0.noOutput.includes('code=unavailable')
      && exit0.noOutput.includes(`daemon_pid=${process.pid}`) && exit0.noOutput.includes(`parent_pid=${process.ppid}`)
      && exit0.noOutput.includes(`detached=${context.detached}`) && /detached=(true|false)$/.test(exit0.noOutput) && !/[\r\n]/.test(exit0.noOutput),
    `a distinct one-line log names agent, provider code, daemon pid, parent pid and detached status: ${exit0.noOutput}`);
    assert(exit0.lines.length === 2, `exactly two core log lines for a silent exit (got ${exit0.lines.length})`);

    const exit3 = await capture('process.exit(3)', 'silent-3');
    assert(/exited with no output \(exit 3\)/.test(exit3.refused) && exit3.noOutput.includes('daemon_pid='),
      'a silent non-zero exit is also named no-output, with its exit code, and logs the process context');
    const signalled = await capture("process.kill(process.pid, 'SIGTERM')", 'silent-sig');
    assert(/exited with no output \(signal SIGTERM\)/.test(signalled.refused), `a silent signal termination names the signal: ${signalled.refused}`);

    const noisy = await capture(`process.stderr.write('first line\\n' + 'y'.repeat(150) + '\\nLast words: keychain locked'); process.exit(1)`, 'noisy-1');
    const tail = (noisy.refused.split(' stderr: ')[1] || '');
    assert(/message=Claude Code exited without a result \(exit 1\)\. stderr: /.test(noisy.refused) && tail.endsWith('Last words: keychain locked')
      && tail.length === 100 && !tail.includes('first line') && !/[\r\n]/.test(noisy.refused),
    `stderr's last 100 characters are appended on one line: ${noisy.refused}`);
    assert(noisy.noOutput === '', 'a turn that wrote stderr is not logged as no-output');

    const rejected = await capture(`process.stderr.write('z'.repeat(150) + '\\nerror: unknown option --bogus-flag'); process.exit(1)`, 'rejected-1');
    const rejectedTail = (rejected.refused.split(' stderr: ')[1] || '');
    assert(/message=The installed Claude Code rejected the non-interactive flag set\. stderr: /.test(rejected.refused)
      && rejectedTail.endsWith('error: unknown option --bogus-flag') && rejectedTail.length === 100 && !/[\r\n]/.test(rejected.refused),
    `an incompatible-version exit also appends stderr's last 100 characters on one line: ${rejected.refused}`);

    // A turn that cannot be spawned (here: a working directory that vanished
    // after the startSession check) is a spawn error, never "no output".
    {
      const gone = path.join(TMP, 'vanishing-ws');
      fs.mkdirSync(gone, { recursive: true });
      const spawnFails = claude.createClaudeSessionProvider({
        bin: path.join(ROOT, 'test-support', 'fake-claude-cli.js'), configDir: path.join(TMP, 'claude-config'), stateDir: claudeState,
        env: { ...process.env }, pollMs: 10, startupTimeoutMs: 10_000,
        spawn: (command, args, options) => { fs.rmSync(gone, { recursive: true, force: true }); return require('child_process').spawn(process.execPath, ['-e', ''], { ...options, cwd: gone }); },
      });
      const started = await spawnFails.startSession({ workspace: gone, prompt: 'x', authority: 'read_only', idempotency_key: 'spawn-fail-1', correlation: {} });
      const message = (started.error && started.error.message) || '';
      assert(started.error && started.error.code === 'unavailable' && /could not start: spawn .*ENOENT/.test(message) && message.includes(gone) && !/no output|status unknown/.test(message),
        `a spawn failure names the spawn error and working directory, not no-output: ${message}`);
      assert(!started.error.no_output, 'a spawn failure is not flagged no_output');
    }

    // The turn-level classification: exit 0 with no output is its own code.
    const provider = claudeProvider('process.exit(0)');
    const turnsDir = path.join(claudeState, 'turns');
    const writeTurn = (fields, err = '') => {
      const id = `ct-${require('crypto').randomUUID()}`;
      fs.writeFileSync(path.join(turnsDir, `${id}.json`), JSON.stringify({
        id, session_id: require('crypto').randomUUID(), kind: 'send', authority: 'read_only', workspace: ws, pid: null,
        state: 'exited', exit_code: 0, created_at: 1, finished_at: 2, ...fields,
      }));
      fs.writeFileSync(path.join(turnsDir, `${id}.out.jsonl`), '');
      fs.writeFileSync(path.join(turnsDir, `${id}.err.log`), err);
      return id;
    };
    const observe = async id => (await provider.observeTurn({ provider_turn_id: id, correlation: {} })).value.failure;
    const zero = await observe(writeTurn({ exit_code: 0 }));
    const one = await observe(writeTurn({ exit_code: 1 }));
    const killed = await observe(writeTurn({ exit_code: null, exit_signal: 'SIGKILL' }));
    const spoke = await observe(writeTurn({ exit_code: 0 }, 'boom\n'));
    assert(zero.code === 'process_exited_no_output' && zero.no_output === true && /no output \(exit 0\)/.test(zero.message),
      `exit 0 with no output is process_exited_no_output (got ${zero.code})`);
    assert(one.code === 'process_exited' && one.no_output === true && killed.code === 'process_exited' && /signal SIGKILL/.test(killed.message),
      'another exit code or a signal with no output stays process_exited, still flagged no-output');
    assert(spoke.code === 'process_exited' && !spoke.no_output && /stderr: boom$/.test(spoke.message), 'exit 0 with stderr is process_exited with the stderr tail');
    const incompatible = await observe(writeTurn({ exit_code: 1 }, 'error: unrecognized option --x\n'));
    assert(incompatible.code === 'incompatible_version' && /flag set\. stderr: error: unrecognized option --x$/.test(incompatible.message),
      `an incompatible-version failure carries the stderr tail (got ${incompatible.message})`);
    registerFakes(ids);
  }

  console.log('\nUnsupported capabilities are refused before the provider is called');
  const limitedRef = (() => {
    const id = require('crypto').randomUUID();
    db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, resumable, created_at, updated_at)
      VALUES (?, ?, ?, 'fake-limited', 'limited-1-SECRET', 'discovered', 1, 0, 0)`).run(id, limited.id, ids.limited);
    return id;
  })();
  await rejects(ps.syncAgentSessions(db, limited.id), 'unsupported', 'list unsupported');
  await rejects(ps.readProviderTranscript(db, limited.id, limitedRef), 'unsupported', 'read unsupported');
  await rejects(ps.startProviderSession(db, limited.id, { workspace: '/work/alpha', prompt: 'x', authority: 'read_only', idempotencyKey: 'l1', requester: owner }), 'unsupported', 'start unsupported');
  await rejects(ps.sendProviderTurn(db, limited.id, limitedRef, { prompt: 'x', authority: 'read_only', idempotencyKey: 'l2', requester: owner }), 'unsupported', 'resume unsupported');
  assert(fake.providerCalls(STATE.limited) === 0, 'the limited provider received no call at all');
  contract.registerSessionProvider({ connectionId: ids.limited }, () => fake.createFakeSessionProvider({ statePath: STATE.limited, kind: 'fake-limited', capabilities: { authorities: ['read_only'] } }));
  await rejects(ps.startProviderSession(db, limited.id, { workspace: '/work/alpha', prompt: 'x', authority: 'workspace_write', idempotencyKey: 'l3', requester: owner }),
    'authority_not_allowed', 'workspace_write is refused when the provider cannot enforce it, even for a workspace_write Agent');
  registerFakes(ids);

  console.log('\nTranscript pages');
  const a1 = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'native-a1-SECRET'").get(dev.id).id;
  const pages = [];
  let cursor = null;
  do {
    const pageN = await ps.readProviderTranscript(db, dev.id, a1, { cursor, limit: 2 });
    pages.push(pageN);
    cursor = pageN.next_cursor;
  } while (cursor && pages.length < 10);
  const entries = pages.flatMap(pageN => pageN.entries);
  assert(pages.length === 3 && pages.every(pageN => pageN.entries.length <= 2 && pageN.session_ref === a1) && entries.map(entry => entry.seq).join(',') === '1,2,3,4,5',
    'a pre-existing session\'s transcript reads in bounded pages, in order');
  assert(entries[3].text === 'Done in [redacted]' && !SECRET.test(JSON.stringify(pages)), 'the provider session id is redacted out of transcript text');
  await rejects(ps.readProviderTranscript(db, twin.id, a1), 'session_not_found', 'another Agent\'s reference is session_not_found');

  console.log('\nStart in an explicit workspace');
  const startInput = { workspace: '/work/alpha/new', prompt: 'Scaffold the new module\nwith tests', authority: 'workspace_write', idempotencyKey: 'start-1', requester: owner, correlation: { requestId: 'corr-1' } };
  await rejects(ps.startProviderSession(db, dev.id, { ...startInput, workspace: 'relative/path' }), 'invalid_input', 'a relative workspace is refused');
  await rejects(ps.startProviderSession(db, dev.id, { ...startInput, authority: undefined }), 'invalid_input', 'authority is never defaulted');
  await rejects(ps.startProviderSession(db, dev.id, { ...startInput, workspace: '/work/beta/x' }), 'out_of_scope', 'a workspace outside the scope is refused');
  await rejects(ps.startProviderSession(db, peer.id, { ...startInput, authority: 'read_only' }), 'out_of_scope', 'a selected-sessions scope cannot start new sessions');
  const startsBefore = fake.providerCalls(STATE.laptop, 'startSession');
  const started = await ps.startProviderSession(db, dev.id, startInput);
  const replayStart = await ps.startProviderSession(db, dev.id, startInput);
  assert(started.turn.state === 'running' && started.turn.kind === 'start' && started.turn.authority === 'workspace_write' && !started.replayed,
    'start records a running turn with its explicit authority');
  assert(replayStart.replayed && replayStart.turn.turn_ref === started.turn.turn_ref && fake.providerCalls(STATE.laptop, 'startSession') === startsBefore + 1,
    'the same idempotency key replays the turn without calling the provider again');
  await rejects(ps.startProviderSession(db, dev.id, { ...startInput, prompt: 'Something else' }), 'idempotency_conflict', 'the same key with another body conflicts');
  const startedRow = db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(started.turn.session_ref);
  assert(startedRow.origin === 'started' && startedRow.workspace === '/work/alpha/new' && startedRow.title === 'Scaffold the new module' && startedRow.busy === 1,
    'the new session gets a Botmancers reference, its workspace, a title from the prompt, and busy');
  const doneStart = await ps.observeProviderTurn(db, dev.id, started.turn.turn_ref);
  const observes = fake.providerCalls(STATE.laptop, 'observeTurn');
  const again = await ps.observeProviderTurn(db, dev.id, started.turn.turn_ref);
  assert(doneStart.state === 'completed' && /Scaffold the new module/.test(doneStart.output) && again.state === 'completed'
    && fake.providerCalls(STATE.laptop, 'observeTurn') === observes, 'observe reaches the terminal output once; a repeat reads it from the registry');
  assert(db.prepare('SELECT busy FROM provider_sessions WHERE id = ?').get(started.turn.session_ref).busy === 0, 'the session is no longer busy');
  assert(JSON.parse(db.prepare('SELECT correlation FROM provider_session_turns WHERE id = ?').get(started.turn.turn_ref).correlation).requestId === 'corr-1',
    'the caller\'s correlation ids are recorded with the turn');

  // A turn started now and observed only after the restart.
  const pending = await ps.sendProviderTurn(db, dev.id, a1, { prompt: 'Summarize before the restart', authority: 'read_only', idempotencyKey: 'pre-restart', requester: owner });
  await rejects(ps.sendProviderTurn(db, dev.id, a1, { prompt: 'Second', authority: 'read_only', idempotencyKey: 'concurrent', requester: owner }), 'busy',
    'a session with a turn in flight is busy');
  await rejects(ps.sendProviderTurn(db, peer.id, peerA1, { prompt: 'x', authority: 'workspace_write', idempotencyKey: 'w1', requester: owner }),
    'authority_not_allowed', 'workspace_write is refused for a read_only Agent (never inferred from provider or workspace)');

  console.log('\nRestart: a second Botmancers process on the same database');
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: { ...process.env, NOT503_TAG: TAG, NOT503_IDS: JSON.stringify({ ...ids, dev: dev.id, a1, pending: pending.turn.turn_ref }) }, encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && result && result.failures === 0, 'the restarted process completed resume/observe/start/cancel');
  assert(result && result.fetchCalls === 0 && fetchCalls === 0, 'no network call (no Agent Deck) in either process');

  console.log('\nMissing sessions stay, with explicit availability');
  fake.mutateFakeProvider(STATE.laptop, state => { state.sessions['native-a3-SECRET'].deleted = true; });
  const a3 = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'native-a3-SECRET'").get(dev.id).id;
  const refreshed = await ps.refreshProviderSession(db, dev.id, a3, { now: 9000 });
  assert(refreshed.availability === 'missing' && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE id = ?', a3) === 1, 'a session the provider lost is marked missing, never deleted');
  await rejects(ps.readProviderTranscript(db, dev.id, a3), 'session_missing', 'reading a missing session is session_missing');

  console.log('\nOne catalog: native and Botmancers-launched sessions');
  const list = catalog.listAgentSessions(db, dev.id, 'all');
  const byRef = Object.fromEntries(list.map(s => [s.ref, s]));
  assert(list.length === 6 && byRef[binding.id].source === 'botmancers' && byRef[a1].source === 'native' && byRef[started.turn.session_ref].source === 'native',
    'the catalog lists the binding and every native session once, under Botmancers references');
  assert(byRef[binding.id].state.synced_at !== null && byRef[binding.id].state.resumable === true, 'the binding shows the provider facts its sync recorded');
  assert(byRef[a3].state.availability === 'missing' && byRef[a3].state.resumable === false, 'missing is explicit in the catalog');
  assert(!SECRET.test(JSON.stringify(list)) && !SECRET.test(JSON.stringify(catalog.getAgentSession(db, dev.id, a1))), 'no provider id in catalog summaries or details');
  assert(catalog.sessionDebugExternalId(db, dev.id, a1) === 'native-a1-SECRET' && catalog.sessionDebugExternalId(db, twin.id, a1) === undefined,
    'only the owner-only debug disclosure returns a native provider id, never across Agents');
  assert(dbModule.sessionBelongsToAgent(dev.id, a1) && !dbModule.sessionBelongsToAgent(twin.id, a1), 'a native reference belongs to its Agent for scope and home-session selection');

  console.log('\nCanonical rows and events');
  const turns = db.prepare('SELECT kind, state FROM provider_session_turns WHERE agent_id = ? ORDER BY created_at, id').all(dev.id);
  const eventCounts = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? GROUP BY type').all(dev.id).map(row => [row.type, row.n]));
  console.log(`  turns: ${JSON.stringify(turns)}`);
  console.log(`  events: ${JSON.stringify(eventCounts)}`);
  assert(turns.length === 6 && turns.filter(t => t.kind === 'start').length === 2 && turns.filter(t => t.state === 'completed').length === 4
    && turns.filter(t => t.state === 'cancelled').length === 2 && turns.every(t => t.state !== 'running'), 'six turns: four completed, two cancelled, none left running');
  assert(eventCounts.session_imported === 3 && eventCounts.session_started === 2 && eventCounts.turn_started === 6 && eventCounts.turn_completed === 4
    && eventCounts.turn_cancelled === 2 && eventCounts.cancel_requested === 2 && eventCounts.session_missing === 1, 'one event per lifecycle fact, no duplicates from replays or repeated cancels');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 6, 'Dev holds six registry rows (3 imported, 2 started, 1 binding)');

  console.log('\nAgent deletion removes its registry rows');
  dbModule.bots.remove(limited.id);
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', limited.id) === 0, 'the deleted Agent\'s sessions are gone with it');

  console.log('\nDocumentation contract');
  const core = fs.readFileSync(path.join(ROOT, 'docs/core-engine.md'), 'utf8');
  assert(/### Provider sessions/.test(core) && /SessionProvider/.test(core) && /availability/.test(core) && /provider_sessions/.test(core),
    'docs/core-engine.md documents the provider boundary, registry, and state facts');

  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session provider checks passed.');
}

// The second process: nothing in memory from the first. The provider is
// registered again from the Agent's runtime connection, and every
// reference comes from the database.
async function restart() {
  const ids = JSON.parse(process.env.NOT503_IDS);
  registerFakes(ids);
  const devId = ids.dev;
  console.log('observe a turn started before the restart');
  const pending = await ps.observeProviderTurn(db, devId, ids.pending);
  assert(pending.state === 'completed' && /Summarize before the restart/.test(pending.output), 'the pre-restart turn is observed to its terminal output');

  console.log('resume the pre-existing native session');
  const resumed = await ps.sendProviderTurn(db, devId, ids.a1, { prompt: 'Continue after restart', authority: 'workspace_write', idempotencyKey: 'resume-1', requester: owner });
  const done = await ps.observeProviderTurn(db, devId, resumed.turn.turn_ref);
  assert(done.state === 'completed' && /Continue after restart/.test(done.output) && done.session_ref === ids.a1, 'resume by Botmancers reference completes on the same session');
  const transcript = await ps.readProviderTranscript(db, devId, ids.a1, { cursor: '5', limit: 10 });
  const rest = await ps.readProviderTranscript(db, devId, ids.a1, { cursor: transcript.next_cursor, limit: 10 });
  const appended = [...transcript.entries, ...rest.entries];
  assert(transcript.entries.length === 3 && appended.length === 4 && appended[3].role === 'assistant' && rest.next_cursor === null,
    'the transcript (pages clamped to the provider bound) shows both turns appended to the native session');

  const a2 = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'native-a2-SECRET'").get(devId).id;
  const archived = await ps.sendProviderTurn(db, devId, a2, { prompt: 'Revive the spike', authority: 'read_only', idempotencyKey: 'resume-archived', requester: owner });
  assert((await ps.observeProviderTurn(db, devId, archived.turn.turn_ref)).state === 'completed', 'an archived session the provider says is resumable can be resumed');
  const a3 = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'native-a3-SECRET'").get(devId).id;
  await rejects(ps.sendProviderTurn(db, devId, a3, { prompt: 'x', authority: 'read_only', idempotencyKey: 'resume-old', requester: owner }), 'not_resumable',
    'a session the provider cannot resume is refused');

  console.log('start, observe with a deadline, and cancel idempotently');
  const held = await ps.startProviderSession(db, devId, { workspace: '/work/alpha/hold', prompt: '[hold] long task', authority: 'read_only', idempotencyKey: 'hold-1', requester: owner });
  const waited = await ps.observeProviderTurn(db, devId, held.turn.turn_ref, { deadlineAt: Date.now() + 30 });
  assert(waited.state === 'running', 'a deadline ends the wait only; the turn keeps running');
  const first = await ps.cancelProviderTurn(db, devId, held.turn.turn_ref);
  const second = await ps.cancelProviderTurn(db, devId, held.turn.turn_ref);
  assert(first.outcome === 'cancelled' && first.turn.state === 'cancelled' && second.outcome === 'already_terminal' && second.turn.state === 'cancelled',
    'cancel stops the turn; a repeated cancel is already_terminal');
  assert(fake.providerCalls(STATE.laptop, 'cancelTurn') === 1, 'the provider received exactly one cancel');
  const heldSend = await ps.sendProviderTurn(db, devId, ids.a1, { prompt: '[hold] watch', authority: 'read_only', idempotencyKey: 'hold-2', requester: owner });
  const controller = new AbortController();
  const watching = ps.observeProviderTurn(db, devId, heldSend.turn.turn_ref, { signal: controller.signal });
  const cancelled = await ps.cancelProviderTurn(db, devId, heldSend.turn.turn_ref);
  controller.abort();
  const watched = await watching;
  assert(cancelled.outcome === 'cancelled' && watched.state === 'cancelled', 'an observer waiting on a turn sees the cancel as its terminal result');
  const views = JSON.stringify([pending, done, transcript, held, first, second, cancelled, watched]);
  assert(!SECRET.test(views), 'no provider session or turn id in any turn view');
  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls })}`);
  process.exit(failures > 0 ? 1 : 0);
}
