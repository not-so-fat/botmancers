// NOT-514: offline reference model of the frozen SessionShare contract and
// the Slack relay core (docs/design/2026-10-24-session-share-preflight.md).
// Not production code: state lives in memory, and the store, endpoints,
// tools, and Socket Mode transport are the implementation tickets' job.
// What is real: every Ask is dispatched through NOT-507 exact-session pins
// (lib/session-pins) and audited through the NOT-499 service audit, so the
// fixture proves the seam, not a parallel path.
//
// Pieces:
//   createSessionShareModel  current-session context resolution, share
//                            create/get/list/revoke, and ask (one read-only
//                            turn on exactly the share's session_ref).
//   normalizeSlackEnvelope   a Socket Mode events_api envelope -> one
//                            canonical question, or a drop reason.
//   createSlackRelay         normalize -> audience allowlist -> thread
//                            routing -> dedup -> ask -> bounded reply.
'use strict';

const crypto = require('crypto');

// Stable public codes (docs/contracts/session-share-v0.sketch.json).
const SHARE_ERROR_STATUS = {
  invalid_request: 400,
  authority_not_allowed: 403,
  session_context_required: 409,
  session_not_found: 404,
  session_ended: 409,
  session_missing: 410,
  session_not_resumable: 409,
  source_session_busy: 409,
  share_not_found: 404,
  share_expired: 410,
  share_revoked: 410,
  share_turn_in_progress: 409,
  share_turn_limit: 409,
  audience_not_allowed: 403,
  idempotency_conflict: 409,
};
const CONTEXT_REASONS = ['missing', 'ambiguous', 'unknown', 'stale', 'revoked', 'unsupported'];
const CONTEXT_HEADER = 'botmancers-session-context';
const CONTEXT_TOKEN = /^bmsc_[A-Za-z0-9_-]{43}$/;
// Body fields that would select a session by provider id or heuristic:
// refused before anything else (NOT-499 authority rule).
const HEURISTIC_FIELDS = [
  'provider_session_id', 'external_session_id', 'claude_session_id', 'codex_thread_id', 'cursor_chat_id',
  'cwd', 'workspace', 'latest', 'most_recent', 'title', 'title_match', 'active_since',
];
const TTL = { min: 300, default: 3600, max: 86400 };
const TURNS = { default: 20, max: 100 };
const QUESTION_MAX = 4000;
const REPLY_MAX = 3000;

class ShareError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = SHARE_ERROR_STATUS[code];
    Object.assign(this, extra);
  }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const ref = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

