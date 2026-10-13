'use client';

import { useEffect, useId, useRef, useState } from 'react';
import DeleteAgentsDialog from '@/app/components/DeleteAgentsDialog';
import { blockedReasonCopy, type DeleteAgentRef, type DeleteBlocked } from '@/lib/bot-deletion';
import { botAgentLabel, deckLabel, isMigratedPending, type DeckListState } from '@/lib/bot-runtime-ui';

interface ManageRow {
  id: string;
  name: string;
  hidden: number;
  agent?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  needs_deck_selection?: boolean | number | null;
  source_provider: string | null;
  created_at: number;
  last_activity: number | null;
  blocked: DeleteBlocked['reason'] | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// NOT-459: every agent (hidden included) in one filterable list with
// bulk selection. Deletion goes through the shared DeleteAgentsDialog.
export default function ManageAgentsPanel({ deckState, onClose, onDeleted }: {
  deckState: DeckListState;
  onClose: () => void;
  onDeleted: (deleted: DeleteAgentRef[]) => void;
}) {
  const titleId = useId();
  const [rows, setRows] = useState<ManageRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/bots/manage', { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body)) {
          setLoadError(typeof body?.error === 'string' ? body.error : 'Could not load agents.');
          return;
        }
        setRows(body as ManageRow[]);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load agents.');
      });
    searchRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = (rows ?? []).filter(row => row.name.toLowerCase().includes(needle));
  const shownDeletable = shown.filter(row => !row.blocked);
  const allShownSelected = shownDeletable.length > 0 && shownDeletable.every(row => selected.includes(row.id));

  const toggle = (id: string) => {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };

  const selectAllShown = () => {
    setSelected(current => Array.from(new Set([...current, ...shownDeletable.map(row => row.id)])));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !confirming) {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="modal-scrim manage-scrim" onKeyDown={onKeyDown}>
      <div className="manage-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="manage-head">
          <h2 id={titleId} className="delete-title">Manage agents</h2>
          <button type="button" className="cancel-btn" onClick={onClose}>Close</button>
        </div>
        <label className="manage-search-label" htmlFor={`${titleId}-search`}>Filter by name</label>
        <input
          id={`${titleId}-search`}
          ref={searchRef}
          className="manage-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Name contains…"
        />
        <div className="manage-tools">
          <button type="button" className="pin-word" onClick={selectAllShown} disabled={shownDeletable.length === 0 || allShownSelected}>
            Select all shown
          </button>
          <button type="button" className="pin-word" onClick={() => setSelected([])} disabled={selected.length === 0}>
            Clear selection
          </button>
          <span className="manage-count" aria-live="polite">
            {selected.length} selected · {shown.length} shown of {rows?.length ?? 0}
          </span>
        </div>
        {loadError ? <p className="delete-error" role="alert">{loadError}</p> : null}
        {!rows && !loadError ? <p className="delete-copy">Loading agents…</p> : null}
        {rows ? (
          <ul className="manage-list" aria-label="Agents">
            {shown.length === 0 ? <li className="delete-copy">No agents match.</li> : null}
            {shown.map(row => {
              const checkboxId = `${titleId}-row-${row.id}`;
              const deck = isMigratedPending(row) ? 'Not selected' : deckLabel(row.deck_id ?? '', deckState);
              return (
                <li key={row.id} className={row.blocked ? 'manage-row is-blocked' : 'manage-row'} data-agent-id={row.id}>
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={selected.includes(row.id)}
                    disabled={!!row.blocked}
                    onChange={() => toggle(row.id)}
                    aria-describedby={row.blocked ? `${checkboxId}-reason` : undefined}
                  />
                  <div className="manage-copy">
                    <label htmlFor={checkboxId} className="manage-name">
                      {row.name}
                      {row.hidden ? <span className="manage-tag">Hidden</span> : null}
                    </label>
                    <dl className="manage-meta">
                      <div><dt>Agent</dt><dd>{botAgentLabel(row)}</dd></div>
                      <div><dt>Agent Deck</dt><dd>{deck}</dd></div>
                      <div><dt>Source</dt><dd>{row.source_provider || 'Created here'}</dd></div>
                      <div><dt>Created</dt><dd>{formatDate(row.created_at)}</dd></div>
                      {row.last_activity ? <div><dt>Last activity</dt><dd>{formatDate(row.last_activity)}</dd></div> : null}
                    </dl>
                    {row.blocked ? (
                      <p id={`${checkboxId}-reason`} className="manage-reason">{blockedReasonCopy(row.blocked)}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="form-actions manage-actions">
          <button type="button" className="cancel-btn" onClick={onClose}>Cancel</button>
          <button
            ref={deleteRef}
            type="button"
            className="delete-btn"
            disabled={selected.length === 0}
            onClick={() => setConfirming(true)}
          >
            Delete selected{selected.length > 0 ? ` (${selected.length})` : ''}
          </button>
        </div>
      </div>
      {confirming ? (
        <DeleteAgentsDialog
          ids={selected}
          onCancel={() => {
            setConfirming(false);
            requestAnimationFrame(() => deleteRef.current?.focus());
          }}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
