# Botmancers MCP bridge (botmancers.mcp.v1, botmancers.mcp.v2)

Status: **implemented** (v1: NOT-491; v2: NOT-500)

Authority: [Botmancers core engine](core-engine.md)

The MCP bridge lets an external agent hand a task to a Botmancers coordinator
Agent and poll the result. It is a narrow MCP tool provider over the
agent conversation service, not a generic route proxy. The caller picks a
coordinator from an allowlist and gives an objective and an idempotency key.
It cannot choose a runtime, Deck, model, tool profile, grant, or target.

Contract `botmancers.mcp.v2` adds granted access on top: with the owner's
grants ([`service-grants.md`](service-grants.md)) an MCP client can discover
Agents and recognizable sessions, read conversations, send one message to the
exact same session of the same Agent, and start `Ask`/`Continue` exchanges,
without the Botmancers UI or any provider session id. v2 is a thin schema and
transport adapter over the same service layer as `/api/v0`
([`lib/mcp-bridge-v2.ts`](../lib/mcp-bridge-v2.ts) over
[`lib/service-api-http.ts`](../lib/service-api-http.ts)), which owns
authorization, filtering, redaction, idempotency, rate limits, and the audit
trail.

## Endpoint

`POST /api/v0/mcp` uses MCP Streamable HTTP, stateless, with
`application/json` responses. Protocol versions `2025-11-25`, `2025-06-18`,
and `2025-03-26` are supported. The server opens no SSE stream and issues no
session id, so `GET` and `DELETE` return 405. Batched JSON-RPC is refused.

Every POST is authenticated before its body is read, `initialize` included.
A failure writes nothing:

| Condition | HTTP | `error.code` |
| --- | --- | --- |
| No service tokens configured, or a malformed list | 503 | `authentication_unavailable` |
| Missing, unknown, or non-Bearer credential | 401 + `WWW-Authenticate: Bearer` | `unauthenticated` |
| Authenticated principal is not a service | 403 | `principal_not_allowed` |
| Browser `Origin` other than the server's own | 403 | `origin_not_allowed` |

## Tools

`tools/list` returns the four v1 tools, in their v1 order, then the eight v2
tools. The exact served list is captured in
[`contracts/mcp-bridge-v2.tools.json`](contracts/mcp-bridge-v2.tools.json);
the v1 capture [`contracts/mcp-bridge-v1.tools.json`](contracts/mcp-bridge-v1.tools.json)
is frozen. `npm run test:mcp-bridge` checks both (`-- --write-contract`
regenerates only the v2 capture).

### v1 tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `botmancers_start_task` | `coordinator`, `objective`, `idempotency_key` (no other field is accepted) | `request_id`, `conversation_id`, `coordinator`, `status`, `replayed` |
| `botmancers_get_request` | `request_id` | `status` (`pending`, `running`, `succeeded`, `failed`, or `cancelled`), `terminal`, `result`, `failure` |
| `botmancers_get_conversation` | `conversation_id` | ordered `messages`, lifecycle `events`, and `status` (`active` while any request in the conversation is open, otherwise `idle`) |
| `botmancers_health` | none | the caller's principal and the allowlisted coordinators |

Tool failures come back as tool results with `isError: true` and
`structuredContent.error.code`:

- `invalid_arguments`
- `unsupported_field`, which lists the offending fields
- `coordinator_not_allowed`
- `idempotency_conflict`
- `request_not_found`
- `conversation_not_found`
- `internal_error`

A request or conversation the caller did not open looks exactly like one that
does not exist.

### v1 compatibility

v2 is additive. Every v1 tool keeps its name, input, output, and behavior,
and a v1 client needs no change:

- `botmancers_start_task`, `botmancers_get_request`, and `botmancers_health`
  are served exactly as captured in v1.
- `botmancers_get_conversation` keeps its v1 `conversation_id` input,
  required list, output shape, errors, and description. Its v2 path is
  selected only by giving `agent_id`; it adds the optional `agent_id`,
  `cursor`, and `limit` inputs and a second output shape (`contract:
  "botmancers.mcp.v2"`). A call without `agent_id` is the v1 tool: `cursor`
  or `limit` without `agent_id` is still v1's `unsupported_field`.
