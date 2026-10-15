'use client';

import { useState } from 'react';
import type { WakeNotice as Notice } from '@/lib/wake-notice';

const LABEL: Record<Notice['tone'], string> = {
  blocked: 'Needs approval',
  rejected: 'Not started',
  allowed: 'Allowed',
  denied: 'Denied',
  waiting: 'Queued',
  stopped: 'Stopped',
};

// NOT-475: one Wake safety outcome as application status in the thread.
// A Wake waiting for the owner's edit grant carries Allow / Deny, which
// POST /api/wakes/{id}/decision; the next poll shows the outcome.
export default function WakeNotice({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blockedLabel = notice.tone === 'blocked' && !notice.actionable ? 'Blocked' : LABEL[notice.tone];

  const decide = async (decision: 'allow' | 'deny') => {
    if (busy || !notice.wakeId) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/wakes/${notice.wakeId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(typeof body?.error?.message === 'string' ? body.error.message : 'The decision could not be recorded.');
      }
    } catch {
      setError('The decision could not be recorded.');
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <div className={`wake-notice wake-notice-${notice.tone}`} role="status" data-wake-notice={notice.tone} data-wake-id={notice.wakeId ?? undefined}>
      <p className="wake-notice-line">
        <span className="wake-notice-label">{blockedLabel}</span>
        {notice.text}
      </p>
      {notice.actionable ? (
        <div className="wake-notice-actions">
          <button type="button" className="approve-control" disabled={busy} onClick={() => { void decide('allow'); }}>
            Allow
          </button>
          <button type="button" className="approve-control" style={{ marginLeft: 8 }} disabled={busy} onClick={() => { void decide('deny'); }}>
            Deny
          </button>
        </div>
      ) : null}
      {error ? <p className="wake-notice-error" role="alert">{error}</p> : null}
    </div>
  );
}
