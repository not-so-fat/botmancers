# Cursor provider (NOT-505)

`lib/cursor-session-provider.ts` is a direct `SessionProvider`
(see [core-engine.md](../core-engine.md#provider-sessions)) for sessions created
by the **Cursor Agent CLI or SDK**. Every runtime connection whose provider is
`cursor` gets it by default (`lib/provider-sessions.ts`).

**Arbitrary Cursor IDE chat tabs are not supported.** The provider never opens
Cursor's own stores (`~/.cursor`, the IDE's `state.vscdb`, or any other
desktop database) and never scrapes UI. It only reads structured output from
supported interfaces.

## Integration

| | Primary: Cursor Agent CLI | Fallback: Cursor SDK |
|---|---|---|
| Selected when | `<cli> --version` succeeds | the CLI is unusable and the SDK module exposes `Agent.create` and `Agent.resume` |
| New session | `cursor-agent create-chat` (prints the chat id) | `Agent.create({ cwd })` |
| Turn | `cursor-agent --print --output-format stream-json --trust --workspace <ws> [--mode ask] --resume <chat> <prompt>` | `Agent.resume(id, { cwd, mode }).stream(prompt)`, written as the same stream-json events |
| Listing | `cursor-agent ls --output-format json`, only if `ls --help` offers it | `Agent.list()`, only if present |

Both backends share one provider kind (`cursor`) and one state directory, so a
session never changes identity when the backend does. The SDK runs only in a
child process; Botmancers never loads it. The SDK surface above is what the
probe requires. No SDK was installed when this provider was written, so that
path is tested only against `test-support/fake-cursor-sdk.mjs`.

Configuration (all optional): `BOTMANCERS_CURSOR_CLI` (default
`cursor-agent` on `PATH`), `BOTMANCERS_CURSOR_SDK_MODULE` (default
`@cursor/sdk`), `BOTMANCERS_CURSOR_STATE_DIR` (default `providers/cursor/`
beside the Botmancers database).

## Capabilities

The probe (`probeCursor`, cached for five minutes) reports the backend, its
version, and whether it can list sessions:

- `read`, `resume`, `start`, `cancel`, `usage`: whenever a backend is
  installed. Authorities: `read_only` (Cursor's read-only `ask` mode) and
  `workspace_write` (Cursor's default agent mode; never `--force`, so
  Cursor's own approvals still apply).
- `list`: only with structured listing. **Cursor CLI 2026.10.16 has none**: its
  `ls` is an interactive picker. On such a version `syncAgentSessions` is
  `unsupported`, and an outside session becomes addressable only by explicit
  import.
- `search`: never.
- No backend: every capability is false and every call is `unavailable`.

## Explicit scoped import

`importProviderSession(db, agentId, { providerSessionId, workspace })` registers
one session the operator names, such as a chat started with `cursor-agent` in a
terminal. The workspace must be inside the Agent's `workspaces` scope, or the
scope must be `all_provider_sessions`. A `sessions` scope can name only
existing references. Repeating the import returns the same reference. A version
that can list confirms the id and refuses one it does not list. Without
listing, the operator's statement is the only evidence available, because the
CLI has no structured way to check that a chat exists.

## Exact-session resume

`cursor-agent --resume <unknown id>` exits 0 after silently starting a **fresh**
chat under that id (observed on 2026.10.16). To prevent this, the provider
resumes only chats it knows: ones it created, ones a listing reported, and
ones explicitly imported. Any other id is `not_found`, and Botmancers marks the
reference `missing` without launching a process. A failed resume (an error
result, an exit without a result, or an init event that names another chat or
workspace) stays a failed turn and is never retried as a new session. Each
turn runs in the session's recorded workspace (both the process cwd and
`--workspace`). The caller's authority is mapped as above, and the caller's
correlation ids are passed as `BOTMANCERS_CORRELATION`.

## Turns, restart, cancel

Each turn runs detached in its own process group. Its stdout is journaled to
`turns/<turn>.out`, and a wrapper writes `turns/<turn>.exit` when the turn ends
on its own. Observe re-reads the journal and the recorded pid, so a restarted
Botmancers reattaches to a turn it started before the restart. Cancel records
the request and signals the process group. A repeated cancel is
`already_terminal`.

## Parser and usage

`parseCursorStream` reads only newline-terminated JSON objects. It skips
anything else, and it ignores a half-written last line while the turn is
running. It takes the init event, assistant text, completed tool steps, and the
**first** `result` event. Later result events are counted but never merged.
Reported `usage.inputTokens` / `usage.outputTokens` and a stated
`total_cost_usd` map to a `{ input_tokens, output_tokens, cost_usd }` sample
on the terminal `turn_*` event. A field that is absent, a string, or negative
is `null`. Cost is never derived from subscription pricing.

## Transcript

Neither interface exposes a chat's history, so `read` returns the turns this
provider journaled: prompt, tool steps, and assistant text. History from before
the import is not readable and is never reconstructed.

## Tests and smoke

- `npm run test:cursor-session-provider`: fake CLI (both capability sets),
  fake SDK, fixtures in `test-support/cursor-stream-fixtures/` (redacted from a
  real 2026.10.16 capture), restart in a second process, and checks that
  there is no Cursor-store access and no network.
- `node scripts/cursor-session-smoke.js`: a real Cursor CLI smoke. See
  [evidence/cursor-smoke.md](evidence/cursor-smoke.md).
