// Compact chip selection for Agent shell — Claude/Codex/Muse: tagged 5H+1W;
// Cursor: billing_cycle as 1M. Inspired by agent-dealer TopBar/Strip selection.

import type {
  CapacityCriticalRole,
  CapacityUnavailableReason,
  CapacityWindow,
  RuntimeCapacityEntry,
} from './types';

export type CapacitySeverity = 'critical' | 'warning' | 'normal';

export type CapacityChip =
  | { key: string; label: string; kind: 'known'; remaining: number; rawRemaining: number; title: string }
  | { key: string; label: string; kind: 'unknown'; reason: CapacityUnavailableReason; title: string };

const REASON_TEXT: Record<CapacityUnavailableReason, string> = {
  unsupported: 'not reported by provider',
  missing: 'no data yet',
  expired: 'expired',
  unparsable: 'provider data unparsable',
  stale: 'stale',
};

const PAIR_RUNTIMES = new Set(['claude', 'codex', 'muse']);
const CURSOR_BILLING_WINDOW_KEY = 'billing_cycle';
const FIVE_HOUR_LABEL = '5H';
const WEEKLY_LABEL = '1W';
const CURSOR_BILLING_LABEL = '1M';

export function capacitySeverity(rawRemaining: number): CapacitySeverity {
  if (rawRemaining < 10) return 'critical';
  if (rawRemaining < 30) return 'warning';
  return 'normal';
}

function knownChip(w: CapacityWindow, label: string): CapacityChip {
  const raw = w.remainingPercent ?? 0;
  const remaining = Math.round(raw);
  const reset = w.resetAt ? `, resets ${new Date(w.resetAt).toLocaleString()}` : '';
  return {
    key: w.windowKey,
    label,
    kind: 'known',
    remaining,
    rawRemaining: raw,
    title: `${label}: ${remaining}% remaining${reset}`,
  };
}

function unknownChip(
  key: string,
  label: string,
  reason: CapacityUnavailableReason
): CapacityChip {
  return {
    key,
    label,
    kind: 'unknown',
    reason,
    title: `${label}: N/A (${REASON_TEXT[reason]})`,
  };
}

function pairChip(
  windows: CapacityWindow[],
  role: CapacityCriticalRole,
  label: string,
  entryReason: CapacityUnavailableReason | null
): CapacityChip {
  const w = windows.find(row => row.criticalRole === role) ?? null;
  if (w && w.unavailableReason === null && w.remainingPercent !== null) {
    return knownChip(w, label);
  }
  if (w?.unavailableReason) {
    return unknownChip(w.windowKey, label, w.unavailableReason);
  }
  return unknownChip(`missing-${label}`, label, entryReason ?? 'missing');
}

/** Select the compact chips for one runtime entry. */
export function selectCapacityChips(entry: RuntimeCapacityEntry): CapacityChip[] {
  if (entry.runtime === 'cursor') {
    const billing = entry.windows.find(w => w.windowKey === CURSOR_BILLING_WINDOW_KEY) ?? null;
    if (billing && billing.unavailableReason === null && billing.remainingPercent !== null) {
      return [knownChip(billing, CURSOR_BILLING_LABEL)];
    }
    if (billing?.unavailableReason) {
      return [unknownChip(billing.windowKey, CURSOR_BILLING_LABEL, billing.unavailableReason)];
    }
    return [unknownChip('missing-1M', CURSOR_BILLING_LABEL, entry.unavailableReason ?? 'missing')];
  }
  if (PAIR_RUNTIMES.has(entry.runtime)) {
    return [
      pairChip(entry.windows, 'five_hour', FIVE_HOUR_LABEL, entry.unavailableReason),
      pairChip(entry.windows, 'weekly', WEEKLY_LABEL, entry.unavailableReason),
    ];
  }
  return [];
}
