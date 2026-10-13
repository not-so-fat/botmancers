# Bot single-runtime creation and configuration — design spec

> **Historical — October 11, 2026.** This runtime-centered design is superseded
> by the authoritative [core-engine design](../core-engine.md). It remains only
> as decision history.

Ticket: NOT-444. Owner: Atelier. Next: operator visual-approval, then UI build ticket.
Status: spec only. No React, CSS, API, database, route, or runtime change is made by this ticket.
Base: exact `origin/main` (`b52c1c1fbfd6d871721388f69d6356dd492fe4f4`) — roster, New Bot modal,
config page, and thread as implemented in `app/page.tsx`, `lib/bot-runtime-ui.ts`, and
`app/bots/[id]/config/page.tsx` at that commit.

Visual/context references (shipped, read-only): `docs/design/bot-runtime-delegation.md`
(NOT-436) and `docs/design/bot-config-page.md` (NOT-392). This spec describes the
**delta** from their dual-runtime assumptions; it does not extend them. Where this spec and
those references disagree, this spec wins for the four surfaces below.

## 1. Product contract (what changes)

The dual presentation is retired everywhere:

- There is exactly **one bot runtime** per bot: `Hermes` or `Agent Deck`.
- There are no separate Chat and Code lines, no `Chat runtime: Hermes (fixed)` line, no
  `Chat:` / `Code:` two-line block, and no separate Coding runtime section next to a fixed
  chat runtime. A bot shows **one runtime summary**.
- The Agent Deck **server URL** moves to a Botmancers-level **workspace settings surface**.
  There is no per-bot server URL control anywhere (not in New Bot, not on the per-bot
  config page, not in the roster).
- Deck selection is a **server-populated dropdown** fed by `GET /api/launch/decks` against
  the configured workspace server. Free-text deck entry is **not** reintroduced while the
  configured server returns deck options (see §5 for the only exception: unreachable /
  malformed server states, which block dropdown selection rather than falling back to
  free text).
- Non-goals (builder must not add): workflow builder, task dashboard, per-bot Agent Deck
  server URL, free-text deck entry when the server returns options, and any redesign of
  chat, group, avatar, approval, artifact, or computer-preview surfaces.

## 2. Vocabulary (single-runtime wording)

Every runtime summary uses exactly one of these two lines:

- `Runtime: Hermes` — the bot converses (and works) through Hermes.
- `Runtime: Agent Deck · <agent> · <deck>` — e.g. `Runtime: Agent Deck · codex · planner`.

The agent token is exactly one of `codex|claude|cursor|muse`. The deck token is the
server-returned deck identifier, rendered verbatim. Working directory never appears in a
summary line; it appears only inside New Bot and the per-bot config page (see §4, §7).

Migration wording reuses the same two lines (see §8). Nothing renders `Chat:` or `Code:`.

## 3. New Bot form — field visibility and defaults

Location: the existing New Bot modal (`BotModal` in `app/page.tsx`, opened by the `New`
button). The Bot/Group kind switch and the Name field are unchanged.

### 3.1 Field list and visibility rules

| # | Field | Visible when | Default / behavior |
|---|---|---|---|
| 1 | Name (existing) | Always | Required text, any non-empty value. Unchanged. |
| 2 | Runtime (new single picker) | Always | Radio or select with exactly two options: `Hermes` (pre-selected) and `Agent Deck`. Hermes is the default single runtime. |
| 3 | Agent (new) | Only after `Agent Deck` is selected | Picker with exactly `codex \| claude \| cursor \| muse`. First entry (`codex`) pre-selected. Hidden while Hermes is selected; switching back to Hermes hides and discards (not submits) agent/deck/workdir values. |
| 4 | Deck (new) | Only after `Agent Deck` is selected | Dropdown populated from the configured server via `GET /api/launch/decks` (see §5). No free-text input while options load successfully. No pre-selection: placeholder `Select a deck…` until the user picks one. |
| 5 | Working directory (new) | Only after `Agent Deck` is selected | Overridable text input, left **blank** when untouched. A hint below the input shows the templated default `~/.botmancers/{bot-id}` where `{bot-id}` is the to-be-assigned bot id (server-generated at insert via `randomUUID` — the client cannot know it before creation, so the input is never pre-filled with an id). Submit omits `working_directory` when the field is untouched/blank (the §4 backend prerequisite assigns the default); any typed value is submitted as the override. Clearing an edited value back to blank restores the omit/default behavior. Hidden while Hermes is selected. |

