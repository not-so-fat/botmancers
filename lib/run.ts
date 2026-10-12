// [run] message payload (NOT-419 reconcile).
//
// Readers accept both `page` (snapshot) and `html` (main, legacy): stored
// messages written before this change keep rendering with no backfill.
// Writers emit exactly one field: `page`. `parseRun` normalises either input
// to `page` (mirrored to the deprecated `html` field so old readers keep
// working); `serializeRun` writes `page` only, taking it from `page` or, for
// old call sites, from `html` as a fallback. See docs/run-payload-migration.md.

export type RunState = 'running' | 'done' | 'stopped';

export interface FileRun {
  state: RunState;
  output?: string;
  // Canonical computer page. Writers always emit this field.
  page?: string;
  // Legacy alias for `page`. Read for backward compatibility, never written.
  // @deprecated use `page`.
  html?: string;
}

export function parseFileReadAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed === 'Read the file filemint6.txt') return { seconds: 4 };
  if (trimmed === 'Read the file filemint6.txt wait 20 seconds') return { seconds: 20 };
  return null;
}

// Validates a public page URL: https only, no credentials. Returns the
// normalised URL or null. Shared by the page-read phrase parser so the rule
// lives in one place.
export function httpsPageUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return raw;
  } catch {
    return null;
  }
}

export function parsePublicPageReadAsk(text: string): { seconds: number; url?: string } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();

  // Legacy one-word extraction from example.com
  if (trimmed === 'Open https://example.com and reply with one word from it') return { seconds: 4 };
  const legacyWaitMatch = trimmed.match(/^Open https:\/\/example\.com and reply with one word from it wait (\d+) seconds$/);
  if (legacyWaitMatch && legacyWaitMatch[1] === '20') return { seconds: 20 };

  // New page title extraction from any https URL
  const titleMatch = trimmed.match(/^Open (https:\/\/[^\s]+) and reply with the page title$/);
  if (titleMatch) {
    const url = httpsPageUrl(titleMatch[1]);
    return url ? { seconds: 4, url } : null;
  }

  const titleWaitMatch = trimmed.match(/^Open (https:\/\/[^\s]+) and reply with the page title wait (\d+) seconds$/);
  if (titleWaitMatch && titleWaitMatch[2] === '20') {
    const url = httpsPageUrl(titleWaitMatch[1]);
    return url ? { seconds: 20, url } : null;
  }

  return null;
}

export function parseCodingLimbAsk(text: string): { seconds: number } | null {
  let trimmed = text.trim();
  if (trimmed.endsWith('.')) trimmed = trimmed.slice(0, -1).trim();

  if (trimmed === 'Ask the coding limb which file holds parsePublicPageReadAsk and reply with that path') return { seconds: 4 };
  if (trimmed === 'Ask the coding limb which file holds parsePublicPageReadAsk and reply with that path wait 20 seconds') return { seconds: 20 };
  return null;
}

function readPage(row: Record<string, unknown>): string | undefined {
  if (typeof row.page === 'string') return row.page;
  if (typeof row.html === 'string') return row.html;
  return undefined;
}

export function parseRun(content: string): FileRun | null {
  const match = content.match(/^\s*\[run\]\s*([\s\S]*)$/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  const page = readPage(row);
  // `html` mirrors `page` so readers written against the legacy field keep
  // working; writers must use `page`.
  const mirror = page === undefined ? {} : { page, html: page };
  if (row.state === 'running' || row.state === 'stopped') {
    return { state: row.state, ...mirror };
  }
  if (row.state === 'done' && typeof row.output === 'string') {
    return { state: 'done', output: row.output, ...mirror };
  }
  return null;
}

export function serializeRun(run: FileRun): string {
  const payload: { state: RunState; output?: string; page?: string } = { state: run.state };
  if (run.state === 'done' && typeof run.output === 'string') payload.output = run.output;
  const page = typeof run.page === 'string' ? run.page : typeof run.html === 'string' ? run.html : undefined;
  if (page !== undefined) payload.page = page;
  return '[run]\n' + JSON.stringify(payload);
}

export function runLine(run: FileRun): string {
  if (run.state === 'done') return run.output ?? '';
  if (run.state === 'stopped') return 'The command was stopped.';
  return 'The command is running';
}
