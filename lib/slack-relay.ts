// NOT-516: the transport-neutral Slack relay core
// (docs/design/2026-10-24-session-share-preflight.md §4 and §5;
// docs/slack-relay.md).
//
// One Slack thread asks exactly one SessionShare. Creating a share's relay
// binding posts one anchor message in the share's allowlisted channel; human
// replies in that exact thread become questions to that share's session_ref
// through NOT-515's askShare, and the bounded, redacted answer is posted back
// in the same thread, correlated by message metadata
// { event_type: "botmancers_share_reply", event_payload: { share_ref, turn_ref } }.
// Nothing is routed by channel alone, text, title, activity, "latest", a
// provider id, or a workspace.
//
// Every Socket Mode envelope goes through:
//
//   normalize -> persist (one commit) -> ack -> askShare -> reply
//
// with three identities, each its own ledger column and constraint:
//
//   delivery  (envelope_id, retry_attempt)  slack_deliveries primary key
//   event     (team_id, event_id)           slack_deliveries: one owning row
//   question  (team_id, channel, message ts) slack_questions primary key
//
// The question key, hashed, is also the NOT-507 pin-turn idempotency key that
// askShare passes through unchanged, so even a lost relay ledger cannot
// dispatch twice. The ledger row is committed before the ack; a question
// that never reached askShare (a crash before or after the ack) stays
// pending and is re-dispatched with the same key when the relay starts
// again. Drops (bot or self messages, edits and other subtypes, top-level
// messages, channels off the owner's allowlist, threads with no share) are
// recorded in the delivery ledger only: no service call, no service audit.
//
// The relay depends only on the four-method SlackTransport below. The native
// @slack/socket-mode adapter, its credentials, and its start/stop wiring in
// the server lifecycle are not part of this module.
import { createHash } from 'crypto';
import db from './db';
import { serviceRedactor } from './service-redaction';
import {
  SHARE_LIMITS, ShareAskError, ShareError, askShare, audienceAllowed, shareAnswer, shareRow, shareState, shareToolAccess,
} from './session-shares';

// ---------------------------------------------------------------------
// The transport boundary (§5): Socket Mode events_api envelopes in, acks
// and thread posts out.

