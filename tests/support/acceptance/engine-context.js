// NOT-476: the in-process context one acceptance scenario runs in.
//
// Loaded by a scenario process whose environment the harness built
// (BOTMANCERS_DB_PATH, BOTMANCERS_FILES_ROOT, HOME all inside the
// disposable root). Before any engine module loads it:
//
// - refuses every non-loopback socket connection (and records the attempt),
//   so a scenario cannot reach a network service by accident;
// - refuses (before it starts) every child process other than git or node,
//   and records the processes it does start.
//
// Runtimes are controlled: coordinator (Hermes-transport) turns follow a
// per-conversation script, and coding Agents run through the real direct
// session-provider adapter against scripted in-process fakes
// (test-support/fake-session-provider.js) over shared state files.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness consumed by standalone Node tests. */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function assertIsolatedEnvironment() {
  const root = process.env.BOTMANCERS_ACCEPTANCE_ROOT;
  if (!root) throw new Error('acceptance scenarios run only inside a harness root (BOTMANCERS_ACCEPTANCE_ROOT unset)');
  for (const name of ['BOTMANCERS_DB_PATH', 'BOTMANCERS_FILES_ROOT', 'HOME']) {
    const value = process.env[name] || '';
    if (!path.resolve(value).startsWith(path.resolve(root) + path.sep)) throw new Error(`${name} (${value}) is outside the harness root ${root}`);
  }
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const blockedConnections = [];
const spawned = [];
const refusedSpawns = [];
const ALLOWED_PROGRAMS = new Set(['git', 'node', path.basename(process.execPath)]);

function installGuards(allowHosts = []) {
  for (const host of allowHosts) ALLOWED_HOSTS.add(String(host).toLowerCase());
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    let host;
    if (options && typeof options === 'object') host = options.path ? null : (options.host || 'localhost');
    else if (typeof options === 'number' || /^\d+$/.test(String(options))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
    else host = null; // a Unix socket path
    if (host !== null && !ALLOWED_HOSTS.has(String(host).toLowerCase())) {
      blockedConnections.push(String(host));
      process.nextTick(() => this.destroy(new Error(`acceptance harness: network connection to ${host} refused`)));
      return this;
    }
    return original.apply(this, args);
  };
  // Only git and node (the harness's own workers) may start; anything else
  // is refused before child_process is called, so it never runs. A shell
  // (exec/execSync, or shell: true) could chain any command, so it is
  // refused outright.
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const fn = childProcess[name];
    const viaShell = name === 'exec' || name === 'execSync';
    childProcess[name] = function guardedSpawn(command, ...rest) {
      const program = path.basename(String(command).trim().split(/\s+/)[0]);
      const options = rest.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg));
      const allowed = !viaShell && !(options && options.shell) && ALLOWED_PROGRAMS.has(program);
      if (!allowed) {
        refusedSpawns.push(String(command));
        throw new Error(`acceptance harness: refused to start ${viaShell || (options && options.shell) ? 'a shell command' : 'process'} "${command}" (only ${[...ALLOWED_PROGRAMS].join(', ')} may run)`);
      }
      spawned.push(program);
      return fn.call(this, command, ...rest);
    };
  }
}

