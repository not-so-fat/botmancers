#!/usr/bin/env node
// NOT-516: the Slack relay core (lib/slack-relay.ts; docs/slack-relay.md;
// design §4 and §5). Proves against NOT-515's real SessionShare store and
// askShare, an isolated SQLite file, the deterministic fake session provider,
// and a deterministic fake SlackTransport:
//   - the four-method SlackTransport boundary; no Slack SDK, Bolt, or Pantalk
//     in the relay source, and (NOT-518) no Slack package in the dependency
//     tree but @slack/socket-mode and @slack/web-api;
//   - one anchor thread per share (idempotent binding), routing only by the
//     exact (team, channel, thread), several shares in one channel, unknown
//     threads, channels off the owner allowlist, and adversarial selector
//     text, without provider dispatch;
//   - a replay of every NOT-514 fixture envelope with the §4 dispatch and
//     audit matrix, plus bot/self, edit, subtype, top-level, DM, and non
//     events_api drops (no service call, no service audit);
//   - separate delivery, event, and question identities with canonical row
//     counts: first delivery, retry, duplicate delivery, duplicate event,
//     duplicate question; the ledger row is durable before the ack; crash
//     before and after the ack, crash after dispatch, a real second process
//     restart, and ledger loss, each dispatched at most once with the same
//     pin-turn idempotency key;
//   - expired, revoked, exhausted, concurrent, and failing shares post fixed
//     notices that disclose nothing; the share principal cannot pin;
//   - replies in the asking thread with botmancers_share_reply metadata
//     holding only share_ref and turn_ref, redacted, Slack-escaped, and
//     bounded to 3000 characters (normal, path, oversized, Unicode, error,
//     replayed).
// Self-contained: no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = require('./support/repo-root');
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT516_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-slack-relay-${TAG}`);
const STATE = path.join(TMP, 'provider.json');
const SHARES_PATH = path.join(TMP, 'session-shares.json');
const IDS_PATH = path.join(TMP, 'ids.json');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
const digest = token => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest('grok-token-NOT516')}`;
process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '100000';
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const shares = jiti('../lib/session-shares.ts');
const relayLib = jiti('../lib/slack-relay.ts');
const { serviceOperations } = jiti('../lib/service-api-http.ts');
const fake = require('./support/fake-session-provider');
const { createFakeSlackTransport } = require('./support/fake-slack-transport');

const db = dbModule.default;
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/slack-relay-v0.fixtures.json'), 'utf8'));
const BOT = fixtures.bot_user_id;
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
const audience = { kind: 'slack', team_id: 'T0SHARE01', channel_id: 'C0SHARE01' };
const sends = () => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').length;
const sendsTo = id => Object.values(fake.loadFakeState(STATE).turns).filter(turn => turn.session === id).length;
const audits = () => count('SELECT COUNT(*) AS n FROM service_audit_events');
const lastAudit = () => db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT 1').get();
const rows = () => ({
  deliveries: count('SELECT COUNT(*) AS n FROM slack_deliveries'),
  questions: count('SELECT COUNT(*) AS n FROM slack_questions'),
  threads: count('SELECT COUNT(*) AS n FROM slack_share_threads'),
});
const question = key => db.prepare('SELECT * FROM slack_questions WHERE message_key = ?').get(key);
const env = name => JSON.parse(JSON.stringify(fixtures.envelopes[name]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const releaseHolds = () => fake.mutateFakeProvider(STATE, state => {
  for (const turn of Object.values(state.turns)) if (turn.state === 'running') turn.prompt = turn.prompt.replace('[hold] ', '');
});

// A message envelope in the fixture's shape.
let serial = 100;
function envelope({ text = 'A question?', ts, thread_ts, channel = 'C0SHARE01', user = 'U0ALICE01', type = 'message', extra = {}, envelope_id, retry_attempt = 0, event_id }) {
  serial += 1;
  const event = { type, channel, user, text, ts: ts || `1761300100.${String(serial).padStart(6, '0')}`, ...extra };
  if (thread_ts !== undefined) event.thread_ts = thread_ts;
  if (user === null) delete event.user;
  return {
    envelope_id: envelope_id || `env-x${serial}`, type: 'events_api', accepts_response_payload: false, retry_attempt, retry_reason: retry_attempt ? 'timeout' : '',
    payload: { team_id: 'T0SHARE01', api_app_id: 'A0RELAY01', event_id: event_id || `EvX${serial}`, event_time: 1761300100, type: 'event_callback', event },
  };
}

function registerFake(connectionId) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, 0o600);
}

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

// A real second Botmancers process on the same database and provider state:
// a crash after the ack left one question pending.
async function restart() {
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  registerFake(ids.connectionId);
  const fakeSlack = createFakeSlackTransport({ tsBase: 5000 });
  const relay = relayLib.createSlackRelay({ transport: fakeSlack.transport, botUserId: BOT });
  const before = { sends: sends(), audits: audits() };
  const recovered = await relay.start();
  await relay.idle();
  const q = question(ids.messageKey);
  const turn = db.prepare('SELECT idempotency_key FROM session_pin_turns WHERE id = ?').get(q.turn_ref);
  process.stdout.write(`RESULT ${JSON.stringify({
    recovered, started: fakeSlack.started, posts: fakeSlack.state.posts, state: q.state, turn_ref: q.turn_ref, key: turn && turn.idempotency_key,
    sends: sends() - before.sends, audits: audits() - before.audits, audit: lastAudit(),
  })}\n`);
  await relay.stop();
  process.exit(0);
}