Field visibility rule (builder-mandatory): Hermes-selected ⇒ only Name + Runtime are
visible. Agent Deck-selected ⇒ Name + Runtime + Agent + Deck + Working directory are
visible. The Agent Deck group appears below Runtime and above the Create/Cancel actions,
with no layout shift of Name/Runtime when it toggles (the group reserves no space while
hidden).

### 3.2 Validation and copy

- Hermes selected: no further validation. Submit creates a Hermes bot.
- Agent Deck selected:
  - No deck chosen: `Select a deck for this bot.` (client copy; shown inline above
    Create; modal stays open with values preserved).
  - Deck dropdown in a blocking error state (unreachable / malformed / empty server —
    see §5): Create is disabled while Agent Deck is selected and no deck is selectable;
    the inline slot explains which state blocks (e.g. `Can't reach the Agent Deck
    server — fix it in Settings, then retry.`). The modal never invents a free-text
    fallback.
  - Server 400 responses render the returned `error` string verbatim in the same inline
    slot (mirrors the existing modal contract).

### 3.3 Annotated New Bot reference (desktop modal, 1440x900)

Default state (Hermes pre-selected — Agent Deck fields absent):

```
┌ New Bot ──────────────────────────┐
│ Name                              │
│ [Alice                       ]    │
│                                   │
│ Runtime                           │
│ (*) Hermes  ( ) Agent Deck        │  ← single picker; Hermes default
│                                   │
│              [Create] [Cancel]    │
└───────────────────────────────────┘
```

Agent Deck selected, deck list loaded:

```
┌ New Bot ──────────────────────────┐
│ Name                              │
│ [Alice                       ]    │
│                                   │
│ Runtime                           │
│ ( ) Hermes  (*) Agent Deck        │
│                                   │
│ Agent                             │
│ ( * ) codex  ( ) claude           │  ← exactly codex|claude|cursor|muse
│ ( ) cursor   ( ) muse             │
│ Deck                              │
│ [planner                    ▾]    │  ← server-populated dropdown
│ Working directory (optional)      │
│ [                            ]    │  ← blank = use default
│ Default: ~/.botmancers/{bot-id}   │  ← hint; {bot-id} assigned at creation
│              [Create] [Cancel]    │
└───────────────────────────────────┘
```

`{bot-id}` is the to-be-assigned bot id, not the agent token: the hint never
contains an agent name (`codex|claude|cursor|muse`) and the input is never
pre-filled with an id the client cannot know. The resolved path (e.g.
`~/.botmancers/a8f3`) appears only after creation, on the per-bot config page.
Submit with the field untouched/blank omits `working_directory` (the §4
backend prerequisite assigns the default); a typed value submits as the override.

Agent Deck selected, deck list loading: the Deck slot reads `Loading decks…`
(disabled); Create is disabled until decks resolve. Agent picker stays interactive.
Workdir input stays blank/editable with the same default hint.

### 3.4 Annotated New Bot reference (narrow, 390x800)

Same fields and order in a full-width card; runtime and agent options stack vertically;
buttons go full-width:

```
┌ New Bot ────────┐
│ Name            │
│ [Alice         ]│
│ Runtime         │
│ (*) Hermes      │
│ ( ) Agent Deck  │
│ [Create]        │
│ [Cancel]        │
└─────────────────┘
```

With Agent Deck selected, the Agent / Deck / Working directory group stacks below
Runtime in the same order as desktop, then full-width Create/Cancel. Annotated
Agent Deck-selected narrow frame (deck loaded):

