#!/usr/bin/env node
// NOT-508: a deterministic fake `muse serve` (MSP v1 over stdio) for the
// direct Muse SessionProvider (lib/muse-session-provider). Shapes follow the
// stable schema exported by Muse 1.4.10 (`muse schema generate-ts`) and the
// live echo-provider transcripts; the usage fixtures are adapted from Agent
// Dealer's Muse serve fixtures (120 in / 45 out).
//
// Run as a host: `node fake-muse-serve.js serve [flags]`. Sessions live in
// one JSON state file (FAKE_MUSE_STATE) so they outlive the host, like a
// real durable Muse home. Every request is appended to FAKE_MUSE_LOG as
// {pid, argv, method, params} so tests can assert the exact wire calls.
//
// Environment: FAKE_MUSE_VERSION (default 1.4.10), FAKE_MUSE_SCHEMA (1),
// FAKE_MUSE_DURABILITY (durable), FAKE_MUSE_DISABLE (comma list of methods
// answered -32601), FAKE_MUSE_NO_TEXT_FILTER (omit appliedFilter.text),
// FAKE_MUSE_AUTH_FAIL (initialize fails with an auth error).
//
// Turn behavior by prompt marker: default completes ~20ms after turn/start
// with output `muse reply: <prompt>` and usage on turn/completed;
// `[usage:partial]` sends no turn usage and two tokenUsage records, one
// without outputTokens; `[usage:none]` sends no usage at all; `[fail:auth]`
// fails with an auth error; `[hold]` runs until turn/cancel (or host death).
// A turn left running by a dead host is settled `failed` (crash_inferred)
// when its session is next resumed, as Muse does.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS fixture consumed by standalone Node tests. */
const fs = require('fs');
const crypto = require('crypto');

const BASE = Date.UTC(2026, 9, 1, 8, 0, 0);

function load(statePath) {
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { counter: 0, sessions: {}, turns: {} };
}

