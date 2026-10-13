'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SettingsStatus } from '@/app/components/AgentDeckRuntime';
import { useDeckList } from '@/app/components/useDeckList';
import { SETTINGS_ENDPOINT, formatClock } from '@/lib/bot-runtime-ui';

type Phase = 'clean' | 'saving' | 'confirmed' | 'error';

async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // keep default reason
  }
  return 'request failed';
}

export default function SettingsPage() {
  const { state: deckState, retry: retryDecks } = useDeckList();
  const [stored, setStored] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [phase, setPhase] = useState<Phase>('clean');
  const [error, setError] = useState('');
  const [confirmedAt, setConfirmedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(SETTINGS_ENDPOINT, { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(await errorReason(res));
        const body = (await res.json()) as { server_url?: string };
        if (cancelled) return;
        const url = typeof body.server_url === 'string' ? body.server_url : '';
        setStored(url);
        setDraft(url);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const dirty = stored !== null && draft !== stored;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function save(): Promise<void> {
    setPhase('saving');
    setError('');
    try {
      const res = await fetch(SETTINGS_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_url: draft }),
      });
      if (!res.ok) throw new Error(await errorReason(res));
      const body = (await res.json()) as { server_url: string };
      setStored(body.server_url);
      setDraft(body.server_url);
      setPhase('confirmed');
      setConfirmedAt(Date.now());
      setTimeout(() => {
        setPhase(current => (current === 'confirmed' ? 'clean' : current));
      }, 5000);
      retryDecks();
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'request failed');
    }
  }

  function discard(): void {
    setDraft(stored ?? '');
    setPhase('clean');
    setError('');
  }

  function confirmLeave(e: React.MouseEvent): void {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) {
      e.preventDefault();
    }
  }

  const stateLine =
    phase === 'saving' ? (
      <span className="text-sm cfg-faint">Saving…</span>
    ) : dirty || phase === 'error' ? (
      <span className="text-sm cfg-dirty">
        <span className="inline-block w-2 h-2 rounded-full cfg-dot-amber mr-1" />
        Unsaved changes
      </span>
    ) : phase === 'confirmed' ? (
      <span className="text-sm cfg-faint">Saved {formatClock(confirmedAt)}</span>
    ) : (
      <span className="text-sm cfg-faint">Saved</span>
    );

  return (
    <div className="cfg-page">
      <div className="max-w-3xl mx-auto">
        <Link href="/" onClick={confirmLeave} className="cfg-link cfg-back text-sm">
          ← Back to chat
        </Link>
        <header className="mt-3 mb-6">
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-sm cfg-faint">Workspace settings for every bot in this Botmancers.</p>
        </header>

        <section className="cfg-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="cfg-title">Agent Deck server</h2>
            {stored !== null ? stateLine : null}
          </div>
          {loadFailed && stored === null ? (
            <p className="text-sm cfg-muted">
              Couldn&apos;t load this section.{' '}
              <button onClick={() => setReloadToken(token => token + 1)} className="cfg-link">
                Retry
              </button>
            </p>
          ) : stored === null ? (
            <div className="h-10 rounded-lg animate-pulse cfg-skel" />
          ) : (
            <>
              <label className="block text-sm cfg-muted mb-1" htmlFor="settings-server-url">
                Server URL
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="settings-server-url"
                  type="url"
                  value={draft}
                  onChange={e => {
                    setDraft(e.target.value);
                    if (phase === 'error') setPhase('clean');
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && dirty) {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  placeholder="http://127.0.0.1:1111"
                  className="cfg-input text-sm sm:flex-1"
                />
                <button
                  onClick={() => { void save(); }}
                  disabled={!dirty || phase === 'saving'}
                  className="cfg-btn-primary text-sm"
                >
                  {phase === 'saving' ? 'Saving…' : 'Save'}
                </button>
                {dirty ? (
                  <button onClick={discard} disabled={phase === 'saving'} className="cfg-btn-ghost text-sm">
                    Discard
                  </button>
                ) : null}
              </div>
              {phase === 'error' && (
                <p className="mt-2 text-sm cfg-error">
                  Couldn&apos;t save: {error}{' '}
                  <button onClick={() => { void save(); }} className="underline hover:no-underline">
                    Retry
                  </button>
                </p>
              )}
              <p className="mt-2 text-xs cfg-faint">
                The only Agent Deck server for this workspace. Bots pick their deck from this server.
              </p>
            </>
          )}
          <div className="mt-4 pt-4 border-t cfg-line">
            <SettingsStatus state={deckState} onRetry={retryDecks} />
          </div>
        </section>
      </div>
    </div>
  );
}
