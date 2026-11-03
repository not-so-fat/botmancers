#!/usr/bin/env node
// NOT-506: the direct Claude Code SessionProvider (lib/claude-session-provider)
// against a stand-in `claude` executable (test-support/fake-claude-cli.js) and
// versioned local-store and stream fixtures (test-support/fixtures/claude-code).
// Proves: the spawn boundary (argv, environment, cwd, stdin, cancellation,
// structured events only); scoped, idempotent discovery of pre-existing
// sessions across workspaces with malformed records and removed sessions;
// open/archived/busy/missing/resumable facts without exposing Claude ids;
// stable missing/auth/permission/incompatible/usage-cap failures that never
// launch a replacement session (process calls and canonical row/event
// counts); reported usage and total_cost_usd kept as nullable values,
// including explicit zero; and resume/observe/cancel after a Botmancers
// restart, with no network and no Agent Deck.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT506_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-claude-provider-${TAG}`);
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
// Claude Code records real paths (macOS /var is /private/var).
const REAL = fs.realpathSync(TMP);
const WS = path.join(REAL, 'ws');
const CONFIG = path.join(TMP, 'claude-config');
const STATE = path.join(TMP, 'provider-state');
const CALLS = path.join(TMP, 'claude-calls.jsonl');
const FAKE_BIN = path.join(ROOT_DIR, 'test-support', 'fake-claude-cli.js');
const FIXTURES = path.join(ROOT_DIR, 'test-support', 'fixtures', 'claude-code');
const NOW = Date.parse('2026-10-18T12:00:00.000Z');

process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT_DIR } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const catalog = jiti('./lib/session-catalog.ts');
const claude = jiti('./lib/claude-session-provider.ts');
const store = jiti('./lib/claude-session-store.ts');
const stream = jiti('./lib/claude-stream.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'store-v2.1', 'manifest.json'), 'utf8'));
const ID = Object.fromEntries(manifest.sessions.filter(s => s.id).map(s => [s.key, s.id]));
const ALL_IDS = new RegExp(Object.values(ID).join('|'));
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const argOf = (call, flag) => { const i = call.argv.indexOf(flag); return i >= 0 ? call.argv[i + 1] : null; };

// The provider's base environment: a stale Agent Deck variable is present
// so the test can prove the deck-agnostic provider applies no
// deck-specific filtering — the turn inherits the base environment.
const providerEnv = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG, FAKE_CLAUDE_LOG: CALLS, FAKE_CLAUDE_MARK: 'not506', AGENT_DECK_URL: 'http://127.0.0.1:1/deck' };
function providerOptions(extra = {}) {
  return { bin: FAKE_BIN, configDir: CONFIG, stateDir: STATE, env: providerEnv, now: () => NOW, pollMs: 20, startupTimeoutMs: 20_000, ...extra };
}
function register(connectionId, extra) {
  contract.registerSessionProvider({ connectionId }, () => claude.createClaudeSessionProvider(providerOptions(extra)));
}

function installStore() {
  for (const session of manifest.sessions) {
    const project = path.join(WS, session.project);
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(CONFIG, 'projects', store.projectSlug(project));
    fs.mkdirSync(dir, { recursive: true });
    const text = fs.readFileSync(path.join(FIXTURES, 'store-v2.1', session.file), 'utf8').split('{{ROOT}}').join(WS).split('{{ID}}').join(session.id ?? '');
    fs.writeFileSync(path.join(dir, session.name ?? `${session.id}.jsonl`), text);
  }
  for (const extra of ['alpha/new', 'alpha/hold', 'alpha/new2']) fs.mkdirSync(path.join(WS, extra), { recursive: true });
  fs.mkdirSync(path.join(CONFIG, 'sessions'), { recursive: true });
  // A live interactive process holds a4; a1's entry belongs to a dead pid.
  fs.writeFileSync(path.join(CONFIG, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID.a4, cwd: path.join(WS, 'alpha'), status: 'idle' }));
  fs.writeFileSync(path.join(CONFIG, 'sessions', '2147483.json'), JSON.stringify({ pid: 2147483, sessionId: ID.a1, cwd: path.join(WS, 'alpha/parser'), status: 'busy' }));
  fs.writeFileSync(path.join(CONFIG, 'sessions', 'broken.json'), '{');
}

