'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentOverview } from '../AgentShell';
import {
  SHARE_FILTERS,
  creationPathLabel,
  normalizeRelayHealth,
  relayCopy,
  type RelayHealth,
} from '@/lib/agent-slack-view';
import {
  SHARE_STATUS_LABELS,
  audienceLabel,
  createdByLabel,
  expiryLabel,
  shareIsLive,
  shareStatusNote,
  threadLabel,
  turnsLabel,
  type OwnerShare,
  type SharePolicy,
} from '@/lib/share-view';

type Filter = 'all' | 'active' | 'expired' | 'revoked';
type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error' };
const PAGE_SIZE = 12;

export default function AgentSlackPage() {
  const { id, overview, loading: overviewLoading, error: overviewError, notFound } = useAgentOverview();
  const [relay, setRelay] = useState<Loadable<RelayHealth>>({ state: 'loading' });
  const [policy, setPolicy] = useState<Loadable<SharePolicy>>({ state: 'loading' });
  const [shares, setShares] = useState<Loadable<OwnerShare[]>>({ state: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadedAgentId, setLoadedAgentId] = useState('');
  const requestRef = useRef(0);

  const shareUrl = useCallback((cursor: string | null = null) => {
    const query = new URLSearchParams({ agent_id: id, limit: String(PAGE_SIZE) });
    if (filter !== 'all') query.set('state', filter);
    if (cursor) query.set('cursor', cursor);
    return `/api/shares?${query.toString()}`;
  }, [filter, id]);

  useEffect(() => {
    let cancelled = false;
    const request = ++requestRef.current;
    Promise.allSettled([
      fetch('/api/health', { cache: 'no-store' }).then(async response => normalizeRelayHealth((await response.json().catch(() => null))?.slack)),
      fetch(`/api/bots/${encodeURIComponent(id)}/share-policy`, { cache: 'no-store' }).then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.policy) throw new Error('policy');
        return body.policy as SharePolicy;
      }),
      fetch(shareUrl(), { cache: 'no-store' }).then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body?.shares)) throw new Error('shares');
        return { shares: (body.shares as OwnerShare[]).filter(share => share.agent.id === id), cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null };
      }),
    ]).then(([healthResult, policyResult, sharesResult]) => {
      if (cancelled || request !== requestRef.current) return;
      setRelay(healthResult.status === 'fulfilled' && healthResult.value ? { state: 'ready', value: healthResult.value } : { state: 'error' });
      setPolicy(policyResult.status === 'fulfilled' ? { state: 'ready', value: policyResult.value } : { state: 'error' });
      if (sharesResult.status === 'fulfilled') {
        setShares({ state: 'ready', value: sharesResult.value.shares });
        setNextCursor(sharesResult.value.cursor);
      } else setShares({ state: 'error' });
      setLoadedAgentId(id);
    }).finally(() => { if (!cancelled && request === requestRef.current) setRefreshing(false); });
    return () => { cancelled = true; };
  }, [id, revision, shareUrl]);

  const refresh = () => {
    setRefreshing(true);
    setRelay({ state: 'loading' });
    setPolicy({ state: 'loading' });
    setShares({ state: 'loading' });
    setNextCursor(null);
    setRevision(value => value + 1);
  };
  const selectFilter = (next: Filter) => {
    if (next === filter) return;
    setShares({ state: 'loading' });
    setNextCursor(null);
    setFilter(next);
  };
  const loadMore = async () => {
    if (!nextCursor || loadingMore || shares.state !== 'ready') return;
    setLoadingMore(true);
    try {
      const response = await fetch(shareUrl(nextCursor), { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.shares)) throw new Error('shares');
      const next = (body.shares as OwnerShare[]).filter(share => share.agent.id === id);
      setShares({ state: 'ready', value: [...shares.value, ...next] });
      setNextCursor(typeof body.next_cursor === 'string' ? body.next_cursor : null);
    } catch {
      setShares({ state: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  if (overviewLoading) return <div className="agent-state" role="status">Loading Slack operations…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an Agent</Link></div>;
  if (overviewError || !overview) return <div className="agent-state" role="alert"><h2>Slack page unavailable</h2><p>Botmancers could not load this Agent.</p></div>;

  const agentChanged = loadedAgentId !== id;

  return <AgentSlackView
    agentId={id}
    agentName={overview.agent.name}
    relay={agentChanged ? { state: 'loading' } : relay}
    policy={agentChanged ? { state: 'loading' } : policy}
    shares={agentChanged ? { state: 'loading' } : shares}
    filter={filter}
    nextCursor={nextCursor}
    refreshing={refreshing}
    loadingMore={loadingMore}
    onFilter={selectFilter}
    onRefresh={refresh}
    onLoadMore={() => { void loadMore(); }}
    onSharesChanged={refresh}
  />;
}

export function AgentSlackView({ agentId, agentName, relay, policy, shares, filter, nextCursor, refreshing, loadingMore, onFilter, onRefresh, onLoadMore, onSharesChanged }: {
  agentId: string;
  agentName: string;
  relay: Loadable<RelayHealth>;
  policy: Loadable<SharePolicy>;
  shares: Loadable<OwnerShare[]>;
  filter: Filter;
  nextCursor: string | null;
  refreshing: boolean;
  loadingMore: boolean;
  onFilter: (filter: Filter) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSharesChanged: () => void;
}) {
  const sessionsHref = `/agents/${encodeURIComponent(agentId)}/sessions`;
  const configHref = `/bots/${encodeURIComponent(agentId)}/config#session-sharing`;
  return (
    <div className="agent-slack" data-agent-slack-page>
      <header className="agent-slack-intro">
        <div>
          <p className="agent-eyebrow">Slack</p>
          <h2>Relay health and shared sessions</h2>
          <p>Botmancers runs one optional Slack relay. {agentName} does not have a separate Slack app; below are only the session threads shared for this Agent.</p>
        </div>
        <button type="button" className="agent-slack-refresh" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </header>

      <section className="agent-slack-relay" aria-labelledby="relay-heading">
        <div className="agent-slack-section-head"><div><p className="agent-eyebrow">Botmancers-wide connection</p><h3 id="relay-heading">Slack relay</h3></div>{relay.state === 'ready' ? <RelayBadge health={relay.value} /> : null}</div>
        {relay.state === 'loading' ? <p role="status">Checking the relay…</p> : null}
        {relay.state === 'error' ? <div className="agent-slack-error" role="alert"><strong>Relay health unavailable</strong><p>Botmancers could not read the redacted health status. Refresh to try again.</p></div> : null}
        {relay.state === 'ready' ? <RelayDetails health={relay.value} /> : null}
      </section>

      <section className="agent-slack-policy" aria-labelledby="policy-heading">
        <div className="agent-slack-section-head"><div><p className="agent-eyebrow">This Agent</p><h3 id="policy-heading">Sharing readiness</h3></div><Link href={configHref}>Edit in Config</Link></div>
        {policy.state === 'loading' ? <p role="status">Checking sharing policy…</p> : null}
        {policy.state === 'error' ? <div className="agent-slack-error" role="alert"><strong>Sharing policy unavailable</strong><p>Refresh, or open Config to review this Agent’s stored policy.</p></div> : null}
        {policy.state === 'ready' ? <PolicyDetails policy={policy.value} /> : null}
      </section>

      <section className="agent-slack-shares" aria-labelledby="shares-heading">
        <div className="agent-slack-section-head agent-slack-shares-head">
          <div><p className="agent-eyebrow">This Agent</p><h3 id="shares-heading">Shared session threads</h3><p>Each share is ask-only and can reach exactly one owning session.</p></div>
          <Link className="agent-primary-action" href={sessionsHref}>Share a session</Link>
        </div>
        <div className="agent-slack-filters" role="group" aria-label="Filter shares by state">
          {SHARE_FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => onFilter(option.value)}>{option.label}</button>)}
        </div>
        {shares.state === 'loading' ? <p className="agent-slack-empty" role="status">Loading shared sessions…</p> : null}
        {shares.state === 'error' ? <div className="agent-slack-error" role="alert"><strong>Shared sessions unavailable</strong><p>No partial or stale list is shown. Refresh to try again.</p></div> : null}
        {shares.state === 'ready' && shares.value.length === 0 ? <p className="agent-slack-empty">{filter === 'all' ? `No sessions from ${agentName} have been shared to Slack yet.` : `No ${SHARE_FILTERS.find(item => item.value === filter)?.label.toLowerCase()} shares for ${agentName}.`}</p> : null}
        {shares.state === 'ready' && shares.value.length > 0 ? <ul className="agent-slack-share-list" aria-label={`Slack shares for ${agentName}`}>{shares.value.map(share => <ShareRow key={share.share_ref} share={share} agentId={agentId} onChanged={onSharesChanged} />)}</ul> : null}
        {shares.state === 'ready' && nextCursor ? <button type="button" className="agent-slack-more" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more shares'}</button> : null}
      </section>
    </div>
  );
}

function RelayBadge({ health }: { health: RelayHealth }) {
  const copy = relayCopy(health);
  return <span className={`agent-slack-status is-${copy.tone}`} data-relay-state={health.state}>{copy.label}</span>;
}

function RelayDetails({ health }: { health: RelayHealth }) {
  const copy = relayCopy(health);
  return <div className="agent-slack-relay-copy"><p><strong>{copy.summary}</strong></p><p>{copy.guidance}</p>{health.state === 'connected' && health.connections > 0 ? <p className="agent-muted">Connections opened this run: {health.connections}</p> : null}</div>;
}

function PolicyDetails({ policy }: { policy: SharePolicy }) {
  const ready = policy.state === 'loaded' && policy.audiences.length > 0;
  return <div>
    <p><strong>{ready ? 'Ready to create session shares.' : policy.state === 'invalid' ? 'The sharing policy needs repair.' : 'No Slack audience is allowlisted yet.'}</strong></p>
    <p className="agent-muted">Share from a running Agent turn: {policy.agent.share_from_turn ? 'On' : 'Off'}. Session owners can still share eligible sessions from Sessions.</p>
    {policy.audiences.length ? <ul className="agent-slack-audiences" aria-label="Allowed Slack audiences">{policy.audiences.map(audience => <li key={`${audience.team_id}:${audience.channel_id}`}>{audienceLabel(audience)}</li>)}</ul> : <p className="agent-slack-empty">No allowlisted Slack channels.</p>}
  </div>;
}

function ShareRow({ share, agentId, onChanged }: { share: OwnerShare; agentId: string; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revokeButton = useRef<HTMLButtonElement>(null);
  const live = shareIsLive(share);
  const sessionHref = `/?agent=${encodeURIComponent(agentId)}&sessions=1&session=${encodeURIComponent(share.session_ref)}`;
  const revoke = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(share.share_ref)}/revoke`, { method: 'POST' });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.error?.message === 'string' ? body.error.message : 'The share could not be revoked.');
      setConfirming(false); onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The share could not be revoked.');
    } finally { setBusy(false); }
  };
  const cancel = () => { setConfirming(false); requestAnimationFrame(() => revokeButton.current?.focus()); };
  return <li className={`agent-slack-share is-${share.status}`} data-share-ref={share.share_ref} data-share-status={share.status}>
    <div className="agent-slack-share-summary">
      <div><span className={`agent-slack-status is-share-${share.status}`}>{SHARE_STATUS_LABELS[share.status]}</span><strong>{audienceLabel(share.audience)}</strong><small>{turnsLabel(share)} · {expiryLabel(share)}</small></div>
      <span className="agent-slack-detail-hint">Open for details</span>
    </div>
    <p className="agent-slack-state-note">{shareStatusNote(share)}</p>
    <details className="agent-slack-details">
      <summary>Details</summary>
      <dl className="agent-slack-share-details">
        <div><dt>Owning session</dt><dd><Link href={sessionHref}>{share.session_ref}</Link></dd></div>
        <div><dt>Posted thread</dt><dd>{threadLabel(share)}</dd></div>
        <div><dt>Creation path</dt><dd>{creationPathLabel(share)}</dd></div>
        <div><dt>Created by</dt><dd>{createdByLabel(share)}</dd></div>
        <div><dt>Authority</dt><dd>Ask only · exact session</dd></div>
        <div><dt>Share reference</dt><dd><code>{share.share_ref}</code></dd></div>
      </dl>
    </details>
    <div className="agent-slack-share-actions">
      <Link href={sessionHref}>Open owning session</Link>
      {live && !confirming ? <button ref={revokeButton} type="button" className="agent-slack-revoke" data-share-action="revoke" onClick={() => setConfirming(true)}>Revoke</button> : null}
    </div>
    {confirming ? <div className="agent-slack-confirm" role="group" aria-label="Confirm revoke"><p>Revoke this share? The next Slack question in its thread gets the revoked notice. This can’t be undone.</p><div><button type="button" className="agent-slack-revoke" data-share-action="confirm-revoke" disabled={busy} onClick={() => { void revoke(); }}>{busy ? 'Revoking…' : 'Revoke share'}</button><button type="button" disabled={busy} onClick={cancel}>Keep it</button></div></div> : null}
    {error ? <p className="delete-error" role="alert">{error}</p> : null}
  </li>;
}
