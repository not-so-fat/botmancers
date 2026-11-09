// NOT-506: Claude Code `--output-format stream-json` events, read as facts.
//
// Only structured events count: one JSON object per line. The `system`
// `init` event names the session the process is actually running, the first
// `result` event is the turn's outcome, a `rate_limit_event` with status
// `rejected` is a usage cap. Anything that is not a JSON object is counted
// as malformed and otherwise ignored; terminal text is never interpreted.
//
// Usage follows Agent Dealer's coordinator/usage.ts semantics for the same
// stream (the first `result` event's `usage.input_tokens` /
// `usage.output_tokens`, camelCase accepted, and `total_cost_usd`) without a
// dependency on it, and is stricter: a value is kept only when it is a
// finite, non-negative number (tokens: an integer). Explicit zero stays
// zero, anything absent or malformed is null, and no price is ever inferred.
import type { ProviderReportedUsage } from './session-provider';

export type ClaudeEvent = Record<string, unknown>;

export type ClaudeFailureCode =
  | 'session_missing'
  | 'auth_required'
  | 'permission_denied'
  | 'usage_limit'
  | 'incompatible_version'
  | 'session_mismatch'
  | 'process_exited'
  | 'process_exited_no_output'
  | 'cancelled'
  | 'runtime_error';

export interface ClaudeStreamSummary {
  // The session id the init event reported, or null before init.
  session_id: string | null;
  claude_code_version: string | null;
  result: ClaudeEvent | null;
  rate_limit_rejected: boolean;
  malformed: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Splits complete lines only: a trailing partial line (the process is still
// writing it) is left for the next read.
export function parseStreamText(text: string): { events: ClaudeEvent[]; malformed: number } {
  const events: ClaudeEvent[] = [];
  let malformed = 0;
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isObject(parsed) && typeof parsed.type === 'string') events.push(parsed);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function summarizeStream(text: string): ClaudeStreamSummary {
  const { events, malformed } = parseStreamText(text);
  const summary: ClaudeStreamSummary = { session_id: null, claude_code_version: null, result: null, rate_limit_rejected: false, malformed };
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init' && summary.session_id === null) {
      if (typeof event.session_id === 'string') summary.session_id = event.session_id;
      if (typeof event.claude_code_version === 'string') summary.claude_code_version = event.claude_code_version;
    } else if (event.type === 'result' && summary.result === null) {
      summary.result = event;
    } else if (event.type === 'rate_limit_event' && isObject(event.rate_limit_info) && event.rate_limit_info.status === 'rejected') {
      summary.rate_limit_rejected = true;
    }
  }
  return summary;
}

const tokenCount = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const dollars = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

// The usage a result event reported. Every field independently nullable.
export function reportedUsage(result: ClaudeEvent | null): ProviderReportedUsage {
  const usage = result && isObject(result.usage) ? result.usage : {};
  return {
    input_tokens: tokenCount(usage.input_tokens) ?? tokenCount(usage.inputTokens),
    output_tokens: tokenCount(usage.output_tokens) ?? tokenCount(usage.outputTokens),
    total_cost_usd: result ? dollars(result.total_cost_usd) : null,
  };
}

// The runtime's own error strings, from structured fields only.
function errorText(result: ClaudeEvent): string {
  const parts: string[] = [];
  if (Array.isArray(result.errors)) for (const item of result.errors) if (typeof item === 'string') parts.push(item);
  if (result.is_error === true && typeof result.result === 'string') parts.push(result.result);
  return parts.join('\n').slice(0, 2000);
}

const MISSING = /no conversation found/i;
const AUTH = /not logged in|please run \/login|\/login|invalid api key|authentication|unauthori[sz]ed|oauth token|credentials? (?:expired|missing|invalid)/i;
const USAGE_CAP = /usage limit|rate limit|limit reached|quota|credit balance/i;

// Whether a result event is a successful turn.
export function resultSucceeded(result: ClaudeEvent): boolean {
  return result.is_error !== true && result.subtype === 'success';
}

// The stable failure a non-successful result event stands for.
export function classifyFailure(result: ClaudeEvent, summary: Pick<ClaudeStreamSummary, 'rate_limit_rejected'>): { code: ClaudeFailureCode; message: string } {
  const text = errorText(result);
  const status = typeof result.api_error_status === 'number' ? result.api_error_status : null;
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials.length : 0;
  const code: ClaudeFailureCode = MISSING.test(text) ? 'session_missing'
    : status === 401 || status === 403 || AUTH.test(text) ? 'auth_required'
      : status === 429 || summary.rate_limit_rejected || USAGE_CAP.test(text) ? 'usage_limit'
        : denials > 0 ? 'permission_denied'
          : 'runtime_error';
  return { code, message: text || `Claude Code reported ${String(result.subtype ?? 'an error')}.` };
}
