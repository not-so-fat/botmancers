# Acceptance harness for the core engine

The acceptance suite tests the canonical conversation and Wake engine
([core-engine.md](core-engine.md)) from end to end. Each run gets its own
disposable state. It does not need a running Botmancers server, network
access, credentials, or an installed coding runtime. It never reads or writes
your Botmancers database, data root, `~/.botmancers`, or this working tree.

## Commands

| Command | What it runs |
| --- | --- |
| `npm run test:acceptance` | The canonical fake-adapter suite: all core scenarios (`test-acceptance-engine.js`) |
| `npm run test:acceptance -- talk-answer safety-denial` | Only the named scenarios |
| `npm run test:acceptance -- --list` | Lists the scenarios and their fixtures |
| `npm run test:acceptance -- --keep` | Keeps the roots of passing scenarios too, for inspection |
| `npm run test:acceptance:harness` | Harness self-tests (`test-acceptance-harness.js`): isolation, cleanup, the clean-environment run, and the smoke guardrails |
| `npm run smoke:agent-deck -- --workdir <dir> --deck <id>` | Opt-in smoke against a real Agent Deck server. Never part of the default suite. |
| `npm run test:acceptance:live-server` | The older `test-acceptance-steps-1-7.js` report script. It needs a developer server on port 43123 and is kept only as history (see `ACCEPTANCE.md`). |

The exit status is 0 only when every scenario passes and the production-state
check passes. The last line is `TEST RESULT: PASS` or `TEST RESULT: FAIL`.

## What a harness root holds

Each scenario runs in its own Node process. That process gets its own root
under the system temp directory, named `botmancers-acceptance-<scenario>-XXXXXX`:

```
<root>/db/botmancers.db   BOTMANCERS_DB_PATH (temporary SQLite database)
<root>/data/files         BOTMANCERS_FILES_ROOT (artifacts)
<root>/home               HOME (so ~/.botmancers/<agent> lands here)
<root>/workspace          disposable Git repository: one commit and a .botmancers-disposable marker
<root>/bin                the whole PATH besides /usr/bin and /bin: only node and git
<root>/logs               scenario.stdout.log, scenario.stderr.log
```

The harness builds the scenario's environment from scratch. Nothing is
inherited from your shell, so no Hermes, Agent Deck, Cursor, or other
credentials reach it, and neither does your Git config. Inside the scenario
process, test-support/acceptance/engine-context.js does the following before
any engine module loads:

- It refuses every network connection that is not to loopback and records the
  attempt. The run fails if any such attempt was made.
- It refuses to start any child process other than `git` or the harness's own
  `node` workers, and any shell command (`exec`, or `shell: true`). A refused
  process never starts; the call throws, the attempt is recorded, and the run
  fails.
- It drives coding Agents through the real Agent Deck run adapter, pointed at
  the deterministic fake Agent Deck API (`test-support/fake-agent-deck-api.js`).
- It runs coordinator (Hermes transport) turns from per-conversation scripts.

When a scenario covers routes, the context serves the real `app/api/**/route.ts`
handlers behind the real owner boundary (`proxy.ts`) on a loopback port that the
OS assigns (`test-support/acceptance/route-host.js`). It never starts `next dev`,
because that would write `.next/`, `next-env.d.ts`, and `AGENTS.md` into the
working tree. It never assumes a developer server on port 43123.

## Cleanup

- **Passing scenario:** its root is removed.
- **Failing scenario:** its root is kept. The run prints
  `FAILED: <scenario>; artifacts preserved at <path>`, and the root holds a
  `FAILED.txt` that names the database, workspace, and logs, the failed
  assertions, and the tail of stderr. To inspect the database, run
  `sqlite3 <path>/db/botmancers.db`, or use `better-sqlite3` from this
  repository. Delete the root with `rm -rf <path>` when you are done.
- **Leftovers from an interrupted run** (for example, Ctrl-C) are ordinary
  temp directories. To remove them:
  `rm -rf "${TMPDIR:-/tmp}"/botmancers-acceptance-*`.

The runner takes a snapshot of the configured production paths before and after
the run: `./botmancers.db*`, `./files`, `~/.botmancers`, and any explicitly set
`BOTMANCERS_DB_PATH` (with its `-wal`/`-shm`) or `BOTMANCERS_FILES_ROOT`,
wherever it lives. Directories are walked to any depth, and each entry is
recorded by metadata only (inode, size, mtime, and ctime, which any write
advances, even a same-size rewrite). File contents are never opened. It also
records this repository's `git status`. The run fails if anything changed.

## Scenarios

Every scenario asserts both layers, and the runner rejects a scenario that
asserted only one of them:

- `[engine]`: durable rows, meaning Wakes, Work Requests, Attempts, engine
  events, Session Bindings, and safety decisions.
