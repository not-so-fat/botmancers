// NOT-499: the HTTP boundary of the granted service API (lib/service-api).
//
// Routes (all authenticated by the /api/v0 authenticator, service
// principals only; docs/service-grants.md):
//   GET  /api/v0/capabilities                                 the caller's grants
//   GET  /api/v0/agents                                       agents:read
//   GET  /api/v0/agents/{agentId}                             agents:read
//   GET  /api/v0/agents/{agentId}/sessions?status&cursor&limit sessions:read
//   GET  /api/v0/agents/{agentId}/sessions/{ref}              sessions:read
//   GET  /api/v0/agents/{agentId}/conversations?cursor&limit  conversations:read
//   GET  /api/v0/agents/{agentId}/conversations/{id}?cursor&limit
//   POST /api/v0/sessions/{ref}/messages                      sessions:message
//     body: { content, idempotency_key }  (or header Idempotency-Key)
//   GET  /api/v0/exchanges?cursor&limit                       exchanges:read
//   POST /api/v0/exchanges                                    exchanges:create
//   GET  /api/v0/exchanges/{id}                               exchanges:read
//   POST /api/v0/exchanges/{id}/cancel                        exchanges:create
//
// Each call is authenticated, rate limited per service principal
// (BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE, default 120, rolling 60 s;
// 429 rate_limited with Retry-After before anything runs), bounded (64 KiB
// bodies), and appends one audit event (lib/service-audit) whatever its
// outcome; a mutation's allowed event commits atomically with the mutation,
// before anything is dispatched. Failures use the /api/v0 envelope { error: { code, message } }.
import db, { serviceAudit, type Principal } from './db';
import { authenticate } from './agent-api';
import { AgentApiError } from './agent-conversations';
import type { AuditOutcome, AuditTargetKind } from './service-audit';
import {
  PAGE_LIMITS,
  ServiceApiError,
  cancelServiceExchange,
  capabilitiesView,
  createServiceExchange,
  getServiceAgent,
  getServiceConversation,
  getServiceExchange,
  getServiceSession,
  listServiceAgents,
  listServiceConversations,
  listServiceExchanges,
  listServiceSessions,
  parseCancelBody,
  parseLimit,
  parseServiceExchangeBody,
  parseSessionMessageBody,
  sendServiceSessionMessage,
  serviceContext,
  type ServiceContext,
} from './service-api';

export const SERVICE_API_CALLS_PER_MINUTE_ENV = 'BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE';
const DEFAULT_CALLS_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

function callsPerMinute(): number {
  const configured = process.env[SERVICE_API_CALLS_PER_MINUTE_ENV];
  if (configured === undefined || configured.trim() === '') return DEFAULT_CALLS_PER_MINUTE;
  const value = Number(configured.trim());
  if (Number.isInteger(value) && value > 0) return value;
  console.error(`${SERVICE_API_CALLS_PER_MINUTE_ENV} must be a positive integer; using ${DEFAULT_CALLS_PER_MINUTE}.`);
  return DEFAULT_CALLS_PER_MINUTE;
}

// Admitted call times per service principal, oldest first (as the MCP
// bridge's tools/call limit, lib/mcp-http).
const callTimes = new Map<string, number[]>();

function rateLimitRetryAfter(principal: Principal, now = Date.now()): number | null {
  const key = `${principal.kind}:${principal.id}`;
  const times = (callTimes.get(key) ?? []).filter(at => at > now - RATE_WINDOW_MS);
  const limit = callsPerMinute();
  if (times.length >= limit) {
    callTimes.set(key, times);
    return Math.max(1, Math.ceil((times[times.length - limit] + RATE_WINDOW_MS - now) / 1000));
  }
  times.push(now);
  callTimes.set(key, times);
  return null;
}

// Test seam.
export function resetServiceApiRateLimits(): void {
  callTimes.clear();
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await readText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceApiError('invalid_request', 'The body must be a JSON object.');
  }
}

