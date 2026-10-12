/** Server-owned Clone Market handoff. The client never supplies the marketplace URL. */

export const HANDOFF_PATH = '/api/marketplace-handoff';
export const HANDOFF_STATUS_PATH = '/api/marketplace-handoff/status';

/** Completed same-origin return: `/?imported=<botId>`. */
export const IMPORT_RETURN_QUERY = 'imported';

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