function save(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function uuid(state, tag) {
  state.counter += 1;
  const hex = crypto.createHash('sha256').update(`${tag}-${state.counter}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Seeds sessions that existed before Botmancers. Each: { id, title?, name?,
// workspace?, kind?, path? (false for an unpersisted session), items:
// [[role, text], ...], raw? (stored verbatim to model a malformed row) }.
function seedFakeMuse(statePath, sessions) {
  const state = load(statePath);
  for (const s of sessions) {
    state.counter += 1;
    const at = BASE + state.counter * 60_000;
    if (s.raw !== undefined) {
      state.sessions[s.id] = { raw: s.raw, updatedAt: iso(at) };
      continue;
    }
    const turnId = `seed-turn-${state.counter}`;
    state.sessions[s.id] = {
      sessionId: s.id, title: s.title ?? null, name: s.name ?? null, workspaceRoot: s.workspace ?? null, kind: s.kind ?? 'root',
      path: s.path === false ? '' : `/fake-muse-home/sessions/${s.id}/session.jsonl`,
      createdAt: iso(at), updatedAt: iso(at), turnCount: s.items ? 1 : 0, loadedBy: null, activeTurnId: null,
      extra: s.extra ?? {},
      items: (s.items ?? []).map(([role, text], i) => ({
        itemId: `${s.id}-item-${i}`, kind: role === 'user' ? 'userMessage' : 'agentMessage', turnId, revision: 1, status: 'completed', recordedAt: iso(at + i), text,
      })),
      lastTurn: s.items ? { turnId, terminal: 'completed' } : null,
    };
  }
  save(statePath, state);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wireSession(s, forPid) {
  if (s.raw !== undefined) return s.raw;
  const loadedHere = s.loadedBy === forPid;
  return {
    sessionId: s.sessionId, path: s.path, status: loadedHere ? (s.activeTurnId ? 'running' : 'idle') : 'notLoaded',
    activeTurnId: loadedHere ? s.activeTurnId : null, createdAt: s.createdAt, updatedAt: s.updatedAt, workspaceRoot: s.workspaceRoot,
    providerId: 'echo', modelId: null, turnCount: s.turnCount, forkedFrom: null, sideFrom: null, kind: s.kind,
    ...(s.title ? { title: s.title, firstUserPrompt: s.title } : {}), ...(s.name ? { name: s.name } : {}), ...s.extra,
  };
}

function runHost() {
  const statePath = process.env.FAKE_MUSE_STATE;
  const logPath = process.env.FAKE_MUSE_LOG;
  const disabled = new Set((process.env.FAKE_MUSE_DISABLE || '').split(',').filter(Boolean));
  const durability = process.env.FAKE_MUSE_DURABILITY || 'durable';
  const argv = process.argv.slice(2);
  const timers = new Map();
  let buffer = '';

  const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const notify = (method, params) => send({ method, params });
  const fail = (id, code, kind, message) => send({ id, error: { code, message, data: { kind, retryable: false } } });
  const withState = fn => {
    const state = load(statePath);
    const out = fn(state);
    save(statePath, state);
    return out;
  };

  function finish(sessionId, turnId, terminal, extra = {}) {
    const completed = withState(state => {
      const s = state.sessions[sessionId];
      const t = state.turns[turnId];
      if (!t || t.state !== 'running') return null;
      t.state = terminal;
      s.activeTurnId = null;
      s.turnCount += 1;
      s.updatedAt = iso(Date.now());
      s.lastTurn = { turnId, terminal, ...(extra.error ? { error: extra.error } : {}), ...(extra.reason ? { reason: extra.reason } : {}) };
      if (terminal === 'completed') {
        s.items.push({ itemId: `${turnId}-reply`, kind: 'agentMessage', turnId, revision: 1, status: 'completed', recordedAt: iso(Date.now()), text: `muse reply: ${t.prompt}`, messagePhase: 'finalAnswer' });
      }
      return { prompt: t.prompt };
    });
    if (!completed) return;
    const prompt = completed.prompt;
    const usage = { inputTokens: 120, outputTokens: 45, cachedTokens: 0, reasoningTokens: 0 };
    if (prompt.startsWith('[usage:partial]')) {
      notify('session/tokenUsage', { sessionId, turnId, usage: { inputTokens: 70, outputTokens: 20, cachedTokens: 0, reasoningTokens: 0 }, promptTokens: 70, totalTokens: 90 });
      notify('session/tokenUsage', { sessionId, turnId, usage: { inputTokens: 50, cachedTokens: 0, reasoningTokens: 0 }, promptTokens: 50, totalTokens: 50 });
    } else if (!prompt.startsWith('[usage:none]') && terminal === 'completed') {
      notify('session/tokenUsage', { sessionId, turnId, usage, promptTokens: 120, totalTokens: 165, cumulative: { promptTokens: 120, outputTokens: 45, totalTokens: 165, cost: { usd: 0.01, partial: false } } });
    }
    const withUsage = terminal === 'completed' && !/^\[usage:(partial|none)\]/.test(prompt);
    notify('turn/completed', { sessionId, turnId, terminal, viewCursor: `v4:${sessionId}:${Date.now()}`, durationMs: 20, ...(withUsage ? { usage } : {}), ...extra });
  }

  const handlers = {
    initialize(params, id) {
      if (process.env.FAKE_MUSE_AUTH_FAIL) return fail(id, -32603, 'internal', 'login is no longer valid; run muse login');
      send({ id, result: {
        serverInfo: { name: 'muse', version: process.env.FAKE_MUSE_VERSION || '1.4.10' }, userAgent: 'fake-muse', museHome: '/fake-muse-home',
        platformFamily: 'unix', platformOs: 'macos', schema: { version: Number(process.env.FAKE_MUSE_SCHEMA || 1), fingerprint: 'sha256:fake' },
        grantedCapabilities: [], experimentalApi: false, sessionDurability: durability, sandboxAvailability: 'available',
      } });
    },
    'session/list'(params, id) {
      const state = load(statePath);
      const filter = params.filter || {};
      let rows = Object.values(state.sessions).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (durability !== 'durable') rows = [];
      if (filter.sessionId) rows = rows.filter(s => filter.sessionId.anyOf.includes(s.sessionId ?? s.raw?.sessionId));
      if (filter.text && !process.env.FAKE_MUSE_NO_TEXT_FILTER) {
        rows = rows.filter(s => filter.text.allOf.every(term => `${s.title ?? ''} ${s.name ?? ''}`.toLowerCase().split(/\W+/).some(token => token.startsWith(term.toLowerCase()))));
      }
      const start = params.cursor ? Number(params.cursor.replace('page-', '')) : 0;
      const limit = params.limit ?? 50;
      const page = rows.slice(start, start + limit);
      const applied = {};
      if (filter.sessionId) applied.sessionId = filter.sessionId;
      if (filter.text && !process.env.FAKE_MUSE_NO_TEXT_FILTER) applied.text = filter.text;
      send({ id, result: {
        sessions: page.map(s => wireSession(s, process.pid)), nextCursor: start + limit < rows.length ? `page-${start + limit}` : null,
        ...(params.filter ? { appliedFilter: applied } : {}),
      } });
    },
    'session/read'(params, id) {
      const state = load(statePath);
      const s = state.sessions[params.sessionId];
      if (!s || s.raw !== undefined || durability !== 'durable') return fail(id, -32020, 'sessionNotFound', `session ${params.sessionId} was not found`);
      const withItems = params.excludeItems === false;
      send({ id, result: {
        session: wireSession(s, process.pid), viewCursor: `v4:${s.sessionId}:1`, pendingRequests: [],
        history: withItems ? { mode: 'inline', items: s.items, snapshot: null } : { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' },
        ...(s.lastTurn ? { lastTurn: s.lastTurn } : {}),
      } });
    },
    'session/start'(params, id) {
      const session = withState(state => {
        const sessionId = uuid(state, 'session');
        state.sessions[sessionId] = {
          sessionId, title: null, name: null, workspaceRoot: params.workspaceRoot ?? null, kind: 'root', path: durability === 'durable' ? `/fake-muse-home/sessions/${sessionId}/session.jsonl` : '',
          createdAt: iso(Date.now()), updatedAt: iso(Date.now()), turnCount: 0, loadedBy: process.pid, activeTurnId: null, extra: {}, items: [], lastTurn: null,
        };
        return state.sessions[sessionId];
      });
      send({ id, result: { session: wireSession(session, process.pid), viewCursor: `v4:${session.sessionId}:1` } });
    },
    'session/resume'(params, id) {
      const state = load(statePath);
      const s = state.sessions[params.sessionId];
      if (!s || s.raw !== undefined) return fail(id, -32020, 'sessionNotFound', `session ${params.sessionId} was not found`);
      if (s.loadedBy && s.loadedBy !== process.pid && pidAlive(s.loadedBy)) return fail(id, -32021, 'sessionInUse', 'session is in use by another host');
      // Host-death terminal for a turn its dead host left running.
      for (const t of Object.values(state.turns)) {
        if (t.session === s.sessionId && t.state === 'running' && t.host !== process.pid && !pidAlive(t.host)) {
          t.state = 'failed';
          s.activeTurnId = null;
          s.lastTurn = { turnId: t.id, terminal: 'failed', reason: 'crash_inferred' };
        }
      }
      s.loadedBy = process.pid;
      save(statePath, state);
      send({ id, result: { session: wireSession(s, process.pid), viewCursor: `v4:${s.sessionId}:1`, pendingRequests: [], history: { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' }, ...(s.lastTurn ? { lastTurn: s.lastTurn } : {}) } });
    },
    'turn/start'(params, id) {
      const text = params.input?.[0]?.text ?? '';
      const turnId = withState(state => {
        const s = state.sessions[params.sessionId];
        if (!s || s.loadedBy !== process.pid) return null;
        const tid = uuid(state, 'turn');
        state.turns[tid] = { id: tid, session: s.sessionId, prompt: text, state: 'running', host: process.pid, argv };
        s.activeTurnId = tid;
        if (!s.title) s.title = text.split('\n')[0];
        s.items.push({ itemId: `${tid}-user`, kind: 'userMessage', turnId: tid, revision: 1, status: 'completed', recordedAt: iso(Date.now()), text });
        return tid;
      });
      if (!turnId) return fail(id, -32024, 'sessionNotLoaded', 'session is not loaded on this connection');
      send({ id, result: { commandId: params.commandId, status: 'accepted', turnId, startedNewTurn: true, disposition: 'started' } });
      notify('turn/started', { sessionId: params.sessionId, turnId });
      if (text.startsWith('[hold]')) return;
      const timer = setTimeout(() => {
        timers.delete(turnId);
        if (text.startsWith('[fail:auth]')) finish(params.sessionId, turnId, 'failed', { error: { kind: 'authRequired', message: 'login is no longer valid', retryable: false } });
        else finish(params.sessionId, turnId, 'completed');
      }, 20);
      timers.set(turnId, timer);
    },
    'turn/cancel'(params, id) {
      send({ id, result: { commandId: params.commandId, status: 'accepted', turnId: params.turnId } });
      clearTimeout(timers.get(params.turnId));
      setTimeout(() => finish(params.sessionId, params.turnId, 'cancelled', { reason: 'cancelled by client' }), 5);
    },
  };

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return;
    if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, argv, method: msg.method, params: msg.params ?? {} })}\n`);
    const handler = handlers[msg.method];
    if (!handler || disabled.has(msg.method)) return fail(msg.id, -32601, 'methodNotFound', `method ${msg.method} not found`);
    handler(msg.params ?? {}, msg.id);
  }

  process.stdin.on('data', chunk => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      onLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function readFakeMuseLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

if (require.main === module) runHost();

module.exports = { seedFakeMuse, readFakeMuseLog, loadFakeMuse: load, saveFakeMuse: save };
