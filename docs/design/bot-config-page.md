# Bot configuration page — design spec

Ticket: NOT-392. Owner: Atelier. Next: Critiquito critique, then build ticket.
Status: spec only. No page or API is implemented by this ticket.

## Purpose and route

One page per bot at `/bots/[id]/config` that makes the bot's effective
configuration transparent: which skills, which rules, and which template
source the bot launches with, plus the recorded snapshot (and hash) of every
launch. This page is the reason Botmancers exists instead of just using
Grok Bot: the configuration a bot runs with is visible, editable, and
auditable in one place.

Entry points (the only changes to existing UI):

- Chat header on `app/page.tsx`: a "Config" link next to the bot name/title
  when a bot conversation is open.
- Sidebar bot rows: the bot name row keeps opening the chat; no new controls
  there.

Unknown bot id renders the not-found state (see states). No session history,
task boards, groups, or cloud/runner controls appear on this page.

## Page structure

Header, then three configuration sections, then the launch snapshot list:

1. Header: back link ("← Back to chat"), bot identity (name, title,
   both read-only; avatar renders read-only when set), current-config
   hash, saved/dirty indicator.
2. Skills section.
3. Rules section.
4. Template source section.
5. Launch snapshots section.

Section order is fixed: skills, rules, template source, snapshots. Each of
the three configuration sections is an independent card with its own heading,
body, state indicator, and Save/Discard controls. Saving one section never
touches the others.

## Skills section

Shows the bot's local instruction skill, the file read by `localSkillForBot`
in `lib/skills.ts` (`skills/<botName>/SKILL.md`, name must match
`/^[A-Za-z0-9_-]+$/`). At launch the file body is appended as a trailing
system message (see `lib/agent.ts`); the page shows exactly that.

Contents:

- Status line: `Present`, `Not present`, or `Unsupported name` (see
  below), plus the resolved path when the name is valid (for example
  `skills/Alice/SKILL.md`).
- When present: file body in a read-only code block, with an Edit button
  that swaps it for a textarea. Present means the file exists and is
  non-blank, matching `localSkillForBot` (a missing or blank file is
  Not present, never an error).
- When absent: the copy `No skill file yet. Create SKILL.md to give this
  bot standing instructions.` plus a Create button that opens an empty
  textarea.
- When the bot name fails `/^[A-Za-z0-9_-]+$/` (legal via
  `POST /api/bots`, which accepts any non-empty name — for example
  `Imported Bot`): the status line reads `Unsupported name` and the body
  copy reads `Skill files need a bot name matching
  /^[A-Za-z0-9_-]+$/ — this name cannot map to a skill path.` No path is
  shown and there is no Create or Edit button. This state is distinct
  from `Not present` (valid name, no file yet).
- A one-line note: `Appended verbatim as a system message at launch.`
- MCP servers are global today (`mcp_servers` has no bot linkage) and are
  not listed or edited here; per-bot tool attachment is future work.

Editing: textarea with Save and Discard buttons. Save writes the file and
re-renders the read-only block. An empty save deletes the file (with a
confirm step: `Delete this skill file?`) and the section returns to the
absent state.

Hash mapping: `skill_path` is the resolved path when the name is valid,
else null; `skill_present` is true only in the Present state;
`skill_content` is the full file body in the Present state, else null.

## Rules section

Shows the bot's standing rules: the `description` field, consumed verbatim
as a hard constraint on every reply (`Standing rules, verbatim...` in
`lib/agent.ts`). Bot `name` and `title` are shown read-only in the page
header, not here, so this section is exactly one field.

This page never renames a bot: there is no name/title edit control, no
save grouping for identity, and no identity state cycle. If the name is
changed elsewhere (via `PATCH /api/bots`), this page does not move any
skill file — the Skills section simply re-resolves
`skills/<newName>/SKILL.md` on next load, which may flip Present to Not
present (old file orphaned) or to Unsupported name (new name invalid).
That re-resolution is the specified rename behaviour; no warning or
migration prompt appears on this page.

Contents:

- A textarea with the current description.
- A one-line note: `Sent verbatim as the standing-rules system message on
  every turn. This beats the user's request for detail or length.`
- Save and Discard buttons (same states as skills).

