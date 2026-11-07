// NOT-499: the HTTP boundary of the service API (lib/service-api).
//
// Routes (all authenticated by the /api/v0 authenticator, service
// principals only; every operation on every registered Agent, NOT-556):
//   GET  /api/v0/capabilities                                 every registered Agent
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
//   NOT-507: registered-Agent messaging and session pins (lib/session-pins).
//   POST /api/v0/agents/{agentId}/pins                        sessions:message
//     body: { content, idempotency_key }  (starting a session: sessions:start)
//     (/agents/{agentId}/messages stays the v1 narrow bridge, lib/agent-api)
//   POST /api/v0/sessions/{ref}/pins                          sessions:message (ask)
//     body: { action, approve_write?, replace_pin_ref?, idempotency_key }
//                                                             sessions:resume (resume)
//   GET  /api/v0/pins/{pinRef}                                the pin's capability
//   POST /api/v0/pins/{pinRef}/messages                       the pin's capability
//     body: { content, idempotency_key }
//   POST /api/v0/pins/{pinRef}/detach                         the pin's capability
//     body: { idempotency_key? }
//   NOT-515: temporary ask-only session shares (lib/session-shares).
//   POST /api/v0/sessions/{ref}/shares                        shares:create
//     body: { audience, ttl_seconds?, max_turns?, agent_id?, idempotency_key }
//   GET  /api/v0/shares?session_ref&state&cursor&limit        shares:create (own shares)
//   GET  /api/v0/shares/{shareRef}                            shares:create (own share)
//   POST /api/v0/shares/{shareRef}/revoke                     shares:create (own share; idempotent)
//   NOT-517: share-current (lib/session-context).
//   POST /api/v0/shares/current                               a live session context
//     header: Botmancers-Session-Context: bmsc_… (no Authorization)
//     body: { audience, ttl_seconds?, max_turns?, agent_id?, idempotency_key }
//   The context authenticates only service:botmancers-session-context, which
//   can call only this operation; a service token here is invalid_request.
//
// Each call is authenticated, rate limited per service principal
// (BOTMANCERS_SERVICE_API_CALLS_PER_MINUTE, default 120, rolling 60 s;
// 429 rate_limited with Retry-After before anything runs), bounded (64 KiB
// bodies), and appends one audit event (lib/service-audit) whatever its
// outcome; a mutation's allowed event commits atomically with the mutation,
// before anything is dispatched. Failures use the /api/v0 envelope { error: { code, message } },
// plus (NOT-507) a recovery hint when the code has one (lib/session-actions).
import db, { serviceAudit, type Principal } from './db';
import { authenticate } from './agent-api';
import { AgentApiError } from './agent-conversations';
import type { AuditOutcome, AuditTargetKind } from './service-audit';
import { sessionOwner as sessionOwnerOf } from './session-pins';
import { SESSION_CONTEXT_PRINCIPAL, SESSION_CONTEXT_SERVICE_ID, resolveSessionContext, sessionContextHeader } from './session-context';
import {
  PAGE_LIMITS,
  ServiceApiError,
  checkShareListParams,
  createCurrentSessionShare,
  createServiceShare,
  parseShareCurrentBody,
  requireShareCurrentCaller,
  sessionContextError,
  getServiceShare,
  listServiceShares,
  parseShareCreateBody,
  parseShareRevokeBody,
  revokeServiceShare,
  type ShareAuditHooks,
  detachServicePin,
  messageServiceAgent,
  parseAgentMessageBody,
  parsePinBody,
  pinServiceSession,
  readServicePin,
  sendServicePinMessage,
  type PinAuditHooks,
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
  warmServiceAgent,
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

// One service call's answer, before it becomes an HTTP response (here) or an
// MCP tool result (lib/mcp-bridge).
export interface ServiceResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, status = 200): ServiceResult => ({ status, body });

