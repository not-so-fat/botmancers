#!/usr/bin/env node
// NOT-506 operator smoke: the direct Claude Code provider against the real,
// logged-in `claude` CLI, with no Agent Deck.
//
//   npm run smoke:claude-provider -- --approve-write
//
// 1. Creates an external past session with plain `claude -p` in a fresh
//    temporary workspace (Botmancers is not involved).
// 2. Botmancers process A registers a direct Claude Agent scoped to that
//    workspace, imports the session, and pages its transcript.
// 3. Botmancers process B (a restart: same database, nothing in memory)
//    resumes the exact session read-only, then, only with --approve-write,
//    runs one workspace_write turn that creates a file.
// Prints a redacted structured transcript (Claude session id replaced) with
// versions, the Botmancers session ref, and HEAD. Spends real Claude usage.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PHASE = process.argv[2] === '--phase' ? process.argv[3] : 'main';
const APPROVE_WRITE = process.argv.includes('--approve-write');
const CODEWORD = 'AMBER-7';

function out(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function setupEnv(tmp) {
  process.env.BOTMANCERS_DB_PATH = path.join(tmp, 'botmancers.db');
  process.env.BOTMANCERS_CLAUDE_STATE_DIR = path.join(tmp, 'claude-provider');
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
  globalThis.fetch = async () => { throw new Error('network disabled: the direct provider needs no Agent Deck'); };
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': ROOT } });
  return { dbModule: jiti('./lib/db.ts'), ps: jiti('./lib/provider-sessions.ts'), catalog: jiti('./lib/session-catalog.ts') };
}

const owner = { kind: 'person', id: 'local-owner' };

async function phaseA(tmp, workspace) {
  const { dbModule, ps } = setupEnv(tmp);
  const db = dbModule.default;
  const connection = dbModule.runtimeConnections.create({ provider: 'claude', label: 'Claude Code (smoke)', host: 'This computer' });
  const agent = dbModule.bots.create({
    name: 'Claude smoke', title: 'Claude', description: 'NOT-506 smoke', agent: 'claude', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([workspace]),
    policy_mode: 'workspace_write', allow_new_sessions: 0, allow_resume_with_edits: 1,
  });
  const caps = ps.agentProviderCapabilities(db, agent.id);
  const sync = await ps.syncAgentSessions(db, agent.id);
  const again = await ps.syncAgentSessions(db, agent.id);
  const ref = sync.imported[0];
  const page = await ps.readProviderTranscript(db, agent.id, ref, { limit: 10 });
  return {
    agent_id: agent.id, deck_id: dbModule.bots.getById(agent.id).deck_id, provider_kind: caps && caps.provider_kind,
    imported: sync.imported.length, reimported_on_repeat: again.imported.length, session_ref: ref, transcript_page: page.entries.map(e => ({ seq: e.seq, role: e.role, text: e.text.slice(0, 120) })),
  };
}

async function phaseB(tmp, workspace, agentId, ref, approveWrite) {
  const { dbModule, ps } = setupEnv(tmp);
  const db = dbModule.default;
  const turnOut = turn => ({ turn_ref: turn.turn_ref, session_ref: turn.session_ref, authority: turn.authority, state: turn.state, failure_code: turn.failure_code, usage: turn.usage, output: (turn.output || '').slice(0, 200) });
  const ro = await ps.sendProviderTurn(db, agentId, ref, { prompt: 'What codeword did I ask you to remember? Reply with only the codeword.', authority: 'read_only', idempotencyKey: 'smoke-ro', requester: owner });
  const roDone = await ps.observeProviderTurn(db, agentId, ro.turn.turn_ref, { deadlineAt: Date.now() + 300_000 });
  const result = { read_only: turnOut(roDone), recalled_codeword: (roDone.output || '').includes(CODEWORD) };
  if (approveWrite) {
    const w = await ps.sendProviderTurn(db, agentId, ref, { prompt: 'Create a file named smoke.txt in the current directory containing exactly the codeword, then reply DONE.', authority: 'workspace_write', idempotencyKey: 'smoke-w', requester: owner });
    const wDone = await ps.observeProviderTurn(db, agentId, w.turn.turn_ref, { deadlineAt: Date.now() + 300_000 });
    const file = path.join(workspace, 'smoke.txt');
    result.workspace_write = turnOut(wDone);
    result.file_written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  }
  result.provider_session_rows = db.prepare('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?').get(agentId).n;
  return result;
}

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-claude-smoke-')));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.txt'), 'NOT-506 smoke workspace\n');
  const versions = {
    claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
    node: process.version,
    botmancers: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  };
  // 1. The external past session, created without Botmancers.
  const external = spawnSync('claude', ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config'], {
    cwd: workspace, input: `Remember the codeword ${CODEWORD}. Reply with just OK.`, encoding: 'utf8', timeout: 300_000,
  });
  const created = JSON.parse(external.stdout);
  const secret = created.session_id;
  const redact = value => JSON.parse(JSON.stringify(value).split(secret).join('[redacted]').split(tmp).join('<tmp>'));
  out(redact({ step: 'versions', ...versions, approve_write: APPROVE_WRITE }));
  out(redact({ step: 'external_session', created_by: 'claude -p (no Botmancers)', is_error: created.is_error, session_id: secret }));

  const run = (phase, args) => {
    const child = spawnSync(process.execPath, [__filename, '--phase', phase, tmp, workspace, ...args], { encoding: 'utf8', timeout: 900_000 });
    if (child.status !== 0) throw new Error(`${phase} failed: ${child.stderr.slice(-2000)}`);
    return JSON.parse(child.stdout.trim().split('\n').pop());
  };
  const a = run('A', []);
  out(redact({ step: 'botmancers_process_A_import', ...a }));
  const b = run('B', [a.agent_id, a.session_ref, APPROVE_WRITE ? 'write' : 'no-write']);
  out(redact({ step: 'botmancers_process_B_after_restart', ...b }));
  const ok = a.provider_kind === 'claude-code' && a.deck_id === null && a.imported === 1 && a.reimported_on_repeat === 0
    && b.read_only.state === 'completed' && b.recalled_codeword && b.read_only.session_ref === a.session_ref
    && (!APPROVE_WRITE || (b.workspace_write.state === 'completed' && b.file_written === CODEWORD)) && b.provider_session_rows === 1;
  out({ step: 'verdict', ok });
  process.exit(ok ? 0 : 1);
}

if (PHASE === 'A' || PHASE === 'B') {
  const [tmp, workspace, agentId, ref, write] = process.argv.slice(4);
  (PHASE === 'A' ? phaseA(tmp, workspace) : phaseB(tmp, workspace, agentId, ref, write === 'write'))
    .then(result => { process.stdout.write(`\n${JSON.stringify(result)}\n`); process.exit(0); })
    .catch(error => { console.error(error); process.exit(1); });
} else {
  main().catch(error => { console.error(error); process.exit(1); });
}
