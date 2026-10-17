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
import { serviceAudit, type Principal } from './db';
import type { AuditTargetKind } from './service-audit';
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

// NOT-499: a service principal's call is appended to the service audit
// trail (lib/service-audit) under the narrow participant rule.
interface NarrowAudit {
  operation: string;
  targetKind: AuditTargetKind;
  targetRef: string;
}

const DENIED_CODES = ['authentication_unavailable', 'unauthenticated', 'principal_mismatch', 'agent_not_found', 'conversation_not_found', 'request_not_found'];

async function withErrors(run: (setPrincipal: (principal: Principal) => void) => Promise<Response>, audit?: NarrowAudit): Promise<Response> {
  let principal: Principal | null = null;
  let response: Response;
  let code: string | null = null;
  try {
    response = await run(next => { principal = next; });
  } catch (error) {
    if (error instanceof AgentApiError) {
      code = error.code;
      response = errorResponse(error);
    } else {
      console.error('Agent conversation API error:', error);
      code = 'internal_error';
      response = Response.json({ error: { code: 'internal_error', message: 'The request could not be processed.' } }, { status: 500 });
    }
  }
  const caller = principal as Principal | null;
  if (audit && caller && caller.kind === 'service') {
    try {
      serviceAudit.append({
        principal: caller, operation: audit.operation, capability: 'participant', targetKind: audit.targetKind, targetRef: audit.targetRef,
        outcome: code === null ? 'allowed' : code === 'internal_error' ? 'error' : DENIED_CODES.includes(code) ? 'denied' : 'rejected', code,
      });
    } catch (error) {
      console.error('Service audit append failed:', error instanceof Error ? error.message : 'unknown error');
      return Response.json({ error: { code: 'internal_error', message: 'The request could not be processed.' } }, { status: 500 });
    }
  }
  return response;
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
  return withErrors(async setPrincipal => {
    const principal = await authenticate(request);
    setPrincipal(principal);
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
  }, { operation: 'agents.message', targetKind: 'agent', targetRef: agentId });
}

export async function handleGetConversation(request: Request, conversationId: string): Promise<Response> {
  return withErrors(async setPrincipal => {
    const principal = await authenticate(request);
    setPrincipal(principal);
    return Response.json(getConversation(principal, conversationId));
  }, { operation: 'conversations.read', targetKind: 'conversation', targetRef: conversationId });
}

export async function handleGetAgentRequest(request: Request, requestId: string): Promise<Response> {
  return withErrors(async setPrincipal => {
    const principal = await authenticate(request);
    setPrincipal(principal);
    return Response.json(getAgentRequest(principal, requestId));
  }, { operation: 'requests.read', targetKind: 'request', targetRef: requestId });
}
