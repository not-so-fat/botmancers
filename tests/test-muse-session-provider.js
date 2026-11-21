#!/usr/bin/env node
// NOT-508: the direct Muse Code SessionProvider (lib/muse-session-provider)
// against a fake `muse serve` speaking stable MSP v1 over stdio
// (test-support/fake-muse-serve), without Agent Deck.
// Proves: structured normalization (session rows, transcripts, usage,
// errors, versions) on fixtures adapted from Agent Dealer's Muse parsers;
// the capability/version probe and unsupported, auth, and missing-binary
// failures; the exact MSP requests for list (pagination, filters), read,
// start, resume, observe, and cancel, with one host per authority; and,
// through lib/provider-sessions, scoped idempotent discovery over several
// workspaces with missing and malformed records, exact-session resume after
// a Botmancers restart (a second process), a turn lost with its host
// reported failed rather than replaced, and canonical row/event counts.
// Self-contained: isolated SQLite and state files, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT508_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-muse-provider-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
const FAKE = path.join(ROOT, 'test-support/fake-muse-serve.js');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const catalog = jiti('./lib/session-catalog.ts');
const muse = jiti('./lib/muse-session-provider.ts');
const fakeMuse = require('./test-support/fake-muse-serve');

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
const owner = { kind: 'person', id: 'local-owner' };
const correlation = { requestId: null };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function options(name, env = {}) {
  return {
    command: process.execPath, commandArgs: [FAKE], serveArgs: [], rpcTimeoutMs: 5000, cancelSettleMs: 2000,
    env: { FAKE_MUSE_STATE: path.join(TMP, `${name}.json`), FAKE_MUSE_LOG: path.join(TMP, `${name}.log`), ...env },
  };
}
const log = name => fakeMuse.readFakeMuseLog(path.join(TMP, `${name}.log`));
const state = name => fakeMuse.loadFakeMuse(path.join(TMP, `${name}.json`));
// Every Muse id the fake holds: none may appear in a Botmancers view.
function museIds(name) {
  const s = state(name);
  return [...Object.keys(s.sessions), ...Object.keys(s.turns)];
}
function leaks(name, value) {
  const text = JSON.stringify(value);
  return museIds(name).filter(id => text.includes(id));
}

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  muse.shutdownMuseSessionProviders();
  process.exit(1);
}

