#!/usr/bin/env node
// NOT-552: focused Agent Slack page contract. Uses the deterministic seeded
// owner store, server-renders every relay state, and verifies paging,
// lifecycle presentation, cross-Agent isolation, navigation, and redaction.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createJiti } = require('jiti');

const ROOT = require('./support/repo-root');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-slack-'));
const env = {
  ...process.env,
  BOTMANCERS_DB_PATH: path.join(temp, 'agent-slack.db'),
  BOTMANCERS_SESSION_SHARES_PATH: path.join(temp, 'config', 'session-shares.json'),
  BOTMANCERS_CODEX_BIN: path.join(temp, 'fake-codex'),
  FAKE_CODEX_STATE: path.join(temp, 'fake-codex.json'),
  BOTMANCERS_NO_AUTOPROCESS: '1',
};
const seeded = spawnSync(process.execPath, ['scripts/seed-agent-slack-fixture.js'], { cwd: ROOT, env, encoding: 'utf8' });
if (seeded.status !== 0) throw new Error(seeded.stderr || seeded.stdout);
Object.assign(process.env, env);
const fixture = JSON.parse(seeded.stdout.trim().split('\n').at(-1));
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const db = jiti('../lib/db.ts').default;
const { listOwnerShares } = jiti('../lib/session-share-owner.ts');
const view = jiti('../lib/agent-slack-view.ts');
const { AgentSlackView } = jiti('../app/agents/[id]/slack/AgentSlackPage.tsx');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const ready = value => ({ state: 'ready', value });
const policy = {
  state: 'loaded', reason: null, revision: 'fixture', audiences: [{ kind: 'slack', team_id: 'T0BMDEMO1', channel_id: 'C0REVIEWS' }],
  agent: { id: fixture.forge, share_from_turn: true, share_current: { supported: true, reason: null }, live_contexts: 0 },
  limits: { ttl_seconds: { min: 300, default: 3600, max: 86400 }, max_turns: { min: 1, default: 20, max: 100 }, audiences: 512 },
};
const render = props => renderToStaticMarkup(React.createElement(AgentSlackView, {
  agentId: fixture.forge, agentName: 'Forge', relay: ready({ state: 'connected', reason: null, since: Date.now(), connections: 1 }),
  policy: ready(policy), shares: ready([]), filter: 'all', nextCursor: null, refreshing: false, loadingMore: false,
  onFilter() {}, onRefresh() {}, onLoadMore() {}, onSharesChanged() {}, ...props,
}));
const SECRET = /SENTINEL_RAW_TRANSPORT|xoxb-super-secret|xapp-super-secret|slack\.com\/socket|\/Users\/secret/;

