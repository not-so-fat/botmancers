# Specialist wake latency (click-to-reply)

Status: **PENDING MEASUREMENT** — the Mac-side timing runs have not been handed
over yet. This note records the verified protocol; the results tables are empty
until Botmancer hands back the raw timing log (NOT-391, operator step).

Question: how long does a person wait from starting a cold specialist session
to its first assistant text, for (A) a new SDK session and (B) an SDK resume of
an existing session? These numbers decide whether any persistent-process work
is ticketed. Related: `docs/product-requirements.md` R8 (idle workers may wait
only if wake is quick enough for conversational delegation) and the design
review open question on acceptable wake latency.

## Protocol

- Machine: owner Mac, macOS 27.0.1 (26A434), arm64, Apple M4, 16 GB RAM.
- Claude Agent SDK: 0.3.296 (installed;
  `botmancers-claude-runner` requires `^0.3.296`).
- Claude Code: 2.1.296. Node: v26.10.0.
- Network: to be recorded at run time (runs not yet executed).
- Deck wired: planner deck via `.mcp.json` (`agent-deck` stdio server,
  `AGENT_DECK_MCP_PORT=1110`, `AGENT_DECK_HOST=127.0.0.1`).
- Runner: `/Users/not_so_fat/workspace/codes/botmancers-claude-runner/run.mjs`
  with a timestamp wrapper kept next to it (wrapper adds invoke time and
  per-message arrival times; runner behavior itself unchanged). Same options:
  `settingSources: ['project','user']`, `permissionMode: 'acceptEdits'`,
  `cwd` = the botmancers repo.
- Repo: `botmancers`, HEAD `6faaeba`.
- Path (A): new session via `query()`.
- Path (B): resume via `query()` with `resume: sessionId`, using session
  `4948be20-e831-4771-8447-02fd93526d7a` (the NOT-390..NOT-398 planning
  session), or a fresh equivalent session if it has grown too large — the run
  log records which session was resumed.
- Definitions: **cold** = no Claude Code or runner process for that specialist
  running before the call. **start-to-first-text** = wall clock from invoking
  `query()` to the first `assistant` message containing a `text` block.
  Time-to-first-message of any kind is recorded as a secondary column.
- Runs required: at least 5 cold and 3 warm runs per path.
- Detached launch (verified working on macOS, which has no `setsid` binary;
  `nohup ... &` plus `disown` was not enough, and stdin must be redirected
  from `/dev/null`):

```sh
nohup perl -MPOSIX -e 'setsid(); exec @ARGV' node run.mjs <cwd> <promptFile> <logFile> [resumeId] < /dev/null > run.out 2>&1 &
```

## Results — path (A): new session via `query()`

Pending — no runs handed over yet.

| run | cold/warm | start-to-first-text (s) | time-to-first-message (s) | notes |
|-----|-----------|-------------------------|---------------------------|-------|
| —   | —         | —                       | —                         | —     |

Median cold start-to-first-text (path A): pending (no runs yet).
Worst cold start-to-first-text (path A): pending (no runs yet).

## Results — path (B): resume via `query()` with `resume: sessionId`

Pending — no runs handed over yet. Session resumed: to be recorded
(`4948be20-e831-4771-8447-02fd93526d7a` unless the log names a replacement).

| run | cold/warm | start-to-first-text (s) | time-to-first-message (s) | notes |
|-----|-----------|-------------------------|---------------------------|-------|
| —   | —         | —                       | —                         | —     |

Median cold start-to-first-text (path B): pending (no runs yet).
Worst cold start-to-first-text (path B): pending (no runs yet).

## Persistence decision

Persistence decision: pending — no median can be cited until the timing runs
are handed over, so neither branch of the rule can be taken yet. Rule: median
cold start-to-first-text of 10 s or less per path means no persistence work is
ticketed; above 10 s means one follow-up ticket for keeping a specialist warm.
The 10 s threshold is an unconfirmed placeholder proposed by the planner, not
agreed with the owner.

## Handoff request (for Botmancer)

On the owner's Mac, on the owner's subscription, run at least 5 cold and 3 warm
runs for each of paths (A) and (B), launched with the detached command above,
and hand the raw timing log to Lorekeeper (attach it to NOT-391). The log lists
path, run number, cold/warm, and seconds for every run, plus the session id
resumed for path (B) and the network conditions during the runs.
