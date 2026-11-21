// NOT-518: a local fake of the Slack services the native transport talks to
// (lib/slack-transport.ts), on 127.0.0.1 only, so the real
// @slack/socket-mode SocketModeClient and @slack/web-api WebClient can be
// driven through connect, ack, server "disconnect", socket close,
// reconnect, redelivery, and stop without a network.
//
// - POST /api/apps.connections.open (app token) -> { ok, url: ws://…/link }
// - POST /api/auth.test (bot token)              -> { ok, user_id, team_id }
// - POST /api/chat.postMessage (bot token)       -> { ok, ts }; recorded
// - WebSocket /link: "hello" on connect; every client frame with an
//   envelope_id is recorded as an ack.
//
// deliver(envelope) sends one Socket Mode frame on the live socket;
// serverDisconnect() sends { type: "disconnect", reason: "refresh_requested" };
// dropSocket() terminates the socket without a close frame.
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

function createFakeSlackServer({ appToken, botToken, botUserId, teamId, onAck = () => {}, failPost = null } = {}) {
  const state = { opens: 0, connections: 0, acks: [], posts: [], auth: 0, rejected: [], frames: [] };
  let socket = null;
  let counter = 0;
  let base = null;
  const waiters = [];
  const notify = () => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const method = req.url.replace(/^\/api\//, '').split('?')[0];
      const args = req.headers['content-type']?.includes('json') ? JSON.parse(body || '{}') : Object.fromEntries(new URLSearchParams(body));
      if (method === 'apps.connections.open') {
        if (auth !== `Bearer ${appToken}`) { state.rejected.push(method); return json({ ok: false, error: 'invalid_auth' }); }
        state.opens += 1;
        return json({ ok: true, url: `${base.replace('http', 'ws')}/link` });
      }
      if (auth !== `Bearer ${botToken}`) { state.rejected.push(method); return json({ ok: false, error: 'invalid_auth' }); }
      if (method === 'auth.test') {
        state.auth += 1;
        return json({ ok: true, user_id: botUserId, team_id: teamId, bot_id: 'B0BOT0001' });
      }
      if (method === 'chat.postMessage') {
        if (failPost && failPost(args)) return json({ ok: false, error: 'channel_not_found' });
        counter += 1;
        const ts = `1761310000.${String(counter).padStart(6, '0')}`;
        const metadata = typeof args.metadata === 'string' ? JSON.parse(args.metadata) : args.metadata;
        state.posts.push({ ...args, metadata, ts });
        notify();
        return json({ ok: true, channel: args.channel, ts });
      }
      json({ ok: false, error: 'unknown_method' });
    });
  });
  const wss = new WebSocketServer({ server, path: '/link' });
  wss.on('connection', ws => {
    state.connections += 1;
    socket = ws;
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      state.frames.push(frame);
      if (frame.envelope_id) {
        state.acks.push(frame.envelope_id);
        onAck(frame.envelope_id);
      }
      notify();
    });
    ws.on('close', () => { if (socket === ws) socket = null; notify(); });
    ws.send(JSON.stringify({ type: 'hello', num_connections: 1, debug_info: { host: 'fake' } }));
    notify();
  });

  return {
    state,
    get connected() { return socket !== null && socket.readyState === 1; },
    listen() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve(`${base}/api/`);
      }));
    },
    deliver(envelope) {
      if (!socket) throw new Error('no live Socket Mode connection');
      socket.send(JSON.stringify(envelope));
    },
    serverDisconnect() {
      socket?.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'fake' } }));
    },
    dropSocket() {
      socket?.terminate();
    },
    // Resolves once test() holds (checked on every request, frame, and close).
    until(test, label = 'condition', ms = 10000) {
      if (test()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
        waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { createFakeSlackServer };
