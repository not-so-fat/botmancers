# Direct Codex sessions (NOT-504)

`lib/codex-session-provider.ts` is the direct Codex `SessionProvider`
(see [core-engine.md § Provider sessions](../core-engine.md#provider-sessions)).
It is installed by default for every runtime connection whose provider is
`codex`, so a registered direct Codex Agent can discover, read, start, resume,
observe, and cancel native Codex sessions — including threads created before
Botmancers. Set `BOTMANCERS_CODEX_PROVIDER=off` to not
install it; `BOTMANCERS_CODEX_BIN` names the `codex` executable (default
`codex` on `PATH`).

## Protocol

The provider spawns one `codex app-server` per Botmancers process and speaks
its JSON-RPC protocol over stdio (`lib/codex-app-server.ts`). Every fact comes
from structured requests, responses, and notifications; terminal UI text is
never read.

| SessionProvider | Codex app-server |
| --- | --- |
| `listSessions` | `thread/list` (open, then `archived: true`; `sourceKinds` cli, vscode, exec, appServer; `searchTerm` for search) |
| `getSession` | `thread/read` |
| `readTranscript` | `thread/items/list`, or `thread/turns/list` for threads without paginated history |
| `startSession` | `thread/start` (`cwd`, `sandbox`, `approvalPolicy: never`) then `turn/start` |
| `sendTurn` | `thread/resume` (exact thread id) then `turn/start` |
| `observeTurn` | `item/completed`, `thread/tokenUsage/updated`, `turn/completed` notifications; `thread/turns/list` after a restart |
| `cancelTurn` | `turn/interrupt` |

Every `turn/start` carries the explicit `cwd` and a sandbox policy derived
only from the caller's authority: `read_only` → `readOnly`; `workspace_write`
→ `workspaceWrite` with the workspace as the only writable root. Network
access is off and `approvalPolicy` is `never`; any approval request the
server still sends is declined, never approved, so a turn cannot widen its
authority. `clientUserMessageId` carries Botmancers' hashed idempotency key.

## Installed-version probe

Capabilities are probed at runtime, never assumed: `codex --version`, the
`initialize` handshake, one deliberately ill-typed request per method (an
unknown method answers "unknown variant", a known one rejects the parameters;
nothing runs), and `account/read`. Failures are structured:

- `unavailable` — no `codex` binary, or the app-server does not start.
- `unsupported` — the app-server has no `thread/list`, or the operation is
  not available on this version (and the fallback is not).
- `auth_required` — Codex is installed but not signed in.

The registry surfaces them as `provider_unavailable`, `unsupported`, and
`auth_required`.

## `codex exec resume` fallback

When the installed app-server lacks `thread/start`, `thread/resume`, or
`turn/start`, start and resume fall back to `codex exec --json` /
`codex exec resume --json <thread>` with `-c sandbox_mode=...` and
`-c approval_policy="never"`, the prompt on stdin. The Codex thread id is
read from the structured `thread.started` event, so there is one identity
model. Runs are recorded beside the database (`codex-exec-runs/`), so they
outlive a Botmancers restart; cancel sends SIGINT. The fallback is selected
per operation only when the app-server cannot do it, and can be disabled
(`execFallback: false`). Listing and reading always use the app-server.

## Discovery facts

Each thread maps to the common record: title (thread name, else preview),
workspace (`cwd`), created/updated times (seconds → ms), `archived` vs
`open`, `busy` (status `active`), and `resumable` (persisted, not a system
error, and its workspace still exists — a moved workspace is reported as not
resumable). A thread Codex no longer has is `missing`, never deleted.
Ephemeral and sub-agent threads are not sessions. Botmancers re-checks the
registered scope on every record; out-of-scope threads are never stored.
A thread that is not currently running stays resumable while Codex accepts
resume, archived ones included.

Codex thread and turn ids live only inside the provider registry
(`provider_sessions.provider_session_id`, `provider_session_turns.provider_turn_id`);
every view carries Botmancers references.

## Usage

`lib/codex-usage.ts` (adapted from Agent Dealer's codex-jsonl normalizer,
no package dependency) maps structured usage into the common sample
`{ input_tokens, output_tokens, cached_input_tokens, cost_usd }`:
`turn.completed.usage` for exec runs, and the sum of
`thread/tokenUsage/updated` `last` breakdowns for app-server turns. Cached
input is a subset of input. Missing or malformed usage yields no sample.
Codex does not report cost, so `cost_usd` stays null; it is never estimated.
The sample is stored on the terminal turn event.

## Restart

Turn handles are durable (stored in the registry). After a Botmancers
restart, a fresh app-server reads the turn from `thread/turns/list`: a
finished turn returns its real result; a turn left in progress by the
previous app-server is terminal `failed` / `interrupted` and is never re-run.
A repeated idempotency key maps to the existing turn (Botmancers replay, and
the provider finds the key as the user message `clientId`), so no duplicate
turn is started.

## Tests

`npm run test:codex-session-provider` drives the provider through the
registry against `test-support/fake-codex.js`, a fake `codex` binary that
speaks the app-server subset and the exec JSONL stream, and asserts the exact
request payloads. Usage fixtures live in `test-support/codex-fixtures/`.
