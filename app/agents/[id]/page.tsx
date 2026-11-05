'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAgentOverview } from './AgentShell';
import { agentLabel } from '@/lib/bot-definition';
import { HarnessIcon } from '@/app/components/HarnessIcon';
import { ActivityList } from './activity/AgentActivityPage';

const BRIDGE_CLIENTS = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
] as const;

type BridgeClientId = (typeof BRIDGE_CLIENTS)[number]['id'];

function setupCommand(id: BridgeClientId) {
  return `botmancers setup --client ${id}`;
}

function BridgeSetupClients() {
  const [active, setActive] = useState<BridgeClientId>('cursor');
  const [copied, setCopied] = useState<BridgeClientId | null>(null);
  const command = setupCommand(active);

  async function copyFor(id: BridgeClientId) {
    setActive(id);
    try {
      await navigator.clipboard.writeText(setupCommand(id));
      setCopied(id);
      window.setTimeout(() => setCopied(current => (current === id ? null : current)), 1600);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="agent-setup-clients">
      <div className="agent-setup-client-row" role="group" aria-label="Copy setup command for a coding client">
        {BRIDGE_CLIENTS.map(client => {
          const isActive = active === client.id;
          const justCopied = copied === client.id;
          return (
            <button
              key={client.id}
              type="button"
              className={`agent-setup-client${isActive ? ' is-active' : ''}${justCopied ? ' is-copied' : ''}`}
              aria-pressed={isActive}
              aria-label={justCopied ? `Copied setup command for ${client.label}` : `Copy setup command for ${client.label}`}
              onClick={() => void copyFor(client.id)}
            >
              <HarnessIcon agent={client.id} size={14} className="agent-setup-client-mark" />
              <span>{justCopied ? 'Copied' : client.label}</span>
            </button>
          );
        })}
      </div>
      <pre className="agent-setup-command"><code>{command}</code></pre>
    </div>
  );
}

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

  const configHref = `/agents/${encodeURIComponent(id)}/config`;
  const messageHref = overview.conversation
    ? `/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(overview.conversation.id)}`
    : `/agents/${encodeURIComponent(id)}/conversations`;
  const messagingStatus = overview.messaging.home_session_ref
    ? 'Home session configured'
    : overview.messaging.new_sessions_allowed && overview.messaging.default_workspace_set
      ? 'Can start a configured session'
      : overview.current_work.length > 0
        ? 'Uses an eligible existing session'
        : 'No ready session is known';
  return (
    <div className="agent-overview" data-agent-overview>
      <div className="agent-overview-grid">
        <section className="agent-panel agent-instructions">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Standing instructions</p><h2>How this Agent works</h2></div><Link href={configHref}>Config</Link></div>
          <dl>
            <div><dt>Rules</dt><dd>{overview.instructions.rules}</dd></div>
            <div><dt>Skill</dt><dd>{overview.instructions.skill}</dd></div>
          </dl>
        </section>

        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Runtime</p><h2>{overview.runtime.available ? 'Ready to work' : 'Setup required'}</h2></div><Link href={configHref}>Config</Link></div>
          <p>{overview.runtime.available
            ? `${agentLabel(overview.runtime.agent)} is connected through ${overview.runtime.connection || 'the configured runtime'}.`
            : 'This Agent cannot launch with its current registration. Open Config to resolve the connection or session scope.'}</p>
          <dl className="agent-runtime-facts">
            <div><dt>Heartbeat</dt><dd>{overview.runtime.last_seen ? new Date(overview.runtime.last_seen).toLocaleString() : 'Not reported'}</dd></div>
            <div><dt>Messaging</dt><dd>{messagingStatus}</dd></div>
          </dl>
          <p className="agent-muted">Messages use the Agent’s configured home session or launch policy. Callers do not choose its runtime, model, or provider session.</p>
        </section>
      </div>

      <section className="agent-use" aria-labelledby="open-this-agent">
        <p className="agent-eyebrow">Open this Agent</p>
        <h2 id="open-this-agent">Make it reachable</h2>
        <div className="agent-use-grid">
          <article>
            <span className="agent-use-number">01</span>
            <h3>Use from a coding agent</h3>
            <p>Let another coding agent discover {overview.agent.name} and ask its sessions — so work learned here can travel between agents.</p>
            <p className="agent-muted">One command connects the client to the bridge and installs the collaboration skill. Click your client to copy it:</p>
            <BridgeSetupClients />
          </article>
          <article>
            <span className="agent-use-number">02</span>
            <h3>Share a session to Slack</h3>
            <p>Open one of this Agent’s sessions to people in Slack — a time-limited, read-only share so others can ask what the session already knows.</p>
            <Link href={`/agents/${encodeURIComponent(id)}/slack`}>Share through Slack</Link>
          </article>
          <article>
            <span className="agent-use-number">03</span>
            <h3>Message in Botmancers</h3>
            <p>Talk directly with {overview.agent.name} in a focused conversation when you are the one asking.</p>
            <Link href={messageHref}>Open conversation</Link>
          </article>
        </div>
      </section>

      <div className="agent-overview-grid agent-work-grid">
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Current work</p><h2>Active sessions</h2></div><Link href={`/agents/${encodeURIComponent(id)}/sessions`}>All sessions</Link></div>
          <WorkList rows={overview.current_work} empty="No active work right now." />
        </section>
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Recent activity</p><h2>Latest work</h2></div><Link href={`/agents/${encodeURIComponent(id)}/activity`}>View activity</Link></div>
          {overview.recent_activity.length ? <ActivityList items={overview.recent_activity} compact /> : <p className="agent-empty">No operational activity yet.</p>}
        </section>
      </div>
    </div>
  );
}
