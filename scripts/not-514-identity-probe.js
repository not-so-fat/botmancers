#!/usr/bin/env node
// NOT-514 caller-identity probe. Reports which ambient session-identity
// signals a coding-agent client hands to a process it launches, without
// ever printing a value.
//
//   node scripts/not-514-identity-probe.js env
//       One redacted JSON report of this process's environment.
//   node scripts/not-514-identity-probe.js mcp-stdio
//       A minimal stdio MCP server with one tool, `identity_probe`, that
//       returns the same report as seen by the MCP subprocess. Register it
//       in Claude Code, Codex, or Cursor and call the tool once per case in
//       docs/evidence/NOT-514/probe-results.md (new session, exact resume,
//       implicit continue, clear/reset, client restart, launched outside
//       Botmancers). With NOT514_PROBE_OUT set, the report seen at
//       `initialize` is also appended to that file as one JSON line.
//
// Each watched variable is reported as { present, shape, length,
// fingerprint }. `fingerprint` is the first 12 hex digits of
// HMAC-SHA256(NOT514_PROBE_SALT, value): set the same random salt for every
// call of one run to compare values across cases (same session or not)
// without recording them. With no salt there is no fingerprint. Never commit
// the salt. Only names in WATCHED are read; the rest of the environment is
// counted, not listed.
'use strict';

const crypto = require('crypto');

// Ambient identity candidates. Documented: CLAUDE_CODE_SESSION_ID (Claude
// Code, stdio MCP subprocesses). The rest are names a client might set; a
// hit is a lead to verify in that client's documentation, not a contract.
const WATCHED = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM',
  'CURSOR_SESSION_ID', 'CURSOR_CHAT_ID', 'CURSOR_AGENT', 'CURSOR_TRACE_ID',
  'BOTMANCERS_SESSION_CONTEXT',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shapeOf(value) {
  if (UUID.test(value)) return 'uuid';
  if (/^bmsc_[A-Za-z0-9_-]{43}$/.test(value)) return 'botmancers_context';
  if (/^[01]$|^(true|false)$/i.test(value)) return 'flag';
  if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) return 'token';
  if (/[\\/]/.test(value)) return 'path';
  return 'other';
}

function report(env, salt) {
  const signals = {};
  for (const name of WATCHED) {
    const value = env[name];
    if (value === undefined || value === '') {
      signals[name] = { present: false };
      continue;
    }
    // Paths and flags are described, never fingerprinted.
    const shape = shapeOf(value);
    const fingerprint = salt && (shape === 'uuid' || shape === 'token' || shape === 'botmancers_context')
      ? crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 12)
      : null;
    signals[name] = { present: true, shape, length: value.length, fingerprint };
  }
  return {
    probe: 'not-514-identity-probe',
    version: 1,
    pid_role: process.ppid === 1 ? 'orphan' : 'child',
    salted: !!salt,
    signals,
    other_env_names: Object.keys(env).filter(name => !WATCHED.includes(name)).length,
  };
}

function serveMcp() {
  let buffer = '';
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (message.id === undefined) continue;
      if (message.method === 'initialize') {
        // Spawn-time evidence even when the client never gets to a tool call.
        if (process.env.NOT514_PROBE_OUT) {
          require('fs').appendFileSync(process.env.NOT514_PROBE_OUT,
            `${JSON.stringify({ at: 'initialize', ...report(process.env, process.env.NOT514_PROBE_SALT || null) })}\n`);
        }
        send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'not-514-identity-probe', version: '1' },
        } });
      } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
          name: 'identity_probe', description: 'Redacted report of the session-identity signals this MCP subprocess received.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }] } });
      } else if (message.method === 'tools/call' && message.params && message.params.name === 'identity_probe') {
        // Read the environment at call time: a client that updated it would show here.
        const text = JSON.stringify(report(process.env, process.env.NOT514_PROBE_SALT || null));
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
      } else if (message.method === 'ping') {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
      }
    }
  });
}

// A minimal Streamable HTTP MCP endpoint on loopback (JSON responses only)
// for the header form of a minted context: each request appends one line
// { method, authorization: { present, fingerprint }, context_header: {...} }
// to `out`. Resolves with { url, close }.
function serveMcpHttp({ out, salt }) {
  const http = require('http');
  const fs = require('fs');
  const fp = value => (value ? { present: true, fingerprint: salt ? crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 12) : null } : { present: false });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let message = null;
      try { message = JSON.parse(body); } catch { /* GET or empty */ }
      const auth = req.headers.authorization && /^Bearer (.+)$/.exec(req.headers.authorization);
      fs.appendFileSync(out, `${JSON.stringify({
        http_method: req.method, method: message && message.method ? message.method : null,
        authorization: fp(auth ? auth[1] : null), context_header: fp(req.headers['botmancers-session-context'] || null),
      })}\n`);
      if (req.method !== 'POST' || !message) {
        res.writeHead(405).end();
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result = message.method === 'initialize'
        ? { protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'not-514-identity-probe', version: '1' } }
        : message.method === 'tools/list' ? { tools: [] } : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(done => server.close(done)),
  })));
}

if (require.main === module) {
  const mode = process.argv[2] || 'env';
  if (mode === 'env') process.stdout.write(`${JSON.stringify(report(process.env, process.env.NOT514_PROBE_SALT || null), null, 2)}\n`);
  else if (mode === 'mcp-stdio') serveMcp();
  else {
    process.stderr.write('usage: not-514-identity-probe.js env|mcp-stdio\n');
    process.exit(2);
  }
}

module.exports = { WATCHED, report, shapeOf, serveMcpHttp };