Validation: description may be empty (rules then impose no constraint).
There is no name validation on this page because name is not editable
here; `PATCH /api/bots` (`Name is required`) still applies to callers
that do edit identity.

## Template source section

Shows where the bot came from. Bots created by import carry provenance
columns (`source_provider`, `template_id`, `template_url`,
`import_schema_version`, `import_operation_id`, `import_timestamp`); bots
created in Botmancers have all of them null.

This section is read-only by design: provenance is a historical record of
the import, and editing it would falsify history. It therefore has no
dirty/saving states, only loaded, absent, and load-error states (see
states).

Present state — a definition list with exactly these rows:

- Source provider (for example `grok-marketplace`)
- Template ID (for example `template-abc`)
- Template URL (rendered as a link; for example
  `https://example.com/template/abc`)
- Import schema version (for example `1.0.0`)
- Import operation ID (for example `import-op-12345`)
- Imported at (local date-time rendered from `import_timestamp`)

Example values above are the real fixture values from `test-import.js`.
No Edit button. No "re-import" or "link template" action on this page.

## Absent template source

Bots created manually in Botmancers (via `POST /api/bots`, which sets no
provenance) show this state:

- The copy `Created manually in Botmancers — no template source.`
- The six provenance rows render as `—` (em dash), so the builder keeps the
  same row layout in both states.
- No call to action: importing is initiated from the bot list
  ("Import from Grok Marketplace"), not from this page.

The desktop and narrow mocks below both show this state, because the mock
bot Alice was created manually.

## Edit, save, dirty, and error states

States apply per section. Skills and rules have the full cycle; template
source is read-only and uses only loaded, absent, and load-error.

- Saved (clean): body shows stored values. State line reads
  `Saved` with no dot. Save/Discard are hidden (skills present/read-only
  view) or disabled (rules textarea matches stored value).
- Dirty: any keystroke that differs from the stored value shows an amber
  dot, the state line `Unsaved changes`, and enables Save/Discard.
  Navigating away with dirty state shows the browser-native unsaved-changes
  prompt.
- Saving: Save click disables both buttons, shows `Saving…`, and keeps the
  edited text visible. Double-submit is impossible.
- Saved confirmation: on success the section returns to clean and the state
  line reads `Saved HH:MM:SS` (local time) for five seconds, then `Saved`.
- Save error: on failure the edits are preserved, the section stays dirty,
  and an inline error appears above the buttons:
  `Couldn't save: <reason>. Retry.` with a Retry button that re-attempts
  the same save. Reasons reuse the saving API's message verbatim: rules
  saves go to `PATCH /api/bots` with `{id, description}` only, skills
  saves to the skill file write; network failure and `Bot not found`
  (deleted mid-edit) are the other reasons. No save on this page touches
  avatar, so no avatar error appears here.
- Load error (all sections including template source): the card shows
  `Couldn't load this section. Retry.` with a Retry button; other sections
  still render.
- Page-level loading: skeleton cards in the section positions, no layout
  shift when content arrives.
- Bot not found: full-page `Bot not found.` with a back-to-chat link.
  No sections render.

Header indicator: the header shows one dot summarizing all sections —
amber `Unsaved changes` if any section is dirty, otherwise `Saved`.

## Launch snapshots and snapshot hash

A launch is one `processing_queue` item for this bot reaching a terminal
state (`completed` or `failed`) — that is, one `processQueueItem` run in
`lib/agent.ts`, including the greeting run enqueued at bot creation. The
snapshot captures the effective configuration that run used: the builder
captures the hash-input values at config read time (bot-row fields when
the run reads the bot row, skill fields when it reads the skill file
before the model call), holds them for the run, and writes them when the
item is marked terminal; the written row is immutable afterwards. A
rules/skill edit during an in-flight run therefore never changes that
run's recorded snapshot. Runs that return before the config read point
(bot not found, conversation not found, chief-of-staff delegated runs,
and other pre-model early returns) record a row with the fields actually
read and null for fields never read; a bot-not-found run records no row
on any bot page because no bot identity exists to attach it to. There is no
de-duplication: every launch records a row even when its hash equals the
previous row's, and failed launches record the same snapshot fields (the
failure does not change the configuration used). The launch id is the
queue item's `id` (a UUID v4 from `randomUUID`; the short form shown on
rows is its first 4 characters). The Launch snapshots section lists
launches reverse-chronologically (newest first), below the three config
sections.

