# Botmancers

Botmancers lets a developer stay in one conversation while a persistent bot
delegates coding work to local coding agents on the Mac.

Each Agent is registered against one runtime connection — one Hermes,
Cursor, Claude, Codex, or Muse Code installation/account on one host, such as
"Codex on this computer" — with an explicit session scope, an optional default
workspace, a launch policy, and a launch profile: `direct` or `agent_deck`.
Only the Agent Deck profile selects a deck from the workspace Agent Deck server
(plus an optional working directory); a direct Agent never contacts Agent Deck.
Hermes turns run on the persistent Hermes gateway; Agent Deck coding agents
launch through Agent Deck. An Agent without a chosen launch profile (or, on the
Agent Deck profile, without a selected deck) stays readable but cannot launch.
See [`docs/design/agent-registration.md`](docs/design/agent-registration.md).

When asked to implement and review a change, a coordinator Agent such as Tank
wakes a developer Agent, evaluates the result, wakes a separate reviewer, and
can wake the developer again to revise in its original coding session. Every
result returns to the same conversation. The user does not copy prompts or
session identifiers and does not configure a workflow form.

The roster shows `Agent: <agent> · Agent Deck: <deck>` (or `Launch: Direct`),
and the per-Agent configuration page shows each registration choice separately. Availability lists only agents with a real, available launch path.
The thread shows Wakes, Work Request status, results, and failures as
conversation events.

The embedded example model loop has been removed. It is not part of the
Botmancers execution architecture and has no replacement generic-model role.

## Architecture

[`docs/core-engine.md`](docs/core-engine.md) is the only current product and
architecture authority: conversations, Wakes, Work Requests, Attempts, Session
Bindings, the safety policy, the persistent schema, and the remaining
convergence work. Where another document disagrees with it, it wins.

Some current documents are subordinate to it and stay in force within their
scope:

- contracts it adopts: the Wake contract
  ([`docs/wake-contract-v1.md`](docs/wake-contract-v1.md), with its schema and
  fixtures in [`docs/contracts/`](docs/contracts)), the Wake safety contract
  ([`docs/design/2026-10-14-wake-safety-contract.md`](docs/design/2026-10-14-wake-safety-contract.md)),
  and the git finalization contract
  ([`docs/design/2026-10-13-git-finalization-contract.md`](docs/design/2026-10-13-git-finalization-contract.md));
- operational runbooks and compatibility records: the acceptance harness
  ([`docs/acceptance-harness.md`](docs/acceptance-harness.md)) and the `[run]`
  payload migration record
  ([`docs/run-payload-migration.md`](docs/run-payload-migration.md));
- the external-agent intake: the MCP bridge contract
  ([`docs/mcp-bridge.md`](docs/mcp-bridge.md), tool schemas in
  [`docs/contracts/mcp-bridge-v2.tools.json`](docs/contracts/mcp-bridge-v2.tools.json),
  with the frozen v1 capture
  [`docs/contracts/mcp-bridge-v1.tools.json`](docs/contracts/mcp-bridge-v1.tools.json))
  and the Cursor Grok Bot runbook
  ([`docs/integrations/grok-bot/README.md`](docs/integrations/grok-bot/README.md)).

Every other document under `docs/` is dated history or evidence, labeled as
such at its top, and is not a current contract.

## Current status

The application can:

- create, open, mention, and delete individual agents (legacy group data
  stays stored and reachable through `/api/groups`, but the UI shows agents
  only);
- accept UI and `/api/v0` messages through one conversation intake that
  records durable Work Requests;
- converse through the persistent Hermes runtime and launch coding agents
  through `agent-deck run`;
- route coordinator Wakes with grants, depth, budget, and concurrency limits,
  return results to the coordinator, and recover running work after a restart;
- show a dark roster-and-thread UI with unread tracking;
- draft outbound message proposals, gate actions behind Approve/Deny
  approval requests, and write file artifacts from chat;
- run taught one-shots and recurring routines, and park a turn on one
  ask-and-wait question;
- accept tasks from external agents, such as Cursor's Grok Bot, through an
  authenticated MCP bridge (see "External agents" below);
- import bot identity from the Grok marketplace boundary;
- persist state in SQLite.

