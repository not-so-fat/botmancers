#!/usr/bin/env node
// NOT-505: real Cursor Agent CLI smoke for the direct Cursor SessionProvider.
// Needs an installed, logged-in `cursor-agent` (or BOTMANCERS_CURSOR_CLI) and
// network for Cursor itself. Agent Deck is never contacted: AGENT_DECK_* is
// cleared and every in-process fetch is refused and counted.
//
// Steps, each in its own process:
//   outside  `cursor-agent create-chat` + one stream-json turn, run directly
//            (no Botmancers code), so the chat exists outside Botmancers.
//   import   Botmancers process 1: probe, capability report, discovery (or
//            its refusal), explicit scoped import of that chat.
//   resume   Botmancers process 2 (the restart): resume the exact chat and
//            recall the codeword, refuse an unknown target without a launch,
//            start and cancel a turn, and count durable rows/events.
// Output is a redacted JSON-lines transcript: the Cursor chat id never
// appears; only the safe Botmancers reference does.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STEP = process.argv[2] || 'all';
const DIR = process.env.CURSOR_SMOKE_DIR || path.join(fs.realpathSync(os.tmpdir()), 'botmancers-cursor-smoke');
const STATE = path.join(DIR, 'smoke-state.json');
const WORKSPACE = path.join(DIR, 'work', 'smoke');
const CLI = process.env.BOTMANCERS_CURSOR_CLI || 'cursor-agent';

process.env.BOTMANCERS_DB_PATH = path.join(DIR, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CURSOR_STATE_DIR = path.join(DIR, 'provider-state');
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in the Botmancers process'); };

const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const writeState = patch => fs.writeFileSync(STATE, JSON.stringify({ ...(fs.existsSync(STATE) ? readState() : {}), ...patch }), { mode: 0o600 });
function redact(value) {
  let text = JSON.stringify(value);
  const chat = fs.existsSync(STATE) ? readState().chat : null;
  if (chat) text = text.split(chat).join('<cursor-chat-REDACTED>');
  return text.split(os.homedir()).join('~');
}
const emit = (step, fact) => console.log(redact({ step, ...fact }));
let failures = 0;
function check(step, condition, label) {
  if (!condition) failures++;
  emit(step, { check: label, pass: !!condition });
}

function loadBotmancers() {
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': ROOT } });
  return {
    dbModule: jiti('@/lib/db.ts'),
    ps: jiti('@/lib/provider-sessions.ts'),
    cursor: jiti('@/lib/cursor-session-provider.ts'),
  };
}

function outside() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const version = spawnSync(CLI, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`${CLI} --version failed; is the Cursor Agent CLI installed?`);
  const created = spawnSync(CLI, ['create-chat'], { cwd: WORKSPACE, encoding: 'utf8', timeout: 60_000 });
  const chat = created.stdout.trim().split('\n').pop();
  if (created.status !== 0 || !chat) throw new Error('create-chat failed');
  const codeword = `ZEBRA${crypto.randomInt(1000, 9999)}`;
  writeState({ chat, codeword, cursor_version: version.stdout.trim() });
  const turn = spawnSync(CLI, ['--print', '--output-format', 'stream-json', '--trust', '--workspace', WORKSPACE, '--mode', 'ask', '--resume', chat,
    `Remember this codeword for later: ${codeword}. Reply only with OK.`], { cwd: WORKSPACE, encoding: 'utf8', timeout: 180_000 });
  const result = turn.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(e => e && e.type === 'result');
  emit('outside', { cursor_version: version.stdout.trim(), created_chat: true, turn_exit: turn.status, result_subtype: result ? result.subtype : null, result_text: result ? result.result : null });
  check('outside', turn.status === 0 && result && !result.is_error, 'a chat created and used directly with cursor-agent, outside Botmancers');
}

async function importStep() {
  const { dbModule, ps, cursor } = loadBotmancers();
  const db = dbModule.default;
  const state = readState();
  const probe = cursor.probeCursor();
  emit('import', { process: process.pid, probe });
  const connection = dbModule.runtimeConnections.create({ provider: 'cursor', label: 'Cursor smoke', host: 'This computer' });
  const agent = dbModule.bots.create({
    name: 'CursorSmoke', title: 'Cursor', description: 'Cursor smoke', agent: 'cursor', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([WORKSPACE]),
    policy_mode: 'workspace_write', allow_new_sessions: 1, allow_resume_with_edits: 1,
  });
  const capabilities = ps.agentProviderCapabilities(db, agent.id);
  emit('import', { capability_report: capabilities, deck_id: dbModule.bots.getById(agent.id).deck_id, launch_profile: dbModule.bots.getById(agent.id).launch_profile });
  let listing;
  try {
    const synced = await ps.syncAgentSessions(db, agent.id);
    listing = { supported: true, imported: synced.imported.length };
  } catch (error) {
    listing = { supported: false, refused_as: error.code };
  }
  emit('import', { session_listing: listing });
  check('import', capabilities.list === listing.supported, 'the capability report matches what discovery actually does');
  const imported = await ps.importProviderSession(db, agent.id, { providerSessionId: state.chat, workspace: WORKSPACE });
  const again = await ps.importProviderSession(db, agent.id, { providerSessionId: state.chat, workspace: WORKSPACE });
  emit('import', { safe_session_ref: imported.ref, created: imported.created, repeat_created: again.created });
  check('import', imported.created && !again.created && imported.ref === again.ref, 'explicit scoped import is idempotent');
  writeState({ agent: agent.id, ref: imported.ref, listing });
  check('import', fetchCalls === 0, 'no network call from Botmancers (no Agent Deck)');
}

