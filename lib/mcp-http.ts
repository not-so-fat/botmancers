// NOT-491: Streamable HTTP transport for the MCP bridge (./mcp-bridge),
// served at /api/v0/mcp.
//
// Stateless: each POST carries one JSON-RPC message and is answered with
// application/json (no session id, no server-initiated SSE stream, so GET
// and DELETE are 405). Every POST is authenticated by the /api/v0
// authenticator (./agent-api) before its body is read; a failure is
// answered with the /api/v0 error envelope and writes nothing. Only service
// principals may use the bridge.
//
// DNS-rebinding guard (checked first, before authentication): the Host
// header must be a loopback host (any port) or an exact entry of
// BOTMANCERS_MCP_ALLOWED_HOSTS, and an Origin header, when present, must be
// exactly http://<that loopback Host> or an exact entry of
// BOTMANCERS_MCP_ALLOWED_ORIGINS. Neither is compared with the request's own
// authority, which a rebound request controls.
import type { Principal } from './db';
import { AgentApiError } from './agent-conversations';
import { authenticate } from './agent-api';
import { isLoopbackHost } from './owner-boundary';
import { JSON_RPC, MCP_PROTOCOL_VERSIONS, handleMcpMessage, jsonRpcError } from './mcp-bridge';

const MAX_BODY_BYTES = 256 * 1024;

export const MCP_ALLOWED_HOSTS_ENV = 'BOTMANCERS_MCP_ALLOWED_HOSTS';
export const MCP_ALLOWED_ORIGINS_ENV = 'BOTMANCERS_MCP_ALLOWED_ORIGINS';

function envelope(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
}

// Null when Host and Origin are trusted, else the refusal.
function rebindingRefusal(request: Request): Response | null {
  const host = (request.headers.get('host') ?? '').trim().toLowerCase();
  if (!host || !(isLoopbackHost(host) || listEnv(MCP_ALLOWED_HOSTS_ENV).includes(host))) {
    return envelope(403, 'host_not_allowed', 'The request did not arrive on a trusted host.');
  }
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  const normalized = origin.trim().toLowerCase();
  if (isLoopbackHost(host) && normalized === `http://${host}`) return null;
  if (listEnv(MCP_ALLOWED_ORIGINS_ENV).includes(normalized)) return null;
  return envelope(403, 'origin_not_allowed', 'Cross-origin requests are not accepted.');
}

class BodyTooLarge extends Error {}

// Reads the body, refusing it as soon as it exceeds MAX_BODY_BYTES (by
// Content-Length up front, then incrementally) so it is never buffered whole.
async function readBody(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_BODY_BYTES)) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get('accept');
  return !accept || /application\/json|application\/\*|\*\/\*/i.test(accept);
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const refusal = rebindingRefusal(request);
  if (refusal) return refusal;
  let principal: Principal;
  try {
    principal = await authenticate(request);
  } catch (error) {
    if (error instanceof AgentApiError) {
      const headers: Record<string, string> = error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="botmancers"' } : {};
      return envelope(error.status, error.code, error.message, headers);
    }
    console.error('MCP bridge authentication error:', error);
    return envelope(500, 'internal_error', 'The request could not be processed.');
  }
  if (principal.kind !== 'service') return envelope(403, 'principal_not_allowed', 'The MCP bridge accepts only service principals.');

  const version = request.headers.get('mcp-protocol-version');
  if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return envelope(400, 'unsupported_protocol_version', `Supported MCP protocol versions: ${MCP_PROTOCOL_VERSIONS.join(', ')}.`);
  }
  if (!acceptsJson(request)) return envelope(406, 'not_acceptable', 'This server answers with application/json.');

  let text: string;
  try {
    text = await readBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return envelope(413, 'payload_too_large', 'The message is too large.');
    throw error;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return Response.json(jsonRpcError(null, JSON_RPC.parseError, 'Parse error'), { status: 400 });
  }
  if (Array.isArray(message)) {
    return Response.json(jsonRpcError(null, JSON_RPC.invalidRequest, 'Batched messages are not supported.'), { status: 400 });
  }
  let response;
  try {
    response = handleMcpMessage(principal, message);
  } catch (error) {
    console.error('MCP bridge error:', error);
    const id = (message as { id?: unknown })?.id;
    response = jsonRpcError(typeof id === 'string' || typeof id === 'number' ? id : null, JSON_RPC.internalError, 'Internal error');
  }
  if (!response) return new Response(null, { status: 202 });
  return Response.json(response, { status: response.error && response.id === null ? 400 : 200 });
}

export function handleMcpMethodNotAllowed(): Response {
  return envelope(405, 'method_not_allowed', 'This MCP endpoint accepts POST only (no server-initiated stream or session).', { Allow: 'POST' });
}
