// NOT-509: provider-reported token usage and cost. Pure: normalizes the
// structured shapes runtimes already emit into one sample, and aggregates
// samples into a per-metric summary with explicit coverage. Nothing here
// estimates: no pricing table, no model guess, no subscription share, and
// an absent value is never zero (only a provider's explicit 0 is).
//
// Accepted shapes (the ones Agent Dealer's coordinator/usage.ts proves):
// - Codex `turn.completed` events: `usage` with input/output tokens and
//   normally no cost.
// - Claude / Cursor `result` events: `usage` (snake_case or camelCase)
//   plus `total_cost_usd` (or `totalCostUsd`) when the provider reports it.
// - Muse-compatible normalized usage: `{ input_tokens, output_tokens,
//   cost_usd }` directly or under `usage`, as a SessionProvider turn
//   result reports it (lib/session-provider ProviderTurnResult.usage).
// Malformed or unsupported data fails soft: the parser returns null and
// the caller records the turn with nothing known.

export type UsageSource = 'codex.turn_completed' | 'result' | 'normalized' | 'none';

export interface NormalizedUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  source: UsageSource;
  // Extra provider token counters (cache reads/writes, reasoning), numeric
  // and whitelisted only: never text, ids, or model names. Persisted, not
  // returned by any API.
  breakdown: Record<string, number> | null;
}

export type UsageQuality = 'complete' | 'partial' | 'unavailable';

export interface UsageMetricSummary {
  // Sum of the reported values; null when no sample reported this metric.
  sum: number | null;
  // Samples that reported this metric / samples that apply.
  known: number;
  total: number;
  quality: UsageQuality;
}

export interface UsageSummary {
  input_tokens: UsageMetricSummary;
  output_tokens: UsageMetricSummary;
  cost_usd: UsageMetricSummary;
}