function normalization() {
  console.log('\nNormalization fixtures');
  const live = {
    sessionId: '01a150ee-e492-76c0-90ed-0a5e2584ca6e', path: '/m/sessions/x/session.jsonl', status: 'notLoaded', activeTurnId: null,
    createdAt: '2026-10-18T21:33:15.796041Z', updatedAt: '2026-10-18T21:33:24.682652Z', lastActivityAt: '2026-10-18T21:33:16.755103Z',
    workspaceRoot: '/tmp/ws', providerId: 'echo', modelId: null, turnCount: 2, forkedFrom: null, sideFrom: null, kind: 'root',
    name: 'rainy-scutum', title: 'hello probe', firstUserPrompt: 'hello probe',
  };
  const rec = muse.museSessionRecord(live);
  assert(rec.provider_session_id === live.sessionId && rec.title === 'hello probe' && rec.workspace === '/tmp/ws'
    && rec.created_at === Date.parse(live.createdAt) && rec.updated_at === Date.parse(live.lastActivityAt)
    && rec.lifecycle === 'open' && rec.resumable === true && rec.busy === false, 'a live MSP Session row maps to a provider record');
  assert(muse.museSessionRecord({ ...live, title: undefined, firstUserPrompt: undefined }).title === 'rainy-scutum'
    && muse.museSessionRecord({ ...live, title: undefined }).title === 'hello probe', 'title falls back to the first prompt, then the name');
  assert(muse.museSessionRecord({ ...live, status: 'running', activeTurnId: 't' }).busy === true
    && muse.museSessionRecord({ ...live, status: 'idle' }).busy === false, 'running (or an active turn) is busy; idle and notLoaded are not');
  assert(muse.museSessionRecord({ ...live, path: '' }).resumable === false && muse.museSessionRecord(live, 'ephemeral').resumable === false,
    'an unpersisted session or an ephemeral host is not resumable');
  assert(muse.museSessionRecord({ ...live, archived: true, lifecycle: 'archived' }).lifecycle === 'open',
    'MSP v1 has no archive state: undocumented archive-like fields are ignored, lifecycle stays open');
  assert(muse.museSessionRecord({ ...live, workspaceRoot: 'relative' }).workspace === null && muse.museSessionRecord({ ...live, createdAt: 'nope' }).created_at === null,
    'a relative workspace or an unparsable time is unknown');
  assert([null, 'x', 7, {}, { sessionId: 42 }, { sessionId: '' }, { ...live, kind: 'subagent' }].every(raw => muse.museSessionRecord(raw) === null),
    'malformed rows and subagent children are skipped');

  const items = [
    { itemId: '1', kind: 'userMessage', turnId: 't1', text: 'hello', recordedAt: '2026-10-18T21:33:16.260043Z' },
    { itemId: '2', kind: 'reminderChild', turnId: 't1', fallbackText: 'Reminder child session' },
    { itemId: '3', kind: 'agentMessage', turnId: 't1', text: 'echo: hello', messagePhase: 'finalAnswer' },
    { itemId: '4', kind: 'agentMessage', turnId: 't2', text: 'retracted', retracted: true },
    { itemId: '5', kind: 'toolCall', turnId: 't2', tool: 'shell' },
    { itemId: '6', kind: 'agentMessage', turnId: 't2', text: 'second' },
    null,
  ];
  const transcript = muse.museTranscript(items);
  assert(transcript.map(e => `${e.seq}:${e.role}:${e.text}`).join('|') === '1:user:hello|2:assistant:echo: hello|3:assistant:second'
    && transcript[0].at === Date.parse('2026-10-18T21:33:16.260043Z') && transcript[1].at === null,
  'history folds to user/agent messages in order; tools, reminders, retracted, and malformed items are dropped');
  assert(muse.museTurnOutput(items, 't1') === 'echo: hello' && muse.museTurnOutput(items, 't9') === null, 'turn output is that turn\'s agent text');

  // Usage: Agent Dealer's Muse serve fixture (120 in / 45 out), its partial
  // rule (any record missing a field makes the sum unknown), and absence.
  const complete = muse.museUsageSample({ inputTokens: 120, outputTokens: 45, cachedTokens: 0, reasoningTokens: 0 });
  assert(complete.input_tokens === 120 && complete.output_tokens === 45 && complete.cost_usd === null, 'complete: turn/completed usage maps; cost stays unknown');
  const summed = muse.museUsageSample(undefined, [{ inputTokens: 70, outputTokens: 20 }, { inputTokens: 50, outputTokens: 25 }]);
  assert(summed.input_tokens === 120 && summed.output_tokens === 45, 'tokenUsage records sum when turn/completed carries none');
  const partial = muse.museUsageSample(undefined, [{ inputTokens: 70, outputTokens: 20 }, { inputTokens: 50 }]);
  assert(partial.input_tokens === 120 && partial.output_tokens === null, 'partial: a record missing outputTokens leaves output unknown, never under-reported');
  assert(muse.museUsageSample({ inputTokens: -1, outputTokens: 'x' }).input_tokens === null && muse.museUsageSample({ inputTokens: 3 }).output_tokens === null,
    'invalid or missing counters are unknown');
  assert(muse.museUsageSample(undefined, []) === null && muse.museUsageSample(null) === null, 'absent: no usage reported is null, not zero');

  const err = (code, kind, message = '') => muse.museRpcError({ code, message, data: { kind } });
  assert(err(-32601, 'methodNotFound').code === 'unsupported' && err(-32010, 'capabilityRequired').code === 'unsupported'
    && err(-32020, 'sessionNotFound').code === 'not_found' && err(-32021, 'sessionInUse').code === 'busy'
    && err(-32602, 'invalidParams').code === 'invalid_input' && err(-32001, 'overloaded').code === 'unavailable',
  'MSP error codes map to structured provider errors');
  const auth = err(-32603, 'internal', 'login is no longer valid');
  assert(auth.code === 'unavailable' && /^auth_required/.test(auth.message) && !/login/.test(auth.message), 'auth failures are classified; the raw message is not carried');
  assert(muse.museTurnFailure({ kind: 'authRequired', message: 'x' }).code === 'auth' && muse.museTurnFailure({ kind: 'provider', message: 'quota exhausted' }).code === 'usage_cap'
    && muse.museTurnFailure({ kind: 'toolLoop', message: 'm' }).code === 'toolLoop' && muse.museTurnFailure(null, 'crash').code === 'failed',
  'turn failures classify auth and usage caps, else keep the MSP kind');
  assert(JSON.stringify(muse.parseMuseVersion('1.4.10-R6427.1')) === '[1,4,10]' && muse.parseMuseVersion('dev') === null, 'Muse versions parse');
  assert(UUID7.test(muse.museUuidv7()) && muse.museUuidv7(0) !== muse.museUuidv7(0), 'commandIds are fresh UUIDv7s');
}