// deps: { pins, audit, redact, now(), grants: { has(principal, agentId, capability) } }
function createSessionShareModel(deps) {
  const contexts = new Map(); // sha256(token) -> { agent_id, session_ref, launch_ref, state, expires_at }
  const shares = new Map(); // share_ref -> share
  const keys = new Map(); // `${principal}:${key}` -> { hash, share_ref }
  const principalOf = p => `${p.kind}:${p.id}`;

  function audit(principal, operation, capability, target, outcome, code) {
    deps.audit.append({
      principal, operation, capability, targetKind: 'session', targetRef: target.sessionRef ?? null, agentId: target.agentId ?? null, outcome, code: code ?? null,
    });
  }

  // A Botmancers-minted, session-bound context: the value the MCP entry of
  // one Botmancers launch carries as a header (a Claude turn process, or a
  // Codex thread load in Botmancers' app-server).
  function mintContext({ agentId, sessionRef, launchRef, ttlMs = 15 * 60 * 1000 }) {
    const token = `bmsc_${crypto.randomBytes(32).toString('base64url')}`;
    contexts.set(sha256(token), { agent_id: agentId, session_ref: sessionRef, launch_ref: launchRef, state: 'live', expires_at: deps.now() + ttlMs });
    return token;
  }
  // The bound launch ended (or the owner withdrew it): the token fails closed.
  function endContext(launchRef, state = 'stale') {
    for (const ctx of contexts.values()) if (ctx.launch_ref === launchRef && ctx.state === 'live') ctx.state = state;
  }

  // Exactly one session from trusted caller context, or session_context_required.
  function resolveCurrent(headers) {
    const raw = headers[CONTEXT_HEADER];
    const fail = reason => { throw new ShareError('session_context_required', 'This caller has no exact session context; pass an explicit session_ref (botmancers_list_sessions).', { reason, recovery: 'choose_session' }); };
    if (raw === undefined || raw === null || raw === '') fail('missing');
    const values = Array.isArray(raw) ? raw : String(raw).split(',').map(v => v.trim()).filter(Boolean);
    if (values.length !== 1) fail('ambiguous');
    // An ambient provider identity (a raw UUID, `claude:<id>`, a Cursor chat
    // id) in place of a minted context is not accepted, and never echoed.
    if (!CONTEXT_TOKEN.test(values[0])) fail('unsupported');
    const ctx = contexts.get(sha256(values[0]));
    if (!ctx) fail('unknown');
    if (ctx.state === 'revoked') fail('revoked');
    if (ctx.state !== 'live' || deps.now() >= ctx.expires_at) fail('stale');
    return { agentId: ctx.agent_id, sessionRef: ctx.session_ref };
  }

  function view(share) {
    const at = deps.now();
    const state = share.state === 'revoked' ? 'revoked' : at >= share.expires_at ? 'expired' : 'active';
    return {
      share_ref: share.share_ref, agent_id: share.agent_id, session_ref: share.session_ref, authority: 'ask', state,
      audience: { ...share.audience }, created_at: share.created_at, expires_at: share.expires_at, revoked_at: share.revoked_at,
      max_turns: share.max_turns, turns_used: share.turns_used, created_via: share.created_via,
    };
  }

  function checkBody(body, allowed) {
    for (const field of Object.keys(body)) {
      if (HEURISTIC_FIELDS.includes(field)) throw new ShareError('authority_not_allowed', `${field} cannot select or describe a session; use session_ref.`);
      if (!allowed.includes(field)) throw new ShareError('invalid_request', `Unknown field ${field}.`);
    }
  }

  // create (explicit session_ref) and create-current (context header).
  async function createShare({ principal, sessionRef = null, headers = null, body }) {
    const target = { sessionRef, agentId: null };
    try {
      checkBody(body, ['agent_id', 'audience', 'ttl_seconds', 'max_turns', 'idempotency_key']);
      if (headers) {
        if (sessionRef) throw new ShareError('invalid_request', 'share_current_session takes no session_ref.');
        Object.assign(target, resolveCurrent(headers));
      }
      if (!target.sessionRef) throw new ShareError('invalid_request', 'session_ref is required.');
      const key = typeof body.idempotency_key === 'string' && body.idempotency_key.length >= 8 && body.idempotency_key.length <= 200 ? body.idempotency_key : null;
      if (!key) throw new ShareError('invalid_request', 'idempotency_key is required (8-200 characters).');
      const ttl = body.ttl_seconds ?? TTL.default;
      if (!Number.isInteger(ttl) || ttl < TTL.min || ttl > TTL.max) throw new ShareError('invalid_request', `ttl_seconds must be ${TTL.min}-${TTL.max}.`);
      const maxTurns = body.max_turns ?? TURNS.default;
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > TURNS.max) throw new ShareError('invalid_request', `max_turns must be 1-${TURNS.max}.`);
      const audience = body.audience;
      if (!audience || audience.kind !== 'slack' || !/^T[A-Z0-9]{2,20}$/.test(audience.team_id || '') || !/^[CG][A-Z0-9]{2,20}$/.test(audience.channel_id || '')) {
        throw new ShareError('invalid_request', 'audience must be { kind: "slack", team_id, channel_id }.');
      }
      if (!deps.audiences.some(a => a.team_id === audience.team_id && a.channel_id === audience.channel_id)) {
        throw new ShareError('audience_not_allowed', 'That channel is not on the owner\'s share allowlist.');
      }
      const owner = deps.pins.sessionOwner(target.sessionRef);
      target.agentId = owner;
      // Not granted, unknown, and another Agent's session answer the same.
      if (!owner || (body.agent_id && body.agent_id !== owner) || !deps.grants.has(principal, owner, headers ? 'shares:create_current' : 'shares:create')) {
        throw new ShareError('session_not_found', 'No session with that reference.');
      }
      const hash = sha256(JSON.stringify([target.sessionRef, audience.team_id, audience.channel_id, ttl, maxTurns]));
      const replay = keys.get(`${principalOf(principal)}:${key}`);
      if (replay) {
        if (replay.hash !== hash) throw new ShareError('idempotency_conflict', 'That idempotency key was used for a different share.');
        audit(principal, 'shares.create', 'shares:create', target, 'allowed', null);
        return { status: 200, body: { share: view(shares.get(replay.share_ref)), replayed: true } };
      }
      // Eligibility is NOT-507's: the share's ask pin is created now, on
      // exactly this session, so an ended/missing/unresumable session is
      // refused with the existing codes before any share exists.
      const shareRef = ref('shr');
      let pin;
      try {
        pin = (await deps.pins.createPin({ requester: deps.relayPrincipal, sessionRef: target.sessionRef, agentId: owner, action: 'ask', idempotencyKey: `share:${shareRef}` })).pin;
      } catch (error) {
        if (error && SHARE_ERROR_STATUS[error.code]) throw new ShareError(error.code, error.message);
        throw error;
      }
      const at = deps.now();
      const share = {
        share_ref: shareRef, agent_id: owner, session_ref: target.sessionRef, pin_ref: pin.id, audience: { kind: 'slack', team_id: audience.team_id, channel_id: audience.channel_id },
        created_by: principalOf(principal), created_via: headers ? 'current_session' : 'session_ref', created_at: at, expires_at: at + ttl * 1000,
        state: 'active', revoked_at: null, max_turns: maxTurns, turns_used: 0, inflight: null,
      };
      shares.set(shareRef, share);
      keys.set(`${principalOf(principal)}:${key}`, { hash, share_ref: shareRef });
      audit(principal, 'shares.create', 'shares:create', target, 'allowed', null);
      return { status: 201, body: { share: view(share), replayed: false } };
    } catch (error) {
      if (!(error instanceof ShareError)) throw error;
      audit(principal, 'shares.create', 'shares:create', target, error.code === 'invalid_request' || error.code === 'idempotency_conflict' ? 'rejected' : 'denied', error.code);
      return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(error.recovery ? { recovery: error.recovery } : {}) } } };
    }
  }

  function visible(principal, shareRef) {
    const share = shares.get(shareRef);
    if (!share) return null;
    if (principal.kind === 'person') return share; // the owner sees and revokes every share
    return share.created_by === principalOf(principal) && deps.grants.has(principal, share.agent_id, 'shares:create') ? share : null;
  }

  function getShare(principal, shareRef) {
    const share = visible(principal, shareRef);
    if (!share) return { status: 404, body: { error: { code: 'share_not_found', message: 'No share with that reference.' } } };
    return { status: 200, body: { share: view(share) } };
  }

  function listShares(principal, { sessionRef = null, state = null } = {}) {
    const items = [...shares.values()].filter(s => visible(principal, s.share_ref)).map(view)
      .filter(s => (!sessionRef || s.session_ref === sessionRef) && (!state || s.state === state))
      .sort((a, b) => b.created_at - a.created_at || (a.share_ref < b.share_ref ? 1 : -1));
    return { status: 200, body: { items, next_cursor: null } };
  }

  // Idempotent: revoking a revoked share answers the same share.
  function revokeShare(principal, shareRef) {
    const share = visible(principal, shareRef);
    if (!share) return { status: 404, body: { error: { code: 'share_not_found', message: 'No share with that reference.' } } };
    if (share.state !== 'revoked') {
      share.state = 'revoked';
      share.revoked_at = deps.now();
      deps.pins.detachPin(deps.relayPrincipal, share.pin_ref);
    }
    return { status: 200, body: { share: view(share) } };
  }

  // One read-only Ask on exactly share.session_ref. messageKey is the
  // canonical Slack message identity, so a lost relay ledger still
  // cannot double-dispatch.
  async function ask({ shareRef, question, messageKey }) {
    const principal = deps.relayPrincipal;
    const share = shares.get(shareRef);
    const target = { sessionRef: share ? share.session_ref : null, agentId: share ? share.agent_id : null };
    const deny = (code, message) => {
      audit(principal, 'shares.ask', 'shares:ask', target, 'denied', code);
      throw new ShareError(code, message);
    };
    if (!share) deny('share_not_found', 'No share with that reference.');
    const v = view(share);
    if (v.state === 'revoked') deny('share_revoked', 'This share was revoked.');
    if (v.state === 'expired') deny('share_expired', 'This share has expired.');
    if (share.inflight) {
      const read = await deps.pins.readPin(principal, share.pin_ref);
      const turn = read.turns.find(t => t.turn_ref === share.inflight);
      if (turn && turn.state === 'running') deny('share_turn_in_progress', 'A question on this share is still being answered.');
      share.inflight = null;
    }
    if (share.turns_used >= share.max_turns) deny('share_turn_limit', 'This share has used all of its questions.');
    let result;
    try {
      result = await deps.pins.sendPinTurn({ requester: principal, pinRef: share.pin_ref, content: question, idempotencyKey: messageKey });
    } catch (error) {
      if (error && SHARE_ERROR_STATUS[error.code]) deny(error.code, error.message);
      throw error;
    }
    if (!result.replayed) {
      share.turns_used += 1;
      share.inflight = result.turn.turn_ref;
    }
    audit(principal, 'shares.ask', 'shares:ask', target, 'allowed', result.replayed ? 'replayed' : null);
    return { turnRef: result.turn.turn_ref, replayed: result.replayed, settled: result.settled };
  }

  // The bounded, redacted final answer of one turn, or null while running.
  async function answer(shareRef, turnRef) {
    const share = shares.get(shareRef);
    const read = await deps.pins.readPin(deps.relayPrincipal, share.pin_ref);
    const turn = read.turns.find(t => t.turn_ref === turnRef);
    if (!turn || turn.state === 'running') return null;
    if (share.inflight === turnRef) share.inflight = null;
    if (turn.state !== 'completed' || typeof turn.answer !== 'string') return { state: turn.state, text: null };
    const text = deps.redact(turn.answer);
    return { state: 'completed', text: text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1)}…` : text };
  }

  return { mintContext, endContext, resolveCurrent, createShare, getShare, listShares, revokeShare, ask, answer };
}

// ---------------------------------------------------------------------
// Slack: canonical event identity.

// Socket Mode envelope -> { question } or { drop }. The delivery identity
// (envelope_id, retry_attempt) is transport-only; the event identity is
// (team_id, event_id); the question identity is (team_id, channel, ts), so
// one message delivered as both `message` and `app_mention` is one question.
function normalizeSlackEnvelope(envelope, { botUserId }) {
  if (!envelope || envelope.type !== 'events_api' || !envelope.payload) return { drop: 'not_events_api' };
  const { payload } = envelope;
  const event = payload.event || {};
  const delivery = { envelope_id: envelope.envelope_id, retry_attempt: envelope.retry_attempt ?? 0, retry_reason: envelope.retry_reason ?? null };
  if (event.type !== 'message' && event.type !== 'app_mention') return { drop: 'not_message', delivery };
  // Bot output (including our own replies) and edits never become questions.
  if (event.bot_id || event.subtype || event.user === botUserId) return { drop: 'not_a_person', delivery };
  if (!event.thread_ts || event.thread_ts === event.ts) return { drop: 'not_in_thread', delivery };
  if (typeof payload.team_id !== 'string' || typeof payload.event_id !== 'string' || typeof event.channel !== 'string' || typeof event.ts !== 'string') {
    return { drop: 'malformed', delivery };
  }
  const text = String(event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return { drop: 'empty', delivery };
  return {
    delivery,
    question: {
      team_id: payload.team_id, event_id: payload.event_id, channel_id: event.channel, thread_ts: event.thread_ts, message_ts: event.ts,
      user_id: event.user, text: text.slice(0, QUESTION_MAX),
      message_key: `slack-${sha256(`${payload.team_id}\n${event.channel}\n${event.ts}`).slice(0, 40)}`,
    },
  };
}

// ---------------------------------------------------------------------
// Slack relay core, transport-independent. transport: { post({ channel,
// thread_ts, text, metadata }) -> { ts } }. The production adapter
// (@slack/socket-mode + @slack/web-api) supplies envelopes and post().

const NOTICES = {
  share_expired: 'This shared session is no longer available (the share expired).',
  share_revoked: 'This shared session is no longer available (the owner revoked the share).',
  share_turn_in_progress: 'A question is still being answered; ask again when it finishes.',
  share_turn_limit: 'This share has used all of its questions.',
  source_session_busy: 'The session is busy right now; ask again shortly.',
};

function createSlackRelay({ model, audiences, botUserId, transport }) {
  const events = new Map(); // `${team}:${event_id}` -> outcome
  const questions = new Map(); // message_key -> { share_ref, turn_ref }
  const threads = new Map(); // `${team}:${channel}:${thread_ts}` -> share_ref
  const log = [];

  // The owner's share is announced in its channel; replies in that thread are its questions.
  async function announce(share) {
    const posted = await transport.post({
      channel: share.audience.channel_id, thread_ts: null,
      text: 'A coding-agent session was shared here (read-only). Reply in this thread to ask it a question.',
      metadata: { event_type: 'botmancers_share', event_payload: { share_ref: share.share_ref } },
    });
    threads.set(`${share.audience.team_id}:${share.audience.channel_id}:${posted.ts}`, share.share_ref);
    return posted.ts;
  }

  async function handleEnvelope(envelope) {
    const normalized = normalizeSlackEnvelope(envelope, { botUserId });
    // Ack first (Slack's 3 s budget); the ledger below makes redelivery harmless.
    const ack = { envelope_id: envelope && envelope.envelope_id };
    const record = entry => {
      log.push(entry);
      return { ack, ...entry };
    };
    if (normalized.drop) return record({ outcome: 'dropped', reason: normalized.drop });
    const q = normalized.question;
    const eventKey = `${q.team_id}:${q.event_id}`;
    if (events.has(eventKey)) return record({ outcome: 'duplicate_event', retry_attempt: normalized.delivery.retry_attempt });
    events.set(eventKey, 'seen');
    if (!audiences.some(a => a.team_id === q.team_id && a.channel_id === q.channel_id)) return record({ outcome: 'dropped', reason: 'audience_not_allowed' });
    const shareRef = threads.get(`${q.team_id}:${q.channel_id}:${q.thread_ts}`);
    if (!shareRef) return record({ outcome: 'dropped', reason: 'share_thread_unknown' });
    if (questions.has(q.message_key)) return record({ outcome: 'duplicate_question', share_ref: shareRef });
    try {
      const asked = await model.ask({ shareRef, question: q.text, messageKey: q.message_key });
      questions.set(q.message_key, { q, share_ref: shareRef, turn_ref: asked.turnRef });
      const replied = asked.settled.then(() => reply(q, shareRef, asked.turnRef));
      return record({ outcome: asked.replayed ? 'replayed' : 'dispatched', share_ref: shareRef, turn_ref: asked.turnRef, replied });
    } catch (error) {
      if (!(error instanceof ShareError)) throw error;
      if (NOTICES[error.code]) {
        await transport.post({ channel: q.channel_id, thread_ts: q.thread_ts, text: NOTICES[error.code], metadata: { event_type: 'botmancers_share_notice', event_payload: { share_ref: shareRef, code: error.code } } });
      }
      return record({ outcome: 'refused', code: error.code, share_ref: shareRef });
    }
  }

  // Correlated by (share_ref, turn_ref) in message metadata; the text is
  // the redacted, bounded final answer.
  async function reply(q, shareRef, turnRef) {
    const answer = await model.answer(shareRef, turnRef);
    if (!answer) return null;
    return transport.post({
      channel: q.channel_id, thread_ts: q.thread_ts,
      text: answer.text ?? 'The session could not answer this question.',
      metadata: { event_type: 'botmancers_share_reply', event_payload: { share_ref: shareRef, turn_ref: turnRef } },
    });
  }

  // For a turn that settles after its envelope was handled (a held turn).
  function replyFor(messageKey) {
    const entry = questions.get(messageKey);
    return entry ? reply(entry.q, entry.share_ref, entry.turn_ref) : Promise.resolve(null);
  }

  return { announce, handleEnvelope, replyFor, log };
}

module.exports = {
  CONTEXT_HEADER, CONTEXT_REASONS, HEURISTIC_FIELDS, QUESTION_MAX, REPLY_MAX, SHARE_ERROR_STATUS, TTL, TURNS,
  ShareError, createSessionShareModel, createSlackRelay, normalizeSlackEnvelope,
};