function createContext(scenarioName, options = {}) {
  assertIsolatedEnvironment();
  installGuards(options.allowHosts);

  const { createJiti } = require('jiti');
  const jiti = createJiti(path.join(REPO_ROOT, 'tests', 'test-acceptance-engine.js'), { alias: { '@': REPO_ROOT } });
  const lib = name => jiti(path.join(REPO_ROOT, 'lib', name));
  const db = lib('db.ts');
  const service = lib('agent-conversations.ts');
  const dispatch = lib('agent-dispatch.ts');
  const sessionProvider = lib('session-provider.ts');
  const router = lib('wake-router.ts');
  const safety = lib('wake-safety.ts');
  const fake = require('../fake-session-provider.js');
  const raw = db.default;
  const { bots, conversations, engine, projector, UI_OWNER_PRINCIPAL } = db;

  // ---- assertions --------------------------------------------------------
  const results = { scenario: scenarioName, passed: 0, failed: 0, engine: 0, conversation: 0, failures: [] };
  function check(condition, label, layer) {
    const ok = !!condition;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} [${layer}] ${label}`);
    if (ok) {
      results.passed += 1;
      if (layer === 'engine') results.engine += 1;
      if (layer === 'conversation') results.conversation += 1;
    } else {
      results.failed += 1;
      results.failures.push(`[${layer}] ${label}`);
    }
    return ok;
  }
  const engineCheck = (condition, label) => check(condition, label, 'engine');
  const conversationCheck = (condition, label) => check(condition, label, 'conversation');
  const isolationCheck = (condition, label) => check(condition, label, 'isolation');

  // ---- durable state queries --------------------------------------------
  const one = (sql, ...args) => raw.prepare(sql).get(...args);
  const all = (sql, ...args) => raw.prepare(sql).all(...args);
  const requestsIn = conversationId => all('SELECT * FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at ASC, rowid ASC', conversationId);
  const attemptsOf = requestId => all('SELECT * FROM work_attempts WHERE request_id = ? ORDER BY attempt_number', requestId);
  const wakesIn = conversationId => all('SELECT w.* FROM wakes w JOIN messages m ON m.id = w.source_event_id WHERE m.conversation_id = ? ORDER BY w.created_at, w.rowid', conversationId);
  const messagesIn = conversationId => all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC', conversationId);
  const eventTypes = requestId => engine.listEvents(requestId).map(event => event.type);
  const TABLES = ['wakes', 'work_requests', 'work_attempts', 'session_bindings', 'messages', 'engine_events', 'conversation_events'];
  const counts = () => Object.fromEntries(TABLES.map(table => [table, one(`SELECT COUNT(*) AS n FROM ${table}`).n]));
  const sameCounts = (a, b) => TABLES.every(table => a[table] === b[table]);
  // The projected conversation (the read model both UI and API return).
  const projection = conversationId => projector.listConversationEvents(conversationId);
  const projectedKinds = (conversationId, filter = () => true) => projection(conversationId).filter(filter).map(view => view.kind);
  // Whether `expected` appears in order (not necessarily adjacent) in `list`.
  function inOrder(list, expected) {
    let at = 0;
    for (const item of list) if (item === expected[at]) at += 1;
    return at === expected.length;
  }

  // ---- controlled runtimes ----------------------------------------------
  // One file-backed fake SessionProvider per Agent, registered for the
  // Agent's runtime connection. State files live in the shared provider
  // dir, so restart workers (separate processes) observe the same turns.
  // A script seeds, in call order: results (verbatim turn outputs),
  // holdNext (turns that stay running until released), failStarts plus
  // startError (launch failures), failSends (send failures). Default: the
  // fake's echo reply.
  const providerDir = process.env.BOTMANCERS_ACCEPTANCE_PROVIDER_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), `botmancers-acceptance-providers-${scenarioName}-`));
  fs.mkdirSync(providerDir, { recursive: true });
  const statePathFor = agentId => path.join(providerDir, `${agentId}.provider.json`);
  const registeredProviders = new Set();
  function ensureProvider(agentRow) {
    if (registeredProviders.has(agentRow.runtime_connection_id)) return;
    registeredProviders.add(agentRow.runtime_connection_id);
    const statePath = statePathFor(agentRow.id);
    const agentId = agentRow.id;
    sessionProvider.registerSessionProvider(
      { connectionId: agentRow.runtime_connection_id },
      () => fake.createFakeSessionProvider({ statePath, kind: `acceptance-${agentId}` }),
    );
    const manifestPath = path.join(providerDir, 'providers.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    manifest[agentRow.runtime_connection_id] = agentId;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  // Restart workers register every provider the orchestrator scripted.
  function registerProvidersFromManifest(allBots) {
    const manifestPath = path.join(providerDir, 'providers.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const [connectionId, agentId] of Object.entries(manifest)) {
      const row = allBots.find(entry => entry.runtime_connection_id === connectionId) || { id: agentId, runtime_connection_id: connectionId };
      ensureProvider(row);
    }
  }
  function script(agentRow, hooks = {}) {
    const statePath = statePathFor(agentRow.id);
    fake.mutateFakeProvider(statePath, state => {
      if (hooks.results) state.results = [...(state.results ?? []), ...hooks.results];
      if (typeof hooks.holdNext === 'number') state.holdNext = (state.holdNext ?? 0) + hooks.holdNext;
      if (typeof hooks.failStarts === 'number') state.failStarts = (state.failStarts ?? 0) + hooks.failStarts;
      if (hooks.startError) state.startError = hooks.startError;
      if (typeof hooks.failSends === 'number') state.failSends = (state.failSends ?? 0) + hooks.failSends;
    });
    ensureProvider(agentRow);
  }
  const providerTurns = agentRow => fake.loadFakeState(statePathFor(agentRow.id)).turns;
  const providerCalls = (agentRow, op) => fake.loadFakeState(statePathFor(agentRow.id)).calls.filter(entry => entry.op === op);
  const startsFor = agentRow => providerCalls(agentRow, 'startSession');
  const sendsFor = agentRow => providerCalls(agentRow, 'sendTurn');
  const cancelsFor = agentRow => providerCalls(agentRow, 'cancelTurn');
  const turnState = (agentRow, turnId) => providerTurns(agentRow)[turnId]?.state ?? null;
  // Releases the Agent's earliest still-running held turn with a verbatim
  // output, so an observer (possibly another process) sees it complete.
  function release(agentRow, result = null) {
    const statePath = statePathFor(agentRow.id);
    const turn = Object.values(fake.loadFakeState(statePath).turns).find(entry => entry.state === 'running' && entry.held);
    if (!turn) throw new Error(`no held turn for ${agentRow.name}`);
    fake.releaseFakeTurn(statePath, turn.id, result);
    return turn.id;
  }

  // Coordinator (Hermes transport) turns: a per-Agent script when one is
  // set, else a per-conversation plan of steps; each (input, request) =>
  // reply text, or { output, sessionId } to report a runtime session.
  const plans = new Map();
  const hermesScripts = new Map();
  const coordinatorLaunches = [];
  let runCounter = 0;
  function scriptedCoordinator() {
    return {
      name: 'hermes-gateway',
      async run(input, onEvent) {
        await new Promise(resolve => setImmediate(resolve));
        const request = engine.getWorkRequest(input.correlation.requestId);
        const runId = `coordinator-run-${++runCounter}`;
        coordinatorLaunches.push({ input, request, runId });
        onEvent?.({ type: 'started', adapter: 'hermes-gateway', at: Date.now(), externalRunId: runId, externalSessionId: null });
        const script = hermesScripts.get(request.target_agent_id);
        const plan = plans.get(request.source_conversation_id) || [];
        const step = script || plan.shift();
        const reply = step ? step(input, request) : 'Nothing more to do.';
        const output = reply && typeof reply === 'object' ? reply.output : reply;
        const externalSessionId = reply && typeof reply === 'object' ? reply.sessionId ?? null : null;
        const now = Date.now();
        return { status: 'completed', adapter: 'hermes-gateway', externalRunId: runId, externalSessionId, output, artifacts: [], startedAt: now, finishedAt: now, failure: null };
      },
    };
  }
  dispatch.setAttemptAdapterOverride(transport => (transport === 'hermes-gateway' ? scriptedCoordinator() : dispatch.ATTEMPT_ADAPTERS[transport]()));

  // ---- fixtures ----------------------------------------------------------
  const workspace = process.env.BOTMANCERS_ACCEPTANCE_WORKSPACE;
  const PERSON = { kind: 'person', id: 'acceptance-owner' };
  function agent(name, kind, fields = {}) {
    const bot = bots.create({
      name, title: name, description: `${name} (acceptance fixture)`, agent: kind,
      runtime_connection_id: db.runtimeConnections.ensureLocal(kind),
      session_scope_kind: 'workspaces',
      session_scope_items: JSON.stringify([workspace]),
      policy_mode: 'read_only',
      allow_new_sessions: 1,
      allow_resume_with_edits: 0,
      ...fields,
    });
    // Every fixture Agent gets a scripted runtime, so turns never touch a
    // real CLI even when the scenario seeds no script.
    if (kind !== 'hermes') ensureProvider(bot);
    return bots.getById(bot.id);
  }
  function block(envelope) {
    return '```botmancers-wake\n' + JSON.stringify({ version: 1, ...envelope }, null, 2) + '\n```';
  }
  async function ask(target, content, key, plan) {
    const { accepted, dispatched } = service.acceptAgentMessage(PERSON, { agentId: target.id, content, idempotencyKey: key });
    if (plan) plans.set(accepted.conversationId, plan);
    await dispatched;
    await service.waitForAgentDispatchIdle();
    return accepted;
  }

  // Waits (bounded) until every named request has left queued/running, as
  // work started by a route handler finishes, then for dispatch to idle.
  async function settle(requestIds, { timeoutMs = 10_000, until = ['completed', 'failed', 'cancelled', 'blocked'] } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = requestIds.filter(id => !until.includes((engine.getWorkRequest(id) || {}).state));
      if (pending.length === 0) break;
      if (Date.now() > deadline) throw new Error(`requests did not settle within ${timeoutMs}ms: ${pending.join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await service.waitForAgentDispatchIdle();
  }

  // The real API route handlers behind proxy.ts on an ephemeral loopback
  // port, started on first use and closed by close().
  let host = null;
  async function routeHost() {
    if (!host) {
      const { startRouteHost } = require('./route-host.js');
      host = await startRouteHost({ jiti, repoRoot: REPO_ROOT });
    }
    return host;
  }
  async function close() {
    if (host) await host.close();
    host = null;
  }

  const lastEntry = input => input.prompt.history[input.prompt.history.length - 1];

  return {
    REPO_ROOT, jiti, lastEntry, lib, db, raw, service, dispatch, router, safety, engine, projector, bots, conversations, UI_OWNER_PRINCIPAL,
    providerDir, plans, hermesScripts, coordinatorLaunches, PERSON, workspace,
    script, startsFor, sendsFor, cancelsFor, turnState, release, registerProvidersFromManifest, providerCalls, providerTurns,
    check, engineCheck, conversationCheck, isolationCheck, results,
    one, all, requestsIn, attemptsOf, wakesIn, messagesIn, eventTypes, counts, sameCounts, projection, projectedKinds, inOrder,
    agent, block, ask, settle, routeHost, close,
    guards: { blockedConnections, spawned, refusedSpawns },
  };
}

module.exports = { createContext };
