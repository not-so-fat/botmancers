'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import type { SessionRow } from '@/lib/session-view';
import {
  FULL_ACCESS_NOTE,
  SHARE_DURATIONS,
  SHARE_OPEN_CLI_NOTE,
  SHARE_STATUS_LABELS,
  audienceLabel,
  createdByLabel,
  expiryLabel,
  sessionShares,
  shareCreateAvailability,
  shareCreateBody,
  shareIsLive,
  shareStatusNote,
  threadLabel,
  turnsLabel,
  type OwnerShare,
  type SharePolicy,
  type ShareToolAccess,
} from '@/lib/share-view';

// NOT-519: the Slack share section of one Sessions row. Shows the
// session's shares (state, expiry, questions used, audience, thread) with
// Copy reference and Revoke, and Share to Slack when the session can take an
// Ask and the owner's allowlist names a channel (lib/share-view). A share is
// one read-only Ask on exactly this session; nothing here shows a provider
// id, workspace, or token.
const ENDED_SHOWN = 3;

function newKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `owner-share-${crypto.randomUUID()}`
    : `owner-share-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function SessionShares({ row, shares, policy, onChanged }: {
  row: SessionRow;
  shares: OwnerShare[] | null;
  // 'loading' until the first answer; null when it could not be loaded.
  policy: SharePolicy | 'loading' | null;
  onChanged: () => void;
}) {
  const headingId = useId();
  const [creating, setCreating] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const mine = shares ? sessionShares(shares, row.ref) : [];
  const live = mine.filter(shareIsLive);
  const ended = mine.filter(share => !shareIsLive(share));
  const loadingPolicy = policy === 'loading';
  const loaded = policy === 'loading' ? null : policy;
  const availability = loadingPolicy ? null : shareCreateAvailability(row, loaded);
  const visibleEnded = showEnded ? ended : ended.slice(0, live.length ? 0 : ENDED_SHOWN);
  // NOT-610: the form (and its open-CLI helper) shows only while sharing is
  // available. A refresh that makes the session busy or ended, or empties the
  // allowlist, closes it rather than leaving it under the unavailable reason.
  const unavailable = availability !== null && !availability.available;
  const formOpen = creating && loaded !== null && availability?.available === true;
  if (creating && unavailable) setCreating(false);
  return (
    <section className="session-shares" aria-labelledby={headingId} data-session-shares={row.ref}>
      <div className="session-shares-head">
        <h3 id={headingId} className="session-shares-title">Slack share</h3>
        {availability?.available && !creating ? (
          <button type="button" className="session-action" data-share-action="create" onClick={() => setCreating(true)}>
            Share to Slack
          </button>
        ) : null}
      </div>
      {loadingPolicy ? <p className="session-share-note session-share-loading" role="status">Checking the share policy…</p> : null}
      {availability && !availability.available ? (
        <p className="session-share-unavailable">
          {availability.reason}{' '}
          {availability.configHref ? <Link className="session-link" href={availability.configHref}>Open Config</Link> : null}
        </p>
      ) : null}
      {formOpen && loaded ? (
        <ShareCreateForm row={row} policy={loaded} onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); onChanged(); }} />
      ) : null}
      {shares === null ? <p className="session-share-note" role="status">Loading shares…</p> : null}
      {shares !== null && mine.length === 0 && !formOpen ? <p className="session-share-note">Not shared.</p> : null}
      {live.length + visibleEnded.length > 0 ? (
        <ul className="session-share-list" aria-label={`Slack shares of ${row.title}`}>
          {[...live, ...visibleEnded].map(share => <ShareItem key={share.share_ref} share={share} onChanged={onChanged} />)}
        </ul>
      ) : null}
      {ended.length > visibleEnded.length ? (
        <button type="button" className="pin-word" onClick={() => setShowEnded(true)}>
          Show {ended.length - visibleEnded.length} ended share{ended.length - visibleEnded.length === 1 ? '' : 's'}
        </button>
      ) : null}
    </section>
  );
}

function ShareItem({ share, onChanged }: { share: OwnerShare; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const live = shareIsLive(share);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share.share_ref);
      setCopied(true);
    } catch {
      setError('Copy failed. Select the reference instead.');
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(share.share_ref)}/revoke`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(typeof body?.error?.message === 'string' ? body.error.message : 'The share could not be revoked.');
      else {
        setConfirming(false);
        onChanged();
      }
    } catch {
      setError('The share could not be revoked.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`session-share is-${share.status}`} data-share-ref={share.share_ref} data-share-status={share.status}>
      <div className="session-share-head">
        <span className={`manage-tag session-share-status is-${share.status}`}>{SHARE_STATUS_LABELS[share.status]}</span>
        <span className="session-share-audience">{audienceLabel(share.audience)}</span>
      </div>
      <dl className="manage-meta session-share-meta">
        <div><dt>Expiry</dt><dd>{expiryLabel(share)}</dd></div>
        <div><dt>Questions</dt><dd>{turnsLabel(share)}</dd></div>
        <div><dt>Thread</dt><dd>{threadLabel(share)}</dd></div>
        <div><dt>Reference</dt><dd><code className="session-share-ref">{share.share_ref}</code></dd></div>
        <div><dt>Origin</dt><dd>{createdByLabel(share)} · Ask</dd></div>
        <div><dt>Tool access</dt><dd data-share-tool-access={share.tool_access}>{share.tool_access === 'full_access' ? 'Full access: edits, shell, network' : 'Read only'}</dd></div>
      </dl>
      <p className="session-share-note">{shareStatusNote(share)}</p>
      <div className="session-actions" role="group" aria-label="Share actions">
        <button type="button" className="pin-word" data-share-action="copy" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy reference'}</button>
        {live && !confirming ? (
          <button type="button" className="session-action session-share-revoke" data-share-action="revoke" onClick={() => setConfirming(true)}>Revoke</button>
        ) : null}
      </div>
      {confirming ? (
        <div className="session-share-confirm" role="group" aria-label="Confirm revoke">
          <p>Revoke this share? The next Slack question in its thread gets the revoked notice. This can’t be undone.</p>
          <div className="session-actions">
            <button type="button" className="session-action session-share-revoke" data-share-action="confirm-revoke" disabled={busy} onClick={() => { void revoke(); }}>
              {busy ? 'Revoking…' : 'Revoke share'}
            </button>
            <button type="button" className="pin-word" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="delete-error" role="alert">{error}</p> : null}
    </li>
  );
}

export function ShareCreateForm({ row, policy, onCancel, onCreated }: { row: SessionRow; policy: SharePolicy; onCancel: () => void; onCreated: () => void }) {
  const ids = { channel: useId(), duration: useId(), turns: useId(), access: useId() };
  const [audience, setAudience] = useState(0);
  const [toolAccess, setToolAccess] = useState<ShareToolAccess>('read_only');
  const fullAccess = policy.agent.full_access;
  const [ttl, setTtl] = useState(policy.limits.ttl_seconds.default);
  const [turns, setTurns] = useState(String(policy.limits.max_turns.default));
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const turnsValue = Number(turns);
  const turnsValid = Number.isInteger(turnsValue) && turnsValue >= policy.limits.max_turns.min && turnsValue <= policy.limits.max_turns.max;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!turnsValid) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/bots/${encodeURIComponent(row.agent.id)}/sessions/${encodeURIComponent(row.ref)}/shares`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(shareCreateBody(policy.audiences[audience], ttl, turnsValue, key, toolAccess)),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(typeof body?.error?.message === 'string' ? body.error.message : 'The share could not be created.');
      else onCreated();
    } catch {
      setError('The share could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="session-share-form" onSubmit={e => { void submit(e); }} aria-label={`Share ${row.title} to Slack`}>
      <p className="session-share-note">
        Shares <strong>{row.title}</strong> ({row.agent.name}) as an Ask: Slack replies in the share’s thread ask exactly this session.
      </p>
      <p className="session-share-note" data-share-note="open-cli">{SHARE_OPEN_CLI_NOTE}</p>
      <label htmlFor={ids.channel}>Slack channel</label>
      <select id={ids.channel} value={audience} onChange={e => setAudience(Number(e.target.value))} disabled={busy}>
        {policy.audiences.map((entry, i) => <option key={`${entry.team_id}:${entry.channel_id}`} value={i}>{audienceLabel(entry)}</option>)}
      </select>
      <label htmlFor={ids.duration}>Expires after</label>
      <select id={ids.duration} value={ttl} onChange={e => setTtl(Number(e.target.value))} disabled={busy}>
        {SHARE_DURATIONS.map(option => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
      </select>
      <label htmlFor={ids.turns}>Questions allowed</label>
      <input
        id={ids.turns} type="number" inputMode="numeric" min={policy.limits.max_turns.min} max={policy.limits.max_turns.max}
        value={turns} onChange={e => setTurns(e.target.value)} disabled={busy} aria-invalid={!turnsValid}
      />
      <fieldset className="session-share-access" disabled={busy}>
        <legend id={ids.access}>Tool access</legend>
        {(['read_only', 'full_access'] as const).map(value => (
          <label key={value}>
            <input
              type="radio" name={ids.access} value={value} checked={toolAccess === value}
              disabled={value === 'full_access' && !fullAccess.supported}
              onChange={() => setToolAccess(value)} data-share-tool-access={value}
            />
            {value === 'read_only' ? ' Read only: it can read files and answer' : ' Full access: it can edit files, run shell commands, and use the network'}
          </label>
        ))}
        {!fullAccess.supported && fullAccess.reason ? <p className="session-share-note">{fullAccess.reason}</p> : null}
        {toolAccess === 'full_access' ? <p className="session-share-note session-share-warning" role="note" data-share-note="full-access">{FULL_ACCESS_NOTE}</p> : null}
      </fieldset>
      {!turnsValid ? <p className="delete-error">Questions allowed must be a whole number from {policy.limits.max_turns.min} to {policy.limits.max_turns.max}.</p> : null}
      {error ? <p className="delete-error" role="alert">{error}</p> : null}
      <div className="session-actions">
        <button type="submit" className="session-action" data-share-action="submit" disabled={busy || !turnsValid}>{busy ? 'Sharing…' : 'Create share'}</button>
        <button type="button" className="pin-word" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
