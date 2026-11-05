#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dbPath = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'agent-conversations-fixture.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(dbPath + suffix, { force: true });
process.env.BOTMANCERS_DB_PATH = dbPath;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
const data = jiti('../lib/db.ts');
const db = data.default;
const base = 1800000000000;
const bo = data.bots.create({ name: 'Bo', title: 'Review Agent', description: 'Reviews releases.', agent: 'codex' }, { created_at: base });
const ada = data.bots.create({ name: 'Ada', title: 'Release Agent', description: 'Builds releases.', agent: 'codex' }, { created_at: base + 1 });
const direct = data.conversations.getByBotId(ada.id);
const group = data.groups.create('Release room', [ada.id, bo.id], ada.id, { created_at: base + 2 });
const room = data.conversations.getByGroupId(group.id);

const message = db.prepare('INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
for (let index = 0; index < 84; index++) {
  const mine = index % 2 === 0;
  message.run(`history-${index}`, direct.id, mine ? 'user' : 'bot', mine ? null : ada.id, mine ? 'person' : 'bot', mine ? `Owner history message ${index + 1}` : `Ada history reply ${index + 1}`, base + 100 + index);
}
message.run('draft-card', direct.id, 'bot', ada.id, 'bot', '[draft]\n{"channel":"email","recipient":"release@example.test","body":"Release is ready.","state":"open"}', base + 190);
message.run('approval-card', direct.id, 'bot', ada.id, 'bot', 'Ready to publish; approve using the code release-proof', base + 191);
message.run('artifact-card', direct.id, 'bot', ada.id, 'bot', 'Build report\n[file] release-report.txt', base + 192);
message.run('group-row', room.id, 'bot', bo.id, 'bot', 'Group review is read only here.', base + 193);

function conversation(id, originKind, originId, participants, at) {
  db.prepare('INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'agent', originKind, originId, at);
  const bind = db.prepare('INSERT INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)');
  for (const item of participants) bind.run(id, item.kind, item.id, at);
}
conversation('proof-agent-to-agent', 'bot', bo.id, [{ kind: 'bot', id: bo.id }, { kind: 'bot', id: ada.id }], base + 3);
message.run('agent-row', 'proof-agent-to-agent', 'bot', bo.id, 'bot', 'Review handoff complete.', base + 194);
conversation('proof-slack-origin', 'service', 'slack:C_RELEASES', [{ kind: 'service', id: 'slack:C_RELEASES' }, { kind: 'bot', id: ada.id }], base + 4);
message.run('slack-row', 'proof-slack-origin', 'user', 'slack:C_RELEASES', 'service', 'Slack asked for release status.', base + 195);

const bindingId = 'proof-session-binding';
db.prepare(`
  INSERT INTO session_bindings (id, agent_id, adapter, conversation_id, request_id, external_session_id, source_attempt_id, created_at, released_at)
  VALUES (?, ?, 'codex', ?, NULL, 'proof-external-session', NULL, ?, NULL)
`).run(bindingId, ada.id, direct.id, base + 5);
const exchangeId = 'proof-exchange-focus';
db.prepare(`
  INSERT INTO session_exchanges (
    id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
    source_agent_id, source_binding_id, destination_agent_id, destination_conversation_id, instruction,
    state, created_at, updated_at, terminal_at
  ) VALUES (?, 'person', 'local-owner', 'proof-exchange-focus', 'proof-hash', 'ask', ?, ?, ?, NULL, NULL, 'Confirm the release packet.', 'queued', ?, ?, NULL)
`).run(exchangeId, direct.id, ada.id, bindingId, base + 196, base + 196);

const fixture = {
  agentId: ada.id,
  directId: direct.id,
  groupId: room.id,
  agentConversationId: 'proof-agent-to-agent',
  externalId: 'proof-slack-origin',
  exchangeId,
};
const fixturePath = path.join(path.dirname(dbPath), 'agent-conversations-fixture.json');
fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
db.close();
console.log(`Seeded ${dbPath}: agent=${ada.id}, direct=${direct.id}, exchange=${exchangeId}, fixture=${fixturePath}`);
