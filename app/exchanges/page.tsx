'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import ExchangeCard from '@/app/components/ExchangeCard';
import {
  DEFAULT_LEDGER_FILTER,
  MODE_FILTER_OPTIONS,
  STATE_FILTER_OPTIONS,
  eventLabel,
  excerpt,
  formatExchangeTime,
  instructionHeading,
  ledgerAgents,
  ledgerRows,
  ledgerView,
  linkRoleLabel,
  liveStateLabel,
  modeLabel,
  participantsLabel,
  stateTone,
  threadHref,
  type ExchangeDetail,
  type ExchangeSummary,
  type LedgerFilter,
  type StateFilter,
} from '@/lib/exchange-view';

const POLL_MS = 2000;

// The selected exchange lives in the URL (?id=), so a card's Details link,
// Back, and a reload all land on the same detail.
const NAVIGATE = 'botmancers:exchanges-navigate';
function subscribeUrl(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}
function selectedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

// NOT-498: the global Agent Exchanges ledger. Every durable Ask and
// Continue of the owner, newest activity first, filterable by mode,
// status, and Agent; a detail view shows the ordered event timeline and a
// backlink to every linked thread. Narrow layouts show the list or the
// detail as a full-height page, never squeezed columns.
export default function ExchangesPage() {
  const [all, setAll] = useState<ExchangeSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<LedgerFilter>(DEFAULT_LEDGER_FILTER);
  const selected = useSyncExternalStore(subscribeUrl, selectedFromUrl, () => null);
  const statusId = useId();
  const agentId = useId();
  const listTitleId = useId();
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const lastSelected = useRef<string | null>(null);

  // Leaving a detail (its Back control, or browser Back) unmounts the
  // focused heading; focus returns to the row that opened it, or to the
  // list heading when that row is gone or filtered out.
  useEffect(() => {
    const previous = lastSelected.current;
    lastSelected.current = selected;
    if (selected || !previous) return;
    const row = document.querySelector<HTMLElement>(`.ledger-row[data-exchange-id="${CSS.escape(previous)}"]`);
    (row ?? listTitleRef.current)?.focus();
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/exchanges', { cache: 'no-store' })
        .then(async res => {
          const body = await res.json().catch(() => null);
          if (cancelled) return;
          if (!res.ok || !Array.isArray(body?.exchanges)) {
            setLoadError(typeof body?.error?.message === 'string' ? body.error.message : 'Could not load exchanges.');
            return;
          }
          setLoadError('');
          setAll(body.exchanges as ExchangeSummary[]);
        })
        .catch(() => { if (!cancelled) setLoadError('Could not load exchanges.'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reload]);

  const open = (id: string | null) => {
    window.history.pushState(null, '', id ? `/exchanges?id=${encodeURIComponent(id)}` : '/exchanges');
    window.dispatchEvent(new Event(NAVIGATE));
  };

  const rows = all ? ledgerRows(all, filter) : [];
  // A failed refresh keeps the rows already shown.
  const view = ledgerView(all, all ? '' : loadError, rows);
  const agents = all ? ledgerAgents(all) : [];

  return (
    <div className={selected ? 'ledger-page has-detail' : 'ledger-page'}>
      <header className="ledger-head">
        <Link href="/" className="cfg-link ledger-back">← Back to chat</Link>
        <h1 className="ledger-title">Agent Exchanges</h1>
        <p className="ledger-sub">Every Ask and Continue between Agent sessions, newest activity first.</p>
      </header>
      <main className="ledger-main">
        <section className="ledger-list-pane" aria-labelledby={listTitleId}>
          <h2 id={listTitleId} ref={listTitleRef} tabIndex={-1} className="ledger-pane-title">Exchanges</h2>
          <div className="ledger-filters">
            <div className="sessions-filter ledger-mode" role="group" aria-label="Mode">
              {MODE_FILTER_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className="sessions-filter-btn"
                  aria-pressed={filter.mode === option.value}
                  onClick={() => setFilter(current => ({ ...current, mode: option.value }))}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="ledger-selects">
              <label className="ledger-select-label" htmlFor={statusId}>
                Status
                <select
                  id={statusId}
                  className="exchange-select"
                  value={filter.state}
                  onChange={e => setFilter(current => ({ ...current, state: e.target.value as StateFilter }))}
                >
                  {STATE_FILTER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="ledger-select-label" htmlFor={agentId}>
                Agent
                <select
                  id={agentId}
                  className="exchange-select"
                  value={filter.agentId}
                  onChange={e => setFilter(current => ({ ...current, agentId: e.target.value }))}
                >
                  <option value="">Any Agent</option>
                  {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
            </div>
            <p className="manage-count ledger-count" role="status">{all ? `${rows.length} of ${all.length} shown` : ''}</p>
          </div>
          {view === 'loading' ? <p className="ledger-state" role="status" data-ledger-state="loading">Loading exchanges…</p> : null}
          {view === 'error' ? (
            <div className="ledger-state" role="alert" data-ledger-state="error">
              <p className="delete-error">{loadError}</p>
              <button type="button" className="pin-word" onClick={() => { setLoadError(''); setReload(n => n + 1); }}>Retry</button>
            </div>
          ) : null}
          {view === 'empty' ? (
            <p className="ledger-state" data-ledger-state="empty">
              No exchanges yet. Open an agent’s Sessions and choose Ask from this context or Hand off to… to start one.
            </p>
          ) : null}
          {view === 'filtered-out' ? (
            <div className="ledger-state" data-ledger-state="filtered-out">
              <p>No exchanges match these filters.</p>
              <button type="button" className="pin-word" onClick={() => setFilter(DEFAULT_LEDGER_FILTER)}>Clear filters</button>
            </div>
          ) : null}
          {view === 'rows' ? (
            <ol className="ledger-list" aria-label="Exchanges, newest activity first">
              {rows.map(summary => (
                <li key={summary.id} className="ledger-row-item">
                  <button
                    type="button"
                    className={`ledger-row is-${stateTone(summary.state)}`}
                    data-exchange-id={summary.id}
                    aria-current={selected === summary.id ? 'true' : undefined}
                    onClick={() => open(summary.id)}
                  >
                    <span className="ledger-row-line">
                      <span className="exchange-card-mode">{modeLabel(summary.mode)}</span>
                      <span className="ledger-row-who">{participantsLabel(summary)}</span>
                      <span className="ledger-row-state">{liveStateLabel(summary)}</span>
                    </span>
                    <span className="ledger-row-session">{summary.source.session_title}</span>
                    <span className="ledger-row-meta">
                      From {summary.origin?.label ?? 'an unknown thread'} · Started {formatExchangeTime(summary.created_at)} · Updated {formatExchangeTime(summary.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
        <section className="ledger-detail-pane" aria-label="Exchange detail">
          {selected ? (
            <ExchangeDetailView key={selected} id={selected} onBack={() => open(null)} onChanged={() => setReload(n => n + 1)} />
          ) : (
            <p className="ledger-state ledger-placeholder">Choose an exchange to see its timeline and linked threads.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function ExchangeDetailView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ExchangeDetail | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/exchanges/${encodeURIComponent(id)}`, { cache: 'no-store' })
        .then(async res => {
          const body = await res.json().catch(() => null);
          if (cancelled) return;
          if (!res.ok || !body?.detail) {
            setError(res.status === 404 ? 'This exchange no longer exists.' : 'Could not load this exchange.');
            return;
          }
          setError('');
          setDetail(body.detail as ExchangeDetail);
        })
        .catch(() => { if (!cancelled) setError('Could not load this exchange.'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, tick]);

  useEffect(() => {
    if (detail && !focused.current) {
      focused.current = true;
      headingRef.current?.focus();
    }
  }, [detail]);

  const back = (
    <button type="button" className="pin-word ledger-detail-back" onClick={onBack}>← All exchanges</button>
  );
  if (!detail) {
    return (
      <div className="ledger-detail">
        {back}
        {error
          ? <div role="alert" className="ledger-state"><p className="delete-error">{error}</p><button type="button" className="pin-word" onClick={() => setTick(n => n + 1)}>Retry</button></div>
          : <p className="ledger-state" role="status">Loading exchange…</p>}
      </div>
    );
  }
  const { summary, events, packet } = detail;
  return (
    <article className="ledger-detail" aria-labelledby={titleId} data-exchange-detail={summary.id}>
      {back}
      <h2 id={titleId} ref={headingRef} tabIndex={-1} className="ledger-detail-title">
        {modeLabel(summary.mode)}: {participantsLabel(summary)}
      </h2>
      <ExchangeCard summary={summary} onChanged={() => { setTick(n => n + 1); onChanged(); }} />
      <section className="ledger-section" aria-label={instructionHeading(summary.mode)}>
        <h3 className="ledger-section-title">{instructionHeading(summary.mode)}</h3>
        <p className="ledger-text">{summary.instruction}</p>
      </section>
      {detail.answer ? (
        <section className="ledger-section" aria-label="Answer">
          <h3 className="ledger-section-title">Answer</h3>
          <p className="ledger-text">{detail.answer}</p>
        </section>
      ) : null}
      {packet ? (
        <section className="ledger-section" aria-label="Handoff packet">
          <h3 className="ledger-section-title">Handoff packet</h3>
          <p className="ledger-text">{packet.objective}</p>
          {([['Decisions', packet.decisions], ['Constraints', packet.constraints], ['Artifacts and references', packet.artifacts], ['Open questions', packet.open_questions]] as const)
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <div key={label} className="ledger-packet-list">
                <h4 className="ledger-packet-title">{label}</h4>
                <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </div>
            ))}
        </section>
      ) : null}
      <section className="ledger-section" aria-label="Linked threads">
        <h3 className="ledger-section-title">Linked threads</h3>
        <ul className="ledger-links">
          {summary.links.map(link => {
            const href = threadHref(link, summary.id);
            return (
              <li key={link.id}>
                {href
                  ? <Link className="session-link ledger-thread-link" href={href}>{link.label}</Link>
                  : <span>{link.label}{link.kind === 'agent_api' ? <span className="ledger-link-role"> (between Agents, not an owner thread)</span> : null}</span>}
                <span className="ledger-link-role"> · {linkRoleLabel(link.roles)}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="ledger-section" aria-label="Timeline">
        <h3 className="ledger-section-title">Timeline</h3>
        <ol className="ledger-timeline">
          {events.map(event => (
            <li key={event.sequence} data-event-type={event.type}>
              <span className="ledger-timeline-time">{formatExchangeTime(event.at)}</span>
              <span className="ledger-timeline-text">{eventLabel(event, summary)}</span>
            </li>
          ))}
        </ol>
      </section>
      <p className="ledger-foot">{excerpt(`${summary.source.agent_name}’s session: ${summary.source.session_title}`, 200)}{summary.destination?.session_title ? ` · ${summary.destination.agent_name}’s new session: ${summary.destination.session_title}` : ''}</p>
    </article>
  );
}
