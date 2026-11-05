'use client';

import Link from 'next/link';
import SessionsPanel from '@/app/components/SessionsPanel';
import { useAgentOverview } from '../AgentShell';

export default function SessionsPage() {
  const { id, agents, overview, loading, error, notFound } = useAgentOverview();
  if (loading) return <div className="agent-state" role="status">Loading sessions…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an Agent</Link></div>;
  if (error || !overview) return <div className="agent-state" role="alert"><h2>Sessions unavailable</h2><p>Botmancers could not load this Agent. Refresh to try again.</p></div>;

  return (
    <SessionsPanel
      agentId={id}
      agentName={overview.agent.name}
      agentProvider={overview.runtime.agent}
      agents={agents.map(agent => ({ id: agent.id, name: agent.name }))}
      origin={overview.conversation ? { conversationId: overview.conversation.id, label: `${overview.agent.name} conversation` } : null}
    />
  );
}
