#!/usr/bin/env node
// NOT-505: the direct Cursor CLI/SDK SessionProvider
// (lib/cursor-session-provider) behind the NOT-503 registry
// (lib/provider-sessions), driven through a fake `cursor-agent`
// (test-support/fake-cursor-cli.js) and a fake SDK module
// (test-support/fake-cursor-sdk.mjs). No network, no Agent Deck, no real
// Cursor.
// Proves: the structured stream parser on real-shaped fixtures (complete,
// partial, missing, malformed, repeated, error, half-written); installed
// capability selection (CLI primary, SDK fallback, neither); the
// listing-less capability set (list unsupported, explicit scoped import
// only) and the listing one (scoped, idempotent discovery); exact-session
// resume preserving cwd, authority, and correlation; missing or unknown
// resume targets never launching a fresh session; nullable usage samples;
// observe/cancel reattachment after a Botmancers restart (a second
// process); durable row/event counts; and no access to Cursor's own stores.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT505_TAG || `${process.pid}`;
const TMP = fs.realpathSync(os.tmpdir()) + `/botmancers-cursor-provider-${TAG}`;
const DIRS = {
  home: path.join(TMP, 'home'),
  bin: path.join(TMP, 'bin'),
  fakeMain: path.join(TMP, 'fake-main'),
  fakeListing: path.join(TMP, 'fake-listing'),
  fakeSdk: path.join(TMP, 'fake-sdk'),
  providerState: path.join(TMP, 'provider-state'),
  alpha: path.join(TMP, 'work', 'alpha'),
  beta: path.join(TMP, 'work', 'beta'),
};
const BIN = path.join(DIRS.bin, 'cursor-agent');
const SDK = path.join(ROOT, 'test-support', 'fake-cursor-sdk.mjs');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['app', 'app2', 'new', 'sdk']) fs.mkdirSync(path.join(DIRS.alpha, sub), { recursive: true });
  fs.writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test-support', 'fake-cursor-cli.js')}" "$@"\n`, { mode: 0o755 });
  // Decoys where Cursor keeps its own data: nothing may open them.
  fs.mkdirSync(path.join(DIRS.home, '.cursor', 'chats', 'x'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.home, '.cursor', 'chats', 'x', 'store.db'), 'decoy');
  fs.mkdirSync(path.join(DIRS.home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), 'decoy');
}
process.env.HOME = DIRS.home;
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CURSOR_CLI = BIN;
process.env.BOTMANCERS_CURSOR_STATE_DIR = DIRS.providerState;
process.env.FAKE_CURSOR_STATE = DIRS.fakeMain;
delete process.env.FAKE_CURSOR_VARIANT;
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

