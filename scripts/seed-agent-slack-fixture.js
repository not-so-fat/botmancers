#!/usr/bin/env node
// NOT-552: deterministic real-app fixture for the Agent Slack page. It
// creates all six owner-facing lifecycle statuses for Forge and a live share
// for another Agent, with no real Slack credentials or workspace required.
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'agent-slack-fixture.db');
const DIR = path.dirname(DB_PATH);
const STATE = path.resolve(process.env.FAKE_CODEX_STATE || path.join(DIR, 'agent-slack-codex.json'));
const BIN = path.resolve(process.env.BOTMANCERS_CODEX_BIN || path.join(DIR, 'agent-slack-codex'));
const POLICY = path.resolve(process.env.BOTMANCERS_SESSION_SHARES_PATH || path.join(DIR, 'agent-slack-config', 'session-shares.json'));
const WORK = path.resolve(DIR, 'agent-slack-work');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.dirname(POLICY), { recursive: true, mode: 0o700 });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
for (const file of [STATE, POLICY]) fs.rmSync(file, { force: true });
fs.writeFileSync(BIN, `#!/bin/sh\nFAKE_CODEX_STATE='${STATE}' exec '${process.execPath}' '${path.resolve(__dirname, '..', 'tests', 'support', 'fake-codex.js')}' "$@"\n`);
fs.chmodSync(BIN, 0o755);
Object.assign(process.env, {
  BOTMANCERS_DB_PATH: DB_PATH,
  BOTMANCERS_NO_AUTOPROCESS: '1',
  BOTMANCERS_CODEX_BIN: BIN,
  FAKE_CODEX_STATE: STATE,
  BOTMANCERS_SESSION_SHARES_PATH: POLICY,
});

const sessions = [
  ['active', 'Prepare the release'], ['answering', 'Review retry behavior'], ['recovering', 'Recover interrupted work'],
  ['exhausted', 'Answer migration questions'], ['expired', 'Audit old dependencies'], ['revoked', 'Retired rollout thread'],
  ['other', 'Other Agent private session'],
].map(([id, name]) => ({ id: `slack-${id}-SECRET`, cwd: WORK, name, turns: [[name, 'Fixture answer']] }));
require('../tests/support/fake-codex').seedFakeCodex(STATE, sessions);

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
const dbModule = jiti('../lib/db.ts');
const providerSessions = jiti('../lib/provider-sessions.ts');
const codex = jiti('../lib/codex-session-provider.ts');
const shareStore = jiti('../lib/session-shares.ts');
jiti('../lib/slack-relay.ts');
const db = dbModule.default;
const AUDIENCE = { kind: 'slack', team_id: 'T0BMDEMO1', channel_id: 'C0REVIEWS' };

async function sync(agentId) {
  let cursor = null;
  do cursor = (await providerSessions.syncAgentSessions(db, agentId, { cursor })).next_cursor; while (cursor);
}

async function main() {
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' });
  const createAgent = (name, title) => dbModule.bots.create({
    name, title, description: `${title} fixture`, agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  const forge = createAgent('Forge', 'Release implementer');
  const scout = createAgent('Scout', 'Researcher');
  await sync(forge.id); await sync(scout.id);
  fs.writeFileSync(POLICY, `${JSON.stringify({ version: 1, audiences: [AUDIENCE], agents: [{ agent: forge.id, share_from_turn: true }] }, null, 2)}\n`, { mode: 0o600 });
  shareStore.resetSessionSharesConfigCache();
  const ref = (agentId, suffix) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(agentId, `slack-${suffix}-SECRET`).id;
  const make = (agentId, suffix, key, extra = {}) => shareStore.createShare({ creator: dbModule.UI_OWNER_PRINCIPAL, sessionRef: ref(agentId, suffix), agentId, audience: AUDIENCE, idempotencyKey: key, ...extra }).then(result => result.share);
  const now = Date.now();
  const active = await make(forge.id, 'active', 'agent-slack-active');
  const answering = await make(forge.id, 'answering', 'agent-slack-answering');
  db.prepare("UPDATE session_shares SET inflight_turn_ref = 'turn_fixture_answering' WHERE id = ?").run(answering.id);
  const recovering = await make(forge.id, 'recovering', 'agent-slack-recovering', { createdVia: 'current_session' });
  db.prepare("UPDATE session_shares SET inflight_key = 'fixture-lost-question', inflight_owner = 'previous-process' WHERE id = ?").run(recovering.id);
  const exhausted = await make(forge.id, 'exhausted', 'agent-slack-exhausted', { maxTurns: 3 });
  db.prepare('UPDATE session_shares SET turns_used = max_turns WHERE id = ?').run(exhausted.id);
  shareStore.setSessionShareClock(() => now - 2 * 3600_000);
  await make(forge.id, 'expired', 'agent-slack-expired', { ttlSeconds: 300 });
  shareStore.setSessionShareClock(() => now - 3600_000);
  const revoked = await make(forge.id, 'revoked', 'agent-slack-revoked');
  shareStore.revokeShare(revoked.id);
  shareStore.setSessionShareClock(null);
  await make(scout.id, 'other', 'agent-slack-other');
  db.prepare('INSERT INTO slack_share_threads (share_ref, session_ref, team_id, channel_id, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(active.id, active.session_ref, AUDIENCE.team_id, AUDIENCE.channel_id, '1761400000.000100', now - 60_000);
  codex.shutdownDefaultCodexRuntime();
  console.log(JSON.stringify({ db: DB_PATH, policy: POLICY, forge: forge.id, scout: scout.id, shares: 7 }));
}

main().catch(error => { console.error(error); process.exit(1); });
