# NOT-514 probe procedure and redacted results

- **HEAD:** `8e19aa24e51aeb4a26bf4d9a057ae2012daadc3b`. The ticket names `release/0.5.1` at `2bcf469`, which is not in this clone, so the evidence is rebased to the worktree HEAD.
- **Date:** 2026-10-24. **Host:** macOS (Darwin 27.0.0), Node from `PATH`, no network.
- **Clients:** Claude Code `2.1.309`, Codex `codex-cli 0.157.1`, Cursor Agent CLI `2026.10.16-e3cb207`.
- **Machine-readable matrix:** [`identity-matrix.json`](./identity-matrix.json). `npm run test:session-share-preflight` checks it.

## What the probes keep

The probes never print an identifier, a path, or a credential. For each variable in a fixed allowlist (`WATCHED` in `scripts/not-514-identity-probe.js`), they record only:

- whether it is present;
- its shape (`uuid`, `token`, `flag`, `path`, `botmancers_context`, `other`);
- its length;
- a salted fingerprint: the first 12 hex digits of `HMAC-SHA256(salt, value)`.

The salt is random for each run and is never written down. Values are compared only by fingerprint, inside one run. Each run's temporary workspace and config directory are deleted when it finishes. Nothing below was edited by hand except to shorten it.

## Commands

```sh
node scripts/not-514-identity-probe.js env          # this process (here: a Claude Code Bash tool subprocess)
npm run probe:not-514-claude                        # isolated CLAUDE_CONFIG_DIR, not logged in
npm run probe:not-514-codex                         # isolated CODEX_HOME, not logged in
npm run probe:not-514-cursor                        # isolated HOME, not logged in
# Same probes against the logged-in client (spends usage):
npm run probe:not-514-claude -- --home              # likewise for codex and cursor
```

The isolated runs do not need a login for what they test. Each client spawns its MCP servers, and reports or persists its session id, before the model call fails on authentication. The model call itself is never needed.

## Results

### This Claude Code session (not launched by Botmancers)

`node scripts/not-514-identity-probe.js env`:

```json
"CLAUDE_CODE_SESSION_ID": { "present": true, "shape": "uuid", "length": 36 },
"CLAUDECODE": { "present": true, "shape": "flag" },
"CLAUDE_CODE_ENTRYPOINT": { "present": true, "shape": "token", "length": 7 },
"CODEX_*", "CURSOR_*", "BOTMANCERS_SESSION_CONTEXT": { "present": false }
```

### Claude Code 2.1.309: `scripts/not-514-claude-mcp-probe.js`

Setup: one fresh session id S, one fresh temporary workspace, and a stdio probe MCP server attached with `--strict-mcp-config --mcp-config`. The parent's `CLAUDE_CODE_*` variables are removed from the environment first.

| Case | Launch | MCP spawned | env present | env = S | reported session = S | env = reported |
|---|---|---|---|---|---|---|
| new | `-p --session-id S` | yes | yes (uuid) | **yes** | yes | yes |
| resume | `-p --resume S` | yes | yes (uuid) | **yes** | yes | yes |
| continue | `-p --continue` | yes | yes (uuid) | **no** | **yes** | **no** |
| fork | `-p --resume S --fork-session` | yes | yes (uuid) | no | no | yes |
| HTTP header context | `--mcp-config` http entry, header `Botmancers-Session-Context: ${BOTMANCERS_SESSION_CONTEXT}`, value in the turn's env | 5 requests (initialize included) | n/a | n/a | n/a | the header carried the minted value on **every** request |

Every case exited 1 with `not_logged_in`.

The `continue` row is the implicit-resume hazard, measured here. Claude Code continued S, and its result reports S. The MCP subprocess, however, was handed a different id. A server that trusted `CLAUDE_CODE_SESSION_ID` would have shared the wrong session.

### Codex 0.157.1: `scripts/not-514-codex-mcp-probe.js`