```
┌ New Bot ────────┐
│ Name            │
│ [Alice         ]│
│ Runtime         │
│ ( ) Hermes      │
│ (*) Agent Deck  │
│ Agent           │
│ (*) codex       │
│ ( ) claude      │
│ ( ) cursor      │
│ ( ) muse        │
│ Deck            │
│ [planner      ▾]│
│ Workdir (opt.)  │
│ [              ]│
│ Default:        │
│ ~/.botmancers/  │
│ {bot-id}        │
│ [Create]        │
│ [Cancel]        │
└─────────────────┘
```

Blank workdir input with the same `~/.botmancers/{bot-id}` hint; submit omits
`working_directory` when untouched, exactly as desktop (§3.1 row 5). While the
deck list loads, the Deck slot reads `Loading decks…` (disabled) and Create is
disabled; agent picker and workdir stay interactive.

## 4. Working-directory default and override behavior

- The default is `~/.botmancers/{bot-id}` where `{bot-id}` is the bot id
  (server-generated at insert; `randomUUID` in `lib/db.ts`). `{bot-id}` is never
  the agent token (`codex|claude|cursor|muse`).
- In New Bot the id is to-be-assigned and therefore unknown: the input is left
  **blank** with the templated default as a hint (`Default:
  ~/.botmancers/{bot-id}`), never pre-filled. Submit with the field untouched or
  cleared omits `working_directory` (which relies on the backend prerequisite
  below to assign the default); a typed value submits as the override. Blank
  never submits as a literal value, and the client never guesses the id.
- On the per-bot config page the id is known: the input shows the stored value
  (default or override). Clearing it back to blank restores the default on
  blur/submit (omit → server default under the backend prerequisite below).
- The resolved default (e.g. `~/.botmancers/a8f3`) is shown only after creation,
  in config read view with no marker. A bot with an overridden workdir shows the
  stored value in config read view with the marker `(custom)` after it, e.g.
  `Working directory: /Users/you/workspace/codes (custom)`.
- Validation: the workdir slot is never in a "required but blank" state (blank
  resolves to omit → server default under the prerequisite below), so there is
  no workdir-required error string in this spec. Server 400 text still renders
  verbatim if the backend rejects a value.

### Backend prerequisite (dependent ticket — no API change in this spec)

Today's API does not assign the default: `POST /api/bots` stores exactly what
it receives (`validateCreateRuntimePath` in `lib/bot-definition.ts`), and a
launchable create without `working_directory` is rejected with 400
(`lib/bot-definition.ts:118`, `app/api/bots/route.ts:36`). `PATCH` with an
omitted `working_directory` keeps the stored value, and a blank one clears it
to null (`lib/db.ts:484`), which reads back as partially stored and renders as
`Runtime: Hermes` under §8. The omit→default wire rule above therefore requires
a backend dependent ticket implementing: (a) POST assigns
`~/.botmancers/{new-id}` when an Agent Deck create omits `working_directory`;
(b) PATCH re-assigns `~/.botmancers/{id}` (instead of null) when an Agent Deck
bot clears `working_directory`, so a UI-cleared value never demotes the bot to
the §8 partially-stored/Hermes presentation (that row then covers only legacy
stored rows, never a post-prerequisite UI clear). The UI wire rule in this spec
is written against the post-prerequisite API.

## 5. Workspace settings surface — Agent Deck server URL

### 5.1 Placement and ownership

A Botmancers-level settings surface (new route or app-level settings panel — builder
chooses the smallest fitting container; see §10) owns the **single** Agent Deck server
URL field. It is the only place the URL is viewed or edited. New Bot and the per-bot
config page link to it (`Configure the Agent Deck server in Settings`) but never render
a URL input.

Settings card layout:

```
AGENT DECK SERVER
Server URL
[http://localhost:7777              ] [Save]
Status: ● Connected · 4 decks · checked 14:02:11
[Retry] (only when not connected)
```

