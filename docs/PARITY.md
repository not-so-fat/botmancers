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

Repair round 2 (this HEAD) fixes the C4 error layout, skill Discard,
and the C7 mixed mock in code plus the seed, and marks rows 1, 2, 3,
8, 9 as accepted roster-style drift per the owner decision. Rows 7–8,
10–12, and fresh C1–C7 captures are operator work below; the attached
`unread-cleared.png`, `unread-hover.png`, and `config-*.png` images
predate those captures.

## Reference screens

| # | Screen | Reference file | Current-side repro | Side-by-side | Verdict |
|---|--------|----------------|--------------------|--------------|---------|
| 1 | Grouped roster, botmancer idle, card rows | `botmancer-idle.png` | seed fixture, `/` at 1440x900 | [`docs/parity/botmancer-idle.png`](parity/botmancer-idle.png) | ACCEPTED DRIFT (roster style, owner decision) — palette, tokens, thread cards and composer match; roster is flat rows with sans names (Atelier 2026-10-03 spec) vs reference card rows, the only style difference. The computer-preview overlay is main-only (see Intentionally different) |
| 2 | Same, scrolled to top | `botmancer-idle-top.png` | seed fixture, `/` scrolled top | [`docs/parity/botmancer-idle-top.png`](parity/botmancer-idle-top.png) | ACCEPTED DRIFT (roster style, owner decision) — thread view (mono message cards, You labels, header) matches; roster is flat rows vs reference card rows, the only difference |
| 3 | Botmancer working (heartbeat "Working") | `botmancer-working.png` | seed fixture, trigger a run, capture mid-run | [`docs/parity/botmancer-working.png`](parity/botmancer-working.png) | ACCEPTED DRIFT (roster style, owner decision) — header shows "Working" as in the reference; roster is flat rows vs reference card rows, the only style difference. The lead-card error line is a fixture limit (no OPENAI_API_KEY) and the computer-preview overlay is main-only |
| 4 | Flat rows, group section | `flat-rows-group.png` | seed fixture, `/` scrolled to groups | [`docs/parity/flat-rows-group.png`](parity/flat-rows-group.png) | MATCH — flat rows, group pills (ClickproofGrove @Pine, Research Team), thread cards match; only the listed main-only additions (logo, Import button, Config/Stop) differ |
| 5 | Flat rows, top | `flat-rows-top.png` | seed fixture, `/` scrolled top | [`docs/parity/flat-rows-top.png`](parity/flat-rows-top.png) | MATCH — same as flat-rows-group at the top of the roster |
| 6 | Roster without groups | `roster-nogroups.png` | `--no-groups` fixture, `/` | [`docs/parity/roster-nogroups.png`](parity/roster-nogroups.png) | MATCH — flat roster without groups, highlighted active row, thread cards match; only the main-only additions differ |
| 7 | Unread badge cleared | `unread-cleared.png` | seed fixture, open the Cedar thread, no menu | [`docs/parity/unread-cleared.png`](parity/unread-cleared.png) | DRIFT (repro, operator recapture below) — attached capture shows the LaunchMint thread with the row menu open; the reference shows the Cedar thread with no menu, so this pair is not like-for-like |
| 8 | Unread row hover (tooltip) | `unread-hover.png` | seed fixture, hover unread row (Alice unread) | [`docs/parity/unread-hover.png`](parity/unread-hover.png) | DRIFT (repro) + ACCEPTED DRIFT (roster style, owner decision) — row menu style matches; the attached capture has no "Unread" line because no bot was unread at capture time (operator recapture below restores it). Roster is flat rows vs reference card rows: accepted, the only style difference once unread is seeded |
| 9 | Unread thread with tooltip menu | `unread-thread.png` | seed fixture, hover row in thread view | [`docs/parity/unread-thread.png`](parity/unread-thread.png) | ACCEPTED DRIFT (roster style, owner decision) — thread and row-menu styling match; roster is flat rows vs reference card rows, the only style difference. The menu reads Unpin because LaunchMint is pinned in the fixture (fixture state, not a style drift) |
| 10 | Draft proposal card | (behavioral, NOT-410) | `--thread-cards` fixture, draft thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |
| 11 | Approval request (Approve/Deny) | (behavioral, NOT-410/411) | `--thread-cards` fixture, approval thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |
| 12 | File artifact card | (behavioral, NOT-410) | `--thread-cards` fixture, file thread | NOT CAPTURED | not in this pass (operator captured config states + 9 reference screens only) |

