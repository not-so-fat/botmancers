# Agent registration: runtime connections and launch profiles (NOT-502)

A Botmancers Agent is a registered identity and policy attached to one runtime
connection. Agent Deck is an optional launch profile, not a prerequisite. A Grok
Bot or another granted MCP caller addresses the registered Agent by its stable
Agent ID whether it launches directly or through Agent Deck; the service-grant
principal/capability model is unchanged.

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
| Launch profile | `launch_profile` | `direct` or `agent_deck`; `NULL` is an unresolved legacy row |
| Agent Deck settings | `deck_id`, `working_directory` | `agent_deck` only; switching to `direct` clears them |
| Policy | `policy_mode`, `allow_new_sessions`, `allow_resume_with_edits` | `read_only` or `workspace_write`; resume with edits requires `workspace_write` |
| Home session | `home_session_id` | optional `session_bindings.id` whose `agent_id` is this Agent (and inside a `sessions` scope) |

The pure contract lives in `lib/agent-registration.ts`; the repository write is
`bots.updateRegistration` in `lib/db.ts`; the read shape is `serializeAgent`.

## API

`POST /api/bots` takes `runtime_connection_id`, `launch_profile`,
`session_scope`, optional `default_workspace`, `policy`, and (agent_deck only)
`deck_id` / `working_directory`. `PATCH /api/bots` merges supplied fields over
the stored registration and validates the whole candidate. Every rejection is a
400 with nothing written (create and edit, including other fields in the same
PATCH). Reads add `runtime_connection`, `session_scope`, `default_workspace`,
`launch_profile`, `needs_launch_profile`, `policy`, `home_session_id`, and
`launch_blocker`; provider session IDs and raw storage columns are never exposed.

Compatibility: the NOT-456 create shape `{ agent, deck_id, working_directory? }`
is an Agent Deck registration on the agent's local connection, scoped to its
launch workspace, with the migration policy. A PATCH with `deck_id` alone
chooses `agent_deck` (an invalid combination on a `direct` Agent); an unresolved
row edited only through `agent` / `working_directory` stays unresolved.

## Launch

- `agent_deck`: unchanged NOT-456/NOT-487 behavior; requires a selected,
  well-formed deck ID chosen from the verified Agent Deck deck list.
- `direct`: never contacts Agent Deck (dispatch, roster, New Agent, and Config
  do not request the deck list). Hermes launches on its gateway. Direct
  coding-agent sessions arrive with provider session execution (a dependent
  ticket); until then those Agents are fully registered but report
  `launch_blocker: direct_runtime` and fail closed with a fixed message.
- unresolved (`NULL` profile): readable, never launchable, and the thread notice
  asks the owner to select a deck or choose Direct.

Policy and scope are stored and validated here; enforcing them during session
discovery/resume belongs to the dependent provider-session tickets. Registering
an Agent never starts a session.

## Migration

Deterministic and idempotent (no network), on DB load, for each row without a
`runtime_connection_id`:

- connection: the local connection for the row's agent;
- profile: `agent_deck` when a deck ID is selected and no re-selection is
  pending; otherwise `NULL` (unresolved, never silently `direct`);
- scope: `workspaces` with exactly the directory the Agent already launched in
  (its override, else `~/.botmancers/<id>`), so authority never widens;
- policy: `read_only`, new sessions allowed, resume with edits off.

`deck_id`, `deck_name`, `working_directory`, `needs_deck_selection`, identity,
and every other table (conversations, messages, work requests, attempts,
session bindings, wake grants, launch snapshots, events) are left untouched;
the service-grant file is not read or written. `test-agent-registration.js`
proves this on a before/after fixture.

## UI

New Agent and the Config "Agent" card render, in order and as separate
controls: Runtime connection (with Add connection), Session scope, Default
workspace, Launch profile, Policy, and on Config the Home session. Deck and
working-directory controls render only for the Agent Deck profile. Nothing that
grants authority is preselected. `test-agent-registration-ui.js` covers the
states (loading, validation, Agent Deck unavailable), keyboard semantics, and
narrow/desktop layout.