export const USAGE_METRICS = ['input_tokens', 'output_tokens', 'cost_usd'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

const BREAKDOWN_KEYS: Record<string, string> = {
  cached_input_tokens: 'cached_input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  cache_read_input_tokens: 'cache_read_input_tokens',
  cacheReadInputTokens: 'cache_read_input_tokens',
  cacheReadTokens: 'cache_read_input_tokens',
  cache_creation_input_tokens: 'cache_creation_input_tokens',
  cacheCreationInputTokens: 'cache_creation_input_tokens',
  cacheWriteTokens: 'cache_creation_input_tokens',
  reasoning_output_tokens: 'reasoning_output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
  reasoningTokens: 'reasoning_output_tokens',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// A token count: a finite, non-negative integer. Anything else is unknown.
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

// A reported cost in USD: finite and non-negative. 0 stays 0.
export function costUsd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e9 ? value : null;
}

function firstOf(source: Record<string, unknown>, keys: string[], read: (value: unknown) => number | null): number | null {
  for (const key of keys) {
    if (key in source) {
      const value = read(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function breakdownOf(usage: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [key, name] of Object.entries(BREAKDOWN_KEYS)) {
    const value = tokenCount(usage[key]);
    if (value !== null && out[name] === undefined) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sample(usage: Record<string, unknown> | null, cost: number | null, source: UsageSource): NormalizedUsage | null {
  const input = usage ? firstOf(usage, ['input_tokens', 'inputTokens'], tokenCount) : null;
  const output = usage ? firstOf(usage, ['output_tokens', 'outputTokens'], tokenCount) : null;
  if (input === null && output === null && cost === null) return null;
  return { input_tokens: input, output_tokens: output, cost_usd: cost, source, breakdown: usage ? breakdownOf(usage) : null };
}

// One structured event (or turn result) to a sample, or null when it
// carries no usage this module recognizes.
export function usageFromEvent(event: unknown): NormalizedUsage | null {
  const value = record(event);
  if (!value) return null;
  const type = typeof value.type === 'string' ? value.type : null;
  const usage = record(value.usage);
  if (type === 'turn.completed') return sample(usage, null, 'codex.turn_completed');
  if (type === 'result') {
    return sample(usage, firstOf(value, ['total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd'], costUsd), 'result');
  }
  // Normalized usage: a bare usage object, an event wrapping one, or a
  // turn result with a `usage` field.
  if (type === null || type === 'usage') {
    const inner = usage ?? value;
    const cost = firstOf(inner, ['cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd'], costUsd)
      ?? (usage ? firstOf(value, ['cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd'], costUsd) : null);
    return sample(inner, cost, 'normalized');
  }
  return null;
}

function addOrNull(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b;
}

// The usage of one attempt from its structured event stream. A `result`
// event is terminal and cumulative for the run, so the last one wins and
// any Codex turn events are ignored; otherwise each Codex `turn.completed`
// is one turn and they add up. A replayed event with the same `seq` (or
// `id`) counts once. Null when the stream reports nothing (a missing or
// unparseable log included).
export function usageFromEvents(events: Iterable<unknown> | null | undefined): NormalizedUsage | null {
  if (!events) return null;
  let result: NormalizedUsage | null = null;
  let turns: NormalizedUsage | null = null;
  let normalized: NormalizedUsage | null = null;
  const seen = new Set<string>();
  for (const event of events) {
    const value = record(event);
    const identity = value && (typeof value.seq === 'number' || typeof value.id === 'string') ? `${value.type}:${value.seq ?? value.id}` : null;
    if (identity) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    const found = usageFromEvent(event);
    if (!found) continue;
    if (found.source === 'result') result = found;
    else if (found.source === 'codex.turn_completed') {
      turns = turns === null ? found : {
        input_tokens: addOrNull(turns.input_tokens, found.input_tokens),
        output_tokens: addOrNull(turns.output_tokens, found.output_tokens),
        cost_usd: null,
        source: 'codex.turn_completed',
        breakdown: mergeBreakdown(turns.breakdown, found.breakdown),
      };
    } else normalized = found;
  }
  return result ?? turns ?? normalized;
}

function mergeBreakdown(a: Record<string, number> | null, b: Record<string, number> | null): Record<string, number> | null {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
}

// JSONL text (one JSON event per line), as a runtime log stores it.
// Unparseable lines are skipped; null or empty text is no usage.
export function usageFromJsonl(text: string | null | undefined): NormalizedUsage | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* malformed line: fail soft */ }
  }
  return usageFromEvents(events);
}

// Defensive copy of a sample a caller built (an adapter result or a
// provider turn result): bad values become unknown, never zero.
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  const value = record(raw);
  if (!value) return null;
  const source: UsageSource = value.source === 'codex.turn_completed' || value.source === 'result' || value.source === 'normalized'
    ? value.source : 'normalized';
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  const cost = costUsd(value.cost_usd);
  if (input === null && output === null && cost === null) return null;
  const breakdown = record(value.breakdown);
  const safe: Record<string, number> = {};
  if (breakdown) {
    for (const name of new Set(Object.values(BREAKDOWN_KEYS))) {
      const count = tokenCount(breakdown[name]);
      if (count !== null) safe[name] = count;
    }
  }
  return { input_tokens: input, output_tokens: output, cost_usd: cost, source, breakdown: Object.keys(safe).length > 0 ? safe : null };
}

type MetricValues = Pick<NormalizedUsage, UsageMetric>;

// Rounds away float noise from summing many costs (micro-dollar precision).
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function qualityOf(known: number, total: number): UsageQuality {
  if (total === 0 || known === 0) return 'unavailable';
  return known === total ? 'complete' : 'partial';
}

// Each metric independently: a sample that reported input tokens but no
// cost is known for input and unknown for cost. Every sample applies to
// every metric, so a session with one Codex turn (no cost) and one Claude
// turn (cost) has partial cost coverage.
export function aggregateUsage(samples: readonly MetricValues[]): UsageSummary {
  const metric = (name: UsageMetric): UsageMetricSummary => {
    let sum: number | null = null;
    let known = 0;
    for (const item of samples) {
      const value = item[name];
      if (value === null || value === undefined) continue;
      known++;
      sum = (sum ?? 0) + value;
    }
    if (sum !== null && name === 'cost_usd') sum = roundCost(sum);
    return { sum, known, total: samples.length, quality: qualityOf(known, samples.length) };
  };
  return { input_tokens: metric('input_tokens'), output_tokens: metric('output_tokens'), cost_usd: metric('cost_usd') };
}
