# Service access: what a service token can do in `/api/v0`

Status: NOT-499, simplified by NOT-556. Code: `lib/service-api.ts` (core
services), `lib/service-api-http.ts` (HTTP boundary), `lib/service-audit.ts`
(audit trail), `lib/service-token-auth.ts` (tokens), `app/api/v0/**`.
Contract test: `npm run test:service-access`.

A service principal is a caller authenticated by a `BOTMANCERS_SERVICE_TOKENS`
entry (the principal `service:<id>`, see [`mcp-bridge.md`](mcp-bridge.md)).
**A configured service token reaches every registered Agent.** There is no
second, per-Agent permission step: the service can discover every Agent,
read its sessions and conversations, message its sessions, start exchanges,
pin sessions, and share them, subject to the gates below. The caller never
receives a provider session or run id, a Deck credential or selection, a
working directory, or a tool profile choice, and it can never choose them.

The same operations are MCP tools (contract `botmancers.mcp.v2`,
[`mcp-bridge.md`](mcp-bridge.md)): `botmancers_capabilities`,
`botmancers_list_agents`, `botmancers_list_sessions`,
`botmancers_list_conversations`, `botmancers_get_conversation` (with
`agent_id`), `botmancers_send_to_session`, `botmancers_create_exchange`,
`botmancers_get_exchange`, `botmancers_list_exchanges`, the pin tools, and
the share tools. Each is one call of the same audited, rate-limited service
operation (`serviceOperations` in `lib/service-api-http.ts`); the audit trail
records MCP and REST calls alike.

## The gates that remain

Giving a service a token means trusting it with every Agent. The risky
actions are still decided elsewhere, by the owner:

- **The Agent's policy** (Agent Config, `lib/session-pins`). A message to a
  registered Agent starts a new read-only session only when the Agent has no
  session that can take it, its policy allows new sessions, and it has a
  default workspace; otherwise 409 `no_eligible_session` or
  `workspace_required`. Resume work here (`POST /api/v0/sessions/{ref}/pins`
  with `action: "resume"`, workspace-write turns in that exact session) runs
  only when the Agent's policy allows resuming with edits and its runtime
  enforces it (else 409 `action_unavailable`).
- **`approve_write`.** A resume pin also needs `approve_write: true`, which
  the caller sets only after the person it acts for approved edits; without
  it, 403 `approval_required`. Every other service turn is read-only.
