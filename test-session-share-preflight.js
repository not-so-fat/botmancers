#!/usr/bin/env node
// NOT-514 preflight: exact-session self-identification and the Slack relay
// seam (docs/design/2026-10-24-session-share-preflight.md). Proves, offline:
//   - the committed identity matrix covers Claude Code, Codex, and Cursor
//     for every lifecycle case, classifies each, and holds no raw id,
//     credential, transcript, or user path;
//   - the identity probe reports presence and shape only, in env and stdio
//     MCP modes;
//   - share_current_session resolves exactly one session from a minted
//     context and fails closed (session_context_required, with a reason)
//     for missing, ambiguous, unsupported, unknown, stale, and revoked
//     context; mismatched Agent and ungranted callers answer
//     session_not_found; heuristic selectors are authority_not_allowed;
//   - an offline Slack fixture is normalized, deduplicated, routed to one
//     exact seeded session_ref through NOT-507 pins, audited through the
//     NOT-499 audit, and answered in the right thread with a bounded,
//     redacted reply; canonical dispatch/audit counts for first delivery,
//     retry, double delivery, ledger loss, expired, revoked, unauthorized
//     channel, unknown thread, and concurrent turn;
//   - the Slack relay principal holds no Agent grant: the share is its only
//     authority.
// Self-contained: isolated SQLite and state files, no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(os.tmpdir(), `botmancers-session-share-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SERVICE_GRANTS_PATH = path.join(TMP, 'service-grants.json');
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=sha256:${'a'.repeat(64)},slack-relay=sha256:${'c'.repeat(64)}`;
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const STATE = path.join(TMP, 'provider.json');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const pins = jiti('./lib/session-pins.ts');
const { serviceRedactor } = jiti('./lib/service-redaction.ts');
const { serviceOperations } = jiti('./lib/service-api-http.ts');
const fake = require('./test-support/fake-session-provider');
const model = require('./test-support/session-share-model');
const probe = require('./scripts/not-514-identity-probe');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const SECRET = /SECRET/;
// No user path, no UUID-shaped id, no Slack/Cursor/OpenAI/Anthropic token.
const LEAK = /\/Users\/|\/home\/[a-z]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|xox[abp]-|xapp-|sk-[A-Za-z0-9]{8}|key_[A-Za-z0-9]{16}/i;

async function main() {
  const matrix = readJson('docs/evidence/NOT-514/identity-matrix.json');
  const sketch = readJson('docs/contracts/session-share-v0.sketch.json');
  const fixtures = readJson('docs/contracts/slack-relay-v0.fixtures.json');

  console.log('\nIdentity matrix: every client, every lifecycle case, classified');
  const CASES = ['new_session', 'exact_resume', 'implicit_resume', 'clear_reset', 'client_restart', 'not_botmancers_launched'];
  const CLASSES = ['supported', 'supported_when_botmancers_launches', 'unsupported'];
  assert(JSON.stringify(Object.keys(matrix.clients).sort()) === JSON.stringify(['claude_code', 'codex', 'cursor']), 'the matrix covers exactly Claude Code, Codex, and Cursor');
  for (const [name, client] of Object.entries(matrix.clients)) {
    assert(CLASSES.includes(client.classification) && typeof client.version === 'string' && client.version.length > 0,
      `${name}: classified ${client.classification} at version ${client.version}`);
    assert(CASES.every(c => client.cases[c] && typeof client.cases[c].ambient === 'string' && typeof client.cases[c].evidence === 'string' && ['exact', 'fail_closed'].includes(client.cases[c].share_current)),
      `${name}: all six lifecycle cases record ambient behavior, evidence, and an exact-or-fail-closed outcome`);
    assert(client.binding && ['botmancers_minted_context', 'none'].includes(client.binding.mechanism), `${name}: binding mechanism ${client.binding.mechanism}`);
    assert(client.classification === 'unsupported' ? client.binding.mechanism === 'none' : client.binding.mechanism === 'botmancers_minted_context',
      `${name}: a supported path binds with a minted context, an unsupported one binds nothing`);
    assert(client.cases.not_botmancers_launched.share_current === 'fail_closed', `${name}: outside a Botmancers launch, share-current fails closed`);
  }
  assert(Object.values(matrix.clients).every(c => c.ambient_identity_adopted === false), 'no client\'s ambient provider identity is adopted as authority');
  assert(matrix.head && /^[0-9a-f]{40}$/.test(matrix.head), 'the matrix names the exact HEAD it was probed at');
  const docText = ['docs/evidence/NOT-514/identity-matrix.json', 'docs/evidence/NOT-514/probe-results.md', 'docs/design/2026-10-24-session-share-preflight.md',
    'docs/contracts/session-share-v0.sketch.json', 'docs/contracts/slack-relay-v0.fixtures.json'].map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  assert(!LEAK.test(docText), 'committed evidence holds no user path, raw UUID, or credential');

  console.log('\nIdentity probe: presence and shape only');
  const raw = '0b9e3c1a-1111-4222-8333-944455556666';
  const report = probe.report({ CLAUDE_CODE_SESSION_ID: raw, CLAUDECODE: '1', CODEX_HOME: '/tmp/x/y', SOMETHING_ELSE: 'z' }, 'salt');
  const text = JSON.stringify(report);
  assert(report.signals.CLAUDE_CODE_SESSION_ID.present && report.signals.CLAUDE_CODE_SESSION_ID.shape === 'uuid' && /^[0-9a-f]{12}$/.test(report.signals.CLAUDE_CODE_SESSION_ID.fingerprint),
    'a UUID-shaped session id is reported as present/uuid with a salted fingerprint');
  assert(!text.includes(raw) && !text.includes('/tmp/x/y') && report.signals.CODEX_HOME.fingerprint === null && report.other_env_names === 1,
    'no value, no path, and no unwatched name is printed');
  assert(probe.report({ CLAUDE_CODE_SESSION_ID: raw }, null).signals.CLAUDE_CODE_SESSION_ID.fingerprint === null, 'without a salt there is no fingerprint');
  const lines = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"identity_probe","arguments":{}}}'].join('\n');
  const mcpRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts/not-514-identity-probe.js'), 'mcp-stdio'], {
    input: `${lines}\n`, encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: raw, NOT514_PROBE_SALT: 'salt', NOT514_PROBE_OUT: path.join(TMP, 'probe.jsonl') }, timeout: 10000,
  });
  const replies = mcpRun.stdout.trim().split('\n').map(line => JSON.parse(line));
  const toolReport = JSON.parse(replies[2].result.content[0].text);
  assert(replies[0].result.serverInfo.name === 'not-514-identity-probe' && replies[1].result.tools[0].name === 'identity_probe'
    && toolReport.signals.CLAUDE_CODE_SESSION_ID.fingerprint === report.signals.CLAUDE_CODE_SESSION_ID.fingerprint && !mcpRun.stdout.includes(raw),
    'mcp-stdio: initialize, tools/list, and identity_probe answer the same redacted report');
  assert(!fs.readFileSync(path.join(TMP, 'probe.jsonl'), 'utf8').includes(raw), 'mcp-stdio: the initialize-time report file holds no value');

  console.log('\nSetup: one Agent, two exact sessions, a grok-bot service, a Slack relay with no grants');
  const connectionId = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
  fake.seedFakeProvider(STATE, [
    { id: 'share-1-SECRET', title: 'Fix the uploader retry', workspace: '/work/share' },
    { id: 'share-2-SECRET', title: 'Write release notes', workspace: '/work/share' },
    { id: 'gone-1-SECRET', title: 'Soon gone', workspace: '/work/share' },
    { id: 'other-1-SECRET', title: 'Other agent', workspace: '/work/other' },
  ]);
  const mkAgent = name => dbModule.bots.create({
    name, title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  const dev = mkAgent('Dev');
  const otherAgent = mkAgent('Other');
  db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run('/work/share', dev.id);
  for (const bot of [dev, otherAgent]) {
    let cursor = null;
    do cursor = (await ps.syncAgentSessions(db, bot.id, { cursor })).next_cursor; while (cursor);
  }
  const keep = (bot, ids) => db.prepare(`DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id NOT IN (${ids.map(() => '?').join(',')})`).run(bot.id, ...ids);
  keep(dev, ['share-1-SECRET', 'share-2-SECRET', 'gone-1-SECRET']);
  keep(otherAgent, ['other-1-SECRET']);
  const refOf = (bot, id) => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(bot.id, id).id;
  const s1 = refOf(dev, 'share-1-SECRET');
  const s2 = refOf(dev, 'share-2-SECRET');
  const gone = refOf(dev, 'gone-1-SECRET');
  const otherRef = refOf(otherAgent, 'other-1-SECRET');
  fs.writeFileSync(process.env.BOTMANCERS_SERVICE_GRANTS_PATH, JSON.stringify({ version: 1, grants: [
    { service: 'grok-bot', agent: dev.id, capabilities: ['agents:read', 'sessions:read'] },
  ] }));
  fs.chmodSync(process.env.BOTMANCERS_SERVICE_GRANTS_PATH, 0o600);
  const grok = { kind: 'service', id: 'grok-bot' };
  const relayPrincipal = { kind: 'service', id: 'slack-relay' };
  const owner = dbModule.UI_OWNER_PRINCIPAL;
  // shares:create is the new SessionShare grant capability and
  // share_from_turn the owner's per-Agent opt-in (sketch); the model holds
  // both in memory.
  const shareGrants = new Set([`service:grok-bot|${dev.id}|shares:create`]);
  const shareFromTurn = new Set([dev.id]);
  const contextPrincipal = model.CONTEXT_PRINCIPAL;
  let clock = Date.UTC(2026, 9, 24, 9, 0, 0);
  const audiences = fixtures.audiences;
  // Finding R1: the NOT-499 redactor does not treat an Agent's
  // default_workspace or a native session's workspace as private. A share
  // reply must, so the SessionShare core ticket extends lib/service-redaction;
  // until then the fixture adds those values itself.
  const echo = 'cwd is /work/share';
  assert(serviceRedactor().text(echo) === echo, 'R1 recorded: serviceRedactor alone leaves a native session workspace in text');
  const workspaces = () => [...new Set([
    ...db.prepare('SELECT default_workspace AS w FROM bots WHERE default_workspace IS NOT NULL').all().map(r => r.w),
    ...db.prepare('SELECT workspace AS w FROM provider_sessions WHERE workspace IS NOT NULL').all().map(r => r.w),
  ])].filter(w => w.length >= 4).sort((a, b) => b.length - a.length);
  const redact = value => workspaces().reduce((acc, w) => acc.split(w).join('[redacted]'), serviceRedactor().text(value));
  const shares = model.createSessionShareModel({
    pins, audit: dbModule.serviceAudit, redact, now: () => clock, relayPrincipal, audiences,
    grants: { has: (p, agentId, cap) => shareGrants.has(`${p.kind}:${p.id}|${agentId}|${cap}`) }, shareFromTurn: agentId => shareFromTurn.has(agentId),
  });
  const relaySends = () => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').length;
  const sendsTo = id => Object.values(fake.loadFakeState(STATE).turns).filter(turn => turn.session === id).length;
  const audits = () => count("SELECT COUNT(*) AS n FROM service_audit_events WHERE principal IN ('service:slack-relay', 'service:grok-bot', 'service:botmancers-session-context')");
  const lastAudit = () => db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT 1').get();
  const denyRelay = await serviceOperations.pinSession(relayPrincipal, s1, () => ({ action: 'ask', idempotency_key: 'relay-direct-1' }), null);
  assert(denyRelay.status === 404 && denyRelay.body.error.code === 'session_not_found',
    'the Slack relay principal cannot pin or message any session through the grants API: shares do not broaden Agent-wide grants');
  const audience = { kind: 'slack', team_id: 'T0SHARE01', channel_id: 'C0SHARE01' };

  console.log('\nCurrent-session context: exactly one session, or session_context_required');
  const ctx = shares.mintContext({ agentId: dev.id, sessionRef: s1, launchRef: 'launch-1' });
  const current = await shares.createShare({ principal: contextPrincipal, headers: { 'botmancers-session-context': ctx }, body: { audience, ttl_seconds: 3600, idempotency_key: 'cur-0001' } });
  assert(current.status === 201 && current.body.share.session_ref === s1 && current.body.share.created_via === 'current_session' && current.body.share.authority === 'ask',
    'a minted, live context shares exactly its bound session_ref with ask-only authority');
  const reasonOf = async (headers, key, body = {}) => (await shares.createShare({ principal: contextPrincipal, headers, body: { audience, idempotency_key: key, ...body } })).body.error;
  const missing = await reasonOf({}, 'neg-0001');
  assert(missing.code === 'session_context_required' && missing.reason === 'missing' && missing.recovery === 'choose_session', 'missing context: session_context_required/missing, recovery choose_session');
  const ctx2 = shares.mintContext({ agentId: dev.id, sessionRef: s2, launchRef: 'launch-2' });
  assert((await reasonOf({ 'botmancers-session-context': [ctx, ctx2] }, 'neg-0002')).reason === 'ambiguous'
    && (await reasonOf({ 'botmancers-session-context': `${ctx}, ${ctx2}` }, 'neg-0003')).reason === 'ambiguous', 'two contexts (repeated or comma-joined header): ambiguous');
  const ambient = await reasonOf({ 'botmancers-session-context': '0b9e3c1a-1111-4222-8333-944455556666' }, 'neg-0004');
  assert(ambient.reason === 'unsupported' && !JSON.stringify(ambient).includes('0b9e3c1a'), 'an ambient provider id in place of a minted context: unsupported, never echoed');
  assert((await reasonOf({ 'botmancers-session-context': `bmsc_${'A'.repeat(43)}` }, 'neg-0005')).reason === 'unknown', 'a well-formed but unminted context: unknown');
  shares.endContext('launch-2');
  assert((await reasonOf({ 'botmancers-session-context': ctx2 }, 'neg-0006')).reason === 'stale', 'the bound turn ended: stale (the session may have moved on)');
  const ctx3 = shares.mintContext({ agentId: dev.id, sessionRef: s2, launchRef: 'launch-3', ttlMs: 1000 });
  clock += 1000;
  assert((await reasonOf({ 'botmancers-session-context': ctx3 }, 'neg-0007')).reason === 'stale', 'an expired context: stale');
  const ctx4 = shares.mintContext({ agentId: dev.id, sessionRef: s2, launchRef: 'launch-4' });
  shares.endContext('launch-4', 'revoked');
  assert((await reasonOf({ 'botmancers-session-context': ctx4 }, 'neg-0008')).reason === 'revoked', 'an owner-revoked context: revoked');
  const ctx5 = shares.mintContext({ agentId: dev.id, sessionRef: s2, launchRef: 'launch-5' });
  const mismatch = await reasonOf({ 'botmancers-session-context': ctx5 }, 'neg-0009', { agent_id: otherAgent.id });
  assert(mismatch.code === 'session_not_found', 'a context whose session belongs to another Agent than the caller expects: session_not_found');
  const ctxOther = shares.mintContext({ agentId: otherAgent.id, sessionRef: otherRef, launchRef: 'launch-6' });
  assert((await reasonOf({ 'botmancers-session-context': ctxOther }, 'neg-0010')).reason === 'revoked',
    'a context of an Agent whose owner has not enabled share-from-turn (or turned it off): revoked');
  const viaService = await shares.createShare({ principal: grok, headers: { 'botmancers-session-context': ctx }, body: { audience, idempotency_key: 'neg-0013' } });
  assert(viaService.body.error.code === 'invalid_request', 'a granted service cannot use share-current: the context, not a service token, is its credential');
  fake.mutateFakeProvider(STATE, state => { state.sessions['gone-1-SECRET'].deleted = true; });
  await ps.refreshProviderSession(db, dev.id, gone);
  const ctxGone = shares.mintContext({ agentId: dev.id, sessionRef: gone, launchRef: 'launch-7' });
  const ended = await reasonOf({ 'botmancers-session-context': ctxGone }, 'neg-0011');
  assert(['session_ended', 'session_missing', 'session_not_resumable'].includes(ended.code), `a session that can no longer take an Ask: NOT-507's code (${ended.code}), no share`);
  for (const field of model.HEURISTIC_FIELDS) {
    const refused = await shares.createShare({ principal: grok, sessionRef: s1, body: { audience, idempotency_key: `heur-${field}`, [field]: 'x' } });
    if (!(refused.status === 403 && refused.body.error.code === 'authority_not_allowed')) assert(false, `heuristic field ${field} refused`);
  }
  assert(true, `every heuristic selector (${model.HEURISTIC_FIELDS.length}: provider ids, cwd, latest, title, activity) is authority_not_allowed`);
  const both = await shares.createShare({ principal: contextPrincipal, sessionRef: s1, headers: { 'botmancers-session-context': ctx }, body: { audience, idempotency_key: 'neg-0012' } });
  assert(both.body.error.code === 'invalid_request', 'share-current never also takes a session_ref');

  console.log('\nExplicit share lifecycle: create, idempotency, TTL, list, get, revoke');
  const created = await shares.createShare({ principal: grok, sessionRef: s1, body: { audience, ttl_seconds: 3600, idempotency_key: 'share-a-01' } });
  const replay = await shares.createShare({ principal: grok, sessionRef: s1, body: { audience, ttl_seconds: 3600, idempotency_key: 'share-a-01' } });
  const conflict = await shares.createShare({ principal: grok, sessionRef: s2, body: { audience, ttl_seconds: 3600, idempotency_key: 'share-a-01' } });
  assert(created.status === 201 && replay.status === 200 && replay.body.replayed && replay.body.share.share_ref === created.body.share.share_ref && conflict.body.error.code === 'idempotency_conflict',
    'create 201; the exact replay 200 with the same share; the same key for another session idempotency_conflict');
  const ttlBad = await shares.createShare({ principal: grok, sessionRef: s1, body: { audience, ttl_seconds: 86401, idempotency_key: 'share-ttl-1' } });
  const channelBad = await shares.createShare({ principal: grok, sessionRef: s1, body: { audience: { ...audience, channel_id: 'C0OTHER01' }, idempotency_key: 'share-chan-1' } });
  assert(ttlBad.body.error.code === 'invalid_request' && channelBad.body.error.code === 'audience_not_allowed', 'TTL beyond 24 h is invalid; a channel off the owner allowlist is audience_not_allowed');
  const expiring = await shares.createShare({ principal: grok, sessionRef: s2, body: { audience, ttl_seconds: 300, idempotency_key: 'share-b-01' } });
  const revoking = await shares.createShare({ principal: grok, sessionRef: s2, body: { audience, ttl_seconds: 3600, idempotency_key: 'share-c-01' } });
  const listed = shares.listShares(grok, { sessionRef: s1 });
  const ownerListed = shares.listShares(owner, { sessionRef: s1 });
  assert(listed.body.items.length === 1 && ownerListed.body.items.length === 2 && ownerListed.body.items.every(s => s.session_ref === s1),
    'list filters by session_ref; a service sees its own shares, the owner sees every share (here also the current-session one)');
  assert(shares.getShare(relayPrincipal, created.body.share.share_ref).status === 404, 'another principal cannot read the share (share_not_found)');

  console.log('\nSlack relay: normalization, dedup, exact routing, reply correlation');
  const posts = [];
  let anchorIndex = 0;
  const transport = { post: async message => {
    const ts = message.thread_ts === null ? fixtures.anchors[anchorIndex++] : `1761300009.${String(posts.length).padStart(6, '0')}`;
    posts.push({ ...message, ts });
    return { ts };
  } };
  const relay = model.createSlackRelay({ model: shares, audiences, botUserId: fixtures.bot_user_id, transport });
  for (const s of [created, expiring, revoking]) await relay.announce(s.body.share);
  assert(posts.length === 3 && posts.every((p, i) => p.ts === fixtures.anchors[i] && p.metadata.event_payload.share_ref), 'each share is announced once; its anchor thread is its routing key');
  const env = name => fixtures.envelopes[name];
  const step = async (name, expect) => {
    const before = { dispatch: relaySends(), audit: audits(), s1: sendsTo('share-1-SECRET'), s2: sendsTo('share-2-SECRET') };
    const out = await relay.handleEnvelope(env(name));
    const delta = { dispatch: relaySends() - before.dispatch, audit: audits() - before.audit, s1: sendsTo('share-1-SECRET') - before.s1, s2: sendsTo('share-2-SECRET') - before.s2 };
    const ok = out.ack.envelope_id === env(name).envelope_id && out.outcome === expect.outcome && (expect.reason ? out.reason === expect.reason : true)
      && (expect.code ? out.code === expect.code : true) && delta.dispatch === expect.dispatch && delta.audit === expect.audit;
    assert(ok, `${name}: ${out.outcome}${out.reason ? `/${out.reason}` : ''}${out.code ? `/${out.code}` : ''}, acked, dispatch +${delta.dispatch}, audit +${delta.audit}`);
    return { out, delta };
  };
  const first = await step('first_delivery', { outcome: 'dispatched', dispatch: 1, audit: 1 });
  assert(first.delta.s1 === 1 && first.delta.s2 === 0 && lastAudit().operation === 'shares.ask' && lastAudit().target_ref === s1 && lastAudit().outcome === 'allowed',
    'first delivery reached exactly the share\'s session_ref and was audited as shares.ask on it');
  await first.out.replied;
  const reply = posts.at(-1);
  assert(reply.thread_ts === fixtures.anchors[0] && reply.channel === 'C0SHARE01' && reply.metadata.event_type === 'botmancers_share_reply'
    && reply.metadata.event_payload.share_ref === created.body.share.share_ref && reply.metadata.event_payload.turn_ref === first.out.turn_ref,
    'the final answer is posted in the asking thread, correlated by (share_ref, turn_ref)');
  assert(/fake reply/.test(reply.text) && !SECRET.test(reply.text) && !reply.text.includes('/work/share') && reply.text.length <= model.REPLY_MAX,
    `the reply is bounded and redacted: no provider session id, no working directory`);
  await step('retry_same_event', { outcome: 'duplicate_event', dispatch: 0, audit: 0 });
  await step('double_delivery_app_mention', { outcome: 'duplicate_question', dispatch: 0, audit: 0 });
  await step('own_bot_reply', { outcome: 'dropped', reason: 'not_a_person', dispatch: 0, audit: 0 });
  await step('unauthorized_channel', { outcome: 'dropped', reason: 'audience_not_allowed', dispatch: 0, audit: 0 });
  await step('unknown_thread', { outcome: 'dropped', reason: 'share_thread_unknown', dispatch: 0, audit: 0 });
  const held = await step('held_question', { outcome: 'dispatched', dispatch: 1, audit: 1 });
  const postsBefore = posts.length;
  await step('concurrent_question', { outcome: 'refused', code: 'share_turn_in_progress', dispatch: 0, audit: 1 });
  assert(lastAudit().outcome === 'denied' && lastAudit().code === 'share_turn_in_progress' && posts.length === postsBefore + 1 && posts.at(-1).metadata.event_type === 'botmancers_share_notice',
    'concurrent turn: denied and audited, a fixed notice in the thread, nothing sent to the session');
  fake.mutateFakeProvider(STATE, state => { for (const turn of Object.values(state.turns)) if (turn.state === 'running') turn.prompt = turn.prompt.replace('[hold] ', ''); });
  await held.out.replied;
  assert(posts.at(-1).metadata.event_payload.turn_ref === held.out.turn_ref && posts.at(-1).thread_ts === fixtures.anchors[0], 'the held turn\'s answer is correlated to its own question once it settles');
  await (await step('after_settle_question', { outcome: 'dispatched', dispatch: 1, audit: 1 })).out.replied;
  clock += 301 * 1000;
  await step('expired_share', { outcome: 'refused', code: 'share_expired', dispatch: 0, audit: 1 });
  assert(lastAudit().code === 'share_expired' && lastAudit().target_ref === s2 && posts.at(-1).text === 'This shared session is no longer available (the share expired).',
    'expired share: denied and audited on its session, notice reveals nothing about the session');
  const revoked = shares.revokeShare(owner, revoking.body.share.share_ref);
  const revokedAgain = shares.revokeShare(owner, revoking.body.share.share_ref);
  assert(revoked.body.share.state === 'revoked' && revokedAgain.body.share.revoked_at === revoked.body.share.revoked_at, 'the owner revokes; revoking again changes nothing');
  await step('revoked_share', { outcome: 'refused', code: 'share_revoked', dispatch: 0, audit: 1 });
  assert(shares.getShare(grok, expiring.body.share.share_ref).body.share.state === 'expired', 'get reports the expired share as expired');

  console.log('\nLedger loss: a fresh relay sees the first delivery again');
  const relay2 = model.createSlackRelay({ model: shares, audiences, botUserId: fixtures.bot_user_id, transport: { post: async () => ({ ts: fixtures.anchors[0] }) } });
  await relay2.announce(created.body.share);
  const lost = await (async () => {
    const before = { dispatch: relaySends(), audit: audits() };
    const out = await relay2.handleEnvelope(env('first_delivery'));
    return { out, dispatch: relaySends() - before.dispatch, audit: audits() - before.audit };
  })();
  assert(lost.out.outcome === 'replayed' && lost.out.turn_ref === first.out.turn_ref && lost.dispatch === 0 && lost.audit === 1 && lastAudit().code === 'replayed',
    'the question identity is the pin turn idempotency key: replayed to the same turn, nothing dispatched, one audit row');

  console.log('\nCanonical totals and privacy');
  const pinRows = db.prepare("SELECT * FROM session_pins WHERE requester_id = 'slack-relay'").all();
  assert(pinRows.length === 4 && pinRows.every(p => p.action === 'ask' && p.authority === 'read_only'), 'one read-only ask pin per share (current, A, B, C), never workspace-write');
  assert(sendsTo('share-1-SECRET') === 3 && sendsTo('share-2-SECRET') === 0, 'three questions reached share A\'s session; the expired and revoked shares\' session got none');
  const relayAudit = db.prepare("SELECT operation, outcome, code FROM service_audit_events WHERE principal = 'service:slack-relay' AND operation = 'shares.ask' ORDER BY id").all();
  const summary = relayAudit.map(r => `${r.outcome}${r.code ? `:${r.code}` : ''}`).join(',');
  assert(summary === 'allowed,allowed,denied:share_turn_in_progress,allowed,denied:share_expired,denied:share_revoked,allowed:replayed', `relay audit trail: ${summary}`);
  const publicSurface = JSON.stringify([posts, relay.log.map(({ replied, ...rest }) => rest), shares.listShares(owner).body, db.prepare("SELECT * FROM service_audit_events WHERE principal = 'service:slack-relay'").all()]);
  assert(!SECRET.test(publicSurface) && !publicSurface.includes('/work/share') && !/xox[abp]-|xapp-/.test(publicSurface), 'no provider id, working directory, or credential in replies, relay log, share views, or audit');
  const outcomes = sketch.errors.map(e => e.code);
  assert(Object.keys(model.SHARE_ERROR_STATUS).every(code => outcomes.includes(code) && sketch.errors.find(e => e.code === code).status === model.SHARE_ERROR_STATUS[code]),
    'every code the model returns is in the frozen sketch with the same status');
  assert(JSON.stringify(sketch.context.reasons) === JSON.stringify(model.CONTEXT_REASONS), 'session_context_required reasons match the sketch');

  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures})`}`);
  if (failures === 0) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
