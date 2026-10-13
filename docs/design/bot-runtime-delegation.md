# Bot runtime and same-thread delegation — design spec

> **Historical — October 11, 2026.** This dual-runtime design is superseded by
> the authoritative [core-engine design](../core-engine.md). Do not implement
> its Chat/Code split as current product behavior.

Ticket: NOT-436. Owner: Atelier. Next: operator inspection approval, then build ticket.
Status: spec only. No React, CSS, API, or database change is made by this ticket.
Base: exact `origin/main` (`d7b97174aacea414615c42769da5a82d3df5c123`) — roster, New Bot modal, config page, and
thread as implemented in `app/page.tsx`, `app/globals.css`, and
`app/bots/[id]/config/page.tsx` at that commit.

## Purpose

One layout specification for three surfaces that must each keep two runtime
roles legible and never conflate them:

- **Chat** (persistent conversational runtime): always Hermes today.
  Fixed, not chosen.
- **Code** (coding-agent launch path): `<coding runtime> · <deck>`, launched
  only through the NOT-395 agent-deck adapter. Only launch paths reported
  ready by the backend are ever selectable.

The delegation story (handoff, bound session, review, resume, final result,
failure) stays inside the existing conversation as ordinary bot turns. No
workflow builder, no mode picker, no separate orchestration screen.

## Information hierarchy

Everywhere both roles appear, Chat comes first and Code second, in this
exact wording:

- `Chat: Hermes`
- `Code: <coding_runtime> · <deck_name>` (configured bots only)

The persistent label and the coding label are always two separate lines.
A bot never shows a single merged "runtime" line.

### Configured path vs effective launch

The `Code:` line everywhere (roster, config, modal confirmation) shows the
bot's **stored configured path** — the `coding_runtime`, `deck_name`, and
`working_directory` saved on the bot record. It is configuration, not a
claim about what the next delegation will run.

The effective launch is resolved at delegation time by the conversation
loop (`lib/agent.ts`, DECK directive path), never read from the bot
record: the runtime comes from the model's `DECK <runtime>:` directive
line, the deck comes from `resolveDeckForCwd` over `BOTMANCERS_DECK_CWD`
(or `process.cwd()`), and the working directory is that same cwd. The
loop overwrites the held launch snapshot with the resolved values
(`recordDeckLaunchInSnapshot`), so the snapshot records what the launch
actually used. Thread `[Deck …]` events likewise carry the effective
values — a handoff's `runtime=`/`deck=` may differ from the roster's
configured `Code:` line, and that is expected. The UI never reconciles
the two; it labels the stored value honestly and lets the thread tell
what actually ran. No adapter or loop change is expected from the build
ticket: this difference is documented, not closed.

Working directory appears only on the config page, never in the roster or
thread. Session ids and run ids appear only in thread delegation events,
copied verbatim from the adapter.

## New Bot section

The New Bot modal (`BotModal` in `app/page.tsx`, opened by the `New` button)
gains a coding-path group below the existing name field. The Bot/Group
kind switch is unchanged.

### Fields

1. **Name** (existing): unchanged — required text, any non-empty value.
2. **Chat runtime** (new, fixed): read-only line reading
   `Chat runtime: Hermes (fixed)`. No picker, no input. It documents that
   every manually created bot converses through Hermes.
3. **Coding runtime** (new): picker whose options are exactly the entries
   of `GET /api/bots/availability` (`{ runtimes: [{ runtime, launchable }] }`).
   Only probe-ready runtimes appear. There is no free-text runtime input.
4. **Deck name** (new): required text input, placeholder `planner`.
5. **Working directory** (new): required text input, placeholder
   `/Users/you/workspace/codes/botmancers`.

Submit posts the existing `POST /api/bots` shape plus the coding path with
`launchable: true`:

```json
{
  "name": "Alice",
  "launchable": true,
  "coding_runtime": "codex",
  "deck_name": "planner",
  "working_directory": "/Users/you/workspace/codes/botmancers"
}
```

`persistent_runtime` is omitted and defaults to Hermes server-side.

### Validation and copy

A launchable bot must carry the full coding path
(`validateLaunchableCodingPath` in `lib/bot-definition.ts`). Client-side
validation mirrors the server errors verbatim so the modal never invents
its own wording:

