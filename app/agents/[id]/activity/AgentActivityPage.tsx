'use client';

import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useAgentOverview } from '../AgentShell';
import { AGENT_ACTIVITY_FILTERS, type AgentActivityFilter, type AgentActivityItem } from '@/lib/agent-activity-view';

export type ActivityLoadable = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: AgentActivityItem[] };
export interface ActivityPageState {
  filter: AgentActivityFilter;
  requestKey: string;
  activity: ActivityLoadable;
  nextCursor: string | null;
  loadingMore: boolean;
}
export type ActivityPageAction =
  | { type: 'select_filter'; filter: AgentActivityFilter }
  | { type: 'request_started'; key: string }
  | { type: 'request_succeeded'; key: string; items: AgentActivityItem[]; nextCursor: string | null }
  | { type: 'request_failed'; key: string }
  | { type: 'load_started'; key: string }
  | { type: 'load_succeeded'; key: string; items: AgentActivityItem[]; nextCursor: string | null }
  | { type: 'load_failed'; key: string };

export const initialActivityPageState: ActivityPageState = {
  filter: 'all', requestKey: '', activity: { state: 'loading' }, nextCursor: null, loadingMore: false,
};

export function activityPageReducer(state: ActivityPageState, action: ActivityPageAction): ActivityPageState {
  if (action.type === 'select_filter') return { ...state, filter: action.filter, requestKey: '', activity: { state: 'loading' }, nextCursor: null, loadingMore: false };
  if (action.type === 'request_started') return { ...state, requestKey: action.key, activity: { state: 'loading' }, nextCursor: null, loadingMore: false };
  if (action.type === 'request_succeeded') return action.key === state.requestKey ? { ...state, activity: { state: 'ready', items: action.items }, nextCursor: action.nextCursor } : state;
  if (action.type === 'request_failed') return action.key === state.requestKey ? { ...state, activity: { state: 'error' }, nextCursor: null } : state;
  if (action.type === 'load_started') return action.key === state.requestKey ? { ...state, loadingMore: true } : state;
  if (action.type === 'load_succeeded' && action.key === state.requestKey && state.activity.state === 'ready') return { ...state, activity: { state: 'ready', items: [...state.activity.items, ...action.items] }, nextCursor: action.nextCursor, loadingMore: false };
  if (action.type === 'load_failed') return action.key === state.requestKey ? { ...state, activity: { state: 'error' }, nextCursor: null, loadingMore: false } : state;
  return state;
}

const PAGE_SIZE = 20;

export function agentActivityUrl(id: string, filter: AgentActivityFilter, cursor: string | null = null): string {
  const query = new URLSearchParams({ filter, limit: String(PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  return `/api/bots/${encodeURIComponent(id)}/activity?${query.toString()}`;
}

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

export function ActivityResults({ activity, filter, nextCursor, loadingMore, onLoadMore }: {
  activity: ActivityLoadable;
  filter: AgentActivityFilter;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return <>
    {activity.state === 'loading' ? <p className="agent-activity-state" role="status">Loading activity…</p> : null}
    {activity.state === 'error' ? <div className="agent-activity-state is-error" role="alert"><strong>Activity unavailable</strong><p>No partial or stale timeline is shown. Refresh to try again.</p></div> : null}
    {activity.state === 'ready' && !activity.items.length ? <p className="agent-activity-state">{filter === 'all' ? 'No operational activity has been recorded for this agent yet.' : `No ${AGENT_ACTIVITY_FILTERS.find(row => row.value === filter)?.label.toLowerCase()} activity matches this filter.`}</p> : null}
    {activity.state === 'ready' && activity.items.length ? <ActivityList items={activity.items} /> : null}
    {activity.state === 'ready' && nextCursor ? <button type="button" className="agent-activity-more" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older activity'}</button> : null}
  </>;
}

export default function AgentActivityPage() {
  const { id, overview, loading: overviewLoading, error: overviewError, notFound } = useAgentOverview();
  const [state, dispatch] = useReducer(activityPageReducer, initialActivityPageState);
  const { filter, activity, nextCursor, loadingMore } = state;
  const requestRef = useRef(0);

  const url = useCallback((cursor: string | null = null) => agentActivityUrl(id, filter, cursor), [filter, id]);

  useEffect(() => {
    let cancelled = false;
    const request = ++requestRef.current;
    const key = `${id}:${filter}:${request}`;
    dispatch({ type: 'request_started', key });
    fetch(url(), { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.activity)) throw new Error('activity');
      if (cancelled || request !== requestRef.current) return;
      dispatch({ type: 'request_succeeded', key, items: body.activity as AgentActivityItem[], nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null });
    }).catch(() => {
      if (!cancelled && request === requestRef.current) {
        dispatch({ type: 'request_failed', key });
      }
    });
    return () => { cancelled = true; };
  }, [filter, id, url]);

  const loadMore = async () => {
    if (!nextCursor || activity.state !== 'ready' || loadingMore) return;
    const key = state.requestKey;
    dispatch({ type: 'load_started', key });
    try {
      const response = await fetch(url(nextCursor), { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.activity)) throw new Error('activity');
      dispatch({ type: 'load_succeeded', key, items: body.activity as AgentActivityItem[], nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null });
    } catch { dispatch({ type: 'load_failed', key }); }
  };

  if (overviewLoading) return <div className="agent-state" role="status">Loading agent activity…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an agent</Link></div>;
  if (overviewError || !overview) return <div className="agent-state" role="alert"><h2>Activity unavailable</h2><p>Botmancers could not load this agent.</p></div>;

  return <div className="agent-activity" data-agent-activity-page>
    <header className="agent-activity-intro"><p className="agent-eyebrow">Activity</p><h2>What changed for {overview.agent.name}</h2><p>Operational history from Botmancers records. Open the owning page for actions and complete detail.</p></header>
    <div className="agent-activity-filters" role="group" aria-label="Filter Agent activity">
      {AGENT_ACTIVITY_FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => dispatch({ type: 'select_filter', filter: option.value })}>{option.label}</button>)}
    </div>
    <ActivityResults activity={activity} filter={filter} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={() => { void loadMore(); }} />
  </div>;
}