function failure(status: number, code: string, message: string, headers: Record<string, string> = {}, fields?: string[], recovery?: string | null, reason?: string | null): ServiceResult {
  return { status, body: { error: { code, message, ...(fields ? { fields } : {}), ...(reason ? { reason } : {}), ...(recovery ? { recovery } : {}) } }, headers };
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
  // NOT-507: a registered-Agent message or pin call refines the audited
  // capability and operation to the one the resolved action used.
  capability?: string;
  operation?: string;
}

// A caller-side check that runs first inside the audited call (the MCP
// bridge validates its tool arguments here), so its refusal is audited and
// precedes any write.
export type ServiceGuard = (ctx: ServiceContext) => void;

type Run = (ctx: ServiceContext, target: AuditTarget, commitAudit: () => void) => Promise<ServiceResult> | ServiceResult;

// One call by an already authenticated principal: service principals only,
// rate limited, and audited whatever its outcome. A mutation hands
// commitAudit to the service as its commit hook: the allowed audit event is
// appended inside the transaction that records the mutation, so if the
// append fails nothing is committed or dispatched.
async function serveAs(principal: Principal, op: Operation, run: Run, guard?: ServiceGuard): Promise<ServiceResult> {
  const target: AuditTarget = { kind: op.targetKind, targetRef: op.targetRef ?? null, agentId: op.agentId ?? null };
  const append = (outcome: AuditOutcome, code: string | null) => serviceAudit.append({
    principal, operation: target.operation ?? op.operation, capability: target.capability ?? op.capability,
    targetKind: target.kind, targetRef: target.targetRef, agentId: target.agentId, outcome, code,
  });
  let committed = false;
  const commitAudit = () => {
    append('allowed', null);
    committed = true;
  };
  let result: ServiceResult;
  let outcome: AuditOutcome;
  let code: string | null = null;
  try {
    if (principal.kind !== 'service') throw new ServiceApiError('principal_not_allowed', 'The service API accepts only service principals.');
    // NOT-517: the session-context principal can call share-current only.
    if (principal.id === SESSION_CONTEXT_SERVICE_ID && op.capability !== SHARE_CURRENT_CAPABILITY) {
      throw new ServiceApiError('principal_not_allowed', 'A session context can only share its own session (share-current).');
    }
    const retryAfter = rateLimitRetryAfter(principal);
    if (retryAfter !== null) {
      code = 'rate_limited';
      outcome = 'denied';
      result = failure(429, 'rate_limited', 'Too many calls; retry later.', { 'Retry-After': String(retryAfter) });
    } else {
      const ctx = serviceContext(principal);
      guard?.(ctx);
      result = await run(ctx, target, commitAudit);
      outcome = 'allowed';
    }
  } catch (error) {
    if (error instanceof ServiceApiError) {
      outcome = error.denied ? 'denied' : 'rejected';
      code = error.notGranted ? 'not_granted' : error.code;
      result = failure(error.status, error.code, error.message, {}, error.fields, error.recovery, error.reason);
    } else {
      console.error('Service API error:', error instanceof Error ? error.message : 'unknown error');
      outcome = 'error';
      code = 'internal_error';
      result = failure(500, 'internal_error', 'The request could not be processed.');
    }
  }
  // A committed mutation already holds its allowed event; anything that
  // failed after the commit is appended as well.
  if (committed && outcome === 'allowed') return result;
  try {
    append(outcome, code);
  } catch (error) {
    // Fail closed: nothing is returned that was not audited.
    console.error('Service audit append failed:', error instanceof Error ? error.message : 'unknown error');
    return failure(500, 'internal_error', 'The request could not be processed.');
  }
  return result;
}

// The audited operation word of share-current: shares.create, with its own
// capability word in the audit row.
const SHARE_CURRENT_OPERATION = 'shares.create';
const SHARE_CURRENT_CAPABILITY = 'shares:current';

