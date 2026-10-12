# NOT-398 — Todos trial handoff (builder → reviewer → resumed builder)

Status: **blocked in sandbox — operator run required.** This file is the trial
protocol plus the Lexicon-note skeleton. It contains no trial results: every
evidence-dependent cell is marked PENDING. Do not present this file as the
fit-gap note.

## Why the trial did not run here

Verified in this session (branch `yusukemuraoka0208/not-398-…`, HEAD `1caeea5`):

- Network `none`: a fetch attempt failed with `Could not resolve host:
  github.com`. `https://todos.dev/docs/mcp` and `https://todos.dev/docs/runtimes`
  are unreachable, and the Todos remote MCP / cloud cannot be reached.
- No browser: the docs read and any Todos UI steps cannot be done here.
- No credentials: the owner's Claude and Codex accounts are unavailable
  (the builder deck's only MCP service shows no token / not connected).
  The trial's first acceptance criterion is explicitly `[operator]` for this
  reason.
- No Linear service on the builder deck: the NOT-398 ticket cannot be fetched
  or commented on from here. The ticket text in the task prompt is authoritative.
- The Lexicon vault (`workspace/Obsidian/lexicon-personal`) is outside the
  sandbox write roots, so the note itself must be written by the operator.

## Trial protocol (one scenario, per ticket)

Setup (operator, on the Mac):

1. Read `https://todos.dev/docs/mcp` and `https://todos.dev/docs/runtimes`.
2. Wire Todos MCP into the originating agent conversation with the owner's
   actual runtime configurations (owner's Claude account for the builder,
   owner's Codex account for the reviewer).
3. Record: run date, Todos build ID(s), review ID(s), repo + commit under work,
   and which configuration each side launched with.

Steps (single trial scenario — no more):

1. **Build (Claude).** From the originating conversation, delegate one small
   implementation task to the Claude builder through Todos MCP. Record the
   build ID and the artifact returned.
2. **Review (Codex).** Request review of the builder artifact by Codex through
   Todos MCP. Record the review ID, the verdict, and the feedback text.
3. **Resumed builder (Claude).** Resume the same builder session with the
   review feedback. Record whether the same session resumed (native session
   ID reused vs new session vs portable continuation) and the revised artifact
   or explicit failure.

Record throughout: where the launched configuration differed from the owner's
configured bot identity, which steps needed a human action, and whether each
result returned to the originating conversation without manual copying.

## Lexicon note skeleton (copy into the vault)

Target: `Sources/Ideas/personal/YYYY-MM-DD Todos trial — builder → reviewer → resumed builder.md`
(frontmatter follows the existing `2026-10-11 Botmancers design review` note).
The note's **last line** must be the one-sentence recommendation.

```markdown
---
area: personal
created: YYYY-MM-DD
tags:
  - idea
  - botmancers
  - todos-trial
status:
triaged:
triage_note:
promotes-to:
---

# Todos trial — builder → reviewer → resumed builder

**Run date:** PENDING · **Build ID:** PENDING · **Review ID:** PENDING
**Related:** [[Sources/Ideas/personal/2026-10-11 Botmancers design review — build vs integrate]]
**Requirements:** `docs/product-requirements.md` R1–R9 (`origin/main`, post-NOT-390)

## Setup used

PENDING — Todos account, MCP wiring, Claude/Codex configs, repo + commit.

## Steps taken

1. PENDING — Build (Claude): outcome.
2. PENDING — Review (Codex): outcome.
3. PENDING — Resumed builder with feedback: outcome.

## Fit-gap table (R1–R9)

| Req | Requirement gist | Status | Source (quote or observation) |
| --- | --- | --- | --- |
| R1 | Register launchable bots from configs the user controls | PENDING met/partial/unmet | PENDING |
| R2 | Inspect effective configuration + immutable launch snapshot | PENDING met/partial/unmet | PENDING |
| R3 | Actually launch/activate the bot (no invite-link stubs) | PENDING met/partial/unmet | PENDING |
| R4 | Local + cloud execution (cloud is post-evidence-gate) | PENDING met/partial/unmet | PENDING |
| R5 | Preserve/resume sessions; show continuity mode | PENDING met/partial/unmet | PENDING |
| R6 | Agent-initiated delegation without per-handoff approval | PENDING met/partial/unmet | PENDING |
| R7 | Route outcomes back to originating task/conversation | PENDING met/partial/unmet | PENDING |
| R8 | Idle workers; durable state; low wake latency (wake-up post-gate) | PENDING met/partial/unmet | PENDING |
| R9 | May reuse existing communication infrastructure | PENDING met/partial/unmet | PENDING |

## Where configuration fidelity broke

PENDING — at least one concrete observation.

## Which steps needed a human

PENDING — at least one concrete observation.

## Whether results returned to the originating conversation

PENDING — at least one concrete observation.

PENDING one-sentence recommendation: integrate/narrow vs continue, with the single strongest evidence.
```

## Desk-research pre-read (NOT trial evidence — verify during the run)

Prior claims to check, from the repo plan and the 2026-10-11 design review:

- Todos drives Claude Code via the Claude Agent SDK, Codex via
  `codex app-server`, and Grok Build / Cursor / Hermes / others over ACP.
- Its remote MCP lets an agent create todos, run builds, and request reviews;
  machines claim runs and managed machines wake on arrival; charter/memory/
  task history persist outside one runtime conversation.
- Its AI review flow routes critique back to the builder, but the documented
  flow still needs a person to initiate review and make the final decision.
- Per the plan, most personal runtime configuration, skills, plugins, and
  existing sessions are excluded from Todos' isolated runtime homes. The ticket
  explicitly says that claim is not re-verified — the trial decides whether
  that fidelity gap matters.
- Reference requirement texts: R1–R9 in `origin/main:docs/product-requirements.md`
  (this branch is one commit behind `origin/main` and lacks that file;
  `docs/implementation-plan.md` is uncommitted even on `origin/main`).

## Operator close-out checklist (maps to acceptance criteria)

- [ ] Trial run end to end (Claude build → Codex review → resumed builder);
      note records run date, build/review IDs, three steps with outcomes.
- [ ] Fit-gap table has nine rows R1–R9, each with met/partial/unmet + source.
- [ ] Three labeled subsections (fidelity breaks / human steps / return to
      origin), each with ≥1 concrete observation.
- [ ] Note's last line is the one-sentence recommendation; its link is posted
      as a comment on NOT-398.
