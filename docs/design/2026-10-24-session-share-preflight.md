# Session shares: exact-session self-identification and the Slack relay seam

Status: **accepted decision record for NOT-514** (investigation), now implemented by NOT-515 to NOT-519. The current behavior is owned by [service-grants.md](../service-grants.md), [slack-relay.md](../slack-relay.md), [slack-transport.md](../slack-transport.md), and [session-shares.md](../session-shares.md); read this record for why, not for what ships. The probes, the offline reference model, and the focused test remain.

- **HEAD:** `8e19aa24e51aeb4a26bf4d9a057ae2012daadc3b`. The ticket's `2bcf469` is not in this clone.
- **Evidence:** [identity matrix](../evidence/NOT-514/identity-matrix.json), [probe results](../evidence/NOT-514/probe-results.md), [contract sketch](../contracts/session-share-v0.sketch.json), [Slack fixtures](../contracts/slack-relay-v0.fixtures.json).
- **Test:** `npm run test:session-share-preflight` ([`test-session-share-preflight.js`](../../test-session-share-preflight.js), using [`test-support/session-share-model.js`](../../test-support/session-share-model.js)).
- **Builds on:** NOT-499 (grants, audit, redaction), NOT-500/NOT-507 (MCP v2, exact-session pins), NOT-503–506 (providers).

## Question

A user says to their coding agent: "share this session." Can Botmancers identify that session exactly, for Claude Code, Codex, and Cursor? It must not guess from the cwd, activity time, title, or "latest". And where should the Slack relay attach so that a Slack thread asks exactly one Botmancers session?

## Answer

1. **`session_ref` is the universal input.** Every client can share any session it is granted. It does so explicitly: `botmancers_list_sessions` → `botmancers_create_share { session_ref }`.
2. **Share-current exists only inside a Botmancers launch.** It works only where Botmancers itself launched the turn, and only from context Botmancers minted for that launch. Botmancers writes the launch's MCP entry with a `Botmancers-Session-Context` header that carries a random, hashed, launch-bound token. The client's ambient identity is never trusted:
   - Claude Code: per-turn `--mcp-config`.
   - Codex: per-thread `config.mcp_servers` on the app-server; `-c` for exec.
   - Cursor: unsupported, because no per-launch MCP seam exists.

   Everything else answers `session_context_required` with a reason.
3. **Shares reuse NOT-507.** A share is one read-only Ask pin on exactly one `session_ref`, with a TTL and a turn limit, that the owner can revoke. The Slack relay's principal holds no Agent grant: the share is its only authority, so long-lived grants are not broadened.
4. **Transport: native.** `@slack/socket-mode` 2.0.7 plus `@slack/web-api` 7.x, both MIT, behind a four-method `SlackTransport` adapter. Not Bolt (its HTTP/OAuth weight is a non-goal) and not Pantalk (not verifiable offline; see below).

## 1. Provider identity matrix

Measured with the redacted probes against Claude Code 2.1.309, Codex 0.157.1, and Cursor CLI 2026.10.16. "Share-current" is the convenience call. Explicit `session_ref` works in every cell.

| Case | Claude Code | Codex | Cursor |
|---|---|---|---|
| Ambient signal | `CLAUDE_CODE_SESSION_ID` (stdio MCP only) | none in the MCP env | `session_id` in stream-json output only |
| New session | env = chosen id ✔ · share-current **exact** (minted) | no ambient id · **exact** (minted) | fail closed |
| Exact resume | env = resumed id ✔ · **exact** | new process sees the new context ✔ · **exact** | fail closed |
| Implicit resume (`--continue` / `--last`) | **env ≠ the conversation continued** · fail closed | Botmancers never uses `--last` · fail closed | fail closed |
| Clear / reset | spawn-time env can outlive `/clear` (documented; not headless) · fail closed | new TUI thread has no context · fail closed | fail closed |
| Client restart | each Botmancers turn is a new process with a new context · **exact** | app-server restart reloads with a new context · **exact** | fail closed |
| Not launched by Botmancers | env present but not adopted · fail closed | fail closed | fail closed |
| **Classification** | **supported when Botmancers launches** | **supported when Botmancers launches** | **unsupported** |

Why no ambient id is adopted, even where one exists:

- **Claude Code.** Under `--continue`, the MCP subprocess receives a fresh id while the run continues the old session (probe `continue`). Trusting `CLAUDE_CODE_SESSION_ID` would share the wrong session. It also reaches only stdio subprocesses, while the Botmancers bridge is HTTP. And translating it would send a raw provider id across the API boundary.
- **Codex.** There is nothing to adopt.
- **Cursor.** It has no per-invocation MCP configuration. The only seams are the user's repository `.cursor/mcp.json` or the shared `~/.cursor/mcp.json`. Neither is per session, and writing to either is out of bounds. Upgrade trigger: see the matrix.

## 2. Binding mechanism (frozen)

**The context.**

- Format: `bmsc_` followed by 256 random bits (base64url).
- Storage: only its SHA-256.
- Binding: one `(agent_id, session_ref, launch)`. Botmancers mints it only while the owner has enabled **share-from-turn** for that Agent.
- Delivery: as an HTTP header on the MCP entry Botmancers writes for that launch, pointed at Botmancers' own `/api/v0/mcp`. The model never sees it, and no tool argument carries it.
- Credential: it is the *only* credential for the reserved principal `service:botmancers-session-context`. That principal can call share-current and nothing else in v0. It is never a token id or a grants entry, and it is refused in the grants document like `botmancers-exchanges`.

| Runtime | Launch unit (= context lifetime) | Delivery | Probe |
|---|---|---|---|
| Claude Code | one `claude -p` turn process | `--mcp-config <0600 file>` http entry; `headers: { "Botmancers-Session-Context": "${BOTMANCERS_SESSION_CONTEXT}" }`; value in the turn env, never argv | `new_http_header_context`: every request carried it |
| Codex app-server | one thread **load** into Botmancers' app-server (`thread/start`, or the first `thread/resume` in that process) | `config.mcp_servers.botmancers = { url, http_headers }` | two threads on one process each saw only their own value; a resume in a new process saw the new one; **a second resume of a loaded thread spawns no new MCP**, hence load-scoped, not turn-scoped |
| Codex exec fallback | one process | `-c mcp_servers.botmancers.*` | `exec`: delivered |
| Cursor | — | none | — |

A context is valid while its launch is live and a Botmancers turn on its `session_ref` is running, for at most 15 minutes after the last such turn. It is revoked when the launch ends (turn process exit, thread unload, app-server exit) or when the owner turns share-from-turn off. Because it names one `session_ref`, a stale or replayed token can fail closed but can never point at another session.

### Contract examples (all exercised by the test)

`POST /api/v0/shares/current` with header `Botmancers-Session-Context: bmsc_…` and body `{ "audience": { "kind": "slack", "team_id": "T…", "channel_id": "C…" }, "ttl_seconds": 3600, "idempotency_key": "…" }` returns `201 { share: { share_ref, session_ref, authority: "ask", state: "active", created_via: "current_session", … } }`.

| Caller context | Result |
|---|---|
| missing header | `409 session_context_required`, `reason: missing`, `recovery: choose_session` |
| two values (repeated or comma-joined) | `… reason: ambiguous` |
| a provider id (UUID, chat id, path) instead of a minted token | `… reason: unsupported`; the value is never echoed |
| well-formed but never minted | `… reason: unknown` |
| launch ended / token expired | `… reason: stale` |
| context revoked, or share-from-turn off for the Agent | `… reason: revoked` |
| `agent_id` given and not the context's Agent | `404 session_not_found` (NOT-499: identical to missing) |
| the session can no longer take an Ask | NOT-507's code: `session_ended` / `session_missing` / `session_not_resumable` |
| a granted service calls share-current | `400 invalid_request`: the context, not a service token, is the credential |
| share-current with a `session_ref` too | `400 invalid_request` |
| any of `provider_session_id, external_session_id, claude_session_id, codex_thread_id, cursor_chat_id, cwd, workspace, latest, most_recent, title, title_match, active_since` | `403 authority_not_allowed` |

**Rejected outright:**

- selecting a session by cwd, workspace, activity time, title similarity, or the provider's "latest/continue";
- trusting `CLAUDE_CODE_SESSION_ID` or a Cursor `session_id`;
- client-supplied provider ids, whether raw or hashed;
- MCP `clientInfo`.

## 3. Public surface (frozen sketch)

The full field, limit, and error list is in [`session-share-v0.sketch.json`](../contracts/session-share-v0.sketch.json).