- URL field: single text input with Save (and Discard on dirty, mirroring the config
  page save/dirty cycle: Saved / Unsaved changes / Saving… / Saved HH:MM:SS / error
  inline with Retry).
- Saving the URL re-runs the connection + deck-list fetch. Unsaved URL edits do not
  affect any open New Bot dropdown until saved.
- The status line always shows exactly one state (see §5.2). A manual Retry button is
  present in every non-connected state and re-issues `GET /api/launch/decks`.

### 5.2 Settings + deck-dropdown states for `GET /api/launch/decks`

One state model drives both the settings status line and every deck-dropdown instance
(New Bot + config edit view). Labels below are exact copy:

| # | State | Settings status line | Deck-dropdown rendering | Retry |
|---|---|---|---|---|
| 1 | Loading | `Status: ○ Checking the Agent Deck server…` | Disabled slot reading `Loading decks…`; Create/Save disabled for Agent Deck selections | Auto (no button while loading) |
| 2 | Connected (≥1 deck) | `Status: ● Connected · N decks · checked HH:MM:SS` | Dropdown lists exactly the returned deck ids verbatim; placeholder `Select a deck…` until chosen | Not shown; re-check runs on URL save and on surface open |
| 3 | Empty (connected, 0 decks) | `Status: ○ Connected — no decks on this server.` | Disabled slot reading `No decks on this server — add one there, then retry.`; Agent Deck Create/Save disabled | `Retry` button in both settings and the dropdown slot |
| 4 | Malformed response | `Status: ○ The server returned decks this app can't read.` | Disabled slot reading `The deck list came back unreadable. Retry — or fix the server, then retry.`; Agent Deck Create/Save disabled | `Retry` button in both |
| 5 | Unreachable (network / non-2xx / timeout) | `Status: ○ Can't reach the Agent Deck server.` | Disabled slot reading `Can't reach the Agent Deck server — fix it in Settings, then retry.`; Agent Deck Create/Save disabled | `Retry` button in both |
| 6 | No server configured | `Status: ○ No Agent Deck server set.` | Disabled slot reading `No Agent Deck server set — add it in Settings.`; Agent Deck Create/Save disabled | No retry (nothing to re-fetch); CTA links to Settings |

Rules:

- No per-bot URL control exists in any state. The dropdown slot never becomes a
  free-text input, including in states 3–6 (blocking message + retry instead).
- Hermes flows are unaffected by every state above: creating or saving a Hermes bot
  never touches `GET /api/launch/decks` and never disables.
- Truncation: deck ids truncate with ellipsis exactly like `.bot-preview`; full id is
  the submitted value and the read-view value (title attribute shows full id on hover).

## 6. Roster — one runtime summary

Each roster row keeps its existing layout (mark, name, latest-message preview) and shows
exactly **one** runtime sub-line below the preview, in the same 12px de-emphasised style
as `.bot-preview`:

- Hermes bot: `Runtime: Hermes`
- Agent Deck bot: `Runtime: Agent Deck · codex · planner`
- Agent Deck bot whose saved deck is unavailable (deck id absent from the latest
  successful deck list — the fresh list, or the cached list during an outage):
  the stored line plus the trailing marker ` (deck unavailable — see Config)`,
  e.g. `Runtime: Agent Deck · codex · planner (deck unavailable — see Config)`.
  Unreachability alone never earns the marker (see the cached-list rules below).
  The stored values still render (configuration, honestly labelled); the marker is plain
  non-interactive text. The roster row's own click still opens the conversation; no inner
  link/button is rendered inside the row, so no `stopPropagation`, tab stop, or key
  handling is added.

No `Chat:` / `Code:` lines appear in any roster state.

Roster rendering against deck-list states (§5.2):

- Connected with a fresh list, or empty list: availability is checked against
  that list. A stored deck absent from the list gets the
  ` (deck unavailable — see Config)` marker.