- No coding runtime chosen: `Invalid coding runtime: "". Expected one of
  codex|claude|cursor|muse.`
- Deck name blank: `Deck name is required for a launchable bot.`
- Working directory blank: `Working directory is required for a launchable bot.`

These strings are server error text rendered verbatim in the modal's
inline error slot — they are validation feedback, not launch-path
options. The picker itself never lists a runtime the probe did not
report ready; no name appearing only inside an error string is ever
rendered as a selectable choice.

Errors render inline above the Create button; the modal stays open with all
typed values preserved. Create is disabled while the availability fetch is
loading (see states). Server 400 responses render the returned `error`
string verbatim in the same inline slot.

### Availability states in the modal

- **Loading**: the coding-runtime picker is disabled and reads
  `Checking available runtimes…`. Create is disabled.
- **Ready (one or more)**: picker lists exactly the returned runtimes.
  The first entry is pre-selected.
- **Empty (none verified)**: the picker is replaced by the honest
  unavailable state — no fake option is rendered:
  `No coding runtimes verified on this machine yet. The bot will still
  chat via Hermes; add a coding path later from Config once a runtime is
  installed.` Create stays enabled and submits without a coding path:
  the request carries no `coding_runtime`, `deck_name`, or
  `working_directory` keys and `launchable` is omitted, so nothing
  partial is stored — the bot is created fully unconfigured (all three
  null; see legacy state below), even if deck/directory text was typed
  before the probe resolved.
- **Load error**: `Couldn't check coding runtimes. Retry.` with a Retry
  button that re-fetches. Create stays enabled and submits the same
  fully-unconfigured body (all three coding keys omitted).

### Annotated New Bot reference (desktop modal, 1440x900)

Ready state (one or more runtimes verified):

```
┌ New Bot ──────────────────────────┐
│ Name                              │
│ [Alice                       ]    │
│                                   │
│ Chat runtime: Hermes (fixed)      │  ← read-only line, no picker
│                                   │
│ Coding runtime                    │
│ ( ) codex  ( ) claude             │  ← exactly the availability
│  ^ pre-selected: first entry      │     entries; no free text
│ Deck name                         │
│ [planner                     ]    │
│ Working directory                 │
│ [/Users/you/workspace/codes/ ]    │
│              [Create] [Cancel]    │
└───────────────────────────────────┘
```

Loading state: the coding-runtime slot reads `Checking available
runtimes…` (disabled), and Create is disabled. Empty state: the picker
slot reads the `No coding runtimes verified…` note above, deck and
directory inputs stay editable, but Create omits all three coding keys
(fully unconfigured submit — typed deck/directory text is discarded, not
stored). Load-error state: the picker slot reads `Couldn't check coding
runtimes.` with a `Retry` button; Create stays enabled (same
omit-all-three submit). Validation errors render inline above Create with typed values
preserved.

### Annotated New Bot reference (narrow, 390x800)

Same fields and order in a full-width card; radio options stack
vertically and buttons go full-width:

```
┌ New Bot ────────┐
│ Name            │
│ [Alice         ]│
│ Chat runtime:   │
│ Hermes (fixed)  │
│ Coding runtime  │
│ ( ) codex       │
│ ( ) claude      │
│ Deck name       │
│ [planner       ]│
│ Working dir.    │
│ [/Users/you/   ]│
│ [Create]        │
│ [Cancel]        │
└─────────────────┘
```

## Roster section

Each roster row keeps its existing layout (mark, name, latest-message
preview) and gains one runtime sub-line below the preview, rendered in the
same 12px de-emphasised style as `.bot-preview`:

- Configured bot: two lines —
  `Chat: Hermes` then `Code: codex · planner`.
- Legacy/imported/unconfigured bot (`coding_configured: false`): two lines —
  `Chat: Hermes` then `Code: not set — add it in Config.`
  Nothing is invented: a null `coding_runtime`, `deck_name`, or
  `working_directory` never renders a guessed value.
- Stored but not currently verified (configured bot whose stored
  `coding_runtime` is absent from the latest `GET /api/bots/availability`
  probe): two lines — `Chat: Hermes` then
  `Code: codex · planner (not verified — see Config).`
  The stored values still render (they are configuration, honestly
  labelled), but the trailing note marks that no verified launch path
  matches them right now. The roster consults the availability payload
  only for this verified/unverified marker; it never consults the
  coding-runtime enum directly, and an unverified runtime never appears
  as a fresh selectable option anywhere.

