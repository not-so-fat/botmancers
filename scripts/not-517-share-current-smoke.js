#!/usr/bin/env node
// NOT-517 operator smoke: a real Claude Code or Codex turn, launched by
// Botmancers' own provider, calls botmancers_share_current_session over the
// MCP entry Botmancers wrote for that launch, against the real /api/v0/mcp
// handler served on a loopback port, and the share names exactly the
// session Botmancers started. Spends a little usage of the logged-in CLI.
//
//   node scripts/not-517-share-current-smoke.js claude
//   node scripts/not-517-share-current-smoke.js codex
//
// Everything Botmancers writes lives in a temporary directory (database,
// owner documents, provider state); the CLI uses its normal login. Prints
// only booleans and counts, never a context, provider id, or path.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const RUNTIME = process.argv[2] === 'codex' ? 'codex' : 'claude';
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'not517-smoke-'));
const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS);
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SESSION_SHARES_PATH = path.join(TMP, 'session-shares.json');
process.env.BOTMANCERS_SERVICE_GRANTS_PATH = path.join(TMP, 'service-grants.json');
process.env.BOTMANCERS_CLAUDE_STATE_DIR = path.join(TMP, 'claude-state');
for (const name of Object.keys(process.env)) if (/^AGENT_DECK|^CLAUDE_?CODE|^BOTMANCERS_SESSION_CONTEXT$/.test(name)) delete process.env[name];

async function main() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.BOTMANCERS_SESSION_CONTEXT_URL = `http://127.0.0.1:${port}/api/v0/mcp`;
  const { createJiti } = require('jiti');
  const jiti = createJiti(path.join(ROOT, 'index.js'), { alias: { '@': ROOT } });
  const dbModule = jiti('./lib/db.ts');
  const ps = jiti('./lib/provider-sessions.ts');
  const { handleMcpPost } = jiti('./lib/mcp-http.ts');
  const db = dbModule.default;
  let mcpCalls = 0;
  server.on('request', async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    mcpCalls++;
    if (process.env.NOT517_SMOKE_DEBUG) { try { const m = JSON.parse(Buffer.concat(chunks).toString('utf8')); console.error('mcp', m.method, m.params && m.params.name ? m.params.name : ''); } catch { /* not JSON */ } }
    const response = await handleMcpPost(new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  const connection = dbModule.runtimeConnections.create({ provider: RUNTIME, label: 'smoke', host: 'This computer' }).id;
  const bot = dbModule.bots.create({
    name: 'Smoke', title: 'Smoke', description: 'NOT-517 smoke', agent: RUNTIME, runtime_connection_id: connection, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const audience = { kind: 'slack', team_id: 'T0SMOKE01', channel_id: 'C0SMOKE01' };
  fs.writeFileSync(process.env.BOTMANCERS_SESSION_SHARES_PATH, JSON.stringify({ version: 1, audiences: [audience], agents: [{ agent: bot.id, share_from_turn: true }] }), { mode: 0o600 });

  const prompt = 'Call the tool botmancers_share_current_session exactly once with arguments '
    + `{"audience": {"kind": "slack", "team_id": "${audience.team_id}", "channel_id": "${audience.channel_id}"}, "idempotency_key": "smoke-1"}. `
    + 'Then reply with only the share state the tool returned.';
  const started = await ps.startProviderSession(db, bot.id, {
    workspace: WS, prompt, authority: 'read_only', idempotencyKey: 'smoke-turn-1', requester: { kind: 'person', id: 'local-owner' },
  });
  const turn = await ps.observeProviderTurn(db, bot.id, started.turn.turn_ref, { deadlineAt: Date.now() + 240_000 });
  if (process.env.NOT517_SMOKE_DEBUG) console.error('output', turn.output, turn.failure_code);
  const shares = db.prepare('SELECT session_ref, created_via, creator_id FROM session_shares').all();
  const contexts = db.prepare('SELECT state, end_reason FROM session_contexts').all();
  const dbText = fs.readFileSync(process.env.BOTMANCERS_DB_PATH).toString('latin1');
  const result = {
    smoke: 'not-517-share-current', runtime: RUNTIME,
    turn_state: turn.state,
    mcp_requests: mcpCalls,
    shares: shares.length,
    share_is_started_session: shares.length === 1 && shares[0].session_ref === started.turn.session_ref,
    created_via_current_session: shares.length === 1 && shares[0].created_via === 'current_session' && shares[0].creator_id === 'botmancers-session-context',
    contexts: contexts.map(row => `${row.state}${row.end_reason ? `:${row.end_reason}` : ''}`),
    context_in_database: /bmsc_[A-Za-z0-9_-]{43}/.test(dbText),
  };
  if (RUNTIME === 'codex') jiti('./lib/codex-session-provider.ts').shutdownDefaultCodexRuntime();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.share_is_started_session && result.created_via_current_session && !result.context_in_database ? 0 : 1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'smoke failed');
  process.exit(1);
});