- Unreachable with a last successful list cached: availability is checked
  against the cached list; a stored deck absent from the cache gets the marker.
  A transient outage never flags bots whose decks are in the cache.
- Unreachable with no cached list: availability is unknown, so Agent Deck rows
  render the stored line **without** any marker (never a blanket
  "unavailable" flag during an outage). The per-bot config page still carries
  the unreachable notice + Retry (§7.2).
- No Agent Deck server set: the roster has nothing to check against, so Agent
  Deck rows render the stored line **without** any marker. Discovery of the
  missing server happens in Settings and the config page, not the roster.

### 6.1 Annotated roster reference (desktop rail, 1440x900)

```
│ Alice                   │  ← .bot-name (26px inline, preserved)
│ shipped the migration   │  ← .bot-preview: latest message
│ Runtime: Hermes         │  ← single summary line (12px, 50% ink)
│                         │
│ Planner Bot             │  ← configured Agent Deck row
│ reviewed the diff       │
│ Runtime: Agent Deck     │
│   · codex · planner     │  ← wraps to at most 2 lines, then ellipsis
│                         │
│ Stale Bot               │  ← saved deck currently unavailable
│ old thread preview      │
│ Runtime: Agent Deck     │
│   · codex · planner     │
│   (deck unavailable —   │
│   see Config).          │  ← plain-text marker; row click unchanged
```

All three rows render inside equal-width frames; `Runtime: Hermes` is padded
to the same column width as the longest line (no border overrun).

### 6.2 Annotated roster reference (narrow, 390x800)

The rail stacks above the thread (`max-height: 38vh`, scrollable). Rows keep the same
order, sizes, and truncation; only the width changes:

```
│ Alice                   │
│ shipped the migration   │
│ Runtime: Hermes         │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ Planner Bot             │
│ reviewed the diff       │
│ Runtime: Agent Deck     │
│   · codex · planner     │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ Stale Bot               │  ← saved deck currently unavailable
│ old thread preview      │
│ Runtime: Agent Deck     │
│   · codex · planner     │
│   (deck unavailable —   │
│   see Config).          │  ← plain-text marker; row click unchanged
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ (thread below, scrolled)│
```

All three rows render inside equal-width frames; `Runtime: Hermes` is padded
to the same column width as the longest line (no border overrun).

Responsive/truncation: desktop (≥800px) rail `max-width: 280px`; the summary line
truncates with ellipsis like `.bot-preview` and never pushes the row mark out of
alignment. Narrow (<800px) keeps the same order and truncation.

## 7. Per-bot configuration page — runtime card

The per-bot page at `/bots/[id]/config` gains one card, **Runtime**, placed after Rules
and before Template source (the position the Coding path card held in the NOT-436
reference). Skills, Rules, Template source, and Launch snapshots are unchanged (see
`docs/design/bot-config-page.md`).

### 7.1 Read view

Hermes bot:

```
RUNTIME                                     Saved
Runtime: Hermes
[Change to Agent Deck]
```

Agent Deck bot (default workdir):

```
RUNTIME                                     Saved
Runtime: Agent Deck · codex · planner
Working directory: ~/.botmancers/a8f3
[Edit]
```

Agent Deck bot (overridden workdir):

```
RUNTIME                                     Saved
Runtime: Agent Deck · claude · research
Working directory: /Users/you/workspace/codes (custom)
[Edit]
```

Agent Deck bot whose saved deck is unavailable (stored deck checked against a
fresh or cached list and absent from it):

```
RUNTIME                                     Saved
Runtime: Agent Deck · codex · planner (deck unavailable)
Working directory: ~/.botmancers/a8f3
This deck isn't on the configured server right now. Pick another
deck, or fix the server in Settings. [Edit]
```

When no list is available at all (deck list unreachable with no cached list,
or no server configured), the read view shows the stored runtime line with no
`(deck unavailable)` marker; the notice names that state instead (unreachable /
missing server) and links to Settings — the same cached-list rule as the
roster (§6).

### 7.2 Edit view

