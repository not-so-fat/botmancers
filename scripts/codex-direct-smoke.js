#!/usr/bin/env node
// NOT-504 operator smoke: the direct Codex provider against the real,
// locally signed-in Codex. Not part of CI (it needs Codex auth and network).
//
//   node scripts/codex-direct-smoke.js
//
// 1. Creates a native Codex thread outside Botmancers (`codex exec --json`
//    in a throwaway workspace).
// 2. Process A: registers a direct Codex Agent scoped to that workspace,
//    imports the thread, reads it by Botmancers reference, and asks a
//    read-only question.
// 3. Process B (a Botmancers restart on the same database): resumes the same
//    reference read-only and observes the answer.
// Each phase checks that no Agent Deck server is running or contacted.
// Prints a redacted protocol transcript: Codex thread ids never appear.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PHASE = process.argv[2] || 'setup';
const TMP = process.env.NOT504_SMOKE_DIR || path.join(fs.realpathSync(os.tmpdir()), `botmancers-codex-smoke-${process.pid}`);
const WORKSPACE = path.join(TMP, 'workspace');
const CODEX = process.env.BOTMANCERS_CODEX_BIN || 'codex';
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];

// Any fetch from Botmancers code would be an Agent Deck (or other HTTP) call.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('fetch disabled in the Codex direct smoke'); };

const secrets = new Set();
const redact = text => [...secrets].reduce((out, id) => out.split(id).join('[codex-id]'), String(text));
const log = (...parts) => console.log(redact(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')));

function agentDeckRunning() {
  const ps = spawnSync('pgrep', ['-fl', 'agent-deck'], { encoding: 'utf8' });
  const lines = (ps.stdout || '').split('\n').filter(line => line.trim() && !line.includes('pgrep') && !line.includes('codex-direct-smoke'));
  return lines.length > 0;
}

async function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'NOTES.md'), 'The project codename is BLUE HERON.\n');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const version = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim();
  log(`HEAD ${head}`);
  log(`codex ${version}`);
  log(`agent-deck process running: ${agentDeckRunning()}`);
  // A thread created outside Botmancers.
  const out = execFileSync(CODEX, ['exec', '--json', '--skip-git-repo-check', '-C', WORKSPACE, '-c', 'sandbox_mode="read-only"', '-'], {
    input: 'Read NOTES.md and reply with one short sentence naming the codename.', encoding: 'utf8', timeout: 300_000,
  });
  const started = out.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(e => e && e.type === 'thread.started');
  if (!started) throw new Error('codex exec reported no thread');
  log('native thread created outside Botmancers via codex exec --json');
  for (const phase of ['first', 'restart']) {
    const child = spawnSync(process.execPath, [__filename, phase], {
      env: { ...process.env, NOT504_SMOKE_DIR: TMP, NOT504_THREAD: started.thread_id }, encoding: 'utf8', timeout: 600_000,
    });
    process.stdout.write(redact(child.stdout).split('\n').filter(Boolean).map(line => `[${phase}] ${line}\n`).join(''));
    if (child.status !== 0) {
      process.stdout.write(redact(child.stderr));
      process.exit(1);
    }
  }
  log('smoke passed');
  if (!process.env.NOT504_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
}

async function phase(name) {
  secrets.add(process.env.NOT504_THREAD);
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': ROOT } });
  const dbModule = jiti('./lib/db.ts');
  const ps = jiti('./lib/provider-sessions.ts');
  const codex = jiti('./lib/codex-session-provider.ts');
  const db = dbModule.default;
  const owner = { kind: 'person', id: 'local-owner' };
  let agentId;
  if (name === 'first') {
    const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' });
    agentId = dbModule.bots.create({
      name: 'CodexSmoke', title: 'Codex', description: 'Direct Codex smoke', agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
      session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([WORKSPACE]), policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
    }).id;
    log(`registered direct Codex Agent, deck_id=${dbModule.bots.getById(agentId).deck_id}`);
  } else {
    agentId = db.prepare("SELECT id FROM bots WHERE name = 'CodexSmoke'").get().id;
  }
  const rt = codex.defaultCodexRuntime();
  const ready = await rt.ready();
  log(`probe: ${JSON.stringify({ status: rt.probe.status, cli_version: rt.probe.cli_version, selection: rt.selection(), ok: ready.ok })}`);
  if (!ready.ok) throw new Error(`codex not ready: ${ready.error.code}`);

  let ref;
  if (name === 'first') {
    let cursor = null;
    const imported = [];
    do {
      const page = await ps.syncAgentSessions(db, agentId, { cursor });
      imported.push(...page.imported);
      cursor = page.next_cursor;
    } while (cursor);
    ref = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(agentId, process.env.NOT504_THREAD)?.id;
    if (!ref) throw new Error('the native thread was not imported');
    const row = db.prepare('SELECT title, workspace, lifecycle, resumable, busy, availability FROM provider_sessions WHERE id = ?').get(ref);
    log(`imported ${imported.length} thread(s) in scope; session ref ${ref}: ${JSON.stringify(row)}`);
    const transcript = await ps.readProviderTranscript(db, agentId, ref, { limit: 10 });
    log(`thread/items transcript: ${JSON.stringify(transcript.entries.map(e => ({ role: e.role, text: e.text.slice(0, 120) })))}`);
  } else {
    ref = db.prepare("SELECT id FROM provider_sessions WHERE agent_id = ? AND origin = 'discovered'").get(agentId).id;
    log(`after restart: same session ref ${ref}`);
  }
  const prompt = name === 'first'
    ? 'Without running any commands, what codename did you name earlier? One short sentence.'
    : 'Without running any commands, repeat the codename once more in one short sentence.';
  const sent = await ps.sendProviderTurn(db, agentId, ref, { prompt, authority: 'read_only', idempotencyKey: `smoke-${name}`, requester: owner, correlation: { requestId: `smoke-${name}` } });
  log(`turn/start (read_only) turn ref ${sent.turn.turn_ref}`);
  const done = await ps.observeProviderTurn(db, agentId, sent.turn.turn_ref, { deadlineAt: Date.now() + 300_000 });
  const event = db.prepare("SELECT detail FROM provider_session_events WHERE turn_id = ? AND type = 'turn_completed'").get(sent.turn.turn_ref);
  log(`turn ${done.state}: ${JSON.stringify(done.output)}`);
  log(`usage: ${event ? JSON.stringify(JSON.parse(event.detail).usage ?? null) : 'none'}`);
  const views = JSON.stringify([done, sent, ps.listProviderTurns(db, agentId, ref)]);
  log(`thread id in views: ${views.includes(process.env.NOT504_THREAD)}`);
  log(`fetch calls (Agent Deck or other HTTP): ${fetchCalls}; agent-deck process running: ${agentDeckRunning()}`);
  codex.shutdownDefaultCodexRuntime();
  if (done.state !== 'completed' || fetchCalls !== 0 || views.includes(process.env.NOT504_THREAD)) process.exit(1);
  process.exit(0);
}

(PHASE === 'setup' ? setup() : phase(PHASE)).catch(error => {
  console.error(redact(error && error.stack || error));
  process.exit(1);
});
