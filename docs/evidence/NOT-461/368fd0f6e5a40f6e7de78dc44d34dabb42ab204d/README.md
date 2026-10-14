# NOT-461 evidence — code HEAD `368fd0f6e5a40f6e7de78dc44d34dabb42ab204d`

Captured on 2026-10-14 from this worktree at `368fd0f6e5a40f6e7de78dc44d34dabb42ab204d` (the evidence commit that adds
this folder changes no code). Each text file starts with `HEAD: 368fd0f6e5a40f6e7de78dc44d34dabb42ab204d`.

| File | What it proves |
| --- | --- |
| `lint.txt`, `build.txt`, `test-group-semantics.txt`, `test-unread.txt`, `test-parity-small.txt` | AC7 gate commands, all `exit: 0` |
| `build-attempt1-fresh-db-race.txt` | First build attempt failed with `duplicate column name: import_timestamp`: parallel build workers raced to initialize a fresh default DB (`lib/db.ts` is unchanged by this ticket). The immediate rerun (`build.txt`) passed. |
| `proof.txt` | `scripts/ui-agent-only-proof.js` run against the real app (`next start -p 43461`, `BOTMANCERS_DB_PATH=.temporal/design-fixture.db` seeded by `scripts/seed-design-fixture.js` with 2 stored groups): 28 PASS / 0 FAIL interaction trace, group digest before == after |
| `network.txt` | Browser network receipt (CDP + fetch/XHR spy): no `/api/groups` or `?groupId=` request |
| `desktop-1280x720-*.png`, `narrow-390x844-*.png` | New Agent panel, roster, hidden agents, mentions, thread, row menu, Manage agents, delete confirmation at both viewports |
