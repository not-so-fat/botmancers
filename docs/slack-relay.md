# Slack relay core: one thread asks one shared session

Status: NOT-516. Code: `lib/slack-relay.ts` (normalization, ledgers, routing,
replies, the `SlackTransport` interface), `test-support/fake-slack-transport.js`
(deterministic fake). Contract test: `npm run test:slack-relay`. Design:
[`design/2026-10-24-session-share-preflight.md`](design/2026-10-24-session-share-preflight.md)
§4 and §5; fixtures:
[`contracts/slack-relay-v0.fixtures.json`](contracts/slack-relay-v0.fixtures.json).

The relay turns human replies in one Slack thread into read-only questions to
exactly one [session share](service-access.md#session-shares-not-515) and
posts the answer back in that thread. It owns no share authority: every
question goes through NOT-515's internal `askShare`, which applies the
audience allowlist, expiry, revocation, turn limit, in-flight guard,
redaction, and the `shares.ask` audit. The relay never calls the session-pin
endpoints and never selects a session itself.

This module holds no Slack SDK, credential, or server lifecycle. The native
Socket Mode adapter (`@slack/socket-mode`, `@slack/web-api`), its tokens, its
start/stop wiring, and the operator smoke are NOT-518's:
[`slack-transport.md`](slack-transport.md).

## The transport boundary

```ts
interface SlackTransport {
  start(onEnvelope: (e: SocketModeEnvelope) => Promise<void>): Promise<void>; // events_api only
  ack(envelopeId: string): Promise<void>;
  post(m: SlackPost): Promise<{ ts: string }>;
  stop(): Promise<void>;
}
```

`createSlackRelay({ transport, botUserId })` returns `start` (recover, then
start the transport), `stop`, `bindShare(shareRef)`, `handleEnvelope`,
`recover`, `flushReplies`, and `idle`.

## Binding: one anchor thread per share

`bindShare(shareRef)` posts one top-level anchor message in the share's
allowlisted channel (fixed text: the read-only wording, or, for a share the
owner gave full access, one that says the session can edit files, run shell
commands, and use the network; metadata
`{ event_type: "botmancers_share", event_payload: { share_ref } }`) and
records `slack_share_threads (share_ref → session_ref, team_id, channel_id,
thread_ts)`. Binding again returns the same row and posts nothing; an unknown,
revoked, or expired share, or an audience no longer on the allowlist, is not
bound. Binding dispatches nothing and writes no service audit.

The only routing lookup is the exact `(team_id, channel_id, thread_ts)` of an
anchor. Nothing is routed by channel alone, text, session title, activity,
"latest", provider id, or workspace; several shares can live in one channel.

## Envelope path

```
normalize -> persist (one commit) -> ack -> askShare -> reply
```

**Dropped** (a `dropped` delivery row only; no service call, no service
audit): non-`events_api` envelopes, non-message events, bot or own messages,
edits and every other subtype, top-level messages (no `thread_ts`, or the
anchor itself), empty text after removing mentions, channels off the owner's
allowlist (`audience_not_allowed`), and threads with no share
(`share_thread_unknown`).

## Ledgers and identities

Each identity has its own column and constraint:

| Identity | Ledger | Constraint |
|---|---|---|
| delivery `(envelope_id, retry_attempt)` | `slack_deliveries` | primary key; a repeated delivery is acked and ignored |
| event `(team_id, event_id)` | `slack_deliveries.event_owner` | unique: one owning delivery per event; a retry is a `duplicate_event` row |
| question `(team_id, channel_id, message_ts)` | `slack_questions` | primary key; the same message as `message` and `app_mention` is a `duplicate_question` row |

The question key, hashed (`questionKey`), is also the pin-turn idempotency key
(`turn:<key>`) that `askShare` passes to NOT-507, so even a lost relay ledger
replays the original turn instead of dispatching again.

**Durability.** The delivery row (and the `pending` question) commit before
the ack. A crash before or after the ack leaves the question `pending`;
`start()`/`recover()` re-dispatches every pending question with its original
key, posts unposted refusal notices, and posts answers of turns that
finished meanwhile. The question text is kept only while `pending`.

## Replies and notices

- **Answer:** posted in the asking thread with metadata
  `{ event_type: "botmancers_share_reply", event_payload: { share_ref, turn_ref } }`
  and nothing else. The text passes through the service redactor, is escaped
  for Slack (`&`, `<`, `>`: no mention or broadcast), drops lone surrogates,
  and is cut at 3000 characters without splitting a surrogate pair or an
  escape. A failed turn posts a fixed failure text with the same metadata.
- **Refusal:** `share_expired`, `share_revoked`, `share_turn_limit`,
  `share_turn_in_progress`, `source_session_busy` (and a generic text for any
  other code) post a fixed notice with
  `{ event_type: "botmancers_share_notice", event_payload: { share_ref, code } }`.
  Notices never name the session, Agent, provider, workspace, or turn count.
  A refusal from the share's state is one denied `shares.ask` audit and no
  provider send.