- v1 results and errors keep `contract: "botmancers.mcp.v1"`.
- The v1 idempotency namespace (`mcp:<key>`) is unchanged. v2 mutations
  share the service API's namespaces: a `botmancers_send_to_session` key is
  the same key as `POST /api/v0/sessions/{ref}/messages`, and a
  `botmancers_create_exchange` key the same as `POST /api/v0/exchanges`.

### v2 tools: discover, select, act, observe

Each v2 tool needs a capability the owner granted this service principal on
the Agents involved ([`service-grants.md`](service-grants.md)). The caller
never supplies a Deck, runtime, model, tool profile, provider session id,
grant, principal, or destination session: none is in any input schema, and
the Agent, runtime, and session come from the referenced Botmancers session
and the Agent's stored configuration.

| Step | Tool | Grant | Arguments | Returns |
| --- | --- | --- | --- | --- |
| 1 discover | `botmancers_capabilities` | none | none | `contracts_supported`, `mode` (`granted` or `narrow`), granted `agents` and their capabilities, the granted `operations` (tool, contract, Agents), `limits`, `polling` |
| 2 discover | `botmancers_list_agents` | `agents:read` | `cursor`, `limit` | `items` (`agent_id`, `name`, `title`, `runtime`, `available`, `capabilities`), `next_cursor` |
| 3 select | `botmancers_list_sessions` | `sessions:read` | `agent_id`, `status` (`active`, `ended`, `all`), `cursor`, `limit` | `items` (`ref`, recognizable `title`, `status`, `resumable`, `origin`, optional additive `usage`: provider-reported input/output tokens and cost, each with `sum` (null when unreported), `known`/`total`, and `quality` `complete`/`partial`/`unavailable`), `next_cursor` |
| history | `botmancers_list_conversations` | `conversations:read` | `agent_id`, `cursor`, `limit` | `items` (`conversation_id`, `label`, `participants`, `message_count`), `next_cursor` |
| history | `botmancers_get_conversation` (v2 path) | `conversations:read` | `conversation_id`, `agent_id`, `cursor`, `limit` | `messages` (redacted, `truncated`), `next_cursor` (older messages), `content_trust: "untrusted"` |
| 4 act, same Agent | `botmancers_send_to_session` | `sessions:message` | `session_ref`, `content`, `idempotency_key` | `exchange_id`, `request_id`, `conversation_id`, `message_id`, `state`, `replayed` |
| 4 act, exchange | `botmancers_create_exchange` | `exchanges:create` on every Agent involved | `mode` (`ask`, `continue`), `source` (`session_ref`, optional `agent_id`), `destination` (`agent_id`, optional `conversation_id`; Continue only), optional `origin_conversation_id`, `instruction`, `idempotency_key` | `exchange` (full view with `exchanges:read`, else status metadata), `replayed`, `terminal` |
| 5 observe | `botmancers_get_exchange` | `exchanges:read` on every Agent involved | `exchange_id` | `exchange` (state, `answer`, `packet`, `failure`, `events`), `terminal`, `content_trust: "untrusted"` |
| 5 observe | `botmancers_list_exchanges` | `exchanges:read` | `cursor`, `limit` | `items` (status metadata, session messages included), `next_cursor` |
| 4 act, registered Agent | `botmancers_message_agent` | `sessions:message` (a new session also `sessions:start`) | `agent_id`, `content`, `idempotency_key` | `pin`, `turn`, `resolution` (`home`, `newest`, `started`), `replayed` |
| 4 act, exact session | `botmancers_pin_session` | `sessions:message` (`ask`) or `sessions:resume` (`resume`) | `session_ref`, `action` (`ask`, `resume`), `approve_write`, optional `replace_pin_ref`, `idempotency_key` | `pin`, `replaced_pin_ref`, `replayed` |
| 4 act, pinned | `botmancers_send_to_pin` | the pin's | `pin_ref`, `content`, `idempotency_key` | `pin`, `turn`, `replayed` |
| 5 observe | `botmancers_get_pin` | the pin's | `pin_ref` | `pin`, `turns` (state, `answer`), `content_trust: "untrusted"` |
| stop | `botmancers_detach_pin` | the pin's | `pin_ref` | `pin`, `replayed` |

