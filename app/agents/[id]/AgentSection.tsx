'use client';

import Link from 'next/link';
import { useAgentOverview } from './AgentShell';

export type AgentSectionName = 'sessions' | 'conversations' | 'slack' | 'activity';

const COPY: Record<AgentSectionName, { eyebrow: string; title: string; body: string }> = {
  sessions: { eyebrow: 'Sessions', title: 'Work attached to this Agent', body: 'Review active and previous runtime sessions in the existing Agent-scoped session catalog.' },
  conversations: { eyebrow: 'Conversations', title: 'Talk with this Agent', body: 'Conversation history remains in the established Botmancers thread while the dedicated Conversations page is built.' },
  slack: { eyebrow: 'Slack', title: 'Share one session to Slack', body: 'Slack shares are created from a specific session and stay read-only, time-limited, and revocable.' },
  activity: { eyebrow: 'Activity', title: 'Recent Agent work', body: 'This summary uses the Agent’s existing session activity; the full Activity destination will replace it in its follow-on ticket.' },
};

export default function AgentSection({ section }: { section: AgentSectionName }) {
  const { id, overview, loading, error, notFound } = useAgentOverview();
  if (loading) return <div className="agent-state" role="status">Loading…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an Agent</Link></div>;
  if (error || !overview) return <div className="agent-state" role="alert">This Agent section is unavailable.</div>;
  const copy = COPY[section];
  const sessionHref = `/agents/${encodeURIComponent(id)}/sessions`;
  const conversationHref = `/?agent=${encodeURIComponent(id)}`;
  const rows = section === 'activity' ? overview.recent_work : overview.current_work;
  return (
    <div className="agent-section-page">
      <p className="agent-eyebrow">{copy.eyebrow}</p>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      {(section === 'sessions' || section === 'slack') ? <Link className="agent-primary-action" href={sessionHref}>Open Agent sessions</Link> : null}
      {section === 'conversations' ? <Link className="agent-primary-action" href={conversationHref}>Open conversation</Link> : null}
      {section === 'slack' ? <p className="agent-muted">In Sessions, open a session and choose Share to Slack. Slack policy remains editable in <Link href={`/bots/${encodeURIComponent(id)}/config`}>Config</Link>.</p> : null}
      {section === 'activity' ? (
        rows.length ? <ul className="agent-work-list">{rows.map(row => <li key={row.ref}><span><strong>{row.title}</strong><small>{row.status} · {new Date(row.last_activity_at).toLocaleString()}</small></span></li>)}</ul> : <p className="agent-empty">No activity yet.</p>
      ) : null}
    </div>
  );
}
