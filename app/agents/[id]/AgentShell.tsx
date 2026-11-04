'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import BotAvatar from '@/app/components/BotAvatar';
import type { AgentOverviewDto } from '@/lib/agent-overview';
import { agentLabel } from '@/lib/bot-definition';

interface RailAgent {
  id: string;
  name: string;
  title: string;
  hidden?: number;
  pinned?: number;
  avatar?: string | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
  launchable?: boolean | null;
  runtime_connection?: { label: string } | null;
  agent?: string | null;
}

interface AgentContextValue {
  id: string;
  overview: AgentOverviewDto | null;
  loading: boolean;
  error: boolean;
  notFound: boolean;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgentOverview(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgentOverview must be used inside AgentShell');
  return value;
}

const TABS = [
  { label: 'Overview', segment: '' },
  { label: 'Sessions', segment: 'sessions' },
  { label: 'Conversations', segment: 'conversations' },
  { label: 'Slack', segment: 'slack' },
  { label: 'Activity', segment: 'activity' },
] as const;

export default function AgentShell({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = String(params.id ?? '');
  const pathname = usePathname();
  const [agents, setAgents] = useState<RailAgent[]>([]);
  const [overview, setOverview] = useState<AgentOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/bots', { cache: 'no-store' }).then(response => response.ok ? response.json() : []),
      fetch(`/api/bots/${encodeURIComponent(id)}/overview`, { cache: 'no-store' }),
    ]).then(async ([agentRows, response]) => {
      if (cancelled) return;
      setAgents(Array.isArray(agentRows) ? agentRows : []);
      if (response.status === 404) {
        setNotFound(true);
        setOverview(null);
        return;
      }
      if (!response.ok) throw new Error('overview request failed');
      setOverview(await response.json() as AgentOverviewDto);
      setNotFound(false);
      setError(false);
    }).catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [id]);

  const visibleAgents = agents
    .filter(agent => !agent.hidden)
    .sort((a, b) => {
      const rank = (agent: RailAgent) => agent.name.toLowerCase() === 'chief-of-staff' ? 0 : agent.pinned ? 1 : 2;
      return rank(a) - rank(b);
    });
  const selected = overview?.agent;
  const runtime = overview?.runtime;

  return (
    <AgentContext.Provider value={{ id, overview, loading, error, notFound }}>
      <div className="field agent-field">
        <aside className="rail agent-rail">
          <Link href="/" className="brand agent-brand" aria-label="Botmancers home">
            <span className="logo-shape"><Image src="/brand/botmancers-logo-filled-256.png" alt="" width={40} height={40} /></span>
            <span className="logo-word">botmancers</span>
          </Link>
          <div className="bar">
            <Link className="add-btn" href="/?new=1">New</Link>
            {visibleAgents.length ? <Link className="add-btn" href="/?manage=1">Manage agents</Link> : null}
            <Link className="add-btn settings-link" href="/settings">Settings</Link>
          </div>
          <nav className="rail-nav" aria-label="Workspace">
            <Link href="/exchanges" className="add-btn rail-nav-link">Exchanges</Link>
          </nav>
          <div className="roster" aria-label="Agents">
            {visibleAgents.map(agent => (
              <div className={agent.id === id ? 'bot-row is-open' : 'bot-row'} key={agent.id}>
                <span className="mark-avatar mark-avatar-sm"><BotAvatar bot={agent} size={36} title={`${agent.name} avatar`} /></span>
                <div className="bot-copy">
                  <Link
                    href={`/agents/${encodeURIComponent(agent.id)}`}
                    className="bot-name row-open agent-row-link"
                    data-open-agent={agent.id}
                    aria-current={agent.id === id ? 'page' : undefined}
                  >
                    {agent.name}
                  </Link>
                  <div className="bot-runtime">
                    Agent: {agentLabel(agent.agent)} · {agent.runtime_connection?.label || 'No connection'}
                  </div>
                </div>
                <details className="agent-row-menu">
                  <summary className="row-actions" aria-label={`Actions for ${agent.name}`}>⋯</summary>
                  <div className="agent-row-menu-popover">
                    <Link href={`/?agent=${encodeURIComponent(agent.id)}`}>Message</Link>
                    <Link href={`/bots/${encodeURIComponent(agent.id)}/config`}>Config</Link>
                    <Link href="/?manage=1">Manage agent</Link>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </aside>

        <section className="pane agent-pane">
          <header className="agent-shell-header">
            <div className="agent-shell-identity">
              {selected ? <BotAvatar bot={selected} size={48} title={`${selected.name} avatar`} /> : null}
              <div>
                <p className="agent-shell-kicker">Agent</p>
                <h1>{selected?.name ?? (loading ? 'Loading…' : 'Unknown Agent')}</h1>
                {selected ? <p>{selected.role}</p> : null}
              </div>
            </div>
            {runtime ? (
              <div className="agent-shell-runtime" aria-label="Runtime and availability">
                <span className={runtime.available ? 'availability is-available' : 'availability is-blocked'}>
                  {runtime.available ? 'Available' : 'Needs setup'}
                </span>
                <span>{agentLabel(runtime.agent)} · {runtime.connection || 'No connection'}</span>
              </div>
            ) : null}
          </header>
          <nav className="agent-tabs" aria-label="Agent">
            {TABS.map(tab => {
              const href = `/agents/${encodeURIComponent(id)}${tab.segment ? `/${tab.segment}` : ''}`;
              const selectedTab = pathname === href;
              return <Link key={tab.label} href={href} aria-current={selectedTab ? 'page' : undefined}>{tab.label}</Link>;
            })}
            <Link href={`/bots/${encodeURIComponent(id)}/config`}>Config</Link>
          </nav>
          <main className="agent-content">{children}</main>
        </section>
      </div>
    </AgentContext.Provider>
  );
}