- **Discover.** `botmancers_capabilities` lists only what this principal was
  granted. Without a grants document the bridge is in `narrow` mode and only
  the v1 tools work.
- **Select.** A session is identified by its stable Botmancers reference
  (`ref`, passed as `session_ref`), never by a provider session id. Choose an
  `active`, `resumable` session to send to.
- **Act.** `botmancers_send_to_session` is one read-only turn that resumes
  exactly the referenced session of the Agent that owns it; the question and
  the reply land in one conversation the service owns per session.
  `botmancers_create_exchange` with `mode: "ask"` asks that session a question
  (no destination); with `mode: "continue"` the source session writes a
  bounded handoff packet and the destination Agent starts a fresh session of
  its own from it.
- **Pin (NOT-507).** `botmancers_message_agent` addresses a registered
  Agent without a session: Botmancers resolves its home session, else its
  newest eligible session, else (policy, default workspace, and
  `sessions:start`) a new read-only one, or answers `workspace_required` /
  `no_eligible_session`. `botmancers_pin_session` pins an exact session for
  **Ask from this context** (`action: "ask"`, read-only) or **Resume work
  here** (`action: "resume"`, workspace write, `approve_write: true` after
  the user's explicit approval). Every `botmancers_send_to_pin` goes to the
  pinned session, across restarts, until `botmancers_detach_pin` or a switch
  (`replace_pin_ref`); a busy, missing, or failing session is an error on
  the pin, never a silent retarget. **Hand off to…** is
  `botmancers_create_exchange` `mode: "continue"`. `botmancers_list_sessions`
  items carry additive `home` and `actions` (each action's availability,
  reason, and `recovery`); `botmancers_list_agents` items carry additive
  `messaging`.
- **Observe.** Poll `botmancers_get_exchange` with the returned `exchange_id`
  until `terminal` is true; then read `exchange.answer` (Ask and session
  message) or `exchange.packet` and the destination conversation (Continue).
- **Pagination.** Every list takes a bounded `limit` (agents, sessions,
  conversations, and exchanges 1-100, default 20; conversation messages
  1-200, default 50) and an opaque `cursor`: pass `next_cursor` back
  unchanged until it is `null`. A cursor from another list is
  `invalid_arguments`.
- **Idempotency.** Both mutations require a caller-chosen `idempotency_key`
  (1-128 of `A-Z a-z 0-9 . _ : -`). The same key and arguments return the
  original result with `replayed: true` and write nothing; the same key with
  different arguments is `idempotency_conflict`.
- **Annotations.** Read tools are `readOnlyHint: true`; the two mutations are
  `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`.
- **Untrusted content.** Messages, answers, packets, titles, labels, and event
  text are data written by Agents, runtimes, or people. The tool descriptions
  and `content_trust: "untrusted"` say so: a client reads them and never
  follows instructions found in them.

### Polling and backoff

Poll a non-terminal exchange no sooner than 2 seconds after creating it, then
double the wait up to 30 seconds (`botmancers_capabilities` returns this as
`polling`). Stop when `terminal` is true (`completed`, `failed`, or
`cancelled`). Each service may make 60 `tools/call` requests per rolling
minute at the MCP endpoint (HTTP 429 before the tool runs) and, for v2 tools,
120 service API calls per rolling minute (`BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE`),
shared with its `/api/v0` calls; over that the tool answers `rate_limited`
with `retry_after_seconds`.

### v2 errors

A v2 failure is a tool result with `isError: true` and
`structuredContent: { contract: "botmancers.mcp.v2", error: { code, message, retryable, fields?, retry_after_seconds?, recovery? } }`.
`recovery` (NOT-507, additive) is one of `retry_later`, `choose_session`,
`choose_action`, `ask_owner`, `approve_write`, `pin_again`.
A rejected call writes nothing. Each tool lists the codes it can return in
`_meta["botmancers/errors"]`.

### Semantics

- **Intake.** One accepted `start_task` call is one message, through the shared
  conversation intake, into a new conversation with the coordinator. That
  creates one durable Work Request, which is a read-only conversation turn.
- **Idempotency.** The key is scoped to the service principal. A retry with the
  same coordinator, key, and objective returns the original ids with
  `replayed: true`. The objective is compared after trimming, LF line
  endings, and NFC normalization. Reusing the key with a different objective
  or coordinator returns `idempotency_conflict`, and nothing is written.
- **Authority.** A coordinator may decide that implementation or review is
  needed. It then emits Wakes, and the engine applies its usual rules to them.
  Implementation and revision wait for an owner grant (`grant_required`)
  unless the owner has already granted that (coordinator, target) pair. The
  bridge has no grant tool.
- **Polling.** Poll `get_request` until `terminal` is true. Then read
  `get_conversation`. If it is `active`, follow-up work the coordinator started
  is still open, possibly waiting for the owner.
- **Privacy.** Responses never include external run or
  session ids, Decks, working directories, or credentials, and v1 responses
  never include Session Bindings or tool profiles. v2 names a session only by
  its Botmancers reference, and every runtime-written text is redacted by the
  service layer ([`lib/service-redaction.ts`](../lib/service-redaction.ts)).
  The owner's Sessions view (`docs/core-engine.md`, Session catalog) is a
  loopback UI route, not a bridge tool; the bridge never proxies it. v2 reads
  sessions only through the grant-gated service API.

## Error recovery

| `error.code` | Meaning | Recovery |
| --- | --- | --- |
| `invalid_arguments` | An argument breaks the input schema, or a cursor is not from this list. | Fix the argument; for a cursor, restart the list. |
| `unsupported_field` | A field the tool does not take (listed in `fields`). | Remove it. |
| `authority_not_allowed` | A field asks for authority Botmancers chooses (Deck, runtime, model, tool profile, provider session, grant, principal; listed in `fields`). | Remove it; Botmancers takes these from the session and the Agent. |
| `permission_denied` | The authenticated principal is not a service. | Use a service token. |
| `grant_required` | This principal holds the tool's capability on no Agent. | Ask the owner to grant it in `service-grants.json`; check `botmancers_capabilities`. |
| `grants_unavailable` | The owner's grants document is malformed or not owner-only (retryable). | The owner fixes it; retry later. |
| `agent_not_found` | No such Agent, or not granted for this operation. | Re-run `botmancers_list_agents`. |
| `session_not_found` | No such session, or its Agent is not granted for this operation. | Re-run `botmancers_list_sessions`. |
| `conversation_not_found` | No such conversation, or not readable under the grants. | Re-run `botmancers_list_conversations`. |
| `exchange_not_found` | No such exchange, or not this caller's or not readable. | Use the `exchange_id` the mutation returned. |
| `session_ended` | The session has ended. | Choose an `active` session. |
| `session_not_resumable` | The session belongs to another runtime than the Agent's current one. | Choose another session. |
| `source_session_busy` | The session is in another turn (retryable). | Back off and retry with the same key. |
| `agent_unavailable` | The Agent cannot be launched now (retryable). | Back off and retry with the same key. |
| `destination_invalid` | An Ask names a destination, or a Continue names none. | Fix `destination`. |
| `recursive_exchange` | An exchange cannot start from another exchange. | Start from a session. |
| `idempotency_conflict` | The key was used with different arguments. | Use a new key, or repeat the original arguments. |
| `exchange_terminal` | The exchange already ended. | Read it with `botmancers_get_exchange`. |
| `conflict` | The exchange changed concurrently (retryable). | Read it and retry. |
| `payload_too_large` | The request is too large. | Shorten `content` or `instruction`. |
| `rate_limited` | Over the service limit (retryable; `retry_after_seconds`). | Wait that long, then retry with the same key. |
| `internal_error` | Unexpected failure (retryable). | Retry with the same key; mutations stay idempotent. |
| `pin_not_found` | No such pin of this caller, or its grant was withdrawn. | Pin a session again. |
| `pin_detached` | The pin was detached or switched. | Use the replacing pin, or pin again. |
| `workspace_required` | The Agent has no session that can take a message and no default workspace for a new one. | Ask the owner to set one, or pin one of its sessions. |
| `no_eligible_session` | No session can take a message and a new one is not allowed. | Ask the owner, or pin one of its sessions. |
| `session_missing` | The runtime no longer has the session (the pin stays on it). | Choose another session and switch. |
| `action_unavailable` | The runtime cannot do this action on this session. | Choose another action (see `actions`). |
| `approval_required` | Resume work here needs `approve_write: true`. | Ask the user to approve edits first. |
| `provider_failed` | The runtime failed the turn (retryable; the pin stays). | Retry later with the same key. |

A target outside the caller's grants is answered exactly like a missing one.
A terminal exchange carries its own stable `failure.code` (for example
`packet_invalid` or `destination_session_invalid`).

## Example: same-session message, then cross-Agent Continue

A client granted `agents:read`, `sessions:read`, `sessions:message`,
`exchanges:read`, and `exchanges:create` on Codex, and `agents:read`,
`exchanges:read`, and `exchanges:create` on Grok (`tools/call` arguments shown):

1. `botmancers_capabilities {}` → `operations` lists `botmancers_send_to_session`
   for Codex and `botmancers_create_exchange` for Codex and Grok.
2. `botmancers_list_agents {}` → `items: [{ "agent_id": "a-codex", "name": "Codex" }, { "agent_id": "a-grok", "name": "Grok" }]`.
3. `botmancers_list_sessions { "agent_id": "a-codex", "status": "active" }` →
   `items: [{ "ref": "s-123", "title": "Implement retry for the uploader", "status": "active", "resumable": true }]`.
4. Same-session: `botmancers_send_to_session { "session_ref": "s-123", "content": "Why did you keep the leases?", "idempotency_key": "ask-leases-1" }`
   → `{ "exchange_id": "x-1", "conversation_id": "c-9", "replayed": false }`.
5. Observe: `botmancers_get_exchange { "exchange_id": "x-1" }` every 2, 4, 8 s …
   until `terminal: true`; the reply is `exchange.answer.content` (untrusted
   data). The full thread is `botmancers_get_conversation { "conversation_id": "c-9", "agent_id": "a-codex" }`.
6. Cross-Agent: `botmancers_create_exchange { "mode": "continue", "source": { "session_ref": "s-123" }, "destination": { "agent_id": "a-grok" }, "instruction": "Carry the retry work on and add tests.", "idempotency_key": "handoff-1" }`
   → `{ "exchange": { "id": "x-2", "state": "queued" }, "terminal": false }`.
7. Poll `botmancers_get_exchange { "exchange_id": "x-2" }` until terminal:
   `exchange.packet` is Codex's handoff, and `exchange.destination` names
   Grok's new session (`session_ref`) and the conversation it answered in.

A retry of step 4 or 6 with the same key and arguments returns the same
exchange. An ended `s-123` would answer `session_ended`; choose another
session from step 3.

## Versioning

- `botmancers.mcp.v1` is frozen: its capture
  [`contracts/mcp-bridge-v1.tools.json`](contracts/mcp-bridge-v1.tools.json)
  never changes, and every v1 tool keeps its behavior.
- `botmancers.mcp.v2` is the served contract
  ([`contracts/mcp-bridge-v2.tools.json`](contracts/mcp-bridge-v2.tools.json)):
  v1 plus the v2 tools and the v2 path of `botmancers_get_conversation`.
  Each tool names its contract in `_meta["botmancers/contract"]`;
  `botmancers_capabilities` returns `contracts_supported`, and the standalone
  bridge's `GET /healthz` returns `contracts`.
- Changes within v2 are additive (a new optional input, output field, or error
  code). A breaking change is a new contract version, served next to the
  older ones.
- The standalone `botmancers` package bundles both captures byte for byte and
  refuses to start against a Botmancers that lacks any bundled tool (see
  below), so a newer bridge never silently drops v2.

## Operator configuration

1. **Issue a token per service.** Pick a random token and store only its
   SHA-256 digest:

   ```sh
   TOKEN=$(openssl rand -hex 32)
   printf %s "$TOKEN" | shasum -a 256   # -> <hex>
   ```

2. **Configure the Botmancers server** (the environment of `npm run dev` /
   `npm start`):

   ```sh
   BOTMANCERS_SERVICE_TOKENS="grok-bot=sha256:<hex>"   # comma-separated <service-id>=sha256:<hex>
   BOTMANCERS_MCP_COORDINATORS="Tank"                  # comma-separated coordinator Agent names
   ```

   The service id becomes the caller's principal, `service:<id>`. A malformed
   entry or a duplicate id disables the whole list, and the API fails closed.
   The same tokens also authenticate the REST `/api/v0` routes. Changes take
   effect on the next request.
   Access beyond this bridge (Agents, sessions, conversations, session
   messages, exchanges) needs explicit owner grants:
   [`service-grants.md`](service-grants.md).

3. **Point the MCP client** at `http://127.0.0.1:3333/api/v0/mcp` and send the
   header `Authorization: Bearer $TOKEN`. Botmancers listens on loopback only.
   To reach it from another machine, put a TLS-terminating tunnel or reverse
   proxy in front, and pass the `Authorization` header through unchanged.

   As a DNS-rebinding guard, the endpoint refuses (403, before
   authentication) any request whose `Host` is not a loopback host or an
   exact entry of `BOTMANCERS_MCP_ALLOWED_HOSTS`, and any request carrying an
   `Origin` other than `http://<loopback Host>` or an exact entry of
   `BOTMANCERS_MCP_ALLOWED_ORIGINS`. Either have the proxy rewrite `Host` to
   `127.0.0.1:3333`, or list its public name:

   ```sh
   BOTMANCERS_MCP_ALLOWED_HOSTS="mcp.example.com"            # comma-separated host[:port]
   BOTMANCERS_MCP_ALLOWED_ORIGINS="https://mcp.example.com"  # only if a client sends this Origin
   ```

   The endpoint does not implement CORS: it has no `OPTIONS` preflight
   handler and sends no `Access-Control-Allow-*` headers, so cross-origin
   browser clients are not supported even when their origin is listed.
   `BOTMANCERS_MCP_ALLOWED_ORIGINS` only stops the guard from refusing a
   server-side client that sends an `Origin` header.

   Request bodies over 256 KiB are refused with 413.

   Each service may make at most 60 `tools/call` requests in any rolling
   minute. A call over the limit is refused with 429 `rate_limited` and a
   `Retry-After` header (seconds) before the tool runs, so nothing is
   written. To change the limit:

   ```sh
   BOTMANCERS_MCP_TOOL_CALLS_PER_MINUTE="60"   # positive integer; anything else uses 60
   ```

   Bridge idempotency keys are stored as `mcp:<idempotency_key>`. The REST
   `POST /api/v0/agents/{agentId}/messages` route therefore refuses keys
   that start with `mcp:` (400 `invalid_request`), so REST calls cannot
   occupy or replay a bridge key.

4. **Check the setup.** Call `botmancers_health`. It should return
   `status: "ok"`, your service id, and each coordinator with
   `available: true`. For v2, call `botmancers_capabilities`: `mode` is
   `granted` and `operations` lists what the owner granted.

## Standalone bridge (`npx botmancers`)

The npm package `botmancers` (source in
[`packages/mcp-server`](../packages/mcp-server/README.md)) runs this same
contract as a standalone Streamable HTTP server. It answers `tools/list`
from a bundled copy of the captured v2 schemas and forwards every v1 and v2
`tools/call` unchanged to this endpoint with a service token. MCP clients
authenticate to it with a separate token. Use it when a consumer needs its
own reachable endpoint. At startup its preflight (`initialize` and
`tools/list` only, never a tool call) refuses a Botmancers that lacks any
bundled tool, naming exactly what is missing: a v1-only server ("it serves
only botmancers.mcp.v1"), missing v2 tools, or a `botmancers_get_conversation`
without the v2 `agent_id` path.
Release steps are in
[`packages/mcp-server/RELEASING.md`](../packages/mcp-server/RELEASING.md).

For Codex, Cursor, and Claude Code, `botmancers setup --client
codex|cursor|claude` writes the MCP connection and installs the optional
`botmancers-collaboration` Agent Skill, a procedure for this workflow that
holds no tools, credentials, or authority of its own
([client setup](../packages/mcp-server/README.md#client-setup-and-the-collaboration-skill)).
Clients without skills use the tools above unchanged.

Consumer runbooks: [Cursor Grok Bot](integrations/grok-bot/README.md)
(pinned package, network route, token rotation, fixture and operator smokes).

Out of scope here: hosted or multi-tenant operation,
push completion callbacks, and any particular client's account setup.