| REST | MCP | Authority | Audit operation |
|---|---|---|---|
| `POST /api/v0/sessions/{session_ref}/shares` | `botmancers_create_share` | `shares:create` (new grant capability, per Agent; never implied by `sessions:message`) | `shares.create` |
| `POST /api/v0/shares/current` | `botmancers_share_current_session` | live minted context + owner's share-from-turn | `shares.create` |
| `GET /api/v0/shares/{share_ref}` | `botmancers_get_share` | `shares:create`, own shares | `shares.read` |
| `GET /api/v0/shares?session_ref&state&cursor&limit` | `botmancers_list_shares` | same; NOT-499 list rules | `shares.list` |
| `POST /api/v0/shares/{share_ref}/revoke` | `botmancers_revoke_share` | same; idempotent | `shares.revoke` |
| owner UI routes (loopback) | — | owner: every share | — |
| internal `SessionShare.ask` (Slack relay only) | — | the share itself | `shares.ask` |

Fixed rules:

- **TTL:** 300 s to 86 400 s, default 3600.
- **`max_turns`:** 1–100, default 20.
- **Authority:** always `ask` (read-only).
- **Audience:** must be on the owner's allowlist.
- **Idempotency:** NOT-499 rules (exact replay is `200`; the same key with another body is `409 idempotency_conflict`).
- **Never in any view:** provider ids, cwd, Deck or runtime, credentials, transcripts.

### Traceability

