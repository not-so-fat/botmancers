# Changelog

All notable changes to the `botmancers` npm package. It uses
[Semantic Versioning](https://semver.org): while the package is `0.x`, a
minor version may change the CLI or configuration. The MCP tool contract is
versioned separately, as `botmancers.mcp.v1`.

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
