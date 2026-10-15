// NOT-475: the loopback boundary that makes a UI caller the human owner
// (docs/design/2026-10-14-wake-safety-contract.md, Principals). It proves
// "a process on this machine, via a same-origin page", not user identity:
//
//   - Host is 127.0.0.1, localhost, or [::1] (any port), so a DNS-rebound
//     foreign name never reaches a route;
//   - a mutating request carrying browser provenance is same-origin: an
//     Origin header equal to the request's own origin, or Sec-Fetch-Site
//     same-origin / none.
//
// A mutating request with neither Origin nor Sec-Fetch-Site comes from a
// non-browser local client (curl, the integration scripts). Browsers send
// Origin on every cross-origin POST, so cross-site requests are still
// refused; a local process could forge both headers anyway, so requiring
// them would add no protection. /api/v0 has its own authenticator and is
// outside this boundary. Pure: no database, safe in proxy.ts.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const OWNER_ORIGIN_REQUIRED = 'owner_origin_required';

function hostName(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return null;
    const rest = trimmed.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return null;
    return trimmed.slice(0, end + 1);
  }
  const [name, port, extra] = trimmed.split(':');
  if (extra !== undefined || (port !== undefined && !/^\d+$/.test(port))) return null;
  return name;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const name = host ? hostName(host) : null;
  return !!name && LOOPBACK_HOSTS.has(name);
}

export interface OwnerBoundaryInput {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  // The protocol the request arrived on, e.g. 'http:'.
  protocol: string;
}

// Null when the request is inside the owner boundary, else why not.
export function ownerBoundaryRefusal(input: OwnerBoundaryInput): string | null {
  if (!isLoopbackHost(input.host)) return 'The request did not arrive on a loopback host.';
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  const site = input.secFetchSite?.trim().toLowerCase() ?? null;
  if (site !== null && site !== 'same-origin' && site !== 'none') return 'The request came from another site.';
  if (input.origin !== null) {
    const expected = `${input.protocol}//${(input.host as string).trim().toLowerCase()}`;
    if (input.origin.trim().toLowerCase() !== expected) return 'The request came from another origin.';
  }
  return null;
}

export function ownerBoundaryRefusalFor(request: Request): string | null {
  const url = new URL(request.url);
  return ownerBoundaryRefusal({
    method: request.method,
    host: request.headers.get('host') ?? url.host,
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    protocol: url.protocol,
  });
}
