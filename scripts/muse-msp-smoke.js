#!/usr/bin/env node
// NOT-508 operator smoke: a real `muse serve` (stable MSP) behind the
// direct Muse SessionProvider, without Agent Deck.
//
//   node scripts/muse-msp-smoke.js            # free: --provider echo, isolated Muse home
//   node scripts/muse-msp-smoke.js --provider meta   # a real model turn (billable)
//
// 1. Creates a past session outside Botmancers (`muse exec`) in an isolated
//    workspace and Muse home (XDG_DATA_HOME), so the operator's own sessions
//    are never touched.
// 2. Botmancers process 1 registers a direct Muse Agent scoped to that
//    workspace, probes Muse, imports the session, and reads its transcript.
// 3. Botmancers process 2 (the restart; nothing in memory) resumes that
//    exact session by its Botmancers reference, observes the turn, and reads
//    the appended transcript.
// Prints a redacted transcript: Muse ids are replaced, the Botmancers
// reference is safe to share, and the HEAD SHA and versions are recorded.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PHASE = process.argv[2] === '--phase' ? process.argv[3] : 'main';
const providerArg = process.argv.indexOf('--provider');
const MUSE_PROVIDER = providerArg > 0 ? process.argv[providerArg + 1] : 'echo';
const MUSE_BIN = process.env.BOTMANCERS_MUSE_BIN || 'muse';

// Muse session and turn ids are UUIDv7; Botmancers references (UUIDv4) stay visible.
const redactIds = text => String(text).replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[muse-id]');
const say = line => console.log(redactIds(line));

if (PHASE === 'main') main();
else phase(PHASE).catch(error => { console.error(error); process.exit(1); });

function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-muse-smoke-')));
  const ws = path.join(tmp, 'workspace');
  fs.mkdirSync(ws);
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(tmp, 'muse-data'),
    BOTMANCERS_DB_PATH: path.join(tmp, 'botmancers.db'),
    BOTMANCERS_NO_AUTOPROCESS: '1',
    BOTMANCERS_MUSE_SERVE_ARGS: JSON.stringify(['--provider', MUSE_PROVIDER]),
    SMOKE_WS: ws,
  };
  for (const name of Object.keys(env)) if (/^AGENT_DECK/.test(name)) delete env[name];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  say(`# NOT-508 Muse MSP smoke`);
  say(`head: ${head}${dirty ? ' (worktree has uncommitted changes)' : ''}`);
  say(`muse: ${execFileSync(MUSE_BIN, ['--version'], { encoding: 'utf8' }).trim()}`);
  say(`node: ${process.version}  provider: --provider ${MUSE_PROVIDER}  agent deck: not configured`);

  say('\n## 0. a past session created outside Botmancers (muse exec)');
  const exec = spawnSync(MUSE_BIN, ['exec', '--provider', MUSE_PROVIDER, 'Smoke: describe this empty workspace in one line.'], { cwd: ws, env, encoding: 'utf8' });
  if (exec.status !== 0) {
    say(`muse exec failed (${exec.status}): ${exec.stderr.slice(-500)}`);
    process.exit(1);
  }
  say(`muse exec: exit 0, session ${exec.stdout.trim().split('\n').pop()}`);
  const sessionsBefore = countSessions(env.XDG_DATA_HOME);

  for (const name of ['import', 'restart']) {
    say(`\n## ${name === 'import' ? '1. Botmancers process 1: probe, import, read' : '2. Botmancers process 2 (restart): resume the exact session'}`);
    const run = spawnSync(process.execPath, [__filename, '--phase', name], { env, encoding: 'utf8', timeout: 300_000 });
    process.stdout.write(redactIds(run.stdout));
    if (run.status !== 0) {
      process.stdout.write(redactIds(run.stderr));
      say(`phase ${name} failed`);
      process.exit(1);
    }
  }
  const sessionsAfter = countSessions(env.XDG_DATA_HOME);
  say(`\nmuse sessions on disk: before=${sessionsBefore} after=${sessionsAfter} (no replacement session)`);
  if (sessionsAfter !== sessionsBefore) process.exit(1);
  fs.rmSync(tmp, { recursive: true, force: true });
  say('SMOKE PASSED');
}

