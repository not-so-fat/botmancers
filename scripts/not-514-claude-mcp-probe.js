#!/usr/bin/env node
// NOT-514 Claude Code lifecycle probe: which session id a stdio MCP
// subprocess sees as CLAUDE_CODE_SESSION_ID, per launch shape, compared
// with the id Botmancers would have chosen, without printing either.
//
//   node scripts/not-514-claude-mcp-probe.js            isolated CLAUDE_CONFIG_DIR (no login)
//   node scripts/not-514-claude-mcp-probe.js --home     the logged-in config (spends usage,
//                                                       writes real sessions under a temp workspace)
//
// Cases, in order, on one fresh session id S in a fresh temp workspace:
//   new        claude -p --session-id S
//   resume     claude -p --resume S
//   continue   claude -p --continue            (implicit: "most recent" in this cwd)
//   fork       claude -p --resume S --fork-session
// For each: did Claude Code spawn the MCP subprocess, was the variable
// present, did its salted fingerprint equal S's. A last case serves a
// loopback HTTP MCP endpoint and checks that a per-turn --mcp-config header
// built from an ${ENV} reference reaches it on every request. Interactive /clear and a
// client restart cannot be driven headlessly; see probe-results.md for the
// manual steps with `scripts/not-514-identity-probe.js mcp-stdio`.
// The inherited CLAUDE_CODE_* variables of a parent Claude Code are removed
// first so they cannot leak into the result.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME_CONFIG = process.argv.includes('--home');
const TIMEOUT_MS = Number(process.env.NOT514_CASE_TIMEOUT_MS || 45000);
const PROBE = path.join(__dirname, 'not-514-identity-probe.js');

function fingerprint(salt, value) {
  return crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
}

const readLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'not514-claude-'));
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(workspace);
  const salt = crypto.randomBytes(16).toString('hex');
  const sessionId = crypto.randomUUID();
  const expected = fingerprint(salt, sessionId);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^CLAUDE_?CODE/.test(key)) env[key] = value;
  if (!HOME_CONFIG) {
    env.CLAUDE_CONFIG_DIR = path.join(tmp, 'config');
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  }
  let version = 'unavailable';
  try {
    version = execFileSync('claude', ['--version'], { encoding: 'utf8', env }).trim();
  } catch { /* reported below */ }
  const cases = [
    ['new', ['--session-id', sessionId]],
    ['resume', ['--resume', sessionId]],
    ['continue', ['--continue']],
    ['fork', ['--resume', sessionId, '--fork-session']],
  ];
  const results = [];
  for (const [name, target] of cases) {
    const out = path.join(tmp, `${name}.jsonl`);
    const mcp = path.join(tmp, `${name}.mcp.json`);
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { probe: {
      type: 'stdio', command: process.execPath, args: [PROBE, 'mcp-stdio'], env: { NOT514_PROBE_OUT: out, NOT514_PROBE_SALT: salt },
    } } }));
    const r = await run('claude', ['-p', '--strict-mcp-config', '--mcp-config', mcp, '--output-format', 'json', ...target, 'Reply with the single word ok.'], { cwd: workspace, env });
    const reports = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const signal = reports[0] && reports[0].signals.CLAUDE_CODE_SESSION_ID;
    let reported = null;
    try {
      const parsed = JSON.parse(r.stdout);
      reported = typeof parsed.session_id === 'string' ? fingerprint(salt, parsed.session_id) : null;
    } catch { /* not JSON: login or startup failure */ }
    results.push({
      case: name,
      exit: r.signal ? `signal:${r.signal}` : r.code,
      mcp_spawned: reports.length > 0,
      env_present: signal ? signal.present : null,
      env_shape: signal && signal.present ? signal.shape : null,
      env_matches_S: signal && signal.present ? signal.fingerprint === expected : null,
      // The id the client reported as this run's session, versus S and versus the env.
      result_matches_S: reported === null ? null : reported === expected,
      env_matches_result: reported === null || !signal || !signal.present ? null : signal.fingerprint === reported,
      failure_kind: r.code === 0 ? null : /log ?in|auth|api key/i.test(r.stdout + r.stderr) ? 'not_logged_in' : 'other',
    });
  }
  // The header form of a Botmancers-minted context on an HTTP MCP entry:
  // the per-turn --mcp-config names the header with an ${ENV} reference, the
  // turn's process env holds the value (never argv).
  const { serveMcpHttp } = require('./not-514-identity-probe');
  const httpOut = path.join(tmp, 'http.jsonl');
  const server = await serveMcpHttp({ out: httpOut, salt });
  const marker = `bmsc_${crypto.randomBytes(32).toString('base64url')}`;
  const httpMcp = path.join(tmp, 'http.mcp.json');
  fs.writeFileSync(httpMcp, JSON.stringify({ mcpServers: { botmancers: {
    type: 'http', url: server.url, headers: { 'Botmancers-Session-Context': '${BOTMANCERS_SESSION_CONTEXT}' },
  } } }));
  const httpRun = await run('claude', ['-p', '--strict-mcp-config', '--mcp-config', httpMcp, '--output-format', 'json', '--session-id', crypto.randomUUID(), 'Reply with the single word ok.'],
    { cwd: workspace, env: { ...env, BOTMANCERS_SESSION_CONTEXT: marker } });
  await server.close();
  const httpReports = readLines(httpOut);
  results.push({
    case: 'new_http_header_context',
    exit: httpRun.signal ? `signal:${httpRun.signal}` : httpRun.code,
    mcp_requests: httpReports.length,
    initialize_seen: httpReports.some(r => r.method === 'initialize'),
    context_delivered_on_every_request: httpReports.length > 0 && httpReports.every(r => r.context_header.present && r.context_header.fingerprint === fingerprint(salt, marker)),
    ambient_in_header: false,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ probe: 'not-514-claude-mcp-probe', client: version, config: HOME_CONFIG ? 'home' : 'isolated', results }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'probe failed');
  process.exit(1);
});
