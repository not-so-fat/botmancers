// NOT-496: pure presentation helpers for the Sessions drawer
// (app/components/SessionsPanel). The shapes mirror lib/session-catalog's
// JSON; this module never sees an external provider session id.

import type { SessionActions, SessionRoute } from './session-actions';

export type SessionFilter = 'active' | 'ended' | 'all';

export const SESSION_FILTER_OPTIONS: { value: SessionFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
];

export interface SessionRow {
  ref: string;
  agent: { id: string; name: string; adapter: string; transport: string | null };
  title: string;
  status: 'active' | 'ended';
  resumable: boolean;
  created_at: number;
  ended_at: number | null;
  last_activity_at: number;
  origin: {
    conversation: { id: string; kind: 'direct' | 'group' | 'agent_api'; label: string; thread_agent_id: string | null } | null;
    work_request: { id: string; execution_kind: string; state: string } | null;
  };
  context: { workspace: string | null; deck: string | null };
  // NOT-509: provider-reported usage (lib/usage UsageSummary). Optional so
  // a row from an older server still renders.
  usage?: SessionUsageRow;
  // NOT-507: the Agent's home session, how a turn reaches it, and what each
  // session action (lib/session-actions) can do now. Optional likewise.
  home?: boolean;
  route?: SessionRoute;
  actions?: SessionActions;
  // NOT-500: the runtime's view of the session, when the catalog reports it.
  state?: { availability: 'available' | 'missing'; lifecycle: 'open' | 'archived'; resumable: boolean | null; busy: boolean };
}

export type UsageQuality = 'complete' | 'partial' | 'unavailable';

export interface UsageMetricRow {
  sum: number | null;
  known: number;
  total: number;
  quality: UsageQuality;
}

export interface SessionUsageRow {
  input_tokens: UsageMetricRow;
  output_tokens: UsageMetricRow;
  cost_usd: UsageMetricRow;
}

export interface SessionUsageSampleRow {
  kind: 'attempt' | 'turn';
  attempt_number: number | null;
  turn_kind: string | null;
  provider: string;
  source: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  observed_at: number;
}

export interface SessionAttemptRow {
  attempt_number: number;
  kind: 'launch' | 'resume';
  role: 'source' | 'resume';
  request_id: string;
  outcome: string | null;
  started_at: number;
  finished_at: number | null;
}

