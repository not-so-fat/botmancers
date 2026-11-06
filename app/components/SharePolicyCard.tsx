'use client';

import { useEffect, useId, useState } from 'react';
import { audienceInputError, audienceLabel, shareFromTurnNote, type SharePolicy, type SlackAudience } from '@/lib/share-view';

// NOT-519: Session sharing on Agent Config. The owner's explicit
// share_from_turn toggle for this agent and the Slack channel allowlist
// every share must use (config/session-shares.json, through PUT
// /api/bots/:id/share-policy). Each change is sent with the revision it was
// made on, validated whole by the server before anything is written, and
// refused if the document changed meanwhile (reload and retry). Turning the
// toggle off revokes the agent's live turn contexts at once.
type Phase = 'idle' | 'saving' | 'error';

export default function SharePolicyCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const toggleId = useId();
  const teamId = useId();
  const channelId = useId();
  const [policy, setPolicy] = useState<SharePolicy | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [team, setTeam] = useState('');
  const [channel, setChannel] = useState('');
  const [inputError, setInputError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bots/${encodeURIComponent(agentId)}/share-policy`, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.policy) setLoadError('Could not load the share policy.');
        else {
          setLoadError('');
          setPolicy(body.policy as SharePolicy);
        }
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load the share policy.'); });
    return () => { cancelled = true; };
  }, [agentId, attempt]);

  const reload = () => {
    setError('');
    setPhase('idle');
    setAttempt(n => n + 1);
  };

  const apply = async (change: { share_from_turn?: boolean; audiences?: SlackAudience[] }, done: (revoked: number) => string) => {
    if (!policy) return false;
    setPhase('saving');
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/bots/${encodeURIComponent(agentId)}/share-policy`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: policy.revision, ...change }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.policy) {
        setPhase('error');
        setError(typeof body?.error?.message === 'string' ? body.error.message : 'The share policy could not be saved.');
        return false;
      }
      setPolicy(body.policy as SharePolicy);
      setPhase('idle');
      setNotice(done(typeof body.revoked_contexts === 'number' ? body.revoked_contexts : 0));
      return true;
    } catch {
      setPhase('error');
      setError('The share policy could not be saved.');
      return false;
    }
  };

  const addAudience = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policy) return;
    const problem = audienceInputError(team, channel, policy.audiences);
    setInputError(problem ?? '');
    if (problem) return;
    const entry: SlackAudience = { kind: 'slack', team_id: team.trim(), channel_id: channel.trim() };
    if (await apply({ audiences: [...policy.audiences, entry] }, () => `Added ${audienceLabel(entry)}.`)) {
      setTeam('');
      setChannel('');
    }
  };

  const removeAudience = (entry: SlackAudience) => {
    if (!policy) return;
    void apply(
      { audiences: policy.audiences.filter(a => !(a.team_id === entry.team_id && a.channel_id === entry.channel_id)) },
      () => `Removed ${audienceLabel(entry)}. Its Slack threads stop being answered.`,
    );
  };

  const saving = phase === 'saving';
  const editable = !!policy && policy.state !== 'invalid';
  return (
    <section className="cfg-card share-policy" id="session-sharing" aria-labelledby="cfg-sharing-title">
      <div className="flex items-center justify-between mb-3">
        <h2 id="cfg-sharing-title" className="cfg-title">Session sharing</h2>
        {saving ? <span className="text-sm cfg-faint" role="status">Saving…</span> : null}
      </div>
      <p className="text-sm cfg-muted mb-3">
        A share lets people in one Slack channel ask one of {agentName}’s sessions questions, read-only, until it expires or you revoke it.
        Create and revoke shares from Sessions.
      </p>
      {loadError ? (
        <p className="text-sm cfg-error" role="alert">
          {loadError}{' '}
          <button type="button" onClick={reload} className="underline hover:no-underline">Retry</button>
        </p>
      ) : null}
      {!policy && !loadError ? <p className="text-sm cfg-faint" role="status">Loading…</p> : null}
      {policy?.state === 'invalid' ? (
        <p className="text-sm cfg-error mb-3" role="alert">
          The share policy file is invalid, so nothing can be shared: {policy.reason} Fix or remove config/session-shares.json, then{' '}
          <button type="button" onClick={reload} className="underline hover:no-underline">reload</button>.
        </p>
      ) : null}
      {policy ? (
        <>
          <div className="share-policy-toggle">
            <input
              id={toggleId}
              type="checkbox"
              role="switch"
              checked={policy.agent.share_from_turn}
              aria-checked={policy.agent.share_from_turn}
              disabled={!editable || saving || (!policy.agent.share_current.supported && !policy.agent.share_from_turn)}
              data-share-policy="share_from_turn"
              onChange={e => {
                const on = e.target.checked;
                void apply({ share_from_turn: on }, revoked => on
                  ? 'Share from a turn is on.'
                  : `Share from a turn is off.${revoked ? ` Revoked ${revoked} live turn context${revoked === 1 ? '' : 's'}.` : ''}`);
              }}
            />
            <label htmlFor={toggleId} className="text-sm">
              <span className="font-medium">Share from a turn</span> (<code className="cfg-code">share_from_turn</code>)
            </label>
          </div>
          <p className="text-sm cfg-faint share-policy-hint">{shareFromTurnNote(policy)}</p>
          {policy.agent.live_contexts > 0 ? (
            <p className="text-sm cfg-faint share-policy-hint">{policy.agent.live_contexts} live turn context{policy.agent.live_contexts === 1 ? '' : 's'} now.</p>
          ) : null}

          <h3 className="cfg-title share-policy-sub">Slack channel allowlist</h3>
          <p className="text-sm cfg-faint">Every Agent’s shares use this list. A share can only go to a channel on it.</p>
          {policy.audiences.length === 0 ? (
            <p className="text-sm cfg-muted share-policy-empty">No channel yet: nothing can be shared to Slack.</p>
          ) : (
            <ul className="share-policy-list" aria-label="Allowed Slack channels">
              {policy.audiences.map(entry => (
                <li key={`${entry.team_id}:${entry.channel_id}`} className="share-policy-entry">
                  <span className="cfg-code">{entry.channel_id}</span>
                  <span className="cfg-faint">workspace {entry.team_id}</span>
                  <button
                    type="button"
                    className="cfg-link text-sm share-policy-remove"
                    disabled={!editable || saving}
                    aria-label={`Remove ${audienceLabel(entry)}`}
                    onClick={() => removeAudience(entry)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="share-policy-add" onSubmit={e => { void addAudience(e); }} aria-label="Add a Slack channel">
            <div>
              <label htmlFor={teamId} className="text-sm">Workspace ID</label>
              <input id={teamId} className="cfg-input" value={team} placeholder="T0123ABCD" autoComplete="off" spellCheck={false}
                disabled={!editable || saving} aria-invalid={!!inputError} onChange={e => { setTeam(e.target.value); setInputError(''); }} />
            </div>
            <div>
              <label htmlFor={channelId} className="text-sm">Channel ID</label>
              <input id={channelId} className="cfg-input" value={channel} placeholder="C0123ABCD" autoComplete="off" spellCheck={false}
                disabled={!editable || saving} aria-invalid={!!inputError} onChange={e => { setChannel(e.target.value); setInputError(''); }} />
            </div>
            <button type="submit" className="cfg-btn-primary text-sm" disabled={!editable || saving || !team.trim() || !channel.trim()}>Add channel</button>
          </form>
          {inputError ? <p className="mt-2 text-sm cfg-error" role="alert">{inputError}</p> : null}
          {phase === 'error' ? (
            <p className="mt-2 text-sm cfg-error" role="alert">
              Couldn&apos;t save: {error}{' '}
              <button type="button" onClick={reload} className="underline hover:no-underline">Reload</button>
            </p>
          ) : null}
          <p className="mt-2 text-sm cfg-ok" role="status">{notice}</p>
        </>
      ) : null}
    </section>
  );
}
