#!/usr/bin/env node
// NOT-518 operator smoke: one real Slack workspace round trip through the
// native Socket Mode transport (lib/slack-transport.ts), the relay
// (lib/slack-relay.ts), and SessionShare (lib/session-shares.ts), against
// the operator's own Botmancers home. Runbook: docs/slack-transport.md.
//
//   BOTMANCERS_SLACK_APP_TOKEN=… BOTMANCERS_SLACK_BOT_TOKEN=… \
//     npm run smoke:slack-relay -- --session <session_ref> [--channel C…] \
//       [--out transcript.txt] [--wait 600] [--keep-share]
//
// (--slack-api-url <url> points the clients at a local fake Slack, to
// rehearse the script; a recorded proof never uses it.)
//
// Steps (each printed as one redacted transcript line):
//   1. start the Slack runtime in this process (the same startSlackRuntime
//      the core server runs) and require state "connected";
//   2. create one ask-only share of --session for the allowlisted channel;
//   3. the runtime binds it: one anchor message in the channel;
//   4. the operator replies in the anchor thread (as a human). The smoke
//      withholds that envelope's Socket Mode ack, after the relay has
//      recorded it, so Slack must redeliver it;
//   5. one correlated Botmancers reply is posted in the thread;
//   6. the socket is closed the way a Slack "disconnect" closes it, and the
//      client reconnects;
//   7. Slack redelivers the unacked envelope (retry_attempt >= 1); the relay
//      records it as a duplicate event;
//   8. exactly one provider turn exists for the share's question;
//   9. stop: the client disconnects and does not reconnect.
// The share is revoked at the end unless --keep-share.
//
// The core server must not run its own Slack connection at the same time
// (Slack would spread events across both): stop Botmancers, or start it
// without the Slack tokens, before the smoke. The transcript replaces the
// workspace, channel, user, and bot ids, every message ts, and both tokens;
// question and answer text are reported by length only. Botmancers share and
// turn references are kept (they name nothing outside Botmancers).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback;
};
if (flag('help') || !option('session')) {
  console.log('usage: npm run smoke:slack-relay -- --session <session_ref> [--channel C…] [--out file] [--wait seconds] [--keep-share]');
  process.exit(flag('help') ? 0 : 2);
}
const SESSION = option('session');
const WAIT_MS = Number(option('wait', '600')) * 1000;
const OUT = option('out');
// Rehearsal only: a local fake Slack (test-support/fake-slack-server.js).
const API_URL = option('slack-api-url');

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const shares = jiti('../lib/session-shares.ts');
const transportLib = jiti('../lib/slack-transport.ts');
const runtimeLib = jiti('../lib/slack-runtime.ts');
const db = dbModule.default;

// ---------------------------------------------------------------------
// The redacted transcript.
const tokens = [process.env.BOTMANCERS_SLACK_APP_TOKEN, process.env.BOTMANCERS_SLACK_BOT_TOKEN].filter(Boolean);
const aliases = new Map();
function alias(value, prefix) {
  if (!value) return value;
  if (!aliases.has(value)) aliases.set(value, `${prefix}[${prefix === 'U' ? `user${aliases.size + 1}` : prefix === 'T' ? 'team' : prefix === 'C' ? 'channel' : 'bot'}]`);
  return aliases.get(value);
}
function redact(text) {
  let out = String(text);
  for (const token of tokens) out = out.split(token).join('[redacted token]');
  for (const [value, label] of aliases) out = out.split(value).join(label);
  return out
    .replace(/\bx(?:app|ox[abpers])-[A-Za-z0-9-]+/g, '[redacted token]')
    .replace(/\b\d{10}\.\d{6}\b/g, '[ts]');
}
const transcript = [];
function line(text) {
  const safe = redact(text);
  transcript.push(safe);
  console.log(safe);
}
function finish(pass, reason) {
  line(`RESULT ${pass ? 'PASS' : `FAIL (${reason})`}`);
  if (OUT) fs.writeFileSync(OUT, `${transcript.join('\n')}\n`, { mode: 0o600 });
  process.exit(pass ? 0 : 1);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, ms = WAIT_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function coreSlackState() {
  const port = process.env.BOTMANCERS_UI_PORT || '3333';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return body && body.slack ? body.slack.state : 'unknown';
  } catch {
    return 'not running';
  }
}

