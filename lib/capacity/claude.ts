// Claude capacity from ~/.claude.json cachedUsageUtilization (read-only).
// Adapted from agent-dealer's local-cache reader; Botmancers-owned.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapacityWindow } from './types';
import { remainingPercentFromFraction, remainingPercentFromUsedPercent } from './types';

export const CLAUDE_CACHE_FILE_ENV = 'BOTMANCERS_CLAUDE_CACHE_FILE';

const FIVE_HOUR_LIMIT_NAMES = new Set([
  'five_hour',
  'five-hour',
  '5h',
  'session',
  'session_limit',
]);
const WEEKLY_LIMIT_NAMES = new Set([
  'seven_day',
  'seven-day',
  '7d',
  'weekly',
  'weekly_all',
  'weekly_all_models',
]);

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = asFiniteNumber(c);
    if (n !== null) return n;
  }
  return null;
}

function pickString(candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

function normalizeResetsAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeResetsAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function limitEntryRole(name: string): 'five_hour' | 'weekly' | null {
  const b = name.trim().toLowerCase();
  if (FIVE_HOUR_LIMIT_NAMES.has(b)) return 'five_hour';
  if (WEEKLY_LIMIT_NAMES.has(b)) return 'weekly';
  return null;
}

type Scale = { usedPercent: number | null; usedFraction: number | null };

function cacheEntryScale(entry: Record<string, unknown>): Scale | null {
  const usedPercent = pickNumber([
    entry.usedPercent,
    entry.used_percent,
    entry.utilizationPercent,
    entry.utilization_percent,
    entry.percent,
  ]);
  if (usedPercent !== null) {
    if (usedPercent < 0 || usedPercent > 100) return null;
    return { usedPercent, usedFraction: null };
  }
  const strictFraction = pickNumber([entry.usedFraction, entry.used_fraction]);
  if (strictFraction !== null) {
    if (strictFraction < 0 || strictFraction > 1) return null;
    return { usedPercent: null, usedFraction: strictFraction };
  }
  const usedValue = pickNumber([entry.utilization, entry.used]);
  if (usedValue === null) return null;
  if (usedValue < 0 || usedValue > 100) return null;
  if (usedValue <= 1) return { usedPercent: null, usedFraction: usedValue };
  return { usedPercent: usedValue, usedFraction: null };
}

function windowFromRole(
  role: 'five_hour' | 'weekly',
  entry: unknown,
  observedAt: string,
  observedMs: number
): CapacityWindow | null {
  let scale: Scale | null = null;
  let resetRaw: unknown = null;
  if (typeof entry === 'number') {
    const f = asFiniteNumber(entry);
    if (f === null || f < 0 || f > 1) return null;
    scale = { usedPercent: null, usedFraction: f };
  } else if (entry && typeof entry === 'object') {
    const w = entry as Record<string, unknown>;
    scale = cacheEntryScale(w);
    if (!scale) return null;
    resetRaw = w.resets_at ?? w.resetsAt ?? w.reset_at ?? w.resetAt ?? w.resetsAtMs ?? null;
  } else {
    return null;
  }
  const resetAt = normalizeResetsAt(resetRaw);
  if (resetAt !== null) {
    const resetMs = Date.parse(resetAt);
    if (!Number.isFinite(resetMs) || resetMs <= observedMs) return null;
  }
  const remaining =
    scale.usedPercent !== null
      ? remainingPercentFromUsedPercent(scale.usedPercent)
      : remainingPercentFromFraction(scale.usedFraction as number);
  return {
    windowKey: role === 'five_hour' ? 'claude_unified_five_hour' : 'claude_unified_seven_day',
    providerBucket: role === 'five_hour' ? 'five_hour' : 'seven_day',
    displayLabel: role === 'five_hour' ? '5H' : '1W',
    remainingPercent: remaining,
    resetAt,
    observedAt,
    source: 'observed_event',
    unavailableReason: null,
    criticalRole: role,
  };
}

/** Parse only the cachedUsageUtilization subtree into 5H/1W windows. */
export function parseClaudeCachedUtilization(raw: unknown, nowMs = Date.now()): CapacityWindow[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const fetchedAtMs = asFiniteNumber(root.fetchedAtMs);
  if (fetchedAtMs === null || fetchedAtMs <= 0 || fetchedAtMs > nowMs) return null;
  const observedAt = new Date(fetchedAtMs).toISOString();
  const utilization = root.utilization;
  if (!utilization || typeof utilization !== 'object' || Array.isArray(utilization)) return null;
  const u = utilization as Record<string, unknown>;
  const byRole = new Map<'five_hour' | 'weekly', CapacityWindow>();
  const consider = (role: 'five_hour' | 'weekly', entry: unknown) => {
    if (byRole.has(role)) return;
    const reading = windowFromRole(role, entry, observedAt, fetchedAtMs);
    if (reading) byRole.set(role, reading);
  };
  if (Array.isArray(u.limits)) {
    for (const item of u.limits) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const w = item as Record<string, unknown>;
      const name = pickString([w.name, w.window, w.bucket, w.key, w.id, w.kind, w.group]);
      if (!name) continue;
      const role = limitEntryRole(name);
      if (!role) continue;
      consider(role, item);
    }
  }
  if (!byRole.has('five_hour') && u.five_hour !== undefined) consider('five_hour', u.five_hour);
  if (!byRole.has('weekly') && u.seven_day !== undefined) consider('weekly', u.seven_day);
  return byRole.size > 0 ? [...byRole.values()] : null;
}

export function extractClaudeCacheSubtree(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const subtree = (parsed as Record<string, unknown>).cachedUsageUtilization;
  if (subtree && typeof subtree === 'object' && !Array.isArray(subtree)) return subtree;
  return parsed;
}

export function claudeCacheFilePath(): string {
  const override = process.env[CLAUDE_CACHE_FILE_ENV]?.trim();
  if (override) return override;
  return path.join(process.env.HOME ?? os.homedir(), '.claude.json');
}

/** Read-only Claude capacity from the local cache. Never throws. */
export function readClaudeCapacity(nowMs = Date.now()): CapacityWindow[] | null {
  let text: string;
  try {
    text = fs.readFileSync(claudeCacheFilePath(), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseClaudeCachedUtilization(extractClaudeCacheSubtree(parsed), nowMs);
}