async function protocol() {
  console.log('\nProtocol fake: probe, requests, pagination, events, cancellation');
  fakeMuse.seedFakeMuse(path.join(TMP, 'proto.json'), [
    { id: 'p-1', title: 'Refactor the parser', workspace: '/w/a', items: [['user', 'one'], ['assistant', 'two'], ['user', 'three']] },
    { id: 'p-2', title: 'Second', workspace: '/w/a' },
    { id: 'p-3', title: 'Third', workspace: '/w/b' },
  ]);
  const provider = muse.createMuseSessionProvider('conn-proto', options('proto'));
  assert(JSON.stringify(provider.capabilities()) === JSON.stringify(muse.MUSE_DECLARED_CAPABILITIES), 'before a probe the declared MSP v1 capabilities are reported');
  const probe = await provider.probe();
  assert(probe.status === 'ready' && probe.muse_version === '1.4.10' && probe.schema_version === 1 && probe.durability === 'durable' && probe.reason === null,
    'the probe reports versioned capabilities from the initialize handshake');
  assert(log('proto')[0].method === 'initialize' && log('proto')[0].params.clientInfo.name === 'botmancers', 'the handshake identifies Botmancers');

  const all = { kind: 'all_provider_sessions', workspaces: [], provider_session_ids: [] };
  const page1 = await provider.listSessions({ scope: all, limit: 2, correlation });
  const page2 = await provider.listSessions({ scope: all, limit: 2, cursor: page1.value.next_cursor, correlation });
  const lists = log('proto').filter(e => e.method === 'session/list');
  assert(page1.value.items.length === 2 && page1.value.next_cursor === 'page-2' && page2.value.items.length === 1 && page2.value.next_cursor === null
    && lists[0].params.limit === 2 && lists[0].params.cursor === undefined && lists[1].params.cursor === 'page-2', 'session/list pages by the host\'s opaque cursor');
  await provider.listSessions({ scope: all, limit: 500, correlation });
  assert(log('proto').filter(e => e.method === 'session/list').pop().params.limit === muse.MUSE_MAX_PAGE, 'the page size is bounded');
  const search = await provider.listSessions({ scope: all, query: 'pars', limit: 10, correlation });
  assert(search.value.items.length === 1 && JSON.stringify(log('proto').filter(e => e.method === 'session/list').pop().params.filter) === JSON.stringify({ text: { allOf: ['pars'], fields: ['name', 'title'] } }),
    'search uses the structured name/title filter');
  const picked = await provider.listSessions({ scope: { kind: 'sessions', workspaces: [], provider_session_ids: ['p-3'] }, limit: 10, correlation });
  assert(picked.value.items.length === 1 && picked.value.items[0].provider_session_id === 'p-3'
    && JSON.stringify(log('proto').filter(e => e.method === 'session/list').pop().params.filter) === JSON.stringify({ sessionId: { anyOf: ['p-3'] } }),
  'a selected-sessions scope uses the sessionId filter');
  const listCount = log('proto').filter(e => e.method === 'session/list').length;
  const none = await provider.listSessions({ scope: { kind: 'sessions', workspaces: [], provider_session_ids: [] }, limit: 10, correlation });
  assert(none.value.items.length === 0 && log('proto').filter(e => e.method === 'session/list').length === listCount, 'an empty selection asks the host nothing');

  assert((await provider.getSession({ provider_session_id: 'nope', correlation })).value === null, 'getSession of an unknown session is ok(null) (missing)');
  const read1 = await provider.readTranscript({ provider_session_id: 'p-1', limit: 2, correlation });
  const read2 = await provider.readTranscript({ provider_session_id: 'p-1', limit: 2, cursor: read1.value.next_cursor, correlation });
  assert(read1.value.items.map(e => e.seq).join(',') === '1,2' && read2.value.items.map(e => e.seq).join(',') === '3' && read2.value.next_cursor === null,
    'readTranscript pages session/read history in order');
  assert(log('proto').filter(e => e.method === 'session/read').every(e => e.params.excludeItems === false || e.params.excludeItems === true)
    && !log('proto').some(e => e.method === 'session/resume'), 'reads never attach (no session/resume)');
  assert((await provider.readTranscript({ provider_session_id: 'nope', limit: 2, correlation })).error.code === 'not_found', 'reading an unknown session is not_found');

  const started = await provider.startSession({ workspace: '/w/a/new', prompt: 'Scaffold it', authority: 'read_only', idempotency_key: 'k1', correlation });
  const startReq = log('proto').find(e => e.method === 'session/start');
  const turnReq = log('proto').find(e => e.method === 'turn/start');
  assert(started.ok && startReq.params.workspaceRoot === '/w/a/new' && startReq.params.approvalMode === 'denyUnmatched' && UUID7.test(startReq.params.commandId)
    && turnReq.params.sessionId === started.value.provider_session_id && turnReq.params.input[0].text === 'Scaffold it' && turnReq.params.ifBusy === undefined,
  'start sends session/start in the explicit workspace, then turn/start with the prompt');
  assert(startReq.argv.join(' ') === 'serve --disable-write --disable-shell', 'a read_only turn runs on a host started with writes and shell disabled');
  const again = await provider.startSession({ workspace: '/w/a/new', prompt: 'Scaffold it', authority: 'read_only', idempotency_key: 'k1', correlation });
  assert(again.value.provider_turn_id === started.value.provider_turn_id && log('proto').filter(e => e.method === 'session/start').length === 1, 'start is idempotent per key');
  const done = await provider.observeTurn({ provider_turn_id: started.value.provider_turn_id, correlation });
  assert(done.ok && done.value.status === 'completed' && done.value.output === 'muse reply: Scaffold it' && done.value.usage.input_tokens === 120 && done.value.usage.output_tokens === 45,
    'observe settles on turn/completed with the turn output and usage');

  const sent = await provider.sendTurn({ provider_session_id: 'p-1', prompt: 'Continue', authority: 'workspace_write', idempotency_key: 'k2', correlation });
  const resumeReq = log('proto').find(e => e.method === 'session/resume');
  assert(sent.ok && resumeReq.params.sessionId === 'p-1' && UUID7.test(resumeReq.params.commandId) && resumeReq.argv.join(' ') === 'serve',
    'send resumes the exact session on the workspace_write host (default posture)');
  assert((await provider.observeTurn({ provider_turn_id: sent.value.provider_turn_id, correlation })).value.status === 'completed', 'the resumed turn completes');
  const partial = await provider.sendTurn({ provider_session_id: 'p-1', prompt: '[usage:partial] p', authority: 'workspace_write', idempotency_key: 'k3', correlation });
  const partialDone = await provider.observeTurn({ provider_turn_id: partial.value.provider_turn_id, correlation });
  assert(partialDone.value.usage.input_tokens === 120 && partialDone.value.usage.output_tokens === null, 'partial usage keeps the unknown field null');
  const bare = await provider.sendTurn({ provider_session_id: 'p-1', prompt: '[usage:none] n', authority: 'workspace_write', idempotency_key: 'k4', correlation });
  assert((await provider.observeTurn({ provider_turn_id: bare.value.provider_turn_id, correlation })).value.usage === null, 'absent usage is null');
  assert(log('proto').filter(e => e.method === 'session/resume').length === 1, 'a session already loaded on the host is not resumed again');
  const authFail = await provider.sendTurn({ provider_session_id: 'p-1', prompt: '[fail:auth] x', authority: 'workspace_write', idempotency_key: 'k5', correlation });
  const authDone = await provider.observeTurn({ provider_turn_id: authFail.value.provider_turn_id, correlation });
  assert(authDone.value.status === 'failed' && authDone.value.failure.code === 'auth', 'a turn failing on credentials is failed/auth');

  const held = await provider.sendTurn({ provider_session_id: 'p-1', prompt: '[hold] long', authority: 'workspace_write', idempotency_key: 'k6', correlation });
  const busy = await provider.sendTurn({ provider_session_id: 'p-1', prompt: 'x', authority: 'workspace_write', idempotency_key: 'k7', correlation });
  assert(busy.error && busy.error.code === 'busy', 'a session with a turn in flight is busy (never queued, steered, or replaced)');
  const busyRo = await provider.sendTurn({ provider_session_id: 'p-1', prompt: 'x', authority: 'read_only', idempotency_key: 'k8', correlation });
  assert(busyRo.error && busyRo.error.code === 'busy', 'another authority cannot take a session our other host is running');
  const waited = await provider.observeTurn({ provider_turn_id: held.value.provider_turn_id, deadline_at: Date.now() + 50, correlation });
  assert(waited.error.code === 'timed_out', 'a deadline ends the wait only');
  const controller = new AbortController();
  const watching = provider.observeTurn({ provider_turn_id: held.value.provider_turn_id, signal: controller.signal, correlation });
  const cancel1 = await provider.cancelTurn({ provider_turn_id: held.value.provider_turn_id, correlation });
  const watched = await watching;
  const cancel2 = await provider.cancelTurn({ provider_turn_id: held.value.provider_turn_id, correlation });
  const cancels = log('proto').filter(e => e.method === 'turn/cancel');
  assert(cancel1.value === 'cancelled' && cancel2.value === 'already_terminal' && cancels.length === 1
    && cancels[0].params.sessionId === 'p-1' && UUID7.test(cancels[0].params.commandId) && watched.value.status === 'cancelled',
  'cancel sends one turn/cancel for the exact turn; an observer sees cancelled; a repeat is already_terminal');
  assert((await provider.cancelTurn({ provider_turn_id: sent.value.provider_turn_id, correlation })).value === 'already_terminal'
    && log('proto').filter(e => e.method === 'turn/cancel').length === 1, 'cancelling a finished turn calls nothing');
  const methods = new Set(log('proto').map(e => e.method));
  assert([...methods].every(m => ['initialize', 'session/list', 'session/read', 'session/start', 'session/resume', 'turn/start', 'turn/cancel'].includes(m)),
    `only stable MSP operations are sent (${[...methods].join(', ')})`);

  console.log('\nProtocol fake: unsupported, auth, and missing-runtime failures');
  const noList = muse.createMuseSessionProvider('conn-nolist', options('nolist', { FAKE_MUSE_DISABLE: 'session/list' }));
  assert((await noList.listSessions({ scope: all, limit: 5, correlation })).error.code === 'unsupported', 'a method the host does not serve is unsupported');
  const noText = muse.createMuseSessionProvider('conn-notext', options('notext', { FAKE_MUSE_NO_TEXT_FILTER: '1' }));
  assert((await noText.listSessions({ scope: all, query: 'x', limit: 5, correlation })).error.code === 'unsupported', 'a host that does not echo the text filter cannot search');
  const old = muse.createMuseSessionProvider('conn-old', options('old', { FAKE_MUSE_VERSION: '1.3.9' }));
  const oldProbe = await old.probe();
  assert(oldProbe.status === 'unsupported' && oldProbe.reason === 'muse_version_1.3.9' && contract.SESSION_PROVIDER_CAPABILITIES.every(key => old.capabilities()[key] === false)
    && old.capabilities().list === false && old.capabilities().authorities.length === 0, 'a Muse older than the verified version is unsupported and reports no capability');
  assert((await old.listSessions({ scope: all, limit: 5, correlation })).error.code === 'unsupported', 'operations on it fail unsupported');
  const schema2 = muse.createMuseSessionProvider('conn-schema', options('schema', { FAKE_MUSE_SCHEMA: '2' }));
  assert((await schema2.probe()).reason === 'msp_schema_2', 'an unknown MSP envelope schema is unsupported');
  const ephemeral = muse.createMuseSessionProvider('conn-eph', options('eph', { FAKE_MUSE_DURABILITY: 'ephemeral' }));
  const ephProbe = await ephemeral.probe();
  assert(ephProbe.status === 'ready' && ephemeral.capabilities().resume === false && ephemeral.capabilities().list === false && ephemeral.capabilities().start === true,
    'an ephemeral host can start but has nothing to list, read, or resume');
  const authHost = muse.createMuseSessionProvider('conn-auth', options('auth', { FAKE_MUSE_AUTH_FAIL: '1' }));
  const authProbe = await authHost.probe();
  const authList = await authHost.listSessions({ scope: all, limit: 5, correlation });
  assert(authProbe.status === 'auth_required' && authList.error.code === 'unavailable' && /^auth_required/.test(authList.error.message), 'an auth failure is a structured auth_required');
  const missing = muse.createMuseSessionProvider('conn-missing', { command: path.join(TMP, 'no-such-muse') });
  const missingProbe = await missing.probe();
  assert(missingProbe.status === 'unavailable' && missingProbe.reason === 'binary_missing', 'a missing muse binary is unavailable/binary_missing');
  muse.shutdownMuseSessionProviders();
}

