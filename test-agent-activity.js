#!/usr/bin/env node
// NOT-553: deterministic Agent Activity projection and UI contract.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const ROOT = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-activity-'));
process.env.BOTMANCERS_DB_PATH = path.join(temp, 'activity.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const dbModule = jiti('./lib/db.ts');
jiti('./lib/session-shares.ts'); // install the canonical share tables
jiti('./lib/slack-relay.ts'); // install the canonical Slack thread ledger
const raw = dbModule.default;
const { bots, conversations, engine } = dbModule;
const activity = jiti('./lib/agent-activity.ts');
const {
  ActivityList,
  ActivityResults,
  activityPageReducer,
  agentActivityUrl,
  initialActivityPageState,
} = jiti('./app/agents/[id]/activity/AgentActivityPage.tsx');

const SECRET = {
  provider: 'provider-session-SENTINEL-553',
  token: 'xoxb-SENTINEL-553',
  transcript: 'TRANSCRIPT-SENTINEL-553',
  path: '/Users/private/SENTINEL-553/worktree',
  payload: 'RUNTIME-PAYLOAD-SENTINEL-553',
};
const BASE = 1_800_000_000_000;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

function createAgent(name) { return bots.create({ name, title: 'Operator', description: `${name} fixture`, agent: 'codex' }, { created_at: BASE }); }
function providerEvent(id, agentId, ref, type, at, detail = {}) {
  raw.prepare('INSERT INTO provider_session_events (id, agent_id, session_ref, turn_id, type, detail, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
    .run(id, agentId, ref, type, JSON.stringify(detail), at);
}

try {
  const ada = createAgent('Ada Activity');
  const bo = createAgent('Bo Activity');
  const adaConversation = conversations.getByBotId(ada.id);
  const boConversation = conversations.getByBotId(bo.id);
  const first = engine.bindSession({ agentId: ada.id, adapter: 'codex', externalSessionId: SECRET.provider, conversationId: adaConversation.id, now: BASE + 10 });
  engine.bindSession({ agentId: ada.id, adapter: 'codex', externalSessionId: `${SECRET.provider}-replacement`, conversationId: adaConversation.id, now: BASE + 20 });
  const boBinding = engine.bindSession({ agentId: bo.id, adapter: 'codex', externalSessionId: 'bo-private-provider-id', conversationId: boConversation.id, now: BASE + 15 });

  // A provider registry row can be linked to a binding while retaining its
  // own internal row id. Activity links must use the Session catalog ref.
  const registered = raw.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(first.id);
  raw.prepare('DELETE FROM provider_sessions WHERE id = ?').run(first.id);
  raw.prepare(`INSERT INTO provider_sessions (
    id, agent_id, runtime_connection_id, provider_kind, provider_session_id, binding_id, origin,
    availability, lifecycle, resumable, busy, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'started', 'available', 'open', 1, 0, ?, ?)`)
    .run('provider-registry-ada', ada.id, registered.runtime_connection_id, registered.provider_kind, SECRET.provider, first.id, BASE + 10, BASE + 10);

  providerEvent('pse-ada-start', ada.id, 'provider-registry-ada', 'session_started', BASE + 30, { authority: 'read_only', token: SECRET.token, path: SECRET.path });
  providerEvent('pse-ada-fail', ada.id, 'provider-registry-ada', 'turn_failed', BASE + 60, { payload: SECRET.payload });
  for (let i = 0; i < 24; i++) providerEvent(`pse-sync-${i}`, ada.id, 'provider-registry-ada', 'session_synced', BASE + 100 + i, { transcript: SECRET.transcript });
  providerEvent('pse-bo', bo.id, boBinding.id, 'session_missing', BASE + 70, { transcript: SECRET.transcript });

  // Arbitrary prose is durable message content, but never an Activity
  // lifecycle authority.
  dbModule.messages.create(adaConversation.id, 'user', `Session failed and Slack share revoked. ${SECRET.transcript}`);

  raw.pragma('foreign_keys = OFF');
  const insertConversationEvent = raw.prepare(`INSERT INTO conversation_events (
    id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id,
    kind, state, text, data, sort_at, request_created_at, created_at
  ) VALUES (?, ?, NULL, 0, NULL, ?, NULL, ?, ?, ?, ?, '{}', ?, ?, ?)`);
  insertConversationEvent.run('conversation-event-queued', adaConversation.id, 1, 'fixture-wake-queued', 'request_queued', 'queued', `Queued ${SECRET.transcript}`, BASE + 42, BASE + 42, BASE + 42);
  insertConversationEvent.run('conversation-event-finalization', adaConversation.id, 2, 'fixture-wake-finalization', 'finalization_failed', 'failed', `Failed ${SECRET.transcript}`, BASE + 57, BASE + 42, BASE + 57);
  raw.pragma('foreign_keys = ON');

  raw.prepare(`INSERT INTO session_exchanges (
    id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
    source_agent_id, source_binding_id, instruction, state, version, created_at, updated_at
  ) VALUES (?, 'person', 'local-owner', ?, 'hash', 'ask', ?, ?, ?, ?, 'queued', 0, ?, ?)`)
    .run('exchange-ada', 'exchange-ada-key', adaConversation.id, ada.id, first.id, `Do not expose ${SECRET.transcript}`, BASE + 35, BASE + 35);
  raw.prepare('INSERT INTO session_exchange_events (id, exchange_id, sequence, type, data, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run('exchange-event-created', 'exchange-ada', 'created', JSON.stringify({ provider_session_id: SECRET.provider, payload: SECRET.payload }), BASE + 36);
  raw.prepare('INSERT INTO session_exchange_events (id, exchange_id, sequence, type, data, created_at) VALUES (?, ?, 2, ?, ?, ?)')
    .run('exchange-event-failed', 'exchange-ada', 'state_changed', JSON.stringify({ from: 'queued', to: 'failed', failure_message: SECRET.transcript }), BASE + 55);

  raw.prepare(`INSERT INTO session_shares (
    id, creator_kind, creator_id, idempotency_key, request_hash, agent_id, session_ref, pin_ref, authority,
    audience_kind, audience_team_id, audience_channel_id, created_via, ttl_seconds, max_turns, turns_used,
    state, created_at, expires_at, updated_at
  ) VALUES (?, 'person', 'local-owner', ?, 'hash', ?, ?, ?, 'ask', 'slack', 'TSAFE', 'CSAFE', 'session_ref', 300, 3, 0, 'active', ?, ?, ?)`)
    .run('shr_ada_activity', 'share-key', ada.id, first.id, 'pin-ada-activity', BASE + 40, BASE + 50, BASE + 40);
  raw.prepare("INSERT INTO session_share_events (share_ref, sequence, type, at) VALUES ('shr_ada_activity', 1, 'created', ?)").run(BASE + 40);
  raw.prepare("INSERT INTO session_share_events (share_ref, sequence, type, code, at) VALUES ('shr_ada_activity', 2, 'turn_refused', 'expired', ?)").run(BASE + 58);
  raw.prepare(`INSERT INTO slack_share_threads (share_ref, session_ref, team_id, channel_id, thread_ts, created_at)
    VALUES ('shr_ada_activity', ?, 'TSAFE', 'CSAFE', '1800000000.000100', ?)`)
    .run(first.id, BASE + 45);

  test('Agent scope, stable kinds, newest-first order, targets, severity, and safe details', () => {
    const page = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 100 });
    assert.ok(page.items.length >= 9);
    assert.deepEqual(page.items.map(row => row.occurred_at), [...page.items.map(row => row.occurred_at)].sort((a, b) => b - a));
    assert.ok(page.items.every(row => typeof row.kind === 'string' && row.target.href && typeof row.attention === 'boolean'));
    assert.ok(page.items.some(row => row.kind === 'session.active' && row.target.href.includes(`/agents/${ada.id}/sessions`)));
    assert.ok(page.items.some(row => row.kind === 'conversation.created' && row.target.href.includes(`/agents/${ada.id}/conversations/`)));
    assert.ok(page.items.some(row => row.kind === 'exchange.created' && row.target.href === '/exchanges?id=exchange-ada'));
    assert.ok(page.items.some(row => row.kind === 'slack.share_created' && row.target.href.endsWith('/slack')));
    assert.ok(page.items.some(row => row.kind.startsWith('availability.') && row.target.href === `/agents/${ada.id}/config`));
    assert.ok(page.items.some(row => row.kind === 'session.turn_failed' && row.severity === 'error' && row.attention));
    assert.ok(page.items.some(row => row.kind === 'conversation.request_queued'));
    assert.ok(page.items.some(row => row.kind === 'conversation.finalization_failed'));
    assert.ok(page.items.some(row => row.kind === 'slack.thread_posted'));
    const linked = page.items.find(row => row.id === 'provider-session-event:pse-ada-start');
    assert.equal(linked.target.href, `/agents/${ada.id}/sessions?session=${first.id}`);
    assert.equal(linked.target.href.includes('provider-registry-ada'), false);
    assert.ok(page.items.every(row => !row.id.includes('pse-bo') && !row.target.href.includes(bo.id)));
    assert.equal(activity.listAgentActivity('missing-agent', { filter: 'all', cursor: null, limit: 20 }), null);
  });

  test('filters are deterministic and arbitrary message prose creates no lifecycle event', () => {
    const list = filter => activity.listAgentActivity(ada.id, { filter, cursor: null, limit: 100 }).items;
    assert.ok(list('sessions').every(row => row.category === 'sessions'));
    assert.ok(list('conversations').every(row => row.category === 'conversations'));
    assert.ok(list('slack').every(row => row.category === 'slack'));
    assert.ok(list('errors').every(row => row.severity === 'error'));
    assert.equal(list('all').some(row => row.summary.includes('Slack share revoked')), false);
    assert.equal(list('all').some(row => row.kind === 'slack.share_revoked'), false);
    assert.equal(list('all').some(row => row.id.startsWith('provider-session-event:pse-sync-')), false);
    const preview = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 4 }).items;
    assert.ok(preview.some(row => row.kind === 'session.turn_failed'), 'sync heartbeats do not displace lifecycle events');
  });

  test('cursor pagination is stable, filter- and Agent-bound', () => {
    const firstPage = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 3 });
    const secondPage = activity.listAgentActivity(ada.id, { filter: 'all', cursor: firstPage.next_cursor, limit: 3 });
    assert.equal(firstPage.items.length, 3);
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map(row => row.id)).size, firstPage.items.length + secondPage.items.length);
    assert.throws(() => activity.listAgentActivity(bo.id, { filter: 'all', cursor: firstPage.next_cursor, limit: 3 }), activity.InvalidPageCursorError);
    assert.throws(() => activity.listAgentActivity(ada.id, { filter: 'errors', cursor: firstPage.next_cursor, limit: 3 }), activity.InvalidPageCursorError);
  });

  test('redaction matrix excludes provider ids, credentials, transcripts, paths, and payloads', () => {
    const serialized = JSON.stringify(activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 100 }));
    for (const forbidden of Object.values(SECRET)) assert.equal(serialized.includes(forbidden), false, `excluded ${forbidden}`);
    for (const key of ['provider_session_id', 'external_session_id', 'instruction', 'content', 'failure_message']) assert.equal(serialized.includes(`"${key}"`), false);
  });

  test('shared UI renders human summaries, links, collapsed disclosure, and attention state', () => {
    const items = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 8 }).items;
    const html = renderToStaticMarkup(React.createElement(ActivityList, { items }));
    assert.match(html, /Agent activity, newest first/);
    assert.match(html, /Raw details/);
    assert.doesNotMatch(html, /details open/);
    assert.match(html, /Needs attention/);
    assert.match(html, /Open (session|conversation|exchange|Slack)/);
    for (const forbidden of Object.values(SECRET)) assert.equal(html.includes(forbidden), false);
  });

  test('UI state model drives filter, pagination, empty, and error behavior', () => {
    const all = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 8 }).items;
    let state = activityPageReducer(initialActivityPageState, { type: 'select_filter', filter: 'errors' });
    assert.equal(state.filter, 'errors');
    assert.equal(state.activity.state, 'loading');
    state = activityPageReducer(state, { type: 'request_started', key: 'ada:errors:1' });
    state = activityPageReducer(state, { type: 'request_succeeded', key: 'ada:errors:1', items: all.slice(0, 2), nextCursor: 'older-page' });
    let html = renderToStaticMarkup(React.createElement(ActivityResults, {
      activity: state.activity, filter: state.filter, nextCursor: state.nextCursor, loadingMore: state.loadingMore, onLoadMore() {},
    }));
    assert.match(html, /Load older activity/);
    assert.match(html, /Raw details/);

    state = activityPageReducer(state, { type: 'load_started', key: 'ada:errors:1' });
    assert.equal(state.loadingMore, true);
    state = activityPageReducer(state, { type: 'load_succeeded', key: 'ada:errors:1', items: all.slice(2, 4), nextCursor: null });
    assert.equal(state.activity.items.length, 4);
    assert.equal(state.loadingMore, false);
    assert.equal(state.nextCursor, null);

    state = activityPageReducer(state, { type: 'select_filter', filter: 'slack' });
    state = activityPageReducer(state, { type: 'request_started', key: 'ada:slack:2' });
    state = activityPageReducer(state, { type: 'request_succeeded', key: 'ada:slack:2', items: [], nextCursor: null });
    html = renderToStaticMarkup(React.createElement(ActivityResults, {
      activity: state.activity, filter: state.filter, nextCursor: null, loadingMore: false, onLoadMore() {},
    }));
    assert.match(html, /No slack activity matches this filter/);

    state = activityPageReducer(state, { type: 'request_started', key: 'ada:slack:3' });
    state = activityPageReducer(state, { type: 'request_failed', key: 'ada:slack:3' });
    html = renderToStaticMarkup(React.createElement(ActivityResults, {
      activity: state.activity, filter: state.filter, nextCursor: null, loadingMore: false, onLoadMore() {},
    }));
    assert.match(html, /role="alert"/);
    assert.match(html, /Activity unavailable/);
    assert.equal(agentActivityUrl('agent / one', 'conversations', 'cursor+/='), '/api/bots/agent%20%2F%20one/activity?filter=conversations&limit=20&cursor=cursor%2B%2F%3D');
  });

  test('Overview compact list renders the full four-item projection bound', () => {
    const items = activity.listAgentActivity(ada.id, { filter: 'all', cursor: null, limit: 4 }).items;
    const html = renderToStaticMarkup(React.createElement(ActivityList, { items, compact: true }));
    assert.equal((html.match(/class="agent-activity-item /g) || []).length, 4);
    assert.doesNotMatch(html, /Raw details/);
  });

  console.log(`\n${passed} passed`);
} finally {
  raw.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
