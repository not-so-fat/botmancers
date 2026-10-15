# Botmancers

Botmancers lets a developer stay in one conversation while a persistent bot
delegates coding work to local coding agents on the Mac.

Each bot has one Agent — Hermes, Cursor, Claude, Codex, or Muse Code — and
one Agent Deck selected from the workspace Agent Deck server, plus an optional
working directory. Agent Deck is the deck configuration every agent launches
with; it is not an agent or a runtime. Hermes turns run on the persistent
Hermes gateway; the coding agents launch through `agent-deck run`. A bot
without a selected Agent Deck stays readable but cannot launch.

When asked to implement and review a change, a coordinator Agent such as Tank
wakes a developer Agent, evaluates the result, wakes a separate reviewer, and
can wake the developer again to revise in its original coding session. Every
result returns to the same conversation. The user does not copy prompts or
session identifiers and does not configure a workflow form.

The roster and per-bot configuration page show `Agent: <agent> · Agent Deck:
<deck>`. Availability lists only agents with a real, available launch path.
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
  ([`docs/run-payload-migration.md`](docs/run-payload-migration.md)).

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
- import bot identity from the Grok marketplace boundary;
- persist state in SQLite.

Web UI thread turns are Work Requests run by the UI turn executor. See
"Current code and convergence" in `docs/core-engine.md`.

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

Conversational turns require Hermes configuration: without
`HERMES_API_SERVER_KEY`, a turn posts an explicit Hermes error instead of a
reply, and no fallback transport is attempted. Coding work is delegated to
local coding agents through `agent-deck run`.
