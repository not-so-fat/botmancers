# Service grants: granted `/api/v0` access for other agents

Status: NOT-499. Code: `lib/service-grants.ts` (document), `lib/service-audit.ts`
(audit trail), `lib/service-api.ts` (core services), `lib/service-api-http.ts`
(HTTP boundary), `app/api/v0/**`. Contract test: `npm run test:service-grants`.

A service principal (a caller authenticated by a `BOTMANCERS_SERVICE_TOKENS`
entry, see [`mcp-bridge.md`](mcp-bridge.md)) gets no access to Agents,
sessions, conversations, or exchanges beyond the narrow bridge unless the
owner grants it, per Agent and per capability, in one document. The caller
never receives a provider session or run id, a Deck credential or selection,
a working directory, or a tool profile choice, and it can never choose them.

The same operations are MCP tools (contract `botmancers.mcp.v2`,
[`mcp-bridge.md`](mcp-bridge.md)): `botmancers_capabilities`,
`botmancers_list_agents`, `botmancers_list_sessions`,
`botmancers_list_conversations`, `botmancers_get_conversation` (with
`agent_id`), `botmancers_send_to_session`, `botmancers_create_exchange`,
`botmancers_get_exchange`, and `botmancers_list_exchanges`. Each is one call of
the same audited, rate-limited service operation (`serviceOperations` in
`lib/service-api-http.ts`), under the grants below; the audit trail records
MCP and REST calls alike.

## The document

Path: `<BOTMANCERS_HOME>/config/service-grants.json` (default
`~/.botmancers/config/service-grants.json`). `BOTMANCERS_SERVICE_GRANTS_PATH`
overrides it (a source checkout without `BOTMANCERS_HOME` must set it to use
grants at all).

```json
{
  "version": 1,
  "grants": [
    {
      "service": "grok-bot",
      "agent": "<Codex agent id>",
      "capabilities": ["agents:read", "sessions:read", "conversations:read", "sessions:message"]
    }
  ]
}
```

- `service` is the id from `BOTMANCERS_SERVICE_TOKENS` (the principal
  `service:<id>`). Every entry must name a service configured there: a typo,
  a service removed from the token list, or a malformed token list refuses the
  whole document.
- `agent` is one Agent id (the id in `/api/bots`, or in the Agent's config
  page URL). There is no wildcard.
- `capabilities` is an explicit, non-empty subset of:

| Capability | Allows, for this Agent |
| --- | --- |
| `agents:read` | appear in `GET /api/v0/agents`, `GET /api/v0/agents/{agentId}` |
| `sessions:read` | `GET /api/v0/agents/{agentId}/sessions`, `.../sessions/{ref}` |
| `conversations:read` | `GET /api/v0/agents/{agentId}/conversations`, `.../conversations/{id}` |
| `sessions:message` | `POST /api/v0/sessions/{ref}/messages` on this Agent's sessions |
| `exchanges:read` | `GET /api/v0/exchanges`, `GET /api/v0/exchanges/{id}` for the caller's exchanges involving it |
| `exchanges:create` | `POST /api/v0/exchanges`, `POST /api/v0/exchanges/{id}/cancel` involving it |
| `sessions:start` | NOT-507: let `POST /api/v0/agents/{agentId}/pins` (a registered-Agent message) start a new read-only session when the Agent has none that can take it, its policy allows new sessions, and it has a default workspace. Never implied by `sessions:message`. |
| `sessions:resume` | NOT-507: `POST /api/v0/sessions/{ref}/pins` with `action: "resume"` (Resume work here: workspace-write turns in that exact session, with `approve_write: true`, only when the Agent's policy allows resuming with edits and its runtime enforces it). Never implied by `sessions:message`. |
| `shares:create` | NOT-515: `POST /api/v0/sessions/{ref}/shares` on this Agent's sessions, and `GET /api/v0/shares`, `GET /api/v0/shares/{shareRef}`, `POST /api/v0/shares/{shareRef}/revoke` for the caller's own shares of them ([Session shares](#session-shares-not-515)). Never implied by `sessions:message`, and grants no Ask itself. |

NOT-507 pins: `POST /api/v0/agents/{agentId}/pins` (message a registered
Agent; `sessions:message`), `POST /api/v0/sessions/{ref}/pins` (`action:
"ask"` needs `sessions:message`), and `GET /api/v0/pins/{pinRef}`,
`POST /api/v0/pins/{pinRef}/messages`, `POST /api/v0/pins/{pinRef}/detach`
(the capability the pin was created under, checked again on every call, so a
withdrawn grant makes the pin answer `pin_not_found`). Each audit event names
the resolved Agent and session, the capability actually used, and the final
action (`agents.message`, `agents.message.start`, `pins.ask`, `pins.resume`,
`pins.send`, `pins.read`, `pins.detach`).

The file must be owned by the user running Botmancers and neither readable
nor writable by group or others (modes such as `644` or `640` are refused):

```sh
chmod 600 ~/.botmancers/config/service-grants.json
```

### Fail closed

- **Missing document:** nothing is granted. The narrow bridge behavior is
  unchanged (`POST /api/v0/agents/{agentId}/messages` opens a new
  conversation; a service reads only conversations and requests it
  opened). `GET /api/v0/capabilities` reports `"mode": "narrow"`.
- **Invalid document:** the whole document is refused and every granted
  route answers 503 `grants_unavailable` for every service. Invalid means:
  not JSON, `version` other than 1, an unknown field anywhere, an unknown,
  empty, or repeated capability, a wildcard or malformed Agent id, a repeated
  `(service, agent)` pair, an entry naming an Agent that is not registered,
  a reserved engine principal
  (`botmancers-exchanges`, `botmancers-engine`, and, NOT-515,
  `botmancers-session-share` and `botmancers-session-context`), more than 512 entries or
  64 KiB, or a file that is not owner-only. The narrow routes keep working.
- An entry for an Agent that does not exist (a typo, or an Agent you deleted)
  makes the document invalid, so the other entries never stay quietly in
  force: fix or remove the entry. The document is re-validated whenever the
  registered Agents change. A service with no entry is granted nothing.

The document is re-read whenever the file changes; no restart is needed.
`GET /api/service-grants` (owner UI boundary, loopback only) shows whether it
loaded, the first problem when it did not, the effective grants, and the
latest audit events.

## Rotation, revocation, rollback

- **Rotate a token:** add the new `sha256:` digest under a new service id or
  replace the digest of the existing id in `BOTMANCERS_SERVICE_TOKENS`. Grants
  are keyed by service id, so replacing the digest of the same id keeps its
  grants; a new id needs its own entries. Retiring a service id: delete its
  grant entries first, then remove it from `BOTMANCERS_SERVICE_TOKENS`; an
  entry naming an unconfigured service refuses the whole document.
- **Revoke:** delete the service's entries (or one capability) and save. The
  next call is refused; targets it can no longer see answer exactly as
  missing ones. Exchanges already running finish under the engine; the caller
  can no longer read or cancel them.
- **Rollback:** keep the previous file (`service-grants.json.bak`) and copy it
  back, or delete the file to return to the narrow behavior. Both apply on the
  next call. Keep the copy `chmod 600`.

## Least-privilege examples

Consult a past Codex context, read only:

```json
{ "service": "grok-bot", "agent": "<codex>", "capabilities": ["agents:read", "sessions:read", "conversations:read"] }
```

Ask Codex's exact session a question (one read-only turn, no Deck or
runtime choice):

```json
{ "service": "grok-bot", "agent": "<codex>", "capabilities": ["agents:read", "sessions:read", "sessions:message"] }
```

Hand Codex's work to Grok (`Continue`): `exchanges:create` on both Agents,
`exchanges:read` to follow it:

```json
{ "service": "grok-bot", "agent": "<codex>", "capabilities": ["sessions:read", "exchanges:read", "exchanges:create"] },
{ "service": "grok-bot", "agent": "<grok>",  "capabilities": ["exchanges:read", "exchanges:create"] }
```

Grant `conversations:read` only for Agents whose whole transcript the service
may see: a conversation is visible only when every Agent in it is granted
`conversations:read` and no other service participates.

## API

All routes need `Authorization: Bearer <token>` of a service principal
(person and bot principals get 403 `principal_not_allowed`). Errors use
`{ "error": { "code", "message" } }`. A target outside the caller's grants is
answered with exactly the code and message of a missing one
(`agent_not_found`, `session_not_found`, `conversation_not_found`,
`exchange_not_found`, all 404).

| Route | Notes |
| --- | --- |
| `GET /api/v0/capabilities` | `mode` (`granted` or `narrow`), the caller's Agents and capabilities, limits |
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
requester; `exchanges:create` is needed on the source Agent and, for a
`Continue`, on the destination Agent. The destination starts a fresh session
it owns with its own configured Deck. When `origin_conversation_id` is
omitted, a new conversation owned by the service is opened. When a `Continue`
omits `destination.conversation_id`, the delivery goes to a new conversation
the service opens with the destination Agent (never the owner's direct thread);
a named destination conversation must be one the service participates in.
`POST /api/v0/exchanges` and its cancel return the full exchange (instruction,
hops, answer, handoff packet, events) only when the caller also holds
`exchanges:read` on every Agent involved; with `exchanges:create` alone they
return status metadata (`id`, `kind`, `mode`, `state`, source and destination
Agent and session, failure code, timestamps), also on an idempotent replay.

**Redaction:** everything a service is shown — conversation messages, session
titles and Attempts, Ask answers, Continue handoff packets, failure messages,
and events, through the granted routes and through
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

A **share** lets one audience ask exactly one session read-only questions
for a while. It is one NOT-507 Ask pin on that `session_ref` (read-only,
never workspace-write), requested by the reserved engine principal
`service:botmancers-session-share`. That principal holds no grant (it is
refused in this document), so the share is the only authority its questions
have: a share never broadens anyone's grants, and the share principal cannot
use `POST /api/v0/sessions/{ref}/pins`, `/messages`, or any pin route.

| Route | MCP tool | Notes |
| --- | --- | --- |
| `POST /api/v0/sessions/{ref}/shares` | `botmancers_create_share` | body `{ audience, ttl_seconds?, max_turns?, agent_id?, idempotency_key }` (or `Idempotency-Key`); 201 `{ share, replayed: false }`, exact replay 200 `{ share, replayed: true }`, the same key with another body 409 `idempotency_conflict` |
| `GET /api/v0/shares?session_ref&state&cursor&limit` | `botmancers_list_shares` | the caller's own shares, newest first, `state` `active`, `expired`, or `revoked` |
| `GET /api/v0/shares/{shareRef}` | `botmancers_get_share` | one own share |
| `POST /api/v0/shares/{shareRef}/revoke` | `botmancers_revoke_share` | 200 `{ share, replayed }`; revoking a revoked share returns it unchanged |

Share-current (`POST /api/v0/shares/current`) is not a granted-service route:
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
- **Visibility.** A share is visible to its creator only while it still holds
  `shares:create` on the session's Agent; anything else is 404
  `share_not_found`, exactly like a missing share. An unknown, ungranted, or
  other-Agent session is 404 `session_not_found`, exactly like a missing one.
- **View.** `share_ref` (opaque `shr_…`), `agent_id`, `session_ref`,
  `authority`, `state`, `audience`, `created_via`, `created_at`, `expires_at`,
  `revoked_at`, `max_turns`, `turns_used`. Never a provider id, working
  directory, Deck, runtime, model, prompt, or transcript.
- **Audit:** `shares.create`, `shares.read`, `shares.list`, `shares.revoke`
  (capability `shares:create`, target kind `session`: the session for create
  and list, the `share_ref` for read and revoke). A create or revoke commits
  with its `allowed` row.

**The owner's share configuration** is a second owner-only document,
`<BOTMANCERS_HOME>/config/session-shares.json`
(`BOTMANCERS_SESSION_SHARES_PATH` overrides it):

```json
{
  "version": 1,
  "audiences": [{ "kind": "slack", "team_id": "T0123ABCD", "channel_id": "C0123ABCD" }],
  "agents": [{ "agent": "<agent id>", "share_from_turn": true }]
}
```

A share's `audience` must be on `audiences` (else 403
`audience_not_allowed`). `share_from_turn` is the per-Agent opt-in for
[share-current](#share-the-current-session-not-517) (default off). The same fail-closed rules apply as for
this document (owner-only `chmod 600`, at most 64 KiB and 512 entries, strict
JSON, no unknown field, no wildcard or malformed id, no duplicate, only
registered Agents): while it is missing or invalid, no audience is allowed
and `share_from_turn` is off. It is re-read when it changes.

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
audit-only and not grantable) on the share's session, by
`service:botmancers-session-share`, whatever its outcome; an accepted turn,
its count, and its audit row commit together. Share rows and their
append-only `session_share_events` survive restarts.

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
| Codex app-server | one thread **load**: `thread/start`, or the first `thread/resume` in that app-server | `config.mcp_servers.botmancers = { url, http_headers }`. A resume of an already loaded thread sends no config and mints nothing: Codex keeps the load's MCP client, so the context is load-scoped, not turn-scoped |
| `codex exec` fallback | one process | `-c mcp_servers.botmancers.url=…` and `-c mcp_servers.botmancers.env_http_headers={ "Botmancers-Session-Context" = "BOTMANCERS_SESSION_CONTEXT_TOKEN" }`, the value only in the run's environment |
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
is unknown. It is refused in this document and in
`BOTMANCERS_SERVICE_TOKENS`, like `botmancers-exchanges`. A granted service
never sees the tool, and calling share-current with a service token is 400
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

Recovery for `session_context_required`: share explicitly with
`botmancers_list_sessions` → `botmancers_create_share { session_ref }`.

**Audit:** `shares.create` with capability `shares:current`, target kind
`session` (the context's session once resolved), by
`service:botmancers-session-context`, whatever the outcome; a refusal writes
no share, event, or pin.

## Audit trail

Every granted call, and every narrow `/api/v0` call by a service, appends one
row to `service_audit_events` (in the Botmancers database): time, principal,
operation, capability (`participant` for the narrow routes), target kind and
Botmancers reference, the owning Agent when known, outcome (`allowed`,
`denied`, `rejected`, `error`), and a stable code. Internally a refusal
because of the grants is recorded as `not_granted`, distinct from a missing
target. Rows never hold a prompt, transcript, token, credential, provider id,
or working directory; a reference that does not look like a Botmancers id is
stored as `[invalid]`. Rows cannot be updated or deleted. A mutation (session
message, exchange create, cancel) commits in the same transaction as its
`allowed` row, and is dispatched only after that commit: if the audit row
cannot be written, nothing is recorded or launched and the caller gets 500
`internal_error` (audited as `error` when the trail accepts it). Unauthenticated
requests are not recorded (there is no principal).

## Migration

Nothing changes for an existing installation until the owner writes the
document. The audit table is created on first start. To adopt grants: create
the file as above, `chmod 600`, and check `GET /api/v0/capabilities` with the
service's token (it should report `"mode": "granted"` and the Agents you
listed).
