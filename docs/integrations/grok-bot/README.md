# Cursor Grok Bot → Botmancers (NOT-493)

Status: **runbook + fixture smoke**. The real Grok Bot smoke is an operator step; its
record goes in [`evidence/operator-smoke.md`](evidence/operator-smoke.md).

Authority: [MCP bridge contract](../../mcp-bridge.md) and the
[`botmancers` package README](../../../packages/mcp-server/README.md).

This runbook connects Cursor's Grok Bot to a Botmancers coordinator through the
published MCP bridge, pinned to **`botmancers@0.1.0`**. Grok Bot starts a task,
polls it, and reads the coordinator's final reply. That is all it can do. It cannot
pick a Deck, workspace, runtime, model, grant, or implementation target. Any
implementation or review comes from the coordinator's own Wakes, under the owner's
grants.

Cursor references: [Grok Bot plugin connections](https://cursor.com/help/grok-bot/connect-plugins)
and [MCP in Cursor](https://prod.cursor.com/docs/mcp).

## Files

| File | Purpose |
| --- | --- |
| [`cursor-mcp.template.json`](cursor-mcp.template.json) | The MCP server entry for Grok Bot: an HTTPS URL and a bearer header taken from an environment variable. |
| [`bridge.env.template`](bridge.env.template) | The bridge's environment, with the exact package pin. |
| [`botmancers.env.template`](botmancers.env.template) | The app's service-token digest and coordinator allowlist. |
| [`evidence/fixture-smoke.txt`](evidence/fixture-smoke.txt) | Transcript of `npm run test:grok-handoff` at this commit. |
| [`evidence/operator-smoke.md`](evidence/operator-smoke.md) | Record of the real Grok Bot smoke, with secrets redacted. |

Every template contains `<PLACEHOLDER>` values only. `npm run test:grok-handoff`
scans them for secret-shaped values. It also fails if they pin more than one
version, or if the pinned version differs from the installed package version.

## Architecture

```
Cursor Grok Bot (remote)
   │  HTTPS, Authorization: Bearer <MCP token>
   ▼
Operator route: TLS tunnel / reverse proxy (public name, /mcp only)
   │  plain HTTP on loopback, Host rewritten to 127.0.0.1:3332
   ▼
botmancers@0.1.0 bridge   127.0.0.1:3332   checks the MCP token
   │  http://127.0.0.1:3333/api/v0/mcp, Authorization: Bearer <service token>
   ▼
Botmancers app            127.0.0.1:3333   checks the service-token digest and the coordinator allowlist
```

- **Botmancers stays on loopback.** Its UI and `/api/v0` are never routed. Only
  the bridge's `/mcp` path is published.
- **Two credentials, two hops.**
  - The **MCP token** (inbound) is held by Grok Bot and checked by the bridge.
  - The **service token** (outbound) is held only by the bridge. Botmancers
    stores only its SHA-256 digest, under the service id `grok-bot`. That id
    becomes the principal `service:grok-bot`, which is recorded on every request
    and scopes the idempotency keys.
- **Fail closed.** The bridge refuses to start (exit codes 2, 4, or 5) when a
  token is missing, when Botmancers is unreachable, or when Botmancers rejects
  the service token. Any request without the right MCP token gets 401. A request
  that arrives with a non-loopback `Host`, meaning the route did not rewrite it,
  gets 403 `host_not_allowed`. With no route, Grok Bot cannot connect at all.
  None of these writes anything.

## Setup

### 1. Credentials

Generate both tokens on the Botmancers machine. Never paste them into a
repository, a ticket, or a chat:

```sh
umask 077; mkdir -p ~/.config/botmancers
cp docs/integrations/grok-bot/bridge.env.template ~/.config/botmancers/grok-bridge.env
openssl rand -hex 32   # -> BOTMANCERS_SERVICE_TOKEN in grok-bridge.env
openssl rand -hex 32   # -> BOTMANCERS_MCP_TOKEN in grok-bridge.env (also entered in Grok Bot)
```

### 2. Botmancers app: service authentication and the coordinator allowlist

From [`botmancers.env.template`](botmancers.env.template):

```sh
printf %s "<service token>" | shasum -a 256          # -> <SERVICE_TOKEN_SHA256_HEX>
BOTMANCERS_SERVICE_TOKENS="grok-bot=sha256:<SERVICE_TOKEN_SHA256_HEX>"
BOTMANCERS_MCP_COORDINATORS="<COORDINATOR_AGENT_NAME>"
npm start                                            # listens on 127.0.0.1:3333
```

Allowlist only the coordinators you want Grok Bot to reach. Grok Bot can do
nothing else, and `botmancers_health` lists exactly these coordinators. For the
smoke, use a coordinator whose runtime is not production-critical.

### 3. Bridge, pinned

```sh
set -a; . ~/.config/botmancers/grok-bridge.env; set +a
npx --yes botmancers@0.1.0
# botmancers 0.1.0: MCP bridge listening on http://127.0.0.1:3332/mcp ...
```

Always name the exact version. An unpinned `npx botmancers` may resolve a
different release. To upgrade, edit the pin here and in `bridge.env.template` in
one reviewed change. Then rerun `npm run test:grok-handoff -- --registry <version>`.

### 4. Network route (HTTPS or an approved private network)

Grok Bot runs in Cursor's cloud, so a loopback address cannot reach it. Publish
**only** the bridge, over HTTPS, using a route that:

- terminates TLS, so the MCP token never travels in cleartext;
- forwards `/mcp` (POST) to `http://127.0.0.1:3332/mcp` and nothing else;
- passes the `Authorization` header through unchanged;
- **rewrites `Host` to `127.0.0.1:3332`**. While the bridge is bound to
  loopback, it refuses any other `Host` as a DNS-rebinding guard.

Examples (adapt to your tool and confirm against its documentation):

```yaml
# cloudflared config.yml
ingress:
  - hostname: <BRIDGE_PUBLIC_HOST>
    path: ^/mcp$
    service: http://127.0.0.1:3332
    originRequest:
      httpHostHeader: 127.0.0.1:3332
  - service: http_status:404
```

```
# Caddyfile
<BRIDGE_PUBLIC_HOST> {
  handle /mcp {
    reverse_proxy 127.0.0.1:3332 {
      header_up Host {upstream_hostport}
    }
  }
  respond 404
}
```

A private-network route (VPN or tailnet) is acceptable only if Cursor's Grok Bot
can actually reach it and your security owner has approved it. The same rules
apply: TLS, `/mcp` only, and the `Host` rewrite. Never bind Botmancers or the
bridge to `0.0.0.0` on a public interface. Never route port 3333.

Check the route before connecting Grok Bot:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<BRIDGE_PUBLIC_HOST>/mcp   # 401: route up, auth enforced
curl -s -o /dev/null -w '%{http_code}\n' https://<BRIDGE_PUBLIC_HOST>/              # 404: nothing else published
```

A `403` with `host_not_allowed` means the route is not rewriting `Host`.

### 5. Connect Grok Bot

Follow Cursor's [plugin connection guide](https://cursor.com/help/grok-bot/connect-plugins).
Add an MCP server shaped like [`cursor-mcp.template.json`](cursor-mcp.template.json):

- URL: `https://<BRIDGE_PUBLIC_HOST>/mcp` (Streamable HTTP).
- Header: `Authorization: Bearer <MCP token>`. Store the token in Cursor's secret
  or environment field wherever possible (the template references
  `${env:BOTMANCERS_MCP_TOKEN}`) rather than as a literal.

Grok Bot should list exactly four tools: `botmancers_start_task`,
`botmancers_get_request`, `botmancers_get_conversation`, and `botmancers_health`.
If it shows more or fewer tools, stop. That would mean you connected to
something other than the pinned bridge. (This runbook pins a
`botmancers.mcp.v1` bridge. Bridge releases that serve `botmancers.mcp.v2`
list these four tools unchanged plus eight granted tools; see
[`docs/mcp-bridge.md`](../../mcp-bridge.md). Re-pinning is a separate change.)

**Tool approval.** Keep Cursor's per-call approval on for `botmancers_start_task`,
because each accepted call creates a durable Work Request. The other three tools
are read-only and may be auto-approved. Grok Bot cannot approve grants:
implementation or revision Wakes from the coordinator wait for the owner
(`edit_approval_required`) in the Botmancers UI.

## Using it

Grok Bot should work like this:

1. Call `botmancers_start_task` once with `coordinator`, `objective`, and
   `idempotency_key` set to a stable id for this Grok invocation or run (letters,
   digits, `. _ : -`). Keep the returned `request_id` and `conversation_id`.
2. Poll `botmancers_get_request` until `terminal` is `true`. The status moves
   from `pending` to `running`, then to `succeeded`, `failed`, or `cancelled`.
   Poll at most about once every 5 seconds: the app allows 60 tool calls per
   minute per service.
3. Read `botmancers_get_conversation` for the final reply. If its status is
   `active`, follow-up work the coordinator started is still open, possibly
   waiting for the owner.
4. On a timeout or error, retry `botmancers_start_task` with the **same**
   `idempotency_key` and the same objective. That returns the original ids with
   `replayed: true` and runs nothing again. Using the same key with a different
   objective returns `idempotency_conflict`. Use a new key for a new task.

## Token rotation

- **MCP token (Grok Bot → bridge).**
  1. Generate a new token and put it in `grok-bridge.env`.
  2. Restart the bridge.
  3. Update the header in Grok Bot's plugin settings.
  4. Confirm that the old token now gets `401`.

  Grok calls fail with 401 between steps 2 and 3, so rotate when no task is in
  flight. Durable requests are unaffected and stay readable.
- **Service token (bridge → Botmancers).**
  1. Generate a new token.
  2. Replace the digest **under the same service id** `grok-bot` in
     `BOTMANCERS_SERVICE_TOKENS`.
  3. Restart the app.
  4. Put the new token in `grok-bridge.env` and restart the bridge. The bridge
     refuses to start (exit 5) until the two match.

  Do not move to a new service id. Idempotency keys and request visibility are
  scoped to the principal `service:grok-bot`, so a new id would turn retries into
  new tasks and hide the existing requests from Grok Bot.
- **On suspected leak:** remove the `grok-bot` entry from
  `BOTMANCERS_SERVICE_TOKENS` and stop the route. Everything then fails closed
  (503/401). Rotate both tokens before restoring the route.

## Verification

### Fixture smoke (agent, offline)

```sh
npm run test:grok-handoff                                   # packs and installs packages/mcp-server
npm run test:grok-handoff -- --registry 0.1.0               # the published package (needs network)
npm run test:grok-handoff -- --out docs/integrations/grok-bot/evidence/fixture-smoke.txt
```

The smoke installs the packed bridge into an empty project, the same way an
operator does. It asserts that the installed version is the pinned one, then runs
the scenario against a temporary Botmancers database, with a Host-rewriting route
in front of the bridge:

- refused starts: missing tokens, unreachable Botmancers, rejected service token;
- 401/403 inbound checks, with no rows written;
- exactly four tools;
- non-allowlisted coordinators and extra authority fields are refused;
- `start_task` once, with polling observed in order: `pending` → `running` → `succeeded`;
- the final conversation;
- a retry mid-flight and a retry after the terminal state replay the original ids;
- a changed objective returns `idempotency_conflict`, with unchanged canonical row
  counts;
- correlation through `scripts/mcp-handoff-correlate.js`;
- a removed route fails closed.

### Real Grok Bot smoke (operator)

Use a disposable, read-only objective and an allowlisted, non-production
coordinator. Record everything in
[`evidence/operator-smoke.md`](evidence/operator-smoke.md), with every token and
digest redacted.

1. Start the app and the bridge as described above. Check the route with `curl`.
2. In Grok Bot, list the tools. Capture the four names and the plugin
   configuration, with the token redacted.
3. Prompt, for example: *"Use botmancers_start_task with coordinator
   `<COORDINATOR_AGENT_NAME>`, idempotency_key `grok-smoke-<date>-1`, objective
   'Read-only: summarize the README of your workspace in one sentence. Do not
   change anything.' Then poll botmancers_get_request until terminal and show me
   botmancers_get_conversation."* Record `request_id`, `conversation_id`, the
   statuses polled, and the final reply.
4. Correlate the run with the durable records (read-only):

   ```sh
   node scripts/mcp-handoff-correlate.js --request-id <request_id> --key grok-smoke-<date>-1 > /tmp/grok-smoke-1.json
   ```

   The script checks against `--service grok-bot` by default; pass `--service
   <id>` if you configured a different service id.
   `verdict.no_external_elevation` must be `true`. It is `true` only when the
   direct request is a read-only conversation, is the root of its lineage, and
   was requested by the expected service principal. Its intake must belong to
   that same principal and key, every request in the lineage must carry that
   principal as `root_principal`, and every other request must be internal. In `lineage`, only the first
   request (`origin: "external"`) may name `service:grok-bot` as its requester.
   Every other request must have `origin: "wake"` (requester `bot:<coordinator>`)
   or `origin: "engine_continuation"` (requester `service:botmancers-engine`),
   which shows it came from inside Botmancers.
5. Repeat the exact same Grok action with the same `idempotency_key`. Expect
   `replayed: true` and the same ids. Rerun the correlation into
   `/tmp/grok-smoke-2.json` and confirm that `counts` is unchanged
   (`intakes_for_key: 1`).