async function serve(request: Request, call: (principal: Principal) => Promise<ServiceResult>): Promise<Response> {
  let principal: Principal;
  try {
    principal = await authenticate(request);
  } catch (error) {
    if (error instanceof AgentApiError) return envelope(error.status, error.code, error.message);
    console.error('Service API authentication error:', error instanceof Error ? error.message : 'unknown error');
    return envelope(500, 'internal_error', 'The request could not be processed.');
  }
  const result = await call(principal);
  return Response.json(result.body, { status: result.status, headers: result.headers ?? {} });
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

function sessionOwner(ref: string): string | null {
  const row = db.prepare('SELECT agent_id FROM session_bindings WHERE id = ?').get(ref) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

// NOT-507: the audit hooks of a pin call. The target becomes the resolved
// session (and its Agent), with the capability and action it used.
function pinHooks(target: AuditTarget, commitAudit: () => void): PinAuditHooks {
  return {
    onTarget: resolved => {
      target.kind = resolved.sessionRef ? 'session' : 'agent';
      target.targetRef = resolved.sessionRef ?? resolved.agentId;
      target.agentId = resolved.agentId;
      target.capability = resolved.capability;
      target.operation = resolved.action;
    },
    onCommit: commitAudit,
  };
}

// NOT-515: the audit hooks of a share call. create targets the session (and
// its Agent); read and revoke keep the share_ref as target and add its Agent.
function shareHooks(target: AuditTarget, commitAudit: () => void, refineRef: boolean): ShareAuditHooks {
  return {
    onTarget: resolved => {
      if (refineRef) target.targetRef = resolved.sessionRef;
      target.agentId = resolved.agentId;
    },
    onCommit: commitAudit,
  };
}

function exchangeSource(id: string): string | null {
  if (id.length > 200) return null;
  const row = db.prepare('SELECT source_agent_id FROM session_exchanges WHERE id = ?').get(id) as { source_agent_id: string } | undefined;
  return row?.source_agent_id ?? null;
}

// ---------------------------------------------------------------------
// The operations, for a principal the transport authenticated: the HTTP
// handlers below and the MCP bridge's granted tools (lib/mcp-bridge) are
// both thin adapters over these. List parameters arrive as the raw query
// strings and are validated inside the audited call.

export interface ListParams {
  cursor: string | null;
  limit: string | null;
}

// A request body, read (and for the MCP bridge, built from validated tool
// arguments) inside the audited call.
export type BodySource = () => Promise<unknown> | unknown;

export const serviceOperations = {
  capabilities: (principal: Principal, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'capabilities.read', capability: 'discovery', targetKind: 'grants' }, ctx => ok(capabilitiesView(ctx)), guard),

  listAgents: (principal: Principal, q: ListParams, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'agents.list', capability: 'agents:read', targetKind: 'agent' },
      ctx => ok(listServiceAgents(ctx, { cursor: q.cursor, limit: parseLimit(q.limit) })), guard),

  getAgent: (principal: Principal, agentId: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'agents.read', capability: 'agents:read', targetKind: 'agent', targetRef: agentId, agentId },
      ctx => ok(getServiceAgent(ctx, agentId)), guard),

  listSessions: (principal: Principal, agentId: string, q: ListParams & { status: string | null }, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'sessions.list', capability: 'sessions:read', targetKind: 'agent', targetRef: agentId, agentId },
      async ctx => {
        await warmServiceAgent(ctx, agentId);
        return ok(listServiceSessions(ctx, agentId, { cursor: q.cursor, limit: parseLimit(q.limit), status: q.status }));
      }, guard),

  getSession: (principal: Principal, agentId: string, ref: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'sessions.read', capability: 'sessions:read', targetKind: 'session', targetRef: ref, agentId },
      async ctx => {
        await warmServiceAgent(ctx, agentId);
        return ok(getServiceSession(ctx, agentId, ref));
      }, guard),

  listConversations: (principal: Principal, agentId: string, q: ListParams, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'conversations.list', capability: 'conversations:read', targetKind: 'agent', targetRef: agentId, agentId },
      ctx => ok(listServiceConversations(ctx, agentId, { cursor: q.cursor, limit: parseLimit(q.limit) })), guard),

  getConversation: (principal: Principal, agentId: string, conversationId: string, q: ListParams, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'conversations.read', capability: 'conversations:read', targetKind: 'conversation', targetRef: conversationId, agentId },
      ctx => ok(getServiceConversation(ctx, agentId, conversationId, {
        cursor: q.cursor, limit: parseLimit(q.limit, PAGE_LIMITS.messagesDefault, PAGE_LIMITS.messagesMax),
      })), guard),

  sendSessionMessage: (principal: Principal, ref: string, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'sessions.message', capability: 'sessions:message', targetKind: 'session', targetRef: ref }, async (ctx, target, commitAudit) => {
      if (ref.length <= 200) target.agentId = sessionOwner(ref);
      const input = parseSessionMessageBody(await body(), idempotencyHeader);
      const { accepted } = sendServiceSessionMessage(ctx, ref, input, row => {
        target.agentId = row.source_agent_id;
        commitAudit();
      });
      return ok(accepted, accepted.replayed ? 200 : 202);
    }, guard),

  listExchanges: (principal: Principal, q: ListParams, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'exchanges.list', capability: 'exchanges:read', targetKind: 'exchange' },
      ctx => ok(listServiceExchanges(ctx, { cursor: q.cursor, limit: parseLimit(q.limit) })), guard),

  // Until the exchange exists, its audit target is the source session (and
  // the Agent owning it), recorded even when the body is then refused.
  createExchange: (principal: Principal, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'exchanges.create', capability: 'exchanges:create', targetKind: 'session' }, async (ctx, target, commitAudit) => {
      const raw = await body();
      Object.assign(target, sourceTargetOf(raw));
      const input = parseServiceExchangeBody(raw, idempotencyHeader);
      const { exchange, created } = createServiceExchange(ctx, input, row => {
        target.kind = 'exchange';
        target.targetRef = row.id;
        target.agentId = row.source_agent_id;
        commitAudit();
      });
      return ok({ exchange, replayed: !created }, created ? 201 : 200);
    }, guard),

  getExchange: (principal: Principal, id: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'exchanges.read', capability: 'exchanges:read', targetKind: 'exchange', targetRef: id }, (ctx, target) => {
      target.agentId = exchangeSource(id);
      const exchange = getServiceExchange(ctx, id);
      target.agentId = exchange.source.agent_id;
      return ok(exchange);
    }, guard),

  cancelExchange: (principal: Principal, id: string, readReason: () => Promise<string | null>, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'exchanges.cancel', capability: 'exchanges:create', targetKind: 'exchange', targetRef: id }, async (ctx, target, commitAudit) => {
      target.agentId = exchangeSource(id);
      const reason = await readReason();
      const result = await cancelServiceExchange(ctx, id, reason, row => {
        target.agentId = row.source_agent_id;
        commitAudit();
      });
      return ok(result);
    }, guard),

  // NOT-507: registered-Agent messaging and session pins.
  messageAgent: (principal: Principal, agentId: string, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'agents.message', capability: 'sessions:message', targetKind: 'agent', targetRef: agentId, agentId }, async (ctx, target, commitAudit) => {
      const input = parseAgentMessageBody(await body(), idempotencyHeader);
      const { body: result } = await messageServiceAgent(ctx, agentId, input, pinHooks(target, commitAudit));
      return ok(result, result.replayed ? 200 : 202);
    }, guard),

  pinSession: (principal: Principal, ref: string, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'pins.create', capability: 'sessions:message', targetKind: 'session', targetRef: ref }, async (ctx, target, commitAudit) => {
      const input = parsePinBody(await body(), idempotencyHeader);
      const result = await pinServiceSession(ctx, ref, input, pinHooks(target, commitAudit));
      return ok(result, result.replayed ? 200 : 201);
    }, guard),

  readPin: (principal: Principal, pinRef: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'pins.read', capability: 'sessions:message', targetKind: 'session' }, async (ctx, target) =>
      ok(await readServicePin(ctx, pinRef, pinHooks(target, () => {}))), guard),

  sendToPin: (principal: Principal, pinRef: string, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'pins.send', capability: 'sessions:message', targetKind: 'session' }, async (ctx, target, commitAudit) => {
      const input = parseAgentMessageBody(await body(), idempotencyHeader);
      const { body: result } = await sendServicePinMessage(ctx, pinRef, input, pinHooks(target, commitAudit));
      return ok(result, result.replayed ? 200 : 202);
    }, guard),

  detachPin: (principal: Principal, pinRef: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'pins.detach', capability: 'sessions:message', targetKind: 'session' }, (ctx, target, commitAudit) =>
      ok(detachServicePin(ctx, pinRef, pinHooks(target, commitAudit))), guard),

  // NOT-515: session shares.
  createShare: (principal: Principal, ref: string, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'shares.create', capability: 'shares:create', targetKind: 'session', targetRef: ref }, async (ctx, target, commitAudit) => {
      if (ref.length <= 200) target.agentId = sessionOwnerOf(ref);
      const input = parseShareCreateBody(await body(), idempotencyHeader);
      const result = await createServiceShare(ctx, ref, input, shareHooks(target, commitAudit, false));
      return ok(result, result.replayed ? 200 : 201);
    }, guard),

  getShare: (principal: Principal, shareRef: string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'shares.read', capability: 'shares:create', targetKind: 'session', targetRef: shareRef }, (ctx, target) =>
      ok(getServiceShare(ctx, shareRef, shareHooks(target, () => {}, false))), guard),

  listShares: (principal: Principal, q: ListParams & { sessionRef: string | null; state: string | null; names?: string[] }, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'shares.list', capability: 'shares:create', targetKind: 'session', targetRef: q.sessionRef }, (ctx, target) => {
      checkShareListParams(q.names ?? []);
      if (q.sessionRef && q.sessionRef.length <= 200) target.agentId = sessionOwnerOf(q.sessionRef);
      return ok(listServiceShares(ctx, { cursor: q.cursor, limit: parseLimit(q.limit), sessionRef: q.sessionRef, state: q.state }));
    }, guard),

  revokeShare: (principal: Principal, shareRef: string, readBody: () => Promise<string> | string, guard?: ServiceGuard) =>
    serveAs(principal, { operation: 'shares.revoke', capability: 'shares:create', targetKind: 'session', targetRef: shareRef }, async (ctx, target, commitAudit) => {
      parseShareRevokeBody(await readBody());
      return ok(revokeServiceShare(ctx, shareRef, shareHooks(target, commitAudit, false)));
    }, guard),

  // NOT-517: share-current. The principal is the session-context one when
  // the transport authenticated a context header; contextValue is that
  // header, resolved here inside the audited call (any failure is audited
  // and writes nothing else).
  shareCurrent: (principal: Principal, contextValue: string | null, body: BodySource, idempotencyHeader: string | null, guard?: ServiceGuard) =>
    serveAs(principal, { operation: SHARE_CURRENT_OPERATION, capability: SHARE_CURRENT_CAPABILITY, targetKind: 'session' }, async (ctx, target, commitAudit) => {
      const input = parseShareCurrentBody(await body(), idempotencyHeader);
      requireShareCurrentCaller(ctx.principal);
      const resolution = resolveSessionContext(contextValue);
      if (!resolution.ok) throw sessionContextError(resolution);
      const result = await createCurrentSessionShare(ctx, resolution, input, shareHooks(target, commitAudit, true));
      return ok(result, result.replayed ? 200 : 201);
    }, guard),
};

