// NOT-504: structured Codex events -> the common usage sample
// (ProviderTurnUsage, ./session-provider). Adapted from Agent Dealer's
// codex-jsonl normalizer (packages/server/src/runners/codex-jsonl.ts):
// the same `turn.completed` usage shape and the same tolerance for
// malformed lines, without a package dependency.
//
// Two producers, one sample:
// - `codex exec --json` JSONL: `turn.completed` carries snake_case
//   `usage` { input_tokens, cached_input_tokens, output_tokens,
//   reasoning_output_tokens }.
// - app-server `thread/tokenUsage/updated` notifications carry camelCase
//   breakdowns { inputTokens, cachedInputTokens, outputTokens,
//   reasoningOutputTokens, ... }; `last` is one model request, so a turn's
//   usage is the sum of its `last` breakdowns.
//
// Codex reports cached and reasoning tokens as subsets of input and output,
// so they are never added on top. Cost is never derived: Codex does not
// report it, so cost_usd stays null.
import type { ProviderTurnUsage } from './session-provider';

export type CodexEvent = Record<string, unknown>;

// One event per non-empty JSON line; malformed lines are skipped.
export function parseCodexJsonl(raw: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value as CodexEvent);
    } catch {
      // A partial or non-JSON line is not an event.
    }
  }
  return events;
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

function sample(input: number | null, cached: number | null, output: number | null): ProviderTurnUsage | null {
  if (input === null && output === null) return null;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cost_usd: null };
}

// The usage of the last `turn.completed` event, or null when there is none,
// it has no usage, or the usage holds no token counts.
export function usageFromExecEvents(events: CodexEvent[]): ProviderTurnUsage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'turn.completed') continue;
    const usage = event.usage;
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;
    return sample(count(u.input_tokens), count(u.cached_input_tokens), count(u.output_tokens));
  }
  return null;
}

// One app-server TokenUsageBreakdown, or null when malformed.
export function usageFromBreakdown(breakdown: unknown): ProviderTurnUsage | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const b = breakdown as Record<string, unknown>;
  return sample(count(b.inputTokens), count(b.cachedInputTokens), count(b.outputTokens));
}

export function addUsage(a: ProviderTurnUsage | null, b: ProviderTurnUsage | null): ProviderTurnUsage | null {
  if (!a) return b;
  if (!b) return a;
  const plus = (x: number | null | undefined, y: number | null | undefined) => (x == null && y == null ? null : (x ?? 0) + (y ?? 0));
  return {
    input_tokens: plus(a.input_tokens, b.input_tokens),
    output_tokens: plus(a.output_tokens, b.output_tokens),
    cached_input_tokens: plus(a.cached_input_tokens, b.cached_input_tokens),
    cost_usd: null,
  };
}

// The exec run's terminal facts from its JSONL events.
export interface ExecRunFacts {
  thread_id: string | null;
  terminal: 'completed' | 'failed' | null;
  output: string | null;
  error: string | null;
  usage: ProviderTurnUsage | null;
}

export function execRunFacts(events: CodexEvent[]): ExecRunFacts {
  let threadId: string | null = null;
  let output: string | null = null;
  let terminal: ExecRunFacts['terminal'] = null;
  let error: string | null = null;
  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    else if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) output = item.text;
    } else if (event.type === 'turn.completed') terminal = 'completed';
    else if (event.type === 'turn.failed' || event.type === 'error') {
      terminal = 'failed';
      const e = event.error;
      error = typeof e === 'string' ? e
        : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message
          : typeof event.message === 'string' ? event.message : 'codex turn failed';
    }
  }
  return { thread_id: threadId, terminal, output, error, usage: usageFromExecEvents(events) };
}