Row layout (one row per launch):

- Launch time (local date-time) and short launch id (first 4 characters
  of the queue item id).
- Short hash: first 12 hex characters, monospace, with a Copy button that
  copies the full 64-character hash.
- Freshness badge: `Matches current config` (green) when the row hash
  equals the current-config hash in the header, else `Config changed
  since` (grey).
- Expand chevron: opens the snapshot detail inline, showing the full
  launch id, the full hash, and the covered field values recorded at
  launch.

The snapshot hash is displayed in three places: the current-config hash in
the page header (computed live from saved values), the short hash on each
snapshot row, and the full hash inside the expanded snapshot detail.

Hash algorithm: SHA-256 over canonical JSON — object keys sorted
recursively at every level, UTF-8, no whitespace — hex-encoded.
Pseudocode:

  canonical = JSON.stringify(sortKeysDeep(hashInput))
  hash = sha256Hex(utf8(canonical))

This is deliberately not `computeBodyHash` in
`app/api/bots/import/route.ts`: that function hashes a different field set
(the import request body) with `JSON.stringify` in written key order and
no key sorting. The snapshot hash sorts keys, so the builder implements
the sorted-key canonicalisation above rather than reusing
`computeBodyHash`.

The hash covers exactly these fields (listed here in the sorted key order
used by the canonicalisation):

- `description` (the rules text)
- `import_operation_id`, `import_schema_version` (each null when absent)
- `name`
- `skill_content` (full file body, or null), `skill_path` (for example
  `skills/Alice/SKILL.md`, or null when the bot name is invalid — see
  the Skills section), `skill_present` (boolean)
- `source_provider`, `template_id`, `template_url` (each null when absent)
- `title`

String fields use stored values verbatim: `title` and `description` are
`''` when empty (never null); provenance fields, `skill_path`, and
`skill_content` are null when absent.

The hash covers configuration only. It does not cover avatar, color,
pinned, timestamps, conversation history, or model/API settings, so a hash
match means "same effective configuration" and nothing more.

Empty state: `No launches recorded yet.` (A bot that never launched has no
rows; the section still renders with its heading.)

## Desktop layout (mock: Alice)

Viewport 1440x900. Two columns. Name, title, and rules are the real
prototype values for the manually created bot Alice from
`test-acceptance-steps-1-7.js`. Alice ships no `skills/Alice/SKILL.md`,
so her real skills state is Not present; the body below is the
prototype's only shipped `SKILL.md` body
(`skills/LaunchMint/SKILL.md`) shown verbatim as a STAND-IN to illustrate
the Present state. The two snapshot rows are illustrative examples.

```
┌────────────────────────────────────────────────────────────────┐
│ ← Back to chat                                                 │
│ Alice                             Current config hash: 9f2ca41b│
│ Research Assistant                 ● Saved                     │
├──────────────────────────────────┬─────────────────────────────┤
│ SKILLS                    Saved  │ LAUNCH SNAPSHOTS            │
│ skills/Alice/SKILL.md · Present  │ ┌─────────────────────────┐ │
│ ┌──────────────────────────────┐ │ │ 2026-10-10 14:02 · a8f3 │ │
│ │ Every reply ends with the    │ │ │ 9f2ca41b7e03 · Copy     │ │
│ │ exact token skillmint441     │ │ │ ● Matches current config│ │
│ │ and nothing about why.       │ │ └─────────────────────────┘ │
│ └──────────────────────────────┘ │ ┌─────────────────────────┐ │
│ [Edit]                           │ │ 2026-10-09 09:15 · b71c │ │
│ Appended verbatim as a system    │ │ 44d0e9aa12bc · Copy     │ │
│ message at launch.               │ │ ○ Config changed since  │ │
├──────────────────────────────────┤ └─────────────────────────┘ │
│ RULES                     Saved  │                             │
│ ┌──────────────────────────────┐ │                             │
│ │ You are Alice, a research    │ │                             │
│ │ assistant. When asked to     │ │                             │
│ │ research something, provide  │ │                             │
│ │ a brief response and then    │ │                             │
│ │ use: WAKE Bob: Please review │ │                             │
│ │ my research on [topic]. Make │ │                             │
│ │ sure to actually use the     │ │                             │
│ │ WAKE command to hand off to  │ │                             │
│ │ Bob.                         │ │                             │
│ └──────────────────────────────┘ │                             │
│ Sent verbatim as the             │                             │
│ standing-rules system message.   │                             │
├──────────────────────────────────┤                             │
│ TEMPLATE SOURCE                  │                             │
│ Created manually in Botmancers   │                             │
│ — no template source.            │                             │
│ Source provider .... —           │                             │
│ Template ID ........ —           │                             │
│ Template URL ....... —           │                             │
│ Schema version ..... —           │                             │
│ Operation ID ....... —           │                             │
│ Imported at ........ —           │                             │
└──────────────────────────────────┴─────────────────────────────┘
```

