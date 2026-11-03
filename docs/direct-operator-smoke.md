# Direct operator smoke (NOT-543)

Proves at the exact HEAD that, with Agent Deck stopped or uninstalled, a
user can register local Claude and Codex Agents, Wake fresh and existing
sessions, receive durable results, and complete a review/revision loop —
with no Agent Deck launch choice, deck setting, run token, or endpoint in
the path.

## Prerequisites

- This repository checked out at the PR HEAD (`git rev-parse HEAD`).
- Agent Deck stopped or uninstalled. The automated core records any stale
  `AGENT_DECK_*` environment as ignored; it never uses it.
- Provider CLIs installed and signed in: `claude --version` and
  `codex --version` both answer.
- For part 2 (coordinator consensus): a Hermes gateway key in `.env.local`
  (`HERMES_API_SERVER_KEY`), so a Hermes coordinator can run real turns.

## Part 1 — automated core (exact command)

Prepare a disposable workdir, then run:

```sh
dir=$(mktemp -d) && cd "$dir" && git init -q -b main \
  && echo "disposable" > .botmancers-disposable && git add -A && git commit -qm init
npm run smoke:direct -- --workdir "$dir" --evidence /tmp/direct-smoke.json
```

Expected: `SMOKE RESULT: PASS`, and `/tmp/direct-smoke.json` records three
completed requests (`implementation`, `review`, `revision`),
`sameDevSession: true`, `adaptersUsed: ["session-provider", ...]`, an empty
non-loopback list, and the workdir holding exactly `smoke-note.txt` at the
same HEAD. It proves: direct registration, a fresh-session Wake, an
existing-session revision Wake, a read-only review Wake, owner-grant gating
for edit work, and durable results.

## Part 2 — coordinator review loop (manual)

Start the app (`npm run dev`), then:

1. Register three Agents (New Agent): **Tank** (Hermes), **Dev** (Claude,
   `Workspace write`, new sessions allowed, scoped to a disposable
   workdir), **Reviewer** (Codex, `Read only`, same scope).
2. In Tank's thread, ask for a small outcome, e.g. "Add a `smoke.txt` file
   holding one line, and have it reviewed."
3. Tank emits `implementation` and `review` Wake blocks; approve the edit
   grant in the thread when asked. If the review finds a gap, Tank emits a
   `revision` Wake that resumes Dev's exact implementation session.
4. The loop ends when Tank declares the result final (consensus) or a Wake
   safety limit stops it (depth, budget, or concurrency — the thread names
   which).

## What to record

Attach a redacted transcript with:

- The Botmancers HEAD (`git rev-parse HEAD`).
- `claude --version` and `codex --version` output.
- Part 1: the smoke's `SMOKE RESULT` line and the evidence file.
- Part 2: the thread (Wake notices, grants, each round's outcome), the
  session refs from Dev's Sessions drawer showing the revision resumed the
  implementation session, and whether the loop ended in consensus or at a
  named round cap.
- Proof that no Agent Deck process or endpoint was used: Agent Deck
  stopped/uninstalled, the smoke evidence's adapter and network record, and
  no `agent-deck` process (`pgrep -f agent-deck` empty) during the run.

Provider session ids are private: record Botmancers request ids and session
refs only, never raw provider ids.