The "Config" wording in the unconfigured and unverified lines is
non-interactive text, not a control: the roster row's own click already
opens the conversation (`openBot(bot.id)` in `app/page.tsx:811`), and
rows are non-focusable `div`s with no `tabIndex` or key handler, so this
spec adds no row click target, no tab stop, and no key handling.
Config is reached through the existing thread-bar Config link
(`app/page.tsx:966`, `Link` to `/bots/[id]/config`), which is visible
once the bot's conversation is open. No inner `<a>` or `<button>` is
rendered inside the row, so no `stopPropagation` is needed and focus
order is unchanged.

### Annotated roster reference (desktop rail, 1440x900)

```
│ Alice                    │  ← .bot-name (26px inline, preserved)
│ shipped the migration    │  ← .bot-preview: latest message
│ Chat: Hermes             │  ← runtime line 1 (12px, 50% ink)
│ Code: codex · planner    │  ← runtime line 2 (12px, 50% ink)
│                          │
│ Imported Bot             │  ← legacy/imported row
│ welcome aboard           │
│ Chat: Hermes             │
│ Code: not set —          │  ← honest unconfigured state;
│   add it in Config.      │     plain text; row click still
│                          │     opens the conversation
│ Stale Bot                │  ← stored-but-unverified row
│ old thread preview       │
│ Chat: Hermes             │
│ Code: codex · planner    │  ← stored path still shown…
│   (not verified —        │  ← …with the unverified marker
│   see Config).           │     (plain text); row click still
│                          │     opens the conversation
```

### Annotated roster reference (narrow, 390x800)

The rail stacks above the thread (`max-height: 38vh`, scrollable). Rows
keep the same order, sizes, and truncation; only the width changes:

```
│ Alice                    │
│ shipped the migration    │
│ Chat: Hermes             │
│ Code: codex · planner    │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ Stale Bot                │
│ old thread preview       │
│ Chat: Hermes             │
│ Code: codex · planner    │
│   (not verified —        │
│   see Config).           │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ (thread below, scrolled) │
```

### Roster responsive and truncation

- Desktop (≥800px): rail is `max-width: 280px`; the two runtime lines
  truncate with ellipsis exactly like `.bot-preview`.
- Narrow (<800px): rail stacks above the thread (`max-height: 38vh`,
  scrollable); runtime lines keep the same order and truncation.
- The runtime lines never wrap to a third line and never push the row
  mark out of alignment.

## Config section

The per-bot page at `/bots/[id]/config` gains one new card, **Coding path**,
placed after Rules and before Template source. Skills, Rules, Template
source, and Launch snapshots are unchanged (see
`docs/design/bot-config-page.md`).

### Coding path card

Read view (configured bot):

```
CODING PATH                                   Saved
Chat: Hermes (fixed)
Code: codex · planner
Working directory: /Users/you/workspace/codes/botmancers
[Edit]
```

Read view (legacy/imported/unconfigured bot):

```
CODING PATH                                   Saved
Chat: Hermes (fixed)
Code: not configured — this bot chats only.
No coding runtime, deck, or working directory has been set, so nothing
is shown as selectable. [Add a coding path]
```

Edit view (same save/dirty/saving/confirmed/error cycle as Skills/Rules):

- Coding runtime picker: exactly the `GET /api/bots/availability` entries.
  The currently stored runtime stays displayed as plain text even if it is
  absent from the probe result (for example uninstalled since), with the
  note `Stored but not currently verified — saving keeps it.` It is never
  offered as a fresh choice to other bots.
- Deck name and working directory: text inputs pre-filled from stored values.
- Clearing all three coding fields back to blank saves an explicitly
  unconfigured path (`validateUpdateRuntimePath` blank-clears to null).
- Save issues `PATCH /api/bots` with
  `{ id, coding_runtime, deck_name, working_directory }` only; chat runtime
  is not editable and is not sent.

### Annotated config reference (desktop, 1440x900)

