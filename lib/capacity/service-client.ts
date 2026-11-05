// Browser-safe helpers for capacity DTOs (no Node fs/spawn imports).

import type { RuntimeCapacityEntry, RuntimeCapacityResponse } from './types';
import { isCapacityRuntime } from './types';

export function capacityEntryForRuntime(
  response: RuntimeCapacityResponse,
  runtime: string | null | undefined
): RuntimeCapacityEntry | null {
  if (!runtime || !isCapacityRuntime(runtime)) return null;
  return response.runtimes.find(entry => entry.runtime === runtime) ?? null;
}