async function readText(request: Request): Promise<string> {
  const tooLarge = new ServiceApiError('payload_too_large', 'The request body is too large.');
  const declared = request.headers.get('content-length');
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_BODY_BYTES)) throw tooLarge;
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
      throw tooLarge;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function envelope(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

interface Operation {
  operation: string;
  capability: string;
  targetKind: AuditTargetKind;
  targetRef?: string | null;
  agentId?: string | null;
}

// The audit target, refined by the handler once it knows more (the Agent
// that owns a session, the exchange a create made).
interface AuditTarget {
  kind: AuditTargetKind;
  targetRef: string | null;
  agentId: string | null;
}

// A mutation hands commitAudit to the service as its commit hook: the
// allowed audit event is appended inside the transaction that records the
// mutation, so if the append fails nothing is committed or dispatched.
async function serve(
  request: Request,
  op: Operation,
  run: (ctx: ServiceContext, target: AuditTarget, commitAudit: () => void) => Promise<Response> | Response,
): Promise<Response> {
  let principal: Principal;
  try {
    principal = await authenticate(request);
  } catch (error) {
    if (error instanceof AgentApiError) return envelope(error.status, error.code, error.message);
    console.error('Service API authentication error:', error instanceof Error ? error.message : 'unknown error');
    return envelope(500, 'internal_error', 'The request could not be processed.');
  }
  const target: AuditTarget = { kind: op.targetKind, targetRef: op.targetRef ?? null, agentId: op.agentId ?? null };
  const append = (outcome: AuditOutcome, code: string | null) => serviceAudit.append({
    principal, operation: op.operation, capability: op.capability,
    targetKind: target.kind, targetRef: target.targetRef, agentId: target.agentId, outcome, code,
  });
  let committed = false;
  const commitAudit = () => {
    append('allowed', null);
    committed = true;
  };
  let response: Response;
  let outcome: AuditOutcome;
  let code: string | null = null;
  try {
    if (principal.kind !== 'service') throw new ServiceApiError('principal_not_allowed', 'The granted service API accepts only service principals.');
    const retryAfter = rateLimitRetryAfter(principal);
    if (retryAfter !== null) {
      code = 'rate_limited';
      outcome = 'denied';
      response = envelope(429, 'rate_limited', 'Too many calls; retry later.', { 'Retry-After': String(retryAfter) });
    } else {
      response = await run(serviceContext(principal), target, commitAudit);
      outcome = 'allowed';
    }
  } catch (error) {
    if (error instanceof ServiceApiError) {
      outcome = error.denied ? 'denied' : 'rejected';
      code = error.notGranted ? 'not_granted' : error.code;
      response = envelope(error.status, error.code, error.message);
    } else {
      console.error('Service API error:', error instanceof Error ? error.message : 'unknown error');
      outcome = 'error';
      code = 'internal_error';
      response = envelope(500, 'internal_error', 'The request could not be processed.');
    }
  }
  // A committed mutation already holds its allowed event; anything that
  // failed after the commit is appended as well.
  if (committed && outcome === 'allowed') return response;
  try {
    append(outcome, code);
  } catch (error) {
    // Fail closed: nothing is returned that was not audited.
    console.error('Service audit append failed:', error instanceof Error ? error.message : 'unknown error');
    return envelope(500, 'internal_error', 'The request could not be processed.');
  }
  return response;
}

// The source session a create body names, and the Agent owning it, before
// the body is validated. The reference is audited only in its safe form
// (lib/service-audit stores anything else as "[invalid]").
function sourceTargetOf(body: unknown): Partial<AuditTarget> {
  const source = body && typeof body === 'object' ? (body as Record<string, unknown>).source : undefined;
  const ref = source && typeof source === 'object' ? (source as Record<string, unknown>).session_ref : undefined;
  if (typeof ref !== 'string' || ref.length === 0) return {};
  return { targetRef: ref, agentId: ref.length <= 200 ? sessionOwner(ref) : null };
}

function query(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    cursor: params.get('cursor'),
    limit: (max: number = PAGE_LIMITS.max, fallback: number = PAGE_LIMITS.default) => parseLimit(params.get('limit'), fallback, max),
    get: (name: string) => params.get(name),
  };
}

