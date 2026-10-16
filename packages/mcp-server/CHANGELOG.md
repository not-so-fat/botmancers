# Changelog

All notable changes to the `botmancers` npm package. It uses
[Semantic Versioning](https://semver.org): while the package is `0.x`, a
minor version may change the CLI or configuration. The MCP tool contract is
versioned separately, as `botmancers.mcp.v1`.

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
