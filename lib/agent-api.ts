// NOT-446: authenticated HTTP boundary for the agent conversation API.
//
// Every request is authenticated by an injected authenticator before any
// body is trusted or any row is written. No authenticator ships with the
// engine: credential issuance and exposure policy are operator decisions,
// so until an operator installs one via setAgentApiAuthenticator every
// request fails closed with authentication_unavailable. A principal
// declared in the request body is never trusted on its own; when present
// it must equal the authenticated principal or the request fails with
// principal_mismatch before persistence or launch.
//
// Routes:
//   POST /api/v0/agents/{agentId}/messages   open or continue a conversation
//     body: { content, conversationId?, idempotencyKey?, principal?, wait? }
//     header: Idempotency-Key (alternative to body idempotencyKey)
//   GET  /api/v0/conversations/{id}          participants, origin, ordered messages
//   GET  /api/v0/requests/{id}               request state, reply, typed failure
// Failures use one envelope: { error: { code, message } } with a stable code.
import type { Principal } from './db';
import {
  AgentApiError,
  getAgentRequest,
  getConversation,
  isPrincipalKind,
  samePrincipal,
  sendAgentMessage,
  startAgentDispatch,
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

async function authenticate(request: Request): Promise<Principal> {
  if (!authenticator) {
    throw new AgentApiError('authentication_unavailable', 'No authenticator is configured for the agent conversation API.');
  }
  let principal: Principal | null;
  try {
    principal = await authenticator(request);
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
    const accepted = sendAgentMessage(principal, {
      agentId,
      content: typeof body.content === 'string' ? body.content : '',
      idempotencyKey: headerKey ?? bodyKey ?? '',
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : body.conversationId == null ? null : '',
    });
    const dispatch = startAgentDispatch(accepted.requestId);
    if (body.wait === true) {
      await dispatch;
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
