// Botmancers-owned runtime capacity contract (inspired by agent-dealer NOT-245,
// reimplemented here — no shared dependency).

export type CapacityRuntime = 'claude' | 'codex' | 'cursor' | 'muse';

export type CapacityUnavailableReason =
  | 'unsupported'
  | 'missing'
  | 'expired'
  | 'unparsable'
  | 'stale';

export type CapacityCriticalRole = 'five_hour' | 'weekly';

export type CapacitySource =
  | 'supported_protocol'
  | 'observed_event'
  | 'experimental_api'
  | 'unavailable';

export interface CapacityWindow {
  windowKey: string;
  providerBucket: string;
  displayLabel: string;
  remainingPercent: number | null;
  resetAt: string | null;
  observedAt: string;
  source: CapacitySource;
  unavailableReason: CapacityUnavailableReason | null;
  criticalRole: CapacityCriticalRole | null;
}

export interface RuntimeCapacityEntry {
  runtime: CapacityRuntime;
  windows: CapacityWindow[];
  unavailableReason: CapacityUnavailableReason | null;
}

export interface RuntimeCapacityResponse {
  runtimes: RuntimeCapacityEntry[];
  observedAt: string;
}

export const CAPACITY_RUNTIMES: CapacityRuntime[] = ['claude', 'codex', 'cursor', 'muse'];

export function isCapacityRuntime(value: string): value is CapacityRuntime {
  return (CAPACITY_RUNTIMES as readonly string[]).includes(value);
}

export function remainingPercentFromUsedPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function remainingPercentFromFraction(usedFraction: number): number {
  return remainingPercentFromUsedPercent(usedFraction * 100);
}