Web UI thread turns are Work Requests run by the UI turn executor. See
"Current code and convergence" in `docs/core-engine.md`.

## External agents (MCP bridge)

An external MCP client can hand a task to an allowlisted coordinator Agent and
poll the result. The app serves the `botmancers.mcp.v1` tools at
`POST /api/v0/mcp`, behind a service token. The caller supplies only a
coordinator, an objective, and an idempotency key; it cannot choose a runtime,
Deck, model, grant, or target. The contract is in
[`docs/mcp-bridge.md`](docs/mcp-bridge.md).

Beyond that narrow bridge, the owner can grant a service explicit,
per-Agent access to discover Agents, read their sessions and conversations,
send one read-only message to an exact session, and start `Ask`/`Continue`
exchanges, through `/api/v0` and an owner-only grants document. Setup,
rotation, rollback, and least-privilege examples are in
[`docs/service-grants.md`](docs/service-grants.md).

The same granted access is an MCP contract, `botmancers.mcp.v2`, served next
to the unchanged v1 tools: `botmancers_capabilities`, `botmancers_list_agents`,
`botmancers_list_sessions`, `botmancers_list_conversations`,
`botmancers_get_conversation` (with `agent_id`), `botmancers_send_to_session`,
`botmancers_create_exchange`, `botmancers_get_exchange`, and
`botmancers_list_exchanges`. Their descriptions alone carry the
discover, select, act, observe workflow; returned transcript text is
untrusted data. See [`docs/mcp-bridge.md`](docs/mcp-bridge.md).

The [`botmancers`](packages/mcp-server/README.md) npm package
(`packages/mcp-server`) ships the whole product: the UI, API, core engine,
and the bridge, run by one supervisor with no checkout needed:

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash
botmancers setup
botmancers start --daemon --open    # UI 127.0.0.1:43123, MCP 127.0.0.1:43124/mcp
```

That is the recommended managed install: the release lives in
`~/.botmancers/versions/<version>` behind the `~/.local/bin/botmancers`
launcher. It updates itself in the background and activates a new release
only at the next `botmancers start`; `BOTMANCERS_DISABLE_AUTOUPDATER=1` turns
that off. `npx botmancers ...` and `npm install -g botmancers` still work.
Its state lives under `BOTMANCERS_HOME` (default `~/.botmancers`);
`botmancers status`, `doctor`, `open`, and `stop` manage it. Bare
`botmancers` (or `botmancers mcp`) is still the standalone bridge in front of
an app you run yourself, such as this checkout:

```bash
BOTMANCERS_URL=http://127.0.0.1:43123 npx botmancers
```

Setup of the service token and coordinator allowlist is in the package README.
[`docs/integrations/grok-bot/README.md`](docs/integrations/grok-bot/README.md)
connects Cursor's Grok Bot through the bridge-only command pinned to
`botmancers@0.1.0`, which 0.2.0 keeps unchanged. Its fixture smoke passes; the real Grok Bot smoke is
still a pending operator step
([record](docs/integrations/grok-bot/evidence/operator-smoke.md)).
Maintainers release the package as described in
[`packages/mcp-server/RELEASING.md`](packages/mcp-server/RELEASING.md); never
publish from the repository root.

## Run the app

1. Install dependencies:

```bash
npm install
```

2. Point the app at a running Hermes gateway for conversational turns:

```bash
export HERMES_API_SERVER_KEY=your-key-here
```

Optional configuration:

```bash
export HERMES_BASE_URL=http://127.0.0.1:8642  # default gateway origin
```

3. Start the development server:

```bash
npm run dev
```

4. Open http://localhost:43123

A checkout keeps its state in `./botmancers.db`, `./files`, `./skills`, and
`./.temporal` unless `BOTMANCERS_HOME` (or an explicit `BOTMANCERS_DB_PATH`,
`BOTMANCERS_FILES_ROOT`, `BOTMANCERS_SKILLS_ROOT`, `HERMES_WAIT_LOG_PATH`) is
set; see `lib/home.ts`.

Conversational turns require Hermes configuration: without
`HERMES_API_SERVER_KEY`, a turn posts an explicit Hermes error instead of a
reply, and no fallback transport is attempted. Coding work is delegated to
local coding agents through `agent-deck run`.