Same save/dirty/saving/confirmed/error cycle as Skills/Rules:

- Runtime switch: `Hermes` / `Agent Deck` (same two options as New Bot). Switching to
  Hermes in edit view hides Agent/Deck/Workdir and, on save, stores the Hermes runtime
  (agent/deck/workdir handling is a backend concern — the UI sends the runtime choice
  and the visible field values, and renders what the server returns).
- Agent picker: exactly `codex|claude|cursor|muse`, pre-filled from the stored agent.
- Deck dropdown: populated from `GET /api/launch/decks` with the six states in §5.2.
  The currently stored deck stays displayed as plain text even when absent from the
  list, with the note `Saved deck not on this server — saving keeps it unless you pick
  another.` It is never offered as a fresh choice to other bots.
- Working directory: text input pre-filled with the stored value (resolved
  default such as `~/.botmancers/a8f3`, or the override). Clearing it restores
  the `~/.botmancers/{bot-id}` default on blur/submit — submit omits
  `working_directory` and the server re-assigns the default (requires the §4
  backend prerequisite; post-prerequisite a cleared value stores the default and
  the bot keeps its Agent Deck presentation — it never falls into the §8
  partially-stored/Hermes row).
- No server URL input on this page. The deck slot's unreachable/missing-server copy
  links to Settings.

### 7.3 Annotated config reference (desktop, 1440x900)

```
┌──────────────────────────────────┬─────────────────────────────┐
│ SKILLS                    Saved  │ LAUNCH SNAPSHOTS            │
│ … (unchanged)                    │ … (unchanged)               │
├──────────────────────────────────┤                             │
│ RULES                     Saved  │                             │
│ … (unchanged)                    │                             │
├──────────────────────────────────┤                             │
│ RUNTIME                   Saved  │                             │
│ Runtime: Agent Deck              │                             │
│   · codex · planner              │                             │
│ Working directory:               │                             │
│ ~/.botmancers/a8f3               │                             │
│ [Edit]                           │                             │
├──────────────────────────────────┤                             │
│ TEMPLATE SOURCE                  │                             │
│ … (unchanged)                    │                             │
└──────────────────────────────────┴─────────────────────────────┘
```

### 7.4 Config responsive (narrow, 390x800)

The Runtime card stacks full-width in the same section order (Skills, Rules, Runtime,
Template source, Snapshots); the working-directory value wraps; buttons go full-width,
matching the existing narrow rules. The unavailable-deck notice stacks above Edit.

Annotated narrow examples (390x800) — one per listed state:

Hermes bot:

```
┌ Runtime ────────┐
│ Runtime: Hermes │
│ Saved           │
│ [Change to      │
│  Agent Deck]    │
└─────────────────┘
```

Agent Deck bot, default workdir:

```
┌ Runtime ────────┐
│ Runtime:        │
│ Agent Deck      │
│ · codex · plan… │  ← ellipsis like .bot-preview
│ Workdir:        │
│ ~/.botmancers/  │
│ a8f3            │
│ [Edit]          │
└─────────────────┘
```

Agent Deck bot, workdir override:

```
┌ Runtime ────────┐
│ Runtime:        │
│ Agent Deck      │
│ · claude · res… │
│ Workdir:        │
│ /Users/you/     │
│ workspace/codes │
│ (custom)        │
│ [Edit]          │
└─────────────────┘
```

Unavailable saved deck:

```
┌ Runtime ────────┐
│ Runtime:        │
│ Agent Deck      │
│ · codex · plan… │
│ (deck unavail.) │
│ This deck isn't │
│ on the server.  │
│ Pick another,   │
│ or fix it in    │
│ Settings.       │
│ [Edit]          │
└─────────────────┘
```

### 7.5 Config loading / error variants (unchanged positions)

Availability-style loading keeps the existing skeleton cards with the Runtime skeleton
in its fixed position (no layout shift). Per-section `Couldn't load this section.
Retry.`, full-page `Bot not found.`, and the browser-native unsaved-changes prompt are
unchanged from the existing spec.

