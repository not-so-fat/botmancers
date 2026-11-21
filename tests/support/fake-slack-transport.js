// NOT-516: deterministic fake of the four-method SlackTransport
// (lib/slack-relay.ts; design §5). No socket, no Slack SDK, no credential.
//
// - start(onEnvelope) keeps the handler; deliver(envelope) feeds it one
//   Socket Mode envelope, as the native adapter would.
// - ack(envelope_id) records the ack. crashBeforeAck / crashAfterAck name
//   envelope ids whose ack throws before / after Slack received it (the
//   relay process "dies" there).
// - post(message) records the message and answers a deterministic ts: the
//   next of `anchors` for a top-level post, a counter otherwise. Like
//   chat.postMessage, an empty text is refused (no_text) and not recorded.
'use strict';

function createFakeSlackTransport(options = {}) {
  const anchors = [...(options.anchors || [])];
  const crashBeforeAck = new Set(options.crashBeforeAck || []);
  const crashAfterAck = new Set(options.crashAfterAck || []);
  let counter = options.tsBase || 0;
  let handler = null;
  const state = { posts: [], acks: [], starts: 0, stops: 0 };

  const transport = {
    async start(onEnvelope) {
      state.starts += 1;
      handler = onEnvelope;
    },
    async ack(envelopeId) {
      if (crashBeforeAck.has(envelopeId)) throw new Error(`fake crash before ack of ${envelopeId}`);
      state.acks.push(envelopeId);
      if (crashAfterAck.has(envelopeId)) throw new Error(`fake crash after ack of ${envelopeId}`);
    },
    async post(message) {
      if (typeof message.text !== 'string' || message.text.trim() === '') throw new Error('Slack chat.postMessage failed (no_text).');
      counter += 1;
      const ts = message.thread_ts === null && anchors.length > 0 ? anchors.shift() : `1761309999.${String(counter).padStart(6, '0')}`;
      state.posts.push({ ...message, ts });
      return { ts };
    },
    async stop() {
      state.stops += 1;
      handler = null;
    },
  };

  return {
    transport,
    state,
    get started() {
      return handler !== null;
    },
    async deliver(envelope) {
      if (!handler) throw new Error('the fake transport is not started');
      await handler(envelope);
    },
  };
}

module.exports = { createFakeSlackTransport };
