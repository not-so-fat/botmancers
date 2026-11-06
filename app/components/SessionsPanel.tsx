'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  SESSION_FILTER_OPTIONS,
  attemptLabel,
  emptySessionsCopy,
  formatSessionDate,
  formatSyncRelativeTime,
  noMatchingSessionsCopy,
  runtimeLabel,
  sessionOriginChips,
  sessionStateTags,
  sessionUsageLine,
  statusLabel,
  usageMetricView,
  usageSampleLabel,
  usageSampleValues,
  workRequestLabel,
  workspaceFolderName,
  workspaceOptions,
  type SessionAttemptRow,
  type SessionFilter,
  type SessionRow,
  type SessionSyncState,
  type SessionUsageRow,
  type SessionUsageSampleRow,
} from '@/lib/session-view';
import { agentLabel } from '@/lib/bot-definition';
import ExchangeDialog, { type ExchangeAgentOption } from '@/app/components/ExchangeDialog';
import { detailsHref, sessionDialogMode, sessionRowActions, type SessionDialogMode } from '@/lib/exchange-view';
import SessionShares from '@/app/components/SessionShares';
import type { OwnerShare, SharePolicy } from '@/lib/share-view';

// NOT-550: the selected Agent's full-page Sessions review surface. The
// compact list contains only scannable catalog facts; actions, explanations,
// usage, shares, origin, timestamps, and debug identifiers live in detail.
const SHARE_REFRESH_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 250;

function sessionsListUrl(agentId: string, filter: SessionFilter, query: string, workspace: string, cursor: string | null): string {
  const params = new URLSearchParams({ status: filter });
  const q = query.trim();
  if (q) params.set('q', q);
  if (workspace) params.set('workspace', workspace);
  if (cursor) params.set('cursor', cursor);
  return `/api/bots/${encodeURIComponent(agentId)}/sessions?${params.toString()}`;
}

function conversationHref(row: SessionRow): string | null {
  const conversation = row.origin.conversation;
  if (!conversation) return null;
  if (conversation.thread_agent_id) return `/agents/${encodeURIComponent(conversation.thread_agent_id)}/conversations`;
  if (conversation.kind === 'group') return `/threads/${encodeURIComponent(conversation.id)}`;
  return null;
}

