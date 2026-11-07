# botmancers

Botmancers in one npm package: the web UI, the API and durable core engine,
and the authenticated [MCP](https://modelcontextprotocol.io) bridge that lets
an external agent hand a task to a Botmancers coordinator Agent and poll the
result. Examples of such agents are Cursor's Grok Bot or any other MCP client.
No source checkout or separately started app is needed.

- `botmancers setup` / `botmancers start` run the **full product**: the UI and
  core engine on `http://127.0.0.1:3333` and the MCP bridge on
  `http://127.0.0.1:3332/mcp`, under one supervisor.
- Bare `botmancers` (or `botmancers mcp`) runs **only the bridge** in front of
  a Botmancers app you run yourself, exactly as in 0.1.0, so existing MCP
  configurations keep working.

The tool contract is `botmancers.mcp.v2`, which serves every
`botmancers.mcp.v1` tool unchanged and adds service access to Agents,
sessions, conversations, and exchanges. Its JSON schema ships in this
package at `schemas/botmancers.mcp.v2.tools.json`, next to the frozen
`schemas/botmancers.mcp.v1.tools.json`; both are byte-identical to the
captures in the Botmancers repository
([`docs/contracts`](../../docs/contracts/mcp-bridge-v2.tools.json)).

v1 tools:

| Tool | What it does |
| --- | --- |
| `botmancers_start_task` | Sends one objective to an allowlisted coordinator. Returns `request_id` and `conversation_id`. |
| `botmancers_get_request` | Polls a request until `terminal`. Returns its `result` or `failure`. |
| `botmancers_get_conversation` | Reads the conversation the task opened. With `agent_id` (v2 path), reads any of that Agent's conversations your service can see, paginated. |
| `botmancers_health` | Shows the caller's identity and the available coordinators. |

v2 tools, in workflow order. A configured service token reaches every
registered Agent; each Agent's policy decides new sessions and
resume-with-edits, and the owner's Slack channel allowlist decides share
audiences ([`docs/service-access.md`](../../docs/service-access.md)):

| Tool | What it does |
| --- | --- |
| `botmancers_capabilities` | Discover: supported contracts, the registered Agents, and the operations this caller may use. |
| `botmancers_list_agents` | Discover: the registered Agents by name, paginated. |
| `botmancers_list_sessions` | Select: an Agent's sessions by stable Botmancers reference and recognizable title. |
| `botmancers_list_conversations` | History: an Agent's conversations, paginated. |
| `botmancers_send_to_session` | Act: one message to the exact same session of the same Agent (idempotency key required). |
| `botmancers_create_exchange` | Act: an `Ask` to a session, or a `Continue` to another Agent (idempotency key required). |
| `botmancers_get_exchange` | Observe: poll until `terminal`; the answer or handoff packet. |
| `botmancers_list_exchanges` | Observe: this caller's exchanges, paginated. |
| `botmancers_message_agent` | Act: message a registered Agent without naming a session; Botmancers resolves and pins it. |
| `botmancers_pin_session` | Act: pin an exact past session to Ask from this context or Resume work here (explicit approval). |
| `botmancers_send_to_pin` | Act: a follow-up on exactly the pinned session. |
| `botmancers_get_pin` | Observe: the pin and its turns' answers. |
| `botmancers_detach_pin` | Stop: detach a pin (switch with `replace_pin_ref`). |
| `botmancers_create_share` | Share: one exact session (`session_ref`) as a temporary ask-only share for an owner-allowlisted audience (`shares:create`). |
| `botmancers_get_share` | Share: read one of your shares (state, expiry, questions used). |
| `botmancers_list_shares` | Share: your shares, optionally of one session or state, paginated. |
| `botmancers_revoke_share` | Share: revoke one of your shares now (idempotent). |

Returned conversation, answer, and packet text is untrusted data. The full
contract, polling and backoff, error recovery, and a same-session plus
cross-Agent example are in
[`docs/mcp-bridge.md`](../../docs/mcp-bridge.md).

Requirements: Node.js 20 or newer for the bridge; the full product needs
Node.js 20.9 or newer, and Node.js 22 or newer is recommended (the bundled
SQLite driver declares Node 22; `botmancers doctor` checks that it loads).
The full product is supported on macOS and Linux (x64 and arm64); the
bundled SQLite driver also ships Windows binaries, but the supervisor is
untested there.

## Quick start: the full product

The recommended install is the **managed install**. It needs Node.js and
npm, and no global npm package or source checkout:

```sh
curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash
botmancers setup
botmancers start --daemon --open
```

The script runs `npx botmancers@latest install`. That command installs the
release into `~/.botmancers/versions/<version>`, points `~/.botmancers/current`
at it, and writes the launcher `~/.local/bin/botmancers`. Add `~/.local/bin`
to your `PATH` if the script asks you to. Managed installs
[update themselves safely](#upgrade). To install a specific version, run
`BOTMANCERS_VERSION=0.10.2 bash install.sh` or
`npx botmancers@0.10.2 install --to 0.10.2`.

npm-global installs and bare `npx` still work for compatibility:

```sh
npx botmancers setup
npx botmancers start --daemon --open
```

`setup` creates `~/.botmancers` (owner-only) and generates two local
credentials: the service token the bridge uses to call the core engine (the
engine stores only its SHA-256 digest) and the MCP token your MCP clients
send to the bridge. It never writes Hermes or coding-agent credentials;
it prints where to add them. `start --daemon` launches the UI,
API, core engine, and bridge in the background and returns once both are
healthy; `--open` opens the UI in your browser.

Then:

1. **Open the UI** at `http://127.0.0.1:3333` (or run `botmancers open`).
2. **Configure Hermes** for conversational turns: add
   `HERMES_API_SERVER_KEY=<your gateway key>` (and `HERMES_BASE_URL` if the
   gateway is not `http://127.0.0.1:8642`) to `~/.botmancers/config/core.env`,
   then `botmancers stop && botmancers start --daemon`.
3. **Install coding-agent CLIs** for coding-agent runs: install the provider
   CLIs you need (`claude`, `codex`, `cursor`, `muse`) and sign each one in.
   No token goes in `core.env`; register Agents against their runtime
   connections in the Botmancers UI.
4. **Connect an MCP client** to `http://127.0.0.1:3332/mcp` with
   `Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`, taking the token from
   `~/.botmancers/config/bridge.env`. For Codex, Cursor, or Claude Code,
   `botmancers setup --client codex|cursor|claude` does this for you and adds
   the optional collaboration skill
   ([Client setup and the collaboration skill](#client-setup-and-the-collaboration-skill)).
   To let `botmancers_start_task` reach a coordinator, list its Agent name in
   `core.env` as `BOTMANCERS_MCP_COORDINATORS=Tank` and restart.
5. **Check everything** with `botmancers doctor`.

For anything long-running, use the managed install, or a pinned global
release rather than `npx`: `npm install -g botmancers@0.10.2`, then run
`botmancers setup` and `botmancers start --daemon`.

### Product commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `botmancers setup` | Creates `BOTMANCERS_HOME` and its credentials; re-running keeps them and re-tightens permissions, and refreshes the clients set up with `--client`. | `0`; `9` home not writable |
| `botmancers setup --client codex\|cursor\|claude [--remove]` | Connects that MCP client to the bridge and installs the optional collaboration skill, or removes both. Files you edited are never overwritten. See [Client setup](#client-setup-and-the-collaboration-skill). | `0`; `2` usage or unsupported client; `11` client not installed; `12` conflicting files (nothing written) |
| `botmancers start [--daemon] [--open]` | Starts the UI/core and the bridge. Without `--daemon` it stays in the foreground until Ctrl-C. Starting a healthy product again changes nothing. | `0` running; `1` a previous start is degraded; `6` a port is in use; `7` the core or bridge failed (both are stopped); `8` packaged app incomplete; `9` home not writable; `10` not set up |
| `botmancers stop` | Stops the supervisor, the core, and the bridge. Safe to repeat. | `0`; `1` a process would not stop |
| `botmancers status` | Reports `healthy`, `degraded`, or `stopped`, with the install kind, launcher, the CLI, current, and pending versions, the versions the live core and bridge report, both endpoints, process ids, and the restart action. | `0` healthy; `1` degraded; `3` stopped |
| `botmancers doctor` | Checks the install kind, the launcher and `PATH` shadowing, the updater, Node, the packaged app, the home and its permissions, the credentials, the SQLite driver, ports, Hermes, provider CLIs, and the MCP clients set up with `--client`. Hermes, provider CLIs, and clients are optional and only warn. | `0` ok; `1` a check failed |
| `botmancers open` | Opens the UI in a browser (`BOTMANCERS_BROWSER` overrides the command). | `0`; `1` no browser; `3` not running |
| `botmancers mcp [options]` | Runs only the bridge; identical to bare `botmancers`. | see [bridge exit codes](#startup-checks-and-exit-codes) |
| `botmancers install [--to VERSION] [--migrate-cli] [--purge-global]` | Managed install or rollback: downloads the release into `~/.botmancers/versions/VERSION`, verifies it, makes it current, and writes the launcher. `--purge-global` also runs `npm uninstall -g botmancers`; nothing else uninstalls it. | `0`; `1` download or verification failed; `2` usage |
| `botmancers upgrade [--check] [--to VERSION] [--yes]` | Updates this install. See [Upgrade](#upgrade). | `0`; `1` failed, or this kind of install cannot update itself; `2` usage |

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
| `config/core.env` | Core engine configuration: the bridge's service-token digest and anything you add (Hermes, coordinators). Variables exported in your shell take precedence. |
| `config/bridge.env` | The bridge's service token and MCP token. Keep private. |
| `config/clients/<client>.json` | What `setup --client` manages in that client: the version, and the SHA-256 of each skill file and of the MCP entry it wrote. No token. |
| `data/` | The SQLite database and its WAL. |
| `files/`, `skills/` | File artifacts and local Agent skills. |
| `logs/` | `supervisor.log`, `core.log`, `bridge.log`, and the Hermes wait log. |
| `run/product.json` | Run metadata of the supervised product. |
| `versions/`, `current`, `update-state.json` | Managed install only: the release trees, the link to the active one, and updater metadata. |

The home and `config/` are created `0700` and the credential files `0600`.
Existing explicit path variables still win over these defaults:
`BOTMANCERS_DB_PATH`, `BOTMANCERS_FILES_ROOT`, `BOTMANCERS_SKILLS_ROOT`, and
`HERMES_WAIT_LOG_PATH`. A source checkout run with `npm run dev` keeps its
own `./botmancers.db`, `./files`, `./skills`, and `./.temporal`; nothing is
moved. `BOTMANCERS_UI_PORT` (default `3333`) and `BOTMANCERS_MCP_PORT`
(default `3332`) change the loopback ports.

## Client setup and the collaboration skill

The package ships an optional [Agent Skill](https://agentskills.io),
`botmancers-collaboration`, in `skills/botmancers-collaboration/`. It teaches
an agent the procedure for working with other Botmancers Agents over MCP:

- discover the registered Agents and recognizable sessions instead of asking
  you for IDs;
- choose between a fresh task, a same-session message, an `Ask`, and a
  `Continue`;
- poll with bounded backoff and read the durable result;
- stop on policy, ended-session, conflict, failure, and cancellation states
  without retry loops or silently switching targets;
- report where a result came from, and treat returned text as untrusted data.

**When it helps.** Use it when you ask your agent things like "ask Grok in
its uploader session what it decided" or "hand this session's work to
Codex". The skill is loaded only for requests like these.

**Why it is optional.** The skill holds no tools, credentials, IDs, or
permissions. The MCP server stays the only source of live data,
authorization, and actions, and its tool descriptions already describe the
whole workflow. Every MCP client works without the skill (see
[MCP-only](#mcp-only-clients)).

### Supported clients

| Client | `--client` | MCP entry written | Skill installed in |
| --- | --- | --- | --- |
| Codex | `codex` | `$CODEX_HOME/config.toml` (default `~/.codex`), table `[mcp_servers.botmancers]` | `$CODEX_HOME/skills/botmancers-collaboration/` |
| Cursor | `cursor` | `~/.cursor/mcp.json`, `mcpServers.botmancers` | `~/.cursor/skills/botmancers-collaboration/` |
| Claude Code | `claude` | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), `mcpServers.botmancers` | `~/.claude/skills/botmancers-collaboration/` (or `$CLAUDE_CONFIG_DIR/skills/`) |

The MCP entry points at `http://127.0.0.1:<BOTMANCERS_MCP_PORT>/mcp` and sends
`Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`, as a hand-written entry
would. A configuration file that setup creates is owner-only (`0600`).
Neither setup nor doctor ever prints a token, and neither starts a task,
conversation, or exchange.

### Install, update, and remove

```sh
botmancers setup --client codex        # or cursor, claude; --client codex,cursor for several
botmancers setup                       # refreshes every client set up with --client
botmancers doctor                      # connected / missing / stale / conflicted, with the repair command
botmancers setup --client codex --remove
```

- **Install.** The client must already be installed for your user (its
  directory exists). Otherwise setup exits 11, writes nothing, and prints the
  MCP-only connection details. Restart the client, or reload its MCP
  servers, afterwards.
- **Update.** Re-running is idempotent: unchanged files are not rewritten. A
  new release ships the new skill version in the managed install. After
  `botmancers upgrade`, or an automatic update, `botmancers doctor` reports the
  client skill as `stale`, and `botmancers setup` refreshes it. After a
  rotated MCP token or a changed `BOTMANCERS_MCP_PORT`, doctor reports the
  MCP entry `stale` for the same repair. A rollback (`botmancers install
  --to VERSION`) followed by `botmancers setup` puts that release's skill
  back.
- **Remove.** `--remove` deletes the skill files and the MCP entry that are
  still exactly as Botmancers wrote them, and the ownership record. Anything
  you edited is kept and listed.

### Managed-file ownership

Setup records each file and MCP entry it writes, with its SHA-256, in
`config/clients/<client>.json` under `BOTMANCERS_HOME`. It replaces only a file
or entry that still has the recorded hash, or that already has the wanted
content. Your own MCP servers, other keys in the configuration file, and
other skills are never touched. If the skill directory holds a file you
edited, or the configuration already has a `botmancers` server that setup
did not write, setup changes nothing for that client, exits 12, and lists
what conflicts. To hand it back to Botmancers, keep a copy of your
version, remove the listed files or entry, and re-run setup. If a write
fails part way, setup restores every file it had already changed for that
client. Credentials in `config/` are never rewritten by `--client`.

### MCP-only clients

Any other MCP client needs no setup and no skill. Connect it to the URL and
header that `botmancers setup` prints:

```text
URL     http://127.0.0.1:3332/mcp
Header  Authorization: Bearer <BOTMANCERS_MCP_TOKEN from ~/.botmancers/config/bridge.env>
```

Then follow the tool descriptions in workflow order: `botmancers_capabilities`,
`botmancers_list_agents`, `botmancers_list_sessions`, an action, and
`botmancers_get_exchange` until `terminal`
([`docs/mcp-bridge.md`](../../docs/mcp-bridge.md)). A client that supports
Agent Skills but is not listed above can also load the skill directly: copy
`skills/botmancers-collaboration/` from this package into that client's skills
directory. Setup does not manage that copy.

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
   BOTMANCERS_URL=http://127.0.0.1:3333 npx botmancers
   ```

   It prints
   `botmancers <version>: MCP bridge listening on http://127.0.0.1:3332/mcp ...`
   and keeps running until you press Ctrl-C.

4. **Connect an MCP client** to `http://127.0.0.1:3332/mcp` with the header
   `Authorization: Bearer <BOTMANCERS_MCP_TOKEN>`. Then call
   `botmancers_health`. It should return `status: "ok"` and each coordinator
   with `available: true`.

To pin an exact release, which is recommended for anything long-running:

```sh
BOTMANCERS_URL=http://127.0.0.1:3333 npx botmancers@0.10.2
```

## Bridge configuration

| Variable | Flag | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `BOTMANCERS_URL` | `--botmancers-url` | yes | none | Base URL of the Botmancers app, for example `http://127.0.0.1:3333`. Must be `http://` or `https://`, with no credentials, query, or fragment. The bridge calls `<url>/api/v0/mcp`. |
| `BOTMANCERS_SERVICE_TOKEN` | none (environment only) | yes | none | Bearer token the bridge sends to Botmancers. Its SHA-256 digest must be listed in the app's `BOTMANCERS_SERVICE_TOKENS`. |
| `BOTMANCERS_MCP_TOKEN` | none (environment only) | yes | none | Bearer token MCP clients must send to the bridge. At least 16 characters, and must differ from the service token. |
| `BOTMANCERS_MCP_HOST` | `--host` | no | `127.0.0.1` | Address to bind. |
| `BOTMANCERS_MCP_PORT` | `--port` | no | `3332` | Port to bind. `0` picks a free port. |

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
- `GET /healthz` returns `{"status":"ok","contract":"botmancers.mcp.v2","contracts":["botmancers.mcp.v1","botmancers.mcp.v2"],"version":"<version>"}`.
  It needs no authentication and does not call Botmancers. Use the
  `botmancers_health` tool to check the end-to-end path.

### Startup checks and exit codes

Before listening, the bridge validates its configuration. It then runs a
compatibility preflight: an MCP `initialize` and a `tools/list` with the
service token, never a tool call, so it writes nothing and does not count
against the rate limit. Botmancers must offer every bundled tool: all of
`botmancers.mcp.v1`, all of `botmancers.mcp.v2`, and the v2 `agent_id` path of
`botmancers_get_conversation`. Otherwise the bridge exits 4 naming exactly
what is missing, for example `it serves only botmancers.mcp.v1; this bridge
needs botmancers.mcp.v2 (missing botmancers_capabilities, ...)` or `missing
botmancers.mcp.v2 tools: botmancers_send_to_session`. Upgrade that Botmancers,
or pin a bridge release that predates v2. No error message contains a token.

Every v1 and v2 `tools/call` is forwarded to Botmancers unchanged, and its
result returned unchanged; Botmancers validates the arguments and applies
each Agent's policy.

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` | Stopped by SIGINT or SIGTERM. | Nothing. |
| `2` | Configuration error: a missing or invalid variable or flag. Every problem is listed. | Fix the listed settings. |
| `3` | Cannot listen, for example because the port is already in use. | Stop the other process, or choose another `--port`. |
| `4` | Botmancers is unreachable, or `BOTMANCERS_URL` is not a compatible Botmancers MCP endpoint (the server is not named `botmancers`, or lacks a `botmancers.mcp.v1` or `botmancers.mcp.v2` tool). | Start or upgrade the app, or fix the URL. |
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

### Managed install (automatic)

A managed install checks npm's `latest` tag at most once every 24 hours, in a
background process, so no command waits on the network. A newer release is
downloaded next to the running one under a temporary name, checked against
the registry's sha512 integrity and for a complete package, and then
recorded as **pending**. The running product is not stopped or changed.
`botmancers status` shows the versions the live core and bridge report, the
pending version, and the restart command:

```
  versions    cli 0.3.0, current 0.3.0, pending 0.3.1 (staged, not running)
  running     core 0.3.0, bridge 0.3.0 (started by 0.3.0)
  restart     botmancers stop && botmancers start --daemon   (activates 0.3.1)
```

The pending release becomes current only when `botmancers start` has checked
that no Botmancers process from this home is still running. `status`,
`open`, `doctor`, the bridge, and a running product never switch it. If the
product is still running, `start` leaves it alone and prints the restart
command. Restart once to activate the pending release:

```sh
botmancers stop && botmancers start --daemon
```

Set `BOTMANCERS_DISABLE_AUTOUPDATER=1` to turn off the automatic checks,
downloads, and activation completely. `botmancers upgrade` still works when
it is set.

Explicit commands:

```sh
botmancers upgrade --check          # installed, latest, and pending versions; changes nothing
botmancers upgrade                  # download, verify, and activate latest
botmancers upgrade --to 0.3.0       # a specific version
botmancers install --to 0.3.0       # roll back (no download if it is still installed)
```

If the product is running, `upgrade` downloads the release and marks it
pending. It does not switch versions underneath the running product. After a
rollback, the newer version is not reinstalled automatically. A later
`botmancers upgrade` moves forward again. The active release and the two most
recent other complete releases are kept, and older or incomplete release
trees are removed when a release is activated. Install, upgrade, rollback,
and pruning change only `versions/`, `current`, `update-state.json`, and the
launcher. They never touch your data, configuration, logs, or workdirs.

If `botmancers doctor` reports that another `botmancers` (for example an
npm-global copy) shadows `~/.local/bin/botmancers` on `PATH`, put
`~/.local/bin` first, or run `botmancers install --purge-global` to remove
the global copy.

### npm-global, npx, and project-local installs

These never update themselves automatically. `botmancers upgrade` on an
npm-global install asks before it runs `npm install -g botmancers@<version>`
(`--yes` skips the question). On any other kind of install, it explains how
to upgrade and changes nothing.

`npx botmancers` resolves the newest release on the `latest` tag the first
time. After that, npx may reuse its cached copy. To move deliberately, name
the version:

```sh
npx botmancers@0.10.2 --version
```

For a global full product, stop it, upgrade, and start it again. Your state
in `BOTMANCERS_HOME` is kept:

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
while the package is `0.x`. The tool contract is versioned separately: the
bundled `botmancers.mcp.v2` keeps `botmancers.mcp.v1` frozen, changes within v2
are additive, and a breaking change is a new contract version.

## Uninstall

Stop the product with `botmancers stop` (or the bridge with Ctrl-C or
SIGTERM), then remove the package:

```sh
npm uninstall botmancers        # project-local
npm uninstall -g botmancers     # global
npm cache clean --force         # optional: drops npx's cached copy
rm -rf ~/.botmancers/versions ~/.botmancers/current ~/.botmancers/update-state.json ~/.local/bin/botmancers   # managed install
```

Before deleting the home, remove the client connections:
`botmancers setup --client codex --remove` (and `cursor`, `claude`).

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
