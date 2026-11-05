'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentOverview } from '../AgentShell';
import { AGENT_ACTIVITY_FILTERS, type AgentActivityFilter, type AgentActivityItem } from '@/lib/agent-activity-view';

type Loadable = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: AgentActivityItem[] };
const PAGE_SIZE = 20;

export function ActivityList({ items, compact = false }: { items: AgentActivityItem[]; compact?: boolean }) {
  return (<ol className={compact ? 'agent-activity-list is-compact' : 'agent-activity-list'} aria-label="Agent activity, newest first">
    {items.map(item => <li key={item.id} className={`agent-activity-item is-${item.severity}`} data-activity-kind={item.kind}>
      <span className="agent-activity-marker" aria-hidden="true" />
      <div className="agent-activity-card">
        <div className="agent-activity-summary">
          <div><span className="agent-activity-category">{item.category === 'conversations' ? 'Conversations & exchanges' : item.category}</span><strong>{item.summary}</strong><time dateTime={new Date(item.occurred_at).toISOString()}>{new Date(item.occurred_at).toLocaleString()}</time></div>
          {item.attention ? <span className="agent-activity-attention">Needs attention</span> : null}
        </div>
        <div className="agent-activity-actions"><Link href={item.target.href}>{item.target.label}</Link></div>
        {!compact && Object.keys(item.details).length ? <details className="agent-activity-details"><summary>Raw details</summary><dl>{Object.entries(item.details).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd><code>{String(value)}</code></dd></div>)}</dl><p>Safe structured fields only. Provider transcripts and identifiers are excluded.</p></details> : null}
      </div>
    </li>)}
  </ol>);
}

export default function AgentActivityPage() {
  const { id, overview, loading: overviewLoading, error: overviewError, notFound } = useAgentOverview();
  const [filter, setFilter] = useState<AgentActivityFilter>('all');
  const [activity, setActivity] = useState<Loadable>({ state: 'loading' });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const requestRef = useRef(0);

  const url = useCallback((cursor: string | null = null) => {
    const query = new URLSearchParams({ filter, limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    return `/api/bots/${encodeURIComponent(id)}/activity?${query.toString()}`;
  }, [filter, id]);

  useEffect(() => {
    let cancelled = false;
    const request = ++requestRef.current;
    fetch(url(), { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.activity)) throw new Error('activity');
      if (cancelled || request !== requestRef.current) return;
      setActivity({ state: 'ready', items: body.activity as AgentActivityItem[] });
      setNextCursor(typeof body.next_cursor === 'string' ? body.next_cursor : null);
      setLoadedKey(`${id}:${filter}`);
    }).catch(() => {
      if (!cancelled && request === requestRef.current) {
        setActivity({ state: 'error' });
        setNextCursor(null);
        setLoadedKey(`${id}:${filter}`);
      }
    });
    return () => { cancelled = true; };
  }, [filter, id, url]);

  const loadMore = async () => {
    if (!nextCursor || activity.state !== 'ready' || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(url(nextCursor), { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.activity)) throw new Error('activity');
      setActivity({ state: 'ready', items: [...activity.items, ...body.activity as AgentActivityItem[]] });
      setNextCursor(typeof body.next_cursor === 'string' ? body.next_cursor : null);
    } catch { setActivity({ state: 'error' }); }
    finally { setLoadingMore(false); }
  };

  if (overviewLoading) return <div className="agent-state" role="status">Loading Agent activity…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an Agent</Link></div>;
  if (overviewError || !overview) return <div className="agent-state" role="alert"><h2>Activity unavailable</h2><p>Botmancers could not load this Agent.</p></div>;

  const shownActivity: Loadable = loadedKey === `${id}:${filter}` ? activity : { state: 'loading' };

  return <div className="agent-activity" data-agent-activity-page>
    <header className="agent-activity-intro"><p className="agent-eyebrow">Activity</p><h2>What changed for {overview.agent.name}</h2><p>Operational history from Botmancers records. Open the owning page for actions and complete detail.</p></header>
    <div className="agent-activity-filters" role="group" aria-label="Filter Agent activity">
      {AGENT_ACTIVITY_FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>)}
    </div>
    {shownActivity.state === 'loading' ? <p className="agent-activity-state" role="status">Loading activity…</p> : null}
    {shownActivity.state === 'error' ? <div className="agent-activity-state is-error" role="alert"><strong>Activity unavailable</strong><p>No partial or stale timeline is shown. Refresh to try again.</p></div> : null}
    {shownActivity.state === 'ready' && !shownActivity.items.length ? <p className="agent-activity-state">{filter === 'all' ? 'No operational activity has been recorded for this Agent yet.' : `No ${AGENT_ACTIVITY_FILTERS.find(row => row.value === filter)?.label.toLowerCase()} activity matches this filter.`}</p> : null}
    {shownActivity.state === 'ready' && shownActivity.items.length ? <ActivityList items={shownActivity.items} /> : null}
    {shownActivity.state === 'ready' && nextCursor ? <button type="button" className="agent-activity-more" onClick={() => { void loadMore(); }} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older activity'}</button> : null}
  </div>;
}
