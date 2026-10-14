#!/usr/bin/env node
// NOT-468 PoC harness: Botmancers restart reconciliation against a real
// Agent Deck run API. Disposable and investigation-only: it drives the
// unmodified Botmancers libraries (canonical startAgentDispatch -> runTurn ->
// Agent Deck API Attempt adapter) on an isolated SQLite file, and each
// invocation is one Botmancers process lifetime. A crash point SIGKILLs the
// process at an exact HTTP boundary, so the next invocation is a real
// restart from durable state only.
//
// Nothing here is production code. The reconcile/reattach commands are the
// prototype dispatcher behaviors whose evidence feeds the decision record
// (docs/evidence/NOT-468/decision-record.md).
//
// Environment (no credentials are written by this script):
//   POC_DIR               state + transcript directory (default /tmp/not468/poc)
//   POC_AGENT_DECK_URL    Agent Deck server (default http://127.0.0.1:18468)
//   POC_TOKEN_FILE        file holding the run-grant bearer (read, never logged)
//   POC_DECK              deck id the workspace is assigned to
//   POC_WORKSPACE         disposable Git workspace (Agent Deck host path)
//   POC_AGENT_DECK_HOME   optional; host-side run-directory count only
//
// Commands:
//   init
//   launch <scenario> [--crash-at=start-response|started|running|terminal] [--task=<text>]
//   restart <scenario>        Botmancers startup recovery + read-only status/events reconcile
//   reattach <scenario>       idempotent re-POST of the persisted Attempt, observe, persist
//   cancel <scenario>         cancel the persisted run, then mark the Attempt cancelled
//   resume <scenario> <new>   revision that resumes <scenario>'s Session Binding
//   probe <name> [args]       negative probes (unknown-run, foreign-grant, expired-grant, rotated-grant,
//                             unreachable, idempotency-conflict, resume-unknown-session)
//   snapshot <scenario>
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const POC_DIR = process.env.POC_DIR || '/tmp/not468/poc';
fs.mkdirSync(POC_DIR, { recursive: true });
const STATE_FILE = path.join(POC_DIR, 'state.json');
const TRANSCRIPT = path.join(POC_DIR, 'transcript.jsonl');
const AGENT_DECK_URL = process.env.POC_AGENT_DECK_URL || 'http://127.0.0.1:18468';
const DECK = process.env.POC_DECK || '';
const WORKSPACE = process.env.POC_WORKSPACE || '/tmp/not468/ws';

process.env.BOTMANCERS_DB_PATH = path.join(POC_DIR, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
if (process.env.POC_TOKEN_FILE) process.env.AGENT_DECK_RUN_TOKEN = fs.readFileSync(process.env.POC_TOKEN_FILE, 'utf8').trim();

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('../lib/db.ts');
const conv = jiti('../lib/agent-conversations.ts');
const deckApi = jiti('../lib/agent-deck-api.ts');
const deckAttempt = jiti('../lib/agent-deck-attempt.ts');
const settings = jiti('../lib/agent-deck-settings.ts');
const dispatch = jiti('../lib/agent-dispatch.ts');
const executor = jiti('../lib/attempt-executor.ts');
const finalization = jiti('../lib/agent-deck-finalization.ts');
const policyLib = jiti('../lib/execution-policy.ts');
const { engine, bots, conversations, messages } = db;
const raw = db.default;

const [command, ...args] = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.join('=') || true];
}));
const positional = args.filter(a => !a.startsWith('--'));