try {
  test('every redacted relay state renders safe status and recovery guidance', () => {
    for (const state of view.RELAY_STATES) {
      const reason = state === 'disabled' ? 'slack_tokens_absent' : state === 'misconfigured' ? 'bot_token_missing' : state === 'failed' ? 'slack_connect_failed' : null;
      const health = view.normalizeRelayHealth({ state, reason, since: 1, connections: 2, token: 'xoxb-super-secret', error: 'SENTINEL_RAW_TRANSPORT slack.com/socket /Users/secret' });
      const html = render({ relay: ready(health) });
      assert.match(html, new RegExp(`data-relay-state="${state}"`));
      assert.ok(view.relayCopy(health).guidance.length > 20);
      assert.equal(SECRET.test(html), false, state);
    }
    for (const [state, reason] of [
      ['disabled', 'slack_tokens_absent'],
      ['misconfigured', 'app_token_missing'], ['misconfigured', 'bot_token_missing'],
      ['misconfigured', 'app_token_invalid'], ['misconfigured', 'bot_token_invalid'],
      ['misconfigured', 'share_config_absent'], ['misconfigured', 'share_config_invalid'],
      ['misconfigured', 'share_config_no_audience'], ['misconfigured', 'workspace_not_allowlisted'],
      ['failed', 'slack_auth_failed'], ['failed', 'slack_connect_failed'],
    ]) {
      const health = view.normalizeRelayHealth({ state, reason, since: 1, connections: 0, error: 'SENTINEL_RAW_TRANSPORT' });
      const html = render({ relay: ready(health) });
      assert.ok(view.relayCopy(health).guidance.length > 20, `${state}/${reason}`);
      assert.equal(SECRET.test(html), false, `${state}/${reason}`);
    }
  });

  test('unknown health and API failures have deterministic error states without raw errors', () => {
    assert.equal(view.normalizeRelayHealth({ state: 'connected', reason: 'SENTINEL_RAW_TRANSPORT', error: 'xoxb-super-secret' }).reason, null);
    const html = render({ relay: { state: 'error' }, policy: { state: 'error' }, shares: { state: 'error' } });
    assert.match(html, /Relay health unavailable/);
    assert.match(html, /Sharing policy unavailable/);
    assert.match(html, /Shared sessions unavailable/);
    assert.equal(SECRET.test(html), false);
    assert.match(render({ shares: ready([]), filter: 'active' }), /No live shares for Forge/);
  });

  const all = listOwnerShares(new URLSearchParams({ agent_id: fixture.forge, limit: '100' }));
  test('selected Agent list contains every lifecycle status and no other Agent shares', () => {
    assert.deepEqual(new Set(all.shares.map(share => share.status)), new Set(view.ALL_SHARE_STATUSES));
    assert.ok(all.shares.every(share => share.agent.id === fixture.forge));
    assert.equal(JSON.stringify(all).includes(fixture.scout), false);
    assert.equal(SECRET.test(JSON.stringify(all)), false);
  });

  test('owner state filtering and opaque pagination remain Agent-scoped', () => {
    const first = listOwnerShares(new URLSearchParams({ agent_id: fixture.forge, state: 'active', limit: '2' }));
    assert.equal(first.shares.length, 2);
    assert.ok(first.next_cursor);
    const second = listOwnerShares(new URLSearchParams({ agent_id: fixture.forge, state: 'active', limit: '2', cursor: first.next_cursor }));
    assert.ok(second.shares.length > 0);
    assert.equal(new Set([...first.shares, ...second.shares].map(share => share.share_ref)).size, first.shares.length + second.shares.length);
    assert.ok([...first.shares, ...second.shares].every(share => share.agent.id === fixture.forge && share.state === 'active'));
  });

  test('page separates the one relay from shared threads and shows lifecycle summaries', () => {
    const html = render({ shares: ready(all.shares), nextCursor: 'fixture-next' });
    assert.match(html, /Botmancers-wide connection/);
    assert.match(html, /single Botmancers Slack relay/);
    assert.match(html, /does not have a separate Slack app/);
    assert.match(html, /Shared session threads/);
    for (const status of view.ALL_SHARE_STATUSES) assert.match(html, new RegExp(`data-share-status="${status}"`));
    assert.match(html, /Slack channel C0REVIEWS · workspace T0BMDEMO1/);
    assert.match(html, /question/);
    for (const detail of ['Owning session', 'Posted thread', 'Creation path', 'Created by', 'Ask only · exact session', 'Share reference']) assert.match(html, new RegExp(detail));
    assert.match(html, /Load more shares/);
    assert.equal(SECRET.test(html), false);
  });

  test('navigation, progressive detail, refresh, filters, and confirmed revoke use existing owner paths', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/slack/AgentSlackPage.tsx'), 'utf8');
    assert.match(source, /fetch\('\/api\/health'/);
    assert.match(source, /\/share-policy`/);
    assert.match(source, /agent_id/);
    assert.match(source, /state', filter/);
    assert.match(source, /cursor/);
    assert.match(source, /Share a session/);
    assert.match(source, /\/agents\/\$\{encodeURIComponent\(agentId\)\}\/sessions/);
    assert.match(source, /config#session-sharing/);
    assert.match(source, /Creation path/);
    assert.match(source, /Posted thread/);
    assert.match(source, /Open owning session/);
    assert.match(source, /\?session=\$\{encodeURIComponent\(share\.session_ref\)\}/);
    assert.match(source, /data-share-action="confirm-revoke"/);
    assert.match(source, /requestAnimationFrame\(\(\) => revokeButton\.current\?\.focus\(\)\)/);
    assert.match(source, /method: 'POST'/);
    const sessions = fs.readFileSync(path.join(ROOT, 'app/components/SessionsPanel.tsx'), 'utf8');
    const home = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
    // NOT-550: Slack owning-session links land on the Agent Sessions page;
    // ?session= still forces that exact catalog row onto the first page.
    assert.match(sessions, /requestedRef/);
    assert.match(sessions, /sessions\/\$\{encodeURIComponent\(requestedRef\)\}/);
    assert.match(home, /sessions\?session=\$\{encodeURIComponent\(session\)\}/);
  });

  test('Overview entry and release check include the Agent Slack page', () => {
    const overview = fs.readFileSync(path.join(ROOT, 'app/agents/[id]/page.tsx'), 'utf8');
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.match(overview, /Share a session to Slack/);
    assert.match(overview, /\/agents\/\$\{encodeURIComponent\(id\)\}\/slack/);
    assert.match(workflow, /run: npm test/);
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    const target = (scripts['test:agent-slack-page'].match(/node\s+(\S+)/) || [])[1];
    assert.ok(target && fs.existsSync(path.join(ROOT, target)), `test:agent-slack-page still resolves to an existing suite (${target})`);
  });
} finally {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