function query(request: Request): ListParams & { get: (name: string) => string | null; names: string[] } {
  const params = new URL(request.url).searchParams;
  return { cursor: params.get('cursor'), limit: params.get('limit'), get: (name: string) => params.get(name), names: [...new Set(params.keys())] };
}

// ---------------------------------------------------------------------
// HTTP handlers.

export function handleGetCapabilities(request: Request): Promise<Response> {
  return serve(request, principal => serviceOperations.capabilities(principal));
}

export function handleListAgents(request: Request): Promise<Response> {
  return serve(request, principal => serviceOperations.listAgents(principal, query(request)));
}

export function handleGetAgent(request: Request, agentId: string): Promise<Response> {
  return serve(request, principal => serviceOperations.getAgent(principal, agentId));
}

export function handleListSessions(request: Request, agentId: string): Promise<Response> {
  const q = query(request);
  return serve(request, principal => serviceOperations.listSessions(principal, agentId, { cursor: q.cursor, limit: q.limit, status: q.get('status') }));
}

export function handleGetSession(request: Request, agentId: string, ref: string): Promise<Response> {
  return serve(request, principal => serviceOperations.getSession(principal, agentId, ref));
}

export function handleListConversations(request: Request, agentId: string): Promise<Response> {
  return serve(request, principal => serviceOperations.listConversations(principal, agentId, query(request)));
}

