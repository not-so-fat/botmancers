# Specialist wake latency (click-to-reply)

Status: **MEASURED** — 16 Mac-side timing runs handed over by Botmancer and
transcribed below (NOT-391, operator step complete).

Question: how long does a person wait from starting a cold specialist session
to its first assistant text, for (A) a new SDK session and (B) an SDK resume of
an existing session? These numbers decide whether any persistent-process work
is ticketed. Related: `docs/product-requirements.md` R8 (idle workers may wait
only if wake is quick enough for conversational delegation) and the design
review open question on acceptable wake latency.

Source: raw timing log `not-391-timing-log.jsonl` attached to NOT-391: 16
runs (5 cold + 3 warm per path, launched with the detached command below, on
the owner's Mac on the owner's subscription). No run errored. Per-run rows
(path, run number, cold/warm, seconds, time-to-first-message) live in that
attached log; this note records the summary values per path.

## Protocol

- Machine: owner Mac, macOS 27.0.1 (26A434), arm64, Apple M4, 16 GB RAM.
- Claude Agent SDK: 0.3.296 (installed;
  `botmancers-claude-runner` requires `^0.3.296`).
- Claude Code: 2.1.296. Node: v26.10.0.
- Network: as during the runs; details recorded in the attached run log.
- Deck wired: planner deck via `.mcp.json` (`agent-deck` stdio server,
  `AGENT_DECK_MCP_PORT=1110`, `AGENT_DECK_HOST=127.0.0.1`).
- Runner: `/Users/not_so_fat/workspace/codes/botmancers-claude-runner/run.mjs`
  with a timestamp wrapper kept next to it (wrapper adds invoke time and
  per-message arrival times; runner behavior itself unchanged). Same options:
  `settingSources: ['project','user']`, `permissionMode: 'acceptEdits'`,
  `cwd` = the botmancers repo.
- Repo: `botmancers`, HEAD `6faaeba`.
- Path (A): new session via `query()`.
- Path (B): resume via `query()` with `resume: sessionId`, using a fresh small
  seeded session (the original planning session had grown too large; the exact
  session id resumed is recorded in the attached run log).
- Definitions: **cold** = no Claude Code or runner process for that specialist
  running before the call. **start-to-first-text** = wall clock from invoking
  `query()` to the first `assistant` message containing a `text` block.
  Time-to-first-message of any kind is recorded as a secondary column in the
  attached log.
- Detached launch (verified working on macOS, which has no `setsid` binary;
  `nohup ... &` plus `disown` was not enough, and stdin must be redirected
  from `/dev/null`):

```sh
nohup perl -MPOSIX -e 'setsid(); exec @ARGV' node run.mjs <cwd> <promptFile> <logFile> [resumeId] < /dev/null > run.out 2>&1 &
```

## Results — path (A): new session via `query()`

Start-to-first-text in seconds, from the attached log (5 cold + 3 warm runs):

| group | runs | median start-to-first-text (s) | worst cold start-to-first-text (s) |
|-------|------|--------------------------------|------------------------------------|
| cold  | 5    | 1.57                           | 2.66                               |
| warm  | 3    | 0.83                           | n/a (see attached log)             |

Median cold start-to-first-text (path A): 1.57 s.
Worst cold start-to-first-text (path A): 2.66 s.
Median warm start-to-first-text (path A): 0.83 s.

## Results — path (B): resume via `query()` with `resume: sessionId`

Start-to-first-text in seconds, from the attached log (5 cold + 3 warm runs,
resuming the small seeded session named in the log):

| group | runs | median start-to-first-text (s) | worst cold start-to-first-text (s) |
|-------|------|--------------------------------|------------------------------------|
| cold  | 5    | 1.70                           | 1.97                               |
| warm  | 3    | 0.84                           | n/a (see attached log)             |

Median cold start-to-first-text (path B): 1.70 s.
Worst cold start-to-first-text (path B): 1.97 s.
Median warm start-to-first-text (path B): 0.84 s.

## Caveats

These numbers rest on a trivial prompt with no tool calls, a small seeded
session for path (B), small samples (5 cold + 3 warm runs per path), and a
single machine.

## Persistence decision

Persistence decision: with median cold start-to-first-text of 1.57 s on path
(A) and 1.70 s on path (B), both at or under the 10 s threshold, no
persistence work is ticketed.

Rule: median cold start-to-first-text of 10 s or less per path means no
persistence work is ticketed; above 10 s means one follow-up ticket for
keeping a specialist warm. The 10 s threshold is an unconfirmed placeholder
proposed by the planner, not agreed with the owner.
