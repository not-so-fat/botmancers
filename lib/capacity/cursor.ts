// Cursor Individual capacity — experimental opt-in only.
// Undocumented dashboard surface; disabled unless BOTMANCERS_CURSOR_INDIVIDUAL_CAPACITY=experimental.
// Adapted from agent-dealer; Botmancers-owned. Thin slice: without opt-in, reports unsupported.

import type { CapacityUnavailableReason, CapacityWindow } from './types';

export const CURSOR_INDIVIDUAL_OPT_IN_ENV = 'BOTMANCERS_CURSOR_INDIVIDUAL_CAPACITY';
export const CURSOR_INDIVIDUAL_OPT_IN_VALUE = 'experimental';
export const CURSOR_BILLING_WINDOW_KEY = 'billing_cycle';

export function isCursorIndividualExperimentalEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[CURSOR_INDIVIDUAL_OPT_IN_ENV] === CURSOR_INDIVIDUAL_OPT_IN_VALUE;
}

/**
 * Cursor capacity read. Without explicit opt-in, returns unsupported (no
 * credential touch, no HTTP). With opt-in but no live dashboard wiring in
 * this thin slice, returns missing so the UI shows 1M N/A honestly.
 */
export async function readCursorCapacity(
  _nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<{ windows: CapacityWindow[] | null; reason: CapacityUnavailableReason }> {
  if (!isCursorIndividualExperimentalEnabled(env)) {
    return { windows: null, reason: 'unsupported' };
  }
  return { windows: null, reason: 'missing' };
}

/** Test helper: build a known billing-cycle window. */
export function cursorBillingWindow(
  remainingPercent: number,
  nowMs = Date.now()
): CapacityWindow {
  return {
    windowKey: CURSOR_BILLING_WINDOW_KEY,
    providerBucket: 'individual',
    displayLabel: '1M',
    remainingPercent,
    resetAt: null,
    observedAt: new Date(nowMs).toISOString(),
    source: 'experimental_api',
    unavailableReason: null,
    criticalRole: null,
  };
}
