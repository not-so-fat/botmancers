// NOT-503: deterministic fake direct SessionProvider (lib/session-provider).
// A stand-in for a native coding-agent runtime: its sessions and turns live
// in one JSON state file, so they outlive the Botmancers process that
// talks to it (a restart reopens the same file). No network, no Agent
// Deck, no clock: ids and times come from a counter in the state file.
//
// Turn behavior: a turn completes on its first observe with output
// `fake reply #<n>: <prompt>`, appended to the session transcript. A prompt
// starting with `[hold]` stays running until cancelled (or until the
// observer's signal/deadline ends the wait). Every provider call is logged
// in state.calls so tests can count them.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS fixture consumed by standalone Node tests. */
const fs = require('fs');

const BASE = Date.UTC(2026, 9, 1, 8, 0, 0);
const FULL_CAPABILITIES = {
  list: true, search: true, read: true, resume: true, start: true, cancel: true, usage: true,
  authorities: ['read_only', 'workspace_write'], max_page_size: 3,
};

function emptyState() {
  return { counter: 0, sessions: {}, order: [], turns: {}, keys: {}, calls: [] };
}

function load(statePath) {
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : emptyState();
}

function save(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function tick(state) {
  state.counter += 1;
  return BASE + state.counter * 1000;
}

// Seeds sessions that "existed before Botmancers". Each: { id, title,
// workspace, lifecycle, resumable, busy, transcript: [[role, text], ...] }.
function seedFakeProvider(statePath, sessions) {
  const state = load(statePath);
  for (const session of sessions) {
    const at = tick(state);
    state.sessions[session.id] = {
      title: session.title ?? null, workspace: session.workspace ?? null, created_at: at, updated_at: at,
      lifecycle: session.lifecycle ?? 'open', resumable: session.resumable ?? true, busy: session.busy ?? false, deleted: false,
      transcript: (session.transcript ?? []).map(([role, text], i) => ({ seq: i + 1, role, text, at: at + i })),
    };
    state.order.push(session.id);
  }
  save(statePath, state);
}

function mutateFakeProvider(statePath, fn) {
  const state = load(statePath);
  fn(state);
  save(statePath, state);
}

const ok = value => ({ ok: true, value });
const err = (code, message) => ({ ok: false, error: { code, message } });

function record(id, s) {
  return {
    provider_session_id: id, title: s.title, workspace: s.workspace, created_at: s.created_at, updated_at: s.updated_at,
    lifecycle: s.lifecycle, resumable: s.resumable, busy: s.busy,
  };
}

function inProviderScope(scope, id, s) {
  if (scope.kind === 'all_provider_sessions') return true;
  if (scope.kind === 'sessions') return scope.provider_session_ids.includes(id);
  return !!s.workspace && scope.workspaces.some(root => s.workspace === root || s.workspace.startsWith(`${root.replace(/\/+$/, '')}/`));
}

// options: { statePath, kind?, capabilities?, ignoreScope? (return every
// session so Botmancers' own scope check is exercised) }.
function createFakeSessionProvider(options) {
  const { statePath } = options;
  const kind = options.kind ?? 'fake-direct';
  const capabilities = { ...FULL_CAPABILITIES, ...(options.capabilities ?? {}) };
  const call = (state, op, detail = {}) => state.calls.push({ op, ...detail });
  const withState = fn => {
    const state = load(statePath);
    const out = fn(state);
    save(statePath, state);
    return out;
  };

  function finishTurn(state, turnId) {
    const turn = state.turns[turnId];
    const session = state.sessions[turn.session];
    const at = tick(state);
    turn.state = 'completed';
    turn.output = `fake reply #${state.counter}: ${turn.prompt}`;
    turn.finished_at = at;
    session.busy = false;
    session.updated_at = at;
    session.transcript.push({ seq: session.transcript.length + 1, role: 'assistant', text: turn.output, at });
  }

  function beginTurn(state, sessionId, input) {
    const existing = state.keys[input.idempotency_key];
    if (existing) return state.turns[existing];
    const at = tick(state);
    const id = `fake-turn-${state.counter}-SECRET`;
    const session = state.sessions[sessionId];
    session.busy = true;
    session.updated_at = at;
    session.transcript.push({ seq: session.transcript.length + 1, role: 'user', text: input.prompt, at });
    state.turns[id] = { id, session: sessionId, prompt: input.prompt, authority: input.authority, state: 'running', output: null, finished_at: null, correlation: input.correlation };
    // NOT-509 usage hook: the next queued value is this turn's reported
    // usage verbatim (normalized, Codex/Claude event shapes, or malformed).
    if (Array.isArray(state.usageQueue) && state.usageQueue.length > 0) state.turns[id].usage = state.usageQueue.shift();
    state.keys[input.idempotency_key] = id;
    return state.turns[id];
  }

  const view = turn => ({
    status: turn.state === 'completed' ? 'completed' : turn.state === 'cancelled' ? 'cancelled' : 'failed',
    provider_session_id: turn.session,
    output: turn.output,
    failure: turn.state === 'cancelled' ? { code: 'cancelled', message: 'cancelled' } : null,
    usage: turn.usage !== undefined ? turn.usage : capabilities.usage ? { input_tokens: turn.prompt.length, output_tokens: (turn.output ?? '').length } : null,
    finished_at: turn.finished_at,
  });

  return {
    kind,
    capabilities: () => ({ ...capabilities, authorities: [...capabilities.authorities] }),

    async listSessions(input) {
      return withState(state => {
        call(state, 'listSessions', { limit: input.limit, query: input.query ?? null, cursor: input.cursor ?? null });
        const query = (input.query ?? '').toLowerCase();
        const visible = state.order.filter(id => {
          const s = state.sessions[id];
          if (s.deleted) return false;
          if (query && !(s.title ?? '').toLowerCase().includes(query)) return false;
          return options.ignoreScope || inProviderScope(input.scope, id, s);
        });
        const start = input.cursor ? Number(input.cursor) : 0;
        const items = visible.slice(start, start + input.limit).map(id => record(id, state.sessions[id]));
        const next = start + input.limit < visible.length ? String(start + input.limit) : null;
        return ok({ items, next_cursor: next });
      });
    },

    async getSession(input) {
      return withState(state => {
        call(state, 'getSession');
        const s = state.sessions[input.provider_session_id];
        return ok(s && !s.deleted ? record(input.provider_session_id, s) : null);
      });
    },

    async readTranscript(input) {
      return withState(state => {
        call(state, 'readTranscript', { limit: input.limit, cursor: input.cursor ?? null });
        const s = state.sessions[input.provider_session_id];
        if (!s || s.deleted) return err('not_found', 'no such session');
        const start = input.cursor ? Number(input.cursor) : 0;
        const items = s.transcript.slice(start, start + input.limit);
        return ok({ items, next_cursor: start + input.limit < s.transcript.length ? String(start + input.limit) : null });
      });
    },

    async startSession(input) {
      return withState(state => {
        call(state, 'startSession', { authority: input.authority, workspace: input.workspace });
        const existing = state.keys[input.idempotency_key];
        if (existing) return ok({ provider_turn_id: existing, provider_session_id: state.turns[existing].session });
        const at = tick(state);
        const id = `fake-native-started-${state.counter}-SECRET`;
        state.sessions[id] = {
          title: null, workspace: input.workspace, created_at: at, updated_at: at,
          lifecycle: 'open', resumable: true, busy: false, deleted: false, transcript: [],
        };
        state.order.push(id);
        const turn = beginTurn(state, id, input);
        return ok({ provider_turn_id: turn.id, provider_session_id: id });
      });
    },

    async sendTurn(input) {
      return withState(state => {
        call(state, 'sendTurn', { authority: input.authority });
        const existing = state.keys[input.idempotency_key];
        if (existing) return ok({ provider_turn_id: existing, provider_session_id: state.turns[existing].session });
        const s = state.sessions[input.provider_session_id];
        if (!s || s.deleted) return err('not_found', 'no such session');
        if (!s.resumable) return err('not_resumable', 'cannot resume');
        if (s.busy) return err('busy', 'busy');
        const turn = beginTurn(state, input.provider_session_id, input);
        return ok({ provider_turn_id: turn.id, provider_session_id: input.provider_session_id });
      });
    },

    async observeTurn(input) {
      const step = () => withState(state => {
        const turn = state.turns[input.provider_turn_id];
        if (!turn) return err('not_found', 'no such turn');
        if (turn.state === 'running' && !turn.prompt.startsWith('[hold]')) finishTurn(state, turn.id);
        return turn.state === 'running' ? null : ok(view(turn));
      });
      mutateFakeProvider(statePath, state => call(state, 'observeTurn'));
      for (;;) {
        const out = step();
        if (out) return out;
        if (input.signal?.aborted) return err('cancelled', 'observe aborted');
        if (typeof input.deadline_at === 'number' && Date.now() >= input.deadline_at) return err('timed_out', 'observe deadline');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },

    async cancelTurn(input) {
      return withState(state => {
        call(state, 'cancelTurn');
        const turn = state.turns[input.provider_turn_id];
        if (!turn) return err('not_found', 'no such turn');
        if (turn.state !== 'running') return ok('already_terminal');
        turn.state = 'cancelled';
        turn.finished_at = tick(state);
        state.sessions[turn.session].busy = false;
        return ok('cancelled');
      });
    },
  };
}

function providerCalls(statePath, op) {
  const calls = load(statePath).calls;
  return op ? calls.filter(entry => entry.op === op).length : calls.length;
}

module.exports = { BASE, FULL_CAPABILITIES, createFakeSessionProvider, seedFakeProvider, mutateFakeProvider, providerCalls, loadFakeState: load };
