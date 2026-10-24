#!/usr/bin/env node
// NOT-514 Codex probe: can Botmancers hand one Codex run (exec) or one
// thread (app-server) its own MCP server configuration, and what session
// identity does that MCP subprocess see? Prints only presence, shape, and
// salted-fingerprint comparisons, never a value.
//
//   node scripts/not-514-codex-mcp-probe.js            isolated CODEX_HOME (no login)
//   node scripts/not-514-codex-mcp-probe.js --home     the logged-in CODEX_HOME (spends usage)
//
// Cases:
//   exec        codex exec --json -c mcp_servers.probe.*=...    (per-process override)
//   app_thread  codex app-server; thread/start { config: { mcp_servers: { probe } } }
//               (per-thread override on a shared app-server process)
// For app_thread the probe compares the MCP subprocess's fingerprint
// marker (a per-thread value Botmancers put in the probe server's env via
// the thread config) with the thread it was started for.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME_CONFIG = process.argv.includes('--home');
const TIMEOUT_MS = Number(process.env.NOT514_CASE_TIMEOUT_MS || 30000);
const PROBE = path.join(__dirname, 'not-514-identity-probe.js');

const fingerprint = (salt, value) => crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
const tomlString = value => JSON.stringify(value);
const readReports = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

function run(bin, args, opts) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.end('Reply with the single word ok.');
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function execCase(env, workspace, tmp, salt) {
  const out = path.join(tmp, 'exec.jsonl');
  const marker = crypto.randomUUID();
  const config = [
    '-c', `mcp_servers.probe.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.probe.args=[${tomlString(PROBE)}, "mcp-stdio"]`,
    '-c', `mcp_servers.probe.env={ NOT514_PROBE_OUT = ${tomlString(out)}, NOT514_PROBE_SALT = ${tomlString(salt)}, BOTMANCERS_SESSION_CONTEXT = ${tomlString(marker)} }`,
    '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
  ];
  const r = await run('codex', ['exec', '--json', '--skip-git-repo-check', '-C', workspace, ...config, '-'], { cwd: workspace, env });
  let threadFp = null;
  for (const line of r.stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadFp = fingerprint(salt, event.thread_id);
    } catch { /* not an event line */ }
  }
  const reports = readReports(out);
  const signals = reports[0] ? reports[0].signals : {};
  return {
    case: 'exec',
    exit: r.signal ? `signal:${r.signal}` : r.code,
    mcp_spawned: reports.length > 0,
    per_run_context_delivered: signals.BOTMANCERS_SESSION_CONTEXT ? signals.BOTMANCERS_SESSION_CONTEXT.fingerprint === fingerprint(salt, marker) : null,
    thread_started_reported: threadFp !== null,
    ambient_thread_env: Object.fromEntries(['CODEX_THREAD_ID', 'CODEX_SESSION_ID'].map(name => [name, signals[name] ? signals[name].present : null])),
    ambient_matches_thread: signals.CODEX_THREAD_ID && signals.CODEX_THREAD_ID.present && threadFp ? signals.CODEX_THREAD_ID.fingerprint === threadFp : null,
  };
}

function appServerCase(env, workspace, tmp, salt) {
  return new Promise(resolve => {
    const child = spawn('codex', ['app-server'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    const finish = result => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(() => finish({ case: 'app_thread', exit: 'timeout', threads: [] }), TIMEOUT_MS * 2);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch { /* ignore */ }
      }
    });
    child.on('error', () => finish({ case: 'app_thread', exit: 'spawn_failed', threads: [] }));
    const rpc = (method, params) => new Promise(done => {
      const id = nextId++;
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const init = await rpc('initialize', { clientInfo: { name: 'not-514-probe', version: '1' } });
      if (init.error) return finish({ case: 'app_thread', exit: 'initialize_failed', threads: [] });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      // Two threads on one shared app-server process, each with its own context marker.
      const threads = [];
      for (const label of ['A', 'B']) {
        const out = path.join(tmp, `thread-${label}.jsonl`);
        const marker = crypto.randomUUID();
        const started = await rpc('thread/start', {
          cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
          config: { mcp_servers: { probe: { command: process.execPath, args: [PROBE, 'mcp-stdio'], env: {
            NOT514_PROBE_OUT: out, NOT514_PROBE_SALT: salt, BOTMANCERS_SESSION_CONTEXT: marker,
          } } } },
        });
        const threadId = started.result && started.result.thread && started.result.thread.id;
        if (threadId) await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word ok.' }] });
        threads.push({ label, out, marker, ok: !!threadId, error: started.error ? started.error.code : null });
      }
      await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 8000)));
      finish({
        case: 'app_thread',
        exit: 'ok',
        threads: threads.map(t => {
          const reports = readReports(t.out);
          const ctx = reports[0] && reports[0].signals.BOTMANCERS_SESSION_CONTEXT;
          return {
            thread: t.label, thread_started: t.ok, rpc_error: t.error,
            mcp_spawned: reports.length > 0,
            per_thread_context_delivered: ctx && ctx.present ? ctx.fingerprint === fingerprint(salt, t.marker) : null,
            ambient_thread_env: reports[0] ? reports[0].signals.CODEX_THREAD_ID.present : null,
          };
        }),
      });
    })().catch(() => finish({ case: 'app_thread', exit: 'probe_error', threads: [] }));
  });
}

