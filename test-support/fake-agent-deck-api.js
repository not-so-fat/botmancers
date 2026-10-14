// NOT-487: deterministic fake of the Agent Deck run HTTP API
// (Agent Deck docs/AGENT_RUN_API.md) for Botmancers tests.
//
// One handler serves both an in-process fetch seam (`fake.fetch`, for
// lib/agent-deck-api setAgentDeckApiFetch) and a real loopback HTTP server
// (`await fake.listen()`). Every request is captured with its method, path,
// query, headers, and parsed body. Runs follow a per-test script:
//
//   fake.onStart = (body, run) => ({ result, sessionId, state, files, hold, ... })
//
// A run is terminal on the first read unless the script holds it
// (`hold: true`, ended by fake.release(runId) or cancel). Prepared runs get
// a baseline and expose `files` as their candidate manifest; finalize
// enforces the documented idempotency, capability, and manifest checks and
// counts logical commits.
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS fixture consumed by standalone Node tests. */

const http = require('http');
const { createHash } = require('crypto');

const sha = (value, n = 64) => createHash('sha256').update(String(value)).digest('hex').slice(0, n);
const oid = value => createHash('sha1').update(String(value)).digest('hex');

function normalizedFinalizeBody(body) {
  const files = [...(body.files || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ ...body, files });
}

function manifestDigestOf(files) {
  return sha(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : 1))));
}

