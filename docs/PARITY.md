# Design parity record (NOT-412)

Reference: branch `origin/v0-box-snapshot` (commit `4524751`), screenshots
under `design-reference/screenshots/`, notes in `SNAPSHOT.md`. Reference
only; never merged. Read with
`git show origin/v0-box-snapshot:design-reference/screenshots/<file>`.

The ticket text says "six reference screenshots"; the reference branch
actually holds nine PNGs. This doc covers all nine, plus the draft,
approval, file, and config states.

## Capture recipe (operator / Atelier)

All current-side captures run from the exact PR HEAD:

```sh
node scripts/seed-design-fixture.js            # grouped roster fixture
BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
# open http://localhost:43123 at 1440x900 and 390x800

node scripts/seed-design-fixture.js --no-groups   # roster-nogroups screen
node scripts/seed-design-fixture.js --thread-cards # NOT-410 card demo thread
```

Side-by-side composites go in `docs/parity/` as
`<screen>.png` (reference left, current right, same viewport).
Status `PENDING` below means the current-side capture still needs a
browser session; the dev sandbox for this change has no browser and no
loopback, so captures are routed to the operator.

## Reference screens

| # | Screen | Reference file | Current-side repro | Side-by-side | Verdict |
|---|--------|----------------|--------------------|--------------|---------|
| 1 | Grouped roster, botmancer idle, card rows | `botmancer-idle.png` | seed fixture, `/` at 1440x900 | `docs/parity/botmancer-idle.png` — PENDING | pending visual check |
| 2 | Same, scrolled to top | `botmancer-idle-top.png` | seed fixture, `/` scrolled top | `docs/parity/botmancer-idle-top.png` — PENDING | pending visual check |
| 3 | Botmancer working (heartbeat "Working") | `botmancer-working.png` | seed fixture, trigger a run, capture mid-run | `docs/parity/botmancer-working.png` — PENDING | pending visual check |
| 4 | Flat rows, group section | `flat-rows-group.png` | seed fixture, `/` scrolled to groups | `docs/parity/flat-rows-group.png` — PENDING | pending visual check |
| 5 | Flat rows, top | `flat-rows-top.png` | seed fixture, `/` scrolled top | `docs/parity/flat-rows-top.png` — PENDING | pending visual check |
| 6 | Roster without groups | `roster-nogroups.png` | `--no-groups` fixture, `/` | `docs/parity/roster-nogroups.png` — PENDING | pending visual check |
| 7 | Unread badge cleared | `unread-cleared.png` | seed fixture, open the unread thread | `docs/parity/unread-cleared.png` — PENDING | pending visual check |
| 8 | Unread row hover (tooltip) | `unread-hover.png` | seed fixture, hover unread row | `docs/parity/unread-hover.png` — PENDING | pending visual check |
| 9 | Unread thread with tooltip menu | `unread-thread.png` | seed fixture, hover row in thread view | `docs/parity/unread-thread.png` — PENDING | pending visual check |
| 10 | Draft proposal card | (behavioral, NOT-410) | `--thread-cards` fixture, draft thread | `docs/parity/draft-card.png` — PENDING | pending visual check |
| 11 | Approval request (Approve/Deny) | (behavioral, NOT-410/411) | `--thread-cards` fixture, approval thread | `docs/parity/approval-card.png` — PENDING | pending visual check |
| 12 | File artifact card | (behavioral, NOT-410) | `--thread-cards` fixture, file thread | `docs/parity/file-card.png` — PENDING | pending visual check |

## Config page states (no reference counterpart)

The reference has no config page; these states are judged against the
restored home page and the screenshots above. Repro: seed fixture,
`/bots/<id>/config` at 1440x900 and 390x800.

| # | State | Repro | Image | Verdict |
|---|-------|-------|-------|---------|
| C1 | Loaded (skills present, rules, template source, snapshots) | open config page for a bot with skill + launches | `docs/parity/config-loaded.png` — PENDING | pending Atelier verdict |
| C2 | Saving (`Saving…`, buttons disabled) | edit rules or skill, capture mid-save | `docs/parity/config-saving.png` — PENDING | pending Atelier verdict |
| C3 | Saved (`Saved HH:MM:SS`) | capture within 5s of a save | `docs/parity/config-saved.png` — PENDING | pending Atelier verdict |
| C4 | Load error with retry | stop API / seed failure, load page | `docs/parity/config-error.png` — PENDING | pending Atelier verdict |
| C5 | Not found | `/bots/does-not-exist/config` | `docs/parity/config-not-found.png` — PENDING | pending Atelier verdict |
| C6 | Empty snapshot list | bot with no launches | `docs/parity/config-snapshots-empty.png` — PENDING | pending Atelier verdict |
| C7 | Snapshot list with two hashes | bot with two launches, one row expanded | `docs/parity/config-snapshots-two.png` — PENDING | pending Atelier verdict |

Code check (verified in this PR, no browser needed): the restyled page
contains no light-only surfaces —
`grep -nE 'bg-gray|text-gray|bg-white' 'app/bots/[id]/config/page.tsx'`
prints nothing — and the diff touches only `className` strings plus
the `.cfg-*` block in `app/globals.css`, so every behavior in
`docs/design/bot-config-page.md` is preserved. Styling uses the shared
tokens (`--field`, `--card`, `--hairline`, `--ink`, `--accent`,
`--composer`, `--chrome`, `--mono`) and home-page component patterns
(card, hairline-bordered inputs, accent primary button, accent text
actions). Pre-restyle details preserved: the skill editor stays mono
while Rules stays sans (`.cfg-input-sans`), textareas keep a 2px accent
focus ring, and primary/ghost buttons keep hover feedback
(`brightness(1.1)` / `var(--composer)`).

## Intentionally different

- Config page (`/bots/[id]/config`): new in main (NOT-394), no
  reference counterpart. Judged against the home page, not the
  reference. Reason: main-only feature.
- `Config` link in the chat header (`app/page.tsx`, next to the bot
  name when a bot conversation is open): main-only entry point to the
  config page. Reason: required by `docs/design/bot-config-page.md`.
- `Stop` button in the chat header: stops delegated turns in the
  thread. Reason: main-only delegation feature (NOT-419); no reference
  equivalent.
- `Import from Grok Marketplace` button in the sidebar: main-only
  import entry point. Reason: main-only marketplace feature; no
  reference equivalent.
- Computer preview overlay, chief-of-staff page read, and coding-limb
  UI: main-only agent-loop features. Reason: built on main after the
  snapshot; styled with the same tokens.
