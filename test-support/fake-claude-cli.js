#!/usr/bin/env node
// NOT-506: a stand-in `claude` executable for the direct Claude Code
// provider's spawn-boundary tests (test-claude-session-provider.js). It
// behaves like `claude -p --output-format stream-json` against the session
// store in $CLAUDE_CONFIG_DIR: --resume of an unknown id prints Claude
// Code's structured "No conversation found" result, a turn appends user and
// assistant records to projects/<slug>/<id>.jsonl, and stdout carries only
// stream-json events.
//
// Every invocation is appended to $FAKE_CLAUDE_LOG (argv, cwd, stdin, the
// environment keys the test cares about, pid) so tests can assert exactly
// what crossed the process boundary.
//
// The prompt's leading directive picks a scenario:
//   (none)            init, one assistant message, success with usage/cost
//   [hold]            init, then runs until signalled
//   [fork]            init naming a different session, then runs until signalled
//   [crash]           init, then exits 3 without a result
//   [auth]            init, then an authentication-failure result
//   [auth-early]      an authentication-failure result before init
//   [usage-cap]       init, a rejected rate-limit event, a usage-limit result
//   [permission]      init, an error result with permission denials
//   [stream:<name>]   replays test-support/fixtures/claude-code/stream/<name>.jsonl
// Environment knobs: FAKE_CLAUDE_VERSION (default 2.1.302),
// FAKE_CLAUDE_REJECT_FLAG (exit like an older CLI that lacks that flag),
// FAKE_CLAUDE_FORGET (a session id the CLI claims not to know).
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS executable. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const VERSION = process.env.FAKE_CLAUDE_VERSION || '2.1.302';

if (argv.includes('--version')) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

const flagValue = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const configDir = process.env.CLAUDE_CONFIG_DIR;
const slug = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);

function findSession(id) {
  const root = path.join(configDir, 'projects');
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function result(sessionId, fields) {
  return {
    type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, session_id: sessionId,
    total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [], uuid: crypto.randomUUID(), ...fields,
  };
}

function append(sessionId, records) {
  const dir = path.join(configDir, 'projects', slug(process.cwd()));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId, cwd: process.cwd(), version: VERSION, isSidechain: false, userType: 'external', entrypoint: 'sdk-cli' };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), records.map(r => `${JSON.stringify({ ...base, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...r })}\n`).join(''));
}

function holdUntilSignalled() {
  const timer = setInterval(() => {}, 1000);
  const stop = () => { clearInterval(timer); process.exit(143); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', run);

function run() {
  if (process.env.FAKE_CLAUDE_LOG) {
    const env = {
      agent_deck_keys: Object.keys(process.env).filter(key => /^AGENT_DECK/.test(key)),
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      FAKE_CLAUDE_MARK: process.env.FAKE_CLAUDE_MARK ?? null,
    };
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), stdin, env, pid: process.pid })}\n`);
  }
  const rejected = process.env.FAKE_CLAUDE_REJECT_FLAG;
  if (rejected && argv.includes(rejected)) {
    process.stderr.write(`error: unknown option '${rejected}'\n`);
    process.exit(1);
  }
  const resume = flagValue('--resume');
  const sessionId = resume ?? flagValue('--session-id');
  if (resume && (!findSession(resume) || process.env.FAKE_CLAUDE_FORGET === resume)) {
    const message = `No conversation found with session ID: ${resume}`;
    process.stderr.write(`${message}\n`);
    emit(result(resume, { subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [message] }));
    process.exit(1);
  }
  const directive = /^\[([a-z-]+)(?::([^\]]*))?\]/.exec(stdin);
  const scenario = directive ? directive[1] : null;
  const init = id => emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: id, tools: (flagValue('--tools') || '').split(','), permissionMode: flagValue('--permission-mode'), claude_code_version: VERSION, mcp_servers: [] });

  if (scenario === 'auth-early') {
    emit(result(sessionId, { is_error: true, num_turns: 0, result: 'Not logged in · Please run /login', api_error_status: 401 }));
    process.exit(1);
  }
  if (scenario === 'fork') {
    init(crypto.randomUUID());
    holdUntilSignalled();
    return;
  }
  init(sessionId);
  append(sessionId, [{ type: 'user', message: { role: 'user', content: stdin } }]);
  if (scenario === 'hold') { holdUntilSignalled(); return; }
  if (scenario === 'crash') process.exit(3);
  if (scenario === 'auth') {
    emit(result(sessionId, { is_error: true, result: 'Invalid API key · Please run /login', api_error_status: 401 }));
    process.exit(1);
  }
  if (scenario === 'usage-cap') {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' }, session_id: sessionId });
    emit(result(sessionId, { is_error: true, result: 'Claude usage limit reached.', api_error_status: 429 }));
    process.exit(1);
  }
  if (scenario === 'permission') {
    emit(result(sessionId, { subtype: 'error_during_execution', is_error: true, permission_denials: [{ tool_name: 'Edit', tool_use_id: 'toolu_1' }] }));
    process.exit(1);
  }
  if (scenario === 'stream') {
    const fixture = path.join(__dirname, 'fixtures', 'claude-code', 'stream', `${directive[2]}.jsonl`);
    const lines = fs.readFileSync(fixture, 'utf8').split('\n').filter(line => line.trim() && !/"subtype":"init"/.test(line));
    for (const line of lines) process.stdout.write(`${line.split('{{SESSION_ID}}').join(sessionId)}\n`);
    process.exit(0);
  }
  const reply = `fake claude: ${stdin.trim()}`;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: sessionId });
  append(sessionId, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }]);
  emit(result(sessionId, { result: reply, total_cost_usd: 0.0123, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 400 } }));
  process.exit(0);
}