async function main() {
  let head = 'unknown';
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  line('NOT-518 Slack relay smoke');
  line(`head: ${head}`);
  if (API_URL) line('target: REHEARSAL against a local fake Slack (not a workspace proof)');
  line(`date: ${new Date().toISOString()}`);
  const core = await coreSlackState();
  if (['connecting', 'connected', 'reconnecting'].includes(core)) {
    return finish(false, `the core server already runs a Slack connection (${core}); stop it or start it without the Slack tokens`);
  }
  line(`core server Slack connection: ${core}`);

  // The real clients, with this smoke's hooks: the ack of the first question
  // of our share is withheld (after the relay recorded it), and the socket
  // can be closed as a Slack "disconnect" closes it.
  let clients = null;
  let shareRef = null;
  let withheld = null;
  const factory = t => {
    clients = transportLib.createSlackClients(t, { log: text => line(`sdk: ${text}`), ...(API_URL ? { slackApiUrl: API_URL, clientPingTimeoutMs: 200 } : {}) });
    const send = clients.socket.send.bind(clients.socket);
    clients.socket.send = async (id, body) => {
      const row = shareRef && db.prepare("SELECT retry_attempt, event_id FROM slack_deliveries WHERE envelope_id = ? AND share_ref = ? AND disposition = 'accepted'").get(id, shareRef);
      if (row && !withheld) {
        withheld = { envelope_id: id, event_id: row.event_id };
        return;
      }
      return send(id, body);
    };
    return clients;
  };

  // 1. Runtime.
  const status = await runtimeLib.startSlackRuntime({ clients: factory, sweepMs: 1000, log: text => line(`runtime: ${text}`) });
  line(`step 1 runtime: ${status.state}${status.reason ? ` (${status.reason})` : ''}, connections ${status.connections}`);
  if (status.state !== 'connected') return finish(false, `runtime ${status.state}/${status.reason}`);
  const identity = await transportLib.slackBotIdentity(clients.web);
  alias(identity.team_id, 'T');
  alias(identity.user_id, 'B');

  // 2. One ask-only share.
  const config = shares.loadSessionSharesConfig();
  const audiences = config.state === 'loaded' ? config.config.audiences.filter(a => a.team_id === identity.team_id) : [];
  const channel = option('channel');
  const audience = channel ? audiences.find(a => a.channel_id === channel) : audiences.length === 1 ? audiences[0] : null;
  if (!audience) return finish(false, channel ? 'that channel is not on the share allowlist' : 'pass --channel: the allowlist has several channels for this workspace');
  alias(audience.channel_id, 'C');
  const { share } = await shares.createShare({
    creator: dbModule.UI_OWNER_PRINCIPAL, sessionRef: SESSION, audience: { kind: 'slack', team_id: audience.team_id, channel_id: audience.channel_id },
    ttlSeconds: 1800, maxTurns: 3, idempotencyKey: `not-518-smoke-${Date.now()}`,
  });
  shareRef = share.id;
  line(`step 2 share: ${share.id} authority ${share.authority}, audience ${audience.team_id}/${audience.channel_id}, max_turns ${share.max_turns}, ttl ${share.ttl_seconds}s`);

  // 3. Anchor.
  const thread = await until(() => db.prepare('SELECT * FROM slack_share_threads WHERE share_ref = ?').get(shareRef), 'the anchor', 30000);
  line(`step 3 anchor: posted in ${thread.channel_id} (thread ${thread.thread_ts}), metadata botmancers_share { share_ref }`);

  // 4. The human reply.
  line(`step 4 waiting up to ${Math.round(WAIT_MS / 1000)}s: reply once, as a person, in the anchor thread in ${audience.channel_id}`);
  const q = await until(() => db.prepare('SELECT * FROM slack_questions WHERE share_ref = ? ORDER BY created_at LIMIT 1').get(shareRef), 'a human reply');
  const first = db.prepare('SELECT * FROM slack_deliveries WHERE message_key = ? AND disposition = ?').get(q.message_key, 'accepted');
  line(`step 4 question: delivery ${first.envelope_id} retry_attempt ${first.retry_attempt}, event ${first.event_id}, disposition accepted, recorded before ack; ack ${withheld && withheld.envelope_id === first.envelope_id ? 'withheld to force redelivery' : 'sent'}`);

  // 5. The reply.
  const replied = await until(() => {
    const row = db.prepare('SELECT * FROM slack_questions WHERE message_key = ?').get(q.message_key);
    return row && (row.state === 'replied' || row.state === 'refused') && row.reply_ts ? row : null;
  }, 'the Botmancers reply');
  if (replied.state !== 'replied') return finish(false, `the share refused the question (${replied.code})`);
  const turnText = await shares.shareAnswer(shareRef, replied.turn_ref);
  line(`step 5 reply: posted in the anchor thread (reply ${replied.reply_ts}), metadata botmancers_share_reply { share_ref ${shareRef}, turn_ref ${replied.turn_ref} }, answer ${turnText && turnText.answer ? turnText.answer.length : 0} chars`);

  // 6. Reconnect.
  const before = runtimeLib.slackRuntimeStatus().connections;
  clients.socket.websocket.disconnect();
  await until(() => runtimeLib.slackRuntimeStatus().state === 'connected' && runtimeLib.slackRuntimeStatus().connections > before, 'the reconnect', 60000);
  line(`step 6 reconnect: socket closed as by a server disconnect; reconnected (connections ${runtimeLib.slackRuntimeStatus().connections})`);

  // 7. Redelivery.
  const redelivered = await until(() => db.prepare('SELECT * FROM slack_deliveries WHERE team_id = ? AND event_id = ? AND retry_attempt >= 1 ORDER BY retry_attempt LIMIT 1').get(first.team_id, first.event_id), 'the redelivery', 180000)
    .catch(() => null);
  if (!redelivered) return finish(false, 'Slack did not redeliver the unacked envelope within 180s');
  line(`step 7 redelivery: event ${redelivered.event_id} redelivered as ${redelivered.envelope_id} retry_attempt ${redelivered.retry_attempt} (${redelivered.retry_reason || 'no reason'}), disposition ${redelivered.disposition}, acked`);

  // 8. Exactly one provider turn.
  await sleep(3000);
  const turns = db.prepare('SELECT COUNT(*) AS n FROM session_pin_turns WHERE pin_id = ?').get(share.pin_ref).n;
  const deliveries = db.prepare('SELECT COUNT(*) AS n FROM slack_deliveries WHERE team_id = ? AND event_id = ?').get(first.team_id, first.event_id).n;
  const replies = db.prepare("SELECT COUNT(*) AS n FROM slack_questions WHERE share_ref = ? AND state = 'replied'").get(shareRef).n;
  const used = shares.shareRow(shareRef).turns_used;
  line(`step 8 dedup: ${deliveries} deliveries of the event, ${turns} provider turn(s) on the share pin, share turns_used ${used}, ${replies} reply`);
  if (redelivered.disposition !== 'duplicate_event' || turns !== 1 || used !== 1 || replies !== 1) return finish(false, 'a duplicate provider turn or reply');

  // 9. Stop.
  const connectionsAtStop = runtimeLib.slackRuntimeStatus().connections;
  const stopped = await runtimeLib.stopSlackRuntime();
  await sleep(5000);
  line(`step 9 stop: ${stopped.state}; connections still ${connectionsAtStop}, socket ${clients.socket.websocket && clients.socket.websocket.isActive() ? 'active' : 'closed'} after 5s`);
  if (!flag('keep-share')) {
    shares.revokeShare(shareRef);
    line(`cleanup: share ${shareRef} revoked`);
  }
  finish(stopped.state === 'stopped' && !(clients.socket.websocket && clients.socket.websocket.isActive()), 'the client was still connected after stop');
}

main().catch(error => {
  line(`error: ${error && error.message ? error.message : 'unknown'}`);
  runtimeLib.stopSlackRuntime().finally(() => finish(false, 'error'));
});
