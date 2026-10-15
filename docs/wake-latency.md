# Specialist wake latency (click-to-reply)

> **Evidence — NOT-391.** Dated timing measurements, kept as empirical
> evidence. For the current architecture see the authoritative
> [core-engine design](core-engine.md).

Status: **MEASURED** — 16 Mac-side timing runs handed over by Botmancer and
transcribed below (NOT-391, operator step complete).

Question: how long does a person wait from starting a cold specialist session
to its first assistant text, for (A) a new SDK session and (B) an SDK resume of
an existing session? These numbers decide whether any persistent-process work
is ticketed. Related: `docs/product-requirements.md` R8 (idle workers may wait
only if wake is quick enough for conversational delegation) and the design
review open question on acceptable wake latency.

Source: raw timing log attached to NOT-391: 16 runs (5 cold + 3 warm per
path, launched with the detached command below, on the owner's Mac on the
owner's subscription). No run errored. All 16 per-run rows (path, run number,
cold/warm, start-to-first-text, time-to-first-message) are transcribed in the
tables below; the attached log is the raw record.

## Protocol

- Machine: owner Mac, macOS 27.0.1 (26A434), arm64, Apple M4, 16 GB RAM.
- Claude Agent SDK: 0.3.296 (installed;
  `botmancers-claude-runner` requires `^0.3.296`).
- Claude Code: 2.1.296. Node: v26.10.0.
- Network: not recorded during the runs.
- Deck wired: planner deck via `.mcp.json` (`agent-deck` stdio server,
  `AGENT_DECK_MCP_PORT=1110`, `AGENT_DECK_HOST=127.0.0.1`).
- Runner: `/Users/not_so_fat/workspace/codes/botmancers-claude-runner/run.mjs`
  with a timestamp wrapper kept next to it (wrapper adds invoke time and
  per-message arrival times; runner behavior itself unchanged). Same options:
  `settingSources: ['project','user']`, `permissionMode: 'acceptEdits'` with
  Bash, Edit, Write disallowed, `cwd` = the botmancers repo.
- Repo: `botmancers`, HEAD `6faaeba`.
- Path (A): new session via `query()`.
- Path (B): resume via `query()` with `resume: sessionId`, using small seeded
  session `3f725b62-5a15-4c6e-a36e-133eb9605e81` for all 8 path (B) runs
  (a fresh equivalent: the original planning session had grown too large).
- Definitions: **cold** = no Claude Code or runner process for that specialist
  running before the call. **start-to-first-text** = wall clock from invoking
  `query()` to the first `assistant` message containing a `text` block.
  Time-to-first-message of any kind is recorded as a secondary column in the
  tables below.
- Detached launch (verified working on macOS, which has no `setsid` binary;
  `nohup ... &` plus `disown` was not enough, and stdin must be redirected
  from `/dev/null`):

```sh
nohup perl -MPOSIX -e 'setsid(); exec @ARGV' node run.mjs <cwd> <promptFile> <logFile> [resumeId] < /dev/null > run.out 2>&1 &
```

## Results — path (A): new session via `query()`

Seconds per run, transcribed from the attached log (5 cold + 3 warm runs):

| run  | cold/warm | start-to-first-text (s) | time-to-first-message (s) |
|------|-----------|-------------------------|---------------------------|
| A-1  | cold      | 2.66                    | 1.04                      |
| A-2  | cold      | 1.51                    | 0.81                      |
| A-3  | cold      | 1.42                    | 0.73                      |
| A-4  | cold      | 1.62                    | 0.69                      |
| A-5  | cold      | 1.57                    | 0.72                      |
| A-6  | warm      | 0.83                    | 0.11                      |
| A-7  | warm      | 0.82                    | 0.10                      |
| A-8  | warm      | 1.13                    | 0.11                      |

Median cold start-to-first-text (path A): 1.57 s.
Worst cold start-to-first-text (path A): 2.66 s.
Median warm start-to-first-text (path A): 0.83 s.

## Results — path (B): resume via `query()` with `resume: sessionId`

Seconds per run, transcribed from the attached log (5 cold + 3 warm runs,
all resuming seeded session `3f725b62-5a15-4c6e-a36e-133eb9605e81`):

| run  | cold/warm | start-to-first-text (s) | time-to-first-message (s) |
|------|-----------|-------------------------|---------------------------|
| B-1  | cold      | 1.76                    | 0.86                      |
| B-2  | cold      | 1.44                    | 0.73                      |
| B-3  | cold      | 1.97                    | 1.31                      |
| B-4  | cold      | 1.70                    | 0.93                      |
| B-5  | cold      | 1.51                    | 0.75                      |
| B-6  | warm      | 0.85                    | 0.10                      |
| B-7  | warm      | 0.84                    | 0.10                      |
| B-8  | warm      | 0.82                    | 0.10                      |

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