- **The Slack channel allowlist** (Agent Config, under Session sharing). A
  share's audience must be on it, else 403 `audience_not_allowed`
  ([Session shares](#session-shares-not-515)).
- **Caller-owned visibility.** A service sees only the exchanges, pins,
  shares, and service conversations it created itself. A conversation is
  visible under an Agent only when that Agent participates, every Agent in
  it still exists, and no other service participates (one service never
  reads another's conversation). Anything else answers exactly like a
  missing target.
- **The audit trail.** Every call is recorded ([Audit trail](#audit-trail)).

The engine-internal principals (`botmancers-exchanges`, `botmancers-engine`,
`botmancers-session-share`, `botmancers-session-context`) are refused in
`BOTMANCERS_SERVICE_TOKENS` and reach no Agent through this API.

Each operation still names the capability it uses (`agents:read`,
`sessions:read`, `conversations:read`, `sessions:message`, `exchanges:read`,
`exchanges:create`, `sessions:start`, `sessions:resume`, `shares:create`).
These are labels the audit trail records and `botmancers_capabilities`
reports for every Agent, not permissions the owner hands out.

NOT-507 pins: `POST /api/v0/agents/{agentId}/pins` (message a registered
Agent), `POST /api/v0/sessions/{ref}/pins` (`action: "ask"` or `"resume"`),
and `GET /api/v0/pins/{pinRef}`, `POST /api/v0/pins/{pinRef}/messages`,
`POST /api/v0/pins/{pinRef}/detach` (the caller's own pins, while their Agent
still exists). Each audit event names the resolved Agent and session, the
capability used, and the final action (`agents.message`,
`agents.message.start`, `pins.ask`, `pins.resume`, `pins.send`, `pins.read`,
`pins.detach`).

## Add, rotate, or revoke a service

- **Add:** put a `<service-id>=sha256:<digest>` entry in `BOTMANCERS_SERVICE_TOKENS`
  ([`mcp-bridge.md`](mcp-bridge.md)) and restart. Check with
  `GET /api/v0/capabilities` using the service's token: `"mode": "granted"`
  and every registered Agent.
- **Rotate a token:** replace the digest of the service id in
  `BOTMANCERS_SERVICE_TOKENS`, or add the new digest under a new id.
- **Revoke:** remove the service's entry from `BOTMANCERS_SERVICE_TOKENS` and
  restart. Its next call is unauthenticated. Exchanges already running finish
  under the engine; the caller can no longer read or cancel them.

The owner's service audit route (owner UI boundary, loopback only) reports
the latest service audit events.

### Upgrading from grants

Earlier releases also required an owner-only grants document,
`config/service-grants.json`. A leftover `service-grants.json` is ignored:
it is never read, never deleted, and never causes an error, and
`BOTMANCERS_SERVICE_GRANTS_PATH` has no effect. You can delete the file.
A service that had no grant entries now reaches every Agent, so remove from
`BOTMANCERS_SERVICE_TOKENS` any service you do not trust with all of them.

## API

All routes need `Authorization: Bearer <token>` of a service principal
(person and bot principals get 403 `principal_not_allowed`). Errors use
`{ "error": { "code", "message" } }`. A target the caller may not see
(another service's exchange or conversation, a deleted Agent) is answered
with exactly the code and message of a missing one (`agent_not_found`,
`session_not_found`, `conversation_not_found`, `exchange_not_found`, all
404).

| Route | Notes |
| --- | --- |
| `GET /api/v0/capabilities` | `mode` (always `granted`), every registered Agent and its capabilities, limits |
| `GET /api/v0/agents` | id, name, title, runtime kind, availability, capabilities, activity |
| `GET /api/v0/agents/{agentId}/sessions?status=active\|ended\|all` | the session catalog without its launch context |
| `GET /api/v0/agents/{agentId}/sessions/{ref}` | adds the session's Attempts |
| `GET /api/v0/agents/{agentId}/conversations` | id, type, label, participants, message count, activity |
| `GET /api/v0/agents/{agentId}/conversations/{id}?cursor&limit` | newest `limit` messages (default 50, max 200), `next_cursor` pages back; provider ids, working directories, Deck selections, and credentials redacted, each message at most 16000 characters |
| `POST /api/v0/sessions/{ref}/messages` | body `{ "content", "idempotency_key" }` (or `Idempotency-Key` header) |
| `GET /api/v0/exchanges`, `GET /api/v0/exchanges/{id}` | the caller's own exchanges and session messages |
| `POST /api/v0/exchanges` | `{ mode, idempotency_key, source: { session_ref, agent_id? }, destination?: { agent_id, conversation_id? }, instruction, origin_conversation_id? }` |
| `POST /api/v0/exchanges/{id}/cancel` | optional `{ "reason" }` |

**Lists** take `cursor` and `limit` (default 20, max 100), are ordered newest
activity first (ties: newer creation, then id), and return
`{ items, next_cursor }`. A cursor is valid only for the list that issued it.

**Session messages** resume exactly the referenced active session under the
Agent that owns it, as one read-only conversation turn (an `Ask` exchange,
`lib/session-exchanges`). The Deck, runtime, and model come from the session
and the Agent's configuration. Any other body field is refused before
anything is written: `deck`, `runtime`, `model`, `tool_profile`,
`execution_kind`, `provider_session_id`, `external_session_id`, `grants`,
`cwd`, and similar authority fields with 403 `authority_not_allowed`, any
other unknown field with 400 `invalid_request`. The answer is 202 with
`request_id`, `conversation_id`, `message_id`, `exchange_id`; an exact replay
is 200 with the same ids, and the same key with other content is 409
`idempotency_conflict`. An ended session is 409 `session_ended`; a session
bound under another runtime is 409 `session_not_resumable`; a session with an
exchange in progress is 409 `source_session_busy`. Poll
`GET /api/v0/requests/{request_id}` and `GET /api/v0/conversations/{conversation_id}`:
the service's question and the Agent's answer are in one conversation the
service owns per session.

**Exchanges** are the canonical NOT-497 exchanges with the service as
requester. The destination of a `Continue` starts a fresh session
it owns with its own configured Deck. When `origin_conversation_id` is
omitted, a new conversation owned by the service is opened. When a `Continue`
omits `destination.conversation_id`, the delivery goes to a new conversation
the service opens with the destination Agent (never the owner's direct thread);
a named destination conversation must be one the service participates in.
`POST /api/v0/exchanges` and its cancel return the full exchange (instruction,
hops, answer, handoff packet, events) while every Agent involved still
exists; otherwise status metadata (`id`, `kind`, `mode`, `state`, source and
destination Agent and session, failure code, timestamps), also on an
idempotent replay.

**Redaction:** everything a service is shown — conversation messages, session
titles and Attempts, Ask answers, Continue handoff packets, failure messages,
and events, through the service routes and through
`GET /api/v0/requests/{id}` and `GET /api/v0/conversations/{id}` — passes
through one sanitizer (`lib/service-redaction.ts`): every provider session
and run id the engine recorded becomes `[redacted runtime id]`, and every
working directory, Deck selection, and Hermes profile an Agent is configured
or launched with, and every credential in the environment, becomes
`[redacted]`. NOT-515 (finding R1 of NOT-514): so do every Agent's default
workspace and session-scope workspaces, every native session's workspace (raw
and `~`-expanded), and any absolute path under the home directory of the user
running Botmancers (a runtime echoing its cwd). Owner (UI) reads are unchanged.

**Limits:** request bodies over 64 KiB are 413 `payload_too_large`; content
and instructions at most 4000 characters; idempotency keys 1 to 160
characters. Each service may make `BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE`
(default 120) calls in any rolling minute; over that, 429 `rate_limited` with
`Retry-After`, before anything runs. Exchanges and their idempotency survive a
restart (the engine recovers open exchanges); the rate-limit window does not.

## Session shares (NOT-515)

Code: `lib/session-shares.ts` (store, configuration, `askShare`),
`lib/service-api.ts` (create/get/list/revoke). Contract test:
`npm run test:session-shares`. Design:
[`design/2026-10-24-session-share-preflight.md`](design/2026-10-24-session-share-preflight.md).
The owner's side (Sessions and Agent Config UI, owner routes, the policy
editor, the expiry sweeper, `botmancers doctor`) is
[`session-shares.md`](session-shares.md) (NOT-519).

A **share** lets one audience ask exactly one session read-only questions
for a while. It is one NOT-507 Ask pin on that `session_ref` (read-only,
never workspace-write), requested by the reserved engine principal
`service:botmancers-session-share`. That principal reaches no Agent (it is
refused in `BOTMANCERS_SERVICE_TOKENS`), so the share is the only authority
its questions have: a share never broadens anyone's access, and the share principal cannot
use `POST /api/v0/sessions/{ref}/pins`, `/messages`, or any pin route.

| Route | MCP tool | Notes |
| --- | --- | --- |
| `POST /api/v0/sessions/{ref}/shares` | `botmancers_create_share` | body `{ audience, ttl_seconds?, max_turns?, agent_id?, idempotency_key }` (or `Idempotency-Key`); 201 `{ share, replayed: false }`, exact replay 200 `{ share, replayed: true }`, the same key with another body 409 `idempotency_conflict` |
| `GET /api/v0/shares?session_ref&state&cursor&limit` | `botmancers_list_shares` | the caller's own shares, newest first, `state` `active`, `expired`, or `revoked` |
| `GET /api/v0/shares/{shareRef}` | `botmancers_get_share` | one own share |
| `POST /api/v0/shares/{shareRef}/revoke` | `botmancers_revoke_share` | 200 `{ share, replayed }`; revoking a revoked share returns it unchanged |

Share-current (`POST /api/v0/shares/current`) is not a service-token route:
see [Share the current session](#share-the-current-session-not-517).

- **Session.** Only an explicit `session_ref` (from `.../sessions`). The
  owning Agent is resolved, never chosen (`agent_id` is only an expectation
  check). Any field that would select or describe a session otherwise —
  `provider_session_id`, `external_session_id`, `claude_session_id`,
  `codex_thread_id`, `cursor_chat_id`, `cwd`, `workspace`, `latest`,
  `most_recent`, `title`, `title_match`, `active_since` — and every authority
  field (`runtime`, `deck`, `model`, `tool_profile`, …) is 403
  `authority_not_allowed`, in the body, the audience, the revoke body, and
  the list query, before anything is written.
- **Bounds.** `ttl_seconds` 300-86400 (default 3600); `max_turns` 1-100
  (default 20); otherwise 400 `invalid_request`. Authority is always `ask`.
- **Eligibility** is NOT-507's: an ended, missing, or unresumable session is
  `session_ended`, `session_missing`, or `session_not_resumable`, and no share
  is created.
- **Visibility.** A share is visible only to its creator, and only while the
  session's Agent still exists; anything else is 404 `share_not_found`,
  exactly like a missing share. An unknown or other-Agent session is 404
  `session_not_found`, exactly like a missing one.
- **View.** `share_ref` (opaque `shr_…`), `agent_id`, `session_ref`,
  `authority`, `state`, `audience`, `created_via`, `created_at`, `expires_at`,
  `revoked_at`, `max_turns`, `turns_used`. Never a provider id, working
  directory, Deck, runtime, model, prompt, or transcript.
- **Audit:** `shares.create`, `shares.read`, `shares.list`, `shares.revoke`
  (capability `shares:create`, target kind `session`: the session for create
  and list, the `share_ref` for read and revoke). A create or revoke commits
  with its `allowed` row.

**The owner's share configuration** is edited in Agent Config, under
Session sharing ([`session-shares.md`](session-shares.md)): the Slack
channel allowlist and, per Agent, `share_from_turn`. It is stored in an
owner-only file, `<BOTMANCERS_HOME>/config/session-shares.json`
(`BOTMANCERS_SESSION_SHARES_PATH` overrides it), which you never need to
edit by hand:

```json
{
  "version": 1,
  "audiences": [{ "kind": "slack", "team_id": "T0123ABCD", "channel_id": "C0123ABCD" }],
  "agents": [{ "agent": "<agent id>", "share_from_turn": true }]
}
```

A share's `audience` must be on `audiences` (else 403
`audience_not_allowed`: "That Slack channel is not on the share allowlist.
Add it in Agent Config, under Session sharing."). `share_from_turn` is the
per-Agent opt-in for [share-current](#share-the-current-session-not-517)
(default off). The file fails closed (owner-only `chmod 600`, at most 64 KiB
and 512 entries, strict JSON, no unknown field, no wildcard or malformed id,
no duplicate, only registered Agents): while it is missing or invalid, no
audience is allowed and `share_from_turn` is off. It is re-read when it
changes.

**Asking through a share** (`askShare` in `lib/session-shares.ts`) is internal:
the Slack relay's entry, not a route or MCP tool. Each question is one
read-only turn on exactly the share's session (NOT-507 `sendPinTurn`), with
the caller's question key as the pin-turn idempotency key, so a replayed
question returns the same turn and dispatches nothing. It is refused with
`share_revoked`, `share_expired`, `share_turn_limit` (after `max_turns`
questions), or `share_turn_in_progress` (one question at a time per share: a
durable claim is taken before dispatch, and a claim left by a crashed process
is recovered after a restart). Answers are redacted and cut at 3000
characters. Every ask is audited as `shares.ask` (capability `shares:ask`,
audit-only) on the share's session, by
`service:botmancers-session-share`, whatever its outcome; an accepted turn,
its count, and its audit row commit together. Share rows and their
append-only `session_share_events` survive restarts. The Slack relay core
(NOT-516, [`slack-relay.md`](slack-relay.md)) is its only caller.

## Share the current session (NOT-517)

Code: `lib/session-context.ts` (mint, resolve, end, revoke),
`lib/session-context-launch.ts` (launch arguments), the Claude Code and Codex
providers, `lib/service-api.ts` (`createCurrentSessionShare`). Contract test:
`npm run test:session-context`. Design:
[§1–§3 of the preflight](design/2026-10-24-session-share-preflight.md).

A Claude Code or Codex turn that **Botmancers launched** can share the session
it is running in without naming it: "share this session". It works only from
a credential Botmancers minted for that launch; nothing the client says about
itself is trusted (`CLAUDE_CODE_SESSION_ID`, Codex or Cursor ids, MCP
`clientInfo`, the cwd, a title, activity, "latest", or an implicit continue).
Cursor has no per-launch MCP seam and is not supported: its turns get no
context, and Botmancers never writes `~/.cursor/mcp.json` or a repository
`.cursor/mcp.json`.

| Route | MCP tool | Credential |
| --- | --- | --- |
| `POST /api/v0/shares/current` | `botmancers_share_current_session` | header `Botmancers-Session-Context: bmsc_…`, no `Authorization` |

Body (tool arguments): `{ audience, ttl_seconds?, max_turns?, agent_id?,
idempotency_key }`, the same bounds as create-share. 201 `{ share, replayed:
false }` with `created_via: "current_session"`, exact replay 200. The share
is the NOT-515 one (one ask pin, the same rows, events, and visibility),
created by `service:botmancers-session-context`.

**The session context.** While the owner has `share_from_turn` on for the
Agent, Botmancers mints one context per launch: `bmsc_` and 256 random bits,
stored only as its SHA-256, bound to one Agent, one `session_ref`, and one
launch. It reaches the launch only as an HTTP header on the MCP entry
`botmancers` that Botmancers writes for it, pointed at its own `/api/v0/mcp`
(`BOTMANCERS_SESSION_CONTEXT_URL` overrides the default
`http://127.0.0.1:<PORT>/api/v0/mcp`):

| Runtime | Launch (= context lifetime) | Delivery |
| --- | --- | --- |
| Claude Code | one `claude -p` turn process | a per-turn 0600 `--mcp-config` with `headers: { "Botmancers-Session-Context": "${BOTMANCERS_SESSION_CONTEXT}" }`, the value only in the turn's environment; `--allowedTools` adds exactly `mcp__botmancers__botmancers_share_current_session`; `--strict-mcp-config` |
| Codex app-server | one thread **load**: `thread/start`, or the first `thread/resume` in that app-server | `config.mcp_servers.botmancers = { url, http_headers, enabled_tools: ["botmancers_share_current_session"], tools: { botmancers_share_current_session: { approval_mode: "approve" } } }` (exactly that tool, pre-approved because turns run with `approvalPolicy: "never"`). A resume of an already loaded thread sends no config and mints nothing: Codex keeps the load's MCP client, so the context is load-scoped, not turn-scoped |
| `codex exec` fallback | one process | `-c mcp_servers.botmancers.url=…`, `-c mcp_servers.botmancers.env_http_headers={ "Botmancers-Session-Context" = "BOTMANCERS_SESSION_CONTEXT_TOKEN" }`, and the same `enabled_tools` / `approval_mode` overrides; the value only in the run's environment |
| Cursor | — | none |

The value is never in argv, a file, a log, a provider record, the database,
a tool argument, or model-visible text. An inherited
`BOTMANCERS_SESSION_CONTEXT`/`_TOKEN` in Botmancers' own environment is
removed from every launch.

**Lifetime.** A context is valid while its launch is live and a Botmancers
turn on its session runs, and for at most 15 minutes after the last such
turn. It ends (`stale`) when its launch ends: the Claude turn process or exec
run finishing, the Codex thread unloading (`thread/closed`), the app-server
exiting, or a Botmancers restart (for an app-server load). It is revoked when
the owner turns `share_from_turn` off for the Agent (every live context of
the Agent, durably; turning it back on revives none). Because it names
exactly one `session_ref`, a stale or replayed context fails closed and never
points at another session.

**The reserved principal** `service:botmancers-session-context` is
authenticated only by a live context. It can call share-current and nothing
else: every other operation is 403 `principal_not_allowed`, its MCP
`tools/list` holds only `botmancers_share_current_session`, and any other tool
is unknown. It is refused in `BOTMANCERS_SERVICE_TOKENS`, like
`botmancers-exchanges`. A service token never sees the tool, and calling share-current with a service token is 400
`invalid_request` (`invalid_arguments` over MCP).

**Errors** (REST status; the MCP tool returns the same code, `invalid_request`
as `invalid_arguments`):

| Caller | Result |
| --- | --- |
| no header (MCP: an empty one) | 409 `session_context_required`, `reason: "missing"`, `recovery: "choose_session"` |
| two values (repeated or comma-joined) | … `reason: "ambiguous"` |
| a provider id, chat id, path, or other value instead of a minted context | … `reason: "unsupported"` (never echoed) |
| well-formed, never minted | … `reason: "unknown"` |
| launch ended, idle past 15 minutes, restarted | … `reason: "stale"` |
| revoked, or `share_from_turn` off | … `reason: "revoked"` |
| `agent_id` not the context's Agent | 404 `session_not_found` |
| the session can no longer take an Ask | NOT-507's `session_ended` / `session_missing` / `session_not_resumable` |
| a service token | 400 `invalid_request` |
| `session_ref` in the body | 400 `invalid_request` |
| a selector (`provider_session_id`, `external_session_id`, `claude_session_id`, `codex_thread_id`, `cursor_chat_id`, `cwd`, `workspace`, `latest`, `most_recent`, `title`, `title_match`, `active_since`) | 403 `authority_not_allowed` |

Operator smoke (real CLI, spends a little usage): `npm run
smoke:not-517-share-current -- claude` or `-- codex`; evidence in
[`evidence/NOT-517/probe-results.md`](evidence/NOT-517/probe-results.md).

Recovery for `session_context_required`: share explicitly with
`botmancers_list_sessions` → `botmancers_create_share { session_ref }`.

**Audit:** `shares.create` with capability `shares:current`, target kind
`session` (the context's session once resolved), by
`service:botmancers-session-context`, whatever the outcome; a refusal writes
no share, event, or pin.

## Audit trail

Every `/api/v0` call by a service appends one
row to `service_audit_events` (in the Botmancers database): time, principal,
operation, capability (`participant` for the v1 bridge routes), target kind and
Botmancers reference, the owning Agent when known, outcome (`allowed`,
`denied`, `rejected`, `error`), and a stable code. Internally a refusal
of a target the caller may not see is recorded as `not_granted`, distinct
from a missing target. Rows never hold a prompt, transcript, token, credential, provider id,
or working directory; a reference that does not look like a Botmancers id is
stored as `[invalid]`. Rows cannot be updated or deleted. A mutation (session
message, exchange create, cancel) commits in the same transaction as its
`allowed` row, and is dispatched only after that commit: if the audit row
cannot be written, nothing is recorded or launched and the caller gets 500
`internal_error` (audited as `error` when the trail accepts it). Unauthenticated
requests are not recorded (there is no principal).
