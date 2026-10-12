# Bot configuration page — design critique

Ticket: NOT-393. Owner: Critiquito.
Input: `docs/design/bot-config-page.md` (NOT-392, Atelier).
Status: critique only. No spec rewrite and no build in this ticket.

Judged against: one page per bot; skills, rules and template source visible;
edits saved and shown; snapshot with hash per launch; no workflow forms.
Also judged for clarity, missing states, and drift from the transparency
purpose (configuration visible, editable, and auditable in one place).

Method: read the spec end to end, then spot-checked its code claims against
`lib/skills.ts`, `lib/agent.ts`, `lib/db.ts`, `app/api/bots/route.ts`,
`app/api/bots/import/route.ts`, and `test-import.js`. All checked claims
hold: blank skill reads as absent, `POST /api/bots` accepts any non-empty
name, `PATCH` errors (`Name is required`, `Bot not found`), terminal queue
states (`completed`/`failed`), the greeting run enqueued at creation, the
six provenance columns, the unsorted `computeBodyHash`, and the fixture
values (`grok-marketplace`, `template-abc`, `import-op-12345`).

## Coverage against the judging criteria

- One page per bot at `/bots/[id]/config`: covered by `Purpose and route`
  and `Page structure`. Pass.
- Skills, rules, template source visible: three dedicated sections with
  present/absent/error states each. Pass.
- Edits saved and shown: per-section dirty/saving/saved/save-error cycle
  with header summary. Pass.
- Snapshot with hash per launch: launch definition, row layout, freshness
  badge, SHA-256 canonicalisation, exact field list. Pass.
- No workflow forms: `Out of scope` explicitly excludes routines, cloud,
  sessions, groups, MCP management, re-import. No drift found; the MCP
  exclusion and the hash's configuration-only scope are stated, not
  silent. Pass.

Severity labels below are `must-fix` (blocks build until resolved
by a spec revision) or `optional` (builder may resolve without a spec
revision). Finding 11 was `must-fix` and is now closed by the Atelier
spec revision recorded under Re-review; no `must-fix` finding remains
open.

## Findings

### Finding 1 [optional] — Snapshot persistence and read API are unspecified

Spec section: `Launch snapshots and snapshot hash`.

The spec fully defines what a snapshot means (effective config at the
terminal transition, immutable, no de-dup, failed launches included) and
what the page shows, but not where snapshots persist (new table vs
derived storage) or which endpoint serves the list and expanded detail.
Suggested fix: one line stating persistence and API are defined in the
build ticket, or a minimal contract (table, write point on the
terminal-marking path, read endpoint). The write point matters for
correctness, not just rendering: values read at terminal-marking time
record config the run never used when rules/skills changed mid-flight
(see finding 11), so snapshot values must be captured at config read
time and only written when the item is marked terminal. This finding
stays optional because, once finding 11's capture-timing rule is in
the spec, the remaining storage/API choice does not affect the page
rendering contract and the builder can resolve it without a further
spec revision.

### Finding 2 [optional] — Expanded snapshot detail field list is vague

Spec section: `Launch snapshots and snapshot hash`.

The expanded detail shows "the full launch id, the full hash, and the
covered field values recorded at launch", but the exact rows, order, and
truncation (for example long `skill_content`) are unstated. Suggested
fix: list the detail rows in the same order as the hash field list and
state whether long values truncate with a copy affordance. Optional
because the builder can infer the fields from the hash input list.

### Finding 3 [optional] — Header hash display length is unspecified

Spec section: `Page structure` and `Launch snapshots and snapshot hash`.

Rows specify a 12-character short hash, but the header
"current-config hash" has no stated width; the desktop mock shows 8
characters (`9f2ca41b`). Suggested fix: state the header width (8, to
match the mock, or 12 for consistency) and whether it has a copy
affordance like rows. Optional because the mock disambiguates the width.

### Finding 4 [optional] — Header hash behaviour under section load error

Spec section: `Edit, save, dirty, and error states`.

The header hash is "computed live from saved values", but if the skills
or rules section is in load-error state its saved value is unknown, so
the hash cannot be computed. Suggested fix: specify a placeholder (for
example `—`) until every hash input has loaded. Optional because it is
a narrow edge case with an obvious safe rendering.

### Finding 5 [optional] — Skills save mechanism is unnamed

Spec section: `Edit, save, dirty, and error states` and `Skills section`.

Rules saves name their endpoint (`PATCH /api/bots` with
`{id, description}`), but skills saves go to "the skill file write" with
no endpoint or method, so the save-error reason for skills has no
defined source. Suggested fix: name the endpoint or explicitly defer it
to the build ticket alongside finding 1. Optional because the UI
contract (buttons, states, confirm-on-delete) is fully specified.

