#!/usr/bin/env node
// NOT-514 Cursor probe: does a `cursor-agent --print` turn load an MCP
// server from configuration Botmancers could control per turn, and does
// that server see a per-process context or any ambient chat identity?
// Prints only presence, shape, and salted-fingerprint comparisons.
//
//   node scripts/not-514-cursor-mcp-probe.js          isolated HOME (no login)
//   node scripts/not-514-cursor-mcp-probe.js --home   the logged-in HOME (spends usage)
//
// The tested CLI has no per-invocation MCP flag (`--help` lists
// --approve-mcps only), so the only seams are files: the workspace's
// .cursor/mcp.json (inside the user's repository) or ~/.cursor/mcp.json
// (shared by every chat). The probe writes a project entry into a fresh
// temp workspace whose env references ${env:BOTMANCERS_SESSION_CONTEXT}
// and runs one turn with that variable set.
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

function run(bin, args, opts) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'not514-cursor-'));
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const marker = `bmsc_${crypto.randomBytes(32).toString('base64url')}`;
  const out = path.join(tmp, 'project.jsonl');
  fs.writeFileSync(path.join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { probe: {
    command: process.execPath, args: [PROBE, 'mcp-stdio'],
    env: { NOT514_PROBE_OUT: out, NOT514_PROBE_SALT: salt, BOTMANCERS_SESSION_CONTEXT: '${env:BOTMANCERS_SESSION_CONTEXT}' },
  } } }));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^CURSOR_/.test(key)) env[key] = value;
  if (!HOME_CONFIG) env.HOME = path.join(tmp, 'home');
  if (!HOME_CONFIG) fs.mkdirSync(env.HOME);
  let version = 'unavailable';
  try {
    version = execFileSync('cursor-agent', ['--version'], { encoding: 'utf8', env }).trim();
  } catch { /* reported below */ }
  const r = await run('cursor-agent', ['--print', '--output-format', 'stream-json', '--approve-mcps', '--trust', '--workspace', workspace, 'Reply with the single word ok.'],
    { cwd: workspace, env: { ...env, BOTMANCERS_SESSION_CONTEXT: marker } });
  let initFp = null;
  for (const line of r.stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && typeof event.session_id === 'string') initFp = fingerprint(salt, event.session_id);
    } catch { /* not an event */ }
  }
  const reports = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const signals = reports[0] ? reports[0].signals : {};
  const ctx = signals.BOTMANCERS_SESSION_CONTEXT;
  const result = {
    case: 'print_project_mcp_json',
    exit: r.signal ? `signal:${r.signal}` : r.code,
    failure_kind: r.code === 0 ? null : /log ?in|auth|api key|unauthor/i.test(r.stdout + r.stderr) ? 'not_logged_in' : 'other',
    stream_session_id_reported: initFp !== null,
    mcp_spawned: reports.length > 0,
    per_process_context_delivered: ctx && ctx.present ? ctx.fingerprint === fingerprint(salt, marker) : null,
    context_shape_if_not_expanded: ctx && ctx.present && ctx.fingerprint !== fingerprint(salt, marker) ? ctx.shape : null,
    ambient_chat_env: Object.fromEntries(['CURSOR_SESSION_ID', 'CURSOR_CHAT_ID', 'CURSOR_AGENT', 'CURSOR_TRACE_ID'].map(name => [name, signals[name] ? signals[name].present : null])),
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ probe: 'not-514-cursor-mcp-probe', client: version, config: HOME_CONFIG ? 'home' : 'isolated', results: [result] }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'probe failed');
  process.exit(1);
});
