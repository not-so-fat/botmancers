# Botmancers

Your past coding-agent sessions hold knowledge: why a design was chosen,
what was tried, what is still open. Botmancers keeps those sessions
reachable. You register an **Agent** over a local runtime (Claude Code,
Codex, Cursor, Muse) and choose which workspaces and sessions it may touch.
Then someone else can ask that session a question and get an answer with the
session's context:

- **you**, from the web UI;
- **another coding agent** of yours, over MCP (`botmancers.mcp.v2`);
- **people in a Slack thread**, through a time-limited, read-only share;
- **another Agent**, handing work over in the same conversation.

Every path is bounded by what you granted or shared. A caller never sees
provider session ids, working directories, or credentials. Everything runs
locally on your machine.

The step-by-step journeys are in [docs/USER_FLOWS.md](docs/USER_FLOWS.md).

## Install

Prerequisites: macOS or Linux, Node.js 20.9+ (22+ recommended), npm, and the
provider CLIs you want to use, installed and signed in (`claude`, `codex`,
`cursor`, `muse`).

```sh
curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash
botmancers setup
botmancers start --daemon --open
botmancers doctor
```

This installs the published [`botmancers`](https://www.npmjs.com/package/botmancers)
package under `~/.botmancers`, creates your local credentials, and opens the
UI at [http://127.0.0.1:3333](http://127.0.0.1:3333). The MCP bridge listens
on `http://127.0.0.1:3332/mcp`. To connect Claude Code, Codex, or Cursor to
it, run `botmancers setup --client claude|codex|cursor`. All commands,
upgrades, and troubleshooting are in
[packages/mcp-server/README.md](packages/mcp-server/README.md).

Every coding Agent launches **direct**: its turn runs as a local session of
its own provider CLI through its registered runtime connection. There is no
launch profile, deck, run token, or remote runner to configure. Hermes turns
(optional) run on the persistent Hermes gateway.

The UI shows agents only: create, open, mention, and delete individual
agents. Legacy group data stays stored and reachable through `/api/groups`.

## Register your first Agent

Open the UI and click **New Agent**:

1. **Runtime connection** — pick the runtime the Agent uses, for example
   `Claude on this computer`. Several Agents may share one connection.
2. **Session scope** — select the workspaces the Agent may start sessions in
   (one absolute path per line), select imported sessions, or explicitly
   choose all sessions the runtime can see. An empty scope never means
   unrestricted: the Agent cannot launch until a scope is chosen.
3. **Default workspace (optional)** — where new sessions start. With a
   workspace scope it must sit inside one of the selected workspaces.
4. **Policy** — `Read only` or `Workspace write`, plus whether the Agent may
   start new sessions and whether it may resume with edits (needs
   `Workspace write`).

Settings shows which local runtimes are available right now. An Agent whose
connection, scope, or CLI is missing stays readable and unlaunchable, and
every launch attempt fails closed naming the fix.

## Fresh vs existing sessions

- **Fresh:** talk to the Agent (or wake it) with no session selected and it
  starts a new session in its default workspace — or in its single selected
  workspace when no default is set.
- **Existing:** open the Agent's **Sessions** drawer, pick one of its
  sessions, and Ask or Continue from that context. A revision Wake resumes
  the exact implementation session it names.

No Wake JSON is needed for either path: the UI names sessions by title and
Botmancers session ref, and review/revision Wakes carry their session
references automatically. The envelope contract is in
[docs/wake-contract-v1.md](docs/wake-contract-v1.md).

Direct workspace-write turns may edit the configured workspace. Botmancers
adds no commit, PR, worktree, or remote-run orchestration.

## Develop from source

For contributors. Prerequisites: Node 20+ and Git.

```sh
git clone https://github.com/not-so-fat/botmancers.git
cd botmancers
npm install
cp .env.local.example .env.local   # add HERMES_API_SERVER_KEY for Hermes turns
npm run dev                        # http://localhost:3333
```

## Verify it works

Run one implement → review → revise round through real provider Sessions
against a disposable workdir (see
[docs/acceptance-harness.md](docs/acceptance-harness.md)):

```sh
dir=$(mktemp -d) && cd "$dir" && git init -q -b main \
  && echo "disposable" > .botmancers-disposable && git add -A && git commit -qm init
npm run smoke:direct -- --workdir "$dir" --evidence /tmp/direct-smoke.json
```

The smoke registers a Claude developer and a Codex reviewer, runs a fresh
implementation turn (owner grant), a read-only review turn, and a revision
turn that resumes the implementation session, then prints redacted JSON
evidence: versions, request states, session continuity, the adapters used,
and proof that no non-loopback endpoint was touched.

The deterministic engine suite needs no CLIs at all:

```sh
npm run test:acceptance   # scripted-provider scenarios in disposable roots
npm run lint && npm run build
```

## MCP bridge (`botmancers.mcp.v2`)

Granted Agent access (discover Agents, read their sessions and conversations,
send one read-only message to an exact session, start `Ask`/`Continue`
exchanges) is also an MCP contract, `botmancers.mcp.v2`, served next to the
unchanged v1 tools. Grants are set up as in
[`docs/service-grants.md`](docs/service-grants.md); the tool list and
workflow are in [`docs/mcp-bridge.md`](docs/mcp-bridge.md), and the
machine-readable capture is
[`docs/contracts/mcp-bridge-v2.tools.json`](docs/contracts/mcp-bridge-v2.tools.json).
Returned transcript text is untrusted data.

## Docs

- [docs/USER_FLOWS.md](docs/USER_FLOWS.md) — what a person or an agent does
  with Botmancers, start to finish. Start here.
- [docs/core-engine.md](docs/core-engine.md) — the authoritative product and
  engine contract.
- [docs/acceptance-harness.md](docs/acceptance-harness.md) — the acceptance
  suite, scenarios, and the direct smoke.
- [docs/wake-contract-v1.md](docs/wake-contract-v1.md) — the Wake envelope,
  authority table, and coordinator loop.
- [docs/direct-operator-smoke.md](docs/direct-operator-smoke.md) — the
  exact-HEAD operator procedure for the review/revision loop.
- [docs/claude-session-provider.md](docs/claude-session-provider.md),
  [docs/integrations/codex-direct.md](docs/integrations/codex-direct.md),
  [docs/providers/cursor.md](docs/providers/cursor.md) — the direct
  provider transports.
- [packages/mcp-server/README.md](packages/mcp-server/README.md) — the
  supervised product (`botmancers setup/start/doctor`) and MCP bridge.