| Case | Result |
|---|---|
| `exec --json -c mcp_servers.probe.*` (per process) | MCP spawned. The per-run context was delivered. `thread.started` was reported. `CODEX_THREAD_ID` and `CODEX_SESSION_ID` were **absent**. |
| app-server, two `thread/start` with `config.mcp_servers` (stdio, env marker) | Both threads spawned their own MCP subprocess, and each saw only its own marker. No ambient thread variable. |
| app-server, two threads, HTTP entry with `http_headers` | 6 requests, 0 without the header, 2 distinct contexts, each one a thread's own value. |
| resume in a **new** app-server process with a new `config` | The resumed thread's MCP subprocess saw the new context (`resume_sees_new_context: true`) and not the old one. |
| a second `thread/resume` of an **already loaded** thread in the same process | It returned OK, but **no new MCP subprocess was spawned**. The thread keeps the configuration it was loaded with. |

Consequence of the last row: a Codex context must be bound to the thread's load in Botmancers' app-server, not to each turn (see the decision record).

### Cursor Agent CLI 2026.10.16: `scripts/not-514-cursor-mcp-probe.js`

| Case | Result |
|---|---|
| `--print --output-format stream-json --approve-mcps --trust`, with a probe entry in a temp workspace's `.cursor/mcp.json` whose env references `${env:BOTMANCERS_SESSION_CONTEXT}` | Exit 1, `not_logged_in`. **No MCP spawned** and no stream `session_id`: the login check runs first. |
| `cursor-agent --help` | No per-invocation MCP configuration flag (`--approve-mcps` only). `create-chat`, `--resume [chatId]`, and `--continue` exist. |

## Not exercisable here, and the manual procedure

Interactive `/clear` and an interactive client restart cannot be driven headlessly. The decision does not depend on how they behave: share-current is offered only to Botmancers launches, and those have neither. To record them for a client anyway:

1. `export NOT514_PROBE_SALT=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')`.
2. Register the probe in the client as a stdio MCP server: `node <checkout>/scripts/not-514-identity-probe.js mcp-stdio`, with `NOT514_PROBE_SALT` passed through. For Claude Code, use `claude mcp add` with `--scope local`, in a scratch directory.
3. Start a session and call `identity_probe`. Then run `/clear` and call it again. Then quit, run `claude --continue`, and call it again. Then resume by id and call it again.
4. Keep only the `present`, `shape`, and fingerprint-equality columns. Remove the MCP entry and unset the salt.

The Cursor `--home` run has the same shape. It needs a logged-in Cursor and spends usage. It is the upgrade trigger recorded for Cursor in the matrix.

## Local gate commands (Linux CI equivalent, run from the repository root)

```sh
npm run test:session-share-preflight
cd packages/mcp-server && npm run build && npm run build:app && npm run release:check -- --out /tmp/not514-release.log
```

At 226df69 on macOS, both commands exited 0. The release check ran `npm test` (108 passed, 0 failed), checked the package contents, ran `npm publish --dry-run`, and installed the exact tarball into a clean project. NOT-514 does not change `packages/mcp-server` or anything the release check packages.

At 9be26ae on macOS with Node 26.10.0 (local Node is not 24), `npm run test:session-share-preflight` passed. `node --test --test-timeout=60000 "test/*.test.mjs"` in `packages/mcp-server`, run after `npm run build && npm run build:app`, passed 108 of 108 in 108 s.

### CI status: the release check stalls on `main` too

Both PR runs of `ci-botmancers` (40112720825 at 226df69 and 40114377058 at 9be26ae) were cancelled at the 15-minute job limit. Every focused step passed, including the NOT-514 step. The transcript stops at `RUN tests`, which is the release check's `npm test` in `packages/mcp-server`, and no test result was printed.

A `workflow_dispatch` run on unmodified `main` at 8e19aa2 (40115681199, 2026-10-24) was cancelled the same way. The last green `main` run was 39700335056 on 2026-10-22, at the same commit. So the stall comes from the CI environment or time, not from this branch. The green run used runner image `ubuntu-24.04` version 20261012. Both failed PR runs used version 20261021.618, and GitHub has announced that `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19. The Linux hang has not been reproduced locally, and fixing it is outside NOT-514's scope.
