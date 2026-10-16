# botmancers

Botmancers in one npm package: the web UI, the API and durable core engine,
and the authenticated [MCP](https://modelcontextprotocol.io) bridge that lets
an external agent hand a task to a Botmancers coordinator Agent and poll the
result. Examples of such agents are Cursor's Grok Bot or any other MCP client.
No source checkout or separately started app is needed.

- `botmancers setup` / `botmancers start` run the **full product**: the UI and
  core engine on `http://127.0.0.1:43123` and the MCP bridge on
  `http://127.0.0.1:43124/mcp`, under one supervisor.
- Bare `botmancers` (or `botmancers mcp`) runs **only the bridge** in front of
  a Botmancers app you run yourself, exactly as in 0.1.0, so existing MCP
  configurations keep working.

The tool contract is `botmancers.mcp.v1`, and its JSON schema ships in this
package at `schemas/botmancers.mcp.v1.tools.json`.

| Tool | What it does |
| --- | --- |
| `botmancers_start_task` | Sends one objective to an allowlisted coordinator. Returns `request_id` and `conversation_id`. |
| `botmancers_get_request` | Polls a request until `terminal`. Returns its `result` or `failure`. |
| `botmancers_get_conversation` | Reads the conversation the task opened. |
| `botmancers_health` | Shows the caller's identity and the available coordinators. |

Requirements: Node.js 20 or newer for the bridge; the full product needs
Node.js 20.9 or newer, and Node.js 22 or newer is recommended (the bundled
SQLite driver declares Node 22; `botmancers doctor` checks that it loads).
The full product is supported on macOS and Linux (x64 and arm64); the
bundled SQLite driver also ships Windows binaries, but the supervisor is
untested there.

## Quick start: the full product

```sh
npx botmancers setup
npx botmancers start --daemon --open
```

`setup` creates `~/.botmancers` (owner-only) and generates two local
credentials: the service token the bridge uses to call the core engine (the
engine stores only its SHA-256 digest) and the MCP token your MCP clients
send to the bridge. It never writes Hermes, Agent Deck, or coding-agent
credentials; it prints where to add them. `start --daemon` launches the UI,
API, core engine, and bridge in the background and returns once both are
healthy; `--open` opens the UI in your browser.

Then:

1. **Open the UI** at `http://127.0.0.1:43123` (or run `botmancers open`).
2. **Configure Hermes** for conversational turns: add
   `HERMES_API_SERVER_KEY=<your gateway key>` (and `HERMES_BASE_URL` if the
   gateway is not `http://127.0.0.1:8642`) to `~/.botmancers/config/core.env`,
   then `botmancers stop && botmancers start --daemon`.
3. **Configure Agent Deck** for coding-agent runs: install Agent Deck so
   `agent-deck` is on `PATH` and its server runs on `http://127.0.0.1:1111`,
   and add `AGENT_DECK_RUN_TOKEN=<token issued by Agent Deck>` to `core.env`.
4. **Connect an MCP client** to `http://127.0.0.1:43124/mcp` with
   `Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`, taking the token from
   `~/.botmancers/config/bridge.env`. To let `botmancers_start_task` reach a
   coordinator, list its Agent name in `core.env` as
   `BOTMANCERS_MCP_COORDINATORS=Tank` and restart.
5. **Check everything** with `botmancers doctor`.

For anything long-running, install a pinned release instead of using `npx`:
`npm install -g botmancers@0.2.0`, then run `botmancers setup` and
`botmancers start --daemon`.

### Product commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `botmancers setup` | Creates `BOTMANCERS_HOME` and its credentials; re-running keeps them and re-tightens permissions. | `0`; `9` home not writable |
| `botmancers start [--daemon] [--open]` | Starts the UI/core and the bridge. Without `--daemon` it stays in the foreground until Ctrl-C. Starting a healthy product again changes nothing. | `0` running; `1` a previous start is degraded; `6` a port is in use; `7` the core or bridge failed (both are stopped); `8` packaged app incomplete; `9` home not writable; `10` not set up |
| `botmancers stop` | Stops the supervisor, the core, and the bridge. Safe to repeat. | `0`; `1` a process would not stop |
| `botmancers status` | Reports `healthy`, `degraded`, or `stopped`, with the running version, both endpoints, and process ids. | `0` healthy; `1` degraded; `3` stopped |
| `botmancers doctor` | Checks Node, the packaged app, the home and its permissions, the credentials, the SQLite driver, ports, Hermes, and Agent Deck. Hermes and Agent Deck are optional and only warn. | `0` ok; `1` a check failed |
| `botmancers open` | Opens the UI in a browser (`BOTMANCERS_BROWSER` overrides the command). | `0`; `1` no browser; `3` not running |
| `botmancers mcp [options]` | Runs only the bridge; identical to bare `botmancers`. | see [bridge exit codes](#startup-checks-and-exit-codes) |

`healthy` means the supervisor and both processes are alive, the core's
`GET /api/health` and the bridge's `GET /healthz` report the installed
version, and an authenticated bridge call reaches the core. Anything else
that is running is `degraded` and never reported healthy: one process down,
a version mismatch, or a start that has not finished. Run metadata whose
processes are gone is removed automatically. Each process is recorded with
its start time, and a recorded process id is only signalled when both its
start time and its command line still match, so a recycled PID (even another
Next.js server) is never touched. When identity cannot be verified (no `ps`,
or metadata from an older release) nothing is signalled and the metadata is
kept; the same holds if a process survives `stop`, so `status` keeps
reporting it and `stop` can be retried.

### Where state lives

Everything the product writes lives under `BOTMANCERS_HOME` (default
`~/.botmancers`), whatever directory you start it from:

| Path | Contents |
| --- | --- |
| `config/core.env` | Core engine configuration: the bridge's service-token digest and anything you add (Hermes, Agent Deck, coordinators). Variables exported in your shell take precedence. |
| `config/bridge.env` | The bridge's service token and MCP token. Keep private. |
| `data/` | The SQLite database and its WAL. |
| `files/`, `skills/` | File artifacts and local Agent skills. |
| `logs/` | `supervisor.log`, `core.log`, `bridge.log`, and the Hermes wait log. |
| `run/product.json` | Run metadata of the supervised product. |

The home and `config/` are created `0700` and the credential files `0600`.
Existing explicit path variables still win over these defaults:
`BOTMANCERS_DB_PATH`, `BOTMANCERS_FILES_ROOT`, `BOTMANCERS_SKILLS_ROOT`, and
`HERMES_WAIT_LOG_PATH`. A source checkout run with `npm run dev` keeps its
own `./botmancers.db`, `./files`, `./skills`, and `./.temporal`; nothing is
moved. `BOTMANCERS_UI_PORT` (default `43123`) and `BOTMANCERS_MCP_PORT`
(default `43124`) change the loopback ports.

## Bridge only

Use bare `botmancers` (or `botmancers mcp`) when you run the Botmancers app
yourself, for example from a source checkout. Requirements: Node.js 20 or
newer and a running Botmancers app.

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
BOTMANCERS_URL=http://127.0.0.1:43123 npx botmancers@0.2.0
```

## Bridge configuration

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
  machine. `botmancers start` binds both the UI/core and the bridge to
  `127.0.0.1` only. If `BOTMANCERS_URL` points to another host over plain `http://`,
  the bridge warns that the service token is sent unencrypted. Use `https://`
  in that case.
- Rotate a token by changing it and restarting the bridge. For the service
  token, also update its digest in the app's `BOTMANCERS_SERVICE_TOKENS`.

## Upgrade

`npx botmancers` resolves the newest release on the `latest` tag the first
time. After that, npx may reuse its cached copy. To move deliberately, name
the version:

```sh
npx botmancers@0.2.0 --version
```

For the full product, stop it, upgrade, and start it again; your state in
`BOTMANCERS_HOME` is kept:

```sh
botmancers stop
npm install -g botmancers@latest
botmancers start --daemon
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

Stop the product with `botmancers stop` (or the bridge with Ctrl-C or
SIGTERM), then remove the package:

```sh
npm uninstall botmancers        # project-local
npm uninstall -g botmancers     # global
npm cache clean --force         # optional: drops npx's cached copy
```

For the full product, delete `~/.botmancers` (or your `BOTMANCERS_HOME`)
only if you also want to delete its database, files, and credentials.

For the bridge only, remove its entry from the app's
`BOTMANCERS_SERVICE_TOKENS` so its token stops working. The bridge stores no
files of its own.

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
