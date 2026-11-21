#!/usr/bin/env node
// NOT-550: one Agent with active, ended, missing, resumable, Human-origin,
// Agent-origin, and shared sessions for ui-agent-sessions-page-proof.js.
// Everything is written through the canonical engine/provider/share stores.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'agent-sessions-page-fixture.db');
const DIR = path.dirname(DB_PATH);
const STATE = path.resolve(process.env.FAKE_CODEX_STATE || path.join(DIR, 'agent-sessions-page-codex.json'));
const BIN = path.resolve(process.env.BOTMANCERS_CODEX_BIN || path.join(DIR, 'agent-sessions-page-codex'));
const SHARES = path.resolve(process.env.BOTMANCERS_SESSION_SHARES_PATH || path.join(DIR, 'agent-sessions-page-config', 'session-shares.json'));
const WORK = path.resolve(DIR, 'agent-sessions-page-work');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.dirname(SHARES), { recursive: true, mode: 0o700 });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
for (const file of [STATE, SHARES]) fs.rmSync(file, { force: true });
fs.writeFileSync(BIN, `#!/bin/sh\nFAKE_CODEX_STATE='${STATE}' exec '${process.execPath}' '${path.join(ROOT, 'tests', 'support', 'fake-codex.js')}' "$@"\n`);
fs.chmodSync(BIN, 0o755);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_BIN = BIN;
process.env.FAKE_CODEX_STATE = STATE;
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES;

const { seedFakeCodex } = require('../tests/support/fake-codex');
seedFakeCodex(STATE, [
  { id: 'thr-review-open-SECRET', cwd: WORK, name: 'Prepare release review', turns: [['Prepare release review', 'Review notes are ready']] },
  { id: 'thr-review-ended-SECRET', cwd: WORK, name: 'Archived migration notes', archived: true, turns: [['Review migration', 'Archived notes']] },
  { id: 'thr-review-missing-SECRET', cwd: WORK, name: 'Missing dependency audit', turns: [['Audit dependencies', 'Audit complete']] },
]);

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const provider = jiti('../lib/provider-sessions.ts');
const codex = jiti('../lib/codex-session-provider.ts');
const shares = jiti('../lib/session-shares.ts');
jiti('../lib/slack-relay.ts');
const db = dbModule.default;
const OWNER = dbModule.UI_OWNER_PRINCIPAL;
const AUDIENCE = { kind: 'slack', team_id: 'T0BMDEMO1', channel_id: 'C0REVIEWS' };

async function main() {
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' });
  const reviewer = dbModule.bots.create({
    name: 'Reviewer', title: 'Release reviewer', description: 'Reviews operational session history', agent: 'codex',
    runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]',
    policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  const coordinator = dbModule.bots.create({ name: 'Coordinator', title: 'Coordinator', description: 'Delegates review work', agent: 'hermes' });
  let cursor = null;
  do cursor = (await provider.syncAgentSessions(db, reviewer.id, { cursor })).next_cursor; while (cursor);

  const reviewerConversation = dbModule.conversations.getByBotId(reviewer.id);
  const coordinatorConversation = dbModule.conversations.getByBotId(coordinator.id);
  const seedBinding = ({ conversation, requester, intent, kind, external, at }) => {
    const { request } = dbModule.engine.createOrGetWorkRequest({
      sourceConversationId: conversation.id, sourceEventId: `not-550-${external}`, requester, targetAgentId: reviewer.id,
      intent, executionKind: kind, toolProfile: kind === 'implementation' ? 'edit' : 'readonly',
      idempotencyKey: `not-550-${external}`, now: at,
    });
    dbModule.engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running', now: at });
    const attempt = dbModule.engine.createAttempt(request.id, {
      kind: 'launch', adapter: 'codex', toolProfile: request.tool_profile,
      launchSnapshot: { transport: 'direct', cwd: WORK }, now: at,
    });
    dbModule.engine.finishAttempt(attempt.id, { outcome: 'succeeded', output: 'done', externalSessionId: external, now: at + 1000 });
    dbModule.engine.transitionWorkRequest(request.id, { from: 'running', to: 'completed', now: at + 1000 });
    return dbModule.engine.bindSession({
      agentId: reviewer.id, adapter: 'codex', externalSessionId: external, conversationId: conversation.id,
      requestId: request.id, sourceAttemptId: attempt.id, now: at + 1000,
    });
  };
  const now = Date.now();
  seedBinding({
    conversation: coordinatorConversation, requester: { kind: 'bot', id: coordinator.id },
    intent: 'Review the Agent Sessions page', kind: 'implementation', external: 'work-agent-origin-SECRET', at: now - 20 * 60_000,
  });
  seedBinding({
    conversation: reviewerConversation, requester: OWNER,
    intent: 'Summarize the release evidence', kind: 'conversation', external: 'work-human-origin-SECRET', at: now - 10 * 60_000,
  });

  fs.writeFileSync(SHARES, `${JSON.stringify({ version: 1, audiences: [AUDIENCE], agents: [{ agent: reviewer.id, share_from_turn: true }] }, null, 2)}\n`, { mode: 0o600 });
  const refOf = id => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(reviewer.id, id).id;
  const openRef = refOf('thr-review-open-SECRET');
  const shared = await shares.createShare({
    creator: OWNER, sessionRef: openRef, agentId: reviewer.id, audience: AUDIENCE,
    idempotencyKey: 'not-550-shared-session', ttlSeconds: 86400, maxTurns: 10,
  });

  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state.threads['thr-review-missing-SECRET'].deleted = true;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  await provider.refreshProviderSession(db, reviewer.id, refOf('thr-review-missing-SECRET')).catch(() => undefined);
  codex.shutdownDefaultCodexRuntime();

  const meta = {
    db: DB_PATH, agent: { id: reviewer.id, name: reviewer.name }, sessions: 5,
    shared_session_ref: openRef, share_ref: shared.share.id, codex_bin: BIN,
    fake_codex_state: STATE, shares_path: SHARES,
  };
  const metaPath = path.join(DIR, 'agent-sessions-page-fixture.meta.json');
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify({ ...meta, meta: metaPath }));
}

main().catch(error => { console.error(error); process.exit(1); });
