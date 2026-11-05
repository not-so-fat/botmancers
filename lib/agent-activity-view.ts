// Client-safe public shape for the Agent Activity projection.
export type AgentActivityCategory = 'sessions' | 'conversations' | 'slack';
export type AgentActivityFilter = 'all' | AgentActivityCategory | 'errors';
export type AgentActivitySeverity = 'info' | 'success' | 'warning' | 'error';

export interface AgentActivityItem {
  id: string;
  kind: string;
  category: AgentActivityCategory;
  occurred_at: number;
  summary: string;
  target: { href: string; label: string };
  severity: AgentActivitySeverity;
  attention: boolean;
  details: Record<string, string | number | boolean>;
}

export const AGENT_ACTIVITY_FILTERS: Array<{ value: AgentActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'conversations', label: 'Conversations & exchanges' },
  { value: 'slack', label: 'Slack' },
  { value: 'errors', label: 'Errors' },
];