// ---------------------------------------------------------------- redaction
const HOME = os.homedir();
function short(id) {
  return typeof id === 'string' && id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
function redactText(text) {
  if (typeof text !== 'string') return text;
  const out = text.split(HOME).join('/Users/<owner>');
  return out.length > 240 ? `${out.slice(0, 240)}…(${out.length} chars)` : out;
}
function redactValue(value, key) {
  if (key === 'prompt' && typeof value === 'string') {
    return `<prompt sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)} len:${value.length}>`;
  }
  if ((key === 'sessionId' || key === 'resumeSessionId') && typeof value === 'string') return `<S:${short(value)}>`;
  if (key === 'cwd' && typeof value === 'string') return value.split(HOME).join('/Users/<owner>');
  if (typeof value === 'string') {
    // Session ids also appear inside notice prose.
    let out = redactText(value);
    for (const sid of knownSessions) out = out.split(sid).join(`<S:${short(sid)}>`);
    return out;
  }
  if (Array.isArray(value)) return value.map(v => redactValue(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}
const knownSessions = new Set();
function noteSessions(value) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'sessionId' || k === 'resumeSessionId') && typeof v === 'string') knownSessions.add(v);
    else if (v && typeof v === 'object') noteSessions(v);
  }
}

// --------------------------------------------------------------- transcript
const scenarioName = (command === 'resume' ? positional[1] : positional[0]) || command;
function emit(entry) {
  const line = { at: new Date().toISOString(), pid: process.pid, cmd: command, scenario: scenarioName, ...entry };
  fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`);
  return line;
}
function say(text) {
  process.stdout.write(`${text}\n`);
}
function crash(boundary, detail) {
  emit({ kind: 'crash', boundary, detail });
  say(`!! SIGKILL Botmancers pid ${process.pid} at boundary "${boundary}"${detail ? ` (${detail})` : ''}`);
  process.kill(process.pid, 'SIGKILL');
}

const crashAt = typeof flags['crash-at'] === 'string' ? flags['crash-at'] : null;
let sawStart = false;
let httpCalls = 0;

// Real fetch through Botmancers' own transport seam. Only the method, path,
// idempotency key, redacted body, status, and redacted response are logged;
// the Authorization header is never read.
deckApi.setAgentDeckApiFetch(async (url, init) => {
  const u = new URL(url);
  const p = `${u.pathname}${u.search}`;
  if (crashAt === 'started' && sawStart && init.method === 'GET') crash('started', `before ${init.method} ${p}`);
  httpCalls += 1;
  const reqBody = init.body ? JSON.parse(init.body) : undefined;
  noteSessions(reqBody);
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    emit({ kind: 'http', method: init.method, path: p, idempotencyKey: init.headers['idempotency-key'], body: redactValue(reqBody), status: null, error: error?.cause?.code || error?.name });
    say(`→ ${init.method} ${p}  ✗ transport error (${error?.cause?.code || error?.name})`);
    throw error;
  }
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  noteSessions(parsed);
  const red = redactValue(parsed);
  emit({ kind: 'http', method: init.method, path: p, idempotencyKey: init.headers['idempotency-key'], body: redactValue(reqBody), status: response.status, response: red });
  say(`→ ${init.method} ${p}${init.headers['idempotency-key'] ? `  [Idempotency-Key: ${init.headers['idempotency-key']}]` : ''}`);
  if (reqBody) say(`    body: ${JSON.stringify(redactValue(reqBody))}`);
  say(`  ← ${response.status} ${JSON.stringify(red)}`);
  if (init.method === 'POST' && u.pathname === '/api/agent-runs') {
    sawStart = true;
    if (crashAt === 'start-response') crash('start-response', 'run id received but not yet persisted');
  }
  if (u.pathname.endsWith('/events') && parsed?.data?.state) {
    const st = parsed.data.state;
    if (crashAt === 'running' && st === 'running') crash('running', `events page state=${st}`);
    if (crashAt === 'terminal' && deckApi.AGENT_DECK_TERMINAL_STATES.includes(st)) crash('terminal', `events page state=${st}`);
  }
  return { status: response.status, json: async () => parsed };
});
deckAttempt.setAgentDeckApiPollIntervalForTests(Number(process.env.POC_POLL_MS || 1500));

// -------------------------------------------------------------------- state
function loadState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { scenarios: {} };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function attemptsOf(requestId) {
  return engine.listAttempts(requestId);
}
function bindingsOf(requestId) {
  return raw.prepare('SELECT id, agent_id, adapter, external_session_id, source_attempt_id, request_id FROM session_bindings WHERE request_id = ?').all(requestId);
}
function snapshot(label, requestId) {
  const request = engine.getWorkRequest(requestId);
  const attempts = attemptsOf(requestId).map(a => ({
    id: a.id, kind: a.kind, adapter: a.adapter, external_run_id: a.external_run_id,
    external_session_id: a.external_session_id ? `<S:${short(a.external_session_id)}>` : null,
    outcome: a.outcome, error_category: a.error_category, resumed_session_binding_id: a.resumed_session_binding_id,
    transport: JSON.parse(a.launch_snapshot || '{}').transport,
    prompt_hash: (JSON.parse(a.launch_snapshot || '{}').prompt_hash || '').slice(0, 12),
  }));
  const bindings = bindingsOf(requestId).map(b => ({ ...b, external_session_id: `<S:${short(b.external_session_id)}>` }));
  const baselines = raw.prepare('SELECT attempt_id, baseline_ref FROM attempt_finalization_baselines WHERE attempt_id IN (SELECT id FROM work_attempts WHERE request_id = ?)').all(requestId);
  const events = engine.listEvents(requestId).map(e => e.type);
  const view = { request: { id: request.id, kind: request.execution_kind, state: request.state, error_code: request.error_code }, attempts, bindings, baselines, events };
  say(`[${label}] Botmancers durable state:\n${JSON.stringify(view, null, 2)}`);
  emit({ kind: 'snapshot', label, view });
  return view;
}

function startPostCount(key) {
  if (!fs.existsSync(TRANSCRIPT)) return 0;
  return fs.readFileSync(TRANSCRIPT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.kind === 'http' && e.method === 'POST' && e.path === '/api/agent-runs' && (!key || e.idempotencyKey === key)).length;
}
function startRunIds(key) {
  if (!fs.existsSync(TRANSCRIPT)) return [];
  return [...new Set(fs.readFileSync(TRANSCRIPT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.kind === 'http' && e.method === 'POST' && e.path === '/api/agent-runs' && e.idempotencyKey === key && e.response?.data?.runId)
    .map(e => e.response.data.runId))];
}
function hostRunDirs() {
  const home = process.env.POC_AGENT_DECK_HOME;
  if (!home) return null;
  const dir = path.join(home, 'runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('run-')).length : 0;
}

let failures = 0;
function check(condition, label) {
  say(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  emit({ kind: 'assert', ok: !!condition, label });
  if (!condition) failures += 1;
}

// --------------------------------------------------------- request creation
function developer(state) {
  const bot = bots.getById(state.developerId);
  if (!bot) throw new Error('run init first');
  return bot;
}

function createRequest(state, scenario, kind, task, extraPolicy = {}, parentRequestId = null) {
  const bot = developer(state);
  const conversation = conversations.getByBotId(bot.id);
  const source = messages.create(conversation.id, 'user', task);
  const selected = policyLib.selectExecutionPolicy({
    entryPoint: 'wake', wakeSyntax: 'structured', executionKind: kind, resumesWorkRequest: kind === 'revision',
  });
  if (!selected.ok) throw new Error(selected.reason);
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: conversation.id,
    sourceEventId: source.id,
    requester: { kind: 'person', id: 'not468-operator' },
    targetAgentId: bot.id,
    intent: task,
    executionKind: kind,
    toolProfile: selected.policy.tool_profile,
    idempotencyKey: `not468-${scenario}`,
    parentRequestId,
    executionPolicy: selected.policy,
    policy: extraPolicy,
  });
  state.scenarios[scenario] = { requestId: request.id, kind };
  saveState(state);
  return request;
}

function defaultTask(scenario) {
  return `Create a new file named poc-${scenario}.md in the current directory containing exactly one line: "${scenario} ok". `
    + 'Do not modify any other file and do not run any git command. When done, reply with exactly the text '
    + `DONE-${scenario} and nothing else.`;
}

// Reconstructs the frozen AttemptInput of a persisted Attempt the way
// runTurn built it (conversation history up to the source event; these
// requests carry no Wake context), and checks it against the launch
// snapshot's prompt hash before it is ever re-sent.
function reconstructInput(request, attempt) {
  const bot = bots.getById(request.target_agent_id);
  const rows = raw.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? AND rowid <= (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid ASC`
  ).all(request.source_conversation_id, request.source_event_id);
  const speaker = m => {
    if (m.sender_kind === 'bot' && m.sender_id) {
      const sender = bots.getById(m.sender_id);
      return sender ? sender.name : `bot:${m.sender_id}`;
    }
    return `${m.sender_kind ?? 'person'}:${m.sender_id ?? 'unknown'}`;
  };
  const history = rows.map(m => ({
    speakerLabel: speaker(m),
    fromAgent: m.sender_kind === 'bot' && m.sender_id === bot.id,
    content: m.content,
  }));
  const snapshotJson = JSON.parse(attempt.launch_snapshot);
  const binding = attempt.resumed_session_binding_id
    ? raw.prepare('SELECT * FROM session_bindings WHERE id = ?').get(attempt.resumed_session_binding_id)
    : null;
  const prepared = dispatch.prepareDispatch({
    bot, history, toolProfile: attempt.tool_profile,
    sessionBinding: binding ? { bindingId: binding.id, externalSessionId: binding.external_session_id } : null,
    prepareFinalization: snapshotJson.prepare_finalization === true,
  });
  const input = { ...prepared.input, correlation: { requestId: request.id, attemptId: attempt.id } };
  const hash = crypto.createHash('sha256').update(JSON.stringify(input.prompt)).digest('hex');
  return { input, adapter: prepared.adapter, hashMatches: hash === snapshotJson.prompt_hash, hash };
}