```
┌──────────────────────────────────┬─────────────────────────────┐
│ SKILLS                    Saved  │ LAUNCH SNAPSHOTS            │
│ … (unchanged)                    │ … (unchanged)               │
├──────────────────────────────────┤                             │
│ RULES                     Saved  │                             │
│ … (unchanged)                    │                             │
├──────────────────────────────────┤                             │
│ CODING PATH               Saved  │                             │
│ Chat: Hermes (fixed)             │                             │
│ Code: codex · planner            │                             │
│ Working directory:               │                             │
│ /Users/you/workspace/            │                             │
│   codes/botmancers               │                             │
│ [Edit]                           │                             │
├──────────────────────────────────┤                             │
│ TEMPLATE SOURCE                  │                             │
│ … (unchanged)                    │                             │
└──────────────────────────────────┴─────────────────────────────┘
```

### Config unavailable/legacy variants

- **Availability empty**: picker slot reads `No coding runtimes verified
  on this machine yet — only already-stored values can be kept.` The stored
  path still renders; Edit still allows deck/directory changes.
- **Availability load error**: `Couldn't check coding runtimes. Retry.`
  with Retry; stored values stay visible and editable.
- **Config page load error / not found / dirty-navigation**: unchanged from
  the existing spec (per-section `Couldn't load this section. Retry.`,
  full-page `Bot not found.`, browser-native unsaved-changes prompt).

### Config responsive

Narrow (390x800): the Coding path card stacks full-width in the same
section order (Skills, Rules, Coding path, Template source, Snapshots);
the working-directory value wraps; buttons go full-width, matching the
existing narrow rules.

## Thread section

Delegation events post into the existing conversation as ordinary bot
messages from `delegateCodingViaDeck` in `lib/agent-deck-run.ts`. The thread
renders them as plain `.msg-body` bot turns — no form, no picker, no
approve/deny control, no separate screen. The existing thread-bar `Stop`
button remains the only delegation control (cooperative stop posts its own
notice and promises no late messages).

### Event-to-copy table

Copy is fixed by the adapter's `observe()` calls and rendered verbatim
(run ids and session ids are opaque values copied through, never parsed or
shortened by the UI):

| Event | Thread line (verbatim prefix) | When it posts |
|---|---|---|
| Handoff | `[Deck handoff] runtime=<client> deck=<deck>` + task text | Before the implementation run starts |
| Bound session | `[Deck run] runId=<runId> sessionId=<sessionId\|unknown>` | Implementation run completes |
| Review | `[Deck review] runId=<runId> result=<first 500 chars>` | Reviewer run completes |
| Resume | `[Deck resume] runId=<runId> sessionId=<resumedId>` | Resumed run completes with the same session id |
| Final result | `[Deck result] runId=<runId> result=<first 500 chars>` | End of the sequence; the bot then reports it in its own words |
| Failure (adapter) | `[Deck failed] runtime=<client> deck=<deck> error=<first 300 chars>` | Any run failure, including a resume session fork; then the error is thrown |
| Failure (loop, bad runtime) | `[Deck failed] runtime=<raw directive text> deck=unknown error=Invalid agent-deck runtime.` | The `DECK <runtime>:` line names no known runtime; the adapter never runs |
| Failure (loop, no deck) | `[Deck failed] runtime=<client> deck=unknown error=<first 300 chars>` | `resolveDeckForCwd` throws for the launch cwd before the adapter runs |

The two loop-level rows are posted by the conversation loop in
`lib/agent.ts`, not by the adapter's `observe()` calls — the `deck=unknown`
value is literal copy the UI renders verbatim. The handoff's `runtime=` and
`deck=` are the effective launch values (directive runtime, cwd-resolved
deck); they may differ from the bot's configured `Code:` line (see
"Configured path vs effective launch"). Ids (`runId`, `sessionId`) render
in full and wrap; they are never truncated or shortened by the UI.

A mid-sequence Stop posts nothing further (silent `null` return) — the
thread simply ends at the last posted event plus the Stop notice.

### Annotated thread reference

