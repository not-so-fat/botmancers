#!/usr/bin/env node
// NOT-515: SessionShare core (lib/session-shares) and its explicit REST/MCP
// lifecycle (docs/service-grants.md, Session shares). Proves against the
// real store, an isolated SQLite file, and the deterministic fake provider:
//   - the share store: opaque stable share_ref, exact session_ref, ask-only
//     authority, TTL and turn-limit defaults and bounds, the owner's
//     fail-closed audience allowlist, expiry, revocation, one in-flight turn,
//     restart recovery (a real second process), and idempotent turn
//     accounting, with canonical row and event counts;
//   - shares:create is its own per-Agent grant; missing, malformed,
//     cross-Agent, and ungranted targets answer exactly like a missing one;
//   - create/get/list/revoke through serviceOperations, the REST route
//     handlers, and the MCP v2 tools, with NOT-499 idempotency, pagination,
//     audit, and heuristic or authority-seeking inputs refused before any
//     write; no share-current endpoint or tool exists;
//   - SessionShare.ask: one exact-session read-only NOT-507 pin turn per
//     question, the question key kept as the pin-turn idempotency key,
//     bounded redacted output, and shares.ask audit deltas for first
//     delivery, replay, expired, revoked, exhausted, and in-flight; the
//     share principal cannot use the ordinary pin endpoints;
//   - finding R1 (NOT-514): default/native workspaces and cwd-shaped paths
//     are redacted from API, MCP, audit, error, and ask output.
// Self-contained: no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT515_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-shares-${TAG}`);
const STATE = path.join(TMP, 'provider.json');
const GRANTS_PATH = path.join(TMP, 'service-grants.json');
const SHARES_PATH = path.join(TMP, 'session-shares.json');
const IDS_PATH = path.join(TMP, 'ids.json');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
const digest = token => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
const TOKENS = { grok: 'grok-token-NOT515', other: 'other-token-NOT515' };
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SERVICE_GRANTS_PATH = GRANTS_PATH;
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest(TOKENS.grok)},other-bot=${digest(TOKENS.other)}`;
process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '100000';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const grantsLib = jiti('./lib/service-grants.ts');
const shares = jiti('./lib/session-shares.ts');
const { serviceRedactor } = jiti('./lib/service-redaction.ts');
const { serviceOperations } = jiti('./lib/service-api-http.ts');
const mcp = jiti('./lib/mcp-bridge-v2.ts');
const fake = require('./test-support/fake-session-provider');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const SECRET = /SECRET/;
const HOME = os.homedir();
const grok = { kind: 'service', id: 'grok-bot' };
const other = { kind: 'service', id: 'other-bot' };
const sendsTo = id => Object.values(fake.loadFakeState(STATE).turns).filter(turn => turn.session === id).length;
const sends = () => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').length;
const audits = () => count('SELECT COUNT(*) AS n FROM service_audit_events');
const lastAudit = () => db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT 1').get();
const audience = { kind: 'slack', team_id: 'T0SHARE01', channel_id: 'C0SHARE01' };

function writeJson(file, value, mode = 0o600) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  fs.chmodSync(file, mode);
}

function registerFake(connectionId) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
}

const releaseHolds = () => fake.mutateFakeProvider(STATE, state => {
  for (const turn of Object.values(state.turns)) if (turn.state === 'running') turn.prompt = turn.prompt.replace('[hold] ', '');
});

// Everything a rejected call must not touch.
function snapshot() {
  return {
    shares: count('SELECT COUNT(*) AS n FROM session_shares'),
    events: count('SELECT COUNT(*) AS n FROM session_share_events'),
    pins: count('SELECT COUNT(*) AS n FROM session_pins'),
    turns: count('SELECT COUNT(*) AS n FROM session_pin_turns'),
    conversations: count('SELECT COUNT(*) AS n FROM conversations'),
    sends: sends(),
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

// A second Botmancers process on the same database and provider state.
async function restart() {
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  registerFake(ids.connectionId);
  const out = {};
  const view = shares.shareView(shares.shareRow(ids.held));
  out.view = view;
  try {
    await shares.askShare({ shareRef: ids.held, question: 'Second while held?', messageKey: 'restart-q-1' });
    out.whileHeld = 'dispatched';
  } catch (error) {
    out.whileHeld = error.code;
  }
  releaseHolds();
  const replay = await shares.askShare({ shareRef: ids.held, question: '[hold] Held question?', messageKey: 'held-q-1' });
  out.replay = { replayed: replay.replayed, turn_ref: replay.turn.turn_ref };
  const next = await shares.askShare({ shareRef: ids.held, question: 'After restart?', messageKey: 'restart-q-2' });
  await next.settled;
  out.next = { replayed: next.replayed, turns_used: next.share.turns_used };
  out.answer = await shares.shareAnswer(ids.held, next.turn.turn_ref);
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function main() {
  console.log('\nSetup: two Agents with native sessions, two services, an owner share allowlist');
  const connectionId = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
  registerFake(connectionId);
  fake.seedFakeProvider(STATE, [
    { id: 'share-1-SECRET', title: 'Fix the uploader retry', workspace: '/work/share' },
    { id: 'share-2-SECRET', title: 'Write release notes', workspace: '/work/share' },
    { id: 'share-3-SECRET', title: 'Limited', workspace: '/work/share' },
    { id: 'gone-1-SECRET', title: 'Soon gone', workspace: '/work/share' },
    { id: 'other-1-SECRET', title: 'Other agent', workspace: `${HOME}/private-other` },
  ]);
  const mkAgent = name => dbModule.bots.create({
    name, title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  const dev = mkAgent('Dev');
  const otherAgent = mkAgent('Other');
  db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run('~/dev-default-ws', dev.id);
  for (const bot of [dev, otherAgent]) {
    let cursor = null;
    do cursor = (await ps.syncAgentSessions(db, bot.id, { cursor })).next_cursor; while (cursor);
  }
  const keep = (bot, ids) => db.prepare(`DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id NOT IN (${ids.map(() => '?').join(',')})`).run(bot.id, ...ids);
  keep(dev, ['share-1-SECRET', 'share-2-SECRET', 'share-3-SECRET', 'gone-1-SECRET']);
  keep(otherAgent, ['other-1-SECRET']);
  const refOf = (bot, id) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(bot.id, id).id;
  const s1 = refOf(dev, 'share-1-SECRET');
  const s2 = refOf(dev, 'share-2-SECRET');
  const s3 = refOf(dev, 'share-3-SECRET');
  const gone = refOf(dev, 'gone-1-SECRET');
  const otherRef = refOf(otherAgent, 'other-1-SECRET');
  writeJson(GRANTS_PATH, { version: 1, grants: [
    { service: 'grok-bot', agent: dev.id, capabilities: ['agents:read', 'sessions:read', 'shares:create'] },
    { service: 'grok-bot', agent: otherAgent.id, capabilities: ['sessions:read'] },
    { service: 'other-bot', agent: dev.id, capabilities: ['sessions:message', 'sessions:read'] },
  ] });

  console.log('\nGrant vocabulary: shares:create, reserved share principals');
  {
    assert(grantsLib.SERVICE_CAPABILITIES.includes('shares:create') && grantsLib.isServiceCapability('shares:create'), 'shares:create is in the grant vocabulary');
    assert(!grantsLib.isServiceCapability('shares:ask') && !grantsLib.isServiceCapability('shares:*'), 'shares:ask (audit only) and wildcards are not grantable');
    const refuse = service => {
      try {
        grantsLib.parseServiceGrants(JSON.stringify({ version: 1, grants: [{ service, agent: dev.id, capabilities: ['shares:create'] }] }));
        return false;
      } catch (error) {
        return /reserved/.test(error.message);
      }
    };
    assert(refuse('botmancers-session-context') && refuse('botmancers-session-share') && refuse('botmancers-exchanges'),
      'the session-context and session-share principals are refused in a grants document, like botmancers-exchanges');
    const loaded = grantsLib.loadServiceGrants();
    assert(loaded.state === 'loaded' && loaded.grants.get('grok-bot').get(dev.id).has('shares:create') && !loaded.grants.get('other-bot').get(dev.id).has('shares:create'),
      'the grants document loads with shares:create granted to grok-bot on Dev only');
  }

  console.log('\nOwner share configuration: owner-only, fail closed');
  {
    const createWith = async key => serviceOperations.createShare(grok, s1, () => ({ audience, idempotency_key: key }), null);
    const before = snapshot();
    const absent = await createWith('cfg-absent');
    assert(absent.status === 403 && absent.body.error.code === 'audience_not_allowed', 'no session-shares.json: every audience is audience_not_allowed');
    const invalid = [
      ['group-readable', { version: 1, audiences: [audience] }, 0o644],
      ['not JSON', '{', 0o600],
      ['wrong version', { version: 2, audiences: [audience] }, 0o600],
      ['unknown field', { version: 1, audiences: [audience], extra: true }, 0o600],
      ['wildcard channel', { version: 1, audiences: [{ ...audience, channel_id: '*' }] }, 0o600],
      ['duplicate audience', { version: 1, audiences: [audience, audience] }, 0o600],
      ['unknown Agent', { version: 1, audiences: [audience], agents: [{ agent: 'no-such-agent', share_from_turn: true }] }, 0o600],
      ['non-boolean share_from_turn', { version: 1, audiences: [audience], agents: [{ agent: dev.id, share_from_turn: 'yes' }] }, 0o600],
    ];
    for (const [label, doc, mode] of invalid) {
      writeJson(SHARES_PATH, doc, mode);
      const state = shares.loadSessionSharesConfig();
      const res = await createWith(`cfg-${label.replace(/\W+/g, '-')}`);
      assert(state.state === 'invalid' && res.body.error.code === 'audience_not_allowed' && !shares.shareFromTurnEnabled(dev.id),
        `${label}: the document is invalid, no audience is allowed, share_from_turn is off`);
    }
    assert(same(before, snapshot()), 'no share, event, pin, or conversation written while the configuration refused');
    writeJson(SHARES_PATH, { version: 1, audiences: [audience, { kind: 'slack', team_id: 'T0SHARE01', channel_id: 'C0SHARE02' }], agents: [{ agent: dev.id, share_from_turn: true }, { agent: otherAgent.id, share_from_turn: false }] });
    const loaded = shares.loadSessionSharesConfig();
    assert(loaded.state === 'loaded' && loaded.config.audiences.length === 2 && shares.shareFromTurnEnabled(dev.id) && !shares.shareFromTurnEnabled(otherAgent.id),
      'a valid 0600 document loads: two audiences, share_from_turn on for Dev only');
  }

  console.log('\nCreate: exact replay, conflict, defaults, bounds');
  let shareA;
  {
    const before = snapshot();
    const auditBefore = audits();
    const created = await serviceOperations.createShare(grok, s1, () => ({ audience, idempotency_key: 'share-a-01' }), null);
    shareA = created.body.share;
    assert(created.status === 201 && created.body.replayed === false && /^shr_[A-Za-z0-9_-]{22}$/.test(shareA.share_ref),
      `create -> 201 with an opaque share_ref (${shareA && shareA.share_ref})`);
    assert(shareA.session_ref === s1 && shareA.agent_id === dev.id && shareA.authority === 'ask' && shareA.state === 'active' && shareA.created_via === 'session_ref'
      && shareA.max_turns === 20 && shareA.turns_used === 0 && shareA.expires_at - shareA.created_at === 3600 * 1000 && shareA.revoked_at === null,
      'exactly session_ref, its owning Agent resolved, ask authority, default TTL 3600 s and max_turns 20');
    assert(JSON.stringify(Object.keys(shareA).sort()) === JSON.stringify(['agent_id', 'audience', 'authority', 'created_at', 'created_via', 'expires_at', 'max_turns', 'revoked_at', 'session_ref', 'share_ref', 'state', 'turns_used']),
      'the share view carries only the frozen sketch fields (no provider id, workspace, Deck, runtime, model, pin, or creator)');
    const after = snapshot();
    assert(after.shares - before.shares === 1 && after.events - before.events === 1 && after.pins - before.pins === 1 && after.sends === before.sends,
      'one share row, one created event, one ask pin; nothing dispatched');
    const pin = db.prepare('SELECT * FROM session_pins WHERE id = (SELECT pin_ref FROM session_shares WHERE id = ?)').get(shareA.share_ref);
    assert(pin.requester_kind === 'service' && pin.requester_id === 'botmancers-session-share' && pin.action === 'ask' && pin.authority === 'read_only' && pin.session_ref === s1 && pin.resolution === 'exact',
      'the share is one read-only exact ask pin on session_ref, requested by the reserved share principal');
    assert(audits() - auditBefore === 1 && lastAudit().operation === 'shares.create' && lastAudit().capability === 'shares:create' && lastAudit().outcome === 'allowed'
      && lastAudit().target_kind === 'session' && lastAudit().target_ref === s1 && lastAudit().agent_id === dev.id, 'one shares.create audit row on the session');
    const replay = await serviceOperations.createShare(grok, s1, () => ({ audience, idempotency_key: 'share-a-01' }), null);
    assert(replay.status === 200 && replay.body.replayed === true && replay.body.share.share_ref === shareA.share_ref && same(after, snapshot()),
      'exact replay -> 200, the same share_ref, nothing written');
    const header = await serviceOperations.createShare(grok, s1, () => ({ audience }), 'share-a-01');
    assert(header.status === 200 && header.body.share.share_ref === shareA.share_ref, 'the Idempotency-Key header replays the same share');
    const conflicts = [
      [{ audience, ttl_seconds: 600, idempotency_key: 'share-a-01' }, s1, 'another TTL'],
      [{ audience, idempotency_key: 'share-a-01' }, s2, 'another session'],
      [{ audience: { ...audience, channel_id: 'C0SHARE02' }, idempotency_key: 'share-a-01' }, s1, 'another audience'],
    ];
    for (const [body, ref, label] of conflicts) {
      const res = await serviceOperations.createShare(grok, ref, () => body, null);
      assert(res.status === 409 && res.body.error.code === 'idempotency_conflict' && lastAudit().outcome === 'rejected', `the same key with ${label} -> 409 idempotency_conflict, audited rejected`);
    }
    assert(same(after, snapshot()), 'conflicts write nothing');
    const bounds = [
      [{ ttl_seconds: 299 }, 'ttl_seconds 299'], [{ ttl_seconds: 86401 }, 'ttl_seconds 86401'], [{ ttl_seconds: 600.5 }, 'fractional ttl_seconds'],
      [{ ttl_seconds: '3600' }, 'string ttl_seconds'], [{ max_turns: 0 }, 'max_turns 0'], [{ max_turns: 101 }, 'max_turns 101'],
      [{ audience: { kind: 'teams', team_id: 'T0SHARE01', channel_id: 'C0SHARE01' } }, 'non-Slack audience'],
      [{ audience: { kind: 'slack', team_id: 't-lower', channel_id: 'C0SHARE01' } }, 'malformed team id'],
      [{ audience: undefined }, 'missing audience'], [{ idempotency_key: undefined }, 'missing idempotency key'],
      [{ unexpected: 1 }, 'unknown field'],
    ];
    for (const [patch, label] of bounds) {
      const body = { audience, idempotency_key: `bounds-${label.replace(/\W+/g, '-')}`, ...patch };
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
      const res = await serviceOperations.createShare(grok, s2, () => body, null);
      assert(res.status === 400 && res.body.error.code === 'invalid_request', `${label} -> 400 invalid_request`);
    }
    const edge = await serviceOperations.createShare(grok, s2, () => ({ audience, ttl_seconds: 300, max_turns: 100, idempotency_key: 'share-edge-1' }), null);
    const edge2 = await serviceOperations.createShare(grok, s2, () => ({ audience, ttl_seconds: 86400, max_turns: 1, idempotency_key: 'share-edge-2' }), null);
    assert(edge.status === 201 && edge.body.share.max_turns === 100 && edge2.status === 201 && edge2.body.share.expires_at - edge2.body.share.created_at === 86400 * 1000,
      'the bounds themselves (300 s, 86400 s, 1 and 100 turns) are accepted');
    const offList = await serviceOperations.createShare(grok, s2, () => ({ audience: { ...audience, channel_id: 'C0NOTLIST' }, idempotency_key: 'share-off-1' }), null);
    assert(offList.status === 403 && offList.body.error.code === 'audience_not_allowed' && lastAudit().outcome === 'denied', 'a channel off the owner allowlist -> 403 audience_not_allowed, audited denied');
  }

  console.log('\nCreate: heuristic and authority-seeking inputs, unauthorized targets');
  {
    const before = snapshot();
    const refused = ['provider_session_id', 'external_session_id', 'claude_session_id', 'codex_thread_id', 'cursor_chat_id', 'cwd', 'workspace',
      'latest', 'most_recent', 'title', 'title_match', 'active_since', 'runtime', 'deck', 'deck_id', 'model', 'tool_profile', 'session_id', 'grants', 'principal'];
    const accepted = [];
    for (const field of refused) {
      const res = await serviceOperations.createShare(grok, s2, () => ({ audience, idempotency_key: `heur-${field}`, [field]: 'x' }), null);
      if (!(res.status === 403 && res.body.error.code === 'authority_not_allowed')) accepted.push(field);
    }
    assert(accepted.length === 0, `${refused.length} provider-id, cwd/workspace, title, latest, runtime, Deck, model, and tool-profile fields -> 403 authority_not_allowed${accepted.length ? ` (accepted: ${accepted.join(', ')})` : ''}`);
    const nested = await serviceOperations.createShare(grok, s2, () => ({ audience: { ...audience, workspace: '/work/share' }, idempotency_key: 'heur-nested' }), null);
    assert(nested.status === 403 && nested.body.error.code === 'authority_not_allowed' && !JSON.stringify(nested.body).includes('/work/share'), 'a selector nested in audience is refused too, and never echoed');
    const missing = await serviceOperations.createShare(grok, 'no-such-session', () => ({ audience, idempotency_key: 'nf-1' }), null);
    const targets = [
      ['an Agent without shares:create (sessions:read only)', grok, otherRef],
      ['a service holding sessions:message but not shares:create', other, s1],
      ['an agent_id expectation naming another Agent', grok, s1, { agent_id: otherAgent.id }],
      ['a malformed reference', grok, '../../etc/passwd'],
      ['an over-long reference', grok, 'x'.repeat(500)],
    ];
    assert(missing.status === 404 && missing.body.error.code === 'session_not_found', 'an unknown session_ref -> 404 session_not_found');
    for (const [label, principal, ref, extra] of targets) {
      const res = await serviceOperations.createShare(principal, ref, () => ({ audience, idempotency_key: `nf-${label.length}`, ...(extra || {}) }), null);
      assert(res.status === 404 && same(res.body, missing.body), `${label} -> exactly the missing-session answer`);
    }
    const narrow = db.prepare("SELECT outcome, code FROM service_audit_events WHERE operation = 'shares.create' AND principal = 'service:other-bot' ORDER BY id DESC LIMIT 1").get();
    assert(narrow.outcome === 'denied' && narrow.code === 'not_granted', 'the ungranted refusal is audited as denied/not_granted (internally distinct, externally identical)');
    const relay = await serviceOperations.createShare(shares.SHARE_PRINCIPAL, s1, () => ({ audience, idempotency_key: 'relay-create' }), null);
    assert(relay.status === 404 && relay.body.error.code === 'session_not_found', 'the share principal itself cannot create a share (it holds no grant)');
    fake.mutateFakeProvider(STATE, state => { state.sessions['gone-1-SECRET'].deleted = true; });
    await ps.refreshProviderSession(db, dev.id, gone);
    const ended = await serviceOperations.createShare(grok, gone, () => ({ audience, idempotency_key: 'gone-1' }), null);
    assert(['session_missing', 'session_ended', 'session_not_resumable'].includes(ended.body.error.code) && !SECRET.test(JSON.stringify(ended.body)),
      `a session that can no longer take an Ask -> NOT-507's ${ended.body.error.code}, no share`);
    assert(same(before, snapshot()), 'no rejected create wrote a share, event, pin, conversation, or turn');
  }

  console.log('\nGet, list, revoke');
  let shareB;
  let shareC;
  {
    shareB = (await serviceOperations.createShare(grok, s2, () => ({ audience, ttl_seconds: 300, idempotency_key: 'share-b-01' }), null)).body.share;
    shareC = (await serviceOperations.createShare(grok, s2, () => ({ audience, idempotency_key: 'share-c-01' }), null)).body.share;
    const got = await serviceOperations.getShare(grok, shareA.share_ref);
    assert(got.status === 200 && same(got.body.share, shareA) && lastAudit().operation === 'shares.read' && lastAudit().target_ref === shareA.share_ref && lastAudit().agent_id === dev.id,
      'get -> 200 the same view, audited shares.read');
    const missing = await serviceOperations.getShare(grok, 'shr_doesnotexist');
    const foreign = await serviceOperations.getShare(other, shareA.share_ref);
    assert(missing.status === 404 && missing.body.error.code === 'share_not_found' && same(foreign.body, missing.body), 'another principal\'s share answers exactly like a missing one');
    const all = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: null });
    const s2List = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: s2, state: null });
    assert(all.status === 200 && all.body.items.length === 5 && all.body.next_cursor === null && s2List.body.items.length === 4 && s2List.body.items.every(item => item.session_ref === s2),
      'list -> every own share; session_ref filters to that exact session');
    const newestFirst = all.body.items.every((item, i, items) => i === 0 || items[i - 1].created_at >= item.created_at);
    assert(newestFirst, 'newest first');
    const pageOne = await serviceOperations.listShares(grok, { cursor: null, limit: '2', sessionRef: null, state: null });
    const pageTwo = await serviceOperations.listShares(grok, { cursor: pageOne.body.next_cursor, limit: '2', sessionRef: null, state: null });
    const pageThree = await serviceOperations.listShares(grok, { cursor: pageTwo.body.next_cursor, limit: '2', sessionRef: null, state: null });
    const paged = [...pageOne.body.items, ...pageTwo.body.items, ...pageThree.body.items].map(item => item.share_ref);
    assert(pageOne.body.items.length === 2 && pageThree.body.next_cursor === null && same(paged, all.body.items.map(item => item.share_ref)), 'bounded pagination: limit 2 pages through every share once, in order');
    const badLimit = await serviceOperations.listShares(grok, { cursor: null, limit: '101', sessionRef: null, state: null });
    const badCursor = await serviceOperations.listShares(grok, { cursor: pageOne.body.next_cursor, limit: null, sessionRef: s2, state: null });
    const badState = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: 'latest' });
    const heuristic = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: null, names: ['latest'] });
    const workspace = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: null, names: ['workspace'] });
    const unknownParam = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: null, names: ['foo'] });
    assert(badLimit.body.error.code === 'invalid_request' && badCursor.body.error.code === 'invalid_request' && badState.body.error.code === 'invalid_request'
      && heuristic.body.error.code === 'authority_not_allowed' && workspace.body.error.code === 'authority_not_allowed' && unknownParam.body.error.code === 'invalid_request',
      'limit above 100, a cursor of another list, an unknown state, heuristic (latest, workspace) and unknown parameters are refused');
    const otherList = await serviceOperations.listShares(other, { cursor: null, limit: null, sessionRef: null, state: null });
    assert(otherList.status === 200 && otherList.body.items.length === 0, 'another service lists none of them');
    const revokeBefore = snapshot();
    const revoked = await serviceOperations.revokeShare(grok, shareC.share_ref, () => '');
    const pinState = db.prepare('SELECT state FROM session_pins WHERE id = (SELECT pin_ref FROM session_shares WHERE id = ?)').get(shareC.share_ref).state;
    assert(revoked.status === 200 && revoked.body.share.state === 'revoked' && revoked.body.replayed === false && typeof revoked.body.share.revoked_at === 'number' && pinState === 'detached'
      && lastAudit().operation === 'shares.revoke' && lastAudit().outcome === 'allowed', 'revoke -> 200 revoked, its ask pin detached in the same commit, audited');
    const again = await serviceOperations.revokeShare(grok, shareC.share_ref, () => '{"idempotency_key":"rv-2"}');
    assert(again.status === 200 && again.body.replayed === true && again.body.share.revoked_at === revoked.body.share.revoked_at, 'revoking again -> the same share unchanged (replayed)');
    const afterRevoke = snapshot();
    assert(afterRevoke.events - revokeBefore.events === 1, 'exactly one revoked event, whatever the replays');
    const foreignRevoke = await serviceOperations.revokeShare(other, shareA.share_ref, () => '');
    const badBody = await serviceOperations.revokeShare(grok, shareA.share_ref, () => '{"cwd":"/work/share"}');
    assert(foreignRevoke.body.error.code === 'share_not_found' && badBody.body.error.code === 'authority_not_allowed'
      && shares.shareRow(shareA.share_ref).state === 'active', 'another principal cannot revoke it; an authority-seeking revoke body is refused; the share stays active');
    const revokedList = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: 'revoked' });
    assert(revokedList.body.items.length === 1 && revokedList.body.items[0].share_ref === shareC.share_ref, 'state=revoked filters to the revoked share');
  }

  console.log('\nshares:create withdrawn: the shares vanish');
  {
    writeJson(GRANTS_PATH, { version: 1, grants: [
      { service: 'grok-bot', agent: dev.id, capabilities: ['agents:read', 'sessions:read'] },
      { service: 'other-bot', agent: dev.id, capabilities: ['sessions:message', 'sessions:read'] },
    ] });
    const got = await serviceOperations.getShare(grok, shareA.share_ref);
    const list = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: null });
    const revoke = await serviceOperations.revokeShare(grok, shareA.share_ref, () => '');
    assert(got.body.error.code === 'share_not_found' && list.body.items.length === 0 && revoke.body.error.code === 'share_not_found'
      && shares.shareRow(shareA.share_ref).state === 'active', 'without shares:create the caller can no longer see, list, or revoke its shares');
    writeJson(GRANTS_PATH, { version: 1, grants: [
      { service: 'grok-bot', agent: dev.id, capabilities: ['agents:read', 'sessions:read', 'shares:create'] },
      { service: 'grok-bot', agent: otherAgent.id, capabilities: ['sessions:read'] },
      { service: 'other-bot', agent: dev.id, capabilities: ['sessions:message', 'sessions:read'] },
    ] });
  }

  console.log('\nSessionShare.ask: exact-session NOT-507 turns, audited as shares.ask');
  const askStep = async (label, input, expect) => {
    const before = { sends: sends(), audit: audits(), s1: sendsTo('share-1-SECRET'), s2: sendsTo('share-2-SECRET'), s3: sendsTo('share-3-SECRET'), turns: count('SELECT COUNT(*) AS n FROM session_pin_turns') };
    let result = null;
    let code = null;
    try {
      result = await shares.askShare(input);
    } catch (error) {
      if (!(error instanceof shares.ShareAskError)) throw error;
      code = error.code;
    }
    const delta = { dispatch: sends() - before.sends, audit: audits() - before.audit, s1: sendsTo('share-1-SECRET') - before.s1, s2: sendsTo('share-2-SECRET') - before.s2, s3: sendsTo('share-3-SECRET') - before.s3 };
    const a = lastAudit();
    const ok = (expect.code ? code === expect.code : code === null) && delta.dispatch === expect.dispatch && delta.audit === 1
      && a.operation === 'shares.ask' && a.capability === 'shares:ask' && a.principal === 'service:botmancers-session-share' && a.outcome === expect.outcome && (a.code ?? null) === (expect.auditCode ?? null);
    assert(ok, `${label}: ${code ?? (result.replayed ? 'replayed' : 'dispatched')}, dispatch +${delta.dispatch}, audit +${delta.audit} ${a.outcome}${a.code ? `:${a.code}` : ''}`);
    return { result, code, delta, audit: a };
  };
  let firstTurn;
  {
    const first = await askStep('first delivery', { shareRef: shareA.share_ref, question: `What is in ${HOME}/secret-proj and /work/share?`, messageKey: 'slack-q-1' },
      { dispatch: 1, outcome: 'allowed' });
    firstTurn = first.result.turn;
    assert(first.delta.s1 === 1 && first.delta.s2 === 0 && first.audit.target_ref === s1 && first.audit.agent_id === dev.id,
      'the question reached exactly the share\'s session_ref, audited on it');
    const turnRow = db.prepare('SELECT * FROM session_pin_turns WHERE id = ?').get(firstTurn.turn_ref);
    assert(turnRow.idempotency_key === 'turn:slack-q-1' && turnRow.requester_id === 'botmancers-session-share', 'the question key is the NOT-507 pin-turn idempotency key, unchanged');
    const call = fake.loadFakeState(STATE).calls.filter(c => c.op === 'sendTurn').at(-1);
    assert(call.authority === 'read_only', 'the provider turn runs read_only');
    await first.result.settled;
    const answer = await shares.shareAnswer(shareA.share_ref, firstTurn.turn_ref);
    assert(answer.state === 'completed' && /fake reply/.test(answer.answer) && !answer.answer.includes('/work/share') && !answer.answer.includes(HOME) && !SECRET.test(answer.answer)
      && answer.answer.includes('[redacted]'), `the answer is redacted (no workspace, home path, or provider id): ${answer && answer.answer}`);
    const view = shares.shareView(shares.shareRow(shareA.share_ref));
    assert(view.turns_used === 1 && shares.shareEvents(shareA.share_ref).filter(e => e.type === 'turn_sent').length === 1, 'turns_used 1, one turn_sent event');
    const replay = await askStep('replay (relay ledger lost)', { shareRef: shareA.share_ref, question: `What is in ${HOME}/secret-proj and /work/share?`, messageKey: 'slack-q-1' },
      { dispatch: 0, outcome: 'allowed', auditCode: 'replayed' });
    assert(replay.result.replayed && replay.result.turn.turn_ref === firstTurn.turn_ref && shares.shareRow(shareA.share_ref).turns_used === 1,
      'replayed to the same turn; turns_used unchanged (idempotent accounting)');
    await askStep('the same key with another question', { shareRef: shareA.share_ref, question: 'Something else', messageKey: 'slack-q-1' },
      { code: 'idempotency_conflict', dispatch: 0, outcome: 'rejected', auditCode: 'idempotency_conflict' });
    const long = await askStep('a long answer', { shareRef: shareA.share_ref, question: 'x'.repeat(3990), messageKey: 'slack-q-long' }, { dispatch: 1, outcome: 'allowed' });
    await long.result.settled;
    const longAnswer = await shares.shareAnswer(shareA.share_ref, long.result.turn.turn_ref);
    assert(longAnswer.answer.length === shares.SHARE_LIMITS.replyChars && longAnswer.answer.endsWith('…'), `the answer is bounded to ${shares.SHARE_LIMITS.replyChars} characters`);
    await askStep('an over-long question', { shareRef: shareA.share_ref, question: 'x'.repeat(4001), messageKey: 'slack-q-too-long' }, { code: 'invalid_request', dispatch: 0, outcome: 'rejected', auditCode: 'invalid_request' });
  }

  console.log('\nIn-flight guard, expiry, revocation, turn limit');
  let heldShare;
  {
    heldShare = (await serviceOperations.createShare(grok, s3, () => ({ audience, max_turns: 3, idempotency_key: 'share-held-1' }), null)).body.share;
    const held = await askStep('held question', { shareRef: heldShare.share_ref, question: '[hold] Held question?', messageKey: 'held-q-1' }, { dispatch: 1, outcome: 'allowed' });
    assert(held.delta.s3 === 1 && held.result.turn.state === 'running', 'the held turn runs on its own session');
    await askStep('second question while the first runs', { shareRef: heldShare.share_ref, question: 'Second?', messageKey: 'held-q-2' },
      { code: 'share_turn_in_progress', dispatch: 0, outcome: 'denied', auditCode: 'share_turn_in_progress' });
    const parallelShare = (await serviceOperations.createShare(grok, s1, () => ({ audience, idempotency_key: 'share-par-1' }), null)).body.share;
    const before = sends();
    const outcomes = await Promise.allSettled([
      shares.askShare({ shareRef: parallelShare.share_ref, question: '[hold] Parallel one', messageKey: 'par-1' }),
      shares.askShare({ shareRef: parallelShare.share_ref, question: '[hold] Parallel two', messageKey: 'par-2' }),
    ]);
    const codes = outcomes.map(o => (o.status === 'fulfilled' ? 'dispatched' : o.reason.code)).sort();
    assert(same(codes, ['dispatched', 'share_turn_in_progress']) && sends() - before === 1 && shares.shareRow(parallelShare.share_ref).turns_used === 1,
      'two concurrent questions on one share: one dispatched, one share_turn_in_progress, one provider turn');
    fs.writeFileSync(IDS_PATH, JSON.stringify({ connectionId, held: heldShare.share_ref }));
    const child = spawnSync(process.execPath, [__filename, 'restart'], { env: { ...process.env, NOT515_TAG: TAG }, encoding: 'utf8', timeout: 60000 });
    const line = (child.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
    const out = line ? JSON.parse(line.slice(7)) : null;
    if (!out) console.log(child.stdout, child.stderr);
    assert(out && out.view.share_ref === heldShare.share_ref && out.view.turns_used === 1 && out.view.state === 'active' && out.view.session_ref === s3,
      'restart: a second process reads the same durable share (turns_used 1, active, same session_ref)');
    assert(out && out.whileHeld === 'share_turn_in_progress', 'restart: the in-flight turn still holds the share in the new process');
    assert(out && out.replay.replayed === true && out.replay.turn_ref === held.result.turn.turn_ref, 'restart: the held question replays to its original turn');
    assert(out && out.next.replayed === false && out.next.turns_used === 2 && out.answer && out.answer.state === 'completed', 'restart: once it finished, the next question dispatches (turns_used 2)');
    await askStep('third question exhausts nothing yet', { shareRef: heldShare.share_ref, question: 'Third?', messageKey: 'held-q-3' }, { dispatch: 1, outcome: 'allowed' });
    const third = db.prepare("SELECT inflight_turn_ref FROM session_shares WHERE id = ?").get(heldShare.share_ref).inflight_turn_ref;
    await shares.shareAnswer(heldShare.share_ref, third);
    await askStep('turn limit reached', { shareRef: heldShare.share_ref, question: 'Fourth?', messageKey: 'held-q-4' },
      { code: 'share_turn_limit', dispatch: 0, outcome: 'denied', auditCode: 'share_turn_limit' });
    const replayAfterLimit = await askStep('replay after the limit', { shareRef: heldShare.share_ref, question: 'Third?', messageKey: 'held-q-3' },
      { dispatch: 0, outcome: 'allowed', auditCode: 'replayed' });
    assert(replayAfterLimit.result.replayed && shares.shareRow(heldShare.share_ref).turns_used === 3, 'an exact replay still answers after the limit; turns_used stays 3');
    // A claim left by a crashed process (dispatch never committed) is
    // recovered by the next process.
    const crashShare = (await serviceOperations.createShare(grok, s2, () => ({ audience, idempotency_key: 'share-crash-1' }), null)).body.share;
    db.prepare("UPDATE session_shares SET inflight_key = 'lost-q', inflight_owner = 'dead-process' WHERE id = ?").run(crashShare.share_ref);
    await askStep('a claim left by a dead process', { shareRef: crashShare.share_ref, question: 'After the crash?', messageKey: 'crash-q-1' }, { dispatch: 1, outcome: 'allowed' });
    releaseHolds();
    // Expiry (shareB: 300 s) and revocation (shareC).
    shares.setSessionShareClock(() => Date.now() + 301 * 1000);
    await askStep('expired share', { shareRef: shareB.share_ref, question: 'Still there?', messageKey: 'exp-q-1' }, { code: 'share_expired', dispatch: 0, outcome: 'denied', auditCode: 'share_expired' });
    const expiredGet = await serviceOperations.getShare(grok, shareB.share_ref);
    const expiredList = await serviceOperations.listShares(grok, { cursor: null, limit: null, sessionRef: null, state: 'expired' });
    assert(expiredGet.body.share.state === 'expired' && expiredList.body.items.some(item => item.share_ref === shareB.share_ref), 'get and list report the share expired');
    shares.setSessionShareClock(null);
    await askStep('revoked share', { shareRef: shareC.share_ref, question: 'Still there?', messageKey: 'rev-q-1' }, { code: 'share_revoked', dispatch: 0, outcome: 'denied', auditCode: 'share_revoked' });
    await askStep('unknown share', { shareRef: 'shr_nope', question: 'Hello?', messageKey: 'nf-q-1' }, { code: 'share_not_found', dispatch: 0, outcome: 'denied', auditCode: 'share_not_found' });
    const relayPins = [
      await serviceOperations.pinSession(shares.SHARE_PRINCIPAL, s1, () => ({ action: 'ask', idempotency_key: 'relay-direct-1' }), null),
      await serviceOperations.sendToPin(shares.SHARE_PRINCIPAL, shares.shareRow(shareA.share_ref).pin_ref, () => ({ content: 'direct', idempotency_key: 'relay-direct-2' }), null),
      await serviceOperations.readPin(shares.SHARE_PRINCIPAL, shares.shareRow(shareA.share_ref).pin_ref),
      await serviceOperations.sendSessionMessage(shares.SHARE_PRINCIPAL, s1, () => ({ content: 'direct', idempotency_key: 'relay-direct-3' }), null),
    ];
    assert(relayPins[0].body.error.code === 'session_not_found' && relayPins[1].body.error.code === 'pin_not_found' && relayPins[2].body.error.code === 'pin_not_found'
      && relayPins[3].body.error.code === 'session_not_found', 'the share principal cannot pin, send to, or read pins, or message a session through the ordinary endpoints');
    const askTrail = db.prepare("SELECT outcome, code FROM service_audit_events WHERE operation = 'shares.ask' ORDER BY id").all().map(r => `${r.outcome}${r.code ? `:${r.code}` : ''}`);
    assert(askTrail.length === count("SELECT COUNT(*) AS n FROM service_audit_events WHERE operation = 'shares.ask'") && askTrail.includes('allowed:replayed') && askTrail.includes('denied:share_turn_in_progress'),
      `shares.ask audit trail: ${askTrail.join(',')}`);
    const totalTurns = count('SELECT COUNT(*) AS n FROM session_share_events WHERE type = \'turn_sent\'');
    const totalUsed = db.prepare('SELECT SUM(turns_used) AS n FROM session_shares').get().n;
    const pinTurns = count("SELECT COUNT(*) AS n FROM session_pin_turns WHERE requester_id = 'botmancers-session-share'");
    assert(totalTurns === totalUsed && totalUsed === pinTurns, `canonical counts: turn_sent events (${totalTurns}) = turns_used (${totalUsed}) = share pin turns (${pinTurns})`);
    let appendOnly = false;
    try { db.prepare('DELETE FROM session_share_events').run(); } catch { appendOnly = true; }
    assert(appendOnly, 'session_share_events are append-only');
  }

  console.log('\nREST routes and MCP tools over the same operations');
  {
    const routes = {
      create: jiti('./app/api/v0/sessions/[ref]/shares/route.ts'),
      list: jiti('./app/api/v0/shares/route.ts'),
      get: jiti('./app/api/v0/shares/[shareRef]/route.ts'),
      revoke: jiti('./app/api/v0/shares/[shareRef]/revoke/route.ts'),
    };
    const auth = { authorization: `Bearer ${TOKENS.grok}`, 'content-type': 'application/json' };
    const json = async res => ({ status: res.status, body: await res.json() });
    const created = await json(await routes.create.POST(new Request(`http://local/api/v0/sessions/${s2}/shares`, {
      method: 'POST', headers: { ...auth, 'idempotency-key': 'rest-1' }, body: JSON.stringify({ audience, ttl_seconds: 900 }),
    }), { params: Promise.resolve({ ref: s2 }) }));
    assert(created.status === 201 && created.body.share.session_ref === s2 && created.body.share.expires_at - created.body.share.created_at === 900 * 1000, 'POST /api/v0/sessions/{ref}/shares -> 201');
    const ref = created.body.share.share_ref;
    const got = await json(await routes.get.GET(new Request(`http://local/api/v0/shares/${ref}`, { headers: auth }), { params: Promise.resolve({ shareRef: ref }) }));
    const listed = await json(await routes.list.GET(new Request(`http://local/api/v0/shares?session_ref=${encodeURIComponent(s2)}&state=active&limit=50`, { headers: auth })));
    const heur = await json(await routes.list.GET(new Request('http://local/api/v0/shares?latest=1', { headers: auth })));
    assert(got.status === 200 && got.body.share.share_ref === ref && listed.status === 200 && listed.body.items.some(item => item.share_ref === ref) && heur.status === 403,
      'GET /api/v0/shares/{ref} and GET /api/v0/shares?session_ref&state&limit; ?latest -> 403');
    const unauth = await json(await routes.get.GET(new Request(`http://local/api/v0/shares/${ref}`), { params: Promise.resolve({ shareRef: ref }) }));
    assert(unauth.status === 401, 'no bearer token -> 401 before anything is read');
    const revoked = await json(await routes.revoke.POST(new Request(`http://local/api/v0/shares/${ref}/revoke`, { method: 'POST', headers: auth }), { params: Promise.resolve({ shareRef: ref }) }));
    assert(revoked.status === 200 && revoked.body.share.state === 'revoked', 'POST /api/v0/shares/{ref}/revoke -> 200 revoked');
    assert(!fs.existsSync(path.join(ROOT, 'app/api/v0/shares/current')) && !Object.keys(routes.get).includes('POST'),
      'no /api/v0/shares/current route exists (share-current is not served)');

    const names = mcp.MCP_V2_TOOLS.map(tool => tool.name);
    const shareTools = ['botmancers_create_share', 'botmancers_get_share', 'botmancers_list_shares', 'botmancers_revoke_share'];
    assert(same(names.slice(-4), shareTools) && !names.includes('botmancers_share_current_session'), 'MCP v2 adds the four share tools; botmancers_share_current_session is absent');
    const toolOf = name => mcp.MCP_V2_TOOLS.find(tool => tool.name === name);
    assert(shareTools.every(name => toolOf(name).inputSchema.additionalProperties === false && toolOf(name).outputSchema.additionalProperties === false && toolOf(name)._meta['botmancers/optional'] === true),
      'strict input and output schemas, marked optional (additive)');
    const callTool = async (name, args, principal = grok) => {
      try {
        return { ok: true, data: await mcp.callMcpV2Tool(principal, name, args, { v1Operations: [] }) };
      } catch (error) {
        return { ok: false, code: error.code, fields: error.fields };
      }
    };
    const before = snapshot();
    const mcpCreate = await callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-1' });
    assert(mcpCreate.ok && mcpCreate.data.contract === 'botmancers.mcp.v2' && mcpCreate.data.share.session_ref === s1 && mcpCreate.data.replayed === false, 'botmancers_create_share creates one share');
    const mcpReplay = await callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-1' });
    assert(mcpReplay.ok && mcpReplay.data.replayed === true && mcpReplay.data.share.share_ref === mcpCreate.data.share.share_ref, 'its exact replay returns the same share');
    const restSeen = await serviceOperations.getShare(grok, mcpCreate.data.share.share_ref);
    assert(restSeen.status === 200, 'the MCP-created share is the same share REST reads');
    const mcpRejects = await Promise.all([
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-2', workspace: '/work/share' }),
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-3', latest: true }),
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-4', model: 'x' }),
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-5', ttl_seconds: 10 }),
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-6', surprise: 1 }),
      callTool('botmancers_create_share', { session_ref: otherRef, audience, idempotency_key: 'mcp-7' }),
      callTool('botmancers_create_share', { session_ref: s1, audience, idempotency_key: 'mcp-8' }, other),
    ]);
    assert(mcpRejects[0].code === 'authority_not_allowed' && mcpRejects[1].code === 'authority_not_allowed' && mcpRejects[2].code === 'authority_not_allowed'
      && mcpRejects[3].code === 'invalid_arguments' && mcpRejects[4].code === 'unsupported_field' && mcpRejects[5].code === 'session_not_found' && mcpRejects[6].code === 'grant_required',
      `MCP refusals: workspace/latest/model authority_not_allowed, TTL invalid_arguments, unknown unsupported_field, ungranted session session_not_found, no shares:create grant_required (${mcpRejects.map(r => r.code).join(',')})`);
    const mcpGet = await callTool('botmancers_get_share', { share_ref: mcpCreate.data.share.share_ref });
    const mcpList = await callTool('botmancers_list_shares', { session_ref: s1, state: 'active', limit: 10 });
    const mcpRevoke = await callTool('botmancers_revoke_share', { share_ref: mcpCreate.data.share.share_ref });
    const mcpRevokeAgain = await callTool('botmancers_revoke_share', { share_ref: mcpCreate.data.share.share_ref });
    const mcpMissing = await callTool('botmancers_get_share', { share_ref: 'shr_missing' });
    assert(mcpGet.ok && mcpGet.data.share.share_ref === mcpCreate.data.share.share_ref && mcpList.ok && mcpList.data.items.some(item => item.share_ref === mcpCreate.data.share.share_ref)
      && mcpRevoke.ok && mcpRevoke.data.share.state === 'revoked' && mcpRevoke.data.replayed === false && mcpRevokeAgain.data.replayed === true && mcpMissing.code === 'share_not_found',
      'botmancers_get_share, botmancers_list_shares, botmancers_revoke_share (idempotent); a missing share is share_not_found');
    const after = snapshot();
    assert(after.shares - before.shares === 1 && after.pins - before.pins === 1, 'the MCP refusals wrote nothing: one share and one pin from the one accepted create');
    const caps = await callTool('botmancers_capabilities', {});
    assert(caps.ok && caps.data.agents.find(a => a.agent_id === dev.id).capabilities.includes('shares:create')
      && caps.data.operations.some(op => op.tool === 'botmancers_create_share' && op.capability === 'shares:create' && op.agent_ids.includes(dev.id)),
      'botmancers_capabilities lists shares:create and the share tools it unlocks');
  }

  console.log('\nRedaction (finding R1): workspaces and cwd-shaped output are private');
  {
    const redactor = serviceRedactor();
    const cases = [
      ['cwd is /work/share/src/app.ts', '/work/share'],
      [`working in ${HOME}/dev-default-ws now`, `${HOME}/dev-default-ws`],
      ['default ~/dev-default-ws', '~/dev-default-ws'],
      [`see ${HOME}/anything/else.txt`, HOME],
      [`other: ${HOME}/private-other`, 'private-other'],
    ];
    for (const [text, leak] of cases) {
      const out = redactor.text(text);
      assert(!out.includes(leak) && out.includes('[redacted]'), `"${text.replace(HOME, '~')}" -> "${out}"`);
    }
    assert(redactor.text('the share shr_abc and session ref stay') === 'the share shr_abc and session ref stay', 'ordinary text is untouched');
    const agentView = await serviceOperations.getAgent(grok, dev.id);
    const sessions = await serviceOperations.listSessions(grok, dev.id, { cursor: null, limit: null, status: null });
    const surface = JSON.stringify([agentView.body, sessions.body]);
    assert(agentView.body.messaging.default_workspace_set === true && sessions.body.items.length > 0 && sessions.body.items.every(item => typeof item.ref === 'string' && item.title)
      && !surface.includes('/work/share') && !surface.includes('dev-default-ws') && !surface.includes(HOME) && !SECRET.test(surface),
      'API views keep their safe fields (refs, titles, default_workspace_set) and hold no workspace, home path, or provider id');
    const everything = JSON.stringify([
      db.prepare('SELECT * FROM service_audit_events').all(),
      db.prepare('SELECT * FROM session_shares').all(),
      db.prepare('SELECT * FROM session_share_events').all(),
      (await serviceOperations.listShares(grok, { cursor: null, limit: '100', sessionRef: null, state: null })).body,
    ]);
    assert(!everything.includes('/work/share') && !everything.includes(HOME) && !SECRET.test(everything), 'audit rows, share rows, share events, and share lists hold no workspace, home path, or provider id');
  }

  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures})`}`);
  if (failures === 0) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
