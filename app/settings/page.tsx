'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AGENT_OPTIONS, formatClock } from '@/lib/bot-runtime-ui';

interface AvailabilityEntry {
  agent: string;
  label: string;
  launchable: boolean;
}

// NOT-543: workspace settings. Every Agent launches direct from its own
// runtime connection: there is no server URL and no deck. This page
// reports what the local launch probe sees right now (Hermes: gateway
// configured; coding Agents: provider CLI installed), so a missing
// runtime is visible before an Agent tries to use it.
export default function SettingsPage() {
  const [ready, setReady] = useState<Set<string> | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/bots/availability', { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error('request failed');
        const body = (await res.json()) as { agents?: AvailabilityEntry[] };
        if (cancelled) return;
        const agents = Array.isArray(body.agents) ? body.agents : null;
        if (!agents) throw new Error('request failed');
        setReady(new Set(agents.filter(entry => entry.launchable).map(entry => entry.agent)));
        setCheckedAt(Date.now());
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <div className="cfg-page">
      <div className="max-w-3xl mx-auto">
        <Link href="/" className="cfg-link cfg-back text-sm">
          ← Back to chat
        </Link>
        <header className="mt-3 mb-6">
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-sm cfg-faint">Local runtime status for every agent in this Botmancers.</p>
        </header>

        <section className="cfg-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="cfg-title">Local runtimes</h2>
            {ready !== null ? (
              <span className="text-sm cfg-faint">Checked {formatClock(checkedAt)}</span>
            ) : null}
          </div>
          {loadFailed && ready === null ? (
            <p className="text-sm cfg-muted">
              Couldn&apos;t check the local runtimes.{' '}
              <button onClick={() => setReloadToken(token => token + 1)} className="cfg-link">
                Retry
              </button>
            </p>
          ) : ready === null ? (
            <div className="h-10 rounded-lg animate-pulse cfg-skel" />
          ) : (
            <>
              <dl className="text-sm">
                {AGENT_OPTIONS.map(option => {
                  const available = ready.has(option.value);
                  return (
                    <div key={option.value} className="flex justify-between gap-4 py-1 border-t cfg-line">
                      <dt className="cfg-muted">{option.label}</dt>
                      <dd className={available ? 'cfg-ok' : 'cfg-faint'}>
                        {available ? '● Ready' : '○ Not available'}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p className="mt-2 text-xs cfg-faint">
                Coding Agents need their provider CLI installed and signed in on this computer;
                Hermes needs the gateway key. A runtime that is not available here cannot launch
                an Agent until it is fixed.
              </p>
              <button
                onClick={() => setReloadToken(token => token + 1)}
                className="mt-3 cfg-btn-ghost text-sm w-full sm:w-auto"
              >
                Re-check
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