function agent(name, connectionId, scope, policy) {
  return dbModule.bots.create({
    name, title: 'Claude', description: 'Claude Code sessions', agent: 'claude', runtime_connection_id: connectionId, launch_profile: 'direct',
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
  installStore();
  const correlation = { requestId: null };

  console.log('\nStream parser: structured events, reported usage only');
  const fixture = name => fs.readFileSync(path.join(FIXTURES, 'stream', `${name}.jsonl`), 'utf8');
  const usageOf = name => stream.reportedUsage(stream.summarizeStream(fixture(name)).result);
  assert(JSON.stringify(usageOf('reported')) === JSON.stringify({ input_tokens: 1520, output_tokens: 311, total_cost_usd: 0.0421 }), 'reported: input/output tokens and total_cost_usd as Claude stated them (cache tokens not folded in)');
  assert(JSON.stringify(usageOf('zero')) === JSON.stringify({ input_tokens: 0, output_tokens: 0, total_cost_usd: 0 }), 'explicit zero stays zero');
  assert(JSON.stringify(usageOf('partial')) === JSON.stringify({ input_tokens: null, output_tokens: 9, total_cost_usd: null }), 'partial: each field independently nullable, no price inferred');
  assert(JSON.stringify(usageOf('absent')) === JSON.stringify({ input_tokens: null, output_tokens: null, total_cost_usd: null }), 'absent: all null');
  const malformed = stream.summarizeStream(fixture('malformed'));
  assert(JSON.stringify(stream.reportedUsage(malformed.result)) === JSON.stringify({ input_tokens: null, output_tokens: null, total_cost_usd: null })
    && malformed.malformed === 1 && malformed.result.result === 'ok', 'malformed: a string cost, negative or fractional tokens are null; terminal text is counted, not read; only the first result counts');
  assert(JSON.stringify(usageOf('camel')) === JSON.stringify({ input_tokens: 33, output_tokens: 4, total_cost_usd: 0.002 }), 'Agent Dealer-shaped camelCase usage is accepted');
  assert(JSON.stringify(stream.reportedUsage(null)) === JSON.stringify({ input_tokens: null, output_tokens: null, total_cost_usd: null }), 'no result event: nothing reported');
  const partialLine = stream.parseStreamText('{"type":"system","subtype":"init","session_id":"x"}\n{"type":"res');
  assert(partialLine.events.length === 1 && partialLine.malformed === 0, 'a partially written trailing line waits for the next read');
  const classify = (fields, rl = false) => stream.classifyFailure({ type: 'result', is_error: true, ...fields }, { rate_limit_rejected: rl }).code;
  assert(classify({ errors: ['No conversation found with session ID: x'] }) === 'session_missing'
    && classify({ result: 'Invalid API key · Please run /login' }) === 'auth_required' && classify({ api_error_status: 401 }) === 'auth_required'
    && classify({ api_error_status: 429 }) === 'usage_limit' && classify({}, true) === 'usage_limit'
    && classify({ permission_denials: [{ tool_name: 'Edit' }] }) === 'permission_denied' && classify({ result: 'boom' }) === 'runtime_error',
  'result events map to stable missing/auth/usage-cap/permission/runtime failures');

  console.log('\nLocal store reader (format claude-code-projects-jsonl/v1)');
  assert(store.CLAUDE_STORE_FORMAT === manifest.format, 'the fixtures are the reader\'s declared format version');
  const listed = store.listSessionFiles(CONFIG, [path.join(WS, 'alpha')]).map(file => file.id).sort();
  assert(JSON.stringify(listed) === JSON.stringify([ID.a1, ID.a2, ID.a3, ID.a4, ID.p1, ID.g1, ID.n1].sort()), 'the slug pre-filter keeps alpha and its prefix twin; non-uuid files are ignored');
  const metaA1 = store.readSessionMeta({ id: ID.a1, file: store.findSessionFile(CONFIG, ID.a1), mtime_ms: 0 });
  assert(metaA1.title === 'Parser refactor' && metaA1.workspace === path.join(WS, 'alpha/parser') && metaA1.malformed === 1 && metaA1.messages === 6 && metaA1.claude_code_version === '2.1.302',
    'metadata: custom title wins, cwd is the workspace, malformed lines counted, sidechain/meta records not counted');
  assert(store.readSessionMeta({ id: ID.g1, file: store.findSessionFile(CONFIG, ID.g1), mtime_ms: 0 }) === null
    && store.readSessionMeta({ id: ID.n1, file: store.findSessionFile(CONFIG, ID.n1), mtime_ms: 0 }) === null, 'all-malformed and cwd-less files are not sessions');
  const entriesA1 = store.readTranscriptEntries(store.findSessionFile(CONFIG, ID.a1), ID.a1);
  assert(entriesA1.map(e => `${e.role}:${e.text}`).join('|') === `user:Refactor the parser|assistant:Plan ready|tool:tool call: Read|tool:tool result: export function parse() {}|assistant:Done in session ${ID.a1}|user:Thanks`,
    'transcript: main chain only, thinking/sidechain/meta hidden, tools summarized');
  assert(JSON.stringify([...store.liveSessionIds(CONFIG, pid => pid === process.pid)]) === JSON.stringify([ID.a4]), 'live sessions: only entries whose process is alive');
  assert(store.findSessionFile(CONFIG, '../../etc/passwd') === null, 'a non-uuid session id never becomes a path');

  console.log('\nProvider conformance (direct)');
  const direct = claude.createClaudeSessionProvider(providerOptions());
  const caps = contract.normalizeCapabilities(direct.capabilities());
  assert(direct.kind === 'claude-code' && contract.SESSION_PROVIDER_CAPABILITIES.every(key => caps[key] === true)
    && JSON.stringify(caps.authorities) === '["read_only","workspace_write"]' && caps.max_page_size === 25, 'capabilities: every operation, both authority modes, page bound 25');
  const scopeAlpha = { kind: 'workspaces', workspaces: [path.join(WS, 'alpha')], provider_session_ids: [] };
  const page = await direct.listSessions({ scope: scopeAlpha, limit: 25, correlation });
  const byId = Object.fromEntries(page.value.items.map(item => [item.provider_session_id, item]));
  assert(page.ok && Object.keys(byId).sort().join() === [ID.a1, ID.a2, ID.a3, ID.a4].sort().join() && page.value.next_cursor === null,
    'workspace scope: the four alpha sessions; the alpha-two prefix twin, beta, and malformed files are not listed');
  assert(byId[ID.a1].lifecycle === 'open' && byId[ID.a1].resumable && !byId[ID.a1].busy && byId[ID.a2].lifecycle === 'archived' && byId[ID.a2].resumable
    && byId[ID.a3].resumable === false && byId[ID.a4].busy === true, 'facts: open, archived-but-resumable, not resumable (no conversation), busy (live process)');
  const small = await direct.listSessions({ scope: scopeAlpha, limit: 2, correlation });
  const rest = await direct.listSessions({ scope: scopeAlpha, limit: 25, cursor: small.value.next_cursor, correlation });
  assert(small.value.items.length === 2 && small.value.next_cursor !== null && rest.value.items.length === 2, 'pages continue by cursor');
  const searched = await direct.listSessions({ scope: { kind: 'all_provider_sessions', workspaces: [], provider_session_ids: [] }, query: 'caching', limit: 25, correlation });
  assert(searched.value.items.length === 1 && searched.value.items[0].provider_session_id === ID.a2, 'search matches titles');
  assert((await direct.getSession({ provider_session_id: '99999999-9999-4999-8999-999999999999', correlation })).value === null, 'an unknown session is ok(null): missing');
  assert(calls().length === 0, 'discovery and reads never start a Claude Code process');

  console.log('\nSpawn boundary: start, argv, environment, cwd, stdin');
  const startWs = path.join(WS, 'alpha/new');
  const started = await direct.startSession({ workspace: startWs, prompt: 'Scaffold the module', authority: 'read_only', idempotency_key: 'k-start', correlation });
  const startCall = calls()[0];
  const startSid = started.value.provider_session_id;
  assert(started.ok && store.isClaudeSessionId(startSid) && calls().length === 1, 'start launches exactly one process for a new session id');
  assert(JSON.stringify(startCall.argv) === JSON.stringify(['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--strict-mcp-config', '--session-id', startSid]),
  'read_only argv: print mode, stream-json, dontAsk, no prompts, read tools only, no MCP, an explicit new session id');
  assert(startCall.cwd === startWs && startCall.stdin === 'Scaffold the module' && !startCall.argv.includes('Scaffold the module'), 'cwd is the explicit workspace; the prompt goes on stdin, never argv');
  assert(startCall.env.agent_deck_keys.includes('AGENT_DECK_URL') && startCall.env.FAKE_CLAUDE_MARK === 'not506' && startCall.env.CLAUDE_CONFIG_DIR === CONFIG, 'environment: inherited as-is, with no deck-specific filtering');
  const replay = await direct.startSession({ workspace: startWs, prompt: 'Scaffold the module', authority: 'read_only', idempotency_key: 'k-start', correlation });
  assert(replay.value.provider_turn_id === started.value.provider_turn_id && calls().length === 1, 'the same idempotency key replays without another process');
  const done = await direct.observeTurn({ provider_turn_id: started.value.provider_turn_id, correlation });
  assert(done.ok && done.value.status === 'completed' && done.value.output === 'fake claude: Scaffold the module' && done.value.provider_session_id === startSid
    && JSON.stringify(done.value.usage) === JSON.stringify({ input_tokens: 12, output_tokens: 7, total_cost_usd: 0.0123 }), 'observe: the result event\'s text, session, usage, and cost');
  const sent = await direct.sendTurn({ provider_session_id: ID.a1, prompt: 'Apply the plan', authority: 'workspace_write', idempotency_key: 'k-send', correlation });
  const sendCall = calls()[1];
  assert(sent.ok && argOf(sendCall, '--resume') === ID.a1 && !sendCall.argv.includes('--session-id') && argOf(sendCall, '--permission-mode') === 'acceptEdits'
    && argOf(sendCall, '--tools') === 'Read,Glob,Grep,Edit,Write,NotebookEdit' && sendCall.cwd === path.join(WS, 'alpha/parser'),
  'workspace_write resume: --resume of the exact id, acceptEdits with edit tools only, in the session\'s recorded workspace');
  assert((await direct.observeTurn({ provider_turn_id: sent.value.provider_turn_id, correlation })).value.status === 'completed', 'the resumed turn completes');

  console.log('\nSpawn boundary: cancellation');
  const held = await direct.startSession({ workspace: path.join(WS, 'alpha/hold'), prompt: '[hold] long task', authority: 'read_only', idempotency_key: 'k-hold', correlation });
  const heldPid = calls().pop().pid;
  const controller = new AbortController();
  const waiting = direct.observeTurn({ provider_turn_id: held.value.provider_turn_id, signal: controller.signal, correlation });
  await sleep(60);
  controller.abort();
  assert((await waiting).error.code === 'cancelled', 'an aborted observe ends only the wait');
  assert((await direct.cancelTurn({ provider_turn_id: held.value.provider_turn_id, correlation })).value === 'cancelled', 'cancel stops a running turn');
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) { try { process.kill(heldPid, 0); await sleep(20); } catch { gone = true; } }
  assert(gone, 'the Claude Code process is terminated');
  assert((await direct.cancelTurn({ provider_turn_id: held.value.provider_turn_id, correlation })).value === 'already_terminal'
    && (await direct.observeTurn({ provider_turn_id: held.value.provider_turn_id, correlation })).value.status === 'cancelled', 'a repeated cancel is already_terminal; observe reports cancelled');
  fs.rmSync(path.join(CONFIG, 'projects', store.projectSlug(startWs)), { recursive: true, force: true });
  fs.rmSync(path.join(CONFIG, 'projects', store.projectSlug(path.join(WS, 'alpha/hold'))), { recursive: true, force: true });
  // The probe sessions above stay out of the registry scenario below.
  installStore();

  console.log('\nBuilt-in selection: a claude runtime connection uses the direct provider');
  assert(contract.sessionProviderFor({ id: 'rc-unregistered', provider: 'claude' }).kind === 'claude-code', 'a claude connection without explicit registration gets the built-in Claude Code provider');
  assert(contract.sessionProviderFor({ id: 'rc-unregistered', provider: 'unknown-runtime' }) === null, 'providers without an adapter are unchanged');

  console.log('\nRegistry: scoped discovery, idempotent, multiple workspaces');
  const { runtimeConnections } = dbModule;
  const ids = {
    laptop: runtimeConnections.create({ provider: 'claude', label: 'Claude laptop', host: 'This computer' }).id,
  };
  register(ids.laptop);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const dev = agent('Dev', ids.laptop, { kind: 'workspaces', items: [path.join(WS, 'alpha')] }, write);
  const betaAgent = agent('Beta', ids.laptop, { kind: 'workspaces', items: [path.join(WS, 'beta')] }, { mode: 'read_only', newSessions: true });
  const everything = agent('Everything', ids.laptop, { kind: 'all_provider_sessions' }, { mode: 'read_only', newSessions: false });
  assert([dev, betaAgent, everything].every(bot => dbModule.bots.getById(bot.id).deck_id === null), 'no Agent selects a deck');
  const sync1 = await ps.syncAgentSessions(db, dev.id, { now: 1000 });
  const sync2 = await ps.syncAgentSessions(db, dev.id, { now: 2000 });
  assert(sync1.imported.length === 4 && sync1.rejected_out_of_scope === 0 && sync2.imported.length === 0 && sync2.updated.length === 4
    && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 4, 'pre-existing alpha sessions import once; a repeated sync imports nothing new');
  const ref = key => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(dev.id, ID[key])?.id;
  const rowOf = key => db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(ref(key));
  assert(rowOf('a1').title === 'Parser refactor' && rowOf('a1').workspace === path.join(WS, 'alpha/parser') && rowOf('a1').provider_kind === 'claude-code', 'rows carry title, workspace, provider kind');
  assert(rowOf('a2').lifecycle === 'archived' && rowOf('a2').resumable === 1 && rowOf('a3').resumable === 0 && rowOf('a4').busy === 1, 'archived/resumable/busy facts are stored');
  const betaSync = await ps.syncAgentSessions(db, betaAgent.id, { now: 3000 });
  const allSync = await ps.syncAgentSessions(db, everything.id, { now: 3001 });
  assert(betaSync.imported.length === 1 && allSync.imported.length === 6, 'another workspace\'s Agent sees only its session; the explicit all-sessions scope sees all six valid sessions');
  const list = catalog.listAgentSessions(db, dev.id, 'all');
  assert(list.length === 4 && !ALL_IDS.test(JSON.stringify(list)) && !ALL_IDS.test(JSON.stringify(catalog.getAgentSession(db, dev.id, ref('a1')))),
    'the catalog shows the imported sessions under Botmancers references, never a Claude id');

  const bulkWorkspace = path.join(WS, 'bulk');
  const bulkProject = path.join(CONFIG, 'projects', store.projectSlug(bulkWorkspace));
  fs.mkdirSync(bulkProject, { recursive: true });
  for (let i = 0; i < 30; i++) {
    const suffix = i.toString(16).padStart(12, '0');
    const sessionId = `10000000-0000-4000-8000-${suffix}`;
    fs.writeFileSync(path.join(bulkProject, `${sessionId}.jsonl`), [
      JSON.stringify({ sessionId, cwd: bulkWorkspace, version: '2.1.302', type: 'user', timestamp: `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`, message: { role: 'user', content: `Bulk history ${i}` } }),
      JSON.stringify({ sessionId, cwd: bulkWorkspace, version: '2.1.302', type: 'assistant', timestamp: `2026-09-01T00:01:${String(i).padStart(2, '0')}.000Z`, message: { role: 'assistant', content: 'Done' } }),
      '',
    ].join('\n'));
  }
  const callsBeforeRegistration = calls().length;
  const registeredResponse = await botsRoute.POST(new Request('http://localhost:3333/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Registered with history',
      runtime_connection_id: ids.laptop,
      session_scope: { kind: 'workspaces', workspaces: [bulkWorkspace] },
      policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    }),
  }));
  const registered = await registeredResponse.json();
  assert(registeredResponse.status === 200
    && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', registered.id) === 30,
  'registering a Claude Agent imports every page of its in-scope past sessions');
  assert(calls().length === callsBeforeRegistration && !ALL_IDS.test(JSON.stringify(registered)),
    'registration history import is read-only and exposes no Claude session id');

  console.log('\nTranscript pages');
  const pages = [];
  let cursor = null;
  do {
    const p = await ps.readProviderTranscript(db, dev.id, ref('a1'), { cursor, limit: 2 });
    pages.push(p);
    cursor = p.next_cursor;
  } while (cursor && pages.length < 10);
  const entries = pages.flatMap(p => p.entries);
  assert(pages.length === 3 && entries.map(e => e.seq).join() === '1,2,3,4,5,6' && entries[4].text === 'Done in session [redacted]' && !ALL_IDS.test(JSON.stringify(pages)),
    'a past session reads in bounded pages with its Claude id redacted');

  console.log('\nRemoved sessions stay as missing');
  fs.rmSync(store.findSessionFile(CONFIG, ID.a3));
  const sync3 = await ps.syncAgentSessions(db, dev.id, { now: 4000 });
  const refreshedA3 = await ps.refreshProviderSession(db, dev.id, ref('a3'), { now: 4001 });
  assert(sync3.updated.length === 3 && refreshedA3.availability === 'missing' && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 4,
    'a removed session is no longer listed, is marked missing on refresh, and keeps its row');

  console.log('\nResume failures: stable codes, never a replacement session');
  const turnRows = () => count('SELECT COUNT(*) AS n FROM provider_session_turns WHERE agent_id = ?', dev.id);
  const sessionRows = () => count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id);
  const callsBefore = calls().length;
  const send = (key, prompt, idem, authority = 'read_only') => ps.sendProviderTurn(db, dev.id, ref(key), { prompt, authority, idempotencyKey: idem, requester: owner });
  await rejects(send('a3', 'x', 'neg-missing'), 'session_missing', 'a session removed from the store is session_missing');
  await rejects(send('a4', 'x', 'neg-busy'), 'busy', 'a session a live Claude Code process holds is busy');
  assert(calls().length === callsBefore, 'neither refusal started a process');
  providerEnv.FAKE_CLAUDE_FORGET = ID.a1;
  await rejects(send('a1', 'x', 'neg-forgotten'), 'session_missing', 'Claude Code\'s own "No conversation found" result is session_missing');
  delete providerEnv.FAKE_CLAUDE_FORGET;
  await rejects(send('a1', '[auth-early] x', 'neg-auth-early'), 'auth_required', 'an authentication failure before the turn is auth_required');
  await rejects(send('a1', '[fork] x', 'neg-fork'), 'not_resumable', 'a process that reports another session is stopped and refused');
  register(ids.laptop, { bin: path.join(TMP, 'claude-old'), env: { ...providerEnv, FAKE_CLAUDE_VERSION: '1.9.0' } });
  fs.symlinkSync(FAKE_BIN, path.join(TMP, 'claude-old'));
  await rejects(send('a1', 'x', 'neg-old'), 'incompatible_version', 'a Claude Code older than the supported version is incompatible_version');
  fs.symlinkSync(FAKE_BIN, path.join(TMP, 'claude-noflag'));
  register(ids.laptop, { bin: path.join(TMP, 'claude-noflag'), env: { ...providerEnv, FAKE_CLAUDE_REJECT_FLAG: '--permission-prompts' } });
  await rejects(send('a1', 'x', 'neg-flag'), 'incompatible_version', 'a CLI that rejects the flag set is incompatible_version');
  register(ids.laptop);
  const negCalls = calls().slice(callsBefore);
  assert(negCalls.length === 4 && negCalls.every(call => argOf(call, '--resume') === ID.a1 && !call.argv.includes('--session-id')),
    'four resume processes, every one --resume of the exact id, none a new session (the old CLI never ran a turn)');
  assert(turnRows() === 0 && sessionRows() === 4, 'refused resumes leave no turn and no new session row');

  const failedTurn = async (prompt, idem) => {
    const { turn } = await send('a1', prompt, idem);
    return ps.observeProviderTurn(db, dev.id, turn.turn_ref);
  };
  const auth = await failedTurn('[auth] x', 'neg-auth');
  const cap = await failedTurn('[usage-cap] x', 'neg-cap');
  const perm = await failedTurn('[permission] x', 'neg-perm');
  const crash = await failedTurn('[crash] x', 'neg-crash');
  assert(auth.state === 'failed' && auth.failure_code === 'auth_required' && cap.failure_code === 'usage_limit' && perm.failure_code === 'permission_denied'
    && crash.failure_code === 'process_exited', 'failures during a turn: auth_required, usage_limit, permission_denied, process_exited');
  const afterNeg = calls().slice(callsBefore);
  assert(afterNeg.length === 8 && afterNeg.every(call => argOf(call, '--resume') === ID.a1) && sessionRows() === 4 && turnRows() === 4,
    'every failing turn resumed the exact session once; no session row was added');
  await rejects(ps.startProviderSession(db, dev.id, { workspace: path.join(WS, 'beta'), prompt: 'x', authority: 'read_only', idempotencyKey: 'neg-start', requester: owner }),
    'out_of_scope', 'start outside the registered workspaces is refused');
  await rejects(ps.startProviderSession(db, betaAgent.id, { workspace: path.join(WS, 'beta'), prompt: 'x', authority: 'workspace_write', idempotencyKey: 'neg-w', requester: owner }),
    'authority_not_allowed', 'workspace_write is refused for a read-only Agent');
  assert(calls().length === callsBefore + 8, 'refused starts launched nothing');

  console.log('\nReported usage per turn (nullable, explicit zero kept)');
  const usageTurn = async name => (await failedTurn(`[stream:${name}] x`, `usage-${name}`)).usage;
  const usage = {};
  for (const name of ['reported', 'zero', 'partial', 'absent', 'malformed']) usage[name] = await usageTurn(name);
  assert(JSON.stringify(usage.reported) === JSON.stringify({ input_tokens: 1520, output_tokens: 311, total_cost_usd: 0.0421 }), 'reported usage and cost stored on the turn');
  assert(JSON.stringify(usage.zero) === JSON.stringify({ input_tokens: 0, output_tokens: 0, total_cost_usd: 0 }), 'explicit zero stored as zero');
  assert(JSON.stringify(usage.partial) === JSON.stringify({ input_tokens: null, output_tokens: 9, total_cost_usd: null }), 'partial stays partial');
  assert(JSON.stringify(usage.absent) === JSON.stringify({ input_tokens: null, output_tokens: null, total_cost_usd: null })
    && JSON.stringify(usage.malformed) === JSON.stringify({ input_tokens: null, output_tokens: null, total_cost_usd: null }), 'absent and malformed are null, never estimated');
  const sample = db.prepare(`SELECT s.input_tokens, s.output_tokens, s.cost_usd FROM usage_samples s
    JOIN provider_session_turns t ON t.id = s.turn_id WHERE t.idempotency_key = 'usage-reported'`).get();
  assert(sample && sample.input_tokens === 1520 && sample.output_tokens === 311 && sample.cost_usd === 0.0421,
    'the same reported usage is the turn\'s one NOT-509 usage sample (total_cost_usd as cost_usd)');

  console.log('\nBefore the restart: one unobserved turn, one held turn');
  const pending = await send('a1', 'Summarize before the restart', 'pre-restart');
  const hold = await ps.startProviderSession(db, dev.id, { workspace: path.join(WS, 'alpha/hold'), prompt: '[hold] keep going', authority: 'read_only', idempotencyKey: 'pre-hold', requester: owner });

  console.log('\nRestart: a second Botmancers process on the same database');
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: { ...process.env, NOT506_TAG: TAG, NOT506_IDS: JSON.stringify({ laptop: ids.laptop, dev: dev.id, a1: ref('a1'), a2: ref('a2'), pending: pending.turn.turn_ref, hold: hold.turn.turn_ref }) },
    encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && result && result.failures === 0, 'the restarted process observed, resumed, started, and cancelled');
  assert(result && result.fetchCalls === 0 && fetchCalls === 0, 'no network call (no Agent Deck) in either process');

  console.log('\nCanonical rows and events');
  const turns = db.prepare('SELECT kind, state, failure_code FROM provider_session_turns WHERE agent_id = ? ORDER BY created_at, id').all(dev.id);
  const events = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events WHERE agent_id = ? GROUP BY type').all(dev.id).map(row => [row.type, row.n]));
  console.log(`  turns: ${turns.length} ${JSON.stringify(turns.map(t => t.state))}`);
  console.log(`  events: ${JSON.stringify(events)}`);
  assert(turns.length === 14 && turns.filter(t => t.kind === 'start').length === 2 && turns.filter(t => t.state === 'failed').length === 4
    && turns.filter(t => t.state === 'cancelled').length === 1 && turns.every(t => t.state !== 'running'), 'fourteen turns: two starts, four failed, one cancelled, none running');
  assert(events.session_imported === 4 && events.session_started === 2 && events.session_missing === 1 && events.turn_started === 14 && events.turn_failed === 4
    && events.turn_cancelled === 1 && events.turn_completed === 9, 'one event per fact');
  assert(sessionRows() === 6, 'six rows: four imported, two started');
  const views = JSON.stringify([ps.listProviderTurns(db, dev.id, ref('a1')), catalog.listAgentSessions(db, dev.id, 'all'), db.prepare('SELECT * FROM provider_session_events').all()]);
  const startedIds = db.prepare("SELECT provider_session_id FROM provider_sessions WHERE origin = 'started'").all().map(row => row.provider_session_id);
  assert(!ALL_IDS.test(views) && startedIds.every(id => !views.includes(id)) && !/ct-[0-9a-f-]{36}/.test(views), 'no Claude session or provider turn id in any turn view, catalog row, or event');

  console.log('\nBack-to-back resumes: the result arrives before the process exits');
  const lingerCalls = calls().length;
  const first = await send('a2', '[linger] one', 'linger-1');
  const firstDone = await ps.observeProviderTurn(db, dev.id, first.turn.turn_ref);
  const second = await send('a2', '[linger] two', 'linger-2');
  const secondDone = await ps.observeProviderTurn(db, dev.id, second.turn.turn_ref);
  assert(firstDone.state === 'completed' && secondDone.state === 'completed' && calls().length === lingerCalls + 2,
    'observe returns once the process has exited, so the next resume is not refused as busy');

  console.log('\nDocumentation contract');
  const docs = fs.readFileSync(path.join(ROOT_DIR, 'docs/claude-session-provider.md'), 'utf8');
  assert(/--resume/.test(docs) && /stream-json/.test(docs) && /total_cost_usd/.test(docs) && /incompatible_version/.test(docs) && /claude-code-projects-jsonl\/v1/.test(docs),
    'docs/claude-session-provider.md documents the interface, failures, usage, and store format');

  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll Claude session provider checks passed.');
}