// UTC, the same clock as the catalog's fallback title
// (lib/session-catalog formatSessionTime), so a row never shows two zones.
export function formatSessionDate(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function capitalize(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

export function runtimeLabel(row: SessionRow): string {
  return row.agent.transport ? `${row.agent.adapter} · ${row.agent.transport}` : row.agent.adapter;
}

export function workRequestLabel(row: SessionRow): string | null {
  const request = row.origin.work_request;
  return request ? `${capitalize(request.execution_kind)} · ${request.state}` : null;
}

export function statusLabel(row: SessionRow): string {
  return row.status === 'active' ? 'Active' : 'Ended';
}

// NOT-507: the tags that make a past session recognizable at a glance:
// the Agent's home session, and the runtime's lifecycle and busy state.
export function sessionStateTags(row: Pick<SessionRow, 'home' | 'state' | 'resumable'>): string[] {
  const tags: string[] = [];
  if (row.home) tags.push('Home');
  if (row.state?.availability === 'missing') tags.push('Missing');
  else {
    if (row.state?.lifecycle === 'archived') tags.push('Archived');
    if (row.state?.busy) tags.push('Busy');
  }
  if (row.resumable || row.state?.resumable === true) tags.push('Resumable');
  return tags;
}

export function attemptLabel(attempt: SessionAttemptRow): string {
  const what = attempt.role === 'source' ? 'Started the session' : 'Resumed the session';
  return `${what} · ${attempt.outcome ?? 'running'}`;
}

export function emptySessionsCopy(filter: SessionFilter, agentName: string): string {
  if (filter === 'active') return `${agentName} has no active sessions.`;
  if (filter === 'ended') return `${agentName} has no ended sessions.`;
  return `${agentName} has no sessions yet. One appears after a coding run keeps its runtime context.`;
}

// ---- NOT-509: reported usage ----
//
// Every value shown is what a provider reported. Unknown is "Not reported",
// never 0 or a guess; "$0.00" appears only when a provider reported a zero
// cost. A partial metric is labeled Partial and says how many runs reported
// it, so its sum reads as a lower bound.

const NOT_REPORTED = 'Not reported';

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

// Compact token count for a row: 950, 12.3k, 1.2M, 3.4B.
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${trimDecimal(n / 1000)}k`;
  if (n < 999_950_000) return `${trimDecimal(n / 1_000_000)}M`;
  return `${trimDecimal(n / 1_000_000_000)}B`;
}

// Exact token count for details and accessible labels: 1,203,456.
export function formatTokenCountFull(n: number): string {
  return n.toLocaleString('en-US');
}

// A reported cost. Cents from a cent up; four decimals below a cent so a
// small reported cost never rounds to a misleading $0.00.
export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 0.01) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n < 0.0001) return '<$0.0001';
  return `$${n.toFixed(4)}`;
}

const METRIC_NAMES: Record<keyof SessionUsageRow, string> = {
  input_tokens: 'Input tokens',
  output_tokens: 'Output tokens',
  cost_usd: 'Cost',
};

function metricValue(name: keyof SessionUsageRow, value: number, full: boolean): string {
  if (name === 'cost_usd') return formatUsd(value);
  return full ? formatTokenCountFull(value) : formatTokenCount(value);
}

function runs(n: number): string {
  return `${n} ${n === 1 ? 'run' : 'runs'}`;
}

export interface UsageMetricView {
  name: string;
  // Short visible text: the value, or "Not reported".
  text: string;
  quality: UsageQuality;
  // Coverage line: "2 of 3 runs reported" / "Not reported by any run".
  coverage: string;
  // Full accessible label.
  label: string;
}

export function usageMetricView(name: keyof SessionUsageRow, metric: UsageMetricRow | undefined, full = false): UsageMetricView {
  const title = METRIC_NAMES[name];
  if (!metric || metric.quality === 'unavailable' || metric.sum === null) {
    const coverage = metric && metric.total > 0 ? `0 of ${runs(metric.total)} reported` : 'No runs recorded';
    return { name: title, text: NOT_REPORTED, quality: 'unavailable', coverage, label: `${title}: not reported` };
  }
  const value = metricValue(name, metric.sum, full);
  const exact = metricValue(name, metric.sum, true);
  if (metric.quality === 'partial') {
    const coverage = `Partial: ${metric.known} of ${runs(metric.total)} reported`;
    return { name: title, text: value, quality: 'partial', coverage, label: `${title}: at least ${exact}, partial, reported by ${metric.known} of ${runs(metric.total)}` };
  }
  const coverage = `All ${runs(metric.total)} reported`;
  return { name: title, text: value, quality: 'complete', coverage, label: `${title}: ${exact}, reported by all ${runs(metric.total)}` };
}

export interface SessionUsageLine {
  // Compact visible text for the row.
  text: string;
  // Full accessible label.
  label: string;
  // unavailable: nothing reported; partial: some metric partial or some
  // metric unreported while others are; complete otherwise.
  quality: UsageQuality;
  // Whether to show the Partial tag.
  partial: boolean;
}

// The compact row total: "12.3k in · 2.3k out · $0.42". A metric nobody
// reported says so in place ("cost not reported").
export function sessionUsageLine(usage: SessionUsageRow | undefined): SessionUsageLine {
  const input = usageMetricView('input_tokens', usage?.input_tokens);
  const output = usageMetricView('output_tokens', usage?.output_tokens);
  const cost = usageMetricView('cost_usd', usage?.cost_usd);
  const views = [input, output, cost];
  if (views.every(view => view.quality === 'unavailable')) {
    return { text: NOT_REPORTED, label: 'Usage: not reported', quality: 'unavailable', partial: false };
  }
  const text = [
    input.quality === 'unavailable' ? 'input not reported' : `${input.text} in`,
    output.quality === 'unavailable' ? 'output not reported' : `${output.text} out`,
    cost.quality === 'unavailable' ? 'cost not reported' : cost.text,
  ].join(' · ');
  const partial = views.some(view => view.quality === 'partial');
  const quality: UsageQuality = partial || views.some(view => view.quality === 'unavailable') ? 'partial' : 'complete';
  return { text, label: `Reported usage: ${views.map(view => view.label).join('; ')}`, quality, partial };
}

// One run or turn in the details list, numbered within the session
// (index is its position, oldest first).
export function usageSampleLabel(sample: SessionUsageSampleRow, index: number): string {
  const what = sample.kind === 'turn'
    ? (sample.turn_kind === 'start' ? 'provider turn, started' : 'provider turn')
    : (sample.turn_kind === 'resume' ? 'resumed' : 'started');
  return `Run ${index + 1} · ${what}`;
}

export function usageSampleValues(sample: SessionUsageSampleRow): { input: string; output: string; cost: string } {
  return {
    input: sample.input_tokens === null ? NOT_REPORTED : formatTokenCountFull(sample.input_tokens),
    output: sample.output_tokens === null ? NOT_REPORTED : formatTokenCountFull(sample.output_tokens),
    cost: sample.cost_usd === null ? NOT_REPORTED : formatUsd(sample.cost_usd),
  };
}