function countSessions(dataHome) {
  const root = path.join(dataHome, 'muse', 'sessions');
  let n = 0;
  const walk = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'subagent') continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'session.jsonl'))) n++;
      else walk(full);
    }
  };
  walk(root);
  return n;
}

async function phase(name) {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in this smoke'); };
  const { createJiti } = require('jiti');
  const jiti = createJiti(path.join(ROOT, 'package.json'), { alias: { '@': ROOT } });
  const dbModule = jiti('./lib/db.ts');
  const ps = jiti('./lib/provider-sessions.ts');
  const catalog = jiti('./lib/session-catalog.ts');
  const muse = jiti('./lib/muse-session-provider.ts');
  const db = dbModule.default;
  const ws = process.env.SMOKE_WS;
  const owner = { kind: 'person', id: 'local-owner' };
  const check = (condition, label) => {
    say(`  ${condition ? 'ok' : 'FAILED'}: ${label}`);
    if (!condition) process.exitCode = 1;
  };
  const show = entries => entries.forEach(entry => say(`    #${entry.seq} ${entry.role}: ${entry.text.replace(/\s+/g, ' ').slice(0, 120)}`));

  let agent = db.prepare("SELECT id FROM bots WHERE name = 'MuseSmoke'").get();
  if (name === 'import') {
    const conn = dbModule.runtimeConnections.create({ provider: 'muse', label: 'Muse on this computer', host: 'This computer' }).id;
    agent = dbModule.bots.create({
      name: 'MuseSmoke', title: 'Muse', description: 'Direct Muse smoke', agent: 'muse', runtime_connection_id: conn, launch_profile: 'direct',
      session_scope_kind: 'workspaces', session_scope_items: JSON.stringify([ws]), policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
    });
    say(`  agent: direct, deck=${dbModule.bots.getById(agent.id).deck_id ?? 'none'}, scope=1 workspace, policy=read_only`);
    const probe = await muse.createMuseSessionProvider(conn).probe();
    say(`  probe: status=${probe.status} muse=${probe.muse_version} msp_schema=${probe.schema_version} durability=${probe.durability}`);
    check(probe.status === 'ready', 'the MSP capability probe is ready');
    const sync = await ps.syncAgentSessions(db, agent.id, {});
    const again = await ps.syncAgentSessions(db, agent.id, {});
    say(`  sync: imported=${sync.imported.length} rejected_out_of_scope=${sync.rejected_out_of_scope}; re-sync imported=${again.imported.length} updated=${again.updated.length}`);
    check(sync.imported.length === 1 && again.imported.length === 0, 'the past session imports once');
    const ref = sync.imported[0];
    const row = catalog.getAgentSession(db, agent.id, ref);
    say(`  session ref (Botmancers): ${ref}`);
    say(`  catalog state: ${JSON.stringify(row.state)}`);
    const page = await ps.readProviderTranscript(db, agent.id, ref, {});
    show(page.entries);
    check(page.entries.length >= 2, 'the transcript reads through session/read');
  } else {
    const ref = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ?').get(agent.id).id;
    say(`  session ref (Botmancers): ${ref}`);
    const sent = await ps.sendProviderTurn(db, agent.id, ref, {
      prompt: 'Smoke after restart: reply with one short line.', authority: 'read_only', idempotencyKey: 'smoke-resume-1', requester: owner, correlation: { requestId: 'smoke' },
    });
    const done = await ps.observeProviderTurn(db, agent.id, sent.turn.turn_ref, { deadlineAt: Date.now() + 240_000 });
    say(`  turn: ${done.turn_ref} kind=${done.kind} authority=${done.authority} state=${done.state} session_ref=${done.session_ref}`);
    say(`  output: ${(done.output ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
    check(done.state === 'completed' && done.session_ref === ref, 'the exact session resumed and the turn completed');
    const page = await ps.readProviderTranscript(db, agent.id, ref, {});
    show(page.entries);
    check(page.entries.some(entry => /Smoke after restart/.test(entry.text)), 'the resumed turn is appended to the same session');
    const events = db.prepare('SELECT type, COUNT(*) AS n FROM provider_session_events GROUP BY type ORDER BY type').all();
    say(`  events: ${events.map(e => `${e.type}=${e.n}`).join(' ')}`);
  }
  check(fetchCalls === 0, 'no network call (no Agent Deck)');
  muse.shutdownMuseSessionProviders();
}