export interface SocketModeEnvelope {
  envelope_id?: string;
  type?: string;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
  payload?: {
    team_id?: string;
    event_id?: string;
    type?: string;
    event?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface SlackPost {
  channel: string;
  thread_ts: string | null;
  text: string;
  metadata: { event_type: string; event_payload: Record<string, string> };
}

export interface SlackTransport {
  start(onEnvelope: (e: SocketModeEnvelope) => Promise<void>): Promise<void>; // events_api only
  ack(envelopeId: string): Promise<void>;
  post(m: SlackPost): Promise<{ ts: string }>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------
// Fixed public text. Notices reveal nothing about the session: no title,
// Agent, provider, workspace, or turn count.

export const REPLY_EVENT_TYPE = 'botmancers_share_reply';
export const NOTICE_EVENT_TYPE = 'botmancers_share_notice';
export const ANCHOR_EVENT_TYPE = 'botmancers_share';

export const ANCHOR_TEXT = 'A coding-agent session was shared here (read-only). Reply in this thread to ask it a question.';
// A share the owner gave full access: askers are told what their questions can make it do.
export const FULL_ACCESS_ANCHOR_TEXT = 'A coding-agent session was shared here with full access: it can edit files, run shell commands, and use the network. Reply in this thread to ask it something.';
export const FAILED_TEXT = 'The shared session could not answer this question.';
export const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  share_expired: 'This shared session is no longer available (the share expired).',
  share_revoked: 'This shared session is no longer available (the owner revoked the share).',
  share_turn_in_progress: 'A question is still being answered; ask again when it finishes.',
  share_turn_limit: 'This share has used all of its questions.',
  source_session_busy: 'The session is busy right now; ask again shortly.',
});
export const GENERIC_NOTICE = 'This shared session cannot answer that question right now.';

export function noticeText(code: string): string {
  return NOTICES[code] ?? GENERIC_NOTICE;
}

// ---------------------------------------------------------------------
// Ledgers.

db.exec(`
  CREATE TABLE IF NOT EXISTS slack_share_threads (
    share_ref TEXT PRIMARY KEY,
    session_ref TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (team_id, channel_id, thread_ts)
  );
  CREATE TABLE IF NOT EXISTS slack_deliveries (
    envelope_id TEXT NOT NULL,
    retry_attempt INTEGER NOT NULL,
    retry_reason TEXT,
    team_id TEXT,
    event_id TEXT,
    -- 1 on the one delivery that owns its event; NULL on every other one.
    event_owner INTEGER CHECK (event_owner IS NULL OR event_owner = 1),
    message_key TEXT,
    share_ref TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'duplicate_event', 'duplicate_question', 'dropped')),
    reason TEXT,
    received_at INTEGER NOT NULL,
    acked_at INTEGER,
    PRIMARY KEY (envelope_id, retry_attempt),
    UNIQUE (team_id, event_id, event_owner)
  );
  CREATE TABLE IF NOT EXISTS slack_questions (
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    message_key TEXT NOT NULL UNIQUE,
    thread_ts TEXT NOT NULL,
    share_ref TEXT NOT NULL,
    event_id TEXT NOT NULL,
    -- Kept only while pending (needed to re-dispatch after a restart).
    question TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'refused', 'replied')),
    turn_ref TEXT,
    code TEXT,
    reply_ts TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, channel_id, message_ts)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_questions_turn ON slack_questions(share_ref, turn_ref) WHERE turn_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_slack_questions_state ON slack_questions(state, created_at);
`);

export interface ShareThreadRow {
  share_ref: string;
  session_ref: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  created_at: number;
}

export interface QuestionRow {
  team_id: string;
  channel_id: string;
  message_ts: string;
  message_key: string;
  thread_ts: string;
  share_ref: string;
  event_id: string;
  question: string | null;
  state: 'pending' | 'dispatched' | 'refused' | 'replied';
  turn_ref: string | null;
  code: string | null;
  reply_ts: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------
// Normalization: one envelope -> its identities, and one canonical question
// or a drop reason. Pure.

export type DropReason =
  | 'malformed'
  | 'not_events_api'
  | 'not_message'
  | 'not_a_person'
  | 'message_subtype'
  | 'not_in_thread'
  | 'empty'
  | 'audience_not_allowed'
  | 'share_thread_unknown';

export interface NormalizedQuestion {
  team_id: string;
  event_id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  text: string;
  message_key: string;
}

export interface NormalizedEnvelope {
  delivery: { envelope_id: string; retry_attempt: number; retry_reason: string | null } | null;
  event: { team_id: string; event_id: string } | null;
  question: NormalizedQuestion | null;
  drop: DropReason | null;
}

const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
const ENVELOPE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EVENT_ID = /^[A-Za-z0-9]{1,64}$/;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// The canonical question identity, hashed: also the pin-turn idempotency key.
export function questionKey(teamId: string, channelId: string, messageTs: string): string {
  return `slack-${createHash('sha256').update(`${teamId}\n${channelId}\n${messageTs}`).digest('hex').slice(0, 40)}`;
}

export function normalizeSlackEnvelope(envelope: SocketModeEnvelope, options: { botUserId: string }): NormalizedEnvelope {
  const out: NormalizedEnvelope = { delivery: null, event: null, question: null, drop: null };
  const envelopeId = str(envelope?.envelope_id);
  if (!envelopeId || !ENVELOPE_ID.test(envelopeId)) return { ...out, drop: 'malformed' };
  const attempt = envelope.retry_attempt ?? 0;
  out.delivery = {
    envelope_id: envelopeId,
    retry_attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
    retry_reason: str(envelope.retry_reason) || null,
  };
  const payload = envelope.payload;
  if (envelope.type !== 'events_api' || !payload || payload.type !== 'event_callback') return { ...out, drop: 'not_events_api' };
  const teamId = str(payload.team_id);
  const eventId = str(payload.event_id);
  if (!teamId || !SLACK_ID.test(teamId) || !eventId || !EVENT_ID.test(eventId)) return { ...out, drop: 'malformed' };
  out.event = { team_id: teamId, event_id: eventId };
  const event = payload.event ?? {};
  if (event.type !== 'message' && event.type !== 'app_mention') return { ...out, drop: 'not_message' };
  const user = str(event.user);
  // Bot output, our own replies included, never becomes a question.
  if (event.bot_id || event.bot_profile || event.subtype === 'bot_message' || !user || user === options.botUserId) return { ...out, drop: 'not_a_person' };
  // Edits, deletions, broadcasts, joins, file shares, ...
  if (event.subtype !== undefined) return { ...out, drop: 'message_subtype' };
  const channelId = str(event.channel);
  const ts = str(event.ts);
  const threadTs = event.thread_ts === undefined ? null : str(event.thread_ts);
  if (!channelId || !SLACK_ID.test(channelId) || !ts || !SLACK_TS.test(ts) || (threadTs !== null && !SLACK_TS.test(threadTs))) {
    return { ...out, drop: 'malformed' };
  }
  if (threadTs === null || threadTs === ts) return { ...out, drop: 'not_in_thread' };
  const text = capText(wellFormed(String(event.text ?? '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim()), SHARE_LIMITS.questionChars);
  if (!text) return { ...out, drop: 'empty' };
  out.question = {
    team_id: teamId, event_id: eventId, channel_id: channelId, thread_ts: threadTs, message_ts: ts, text,
    message_key: questionKey(teamId, channelId, ts),
  };
  return out;
}

// ---------------------------------------------------------------------
// Reply formatting: redacted by the service redactor, escaped for Slack
// (&, <, > so an answer cannot mention or broadcast), well-formed, and at
// most SHARE_LIMITS.replyChars (3000) characters, never splitting a
// surrogate pair or an escape.

function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const amp = text.lastIndexOf('&', end - 1);
  if (amp !== -1 && amp >= end - 4 && text.indexOf(';', amp) >= end) end = amp;
  return `${text.slice(0, end)}…`;
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatReply(answer: string): string {
  return capText(escapeSlack(wellFormed(serviceRedactor().text(answer))), SHARE_LIMITS.replyChars);
}

// ---------------------------------------------------------------------
// The relay.

export type RelayOutcome =
  | { envelope_id: string | null; outcome: 'dropped'; reason: DropReason }
  | { envelope_id: string; outcome: 'duplicate_delivery' | 'duplicate_event' }
  | { envelope_id: string; outcome: 'duplicate_question'; share_ref: string }
  | { envelope_id: string | null; outcome: 'dispatched' | 'replayed'; share_ref: string; turn_ref: string; replied: Promise<{ ts: string } | null> }
  | { envelope_id: string | null; outcome: 'refused'; share_ref: string; code: string }
  | { envelope_id: string | null; outcome: 'pending'; share_ref: string };

export interface RecoveryResult {
  // Pending questions sent through askShare (dispatched or replayed).
  dispatched: number;
  // Pending questions askShare refused (a notice is posted).
  refused: number;
  // Answers of earlier turns, already finished, posted now.
  replied: number;
}

export interface SlackRelayOptions {
  transport: SlackTransport;
  // The relay's own Slack user: its messages are never questions.
  botUserId: string;
  now?: () => number;
  // Where an unexpected background failure is reported (default console).
  onError?: (error: unknown) => void;
}

export interface SlackRelay {
  start(): Promise<RecoveryResult>;
  stop(): Promise<void>;
  bindShare(shareRef: string): Promise<{ thread: ShareThreadRow; created: boolean }>;
  handleEnvelope(envelope: SocketModeEnvelope): Promise<RelayOutcome>;
  recover(): Promise<RecoveryResult>;
  flushReplies(): Promise<number>;
  idle(): Promise<void>;
}

export function shareThread(shareRef: string): ShareThreadRow | undefined {
  return db.prepare('SELECT * FROM slack_share_threads WHERE share_ref = ?').get(shareRef) as ShareThreadRow | undefined;
}

// The only routing lookup: the exact (team, channel, thread) of an anchor.
function threadAt(teamId: string, channelId: string, threadTs: string): ShareThreadRow | undefined {
  return db.prepare('SELECT * FROM slack_share_threads WHERE team_id = ? AND channel_id = ? AND thread_ts = ?')
    .get(teamId, channelId, threadTs) as ShareThreadRow | undefined;
}

function questionByKey(messageKey: string): QuestionRow | undefined {
  return db.prepare('SELECT * FROM slack_questions WHERE message_key = ?').get(messageKey) as QuestionRow | undefined;
}

export function createSlackRelay(options: SlackRelayOptions): SlackRelay {
  const { transport, botUserId } = options;
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? ((error: unknown) => console.error('Slack relay:', error instanceof Error ? error.message : 'unknown error'));
  // Questions this process is dispatching or replying to right now.
  const dispatching = new Set<string>();
  const posting = new Set<string>();
  const binding = new Map<string, Promise<{ thread: ShareThreadRow; created: boolean }>>();
  const background = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => {});
    return promise;
  }

  async function bindShare(shareRef: string): Promise<{ thread: ShareThreadRow; created: boolean }> {
    const existing = shareThread(shareRef);
    if (existing) return { thread: existing, created: false };
    const pending = binding.get(shareRef);
    if (pending) return pending;
    const run = (async () => {
      const row = shareRow(shareRef);
      if (!row) throw new ShareError('share_not_found', 'No share with that reference.');
      const state = shareState(row);
      if (state === 'revoked') throw new ShareError('share_revoked', 'This share was revoked.');
      if (state === 'expired') throw new ShareError('share_expired', 'This share has expired.');
      const audience = { kind: 'slack' as const, team_id: row.audience_team_id, channel_id: row.audience_channel_id };
      if (!audienceAllowed(audience)) throw new ShareError('audience_not_allowed', 'That Slack channel is not on the share allowlist. Add it in Agent Config, under Session sharing.');
      const posted = await transport.post({
        channel: audience.channel_id, thread_ts: null, text: shareToolAccess(row) === 'full_access' ? FULL_ACCESS_ANCHOR_TEXT : ANCHOR_TEXT,
        metadata: { event_type: ANCHOR_EVENT_TYPE, event_payload: { share_ref: row.id } },
      });
      if (typeof posted?.ts !== 'string' || !SLACK_TS.test(posted.ts)) throw new Error('The transport returned no message ts for the anchor.');
      db.prepare('INSERT INTO slack_share_threads (share_ref, session_ref, team_id, channel_id, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.session_ref, audience.team_id, audience.channel_id, posted.ts, now());
      return { thread: shareThread(row.id) as ShareThreadRow, created: true };
    })();
    binding.set(shareRef, run);
    try {
      return await run;
    } finally {
      binding.delete(shareRef);
    }
  }

  type Persisted =
    | { kind: 'duplicate_delivery' }
    | { kind: 'dropped'; reason: DropReason }
    | { kind: 'duplicate_event' }
    | { kind: 'duplicate_question'; share_ref: string }
    | { kind: 'accepted'; question: QuestionRow };

  // Everything decided about one delivery, committed before its ack.
  const persist = db.transaction((n: NormalizedEnvelope): Persisted => {
    const delivery = n.delivery as NonNullable<NormalizedEnvelope['delivery']>;
    const seen = db.prepare('SELECT 1 FROM slack_deliveries WHERE envelope_id = ? AND retry_attempt = ?').get(delivery.envelope_id, delivery.retry_attempt);
    if (seen) return { kind: 'duplicate_delivery' };
    const at = now();
    const write = (disposition: string, extra: { owner?: boolean; reason?: string | null; messageKey?: string | null; shareRef?: string | null }) => {
      db.prepare(`
        INSERT INTO slack_deliveries (envelope_id, retry_attempt, retry_reason, team_id, event_id, event_owner, message_key, share_ref, disposition, reason, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delivery.envelope_id, delivery.retry_attempt, delivery.retry_reason, n.event?.team_id ?? null, n.event?.event_id ?? null,
        extra.owner && n.event ? 1 : null, extra.messageKey ?? null, extra.shareRef ?? null, disposition, extra.reason ?? null, at,
      );
    };
    if (n.event) {
      const owned = db.prepare('SELECT 1 FROM slack_deliveries WHERE team_id = ? AND event_id = ? AND event_owner = 1').get(n.event.team_id, n.event.event_id);
      if (owned) {
        write('duplicate_event', {});
        return { kind: 'duplicate_event' };
      }
    }
    const drop = (reason: DropReason, shareRef: string | null = null): Persisted => {
      write('dropped', { owner: true, reason, shareRef });
      return { kind: 'dropped', reason };
    };
    if (n.drop || !n.question) return drop(n.drop ?? 'malformed');
    const q = n.question;
    if (!audienceAllowed({ kind: 'slack', team_id: q.team_id, channel_id: q.channel_id })) return drop('audience_not_allowed');
    const thread = threadAt(q.team_id, q.channel_id, q.thread_ts);
    if (!thread) return drop('share_thread_unknown');
    if (questionByKey(q.message_key)) {
      write('duplicate_question', { owner: true, messageKey: q.message_key, shareRef: thread.share_ref });
      return { kind: 'duplicate_question', share_ref: thread.share_ref };
    }
    db.prepare(`
      INSERT INTO slack_questions (team_id, channel_id, message_ts, message_key, thread_ts, share_ref, event_id, question, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(q.team_id, q.channel_id, q.message_ts, q.message_key, q.thread_ts, thread.share_ref, q.event_id, q.text, at, at);
    write('accepted', { owner: true, messageKey: q.message_key, shareRef: thread.share_ref });
    return { kind: 'accepted', question: questionByKey(q.message_key) as QuestionRow };
  });

  async function postNotice(q: QuestionRow): Promise<void> {
    const code = q.code ?? 'unknown';
    const posted = await transport.post({
      channel: q.channel_id, thread_ts: q.thread_ts, text: noticeText(code),
      metadata: { event_type: NOTICE_EVENT_TYPE, event_payload: { share_ref: q.share_ref, code } },
    });
    db.prepare('UPDATE slack_questions SET reply_ts = ?, updated_at = ? WHERE message_key = ? AND reply_ts IS NULL').run(posted.ts, now(), q.message_key);
  }

  // Posts the answer of a dispatched question once its turn finished; null
  // while it runs (a later flushReplies posts it).
  async function deliverReply(messageKey: string): Promise<{ ts: string } | null> {
    if (posting.has(messageKey)) return null;
    posting.add(messageKey);
    try {
      const q = questionByKey(messageKey);
      if (!q || q.state !== 'dispatched' || !q.turn_ref || q.reply_ts) return null;
      let text: string;
      try {
        const turn = await shareAnswer(q.share_ref, q.turn_ref);
        if (!turn) return null;
        text = turn.state === 'completed' && turn.answer !== null ? formatReply(turn.answer) : FAILED_TEXT;
      } catch (error) {
        if (!(error instanceof ShareError)) throw error;
        text = FAILED_TEXT;
      }
      const posted = await transport.post({
        channel: q.channel_id, thread_ts: q.thread_ts, text,
        metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { share_ref: q.share_ref, turn_ref: q.turn_ref } },
      });
      db.prepare("UPDATE slack_questions SET state = 'replied', reply_ts = ?, updated_at = ? WHERE message_key = ? AND state = 'dispatched'")
        .run(posted.ts, now(), messageKey);
      return posted;
    } finally {
      posting.delete(messageKey);
    }
  }

  // One pending question -> one askShare with its question key.
  async function dispatch(q: QuestionRow, envelopeId: string | null): Promise<RelayOutcome> {
    if (dispatching.has(q.message_key)) return { envelope_id: envelopeId, outcome: 'pending', share_ref: q.share_ref };
    dispatching.add(q.message_key);
    try {
      let asked: Awaited<ReturnType<typeof askShare>>;
      try {
        asked = await askShare({ shareRef: q.share_ref, question: q.question ?? '', messageKey: q.message_key });
      } catch (error) {
        if (!(error instanceof ShareAskError)) throw error;
        db.prepare("UPDATE slack_questions SET state = 'refused', code = ?, question = NULL, updated_at = ? WHERE message_key = ? AND state = 'pending'")
          .run(error.code, now(), q.message_key);
        await postNotice(questionByKey(q.message_key) as QuestionRow);
        return { envelope_id: envelopeId, outcome: 'refused', share_ref: q.share_ref, code: error.code };
      }
      const turnRef = asked.turn.turn_ref;
      db.prepare("UPDATE slack_questions SET state = 'dispatched', turn_ref = ?, question = NULL, updated_at = ? WHERE message_key = ? AND state = 'pending'")
        .run(turnRef, now(), q.message_key);
      const replied = track(asked.settled.then(() => deliverReply(q.message_key)).catch(error => {
        onError(error);
        return null;
      }));
      return { envelope_id: envelopeId, outcome: asked.replayed ? 'replayed' : 'dispatched', share_ref: q.share_ref, turn_ref: turnRef, replied };
    } finally {
      dispatching.delete(q.message_key);
    }
  }

  async function handleEnvelope(envelope: SocketModeEnvelope): Promise<RelayOutcome> {
    const n = normalizeSlackEnvelope(envelope, { botUserId });
    // No delivery identity: nothing can be recorded or acknowledged.
    if (!n.delivery) return { envelope_id: null, outcome: 'dropped', reason: 'malformed' };
    const envelopeId = n.delivery.envelope_id;
    const persisted = persist.immediate(n);
    // The ledger row is durable; only now is Slack told it was received. A
    // failed ack propagates: the question stays pending until a restart's
    // recover() (or Slack's redelivery is recognized as a duplicate).
    await transport.ack(envelopeId);
    if (persisted.kind !== 'duplicate_delivery') {
      db.prepare('UPDATE slack_deliveries SET acked_at = ? WHERE envelope_id = ? AND retry_attempt = ? AND acked_at IS NULL')
        .run(now(), envelopeId, n.delivery.retry_attempt);
    }
    switch (persisted.kind) {
      case 'duplicate_delivery':
      case 'duplicate_event':
        return { envelope_id: envelopeId, outcome: persisted.kind };
      case 'dropped':
        return { envelope_id: envelopeId, outcome: 'dropped', reason: persisted.reason };
      case 'duplicate_question':
        return { envelope_id: envelopeId, outcome: 'duplicate_question', share_ref: persisted.share_ref };
      case 'accepted':
        return dispatch(persisted.question, envelopeId);
    }
  }

  async function flushReplies(): Promise<number> {
    const open = db.prepare("SELECT message_key FROM slack_questions WHERE state = 'dispatched' AND reply_ts IS NULL ORDER BY created_at, message_key").all() as { message_key: string }[];
    let posted = 0;
    for (const { message_key } of open) if (await deliverReply(message_key)) posted++;
    return posted;
  }

  // Resumes what a previous process left: pending questions are dispatched
  // with their original key, unposted notices and answers are posted.
  async function recover(): Promise<RecoveryResult> {
    const result: RecoveryResult = { dispatched: 0, refused: 0, replied: 0 };
    const pending = db.prepare("SELECT * FROM slack_questions WHERE state = 'pending' ORDER BY created_at, message_key").all() as QuestionRow[];
    for (const q of pending) {
      // A dispatched answer is posted when its turn settles (idle() waits).
      const out = await dispatch(q, null);
      if (out.outcome === 'dispatched' || out.outcome === 'replayed') {
        result.dispatched++;
      } else if (out.outcome === 'refused') {
        result.refused++;
      }
    }
    const unposted = db.prepare("SELECT * FROM slack_questions WHERE state = 'refused' AND reply_ts IS NULL ORDER BY created_at, message_key").all() as QuestionRow[];
    for (const q of unposted) await postNotice(q);
    result.replied += await flushReplies();
    return result;
  }

  async function start(): Promise<RecoveryResult> {
    const recovered = await recover();
    await transport.start(async envelope => {
      try {
        await handleEnvelope(envelope);
      } catch (error) {
        onError(error);
      }
    });
    return recovered;
  }

  async function idle(): Promise<void> {
    while (background.size > 0) await Promise.allSettled([...background]);
  }

  return { start, stop: () => transport.stop(), bindShare, handleEnvelope, recover, flushReplies, idle };
}
