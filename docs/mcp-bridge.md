# Botmancers MCP bridge (botmancers.mcp.v1)

Status: **implemented** (NOT-491)

Authority: [Botmancers core engine](core-engine.md)

The MCP bridge lets an external agent hand a task to a Botmancers coordinator
Agent and poll the result. It is a narrow MCP tool provider over the
agent conversation service, not a generic route proxy. The caller picks a
coordinator from an allowlist and gives an objective and an idempotency key.
It cannot choose a runtime, Deck, model, tool profile, grant, or target.

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

The exact schemas are captured in
[`contracts/mcp-bridge-v1.tools.json`](contracts/mcp-bridge-v1.tools.json).
`npm run test:mcp-bridge` checks that `tools/list` still matches that file.

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
- **Privacy.** Responses never include Session Bindings, external run or
  session ids, Decks, working directories, tool profiles, or credentials.

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

3. **Point the MCP client** at `http://127.0.0.1:43123/api/v0/mcp` and send the
   header `Authorization: Bearer $TOKEN`. Botmancers listens on loopback only.
   To reach it from another machine, put a TLS-terminating tunnel or reverse
   proxy in front, and pass the `Authorization` header through unchanged.

4. **Check the setup.** Call `botmancers_health`. It should return
   `status: "ok"`, your service id, and each coordinator with
   `available: true`.

Out of scope here: package publication, hosted or multi-tenant operation,
push completion callbacks, and any particular client's account setup.
