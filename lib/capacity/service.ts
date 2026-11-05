// Machine-wide runtime capacity read model for configured Agents.
// One entry per coding harness account (claude|codex|cursor|muse), not per Agent profile.

import { bots } from '../db';
import type { BotAgent } from '../bot-definition';
import { readClaudeCapacity } from './claude';
import { readCodexCapacity } from './codex';
import { readCursorCapacity } from './cursor';
import type {
  CapacityRuntime,
  CapacityUnavailableReason,
  CapacityWindow,
  RuntimeCapacityEntry,
  RuntimeCapacityResponse,
} from './types';
import { CAPACITY_RUNTIMES, isCapacityRuntime } from './types';

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: RuntimeCapacityResponse } | null = null;

function configuredCapacityRuntimes(): CapacityRuntime[] {
  const seen = new Set<CapacityRuntime>();
  for (const bot of bots.getAll()) {
    const agent = String(bot.agent ?? '') as BotAgent;
    if (isCapacityRuntime(agent)) seen.add(agent);
  }
  return CAPACITY_RUNTIMES.filter(id => seen.has(id));
}

function entryFor(
  runtime: CapacityRuntime,
  windows: CapacityWindow[] | null,
  reason: CapacityUnavailableReason | null
): RuntimeCapacityEntry {
  if (windows && windows.length > 0) {
    return { runtime, windows, unavailableReason: null };
  }
  return {
    runtime,
    windows: [],
    unavailableReason: reason ?? 'missing',
  };
}

async function readOne(runtime: CapacityRuntime, nowMs: number): Promise<RuntimeCapacityEntry> {
  if (runtime === 'claude') {
    const windows = readClaudeCapacity(nowMs);
    return entryFor(runtime, windows, windows ? null : 'missing');
  }
  if (runtime === 'codex') {
    const result = await readCodexCapacity();
    if (result.windows) return entryFor(runtime, result.windows, null);
    const reason: CapacityUnavailableReason =
      result.failure === 'unsupported'
        ? 'unsupported'
        : result.failure === 'malformed'
          ? 'unparsable'
          : 'missing';
    return entryFor(runtime, null, reason);
  }
  if (runtime === 'cursor') {
    const result = await readCursorCapacity(nowMs);
    return entryFor(runtime, result.windows, result.reason);
  }
  // Muse: no Botmancers capacity reader in this slice.
  return entryFor(runtime, null, 'unsupported');
}

/** Live capacity for every coding harness used by at least one Agent. */
export async function getRuntimeCapacity(opts?: {
  nowMs?: number;
  bypassCache?: boolean;
}): Promise<RuntimeCapacityResponse> {
  const nowMs = opts?.nowMs ?? Date.now();
  if (!opts?.bypassCache && cached && nowMs - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const runtimes = configuredCapacityRuntimes();
  const entries = await Promise.all(runtimes.map(runtime => readOne(runtime, nowMs)));
  const value: RuntimeCapacityResponse = {
    runtimes: entries,
    observedAt: new Date(nowMs).toISOString(),
  };
  cached = { at: nowMs, value };
  return value;
}

export function resetRuntimeCapacityCache(): void {
  cached = null;
}
