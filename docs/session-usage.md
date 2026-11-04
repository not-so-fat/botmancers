# Session usage (NOT-509)

How Botmancers records and shows the token usage and cost that providers
report for a session. Sessions themselves are defined in
[core-engine.md](core-engine.md#session-catalog) and
[provider sessions](core-engine.md#provider-sessions).

Sessions show the token usage and cost their providers **reported**: never
estimated from a pricing table, a model guess, or a subscription plan, and
never 0 unless the provider said 0.

- **Samples.** Engine migration 18 adds `usage_samples`: one row per Attempt
  (`attempt:<id>`) or provider turn (`turn:<id>`) that reached a runtime,
  under a unique `sample_key`, with nullable `input_tokens`, `output_tokens`,
  and `cost_usd`, the provider (the Attempt's adapter or the registry
  row's provider kind), the structured `source` it came from
  (`result`, `codex.turn_completed`, `normalized`, or `none`), the observed
  time, and a `breakdown` of whitelisted numeric counters only (cache reads
  and writes, reasoning tokens). The executor writes the sample with the
  Attempt's terminal record (`recordAttemptResult`), an abandoned Attempt's
  record, and a late result; restart reconciliation writes an all-unknown
  sample for a run that died. A later write for the same key only fills a
  metric that was still unknown: replays, late results, and a reconciled
  Attempt after a restart never add or overwrite. A launch refused before a
  run existed writes no sample. Earlier Attempts have none.
- **Parsing** (`lib/usage.ts`). Codex `turn.completed` usage (tokens, no
  cost), Claude/Cursor `result` usage with `total_cost_usd` (snake_case or
  camelCase), and Muse-compatible normalized usage (`input_tokens`,
  `output_tokens`, `cost_usd`, bare or under `usage`). A `result` event is
  cumulative and wins; Codex turns add up; an event replayed with the same
  `seq` counts once. Malformed values become unknown and unsupported or
  missing data yields no usage; the session result is never blocked. A
  SessionProvider reports `ProviderTurnResult.usage`.
- **Summary.** Each metric is aggregated on its own: `sum` (null when no
  sample reported it), `known` and `total` sample counts, and `quality`
  `complete` (all reported), `partial` (some; the sum is a lower bound), or
  `unavailable` (none, or no samples). A Session Binding's samples are its
  source Attempt's, every Attempt that resumed it, and provider turns on its
  registry row; a native session's are its provider turns.
- **Surfaces.** Catalog summaries, `GET /api/bots/:id/sessions`, the service
  API list and detail, and the MCP v2 `botmancers_list_sessions` item carry
  the additive `usage` summary (optional in the v2 schema, so a client or an
  older server that omits it stays valid). Details add `usage_samples` (one
  per run or turn: kind, attempt number, turn kind, provider, source, the
  three values, observed time). The raw breakdown, sample keys, and
  provider ids are never returned. The Sessions view shows a compact row
  total (`1.2M in · 45.7k out · $3.34`), says "Not reported" or "cost not
  reported" for unknown values, labels partial coverage Partial with how
  many runs reported, and lists per-run usage in Details.
