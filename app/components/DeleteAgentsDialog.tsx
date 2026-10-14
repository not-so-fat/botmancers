'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  DELETE_KEEPS_COPY,
  DELETE_REMOVES_COPY,
  blockedReasonCopy,
  deleteConfirmLabel,
  sharedConversationImpactCopy,
  type DeleteAgentRef,
  type DeletePreview,
} from '@/lib/bot-deletion';

// NOT-459: the one permanent-deletion confirmation. Config, the roster row
// menu, and Manage agents all open this with the ids to delete; it loads
// the server preview, confirms once, and calls DELETE /api/bots.
export default function DeleteAgentsDialog({ ids, onCancel, onDeleted }: {
  ids: string[];
  onCancel: () => void;
  onDeleted: (deleted: DeleteAgentRef[]) => void;
}) {
  const titleId = useId();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const idsKey = ids.join('\n');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/bots/delete-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsKey.split('\n') }),
    })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(typeof body?.error === 'string' ? body.error : 'Could not load the deletion preview.');
          return;
        }
        setPreview(body as DeletePreview);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the deletion preview.');
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    // Capture phase on document so Escape works even after focus falls to
    // the body, and never also reaches an enclosing Manage agents panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy) onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  const count = ids.length;
  const blocked = preview ? preview.blocked.length > 0 || preview.missing.length > 0 : true;

  const confirm = async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/bots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === 'string' && body.error ? body.error : `Delete failed (${res.status}).`);
        setBusy(false);
        requestAnimationFrame(() => cancelRef.current?.focus());
        return;
      }
      onDeleted(Array.isArray(body?.deleted) ? body.deleted : []);
    } catch {
      setError('Delete failed: the server did not respond.');
      setBusy(false);
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !cardRef.current) return;
    const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
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
    <div className="modal-scrim delete-scrim" onKeyDown={onKeyDown}>
      <div
        ref={cardRef}
        className="delete-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="delete-agents-dialog"
      >
        <h2 id={titleId} className="delete-title">
          {count === 1 ? 'Delete this agent permanently?' : `Delete ${count} agents permanently?`}
        </h2>
        {loadError ? <p className="delete-error" role="alert">{loadError}</p> : null}
        {!preview && !loadError ? <p className="delete-copy">Checking what will be removed…</p> : null}
        {preview ? (
          <>
            <ul className="delete-names" aria-label="Agents to delete">
              {preview.agents.map(agent => <li key={agent.id}>{agent.name}</li>)}
              {preview.missing.map(id => <li key={id}>Not found: {id}</li>)}
            </ul>
            {preview.blocked.length > 0 ? (
              <div className="delete-blocked" role="alert">
                <p>Nothing can be deleted until these are deselected:</p>
                <ul>
                  {preview.blocked.map(item => (
                    <li key={item.id}>{item.name} — {blockedReasonCopy(item.reason)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="delete-copy">{DELETE_REMOVES_COPY}</p>
            {preview.groups.length > 0 ? (
              <p className="delete-copy" data-testid="delete-legacy-impact">{sharedConversationImpactCopy(preview.groups)}</p>
            ) : null}
            <p className="delete-copy delete-keeps">{DELETE_KEEPS_COPY}</p>
          </>
        ) : null}
        {error ? <p className="delete-error" role="alert">{error}</p> : null}
        <div className="form-actions delete-actions">
          <button ref={cancelRef} type="button" className="cancel-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="delete-btn"
            onClick={() => { void confirm(); }}
            disabled={busy || blocked}
          >
            {busy ? 'Deleting…' : deleteConfirmLabel(count)}
          </button>
        </div>
      </div>
    </div>
  );
}
