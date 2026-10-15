// NOT-491: Streamable HTTP transport for the MCP bridge (./mcp-bridge),
// served at /api/v0/mcp.
//
// Stateless: each POST carries one JSON-RPC message and is answered with
// application/json (no session id, no server-initiated SSE stream, so GET
// and DELETE are 405). Every POST is authenticated by the /api/v0
// authenticator (./agent-api) before its body is read; a failure is
// answered with the /api/v0 error envelope and writes nothing. Only service
// principals may use the bridge. A browser Origin other than the request's
// own is refused (DNS-rebinding guard).
import type { Principal } from './db';
import { AgentApiError } from './agent-conversations';
import { authenticate } from './agent-api';
import { JSON_RPC, MCP_PROTOCOL_VERSIONS, handleMcpMessage, jsonRpcError } from './mcp-bridge';

const MAX_BODY_BYTES = 256 * 1024;

function envelope(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get('accept');
  return !accept || /application\/json|application\/\*|\*\/\*/i.test(accept);
}

export async function handleMcpPost(request: Request): Promise<Response> {
  if (!originAllowed(request)) return envelope(403, 'origin_not_allowed', 'Cross-origin requests are not accepted.');
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

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return envelope(413, 'payload_too_large', 'The message is too large.');
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