## 8. Migrated bot states (one-line summaries, desktop + mobile)

"Migration" here is presentation-only: bots stored under the old dual-runtime
`coding_runtime` / `deck_name` / `working_directory` shape render through the new
single-runtime lines without any data change by this ticket. The builder maps stored
values to display as follows (roster and config read view share the mapping):

| Stored state | Roster line | Config read view |
|---|---|---|
| Migrated Hermes bot (no coding path stored: all three coding fields null) | `Runtime: Hermes` | `Runtime: Hermes` + `[Change to Agent Deck]` |
| Partially stored legacy coding path (only some of `coding_runtime` / `deck_name` / `working_directory` present — treated as unconfigured, matching `rosterRuntimeLines`/`configCodingPathLines`; post-§4-prerequisite this covers legacy stored rows only, never a UI-cleared workdir) | `Runtime: Hermes` | `Runtime: Hermes` + `[Change to Agent Deck]` |
| Migrated Agent Deck bot (full coding path stored, deck on server) | `Runtime: Agent Deck · <agent> · <deck>` | `Runtime: Agent Deck · <agent> · <deck>` + workdir (+ `(custom)` only when overridden) + `[Edit]` |
| Unavailable saved deck (stored deck absent from the fresh list, or from the cached list during an outage — never bare unreachability with no list) | Stored line + ` (deck unavailable — see Config)` | Stored line + ` (deck unavailable)` + notice + `[Edit]` |
| Working-directory override (stored workdir ≠ default) | Same line as its runtime (workdir never in roster) | Workdir value + ` (custom)` |

Desktop examples for each row appear in §6.1 / §7.1; narrow examples in §6.2 / §7.4.
Every listed state except the partially stored legacy path (which renders
identically to the migrated-Hermes frames in both viewports) has its own
annotated desktop and narrow rendering in those sections — no state renders
`Chat:` / `Code:` on either viewport.

## 9. Non-local execution limitation (unconfirmed — copy, not a control)

Execution locality for Agent Deck runs is unconfirmed at spec time. The UI therefore
carries one honest, non-blocking note and no locality picker, toggle, or per-bot host
field:

- New Bot (Agent Deck selected), below Working directory, 12px de-emphasised:
  `Runs use the configured Agent Deck server. Remote execution is unconfirmed —
  see Settings for the configured server.`
- Settings surface, below the status line, same style:
  `Runs use the server above. Remote execution is unconfirmed.`
- Config edit view (Agent Deck), below Working directory, same style: the same sentence
  as New Bot.

This note never blocks Create/Save, never branches states, and never revives a host
picker or per-bot URL. If locality is later confirmed, the note is replaced through a
follow-up spec — the builder does not design that change here.

## 10. Implementation handoff (state-to-component map)

Preserve (do not restyle or restructure): the dark roster-and-thread visual language —
CSS tokens (`--field`, `--card`, `--hairline`, `--ink`, `--accent`) and classes
`.field`, `.rail`, `.bot-row`, `.bot-name`, `.bot-preview`, `.card`, `.thread`,
`.msg-you`, `.msg-bot`, `.msg-body`, `.composer`, `.modal-scrim`, `.new-forms`,
`.form-card`, `.kind-row`, `.kind-word`, `.form-actions`, `.create-btn`, `.cancel-btn`
in `app/globals.css`; the config page language `.cfg-page`, `.cfg-card`, `.cfg-title`,
`.cfg-input`, `.cfg-btn-primary`, `.cfg-btn-ghost`, `.cfg-muted`, `.cfg-faint`,
`.cfg-error`, the dirty/saving/confirmed/error cycle, and the Skills/Rules/Template/
Snapshots sections in `app/bots/[id]/config/page.tsx`; thread behavior (plain-text bot
turns, existing Stop buttons).

