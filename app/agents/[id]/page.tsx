'use client';

import Link from 'next/link';
import { useAgentOverview } from './AgentShell';

const CAPABILITY_LABELS: Record<string, string> = {
  'agents:read': 'Discoverable to connected coding agents',
  'sessions:read': 'Session history',
  'conversations:read': 'Conversation history',
  'sessions:message': 'Session messaging',
  'shares:create': 'Slack session sharing',
};

function WorkList({ rows, empty }: { rows: Array<{ ref: string; title: string; status: string; last_activity_at: number }>; empty: string }) {
  if (!rows.length) return <p className="agent-empty">{empty}</p>;
  return (
    <ul className="agent-work-list">
      {rows.map(row => (
        <li key={row.ref}>
          <span><strong>{row.title}</strong><small>{row.status === 'active' ? 'Active now' : 'Recent'} · {new Date(row.last_activity_at).toLocaleString()}</small></span>
        </li>
      ))}
    </ul>
  );
}

export default function AgentOverviewPage() {
  const { id, overview, loading, error, notFound } = useAgentOverview();
  if (loading) return <div className="agent-state" role="status">Loading Agent overview…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><p>This Agent does not exist or was removed.</p><Link href="/">Choose an Agent</Link></div>;
  if (error || !overview) return <div className="agent-state" role="alert"><h2>Overview unavailable</h2><p>Botmancers could not load this Agent. Refresh to try again.</p></div>;

  const configHref = `/bots/${encodeURIComponent(id)}/config`;
  const messageHref = `/?agent=${encodeURIComponent(id)}`;
  const messagingStatus = overview.messaging.home_session_ref
    ? 'Home session configured'
    : overview.messaging.new_sessions_allowed && overview.messaging.default_workspace_set
      ? 'Can start a configured session'
      : overview.current_work.length > 0
        ? 'Uses an eligible existing session'
        : 'No ready session is known';
  return (
    <div className="agent-overview" data-agent-overview>
      <section className="agent-hero">
        <p className="agent-eyebrow">Overview</p>
        <h2>{overview.agent.role}</h2>
        <p>{overview.instructions.rules}</p>
        <ul className="agent-capabilities" aria-label="Capabilities">
          {overview.capabilities.map(capability => <li key={capability}>{CAPABILITY_LABELS[capability] || capability}</li>)}
        </ul>
      </section>

      <div className="agent-overview-grid">
        <section className="agent-panel agent-instructions">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Standing instructions</p><h2>How this Agent works</h2></div><Link href={configHref}>Full Config</Link></div>
          <dl>
            <div><dt>Rules</dt><dd>{overview.instructions.rules}</dd></div>
            <div><dt>Skill</dt><dd>{overview.instructions.skill}</dd></div>
          </dl>
        </section>

        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Runtime</p><h2>{overview.runtime.available ? 'Ready to work' : 'Setup required'}</h2></div><Link href={configHref}>Config</Link></div>
          <p>{overview.runtime.available
            ? `${overview.runtime.agent} is connected through ${overview.runtime.connection || 'the configured runtime'}.`
            : 'This Agent cannot launch with its current registration. Open Config to resolve the connection or session scope.'}</p>
          <dl className="agent-runtime-facts">
            <div><dt>Heartbeat</dt><dd>{overview.runtime.last_seen ? new Date(overview.runtime.last_seen).toLocaleString() : 'Not reported'}</dd></div>
            <div><dt>Messaging</dt><dd>{messagingStatus}</dd></div>
          </dl>
          <p className="agent-muted">Messages use the Agent’s configured home session or launch policy. Callers do not choose its runtime, model, or provider session.</p>
        </section>
      </div>

      <section className="agent-use" aria-labelledby="use-this-agent">
        <p className="agent-eyebrow">Start here</p>
        <h2 id="use-this-agent">Use this Agent</h2>
        <div className="agent-use-grid">
          <article><span className="agent-use-number">01</span><h3>Message in Botmancers</h3><p>Open a focused conversation when you want to talk directly with {overview.agent.name}.</p><Link className="agent-primary-action" href={messageHref}>Open conversation</Link></article>
          <article><span className="agent-use-number">02</span><h3>Use from a coding agent</h3><p>Connect your coding agent to <code>POST /api/v0/mcp</code>, then call <code>botmancers_capabilities</code> and <code>botmancers_list_agents</code> before messaging.</p><a href="https://github.com/not-so-fat/botmancers/blob/main/packages/mcp-server/README.md#client-setup-and-the-collaboration-skill" target="_blank" rel="noreferrer">Open bridge setup guidance</a></article>
          <article><span className="agent-use-number">03</span><h3>Share a session to Slack</h3><p>Choose one of this Agent’s sessions and create a time-limited, read-only Slack share.</p><Link href={`/agents/${encodeURIComponent(id)}/slack`}>Share through Slack</Link></article>
        </div>
      </section>

      <div className="agent-overview-grid agent-work-grid">
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Current work</p><h2>Active sessions</h2></div><Link href={`/agents/${encodeURIComponent(id)}/sessions`}>All sessions</Link></div>
          <WorkList rows={overview.current_work} empty="No active work right now." />
        </section>
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Recent activity</p><h2>Latest work</h2></div><Link href={`/agents/${encodeURIComponent(id)}/activity`}>View activity</Link></div>
          {overview.conversation?.last_activity_at ? <p className="agent-conversation-activity">Conversation active {new Date(overview.conversation.last_activity_at).toLocaleString()}</p> : null}
          <WorkList rows={overview.recent_work.slice(0, 3)} empty="No session activity yet." />
        </section>
      </div>
    </div>
  );
}