### Remaining captures (operator, repair round 2)

Rows 7–8 recaptures, rows 10–12, and fresh config states C1–C7 need a
browser-capable pass at this HEAD; the dev sandbox has no browser and
no loopback, so this is not a code change.

Rows 7–8 (same seed fixture, reference viewport 1024x570):

```sh
node scripts/seed-design-fixture.js
BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
# open http://localhost:43123 at 1024x570
```

- Row 7: select the Cedar thread (bot `Cedar`), close any row menu,
  then capture. Overwrite `docs/parity/unread-cleared.png` (reference
  left, current right) and flip the row to MATCH if the thread, badge
  clearance, and flat roster all agree.
- Row 8: without opening Alice first (the seed marks Alice unread),
  hover the Alice roster row so the menu shows the "Unread" line,
  then capture. Overwrite `docs/parity/unread-hover.png` and flip the
  row to ACCEPTED DRIFT (roster style) once the Unread line is present.

Rows 10–12 (all three cards live in the one CardMint thread seeded by
the `--thread-cards` fixture):

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

Fresh config states C1–C7 (this HEAD fixes C4 layout, skill Discard,
and the C7 mixed mock; the attached config images predate the fixes):

```sh
node scripts/seed-design-fixture.js
BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev
# LaunchMint has a skill file plus two consistent manual snapshots (no mock);
# Alice has no snapshots (C6). No route interception except C2 (hold PATCH)
# and C4 (return 500).
```

- C1/C7: open `/bots/<LaunchMint-id>/config` (id printed by the seed).
  C1 is the loaded view; C7 expands the first snapshot row. Both use
  real seed data now — do not mock template fields or launch rows.
- C2: edit Rules, hold the PATCH open, capture mid-save (header reads
  "Unsaved changes", Rules card reads "Saving…").
- C4: return 500 from `GET /api/bots/[id]/config`, capture the error
  state (header kept, Back-link gap matches loaded).
- C3/C5/C6 as before. Overwrite `docs/parity/config-*.png` and flip
  C1–C7 from stale to fresh verdicts.

### Approvals pending (operator / Atelier, repair round 2)

- Atelier verdict `approve` (or a mismatch list) on the fresh C1–C7
  captures at this HEAD, recorded as a Linear comment on NOT-412.
  The attached config images predate the C4 header/gap fix, the skill
  Discard fix, and the C7 fixture fix, so judge the fresh captures.
- Local logs on the PR head (repo has no CI workflows; operator
  attaches): `test:snapshot`, `test:delegation`,
  `test:marketplace-import`, `test:acceptance`, `test:thread-actions`,
  `test:agent-loop-extras`, `lint`, `build`, each exit 0. The dev
  sandbox has no loopback and no network, so `test:marketplace-import`,
  `test:acceptance`, and `build` (Google Fonts) are operator-run.

## Config page states (no reference counterpart)

The reference has no config page; these states are judged against the
restored home page and the screenshots above. Repro: seed fixture,
`/bots/<id>/config` at 1440x900 and 390x800.