// Every in-process file access is recorded; Cursor's own stores must never appear.
const touched = [];
const CURSOR_STORE = /\/\.cursor(\/|$)|\/Cursor\/User\/|\.vscdb$/;
for (const name of ['readFileSync', 'readdirSync', 'openSync', 'existsSync', 'statSync', 'lstatSync', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function patched(target, ...rest) {
    if (typeof target === 'string' && CURSOR_STORE.test(target)) touched.push(target);
    return original.call(this, target, ...rest);
  };
}

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const cursor = jiti('./lib/cursor-session-provider.ts');

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
const calls = (dir, op) => {
  const file = path.join(dir, 'calls.jsonl');
  const all = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return op ? all.filter(entry => entry.op === op) : all;
};
function seedChat(dir, id, cwd, history = []) {
  const file = path.join(dir, 'chats.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { counter: 0, chats: {} };
  state.chats[id] = { cwd, title: `Outside ${id.slice(0, 6)}`, created_at: 1, updated_at: 2, history };
  fs.writeFileSync(file, JSON.stringify(state));
}
const envFor = (dir, extra = {}) => ({ ...process.env, FAKE_CURSOR_STATE: dir, ...extra });

// Per-connection providers for the listing and SDK variants; the main
// connection uses the default cursor registration from provider-sessions.
function registerVariants(ids) {
  contract.registerSessionProvider({ connectionId: ids.listing }, connection => cursor.createCursorSessionProvider(connection, {
    stateDir: path.join(DIRS.providerState, 'listing'), env: envFor(DIRS.fakeListing, { FAKE_CURSOR_VARIANT: 'listing' }), pollMs: 20,
  }));
  contract.registerSessionProvider({ connectionId: ids.sdk }, connection => cursor.createCursorSessionProvider(connection, {
    cliPath: path.join(DIRS.bin, 'missing-cursor-agent'), sdkModule: SDK, stateDir: path.join(DIRS.providerState, 'sdk'), env: envFor(DIRS.fakeSdk), pollMs: 20,
  }));
}

function agent(name, connectionId, scope, policy) {
  return dbModule.bots.create({
    name, title: 'Cursor', description: 'Cursor sessions', agent: 'cursor', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: scope.kind, session_scope_items: JSON.stringify(scope.items ?? []),
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0, allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}

const eventUsage = turnRef => {
  const row = db.prepare("SELECT detail FROM provider_session_events WHERE turn_id = ? AND type LIKE 'turn_%' AND type <> 'turn_started'").get(turnRef);
  return row ? JSON.parse(row.detail).usage ?? null : undefined;
};

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

async function main() {
  console.log('\nParser: real-shaped stream-json fixtures');
  const fixture = name => fs.readFileSync(path.join(ROOT, 'test-support', 'cursor-stream-fixtures', name), 'utf8');
  const complete = cursor.parseCursorStream(fixture('complete.jsonl'), true);
  assert(complete.init.session_id === 'chat-REDACTED' && complete.init.cwd === '/work/alpha' && complete.result.ok && complete.result.text === 'PINEAPPLE'
    && complete.steps.length === 1 && complete.steps[0].role === 'assistant', 'complete: init, assistant step, success result');
  assert(JSON.stringify(complete.result.usage) === JSON.stringify({ input_tokens: 12017, output_tokens: 33, cost_usd: null }),
    'complete: reported input/output counts; no reported cost stays null (never priced from a subscription)');
  const partial = cursor.parseCursorStream(fixture('partial-usage.jsonl'), true);
  assert(partial.result.usage.input_tokens === 12017 && partial.result.usage.output_tokens === null, 'partial: the unreported output count is null');
  assert(cursor.parseCursorStream(fixture('missing-usage.jsonl'), true).result.usage === null, 'missing: no usage object means no sample');
  const malformed = cursor.parseCursorStream(fixture('malformed-usage.jsonl'), true);
  assert(JSON.stringify(malformed.result.usage) === JSON.stringify({ input_tokens: null, output_tokens: null, cost_usd: null }) && malformed.malformed === 1,
    'malformed: a string count, a negative count, and a string cost stay unknown; a non-JSON line is ignored');
  const repeated = cursor.parseCursorStream(fixture('repeated-result.jsonl'), true);
  assert(repeated.result_events === 2 && repeated.result.text === 'PINEAPPLE' && repeated.result.usage.input_tokens === 12017,
    'repeated: the first result wins; a later one is counted, never merged or double-counted');
  const errored = cursor.parseCursorStream(fixture('error-result.jsonl'), true);
  assert(errored.result.ok === false && errored.result.subtype === 'error', 'error: an is_error result is not a success');
  const half = fixture('no-result-partial-line.jsonl');
  assert(cursor.parseCursorStream(half, false).result === null && cursor.parseCursorStream(half, false).malformed === 0
    && cursor.parseCursorStream(half, true).malformed === 1, 'a half-written last line is not read while the turn runs');

  console.log('\nInstalled-capability selection');
  const probeWith = (options) => { cursor.resetCursorProbeCache(); return cursor.probeCursor(options); };
  const listless = probeWith({ cliPath: BIN, env: envFor(DIRS.fakeMain) });
  assert(listless.backend === 'cli' && listless.cli.version === '2026.10.16-fake' && listless.cli.list === false && listless.sdk.available === false,
    'CLI installed, no JSON listing: the CLI is the primary backend and list is unsupported; the SDK is not even probed');
  const listing = probeWith({ cliPath: BIN, env: envFor(DIRS.fakeListing, { FAKE_CURSOR_VARIANT: 'listing' }) });
  assert(listing.backend === 'cli' && listing.cli.list === true, 'a CLI whose ls offers JSON output enumerates');
  const sdkOnly = probeWith({ cliPath: path.join(DIRS.bin, 'missing'), sdkModule: SDK, env: envFor(DIRS.fakeSdk) });
  assert(sdkOnly.backend === 'sdk' && sdkOnly.sdk.version === '0.9.0-fake' && sdkOnly.sdk.list === false, 'no CLI, SDK present: the SDK fallback is selected');
  const broken = probeWith({ cliPath: BIN, sdkModule: SDK, env: envFor(DIRS.fakeSdk, { FAKE_CURSOR_VARIANT: 'broken', FAKE_CURSOR_SDK_LIST: '1' }) });
  assert(broken.backend === 'sdk' && broken.sdk.list === true, 'a CLI whose --version fails is not usable; an SDK with Agent.list enumerates');
  const none = probeWith({ cliPath: path.join(DIRS.bin, 'missing'), sdkModule: path.join(TMP, 'no-sdk.mjs'), env: envFor(DIRS.fakeSdk) });
  assert(none.backend === null, 'neither installed: no backend');
  cursor.resetCursorProbeCache();
  const nothing = cursor.createCursorSessionProvider({ id: 'rc-none', provider: 'cursor' }, { cliPath: path.join(DIRS.bin, 'missing'), sdkModule: path.join(TMP, 'no-sdk.mjs'), stateDir: path.join(TMP, 'none') });
  const noCaps = nothing.capabilities();
  assert(contract.SESSION_PROVIDER_CAPABILITIES.every(key => noCaps[key] === false) && noCaps.authorities.length === 0, 'without a backend every capability is false');
  assert((await nothing.startSession({ workspace: DIRS.alpha, prompt: 'x', authority: 'read_only', idempotency_key: 'k', correlation: {} })).error.code === 'unavailable',
    'and a call is refused as unavailable, launching nothing');
  cursor.resetCursorProbeCache();

  console.log('\nRegistry: direct Cursor Agents, no Agent Deck');
  const { runtimeConnections } = dbModule;
  const ids = {
    main: runtimeConnections.create({ provider: 'cursor', label: 'Cursor laptop', host: 'This computer' }).id,
    listing: runtimeConnections.create({ provider: 'cursor', label: 'Cursor listing', host: 'This computer' }).id,
    sdk: runtimeConnections.create({ provider: 'cursor', label: 'Cursor SDK', host: 'This computer' }).id,
  };
  registerVariants(ids);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const dev = agent('CursorDev', ids.main, { kind: 'workspaces', items: [DIRS.alpha] }, write);
  const picky = agent('CursorPicky', ids.main, { kind: 'sessions', items: ['some-other-ref'] }, write);
  const lister = agent('CursorLister', ids.listing, { kind: 'workspaces', items: [DIRS.alpha] }, write);
  const sdkAgent = agent('CursorSdk', ids.sdk, { kind: 'workspaces', items: [DIRS.alpha] }, write);
  assert([dev, picky, lister, sdkAgent].every(bot => dbModule.bots.getById(bot.id).deck_id === null && dbModule.bots.getById(bot.id).launch_profile === 'direct'),
    'every Agent here is direct with no deck');
  const devCaps = ps.agentProviderCapabilities(db, dev.id);
  assert(devCaps.provider_kind === 'cursor' && devCaps.list === false && devCaps.search === false && devCaps.read && devCaps.resume && devCaps.start
    && devCaps.cancel && devCaps.usage && devCaps.explicit_import === true, 'a cursor connection gets the Cursor provider by default; listing-less version: list false, explicit import true');

  console.log('\nListing unsupported: only explicitly imported sessions are addressable');
  const listsBefore = calls(DIRS.fakeMain, 'ls').length;
  await rejects(ps.syncAgentSessions(db, dev.id), 'unsupported', 'discovery is refused as unsupported');
  assert(calls(DIRS.fakeMain, 'ls').length === listsBefore, 'and the CLI is not asked to list');
  // Created outside Botmancers, with history the provider cannot read.
  seedChat(DIRS.fakeMain, 'outside-1-SECRET', path.join(DIRS.alpha, 'app'), [['user', 'Pick a codeword'], ['assistant', 'KUMQUAT']]);
  seedChat(DIRS.fakeMain, 'outside-beta-SECRET', DIRS.beta);
  await rejects(ps.importProviderSession(db, dev.id, { providerSessionId: 'outside-beta-SECRET', workspace: DIRS.beta }), 'out_of_scope', 'an import outside the workspace scope is refused');
  await rejects(ps.importProviderSession(db, picky.id, { providerSessionId: 'outside-1-SECRET', workspace: path.join(DIRS.alpha, 'app') }), 'out_of_scope',
    'a selected-sessions scope cannot import new sessions');
  await rejects(ps.importProviderSession(db, dev.id, { providerSessionId: 'outside-1-SECRET', workspace: 'relative' }), 'invalid_input', 'a relative workspace is refused');
  await rejects(ps.importProviderSession(db, dev.id, { providerSessionId: 'bad id; rm -rf', workspace: path.join(DIRS.alpha, 'app') }), 'invalid_input', 'a non-token id is refused');
  const imported = await ps.importProviderSession(db, dev.id, { providerSessionId: 'outside-1-SECRET', workspace: path.join(DIRS.alpha, 'app') });
  const importedAgain = await ps.importProviderSession(db, dev.id, { providerSessionId: 'outside-1-SECRET', workspace: path.join(DIRS.alpha, 'app') });
  assert(imported.created && !importedAgain.created && imported.ref === importedAgain.ref
    && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 1, 'explicit import is idempotent: one reference, one row');
  assert(count("SELECT COUNT(*) AS n FROM provider_sessions WHERE provider_session_id = 'outside-beta-SECRET'") === 0, 'refused imports store nothing');
  const importedRow = db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(imported.ref);
  assert(importedRow.provider_kind === 'cursor' && importedRow.workspace === path.join(DIRS.alpha, 'app') && importedRow.resumable === 1, 'the row records kind, workspace, resumable');

  console.log('\nExact-session resume preserves cwd, authority, correlation');
  const resumed = await ps.sendProviderTurn(db, dev.id, imported.ref, {
    prompt: 'What was the codeword?', authority: 'read_only', idempotencyKey: 'r1', requester: owner, correlation: { requestId: 'corr-505' },
  });
  const resumedDone = await ps.observeProviderTurn(db, dev.id, resumed.turn.turn_ref);
  const turnCall = calls(DIRS.fakeMain, 'turn').pop();
  assert(resumedDone.state === 'completed' && /fake cursor reply: What was the codeword\?/.test(resumedDone.output), 'the resumed turn completes with structured output');
  assert(turnCall.resume === 'outside-1-SECRET' && turnCall.cwd === path.join(DIRS.alpha, 'app') && turnCall.workspace === path.join(DIRS.alpha, 'app')
    && turnCall.format === 'stream-json', 'the CLI resumed the exact chat in its own workspace (cwd and --workspace), with stream-json');
  assert(turnCall.mode === 'ask' && turnCall.force === false, 'read_only runs in Cursor\'s read-only ask mode, never --force');
  assert(JSON.parse(turnCall.correlation).requestId === 'corr-505', 'the caller\'s correlation reaches the turn process');
  assert(JSON.stringify(eventUsage(resumed.turn.turn_ref)) === JSON.stringify({ input_tokens: 100 + 'What was the codeword?'.length, output_tokens: 7, cost_usd: null }),
    'the reported usage is one durable sample on the terminal event');
  const edit = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: 'Make the edit', authority: 'workspace_write', idempotencyKey: 'r2', requester: owner });
  await ps.observeProviderTurn(db, dev.id, edit.turn.turn_ref);
  assert(calls(DIRS.fakeMain, 'turn').pop().mode === null, 'workspace_write runs in Cursor\'s default agent mode');
  const replay = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: 'Make the edit', authority: 'workspace_write', idempotencyKey: 'r2', requester: owner });
  assert(replay.replayed && calls(DIRS.fakeMain, 'turn').length === 2, 'a replayed key launches no second process');
  const transcript = await ps.readProviderTranscript(db, dev.id, imported.ref, { limit: 50 });
  assert(transcript.entries.map(entry => entry.role).join(',') === 'user,tool,assistant,user,tool,assistant' && transcript.entries[0].text === 'What was the codeword?',
    'read returns the journaled turns (prompt, tool steps, assistant text) in order');
  assert(!transcript.entries.some(entry => /KUMQUAT|Pick a codeword/.test(entry.text)), 'history from before the import is not reconstructed from Cursor\'s stores');

  console.log('\nMissing or failed resume targets never become fresh sessions');
  const creates0 = calls(DIRS.fakeMain, 'create_chat').length;
  const turns0 = calls(DIRS.fakeMain, 'turn').length;
  const staleRef = require('crypto').randomUUID();
  db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, workspace, resumable, created_at, updated_at)
    VALUES (?, ?, ?, 'cursor', 'never-known-SECRET', 'discovered', ?, 1, 0, 0)`).run(staleRef, dev.id, ids.main, path.join(DIRS.alpha, 'app'));
  await rejects(ps.sendProviderTurn(db, dev.id, staleRef, { prompt: 'hello?', authority: 'read_only', idempotencyKey: 'stale', requester: owner }), 'session_missing',
    'a reference the provider does not know is missing');
  assert(db.prepare('SELECT availability FROM provider_sessions WHERE id = ?').get(staleRef).availability === 'missing'
    && count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE session_ref = ?', staleRef) === 0, 'it is marked missing and no turn row exists');
  const direct = cursor.createCursorSessionProvider({ id: ids.main, provider: 'cursor' });
  assert((await direct.sendTurn({ provider_session_id: 'never-known-SECRET', prompt: 'x', authority: 'read_only', idempotency_key: 'raw', correlation: {} })).error.code === 'not_found',
    'the provider itself refuses an unknown chat id');
  const failedTurn = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: '[fail] resume error', authority: 'read_only', idempotencyKey: 'f1', requester: owner });
  const failedDone = await ps.observeProviderTurn(db, dev.id, failedTurn.turn.turn_ref);
  assert(failedDone.state === 'failed' && failedDone.failure_code === 'cursor_error', 'a resume whose result is an error stays a failed turn');
  const exitTurn = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: '[exit] crash', authority: 'read_only', idempotencyKey: 'f2', requester: owner });
  assert((await ps.observeProviderTurn(db, dev.id, exitTurn.turn.turn_ref)).failure_code === 'exit_3', 'a process ending without a result fails with its exit status');
  const mismatch = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: '[mismatch] wrong chat', authority: 'read_only', idempotencyKey: 'f3', requester: owner });
  assert((await ps.observeProviderTurn(db, dev.id, mismatch.turn.turn_ref)).failure_code === 'session_mismatch', 'an init event naming another chat fails the turn');
  assert(calls(DIRS.fakeMain, 'create_chat').length === creates0 && calls(DIRS.fakeMain, 'fresh_on_resume').length === 0
    && calls(DIRS.fakeMain, 'turn').length === turns0 + 3, 'no failure created a chat or resumed an unknown id: exactly the three requested processes');

  console.log('\nUsage samples stay nullable');
  const usageOf = async (prompt, key) => {
    const t = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt, authority: 'read_only', idempotencyKey: key, requester: owner });
    await ps.observeProviderTurn(db, dev.id, t.turn.turn_ref);
    return eventUsage(t.turn.turn_ref);
  };
  assert(JSON.stringify(await usageOf('[usage:partial]', 'u1')) === JSON.stringify({ input_tokens: 42, output_tokens: null, cost_usd: null }), 'partial');
  assert((await usageOf('[usage:missing]', 'u2')) === null, 'missing: no sample');
  assert(JSON.stringify(await usageOf('[usage:malformed]', 'u3')) === JSON.stringify({ input_tokens: null, output_tokens: null, cost_usd: null }), 'malformed: unknown');
  assert((await usageOf('[usage:repeated]', 'u4')).input_tokens === 100 + '[usage:repeated]'.length, 'repeated: first result only');
  assert((await usageOf('[usage:cost]', 'u5')).cost_usd === 0.0123, 'a cost the runtime reports is kept');

  console.log('\nStart in an allowed workspace');
  await rejects(ps.startProviderSession(db, dev.id, { workspace: DIRS.beta, prompt: 'x', authority: 'read_only', idempotencyKey: 's0', requester: owner }), 'out_of_scope',
    'a workspace outside the scope is refused');
  assert(calls(DIRS.fakeMain, 'create_chat').length === creates0, 'before any CLI call');
  const started = await ps.startProviderSession(db, dev.id, { workspace: path.join(DIRS.alpha, 'new'), prompt: 'Scaffold it', authority: 'workspace_write', idempotencyKey: 's1', requester: owner });
  const startedDone = await ps.observeProviderTurn(db, dev.id, started.turn.turn_ref);
  const created = calls(DIRS.fakeMain, 'create_chat').pop();
  const startCall = calls(DIRS.fakeMain, 'turn').pop();
  assert(startedDone.state === 'completed' && created.cwd === path.join(DIRS.alpha, 'new') && startCall.cwd === path.join(DIRS.alpha, 'new')
    && /^fake-chat-\d+-SECRET$/.test(startCall.resume), 'start creates a chat in the workspace, then runs the turn on exactly that chat');
  assert(!SECRET.test(JSON.stringify([resumedDone, startedDone, transcript, started])), 'no Cursor chat or turn id in any view');

  // Turns left for the restarted process.
  const slow = await ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: '[slow] finish after the restart', authority: 'read_only', idempotencyKey: 'pre-1', requester: owner });
  await rejects(ps.sendProviderTurn(db, dev.id, imported.ref, { prompt: 'x', authority: 'read_only', idempotencyKey: 'busy', requester: owner }), 'busy', 'a session with a turn in flight is busy');
  const held = await ps.sendProviderTurn(db, dev.id, started.turn.session_ref, { prompt: '[hold] long task', authority: 'read_only', idempotencyKey: 'pre-2', requester: owner });

  console.log('\nRestart: a second Botmancers process on the same database');
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: { ...process.env, NOT505_TAG: TAG, NOT505_IDS: JSON.stringify({ ...ids, dev: dev.id, imported: imported.ref, slow: slow.turn.turn_ref, held: held.turn.turn_ref }) },
    encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && result && result.failures === 0, 'the restarted process reattached observe and cancel');
  assert(result && result.fetchCalls === 0 && fetchCalls === 0, 'no network call (no Agent Deck) in either process');

  console.log('\nListing supported: scoped, idempotent discovery');
  seedChat(DIRS.fakeListing, 'listed-a-SECRET', path.join(DIRS.alpha, 'app'));
  seedChat(DIRS.fakeListing, 'listed-b-SECRET', path.join(DIRS.alpha, 'app2'));
  seedChat(DIRS.fakeListing, 'listed-out-SECRET', DIRS.beta);
  assert(ps.agentProviderCapabilities(db, lister.id).list === true, 'the listing version reports list');
  const sync1 = await ps.syncAgentSessions(db, lister.id, { now: 1000 });
  const sync2 = await ps.syncAgentSessions(db, lister.id, { now: 2000 });
  assert(sync1.imported.length === 2 && sync1.rejected_out_of_scope === 0 && sync2.imported.length === 0 && sync2.updated.length === 2,
    'discovery imports the two in-scope chats once; a re-sync imports nothing');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', lister.id) === 2
    && count("SELECT COUNT(*) AS n FROM provider_sessions WHERE provider_session_id = 'listed-out-SECRET'") === 0, 'the out-of-scope chat is never stored');
  await rejects(ps.importProviderSession(db, lister.id, { providerSessionId: 'not-listed-SECRET', workspace: path.join(DIRS.alpha, 'app') }), 'session_missing',
    'with listing, an import the listing does not show is refused');
  const listedRef = sync1.imported[0];
  const listedTurn = await ps.sendProviderTurn(db, lister.id, listedRef, { prompt: 'hi listed', authority: 'read_only', idempotencyKey: 'l1', requester: owner });
  assert((await ps.observeProviderTurn(db, lister.id, listedTurn.turn.turn_ref)).state === 'completed', 'a discovered chat resumes');
  const listedFile = path.join(DIRS.fakeListing, 'chats.json');
  const listedState = JSON.parse(fs.readFileSync(listedFile, 'utf8'));
  const listedId = db.prepare('SELECT provider_session_id FROM provider_sessions WHERE id = ?').get(listedRef).provider_session_id;
  listedState.chats[listedId].deleted = true;
  fs.writeFileSync(listedFile, JSON.stringify(listedState));
  const listedTurns = calls(DIRS.fakeListing, 'turn').length;
  await rejects(ps.sendProviderTurn(db, lister.id, listedRef, { prompt: 'still there?', authority: 'read_only', idempotencyKey: 'l2', requester: owner }), 'session_missing',
    'a chat the listing no longer shows is missing and is not resumed');
  assert(calls(DIRS.fakeListing, 'turn').length === listedTurns && calls(DIRS.fakeListing, 'fresh_on_resume').length === 0, 'no process was launched for it');

  console.log('\nSDK fallback: same provider identity, same journal');
  assert(ps.agentProviderCapabilities(db, sdkAgent.id).provider_kind === 'cursor', 'the SDK backend is still provider kind cursor');
  const sdkStart = await ps.startProviderSession(db, sdkAgent.id, { workspace: path.join(DIRS.alpha, 'sdk'), prompt: 'via sdk', authority: 'read_only', idempotencyKey: 'k1', requester: owner });
  const sdkDone = await ps.observeProviderTurn(db, sdkAgent.id, sdkStart.turn.turn_ref);
  assert(sdkDone.state === 'completed' && /fake sdk reply: via sdk/.test(sdkDone.output)
    && calls(DIRS.fakeSdk, 'sdk_create').pop().workspace === path.join(DIRS.alpha, 'sdk') && calls(DIRS.fakeSdk, 'sdk_resume').pop().mode === 'ask',
  'start via Agent.create and Agent.resume in the workspace, read_only as ask mode');
  const sdkHeld = await ps.sendProviderTurn(db, sdkAgent.id, sdkStart.turn.session_ref, { prompt: '[hold] sdk', authority: 'read_only', idempotencyKey: 'k2', requester: owner });
  await new Promise(done => setTimeout(done, 300));
  const sdkCancel = await ps.cancelProviderTurn(db, sdkAgent.id, sdkHeld.turn.turn_ref);
  assert(sdkCancel.outcome === 'cancelled' && sdkCancel.turn.state === 'cancelled', 'an SDK turn cancels the same way');

  console.log('\nDurable rows and events (CursorDev)');
  const turns = db.prepare('SELECT state FROM provider_session_turns WHERE agent_id = ?').all(dev.id);
  const events = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? GROUP BY type').all(dev.id).map(row => [row.type, row.n]));
  console.log(`  events: ${JSON.stringify(events)}`);
  assert(turns.length === 14 && turns.filter(t => t.state === 'completed').length === 10 && turns.filter(t => t.state === 'failed').length === 3
    && turns.filter(t => t.state === 'cancelled').length === 1, 'fourteen turns (one after the restart): ten completed, three failed, one cancelled, none running');
  assert(events.session_imported === 1 && events.session_started === 1 && events.turn_started === 14 && events.turn_completed === 10
    && events.turn_failed === 3 && events.turn_cancelled === 1 && events.cancel_requested === 1 && events.session_missing === 1, 'one event per lifecycle fact');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 3, 'three rows: imported, started, and the stale one kept as missing');

  console.log('\nNo Cursor store access');
  assert(touched.length === 0, `no in-process access to ~/.cursor or Cursor IDE storage (${touched.length})`);
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'cursor-session-provider.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert(!/\.cursor\/|vscdb|globalStorage|better-sqlite3|homedir/.test(source), 'the provider source names no Cursor store and opens no database');

  console.log('\nDocumentation contract');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'providers', 'cursor.md'), 'utf8');
  assert(/stream-json/.test(doc) && /--resume/.test(doc) && /importProviderSession/.test(doc) && /IDE/.test(doc) && /fallback/i.test(doc), 'docs/providers/cursor.md documents the integration');

  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll Cursor session provider checks passed.');
}

async function restart() {
  const ids = JSON.parse(process.env.NOT505_IDS);
  registerVariants(ids);
  const devId = ids.dev;
  console.log('observe a turn started before the restart');
  const slow = await ps.observeProviderTurn(db, devId, ids.slow);
  assert(slow.state === 'completed' && /finish after the restart/.test(slow.output), 'the pre-restart turn is observed to its result from the journal');
  const waited = await ps.observeProviderTurn(db, devId, ids.held, { deadlineAt: Date.now() + 200 });
  assert(waited.state === 'running', 'a deadline ends only the wait on the held turn');
  const first = await ps.cancelProviderTurn(db, devId, ids.held);
  const second = await ps.cancelProviderTurn(db, devId, ids.held);
  assert(first.outcome === 'cancelled' && second.outcome === 'already_terminal', 'cancel reaches the process started before the restart; a repeat is already_terminal');
  const providerState = JSON.parse(fs.readFileSync(path.join(DIRS.providerState, ids.main.replace(/[^A-Za-z0-9._-]/g, '_'), 'state.json'), 'utf8'));
  const pid = Object.values(providerState.turns).find(turn => /\[hold\] long task/.test(turn.prompt)).pid;
  // The wrapper's parent (the first process) is blocked waiting for this
  // one, so the killed wrapper may linger as a zombie until it is reaped.
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    const stat = spawnSync('ps', ['-o', 'stat=', '-g', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    gone = stat.every(line => line.startsWith('Z'));
    if (!gone) await new Promise(done => setTimeout(done, 50));
  }
  assert(gone, 'the held Cursor process group is gone (no live process left)');
  const resumed = await ps.sendProviderTurn(db, devId, ids.imported, { prompt: 'after restart', authority: 'read_only', idempotencyKey: 'post-1', requester: owner });
  assert((await ps.observeProviderTurn(db, devId, resumed.turn.turn_ref)).state === 'completed', 'the imported session resumes after the restart');
  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls })}`);
  process.exit(failures > 0 ? 1 : 0);
}