Full hash inside the expanded first row (format example, illustrative):
`9f2ca41b7e03c5d81a2f6b9407e3d4c5a6b708192a3b4c5d6e7f80910a1b2c3d4`.

## Narrow-width layout (mock: Alice)

Viewport 390x800. Single column, same sections in the same order, same
bot values as the desktop mock. The snapshot list moves below the three
config sections; rows stack time, launch id, hash, and badge vertically.

```
┌──────────────────────┐
│ ← Back to chat       │
│ Alice                │
│ Research Assistant   │
│ Config hash: 9f2ca41b│
│ ● Saved              │
├──────────────────────┤
│ SKILLS        Saved  │
│ skills/Alice/        │
│ SKILL.md · Present   │
│ ┌──────────────────┐ │
│ │ Every reply ends │ │
│ │ with the exact   │ │
│ │ token            │ │
│ │ skillmint441     │ │
│ │ and nothing      │ │
│ │ about why.       │ │
│ └──────────────────┘ │
│ [Edit]               │
├──────────────────────┤
│ RULES         Saved  │
│ ┌──────────────────┐ │
│ │ You are Alice, a │ │
│ │ research         │ │
│ │ assistant. When  │ │
│ │ asked to research│ │
│ │ something, ...   │ │
│ │ use: WAKE Bob:   │ │
│ │ Please review my │ │
│ │ research on      │ │
│ │ [topic]. ...     │ │
│ └──────────────────┘ │
│ (scrolls; full text  │
│ identical to desktop)│
├──────────────────────┤
│ TEMPLATE SOURCE      │
│ Created manually in  │
│ Botmancers — no      │
│ template source.     │
│ Source provider: —   │
│ Template ID: —       │
│ Template URL: —      │
│ Schema version: —    │
│ Operation ID: —      │
│ Imported at: —       │
├──────────────────────┤
│ LAUNCH SNAPSHOTS     │
│ ┌──────────────────┐ │
│ │ 2026-10-10 14:02 │ │
│ │ launch a8f3      │ │
│ │ 9f2ca41b7e03     │ │
│ │ [Copy]           │ │
│ │ ● Matches current│ │
│ │   config         │ │
│ └──────────────────┘ │
│ ┌──────────────────┐ │
│ │ 2026-10-09 09:15 │ │
│ │ launch b71c      │ │
│ │ 44d0e9aa12bc     │ │
│ │ [Copy]           │ │
│ │ ○ Config changed │ │
│ │   since          │ │
│ └──────────────────┘ │
└──────────────────────┘
```

Narrow rules: the rules textarea keeps the full Alice description text
(byte-identical to desktop) and scrolls internally; nothing truncates
stored values. Buttons are full-width. The header stacks identity above
the hash line.

## Out of scope

Explicitly not on this page; a builder must not add them here:

- Memory: conversation and message history stay on the chat page.
- Routines: schedules, cron, wake rules, and recurring tasks.
- Cloud settings: hosts, runners, devices, API keys, model selection,
  tunnels, and phone access.
- Session history and task boards.
- Group membership and group settings.
- MCP server management (add/edit/remove servers).
- Avatar editing (avatar renders read-only in the header when set).
- Re-import, link-template, or template-browsing actions.
- Any change to the chat or bot-list layout beyond the single Config link.
