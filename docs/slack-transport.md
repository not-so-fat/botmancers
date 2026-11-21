# Slack transport: native Socket Mode in the core server

Status: NOT-518. Code: `lib/slack-transport.ts` (the four-method
`SlackTransport` over `@slack/socket-mode` and `@slack/web-api`),
`lib/slack-runtime.ts` (configuration, states, lifecycle), `instrumentation.ts`
(start/stop in the core server process). Tests: `npm run test:slack-transport`
(with `tests/support/fake-slack-server.js`). Operator smoke:
`npm run smoke:slack-relay`. Design:
[`design/2026-10-24-session-share-preflight.md`](design/2026-10-24-session-share-preflight.md)
§5. Relay: [`slack-relay.md`](slack-relay.md). Owner lifecycle and the
`botmancers doctor` Slack line: [`session-shares.md`](session-shares.md).

The relay (NOT-516) depends only on `SlackTransport`. This module supplies the
production implementation and runs it inside the core server: no Bolt, no
HTTP receiver, no OAuth installation, no Pantalk sidecar, no second process.

## Dependencies and licenses

| Package | Range | Locked | License |
|---|---|---|---|
| `@slack/socket-mode` | `^2.0.7` | 2.0.7 | MIT |
| `@slack/web-api` | `^7` | 7.19.0 | MIT |

Their production closure (`@slack/logger`, `@slack/types`, `ws`,
`eventemitter3`, `axios`, `form-data`, `p-queue`, `p-retry`, `retry`, …) is
MIT throughout; `test-slack-transport.js` walks the lockfile and fails on any
other license and on any Bolt, `@slack/oauth`, Express, or Pantalk entry. The
Next build keeps both packages external (`serverExternalPackages`), and the
standalone trace ships them in the package's `app/node_modules`.

## The transport

| Method | Over | Behavior |
|---|---|---|
| `start(onEnvelope)` | `SocketModeClient.start()` | Hands every `events_api` envelope to the relay as `{ envelope_id, type, accepts_response_payload, retry_attempt, retry_reason, payload }`: `retry_attempt` is the SDK's `retry_num`, the payload is the object Slack sent (team, `event_id`, channel, thread, user, message ts untouched). Other envelope types are neither handled nor acknowledged. |
| `ack(envelope_id)` | `SocketModeClient.send(envelope_id)` | The relay calls it only after the delivery row committed, and before `askShare`. |
| `post(message)` | `chat.postMessage` | Channel, `thread_ts` (omitted for an anchor), text, and the relay's metadata unchanged; unfurls off; text over 3000 characters is refused. Works before the socket connects (recovery posts first). |
| `stop()` | `SocketModeClient.disconnect()` | Stops listening, waits (bounded) for envelopes being handled, then disconnects. The SDK never reconnects after `disconnect()`; `ack`/`post` are refused afterwards. |

Reconnects are the SDK's: a socket close, or a Slack `disconnect` message
(pod recycle, `refresh_requested`), reconnects with backoff unless `stop()`
ran. Slack redelivers whatever was not acknowledged; the relay's ledgers
recognize the redelivery (`duplicate_delivery` / `duplicate_event`), so no
question is dispatched twice.

Every error leaving the transport is a `SlackTransportError` with a `code`
(`slack_connect_failed`, `slack_ack_failed`, `slack_post_failed`,
`slack_post_too_long`, `slack_auth_failed`, `slack_transport_stopped`, …) and
the Slack error string (`invalid_auth`, `channel_not_found`, …) at most; never
the SDK error, whose request config carries the `Authorization` header. The
SDK clients log through a logger that drops debug and info (where the SDK
prints payloads) and redacts both tokens and any token-shaped string.

## Configuration and states

Slack starts only when **both** credentials and a **valid** share
configuration are present:

| Variable | Token | Scopes |
|---|---|---|
| `BOTMANCERS_SLACK_APP_TOKEN` | app-level `xapp-…` | `connections:write` |
| `BOTMANCERS_SLACK_BOT_TOKEN` | bot `xoxb-…` | `chat:write`, `channels:history` (and `groups:history` for private channels) |

The Slack app needs Socket Mode enabled and the bot event `message.channels`
(`message.groups` for private channels); `app_mention` is optional. Invite the
bot to every allowlisted channel. Set both variables in
`<BOTMANCERS_HOME>/config/core.env` (owner-only, 0600) or in the shell that
runs `botmancers start`. Only the core process receives them: the managed
start removes both from the MCP bridge's environment, and the CLI's output
redactor knows both. Both names match `CREDENTIAL_ENV` in
`lib/service-redaction.ts`, so their values are redacted from everything a
service is shown.

