// NOT-446: authenticated HTTP boundary for the agent conversation API.
//
// Every request is authenticated before any body is trusted or any row is
// written. NOT-491: the shipped authenticator is the service-token one
// (lib/service-token-auth), active when the operator configures
// BOTMANCERS_SERVICE_TOKENS; an authenticator installed via
// setAgentApiAuthenticator replaces it. With neither (or a malformed token
// list) every request fails closed with authentication_unavailable. A principal
// declared in the request body is never trusted on its own; when present
// it must equal the authenticated principal or the request fails with
// principal_mismatch before persistence or launch.
//
// Routes:
//   POST /api/v0/agents/{agentId}/messages   open or continue a conversation
//     body: { content, conversationId?, idempotencyKey?, principal?, wait? }
//     header: Idempotency-Key (alternative to body idempotencyKey); keys
//     starting with "mcp:" are reserved for the MCP bridge (invalid_request)
//   GET  /api/v0/conversations/{id}          participants, origin, ordered messages,
//                                            projected lifecycle events (NOT-470)
//   GET  /api/v0/requests/{id}               request state, reply, typed failure
// Failures use one envelope: { error: { code, message } } with a stable code.
// NOT-465: POST accepts through the shared conversation intake, the same
// service as the web UI message route; requestId is the canonical Work
// Request id.
import type { Principal } from './db';
import { ServiceTokenConfigError, serviceTokenAuthenticatorFromEnv } from './service-token-auth';
import {
  AgentApiError,
  MCP_IDEMPOTENCY_PREFIX,
  acceptAgentMessage,
  getAgentRequest,
  getConversation,
  isPrincipalKind,
  samePrincipal,
} from './agent-conversations';

export type AgentApiAuthenticator = (request: Request) => Promise<Principal | null> | Principal | null;

let authenticator: AgentApiAuthenticator | null = null;

export function setAgentApiAuthenticator(next: AgentApiAuthenticator | null): void {
  authenticator = next;
}

function errorResponse(error: AgentApiError): Response {
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
}

async function withErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentApiError) return errorResponse(error);
    console.error('Agent conversation API error:', error);
    return Response.json({ error: { code: 'internal_error', message: 'The request could not be processed.' } }, { status: 500 });
  }
}

// The installed authenticator, else the configured service tokens.
function activeAuthenticator(): AgentApiAuthenticator | null {
  if (authenticator) return authenticator;
  try {
    return serviceTokenAuthenticatorFromEnv();
  } catch (error) {
    if (error instanceof ServiceTokenConfigError) {
      console.error(`Agent API authentication disabled: ${error.message}`);
      return null;
    }
    throw error;
  }
}

// The caller's principal, derived only by the authenticator. Throws
// authentication_unavailable or unauthenticated before anything is read.
export async function authenticate(request: Request): Promise<Principal> {
  const active = activeAuthenticator();
  if (!active) {
    throw new AgentApiError('authentication_unavailable', 'No authenticator is configured for the agent conversation API.');
  }
  let principal: Principal | null;
  try {
    principal = await active(request);
  } catch {
    principal = null;
  }
  if (!principal || !isPrincipalKind(principal.kind) || typeof principal.id !== 'string' || !principal.id.trim()) {
    throw new AgentApiError('unauthenticated', 'Authentication failed.');
  }
  return { kind: principal.kind, id: principal.id };
}

function declaredPrincipal(value: unknown): Principal | null {
  if (value === undefined || value === null) return null;
  const candidate = value as { kind?: unknown; id?: unknown };
  return { kind: candidate.kind as Principal['kind'], id: String(candidate.id ?? '') };
}

export async function handleSendAgentMessage(request: Request, agentId: string): Promise<Response> {
  return withErrors(async () => {
    const principal = await authenticate(request);
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new AgentApiError('invalid_request', 'The request body must be a JSON object.');
    }
    const declared = declaredPrincipal(body.principal);
    if (declared && !samePrincipal(declared, principal)) {
      throw new AgentApiError('principal_mismatch', 'The declared principal does not match the authenticated principal.');
    }
    const headerKey = request.headers.get('idempotency-key');
    const bodyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
    if (headerKey && bodyKey && headerKey !== bodyKey) {
      throw new AgentApiError('invalid_request', 'Idempotency-Key header and body idempotencyKey differ.');
    }
    const idempotencyKey = headerKey ?? bodyKey ?? '';
    if (idempotencyKey.toLowerCase().startsWith(MCP_IDEMPOTENCY_PREFIX)) {
      throw new AgentApiError('invalid_request', `Idempotency keys starting with "${MCP_IDEMPOTENCY_PREFIX}" are reserved for the MCP bridge.`);
    }
    const { accepted, dispatched } = acceptAgentMessage(principal, {
      agentId,
      content: typeof body.content === 'string' ? body.content : '',
      idempotencyKey,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : body.conversationId == null ? null : '',
    });
    if (body.wait === true) {
      await dispatched;
      return Response.json({ ...getAgentRequest(principal, accepted.requestId), replayed: accepted.replayed });
    }
    return Response.json(accepted, { status: accepted.replayed ? 200 : 202 });
  });
}

export async function handleGetConversation(request: Request, conversationId: string): Promise<Response> {
  return withErrors(async () => {
    const principal = await authenticate(request);
    return Response.json(getConversation(principal, conversationId));
  });
}

export async function handleGetAgentRequest(request: Request, requestId: string): Promise<Response> {
  return withErrors(async () => {
    const principal = await authenticate(request);
    return Response.json(getAgentRequest(principal, requestId));
  });
}
