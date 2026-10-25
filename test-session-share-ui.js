#!/usr/bin/env node
// NOT-519: the owner's session-share UI (app/components/SessionShares,
// app/components/SharePolicyCard, lib/share-view). Server-renders the
// Slack share section of a Sessions row for every share state (active,
// answering, recovering, exhausted, expired, revoked) and every reason
// Share to Slack is withheld (session cannot take an Ask, no allowlisted
// channel, invalid policy, policy not loaded), and proves:
//   - actions only when permitted: Share to Slack only when the session can
//     take an Ask and a channel is allowlisted; Revoke only on a live share;
//     Copy reference on every share;
//   - the exact session (title, Agent) and the Slack audience are named,
//     and no provider id, workspace, Deck, runtime, or token is rendered;
//   - helpers: labels, ordering, the request body (accepted by the owner
//     create route's parser), client-side allowlist validation;
//   - source contracts: Sessions drawer wiring, Agent Config placement,
//     the revision on every policy write, the revoke confirmation.
// Self-contained: no database, no network.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const view = jiti('./lib/share-view.ts');
const SessionShares = jiti('./app/components/SessionShares.tsx').default;
const SharePolicyCard = jiti('./app/components/SharePolicyCard.tsx').default;

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures += 1;
  return condition;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const PRIVATE = /SECRET|\/work\/|\/Users\/|deck-|codex-direct|claude-code|xoxb|xapp|bmsc_/;

const NOW = Date.now();
const ask = { available: true };
const actions = (askAvailability = ask) => ({
  ask: askAvailability,
  resume: { available: false, code: 'action_unavailable', reason: 'Resume work here is unavailable: read only.', recovery: 'choose_action' },
  handoff: { available: false, code: 'action_unavailable', reason: 'Hand off to… is unavailable.', recovery: 'choose_action' },
});
const row = (extra = {}) => ({
  ref: 'ses_ref_one', agent: { id: 'agent-dev', name: 'Dev', adapter: 'codex-direct', transport: null }, title: 'Fix the uploader retry',
  status: 'active', resumable: true, created_at: NOW - 3600_000, ended_at: null, last_activity_at: NOW - 60_000,
  origin: { conversation: null, work_request: null }, context: { workspace: '/work/SECRET-ws', deck: 'deck-SECRET' },
  route: 'provider', actions: actions(), state: { availability: 'available', lifecycle: 'open', resumable: true, busy: false }, ...extra,
});
const policy = (extra = {}) => ({
  state: 'loaded', reason: null, revision: 'rev-1',
  audiences: [{ kind: 'slack', team_id: 'T0OWNER01', channel_id: 'C0OWNER01' }, { kind: 'slack', team_id: 'T0OWNER01', channel_id: 'C0OWNER02' }],
  agent: { id: 'agent-dev', share_from_turn: true, share_current: { supported: true, reason: null }, live_contexts: 1 },
  limits: { ttl_seconds: { min: 300, default: 3600, max: 86400 }, max_turns: { min: 1, default: 20, max: 100 }, audiences: 512 },
  ...extra,
});
let serial = 0;
const share = (status, extra = {}) => {
  serial += 1;
  const state = status === 'expired' ? 'expired' : status === 'revoked' ? 'revoked' : 'active';
  return {
    share_ref: `shr_fixture${serial}${status}`, agent: { id: 'agent-dev', name: 'Dev' }, session_ref: 'ses_ref_one', authority: 'ask', state, status,
    audience: { kind: 'slack', team_id: 'T0OWNER01', channel_id: 'C0OWNER01' }, created_via: 'session_ref', created_by: 'owner',
    created_at: NOW - serial * 1000, expires_at: state === 'expired' ? NOW - 1000 : NOW + 3600_000, revoked_at: state === 'revoked' ? NOW - 500 : null,
    max_turns: 20, turns_used: status === 'exhausted' ? 20 : 3, thread: { posted: true, posted_at: NOW - 900 }, ...extra,
  };
};
const statuses = ['active', 'answering', 'recovering', 'exhausted', 'expired', 'revoked'];

