# Direct Claude Code session provider (NOT-506)

A registered Agent whose runtime connection's provider is `claude` reaches its
native Claude Code sessions directly, through the locally installed and
logged-in `claude` CLI and Claude Code's local session store, with no Agent
Deck. It implements the [SessionProvider](core-engine.md#provider-sessions)
contract (`lib/claude-session-provider.ts`, provider kind `claude-code`) and
is the built-in adapter for every `claude` connection; an explicit
`registerSessionProvider` registration still wins. Scope, grants, authority
policy, idempotency, audit, and the registry stay in `lib/provider-sessions.ts`.

## Turns: the non-interactive interface only

Every start and resume is one process:

```sh
claude -p --output-format stream-json --verbose --input-format text \
  --permission-mode <mode> --permission-prompts none \
  --tools <list> --allowedTools <list> --strict-mcp-config \
  (--session-id <new uuid> | --resume <session id>)
```

- The prompt is written to stdin, never argv.
- `cwd` is the explicit workspace for a start (already checked against the
  Agent's scope), or the workspace the session recorded for a resume (Claude
  Code finds a session through its project directory).
- Authority maps to an explicit mode and tool list. Botmancers never infers
  authority, and nothing here bypasses Claude Code's permission checks:

  | Botmancers authority | `--permission-mode` | tools (`--tools` = `--allowedTools`) |
  | --- | --- | --- |
  | `read_only` | `dontAsk` | `Read,Glob,Grep` |
  | `workspace_write` | `acceptEdits` | `Read,Glob,Grep,Edit,Write,NotebookEdit` |

  No shell, web, or MCP tool is available in either mode
  (`--strict-mcp-config` with no config), and `--permission-prompts none`
  denies anything that would still prompt.
- Output is read as structured stream events only (`lib/claude-stream.ts`):
  the `system`/`init` event's `session_id`, the first `result` event, and
  `rate_limit_event`s. Terminal text is never interpreted. The only stderr
  check is for a CLI that rejects the flag set (an incompatible version).

The process is detached. Its stdout/stderr and a small turn record (pid,
session, state) live in the provider state directory
(`$BOTMANCERS_CLAUDE_STATE_DIR`, default `claude-provider/` beside the
Botmancers database), so `observeTurn` and `cancelTurn` work the same after a
Botmancers restart. Cancel sends SIGTERM to the process group. Idempotency
keys are claimed exclusively on disk, so a repeated key returns the original
turn without a second process. Claude Code writes its `result` event before
it exits and keeps the session live until then, so `observeTurn` waits up to
`exitGraceMs` (default 10s) for the process to exit before reporting the turn
terminal; a resume sent right after is not refused as `busy`.

## Resume never becomes a new session

- An id that is not a Claude session uuid, or that the local store does not
  have, is refused with `not_found` before any process starts (Botmancers:
  `session_missing`, and the row is marked missing, never deleted).
- A session held by a live Claude Code process (`sessions/<pid>.json`) or a
  running Botmancers turn is `busy`.
- If the CLI itself answers "No conversation found", that structured result is
  `session_missing`.
- If the `init` event names a different session than requested (a fork or a
  fresh session), the process is stopped and the call fails `not_resumable`;
  the other id is never adopted.

A past session is resumable whenever the installed Claude Code accepts its
id, whether or not Botmancers ever held a binding for it.

## Failures

`start`/`send` wait for the first structured event. A refusal before the turn
begins is returned from the call (no turn row); a failure during the turn
ends the turn as `failed` with a stable `failure_code`.

| Condition | Code |
| --- | --- |
| session gone from the store, or Claude Code reports "No conversation found" | `session_missing` |
| not logged in / invalid credentials (`api_error_status` 401/403) | `auth_required` |
| usage cap (`api_error_status` 429, rejected `rate_limit_event`) | `usage_limit` |
| error result with `permission_denials` | `permission_denied` |
| Claude Code older than `MIN_CLAUDE_CODE_VERSION`, or rejecting the flag set | `incompatible_version` |
| process ends without a result event | `process_exited` (turn) / `provider_unavailable` (call) |
| `claude` not runnable | `provider_unavailable` |

## Usage and cost

The first `result` event's `usage.input_tokens`, `usage.output_tokens`
(camelCase accepted, as Agent Dealer's `coordinator/usage.ts` reads the same
stream) and `total_cost_usd` are stored per turn (engine migration 19:
`provider_session_turns.input_tokens`, `output_tokens`, `total_cost_usd`) and
shown on the turn view as `usage`. Each value is independently nullable: an
absent or malformed value (string, negative, fractional tokens) is `null`, an
explicit zero stays `0`, and no price is ever inferred from tokens. Cache
tokens are not folded into `input_tokens`.

## Discovery and transcripts: the local store

`lib/claude-session-store.ts` is the only parser of Claude Code's on-disk
format, `claude-code-projects-jsonl/v1` (Claude Code 2.1.x), pinned by the
fixtures in `test-support/fixtures/claude-code/store-v2.1/`:

- `$CLAUDE_CONFIG_DIR` (default `~/.claude`)`/projects/<slug>/<uuid>.jsonl`,
  one record per line. The workspace is the `cwd` the records state (the slug
  only pre-filters directories, since it is lossy). Title: the last
  `custom-title`, else `ai-title`, else `summary`, else the first user text.
- Malformed lines are skipped and counted; a file whose name is not a session
  uuid, or with no record naming a `cwd`, is not a session. Unknown record
  types are ignored.
- Transcript pages show the main chain only: user and assistant text and
  summarized tool calls/results. Sidechain (subagent), meta, and thinking
  records are not shown.
- Facts: `resumable` when the session has at least one message; `busy` as
  above; `lifecycle` is `archived` when the session has been idle longer than
  Claude Code's own transcript retention (`cleanupPeriodDays`, default 30),
  since Claude Code has no archive flag (archived sessions stay resumable
  while their file exists); `missing` when the file is gone.
- Only the registered scope is read: workspace scopes list only those
  workspaces (re-checked by `cwd`), selected-session scopes only those ids,
  and `all_provider_sessions` only by explicit choice. Claude Code records
  real paths, so register workspaces by their real path (macOS `/tmp` is
  `/private/tmp`).

Claude session ids stay private: they are stored only in the registry, redacted
from transcript text, and never appear in turn views, catalog rows, events, or
service responses.

When a Claude Agent is registered, Botmancers imports every in-scope page from
this store before returning the new Agent. This is read-only and never launches
Claude. Registration remains successful if the store is temporarily
unavailable; only the history import is skipped.

## Verification

- `npm run test:claude-session-provider`: spawn-boundary tests against
  `test-support/fake-claude-cli.js` (argv, environment, cwd, stdin,
  cancellation, structured events), store fixtures (multiple workspaces,
  repeated sync, malformed records, removed sessions), negative resume
  fixtures with process-call and row/event counts, usage fixtures, and a
  restart in a second process.
- `npm run smoke:claude-provider -- --approve-write`: a real logged-in Claude
  Code smoke (operator machine). It creates an external session with plain
  `claude -p`, imports it, resumes it read-only after a Botmancers restart,
  then runs one explicitly approved `workspace_write` turn, and prints a
  redacted structured transcript.