```
You: add rate limiting to the login route
                                                ┌─ bot turn, .msg-body
Bot: on it — handing the implementation to    │
     the coding agent.                          │  plain reply text
                                                │
     [Deck handoff] runtime=codex deck=planner  │  handoff event
     Add rate limiting to the login route       │
                                                │
     [Deck run] runId=run-9f2c                 │  bound session event
       sessionId=4948be20-1234-               │  (full id wraps across
       5678-9abc-844702fd9352                 │   lines, never truncated)
     [Deck review] runId=run-71ab               │  review event
       result=Looks good; one edge case…        │
     [Deck resume] runId=run-73cd               │  resume event, same session
       sessionId=4948be20-1234-               │
       5678-9abc-844702fd9352                 │
     [Deck result] runId=run-73cd               │  final result event
       result=Rate limiting added…              │
Bot: Done — rate limiting is in on the login    │  bot reports in own words
     route, reviewed and applied.               │
└───────────────────────────────────────────────┘

Failure variant (replaces everything from [Deck run] on):

     [Deck failed] runtime=codex deck=planner   │  failure event
       error=agent-deck run run-9f2c died       │
Bot: The coding run failed (died) — nothing     │  bot reports failure
     was changed. Want me to retry?             │  in its own words
```

Thread text rules: event lines render in the thread's monospace run style
at the existing message size; long ids and results wrap, never truncate;
no event line is clickable and none reveals hidden content. Group-thread
handoff reveal (`parseHandoff` click-to-reveal) does not apply to Deck
events — there is nothing hidden behind them.

## Field-to-API map

Every displayed value traces to exactly one contract below. No displayed
value is invented; in particular, enum membership (`codex|claude|cursor|muse`)
never implies launchability — only the capability probe does.

| Displayed value / state | API source | Contract |
|---|---|---|
| `Chat: Hermes` (everywhere) | `GET /api/bots` and `GET /api/bots/[id]/config` → `persistent_runtime` | `normalizePersistentRuntime` in `lib/bot-definition.ts`: null/blank reads back as `hermes`; only `hermes` is valid (NOT-433) |
| `Code: <runtime> · <deck>` | Same responses → `coding_runtime`, `deck_name`, gated by `coding_configured` | `resolveCodingPath` in `lib/bot-definition.ts`: configured only when runtime, deck, and working directory are all non-null; legacy/imported rows report `false` with nulls intact (proven by `test-bot-definition.js`) |
| Working directory (config only) | Same responses → `working_directory` | Same contract; blank clears to null on update (`validateUpdateRuntimePath`) |
| Picker options (modal + config) | `GET /api/bots/availability` → `{ runtimes: [{ runtime, launchable }] }` | `buildAvailabilityPayload` in `lib/bot-definition.ts` over `listAvailableDeckRuntimes` in `lib/agent-deck-run.ts`: only runtimes whose binary plus the agent-deck CLI probe ready (NOT-395). Empty array renders the unavailable state, never a fake option |
| New Bot validation copy | `POST /api/bots` 400 `error` strings | `validateCreateRuntimePath` / `validateLaunchableCodingPath` in `lib/bot-definition.ts` (NOT-433) |
| Config save | `PATCH /api/bots` with `{ id, coding_runtime, deck_name, working_directory }` | `validateUpdateRuntimePath` in `lib/bot-definition.ts`: unknown runtimes rejected; blanks clear to unconfigured |
| Handoff/session/review/resume/result/failure lines (adapter) | Conversation messages written by the adapter | `delegateCodingViaDeck` `observe()` strings in `lib/agent-deck-run.ts` (NOT-395): `[Deck handoff]`, `[Deck run]`, `[Deck review]`, `[Deck resume]`, `[Deck result]`, `[Deck failed]` — carrying the effective launch values, which may differ from the bot's configured `Code:` line |
| Failure lines (loop, `deck=unknown`) | Conversation messages written by the loop before the adapter runs | `lib/agent.ts` DECK directive path: unknown-runtime rejection and `resolveDeckForCwd` throw, both posting `[Deck failed] … deck=unknown …` verbatim |
| Roster unverified marker | Stored `coding_runtime` checked against `GET /api/bots/availability` | `buildAvailabilityPayload` in `lib/bot-definition.ts` over `listAvailableDeckRuntimes` (NOT-395): a stored runtime absent from the probe renders the `(not verified — see Config)` marker; never a fresh selectable option |
| Effective launch record | Launch snapshot for the turn | `recordDeckLaunchInSnapshot` in `lib/agent.ts`: held snapshot overwritten with the resolved `{ coding_runtime, deck_name, working_directory }`; the snapshot records what ran, not the stored configuration |
| Review prompt default | Reviewer run prompt construction | `DECK_REVIEW_FOCUS_DEFAULT` in `lib/agent-deck-run.ts` (`Correctness, edge cases, and fit to the stated goal.`) |
| Verified-path hint (model-facing) | System prompt how-to, not displayed in UI | `formatDeckHowTo` in `lib/agent-deck-run.ts`: `none verified yet` before/without a probe; unverified names never listed |

