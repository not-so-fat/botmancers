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

## Operator capture notes (2026-10-12)

Captured at HEAD 3cdf9a6 with Playwright headless Chromium against
`next dev -p 43200` (43123 was occupied by another local instance),
seed fixture DB. Reference rows use the reference viewport 1024x570
(composites: reference left, current right). Config states are
1440x900 full-page, plus one 390x800. The Next.js dev indicator was
hidden with injected CSS. Config snapshot rows and template fields
were mocked with Playwright route interception (the fixture has no
launches); C2 holds the PATCH open; C4 returns 500.

## Reference screens

| # | Screen | Reference file | Current-side repro | Side-by-side | Verdict |
|---|--------|----------------|--------------------|--------------|---------|
| 1 | Grouped roster, botmancer idle, card rows | `botmancer-idle.png` | seed fixture, `/` at 1440x900 | [`docs/parity/botmancer-idle.png`](parity/botmancer-idle.png) | DRIFT — palette, tokens, thread cards and composer match; roster uses flat rows instead of the reference card rows, names render sans not mono, and the main-only computer-preview overlay covers the thread |
| 2 | Same, scrolled to top | `botmancer-idle-top.png` | seed fixture, `/` scrolled top | [`docs/parity/botmancer-idle-top.png`](parity/botmancer-idle-top.png) | DRIFT — thread view (mono message cards, You labels, header) matches; roster is flat rows vs reference card rows |
| 3 | Botmancer working (heartbeat "Working") | `botmancer-working.png` | seed fixture, trigger a run, capture mid-run | [`docs/parity/botmancer-working.png`](parity/botmancer-working.png) | DRIFT — header shows "Working" as in the reference; the fixture has no OPENAI_API_KEY, so the lead card preview shows an error line, and the computer-preview overlay covers the thread |
| 4 | Flat rows, group section | `flat-rows-group.png` | seed fixture, `/` scrolled to groups | [`docs/parity/flat-rows-group.png`](parity/flat-rows-group.png) | MATCH — flat rows, group pills (ClickproofGrove @Pine, Research Team), thread cards match; only the listed main-only additions (logo, Import button, Config/Stop) differ |
| 5 | Flat rows, top | `flat-rows-top.png` | seed fixture, `/` scrolled top | [`docs/parity/flat-rows-top.png`](parity/flat-rows-top.png) | MATCH — same as flat-rows-group at the top of the roster |
| 6 | Roster without groups | `roster-nogroups.png` | `--no-groups` fixture, `/` | [`docs/parity/roster-nogroups.png`](parity/roster-nogroups.png) | MATCH — flat roster without groups, highlighted active row, thread cards match; only the main-only additions differ |
| 7 | Unread badge cleared | `unread-cleared.png` | seed fixture, open the unread thread | [`docs/parity/unread-cleared.png`](parity/unread-cleared.png) | DRIFT (repro) — capture shows the LaunchMint thread with the row menu open; the reference shows the Cedar thread with no menu, so this pair is not a like-for-like repro |
| 8 | Unread row hover (tooltip) | `unread-hover.png` | seed fixture, hover unread row | [`docs/parity/unread-hover.png`](parity/unread-hover.png) | DRIFT — row menu style (Heartbeat/Pin-Unpin/Hide) matches, but the current menu has no "Unread" line because no bot was unread in the fixture at capture time; roster is flat rows vs reference card rows |
| 9 | Unread thread with tooltip menu | `unread-thread.png` | seed fixture, hover row in thread view | [`docs/parity/unread-thread.png`](parity/unread-thread.png) | DRIFT — thread and row-menu styling match; roster is flat rows vs reference card rows, and the menu reads Unpin because LaunchMint is pinned |
| 10 | Draft proposal card | (behavioral, NOT-410) | `--thread-cards` fixture, draft thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |
| 11 | Approval request (Approve/Deny) | (behavioral, NOT-410/411) | `--thread-cards` fixture, approval thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |
| 12 | File artifact card | (behavioral, NOT-410) | `--thread-cards` fixture, file thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |

### Remaining captures (operator, repair round 2)

Rows 10–12 need a browser-capable pass at this HEAD; the dev sandbox
has no browser and no loopback, so this is not a code change. All
three cards live in the one CardMint thread seeded by the
`--thread-cards` fixture (`scripts/seed-design-fixture.js`):

```sh
node scripts/seed-design-fixture.js --thread-cards
BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
# open http://localhost:43123, select the CardMint thread at 1440x900
```

Capture each card scrolled into view and save as
`docs/parity/thread-draft.png` (row 10, email draft to Alice),
`docs/parity/thread-approval.png` (row 11, `cardmint1` approval),
`docs/parity/thread-file.png` (row 12, `filemint6.txt`), then flip
the three rows above from NOT CAPTURED to linked verdicts. There is
no reference counterpart for these rows; judge them against the
restored home-page tokens like the config states.

### Approvals pending (operator / Atelier, repair round 2)

- Atelier verdict `approve` (or a mismatch list) on config states
  C1–C7, recorded as a Linear comment on NOT-412. The C4 capture
  notes one minor drift (Back link flush on the first card).
- CI run on the PR head: `test:snapshot`, `test:delegation`,
  `test:marketplace-import`, `test:acceptance`, `test:thread-actions`,
  `test:agent-loop-extras`, `lint`, `build`, each exit 0. Local
  evidence at this HEAD: `lint` exit 0 (0 errors, 9 warnings);
  `test:snapshot`, `test:delegation`, `test:thread-actions`,
  `test:agent-loop-extras` PASS; `test:marketplace-import` and
  `test:acceptance` need a loopback dev server and `build` needs
  Google Fonts network access, so they are routed to CI.

## Config page states (no reference counterpart)

The reference has no config page; these states are judged against the
restored home page and the screenshots above. Repro: seed fixture,
`/bots/<id>/config` at 1440x900 and 390x800.

| # | State | Repro | Image | Verdict |
|---|-------|-------|-------|---------|
| C1 | Loaded (skills present, rules, template source, snapshots) | open config page for a bot with skill + launches | [`docs/parity/config-loaded.png`](parity/config-loaded.png) | Consistent with home tokens (card, hairline inputs, accent primary, mono skill / sans rules). Snapshot row + template fields mocked via route interception. 390x800: [`config-loaded-390.png`](parity/config-loaded-390.png), stacks cleanly; pending Atelier verdict |
| C2 | Saving (`Saving…`, buttons disabled) | edit rules or skill, capture mid-save | [`docs/parity/config-saving.png`](parity/config-saving.png) | Consistent — header "Saving…", Save button shows "Saving…" disabled; PATCH held open by route interception; pending Atelier verdict |
| C3 | Saved (`Saved HH:MM:SS`) | capture within 5s of a save | [`docs/parity/config-saved.png`](parity/config-saved.png) | Consistent — "Saved 07:17:01" status, hash updated; pending Atelier verdict |
| C4 | Load error with retry | stop API / seed failure, load page | [`docs/parity/config-error.png`](parity/config-error.png) | Consistent, minor drift — four cards with "Couldn't load this section. Retry"; the Back link sits flush on the first card (no gap); pending Atelier verdict |
| C5 | Not found | `/bots/does-not-exist/config` | [`docs/parity/config-not-found.png`](parity/config-not-found.png) | Consistent — centered "Bot not found." + Back to chat; pending Atelier verdict |
| C6 | Empty snapshot list | bot with no launches | [`docs/parity/config-snapshots-empty.png`](parity/config-snapshots-empty.png) | Consistent — "No launches recorded yet."; pending Atelier verdict |
| C7 | Snapshot list with two hashes | bot with two launches, one row expanded | [`docs/parity/config-snapshots-two.png`](parity/config-snapshots-two.png) | Consistent — two hashes (one matches current, one "Config changed since"), first row expanded with all fields; launch rows mocked; pending Atelier verdict |

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