// The header form on a shared app-server: two threads, each with an HTTP
// MCP entry whose http_headers carry that thread's own context, against
// one loopback endpoint. Each thread's requests must carry only its value.
async function appServerHttpCase(env, workspace, tmp, salt) {
  const { serveMcpHttp } = require('./not-514-identity-probe');
  const out = path.join(tmp, 'app-http.jsonl');
  const server = await serveMcpHttp({ out, salt });
  const markers = { A: `bmsc_${crypto.randomBytes(32).toString('base64url')}`, B: `bmsc_${crypto.randomBytes(32).toString('base64url')}` };
  const result = await new Promise(resolve => {
    const child = spawn('codex', ['app-server'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    const finish = value => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(() => finish({ exit: 'timeout', started: [] }), TIMEOUT_MS * 2);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch { /* ignore */ }
      }
    });
    child.on('error', () => finish({ exit: 'spawn_failed', started: [] }));
    const rpc = (method, params) => new Promise(done => {
      const id = nextId++;
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      await rpc('initialize', { clientInfo: { name: 'not-514-probe', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      const started = [];
      for (const label of ['A', 'B']) {
        const reply = await rpc('thread/start', {
          cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
          config: { mcp_servers: { botmancers: { url: server.url, http_headers: { 'Botmancers-Session-Context': markers[label] } } } },
        });
        started.push(!!(reply.result && reply.result.thread && reply.result.thread.id));
      }
      await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 8000)));
      finish({ exit: 'ok', started });
    })().catch(() => finish({ exit: 'probe_error', started: [] }));
  });
  await server.close();
  const reports = readReports(out);
  const seen = new Set(reports.filter(r => r.context_header.present).map(r => r.context_header.fingerprint));
  return {
    case: 'app_thread_http_header_context',
    exit: result.exit,
    threads_started: result.started,
    mcp_requests: reports.length,
    requests_without_context: reports.filter(r => !r.context_header.present).length,
    distinct_contexts_seen: seen.size,
    every_context_is_a_thread_marker: [...seen].every(fp => fp === fingerprint(salt, markers.A) || fp === fingerprint(salt, markers.B)),
    both_threads_delivered: seen.has(fingerprint(salt, markers.A)) && seen.has(fingerprint(salt, markers.B)),
  };
}