// Mirrors runTurn's projection for a reattached result (reply message,
// edit Session Binding, request completion), in the finishing transaction.
function persistResult(request, attempt, result) {
  return engine.transaction(() => {
    const finished = executor.recordAttemptResult(engine, attempt.id, result);
    finalization.recordPreparedEvidence(request, finished, result, Date.now());
    if (result.status !== 'completed' || result.output === null) {
      const failure = dispatch.dispatchFailureFor(result);
      engine.transitionWorkRequest(request.id, { from: 'running', to: 'failed', errorCode: failure.code, errorMessage: failure.message });
      return finished;
    }
    const replyId = crypto.randomUUID();
    raw.prepare('INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(replyId, request.source_conversation_id, 'bot', request.target_agent_id, 'bot', request.id, result.output, Date.now());
    if (request.tool_profile === 'edit' && result.externalSessionId) {
      engine.bindSession({
        agentId: request.target_agent_id, adapter: attempt.adapter, externalSessionId: result.externalSessionId,
        conversationId: request.source_conversation_id, requestId: request.id, sourceAttemptId: attempt.id,
      });
    }
    engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', result: { reply_message_id: replyId } });
    return finished;
  });
}

async function readAllEvents(runId) {
  const events = [];
  let cursor = null;
  let state = null;
  for (let i = 0; i < 50; i += 1) {
    const page = await deckApi.getAgentDeckRunEvents(runId, cursor);
    events.push(...page.events);
    state = page.state;
    if (page.events.length === 0 || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return { events, state };
}

function classify(attempt, observed) {
  // The decision table of docs/evidence/NOT-468/decision-record.md, as code.
  if (!attempt) return 'manual_attention:no_attempt';
  if (attempt.outcome) return 'noop:attempt_already_terminal';
  if (!attempt.external_run_id) return 'reattach:idempotent_restart_with_same_key';
  if (observed.error) {
    if (observed.error.code === 'agent_deck_unreachable') return 'defer:agent_deck_unreachable_retry_later';
    if (observed.error.code === 'agent_deck_unauthorized' || observed.error.code === 'agent_deck_forbidden') return 'manual_attention:grant';
    if (observed.error.status === 404) return 'manual_attention:run_unknown_to_agent_deck';
    return 'manual_attention:unexpected_api_error';
  }
  const s = observed.status.state;
  if (s === 'starting' || s === 'running') return 'reattach:observe_until_terminal';
  if (s === 'ended') return observed.hasResult ? 'reconcile:succeeded' : 'reconcile:failed_result_contract';
  if (s === 'error') return 'reconcile:failed_runtime';
  if (s === 'canceled') return 'reconcile:cancelled';
  if (s === 'died') return 'reconcile:interrupted';
  return 'manual_attention:unknown_state';
}

// ----------------------------------------------------------------- commands
async function cmdInit() {
  const state = loadState();
  settings.setAgentDeckServerUrl(AGENT_DECK_URL);
  if (!state.developerId) {
    const bot = bots.create({ name: 'Developer 468', title: 'Developer', description: 'NOT-468 restart PoC developer', agent: 'codex', deck_id: DECK, working_directory: WORKSPACE });
    state.developerId = bot.id;
    saveState(state);
  }
  say(`init: developer=${state.developerId} deck=${DECK} cwd=${WORKSPACE} server=${settings.getAgentDeckServerUrl()}`);
}

async function cmdLaunch(scenario) {
  const state = loadState();
  const task = typeof flags.task === 'string' ? flags.task : defaultTask(scenario);
  const kind = typeof flags.kind === 'string' ? flags.kind : 'implementation';
  const request = createRequest(state, scenario, kind, task);
  say(`launch ${scenario}: work request ${request.id} (${kind}, ${request.tool_profile}) crash-at=${crashAt || 'none'}`);
  emit({ kind: 'launch', requestId: request.id, crashAt });
  await conv.startAgentDispatch(request.id);
  await conv.waitForAgentDispatchIdle();
  snapshot('after launch', request.id);
}

async function observe(attempt) {
  const observed = { status: null, events: [], hasResult: false, error: null };
  try {
    observed.status = await deckApi.getAgentDeckRun(attempt.external_run_id);
    const all = await readAllEvents(attempt.external_run_id);
    observed.events = all.events;
    observed.hasResult = all.events.some(e => e.type === 'result' && typeof e.result === 'string' && e.result.length > 0);
    if (observed.status.finalization && deckApi.AGENT_DECK_TERMINAL_STATES.includes(observed.status.state)) {
      try { observed.changes = await deckApi.getAgentDeckRunChanges(attempt.external_run_id); } catch (error) { observed.changesError = { code: error.code, deckCode: error.deckCode, status: error.status }; }
    }
  } catch (error) {
    observed.error = { code: error.code, status: error.status, deckCode: error.deckCode, message: error.message };
    say(`  observed error: ${JSON.stringify(observed.error)}`);
  }
  return observed;
}

async function cmdRestart(scenario) {
  const state = loadState();
  const sc = state.scenarios[scenario];
  say(`restart ${scenario}: new Botmancers process pid ${process.pid}; request ${sc.requestId}`);
  const before = snapshot('on restart, before recovery', sc.requestId);
  const callsBefore = httpCalls;
  const postsBefore = startPostCount();
  // The real Botmancers startup recovery (NOT-472/NOT-487).
  await conv.recoverCoordinatorLoops();
  await conv.waitForAgentDispatchIdle();
  const after = snapshot('after recoverCoordinatorLoops()', sc.requestId);
  check(httpCalls === callsBefore, `recoverCoordinatorLoops made no Agent Deck call (${httpCalls - callsBefore})`);
  check(startPostCount() === postsBefore, 'recoverCoordinatorLoops launched no run');
  check(JSON.stringify(before) === JSON.stringify(after), 'recoverCoordinatorLoops left the open Attempt untouched (no reconciler exists today)');
  const attempt = attemptsOf(sc.requestId).slice(-1)[0];
  if (!attempt.external_run_id) {
    say('  persisted Attempt has NO external run id: status/events cannot be read without a run id.');
    const verdict = classify(attempt, {});
    say(`  decision: ${verdict}`);
    emit({ kind: 'decision', verdict });
    return;
  }
  say(`  persisted run id ${attempt.external_run_id}; reconciling read-only through the public API`);
  const observed = await observe(attempt);
  const verdict = classify(attempt, observed);
  if (observed.status) {
    const terminalEvents = observed.events.filter(e => ['result', 'end', 'error', 'canceled'].includes(e.type)).map(e => `${e.seq}:${e.type}`);
    say(`  status=${observed.status.state} sessionId=${observed.status.sessionId ? `<S:${short(observed.status.sessionId)}>` : null} events=${observed.events.length} terminal-events=[${terminalEvents}] seq-ordered=${observed.events.every((e, i) => e.seq === i + 1)}`);
    check(observed.events.every((e, i) => e.seq === i + 1), 'events are contiguous and ordered by seq from 1');
    if (observed.changes) say(`  changes: ${observed.changes.files.length} file(s) ${observed.changes.files.map(f => f.path).join(', ')} manifest ${observed.changes.manifestDigest.slice(0, 12)}`);
    if (observed.changesError) say(`  changes error: ${JSON.stringify(observed.changesError)}`);
  }
  say(`  decision: ${verdict}`);
  emit({ kind: 'decision', verdict, state: observed.status?.state ?? null });
  check(startPostCount() === postsBefore, `read-only reconcile launched no run (start POSTs total ${startPostCount()})`);
}

async function cmdReattach(scenario) {
  const state = loadState();
  const sc = state.scenarios[scenario];
  const request = engine.getWorkRequest(sc.requestId);
  const attempt = attemptsOf(sc.requestId).slice(-1)[0];
  say(`reattach ${scenario}: Botmancers pid ${process.pid}; Attempt ${attempt.id} run=${attempt.external_run_id}`);
  if (attempt.outcome) { say('  Attempt already terminal; nothing to do'); return; }
  const key = deckAttempt.agentDeckStartIdempotencyKey({ correlation: { attemptId: attempt.id } });
  const { input, adapter, hashMatches } = reconstructInput(request, attempt);
  check(hashMatches, 'reconstructed prompt matches the launch snapshot prompt_hash');
  if (!hashMatches) return;
  const postsBefore = startPostCount(key);
  const hostBefore = hostRunDirs();
  const result = await adapter.run(Object.freeze(input), event => {
    if (event.type === 'started' && event.externalRunId && !attempt.external_run_id) {
      engine.recordAttemptExternalIds(attempt.id, { externalRunId: event.externalRunId });
    }
  });
  const runIds = startRunIds(key);
  say(`  result: status=${result.status} run=${result.externalRunId} session=${result.externalSessionId ? `<S:${short(result.externalSessionId)}>` : null} failure=${JSON.stringify(result.failure)} output=${JSON.stringify(redactText(result.output))} artifacts=${JSON.stringify(result.artifacts)}`);
  check(runIds.length === 1, `every start POST with key ${key} returned the same run id (${runIds.join(', ')}); POSTs with this key: ${postsBefore} before, ${startPostCount(key)} after`);
  if (attempt.external_run_id) check(result.externalRunId === attempt.external_run_id, 'reattached run id equals the persisted run id');
  const hostAfter = hostRunDirs();
  if (hostBefore !== null) check(hostAfter === hostBefore, `host: Agent Deck run directories unchanged by reattach (${hostBefore} -> ${hostAfter})`);
  const finished = persistResult(request, engine.getAttempt(attempt.id), result);
  say(`  persisted Attempt outcome=${finished.outcome} category=${finished.error_category}`);
  snapshot('after reattach', sc.requestId);
}

async function cmdCancel(scenario) {
  const state = loadState();
  const sc = state.scenarios[scenario];
  const attempt = attemptsOf(sc.requestId).slice(-1)[0];
  say(`cancel ${scenario}: Botmancers pid ${process.pid}; run ${attempt.external_run_id}`);
  const first = await deckApi.cancelAgentDeckRun(attempt.external_run_id);
  const second = await deckApi.cancelAgentDeckRun(attempt.external_run_id);
  const all = await readAllEvents(attempt.external_run_id);
  say(`  cancel -> ${first}; repeat cancel -> ${second}; last event ${all.events.slice(-1)[0]?.type}`);
  check(first === 'canceled' && second === 'canceled', 'cancel is idempotent and reports canceled');
  check(all.events.slice(-1)[0]?.type === 'canceled' && !all.events.some(e => e.type === 'result' || e.type === 'end'), 'canceled is the last event; no result/end recorded');
  engine.transaction(() => {
    engine.finishAttempt(attempt.id, { outcome: 'cancelled', errorCategory: 'cancelled', errorMessage: `Agent Deck run ${attempt.external_run_id} was canceled after restart.` });
    engine.transitionWorkRequest(sc.requestId, { from: 'running', to: 'failed', errorCode: 'runtime_failed', errorMessage: 'The agent run was cancelled.' });
  });
  snapshot('after cancel', sc.requestId);
}

async function cmdResume(fromScenario, scenario) {
  const state = loadState();
  const from = state.scenarios[fromScenario];
  const binding = bindingsOf(from.requestId)[0];
  say(`resume ${fromScenario} -> ${scenario}: Botmancers pid ${process.pid}; binding ${binding?.id} session <S:${short(binding?.external_session_id)}>`);
  check(!!binding, 'the reconciled implementation has a persisted Session Binding');
  if (!binding) return;
  knownSessions.add(binding.external_session_id);
  const task = typeof flags.task === 'string' ? flags.task
    : `Create a new file named poc-${scenario}.md containing exactly one line: "${scenario} ok". Do not modify any other file and do not run any git command. Then reply with the exact file name you created in the previous turn of this session, and nothing else.`;
  const request = createRequest(state, scenario, 'revision', task, { resume_work_request: from.requestId }, from.requestId);
  const postsBefore = startPostCount();
  await conv.startAgentDispatch(request.id);
  await conv.waitForAgentDispatchIdle();
  const view = snapshot('after resume', request.id);
  const attempt = attemptsOf(request.id)[0];
  check(attempt.kind === 'resume' && attempt.resumed_session_binding_id === binding.id, 'the Attempt is a resume of the persisted binding');
  check(attempt.external_session_id === binding.external_session_id, 'the resumed run reports the SAME opaque session id as the binding');
  const status = await deckApi.getAgentDeckRun(attempt.external_run_id);
  check(status.sessionId === binding.external_session_id, 'GET status sessionId equals the binding session id byte-for-byte');
  check(startPostCount() === postsBefore + 1, 'exactly one start POST (the resume) was sent');
  return view;
}

async function cmdProbe(name) {
  const state = loadState();
  const sc = positional[1] ? state.scenarios[positional[1]] : null;
  const attempt = sc ? attemptsOf(sc.requestId).slice(-1)[0] : null;
  const runId = attempt?.external_run_id;
  const tryCall = async (label, fn) => {
    try {
      const value = await fn();
      say(`  ${label}: OK ${JSON.stringify(redactValue(value))}`);
      emit({ kind: 'probe', label, ok: true });
      return { ok: true, value };
    } catch (error) {
      const info = { code: error.code, status: error.status, deckCode: error.deckCode, message: error.message };
      say(`  ${label}: ${JSON.stringify(info)}`);
      emit({ kind: 'probe', label, ok: false, info });
      return { ok: false, info };
    }
  };
  say(`probe ${name}: Botmancers pid ${process.pid}`);
  if (name === 'unknown-run') {
    const fake = 'run-20260101T000000-000000';
    const a = await tryCall(`GET status ${fake}`, () => deckApi.getAgentDeckRun(fake));
    const b = await tryCall(`GET events ${fake}`, () => deckApi.getAgentDeckRunEvents(fake, null));
    const c = await tryCall(`POST cancel ${fake}`, () => deckApi.cancelAgentDeckRun(fake));
    const d = await tryCall('GET status run id with path chars', () => deckApi.getAgentDeckRun('../../etc/passwd'));
    const verdict = classify({ external_run_id: fake }, { error: a.info });
    say(`  decision: ${verdict}`);
    check([a, b, c].every(r => !r.ok && r.info.status === 404 && r.info.deckCode === 'RUN_NOT_FOUND'), 'unknown run id: status/events/cancel are 404 RUN_NOT_FOUND');
    emit({ kind: 'decision', verdict, d: d.info });
  } else if (name === 'foreign-grant' || name === 'expired-grant' || name === 'revoked-grant' || name === 'rotated-grant') {
    const r = await tryCall(`GET status ${runId} with ${name}`, () => deckApi.getAgentDeckRun(runId));
    const e = await tryCall(`GET events ${runId} with ${name}`, () => deckApi.getAgentDeckRunEvents(runId, null));
    const verdict = classify(attempt && { ...attempt, outcome: null }, { error: r.info });
    say(`  decision: ${verdict}`);
    emit({ kind: 'decision', verdict, status: r.info?.status, events: e.info?.status });
  } else if (name === 'unreachable') {
    const r = await tryCall(`GET status ${runId} (Agent Deck down)`, () => deckApi.getAgentDeckRun(runId));
    const verdict = classify(attempt && { ...attempt, outcome: null }, { error: r.info });
    say(`  decision: ${verdict}`);
    emit({ kind: 'decision', verdict });
  } else if (name === 'idempotency-conflict') {
    // Same Attempt key, different body (e.g. the conversation changed
    // before a reattach re-rendered the prompt).
    const request = engine.getWorkRequest(sc.requestId);
    const { input } = reconstructInput(request, attempt);
    const key = deckAttempt.agentDeckStartIdempotencyKey(input);
    await tryCall(`POST start with ${key} and a different prompt`, () => deckApi.startAgentDeckRun({
      deckId: input.deck, client: 'codex', cwd: input.cwd, prompt: 'different prompt', tools: input.toolProfile,
      ...(input.prepareFinalization ? { prepareFinalization: true } : {}),
    }, key));
  } else if (name === 'resume-unknown-session') {
    const before = startPostCount();
    await tryCall('POST resume with an unknown session id', () => deckApi.startAgentDeckRun({
      deckId: DECK, client: 'codex', cwd: WORKSPACE, prompt: 'noop', tools: 'edit', resumeSessionId: '00000000-0000-0000-0000-000000000000',
    }, `not468-probe-resume-unknown-${Date.now()}`));
    say(`  start POSTs: ${before} -> ${startPostCount()} (a refused resume launches nothing)`);
  }
}

async function main() {
  if (command === 'init') await cmdInit();
  else if (command === 'launch') await cmdLaunch(positional[0]);
  else if (command === 'restart') await cmdRestart(positional[0]);
  else if (command === 'reattach') await cmdReattach(positional[0]);
  else if (command === 'cancel') await cmdCancel(positional[0]);
  else if (command === 'resume') await cmdResume(positional[0], positional[1]);
  else if (command === 'probe') await cmdProbe(positional[0]);
  else if (command === 'snapshot') snapshot('snapshot', loadState().scenarios[positional[0]].requestId);
  else throw new Error(`unknown command ${command}`);
  if (failures) {
    say(`${failures} assertion(s) FAILED`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
