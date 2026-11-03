# Botmancers

Botmancers lets a developer stay in one durable conversation while configured
agents wake one another, perform bounded work, and return results to that same
conversation — without copying prompts, outputs, or session IDs.

Every coding Agent launches **direct**: its turn runs as a local session of
its own provider CLI through its registered runtime connection. There is no
launch profile, deck, run token, or remote runner to configure. Hermes turns
run on the persistent Hermes gateway.

The UI shows agents only: create, open, mention, and delete individual
agents. Legacy group data stays stored and reachable through `/api/groups`.

## Minimal setup (copy-tested)

Prerequisites: Node 20+, Git, and the provider CLIs you want to use,
installed and signed in. Verify:

```sh
claude --version   # 2.1.317 (Claude Code)
codex --version    # codex-cli 0.157.1
```

Then:

```sh
git clone https://github.com/not-so-fat/botmancers.git
cd botmancers
npm install
cp .env.local.example .env.local   # add HERMES_API_SERVER_KEY for Hermes turns
npm run dev
```

Open [http://localhost:3333](http://localhost:3333) and register an Agent
with **New Agent**:

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

## Docs

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