### Finding 6 [optional] — Snapshot list has no scale behaviour

Spec section: `Launch snapshots and snapshot hash`.

Every launch records a row with no de-dup and no stated cap, page size,
or lazy loading, so a long-lived bot grows the section without bound.
Suggested fix: state the expected behaviour (for example cap with
"load more", or pagination) or defer it to the build ticket. Optional
because early bots will have few launches and any standard list
treatment satisfies the page contract.

### Finding 7 [optional] — Whitespace-only skill save is ambiguous

Spec section: `Skills section`.

"An empty save deletes the file", while elsewhere blank (whitespace-only)
counts as Not present via trim. It is unclear whether a whitespace-only
save deletes the file or writes a blank file that then reads as Not
present. Suggested fix: state the trim rule on save (recommended: trim
and treat blank as delete, matching the read path). Optional because
both readings converge on the same displayed state.

### Finding 8 [optional] — Dirty-navigation prompt scope vs the back link

Spec section: `Edit, save, dirty, and error states`.

"Navigating away with dirty state shows the browser-native
unsaved-changes prompt" — but the in-page back link is client-side
navigation, which does not fire the browser prompt on its own.
Suggested fix: clarify whether the back link also confirms (custom
prompt) or only browser-level navigation does. Optional because no data
model depends on the answer.

### Finding 9 [optional] — Malformed template URL rendering is unspecified

Spec section: `Template source section`.

The URL renders as a link, with no behaviour for a stored value that is
not a valid absolute URL. Suggested fix: render non-URL values as plain
text. Optional because import validation makes this rare and the
failure mode is cosmetic.

### Finding 10 [optional] — Date-time formats have no exact strings

Spec section: `Template source section`, `Launch snapshots and snapshot
hash`, and `Edit, save, dirty, and error states`.

"Local date-time" appears for launch rows and `Imported at`, and
`Saved HH:MM:SS` for the save confirmation, but exact format strings
are unstated. Suggested fix: pin the formats (the mocks already imply
`YYYY-MM-DD HH:MM` for rows). Optional because the mocks illustrate the
intent and any locale-consistent rendering is acceptable.

### Finding 11 [must-fix] — Snapshot capture timing records config the run never used

Spec section: `Launch snapshots and snapshot hash`.

The spec (pre-revision lines 187-189) says the snapshot "captures the
effective configuration that run used, recorded when the item is marked
terminal". But in `lib/agent.ts` the bot row is read at :45 and the
skill at :195 before the async model call, while `markCompleted` runs
at :33/:36 afterwards. A rules/skill edit during an in-flight run
makes a terminal-time read record config the run never used, so the
audit hash is false — direct drift from the transparency purpose and
the "snapshot with hash per launch" criterion. Early-return runs (bot
not found, chief-of-staff file/page/coding runs at `agent.ts:46-81`,
plus conversation-not-found and other pre-model returns) are also
marked completed without consuming the full skills/rules config, and
the pre-revision spec does not say what they snapshot. Required fix: capture the
hash-input values at config read time (bot-row fields at the bot-row
read, skill fields at the skill-file read before the model call),
hold them for the run, and write them when the item is marked
terminal; define what early-return rows record, including that a
bot-not-found run records no row. Status: closed by the Atelier spec
revision verified in Re-review below; no longer open.

## Decision

All five judging criteria are covered, the checked code claims are
accurate, and the state coverage (present/absent/unsupported,
dirty/saving/save-error/load-error/not-found, empty snapshots) is
thorough. Findings 1-10 are clarifications the builder can resolve
without a spec revision, but finding 11 is must-fix: the terminal-time
snapshot read falsifies the audit hash and leaves early-return rows
undefined, so the spec must require capture at config read time before
the build starts.

Verdict: revise

## Re-review after Atelier spec revision

Atelier revised `Launch snapshots and snapshot hash` in
`docs/design/bot-config-page.md` to require capturing hash-input
values at config read time (bot-row fields at the bot-row read, skill
fields at the skill-file read before the model call), holding them for
the run, and writing them when the item is marked terminal, with a
rules/skill edit mid-flight never changing the recorded snapshot; and
to define early-return rows (fields actually read, null for fields
never read; bot-not-found records no row). Re-checked against
`lib/agent.ts` (:45 read, :195 skill read, :33/:36 terminal marking,
:46-81 early returns): the capture point now precedes the async model
call and the early-return rows are defined, so finding 11 is closed.
No must-fix finding remains open, so the build can start. The owner
confirms by commenting on NOT-393.

Verdict: approve
