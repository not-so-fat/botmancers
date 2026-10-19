#!/usr/bin/env node
// NOT-504: a deterministic fake `codex` binary for the direct Codex provider
// tests (test-codex-session-provider.js). Its threads live in one JSON state
// file (FAKE_CODEX_STATE), so they outlive any Botmancers or app-server
// process. Every request is logged in state.calls so tests can assert exact
// protocol payloads. No network.
//
//   fake-codex.js --version            prints `codex-cli <state.version>`
//   fake-codex.js app-server           JSON-RPC over stdio (the app-server protocol subset)
//   fake-codex.js exec [resume] --json ...  the `codex exec --json` JSONL stream
//
// state.config: { missingMethods: [], signedIn: true, noAppServer: false }.
// Prompt markers: `[hold]` stays in progress until interrupted (or SIGINT
// for exec); `[nousage]` reports no token usage; `[fail]` fails the turn;
// `[approval]` makes the server ask for a command approval first.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS fixture consumed by standalone Node tests. */
const fs = require('fs');

const STATE = process.env.FAKE_CODEX_STATE;
const BASE_S = Math.floor(Date.UTC(2026, 9, 1, 8, 0, 0) / 1000);

function emptyState() {
  return { version: '0.157.1', config: { missingMethods: [], signedIn: true }, counter: 0, threads: {}, order: [], calls: [] };
}
function load() {
  return STATE && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : emptyState();
}
function save(state) {
  if (STATE) fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}
function mutate(fn) {
  const state = load();
  const out = fn(state);
  save(state);
  return out;
}
function nextId(state, prefix) {
  state.counter += 1;
  return `${prefix}-${String(state.counter).padStart(4, '0')}-SECRET`;
}