- `[conversation]`: the projected conversation (`projector.listConversationEvents`,
  which is also read over HTTP where a route is involved) and the thread's
  messages.

| Scenario | Proves |
| --- | --- |
| `talk-answer` | The owner posts through the real UI route on an ephemeral port. Codex answers through one read-only Agent Deck run in the disposable workspace. The projection is the same in-process and over HTTP. A resend replays without new rows, and a foreign-origin POST is refused. |
| `duplicate-wake` | A coordinator Wake runs exactly once under every kind of replay: the same person key, re-routing the same reply, replaying the follow-up, and startup recovery. There are no new rows, runs, or projected Wakes. |
| `unavailable-target` | A Wake to a missing Agent is reported to the coordinator. A Wake to an unlaunchable Agent (Hermes not configured) is blocked with no Attempt. After the target becomes available, the owner retries it with `POST /api/wakes/{id}/retry` and it runs. |
| `restart-recovery` | Worker process 1 crashes right after the Agent Deck run id is persisted. A fresh process 2 takes over the lease, reattaches the run, and completes it. There is no second launch, and the answer appears once. The fake Agent Deck is served over loopback so that both processes reach it. |
| `composed-review` | The owner approves the first edit Wake over HTTP. Then implementation, an independent read-only review, a revision that resumes the implementation session, and a second review run, all composed by the coordinator. |
| `lifecycle-controls` | Running work is cancelled, and the run is cancelled in Agent Deck. A 300 ms request deadline times out a held run. A bounded retry (two Attempts) recovers a transient failure. A finished request cannot be retried or cancelled. |
| `safety-denial` | An edit Wake without a grant waits with Allow and Deny. A foreign-origin Allow is refused. The owner's Deny over HTTP cancels the request with no Attempt, no run, and no grant, and a later Allow cannot revive it. |

`self-test-failure` fails on purpose. It runs only when you name it, and the
harness self-test uses it to prove that a failing root is preserved.

## Opt-in real Agent Deck smoke

```
AGENT_DECK_RUN_TOKEN=... npm run smoke:agent-deck -- \
  --workdir /tmp/my-disposable-repo --deck <deck id> \
  [--agent codex|claude|cursor] [--server http://127.0.0.1:1111] \
  [--prompt "..."] [--evidence out.json]
```

The smoke runs one read-only conversation turn through the canonical engine
against a real Agent Deck server. Botmancers state still lives in a disposable
harness root. Only the server and the workdir you give it are real.

The smoke refuses to start, with exit status 2 and before it creates any state,
unless all of the following hold:

- `--workdir` is given, exists, and is a directory.
- The workdir is the root of a Git repository with no uncommitted changes.
- The workdir contains a `.botmancers-disposable` marker file at its root.
  Create this file only in a repository that may be changed or deleted.
- The workdir is outside this repository, is not your home directory (and does
  not contain it), is not inside `~/.botmancers`, and is not `/`.
- `AGENT_DECK_RUN_TOKEN` and `--deck` are set.
- `--server` is an http(s) URL with no `user:password@`, query string, or
  fragment. Pass the token only through `AGENT_DECK_RUN_TOKEN`.
- The evidence file (`--evidence` or the default) is new, its directory
  exists, and it is outside the workdir, this repository, `~/.botmancers`, and
  every configured production path. Writing it therefore cannot change the
  state the smoke verifies, and it never overwrites an existing file.

To prepare a disposable workdir:

```
dir=$(mktemp -d) && cd "$dir" && git init -q -b main \
  && echo "disposable" > .botmancers-disposable && git add -A && git commit -qm init
```

The smoke writes its evidence to the `--evidence` path, or by default to
`$TMPDIR/botmancers-agent-deck-smoke-<time>.json`, and prints it. The evidence
records:

- The Node, Botmancers, and Botmancers commit versions, and the Agent Deck
  version when the server reports one.
- The server, deck, and agent.
- The Work Request, Attempt, Agent Deck run, and session ids.
- The outcome, the projection kinds, and a preview of the reply.
- The workdir's HEAD and clean state before and after the run, and whether
  production state stayed unchanged.

The smoke passes only if the request completed, production state is unchanged,
and the workdir is still clean at the same HEAD. A run that dirties the workdir
or commits to it prints `SMOKE RESULT: FAIL`.

Before anything is printed or written, the evidence is redacted:

- The token, and every environment value whose name looks secret (`*TOKEN*`,
  `*SECRET*`, `*API_KEY*`, and similar), is replaced.
- So are `Bearer …`, `adg_…`, `sk-…`, `gh?_…`, and `xox?-…` patterns, URL
  userinfo (`scheme://user:pass@`), and any field whose name looks secret.

The harness root is removed after a passing smoke and kept after a failing one.
`npm run test:acceptance:harness` runs the guardrails and the whole smoke flow
against the fake Agent Deck served over loopback. That run proves the refusals
and that the token never reaches the output.