export default function SessionsPanel({ agentId, agentName, agentProvider, agents, origin, onExchangeStarted }: {
  agentId: string;
  agentName: string;
  agentProvider?: string;
  agents: ExchangeAgentOption[];
  origin: { conversationId: string; label: string } | null;
  onExchangeStarted?: (exchangeId: string | null) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedRef = searchParams.get('session');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [sync, setSync] = useState<SessionSyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [workspaceOpts, setWorkspaceOpts] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursorScope, setCursorScope] = useState('');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [action, setAction] = useState<{ mode: SessionDialogMode; row: SessionRow; returnTo: HTMLElement | null } | null>(null);
  const [started, setStarted] = useState<{ id: string | null; text: string } | null>(null);
  const [shares, setShares] = useState<OwnerShare[] | null>(null);
  const [sharePolicy, setSharePolicy] = useState<SharePolicy | 'loading' | null>('loading');
  const [shareTick, setShareTick] = useState(0);
  const listSeqRef = useRef(0);
  const lastQueryRef = useRef('');
  const workspaceKeyRef = useRef('');
  const returnToRef = useRef<HTMLElement | null>(null);
  const selectedFromRef = useRef<HTMLElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingDetailFocus = useRef(false);
  const scrolledDeepLinkRef = useRef<string | null>(null);
  const providerLabel = agentProvider ? agentLabel(agentProvider) || undefined : undefined;

  // Catalog list fetch. Do not depend on requestedRef: selecting or closing a
  // session only changes ?session=, and refetching page 1 would discard
  // Load-more rows (and under a filter, clear a page-2 selection).
  useEffect(() => {
    listSeqRef.current += 1;
    const seq = listSeqRef.current;
    const key = `${agentId}\n${filter}`;
    const resetWorkspaces = workspaceKeyRef.current !== key;
    workspaceKeyRef.current = key;
    const delay = query === lastQueryRef.current ? 0 : SEARCH_DEBOUNCE_MS;
    lastQueryRef.current = query;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(sessionsListUrl(agentId, filter, query, workspaceFilter, null), { cache: 'no-store' })
        .then(async res => {
          const body = await res.json().catch(() => null);
          if (cancelled || listSeqRef.current !== seq) return;
          if (!res.ok || !Array.isArray(body?.sessions)) {
            setLoadError(typeof body?.error === 'string' ? body.error : 'Could not load sessions.');
            return;
          }
          const page = body.sessions as SessionRow[];
          setRows(page);
          setSync(body?.sync && typeof body.sync === 'object' ? body.sync as SessionSyncState : null);
          setNextCursor(typeof body?.next_cursor === 'string' ? body.next_cursor : null);
          setCursorScope(`${agentId}\n${filter}\n${query.trim()}\n${workspaceFilter}`);
          setLoadError('');
          const seen = page.map(row => row.context.workspace).filter((w): w is string => !!w);
          setWorkspaceOpts(prev => [...new Set([...(resetWorkspaces ? [] : prev), ...seen])]);
        })
        .catch(() => { if (!cancelled && listSeqRef.current === seq) setLoadError('Could not load sessions.'); });
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [agentId, filter, query, workspaceFilter, attempt]);

  // NOT-552: an owning-session link (?session=) opens that exact Botmancers
  // session even when it is older than the first catalog page. Unknown or
  // cross-Agent refs stay indistinguishable (404). Kept separate from the
  // list fetch so URL-driven selection cannot reset paging.
  useEffect(() => {
    if (!requestedRef || rows === null) return;
    if (rows.some(row => row.ref === requestedRef)) {
      if (scrolledDeepLinkRef.current !== requestedRef) {
        scrolledDeepLinkRef.current = requestedRef;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-session-ref="${CSS.escape(requestedRef)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        }));
      }
      return;
    }
    if (filter !== 'all' || query.trim() || workspaceFilter) return;
    let cancelled = false;
    fetch(`/api/bots/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(requestedRef)}`, { cache: 'no-store' })
      .then(async exactResponse => {
        const exactBody = await exactResponse.json().catch(() => null);
        if (cancelled) return;
        if (!exactResponse.ok || !exactBody?.session) return;
        const exact = exactBody.session as SessionRow;
        setRows(prev => {
          if (!prev || prev.some(row => row.ref === exact.ref)) return prev;
          return [exact, ...prev];
        });
      })
      .catch(() => { /* leave the catalog page as-is; selection stays cleared */ });
    return () => { cancelled = true; };
  }, [requestedRef, rows, agentId, filter, query, workspaceFilter]);

  // The ?session= query is the source of truth for selection. Closing detail
  // clears the query; do not re-select from a stale param while navigation
  // catches up, and do not keep a local selection after the query is gone.
  useEffect(() => {
    if (!rows) return;
    if (requestedRef && rows.some(row => row.ref === requestedRef)) setSelectedRef(requestedRef);
    else setSelectedRef(null);
  }, [requestedRef, rows]);

  // Filter/search changes that drop the selected row must clear ?session= so a
  // later matching filter does not silently reopen detail without focus.
  useEffect(() => {
    if (!rows || !requestedRef) return;
    if (rows.some(row => row.ref === requestedRef)) return;
    if (filter === 'all' && !query.trim() && !workspaceFilter) return; // exact fetch may still land it
    router.replace(`/agents/${encodeURIComponent(agentId)}/sessions`, { scroll: false });
  }, [rows, requestedRef, filter, query, workspaceFilter, agentId, router]);

  useEffect(() => {
    if (!selectedRef) {
      const returnTo = selectedFromRef.current;
      if (!returnTo || pendingDetailFocus.current) return;
      selectedFromRef.current = null;
      if (returnTo.isConnected) returnTo.focus();
      return;
    }
    if (!pendingDetailFocus.current) return;
    pendingDetailFocus.current = false;
    detailHeadingRef.current?.focus();
  }, [selectedRef]);

  const listScope = `${agentId}\n${filter}\n${query.trim()}\n${workspaceFilter}`;
  const cursorLive = nextCursor !== null && cursorScope === listScope;
  const doLoadMore = useCallback(async () => {
    if (loadingMore || !rows || !nextCursor || cursorScope !== listScope) return;
    setLoadingMore(true);
    const base = rows;
    const seq = listSeqRef.current;
    try {
      const res = await fetch(sessionsListUrl(agentId, filter, query, workspaceFilter, nextCursor), { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (listSeqRef.current !== seq) return;
      if (!res.ok || !Array.isArray(body?.sessions)) {
        setLoadError('Could not load more sessions.');
        return;
      }
      const page = body.sessions as SessionRow[];
      // Exact ?session= rows are prepended onto page 1; a later page can
      // repeat that ref. Drop already-present refs so Load more never
      // duplicates a deep-linked row (or React key).
      const present = new Set(base.map(row => row.ref));
      setRows([...base, ...page.filter(row => !present.has(row.ref))]);
      setNextCursor(typeof body?.next_cursor === 'string' ? body.next_cursor : null);
      setLoadError('');
      const seen = page.map(row => row.context.workspace).filter((w): w is string => !!w);
      if (seen.length) setWorkspaceOpts(prev => [...new Set([...prev, ...seen])]);
    } catch {
      if (listSeqRef.current === seq) setLoadError('Could not load more sessions.');
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, filter, query, workspaceFilter, loadingMore, rows, nextCursor, listScope, cursorScope]);

  const doRefresh = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult('');
    try {
      const res = await fetch(`/api/bots/${encodeURIComponent(agentId)}/sessions/sync`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (res.status === 409) setSyncResult('A sync is already running.');
      else if (!res.ok) setSyncResult('Could not sync sessions.');
      else {
        const imported = Array.isArray(body?.imported) ? body.imported.length : 0;
        const updated = Array.isArray(body?.updated) ? body.updated.length : 0;
        setSyncResult(`Synced: ${imported} imported, ${updated} updated.`);
      }
    } catch {
      setSyncResult('Could not sync sessions.');
    } finally {
      setSyncing(false);
      setAttempt(n => n + 1);
    }
  }, [agentId, syncing]);

  useEffect(() => {
    let cancelled = false;
    const id = encodeURIComponent(agentId);
    fetch(`/api/bots/${id}/share-policy`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (!cancelled) setSharePolicy(body?.policy ?? null); })
      .catch(() => { if (!cancelled) setSharePolicy(null); });
    fetch(`/api/shares?agent_id=${id}&limit=100`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(body => { if (!cancelled) setShares(Array.isArray(body?.shares) ? body.shares as OwnerShare[] : []); })
      .catch(() => { if (!cancelled) setShares([]); });
    return () => { cancelled = true; };
  }, [agentId, shareTick]);

  useEffect(() => {
    const timer = setInterval(() => setShareTick(n => n + 1), SHARE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (action || !returnToRef.current) return;
    const returnTo = returnToRef.current;
    returnToRef.current = null;
    if (returnTo.isConnected) returnTo.focus();
  }, [action]);

  const reload = (next: SessionFilter = filter) => {
    setRows(null);
    setLoadError('');
    setFilter(next);
    setAttempt(n => n + 1);
  };
  const clearSearch = () => { setQuery(''); setWorkspaceFilter(''); };
  const searchActive = query.trim() !== '' || workspaceFilter !== '';
  const selected = rows?.find(row => row.ref === selectedRef) ?? null;

  const selectSession = (row: SessionRow, trigger: HTMLElement) => {
    selectedFromRef.current = trigger;
    pendingDetailFocus.current = true;
    router.replace(`/agents/${encodeURIComponent(agentId)}/sessions?session=${encodeURIComponent(row.ref)}`, { scroll: false });
  };
  const closeDetail = () => {
    pendingDetailFocus.current = false;
    router.replace(`/agents/${encodeURIComponent(agentId)}/sessions`, { scroll: false });
  };
  const closeAction = () => {
    returnToRef.current = action?.returnTo ?? null;
    setAction(null);
  };

  return (
    <div className="agent-sessions-page" data-agent-sessions-page>
      <header className="agent-sessions-head">
        <div>
          <p className="agent-eyebrow">Sessions</p>
          <h2>Review {agentName}’s work</h2>
          <p>Scan runtime sessions, then open one for actions and operational detail.</p>
        </div>
        <div className="agent-sessions-sync">
          <span>Last synced {formatSyncRelativeTime(sync?.synced_at ?? null)}</span>
          <button type="button" className="sessions-filter-btn" onClick={() => { void doRefresh(); }} disabled={syncing}>
            {syncing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="sessions-filter" role="group" aria-label="Filter sessions">
        <div className="sessions-status-filter" role="group" aria-label="Show sessions">
          {SESSION_FILTER_OPTIONS.map(option => (
            <button key={option.value} type="button" className="sessions-filter-btn" aria-pressed={filter === option.value}
              onClick={() => { if (filter !== option.value) reload(option.value); }}>
              {option.label}
            </button>
          ))}
        </div>
        <input type="search" className="sessions-search" aria-label="Search sessions by title" placeholder="Search by title"
          value={query} onChange={e => setQuery(e.target.value)} />
        <select className="sessions-workspace" aria-label="Filter sessions by workspace" value={workspaceFilter}
          onChange={e => setWorkspaceFilter(e.target.value)}>
          <option value="">All workspaces</option>
          {workspaceOptions(workspaceOpts).map(option => <option key={option.value} value={option.value} title={option.value}>{option.label}</option>)}
        </select>
        <span className="manage-count" aria-live="polite">{rows ? `${rows.length} shown` : ''}</span>
      </div>
      <div className="exchange-started" role="status">{syncResult}</div>
      <div className="exchange-started" role="status">
        {started ? <>{started.text}{' '}{started.id ? <Link className="session-link" href={detailsHref(started.id)}>View in Exchanges</Link> : null}</> : null}
      </div>

      <div className={`sessions-review${selected ? ' has-detail' : ''}`} inert={!!action}>
        <section className="sessions-list-pane" aria-labelledby="sessions-list-title">
          <h3 id="sessions-list-title" className="session-sr">Session list</h3>
          {loadError ? (
            <div className="sessions-state" role="alert"><p className="delete-error">{loadError}</p><button type="button" className="pin-word" onClick={() => reload()}>Retry</button></div>
          ) : null}
          {!rows && !loadError ? <p className="delete-copy sessions-state" role="status">Loading sessions…</p> : null}
          {rows ? (
            <ul className="sessions-list" aria-label={`Sessions for ${agentName}`}>
              {rows.length === 0 ? (
                <li className="delete-copy sessions-state">
                  {searchActive ? <><p>{noMatchingSessionsCopy(query, workspaceFilter || null)}</p><button type="button" className="pin-word" onClick={clearSearch}>Clear search</button></> : <>
                    <p>{emptySessionsCopy(filter, agentName, sync, providerLabel)}</p>
                    {filter === 'all' && sync?.last_error_code ? <button type="button" className="pin-word" onClick={() => { void doRefresh(); }} disabled={syncing}>{syncing ? 'Retrying…' : 'Retry'}</button> : null}
                    {filter === 'all' && !sync?.last_error_code && (sync?.out_of_scope_count ?? 0) > 0 ? <Link className="session-link" href={`/agents/${encodeURIComponent(agentId)}/config`}>Widen the scope in Config</Link> : null}
                  </>}
                </li>
              ) : null}
              {rows.map(row => <SessionScanRow key={row.ref} row={row} selected={selectedRef === row.ref} onSelect={selectSession} />)}
            </ul>
          ) : null}
          {rows && rows.length > 0 && cursorLive ? <div className="sessions-more"><button type="button" className="sessions-filter-btn" onClick={() => { void doLoadMore(); }} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button></div> : null}
        </section>

        <section className="sessions-detail-pane" aria-label="Session detail">
          {selected ? (
            <SessionDetail key={selected.ref} row={selected} agentId={agentId} headingRef={detailHeadingRef} origin={origin}
              agents={agents} shares={shares} sharePolicy={sharePolicy} onClose={closeDetail}
              onAction={(mode, returnTo) => { setStarted(null); setAction({ mode, row: selected, returnTo }); }}
              onSharesChanged={() => setShareTick(n => n + 1)} />
          ) : <div className="sessions-detail-empty"><p className="agent-eyebrow">Session detail</p><h3>Select a session</h3><p>Actions, usage, origin, shares, and debug detail appear here.</p></div>}
        </section>
      </div>

      {action && origin ? (
        <ExchangeDialog mode={action.mode} session={action.row} agents={agents} origin={origin} onClose={closeAction}
          onStarted={id => {
            const what = action.mode === 'ask'
              ? `Asked ${action.row.agent.name}’s session. The answer arrives in ${origin.label}.`
              : action.mode === 'resume'
                ? `Resumed work in ${action.row.agent.name}’s session. Progress shows in ${origin.label}.`
                : `Handoff started from ${action.row.agent.name}’s session. Progress shows in ${origin.label}.`;
            setStarted({ id, text: what });
            closeAction();
            onExchangeStarted?.(id);
          }} />
      ) : null}
    </div>
  );
}

export function SessionScanRow({ row, selected, onSelect }: { row: SessionRow; selected: boolean; onSelect: (row: SessionRow, trigger: HTMLElement) => void }) {
  const actions = sessionRowActions(row);
  const available = actions.filter(item => item.availability.available).length;
  const folder = workspaceFolderName(row.context.workspace);
  const chips = sessionOriginChips(row);
  const stateTags = sessionStateTags(row);
  return (
    <li className={`session-scan-row is-${row.status}${selected ? ' is-selected' : ''}`} data-session-ref={row.ref}>
      <button type="button" className="session-scan-button" aria-current={selected ? 'true' : undefined} onClick={e => onSelect(row, e.currentTarget)}>
        <span className="session-scan-title-line"><strong className="session-title">{row.title}</strong><span className={`manage-tag session-status is-${row.status}`}>{statusLabel(row)}</span></span>
        <span className="session-scan-context"><span className="session-activity">{formatSessionDate(row.last_activity_at)}</span>{folder ? <span className="session-workspace" title={row.context.workspace ?? undefined}>{folder}</span> : null}</span>
        {chips.length || stateTags.length ? <span className="session-scan-chips">
          {chips.map(chip => <span key={chip} className="session-origin-chip">{chip}</span>)}
          {stateTags.map(tag => <span key={tag} className={`manage-tag session-state-tag is-${tag.toLowerCase()}`}>{tag}</span>)}
        </span> : null}
        <span className={`session-attention${available ? ' is-actionable' : ''}`}>{available ? `${available} action${available === 1 ? '' : 's'} available` : 'Review details'}</span>
      </button>
    </li>
  );
}

export function SessionDetail({ row, agentId, headingRef, origin, agents, shares, sharePolicy, onClose, onAction, onSharesChanged }: {
  row: SessionRow;
  agentId: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  origin: { conversationId: string; label: string } | null;
  agents: ExchangeAgentOption[];
  shares: OwnerShare[] | null;
  sharePolicy: SharePolicy | 'loading' | null;
  onClose: () => void;
  onAction: (mode: SessionDialogMode, returnTo: HTMLElement) => void;
  onSharesChanged: () => void;
}) {
  const [attempts, setAttempts] = useState<SessionAttemptRow[] | null>(null);
  const [usageDetail, setUsageDetail] = useState<{ totals: SessionUsageRow | undefined; samples: SessionUsageSampleRow[] } | null>(null);
  const [error, setError] = useState('');
  const [debugId, setDebugId] = useState<string | null>(null);
  const [debugError, setDebugError] = useState('');
  const [copied, setCopied] = useState(false);
  const base = `/api/bots/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(row.ref)}`;
  const actions = sessionRowActions(row);
  const available = actions.filter(item => item.availability.available);
  const unavailable = actions.filter(item => !item.availability.available);
  const conversation = row.origin.conversation;
  const originLink = conversationHref(row);
  const request = workRequestLabel(row);
  const usage = sessionUsageLine(row.usage);

  useEffect(() => {
    let cancelled = false;
    fetch(base, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body?.session?.attempts)) setError('Could not load session details.');
        else {
          setAttempts(body.session.attempts as SessionAttemptRow[]);
          setUsageDetail({ totals: body.session.usage as SessionUsageRow | undefined, samples: Array.isArray(body.session.usage_samples) ? body.session.usage_samples as SessionUsageSampleRow[] : [] });
        }
      })
      .catch(() => { if (!cancelled) setError('Could not load session details.'); });
    return () => { cancelled = true; };
  }, [base]);

  const loadDebug = useCallback(async () => {
    if (debugId !== null) return;
    try {
      const res = await fetch(`${base}?debug=external_session_id`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      const value = body?.debug?.external_session_id;
      if (res.ok && typeof value === 'string') setDebugId(value); else setDebugError('Not available.');
    } catch { setDebugError('Not available.'); }
  }, [base, debugId]);

  const copy = async () => {
    if (!debugId) return;
    try { await navigator.clipboard.writeText(debugId); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <article className="session-detail" data-session-detail={row.ref}>
      <div className="session-detail-head">
        <div><p className="agent-eyebrow">Session detail</p><h3 ref={headingRef} tabIndex={-1}>{row.title}</h3></div>
        <button type="button" className="pin-word session-detail-close" onClick={onClose}>Back to session list</button>
      </div>
      <div className="session-detail-tags"><span className={`manage-tag session-status is-${row.status}`}>{statusLabel(row)}</span>{sessionStateTags(row).map(tag => <span key={tag} className={`manage-tag session-state-tag is-${tag.toLowerCase()}`}>{tag}</span>)}</div>

      <dl className="session-detail-meta">
        <div><dt>Last activity</dt><dd>{formatSessionDate(row.last_activity_at)}</dd></div>
        <div><dt>Started</dt><dd>{formatSessionDate(row.created_at)}</dd></div>
        {row.ended_at !== null ? <div><dt>Ended</dt><dd>{formatSessionDate(row.ended_at)}</dd></div> : null}
        <div><dt>Runtime</dt><dd>{runtimeLabel(row)}</dd></div>
        <div><dt>Reported usage</dt><dd><span className={`session-usage is-${usage.quality}`} aria-hidden="true">{usage.text}</span><span className="session-sr">{usage.label}</span>{usage.partial ? <span className="manage-tag session-usage-tag">Partial</span> : null}</dd></div>
        {row.context.workspace ? <div className="is-wide"><dt>Workspace</dt><dd>{row.context.workspace}</dd></div> : null}
        <div className="is-wide"><dt>Origin</dt><dd>{originLink && conversation ? <Link className="session-link" href={originLink}>{conversation.label}</Link> : (conversation?.label ?? 'Not recorded')}</dd></div>
        {request ? <div className="is-wide"><dt>Work request</dt><dd>{request}</dd></div> : null}
      </dl>

      <section className="session-detail-section" aria-labelledby={`actions-${row.ref}`}>
        <h4 id={`actions-${row.ref}`}>Actions</h4>
        {origin && available.length ? <div className="session-actions" role="group" aria-label={`Actions for ${row.title}`}>
          {available.map(item => <button key={item.action} type="button" className="session-action" data-session-action={item.action} aria-haspopup="dialog" onClick={e => onAction(sessionDialogMode(item.action), e.currentTarget)}>{item.label}</button>)}
        </div> : null}
        {!origin && available.length ? <p className="session-unavailable">Open this Agent’s Conversation before starting an action.</p> : null}
        {unavailable.length ? <ul className="session-unavailable" aria-label={`Unavailable actions for ${row.title}`}>{unavailable.map(item => <li key={item.action}><strong>{item.label}:</strong> {item.availability.available ? '' : item.availability.reason}</li>)}</ul> : null}
      </section>

      <section className="session-detail-section"><SessionShares row={row} shares={shares} policy={sharePolicy} onChanged={onSharesChanged} /></section>
      <section className="session-detail-section" aria-labelledby={`runs-${row.ref}`}>
        <h4 id={`runs-${row.ref}`}>Runs and usage</h4>
        {error ? <p className="delete-error" role="alert">{error}</p> : null}
        {!attempts && !error ? <p className="delete-copy" role="status">Loading details…</p> : null}
        {attempts ? <ol className="session-attempts" aria-label="Runs in this session">{attempts.length === 0 ? <li>No recorded runs.</li> : null}{attempts.map(item => <li key={`${item.request_id}-${item.attempt_number}`}>{formatSessionDate(item.started_at)} · {attemptLabel(item)}</li>)}</ol> : null}
        {usageDetail ? <SessionUsageDetail totals={usageDetail.totals} samples={usageDetail.samples} /> : null}
      </section>

      <details className="session-debug session-detail-section" onToggle={e => { if (e.currentTarget.open) void loadDebug(); }}>
        <summary>Local debug: provider session ID</summary>
        <p className="session-debug-note">For local troubleshooting only. Botmancers resumes sessions for you; you never need to copy this.</p>
        {debugError ? <p className="delete-error">{debugError}</p> : null}
        {debugId ? <div className="session-debug-value"><code>{debugId}</code><button type="button" className="pin-word" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</button></div> : null}
      </details>
    </article>
  );
}

const USAGE_METRICS = ['input_tokens', 'output_tokens', 'cost_usd'] as const;

function SessionUsageDetail({ totals, samples }: { totals: SessionUsageRow | undefined; samples: SessionUsageSampleRow[] }) {
  const headingId = useId();
  return (
    <section className="session-usage-detail" aria-labelledby={headingId}>
      <h5 id={headingId} className="session-usage-head">Reported usage</h5>
      <dl className="session-usage-totals">{USAGE_METRICS.map(name => {
        const metric = usageMetricView(name, totals?.[name], true);
        return <div key={name}><dt>{metric.name}</dt><dd><span className={`session-usage is-${metric.quality}`} aria-hidden="true">{metric.text}</span><span className="session-sr">{metric.label}.</span><span className={`session-usage-coverage is-${metric.quality}`}>{metric.coverage}</span></dd></div>;
      })}</dl>
      {samples.length === 0 ? <p className="session-usage-none">No run in this session reported usage.</p> : <ol className="session-usage-runs" aria-label="Reported usage by run">{samples.map((sample, i) => {
        const values = usageSampleValues(sample);
        return <li key={`${sample.observed_at}-${i}`}><span className="session-usage-run">{formatSessionDate(sample.observed_at)} · {usageSampleLabel(sample, i)}</span><span className="session-usage-values"><span className={sample.input_tokens === null ? 'is-unavailable' : undefined}>In {values.input}</span><span className={sample.output_tokens === null ? 'is-unavailable' : undefined}>Out {values.output}</span><span className={sample.cost_usd === null ? 'is-unavailable' : undefined}>Cost {values.cost}</span></span></li>;
      })}</ol>}
    </section>
  );
}