function createFakeAgentDeck(options = {}) {
  const fake = {
    token: options.token || 'adg_fake_bearer_for_tests',
    finalizationEnabled: options.finalizationEnabled !== false,
    requests: [],
    responses: [],
    runs: new Map(),
    startKeys: new Map(),
    commits: [],
    onStart: () => ({ result: 'done' }),
    onFinalize: null,
    baseCommit: options.baseCommit || oid('base'),
    server: null,
    url: null,
  };
  let counter = 0;

  function send(status, body) {
    return { status, body };
  }
  function ok(data, status = 200) {
    return send(status, { success: true, data });
  }
  function error(status, code, message = code) {
    return send(status, { success: false, error: message, error_code: code });
  }

  function status(run) {
    return {
      runId: run.runId,
      deckId: run.body.deckId,
      client: run.body.client,
      tools: run.body.tools,
      state: run.state,
      sessionId: run.sessionId,
      startedAt: '2026-10-14T00:00:00.000Z',
      lastEventAt: null,
      finalization: run.baseline
        ? { baselineRef: run.baseline.ref, baselineDigest: run.baseline.digest, state: run.finalized ? 'finalized' : 'prepared', commit: run.finalized ? run.finalized.result.commit : null }
        : null,
    };
  }

  function terminate(run, state) {
    if (['ended', 'error', 'died', 'canceled'].includes(run.state)) return;
    const seq = () => run.events.length + 1;
    if (state === 'canceled') {
      run.events.push({ seq: seq(), ts: 'ts', type: 'canceled', sessionId: run.sessionId });
    } else if (state === 'ended') {
      const result = typeof run.script.result === 'function' ? run.script.result(run) : run.script.result;
      run.events.push({ seq: seq(), ts: 'ts', type: 'result', subtype: 'success', result, sessionId: run.sessionId });
      run.events.push({ seq: seq(), ts: 'ts', type: 'end', sessionId: run.sessionId });
    } else if (state === 'error') {
      run.events.push({ seq: seq(), ts: 'ts', type: 'error', message: run.script.errorMessage || 'client failed', sessionId: run.sessionId });
    }
    run.state = state;
  }

  fake.release = runId => {
    const run = fake.runs.get(runId);
    if (run) terminate(run, run.script.state || 'ended');
  };

  fake.handle = (method, rawUrl, headers, bodyText) => {
    const parsedUrl = new URL(rawUrl, 'http://fake');
    const path = parsedUrl.pathname;
    let body = null;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    const lower = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    fake.requests.push({ method, path, query: Object.fromEntries(parsedUrl.searchParams), headers: lower, body });
    if (lower.authorization !== `Bearer ${fake.token}`) return error(401, 'GRANT_REQUIRED', 'Grant required');

    if (method === 'POST' && path === '/api/agent-runs') {
      const key = lower['idempotency-key'];
      if (!key) return error(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const prior = fake.startKeys.get(key);
      if (prior) {
        if (prior.text !== JSON.stringify(body)) return error(409, 'IDEMPOTENCY_CONFLICT');
        const run = fake.runs.get(prior.runId);
        return ok({ runId: run.runId, state: run.state }, 202);
      }
      if (body.prepareFinalization && body.tools !== 'edit') return error(422, 'FINALIZATION_INVALID', 'prepareFinalization requires tools "edit"');
      const script = { ...(fake.onStart(body) || {}) };
      if (script.startError) return error(script.startError.status, script.startError.code);
      counter += 1;
      const runId = `run-20261014T000000-${sha(`run-${counter}`, 6)}`;
      const run = {
        runId,
        body,
        script,
        state: 'running',
        sessionId: body.resumeSessionId || script.sessionId || `ses-${runId}`,
        events: [{ seq: 1, ts: 'ts', type: 'text', text: 'working' }],
        baseline: body.prepareFinalization ? { ref: `bl_${sha(`bl-${runId}`, 24)}`, digest: sha(`baseline-${runId}`) } : null,
        files: script.files || [],
        baseCommit: script.baseCommit || fake.baseCommit,
        changesError: script.changesError || null,
        finalized: null,
      };
      if (script.sessionId && body.resumeSessionId) run.sessionId = script.sessionId;
      fake.runs.set(runId, run);
      fake.startKeys.set(key, { runId, text: JSON.stringify(body) });
      if (!script.hold) terminate(run, script.state || 'ended');
      return ok({ runId, state: 'starting' }, 202);
    }

    const match = /^\/api\/agent-runs\/([^/]+)(?:\/(events|cancel|changes|finalize))?$/.exec(path);
    if (!match) return error(404, 'NOT_FOUND');
    const run = fake.runs.get(decodeURIComponent(match[1]));
    if (!run) return error(404, 'RUN_NOT_FOUND');
    const action = match[2] || null;

    if (method === 'GET' && action === null) return ok(status(run));
    if (method === 'GET' && action === 'events') {
      const after = Number(parsedUrl.searchParams.get('after') || 0);
      const events = run.events.filter(event => event.seq > after);
      return ok({ runId: run.runId, state: run.state, events, nextCursor: String(events.length ? events[events.length - 1].seq : after) });
    }
    if (method === 'POST' && action === 'cancel') {
      // A refused cancel leaves the run going.
      if (run.script.cancelError) return error(run.script.cancelError.status, run.script.cancelError.code);
      terminate(run, 'canceled');
      return ok(status(run));
    }
    if (method === 'GET' && action === 'changes') {
      if (!run.baseline) return error(409, 'FINALIZATION_NOT_PREPARED');
      if (!['ended', 'error', 'died', 'canceled'].includes(run.state)) return error(409, 'RUN_NOT_TERMINAL');
      if (run.changesError) return error(run.changesError.status, run.changesError.code);
      return ok({
        runId: run.runId,
        baselineRef: run.baseline.ref,
        baselineDigest: run.baseline.digest,
        baseCommit: run.baseCommit,
        files: run.files,
        manifestDigest: manifestDigestOf(run.files),
      });
    }
    if (method === 'POST' && action === 'finalize') {
      if (!fake.finalizationEnabled) return error(403, 'FINALIZATION_CAPABILITY_REQUIRED');
      if (!run.baseline) return error(409, 'FINALIZATION_NOT_PREPARED');
      const key = lower['idempotency-key'];
      if (!key) return error(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const normalized = normalizedFinalizeBody(body);
      if (run.finalized) {
        if (run.finalized.key === key && run.finalized.normalized === normalized) return ok(run.finalized.result);
        return error(409, 'IDEMPOTENCY_CONFLICT');
      }
      if (fake.onFinalize) {
        const forced = fake.onFinalize(body, run);
        if (forced) return error(forced.status, forced.code, forced.message || forced.code);
      }
      if (body.baselineDigest !== run.baseline.digest) return error(409, 'BASELINE_MISMATCH');
      if (body.expectedBaseCommit !== run.baseCommit) return error(409, 'BASE_MISMATCH');
      if (normalizedFinalizeBody({ files: body.files }) !== normalizedFinalizeBody({ files: run.files })) return error(409, 'DIGEST_MISMATCH');
      const commit = oid(`commit-${run.runId}-${normalized}`);
      const result = {
        runId: run.runId,
        finalizationState: 'finalized',
        commit,
        tree: oid(`tree-${commit}`),
        parent: run.baseCommit,
        manifestDigest: manifestDigestOf(body.files),
        fileCount: body.files.length,
        reviewId: body.reviewId,
      };
      run.finalized = { key, normalized, result };
      fake.commits.push({ runId: run.runId, commit, files: body.files.map(file => file.path) });
      return ok(result);
    }
    return error(404, 'NOT_FOUND');
  };

  fake.fetch = async (url, init) => {
    const response = fake.handle(init.method, url, init.headers, init.body);
    fake.responses.push(JSON.parse(JSON.stringify(response.body)));
    return { status: response.status, json: async () => JSON.parse(JSON.stringify(response.body)) };
  };

  fake.listen = () => new Promise(resolve => {
    fake.server = http.createServer((req, res) => {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const response = fake.handle(req.method, req.url, req.headers, text);
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.body));
      });
    });
    fake.server.listen(0, '127.0.0.1', () => {
      fake.url = `http://127.0.0.1:${fake.server.address().port}`;
      resolve(fake.url);
    });
  });

  fake.close = () => new Promise(resolve => (fake.server ? fake.server.close(() => resolve()) : resolve()));

  fake.calls = (method, suffix) => fake.requests.filter(r => r.method === method && (suffix === undefined || r.path.endsWith(suffix)));

  return fake;
}

module.exports = { createFakeAgentDeck, manifestDigestOf, sha, oid };