async function resumeStep() {
  const { dbModule, ps } = loadBotmancers();
  const db = dbModule.default;
  const state = readState();
  const owner = { kind: 'person', id: 'local-owner' };
  emit('resume', { process: process.pid, restarted: true, safe_session_ref: state.ref });
  const turn = await ps.sendProviderTurn(db, state.agent, state.ref, {
    prompt: 'What codeword did I ask you to remember? Reply with only the codeword.', authority: 'read_only', idempotencyKey: 'smoke-resume',
    requester: owner, correlation: { requestId: 'smoke-not-505' },
  });
  const done = await ps.observeProviderTurn(db, state.agent, turn.turn.turn_ref, { deadlineAt: Date.now() + 180_000 });
  const usage = db.prepare("SELECT type, detail FROM provider_session_events WHERE turn_id = ? AND type LIKE 'turn_%' AND type <> 'turn_started'").get(turn.turn.turn_ref);
  emit('resume', { turn: done, terminal_event: usage ? { type: usage.type, usage: JSON.parse(usage.detail).usage ?? null } : null });
  check('resume', done.state === 'completed' && String(done.output).includes(state.codeword), 'the exact outside chat resumed after the restart and recalled its codeword');

  const transcript = await ps.readProviderTranscript(db, state.agent, state.ref, { limit: 50 });
  emit('resume', { transcript: transcript.entries.map(entry => ({ role: entry.role, text: entry.text })) });

  const stale = crypto.randomUUID();
  db.prepare(`INSERT INTO provider_sessions (id, agent_id, runtime_connection_id, provider_kind, provider_session_id, origin, workspace, resumable, created_at, updated_at)
    SELECT ?, agent_id, runtime_connection_id, 'cursor', ?, 'discovered', workspace, 1, 0, 0 FROM provider_sessions WHERE id = ?`).run(stale, crypto.randomUUID(), state.ref);
  let staleCode = null;
  try { await ps.sendProviderTurn(db, state.agent, stale, { prompt: 'hello?', authority: 'read_only', idempotencyKey: 'smoke-stale', requester: owner }); } catch (error) { staleCode = error.code; }
  const staleTurns = db.prepare('SELECT COUNT(*) AS n FROM provider_session_turns WHERE session_ref = ?').get(stale).n;
  emit('resume', { unknown_target: { refused_as: staleCode, turn_rows: staleTurns } });
  check('resume', staleCode === 'session_missing' && staleTurns === 0, 'an unknown resume target is missing; no process, no fresh chat');

  const long = await ps.sendProviderTurn(db, state.agent, state.ref, {
    prompt: 'Count slowly from 1 to 500, one number per line.', authority: 'read_only', idempotencyKey: 'smoke-cancel', requester: owner,
  });
  await ps.observeProviderTurn(db, state.agent, long.turn.turn_ref, { deadlineAt: Date.now() + 3000 });
  const cancelled = await ps.cancelProviderTurn(db, state.agent, long.turn.turn_ref);
  const repeat = await ps.cancelProviderTurn(db, state.agent, long.turn.turn_ref);
  const after = await ps.observeProviderTurn(db, state.agent, long.turn.turn_ref, { deadlineAt: Date.now() + 10_000 });
  emit('resume', { cancel: cancelled, repeat_cancel: repeat, after_cancel: { state: after.state } });
  check('resume', after.state === 'cancelled', 'a running real Cursor turn is cancelled');

  const events = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events GROUP BY type').all().map(row => [row.type, row.n]));
  const turns = Object.fromEntries(db.prepare('SELECT state, COUNT(*) AS n FROM provider_session_turns GROUP BY state').all().map(row => [row.state, row.n]));
  emit('resume', { durable: { sessions: db.prepare('SELECT COUNT(*) AS n FROM provider_sessions').get().n, turns, events } });
  check('resume', fetchCalls === 0, 'no network call from Botmancers (no Agent Deck)');
}

function all() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  console.log(JSON.stringify({ step: 'header', head, node: process.version, platform: process.platform }));
  let ok = true;
  for (const step of ['outside', 'import', 'resume']) {
    const run = spawnSync(process.execPath, [__filename, step], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 });
    process.stdout.write(run.stdout);
    if (run.status !== 0) { ok = false; break; }
  }
  console.log(JSON.stringify({ step: 'summary', pass: ok }));
  process.exit(ok ? 0 : 1);
}

const steps = { outside, import: importStep, resume: resumeStep };
if (STEP === 'all') all();
else Promise.resolve(steps[STEP]()).then(() => process.exit(failures ? 1 : 0), error => { console.error(error); process.exit(1); });
