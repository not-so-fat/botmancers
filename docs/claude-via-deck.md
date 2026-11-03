# Claude-via-deck delegation (Claude Agent SDK sessions)

> **Historical runbook — NOT-395 era (October 2026).** Kept as decision history
> for the Agent Deck adapter. For the current architecture see the
> authoritative [core-engine design](core-engine.md).
> Agent Deck launches are being removed (NOT-541): see
> [direct coding-agent Wakes](design/2026-11-03-direct-coding-agent-wakes.md).

Template runbook for delegating a task to a headless Claude session wired to an
agent-deck deck, proven on the owner's logged-in subscription. A later adapter
(NOT-395) will be built from this runbook; no adapter is built here.

Route: [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
using the owner's logged-in subscription. Not the Claude CLI and not an API key.

## Prerequisites (all on the owner's Mac)

- The subscription login and the runner exist only on the owner's Mac.
  Runs are executed there by Botmancer (the owner's agent with Mac access).
- Claude Agent SDK installed where the runner lives
  (`@anthropic-ai/claude-agent-sdk`, provides `query()`).
- Deck wired for the Claude client (writes `.mcp.json` into the target repo):

```sh
agent-deck use <deck> --client claude
```

For the proven runs below, `<deck>` was `planner` and the target repo was
`/Users/not_so_fat/workspace/codes/botmancers` at commit `6faaeba`.

## The runner

The runner lives outside the repo at
`/Users/not_so_fat/workspace/codes/botmancers-claude-runner/run.mjs` and is
not added by this PR. It is embedded here so the runbook is self-contained:

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
const [,, cwd, promptFile, logFile, resumeId] = process.argv;
const prompt = fs.readFileSync(promptFile, 'utf8');
const log = (o) => fs.appendFileSync(logFile, JSON.stringify(o) + '\n');
let sessionId = resumeId || null;
try {
  for await (const m of query({
    prompt,
    options: {
      cwd,
      resume: resumeId || undefined,
      settingSources: ['project', 'user'],
      permissionMode: 'acceptEdits',
      allowedTools: ['mcp__agent-deck__*', 'Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(ls:*)'],
    },
  })) {
    if (m.session_id) sessionId = m.session_id;
    if (m.type === 'assistant') {
      for (const c of m.message.content) {
        if (c.type === 'text') log({ t: 'text', text: c.text });
        if (c.type === 'tool_use') log({ t: 'tool', name: c.name });
      }
    }
    if (m.type === 'result') log({ t: 'result', sessionId, subtype: m.subtype, result: m.result });
  }
  log({ t: 'end', sessionId });
} catch (e) { log({ t: 'error', message: String(e).slice(0, 500), sessionId }); }
```

Usage: `node run.mjs <cwd> <promptFile> <logFile> [resumeSessionId]`.

Key `query()` options:

- `cwd` — the repo the session works in (`.mcp.json` from `agent-deck use`
  must be present there so the deck's MCP tools load).
- `settingSources: ['project', 'user']` — picks up project and user settings.
- `permissionMode: 'acceptEdits'` with `allowedTools` limited to
  `mcp__agent-deck__*` plus read-only file/git tools.
- `resume: sessionId` — resumes an existing session when given.

## Detached launch (verified)

A headless run dies if the launching shell call is interrupted, and plain
background `nohup ... &` was not enough. What worked on macOS (which has no
`setsid` binary) is `setsid()` via perl, with stdin redirected from `/dev/null`:

```sh
nohup perl -MPOSIX -e 'setsid(); exec @ARGV' node run.mjs <cwd> <promptFile> <logFile> [resumeId] < /dev/null > run.out 2>&1 &
```

The `< /dev/null` stdin redirect is required.

## Steps

1. **Detached launch with deck and task.** Wire the deck
   (`agent-deck use <deck> --client claude`), write the task prompt to a file,
   and launch the runner detached with the command above.
2. **Session id capture from the log.** The runner appends one JSON object per
   line. When the run finishes, the log ends with
   `{"t":"end","sessionId":"<id>"}`; the `result` line carries the same
   `sessionId`. That id is the handle for the follow-up.
3. **Review of the output.** A reviewer reads the log's `text`/`result` lines
   (and any artifacts the session produced) and writes review points as the
   next prompt.
4. **Follow-up with resume.** Run the same runner with the same log
   convention, passing the captured id as the fourth argument, which the
   runner forwards as `resume: sessionId`:
   `node run.mjs <cwd> <promptFile> <logFile> <sessionId>`.

## Provenance: run 1, review, run 2

All source files live under
`/Users/not_so_fat/workspace/codes/botmancers-claude-runner/`.

### Run 1 (done, 2026-10-11): the delegated task

- Command: `node run.mjs /Users/not_so_fat/workspace/codes/botmancers prompt1.txt log1.jsonl`
  (launched detached; deck `planner` wired via `agent-deck use planner --client claude`).
- Prompt (`prompt1.txt`): read the ticket-creation brief and create the Linear
  tickets only, without implementing or editing repo files.
- Result: the session planned and created NOT-390..NOT-398, then ended with
  session id `4948be20-e831-4771-8447-02fd93526d7a`.
- Excerpt from `log1.jsonl` (final lines):

```json
{"t":"text","text":"I created 9 tickets in Linear team NOT (Not-so-fat). …"}
{"t":"result","sessionId":"4948be20-e831-4771-8447-02fd93526d7a","subtype":"success","result":"I created 9 tickets in Linear team NOT (Not-so-fat). …"}
{"t":"end","sessionId":"4948be20-e831-4771-8447-02fd93526d7a"}
```

### Review (done, 2026-10-11): Botmancer's review points

Botmancer, the owner's agent, reviewed NOT-390..NOT-398 in Linear and wrote
five review points into `prompt2.txt` (priority for NOT-396, SDK route for
NOT-396, SDK paths for NOT-391, placeholder flags for NOT-395/NOT-391, no
change for NOT-394), asking for AGREE/DISAGREE per point before editing.
Excerpt from `prompt2.txt`:

```text
I (the project owner's agent, Botmancer) reviewed your 9 tickets NOT-390..NOT-398 in Linear. They are good. …
1. NOT-396 (Claude-via-deck delegation) is the first thing the owner practically needs, but it is ticketed last and has no priority. …
2. NOT-396 describes the Claude CLI and `--resume`. We now chose the Claude Agent SDK sessions … Resume uses `resume: sessionId`. …
```

### Run 2 (done, 2026-10-11): resumed follow-up

- Command: `node run.mjs /Users/not_so_fat/workspace/codes/botmancers prompt2.txt log2.jsonl 4948be20-e831-4771-8447-02fd93526d7a`.
- Result: the resumed run logged the same session id
  `4948be20-e831-4771-8447-02fd93526d7a` in `log2.jsonl`, and its reply
  referenced the first run's tickets and context (AGREE on all four points,
  NOT-396 set to Urgent, NOT-391/NOT-395 updated).
- Excerpt from `log2.jsonl` (final lines):

```json
{"t":"text","text":"All four points agreed and applied to NOT-396, NOT-391 and NOT-395 (read back after saving). …"}
{"t":"result","sessionId":"4948be20-e831-4771-8447-02fd93526d7a","subtype":"success","result":"All four points agreed and applied to NOT-396, NOT-391 and NOT-395 …"}
{"t":"end","sessionId":"4948be20-e831-4771-8447-02fd93526d7a"}
```

**Observed fact: the SDK did not fork the session id on resume.** Run 2 logged
`4948be20-e831-4771-8447-02fd93526d7a`, identical to run 1's id, and its reply
used the first run's context; continuity is proven.

## Result

What worked:

- Headless `query()` session on the subscription login, wired to the planner
  deck through `.mcp.json`, executed the delegated task end to end.
- Session id capture from the log's `result`/`end` lines, and resume of the
  same session via `resume: sessionId` with the id unchanged.
- Detached launch via perl `setsid()` with `< /dev/null` survived the
  launching shell going away.

What needed manual steps:

- The deck wiring, prompt files, launch command, and resume id were all
  hand-assembled on the Mac by Botmancer.
- The review between runs was written by hand into the follow-up prompt.
- Reading the log tail for the session id and the result text was manual.

What to automate first:

- One command that takes a deck and a task, wires the deck, launches detached,
  and reports the session id on completion (the adapter sketched in NOT-395).
- Resume plumbing that feeds the captured id back as `resume: sessionId`
  without hand-editing the command line.
- A completion signal so the caller does not have to poll the log file.

Related: conversational delegation NOT-395 (wiring this into chat is later),
wake latency NOT-391 (measures this same SDK path), Todos trial NOT-398.