async function main() {
  console.log('\nBoundary: the four-method SlackTransport; no Slack SDK');
  {
    const source = fs.readFileSync(path.join(ROOT, 'lib/slack-relay.ts'), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(m => m[1]).sort();
    assert(same(imports, ['./db', './service-redaction', './session-shares', 'crypto']), `lib/slack-relay.ts imports only db, service-redaction, session-shares, crypto (${imports.join(', ')})`);
    assert(!/@slack\/|bolt|pantalk|socket-mode|web-api|xox[abp]-|xapp-|SLACK_(APP|BOT)_TOKEN/i.test(source.replace(/^\/\/.*$/gm, '')), 'no Slack SDK, Bolt, Pantalk, or credential in the relay code');
    assert(!/sendPinTurn|createPin|session-pins/.test(source), 'the relay never reaches NOT-507 pins directly: askShare is its only dispatch');
    const iface = source.match(/export interface SlackTransport \{([\s\S]*?)\n\}/)[1];
    const methods = [...iface.matchAll(/^\s+(\w+)\(/gm)].map(m => m[1]);
    assert(same(methods, ['start', 'ack', 'post', 'stop']), `SlackTransport has exactly four methods: ${methods.join(', ')}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
    const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
    // NOT-518 adds the native transport's two packages (lib/slack-transport.ts,
    // test-slack-transport.js); the relay itself still imports neither.
    const slack = deps.filter(d => /^@slack\//.test(d) || /bolt|pantalk/i.test(d)).sort();
    assert(same(slack, ['@slack/socket-mode', '@slack/web-api']) && !/"node_modules\/@slack\/(bolt|oauth)"|pantalk/i.test(lock),
      'the only Slack dependencies are @slack/socket-mode and @slack/web-api (no Bolt, OAuth, or Pantalk in package.json or package-lock.json)');
    const routing = [...source.matchAll(/FROM slack_share_threads WHERE ([^'`]+)/g)].map(m => m[1].trim());
    assert(same(routing.sort(), ['share_ref = ?', 'team_id = ? AND channel_id = ? AND thread_ts = ?']),
      'threads are looked up only by share_ref (binding) or the exact (team, channel, thread) (routing)');
  }

  console.log('\nSetup: one Agent with four exact sessions, grok-bot with shares:create, the fixture allowlist');
  const connectionId = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
  registerFake(connectionId);
  fake.seedFakeProvider(STATE, [
    { id: 'share-1-SECRET', title: 'Fix the uploader retry', workspace: '/work/share' },
    { id: 'share-2-SECRET', title: 'Write release notes', workspace: '/work/share' },
    { id: 'share-3-SECRET', title: 'Third', workspace: '/work/share' },
    { id: 'share-4-SECRET', title: 'Fourth', workspace: '/work/share' },
  ]);
  const dev = dbModule.bots.create({
    name: 'Dev', title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run('/work/share', dev.id);
  { let cursor = null; do cursor = (await ps.syncAgentSessions(db, dev.id, { cursor })).next_cursor; while (cursor); }
  const refOf = id => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(dev.id, id).id;
  const [s1, s2, s3, s4] = ['share-1-SECRET', 'share-2-SECRET', 'share-3-SECRET', 'share-4-SECRET'].map(refOf);
  writeJson(SHARES_PATH, { version: 1, audiences: fixtures.audiences.map(({ kind, team_id, channel_id }) => ({ kind, team_id, channel_id })) });
  const create = async (ref, key, extra = {}) => {
    const res = await serviceOperations.createShare(grok, ref, () => ({ audience, idempotency_key: key, ...extra }), null);
    if (res.status !== 201) throw new Error(`createShare ${key}: ${JSON.stringify(res.body)}`);
    return res.body.share;
  };
  // Fixture order: anchors[0] = A, [1] = B (expires), [2] = C (revoked); D is
  // a fourth share in the same channel.
  const shareA = await create(s1, 'relay-a');
  const shareB = await create(s2, 'relay-b', { ttl_seconds: 300 });
  const shareC = await create(s2, 'relay-c');
  const shareD = await create(s3, 'relay-d');
  const ANCHOR_D = '1761300000.000400';

  console.log('\nBinding: one anchor thread per share');
  const slack = createFakeSlackTransport({ anchors: [...fixtures.anchors, ANCHOR_D] });
  const relay = relayLib.createSlackRelay({ transport: slack.transport, botUserId: BOT });
  {
    const before = { sends: sends(), audits: audits() };
    const bound = [];
    for (const s of [shareA, shareB, shareC, shareD]) bound.push(await relay.bindShare(s.share_ref));
    assert(bound.every(b => b.created) && same(bound.map(b => b.thread.thread_ts), [...fixtures.anchors, ANCHOR_D]) && rows().threads === 4,
      'four shares bound: one anchor post and one slack_share_threads row each');
    assert(bound.every((b, i) => b.thread.session_ref === [s1, s2, s2, s3][i] && b.thread.channel_id === 'C0SHARE01' && b.thread.team_id === 'T0SHARE01'),
      'each thread row names its share\'s exact session_ref; four shares share one channel');
    assert(slack.state.posts.every(p => p.thread_ts === null && p.text === relayLib.ANCHOR_TEXT && p.metadata.event_type === 'botmancers_share'
      && same(Object.keys(p.metadata.event_payload), ['share_ref'])), 'anchors carry fixed text and only { share_ref } metadata');
    const again = await relay.bindShare(shareA.share_ref);
    const parallel = await Promise.all([relay.bindShare(shareA.share_ref), relay.bindShare(shareA.share_ref)]);
    assert(!again.created && again.thread.thread_ts === fixtures.anchors[0] && parallel.every(p => !p.created) && slack.state.posts.length === 4, 'binding again posts nothing (idempotent)');
    const refusals = [];
    for (const ref of ['shr_nope', (await create(s4, 'relay-gone')).share_ref]) {
      if (ref !== 'shr_nope') await serviceOperations.revokeShare(grok, ref, () => '');
      try { await relay.bindShare(ref); refusals.push('bound'); } catch (error) { refusals.push(error.code); }
    }
    assert(same(refusals, ['share_not_found', 'share_revoked']) && slack.state.posts.length === 4 && rows().threads === 4, 'an unknown or revoked share is not bound');
    assert(sends() === before.sends && audits() === before.audits + 2, 'binding dispatches nothing and writes no service audit (the +2 is grok-bot\'s create and revoke)');
    const relayPin = await serviceOperations.pinSession(shares.SHARE_PRINCIPAL, s1, () => ({ action: 'ask', idempotency_key: 'relay-direct-1' }), null);
    const relaySend = await serviceOperations.sendToPin(shares.SHARE_PRINCIPAL, shares.shareRow(shareA.share_ref).pin_ref, () => ({ content: 'direct', idempotency_key: 'relay-direct-2' }), null);
    assert(relayPin.status === 404 && relayPin.body.error.code === 'session_not_found' && relaySend.body.error.code === 'pin_not_found',
      'the relay\'s share principal cannot use the ordinary session-pin endpoints');
  }

  console.log('\nFixture replay: the §4 dispatch and audit matrix');
  const step = async (label, e, expect) => {
    const before = { dispatch: sends(), audit: audits(), rows: rows(), acks: slack.state.acks.length, posts: slack.state.posts.length, events: count('SELECT COUNT(*) AS n FROM session_share_events'),
      s: [s1, s2, s3, s4].map((_, i) => sendsTo(`share-${i + 1}-SECRET`)) };
    const out = await relay.handleEnvelope(e);
    const after = rows();
    const delta = {
      dispatch: sends() - before.dispatch, audit: audits() - before.audit, deliveries: after.deliveries - before.rows.deliveries, questions: after.questions - before.rows.questions,
      posts: slack.state.posts.length - before.posts, shareEvents: count('SELECT COUNT(*) AS n FROM session_share_events') - before.events,
      s: [s1, s2, s3, s4].map((_, i) => sendsTo(`share-${i + 1}-SECRET`) - before.s[i]),
    };
    const acked = slack.state.acks.length === before.acks + 1 && slack.state.acks.at(-1) === e.envelope_id;
    const ok = out.outcome === expect.outcome && (expect.reason === undefined || out.reason === expect.reason) && (expect.code === undefined || out.code === expect.code)
      && delta.dispatch === expect.dispatch && delta.audit === expect.audit && delta.deliveries === (expect.deliveries ?? 1) && delta.questions === (expect.questions ?? 0) && acked
      && (expect.audit > 0 || delta.shareEvents === 0);
    assert(ok, `${label}: ${out.outcome}${out.reason ? `/${out.reason}` : ''}${out.code ? `/${out.code}` : ''}, acked, dispatch +${delta.dispatch}, audit +${delta.audit}, deliveries +${delta.deliveries}, questions +${delta.questions}`);
    return { out, delta };
  };
  const first = await step('first_delivery', env('first_delivery'), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
  const firstKey = relayLib.questionKey('T0SHARE01', 'C0SHARE01', '1761300000.000101');
  {
    assert(same(first.delta.s, [1, 0, 0, 0]) && lastAudit().operation === 'shares.ask' && lastAudit().outcome === 'allowed' && lastAudit().target_ref === s1,
      'the first delivery reached exactly share A\'s session_ref, audited shares.ask allowed on it');
    const delivery = db.prepare("SELECT * FROM slack_deliveries WHERE envelope_id = 'env-0001'").get();
    assert(delivery.retry_attempt === 0 && delivery.team_id === 'T0SHARE01' && delivery.event_id === 'Ev0000000001' && delivery.event_owner === 1
      && delivery.disposition === 'accepted' && delivery.message_key === firstKey && typeof delivery.acked_at === 'number' && delivery.share_ref === shareA.share_ref,
      'delivery row: (env-0001, 0), owns event (T0SHARE01, Ev0000000001), accepted, acked');
    const q = question(firstKey);
    const turn = db.prepare('SELECT idempotency_key, requester_id FROM session_pin_turns WHERE id = ?').get(first.out.turn_ref);
    assert(q.state === 'dispatched' && q.turn_ref === first.out.turn_ref && q.share_ref === shareA.share_ref && q.question === null && turn.idempotency_key === `turn:${firstKey}`
      && turn.requester_id === 'botmancers-session-share', 'question row (T0SHARE01, C0SHARE01, ts) dispatched; its hashed key is the pin-turn idempotency key; the text is not retained');
    const call = fake.loadFakeState(STATE).calls.filter(c => c.op === 'sendTurn').at(-1);
    const prompt = Object.values(fake.loadFakeState(STATE).turns).filter(t => t.session === 'share-1-SECRET').at(-1).prompt;
    assert(call.authority === 'read_only' && !prompt.includes(BOT) && prompt.startsWith('What did you change'), 'the turn runs read_only with the mention stripped');
    await first.out.replied;
    const reply = slack.state.posts.at(-1);
    assert(reply.channel === 'C0SHARE01' && reply.thread_ts === fixtures.anchors[0] && reply.metadata.event_type === 'botmancers_share_reply'
      && same(reply.metadata.event_payload, { share_ref: shareA.share_ref, turn_ref: first.out.turn_ref }), 'the answer is posted in the asking thread with { share_ref, turn_ref } metadata only');
    assert(/^fake reply #\d+: What did you change, and is \[redacted( runtime id)?\] under \[redacted\] done\?$/.test(reply.text) && !SECRET.test(reply.text) && !reply.text.includes('/work/share'),
      `the answer is redacted: ${reply.text}`);
    assert(question(firstKey).state === 'replied' && question(firstKey).reply_ts === reply.ts, 'the question is marked replied with its reply ts');
  }
  await step('retry_same_event', env('retry_same_event'), { outcome: 'duplicate_event', dispatch: 0, audit: 0 });
  assert(db.prepare("SELECT event_owner, disposition FROM slack_deliveries WHERE envelope_id = 'env-0002'").get().event_owner === null, 'the retry is its own delivery row, not an event owner');
  await step('double_delivery_app_mention', env('double_delivery_app_mention'), { outcome: 'duplicate_question', dispatch: 0, audit: 0 });
  await step('own_bot_reply', env('own_bot_reply'), { outcome: 'dropped', reason: 'not_a_person', dispatch: 0, audit: 0 });
  await step('unauthorized_channel', env('unauthorized_channel'), { outcome: 'dropped', reason: 'audience_not_allowed', dispatch: 0, audit: 0 });
  await step('unknown_thread', env('unknown_thread'), { outcome: 'dropped', reason: 'share_thread_unknown', dispatch: 0, audit: 0 });
  const held = await step('held_question', env('held_question'), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
  {
    const concurrent = await step('concurrent_question', env('concurrent_question'), { outcome: 'refused', code: 'share_turn_in_progress', dispatch: 0, audit: 1, questions: 1 });
    const notice = slack.state.posts.at(-1);
    assert(lastAudit().outcome === 'denied' && lastAudit().code === 'share_turn_in_progress' && concurrent.delta.posts === 1 && notice.thread_ts === fixtures.anchors[0]
      && notice.text === relayLib.NOTICES.share_turn_in_progress && notice.metadata.event_type === 'botmancers_share_notice'
      && same(notice.metadata.event_payload, { share_ref: shareA.share_ref, code: 'share_turn_in_progress' }), 'concurrent turn: one denied audit, a fixed notice in the thread, nothing sent');
    releaseHolds();
    await held.out.replied;
    assert(slack.state.posts.at(-1).metadata.event_payload.turn_ref === held.out.turn_ref && slack.state.posts.at(-1).thread_ts === fixtures.anchors[0]
      && /Summarize the open risks/.test(slack.state.posts.at(-1).text), 'the held turn\'s answer is correlated to its own question once it settles');
  }
  const settle = await step('after_settle_question', env('after_settle_question'), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
  await settle.out.replied;
  shares.setSessionShareClock(() => Date.now() + 301 * 1000);
  {
    await step('expired_share', env('expired_share'), { outcome: 'refused', code: 'share_expired', dispatch: 0, audit: 1, questions: 1 });
    const notice = slack.state.posts.at(-1);
    assert(lastAudit().code === 'share_expired' && lastAudit().target_ref === s2 && notice.thread_ts === fixtures.anchors[1] && notice.text === 'This shared session is no longer available (the share expired).',
      'expired share: denied on its session; the notice in its own thread reveals nothing');
  }
  shares.setSessionShareClock(null);
  await serviceOperations.revokeShare(grok, shareC.share_ref, () => '');
  await step('revoked_share', env('revoked_share'), { outcome: 'refused', code: 'share_revoked', dispatch: 0, audit: 1, questions: 1 });
  assert(slack.state.posts.at(-1).thread_ts === fixtures.anchors[2] && slack.state.posts.at(-1).text === relayLib.NOTICES.share_revoked, 'revoked share: the fixed revoked notice in its thread');
  {
    const trail = db.prepare("SELECT outcome, code FROM service_audit_events WHERE operation = 'shares.ask' ORDER BY id").all().map(r => `${r.outcome}${r.code ? `:${r.code}` : ''}`).join(',');
    assert(trail === 'allowed,allowed,denied:share_turn_in_progress,allowed,denied:share_expired,denied:share_revoked', `fixture shares.ask audit trail matches §4: ${trail}`);
    assert(sendsTo('share-1-SECRET') === 3 && sendsTo('share-2-SECRET') === 0 && sendsTo('share-3-SECRET') === 0, 'three questions reached share A\'s session; B/C\'s session and D\'s got none');
  }

  console.log('\nDrops and routing: no service call, no service audit');
  {
    await step('duplicate delivery (same envelope_id and retry_attempt)', env('first_delivery'), { outcome: 'duplicate_delivery', dispatch: 0, audit: 0, deliveries: 0 });
    const drops = [
      ['an edit (message_changed)', envelope({ thread_ts: fixtures.anchors[0], extra: { subtype: 'message_changed' } }), 'message_subtype'],
      ['a deletion', envelope({ thread_ts: fixtures.anchors[0], extra: { subtype: 'message_deleted' } }), 'message_subtype'],
      ['a thread broadcast', envelope({ thread_ts: fixtures.anchors[0], extra: { subtype: 'thread_broadcast' } }), 'message_subtype'],
      ['a bot_message subtype', envelope({ thread_ts: fixtures.anchors[0], user: null, extra: { subtype: 'bot_message' } }), 'not_a_person'],
      ['another app\'s bot', envelope({ thread_ts: fixtures.anchors[0], user: 'U0OTHERBOT', extra: { bot_id: 'B0OTHER01' } }), 'not_a_person'],
      ['the relay\'s own user', envelope({ thread_ts: fixtures.anchors[0], user: BOT }), 'not_a_person'],
      ['a top-level message in the share channel', envelope({ text: `<@${BOT}> ask share A` }), 'not_in_thread'],
      ['the anchor message itself (thread_ts = ts)', envelope({ ts: fixtures.anchors[0], thread_ts: fixtures.anchors[0] }), 'not_in_thread'],
      ['a DM in an anchor-shaped thread', envelope({ channel: 'D0ALICE01', thread_ts: fixtures.anchors[0] }), 'audience_not_allowed'],
      ['an allowlisted team, other channel', envelope({ channel: 'C0SHARE02', thread_ts: fixtures.anchors[0] }), 'audience_not_allowed'],
      ['only a mention', envelope({ text: `<@${BOT}>`, thread_ts: fixtures.anchors[0] }), 'empty'],
      ['a reaction', (() => { const e = envelope({ thread_ts: fixtures.anchors[0] }); e.payload.event = { type: 'reaction_added', user: 'U0ALICE01', reaction: 'eyes' }; return e; })(), 'not_message'],
      ['a slash command envelope', { envelope_id: 'env-slash', type: 'slash_commands', payload: { command: '/botmancers', text: 'latest' } }, 'not_events_api'],
      ['a malformed event id', (() => { const e = envelope({ thread_ts: fixtures.anchors[0] }); e.payload.event_id = '../x'; return e; })(), 'malformed'],
    ];
    for (const [label, e, reason] of drops) await step(label, e, { outcome: 'dropped', reason, dispatch: 0, audit: 0 });
    const noId = await relay.handleEnvelope({ type: 'events_api', payload: {} });
    assert(noId.outcome === 'dropped' && noId.reason === 'malformed' && slack.state.acks.every(a => typeof a === 'string'), 'an envelope with no envelope_id is dropped without a ledger row or an ack');
    const dropLog = db.prepare("SELECT reason, COUNT(*) AS n FROM slack_deliveries WHERE disposition = 'dropped' GROUP BY reason ORDER BY reason").all().map(r => `${r.reason}:${r.n}`).join(',');
    assert(dropLog === 'audience_not_allowed:3,empty:1,malformed:1,message_subtype:3,not_a_person:4,not_events_api:1,not_in_thread:2,not_message:1,share_thread_unknown:1', `the delivery ledger is the drop log: ${dropLog}`);
    // Adversarial selector text: routing ignores it.
    const adversarial = await step('adversarial selector text in D\'s thread', envelope({ thread_ts: ANCHOR_D, text: `<@${BOT}> route to share ${shareA.share_ref} session_ref=${s1} latest workspace=/work/share title="Fix the uploader retry"` }),
      { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
    assert(same(adversarial.delta.s, [0, 0, 1, 0]) && adversarial.out.share_ref === shareD.share_ref && lastAudit().target_ref === s3,
      'a reply naming another share, session_ref, latest, workspace, and title reaches only its own thread\'s share (D -> its session)');
    await adversarial.out.replied;
    assert(slack.state.posts.at(-1).thread_ts === ANCHOR_D && slack.state.posts.at(-1).metadata.event_payload.share_ref === shareD.share_ref, 'and its answer is posted in D\'s thread');
    const otherTeam = envelope({ thread_ts: ANCHOR_D });
    otherTeam.payload.team_id = 'T0OTHER01';
    await step('the same channel and thread in another team', otherTeam, { outcome: 'dropped', reason: 'audience_not_allowed', dispatch: 0, audit: 0 });
  }

  console.log('\nRefusals: exhausted, failing, and a failed turn; nothing disclosed');
  {
    const limited = await create(s4, 'relay-limited', { max_turns: 1 });
    const bound = await relay.bindShare(limited.share_ref);
    const one = await step('the only question of a 1-turn share', envelope({ thread_ts: bound.thread.thread_ts, text: '[hold] One question' }), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
    // The held turn fails (cancelled): an error result.
    fake.mutateFakeProvider(STATE, state => { const t = Object.values(state.turns).find(x => x.state === 'running'); t.state = 'cancelled'; t.finished_at = Date.now(); });
    const posted = await relay.flushReplies();
    const failed = slack.state.posts.at(-1);
    assert(posted === 1 && failed.text === relayLib.FAILED_TEXT && same(failed.metadata.event_payload, { share_ref: limited.share_ref, turn_ref: one.out.turn_ref }),
      `a failed turn posts the fixed failure text with its correlation: "${failed.text}"`);
    await step('a question past the turn limit', envelope({ thread_ts: bound.thread.thread_ts, text: 'Two?' }), { outcome: 'refused', code: 'share_turn_limit', dispatch: 0, audit: 1, questions: 1 });
    assert(slack.state.posts.at(-1).text === relayLib.NOTICES.share_turn_limit && lastAudit().code === 'share_turn_limit', 'exhausted share: the fixed limit notice, one denied audit');
    fake.mutateFakeProvider(STATE, state => { state.failSends = 1; });
    const failing = await step('the runtime fails the send', envelope({ thread_ts: fixtures.anchors[0], text: 'Will this fail?' }), { outcome: 'refused', dispatch: 1, audit: 1, questions: 1 });
    const notice = slack.state.posts.at(-1);
    assert(lastAudit().outcome === 'denied' && notice.text === relayLib.noticeText(failing.out.code) && notice.metadata.event_payload.code === failing.out.code,
      `a runtime failure is refused (${failing.out.code}) with a fixed notice`);
    const notices = slack.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_notice');
    const texts = new Set([...Object.values(relayLib.NOTICES), relayLib.GENERIC_NOTICE]);
    assert(notices.length === 5 && notices.every(p => texts.has(p.text) && same(Object.keys(p.metadata.event_payload).sort(), ['code', 'share_ref'])),
      'every notice is one of the fixed texts with { share_ref, code } metadata');
  }

  console.log('\nReply formatting: redacted, escaped, bounded');
  {
    const f = relayLib.formatReply;
    assert(f('All done.') === 'All done.', 'normal: unchanged');
    assert(f(`cwd /work/share/src and ${HOME}/notes.txt`) === 'cwd [redacted]/src and [redacted]', `path-containing: ${f(`cwd /work/share/src and ${HOME}/notes.txt`)}`);
    assert(f('ping <!channel> and <@U0BOB0001> & co') === 'ping &lt;!channel&gt; and &lt;@U0BOB0001&gt; &amp; co', 'Slack control sequences are escaped: no mention or broadcast');
    const big = f('x'.repeat(5000));
    assert(big.length === 3000 && big.endsWith('…') && big === `${'x'.repeat(2999)}…`, 'oversized: capped at 3000 characters with an ellipsis');
    const emoji = f(`${'x'.repeat(2998)}${'😀'.repeat(10)}`);
    assert(emoji.length <= 3000 && emoji === `${'x'.repeat(2998)}…` && !/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/.test(emoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'Unicode: never splits a surrogate pair');
    const pairs = f(`${'x'.repeat(2996)}${'😀'.repeat(10)}`);
    assert(pairs === `${'x'.repeat(2996)}😀…` && pairs.length === 2999, 'Unicode: keeps a whole pair that fits');
    const amp = f(`${'x'.repeat(2997)}&&&`);
    assert(amp.length <= 3000 && !/&(a|am|amp)?…$/.test(amp) && amp === `${'x'.repeat(2997)}…`, 'escapes are never cut in half');
    assert(f('broken \uD83D tail') === 'broken  tail', 'a lone surrogate from upstream truncation is dropped');
    // End to end: a turn that completed with an empty answer. Slack refuses
    // an empty text, so posting it as is would fail on every flush.
    fake.mutateFakeProvider(STATE, state => { state.results = ['']; });
    const blank = await step('a turn that completed with an empty answer', envelope({ thread_ts: ANCHOR_D, text: 'Anything?' }), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
    const blankPosted = await blank.out.replied;
    const blankRow = db.prepare('SELECT state, reply_ts FROM slack_questions WHERE turn_ref = ?').get(blank.out.turn_ref);
    assert(blankPosted && slack.state.posts.at(-1).text === relayLib.FAILED_TEXT && blankRow.state === 'replied' && blankRow.reply_ts === blankPosted.ts
      && await relay.flushReplies() === 0, 'an empty answer posts the fixed failure text once and the question is replied, not retried');
    // End to end: an oversized Unicode answer through askShare.
    const uni = await step('an oversized Unicode answer', envelope({ thread_ts: ANCHOR_D, text: `${'日本'.repeat(1000)}${'😀'.repeat(900)}` }), { outcome: 'dispatched', dispatch: 1, audit: 1, questions: 1 });
    await uni.out.replied;
    const text = slack.state.posts.at(-1).text;
    assert(text.length <= 3000 && text.endsWith('…') && text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').search(/[\uD800-\uDFFF]/) === -1 && text.startsWith('fake reply #'),
      `end to end: the posted answer is ${text.length} well-formed characters`);
  }

  console.log('\nDurability: crash before and after the ack, crash after dispatch, restart, ledger loss');
  {
    // Crash before the ack: the row is durable, nothing dispatched, no ack.
    const crashing = createFakeSlackTransport({ crashBeforeAck: ['env-c1'], crashAfterAck: ['env-c2'], tsBase: 2000 });
    const doomed = relayLib.createSlackRelay({ transport: crashing.transport, botUserId: BOT });
    const c1 = envelope({ envelope_id: 'env-c1', thread_ts: ANCHOR_D, text: 'Crash before ack?' });
    const c1Key = relayLib.questionKey('T0SHARE01', 'C0SHARE01', c1.payload.event.ts);
    let before = { sends: sends(), audits: audits(), rows: rows() };
    let crashed = await doomed.handleEnvelope(c1).then(() => false, () => true);
    let after = rows();
    const c1Row = db.prepare("SELECT * FROM slack_deliveries WHERE envelope_id = 'env-c1'").get();
    assert(crashed && after.deliveries - before.rows.deliveries === 1 && after.questions - before.rows.questions === 1 && c1Row.acked_at === null && c1Row.event_owner === 1
      && question(c1Key).state === 'pending' && question(c1Key).question === 'Crash before ack?' && !crashing.state.acks.includes('env-c1') && sends() === before.sends && audits() === before.audits,
      'crash before the ack: delivery and question rows durable (pending), no ack, nothing dispatched or audited');
    // Restart (a new relay; the old process's share claims are gone).
    shares.simulateSessionShareRestart();
    const fresh = createFakeSlackTransport({ tsBase: 3000 });
    const relay2 = relayLib.createSlackRelay({ transport: fresh.transport, botUserId: BOT });
    before = { sends: sends(), audits: audits() };
    const recovered = await relay2.start();
    await relay2.idle();
    const c1Turn = db.prepare('SELECT idempotency_key FROM session_pin_turns WHERE id = ?').get(question(c1Key).turn_ref);
    assert(recovered.dispatched === 1 && fresh.started && sends() - before.sends === 1 && audits() - before.audits === 1 && lastAudit().outcome === 'allowed' && c1Turn.idempotency_key === `turn:${c1Key}`,
      'restart: start() re-dispatches the pending question once, with the same pin-turn idempotency key, before taking envelopes');
    assert(question(c1Key).state === 'replied' && fresh.state.posts.length === 1 && fresh.state.posts[0].thread_ts === ANCHOR_D
      && fresh.state.posts[0].metadata.event_payload.turn_ref === question(c1Key).turn_ref, 'restart: its answer is posted once in its thread');
    // Slack redelivers the unacked envelope (retry 1, a new envelope id).
    before = { sends: sends(), audits: audits(), rows: rows() };
    const redelivered = await relay2.handleEnvelope({ ...c1, envelope_id: 'env-c1r', retry_attempt: 1, retry_reason: 'timeout' });
    assert(redelivered.outcome === 'duplicate_event' && sends() === before.sends && audits() === before.audits && rows().deliveries - before.rows.deliveries === 1 && fresh.state.acks.includes('env-c1r'),
      'the redelivery after restart is a duplicate_event: acked, recorded, never dispatched');

    // Crash after the ack, then a real second process.
    const c2 = envelope({ envelope_id: 'env-c2', thread_ts: ANCHOR_D, text: 'Crash after ack?' });
    const c2Key = relayLib.questionKey('T0SHARE01', 'C0SHARE01', c2.payload.event.ts);
    before = { sends: sends(), audits: audits() };
    crashed = await doomed.handleEnvelope(c2).then(() => false, () => true);
    assert(crashed && crashing.state.acks.includes('env-c2') && question(c2Key).state === 'pending' && sends() === before.sends && audits() === before.audits,
      'crash after the ack (Slack will not redeliver): the question is pending, nothing dispatched');
    fs.writeFileSync(IDS_PATH, JSON.stringify({ connectionId, messageKey: c2Key }));
    const child = spawnSync(process.execPath, [__filename, 'restart'], { env: { ...process.env, NOT516_TAG: TAG }, encoding: 'utf8', timeout: 60000 });
    const line = (child.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
    const out = line ? JSON.parse(line.slice(7)) : null;
    if (!out) console.log(child.stdout, child.stderr);
    assert(out && out.recovered.dispatched === 1 && out.started && out.sends === 1 && out.audits === 1 && out.audit.operation === 'shares.ask' && out.audit.outcome === 'allowed'
      && out.key === `turn:${c2Key}`, 'second process: the pending question is dispatched once with the same pin-turn key and audited allowed');
    assert(out && out.state === 'replied' && out.posts.length === 1 && out.posts[0].thread_ts === ANCHOR_D && same(out.posts[0].metadata.event_payload, { share_ref: shareD.share_ref, turn_ref: out.turn_ref }),
      'second process: one answer posted in the asking thread, correlated');
    before = { sends: sends(), audits: audits() };
    const again = await relay2.recover();
    assert(again.dispatched === 0 && again.refused === 0 && again.replied === 0 && sends() === before.sends && audits() === before.audits, 'recovering again finds nothing to do');

    // Crash after dispatch, before the reply: the answer is posted on restart.
    const c3 = envelope({ envelope_id: 'env-c3', thread_ts: ANCHOR_D, text: '[hold] Crash after dispatch?' });
    const c3Key = relayLib.questionKey('T0SHARE01', 'C0SHARE01', c3.payload.event.ts);
    const c3Out = await relay2.handleEnvelope(c3);
    assert(c3Out.outcome === 'dispatched' && question(c3Key).state === 'dispatched', 'a held question is dispatched');
    shares.simulateSessionShareRestart();
    const fresh3 = createFakeSlackTransport({ tsBase: 4000 });
    const relay3 = relayLib.createSlackRelay({ transport: fresh3.transport, botUserId: BOT });
    before = { sends: sends(), audits: audits() };
    const stillRunning = await relay3.recover();
    assert(stillRunning.dispatched === 0 && stillRunning.replied === 0 && fresh3.state.posts.length === 0 && sends() === before.sends && audits() === before.audits,
      'restart while the turn runs: nothing re-sent, nothing posted yet');
    releaseHolds();
    const later = await relay3.flushReplies();
    assert(later === 1 && fresh3.state.posts.length === 1 && fresh3.state.posts[0].metadata.event_payload.turn_ref === c3Out.turn_ref && question(c3Key).state === 'replied',
      'once it finishes, the new process posts its answer exactly once');
    await c3Out.replied;
    assert(slack.state.posts.filter(p => p.metadata.event_payload.turn_ref === c3Out.turn_ref).length === 0 && fresh3.state.posts.length === 1,
      'the old process\'s pending reply does not post it a second time');

    // Ledger loss: every relay ledger row is gone; Slack sends the first delivery again.
    const firstReply = slack.state.posts.find(p => p.metadata.event_payload.turn_ref === first.out.turn_ref);
    db.exec('DELETE FROM slack_deliveries; DELETE FROM slack_questions; DELETE FROM slack_share_threads;');
    shares.simulateSessionShareRestart();
    const lostSlack = createFakeSlackTransport({ anchors: [fixtures.anchors[0]], tsBase: 6000 });
    const relay4 = relayLib.createSlackRelay({ transport: lostSlack.transport, botUserId: BOT });
    await relay4.bindShare(shareA.share_ref);
    before = { sends: sends(), audits: audits() };
    const lost = await relay4.handleEnvelope(env('first_delivery'));
    await lost.replied;
    assert(lost.outcome === 'replayed' && lost.turn_ref === first.out.turn_ref && sends() === before.sends && audits() - before.audits === 1 && lastAudit().code === 'replayed',
      'ledger loss: the first delivery replays the same turn, nothing dispatched, one allowed:replayed audit');
    const replayed = lostSlack.state.posts.at(-1);
    assert(replayed.text === firstReply.text && same(replayed.metadata.event_payload, firstReply.metadata.event_payload) && same(rows(), { deliveries: 1, questions: 1, threads: 1 }),
      'replayed result: the same redacted answer and correlation; canonical rows 1 delivery, 1 question, 1 thread');
  }

  console.log('\nCanonical totals and privacy');
  {
    const turnSent = count("SELECT COUNT(*) AS n FROM session_share_events WHERE type = 'turn_sent'");
    const pinTurns = count("SELECT COUNT(*) AS n FROM session_pin_turns WHERE requester_id = 'botmancers-session-share'");
    // The one send the runtime failed (the refusals section) is attempted but never becomes a turn.
    assert(turnSent === pinTurns && pinTurns === sends() - 1, `every successful provider send is one share turn: turn_sent (${turnSent}) = share pin turns (${pinTurns}) = provider sends (${sends()}) - 1 failed`);
    const surface = JSON.stringify([
      db.prepare('SELECT * FROM slack_deliveries').all(), db.prepare('SELECT * FROM slack_questions').all(), db.prepare('SELECT * FROM slack_share_threads').all(),
      slack.state.posts, db.prepare('SELECT * FROM service_audit_events').all(),
    ]);
    assert(!SECRET.test(surface) && !surface.includes('/work/share') && !surface.includes(HOME) && !/xox[abp]-|xapp-/.test(surface) && !surface.includes(dev.id.length > 3 ? `"agent":"${dev.id}"` : '\u0000'),
      'no provider id, working directory, home path, or credential in the ledgers, the posts, or the audit');
    const replies = slack.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_reply');
    assert(replies.every(p => same(Object.keys(p.metadata.event_payload).sort(), ['share_ref', 'turn_ref']) && /^shr_/.test(p.metadata.event_payload.share_ref) && p.text.length <= 3000),
      `all ${replies.length} replies carry only { share_ref, turn_ref } and at most 3000 characters`);
    await relay.stop();
    assert(slack.state.stops === 1, 'stop() stops the transport');
  }

  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures})`}`);
  if (failures === 0) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