const SCOPE = ['/work/alpha', '/work/gamma'];

async function main() {
  normalization();
  await protocol();

  console.log('\nRegistration: Muse connections get the direct provider; no Agent Deck');
  assert(contract.sessionProviderFor({ id: 'rc-any', provider: 'muse' }).kind === muse.MUSE_PROVIDER_KIND
    && contract.sessionProviderFor({ id: 'rc-any', provider: 'codex' })?.kind !== muse.MUSE_PROVIDER_KIND, 'the default Muse registration covers muse connections only');
  const conn = dbModule.runtimeConnections.create({ provider: 'muse', label: 'Muse laptop', host: 'This computer' }).id;
  contract.registerSessionProvider({ connectionId: conn }, null);
  muse.registerMuseSessionProvider(options('home'), { connectionId: conn });
  const dev = dbModule.bots.create({
    name: 'MuseDev', title: 'Native', description: 'Native Muse sessions', agent: 'muse', runtime_connection_id: conn, launch_profile: 'direct',
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify(SCOPE), policy_mode: 'workspace_write', allow_new_sessions: 1, allow_resume_with_edits: 1,
  });
  assert(dbModule.bots.getById(dev.id).deck_id === null && dbModule.bots.getById(dev.id).launch_profile === 'direct', 'the Muse Agent is direct with no deck');

  fakeMuse.seedFakeMuse(path.join(TMP, 'home.json'), [
    { id: '01a10000-0000-7000-8000-0000000000a1', title: 'Refactor the parser', workspace: '/work/alpha/parser', items: [
      ['user', 'Refactor the parser'], ['assistant', 'Plan ready'], ['user', 'Go ahead'], ['assistant', 'Done'], ['user', 'Thanks'],
    ] },
    { id: '01a10000-0000-7000-8000-0000000000a3', title: 'Unpersisted', workspace: '/work/alpha/old', path: false },
    { id: '01a10000-0000-7000-8000-0000000000b1', title: 'Outside work', workspace: '/work/beta' },
    { id: '01a10000-0000-7000-8000-0000000000n1', title: 'No workspace' },
    { id: '01a10000-0000-7000-8000-0000000000c1', title: 'Child', workspace: '/work/alpha', kind: 'subagent' },
    { id: 'bad-1', raw: { sessionId: 42, workspaceRoot: '/work/alpha' } },
    { id: 'bad-2', raw: 'not a session' },
    { id: '01a10000-0000-7000-8000-0000000000g1', title: 'Gamma notes', workspace: '/work/gamma', items: [['user', 'notes'], ['assistant', 'ok']] },
  ]);

  console.log('\nDiscovery: scoped, idempotent, several workspaces, malformed rows');
  async function syncAll(now) {
    const out = { imported: [], updated: [], rejected: 0, pages: 0 };
    let cursor = null;
    do {
      const page = await ps.syncAgentSessions(db, dev.id, { cursor, limit: 3, now });
      out.imported.push(...page.imported);
      out.updated.push(...page.updated);
      out.rejected += page.rejected_out_of_scope;
      out.pages++;
      cursor = page.next_cursor;
    } while (cursor && out.pages < 10);
    return out;
  }
  const first = await syncAll(1000);
  assert(first.imported.length === 3 && first.updated.length === 0 && first.rejected === 2 && first.pages === 3,
    'three in-scope sessions across two workspaces import; two out-of-scope are refused; the subagent and malformed rows are skipped');
  const refs = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? ORDER BY id').all(dev.id).map(r => r.id);
  const second = await syncAll(2000);
  const third = await syncAll(3000);
  assert(second.imported.length === 0 && third.imported.length === 0 && second.updated.length === 3 && third.updated.length === 3
    && JSON.stringify(db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? ORDER BY id').all(dev.id).map(r => r.id)) === JSON.stringify(refs),
  'repeated sync imports nothing twice and keeps every reference');
  const workspaces = db.prepare('SELECT workspace FROM provider_sessions WHERE agent_id = ? ORDER BY workspace').all(dev.id).map(r => r.workspace);
  assert(JSON.stringify(workspaces) === JSON.stringify(['/work/alpha/old', '/work/alpha/parser', '/work/gamma']), 'both registered workspaces contribute');
  const lp = log('home').filter(e => e.method === 'session/list');
  assert(lp.every(e => e.params.limit === 3), 'discovery pages are bounded on the wire');
  const rowOf = id => db.prepare('SELECT * FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(dev.id, id);
  const a1 = rowOf('01a10000-0000-7000-8000-0000000000a1').id;
  const a3 = rowOf('01a10000-0000-7000-8000-0000000000a3').id;
  const g1 = rowOf('01a10000-0000-7000-8000-0000000000g1').id;
  const list = catalog.listAgentSessions(db, dev.id, 'all');
  const byRef = Object.fromEntries(list.map(s => [s.ref, s]));
  assert(byRef[a1].source === 'native' && byRef[a1].state.resumable === true && byRef[a1].state.lifecycle === 'open' && byRef[a1].state.busy === false
    && byRef[a3].state.resumable === false, 'the catalog shows Muse facts: open, resumable or not, idle');
  assert(leaks('home', list).length === 0 && leaks('home', catalog.getAgentSession(db, dev.id, a1)).length === 0, 'no Muse id in catalog rows or details');
  const caps = ps.agentProviderCapabilities(db, dev.id);
  assert(caps.provider_kind === 'muse-msp' && caps.resume === true && caps.authorities.length === 2, 'per-Agent capability discovery reports the probed Muse provider');

  console.log('\nTranscript, start, and turns before the restart');
  const t1 = await ps.readProviderTranscript(db, dev.id, a1, { limit: 2 });
  const t2 = await ps.readProviderTranscript(db, dev.id, a1, { limit: 2, cursor: t1.next_cursor });
  const t3 = await ps.readProviderTranscript(db, dev.id, a1, { limit: 2, cursor: t2.next_cursor });
  assert([...t1.entries, ...t2.entries, ...t3.entries].map(e => e.seq).join(',') === '1,2,3,4,5' && t3.next_cursor === null, 'a pre-existing Muse transcript reads in pages');
  await rejects(ps.startProviderSession(db, dev.id, { workspace: '/work/beta/x', prompt: 'x', authority: 'read_only', idempotencyKey: 's0', requester: owner }), 'out_of_scope',
    'a workspace outside the scope is refused before Muse is asked');
  const started = await ps.startProviderSession(db, dev.id, { workspace: '/work/gamma/new', prompt: 'Scaffold the module', authority: 'workspace_write', idempotencyKey: 's1', requester: owner, correlation: { requestId: 'corr-start' } });
  const startedDone = await ps.observeProviderTurn(db, dev.id, started.turn.turn_ref);
  const startedRow = db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(started.turn.session_ref);
  assert(startedDone.state === 'completed' && startedDone.output === 'muse reply: Scaffold the module' && startedRow.workspace === '/work/gamma/new' && startedRow.origin === 'started',
    'a new Muse session starts in the explicit workspace and completes');
  const quick = await ps.sendProviderTurn(db, dev.id, g1, { prompt: 'Summarize before the restart', authority: 'read_only', idempotencyKey: 'pre-1', requester: owner });
  const held = await ps.sendProviderTurn(db, dev.id, a1, { prompt: '[hold] long work before the restart', authority: 'read_only', idempotencyKey: 'pre-2', requester: owner, correlation: { requestId: 'corr-held' } });
  await sleep(300);
  const sessionsBefore = Object.keys(state('home').sessions).length;
  // Botmancers exits: its Muse hosts go with it.
  muse.shutdownMuseSessionProviders();
  await sleep(300);

  console.log('\nRestart: a second Botmancers process on the same database');
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: { ...process.env, NOT508_TAG: TAG, NOT508_IDS: JSON.stringify({ conn, dev: dev.id, a1, g1, quick: quick.turn.turn_ref, held: held.turn.turn_ref }) }, encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && result && result.failures === 0, 'the restarted process reattached, resumed, and cancelled');
  assert(Object.keys(state('home').sessions).length === sessionsBefore, 'no replacement Muse session was started across the restart');
  assert(result && result.fetchCalls === 0 && fetchCalls === 0, 'no network call (no Agent Deck) in either process');

  console.log('\nMissing sessions stay, with explicit availability');
  const home = state('home');
  delete home.sessions['01a10000-0000-7000-8000-0000000000a3'];
  fakeMuse.saveFakeMuse(path.join(TMP, 'home.json'), home);
  const refreshed = await ps.refreshProviderSession(db, dev.id, a3, { now: 9000 });
  assert(refreshed.availability === 'missing' && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE id = ?', a3) === 1, 'a session Muse lost is missing, never deleted');
  await rejects(ps.readProviderTranscript(db, dev.id, a3), 'session_missing', 'reading it is session_missing');
  const resync = await syncAll(9100);
  assert(resync.imported.length === 0 && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 4, 're-sync after a loss imports nothing new');

  console.log('\nCanonical rows and events');
  const turns = db.prepare('SELECT kind, state, failure_code FROM provider_session_turns WHERE agent_id = ? ORDER BY created_at, id').all(dev.id);
  const events = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? GROUP BY type').all(dev.id).map(r => [r.type, r.n]));
  console.log(`  turns: ${JSON.stringify(turns)}`);
  console.log(`  events: ${JSON.stringify(events)}`);
  assert(turns.length === 5 && turns.filter(t => t.state === 'completed').length === 3 && turns.filter(t => t.state === 'cancelled').length === 1
    && turns.filter(t => t.state === 'failed' && t.failure_code === 'host_lost').length === 1 && turns.every(t => t.state !== 'running'),
  'five turns: three completed, one cancelled, one failed host_lost, none running');
  assert(events.session_imported === 3 && events.session_started === 1 && events.turn_started === 5 && events.turn_completed === 3 && events.turn_failed === 1
    && events.turn_cancelled === 1 && events.cancel_requested === 1 && events.session_missing === 1, 'one event per lifecycle fact');
  assert(count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 4, 'four registry rows (three imported, one started)');
  const startedSample = db.prepare('SELECT provider, input_tokens, output_tokens, cost_usd FROM usage_samples WHERE turn_id = ?').get(started.turn.turn_ref);
  assert(startedSample && startedSample.provider === muse.MUSE_PROVIDER_KIND && startedSample.input_tokens === 120 && startedSample.output_tokens === 45 && startedSample.cost_usd === null,
    'a Muse turn records one common usage sample: reported tokens, cost unknown');
  const views = [list, ps.listProviderTurns(db, dev.id, a1), ps.listProviderTurns(db, dev.id, g1), db.prepare('SELECT * FROM provider_session_events').all()];
  assert(leaks('home', views).length === 0, 'no Muse session or turn id in turn views or events');

  console.log('\nDocumentation contract');
  const core = fs.readFileSync(path.join(ROOT, 'docs/providers/muse.md'), 'utf8');
  assert(/Muse/.test(core) && /session\/resume/.test(core) && /host_lost/.test(core), 'docs/providers/muse.md documents the Muse provider');

  muse.shutdownMuseSessionProviders();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll Muse session provider checks passed.');
}

async function restart() {
  const ids = JSON.parse(process.env.NOT508_IDS);
  contract.registerSessionProvider({ connectionId: ids.conn }, null);
  muse.registerMuseSessionProvider(options('home'), { connectionId: ids.conn });
  const startsBefore = log('home').filter(e => e.method === 'session/start').length;
  const a1Resumes = () => log('home').filter(e => e.method === 'session/resume' && e.params.sessionId === '01a10000-0000-7000-8000-0000000000a1');
  const resumesBefore = a1Resumes().length;

  console.log('reattach to turns started before the restart');
  const quick = await ps.observeProviderTurn(db, ids.dev, ids.quick);
  assert(quick.state === 'completed' && quick.output === 'muse reply: Summarize before the restart', 'a turn that finished while Botmancers was down is read from the durable session');
  const held = await ps.observeProviderTurn(db, ids.dev, ids.held);
  assert(held.state === 'failed' && held.failure_code === 'host_lost', 'a turn lost with its host is failed host_lost, not replaced');
  const heldCorr = JSON.parse(db.prepare('SELECT correlation FROM provider_session_turns WHERE id = ?').get(ids.held).correlation);
  assert(heldCorr.requestId === 'corr-held', 'the turn keeps its correlation across the restart');

  console.log('resume the exact past session');
  const resumed = await ps.sendProviderTurn(db, ids.dev, ids.a1, { prompt: 'Continue after restart', authority: 'workspace_write', idempotencyKey: 'post-1', requester: owner, correlation: { requestId: 'corr-resume' } });
  const done = await ps.observeProviderTurn(db, ids.dev, resumed.turn.turn_ref);
  const resumes = a1Resumes().slice(resumesBefore);
  assert(done.state === 'completed' && done.output === 'muse reply: Continue after restart' && done.session_ref === ids.a1, 'resume by Botmancers reference completes on the same session');
  assert(resumes.length === 1 && resumes[0].argv.join(' ') === 'serve', 'exactly one session/resume of that Muse session, on the workspace_write host');
  assert(log('home').filter(e => e.method === 'session/start').length === startsBefore, 'no session/start after the restart');
  const s = state('home').sessions['01a10000-0000-7000-8000-0000000000a1'];
  assert(s.workspaceRoot === '/work/alpha/parser' && s.lastTurn.terminal === 'completed', 'the session keeps its workspace (cwd)');
  const replay = await ps.sendProviderTurn(db, ids.dev, ids.a1, { prompt: 'Continue after restart', authority: 'workspace_write', idempotencyKey: 'post-1', requester: owner });
  assert(replay.replayed && replay.turn.turn_ref === resumed.turn.turn_ref, 'the same idempotency key replays without another Muse turn');

  console.log('cancel after the restart');
  const hold = await ps.sendProviderTurn(db, ids.dev, ids.g1, { prompt: '[hold] watch', authority: 'read_only', idempotencyKey: 'post-2', requester: owner });
  const first = await ps.cancelProviderTurn(db, ids.dev, hold.turn.turn_ref);
  const second = await ps.cancelProviderTurn(db, ids.dev, hold.turn.turn_ref);
  assert(first.outcome === 'cancelled' && first.turn.state === 'cancelled' && second.outcome === 'already_terminal', 'cancel stops the turn; a repeat is already_terminal');
  assert(log('home').filter(e => e.method === 'turn/cancel').length === 1, 'Muse received exactly one turn/cancel');
  assert(leaks('home', [quick, held, done, first, second]).length === 0, 'no Muse id in any turn view');
  muse.shutdownMuseSessionProviders();
  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls })}`);
  process.exit(failures > 0 ? 1 : 0);
}
