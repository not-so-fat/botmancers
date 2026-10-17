'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  detailsHref,
  excerpt,
  failureAdvice,
  formatExchangeTime,
  instructionHeading,
  liveStateLabel,
  modeLabel,
  outcomeLine,
  participantsLabel,
  sessionLabel,
  stateTone,
  type ExchangeSummary,
} from '@/lib/exchange-view';

// NOT-498: one session-targeted Ask or Continue as a typed inline status
// card, the same card (by exchange id) in every linked thread. Everything
// shown comes from the exchange summary (lib/exchange-ledger), never from
// message prose. Cancel appears only while the API allows it.
export default function ExchangeCard({ summary, onChanged }: {
  summary: ExchangeSummary;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tone = stateTone(summary.state);
  const outcome = outcomeLine(summary);
  const advice = failureAdvice(summary);
  const titleId = `exchange-${summary.id}-title`;

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/exchanges/${encodeURIComponent(summary.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(typeof body?.error?.message === 'string' ? body.error.message : 'Could not cancel. Try again.');
      }
    } catch {
      setError('Could not cancel. Try again.');
    } finally {
      setBusy(false);
      onChanged?.();
    }
  };

  return (
    <article
      id={`exchange-${summary.id}`}
      className={`exchange-card is-${tone} is-${summary.state}`}
      data-exchange-id={summary.id}
      data-exchange-state={summary.state}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <p className="exchange-card-line">
        <span className="exchange-card-mode">{modeLabel(summary.mode)}</span>
        <span id={titleId} className="exchange-card-title">{participantsLabel(summary)}</span>
        <span className="exchange-card-state" role="status">{liveStateLabel(summary)}</span>
      </p>
      <p className="exchange-card-session">{sessionLabel(summary)}</p>
      <p className="exchange-card-instruction">
        <span className="exchange-card-key">{instructionHeading(summary.mode)}</span> {excerpt(summary.instruction, 220)}
      </p>
      {outcome ? <p className={summary.state === 'failed' ? 'exchange-card-outcome is-failure' : 'exchange-card-outcome'}>{outcome}</p> : null}
      {advice ? <p className="exchange-card-advice">{advice}</p> : null}
      {error ? <p className="exchange-card-error" role="alert">{error}</p> : null}
      <p className="exchange-card-foot">
        <span className="exchange-card-time">Updated {formatExchangeTime(summary.updated_at)}</span>
        <Link className="exchange-card-link" href={detailsHref(summary.id)} aria-label={`Details: ${modeLabel(summary.mode)} ${participantsLabel(summary)}`}>
          Details
        </Link>
        {summary.can_cancel ? (
          <button type="button" className="exchange-card-cancel" disabled={busy} onClick={() => { void cancel(); }}>
            {busy ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
      </p>
    </article>
  );
}
