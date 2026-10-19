# Changelog

All notable changes to the `botmancers` npm package. It uses
[Semantic Versioning](https://semver.org): while the package is `0.x`, a
minor version may change the CLI or configuration. The MCP tool contract is
versioned separately: `botmancers.mcp.v1` (frozen) and `botmancers.mcp.v2`.

## [Unreleased]

### Added

- `botmancers.mcp.v2` (additive): `botmancers_message_agent`,
  `botmancers_pin_session`, `botmancers_send_to_pin`, `botmancers_get_pin`,
  and `botmancers_detach_pin` for registered-Agent messaging and exact-session
  pins; `home` and `actions` on session items, `messaging` on Agent items,
  and a `recovery` hint on errors. Every existing tool is unchanged.
- The collaboration skill teaches registered-Agent addressing, pinned
  sessions, and the three session actions: Ask from this context, Resume
  work here, and Hand off to….

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
