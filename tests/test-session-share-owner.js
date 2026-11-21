#!/usr/bin/env node
// NOT-519: the owner's session-share lifecycle (lib/session-share-owner,
// docs/session-shares.md) against the real store, an isolated SQLite file,
// the deterministic fake provider, and the fake Slack transport:
//   - owner routes: loopback/same-origin boundary, service credentials
//     refused, create (exact replay, conflict, allowlist, missing and
//     cross-Agent sessions), list (pagination, filters, redaction), and an
//     idempotent revoke (missing, expired, replay) with before/after counts;
//   - the share policy: enable, disable, malformed / duplicate / wildcard
//     audiences, a stale revision (concurrent update), a hand-broken file,
//     deleted Agents pruned, restart; turning share_from_turn off revokes the
//     Agent's live SessionContexts at once and no new one is minted;
//   - the expired-share sweeper, clock-controlled, over active, expired,
//     revoked, exhausted, in-flight, and restart (a real second process)
//     cases, with canonical row counts;
//   - Slack end to end: a share created from the owner route answers one
//     thread question; revoked from the owner route, the next question gets
//     the fixed share_revoked notice; expired and swept, share_expired.
// Self-contained: no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = require('./support/repo-root');
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT519_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-share-owner-${TAG}`);
const STATE = path.join(TMP, 'provider.json');
const SHARES_PATH = path.join(TMP, 'config', 'session-shares.json');
const IDS_PATH = path.join(TMP, 'ids.json');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
const CLAUDE = { config: path.join(TMP, 'claude-config'), state: path.join(TMP, 'claude-state') };
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;
process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '100000';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK|^CLAUDE_CODE|^BOTMANCERS_SLACK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const shares = jiti('../lib/session-shares.ts');
const owner = jiti('../lib/session-share-owner.ts');
const sc = jiti('../lib/session-context.ts');
const relayLib = jiti('../lib/slack-relay.ts');
const { ownerBoundaryRefusalFor } = jiti('../lib/owner-boundary.ts');
const routes = {
  list: jiti('../app/api/shares/route.ts'),
  revoke: jiti('../app/api/shares/[shareRef]/revoke/route.ts'),
  session: jiti('../app/api/bots/[id]/sessions/[ref]/shares/route.ts'),
  policy: jiti('../app/api/bots/[id]/share-policy/route.ts'),
  current: jiti('../app/api/v0/shares/current/route.ts'),
};
const fake = require('./support/fake-session-provider');
const { createFakeSlackTransport } = require('./support/fake-slack-transport');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const SECRET = /SECRET|\/work\/|claude-config|xoxb-|xapp-|bmsc_/;
const HOME = os.homedir();
const BASE = 'http://127.0.0.1:3333';
const SAME_ORIGIN = { origin: BASE, 'sec-fetch-site': 'same-origin' };
const audience = { kind: 'slack', team_id: 'T0OWNER01', channel_id: 'C0OWNER01' };
const audience2 = { kind: 'slack', team_id: 'T0OWNER01', channel_id: 'C0OWNER02' };
const sends = () => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').length;
const releaseHolds = () => fake.mutateFakeProvider(STATE, state => {
  for (const turn of Object.values(state.turns)) if (turn.state === 'running') turn.prompt = turn.prompt.replace('[hold] ', '');
});
const counts = () => ({
  shares: count('SELECT COUNT(*) AS n FROM session_shares'),
  events: count('SELECT COUNT(*) AS n FROM session_share_events'),
  pins: count('SELECT COUNT(*) AS n FROM session_pins'),
  attached: count("SELECT COUNT(*) AS n FROM session_pins WHERE state = 'attached'"),
  audit: count('SELECT COUNT(*) AS n FROM service_audit_events'),
  sends: sends(),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const leaks = value => {
  const text = JSON.stringify(value);
  return SECRET.test(text) || text.includes(HOME);
};

async function call(handler, url, { method = 'GET', headers = {}, body, params = {} } = {}) {
  const init = { method, headers: { ...(method === 'GET' ? {} : SAME_ORIGIN), ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const request = new Request(`${BASE}${url}`, init);
  // The owner boundary runs first in the server (proxy.ts), then the route.
  const refusal = ownerBoundaryRefusalFor(request);
  if (refusal) return { status: 403, body: { error: { code: 'owner_origin_required', message: refusal } } };
  const res = await handler(request, { params: Promise.resolve(params) });
  return { status: res.status, body: await res.json() };
}

function registerProviders(connectionId, claudeConnection) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
  if (claudeConnection) {
    const claude = jiti('../lib/claude-session-provider.ts');
    contract.registerSessionProvider({ connectionId: claudeConnection }, () => claude.createClaudeSessionProvider({
      bin: path.join(ROOT, 'tests', 'support', 'fake-claude-cli.js'), configDir: CLAUDE.config, stateDir: CLAUDE.state, env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE.config }, pollMs: 20, startupTimeoutMs: 20_000,
    }));
  }
}

if (RESTART) restart().catch(fatal);
else main().then(() => {
  console.log(failures ? `\n${failures} failure(s)` : '\nAll session-share owner checks passed.');
  process.exit(failures ? 1 : 0);
}).catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

// A second Botmancers process on the same database: its sweeper (the server
// runs it at start) detaches the shares that expired while it was down.
async function restart() {
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  registerProviders(ids.connectionId, null);
  shares.setSessionShareClock(() => ids.now);
  const before = counts();
  const first = shares.sweepExpiredShares();
  const second = shares.sweepExpiredShares();
  const policy = owner.sharePolicyView(ids.dev);
  process.stdout.write(`RESULT ${JSON.stringify({ before, after: counts(), first: first.swept, second: second.swept, policy: { state: policy.state, on: policy.agent.share_from_turn, audiences: policy.audiences.length } })}\n`);
  process.exit(0);
}

async function main() {
  console.log('\nSetup: Agents with native sessions on the fake provider, a Claude Code Agent');
  fs.mkdirSync(CLAUDE.config, { recursive: true });
  fs.mkdirSync(CLAUDE.state, { recursive: true });
  const connectionId = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Fake', host: 'This computer' }).id;
  const claudeConnection = dbModule.runtimeConnections.create({ provider: 'claude', label: 'Claude', host: 'This computer' }).id;
  registerProviders(connectionId, claudeConnection);
  const seeds = ['own-1', 'own-2', 'own-3', 'own-4', 'own-5', 'own-6', 'own-7', 'own-8', 'own-9', 'slack-1'].map(id => ({ id: `${id}-SECRET`, title: `Session ${id}`, workspace: '/work/owner' }));
  fake.seedFakeProvider(STATE, [...seeds, { id: 'other-1-SECRET', title: 'Other', workspace: `${HOME}/private-other` }]);
  const mkAgent = (name, agent = 'codex', conn = connectionId) => dbModule.bots.create({
    name, title: name, description: 'NOT-519', agent, runtime_connection_id: conn, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  const dev = mkAgent('Dev');
  const other = mkAgent('Other');
  const claudeDev = mkAgent('ClaudeDev', 'claude', claudeConnection);
  db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run('~/dev-default-ws', dev.id);
  for (const bot of [dev, other]) {
    let cursor = null;
    do cursor = (await ps.syncAgentSessions(db, bot.id, { cursor })).next_cursor; while (cursor);
  }
  db.prepare("DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id = 'other-1-SECRET'").run(dev.id);
  db.prepare("DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id <> 'other-1-SECRET'").run(other.id);
  const refOf = (bot, id) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(bot.id, `${id}-SECRET`).id;
  const ref = id => refOf(dev, id);
  const otherRef = refOf(other, 'other-1');
  const policyUrl = id => `/api/bots/${id}/share-policy`;
  const getPolicy = id => call(routes.policy.GET, policyUrl(id), { params: { id } });
  const putPolicy = (id, body, headers) => call(routes.policy.PUT, policyUrl(id), { method: 'PUT', body, headers, params: { id } });

  console.log('\nShare policy: absent, fail-closed validation, enable, concurrent update');
  let revision;
  {
    const absent = await getPolicy(dev.id);
    assert(absent.status === 200 && absent.body.policy.state === 'absent' && absent.body.policy.revision === 'absent' && absent.body.policy.audiences.length === 0
      && absent.body.policy.agent.share_from_turn === false, 'no document: absent, no audience, share_from_turn off');
    const fakeSupport = absent.body.policy.agent.share_current;
    const claudeSupport = (await getPolicy(claudeDev.id)).body.policy.agent.share_current;
    assert(claudeSupport.supported === true && fakeSupport.supported === false && /Share it from Sessions/.test(fakeSupport.reason),
      'share-current is supported for a Claude Code Agent and refused, with the explicit alternative, for a runtime without a launch seam');
    const bad = [
      ['malformed team id', { revision: 'absent', audiences: [{ team_id: 'team-1', channel_id: 'C0OWNER01' }] }, 400],
      ['wildcard channel', { revision: 'absent', audiences: [{ team_id: 'T0OWNER01', channel_id: '*' }] }, 400],
      ['duplicate audience', { revision: 'absent', audiences: [audience, audience] }, 400],
      ['unknown audience field', { revision: 'absent', audiences: [{ ...audience, workspace: '/work' }] }, 400],
      ['non-boolean toggle', { revision: 'absent', share_from_turn: 'yes' }, 400],
      ['no revision', { share_from_turn: true }, 400],
      ['unknown field', { revision: 'absent', agents: [] }, 400],
      ['stale revision', { revision: 'deadbeef', share_from_turn: true }, 409],
      ['not JSON', '{', 400],
    ];
    for (const [label, body, status] of bad) {
      const res = await putPolicy(dev.id, body);
      assert(res.status === status && !fs.existsSync(SHARES_PATH), `${label}: ${res.status} ${res.body.error && res.body.error.code}, nothing written`);
    }
    const crossOrigin = await putPolicy(dev.id, { revision: 'absent', share_from_turn: true }, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    const bearer = await putPolicy(dev.id, { revision: 'absent', share_from_turn: true }, { authorization: 'Bearer grok-token' });
    assert(crossOrigin.status === 403 && bearer.status === 403 && bearer.body.error.code === 'owner_origin_required' && !fs.existsSync(SHARES_PATH),
      'a cross-origin request and a service bearer token are refused by the owner policy route');
    const enabled = await putPolicy(dev.id, { revision: 'absent', share_from_turn: true, audiences: [audience, audience2] });
    revision = enabled.body.policy && enabled.body.policy.revision;
    const stat = fs.statSync(SHARES_PATH);
    assert(enabled.status === 200 && enabled.body.policy.state === 'loaded' && enabled.body.policy.agent.share_from_turn === true && enabled.body.policy.audiences.length === 2
      && (stat.mode & 0o777) === 0o600 && shares.shareFromTurnEnabled(dev.id) && shares.audienceAllowed(audience),
      'enable with two audiences: written 0600, loaded by the store on the next call');
    const [a, b] = await Promise.all([
      putPolicy(other.id, { revision, share_from_turn: false }),
      putPolicy(dev.id, { revision, audiences: [audience] }),
    ]);
    const won = [a, b].filter(res => res.status === 200).length;
    const lost = [a, b].find(res => res.status === 409);
    assert(won === 1 && lost && lost.body.error.code === 'policy_conflict', 'two concurrent updates of one revision: one applies, the other is policy_conflict');
    revision = (await getPolicy(dev.id)).body.policy.revision;
    const restored = await putPolicy(dev.id, { revision, audiences: [audience, audience2] });
    revision = restored.body.policy.revision;
    const doc = JSON.parse(fs.readFileSync(SHARES_PATH, 'utf8'));
    assert(restored.status === 200 && doc.audiences.length === 2 && doc.agents.some(e => e.agent === dev.id && e.share_from_turn === true),
      'the losing change re-applied on the fresh revision; Dev\'s toggle survives an audience edit');
  }

  console.log('\nshare_from_turn off: live contexts revoked now, no new context, share-current refused');
  {
    const launch = ref => ({ kind: 'codex_thread_load', ref });
    const c1 = sc.mintSessionContext({ agentId: dev.id, sessionRef: ref('own-1'), launch: launch('l-1') });
    const c2 = sc.mintSessionContext({ agentId: dev.id, sessionRef: ref('own-2'), launch: launch('l-2') });
    assert(c1 && c2 && sc.resolveSessionContext(c1.token).ok, 'share_from_turn on: contexts are minted and resolve');
    const off = await putPolicy(dev.id, { revision, share_from_turn: false });
    revision = off.body.policy.revision;
    assert(off.status === 200 && off.body.revoked_contexts === 2 && off.body.policy.agent.share_from_turn === false && off.body.policy.agent.live_contexts === 0,
      'turning it off reports both live contexts revoked');
    assert(sc.contextRow(c1.id).state === 'revoked' && sc.contextRow(c1.id).end_reason === 'owner_off' && sc.contextRow(c2.id).state === 'revoked',
      'the rows are revoked (owner_off) in the same call, before any further use');
    assert(sc.mintSessionContext({ agentId: dev.id, sessionRef: ref('own-1'), launch: launch('l-3') }) === null, 'no new context is minted while off');
    const before = counts();
    const res = await routes.current.POST(new Request(`${BASE}/api/v0/shares/current`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Botmancers-Session-Context': c1.token }, body: JSON.stringify({ audience, idempotency_key: 'cur-1' }),
    }));
    const body = await res.json();
    assert(res.status === 409 && body.error.code === 'session_context_required' && body.error.reason === 'revoked' && same(before.shares, counts().shares),
      'share-current with the revoked context: session_context_required (revoked), no share');
    const again = await putPolicy(dev.id, { revision, share_from_turn: true });
    revision = again.body.policy.revision;
    assert(again.status === 200 && again.body.revoked_contexts === 0 && sc.resolveSessionContext(c1.token).reason === 'revoked',
      'turning it back on does not revive a revoked context');
  }

  console.log('\nPolicy file: hand-broken file refused, deleted Agents pruned, restart');
  {
    const good = fs.readFileSync(SHARES_PATH, 'utf8');
    fs.writeFileSync(SHARES_PATH, '{ "version": 1, "audiences": [ {');
    const view = await getPolicy(dev.id);
    const put = await putPolicy(dev.id, { revision: view.body.policy.revision, share_from_turn: false });
    assert(view.body.policy.state === 'invalid' && /not valid JSON/.test(view.body.policy.reason) && put.status === 409 && put.body.error.code === 'policy_invalid'
      && fs.readFileSync(SHARES_PATH, 'utf8').startsWith('{ "version": 1, "audiences": [ {') && !shares.audienceAllowed(audience),
      'an invalid document is reported, never overwritten, and allows nothing');
    fs.writeFileSync(SHARES_PATH, good);
    const gone = mkAgent('Gone');
    const withGone = await putPolicy(gone.id, { revision: (await getPolicy(gone.id)).body.policy.revision, share_from_turn: true });
    dbModule.bots.removeMany([gone.id]);
    shares.resetSessionSharesConfigCache();
    assert(withGone.status === 200 && shares.loadSessionSharesConfig().state === 'invalid', 'a deleted Agent left in the document makes it invalid (the store fails closed)');
    const repaired = await putPolicy(dev.id, { revision: (await getPolicy(dev.id)).body.policy.revision, share_from_turn: true });
    revision = repaired.body.policy.revision;
    assert(repaired.status === 200 && repaired.body.policy.state === 'loaded' && !JSON.parse(fs.readFileSync(SHARES_PATH, 'utf8')).agents.some(e => e.agent === gone.id),
      'the next owner edit prunes the deleted Agent and the document loads again');
    shares.resetSessionSharesConfigCache();
    sc.simulateSessionContextRestart();
    const reloaded = await getPolicy(dev.id);
    assert(reloaded.body.policy.state === 'loaded' && reloaded.body.policy.agent.share_from_turn === true && reloaded.body.policy.revision === revision
      && reloaded.body.policy.audiences.length === 2, 'after a restart the same policy and revision load from the file');
  }

  console.log('\nOwner routes: boundary, service credentials, create, replay, conflict, refusals');
  const createUrl = sessionRef => `/api/bots/${dev.id}/sessions/${sessionRef}/shares`;
  const create = (sessionRef, body, agentId = dev.id, headers) => call(routes.session.POST, `/api/bots/${agentId}/sessions/${sessionRef}/shares`, {
    method: 'POST', body, headers, params: { id: agentId, ref: sessionRef },
  });
  const list = (query = '', headers) => call(routes.list.GET, `/api/shares${query}`, { headers });
  const revoke = (shareRef, headers) => call(routes.revoke.POST, `/api/shares/${shareRef}/revoke`, { method: 'POST', headers, params: { shareRef } });
  let shareA;
  {
    const before = counts();
    const refused = [
      ['non-loopback host', await call(routes.list.GET, '/api/shares', { headers: { host: 'botmancers.example' } })],
      ['cross-origin create', await create(ref('own-1'), { audience, idempotency_key: 'x-1' }, dev.id, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })],
      ['headerless create', await call(routes.session.POST, createUrl(ref('own-1')), { method: 'POST', headers: { origin: '', 'sec-fetch-site': '' }, body: { audience, idempotency_key: 'x-2' }, params: { id: dev.id, ref: ref('own-1') } })],
      ['service bearer list', await list('', { authorization: 'Bearer grok-token' })],
      ['service bearer create', await create(ref('own-1'), { audience, idempotency_key: 'x-3' }, dev.id, { authorization: 'Bearer grok-token' })],
      ['session-context revoke', await revoke('shr_whatever', { 'Botmancers-Session-Context': 'bmsc_x' })],
    ];
    for (const [label, res] of refused) assert(res.status === 403 && res.body.error.code === 'owner_origin_required', `${label}: 403 owner_origin_required`);
    assert(same(before, counts()), 'refused owner calls write nothing (shares, events, pins, audit, sends)');

    const created = await create(ref('own-1'), { audience: { team_id: audience.team_id, channel_id: audience.channel_id }, ttl_seconds: 3600, max_turns: 5, idempotency_key: 'own-a' });
    shareA = created.body.share;
    const after = counts();
    assert(created.status === 201 && created.body.replayed === false && /^shr_/.test(shareA.share_ref) && shareA.session_ref === ref('own-1')
      && shareA.agent.id === dev.id && shareA.agent.name === 'Dev' && shareA.status === 'active' && shareA.created_by === 'owner' && shareA.max_turns === 5
      && shareA.thread.posted === false && after.shares === before.shares + 1 && after.events === before.events + 1 && after.pins === before.pins + 1,
      'owner create: 201, exact session, owner-created, 1 share + 1 created event + 1 ask pin');
    const replay = await create(ref('own-1'), { audience: { team_id: audience.team_id, channel_id: audience.channel_id }, ttl_seconds: 3600, max_turns: 5, idempotency_key: 'own-a' });
    assert(replay.status === 200 && replay.body.replayed === true && replay.body.share.share_ref === shareA.share_ref && same(after, counts()),
      'exact replay: 200, the same share, nothing written');
    const conflict = await create(ref('own-1'), { audience, max_turns: 6, idempotency_key: 'own-a' });
    const offList = await create(ref('own-1'), { audience: { team_id: 'T0OWNER01', channel_id: 'C0NOTLIST' }, idempotency_key: 'own-b' });
    const missing = await create('ses_missing', { audience, idempotency_key: 'own-c' });
    const crossAgent = await create(otherRef, { audience, idempotency_key: 'own-d' });
    const unknownField = await create(ref('own-1'), { audience, idempotency_key: 'own-e', provider_session_id: 'own-1-SECRET' });
    const badTtl = await create(ref('own-1'), { audience, idempotency_key: 'own-f', ttl_seconds: 10 });
    assert(conflict.status === 409 && conflict.body.error.code === 'idempotency_conflict', 'same key, other body: 409 idempotency_conflict');
    assert(offList.status === 403 && offList.body.error.code === 'audience_not_allowed', 'an audience off the allowlist: 403 audience_not_allowed');
    assert(missing.status === 404 && missing.body.error.code === 'session_not_found' && crossAgent.status === 404 && crossAgent.body.error.code === 'session_not_found',
      'a missing session and another Agent\'s session answer alike: 404 session_not_found');
    assert(unknownField.status === 400 && badTtl.status === 400 && !leaks(unknownField.body), 'an unknown field or out-of-range TTL: 400, nothing echoed');
    assert(same(after, counts()), 'refused creates write nothing');
  }

  console.log('\nList: pagination, filters, redaction');
  {
    for (const [i, id] of ['own-2', 'own-3', 'own-4'].entries()) {
      const res = await create(ref(id), { audience: i === 1 ? audience2 : audience, idempotency_key: `own-list-${i}` });
      assert(res.status === 201, `create share on ${id}`);
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    const all = await list();
    const page1 = await list('?limit=2');
    const page2 = await list(`?limit=2&cursor=${page1.body.next_cursor}`);
    const ids = [...page1.body.shares, ...page2.body.shares].map(s => s.share_ref);
    assert(all.status === 200 && all.body.shares.length === 4 && all.body.next_cursor === null, 'four shares, one page by default');
    assert(page1.body.shares.length === 2 && typeof page1.body.next_cursor === 'string' && page2.body.shares.length === 2 && page2.body.next_cursor === null
      && new Set(ids).size === 4 && same(ids, all.body.shares.map(s => s.share_ref)), 'limit 2: two pages, newest first, no repeat, same order as the full list');
    const bySession = await list(`?session_ref=${ref('own-1')}`);
    const bySessionRoute = await call(routes.session.GET, createUrl(ref('own-1')), { params: { id: dev.id, ref: ref('own-1') } });
    assert(bySession.body.shares.length === 1 && bySession.body.shares[0].share_ref === shareA.share_ref && same(bySessionRoute.body, bySession.body),
      'session_ref filter (and the session route): exactly that session\'s share');
    const bad = [await list('?cursor=bogus'), await list('?limit=0'), await list('?state=sideways'), await list('?workspace=/work'), await list('?session_ref=a&session_ref=b')];
    assert(bad.every(res => res.status === 400 && res.body.error.code === 'invalid_request'), 'a bad cursor, limit, state, unknown or repeated parameter: 400');
    const sessionBad = await call(routes.session.GET, `${createUrl(ref('own-1'))}?agent_id=${other.id}`, { params: { id: dev.id, ref: ref('own-1') } });
    assert(sessionBad.status === 400, 'the session route cannot be widened to another Agent');
    const fields = Object.keys(all.body.shares[0]).sort().join(',');
    assert(fields === 'agent,audience,authority,created_at,created_by,created_via,expires_at,max_turns,revoked_at,session_ref,share_ref,state,status,thread,tool_access,turns_used',
      `the owner view has only the safe fields (${fields})`);
    assert(!leaks(all.body), 'no provider session id, workspace, home path, or token in the list');
  }

  console.log('\nRevoke: idempotent, missing, expired; counts');
  {
    const before = counts();
    const first = await revoke(shareA.share_ref);
    const mid = counts();
    const second = await revoke(shareA.share_ref);
    assert(first.status === 200 && first.body.replayed === false && first.body.share.state === 'revoked' && first.body.share.status === 'revoked'
      && typeof first.body.share.revoked_at === 'number', 'revoke: 200, revoked');
    assert(mid.events === before.events + 1 && mid.attached === before.attached - 1 && mid.shares === before.shares && mid.pins === before.pins,
      'one revoked event, the pin detached; no row deleted');
    assert(second.status === 200 && second.body.replayed === true && same(mid, counts()) && second.body.share.revoked_at === first.body.share.revoked_at,
      'replay: 200 replayed, nothing written, the same revoked_at');
    const missing = await revoke('shr_doesnotexist0000000000');
    assert(missing.status === 404 && missing.body.error.code === 'share_not_found' && same(mid, counts()), 'missing share: 404 share_not_found');
    const t0 = Date.now();
    const expiring = (await create(ref('own-5'), { audience, ttl_seconds: 300, idempotency_key: 'own-expiring' })).body.share;
    shares.setSessionShareClock(() => t0 + 301_000);
    const expiredView = (await list(`?session_ref=${ref('own-5')}`)).body.shares[0];
    const revokedExpired = await revoke(expiring.share_ref);
    shares.setSessionShareClock(null);
    assert(expiredView.state === 'expired' && expiredView.status === 'expired' && revokedExpired.status === 200 && revokedExpired.body.share.state === 'revoked',
      'an expired share lists as expired, and the owner can still revoke it');
    const states = (await list('?state=revoked')).body.shares.map(s => s.share_ref).sort();
    assert(same(states, [shareA.share_ref, expiring.share_ref].sort()), 'state=revoked lists exactly the two revoked shares');
  }

  console.log('\nDisplay status: exhausted, answering, recovering');
  {
    const limited = (await create(ref('own-6'), { audience, max_turns: 1, idempotency_key: 'own-limited' })).body.share;
    const ask = await shares.askShare({ shareRef: limited.share_ref, question: 'Only one?', messageKey: 'own-limited-q1' });
    await ask.settled;
    await shares.shareAnswer(limited.share_ref, ask.turn.turn_ref);
    const busy = (await create(ref('own-7'), { audience, idempotency_key: 'own-busy' })).body.share;
    const held = await shares.askShare({ shareRef: busy.share_ref, question: '[hold] Long one?', messageKey: 'own-busy-q1' });
    const stuck = (await create(ref('own-8'), { audience, idempotency_key: 'own-stuck' })).body.share;
    db.prepare("UPDATE session_shares SET inflight_key = 'lost-key', inflight_owner = 'an-earlier-process' WHERE id = ?").run(stuck.share_ref);
    const view = async r => (await list(`?session_ref=${r}`)).body.shares[0].status;
    assert(await view(ref('own-6')) === 'exhausted', 'all questions used: exhausted');
    assert(await view(ref('own-7')) === 'answering', 'a question being answered: answering');
    assert(await view(ref('own-8')) === 'recovering', 'a claim left by an earlier process: recovering');
    releaseHolds();
    await held.settled;
    await shares.shareAnswer(busy.share_ref, held.turn.turn_ref);
    assert(await view(ref('own-7')) === 'active', 'once the answer is recorded: active again');
    const next = await shares.askShare({ shareRef: stuck.share_ref, question: 'Recovered?', messageKey: 'own-stuck-q1' });
    await next.settled;
    await shares.shareAnswer(stuck.share_ref, next.turn.turn_ref);
    assert(await view(ref('own-8')) === 'active', 'the next question frees a stale claim: active');
  }

  console.log('\nExpired-share sweeper: clock-controlled');
  {
    const t0 = Date.now() + 10_000;
    shares.setSessionShareClock(() => t0);
    const mk = async (id, key, extra = {}) => (await create(ref(id), { audience, ttl_seconds: 300, idempotency_key: key, ...extra })).body.share;
    const active = (await create(ref('own-9'), { audience, ttl_seconds: 3600, idempotency_key: 'sw-active' })).body.share;
    const expired = await mk('own-2', 'sw-expired');
    const revoked = await mk('own-3', 'sw-revoked');
    await revoke(revoked.share_ref);
    const exhausted = await mk('own-4', 'sw-exhausted', { max_turns: 1 });
    const used = await shares.askShare({ shareRef: exhausted.share_ref, question: 'One?', messageKey: 'sw-exhausted-q1' });
    await used.settled;
    await shares.shareAnswer(exhausted.share_ref, used.turn.turn_ref);
    const inflight = await mk('own-6', 'sw-inflight');
    const running = await shares.askShare({ shareRef: inflight.share_ref, question: '[hold] Still thinking?', messageKey: 'sw-inflight-q1' });
    const pinState = shareRef => db.prepare('SELECT p.state FROM session_pins p JOIN session_shares s ON s.pin_ref = p.id WHERE s.id = ?').get(shareRef).state;

    const early = shares.sweepExpiredShares();
    assert(early.swept.length === 0, 'before any expiry: nothing swept');
    shares.setSessionShareClock(() => t0 + 301_000);
    const before = counts();
    const auditBefore = count("SELECT COUNT(*) AS n FROM service_audit_events WHERE operation = 'shares.expire'");
    const first = shares.sweepExpiredShares();
    const after = counts();
    const swept = new Set(first.swept);
    assert(swept.size === 3 && swept.has(expired.share_ref) && swept.has(exhausted.share_ref) && swept.has(inflight.share_ref),
      'expired, expired-and-exhausted, and expired-with-a-running-turn shares are swept');
    assert(!swept.has(active.share_ref) && pinState(active.share_ref) === 'attached', 'an active share is not touched (pin attached)');
    assert(!swept.has(revoked.share_ref) && pinState(revoked.share_ref) === 'detached', 'an already revoked share is not touched again');
    assert([expired, exhausted, inflight].every(s => pinState(s.share_ref) === 'detached'), 'every swept share\'s Ask pin is detached');
    assert(after.shares === before.shares && after.events === before.events && after.pins === before.pins && after.attached === before.attached - 3
      && count("SELECT COUNT(*) AS n FROM service_audit_events WHERE operation = 'shares.expire'") === auditBefore + 3 && after.audit === before.audit + 3,
      'canonical counts: shares, events, and pins unchanged (history kept), 3 pins detached, +3 shares.expire audit rows');
    const views = Object.fromEntries((await list()).body.shares.map(s => [s.share_ref, s.state]));
    assert(views[expired.share_ref] === 'expired' && views[inflight.share_ref] === 'expired' && views[revoked.share_ref] === 'revoked' && views[active.share_ref] === 'active',
      'a swept share still reads expired (not revoked); the others keep their state');
    const second = shares.sweepExpiredShares();
    assert(second.swept.length === 0 && same(after, counts()), 'idempotent: a second sweep changes nothing');
    let code = null;
    try { await shares.askShare({ shareRef: expired.share_ref, question: 'Still there?', messageKey: 'sw-expired-q1' }); } catch (error) { code = error.code; }
    assert(code === 'share_expired', 'a question on a swept share is refused share_expired, not share_revoked');
    releaseHolds();
    await running.settled;
    const answer = await shares.shareAnswer(inflight.share_ref, running.turn.turn_ref);
    assert(answer && answer.state === 'completed' && typeof answer.answer === 'string', 'the turn that was running at expiry still finishes and its answer is readable');

    // Restart: shares that expired while Botmancers was stopped are swept by
    // the next process at start, once.
    const late = await mk('own-9', 'sw-restart');
    fs.writeFileSync(IDS_PATH, JSON.stringify({ connectionId, dev: dev.id, now: t0 + 1_000_000 }));
    shares.setSessionShareClock(null);
    const child = spawnSync(process.execPath, [__filename, 'restart'], { env: { ...process.env, NOT519_TAG: TAG }, encoding: 'utf8', timeout: 60_000 });
    const line = (child.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
    const result = line ? JSON.parse(line.slice(7)) : null;
    assert(result && same(result.first, [late.share_ref]) && result.second.length === 0, `restart: the new process sweeps exactly the late share once (${child.stderr ? child.stderr.slice(0, 200) : ''})`);
    assert(result && result.after.shares === result.before.shares && result.after.events === result.before.events && result.after.attached === result.before.attached - 1
      && result.after.audit === result.before.audit + 1, 'restart: counts kept, one pin detached, one audit row');
    assert(result && result.policy.state === 'loaded' && result.policy.on === true && result.policy.audiences === 2, 'restart: the owner policy reloads from the file');
    assert(pinState(late.share_ref) === 'detached', 'this process sees the late share detached');
  }

  console.log('\nSlack end to end: owner create -> one answered question -> owner revoke -> share_revoked notice');
  {
    const slack = createFakeSlackTransport({ anchors: ['1761400000.000100', '1761400000.000200'] });
    const relay = relayLib.createSlackRelay({ transport: slack.transport, botUserId: 'U0BOTOWNER' });
    await relay.start();
    await slack.transport.start(envelope => relay.handleEnvelope(envelope).then(() => {}));
    const share = (await create(ref('slack-1'), { audience, idempotency_key: 'slack-e2e' })).body.share;
    const bound = await relay.bindShare(share.share_ref);
    const posted = (await list(`?session_ref=${ref('slack-1')}`)).body.shares[0];
    assert(bound.thread.thread_ts === '1761400000.000100' && posted.thread.posted === true && typeof posted.thread.posted_at === 'number',
      'the relay posts the anchor; the owner view shows the thread posted');
    let n = 0;
    const question = (text, threadTs) => {
      n += 1;
      return {
        envelope_id: `env-own-${n}`, type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '',
        payload: { team_id: audience.team_id, api_app_id: 'A0OWNER', event_id: `EvOwn${n}`, event_time: 1761400100, type: 'event_callback',
          event: { type: 'message', channel: audience.channel_id, user: 'U0ALICE01', text, ts: `1761400100.00000${n}`, thread_ts: threadTs } },
      };
    };
    const sendsBefore = sends();
    const out1 = await relay.handleEnvelope(question('What is this session about?', bound.thread.thread_ts));
    await relay.idle();
    await relay.flushReplies();
    const reply = slack.state.posts.at(-1);
    assert(out1.outcome === 'dispatched' && sends() === sendsBefore + 1 && reply.thread_ts === bound.thread.thread_ts
      && reply.metadata.event_type === relayLib.REPLY_EVENT_TYPE && reply.metadata.event_payload.share_ref === share.share_ref,
      'one question is dispatched to the session and answered in its thread');
    const revoked = await revoke(share.share_ref);
    const before = { sends: sends(), posts: slack.state.posts.length };
    const out2 = await relay.handleEnvelope(question('One more?', bound.thread.thread_ts));
    await relay.idle();
    const notice = slack.state.posts.at(-1);
    assert(revoked.status === 200 && out2.outcome === 'refused' && out2.code === 'share_revoked' && sends() === before.sends
      && slack.state.posts.length === before.posts + 1 && notice.text === relayLib.NOTICES.share_revoked && notice.thread_ts === bound.thread.thread_ts,
      `after the owner revokes: refused share_revoked, no dispatch, the fixed notice "${notice.text}"`);
    assert(!slack.state.posts.some(p => leaks(p) || p.text.includes(ref('slack-1')) || p.text.includes(dev.id)),
      'no Slack post carries a provider id, workspace, session_ref, Agent id, or token');

    // Expiry: the sweeper detaches, the next question gets share_expired.
    const t1 = Date.now();
    shares.setSessionShareClock(() => t1);
    const short = (await create(ref('slack-1'), { audience, ttl_seconds: 300, idempotency_key: 'slack-e2e-expiring' })).body.share;
    const boundShort = await relay.bindShare(short.share_ref);
    shares.setSessionShareClock(() => t1 + 301_000);
    const swept = shares.sweepExpiredShares();
    const out3 = await relay.handleEnvelope(question('Still open?', boundShort.thread.thread_ts));
    await relay.idle();
    shares.setSessionShareClock(null);
    assert(swept.swept.includes(short.share_ref) && out3.outcome === 'refused' && out3.code === 'share_expired' && slack.state.posts.at(-1).text === relayLib.NOTICES.share_expired,
      'an expired, swept share: the next thread question gets the fixed share_expired notice');
    await relay.stop();
  }

  console.log('\nFull access: the owner grants it per share; a runtime that cannot enforce it is refused');
  {
    // The Dev Agent's fake runtime declares read_only and workspace_write only.
    const plain = await getPolicy(dev.id);
    const before = counts();
    const refusedRuntime = await create(ref('own-9'), { audience, tool_access: 'full_access', idempotency_key: 'full-refused' });
    const badValue = await create(ref('own-9'), { audience, tool_access: 'root', idempotency_key: 'full-bad' });
    assert(plain.body.policy.agent.full_access.supported === false && /Claude Code and Codex/.test(plain.body.policy.agent.full_access.reason),
      'the policy view says this runtime cannot take full access, and which can');
    assert(refusedRuntime.status === 403 && refusedRuntime.body.error.code === 'authority_not_allowed' && badValue.status === 400 && same(before, counts()),
      'full access on a runtime without it: 403 authority_not_allowed; an unknown value: 400; nothing written');
    const readOnly = (await create(ref('own-9'), { audience, idempotency_key: 'full-default' })).body.share;
    assert(readOnly.tool_access === 'read_only'
      && db.prepare('SELECT authority FROM session_pins WHERE id = (SELECT pin_ref FROM session_shares WHERE id = ?)').get(readOnly.share_ref).authority === 'read_only',
      'without tool_access a share stays read-only (its pin is read_only)');

    // A runtime that enforces full_access (as Claude Code and Codex do).
    const FULL_STATE = path.join(TMP, 'provider-full.json');
    const fullConnection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Full', host: 'This computer' }).id;
    contract.registerSessionProvider({ connectionId: fullConnection }, () => fake.createFakeSessionProvider({
      statePath: FULL_STATE, ignoreScope: true, capabilities: { authorities: ['read_only', 'workspace_write', 'full_access'] },
    }));
    fake.seedFakeProvider(FULL_STATE, [{ id: 'full-1-SECRET', title: 'Full', workspace: '/work/full' }]);
    const fullAgent = mkAgent('FullDev', 'codex', fullConnection);
    await ps.syncAgentSessions(db, fullAgent.id, {});
    const fullRef = refOf(fullAgent, 'full-1');
    const policy = await getPolicy(fullAgent.id);
    const created = await create(fullRef, { audience, tool_access: 'full_access', idempotency_key: 'full-a' }, fullAgent.id);
    const share = created.body.share;
    const pin = db.prepare('SELECT action, authority, approved_at FROM session_pins WHERE id = (SELECT pin_ref FROM session_shares WHERE id = ?)').get(share.share_ref);
    assert(policy.body.policy.agent.full_access.supported === true && created.status === 201 && share.tool_access === 'full_access'
      && pin.action === 'ask' && pin.authority === 'full_access' && typeof pin.approved_at === 'number',
      'owner create with tool_access full_access: 201, the share reads full_access, its ask pin carries full_access, recorded approved');
    const replay = await create(fullRef, { audience, tool_access: 'full_access', idempotency_key: 'full-a' }, fullAgent.id);
    const flipped = await create(fullRef, { audience, idempotency_key: 'full-a' }, fullAgent.id);
    assert(replay.status === 200 && replay.body.share.share_ref === share.share_ref && flipped.status === 409 && flipped.body.error.code === 'idempotency_conflict',
      'exact replay: 200; the same key without full access: 409 idempotency_conflict');

    const slack = createFakeSlackTransport({ anchors: ['1761400000.000900'] });
    const relay = relayLib.createSlackRelay({ transport: slack.transport, botUserId: 'U0BOTOWNER' });
    await relay.start();
    const bound = await relay.bindShare(share.share_ref);
    assert(slack.state.posts[0].text === relayLib.FULL_ACCESS_ANCHOR_TEXT && /shell commands/.test(relayLib.FULL_ACCESS_ANCHOR_TEXT),
      'the Slack anchor tells askers this share can edit files, run shell commands, and use the network');
    const out = await relay.handleEnvelope({
      envelope_id: 'env-full-1', type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '',
      payload: { team_id: audience.team_id, api_app_id: 'A0OWNER', event_id: 'EvFull1', event_time: 1761400100, type: 'event_callback',
        event: { type: 'message', channel: audience.channel_id, user: 'U0ALICE01', text: 'Move one task and read it back', ts: '1761400100.000901', thread_ts: bound.thread.thread_ts } },
    });
    await relay.idle();
    const sent = fake.loadFakeState(FULL_STATE).calls.filter(c => c.op === 'sendTurn');
    assert(out.outcome === 'dispatched' && sent.length === 1 && sent[0].authority === 'full_access',
      'a Slack question on the share reaches the runtime as a full_access turn');
    await relay.stop();
  }
}
