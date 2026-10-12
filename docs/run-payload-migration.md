# [run] payload migration: `html` -> `page` (NOT-419)

## Decision

Writers emit one field: `page`. The snapshot's computer page payload is the
agreed field going forward; `lib/run.ts` `serializeRun` writes `page` only.

## Compatibility

Readers accept both. `lib/run.ts` `parseRun` reads `page` first and falls
back to the legacy `html` field, normalising either to `page` (mirrored to
the deprecated `html` property so old readers keep working). An old `[run]`
message with `html` still renders the computer preview with no changes.

## Stored messages

No backfill is required and none is planned: every stored `[run]` message
keeps rendering through the dual reader. Messages are migrated lazily —
any message rewritten through `serializeRun` (a run completing, a stop) is
written with `page`. Old call sites that still pass `html` to `serializeRun`
are written as `page` via the same fallback.

To verify a database has no remaining `html` writers, grep the codebase for
`html:` passed to `serializeRun`; to find stored legacy rows, search message
content for `[run]` payloads containing `"html"`.

## Assets

Computer chrome moved to `/computer/` (`dock-chrome.png`, `dock-gray.png`,
`dock-terminal.png`, `wallpaper.png`, byte-identical to the legacy files).
The legacy root-level files (`/dock-*_hash.png`, `/wallpaper_*.png`) are kept
in `public/` so anything referencing them keeps rendering.
