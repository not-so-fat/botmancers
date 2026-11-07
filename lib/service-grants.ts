// The service API capability names and exchange key namespaces.
//
// NOT-556: there is no owner grants layer any more. A configured service
// principal (lib/service-token-auth, service:<id>) can use every /api/v0
// and MCP v2 operation on every registered Agent (lib/service-api); the
// Agent's own policy (lib/session-pins), the owner's share allowlist
// (lib/session-shares), and caller-owned visibility are the gates. Nothing
// here reads a file: a leftover grants document from an earlier release is
// never read, never deleted, and never causes an error.
//
// The capability names stay as plain constants because the audit trail
// records one per operation and the botmancers.mcp.v2 contract lists them
// per Agent.

export const SERVICE_CAPABILITIES = [
  'agents:read',
  'sessions:read',
  'conversations:read',
  'sessions:message',
  'exchanges:read',
  'exchanges:create',
  'sessions:start',
  'sessions:resume',
  'shares:create',
] as const;

export type ServiceCapability = typeof SERVICE_CAPABILITIES[number];

export function isServiceCapability(value: unknown): value is ServiceCapability {
  return typeof value === 'string' && (SERVICE_CAPABILITIES as readonly string[]).includes(value);
}

// The idempotency namespaces of a service's exchange rows: a session
// message and an exchange never collide on the caller's key.
export const MESSAGE_KEY_PREFIX = 'message:';
export const EXCHANGE_KEY_PREFIX = 'exchange:';
