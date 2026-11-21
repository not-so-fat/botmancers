#!/usr/bin/env node
// NOT-518: the native Socket Mode transport and its server lifecycle
// (lib/slack-transport.ts, lib/slack-runtime.ts, instrumentation.ts;
// docs/slack-transport.md; design §5). Proves:
//   - dependencies: only @slack/socket-mode ^2.0.7 and @slack/web-api ^7
//     (MIT closure; no Bolt, OAuth, Express receiver, or Pantalk);
//   - the adapter over injected fake SocketModeClient/WebClient: exactly the
//     four frozen methods, envelope/retry/event/thread identity forwarded
//     unchanged, ack and post payloads, reply metadata, token-free errors,
//     the post bound, and a graceful stop that never reconnects;
//   - the real SocketModeClient and WebClient against a local fake Slack
//     (127.0.0.1) through the real relay and SessionShare: the ledger row
//     commits before the ack and the ack precedes the provider send; a
//     server "disconnect" and a dropped socket both reconnect; redelivered
//     envelopes are deduplicated (exactly one provider send per question);
//     explicit stop never reconnects;
//   - the managed-start matrix: absent, partial, invalid tokens; absent,
//     invalid, empty share config; auth failure; foreign workspace;
//     connected; reconnecting; shutdown and restart with a pending and a
//     dispatched-unanswered row finished exactly once by the next start;
//   - secrets: both tokens are redacted by CREDENTIAL_ENV, never reach the
//     bridge env, logs, errors, posts, /api/health, service responses,
//     process arguments, or any committed file.
// Self-contained: loopback only, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = __dirname;
const TMP = path.join(os.tmpdir(), `botmancers-slack-transport-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const STATE = path.join(TMP, 'provider.json');
const SHARES_PATH = path.join(TMP, 'session-shares.json');
// Sentinel tokens, assembled at run time so no token-shaped string is
// committed.
const APP_TOKEN = ['xapp', '1', 'A0NOT518', 'SENTINELAPP', 'f00dfeed'].join('-');
const BOT_TOKEN = ['xoxb', '518', 'SENTINELBOT', 'deadbeefcafe'].join('-');
const digest = token => `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
process.env.BOTMANCERS_DB_PATH = path.join(TMP, 'botmancers.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SESSION_SHARES_PATH = SHARES_PATH;
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=${digest('grok-token-NOT518')}`;
process.env.BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE = '100000';
process.env.BOTMANCERS_SLACK_APP_TOKEN = APP_TOKEN;
process.env.BOTMANCERS_SLACK_BOT_TOKEN = BOT_TOKEN;
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

// Everything printed while the suite runs, scanned for the tokens at the end.
const printed = [];
for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    printed.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    original(...args);
  };
}

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const contract = jiti('./lib/session-provider.ts');
const ps = jiti('./lib/provider-sessions.ts');
const shares = jiti('./lib/session-shares.ts');
const relayLib = jiti('./lib/slack-relay.ts');
const transportLib = jiti('./lib/slack-transport.ts');
const runtimeLib = jiti('./lib/slack-runtime.ts');
const { serviceRedactor } = jiti('./lib/service-redaction.ts');
const { serviceOperations } = jiti('./lib/service-api-http.ts');
const fake = require('./test-support/fake-session-provider');
const { createFakeSlackServer } = require('./test-support/fake-slack-server');

const db = dbModule.default;
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/slack-relay-v0.fixtures.json'), 'utf8'));
const BOT = fixtures.bot_user_id;
const TEAM = 'T0SHARE01';
const CHANNEL = 'C0SHARE01';
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(test, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const sends = () => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').length;
const question = key => db.prepare('SELECT * FROM slack_questions WHERE message_key = ?').get(key);
const errorText = error => `${error && error.message}\n${error && error.stack}\n${JSON.stringify(error)}\n${String(error)}`;
const leaks = text => String(text).includes(APP_TOKEN) || String(text).includes(BOT_TOKEN);
const writeJson = (file, value, mode = 0o600) => { fs.writeFileSync(file, JSON.stringify(value)); fs.chmodSync(file, mode); };

// Provider sends and Socket Mode acks in one order log.
const order = [];
function registerFake(connectionId) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => {
    const provider = fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true });
    const sendTurn = provider.sendTurn.bind(provider);
    provider.sendTurn = async input => {
      order.push({ op: 'dispatch', key: input.idempotency_key });
      return sendTurn(input);
    };
    return provider;
  });
}

let serial = 500;
function envelope({ text = 'What changed?', thread_ts, ts, envelope_id, event_id, retry_attempt = 0, retry_reason = '' }) {
  serial += 1;
  return {
    envelope_id: envelope_id || `env-t${serial}`, type: 'events_api', accepts_response_payload: false, retry_attempt, retry_reason,
    payload: {
      team_id: TEAM, api_app_id: 'A0RELAY01', event_id: event_id || `EvT${serial}`, event_time: 1761310100, type: 'event_callback',
      event: { type: 'message', channel: CHANNEL, user: 'U0ALICE01', text, ts: ts || `1761310100.${String(serial).padStart(6, '0')}`, thread_ts },
    },
  };
}

// A fake SocketModeClient: the EventEmitter surface the adapter uses.
function fakeSocket({ failStart = null, failSend = () => false } = {}) {
  const socket = new EventEmitter();
  socket.calls = { start: 0, disconnect: 0, send: [] };
  socket.start = async () => {
    socket.calls.start += 1;
    if (failStart) throw failStart;
    socket.emit('connected');
  };
  socket.disconnect = async () => { socket.calls.disconnect += 1; };
  socket.send = async (id, body) => {
    socket.calls.send.push(body === undefined ? [id] : [id, body]);
    if (failSend(id)) throw Object.assign(new Error(`send failed Bearer ${APP_TOKEN}`), { config: { headers: { Authorization: `Bearer ${APP_TOKEN}` } } });
  };
  // What the SDK emits for one Socket Mode frame.
  socket.frame = e => socket.emit('slack_event', {
    ack: async () => {}, envelope_id: e.envelope_id, type: e.type, body: e.payload, retry_num: e.retry_attempt, retry_reason: e.retry_reason, accepts_response_payload: e.accepts_response_payload,
  });
  return socket;
}
function fakeWeb({ postError = null } = {}) {
  const web = { calls: [], auth: { test: async () => ({ ok: true, user_id: BOT, team_id: TEAM }) } };
  let n = 0;
  web.chat = {
    postMessage: async args => {
      web.calls.push(args);
      if (postError) throw postError;
      n += 1;
      return { ok: true, ts: `1761320000.${String(n).padStart(6, '0')}` };
    },
  };
  return web;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

async function main() {
  console.log('\nDependencies: only @slack/socket-mode and @slack/web-api, MIT, no Bolt/OAuth/Express/Pantalk');
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const slackDeps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).filter(([name]) => /slack|bolt|pantalk/i.test(name));
    assert(same(slackDeps, [['@slack/socket-mode', '^2.0.7'], ['@slack/web-api', '^7']]), `package.json adds exactly @slack/socket-mode ^2.0.7 and @slack/web-api ^7 (${JSON.stringify(slackDeps)})`);
    assert(lock.packages['node_modules/@slack/socket-mode'].version === '2.0.7' && /^7\./.test(lock.packages['node_modules/@slack/web-api'].version), 'the lockfile pins socket-mode 2.0.7 and a web-api 7.x');
    // The production closure of the two packages, from the lockfile.
    const closure = new Map();
    const resolve = (name, from) => {
      for (let dir = from; ; dir = dir.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, '')) {
        const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
        if (lock.packages[key]) return key;
        if (!dir) return null;
      }
    };
    const walk = key => {
      if (closure.has(key)) return;
      const entry = lock.packages[key];
      closure.set(key, entry);
      for (const dep of Object.keys(entry.dependencies || {})) {
        const at = resolve(dep, key);
        if (at) walk(at);
      }
    };
    walk('node_modules/@slack/socket-mode');
    walk('node_modules/@slack/web-api');
    const names = [...closure.keys()].map(key => key.replace(/^.*node_modules\//, ''));
    const forbidden = names.filter(name => /^(@slack\/(bolt|oauth)|express|raw-body|path-to-regexp|pantalk)$/i.test(name));
    assert(forbidden.length === 0 && !Object.keys(lock.packages).some(key => /node_modules\/(@slack\/(bolt|oauth)|express|pantalk)$/i.test(key)),
      'no Bolt, @slack/oauth, Express receiver, or Pantalk anywhere in the lockfile');
    const notMit = [...closure.entries()].filter(([, entry]) => entry.license !== 'MIT' && !/^node_modules\/@types\/node$/.test(entry.license));
    // @types/node is MIT as well; every license is recorded in the lockfile.
    assert(notMit.length === 0, `the ${closure.size}-package production closure is MIT-licensed (${notMit.map(([k, e]) => `${k}:${e.license}`).join(', ') || 'all MIT'})`);
    const source = ['lib/slack-transport.ts', 'lib/slack-runtime.ts', 'instrumentation.ts'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const imports = [...source.matchAll(/from '([^'.][^']*)'/g)].map(m => m[1]);
    assert(imports.every(m => ['@slack/socket-mode', '@slack/web-api'].includes(m)) && !/child_process|spawn\(|express|bolt|pantalk/i.test(source.replace(/^\s*\/\/.*$/gm, '')),
      `the transport and runtime import only the two Slack packages from npm and start no process (${[...new Set(imports)].join(', ')})`);
  }

  console.log('\nAdapter: the four frozen methods over injected SocketModeClient/WebClient');
  {
    const socket = fakeSocket();
    const web = fakeWeb();
    const transport = transportLib.createSlackTransport({ socket, web }, { stopGraceMs: 2000 });
    assert(same(Object.keys(transport).sort(), ['ack', 'post', 'start', 'stop']), `the transport has exactly start, ack, post, stop (${Object.keys(transport).join(', ')})`);
    const received = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await transport.start(async e => {
      received.push(e);
      if (e.envelope_id === 'env-hold') await held;
    });
    assert(socket.calls.start === 1 && socket.listenerCount('slack_event') === 1, 'start() starts the SocketModeClient once and listens to slack_event');
    const original = envelope({ thread_ts: '1761300000.000100', retry_attempt: 2, retry_reason: 'timeout', envelope_id: 'env-ident-1', event_id: 'EvIdent01' });
    socket.frame(original);
    await sleep(10);
    const got = received[0];
    assert(got && got.envelope_id === 'env-ident-1' && got.type === 'events_api' && got.retry_attempt === 2 && got.retry_reason === 'timeout' && got.accepts_response_payload === false,
      'envelope_id, type, retry_attempt (from retry_num), retry_reason, accepts_response_payload forwarded unchanged');
    assert(got && got.payload === original.payload && same(got.payload, original.payload),
      'the payload (team_id, event_id, channel, thread_ts, user, ts) is the very object Slack sent: no key transformed');
    socket.emit('slack_event', { envelope_id: 'env-slash', type: 'slash_commands', body: {} });
    socket.emit('slack_event', { envelope_id: 'env-hello', type: 'interactive', body: {} });
    await sleep(10);
    assert(received.length === 1 && socket.calls.send.length === 0, 'non-events_api envelopes are neither handed to the relay nor acknowledged');
    await transport.ack('env-ident-1');
    assert(same(socket.calls.send, [['env-ident-1']]), 'ack(envelope_id) sends exactly one Socket Mode ack with that envelope_id and an empty payload');
    const reply = await transport.post({ channel: CHANNEL, thread_ts: '1761300000.000100', text: 'answer &amp; more', metadata: { event_type: 'botmancers_share_reply', event_payload: { share_ref: 'shr_x', turn_ref: 'turn_y' } } });
    assert(reply.ts === '1761320000.000001' && same(web.calls[0], {
      channel: CHANNEL, thread_ts: '1761300000.000100', text: 'answer &amp; more',
      metadata: { event_type: 'botmancers_share_reply', event_payload: { share_ref: 'shr_x', turn_ref: 'turn_y' } }, unfurl_links: false, unfurl_media: false,
    }), 'post() is one chat.postMessage in the thread with the relay\'s metadata unchanged, unfurls off, and returns its ts');
    await transport.post({ channel: CHANNEL, thread_ts: null, text: relayLib.ANCHOR_TEXT, metadata: { event_type: 'botmancers_share', event_payload: { share_ref: 'shr_x' } } });
    assert(!('thread_ts' in web.calls[1]) && web.calls[1].metadata.event_type === 'botmancers_share', 'a top-level post (the anchor) carries no thread_ts');
    let tooLong = null;
    try { await transport.post({ channel: CHANNEL, thread_ts: '1761300000.000100', text: 'x'.repeat(3001), metadata: { event_type: 'botmancers_share_reply', event_payload: {} } }); } catch (error) { tooLong = error; }
    assert(tooLong && tooLong.code === 'slack_post_too_long' && web.calls.length === 2, 'a post over 3000 characters is refused before any Web API call');
    let started = null;
    try { await transport.start(async () => {}); } catch (error) { started = error; }
    assert(started && started.code === 'slack_transport_started', 'start() twice is refused');

    socket.frame(envelope({ thread_ts: '1761300000.000100', envelope_id: 'env-hold' }));
    await sleep(10);
    let stopDone = false;
    const stopping = transport.stop().then(() => { stopDone = true; });
    await sleep(50);
    assert(!stopDone && socket.calls.disconnect === 0 && socket.listenerCount('slack_event') === 0, 'stop() first stops listening and waits for the envelope being handled');
    await transport.ack('env-hold');
    release();
    await stopping;
    assert(stopDone && socket.calls.disconnect === 1 && same(socket.calls.send.at(-1), ['env-hold']), 'the in-flight envelope still acks, then the client disconnects once');
    socket.frame(envelope({ thread_ts: '1761300000.000100', envelope_id: 'env-after' }));
    await sleep(10);
    const afterStop = [];
    for (const fn of [() => transport.ack('env-after'), () => transport.post({ channel: CHANNEL, thread_ts: null, text: 'x', metadata: { event_type: 'botmancers_share', event_payload: {} } })]) {
      try { await fn(); afterStop.push('ok'); } catch (error) { afterStop.push(error.code); }
    }
    await transport.stop();
    assert(received.length === 2 && same(afterStop, ['slack_transport_stopped', 'slack_transport_stopped']) && socket.calls.disconnect === 1 && socket.calls.start === 1,
      'after stop(): no envelope is handled, ack and post are refused, a second stop() is a no-op, and nothing restarts the client');
  }

  console.log('\nAdapter errors: codes and Slack error strings, never a token');
  {
    const sdkError = Object.assign(new Error(`An API error occurred: channel_not_found Bearer ${BOT_TOKEN}`), {
      code: 'slack_webapi_platform_error', data: { ok: false, error: 'channel_not_found' }, config: { headers: { Authorization: `Bearer ${BOT_TOKEN}` } },
    });
    const socket = fakeSocket({ failSend: id => id === 'env-fail' });
    const web = fakeWeb({ postError: sdkError });
    const transport = transportLib.createSlackTransport({ socket, web });
    await transport.start(async () => {});
    const caught = [];
    try { await transport.post({ channel: CHANNEL, thread_ts: '1761300000.000100', text: 'x', metadata: { event_type: 'botmancers_share_reply', event_payload: {} } }); } catch (error) { caught.push(error); }
    try { await transport.ack('env-fail'); } catch (error) { caught.push(error); }
    assert(caught[0] && caught[0].name === 'SlackTransportError' && caught[0].code === 'slack_post_failed' && caught[0].slackError === 'channel_not_found' && caught[0] !== sdkError,
      'a failed chat.postMessage is a SlackTransportError (slack_post_failed, channel_not_found), not the SDK error');
    assert(caught[1] && caught[1].code === 'slack_ack_failed', 'a failed ack is slack_ack_failed');
    assert(caught.length === 2 && caught.every(error => !leaks(errorText(error)) && !('config' in error)), 'neither error\'s message, stack, or JSON carries a token or the request config');
    await transport.stop();
    const unauth = Object.assign(new Error(`invalid_auth ${APP_TOKEN}`), { code: 'slack_webapi_platform_error', data: { error: 'invalid_auth' } });
    const broken = fakeSocket({ failStart: unauth });
    let startError = null;
    try { await transportLib.createSlackTransport({ socket: broken, web: fakeWeb() }).start(async () => {}); } catch (error) { startError = error; }
    assert(startError && startError.code === 'slack_connect_failed' && startError.slackError === 'invalid_auth' && !leaks(errorText(startError)) && broken.calls.disconnect === 1 && broken.listenerCount('slack_event') === 0,
      'a failed connect is slack_connect_failed (invalid_auth), token-free, and leaves no listener or reconnect loop');
    const lines = [];
    const logger = transportLib.safeSlackLogger(transportLib.tokenRedactor({ appToken: APP_TOKEN, botToken: BOT_TOKEN }), line => lines.push(line));
    logger.debug(`payload ${BOT_TOKEN}`);
    logger.info('info');
    logger.warn(`warn Bearer ${APP_TOKEN}`);
    logger.error(new Error(`error ${BOT_TOKEN} and ${['xoxp', '12345', 'other', 'token'].join('-')}`));
    assert(lines.length === 2 && lines.every(line => !leaks(line) && !/xox[a-z]-|xapp-/.test(line)) && logger.getLevel() === 'warn',
      'the SDK logger drops debug/info (payload dumps), keeps warn/error, and redacts both tokens and any token-shaped string');
  }

  console.log('\nSetup: one Agent with exact sessions, grok-bot with shares:create, the fixture allowlist');
  const connectionId = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
  registerFake(connectionId);
  fake.seedFakeProvider(STATE, [
    { id: 'tx-1-SECRET', title: 'Transport one', workspace: '/work/tx' },
    { id: 'tx-2-SECRET', title: 'Transport two', workspace: '/work/tx' },
  ]);
  const dev = dbModule.bots.create({
    name: 'Dev', title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]', policy_mode: 'read_only', allow_new_sessions: 0, allow_resume_with_edits: 0,
  });
  { let cursor = null; do cursor = (await ps.syncAgentSessions(db, dev.id, { cursor })).next_cursor; while (cursor); }
  const refOf = id => db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(dev.id, id).id;
  const [s1, s2] = ['tx-1-SECRET', 'tx-2-SECRET'].map(refOf);
  writeJson(SHARES_PATH, { version: 1, audiences: [{ kind: 'slack', team_id: TEAM, channel_id: CHANNEL }] });
  const grok = { kind: 'service', id: 'grok-bot' };
  const serviceBodies = [];
  const create = async (ref, key) => {
    const res = await serviceOperations.createShare(grok, ref, () => ({ audience: { kind: 'slack', team_id: TEAM, channel_id: CHANNEL }, idempotency_key: key }), null);
    serviceBodies.push(res.body);
    if (res.status !== 201) throw new Error(`createShare ${key}: ${JSON.stringify(res.body)}`);
    return res.body.share;
  };
  const shareA = await create(s1, 'tx-a');

  console.log('\nManaged start matrix: stable disabled / misconfigured / failed states');
  {
    const factoryCalls = [];
    const clients = () => { factoryCalls.push(1); return { socket: fakeSocket(), web: fakeWeb() }; };
    const base = { BOTMANCERS_SESSION_SHARES_PATH: SHARES_PATH };
    const badShares = path.join(TMP, 'bad-shares.json');
    const openShares = path.join(TMP, 'open-shares.json');
    const emptyShares = path.join(TMP, 'empty-shares.json');
    fs.writeFileSync(badShares, '{ not json');
    fs.chmodSync(badShares, 0o600);
    writeJson(openShares, { version: 1, audiences: [{ kind: 'slack', team_id: TEAM, channel_id: CHANNEL }] }, 0o644);
    writeJson(emptyShares, { version: 1, audiences: [] });
    const cases = [
      ['absent: no token', { ...base }, 'disabled', 'slack_tokens_absent'],
      ['partial: app token only', { ...base, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN }, 'misconfigured', 'bot_token_missing'],
      ['partial: bot token only', { ...base, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'app_token_missing'],
      ['invalid: app token is a bot token', { ...base, BOTMANCERS_SLACK_APP_TOKEN: BOT_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'app_token_invalid'],
      ['invalid: bot token malformed', { ...base, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: `${BOT_TOKEN} extra` }, 'misconfigured', 'bot_token_invalid'],
      ['share config absent', { BOTMANCERS_SESSION_SHARES_PATH: path.join(TMP, 'missing.json'), BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'share_config_absent'],
      ['share config invalid JSON', { BOTMANCERS_SESSION_SHARES_PATH: badShares, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'share_config_invalid'],
      ['share config readable by others', { BOTMANCERS_SESSION_SHARES_PATH: openShares, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'share_config_invalid'],
      ['share config with no audience', { BOTMANCERS_SESSION_SHARES_PATH: emptyShares, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN }, 'misconfigured', 'share_config_no_audience'],
    ];
    for (const [label, env, state, reason] of cases) {
      const lines = [];
      const status = await runtimeLib.startSlackRuntime({ env, clients, log: line => lines.push(line) });
      assert(status.state === state && status.reason === reason && factoryCalls.length === 0 && runtimeLib.slackRuntimeRelay() === null && lines.every(line => !leaks(line)),
        `${label}: ${status.state}/${status.reason}, no Slack client created, nothing printed with a token`);
    }
    const env = { ...base, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN };
    const authFails = () => ({ socket: fakeSocket(), web: { ...fakeWeb(), auth: { test: async () => { throw Object.assign(new Error(`invalid_auth ${BOT_TOKEN}`), { data: { error: 'invalid_auth' } }); } } } });
    const lines = [];
    const failed = await runtimeLib.startSlackRuntime({ env, clients: authFails, log: line => lines.push(line) });
    assert(failed.state === 'failed' && failed.reason === 'slack_auth_failed' && lines.every(line => !leaks(line)), 'auth.test rejected: failed/slack_auth_failed, token-free log');
    const foreign = () => ({ socket: fakeSocket(), web: { ...fakeWeb(), auth: { test: async () => ({ ok: true, user_id: BOT, team_id: 'T0OTHER01' }) } } });
    const elsewhere = await runtimeLib.startSlackRuntime({ env, clients: foreign, log: () => {} });
    assert(elsewhere.state === 'misconfigured' && elsewhere.reason === 'workspace_not_allowlisted', 'a bot of a workspace with no allowlisted audience: misconfigured/workspace_not_allowlisted');
    const unauth = Object.assign(new Error('nope'), { data: { error: 'invalid_auth' } });
    const noSocket = () => ({ socket: fakeSocket({ failStart: unauth }), web: fakeWeb() });
    const refused = await runtimeLib.startSlackRuntime({ env, clients: noSocket, log: () => {} });
    assert(refused.state === 'failed' && refused.reason === 'slack_connect_failed' && runtimeLib.slackRuntimeRelay() === null, 'Socket Mode refused: failed/slack_connect_failed, no relay left running');
  }

  console.log('\nReal SocketModeClient/WebClient on a local fake Slack: persist -> ack -> dispatch, reconnect, dedup, stop');
  const lines = [];
  let server = null;
  const ackChecks = [];
  server = createFakeSlackServer({ appToken: APP_TOKEN, botToken: BOT_TOKEN, botUserId: BOT, teamId: TEAM });
  const apiUrl = await server.listen();
  const clientOptions = { slackApiUrl: apiUrl, clientPingTimeoutMs: 150, serverPingTimeoutMs: 60000 };
  // The real clients, with the ack observed client-side: the ledger state at
  // the moment the ack is sent.
  const realClients = tokens => {
    const clients = transportLib.createSlackClients(tokens, { ...clientOptions, log: line => lines.push(line) });
    const send = clients.socket.send.bind(clients.socket);
    clients.socket.send = async (id, body) => {
      const delivery = db.prepare('SELECT disposition FROM slack_deliveries WHERE envelope_id = ? ORDER BY retry_attempt DESC LIMIT 1').get(id);
      ackChecks.push({ id, persisted: !!delivery, disposition: delivery && delivery.disposition, sendsBefore: sends() });
      order.push({ op: 'ack', id });
      return send(id, body);
    };
    return clients;
  };
  const startReal = () => runtimeLib.startSlackRuntime({ clients: realClients, sweepMs: 50, stopGraceMs: 2000, log: line => lines.push(line) });
  let anchorTs;
  {
    const status = await startReal();
    assert(status.state === 'connected' && status.reason === null && status.connections === 1 && server.state.opens === 1 && server.state.connections === 1 && server.state.auth === 1,
      'both tokens + valid share config: auth.test, apps.connections.open, one live Socket Mode connection, state connected');
    await server.until(() => server.state.posts.some(p => p.metadata && p.metadata.event_type === 'botmancers_share'), 'anchor post');
    const anchor = server.state.posts.find(p => p.metadata.event_type === 'botmancers_share');
    anchorTs = anchor.ts;
    assert(anchor.channel === CHANNEL && !anchor.thread_ts && anchor.text === relayLib.ANCHOR_TEXT && same(anchor.metadata.event_payload, { share_ref: shareA.share_ref })
      && relayLib.shareThread(shareA.share_ref).thread_ts === anchorTs, 'the sweep binds the new share: one anchor via chat.postMessage, recorded as its thread');
    await sleep(150);
    assert(server.state.posts.filter(p => p.metadata.event_type === 'botmancers_share').length === 1, 'later sweeps post no second anchor');
  }
  const e1 = envelope({ thread_ts: null, text: `<@${BOT}> What changed in the uploader?` });
  {
    e1.payload.event.thread_ts = anchorTs;
    const before = sends();
    order.length = 0;
    server.deliver(e1);
    await server.until(() => server.state.posts.some(p => p.metadata.event_type === 'botmancers_share_reply'), 'reply post');
    const key = relayLib.questionKey(TEAM, CHANNEL, e1.payload.event.ts);
    const check = ackChecks.find(c => c.id === e1.envelope_id);
    assert(check && check.persisted && check.disposition === 'accepted' && check.sendsBefore === before, 'at the moment of the ack the delivery row is committed (accepted) and no provider send has happened');
    const reply = server.state.posts.find(p => p.metadata.event_type === 'botmancers_share_reply');
    await eventually(() => question(key).state === 'replied', 'question replied');
    const q = question(key);
    const pinKey = db.prepare('SELECT idempotency_key FROM session_pin_turns WHERE id = ?').get(q.turn_ref).idempotency_key;
    assert(same(order.map(o => o.op), ['ack', 'dispatch']) && pinKey === `turn:${key}`, `order: ack, then exactly one provider dispatch, on the pin turn keyed by the question (${order.map(o => o.op).join(' -> ')})`);
    assert(server.state.acks.filter(id => id === e1.envelope_id).length === 1, 'Slack received exactly one ack for the envelope');
    assert(reply.channel === CHANNEL && reply.thread_ts === anchorTs && same(reply.metadata.event_payload, { share_ref: shareA.share_ref, turn_ref: q.turn_ref }) && /fake reply/.test(reply.text)
      && reply.unfurl_links === 'false' && q.reply_ts === reply.ts, 'one correlated reply in the anchor thread: metadata { share_ref, turn_ref } only, unfurls off');
    assert(sends() === before + 1, 'exactly one provider send');
  }
  {
    const before = { sends: sends(), posts: server.state.posts.length, opens: server.state.opens };
    server.serverDisconnect();
    await eventually(() => server.state.connections === 2 && server.connected && runtimeLib.slackRuntimeStatus().state === 'connected', 'reconnect after server disconnect');
    assert(lines.some(line => /Slack relay: reconnecting/.test(line)) && runtimeLib.slackRuntimeStatus().connections === 2 && server.state.opens === before.opens + 1,
      'a Slack server "disconnect" (pod recycle) closes the socket; the client reports reconnecting, opens a new URL, and is connected again');
    const redelivered = { ...e1, retry_attempt: 1, retry_reason: 'timeout' };
    server.deliver(redelivered);
    await server.until(() => server.state.acks.filter(id => id === e1.envelope_id).length === 2, 'ack of the redelivery');
    await sleep(100);
    const rows = db.prepare('SELECT retry_attempt, disposition FROM slack_deliveries WHERE envelope_id = ? ORDER BY retry_attempt').all(e1.envelope_id);
    assert(same(rows, [{ retry_attempt: 0, disposition: 'accepted' }, { retry_attempt: 1, disposition: 'duplicate_event' }]) && sends() === before.sends && server.state.posts.length === before.posts,
      'the redelivered envelope (retry_attempt 1) after reconnect is acked and recorded duplicate_event: no provider send, no post');
    server.dropSocket();
    await eventually(() => server.state.connections === 3 && server.connected && runtimeLib.slackRuntimeStatus().state === 'connected', 'reconnect after socket drop');
    server.deliver({ ...e1, retry_attempt: 2, retry_reason: 'http_timeout' });
    server.deliver(e1);
    await server.until(() => server.state.acks.filter(id => id === e1.envelope_id).length === 4, 'acks after socket drop');
    await sleep(100);
    assert(runtimeLib.slackRuntimeStatus().connections === 3 && sends() === before.sends && server.state.posts.length === before.posts
      && count('SELECT COUNT(*) AS n FROM slack_deliveries WHERE envelope_id = ?', e1.envelope_id) === 3,
      'a dropped socket reconnects too; a further retry and an exact repeat are deduplicated (still one provider send)');
    const e2 = envelope({ thread_ts: anchorTs, text: 'And the tests?' });
    server.deliver(e2);
    await server.until(() => server.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_reply').length === 2, 'second reply');
    assert(sends() === before.sends + 1, 'a new question after the reconnects is dispatched once and answered');
  }
  {
    const before = { opens: server.state.opens, connections: server.state.connections };
    const stopped = await runtimeLib.stopSlackRuntime();
    await sleep(600);
    assert(stopped.state === 'stopped' && !server.connected && server.state.opens === before.opens && server.state.connections === before.connections && runtimeLib.slackRuntimeRelay() === null,
      'explicit stop: the socket closes and the client never reconnects (no new connections.open after 4x the backoff)');
  }

  console.log('\nShutdown and restart: pending relay rows survive and finish exactly once');
  {
    // (1) A question answered after shutdown: dispatched, its turn still running.
    await runtimeLib.startSlackRuntime({ clients: realClients, sweepMs: 50, log: line => lines.push(line) });
    await eventually(() => server.connected, 'connected');
    const held = envelope({ thread_ts: anchorTs, text: '[hold] Summarize the session' });
    const heldKey = relayLib.questionKey(TEAM, CHANNEL, held.payload.event.ts);
    const before = { sends: sends(), replies: server.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_reply').length };
    server.deliver(held);
    await eventually(() => question(heldKey) && question(heldKey).state === 'dispatched', 'held question dispatched');
    await runtimeLib.stopSlackRuntime();
    assert(question(heldKey).state === 'dispatched' && question(heldKey).reply_ts === null && sends() === before.sends + 1, 'shutdown leaves the dispatched question as it is (no reply yet)');

    // (2) A question whose ack never reached Slack: pending, never dispatched.
    const lostAck = envelope({ thread_ts: anchorTs, text: 'Which files changed?' });
    const lostKey = relayLib.questionKey(TEAM, CHANNEL, lostAck.payload.event.ts);
    const dropping = { socket: fakeSocket({ failSend: id => id === lostAck.envelope_id }), web: fakeWeb() };
    await runtimeLib.startSlackRuntime({ clients: () => dropping, sweepMs: 60000, log: line => lines.push(line) });
    dropping.socket.frame(lostAck);
    await eventually(() => question(lostKey), 'lost-ack question persisted');
    await sleep(50);
    await runtimeLib.stopSlackRuntime();
    assert(question(lostKey).state === 'pending' && question(lostKey).question !== null && sends() === before.sends + 1,
      'a failed ack leaves the question pending with its text, undispatched, across shutdown');

    // Restart on the real client: both finish exactly once.
    fake.mutateFakeProvider(STATE, state => {
      for (const turn of Object.values(state.turns)) if (turn.state === 'running') turn.prompt = turn.prompt.replace('[hold] ', '');
    });
    const restarted = await runtimeLib.startSlackRuntime({ clients: realClients, sweepMs: 50, log: line => lines.push(line) });
    await eventually(() => question(heldKey).state === 'replied' && question(lostKey).state === 'replied', 'both rows replied after restart');
    await sleep(200);
    const replies = server.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_reply');
    assert(restarted.state === 'connected' && replies.length === before.replies + 2 && sends() === before.sends + 2,
      'after restart: the held answer is posted, the pending question is dispatched once and answered; one provider send each in total');
    // Slack redelivers the unacked envelope to the new connection: deduplicated.
    server.deliver({ ...lostAck, retry_attempt: 1, retry_reason: 'timeout' });
    await server.until(() => server.state.acks.includes(lostAck.envelope_id), 'redelivery ack');
    await sleep(100);
    assert(sends() === before.sends + 2 && server.state.posts.filter(p => p.metadata.event_type === 'botmancers_share_reply').length === before.replies + 2,
      'the redelivery of the never-acked envelope is a duplicate: no second provider turn');
    await runtimeLib.stopSlackRuntime();
  }

  console.log('\nSecrets: CREDENTIAL_ENV, bridge env, logs, errors, posts, health, service responses, argv, committed files');
  {
    const redactor = serviceRedactor();
    assert(redactor.text(`a ${APP_TOKEN} b ${BOT_TOKEN} c`) === 'a [redacted] b [redacted] c', 'serviceRedactor (CREDENTIAL_ENV) redacts both Slack token values');
    const product = jiti('./packages/mcp-server/src/product.ts');
    const home = path.join(TMP, 'product-home');
    const pEnv = { PATH: process.env.PATH, HOME: path.join(TMP, 'user'), BOTMANCERS_HOME: home, BOTMANCERS_SLACK_APP_TOKEN: APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN: BOT_TOKEN };
    const ctx = product.productContext(pEnv, { stdout: () => {}, stderr: () => {} });
    const envs = product.childEnvs(ctx);
    assert(envs.core.BOTMANCERS_SLACK_APP_TOKEN === APP_TOKEN && envs.core.BOTMANCERS_SLACK_BOT_TOKEN === BOT_TOKEN && !Object.values(envs.bridge).some(leaks),
      'the managed start gives the tokens to the core process only; the MCP bridge env holds neither');
    assert(!leaks(ctx.redact(`log ${APP_TOKEN} ${BOT_TOKEN}`)), 'the CLI\'s output redactor knows both Slack tokens');
    const health = jiti('./app/api/health/route.ts');
    const res = await health.GET();
    const body = await res.text();
    assert(JSON.parse(body).slack.state === 'stopped' && !leaks(body), `/api/health reports the Slack state and no token (${JSON.stringify(JSON.parse(body).slack)})`);
    const views = [await serviceOperations.getShare(grok, shareA.share_ref), await serviceOperations.listShares(grok, { sessionRef: null, state: null })].map(r => JSON.stringify(r));
    assert([...serviceBodies.map(b => JSON.stringify(b)), ...views].every(text => !leaks(text)), 'share API responses carry no token');
    assert(server.state.posts.every(p => !leaks(JSON.stringify(p))), 'no Slack post carries a token');
    assert(lines.length > 0 && lines.every(line => !leaks(line)), `no runtime or SDK log line carries a token (${lines.length} lines)`);
    assert(printed.every(line => !leaks(line)), `nothing printed by this process carries a token (${printed.length} lines)`);
    assert(!process.argv.some(leaks) && !process.execArgv.some(leaks), 'no process argument carries a token');
    const dbText = fs.readFileSync(process.env.BOTMANCERS_DB_PATH).toString('latin1');
    assert(!leaks(dbText), 'the database holds no token');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    const tokenShaped = /\bx(?:app|ox[abpers])-\d+-[A-Za-z0-9-]{8,}/;
    const hits = tracked.filter(file => {
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full) || fs.statSync(full).size > 4 * 1024 * 1024) return false;
      const text = fs.readFileSync(full, 'utf8');
      return text.includes(APP_TOKEN) || text.includes(BOT_TOKEN) || tokenShaped.test(text);
    });
    assert(hits.length === 0, `no committed file holds a sentinel or a token-shaped value (${hits.join(', ') || 'none'})`);
  }

  await server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