| # | State | Repro | Image | Verdict |
|---|-------|-------|-------|---------|
| C1 | Loaded (skills present, rules, template source, snapshots) | LaunchMint `/bots/<id>/config` (seed has skill + 2 snapshots, no mock) | [`docs/parity/config-loaded.png`](parity/config-loaded.png) | STALE capture (3cdf9a6, snapshot row + template fields mocked) — consistent with home tokens (card, hairline inputs, accent primary, mono skill / sans rules). 390x800: [`config-loaded-390.png`](parity/config-loaded-390.png), stacks cleanly. Fresh capture at this HEAD uses real seed data; pending Atelier verdict |
| C2 | Saving (Rules card `Saving…`, buttons disabled) | edit rules, hold PATCH open, capture mid-save | [`docs/parity/config-saving.png`](parity/config-saving.png) | STALE capture — header reads "Unsaved changes" (amber any-dirty summary, unchanged from pre-restyle), Rules card reads "Saving…" with Save showing "Saving…" disabled; PATCH held open by route interception. Fresh capture at this HEAD; pending Atelier verdict |
| C3 | Saved (`Saved HH:MM:SS`) | capture within 5s of a save | [`docs/parity/config-saved.png`](parity/config-saved.png) | STALE capture — "Saved 07:17:01" status, hash updated. Fresh capture at this HEAD; pending Atelier verdict |
| C4 | Load error with retry | 500 from `GET /api/bots/[id]/config`, load page | [`docs/parity/config-error.png`](parity/config-error.png) | FIXED in code, capture STALE — error state now keeps the page header (bot id + hash "—") with the loaded-page Back-link gap (`mt-3`/`mb-6`) and errors only inside cards in the loaded grid. The attached capture (3cdf9a6) predates the fix and shows the flush Back link. Fresh capture at this HEAD; pending Atelier verdict |
| C5 | Not found | `/bots/does-not-exist/config` | [`docs/parity/config-not-found.png`](parity/config-not-found.png) | Consistent — centered "Bot not found." + Back to chat. Fresh capture at this HEAD; pending Atelier verdict |
| C6 | Empty snapshot list | Alice `/bots/<id>/config` (no launches) | [`docs/parity/config-snapshots-empty.png`](parity/config-snapshots-empty.png) | Consistent — "No launches recorded yet.". Fresh capture at this HEAD; pending Atelier verdict |
| C7 | Snapshot list with two hashes | LaunchMint `/bots/<id>/config`, first row expanded (seed snapshots, no mock) | [`docs/parity/config-snapshots-two.png`](parity/config-snapshots-two.png) | MIXED-MOCK capture, FIXED by seed — attached capture mixes a manual Template source ("Created manually") with marketplace launch rows (`grok-marketplace` / `tpl-launchmint`) from route interception. The seed now records two consistent manual snapshots (newest matches current, older "Config changed since"); fresh capture uses real data with no mock. Pending Atelier verdict |

Code check (verified in this PR, no browser needed): the restyled page
contains no light-only surfaces —
`grep -nE 'bg-gray|text-gray|bg-white' 'app/bots/[id]/config/page.tsx'`
prints nothing. Styling uses the shared tokens (`--field`, `--card`,
`--hairline`, `--ink`, `--accent`, `--composer`, `--chrome`, `--mono`)
and home-page component patterns (card, hairline-bordered inputs,
accent primary button, accent text actions). Pre-restyle details
preserved: the skill editor stays mono while Rules stays sans
(`.cfg-input-sans`), textareas keep a 2px accent focus ring, and
primary/ghost buttons keep hover feedback (`brightness(1.1)` /
`var(--composer)`). Repair-round-2 behavior fixes (same spec, Atelier
required): the load-error state keeps the page header with the
loaded-page gap and errors only inside cards; skill Discard is disabled
until an edit (matching Rules); `hasTemplateSource` uses `||` so any
set provenance field counts; the seed records two consistent LaunchMint
snapshots so C1/C7 capture from real data.

## Intentionally different

- Flat roster rows on card-row reference screens (rows 1, 2, 3, 8, 9):
  the restored home page uses flat rows per Atelier's 2026-10-03 spec
  (NOT-409, out of scope here) while the reference uses card rows on
  those screens. Reason: accepted drift (roster style, owner decision
  2026-10-12); the reference also has flat-row screens (rows 4–6 match).
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
