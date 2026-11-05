'use client';

// Machine-wide capacity strip for the Agent workspace top bar (Dealer-style).
// One block per configured coding harness: logo + 5H/1W or 1M chips.

import { useEffect, useState } from 'react';
import { HarnessIcon } from '@/app/components/HarnessIcon';
import { agentLabel } from '@/lib/bot-definition';
import { capacitySeverity, selectCapacityChips, type CapacityChip } from '@/lib/capacity/present';
import type { RuntimeCapacityEntry, RuntimeCapacityResponse } from '@/lib/capacity/types';

type TopBarState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: RuntimeCapacityResponse };

function WindowRow({ row }: { row: CapacityChip }) {
  if (row.kind === 'unknown') {
    return (
      <span className="topbar-capacity-window is-unknown" data-window={row.label} data-window-known="false" title={row.title}>
        <span className="topbar-capacity-window-label">{row.label}</span>
        <span>N/A</span>
      </span>
    );
  }
  const severity = capacitySeverity(row.rawRemaining);
  return (
    <span
      className={`topbar-capacity-window is-${severity}`}
      data-window={row.label}
      data-window-known="true"
      data-severity={severity}
      title={row.title}
    >
      <span className="topbar-capacity-window-label">{row.label}</span>
      <span>{row.remaining}%</span>
    </span>
  );
}

function RuntimeBlock({ entry }: { entry: RuntimeCapacityEntry }) {
  const chips = selectCapacityChips(entry);
  const known = chips.some(chip => chip.kind === 'known');
  const exhausted = chips.some(chip => chip.kind === 'known' && chip.rawRemaining === 0);
  const label = agentLabel(entry.runtime) || entry.runtime;
  return (
    <span
      className={exhausted ? 'topbar-capacity-runtime is-exhausted' : 'topbar-capacity-runtime'}
      data-testid={`topbar-capacity-${entry.runtime}`}
      data-known={known ? 'true' : 'false'}
      data-exhausted={exhausted ? 'true' : 'false'}
      role="group"
      aria-label={`${label} capacity`}
      title={chips.map(chip => chip.title).join('; ') || `${label}: N/A`}
    >
      <HarnessIcon agent={entry.runtime} size={16} />
      {chips.length === 0 ? (
        <span className="topbar-capacity-window is-unknown">N/A</span>
      ) : (
        <span className="topbar-capacity-windows">
          {chips.map(chip => (
            <WindowRow key={chip.key} row={chip} />
          ))}
        </span>
      )}
    </span>
  );
}

export function TopBarCapacityView({ state }: { state: TopBarState }) {
  if (state.status === 'loading') {
    return (
      <div className="topbar-capacity" data-testid="topbar-capacity" data-status="loading" title="Runtime capacity is loading">
        <span className="topbar-capacity-eyebrow">Capacity</span>
        <span aria-live="polite">loading…</span>
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div className="topbar-capacity" data-testid="topbar-capacity" data-status="unavailable" title="Runtime capacity is unavailable">
        <span className="topbar-capacity-eyebrow">Capacity</span>
        <span>unavailable</span>
      </div>
    );
  }
  const entries = state.data.runtimes;
  const allUnknown = entries.length === 0 || entries.every(entry => !selectCapacityChips(entry).some(chip => chip.kind === 'known'));
  return (
    <div
      className="topbar-capacity"
      data-testid="topbar-capacity"
      data-status={allUnknown ? 'unknown' : 'ready'}
      title={entries.length === 0 ? 'No coding harness capacity reported' : undefined}
    >
      <span className="topbar-capacity-eyebrow">Capacity</span>
      {entries.length === 0 ? (
        <span className="topbar-capacity-empty">N/A</span>
      ) : (
        entries.map(entry => <RuntimeBlock key={entry.runtime} entry={entry} />)
      )}
    </div>
  );
}

/** Self-loading machine-wide capacity strip for the Agent workspace. */
export default function TopBarCapacity({ refreshMs = 60_000 }: { refreshMs?: number }) {
  const [state, setState] = useState<TopBarState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/runtime-capacity', { cache: 'no-store' })
        .then(async response => {
          if (!response.ok) throw new Error('capacity request failed');
          return response.json() as Promise<RuntimeCapacityResponse>;
        })
        .then(data => {
          if (!cancelled) setState({ status: 'ready', data });
        })
        .catch(() => {
          if (!cancelled) setState({ status: 'unavailable' });
        });
    };
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshMs]);

  return <TopBarCapacityView state={state} />;
}