// One JSON-RPC session against a fresh `codex app-server`.
function appServer(env, workspace, body) {
  return new Promise(resolve => {
    const child = spawn('codex', ['app-server'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    const finish = value => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(() => finish({ exit: 'timeout' }), TIMEOUT_MS * 2);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch { /* ignore */ }
      }
    });
    child.on('error', () => finish({ exit: 'spawn_failed' }));
    const rpc = (method, params) => new Promise(done => {
      const id = nextId++;
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      await rpc('initialize', { clientInfo: { name: 'not-514-probe', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      finish({ exit: 'ok', ...(await body(rpc)) });
    })().catch(() => finish({ exit: 'probe_error' }));
  });
}

// Exact resume: a persisted thread started under context A is resumed by a
// new app-server process (a Botmancers or Codex restart) with context B.
// The MCP subprocess after the resume must see B, never A.
async function resumeCase(env, workspace, tmp, salt) {
  const entry = (out, marker) => ({ probe: { command: process.execPath, args: [PROBE, 'mcp-stdio'], env: { NOT514_PROBE_OUT: out, NOT514_PROBE_SALT: salt, BOTMANCERS_SESSION_CONTEXT: marker } } });
  const outA = path.join(tmp, 'resume-A.jsonl');
  const outB = path.join(tmp, 'resume-B.jsonl');
  const markerA = crypto.randomUUID();
  const markerB = crypto.randomUUID();
  const started = await appServer(env, workspace, async rpc => {
    const reply = await rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, config: { mcp_servers: entry(outA, markerA) } });
    const threadId = reply.result && reply.result.thread && reply.result.thread.id;
    if (threadId) await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word ok.' }] });
    await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 6000)));
    return { threadId };
  });
  if (!started.threadId) return { case: 'resume_new_process', exit: started.exit, thread_started: false };
  const resumed = await appServer(env, workspace, async rpc => {
    const reply = await rpc('thread/resume', { threadId: started.threadId, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, config: { mcp_servers: entry(outB, markerB) } });
    const ok = !!(reply.result && reply.result.thread);
    if (ok) await rpc('turn/start', { threadId: started.threadId, input: [{ type: 'text', text: 'Reply with the single word ok.' }] });
    await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 6000)));
    return { resumed: ok, error: reply.error ? reply.error.code : null };
  });
  // The same thread resumed again inside one long-lived app-server (the
  // way Botmancers keeps it): which context does that thread's MCP see?
  const outC = path.join(tmp, 'resume-C.jsonl');
  const outD = path.join(tmp, 'resume-D.jsonl');
  const markerC = crypto.randomUUID();
  const markerD = crypto.randomUUID();
  const same = await appServer(env, workspace, async rpc => {
    await rpc('thread/resume', { threadId: started.threadId, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, config: { mcp_servers: entry(outC, markerC) } });
    await rpc('turn/start', { threadId: started.threadId, input: [{ type: 'text', text: 'Reply with the single word ok.' }] });
    await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 5000)));
    const again = await rpc('thread/resume', { threadId: started.threadId, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, config: { mcp_servers: entry(outD, markerD) } });
    await rpc('turn/start', { threadId: started.threadId, input: [{ type: 'text', text: 'Reply with the single word ok.' }] });
    await new Promise(done => setTimeout(done, Math.min(TIMEOUT_MS, 5000)));
    return { again_ok: !!(again.result && again.result.thread) };
  });
  const c = readReports(outC);
  const d = readReports(outD);
  const a = readReports(outA);
  const b = readReports(outB);
  const ctxB = b[0] && b[0].signals.BOTMANCERS_SESSION_CONTEXT;
  const sameProcess = {
    case: 'resume_same_process',
    exit: same.exit,
    second_resume_ok: same.again_ok === true,
    first_context_spawned: c.length > 0,
    second_context_spawned: d.length > 0,
  };
  resumeCase.extra = sameProcess;
  return {
    case: 'resume_new_process',
    exit: resumed.exit,
    thread_started: true,
    resumed: resumed.resumed === true,
    rpc_error: resumed.error ?? null,
    start_context_spawned: a.length > 0,
    resume_context_spawned: b.length > 0,
    resume_sees_new_context: ctxB && ctxB.present ? ctxB.fingerprint === fingerprint(salt, markerB) : null,
    resume_sees_old_context: ctxB && ctxB.present ? ctxB.fingerprint === fingerprint(salt, markerA) : null,
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'not514-codex-'));
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(workspace);
  const salt = crypto.randomBytes(16).toString('hex');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^CODEX_/.test(key)) env[key] = value;
  if (!HOME_CONFIG) {
    env.CODEX_HOME = path.join(tmp, 'codex-home');
    fs.mkdirSync(env.CODEX_HOME);
  } else if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  let version = 'unavailable';
  try {
    version = execFileSync('codex', ['--version'], { encoding: 'utf8', env }).trim();
  } catch { /* reported below */ }
  const results = [
    await execCase(env, workspace, tmp, salt), await appServerCase(env, workspace, tmp, salt), await appServerHttpCase(env, workspace, tmp, salt),
    await resumeCase(env, workspace, tmp, salt),
  ];
  if (resumeCase.extra) results.push(resumeCase.extra);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ probe: 'not-514-codex-mcp-probe', client: version, config: HOME_CONFIG ? 'home' : 'isolated', results }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'probe failed');
  process.exit(1);
});
