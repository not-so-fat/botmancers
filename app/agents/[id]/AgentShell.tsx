'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import BotAvatar from '@/app/components/BotAvatar';
import AgentRail, { type RailAgent } from '@/app/components/AgentRail';
import type { AgentOverviewDto } from '@/lib/agent-overview';
import { agentLabel } from '@/lib/bot-definition';
import { deletedStatusLine } from '@/lib/bot-deletion';

interface AgentContextValue {
  id: string;
  agents: RailAgent[];
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
  { label: 'Config', segment: 'config' },
] as const;

export default function AgentShell({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = String(params.id ?? '');
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<RailAgent[]>([]);
  const [overview, setOverview] = useState<AgentOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [rosterStatus, setRosterStatus] = useState(() => {
    const deleted = Number(searchParams.get('deleted')) || 0;
    return deleted > 0 ? deletedStatusLine(deleted) : '';
  });
  const [beatClock, setBeatClock] = useState({ serverNow: 0, fetchedAt: 0 });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (cancelled: () => boolean) => {
    try {
      const [agentsResponse, response] = await Promise.all([
        fetch('/api/bots', { cache: 'no-store' }),
        fetch(`/api/bots/${encodeURIComponent(id)}/overview`, { cache: 'no-store' }),
      ]);
      const agentRows = agentsResponse.ok ? await agentsResponse.json() : [];
      if (cancelled()) return;
      setAgents(Array.isArray(agentRows) ? agentRows : []);
      const headerNow = Date.parse(agentsResponse.headers.get('date') || '');
      setBeatClock({ serverNow: Number.isNaN(headerNow) ? Date.now() : headerNow, fetchedAt: Date.now() });
      if (response.status === 404) {
        setNotFound(true);
        setOverview(null);
        setError(false);
        return;
      }
      if (!response.ok) throw new Error('overview request failed');
      const nextOverview = await response.json() as AgentOverviewDto;
      if (cancelled()) return;
      setOverview(nextOverview);
      setNotFound(false);
      setError(false);
    } catch {
      if (!cancelled()) setError(true);
    } finally {
      if (!cancelled()) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const initialTimer = window.setTimeout(() => { void load(isCancelled); }, 0);
    const refreshTimer = window.setInterval(() => { void load(isCancelled); }, 2000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelled = true; window.clearTimeout(initialTimer); window.clearInterval(refreshTimer); window.clearInterval(clockTimer); };
  }, [load]);

  const selected = overview?.agent;
  const runtime = overview?.runtime;

  return (
    <AgentContext.Provider value={{ id, agents, overview, loading, error, notFound }}>
      <div className="field agent-field">
        <AgentRail
          agents={agents}
          activeAgentId={id}
          beatClock={beatClock}
          now={now}
          status={rosterStatus}
          onAgentsChange={setAgents}
          onNew={() => router.push('/?new=1')}
          onManage={() => router.push('/?manage=1')}
          onDeleted={deleted => {
            setRosterStatus(deletedStatusLine(deleted.length));
            if (deleted.some(agent => agent.id === id)) router.replace(`/?deleted=${deleted.length}`);
          }}
        />

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
          </nav>
          <main className="agent-content">{children}</main>
        </section>
      </div>
    </AgentContext.Provider>
  );
}
