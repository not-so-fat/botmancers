/** Server-owned Clone Market handoff. The client never supplies the marketplace URL. */

export const HANDOFF_PATH = '/api/marketplace-handoff';
export const HANDOFF_STATUS_PATH = '/api/marketplace-handoff/status';

/** Completed same-origin return: `<return>?imported=<botId>`. */
export const IMPORT_RETURN_QUERY = 'imported';

/** Bot IDs are opaque path-safe tokens; anything else is not an import return. */
const IMPORTED_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The imported bot ID from a return query string: null when absent, '' when malformed. */
export function importedBotId(search: string): string | null {
  const raw = new URLSearchParams(search).get(IMPORT_RETURN_QUERY);
  if (raw === null) return null;
  const id = raw.trim();
  return IMPORTED_ID.test(id) ? id : '';
}

/** Where a completed import lands: the imported bot's own Config page. */
export function importedConfigPath(botId: string): string {
  return `/agents/${encodeURIComponent(botId)}/config`;
}

export type ImportReturn =
  | { kind: 'none' }
  | { kind: 'stay' }
  | { kind: 'open'; path: string }
  | { kind: 'missing' };

/**
 * Resolve a handoff return on a Config page. A bot other than the current one
 * opens its own Config page once it is confirmed to exist; the current bot is
 * never the import target.
 */
export async function resolveImportReturn(
  search: string,
  currentId: string,
  exists: (botId: string) => Promise<boolean>,
): Promise<ImportReturn> {
  const imported = importedBotId(search);
  if (imported === null) return { kind: 'none' };
  if (!imported) return { kind: 'missing' };
  if (imported === currentId) return { kind: 'stay' };
  try {
    return (await exists(imported)) ? { kind: 'open', path: importedConfigPath(imported) } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

/** Start the server-owned handoff, returning to this same-origin page (no query, no fragment). */
export function handoffStartPath(origin: string, pathname: string): string {
  return `${HANDOFF_PATH}?return=${encodeURIComponent(origin + pathname)}`;
}

export type MarketImportPhase = 'idle' | 'checking' | 'redirecting' | 'unavailable' | 'failed' | 'missing';

export interface MarketImportView {
  busy: boolean;
  tone: 'muted' | 'error';
  message: string;
}

export const MARKET_IMPORT_HINT = 'Imports a new agent and opens its Config. This agent is not changed.';
export const MARKET_UNAVAILABLE = "Grok Marketplace isn't configured. Set CLONE_MARKET_URL on the Botmancers server.";
export const MARKET_FAILED = "Couldn't reach Botmancers to start the import. Try again.";
export const MARKET_MISSING = "Imported agent not found. The import may not have completed.";

export function marketImportView(phase: MarketImportPhase): MarketImportView {
  switch (phase) {
    case 'checking':
      return { busy: true, tone: 'muted', message: 'Checking Grok Marketplace…' };
    case 'redirecting':
      return { busy: true, tone: 'muted', message: 'Opening Grok Marketplace…' };
    case 'unavailable':
      return { busy: false, tone: 'error', message: MARKET_UNAVAILABLE };
    case 'failed':
      return { busy: false, tone: 'error', message: MARKET_FAILED };
    case 'missing':
      return { busy: false, tone: 'error', message: MARKET_MISSING };
    default:
      return { busy: false, tone: 'muted', message: MARKET_IMPORT_HINT };
  }
}

export function marketUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CLONE_MARKET_URL || '').trim();
}

export function isMarketConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return marketUrlFromEnv(env).length > 0;
}

/** Keep only origin + pathname + search; drop userinfo and fragment. */
export function cleanReturnUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed;
}

/**
 * Build the marketplace destination from CLONE_MARKET_URL only.
 * Strips userinfo, fragment, and every existing query parameter, then sets
 * only target=botmancers and return=<cleaned same-origin return>.
 */
export function buildHandoffDestination(
  cleanedReturn: URL,
  env: NodeJS.ProcessEnv = process.env,
): URL | null {
  const raw = marketUrlFromEnv(env);
  if (!raw) return null;
  let market: URL;
  try {
    market = new URL(raw);
  } catch {
    return null;
  }
  if (market.protocol !== 'http:' && market.protocol !== 'https:') return null;
  market.username = '';
  market.password = '';
  market.hash = '';
  market.search = '';
  market.searchParams.set('target', 'botmancers');
  market.searchParams.set('return', cleanedReturn.toString());
  return market;
}

/** True when the query is anything other than exactly one parameter named return. */
export function invalidHandoffQuery(request: Request): boolean {
  const keys = [...new URL(request.url).searchParams.keys()];
  return keys.length !== 1 || keys[0] !== 'return';
}