Out of scope for this map (unchanged, listed only to prevent drift):
skills/rules/template/snapshots (`docs/design/bot-config-page.md`), import
provenance (`GET /api/import-capabilities`), group threads, avatar editing.

## Responsive behavior

- ≥800px: rail (`max-width: 280px`) beside the thread; config page uses the
  existing 5-column grid with the Coding path card in the left 3-column
  stack; thread events wrap within `.msg-body`.
- <800px: rail stacks above the thread (`max-height: 38vh`); config cards
  stack in fixed order (Skills, Rules, Coding path, Template source,
  Snapshots); modal cards go full-width; buttons full-width.
- No layout shifts on load: availability loading shows the disabled
  `Checking available runtimes…` slot; config loading keeps the existing
  skeleton cards with the Coding path skeleton in its fixed position.

## Builder handoff

### Preserve (do not restyle or restructure)

- Dark roster-and-thread visual language: CSS tokens (`--field`, `--card`,
  `--hairline`, `--ink`, `--accent`) and classes `.field`, `.rail`,
  `.bot-row`, `.bot-name`, `.bot-preview`, `.card`, `.thread`, `.msg-you`,
  `.msg-bot`, `.msg-body`, `.composer`, `.modal-scrim`, `.new-forms`,
  `.form-card`, `.kind-row`, `.kind-word`, `.form-actions`, `.create-btn`,
  `.cancel-btn` in `app/globals.css`.
- Config page language: `.cfg-page`, `.cfg-card`, `.cfg-title`,
  `.cfg-input`, `.cfg-btn-primary`, `.cfg-btn-ghost`, `.cfg-muted`,
  `.cfg-faint`, `.cfg-error`, dirty/saving/confirmed/error cycle, and the
  Skills/Rules/Template/Snapshots sections in
  `app/bots/[id]/config/page.tsx`.
- Thread behavior: plain-text rendering of bot turns, existing `Stop`
  buttons, handoff click-to-reveal for group WAKE handoffs only.

### Expected to change (build ticket)

1. `app/page.tsx` — `BotModal`: add the fixed chat-runtime line, the
   availability-fed coding-runtime picker, deck-name and working-directory
   inputs, inline validation copy, the four availability states, and the
   desktop + 390x800 annotated references above.
2. `app/page.tsx` — roster rows: add the two-line `Chat:`/`Code:` sub-line
   (configured, unconfigured, stored-but-unverified, and truncation rules
   above). The roster reads the availability payload only for the
   verified/unverified marker. The "Config" wording in those lines is
   non-interactive text — do not touch row navigation (`openBot`,
   `app/page.tsx:811`), add no nested link, no `stopPropagation`, no
   `tabIndex`, and no key handler. Config stays reachable through the
   existing thread-bar Config link (`app/page.tsx:966`).
3. `app/page.tsx` — thread (if needed): monospace styling hook for lines
   starting with `[Deck `; no new controls. Thread events render the
   effective launch values verbatim (directive runtime, cwd-resolved
   deck); the builder does not reconcile them with the roster's
   configured line.
4. `app/bots/[id]/config/page.tsx` — new Coding path card (read/edit,
   stored-but-unverified note, blank-clears-to-unconfigured, unavailable
   and load-error variants) between Rules and Template source.
5. `app/globals.css` — additive classes only (runtime sub-lines, Deck event
   lines, unavailable notes) reusing existing tokens. No token changes, no
   layout restructuring.

No API, database, adapter, conversation-loop, or validation-logic change
is expected: the build ticket renders values and states the contracts
above already provide, and documents (rather than closes) the
configured-path vs effective-launch difference.

## Out of scope

Explicitly not in this design; a builder must not add them:

- Any React, CSS, API, or database change (this ticket is spec-only).
- Redesigning the application or replacing the visual language.
- Showing an unverified runtime as selectable anywhere.
- Workflow builders, mode pickers, or a separate orchestration screen.
- Editing chat runtime (always Hermes), per-bot model selection, cloud
  settings, session history boards, or group management on these surfaces.