// Seeds threads "created outside Botmancers". Each: { id, cwd, name?,
// preview?, archived?, ephemeral?, legacy?, source?, turns: [[prompt, reply], ...] }.
function seedFakeCodex(statePath, threads, config) {
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : emptyState();
  if (config) state.config = { ...state.config, ...config };
  for (const t of threads) {
    state.counter += 1;
    const at = BASE_S + state.counter * 60;
    state.threads[t.id] = {
      id: t.id, cwd: t.cwd, name: t.name ?? null, preview: t.preview ?? (t.turns?.[0]?.[0] ?? ''), archived: !!t.archived, ephemeral: !!t.ephemeral,
      legacy: !!t.legacy, deleted: false, source: t.source ?? 'cli', createdAt: at, updatedAt: at,
      turns: (t.turns ?? []).map(([prompt, reply], i) => ({
        id: `${t.id}-turn-${i + 1}`, status: 'completed', error: null, completedAt: at,
        items: [
          { type: 'userMessage', id: `${t.id}-u${i + 1}`, clientId: null, content: [{ type: 'text', text: prompt, text_elements: [] }] },
          { type: 'reasoning', id: `${t.id}-r${i + 1}`, summary: [], content: [] },
          { type: 'agentMessage', id: `${t.id}-a${i + 1}`, text: reply, phase: 'final_answer' },
        ],
      })),
    };
    state.order.push(t.id);
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

module.exports = { seedFakeCodex, emptyState, FAKE_CODEX: __filename };

if (require.main !== module) return;

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${load().version}\n`);
  process.exit(0);
}
if (args[0] === 'app-server') appServer();
else if (args[0] === 'exec') execMode(args.slice(1));
else {
  process.stderr.write('fake-codex: unknown command\n');
  process.exit(2);
}

function threadView(t, loaded) {
  const running = t.turns.some(turn => turn.status === 'inProgress');
  const status = !loaded.has(t.id) ? { type: 'notLoaded' } : running ? { type: 'active', activeFlags: [] } : { type: 'idle' };
  return {
    id: t.id, sessionId: t.id, forkedFromId: null, parentThreadId: null, preview: t.preview, ephemeral: t.ephemeral,
    historyMode: t.legacy ? 'legacy' : 'paginated', modelProvider: 'openai', model: 'fake', createdAt: t.createdAt, updatedAt: t.updatedAt,
    status, path: `/fake/.codex/${t.archived ? 'archived_sessions' : 'sessions'}/rollout-${t.id}.jsonl`, cwd: t.cwd, cliVersion: '0.157.1',
    source: t.source, name: t.name, turns: [],
  };
}

function appServer() {
  const loaded = new Set();
  let buffer = '';
  let nextServerRequest = 1;
  const pendingServer = new Map();
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => send({ method, params });
  const rpcError = (id, message, code = -32600) => send({ id, error: { code, message } });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  process.stdin.on('end', () => process.exit(0));

  function finishTurn(threadId, turnId, prompt) {
    const tokens = { totalTokens: 0, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 3 };
    const reply = `codex reply: ${prompt}`;
    if (!prompt.includes('[nousage]')) {
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: null } });
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: tokens, last: { ...tokens, inputTokens: 50, cachedInputTokens: 50, outputTokens: 5 }, modelContextWindow: null } });
    }
    const failed = prompt.includes('[fail]');
    if (!failed) notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-a`, text: reply, phase: 'final_answer' }, completedAtMs: 0 });
    const turn = mutate(state => {
      const t = state.threads[threadId];
      const target = t.turns.find(x => x.id === turnId);
      if (target.status !== 'inProgress') return null;
      target.status = failed ? 'failed' : 'completed';
      target.error = failed ? { message: 'model refused' } : null;
      state.counter += 1;
      target.completedAt = BASE_S + state.counter * 60;
      if (!failed) target.items.push({ type: 'agentMessage', id: `${turnId}-a`, text: reply, phase: 'final_answer' });
      t.updatedAt = target.completedAt;
      return target;
    });
    if (turn) notify('turn/completed', { threadId, turn });
  }

  function handle(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = pendingServer.get(message.id);
      if (pending) {
        pendingServer.delete(message.id);
        mutate(state => state.calls.push({ method: 'serverRequest/response', params: { request: pending.method, response: message.result ?? message.error } }));
        pending.then();
      }
      return;
    }
    const { id, method } = message;
    const params = message.params ?? {};
    const state = load();
    state.calls.push({ method, params });
    save(state);
    if (id === undefined) return; // notification (initialized)
    const missing = state.config.missingMethods ?? [];
    if (missing.includes(method) || !KNOWN.has(method)) return rpcError(id, `Invalid request: unknown variant \`${method}\`, expected one of ...`);
    if (typeof params.threadId === 'number' || typeof params.limit === 'string' || typeof params.cwd === 'number') {
      return rpcError(id, 'Invalid request: invalid type: integer `0`, expected a string');
    }
    const thread = typeof params.threadId === 'string' ? state.threads[params.threadId] : undefined;
    const gone = !thread || thread.deleted;
    switch (method) {
      case 'initialize':
        return send({ id, result: { userAgent: `fake-codex/${state.version}`, codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'linux' } });
      case 'account/read':
        return send({ id, result: { account: state.config.signedIn === false ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true } });
      case 'thread/list': {
        const kinds = params.sourceKinds && params.sourceKinds.length ? params.sourceKinds : ['cli', 'vscode'];
        const term = (params.searchTerm ?? '').toLowerCase();
        const all = state.order.map(tid => state.threads[tid])
          .filter(t => !t.deleted && t.archived === (params.archived === true) && kinds.includes(t.source)
            && (!term || `${t.name ?? ''} ${t.preview}`.toLowerCase().includes(term)))
          .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
        const start = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? 25;
        const data = all.slice(start, start + limit).map(t => threadView(t, loaded));
        return send({ id, result: { data, nextCursor: start + limit < all.length ? String(start + limit) : null, backwardsCursor: null } });
      }
      case 'thread/read':
        if (gone) return rpcError(id, `thread not loaded: ${params.threadId}`);
        return send({ id, result: { thread: threadView(thread, loaded) } });
      case 'thread/items/list': {
        if (gone || thread.legacy) return rpcError(id, 'thread/items/list is not supported yet', -32601);
        const items = thread.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: null, completedAtMs: (turn.completedAt ?? 0) * 1000 })));
        const start = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? 50;
        return send({ id, result: { data: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null, backwardsCursor: null } });
      }
      case 'thread/turns/list': {
        if (gone) return rpcError(id, `thread not loaded: ${params.threadId}`);
        const turns = params.sortDirection === 'desc' ? [...thread.turns].reverse() : thread.turns;
        const start = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? 10;
        return send({ id, result: { data: turns.slice(start, start + limit), nextCursor: start + limit < turns.length ? String(start + limit) : null, backwardsCursor: null } });
      }
      case 'thread/start': {
        const created = mutate(s => {
          const tid = nextId(s, 'thr');
          s.counter += 1;
          s.threads[tid] = {
            id: tid, cwd: params.cwd, name: null, preview: '', archived: false, ephemeral: false, legacy: false, deleted: false,
            source: 'appServer', createdAt: BASE_S + s.counter * 60, updatedAt: BASE_S + s.counter * 60, turns: [],
          };
          s.order.push(tid);
          return s.threads[tid];
        });
        loaded.add(created.id);
        notify('thread/started', { thread: threadView(created, loaded) });
        return send({ id, result: { thread: threadView(created, loaded), cwd: created.cwd, sandbox: { type: params.sandbox }, approvalPolicy: params.approvalPolicy } });
      }
      case 'thread/resume':
        if (gone) return rpcError(id, `no rollout found for thread id ${params.threadId}`);
        loaded.add(thread.id);
        return send({ id, result: { thread: threadView(thread, loaded), cwd: thread.cwd, sandbox: { type: params.sandbox }, approvalPolicy: params.approvalPolicy } });
      case 'turn/start': {
        if (gone || !loaded.has(thread.id)) return rpcError(id, `thread not loaded: ${params.threadId}`);
        const prompt = params.input.map(part => part.text ?? '').join('');
        const turn = mutate(s => {
          const t = s.threads[params.threadId];
          const tid = nextId(s, 'turn');
          const created = {
            id: tid, status: 'inProgress', error: null, completedAt: null,
            items: [{ type: 'userMessage', id: `${tid}-u`, clientId: params.clientUserMessageId ?? null, content: params.input }],
          };
          if (!t.preview) t.preview = prompt;
          t.turns.push(created);
          return created;
        });
        send({ id, result: { turn } });
        notify('turn/started', { threadId: thread.id, turn });
        if (prompt.includes('[hold]')) return undefined;
        const proceed = () => setTimeout(() => finishTurn(thread.id, turn.id, prompt), 5);
        if (prompt.includes('[approval]')) {
          const rid = `srv-${nextServerRequest++}`;
          pendingServer.set(rid, { method: 'item/commandExecution/requestApproval', then: proceed });
          return send({ id: rid, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: 'x', command: 'rm -rf build' } });
        }
        return proceed();
      }
      case 'turn/interrupt': {
        if (gone) return rpcError(id, `thread not found: ${params.threadId}`);
        const turn = mutate(s => {
          const target = s.threads[params.threadId].turns.find(x => x.id === params.turnId);
          if (!target || target.status !== 'inProgress') return null;
          target.status = 'interrupted';
          s.counter += 1;
          target.completedAt = BASE_S + s.counter * 60;
          return target;
        });
        send({ id, result: {} });
        if (turn) notify('turn/completed', { threadId: params.threadId, turn });
        return undefined;
      }
      default:
        return rpcError(id, `Invalid request: unknown variant \`${method}\``);
    }
  }
}

