// The cursor behind every newest-first paged list: the last row's key
// (activity, creation tie-break, id), bound to the list it came from, as
// base64url JSON. The service API (/api/v0, lib/service-api) and the
// owner's session list (GET /api/bots/:id/sessions, NOT-548) share it, so
// one opaque cursor shape pages both; only the scope string differs.

export interface PageKey { at: number; tie: number; id: string }

export function comparePageKeys(a: PageKey, b: PageKey): number {
  return b.at - a.at || b.tie - a.tie || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function encodePageCursor(scope: string, key: PageKey): string {
  return Buffer.from(JSON.stringify({ s: scope, a: key.at, t: key.tie, i: key.id }), 'utf8').toString('base64url');
}

export class InvalidPageCursorError extends Error {
  constructor() {
    super('cursor is not a cursor of this list.');
    this.name = 'InvalidPageCursorError';
  }
}

export function decodePageCursor(scope: string, cursor: string | null): PageKey | null {
  if (cursor === null || cursor === '') return null;
  if (cursor.length > 1024) throw new InvalidPageCursorError();
  let value: { s?: unknown; a?: unknown; t?: unknown; i?: unknown };
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidPageCursorError();
  }
  if (!value || value.s !== scope || typeof value.a !== 'number' || typeof value.t !== 'number' || typeof value.i !== 'string') {
    throw new InvalidPageCursorError();
  }
  return { at: value.a, tie: value.t, id: value.i };
}

export interface Page<T> { items: T[]; next_cursor: string | null }

export function paginateRows<T>(
  scope: string,
  rows: T[],
  keyOf: (row: T) => PageKey,
  cursor: string | null,
  limit: number,
): Page<T> {
  const after = decodePageCursor(scope, cursor);
  const sorted = [...rows].sort((a, b) => comparePageKeys(keyOf(a), keyOf(b)));
  const remaining = after ? sorted.filter(row => comparePageKeys(keyOf(row), after) > 0) : sorted;
  const items = remaining.slice(0, limit);
  const next = remaining.length > limit ? encodePageCursor(scope, keyOf(items[items.length - 1])) : null;
  return { items, next_cursor: next };
}
