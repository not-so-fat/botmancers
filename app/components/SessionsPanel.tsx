'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  SESSION_FILTER_OPTIONS,
  attemptLabel,
  emptySessionsCopy,
  formatSessionDate,
  runtimeLabel,
  statusLabel,
  workRequestLabel,
  type SessionAttemptRow,
  type SessionFilter,
  type SessionRow,
} from '@/lib/session-view';

// NOT-496: the selected Agent's Sessions drawer. Rows come from the
// session catalog (GET /api/bots/:id/sessions) and are recognized by title,
// state, activity, and origin; nothing here asks for or shows an external
// provider session id except the labeled local debug disclosure.
export default function SessionsPanel({ agentId, agentName, onClose, onOpenThread }: {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onOpenThread: (agentId: string) => void;
}) {
  const titleId = useId();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
    <div className="modal-scrim sessions-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={cardRef} className="sessions-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onCardKeyDown}>
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
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function SessionItem({ agentId, row, open, onToggle, onOpenThread }: {
  agentId: string;
  row: SessionRow;
  open: boolean;
  onToggle: () => void;
  onOpenThread: (agentId: string) => void;
}) {
  const detailId = useId();
  const conversation = row.origin.conversation;
  const request = workRequestLabel(row);
  return (
    <li className={`manage-row session-row is-${row.status}`} data-session-ref={row.ref}>
      <div className="manage-copy">
        <div className="session-head">
          <span className="session-title">{row.title}</span>
          <span className={`manage-tag session-status is-${row.status}`}>{statusLabel(row)}</span>
          {row.resumable ? <span className="manage-tag">Resumable</span> : null}
        </div>
        <dl className="manage-meta">
          <div><dt>Last activity</dt><dd>{formatSessionDate(row.last_activity_at)}</dd></div>
          <div><dt>Started</dt><dd>{formatSessionDate(row.created_at)}</dd></div>
          {row.ended_at !== null ? <div><dt>Ended</dt><dd>{formatSessionDate(row.ended_at)}</dd></div> : null}
          <div><dt>Runtime</dt><dd>{runtimeLabel(row)}</dd></div>
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
        else setAttempts(body.session.attempts as SessionAttemptRow[]);
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
