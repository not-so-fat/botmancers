'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  SESSION_FILTER_OPTIONS,
  attemptLabel,
  emptySessionsCopy,
  formatSessionDate,
  runtimeLabel,
  sessionStateTags,
  sessionUsageLine,
  statusLabel,
  usageMetricView,
  usageSampleLabel,
  usageSampleValues,
  workRequestLabel,
  type SessionAttemptRow,
  type SessionFilter,
  type SessionRow,
  type SessionUsageRow,
  type SessionUsageSampleRow,
} from '@/lib/session-view';
import Link from 'next/link';
import ExchangeDialog, { type ExchangeAgentOption } from '@/app/components/ExchangeDialog';
import { detailsHref, sessionDialogMode, sessionRowActions, type SessionDialogMode } from '@/lib/exchange-view';

// NOT-496: the selected Agent's Sessions drawer. Rows come from the
// session catalog (GET /api/bots/:id/sessions) and are recognized by title,
// state, activity, and origin; nothing here asks for or shows an external
// provider session id except the labeled local debug disclosure.
// NOT-498: each resumable row offers its session actions; the dialog opens
// above the drawer (which goes inert) and focus returns to the action that
// opened it.
// NOT-507: the actions are Ask from this context, Resume work here, and
// Hand off to…, each available from the server's capability- and
// state-based answer (lib/session-actions); an unavailable action says why
// and what to do instead.
// NOT-509: each row shows the session's provider-reported usage totals and
// Details lists it per run. Unknown values read "Not reported" (never $0.00
// or an estimate) and partial coverage is labeled Partial.
export default function SessionsPanel({ agentId, agentName, agents, origin, onClose, onOpenThread, onExchangeStarted }: {
  agentId: string;
  agentName: string;
  agents: ExchangeAgentOption[];
  origin: { conversationId: string; label: string };
  onClose: () => void;
  onOpenThread: (agentId: string) => void;
  onExchangeStarted: (exchangeId: string | null) => void;
}) {
  const titleId = useId();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<{ mode: SessionDialogMode; row: SessionRow; returnTo: HTMLElement | null } | null>(null);
  const [started, setStarted] = useState<{ id: string | null; text: string } | null>(null);

  const closeAction = () => {
    const returnTo = action?.returnTo;
    setAction(null);
    requestAnimationFrame(() => { if (returnTo?.isConnected) returnTo.focus(); });
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bots/${encodeURIComponent(agentId)}/sessions?status=${filter}`, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body?.sessions)) {
          setLoadError(typeof body?.error === 'string' ? body.error : 'Could not load sessions.');
          return;
        }
        setRows(body.sessions as SessionRow[]);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load sessions.');
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, filter, attempt]);

  const reload = (next: SessionFilter = filter) => {
    setRows(null);
    setLoadError('');
    setFilter(next);
    setAttempt(n => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onCardKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !cardRef.current) return;
    const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), summary'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-scrim sessions-scrim" onMouseDown={e => { if (e.target === e.currentTarget && !action) onClose(); }}>
      <div ref={cardRef} className="sessions-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onCardKeyDown} inert={!!action}>
        <div className="manage-head">
          <div>
            <h2 id={titleId} className="delete-title sessions-title">Sessions</h2>
            <p className="sessions-sub">{agentName}</p>
          </div>
          <button ref={closeRef} type="button" className="cancel-btn" onClick={onClose}>Close</button>
        </div>
        <div className="sessions-filter" role="group" aria-label="Show sessions">
          {SESSION_FILTER_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              className="sessions-filter-btn"
              aria-pressed={filter === option.value}
              onClick={() => { if (filter !== option.value) reload(option.value); }}
            >
              {option.label}
            </button>
          ))}
          <span className="manage-count" aria-live="polite">
            {rows ? `${rows.length} shown` : ''}
          </span>
        </div>
        <div className="exchange-started" role="status">
          {started ? (
            <>
              {started.text}{' '}
              {started.id ? <Link className="session-link" href={detailsHref(started.id)}>View in Exchanges</Link> : null}
            </>
          ) : null}
        </div>
        {loadError ? (
          <div className="sessions-state" role="alert">
            <p className="delete-error">{loadError}</p>
            <button type="button" className="pin-word" onClick={() => reload()}>Retry</button>
          </div>
        ) : null}
        {!rows && !loadError ? <p className="delete-copy sessions-state" role="status">Loading sessions…</p> : null}
        {rows ? (
          <ul className="manage-list sessions-list" aria-label={`Sessions for ${agentName}`}>
            {rows.length === 0 ? <li className="delete-copy sessions-state">{emptySessionsCopy(filter, agentName)}</li> : null}
            {rows.map(row => (
              <SessionItem
                key={row.ref}
                agentId={agentId}
                row={row}
                open={openRef === row.ref}
                onToggle={() => setOpenRef(current => current === row.ref ? null : row.ref)}
                onOpenThread={onOpenThread}
                onAction={(mode, returnTo) => { setStarted(null); setAction({ mode, row, returnTo }); }}
              />
            ))}
          </ul>
        ) : null}
      </div>
      {action ? (
        <ExchangeDialog
          mode={action.mode}
          session={action.row}
          agents={agents}
          origin={origin}
          onClose={closeAction}
          onStarted={id => {
            const what = action.mode === 'ask'
              ? `Asked ${action.row.agent.name}’s session. The answer arrives in ${origin.label}.`
              : action.mode === 'resume'
                ? `Resumed work in ${action.row.agent.name}’s session. Progress shows in ${origin.label}.`
                : `Handoff started from ${action.row.agent.name}’s session. Progress shows in ${origin.label}.`;
            setStarted({ id, text: what });
            closeAction();
            onExchangeStarted(id);
          }}
        />
      ) : null}
    </div>
  );
}

function SessionItem({ agentId, row, open, onToggle, onOpenThread, onAction }: {
  agentId: string;
  row: SessionRow;
  open: boolean;
  onToggle: () => void;
  onOpenThread: (agentId: string) => void;
  onAction: (mode: SessionDialogMode, returnTo: HTMLElement) => void;
}) {
  const detailId = useId();
  const actions = sessionRowActions(row);
  const available = actions.filter(item => item.availability.available);
  const reasons = actions.flatMap(item => item.availability.available ? [] : [item.availability.reason]);
  const conversation = row.origin.conversation;
  const request = workRequestLabel(row);
  const usage = sessionUsageLine(row.usage);
  return (
    <li className={`manage-row session-row is-${row.status}`} data-session-ref={row.ref}>
      <div className="manage-copy">
        <div className="session-head">
          <span className="session-title">{row.title}</span>
          <span className={`manage-tag session-status is-${row.status}`}>{statusLabel(row)}</span>
          {sessionStateTags(row).map(tag => <span key={tag} className={`manage-tag session-state-tag is-${tag.toLowerCase()}`}>{tag}</span>)}
        </div>
        <dl className="manage-meta">
          <div><dt>Last activity</dt><dd>{formatSessionDate(row.last_activity_at)}</dd></div>
          <div><dt>Started</dt><dd>{formatSessionDate(row.created_at)}</dd></div>
          {row.ended_at !== null ? <div><dt>Ended</dt><dd>{formatSessionDate(row.ended_at)}</dd></div> : null}
          <div><dt>Runtime</dt><dd>{runtimeLabel(row)}</dd></div>
          <div className="session-usage-meta">
            <dt>Reported usage</dt>
            <dd>
              <span className={`session-usage is-${usage.quality}`} aria-hidden="true">{usage.text}</span>
              <span className="session-sr">{usage.label}</span>
              {usage.partial ? <span className="manage-tag session-usage-tag">Partial</span> : null}
            </dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>
              {conversation?.thread_agent_id ? (
                <button type="button" className="session-link" onClick={() => onOpenThread(conversation.thread_agent_id as string)}>
                  {conversation.label}
                </button>
              ) : (conversation?.label ?? 'Not recorded')}
            </dd>
          </div>
          {request ? <div><dt>Work request</dt><dd>{request}</dd></div> : null}
          {row.context.workspace ? <div><dt>Workspace</dt><dd>{row.context.workspace}</dd></div> : null}
          {row.context.deck ? <div><dt>Deck</dt><dd>{row.context.deck}</dd></div> : null}
        </dl>
        {available.length > 0 ? (
          <div className="session-actions" role="group" aria-label={`Actions for ${row.title}`}>
            {available.map(item => (
              <button key={item.action} type="button" className="session-action" data-session-action={item.action} aria-haspopup="dialog" onClick={e => onAction(sessionDialogMode(item.action), e.currentTarget)}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        {reasons.length > 0 ? (
          <ul className="session-unavailable" aria-label={`Unavailable actions for ${row.title}`}>
            {reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        ) : null}
        <button type="button" className="pin-word session-toggle" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
          {open ? 'Hide details' : 'Details'}
        </button>
        {open ? <SessionDetail id={detailId} agentId={agentId} sessionRef={row.ref} /> : null}
      </div>
    </li>
  );
}

function SessionDetail({ id, agentId, sessionRef }: { id: string; agentId: string; sessionRef: string }) {
  const [attempts, setAttempts] = useState<SessionAttemptRow[] | null>(null);
  const [usage, setUsage] = useState<{ totals: SessionUsageRow | undefined; samples: SessionUsageSampleRow[] } | null>(null);
  const [error, setError] = useState('');
  const [debugId, setDebugId] = useState<string | null>(null);
  const [debugError, setDebugError] = useState('');
  const [copied, setCopied] = useState(false);
  const base = `/api/bots/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionRef)}`;

  useEffect(() => {
    let cancelled = false;
    fetch(base, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body?.session?.attempts)) setError('Could not load session details.');
        else {
          setAttempts(body.session.attempts as SessionAttemptRow[]);
          setUsage({
            totals: body.session.usage as SessionUsageRow | undefined,
            samples: Array.isArray(body.session.usage_samples) ? body.session.usage_samples as SessionUsageSampleRow[] : [],
          });
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
      if (res.ok && typeof value === 'string') setDebugId(value);
      else setDebugError('Not available.');
    } catch {
      setDebugError('Not available.');
    }
  }, [base, debugId]);

  const copy = async () => {
    if (!debugId) return;
    try {
      await navigator.clipboard.writeText(debugId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div id={id} className="session-detail">
      {error ? <p className="delete-error" role="alert">{error}</p> : null}
      {!attempts && !error ? <p className="delete-copy" role="status">Loading details…</p> : null}
      {attempts ? (
        <ol className="session-attempts" aria-label="Runs in this session">
          {attempts.length === 0 ? <li>No recorded runs.</li> : null}
          {attempts.map(item => (
            <li key={`${item.request_id}-${item.attempt_number}`}>
              {formatSessionDate(item.started_at)} · {attemptLabel(item)}
            </li>
          ))}
        </ol>
      ) : null}
      {usage ? <SessionUsageDetail totals={usage.totals} samples={usage.samples} /> : null}
      <details className="session-debug" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open) void loadDebug(); }}>
        <summary>Local debug: provider session ID</summary>
        <p className="session-debug-note">For local troubleshooting only. Botmancers resumes sessions for you; you never need to copy this.</p>
        {debugError ? <p className="delete-error">{debugError}</p> : null}
        {debugId ? (
          <div className="session-debug-value">
            <code>{debugId}</code>
            <button type="button" className="pin-word" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        ) : null}
      </details>
    </div>
  );
}

const USAGE_METRICS = ['input_tokens', 'output_tokens', 'cost_usd'] as const;

function SessionUsageDetail({ totals, samples }: { totals: SessionUsageRow | undefined; samples: SessionUsageSampleRow[] }) {
  const headingId = useId();
  return (
    <section className="session-usage-detail" aria-labelledby={headingId}>
      <h3 id={headingId} className="session-usage-head">Reported usage</h3>
      <dl className="session-usage-totals">
        {USAGE_METRICS.map(name => {
          const metric = usageMetricView(name, totals?.[name], true);
          return (
            <div key={name}>
              <dt>{metric.name}</dt>
              <dd>
                <span className={`session-usage is-${metric.quality}`} aria-hidden="true">{metric.text}</span>
                <span className="session-sr">{metric.label}.</span>
                <span className={`session-usage-coverage is-${metric.quality}`}>{metric.coverage}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      {samples.length === 0 ? (
        <p className="session-usage-none">No run in this session reported usage.</p>
      ) : (
        <ol className="session-usage-runs" aria-label="Reported usage by run">
          {samples.map((sample, i) => {
            const values = usageSampleValues(sample);
            return (
              <li key={`${sample.observed_at}-${i}`}>
                <span className="session-usage-run">{formatSessionDate(sample.observed_at)} · {usageSampleLabel(sample, i)}</span>
                <span className="session-usage-values">
                  <span className={sample.input_tokens === null ? 'is-unavailable' : undefined}>In {values.input}</span>
                  <span className={sample.output_tokens === null ? 'is-unavailable' : undefined}>Out {values.output}</span>
                  <span className={sample.cost_usd === null ? 'is-unavailable' : undefined}>Cost {values.cost}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