export function handleGetConversation(request: Request, agentId: string, conversationId: string): Promise<Response> {
  return serve(request, principal => serviceOperations.getConversation(principal, agentId, conversationId, query(request)));
}

export function handleSendSessionMessage(request: Request, ref: string): Promise<Response> {
  return serve(request, principal => serviceOperations.sendSessionMessage(principal, ref, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handleListExchanges(request: Request): Promise<Response> {
  return serve(request, principal => serviceOperations.listExchanges(principal, query(request)));
}

export function handleCreateExchange(request: Request): Promise<Response> {
  return serve(request, principal => serviceOperations.createExchange(principal, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handleGetExchange(request: Request, id: string): Promise<Response> {
  return serve(request, principal => serviceOperations.getExchange(principal, id));
}

export function handleMessageAgent(request: Request, agentId: string): Promise<Response> {
  return serve(request, principal => serviceOperations.messageAgent(principal, agentId, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handlePinSession(request: Request, ref: string): Promise<Response> {
  return serve(request, principal => serviceOperations.pinSession(principal, ref, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handleReadPin(request: Request, pinRef: string): Promise<Response> {
  return serve(request, principal => serviceOperations.readPin(principal, pinRef));
}

export function handleSendToPin(request: Request, pinRef: string): Promise<Response> {
  return serve(request, principal => serviceOperations.sendToPin(principal, pinRef, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handleDetachPin(request: Request, pinRef: string): Promise<Response> {
  return serve(request, principal => serviceOperations.detachPin(principal, pinRef));
}

export function handleCancelExchange(request: Request, id: string): Promise<Response> {
  return serve(request, principal => serviceOperations.cancelExchange(principal, id, async () => parseCancelBody(await readText(request))));
}

// NOT-515: session shares.
export function handleCreateShare(request: Request, ref: string): Promise<Response> {
  return serve(request, principal => serviceOperations.createShare(principal, ref, () => readJsonBody(request), request.headers.get('idempotency-key')));
}

export function handleListShares(request: Request): Promise<Response> {
  const q = query(request);
  return serve(request, principal => serviceOperations.listShares(principal, {
    cursor: q.cursor, limit: q.limit, sessionRef: q.get('session_ref'), state: q.get('state'), names: q.names,
  }));
}

export function handleGetShare(request: Request, shareRef: string): Promise<Response> {
  return serve(request, principal => serviceOperations.getShare(principal, shareRef));
}

export function handleRevokeShare(request: Request, shareRef: string): Promise<Response> {
  return serve(request, principal => serviceOperations.revokeShare(principal, shareRef, () => readText(request)));
}

// NOT-517: POST /api/v0/shares/current. A request with no Authorization
// header is the session-context principal (its header, even when missing,
// is resolved in the audited call: session_context_required); a request
// with one is authenticated as usual and refused (invalid_request).
export async function handleShareCurrent(request: Request): Promise<Response> {
  const contextValue = sessionContextHeader(request.headers);
  const idempotency = request.headers.get('idempotency-key');
  const run = (principal: Principal) => serviceOperations.shareCurrent(principal, contextValue, () => readJsonBody(request), idempotency);
  if (request.headers.get('authorization') === null) {
    const result = await run(SESSION_CONTEXT_PRINCIPAL);
    return Response.json(result.body, { status: result.status, headers: result.headers ?? {} });
  }
  return serve(request, run);
}
