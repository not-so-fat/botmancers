# botmancers

The Botmancers MCP bridge. It is a standalone [MCP](https://modelcontextprotocol.io)
server, using Streamable HTTP, that lets an external agent hand a task to a
Botmancers coordinator Agent and poll the result. Examples of such agents are
Cursor's Grok Bot or any other MCP client.

The bridge runs on your machine next to the Botmancers app. MCP clients
authenticate to the bridge with their own token. The bridge forwards their
tool calls to Botmancers with a service token, and clients never see that
token. The tool contract is `botmancers.mcp.v1`, and its JSON schema ships in
this package at `schemas/botmancers.mcp.v1.tools.json`.

| Tool | What it does |
| --- | --- |
| `botmancers_start_task` | Sends one objective to an allowlisted coordinator. Returns `request_id` and `conversation_id`. |
| `botmancers_get_request` | Polls a request until `terminal`. Returns its `result` or `failure`. |
| `botmancers_get_conversation` | Reads the conversation the task opened. |
| `botmancers_health` | Shows the caller's identity and the available coordinators. |

Requirements: Node.js 20 or newer and a running Botmancers app.

## Quick start

1. **Create two tokens.** The service token authenticates the bridge to
   Botmancers. The MCP token authenticates MCP clients to the bridge.

   ```sh
   export BOTMANCERS_SERVICE_TOKEN=$(openssl rand -hex 32)
   export BOTMANCERS_MCP_TOKEN=$(openssl rand -hex 32)
   printf %s "$BOTMANCERS_SERVICE_TOKEN" | shasum -a 256   # -> <hex>, for the next step
   ```

2. **Configure the Botmancers app**, in the environment of its `npm start`.
   Store only the token's digest there, and allowlist the coordinators the
   bridge may use:

   ```sh
   BOTMANCERS_SERVICE_TOKENS="mcp-bridge=sha256:<hex>"
   BOTMANCERS_MCP_COORDINATORS="Tank"
   ```

3. **Start the bridge:**

   ```sh
   BOTMANCERS_URL=http://127.0.0.1:43123 npx botmancers
   ```

   It prints
   `botmancers <version>: MCP bridge listening on http://127.0.0.1:43124/mcp ...`
   and keeps running until you press Ctrl-C.

4. **Connect an MCP client** to `http://127.0.0.1:43124/mcp` with the header
   `Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`. Then call
   `botmancers_health`. It should return `status: "ok"` and each coordinator
   with `available: true`.

To pin an exact release, which is recommended for anything long-running:

```sh
BOTMANCERS_URL=http://127.0.0.1:43123 npx botmancers@0.1.0
```

## Configuration

| Variable | Flag | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `BOTMANCERS_URL` | `--botmancers-url` | yes | none | Base URL of the Botmancers app, for example `http://127.0.0.1:43123`. Must be `http://` or `https://`, with no credentials, query, or fragment. The bridge calls `<url>/api/v0/mcp`. |
| `BOTMANCERS_SERVICE_TOKEN` | none (environment only) | yes | none | Bearer token the bridge sends to Botmancers. Its SHA-256 digest must be listed in the app's `BOTMANCERS_SERVICE_TOKENS`. |
| `BOTMANCERS_MCP_TOKEN` | none (environment only) | yes | none | Bearer token MCP clients must send to the bridge. At least 16 characters, and must differ from the service token. |
| `BOTMANCERS_MCP_HOST` | `--host` | no | `127.0.0.1` | Address to bind. |
| `BOTMANCERS_MCP_PORT` | `--port` | no | `43124` | Port to bind. `0` picks a free port. |

Flags override environment variables. Secrets are accepted only from the
environment, because command-line flags are visible to every local user in
the process list. `--service-token` and `--mcp-token` are refused.

`botmancers --help` lists the options. `botmancers --version` prints the
installed version.

### Endpoints

- `POST /mcp` is MCP Streamable HTTP. It is stateless and answers with
  `application/json`, using protocol versions `2025-11-25`, `2025-06-18`, and
  `2025-03-26`. Every request needs `Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`.
  `GET` and `DELETE` return 405 because the bridge opens no SSE stream and
  issues no session. Bodies over 256 KiB are refused with 413.
- `GET /healthz` returns `{"status":"ok","contract":"botmancers.mcp.v1","version":"<version>"}`.
  It needs no authentication and does not call Botmancers. Use the
  `botmancers_health` tool to check the end-to-end path.

### Startup checks and exit codes

Before listening, the bridge validates its configuration. It then sends
Botmancers an MCP `initialize` with the service token. That call writes
nothing and does not count against the rate limit. No error message contains
a token.

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` | Stopped by SIGINT or SIGTERM. | Nothing. |
| `2` | Configuration error: a missing or invalid variable or flag. Every problem is listed. | Fix the listed settings. |
| `3` | Cannot listen, for example because the port is already in use. | Stop the other process, or choose another `--port`. |
| `4` | Botmancers is unreachable, or `BOTMANCERS_URL` is not a Botmancers MCP endpoint (the server is not named `botmancers` or lacks a `botmancers.mcp.v1` tool). | Start the app, or fix the URL. |
| `5` | Botmancers rejected the service token, or the app has no service tokens configured. | Check `BOTMANCERS_SERVICE_TOKEN` against the app's `BOTMANCERS_SERVICE_TOKENS`. |

If Botmancers becomes unavailable after startup, tool calls return a JSON-RPC
error (`-32603`) whose `data.code` is `botmancers_unreachable`,
`botmancers_unauthorized`, or a similar code. The bridge keeps running. When
Botmancers rate-limits a tool call, the bridge answers 429 and passes on
`Retry-After`.

## Network exposure

- **Loopback by default.** The bridge binds `127.0.0.1`. While it is bound to
  loopback, it refuses any request whose `Host` is not a loopback name, and
  any `Origin` other than its own. This guards against DNS rebinding. The
  bridge does not support CORS, so browser pages cannot call it.
- **Remote MCP consumers.** A hosted agent such as Grok Bot cannot reach your
  loopback address. Put the bridge behind an HTTPS endpoint that you control,
  such as a TLS-terminating reverse proxy or tunnel, or reach it over a
  private network such as a VPN or tailnet. Do not expose it as plain HTTP on
  the public internet: the MCP token would travel in cleartext. If you bind a
  non-loopback address (`--host 0.0.0.0`), the bridge prints a warning. Keep
  the proxy or network in front of it.
- **Botmancers itself** should stay on loopback, with the bridge on the same
  machine. If `BOTMANCERS_URL` points to another host over plain `http://`,
  the bridge warns that the service token is sent unencrypted. Use `https://`
  in that case.
- Rotate a token by changing it and restarting the bridge. For the service
  token, also update its digest in the app's `BOTMANCERS_SERVICE_TOKENS`.

## Upgrade

`npx botmancers` resolves the newest release on the `latest` tag the first
time. After that, npx may reuse its cached copy. To move deliberately, name
the version:

```sh
npx botmancers@0.1.0 --version
```

To upgrade a project-local or global install:

```sh
npm install botmancers@latest       # project-local
npm install -g botmancers@latest    # global
```

Check the [changelog](CHANGELOG.md) before upgrading across a minor version
while the package is `0.x`. The tool contract version, `botmancers.mcp.v1`,
changes only with a major contract revision.

## Uninstall

Stop the bridge with Ctrl-C or SIGTERM, then remove the package:

```sh
npm uninstall botmancers        # project-local
npm uninstall -g botmancers     # global
npm cache clean --force         # optional: drops npx's cached copy
```

Finally, remove the bridge's entry from the app's `BOTMANCERS_SERVICE_TOKENS`
so its token stops working. The bridge stores no files of its own.

## Library use

The package also exports the bridge for embedding:

```js
import { createBridge, parseCli } from 'botmancers';

const command = parseCli([], process.env);
if (command.kind === 'serve') {
  const bridge = createBridge({ config: command.config });
  await bridge.upstream.preflight();
  const address = await bridge.listen();
}
```

## License

MIT
