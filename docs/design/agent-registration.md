# Agent registration: runtime connections, scope, and policy (NOT-502, direct-only since NOT-543)

A Botmancers Agent is a registered identity and policy attached to one runtime
connection. Every Agent launches **direct**: a turn runs as a local session of
the connection's provider CLI. There is no launch profile, deck, or run token
(Agent Deck execution was removed in 0.7.0). A granted MCP caller addresses the
registered Agent by its stable Agent ID; the service-grant principal and
capability model is separate ([service-grants.md](../service-grants.md)).

## Model

**Runtime connection** (`runtime_connections`): one usable runtime
installation/account on one host, for example "Codex on this computer". It
stores `provider` (one of `hermes|cursor|claude|codex|muse`), a `label`, and a
`host` label. It never stores credentials; `POST /api/runtime-connections`
rejects credential-shaped fields. Every provider has a seeded local connection
(`rc-local-<provider>`); the owner can add more. Several Agents may share one.

**Registered Agent** (the existing `bots` row; identity is never duplicated):

| Choice | Storage | Rules |
| --- | --- | --- |
| Identity | `id`, `name`, `description` (rules), avatar | unchanged |
| Runtime connection | `runtime_connection_id` | required; the `agent` column follows the connection provider (compatibility read) |
| Session scope | `session_scope_kind`, `session_scope_items` (JSON) | `workspaces` (absolute or `~/` paths), `sessions` (this Agent's own Botmancers session refs), or the explicit `all_provider_sessions`. Empty never means unrestricted: it is rejected and reads back unlaunchable. |
| Default workspace | `default_workspace` | optional convenience for new sessions, never authority; inside a selected workspace when the scope is `workspaces` |
| Policy | `policy_mode`, `allow_new_sessions`, `allow_resume_with_edits` | `read_only` or `workspace_write`; resume with edits requires `workspace_write` |
| Home session | `home_session_id` | optional `session_bindings.id` whose `agent_id` is this Agent (and inside a `sessions` scope) |

The pure contract lives in `lib/agent-registration.ts`; the repository write is
`bots.updateRegistration` in `lib/db.ts`; the read shape is `serializeAgent`.

## API

`POST /api/bots` takes `runtime_connection_id`, `session_scope`, optional
`default_workspace`, and `policy`. `PATCH /api/bots` merges supplied fields over
the stored registration and validates the whole candidate. Every rejection is a
400 with nothing written (create and edit, including other fields in the same
PATCH). Reads add `runtime_connection`, `session_scope`, `default_workspace`,
`policy`, `home_session_id`, and `launch_blocker`; provider session IDs and raw
storage columns are never exposed. Legacy launch fields (`launch_profile`,
`deck_id`, `working_directory`) are neither accepted nor serialized.

## Launch

A new session starts in `default_workspace`, or in the single selected
workspace when no default is set (`directLaunchWorkspace`). An Agent with no
usable launch workspace (a `sessions` scope, several workspaces without a
default, or no usable scope) fails closed and names the fix. Hermes launches on
its gateway; every other provider runs as a direct session provider
([core-engine.md](../core-engine.md)).

An Agent that cannot launch stays readable. `launch_blocker` says why:

- `agent`: the stored agent is not a known provider;
- `connection`: no usable runtime connection;
- `session_scope`: the stored scope is missing or empty.

Policy and scope are enforced during session discovery and resume. Registering
an Agent never starts a session.

## Migration

The NOT-543 direct cutover is one-way, deterministic, idempotent, and makes no
network calls (`applyDirectCutoverMigration` in `lib/db.ts`). On every load,
each row's legacy launch columns (`deck_id`, the working-directory override,
`needs_deck_selection`) are cleared and the profile reads `direct`. Agent ID,
runtime connection, scope, policy, home and default session, conversations,
Work Requests, Attempts, session bindings, Wake and service grants, and history
are untouched. Rows without a usable runtime connection stay readable and
unlaunchable until configured locally; they never fall back to another
transport. The earlier NOT-502 migration that gave pre-registration rows a
local connection, a `workspaces` scope of the directory they already launched
in, and the `read_only` policy (`MIGRATED_POLICY`) still applies to such rows.

## UI

New Agent and the Config "Agent" card render, in order and as separate
controls: Runtime connection (with Add connection), Session scope, Default
workspace, Policy, and on Config the Home session. Nothing that grants
authority is preselected. `test-agent-registration-ui.js` covers the states
(loading, validation), keyboard semantics, and narrow/desktop layout.
