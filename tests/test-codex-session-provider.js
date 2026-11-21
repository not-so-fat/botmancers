#!/usr/bin/env node
// NOT-504: the direct Codex SessionProvider (lib/codex-session-provider)
// over the app-server protocol, driven end to end through the
// provider-session registry (lib/provider-sessions) against a fake `codex`
// binary (tests/support/fake-codex.js) that speaks the app-server JSON-RPC
// subset and the `codex exec --json` stream. No Agent Deck, no network.
// Proves: the installed-version probe and its structured failures
// (unavailable, unsupported, auth_required); scoped, idempotent discovery of
// pre-existing threads with title/cwd/timestamps/archived/busy/missing/
// resumable facts and no thread id exposed; transcript reads (paginated and
// legacy turn history); start in an explicit workspace and resume of an exact
// thread with read-only and workspace-write authority (exact request
// payloads); approval requests declined; observe/cancel; usage
// normalization (cost null); restart reattachment with no duplicate turn; and
// the capability-gated `codex exec` fallback.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = require('./support/repo-root');
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT504_TAG || `${process.pid}`;
const TMP = path.join(fs.realpathSync(os.tmpdir()), `botmancers-codex-provider-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
const STATE = {
  main: path.join(TMP, 'codex-main.json'),
  exec: path.join(TMP, 'codex-exec.json'),
  signedOut: path.join(TMP, 'codex-signed-out.json'),
  old: path.join(TMP, 'codex-old.json'),
};
const WORK = path.join(TMP, 'work');
const ALPHA = path.join(WORK, 'alpha');
const BETA = path.join(WORK, 'beta');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const dir of [ALPHA, path.join(ALPHA, 'parser'), path.join(ALPHA, 'new'), path.join(ALPHA, 'exec'), BETA]) fs.mkdirSync(dir, { recursive: true });
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const catalog = jiti('../lib/session-catalog.ts');
const codex = jiti('../lib/codex-session-provider.ts');
const usage = jiti('../lib/codex-usage.ts');
const { seedFakeCodex, FAKE_CODEX } = require('./support/fake-codex');

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
const SECRET = /SECRET/;
const owner = { kind: 'person', id: 'local-owner' };
const correlation = { requestId: null };
const loadState = statePath => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const calls = (statePath, method) => loadState(statePath).calls.filter(call => call.method === method);
const lastCall = (statePath, method) => calls(statePath, method).pop();
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

const runtimes = [];
function runtime(statePath, options = {}) {
  const rt = new codex.CodexRuntime({
    command: [process.execPath, FAKE_CODEX], env: { ...process.env, FAKE_CODEX_STATE: statePath },
    runsDir: path.join(TMP, 'runs'), requestTimeoutMs: 10_000, ...options,
  });
  runtimes.push(rt);
  return rt;
}
function shutdownAll() {
  for (const rt of runtimes.splice(0)) rt.shutdown();
}

function register(ids) {
  contract.clearSessionProviders({ builtins: true });
  const main = runtime(STATE.main);
  contract.registerSessionProvider({ connectionId: ids.main }, () => codex.createCodexSessionProvider(main));
  const exec = runtime(STATE.exec);
  contract.registerSessionProvider({ connectionId: ids.exec }, () => codex.createCodexSessionProvider(exec));
  const noFallback = runtime(STATE.exec, { execFallback: false });
  contract.registerSessionProvider({ connectionId: ids.noFallback }, () => codex.createCodexSessionProvider(noFallback));
  const signedOut = runtime(STATE.signedOut);
  contract.registerSessionProvider({ connectionId: ids.signedOut }, () => codex.createCodexSessionProvider(signedOut));
  return { main, exec, noFallback, signedOut };
}

function agent(name, connectionId, scope, policy) {
  return dbModule.bots.create({
    name, title: 'Codex', description: 'Direct Codex', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: scope.kind, session_scope_items: JSON.stringify(scope.items ?? []),
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0, allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
}

async function syncAll(agentId, now) {
  const all = { imported: [], updated: [], rejected_out_of_scope: 0, pages: 0 };
  let cursor = null;
  do {
    const page = await ps.syncAgentSessions(db, agentId, { cursor, now });
    all.imported.push(...page.imported);
    all.updated.push(...page.updated);
    all.rejected_out_of_scope += page.rejected_out_of_scope;
    all.pages++;
    cursor = page.next_cursor;
  } while (cursor && all.pages < 20);
  return all;
}

const refOf = (agentId, threadId) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(agentId, threadId)?.id;
const rowOf = ref => db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(ref);
const turnRow = turnRef => db.prepare('SELECT * FROM provider_session_turns WHERE id = ?').get(turnRef);
const usageOf = turnRef => {
  const event = db.prepare("SELECT detail FROM provider_session_events WHERE turn_id = ? AND type LIKE 'turn_%' AND type != 'turn_started'").get(turnRef);
  return event ? JSON.parse(event.detail || '{}').usage ?? null : undefined;
};

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  shutdownAll();
  process.exit(1);
}

async function main() {
  console.log('\nUsage normalization from structured events (fixtures adapted from Agent Dealer)');
  const fixture = name => usage.parseCodexJsonl(fs.readFileSync(path.join(ROOT, 'tests/support/codex-fixtures', name), 'utf8'));
  const cached = usage.execRunFacts(fixture('turn-completed-cached.jsonl'));
  assert(JSON.stringify(cached.usage) === JSON.stringify({ input_tokens: 24763, output_tokens: 122, cached_input_tokens: 24448, cost_usd: null })
    && cached.terminal === 'completed' && cached.output === 'The parser lives in src/parse.ts.' && cached.thread_id === '0199a213-81c0-7800-8aa1-bbab2a035a53',
  'turn.completed usage maps input/output tokens, cached input stays a subset, cost null');
  const noUsage = usage.execRunFacts(fixture('turn-completed-no-usage.jsonl'));
  assert(noUsage.terminal === 'completed' && noUsage.usage === null, 'a turn.completed without usage yields no usage sample (not zeros)');
  const malformed = usage.execRunFacts(fixture('turn-completed-malformed.jsonl'));
  assert(malformed.terminal === 'completed' && malformed.usage === null && malformed.output === null, 'malformed lines are skipped; non-numeric or negative counts are not usage');
  const failed = usage.execRunFacts(fixture('turn-failed.jsonl'));
  assert(failed.terminal === 'failed' && failed.error === 'stream disconnected before completion' && failed.usage === null, 'turn.failed is a terminal failure with its message');
  assert(JSON.stringify(usage.addUsage(usage.usageFromBreakdown({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }), usage.usageFromBreakdown({ inputTokens: 5, outputTokens: 1 })))
    === JSON.stringify({ input_tokens: 15, output_tokens: 3, cached_input_tokens: 4, cost_usd: null }) && usage.usageFromBreakdown('x') === null,
  'app-server tokenUsage breakdowns sum per turn; a malformed breakdown is ignored');

  console.log('\nInstalled-version probe and structured failures');
  seedFakeCodex(STATE.main, [
    { id: 'thr-parser-SECRET', cwd: path.join(ALPHA, 'parser'), name: 'Refactor the parser', turns: [['Refactor the parser', 'Plan ready'], ['Go ahead', 'Done']] },
    { id: 'thr-archived-SECRET', cwd: ALPHA, preview: 'Archived spike', archived: true, turns: [['Archived spike', 'ok']] },
    { id: 'thr-moved-SECRET', cwd: path.join(ALPHA, 'moved-away'), name: 'Moved repo', turns: [['old', 'old reply']] },
    { id: 'thr-legacy-SECRET', cwd: ALPHA, name: 'Legacy history', legacy: true, turns: [['legacy q', 'legacy a']] },
    { id: 'thr-doomed-SECRET', cwd: ALPHA, name: 'Soon deleted', turns: [['x', 'y']] },
    { id: 'thr-beta-SECRET', cwd: BETA, name: 'Outside work', turns: [['beta', 'beta']] },
    { id: 'thr-sub-SECRET', cwd: ALPHA, name: 'Sub-agent thread', source: 'subAgent', turns: [['sub', 'sub']] },
  ]);
  seedFakeCodex(STATE.exec, [], { missingMethods: ['thread/start', 'thread/resume', 'turn/start'] });
  seedFakeCodex(STATE.signedOut, [], { signedIn: false });
  seedFakeCodex(STATE.old, [], { missingMethods: ['thread/list'] });

  const probeRt = runtime(STATE.main);
  assert((await probeRt.ready()).ok && probeRt.probe.cli_version === '0.157.1' && Object.values(probeRt.probe.methods).every(Boolean),
    'a current Codex is ready: CLI version read, every app-server method detected');
  const caps = probeRt.capabilities();
  assert(caps.list && caps.search && caps.read && caps.resume && caps.start && caps.cancel && caps.usage && caps.authorities.join() === 'read_only,workspace_write,full_access',
    'capabilities reflect the probe');
  assert(JSON.stringify(probeRt.selection()) === JSON.stringify({ start: 'app-server', resume: 'app-server' }), 'start and resume select the app-server');
  const probeCalls = loadState(STATE.main).calls;
  assert(probeCalls[0].method === 'initialize' && probeCalls[0].params.clientInfo.name === 'botmancers' && probeCalls[1].method === 'initialized'
    && probeCalls.some(c => c.method === 'account/read') && probeCalls.some(c => c.method === 'turn/start' && c.params.threadId === 0),
  'the probe is initialize, initialized, one ill-typed request per method, and account/read');
  assert(loadState(STATE.main).threads['thr-parser-SECRET'].turns.length === 2 && !probeCalls.some(c => c.method === 'exec'), 'probing ran nothing');
  probeRt.shutdown();

  const missing = runtime(STATE.main, { command: [path.join(TMP, 'no-such-codex')] });
  const missingReady = await missing.ready();
  assert(!missingReady.ok && missingReady.error.code === 'unavailable', 'no codex binary is unavailable');
  const signedOutReady = await runtime(STATE.signedOut).ready();
  assert(!signedOutReady.ok && signedOutReady.error.code === 'auth_required', 'a signed-out Codex is auth_required');
  const old = runtime(STATE.old);
  const oldReady = await old.ready();
  assert(!oldReady.ok && oldReady.error.code === 'unsupported' && old.capabilities().list === false, 'a Codex without thread/list is unsupported (no terminal fallback)');
  shutdownAll();

  console.log('\nRegistry: direct Codex Agents, no Agent Deck');
  const { runtimeConnections } = dbModule;
  const ids = {
    main: runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' }).id,
    exec: runtimeConnections.create({ provider: 'codex', label: 'Codex (exec only)', host: 'This computer' }).id,
    noFallback: runtimeConnections.create({ provider: 'codex', label: 'Codex (no fallback)', host: 'This computer' }).id,
    signedOut: runtimeConnections.create({ provider: 'codex', label: 'Codex (signed out)', host: 'This computer' }).id,
  };
  // The default provider is installed for every 'codex' connection.
  assert(contract.sessionProviderFor({ id: ids.main, provider: 'codex' })?.kind === codex.CODEX_PROVIDER_KIND, 'a codex runtime connection gets the direct Codex provider by default');
  const rts = register(ids);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const dev = agent('Dev', ids.main, { kind: 'workspaces', items: [ALPHA] }, write);
  const reader = agent('Reader', ids.main, { kind: 'all_provider_sessions' }, { mode: 'read_only', newSessions: false });
  const execDev = agent('ExecDev', ids.exec, { kind: 'workspaces', items: [ALPHA] }, write);
  const noFallback = agent('NoFallback', ids.noFallback, { kind: 'workspaces', items: [ALPHA] }, write);
  const signedOut = agent('SignedOut', ids.signedOut, { kind: 'all_provider_sessions' }, write);
  await rejects(ps.syncAgentSessions(db, signedOut.id), 'auth_required', 'discovery on a signed-out Codex is refused as auth_required');

  console.log('\nDiscovery: scoped, idempotent, recognizable');
  const first = await syncAll(dev.id, 1000);
  const listCalls = calls(STATE.main, 'thread/list').filter(c => typeof c.params.limit === 'number');
  assert(first.imported.length === 5 && first.rejected_out_of_scope === 0, 'five pre-existing in-scope threads imported (beta and sub-agent threads are not)');
  assert(listCalls.some(c => c.params.archived === false) && listCalls.some(c => c.params.archived === true)
    && listCalls.every(c => JSON.stringify(c.params.sourceKinds) === JSON.stringify(['cli', 'vscode', 'exec', 'appServer']) && c.params.limit <= 25),
  'thread/list is asked for open then archived threads, interactive and headless sources, bounded pages');
  const parserRef = refOf(dev.id, 'thr-parser-SECRET');
  const parser = rowOf(parserRef);
  const seeded = loadState(STATE.main).threads['thr-parser-SECRET'];
  assert(parser.title === 'Refactor the parser' && parser.workspace === path.join(ALPHA, 'parser') && parser.lifecycle === 'open' && parser.resumable === 1 && parser.busy === 0
    && parser.provider_created_at === seeded.createdAt * 1000 && parser.provider_updated_at === seeded.updatedAt * 1000,
  'title, cwd, timestamps (seconds to ms), open, idle, resumable are mapped');
  const archived = rowOf(refOf(dev.id, 'thr-archived-SECRET'));
  assert(archived.lifecycle === 'archived' && archived.resumable === 1 && archived.title === 'Archived spike', 'an archived thread is archived, still resumable, titled by its preview');
  const moved = rowOf(refOf(dev.id, 'thr-moved-SECRET'));
  assert(moved.availability === 'available' && moved.resumable === 0, 'a thread whose workspace moved away is not resumable');
  assert(refOf(dev.id, 'thr-beta-SECRET') === undefined && refOf(dev.id, 'thr-sub-SECRET') === undefined, 'out-of-scope and sub-agent threads are never stored');
  const again = await syncAll(dev.id, 2000);
  assert(again.imported.length === 0 && again.updated.length === 5 && count('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?', dev.id) === 5,
    're-sync imports nothing twice');
  const readerSync = await syncAll(reader.id, 2100);
  assert(readerSync.imported.length === 6 && refOf(reader.id, 'thr-beta-SECRET') !== undefined, 'an all-provider-sessions scope also imports the beta thread');
  const search = await ps.syncAgentSessions(db, dev.id, { query: 'parser', now: 2200 });
  assert(search.updated.length === 1 && lastCall(STATE.main, 'thread/list').params.searchTerm === 'parser', 'search passes searchTerm to thread/list');
  const list = catalog.listAgentSessions(db, dev.id, 'all');
  assert(list.length === 5 && !SECRET.test(JSON.stringify(list)) && !SECRET.test(JSON.stringify(catalog.getAgentSession(db, dev.id, parserRef))),
    'the catalog lists every imported thread under a Botmancers reference; no thread id');

  console.log('\nRead a thread through its Botmancers reference');
  const transcript = await ps.readProviderTranscript(db, dev.id, parserRef, { limit: 10 });
  assert(transcript.entries.map(e => `${e.role}:${e.text}`).join('|') === 'user:Refactor the parser|assistant:Plan ready|user:Go ahead|assistant:Done'
    && transcript.session_ref === parserRef && lastCall(STATE.main, 'thread/items/list').params.threadId === 'thr-parser-SECRET',
  'thread/items/list history becomes user/assistant entries (reasoning omitted)');
  const legacy = await ps.readProviderTranscript(db, dev.id, refOf(dev.id, 'thr-legacy-SECRET'), { limit: 10 });
  assert(legacy.entries.map(e => e.text).join('|') === 'legacy q|legacy a' && lastCall(STATE.main, 'thread/turns/list').params.itemsView === 'full',
    'a thread without paginated history is read by turns');

  console.log('\nStart in an explicit allowed workspace (workspace-write)');
  await rejects(ps.startProviderSession(db, dev.id, { workspace: BETA, prompt: 'x', authority: 'read_only', idempotencyKey: 's0', requester: owner }), 'out_of_scope',
    'a workspace outside the scope is refused');
  const newWs = path.join(ALPHA, 'new');
  const started = await ps.startProviderSession(db, dev.id, {
    workspace: newWs, prompt: 'Scaffold the module', authority: 'workspace_write', idempotencyKey: 's1', requester: owner, correlation: { requestId: 'corr-start' },
  });
  const threadStart = lastCall(STATE.main, 'thread/start').params;
  const turnStart = lastCall(STATE.main, 'turn/start').params;
  assert(threadStart.cwd === newWs && threadStart.sandbox === 'workspace-write' && threadStart.approvalPolicy === 'never' && threadStart.ephemeral === false,
    'thread/start carries the explicit cwd, the workspace-write sandbox, approvalPolicy never');
  assert(turnStart.cwd === newWs && turnStart.sandboxPolicy.type === 'workspaceWrite' && JSON.stringify(turnStart.sandboxPolicy.writableRoots) === JSON.stringify([newWs])
    && turnStart.sandboxPolicy.networkAccess === false && turnStart.approvalPolicy === 'never' && /^bm-[0-9a-f]{32}$/.test(turnStart.clientUserMessageId)
    && turnStart.input[0].text === 'Scaffold the module', 'turn/start carries the prompt, cwd, writable root = workspace, and the hashed idempotency key');
  const startedDone = await ps.observeProviderTurn(db, dev.id, started.turn.turn_ref);
  assert(startedDone.state === 'completed' && startedDone.output === 'codex reply: Scaffold the module' && rowOf(started.turn.session_ref).workspace === newWs,
    'the turn completes with Codex\'s final answer in a new registered session');
  assert(JSON.stringify(usageOf(started.turn.turn_ref)) === JSON.stringify({ input_tokens: 150, output_tokens: 12, cached_input_tokens: 90, cost_usd: null }),
    'usage is the sum of the turn\'s tokenUsage `last` breakdowns; cost stays null');
  assert(JSON.parse(turnRow(started.turn.turn_ref).correlation).requestId === 'corr-start', 'the correlation id is recorded with the turn');
  const replay = await ps.startProviderSession(db, dev.id, {
    workspace: newWs, prompt: 'Scaffold the module', authority: 'workspace_write', idempotencyKey: 's1', requester: owner, correlation: { requestId: 'corr-start' },
  });
  assert(replay.replayed && calls(STATE.main, 'thread/start').filter(c => typeof c.params.cwd === 'string').length === 1, 'a replayed start starts no second thread');

  console.log('\nResume an exact pre-existing thread (read-only)');
  const resumed = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: 'Where is the parser?', authority: 'read_only', idempotencyKey: 'r1', requester: owner });
  const resume = lastCall(STATE.main, 'thread/resume').params;
  const resumeTurn = lastCall(STATE.main, 'turn/start').params;
  assert(resume.threadId === 'thr-parser-SECRET' && resume.sandbox === 'read-only' && resume.approvalPolicy === 'never',
    'thread/resume names the exact thread with the read-only sandbox');
  assert(resumeTurn.threadId === 'thr-parser-SECRET' && resumeTurn.cwd === path.join(ALPHA, 'parser') && JSON.stringify(resumeTurn.sandboxPolicy) === JSON.stringify({ type: 'readOnly', networkAccess: false }),
    'turn/start continues that thread in its own cwd under a read-only sandbox policy');
  const resumedDone = await ps.observeProviderTurn(db, dev.id, resumed.turn.turn_ref);
  assert(resumedDone.state === 'completed' && resumedDone.session_ref === parserRef && loadState(STATE.main).threads['thr-parser-SECRET'].turns.length === 3,
    'the turn is appended to the same Codex thread');
  const writeResume = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: 'Fix it', authority: 'workspace_write', idempotencyKey: 'r2', requester: owner });
  assert(lastCall(STATE.main, 'thread/resume').params.sandbox === 'workspace-write' && lastCall(STATE.main, 'turn/start').params.sandboxPolicy.type === 'workspaceWrite'
    && (await ps.observeProviderTurn(db, dev.id, writeResume.turn.turn_ref)).state === 'completed', 'an approved workspace-write resume runs with the workspace-write sandbox');
  const fullTurn = await ps.sendProviderTurn(db, reader.id, refOf(reader.id, 'thr-parser-SECRET'), { prompt: 'curl it', authority: 'full_access', idempotencyKey: 'r-full', requester: owner });
  const fullPolicy = lastCall(STATE.main, 'turn/start').params.sandboxPolicy;
  assert(lastCall(STATE.main, 'thread/resume').params.sandbox === 'workspace-write' && fullPolicy.type === 'workspaceWrite' && fullPolicy.networkAccess === true
    && (await ps.observeProviderTurn(db, reader.id, fullTurn.turn.turn_ref)).state === 'completed',
    'a full_access turn (granted by an owner share, not the Agent policy) runs workspace-write with network access on, even for a read-only Agent');
  await rejects(ps.sendProviderTurn(db, reader.id, refOf(reader.id, 'thr-parser-SECRET'), { prompt: 'x', authority: 'workspace_write', idempotencyKey: 'r3', requester: owner }),
    'authority_not_allowed', 'a read-only Agent cannot resume with write authority');
  const archivedTurn = await ps.sendProviderTurn(db, dev.id, archived.id, { prompt: 'Revive', authority: 'read_only', idempotencyKey: 'r4', requester: owner });
  assert((await ps.observeProviderTurn(db, dev.id, archivedTurn.turn.turn_ref)).state === 'completed', 'an archived thread Codex accepts is resumed');
  const resumesBefore = calls(STATE.main, 'thread/resume').length;
  await rejects(ps.sendProviderTurn(db, dev.id, moved.id, { prompt: 'x', authority: 'read_only', idempotencyKey: 'r5', requester: owner }), 'not_resumable',
    'a thread whose workspace moved is not resumed');
  assert(calls(STATE.main, 'thread/resume').length === resumesBefore, 'Codex was not asked to resume it');

  console.log('\nApprovals, failures, missing usage');
  const approval = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: '[approval] clean build', authority: 'workspace_write', idempotencyKey: 'a1', requester: owner });
  assert((await ps.observeProviderTurn(db, dev.id, approval.turn.turn_ref)).state === 'completed'
    && lastCall(STATE.main, 'serverRequest/response').params.response.decision === 'decline', 'a command approval request is declined (authority is never widened)');
  const failing = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: '[fail] please', authority: 'read_only', idempotencyKey: 'f1', requester: owner });
  const failedTurn = await ps.observeProviderTurn(db, dev.id, failing.turn.turn_ref);
  assert(failedTurn.state === 'failed' && failedTurn.failure_code === 'codex_turn_failed', 'a failed Codex turn is failed');
  const quiet = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: '[nousage] hi', authority: 'read_only', idempotencyKey: 'n1', requester: owner });
  assert((await ps.observeProviderTurn(db, dev.id, quiet.turn.turn_ref)).state === 'completed' && usageOf(quiet.turn.turn_ref) === null,
    'a turn without reported usage records no usage sample');

  console.log('\nObserve with a deadline and cancel');
  const held = await ps.sendProviderTurn(db, dev.id, parserRef, { prompt: '[hold] long', authority: 'read_only', idempotencyKey: 'h1', requester: owner });
  assert(rowOf(parserRef).busy === 1, 'the session is busy while the turn runs');
  await rejects(ps.sendProviderTurn(db, dev.id, parserRef, { prompt: 'x', authority: 'read_only', idempotencyKey: 'h1b', requester: owner }), 'busy', 'a second turn is refused as busy');
  assert((await ps.observeProviderTurn(db, dev.id, held.turn.turn_ref, { deadlineAt: Date.now() + 50 })).state === 'running', 'a deadline ends the wait; the turn keeps running');
  const heldTurnId = loadState(STATE.main).threads['thr-parser-SECRET'].turns.at(-1).id;
  const cancel1 = await ps.cancelProviderTurn(db, dev.id, held.turn.turn_ref);
  const cancel2 = await ps.cancelProviderTurn(db, dev.id, held.turn.turn_ref);
  const interrupts = calls(STATE.main, 'turn/interrupt').filter(c => typeof c.params.threadId === 'string');
  assert(cancel1.outcome === 'cancelled' && cancel1.turn.state === 'cancelled' && cancel2.outcome === 'already_terminal' && interrupts.length === 1
    && interrupts[0].params.threadId === 'thr-parser-SECRET' && interrupts[0].params.turnId === heldTurnId,
  'cancel sends one turn/interrupt for the exact thread and turn; a repeat is already_terminal');
  assert(loadState(STATE.main).threads['thr-parser-SECRET'].turns.at(-1).status === 'interrupted' && rowOf(parserRef).busy === 0, 'Codex reports the turn interrupted; the session is idle');

  console.log('\nMissing threads stay, with explicit availability');
  const doomedRef = refOf(dev.id, 'thr-doomed-SECRET');
  const st = loadState(STATE.main);
  st.threads['thr-doomed-SECRET'].deleted = true;
  fs.writeFileSync(STATE.main, JSON.stringify(st, null, 2));
  assert((await ps.refreshProviderSession(db, dev.id, doomedRef)).availability === 'missing' && rowOf(doomedRef) !== undefined, 'a thread Codex no longer has is missing, not deleted');
  await rejects(ps.sendProviderTurn(db, dev.id, doomedRef, { prompt: 'x', authority: 'read_only', idempotencyKey: 'm1', requester: owner }), 'session_missing',
    'a missing thread is not resumed');

  console.log('\nExec fallback (capability-gated)');
  await rts.exec.ready();
  assert(JSON.stringify(rts.exec.selection()) === JSON.stringify({ start: 'exec', resume: 'exec' }) && rts.exec.capabilities().cancel,
    'an app-server without thread/start, thread/resume, turn/start selects `codex exec` for start and resume');
  await rts.noFallback.ready();
  assert(!rts.noFallback.capabilities().start && !rts.noFallback.capabilities().resume, 'with the fallback disabled, start and resume are unsupported');
  await rejects(ps.startProviderSession(db, noFallback.id, { workspace: ALPHA, prompt: 'x', authority: 'read_only', idempotencyKey: 'nf', requester: owner }), 'unsupported',
    'the registry refuses start as unsupported');
  const execWs = path.join(ALPHA, 'exec');
  const execStart = await ps.startProviderSession(db, execDev.id, { workspace: execWs, prompt: 'Explain the build', authority: 'read_only', idempotencyKey: 'e1', requester: owner });
  const execCall = lastCall(STATE.exec, 'exec').params;
  assert(execCall.args[0] === 'exec' && execCall.args.includes('--json') && execCall.args[execCall.args.indexOf('-C') + 1] === execWs && execCall.cwd === execWs
    && execCall.args.includes('sandbox_mode="read-only"') && execCall.args.includes('approval_policy="never"') && execCall.prompt === 'Explain the build',
  'codex exec --json runs in the explicit cwd with the read-only sandbox and the prompt on stdin');
  const execDone = await ps.observeProviderTurn(db, execDev.id, execStart.turn.turn_ref);
  assert(execDone.state === 'completed' && execDone.output === 'codex exec reply: Explain the build'
    && JSON.stringify(usageOf(execStart.turn.turn_ref)) === JSON.stringify({ input_tokens: 120, output_tokens: 9, cached_input_tokens: 20, cost_usd: null }),
  'the exec run completes from its structured events (malformed line skipped), usage from turn.completed');
  const execThread = rowOf(execStart.turn.session_ref).provider_session_id;
  assert(loadState(STATE.exec).threads[execThread]?.source === 'exec', 'the session reference holds the Codex thread id from thread.started (one identity model)');
  const execResume = await ps.sendProviderTurn(db, execDev.id, execStart.turn.session_ref, { prompt: 'And tests?', authority: 'workspace_write', idempotencyKey: 'e2', requester: owner });
  const execResumed = await ps.observeProviderTurn(db, execDev.id, execResume.turn.turn_ref);
  const resumeArgs = lastCall(STATE.exec, 'exec').params.args;
  assert(resumeArgs[0] === 'exec' && resumeArgs[1] === 'resume' && resumeArgs.includes('--json') && resumeArgs.includes(execThread)
    && resumeArgs.includes('sandbox_mode="workspace-write"') && execResumed.state === 'completed' && execResumed.output === 'codex exec reply: And tests?',
  'resume runs `codex exec resume --json` on the exact thread with the requested sandbox');
  const execHeld = await ps.sendProviderTurn(db, execDev.id, execStart.turn.session_ref, { prompt: '[hold] wait', authority: 'read_only', idempotencyKey: 'e3', requester: owner });

  console.log('\nBefore the restart: one finished-but-unobserved turn, one in flight');
  const unobserved = await ps.sendProviderTurn(db, dev.id, archived.id, { prompt: 'Finish while nobody watches', authority: 'read_only', idempotencyKey: 'pre-1', requester: owner });
  const legacyRef = refOf(dev.id, 'thr-legacy-SECRET');
  const inFlight = await ps.sendProviderTurn(db, dev.id, legacyRef, { prompt: '[hold] across restart', authority: 'read_only', idempotencyKey: 'pre-2', requester: owner });
  await new Promise(resolve => setTimeout(resolve, 200));
  const turnStartsBefore = calls(STATE.main, 'turn/start').filter(c => typeof c.params.threadId === 'string').length;
  // Botmancers exits: its app-server child goes with it.
  shutdownAll();
  await new Promise(resolve => setTimeout(resolve, 200));

  console.log('\nRestart: a second Botmancers process on the same database');
  const child = spawnSync(process.execPath, [__filename, 'restart'], {
    env: {
      ...process.env, NOT504_TAG: TAG,
      NOT504_IDS: JSON.stringify({
        ...ids, dev: dev.id, execDev: execDev.id, parserRef, legacyRef, unobserved: unobserved.turn.turn_ref, inFlight: inFlight.turn.turn_ref,
        execHeld: execHeld.turn.turn_ref, turnStartsBefore, inFlightKey: turnRow(inFlight.turn.turn_ref).provider_turn_id ? 'pre-2' : null,
      }),
    },
    encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(child.stdout.split('\n').filter(line => !line.startsWith('RESULT ')).map(line => (line ? `  [restart] ${line}\n` : '')).join(''));
  if (child.status !== 0) process.stdout.write(child.stderr);
  const resultLine = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice(7)) : null;
  assert(child.status === 0 && result && result.failures === 0, 'the restarted process reattached, resumed, and cancelled');
  assert(result && result.fetchCalls === 0 && fetchCalls === 0, 'no network call (no Agent Deck) in either process');

  console.log('\nNo thread or turn id in any normal view');
  const views = JSON.stringify([catalog.listAgentSessions(db, dev.id, 'all'), catalog.listAgentSessions(db, execDev.id, 'all'),
    ps.listProviderTurns(db, dev.id, parserRef), ps.listProviderTurns(db, execDev.id, execStart.turn.session_ref), transcript, legacy]);
  assert(!SECRET.test(views) && !views.includes(execThread), 'catalog, turn, and transcript views never carry a Codex id');
  assert(!SECRET.test(JSON.stringify(db.prepare('SELECT * FROM provider_session_events').all())), 'audit events never name a Codex id');

  console.log('\nDocumentation contract');
  const doc = fs.readFileSync(path.join(ROOT, 'docs/integrations/codex-direct.md'), 'utf8');
  assert(/app-server/.test(doc) && /codex exec resume/.test(doc) && /auth_required/.test(doc) && /cost/.test(doc) && /restart/i.test(doc),
    'docs/integrations/codex-direct.md documents the protocol, fallback, failures, usage, and restart');

  shutdownAll();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll direct Codex provider checks passed.');
}

// The second process: no app-server, no tracker, no idempotency map from the
// first. Every reference comes from the database; turn state from Codex.
async function restart() {
  const ids = JSON.parse(process.env.NOT504_IDS);
  const rts = register(ids);
  console.log('reattach to turns started before the restart');
  const unobserved = await ps.observeProviderTurn(db, ids.dev, ids.unobserved);
  assert(unobserved.state === 'completed' && unobserved.output === 'codex reply: Finish while nobody watches', 'a turn that finished during the restart is read from Codex history');
  const inFlight = await ps.observeProviderTurn(db, ids.dev, ids.inFlight);
  assert(inFlight.state === 'failed' && inFlight.failure_code === 'interrupted', 'a turn whose app-server exited is terminal (interrupted), never re-run');
  const execHeld = await ps.cancelProviderTurn(db, ids.execDev, ids.execHeld);
  assert(execHeld.outcome === 'cancelled' && execHeld.turn.state === 'cancelled', 'an exec fallback run outlives the restart and is cancelled by its durable handle');

  console.log('no duplicate turn for a repeated key');
  const provider = codex.createCodexSessionProvider(rts.main);
  const key = db.prepare('SELECT provider_turn_id FROM provider_session_turns WHERE id = ?').get(ids.inFlight).provider_turn_id;
  // Botmancers' own replay: the same request key returns the recorded turn.
  const replay = await ps.sendProviderTurn(db, ids.dev, ids.legacyRef, { prompt: '[hold] across restart', authority: 'read_only', idempotencyKey: 'pre-2', requester: owner });
  assert(replay.replayed && replay.turn.turn_ref === ids.inFlight, 'the registry replays the recorded turn');
  // The provider's own guard: a key Codex already holds (as the user
  // message clientId) maps back to that turn instead of starting another.
  const turnStart = calls(STATE.main, 'turn/start').filter(c => typeof c.params.threadId === 'string');
  const providerKey = turnStart.find(c => c.params.threadId === 'thr-legacy-SECRET').params.clientUserMessageId;
  const again = await provider.sendTurn({ provider_session_id: 'thr-legacy-SECRET', prompt: '[hold] across restart', authority: 'read_only', idempotency_key: providerKey, correlation });
  assert(again.ok && again.value.provider_turn_id === key, 'a fresh provider finds the keyed turn in Codex history');
  assert(calls(STATE.main, 'turn/start').filter(c => typeof c.params.threadId === 'string').length === ids.turnStartsBefore, 'no turn/start was sent after the restart');

  console.log('resume the pre-existing thread after the restart');
  const resumed = await ps.sendProviderTurn(db, ids.dev, ids.parserRef, { prompt: 'Still there?', authority: 'read_only', idempotencyKey: 'post-1', requester: owner });
  const done = await ps.observeProviderTurn(db, ids.dev, resumed.turn.turn_ref);
  assert(done.state === 'completed' && done.session_ref === ids.parserRef && lastCall(STATE.main, 'turn/start').params.threadId === 'thr-parser-SECRET',
    'the same Botmancers reference resumes the same Codex thread');
  const held = await ps.sendProviderTurn(db, ids.dev, ids.parserRef, { prompt: '[hold] post', authority: 'read_only', idempotencyKey: 'post-2', requester: owner });
  const controller = new AbortController();
  const watching = ps.observeProviderTurn(db, ids.dev, held.turn.turn_ref, { signal: controller.signal });
  const cancelled = await ps.cancelProviderTurn(db, ids.dev, held.turn.turn_ref);
  controller.abort();
  assert(cancelled.outcome === 'cancelled' && (await watching).state === 'cancelled', 'an observer sees the cancel as its terminal result');
  assert(!SECRET.test(JSON.stringify([unobserved, inFlight, execHeld, replay, done, held, cancelled])), 'no Codex id in any turn view');
  shutdownAll();
  console.log(`RESULT ${JSON.stringify({ failures, fetchCalls })}`);
  process.exit(failures > 0 ? 1 : 0);
}
