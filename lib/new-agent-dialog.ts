// NOT-447: geometry and focus wrap for the New Agent dialog. Pure so the
// anchoring and Tab containment rules are testable without a browser.

export const DIALOG_INSET = 16;
export const DIALOG_GAP = 8;
export const DIALOG_WIDTH = 358;
// Below this much room under the trigger the dialog moves to the top inset
// instead of squeezing its body.
export const DIALOG_MIN_ROOM = 360;

export interface DialogPlacement {
  top: number;
  left: number;
  maxHeight: number;
}

export function newAgentDialogPlacement(
  anchor: { left: number; bottom: number } | null,
  viewport: { width: number; height: number },
): DialogPlacement {
  const width = Math.min(DIALOG_WIDTH, viewport.width - 2 * DIALOG_INSET);
  const maxLeft = Math.max(DIALOG_INSET, viewport.width - DIALOG_INSET - width);
  let top = DIALOG_INSET;
  let left = DIALOG_INSET;
  if (anchor) {
    left = Math.min(Math.max(anchor.left, DIALOG_INSET), maxLeft);
    const below = anchor.bottom + DIALOG_GAP;
    if (viewport.height - below - DIALOG_INSET >= DIALOG_MIN_ROOM) top = below;
  }
  return { top, left, maxHeight: Math.max(0, viewport.height - top - DIALOG_INSET) };
}

// Where Tab / Shift+Tab should go to stay inside the dialog, or null to let
// the browser move focus normally.
export function wrapFocusTarget<T>(focusable: T[], active: T | null, shiftKey: boolean): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const inside = active !== null && focusable.includes(active);
  if (shiftKey) return !inside || active === first ? last : null;
  return !inside || active === last ? first : null;
}

export const DIALOG_FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
