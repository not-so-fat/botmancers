// NOT-491: the service-token authenticator for /api/v0 (and the MCP bridge
// mounted under it).
//
// The operator lists each service and the SHA-256 digest of its bearer
// token in BOTMANCERS_SERVICE_TOKENS; the plaintext token is never stored:
//
//   BOTMANCERS_SERVICE_TOKENS="grok-bot=sha256:<64 hex>, ci=sha256:<64 hex>"
//
// A request presenting `Authorization: Bearer <token>` whose digest matches
// an entry is the principal service:<id>. The principal is derived only
// here, from the configured entry; nothing in the request names it. A
// missing, malformed, or unknown token authenticates nobody. A malformed
// configuration installs nothing, so /api/v0 keeps failing closed with
// authentication_unavailable rather than accepting a partial list.
import { createHash, timingSafeEqual } from 'crypto';
import type { Principal } from './db';

export const SERVICE_TOKENS_ENV = 'BOTMANCERS_SERVICE_TOKENS';

// Engine-internal service principals (lib/service-grants refuses a grant
// naming one). NOT-517: no bearer token may authenticate as one either;
// service:botmancers-session-context is authenticated only by a minted
// session context (lib/session-context).
export const RESERVED_SERVICE_IDS: readonly string[] = [
  'botmancers-exchanges', 'botmancers-engine', 'botmancers-session-share', 'botmancers-session-context',
];

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

export interface ServiceTokenEntry {
  serviceId: string;
  digest: Buffer;
}

export class ServiceTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceTokenConfigError';
  }
}

export function serviceTokenDigest(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

// Parses the configured list. Empty or unset: no entries. Any malformed
// entry or duplicate service id rejects the whole list.
export function parseServiceTokens(value: string | undefined): ServiceTokenEntry[] {
  if (!value || !value.trim()) return [];
  const entries: ServiceTokenEntry[] = [];
  const ids = new Set<string>();
  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const at = part.indexOf('=');
    const serviceId = at > 0 ? part.slice(0, at) : '';
    const digest = DIGEST.exec(at > 0 ? part.slice(at + 1).toLowerCase() : '');
    if (!SERVICE_ID.test(serviceId) || !digest) {
      throw new ServiceTokenConfigError(`${SERVICE_TOKENS_ENV} entries must be <service-id>=sha256:<64 hex digits>.`);
    }
    if (ids.has(serviceId)) throw new ServiceTokenConfigError(`${SERVICE_TOKENS_ENV} lists service ${serviceId} twice.`);
    if (RESERVED_SERVICE_IDS.includes(serviceId)) throw new ServiceTokenConfigError(`${SERVICE_TOKENS_ENV} names the reserved engine principal ${serviceId}.`);
    ids.add(serviceId);
    entries.push({ serviceId, digest: Buffer.from(digest[1], 'hex') });
  }
  return entries;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header) : null;
  return match ? match[1] : null;
}

export function createServiceTokenAuthenticator(entries: ServiceTokenEntry[]): (request: Request) => Principal | null {
  return request => {
    const token = bearerToken(request);
    if (!token || token.length > 4096) return null;
    const presented = createHash('sha256').update(token, 'utf8').digest();
    // Compare against every entry so timing does not reveal which matched.
    let match: string | null = null;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest) && match === null) match = entry.serviceId;
    }
    return match ? { kind: 'service', id: match } : null;
  };
}

// The authenticator the environment configures, or null when none is
// configured. Throws ServiceTokenConfigError for a malformed list.
export function serviceTokenAuthenticatorFromEnv(env: NodeJS.ProcessEnv = process.env): ((request: Request) => Principal | null) | null {
  const entries = parseServiceTokens(env[SERVICE_TOKENS_ENV]);
  return entries.length ? createServiceTokenAuthenticator(entries) : null;
}
