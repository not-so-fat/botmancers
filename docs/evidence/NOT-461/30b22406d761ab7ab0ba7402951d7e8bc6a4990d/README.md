# NOT-461 evidence — code HEAD `30b22406d761ab7ab0ba7402951d7e8bc6a4990d`

Captured on 2026-10-14 from this worktree at `30b22406d761ab7ab0ba7402951d7e8bc6a4990d` (the evidence commit that adds
this folder changes no code). Each text file starts with `HEAD: 30b22406d761ab7ab0ba7402951d7e8bc6a4990d`.

| File | What it proves |
| --- | --- |
| `lint.txt`, `build.txt`, `test-group-semantics.txt`, `test-unread.txt`, `test-parity-small.txt` | AC7 gate commands, all `exit: 0` |
| `proof.txt` | `scripts/ui-agent-only-proof.js` run against the real app (`next start -p 43461`, `BOTMANCERS_DB_PATH=.temporal/design-fixture.db` seeded by `scripts/seed-design-fixture.js` with 2 stored groups): 34 PASS / 0 FAIL interaction trace, group digest before == after |
| `network.txt` | Browser network receipt (CDP + fetch/XHR spy): no `/api/groups` or `?groupId=` request |
| `desktop-1280x720-*.png`, `narrow-390x844-*.png` | New Agent panel, roster, hidden agents, mentions, thread, row menu, Manage agents, delete confirmation at both viewports |

This HEAD is the merge of `origin/main` (NOT-451, NOT-453, NOT-487) into the branch. The proof trace now
targets roster rows by exact `.bot-name` (`context menu opened on: Alice` / `Bob`) and the hidden-agents
screenshots scroll Alice's hidden card into view (`hidden agents: ["Alice"]`, asserted in view).
