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
  (`botmancers-exchanges`, `botmancers-engine`), more than 512 entries or
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
`[redacted]`. Owner (UI) reads are unchanged.

**Limits:** request bodies over 64 KiB are 413 `payload_too_large`; content
and instructions at most 4000 characters; idempotency keys 1 to 160
characters. Each service may make `BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE`
(default 120) calls in any rolling minute; over that, 429 `rate_limited` with
`Retry-After`, before anything runs. Exchanges and their idempotency survive a
restart (the engine recovers open exchanges); the rate-limit window does not.

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