| Responsibility | Owner |
|---|---|
| `session_ref` → Agent | existing `lib/session-pins` `sessionOwner` / `lib/provider-sessions` |
| eligibility (ended / missing / not resumable / busy) | existing `lib/session-actions` via `createPin` |
| one Ask on exactly one session; turn idempotency; answers | existing NOT-507 `createPin` / `sendPinTurn` / `readPin`. A share **is** one ask pin, requested by the relay principal. |
| service auth, rate limit, audited wrapper | existing `serveAs` (`lib/service-api-http`) |
| audit rows | existing `lib/service-audit`, `target_kind: session`, new `shares.*` operation words. No schema change. |
| redaction | existing `serviceRedactor`, **plus finding R1** |
| grant vocabulary | existing `lib/service-grants`: `shares:create` and one reserved id |
| MCP schemas | existing `lib/mcp-bridge-v2` and `docs/contracts/mcp-bridge-v2.tools.json`: five tools |
| share rows, events, expiry, revoke, turn limit, in-flight check, audience allowlist, share-from-turn document | **new: SessionShare** (`lib/session-shares.ts`, `config/session-shares.json`) |
| mint / resolve / revoke context; launch injection | **new: SessionContext** (`lib/session-context.ts`, plus the Claude and Codex providers' launch arguments) |
| Slack normalization, ledgers, thread routing, reply posting | **new: Slack relay** (`lib/slack-relay.ts`, `lib/slack-transport.ts`) |

## 4. Slack relay seam (offline fixture)

**Event identity.** Each identity has its own layer:

| Identity | Key | Role |
|---|---|---|
| delivery | `envelope_id`, `retry_attempt` | transport only; acked first |
| event | `(team_id, event_id)` | delivery dedup |
| question | `(team_id, channel, message ts)` | one message arriving as both `message` and `app_mention` is one question |

The question key, hashed, is also the NOT-507 pin-turn idempotency key. So even a lost relay ledger cannot dispatch twice.

**Routing.** Creating a share posts an anchor message in its allowlisted channel. Replies in that thread are its questions: one thread → one share → one `session_ref`. The relay never routes by channel alone, never by text, and never by "latest". Other messages are dropped:

- a channel off the allowlist;
- a thread with no share;
- a bot or self message;
- an edit or other subtype;
- a top-level message.

**Replies.** A reply is posted in the asking thread. It carries Slack message metadata `{ event_type: "botmancers_share_reply", event_payload: { share_ref, turn_ref } }` and is limited to 3000 characters after redaction. Refusals post a fixed notice that reveals nothing about the session.

**Canonical counts** (from `test-session-share-preflight.js`). "Dispatch" counts provider `sendTurn` calls. "Audit" counts rows in `service_audit_events`.

| Delivery | Outcome | Dispatch | Audit |
|---|---|---|---|
| first delivery | dispatched → answer correlated by `(share_ref, turn_ref)` in the thread | +1 | +1 `shares.ask` allowed |
| Slack retry (same `event_id`, `retry_attempt: 1`) | duplicate_event | 0 | 0 |
| same message as `app_mention` (new `event_id`) | duplicate_question | 0 | 0 |
| own bot reply | dropped `not_a_person` | 0 | 0 |
| unauthorized channel | dropped `audience_not_allowed` | 0 | 0 |
| unknown thread | dropped `share_thread_unknown` | 0 | 0 |
| second question while the first runs | refused `share_turn_in_progress` + notice | 0 | +1 denied |
| expired share | refused `share_expired` + notice | 0 | +1 denied |
| revoked share | refused `share_revoked` + notice | 0 | +1 denied |
| relay ledger lost, first delivery again | replayed (same turn) | 0 | +1 allowed `replayed` |

Drops before routing make no service call, so they write no audit row. The relay keeps its own drop log. The Slack relay principal is refused by `POST /api/v0/sessions/{ref}/pins` (`session_not_found`), which proves that a share does not broaden grants.

**Finding R1.** `serviceRedactor` does not treat an Agent's `default_workspace`, or a native session's `workspace`, as private. A runtime that echoes its cwd would therefore leak it to a service, and to Slack. The test records this gap, and the fixture closes it locally. The SessionShare core ticket fixes it in `lib/service-redaction.ts`.

## 5. Transport: native Socket Mode, not Pantalk, not full Bolt

Inspected offline, from the local npm cache. Tarball SHA-256 values:

- `@slack/socket-mode` **2.0.7**: `7630e460…936d`
- `@slack/bolt` **4.7.3**: `455afc51…f0de`

**License.** Both are MIT, like Botmancers. Nothing is copied; they would be npm dependencies.

**Packaging.** Bolt pulls in `express ^5`, `axios`, `@slack/oauth`, `raw-body`, and `path-to-regexp` for HTTP receivers and installation flows. All of that is a non-goal here. `@slack/socket-mode` needs only `@slack/web-api`, `@slack/logger`, `ws`, and `eventemitter3`, which ships inside the existing `botmancers` package with no extra process.

**Socket Mode lifecycle** (`dist/src/SocketModeClient.js`):

- `autoReconnectEnabled` defaults to true (constructor, line 64). A socket close reconnects unless `disconnect()` was called (lines 105–110).
- Reconnect backoff is `clientPingTimeout × consecutive failures` (lines 184–190).
- A server `type: "disconnect"` message (pod recycling) closes and reconnects (lines 273–276).
- An ack is `send(envelope_id, payload)` (lines 282–284, 327).
- `retry_attempt` and `retry_reason` are passed to handlers (lines 293–294, 314–315).

**Dedup.** Neither package deduplicates. Bolt only reads `X-Slack-Retry-Num` (`dist/receivers/HTTPModuleFunctions.js`, `AwsLambdaReceiver.js`). Redelivery after a reconnect is therefore the relay's job: that is the event and question ledger above. The relay acks before it dispatches. It persists the ledger row before the ack and re-dispatches pending rows on start with the same idempotency key.

**Pantalk** could not be inspected. No local source or binary exists (`which pantalk` fails), and the session has no network. Its license, version, reconnect behavior, and event-id handling are therefore unverified. That alone disqualifies it for the MVP, because the ticket requires proof of license compatibility. Two further costs apply even if it checks out:

- a sidecar is a second process to package, update, and supervise beside the npm-installed CLI;
- it would add a second event-identity layer in front of the one Botmancers needs anyway.

**Smallest replaceable boundary:**

```ts
interface SlackTransport {
  start(onEnvelope: (e: SocketModeEnvelope) => Promise<void>): Promise<void>; // events_api only
  ack(envelopeId: string): Promise<void>;
  post(m: { channel: string; thread_ts: string | null; text: string; metadata: { event_type: string; event_payload: Record<string, string> } }): Promise<{ ts: string }>;
  stop(): Promise<void>;
}
```

The relay core (`normalize → allowlist → thread route → dedup → SessionShare.ask → reply`) depends only on this interface. The fixture's fake transport implements it.

**Fallback trigger.** Re-evaluate Pantalk behind the same `SlackTransport` interface only if both of these hold:

1. Either a second chat platform (Discord, Teams, or Mattermost) enters scope, or `@slack/socket-mode` fails the SR-2 reconnect and redelivery tests or is deprecated by Slack.
2. Pantalk's license is verified permissive and it exposes Slack's `event_id` unchanged.

## 6. Implementation map (dependency order)

Each child has exclusive ownership of the named contract. A later child appends only the entries it names to a file an earlier child created. None of them re-implements NOT-499, NOT-500, NOT-503, or NOT-507: they call `createPin` / `sendPinTurn` / `serveAs` / `serviceAudit` / `serviceRedactor`.

| # | Child | Owns (files / contracts) | One-PR exit predicate | Blocked by |
|---|---|---|---|---|
| 1 | **SessionShare core + explicit REST/MCP** | `lib/session-shares.ts` (tables `session_shares`, `session_share_events` via `CREATE TABLE IF NOT EXISTS`, like `service-audit`); `config/session-shares.json` loader (audience allowlist, per-Agent `share_from_turn`; owner-only, fail closed); `shares:create` + reserved `botmancers-session-context` in `lib/service-grants.ts`; `shares.*` operations in `lib/service-api.ts` / `lib/service-api-http.ts`; `app/api/v0/sessions/[ref]/shares`, `app/api/v0/shares/**` (except `current`); MCP tools create/get/list/revoke in `lib/mcp-bridge-v2.ts`, `docs/contracts/mcp-bridge-v2.tools.json`, `packages/mcp-server/schemas`; R1 fix in `lib/service-redaction.ts`; internal `askShare`; `docs/service-grants.md` section | `test-session-shares.js` passes this record's explicit-path cases (create/replay/conflict/TTL/allowlist/list/get/revoke/heuristic fields/ended) and the ask cases against the real store, through `serviceOperations` and MCP, with the same audit counts. `POST /api/v0/shares/current` is absent. | — (NOT-499/500/507 done) |
| 2 | **SessionContext + launch injection + share-current** | `lib/session-context.ts` (mint/hash/resolve/revoke, table `session_contexts`); `/api/v0/mcp` and REST authentication of the context header → reserved principal, tool allowlist = share-current; Claude launch (`claudeTurnArgs`: per-turn 0600 `--mcp-config`, `--allowedTools mcp__botmancers__botmancers_share_current_session`, env var); Codex launch (`thread/start` / first `thread/resume` `config.mcp_servers`, exec `-c`); `app/api/v0/shares/current`; MCP tool `botmancers_share_current_session` | `test-session-context.js`: the token never appears in argv, logs, the DB in plain form, or model-visible text; Claude args and Codex params carry the header entry; every reason in §2 is reproduced; Cursor launches get no context; `npm run probe:not-514-claude -- --home` and `probe:not-514-codex -- --home` rerun green, results appended to `docs/evidence/` | 1 |
| 3 | **Slack relay core** | `lib/slack-relay.ts`: normalization, ledgers (`slack_deliveries`, `slack_questions`, `slack_share_threads`), thread routing, anchor post, notices, reply correlation via message metadata; restart re-dispatch of pending rows | `test-slack-relay.js` replays `docs/contracts/slack-relay-v0.fixtures.json` against child 1's real SessionShare with the §4 counts, including a restart between ack and dispatch | 1 |
| 4 | **Slack Socket Mode transport** | root `package.json` deps `@slack/socket-mode@^2.0.7`, `@slack/web-api@^7`; `lib/slack-transport.ts` (`SlackTransport` above); start/stop wiring in the Botmancers server lifecycle; env `BOTMANCERS_SLACK_APP_TOKEN` / `BOTMANCERS_SLACK_BOT_TOKEN` (already redacted by `CREDENTIAL_ENV`); `scripts/slack-relay-smoke.js` operator smoke | a test with an injected fake `SocketModeClient` proves ack-before-dispatch, server `disconnect` → reconnect → redelivered envelope deduplicated, and token redaction; an operator smoke against a real workspace is recorded | 3 |
| 5 | **Owner lifecycle and operations** | owner routes `GET /api/shares`, `POST /api/shares/{ref}/revoke`; share list/revoke on the session page; share-from-turn toggle and audience allowlist view on the Agent config page; `botmancers doctor` Slack connection line; expired-share sweeper (detach pins); `docs/session-shares.md` | UI proof at 1440×900 and 390×800, revoke from the UI stops the next Slack question (`share_revoked`), the toggle off makes a live context `revoked` | 1, 2, 4 |

No child depends on an open identity or transport question:

- the identity mechanism and its per-runtime delivery are measured (§1, §2);
- Cursor's answer is a fixed fail-closed result;
- the transport and its fallback trigger are fixed (§5).
