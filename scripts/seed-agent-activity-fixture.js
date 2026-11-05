#!/usr/bin/env node
// NOT-553 deterministic real-app fixture. No provider process or live log is
// read: all visible facts are seeded canonical Botmancers records.
'use strict';

const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'agent-activity-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
const dbModule = jiti('../lib/db.ts');
jiti('../lib/session-shares.ts');
const db = dbModule.default;
const now = Date.now();
const agent = dbModule.bots.create({ name: 'Forge', title: 'Release implementer', description: 'Own release implementation.', agent: 'codex' });
const other = dbModule.bots.create({ name: 'Scout', title: 'Researcher', description: 'Private fixture Agent.', agent: 'codex' });
const conversation = dbModule.conversations.getByBotId(agent.id);
const binding = dbModule.engine.bindSession({ agentId: agent.id, adapter: 'codex', externalSessionId: 'private-provider-fixture', conversationId: conversation.id, now: now - 90_000 });
const event = db.prepare('INSERT INTO provider_session_events (id, agent_id, session_ref, turn_id, type, detail, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)');
event.run('activity-session-started', agent.id, binding.id, 'session_started', '{"authority":"read_only"}', now - 80_000);
event.run('activity-turn-failed', agent.id, binding.id, 'turn_failed', '{}', now - 20_000);
event.run('activity-other-missing', other.id, null, 'session_missing', '{}', now - 10_000);
db.prepare(`INSERT INTO session_exchanges (
  id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id, source_agent_id,
  source_binding_id, instruction, state, version, created_at, updated_at
) VALUES ('activity-exchange', 'person', 'local-owner', 'activity-exchange', 'hash', 'ask', ?, ?, ?, 'Fixture question', 'queued', 0, ?, ?)`)
  .run(conversation.id, agent.id, binding.id, now - 70_000, now - 70_000);
db.prepare("INSERT INTO session_exchange_events (id, exchange_id, sequence, type, data, created_at) VALUES ('activity-exchange-created', 'activity-exchange', 1, 'created', '{}', ?)").run(now - 70_000);
db.prepare(`INSERT INTO session_shares (
  id, creator_kind, creator_id, idempotency_key, request_hash, agent_id, session_ref, pin_ref, authority, audience_kind,
  audience_team_id, audience_channel_id, created_via, ttl_seconds, max_turns, turns_used, state, created_at, expires_at, updated_at
) VALUES ('shr_activity_fixture', 'person', 'local-owner', 'activity-share', 'hash', ?, ?, 'activity-pin', 'ask', 'slack',
  'T0FIXTURE', 'C0REVIEWS', 'session_ref', 3600, 10, 0, 'active', ?, ?, ?)`)
  .run(agent.id, binding.id, now - 60_000, now + 3_600_000, now - 60_000);
db.prepare("INSERT INTO session_share_events (share_ref, sequence, type, at) VALUES ('shr_activity_fixture', 1, 'created', ?)").run(now - 60_000);
console.log(JSON.stringify({ db: DB_PATH, forge: agent.id, other: other.id }));
