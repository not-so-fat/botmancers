#!/usr/bin/env node
// NOT-519: seed an isolated DB for the session-share proof
// (scripts/ui-session-shares-proof.js). A Codex Agent "Forge" on the
// deterministic fake codex binary (tests/support/fake-codex.js) with an open
// session, an archived one, and one the runtime no longer has; an owner
// share policy (config/session-shares.json: two Slack channels, Forge's
// share_from_turn on); and shares in the ended and degraded states created
// through the real store: an expired and a revoked share on the open
// session, a share whose questions are used up (its Slack thread posted) and
// one with a question interrupted by a restart on the archived session.
// Also writes the codex wrapper the app must run with.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/shares-fixture.db.
// Usage: node scripts/seed-shares-fixture.js   (prints the dev-server command)
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'shares-fixture.db');
const DIR = path.dirname(DB_PATH);
const STATE = path.resolve(process.env.FAKE_CODEX_STATE || path.join(DIR, 'shares-fixture-codex.json'));
const BIN = path.resolve(process.env.BOTMANCERS_CODEX_BIN || path.join(DIR, 'shares-fixture-codex'));
const SHARES = path.resolve(process.env.BOTMANCERS_SESSION_SHARES_PATH || path.join(DIR, 'shares-fixture-config', 'session-shares.json'));
const WORK = path.resolve(DIR, 'shares-fixture-work');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.dirname(SHARES), { recursive: true, mode: 0o700 });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
fs.rmSync(STATE, { force: true });
fs.rmSync(SHARES, { force: true });
fs.writeFileSync(BIN, `#!/bin/sh\nFAKE_CODEX_STATE='${STATE}' exec '${process.execPath}' '${path.resolve(__dirname, '..', 'tests', 'support', 'fake-codex.js')}' "$@"\n`);
fs.chmodSync(BIN, 0o755);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_BIN = BIN;
process.env.FAKE_CODEX_STATE = STATE;
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES;

const { seedFakeCodex } = require('../tests/support/fake-codex');
seedFakeCodex(STATE, [
  { id: 'thr-uploader-SECRET', cwd: WORK, name: 'Fix the uploader retry', turns: [['Fix the uploader retry', 'Retry now backs off; tests pending'], ['Which tests?', 'upload.test.ts']] },
  { id: 'thr-spike-SECRET', cwd: WORK, name: 'Archived parser spike', archived: true, turns: [['Spike the parser', 'Spike notes saved']] },
  { id: 'thr-gone-SECRET', cwd: WORK, name: 'Old dependency audit', turns: [['Audit deps', 'Two outdated']] },
]);

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
const dbModule = jiti('../lib/db.ts');
const ps = jiti('../lib/provider-sessions.ts');
const codex = jiti('../lib/codex-session-provider.ts');
const shares = jiti('../lib/session-shares.ts');
jiti('../lib/slack-relay.ts');
const db = dbModule.default;
const OWNER = dbModule.UI_OWNER_PRINCIPAL;
const AUDIENCES = [
  { kind: 'slack', team_id: 'T0BMDEMO1', channel_id: 'C0REVIEWS' },
  { kind: 'slack', team_id: 'T0BMDEMO1', channel_id: 'C0RELEASE' },
];

async function main() {
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' });
  const forge = dbModule.bots.create({
    name: 'Forge', title: 'Implementer', description: 'Native Codex sessions', agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]',
    policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  let cursor = null;
  do cursor = (await ps.syncAgentSessions(db, forge.id, { cursor })).next_cursor; while (cursor);
  fs.writeFileSync(SHARES, `${JSON.stringify({ version: 1, audiences: AUDIENCES, agents: [{ agent: forge.id, share_from_turn: true }] }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(SHARES, 0o600);
  const refOf = id => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(forge.id, id).id;
  const open = refOf('thr-uploader-SECRET');
  const archived = refOf('thr-spike-SECRET');
  const make = (sessionRef, key, extra = {}) => shares.createShare({ creator: OWNER, sessionRef, agentId: forge.id, audience: AUDIENCES[0], idempotencyKey: key, ...extra }).then(r => r.share);

  // The open session's history: one expired (created two hours ago for
  // 5 minutes) and one revoked share.
  const now = Date.now();
  shares.setSessionShareClock(() => now - 2 * 3600_000);
  await make(open, 'fixture-expired', { ttlSeconds: 300 });
  shares.setSessionShareClock(() => now - 3600_000);
  const revoked = await make(open, 'fixture-revoked', { ttlSeconds: 86400, maxTurns: 10 });
  shares.setSessionShareClock(() => now - 3000_000);
  shares.revokeShare(revoked.id);
  shares.setSessionShareClock(null);

  // The archived session: every question used (its thread anchored by the
  // relay), and a question a previous Botmancers process claimed but never
  // sent (recovering; the next question clears it).
  const exhausted = await make(archived, 'fixture-exhausted', { maxTurns: 3, audience: AUDIENCES[1] });
  db.prepare('UPDATE session_shares SET turns_used = max_turns WHERE id = ?').run(exhausted.id);
  db.prepare('INSERT INTO slack_share_threads (share_ref, session_ref, team_id, channel_id, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(exhausted.id, archived, AUDIENCES[1].team_id, AUDIENCES[1].channel_id, '1761400000.000100', now - 600_000);
  const recovering = await make(archived, 'fixture-recovering', { ttlSeconds: 8 * 3600 });
  db.prepare("UPDATE session_shares SET inflight_key = 'fixture-lost-question', inflight_owner = 'an-earlier-botmancers-process' WHERE id = ?").run(recovering.id);

  // The runtime loses one session after discovery: it reads as missing.
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state.threads['thr-gone-SECRET'].deleted = true;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  await ps.refreshProviderSession(db, forge.id, refOf('thr-gone-SECRET')).catch(() => undefined);
  codex.shutdownDefaultCodexRuntime();
  const n = db.prepare('SELECT COUNT(*) AS n FROM session_shares').get().n;
  console.log(`Seeded ${DB_PATH}: Forge ${forge.id}, 3 Codex sessions, ${n} shares; policy ${SHARES}; codex wrapper ${BIN}.`);
  console.log(`Serve: BOTMANCERS_DB_PATH=${DB_PATH} BOTMANCERS_NO_AUTOPROCESS=1 BOTMANCERS_CODEX_BIN=${BIN} FAKE_CODEX_STATE=${STATE} BOTMANCERS_SESSION_SHARES_PATH=${SHARES} npx next dev -H 127.0.0.1 -p 43519`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
