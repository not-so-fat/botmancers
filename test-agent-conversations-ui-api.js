#!/usr/bin/env node
// NOT-551: owner-scoped Agent conversation projection and route/UI contract.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-owner-conversations-'));
process.env.BOTMANCERS_DB_PATH = path.join(temp, 'conversations.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';
process.env.NOT551_TEST_TOKEN = 'not551-owner-secret-value';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const projection = jiti('./lib/owner-conversations.ts');
const listRoute = jiti('./app/api/bots/[id]/conversations/route.ts');
const detailRoute = jiti('./app/api/bots/[id]/conversations/[conversationId]/route.ts');
const legacyThreadRoute = jiti('./app/threads/[id]/route.ts');
const exchangeView = jiti('./lib/exchange-view.ts');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const db = dbModule.default;
const at = 1800000000000;
const ada = dbModule.bots.create({ name: 'Ada', title: 'Builder', description: 'Builds.', agent: 'codex' }, { created_at: at });
const bo = dbModule.bots.create({ name: 'Bo', title: 'Reviewer', description: 'Reviews.', agent: 'codex' }, { created_at: at + 1 });
const other = dbModule.bots.create({ name: 'Cy', title: 'Other', description: 'Other.', agent: 'codex' }, { created_at: at + 2 });
const direct = dbModule.conversations.getByBotId(ada.id);
const group = dbModule.groups.create('Release room', [ada.id, bo.id], ada.id, { created_at: at + 20 });
const groupConversation = dbModule.conversations.getByGroupId(group.id);
assert.ok(direct && groupConversation);

function agentConversation(id, originKind, originId, participants, createdAt) {
  db.prepare('INSERT INTO conversations (id, type, origin_kind, origin_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'agent', originKind, originId, createdAt);
  const insert = db.prepare('INSERT INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)');
  for (const participant of participants) insert.run(id, participant.kind, participant.id, createdAt);
}

agentConversation('agent-to-agent', 'bot', bo.id, [{ kind: 'bot', id: ada.id }, { kind: 'bot', id: bo.id }], at + 30);
agentConversation('external-service', 'service', 'linear-sync', [{ kind: 'service', id: 'linear-sync' }, { kind: 'bot', id: ada.id }], at + 40);
agentConversation('not-ada', 'service', 'other-service', [{ kind: 'service', id: 'other-service' }, { kind: 'bot', id: other.id }], at + 50);

const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
insertMessage.run('direct-message', direct.id, 'user', null, 'person', 'hello Ada', at + 101);
insertMessage.run('group-message', groupConversation.id, 'bot', bo.id, 'bot', 'group reply', at + 102);
insertMessage.run('agent-message', 'agent-to-agent', 'bot', bo.id, 'bot', 'agent reply', at + 103);
insertMessage.run('service-message', 'external-service', 'user', 'linear-sync', 'service', 'external request not551-owner-secret-value', at + 104);
insertMessage.run('other-message', 'not-ada', 'user', 'other-service', 'service', 'not visible', at + 105);

async function json(response) { return { status: response.status, body: await response.json() }; }
function request(pathname) { return new Request(`http://127.0.0.1:3333${pathname}`, { headers: { host: '127.0.0.1:3333' } }); }

(async () => {
  try {
    await test('lists every canonical type involving only the selected Agent, newest first', () => {
      const page = projection.listOwnerConversations(ada.id, { q: null, cursor: null, limit: 20 });
      assert.deepEqual(page.items.map(item => item.conversation_id), ['external-service', 'agent-to-agent', groupConversation.id, direct.id]);
      assert.deepEqual(page.items.map(item => item.type), ['agent', 'agent', 'group', 'direct']);
      assert.equal(page.items.some(item => item.conversation_id === 'not-ada'), false);
      for (const row of page.items) {
        assert.ok(row.participants.length >= 2);
        assert.equal(row.message_count, 1);
        assert.ok(row.origin);
      }
    });

    await test('stable cursor pagination and participant search preserve scope', () => {
      const first = projection.listOwnerConversations(ada.id, { q: null, cursor: null, limit: 2 });
      assert.equal(first.items.length, 2);
      assert.ok(first.next_cursor);
      const second = projection.listOwnerConversations(ada.id, { q: null, cursor: first.next_cursor, limit: 2 });
      assert.deepEqual(second.items.map(item => item.conversation_id), [groupConversation.id, direct.id]);
      assert.equal(second.next_cursor, null);
      const searched = projection.listOwnerConversations(ada.id, { q: 'linear-sync', cursor: null, limit: 20 });
      assert.deepEqual(searched.items.map(item => item.conversation_id), ['external-service']);
      assert.throws(() => projection.listOwnerConversations(bo.id, { q: null, cursor: first.next_cursor, limit: 2 }), projection.InvalidPageCursorError);
    });

    await test('writable authority is limited to the local-owner direct thread', () => {
      const page = projection.listOwnerConversations(ada.id, { q: null, cursor: null, limit: 20 });
      assert.equal(page.items.find(item => item.conversation_id === direct.id).writable, true);
      for (const id of ['external-service', 'agent-to-agent', groupConversation.id]) {
        const row = page.items.find(item => item.conversation_id === id);
        assert.equal(row.writable, false);
        assert.ok(row.read_only_reason);
      }
    });

    await test('detail returns ordered redacted history and mismatched pairs are nondisclosing 404s', async () => {
      const detail = projection.getOwnerConversation(ada.id, 'external-service', { cursor: null, limit: 20 });
      assert.equal(detail.messages[0].content, 'external request [redacted]');
      assert.equal(detail.messages[0].sender_name, 'Service linear-sync');
      assert.equal(projection.getOwnerConversation(ada.id, 'not-ada', { cursor: null, limit: 20 }), null);
      const response = await json(await detailRoute.GET(request(`/api/bots/${ada.id}/conversations/not-ada`), { params: Promise.resolve({ id: ada.id, conversationId: 'not-ada' }) }));
      assert.equal(response.status, 404);
      assert.equal(response.body.error, 'Conversation not found');
    });

    await test('owner routes need loopback but never a service token', async () => {
      const ok = await json(await listRoute.GET(request(`/api/bots/${ada.id}/conversations?limit=2`), { params: Promise.resolve({ id: ada.id }) }));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.conversations.length, 2);
      const refusedRequest = new Request(`http://example.test/api/bots/${ada.id}/conversations`, { headers: { host: 'example.test' } });
      const refused = await json(await listRoute.GET(refusedRequest, { params: Promise.resolve({ id: ada.id }) }));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'owner_origin_required');
    });

    await test('legacy direct/group and exchange backlinks preserve the conversation target', async () => {
      let redirected = '';
      try {
        await legacyThreadRoute.GET(request(`/threads/${groupConversation.id}?exchange=exchange-1`), { params: Promise.resolve({ id: groupConversation.id }) });
      } catch (error) {
        redirected = String(error?.digest ?? error);
      }
      assert.match(redirected, new RegExp(`/agents/${ada.id}/conversations/${groupConversation.id}\\?exchange=exchange-1`));
      assert.equal(exchangeView.threadHref({ id: direct.id, kind: 'direct', thread_agent_id: ada.id }, 'exchange-2'), `/agents/${ada.id}/conversations/${direct.id}?exchange=exchange-2`);
      const refused = await json(await legacyThreadRoute.GET(
        new Request(`http://example.test/threads/${groupConversation.id}`, { headers: { host: 'example.test' } }),
        { params: Promise.resolve({ id: groupConversation.id }) },
      ));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'owner_origin_required');
    });

    await test('old /?agent= chat links resolve to detail or Conversations fallback', () => {
      assert.equal(
        projection.legacyAgentChatHref(ada.id, direct.id, 'exchange-legacy'),
        `/agents/${ada.id}/conversations/${direct.id}?exchange=exchange-legacy`,
      );
      assert.equal(
        projection.legacyAgentChatHref(ada.id, null, 'exchange-missing'),
        `/agents/${ada.id}/conversations?exchange=exchange-missing`,
      );
      assert.equal(projection.legacyAgentChatHref(ada.id, null), `/agents/${ada.id}/conversations`);
      const home = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
      assert.match(home, /legacyAgentChatHref\(linkedAgent,\s*conversation\?\.id \?\? null,\s*exchange\)/);
      assert.match(home, /legacyAgentChatHref\(linkedAgent,\s*null,\s*exchange\)/);
      assert.equal(home.includes('linkedAgentRef'), false);
    });

    await test('list/detail source has deterministic states and preserves the direct-chat capability set', () => {
      const list = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/conversations/page.tsx'), 'utf8');
      const detail = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/conversations/[conversationId]/ConversationDetail.tsx'), 'utf8');
      const overview = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/page.tsx'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
      for (const state of ['loading', 'error', 'empty']) assert.ok(list.includes(`data-conversation-state="${state}"`), state);
      for (const text of ['Search conversations', 'Load older conversations', 'Origin:', 'messages']) assert.ok(list.includes(text), text);
      for (const capability of ['/messages', '/stop', '/draft', 'approve', 'deny', 'Attach', 'WakeNotice', 'ExchangeCard', 'setInterval']) assert.ok(detail.includes(capability), capability);
      assert.match(detail, /detail\.writable \? <div className="composer/);
      assert.match(detail, /Read-only history/);
      assert.match(detail, /read_only_reason/);
      assert.match(detail, /Load older messages/);
      assert.match(css, /\.conversation-message-list[\s\S]*?overflow-y: auto/);
      assert.match(css, /@media \(max-width: 799px\)[\s\S]*?\.conversation-index/);
      assert.match(overview, /overview\.conversation\.id/);
    });
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