console.log('\nShare states: each renders its label, expiry, questions, audience, thread, and only the permitted actions');
for (const status of statuses) {
  const s = share(status);
  const html = render(SessionShares, { row: row(), shares: [s], policy: policy(), onChanged: () => {} });
  const live = s.state === 'active';
  assert(html.includes(`data-share-status="${status}"`) && html.includes(`>${view.SHARE_STATUS_LABELS[status]}<`), `${status}: status tag "${view.SHARE_STATUS_LABELS[status]}"`);
  assert(html.includes('Slack channel C0OWNER01 · workspace T0OWNER01') && html.includes(view.turnsLabel(s)) && html.includes('Slack thread posted'),
    `${status}: audience, questions used, thread`);
  assert(html.includes(status === 'expired' ? 'Expired ' : status === 'revoked' ? 'Revoked ' : 'Expires '), `${status}: expiry wording`);
  assert(html.includes('data-share-action="copy"') && html.includes(s.share_ref), `${status}: Copy reference and the reference`);
  assert(html.includes('data-share-action="revoke"') === live, `${status}: Revoke ${live ? 'offered' : 'not offered'}`);
  assert(html.includes(view.shareStatusNote(s)), `${status}: what happens to the next Slack question`);
  assert(!PRIVATE.test(html), `${status}: no provider id, workspace, Deck, runtime, or token in the markup`);
}

console.log('\nShare to Slack: offered only when the session can take an Ask and a channel is allowlisted');
{
  const offered = render(SessionShares, { row: row(), shares: [], policy: policy(), onChanged: () => {} });
  assert(offered.includes('data-share-action="create"') && offered.includes('Not shared.'), 'askable session, allowlisted channel: Share to Slack offered');
  const busy = row({ actions: actions({ available: false, code: 'source_session_busy', reason: 'Ask from this context is unavailable: a turn is running in this session. Try again when it finishes.', recovery: 'retry_later' }) });
  const ended = row({ status: 'ended', actions: actions({ available: false, code: 'session_ended', reason: 'Ask from this context is unavailable: this session has ended. Its history stays here.', recovery: 'choose_session' }) });
  const cases = [
    ['a busy session', busy, policy(), /Share to Slack is unavailable: a turn is running/],
    ['an ended session', ended, policy(), /Share to Slack is unavailable: this session has ended/],
    ['no allowlisted channel', row(), policy({ audiences: [] }), /needs a Slack channel on the share allowlist/],
    ['an invalid policy file', row(), policy({ state: 'invalid', reason: 'bad', audiences: [] }), /share policy file is invalid/],
    ['the policy did not load', row(), null, /share policy could not be loaded/],
  ];
  for (const [label, r, p, reason] of cases) {
    const html = render(SessionShares, { row: r, shares: [], policy: p, onChanged: () => {} });
    assert(!html.includes('data-share-action="create"') && reason.test(html), `${label}: no Share to Slack, says why`);
  }
  const allowlist = render(SessionShares, { row: row(), shares: [], policy: policy({ audiences: [] }), onChanged: () => {} });
  assert(allowlist.includes('href="/bots/agent-dev/config#session-sharing"'), 'the allowlist reason links to Session sharing on Agent Config');
  const loading = render(SessionShares, { row: row(), shares: null, policy: policy(), onChanged: () => {} });
  assert(loading.includes('Loading shares…'), 'while the shares load: a loading state');
}