`slackRuntimeStatus()` (and `GET /api/health` → `slack`) reports one stable
`state` and `reason`, never a token:

| State | Reason | When |
|---|---|---|
| `disabled` | `slack_tokens_absent` | neither variable set |
| `misconfigured` | `app_token_missing`, `bot_token_missing` | only one set |
| `misconfigured` | `app_token_invalid`, `bot_token_invalid` | not `xapp-…` / `xoxb-…` |
| `misconfigured` | `share_config_absent`, `share_config_invalid`, `share_config_no_audience` | `session-shares.json` missing, invalid (fail-closed rules of NOT-515), or with no audience |
| `misconfigured` | `workspace_not_allowlisted` | the bot's workspace (`auth.test`) has no allowlisted audience |
| `failed` | `slack_auth_failed`, `slack_connect_failed` | `auth.test` or `apps.connections.open` refused |
| `connecting`, `connected`, `reconnecting`, `stopped` | — | lifecycle |

Configuration is read at server start; restart Botmancers after changing the
tokens. (The share allowlist itself is re-read on every relay decision.)

## Lifecycle

`instrumentation.ts` runs `startSlackRuntime()` once when the core server
starts (Node runtime only; `BOTMANCERS_NO_AUTOPROCESS=1` keeps it off) and
`stopSlackRuntime()` on `SIGTERM`/`SIGINT`. While connected, these run one at
a time, so a recovery never races an envelope for the same question:

- each envelope: `relay.handleEnvelope` (persist → ack → `askShare` → reply);
- recovery (`relay.recover`): at start, and after every reconnect (a
  question whose ack failed while the socket was down is still pending, and
  its redelivery is only a duplicate event);
- a sweep every 5 s: every active share of the bot's workspace with no
  anchor thread is bound (`relay.bindShare` posts its anchor; a share that
  cannot be bound is retried after a minute), and late answers are flushed.

Shutdown changes no relay row. A pending question, an unposted notice, or an
answer that finished after shutdown is completed exactly once by the next
start's recovery, with the question's original pin-turn key.

## Operator smoke (real workspace)

Records one share-thread round trip, a forced reconnect, and Slack's
redelivery, in a redacted transcript.

1. Prepare a Slack app (Socket Mode on, scopes and event above, installed to
   the workspace), invite the bot to one channel, and allowlist that channel
   in `<BOTMANCERS_HOME>/config/session-shares.json` (0600):
   `{ "version": 1, "audiences": [{ "kind": "slack", "team_id": "T…", "channel_id": "C…" }] }`.
2. Pick one resumable session's Botmancers `session_ref` (Sessions page or
   `GET /api/v0/agents/{id}/sessions`).
3. Stop the core server (`botmancers stop`) or run it without the Slack
   tokens: two Socket Mode connections would split the events. The smoke
   refuses to run while `/api/health` reports a live Slack connection.
4. Run from the checkout, with the tokens only in the environment:

   ```sh
   BOTMANCERS_SLACK_APP_TOKEN=… BOTMANCERS_SLACK_BOT_TOKEN=… \
     npm run smoke:slack-relay -- --session <session_ref> --out /tmp/not-518-smoke.txt
   ```

5. When step 4 prints, reply once, as a person, in the anchor thread.

The smoke creates one ask-only share (TTL 30 min, 3 turns), waits for its
anchor, records the reply, **withholds that envelope's ack** after the relay
recorded it, waits for the correlated Botmancers reply in the thread, closes
the socket as a Slack `disconnect` does and waits for the reconnect, waits for
Slack's redelivery (`retry_attempt ≥ 1`, recorded `duplicate_event`), checks
exactly one provider turn on the share's pin and one reply, stops (no
reconnect), and revokes the share (`--keep-share` keeps it). `RESULT PASS`
ends a good run.

The transcript replaces the workspace, channel, user, and bot ids and every
message ts, never prints a token, and reports question and answer text by
length only; it starts with the exact `HEAD` SHA. Commit it as
`docs/evidence/NOT-518/slack-relay-smoke.txt` after reading it once more for
anything workspace-specific. (`--slack-api-url` points the smoke at a local
fake Slack to rehearse the script; such a transcript says `REHEARSAL` and is
not a workspace proof.)