function sessionOwner(ref: string): string | null {
  const row = db.prepare('SELECT agent_id FROM session_bindings WHERE id = ?').get(ref) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

function exchangeSource(id: string): string | null {
  if (id.length > 200) return null;
  const row = db.prepare('SELECT source_agent_id FROM session_exchanges WHERE id = ?').get(id) as { source_agent_id: string } | undefined;
  return row?.source_agent_id ?? null;
}

export function handleGetCapabilities(request: Request): Promise<Response> {
  return serve(request, { operation: 'capabilities.read', capability: 'discovery', targetKind: 'grants' }, ctx => Response.json(capabilitiesView(ctx)));
}

export function handleListAgents(request: Request): Promise<Response> {
  return serve(request, { operation: 'agents.list', capability: 'agents:read', targetKind: 'agent' }, ctx => {
    const q = query(request);
    return Response.json(listServiceAgents(ctx, { cursor: q.cursor, limit: q.limit() }));
  });
}

export function handleGetAgent(request: Request, agentId: string): Promise<Response> {
  return serve(request, { operation: 'agents.read', capability: 'agents:read', targetKind: 'agent', targetRef: agentId, agentId },
    ctx => Response.json(getServiceAgent(ctx, agentId)));
}

export function handleListSessions(request: Request, agentId: string): Promise<Response> {
  return serve(request, { operation: 'sessions.list', capability: 'sessions:read', targetKind: 'agent', targetRef: agentId, agentId }, ctx => {
    const q = query(request);
    return Response.json(listServiceSessions(ctx, agentId, { cursor: q.cursor, limit: q.limit(), status: q.get('status') }));
  });
}

export function handleGetSession(request: Request, agentId: string, ref: string): Promise<Response> {
  return serve(request, { operation: 'sessions.read', capability: 'sessions:read', targetKind: 'session', targetRef: ref, agentId },
    ctx => Response.json(getServiceSession(ctx, agentId, ref)));
}

export function handleListConversations(request: Request, agentId: string): Promise<Response> {
  return serve(request, { operation: 'conversations.list', capability: 'conversations:read', targetKind: 'agent', targetRef: agentId, agentId }, ctx => {
    const q = query(request);
    return Response.json(listServiceConversations(ctx, agentId, { cursor: q.cursor, limit: q.limit() }));
  });
}

export function handleGetConversation(request: Request, agentId: string, conversationId: string): Promise<Response> {
  return serve(request, { operation: 'conversations.read', capability: 'conversations:read', targetKind: 'conversation', targetRef: conversationId, agentId }, ctx => {
    const q = query(request);
    return Response.json(getServiceConversation(ctx, agentId, conversationId, {
      cursor: q.cursor, limit: q.limit(PAGE_LIMITS.messagesMax, PAGE_LIMITS.messagesDefault),
    }));
  });
}

export function handleSendSessionMessage(request: Request, ref: string): Promise<Response> {
  return serve(request, { operation: 'sessions.message', capability: 'sessions:message', targetKind: 'session', targetRef: ref }, async (ctx, target, commitAudit) => {
    if (ref.length <= 200) target.agentId = sessionOwner(ref);
    const input = parseSessionMessageBody(await readJsonBody(request), request.headers.get('idempotency-key'));
    const { accepted } = sendServiceSessionMessage(ctx, ref, input, row => {
      target.agentId = row.source_agent_id;
      commitAudit();
    });
    return Response.json(accepted, { status: accepted.replayed ? 200 : 202 });
  });
}

export function handleListExchanges(request: Request): Promise<Response> {
  return serve(request, { operation: 'exchanges.list', capability: 'exchanges:read', targetKind: 'exchange' }, ctx => {
    const q = query(request);
    return Response.json(listServiceExchanges(ctx, { cursor: q.cursor, limit: q.limit() }));
  });
}

export function handleCreateExchange(request: Request): Promise<Response> {
  // Until the exchange exists, its audit target is the source session (and
  // the Agent owning it), recorded even when the body is then refused.
  return serve(request, { operation: 'exchanges.create', capability: 'exchanges:create', targetKind: 'session' }, async (ctx, target, commitAudit) => {
    const body = await readJsonBody(request);
    Object.assign(target, sourceTargetOf(body));
    const input = parseServiceExchangeBody(body, request.headers.get('idempotency-key'));
    const { exchange, created } = createServiceExchange(ctx, input, row => {
      target.kind = 'exchange';
      target.targetRef = row.id;
      target.agentId = row.source_agent_id;
      commitAudit();
    });
    return Response.json({ exchange, replayed: !created }, { status: created ? 201 : 200 });
  });
}

export function handleGetExchange(request: Request, id: string): Promise<Response> {
  return serve(request, { operation: 'exchanges.read', capability: 'exchanges:read', targetKind: 'exchange', targetRef: id }, (ctx, target) => {
    target.agentId = exchangeSource(id);
    const exchange = getServiceExchange(ctx, id);
    target.agentId = exchange.source.agent_id;
    return Response.json(exchange);
  });
}

export function handleCancelExchange(request: Request, id: string): Promise<Response> {
  return serve(request, { operation: 'exchanges.cancel', capability: 'exchanges:create', targetKind: 'exchange', targetRef: id }, async (ctx, target, commitAudit) => {
    target.agentId = exchangeSource(id);
    const reason = parseCancelBody(await readText(request));
    const result = await cancelServiceExchange(ctx, id, reason, row => {
      target.agentId = row.source_agent_id;
      commitAudit();
    });
    return Response.json(result);
  });
}