console.log('\nHelpers: ordering, labels, request body, allowlist validation');
{
  const a = share('active', { created_at: NOW - 10 });
  const b = share('answering', { created_at: NOW - 5 });
  const r = share('revoked', { revoked_at: NOW - 100 });
  const e = share('expired', { expires_at: NOW - 50 });
  const other = share('active', { session_ref: 'ses_other' });
  const ordered = view.sessionShares([a, r, other, e, b], 'ses_ref_one').map(s => s.share_ref);
  assert(JSON.stringify(ordered) === JSON.stringify([b.share_ref, a.share_ref, e.share_ref, r.share_ref]), 'one session\'s shares: live newest first, then ended most recent first');
  assert(view.expiryLabel({ state: 'active', expires_at: NOW + 90 * 60_000, revoked_at: null }, NOW).endsWith('(in 1 h 30 min)'), 'expiry: relative time remaining');
  assert(view.threadLabel({ state: 'active', thread: { posted: false, posted_at: null } }) === 'Waiting for the Slack relay to post the thread', 'thread not posted yet');
  const body = view.shareCreateBody(policy().audiences[0], 3600, 5, 'k-1');
  assert(JSON.stringify(Object.keys(body)) === JSON.stringify(['audience', 'ttl_seconds', 'max_turns', 'idempotency_key']) && !('kind' in body.audience),
    'the create body names only audience, ttl_seconds, max_turns, idempotency_key (the owner route\'s fields)');
  const existing = policy().audiences;
  assert(view.audienceInputError('T0OWNER01', 'C0NEW0001', existing) === null, 'a new exact channel passes');
  assert(/Workspace ID/.test(view.audienceInputError('*', 'C0NEW0001', existing)) && /Channel ID/.test(view.audienceInputError('T0OWNER01', 'general', existing))
    && /already/.test(view.audienceInputError('T0OWNER01', 'C0OWNER01', existing)), 'wildcard / malformed / duplicate entries are refused before sending');
  assert(view.SHARE_DURATIONS.every(d => d.seconds >= 300 && d.seconds <= 86400), 'every offered duration is inside the 300 s - 86 400 s TTL bounds');
  assert(/revokes every live turn context/.test(view.shareFromTurnNote(policy())) && /Sessions drawer/.test(view.shareFromTurnNote(policy({ agent: { ...policy().agent, share_from_turn: false } }))),
    'share_from_turn notes: on explains the revocation, off points to Sessions');
  const cursor = policy({ agent: { ...policy().agent, share_current: { supported: false, reason: 'Cursor has no per-launch MCP configuration.' } } });
  assert(view.shareFromTurnNote(cursor) === 'Cursor has no per-launch MCP configuration.', 'an unsupported runtime: the server\'s reason');
}

console.log('\nSource contracts');
{
  const panel = fs.readFileSync(path.join(ROOT, 'app/components/SessionsPanel.tsx'), 'utf8');
  const shares = fs.readFileSync(path.join(ROOT, 'app/components/SessionShares.tsx'), 'utf8');
  const card = fs.readFileSync(path.join(ROOT, 'app/components/SharePolicyCard.tsx'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'app/bots/[id]/config/page.tsx'), 'utf8');
  assert(panel.includes('<SessionShares row={row}') && panel.includes('/api/shares?agent_id=') && panel.includes('/share-policy'),
    'the Sessions drawer renders a share section per row from the owner share list and policy');
  assert(shares.includes("`/api/shares/${encodeURIComponent(share.share_ref)}/revoke`") && shares.includes('data-share-action="confirm-revoke"'),
    'revoke goes through the owner revoke route after an explicit confirmation');
  assert(!shares.includes('row.context') && !/provider_session|external_session/.test(shares), 'the share section never reads the row\'s workspace, Deck, or a provider id');
  assert(card.includes('revision: policy.revision') && card.includes("method: 'PUT'") && card.includes('role="switch"') && card.includes('share_from_turn'),
    'every policy write carries the revision it was made on; the toggle is an explicit share_from_turn switch');
  assert(config.includes('<SharePolicyCard agentId={bot.id}') && config.indexOf('<SharePolicyCard') > config.indexOf('Launch snapshots')
    && config.indexOf('<SharePolicyCard') < config.indexOf('>Avatar<'), 'Agent Config shows Session sharing in the second column, after Launch snapshots');
  const markup = render(SharePolicyCard, { agentId: 'agent-dev', agentName: 'Dev' });
  assert(markup.includes('id="session-sharing"') && markup.includes('Session sharing') && markup.includes('Loading…'), 'the policy card renders its landmark and a loading state');
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll session-share UI checks passed.');
process.exit(failures ? 1 : 0);
