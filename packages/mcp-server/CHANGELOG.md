# Changelog

All notable changes to the `botmancers` npm package. It uses
[Semantic Versioning](https://semver.org): while the package is `0.x`, a
minor version may change the CLI or configuration. The MCP tool contract is
versioned separately: `botmancers.mcp.v1` (frozen) and `botmancers.mcp.v2`.

## [Unreleased]

## [0.10.0] - 2026-11-05

### Added

- Agent pages show your machine's coding-agent capacity in a top bar. Claude
  Code, Codex, and Muse show the 5-hour and weekly (5H, 1W) remaining
  percentage, and Cursor shows the monthly billing cycle (1M); a provider that
  does not report capacity says why. Claude capacity is read from the local
  `~/.claude.json` usage cache (read only), and Codex capacity from its local
  `codex app-server`. Nothing is sent anywhere and no credentials are read. It
  is served to the UI by a new owner route, `GET /api/runtime-capacity`.
- "Make it reachable" has one-click setup per client: Cursor, Codex, and
  Claude Code buttons, each with its logo, copy that client's
  `botmancers setup --client <client>` command.
- The Agent header shows the harness logo next to the Agent's runtime.

## [0.9.3] - 2026-11-05

### Changed

- Agent Config now opens inside the Agent area at `/agents/:id/config`, with
  its tab selected, instead of as a separate page. Old `/bots/:id/config`
  links redirect there.
- The Agent rail avatars are larger so the outline marks read next to the
  Agent header.

## [0.9.2] - 2026-11-05

### Changed

- The Agent Overview leads with how to reach the Agent instead of describing
  the product. The hero and capability tags are gone, and the instructions
  panel links to "Config". The start guide is now "Make it reachable": use it
  from a coding agent (a copyable `botmancers setup --client cursor` command,
  with `codex` and `claude` as alternatives), share a session to Slack, then
  message it in Botmancers.

## [0.9.1] - 2026-11-04

### Fixed

- The Agent header and tabs no longer collapse in short browser windows: the
  header and tab bar keep their size so the tab labels stay readable.

## [0.9.0] - 2026-11-04

### Changed

- Opening Botmancers no longer drops you into a chat: `/` now goes to the
  first Agent's Overview. Each Agent has its own area with an Agent rail and
  an Overview home, with Conversations, Sessions, Activity and Slack pages
  under it. Overview shows the Agent's capabilities, standing instructions,
  runtime and messaging status, active sessions, recent activity and a "Use
  this Agent" start guide. Slack shows relay health and sharing readiness, and
  lists the Agent's shared sessions with details and Revoke. The Agent config
  page's "Back to chat" link is now "Back to Overview".
- Chat moved into Conversations: a durable history list (with search and
  Load older conversations) and a detail page for each conversation. Old `/threads/:id` links and bare `/?agent=` links
  redirect to the matching Conversations page, and an exchange's thread link
  opens the Agent's conversation detail.
- Sessions is now a full page for scanning and reviewing an Agent's sessions,
  replacing the Sessions drawer. It keeps the 0.8.0 paging, title search,
  workspace filter, sync status and Refresh, and a session can be opened
  directly by link. Session rows now show where the session came from (Human
  origin, Service origin, or the requesting Agent) and its conversation.
- Activity lists what the Agent did as readable operations, with each item's
  raw details collapsed behind it. Provider transcripts and identifiers are
  not shown.

The MCP tool contracts (`botmancers.mcp.v1` and `botmancers.mcp.v2`) and the
CLI are unchanged.

## [0.8.0] - 2026-11-04

### Added

- Past-session history is synced when an Agent is registered, for every
  provider that can list sessions (not only Claude Code). A listing failure
  is logged and never rolls back the registration.
- The session catalog stays fresh: a scheduled sync runs at startup and then
  every `BOTMANCERS_SESSION_SYNC_INTERVAL_MS` (default 900000, `0` disables),
  and `POST /api/bots/:id/sessions/sync` runs one guarded manual sync (409
  `sync_in_progress` when one is already running).
- Sessions the provider no longer reports are marked as missing instead of
  being left looking live. This happens only after a complete sync: never on
  a listing error, an incomplete sync, or an empty listing while sessions are
  stored. Nothing is deleted, and a session the provider reports again
  becomes available again.
- The Sessions drawer shows the last sync time with a Refresh button, and its
  empty states say why it is empty: never synced, sync failed (with Retry),
  none in scope, or none exist.
- The Sessions drawer is paged (50 rows by default, Load more) and has a title
  search and a workspace filter, with a readable title on every row.

## [0.7.0] - 2026-11-03

### Changed

- Coding-agent Wakes now launch directly through the local Claude Code,
  Codex, Cursor, or Muse session providers. Agent Deck is no longer part of
  execution: its settings, deck list, launch profile, and Git finalization
  are removed, and existing Agent registrations are migrated one way to the
  direct contract (agent, runtime connection, and session scope). Wakes that
  were mid-flight on a legacy transport are reconciled as interrupted. Dispatch
  runs on a new direct session-provider adapter (fresh start, exact-ref
  resume, observe, cancel, usage, restart-safe replay).
- Configuration: `AGENT_DECK_RUN_TOKEN` is no longer read from `core.env` and
  `BOTMANCERS_AGENT_DECK_URL` is gone. To run coding agents, install the
  `claude`, `codex`, `cursor`, and `muse` CLIs you need, sign each one in, and
  register Agents against their runtime connections in the UI.
- `botmancers doctor` checks for the provider CLIs on `PATH` (a warning, not a
  failure) instead of Agent Deck, and `botmancers setup` no longer prints
  Agent Deck steps.
- The UI follows: Settings shows local runtime status with no server URL,
  Agent registration shows only connection, scope, workspace, and policy, the
  roster shows Agent plus connection, and a failed turn is shown in the thread
  as `[Agent failed]`.
- `botmancers.mcp.v2` tool descriptions no longer mention a Deck. No tool,
  input, or output changed.

## [0.6.1] - 2026-10-25

### Fixed

- The bridge now handles `SIGINT` and `SIGTERM` before it announces that it is
  listening, so a signal sent as soon as that line appears exits cleanly
  instead of killing the process. This race failed the 0.6.0 tag check on the
  Linux release runner.

### Changed

- Includes the 0.6.0 and 0.5.1 changes (below), which were not published.

## [0.6.0] - 2026-10-25

Not published; see 0.6.1.

### Added

- Session sharing to Slack. The owner can share a session into a Slack
  thread; replies in that exact thread are Asked of the session and answered
  there. Shares have an owner lifecycle (create, revoke, expiry), a share
  policy (a Slack channel allowlist and an explicit `share_from_turn`
  switch), and a Sessions share section and Agent Config card in the UI.
  Expired shares are swept automatically.
- `botmancers.mcp.v2` (additive): `botmancers_create_share`,
  `botmancers_get_share`, `botmancers_list_shares`, and
  `botmancers_revoke_share`. Every existing tool is unchanged. The four new
  tools are marked `botmancers/optional`: the bridge still starts against a
  Botmancers that serves the earlier v2 surface without them.
- A Claude Code or Codex turn launched by Botmancers can share its own exact
  session through a launch-bound `botmancers_share_current_session` tool.
  Its context is minted per launch and ends with the launch, turn, or thread.
- Native Slack Socket Mode transport. Slack is enabled only when both Slack
  tokens and a valid share configuration are present, and the tokens never
  reach the bridge. Deliveries are deduplicated across retries and restarts.
- `botmancers doctor` reports the Slack relay state, without tokens.

### Changed

- The release check bounds its test and smoke runs with hard time limits, so
  a hung test fails by name instead of cancelling CI.
- Includes the 0.5.1 change (below), which was not published.

## [0.5.1] - 2026-10-19

Not published; see 0.6.1.

### Changed

- Registering a Claude Code Agent now imports its in-scope past sessions
  right away, so the Sessions drawer and message routing can use that history
  immediately. The import is read-only and never starts Claude; if the local
  session store is unavailable, registration still succeeds.

## [0.5.0] - 2026-10-19

### Added

- `botmancers.mcp.v2` (additive): `botmancers_message_agent`,
  `botmancers_pin_session`, `botmancers_send_to_pin`, `botmancers_get_pin`,
  and `botmancers_detach_pin` for registered-Agent messaging and exact-session
  pins; `home` and `actions` on session items, `messaging` on Agent items,
  and a `recovery` hint on errors. Every existing tool is unchanged.
  The five new tools are marked `botmancers/optional`: the bridge still
  starts against a Botmancers that serves the earlier v2 surface without them.
- The collaboration skill teaches registered-Agent addressing, pinned
  sessions, and the three session actions: Ask from this context, Resume
  work here, and Hand off to….
- Native session providers behind a `SessionProvider` boundary: Botmancers
  discovers and resumes sessions created by Claude Code, Codex, Cursor
  (Agent CLI or SDK), and Muse Code, and imports them as native sessions.
- Sessions show reported token usage and cost.

### Changed

- Agent Deck is now an optional launch profile at registration, not a
  requirement.
- The default ports are now UI 3333 and MCP 3332. Update any configuration
  or bookmarks that use the old ports, or set the ports explicitly.
- `npm run release:publish` no longer needs `--otp`; npm's browser login
  works.

## [0.4.2] - 2026-10-17

### Changed

- Releases are published once, straight to `latest`, by the maintainer
  (`npm run release:publish`). The `canary` dist-tag, the CI publish, npm
  trusted publishing, and the bootstrap token are gone;
  `release-botmancers.yml` now only runs the release check on the tag. The
  package contents are unchanged from 0.4.1.
- 0.4.1 was tagged but never published, so 0.4.2 carries its contents
  (below) and the 0.4.0 contents.

## [0.4.1] - 2026-10-17

Not published; see 0.4.2.

### Fixed

- 0.4.0 was never published: its release check failed on the Linux release
  runner. `npm test` passed a directory to `node --test`, which Node 24 treats
  as a module path; it now passes a glob. The clean-install smoke signalled
  `npx`, which on npm 11.19 does not forward `SIGTERM` to the bridge; it now
  signals the process group and checks that the bridge port closes.
- `release:check` shows the failing test and smoke output, drains stdout
  before exiting, and writes its `--out` transcript as it goes.

### Changed

- A `ci-botmancers` workflow runs the same release check on pull requests that
  touch the app or the package, so release failures show up before a tag.
- 0.4.1 carries everything 0.4.0 would have shipped (below).

## [0.4.0] - 2026-10-17

Not published; see 0.4.1.

### Added

- The Botmancers app bundled in the package adds the durable Agent session
  catalog and Sessions UI, session-targeted Ask and Continue exchanges with
  inline exchange cards, and an Agent Exchanges ledger.
- Service grants let the owner give another Agent narrow, audited access to
  sessions, conversations, and exchanges (`docs/service-grants.md`). Grants
  are re-checked at read time, and an unregistered Agent invalidates the
  document.

- `botmancers setup --client codex|cursor|claude [--remove]`: connects the
  client to the local MCP bridge and installs the optional
  `botmancers-collaboration` Agent Skill (shipped in `skills/`). An
  ownership record in `config/clients/<client>.json` (versions and SHA-256
  hashes, no token) lets re-runs, upgrades, and rollbacks refresh only
  unmodified Botmancers files. Edited or foreign files are never overwritten
  (exit 12), a missing client writes nothing (exit 11), and a failed write is
  rolled back. Plain `botmancers setup` refreshes the clients already set up.
  `botmancers doctor` reports each client as connected, missing, stale, or
  conflicted, with the repair command.

- MCP contract `botmancers.mcp.v2`: `botmancers_capabilities`,
  `botmancers_list_agents`, `botmancers_list_sessions`,
  `botmancers_list_conversations`, `botmancers_send_to_session`,
  `botmancers_create_exchange`, `botmancers_get_exchange`, and
  `botmancers_list_exchanges`, plus a v2 (`agent_id`) path of
  `botmancers_get_conversation`, over the owner's service grants. The bundled
  schema is `schemas/botmancers.mcp.v2.tools.json`; every v2 call is forwarded
  unchanged. `GET /healthz` adds `contracts`. Library exports add
  `MCP_CONTRACT_V1`, `MCP_CONTRACTS`, `TOOL_SCHEMA_V1_URL`, and
  `toolContractOf`.

### Changed

- `MCP_CONTRACT` and `/healthz` `contract` are now `botmancers.mcp.v2`;
  `tools/list` returns the v1 tools unchanged, then the v2 tools.
- Startup preflight refuses (exit 4) a Botmancers that lacks any bundled v1 or
  v2 tool, or the v2 path of `botmancers_get_conversation`, and names what is
  missing. It still sends only `initialize` and `tools/list`.

## [0.3.0] - 2026-10-16

### Added

- Managed install, following the Agent Deck / Agent Dealer contract:
  `curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash`
  or `botmancers install [--to VERSION] [--migrate-cli] [--purge-global]`
  installs the exact npm release into `~/.botmancers/versions/<version>`,
  checks its sha512 integrity and contents, atomically points
  `~/.botmancers/current` at it, and writes the stable launcher
  `~/.local/bin/botmancers`. Existing data, configuration, logs, and workdirs
  are not touched.
- Safe automatic updates for managed installs, on by default: at most one
  background npm `latest` check per 24 hours, a verified download next to the
  running release, and activation only at the next `botmancers start` once no
  Botmancers process from the home is live. `status`, `open`, `doctor`, the
  bridge, and a running product never switch releases.
  `BOTMANCERS_DISABLE_AUTOUPDATER=1` turns all of it off. Explicit installs,
  upgrades, and rollbacks wait for a background download (`update.lock`), and
  a start's stopped check, any release switch, and the supervisor's claim on
  the home are serialized (`run/start.lock`). A release is made current only
  when every module its CLI loads and this platform's better-sqlite3 binary
  are present.
- `botmancers upgrade [--check] [--to VERSION] [--yes]`: managed installs
  download, verify, and activate (or stage while the product runs).
  npm-global installs keep the prompted `npm install -g botmancers@<version>`.
  npx, project-local, and source-checkout copies report how to upgrade and
  never change themselves.
- Rollback with `botmancers install --to <older>`. The newer version is then
  not reinstated automatically. Activation keeps the active release and the
  two newest other complete releases, and removes incomplete trees.
- `status` and `doctor` report the install kind, launcher, `PATH` shadowing,
  the CLI, current, and pending versions, the versions the live core and
  bridge report, and the restart action.

### Fixed

- After a release switch beneath a running product, the newer CLI reports the
  old core and bridge versions as degraded instead of treating the old bridge
  as not running (NOT-279 class). It can still stop that product. The run
  record now stores the CLI path the product was started from.

## [0.2.0] - 2026-10-16

### Added

- The full Botmancers product in the package: the production Next.js UI, API
  routes, and core engine (standalone server under `app/`, with every
  platform's SQLite prebuild) next to the MCP bridge.
- `botmancers setup`: creates `BOTMANCERS_HOME` (default `~/.botmancers`)
  owner-only and generates the bridge-to-core service token (the engine
  stores only its digest) and the inbound MCP token; prints the Hermes and
  Agent Deck steps without writing their credentials.
- `botmancers start [--daemon] [--open]`, `stop`, `status`, `doctor`, and
  `open`: one supervisor runs the UI/core on `127.0.0.1:43123` and the bridge
  on `127.0.0.1:43124`, with one health model (healthy / degraded /
  stopped), idempotent start, stale run-metadata repair, and deterministic
  exit codes.
- `botmancers mcp`, the explicit bridge-only command.
- Core `GET /api/health` reporting the running release version.

### Changed

- Installed-product state (database, files, skills, logs, configuration, run
  metadata) lives under `BOTMANCERS_HOME` regardless of the launch directory.
  Explicit `BOTMANCERS_DB_PATH`, `BOTMANCERS_FILES_ROOT`,
  `BOTMANCERS_SKILLS_ROOT` (new), and `HERMES_WAIT_LOG_PATH` still win; a
  source checkout without `BOTMANCERS_HOME` keeps its cwd-relative files.
- Bare `botmancers` is unchanged (bridge only, same flags, environment, and
  exit codes); `--help` now also points to the product commands.

## [0.1.0] - 2026-10-15

### Added

- `botmancers` CLI (`npx botmancers`), a standalone Streamable HTTP MCP bridge
  that forwards the `botmancers.mcp.v1` tools to a Botmancers app's
  `/api/v0/mcp` endpoint.
- Configuration through `BOTMANCERS_URL`, `BOTMANCERS_SERVICE_TOKEN`,
  `BOTMANCERS_MCP_TOKEN`, `BOTMANCERS_MCP_HOST`, and `BOTMANCERS_MCP_PORT`,
  with `--botmancers-url`, `--host`, and `--port` flags. The bridge binds
  loopback by default.
- A startup preflight against Botmancers. Configuration, listen,
  reachability, and credential failures each have their own exit code, and
  their messages are redacted.
- `GET /healthz` liveness endpoint.
- The versioned tool schema at `schemas/botmancers.mcp.v1.tools.json`, and a
  library export (`createBridge`, `parseCli`, and related functions).