const KNOWN = new Set([
  'initialize', 'account/read', 'thread/list', 'thread/read', 'thread/items/list', 'thread/turns/list',
  'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt',
]);

function execMode(argv) {
  const resume = argv[0] === 'resume';
  const rest = resume ? argv.slice(1) : argv;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-c' || rest[i] === '-C') { i++; continue; }
    if (rest[i].startsWith('-') && rest[i] !== '-') continue;
    positional.push(rest[i]);
  }
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    const out = line => process.stdout.write(`${line}\n`);
    const threadId = mutate(state => {
      state.calls.push({ method: 'exec', params: { args: argv, cwd: process.cwd(), prompt } });
      let tid = resume ? positional[0] : null;
      if (!tid) {
        tid = nextId(state, 'thr');
        state.counter += 1;
        state.threads[tid] = {
          id: tid, cwd: process.cwd(), name: null, preview: prompt, archived: false, ephemeral: false, legacy: false, deleted: false,
          source: 'exec', createdAt: BASE_S + state.counter * 60, updatedAt: BASE_S + state.counter * 60, turns: [],
        };
        state.order.push(tid);
      }
      return tid;
    });
    out(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
    out(JSON.stringify({ type: 'turn.started' }));
    if (prompt.includes('[hold]')) {
      process.on('SIGINT', () => process.exit(130));
      setInterval(() => {}, 1000);
      return;
    }
    const reply = `codex exec reply: ${prompt}`;
    mutate(state => {
      state.counter += 1;
      state.threads[threadId].turns.push({
        id: nextId(state, 'turn'), status: 'completed', error: null, completedAt: BASE_S + state.counter * 60,
        items: [
          { type: 'userMessage', id: 'u', clientId: null, content: [{ type: 'text', text: prompt, text_elements: [] }] },
          { type: 'agentMessage', id: 'a', text: reply, phase: 'final_answer' },
        ],
      });
    });
    out(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: reply } }));
    out('{"type":"item.completed", truncated');
    out(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 9, reasoning_output_tokens: 4 } }));
    process.exit(0);
  });
}