| State / behavior | Component / module | Change |
|---|---|---|
| New Bot single Runtime picker (Hermes default), Agent Deck group visibility (§3.1) | `app/page.tsx` — `BotModal` (form-card block) | Replace fixed chat line + availability-fed coding picker + free-text deck/workdir with Runtime picker; render Agent/Deck/Workdir group only when Agent Deck selected |
| Agent picker `codex\|claude\|cursor\|muse` | `app/page.tsx` — `BotModal`; options enum shared with `lib/bot-definition.ts` `CODING_RUNTIMES` | New picker; pre-select first entry |
| Deck dropdown + 6 states (§5.2), default/override workdir (§4), non-local note (§9) | `app/page.tsx` — `BotModal` | New dropdown fed by `GET /api/launch/decks`; workdir input blank with `~/.botmancers/{bot-id}` hint, omitted on submit when untouched (omit→default requires the §4 backend prerequisite); note as static copy |
| Roster one-line summary + unavailable-deck marker (§6) | `app/page.tsx` — roster rows (`.bot-row` / `.bot-preview` / `.bot-runtime` slots); summary-line helper succeeding `rosterRuntimeLines` in `lib/bot-runtime-ui.ts` | Replace two-line Chat/Code block with one summary line; keep row click/open behavior unchanged |
| Runtime summary copy + deck-state copy (single source) | `lib/bot-runtime-ui.ts` | Succeed the `CHAT_*` / `Code:` / availability-probe copy with single-runtime summary builders and the §5.2 deck-list state copy; no per-bot URL copy |
| Config Runtime card read/edit/save cycle (§7) | `app/bots/[id]/config/page.tsx` — Runtime card (position after Rules) | Replace Coding path card with Runtime card; agent picker, server-fed deck dropdown, workdir default/override, unavailable-deck notice, no URL field |
| Workspace settings surface: server URL + 6 states (§5) | New settings surface (smallest fitting container: new route or app-level panel reusing `.card` / `.cfg-card` language) | New URL field, status line, Retry, dirty/save cycle, non-local note; sole writer of the server URL |
| Deck-list fetch + malformed/unreachable/empty handling | Settings surface + dropdown data hook (builder-placed, shared by New Bot and config) | Single fetcher for `GET /api/launch/decks`; malformed = unparseable or shape-mismatched payload; unreachable = network/non-2xx/timeout |
| Server-side workdir default prerequisite (§4) | Backend dependent ticket: `app/api/bots/route.ts`, `lib/bot-definition.ts`, `lib/db.ts` (`updateRuntimePath`) | POST assigns `~/.botmancers/{new-id}` on omitted workdir; PATCH re-assigns the default on blank clear; this spec makes no API change |

Explicitly excluded (builder must not touch): workflow builder, task dashboard,
per-bot Agent Deck server URL, free-text deck entry while the server returns options,
and any redesign of chat, group, avatar, approval, artifact, or computer-preview
surfaces (including `BotAvatar`, approval/artifact rendering, group threads, and the
computer-preview band).

## 11. Atelier state board (attached visual reference)

The Atelier review attaches one labeled state board alongside this spec (image or
equivalent labeled export). Minimum frames, each labeled with frame name + viewport:

1. New Bot — Hermes default (desktop 1440x900).
2. New Bot — Agent Deck selected, deck loaded (desktop 1440x900).
3. New Bot — Agent Deck selected, narrow (390x800).
4. Settings — connected (desktop 1440x900).
5. Settings — unreachable + Retry (desktop 1440x900).
6. Deck dropdown — loading / empty / malformed / unreachable slots (one frame each or
   one annotated strip; each slot labeled).
7. Roster — Hermes / Agent Deck / unavailable-deck rows (desktop + narrow).
8. Config — Runtime card read + edit, unavailable-deck notice, workdir override
   (desktop + narrow).

Each frame is labeled with the exact `origin/main` SHA it was approved against. The
ASCII references in §3.3, §3.4, §6.1, §6.2, and §7.3 are the normative fallback if
image export is unavailable; the approval record names the SHA regardless of medium.
