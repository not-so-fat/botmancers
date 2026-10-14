# NOT-448 evidence — code HEAD `6f49630a55618acd72ddbea556de9e7df8c7d1ae`

Captured on 2026-10-14 from this worktree at `6f49630a55618acd72ddbea556de9e7df8c7d1ae` (the evidence commit that adds
this folder changes no code). Text receipts start with `HEAD: 6f49630a55618acd72ddbea556de9e7df8c7d1ae`; every AX snapshot carries `"head": "6f49630a55618acd72ddbea556de9e7df8c7d1ae"`.

App: real Next.js app from this worktree (`BOTMANCERS_DB_PATH=.temporal/design-fixture.db npx next dev -p 43448`),
DB seeded by `node scripts/seed-design-fixture.js` (populated design fixture incl. 2 stored legacy groups). No mocks.
Browser: headless Chrome driven over CDP with real key events by `node scripts/ui-roster-keyboard-proof.js --url http://localhost:43448 --out docs/evidence/NOT-448/6f49630a55618acd72ddbea556de9e7df8c7d1ae`.

| File | What it proves |
| --- | --- |
| `lint.txt`, `test-unread.txt`, `test-parity-small.txt` | AC6 gate commands, all `exit: 0` |
| `test-roster-a11y.txt` | Focused row-semantics regression (one named open button per row, no nested controls, menu items, focus CSS, no Group copy), `exit: 0` |
| `roster-keyboard-trace.txt` | Keyboard trace at both viewports: 92 PASS / 0 FAIL — Tab order matches visual order, Enter and Space open agents, focused row outline, every row action (Pin/Unpin, Mark as Unread, Rename Agent, Hide/Unhide, Config, Delete agent…) invoked by keyboard via the `Actions for <agent>` trigger, focus restore, pointer select, right-click, Chief of Staff ordering, Manage agents, no Group row |
| `*-ax-roster.json`, `*-ax-row-menu.json`, `*-ax-hidden-roster.json`, `*-ax-hidden-row-menu.json` | Accessibility-tree snapshots: per-agent named button + `Actions for <agent>` menu button; open menu items; hidden agents with Unhide |
| `desktop-1440x900-*.png`, `mobile-390x800-*.png` | Focused row, opened-by-Space, row menu, after rename, Config, delete confirmation, hidden row focus, Unhide, Manage agents |