// The second process: nothing in memory from the first. The provider is
// registered again for the Agent's runtime connection; every reference and
// provider turn comes from the database and the provider state directory.
async function restart() {
  const ids = JSON.parse(process.env.NOT506_IDS);
  register(ids.laptop);
  const devId = ids.dev;
  console.log('observe a turn started before the restart');
  const pending = await ps.observeProviderTurn(db, devId, ids.pending);
  assert(pending.state === 'completed' && pending.output === 'fake claude: Summarize before the restart' && pending.usage.total_cost_usd === 0.0123,
    'the pre-restart turn is observed to its result and reported cost');

  console.log('resume past sessions read-only, then one workspace_write turn');
  const readOnly = await ps.sendProviderTurn(db, devId, ids.a2, { prompt: 'Recap the spike', authority: 'read_only', idempotencyKey: 'post-ro', requester: owner });
  const ro = await ps.observeProviderTurn(db, devId, readOnly.turn.turn_ref);
  const roCall = calls().pop();
  assert(ro.state === 'completed' && ro.session_ref === ids.a2 && argOf(roCall, '--resume') === ID.a2 && argOf(roCall, '--permission-mode') === 'dontAsk',
    'the archived past session resumes read-only by its exact id');
  const writeTurn = await ps.sendProviderTurn(db, devId, ids.a1, { prompt: 'Apply the fix', authority: 'workspace_write', idempotencyKey: 'post-w', requester: owner });
  const w = await ps.observeProviderTurn(db, devId, writeTurn.turn.turn_ref);
  const wCall = calls().pop();
  assert(w.state === 'completed' && argOf(wCall, '--resume') === ID.a1 && argOf(wCall, '--permission-mode') === 'acceptEdits', 'an explicit workspace_write turn resumes with edit authority');
  const transcript = await ps.readProviderTranscript(db, devId, ids.a1, { cursor: '6', limit: 25 });
  assert(transcript.entries.some(e => e.text === 'Summarize before the restart') && transcript.entries.some(e => e.text === 'fake claude: Apply the fix'),
    'the turns are appended to the same native transcript');

  console.log('start in an allowed workspace; cancel a turn started before the restart');
  const fresh = await ps.startProviderSession(db, devId, { workspace: path.join(WS, 'alpha/new2'), prompt: 'New work', authority: 'workspace_write', idempotencyKey: 'post-start', requester: owner });
  assert((await ps.observeProviderTurn(db, devId, fresh.turn.turn_ref)).state === 'completed', 'a new session starts in an allowed workspace');
  const cancelled = await ps.cancelProviderTurn(db, devId, ids.hold);
  const again = await ps.cancelProviderTurn(db, devId, ids.hold);
  assert(cancelled.outcome === 'cancelled' && cancelled.turn.state === 'cancelled' && again.outcome === 'already_terminal', 'the pre-restart held turn is cancelled from its persisted process record');
  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls })}`);
  process.exit(failures > 0 ? 1 : 0);
}
