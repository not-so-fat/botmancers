// NOT-496: pure presentation helpers for the Sessions drawer
// (app/components/SessionsPanel). The shapes mirror lib/session-catalog's
// JSON; this module never sees an external provider session id.

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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatSessionDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export function attemptLabel(attempt: SessionAttemptRow): string {
  const what = attempt.role === 'source' ? 'Started the session' : 'Resumed the session';
  return `${what} · ${attempt.outcome ?? 'running'}`;
}

export function emptySessionsCopy(filter: SessionFilter, agentName: string): string {
  if (filter === 'active') return `${agentName} has no active sessions.`;
  if (filter === 'ended') return `${agentName} has no ended sessions.`;
  return `${agentName} has no sessions yet. One appears after a coding run keeps its runtime context.`;
}
