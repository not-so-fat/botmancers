// NOT-446: runtime-neutral agent conversation service.
//
// An authenticated principal (person|bot|service) names a registered
// agent, opens or continues a durable conversation, and later reads the
// ordered history and the agent's reply. Bot-to-bot team conversations and
// external-caller conversations use the same rows: one conversation, its
// explicit participants and origin principal, ordered messages, and one
// request per accepted message reported in a runtime-neutral state
// (accepted -> dispatched -> completed|failed) plus durable events.
//
// NOT-465: messages are accepted through the shared conversation intake
// (./conversation-intake), the same service the web UI route uses. Each
// accepted message is one canonical Work Request (./engine-store); the
// request id is the Work Request id and its lifecycle is the canonical
// state machine shown in the documented API vocabulary. NOT-477: requests
// and idempotency keys accepted before NOT-465 were copied into the
// canonical tables (lib/engine-store archiveLegacyAgentRequests) and keep
// their original request ids here.
//
// Idempotency: (principal kind, principal id, idempotency key) is unique.
// An exact retry returns the original request; the same key with a
// different payload fails with idempotency_conflict and writes nothing.
// NOT-473: a failed Attempt is retried only under the request's stored
// bounded retry policy (one Attempt by default, so a failed request stays
// failed); cancellation and deadlines go through lib/work-request-control.
//
// Existing UI threads ('bot'/'group' conversations) are readable here
// through the compatibility participants bound in ./db; they stay
// writable only through the UI routes, whose agent loop owns their turns.
import { randomUUID } from 'crypto';
import db, { bots, engine, projector, type Bot, type Principal, type PrincipalKind } from './db';
import {
  DispatchFailure,
  adapterForTransport,
  agentForDispatch,
  dispatchFailureFor,
  prepareDispatch,
  type DispatchHistoryEntry,
  type PreparedDispatch,
} from './agent-dispatch';
import { abandonedLocally, beginAttempt, recordAbandonedResult, recordAttemptResult, recordLateResult, runAttempt, type LocallyAbandonedAttempt, type PreparedAttempt } from './attempt-executor';
import { EngineStoreError, TERMINAL_STATES, type EngineEvent, type WorkAttempt, type WorkRequest, type WorkRequestState } from './engine-store';
import { ControlError, type AbandonedAttempt, type CancelResult, type ControlActor, type ControlAuthorizer, type EnforcedRequest, type RetryResult } from './work-request-control';
import type { AttemptEvent, AttemptResult, RunObservation } from './attempt-adapter';
import {
  LeaseLostError,
  createDispatcher,
  decideRepostResult,
  decideWithRunId,
  decideWithoutRunId,
  dispatchFault,
  type DispatchLease,
  type Dispatcher,
  type DispatcherOptions,
  type ReconcileDecision,
} from './dispatcher';
import { authorizeWorkRequest } from './execution-policy';
import { IntakeError, acceptConversationMessage, type AcceptedIntake, type IntakeErrorCode } from './conversation-intake';
import type { ConversationEventView } from './conversation-projection';
import { continueAfterFinalization, continueAfterTerminal, pendingCoordinatorWork, resumeBindingFor, turnContext } from './coordinator-loop';
import { decideWakeGrant, retryWake, type GrantDecisionResult, type RoutedWake } from './wake-router';
import { revokeWakeGrant, type CallerCategory, type WakeGrant } from './wake-safety';
import { openFinalizationIds, recordAttemptBaseline, recordPreparedEvidence, runFinalization } from './agent-deck-finalization';
import { ExchangeError, createExchangeStore, hopOf, type CreateExchangeInput, type ExchangeView } from './session-exchanges';

export const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['person', 'bot', 'service'];

// NOT-491: the MCP bridge stores its callers' keys under this prefix; the
// REST route refuses keys that start with it so the two cannot collide.
export const MCP_IDEMPOTENCY_PREFIX = 'mcp:';

export type AgentApiErrorCode =
  | 'authentication_unavailable'
  | 'unauthenticated'
  | 'principal_mismatch'
  | 'invalid_request'
  | 'agent_not_found'
  | 'conversation_not_found'
  | 'conversation_not_writable'
  | 'request_not_found'
  | 'idempotency_conflict'
  | 'internal_error';

export const AGENT_API_ERROR_STATUS: Record<AgentApiErrorCode, number> = {
  authentication_unavailable: 503,
  unauthenticated: 401,
  principal_mismatch: 403,
  invalid_request: 400,
  agent_not_found: 404,
  conversation_not_found: 404,
  conversation_not_writable: 409,
  request_not_found: 404,
  idempotency_conflict: 409,
  internal_error: 500,
};

export class AgentApiError extends Error {
  readonly code: AgentApiErrorCode;
  constructor(code: AgentApiErrorCode, message: string) {
    super(message);
    this.name = 'AgentApiError';
    this.code = code;
  }
  get status(): number {
    return AGENT_API_ERROR_STATUS[this.code];
  }
}

export type AgentRequestState = 'accepted' | 'dispatched' | 'completed' | 'failed';

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: 'user' | 'bot';
  sender_id: string | null;
  sender_kind: PrincipalKind | null;
  request_id: string | null;
  content: string;
  created_at: number;
}

export interface SendAgentMessageInput {
  agentId: string;
  content: string;
  idempotencyKey: string;
  conversationId?: string | null;
}

export interface AcceptedAgentRequest {
  requestId: string;
  conversationId: string;
  acceptedMessageId: string;
  state: AgentRequestState;
  replayed: boolean;
}

export interface AgentRequestView {
  requestId: string;
  conversationId: string;
  agentId: string;
  acceptedMessageId: string;
  state: AgentRequestState;
  reply: { messageId: string; content: string } | null;
  failure: { code: string; message: string } | null;
  events: { type: string; at: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessageView {
  messageId: string;
  seq: number;
  sender: Principal;
  content: string;
  requestId: string | null;
  createdAt: number;
}

export interface ConversationView {
  conversationId: string;
  type: 'agent' | 'direct' | 'group';
  origin: Principal | null;
  participants: (Principal & { joinedAt: number })[];
  messages: ConversationMessageView[];
  // NOT-470: projected Wake and Work Request lifecycle, in conversation
  // order (lib/conversation-projection). The UI conversation read returns
  // the same list.
  events: ConversationEventView[];
}

export function isPrincipalKind(value: unknown): value is PrincipalKind {
  return typeof value === 'string' && (PRINCIPAL_KINDS as readonly string[]).includes(value);
}

export function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isParticipant(conversationId: string, principal: Principal): boolean {
  return !!db.prepare(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND participant_kind = ? AND participant_id = ?'
  ).get(conversationId, principal.kind, principal.id);
}

// Canonical lifecycle seen through the documented API vocabulary.
export function apiStateOf(state: WorkRequestState): AgentRequestState {
  switch (state) {
    case 'running':
    case 'waiting':
      return 'dispatched';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'accepted';
  }
}

// Principals the authenticator vouched for still have to name something
// this engine knows: a bot principal must be a registered bot.
export function assertKnownPrincipal(principal: Principal): void {
  if (!isPrincipalKind(principal.kind) || !nonEmptyString(principal.id)) {
    throw new AgentApiError('unauthenticated', 'Authentication failed.');
  }
  if (principal.kind === 'bot' && !bots.getById(principal.id)) {
    throw new AgentApiError('unauthenticated', 'Authentication failed.');
  }
}

// Normalized intake categories in the documented /api/v0 envelope.
const INTAKE_TO_API: Record<IntakeErrorCode, AgentApiErrorCode> = {
  invalid_request: 'invalid_request',
  conversation_not_found: 'conversation_not_found',
  conversation_not_writable: 'conversation_not_writable',
  target_not_found: 'agent_not_found',
  idempotency_conflict: 'idempotency_conflict',
  unknown_principal: 'unauthenticated',
  intake_failed: 'internal_error',
};

export function agentApiErrorFromIntake(error: IntakeError): AgentApiError {
  return new AgentApiError(INTAKE_TO_API[error.code], error.code === 'intake_failed' ? 'The request could not be processed.' : error.message);
}

// Accepted API work runs through the canonical request dispatcher; it is
// idempotent, so exact replays may call it again.
function dispatchAccepted(accepted: AcceptedIntake): Promise<void> {
  return Promise.all(accepted.requestIds.map(startAgentDispatch)).then(() => undefined);
}

// Accepts through the shared conversation intake (lib/conversation-intake).
// A key first used before NOT-465 replays from its migrated intake row.
export function acceptAgentMessage(principal: Principal, input: SendAgentMessageInput): { accepted: AcceptedAgentRequest; dispatched: Promise<void> } {
  assertKnownPrincipal(principal);
  if (!nonEmptyString(input.agentId)) throw new AgentApiError('invalid_request', 'agentId is required.');
  if (!nonEmptyString(input.content)) throw new AgentApiError('invalid_request', 'content is required.');
  if (!nonEmptyString(input.idempotencyKey) || input.idempotencyKey.length > 200) {
    throw new AgentApiError('invalid_request', 'An idempotency key (1-200 characters) is required.');
  }
  if (input.conversationId !== undefined && input.conversationId !== null && !nonEmptyString(input.conversationId)) {
    throw new AgentApiError('invalid_request', 'conversationId must be a non-empty string when present.');
  }

  let intake: ReturnType<typeof acceptConversationMessage>;
  try {
    intake = acceptConversationMessage({
      surface: 'api',
      requester: principal,
      idempotencyKey: input.idempotencyKey,
      conversation: input.conversationId ? { id: input.conversationId } : { create: true },
      content: input.content,
      fingerprint: [input.agentId, input.conversationId ?? null, input.content],
      route: () => ({ deliveries: [{ agentId: input.agentId }] }),
      dispatch: dispatchAccepted,
    });
  } catch (error) {
    if (error instanceof IntakeError) throw agentApiErrorFromIntake(error);
    throw error;
  }
  const request = intake.requests[0];
  return {
    accepted: {
      requestId: request ? publicRequestId(request) : intake.requestIds[0],
      conversationId: intake.conversationId,
      acceptedMessageId: intake.acceptedMessageId,
      state: request ? apiStateOf(request.state) : 'accepted',
      replayed: intake.replayed,
    },
    dispatched: intake.dispatched,
  };
}

export function sendAgentMessage(principal: Principal, input: SendAgentMessageInput): AcceptedAgentRequest {
  return acceptAgentMessage(principal, input).accepted;
}

function speakerLabel(row: MessageRow): string {
  if (row.sender_kind === 'bot' && row.sender_id) {
    const bot = bots.getById(row.sender_id);
    return bot ? bot.name : `bot:${row.sender_id}`;
  }
  return `${row.sender_kind ?? 'person'}:${row.sender_id ?? 'unknown'}`;
}

function historyFor(request: WorkRequest, bot: Bot): DispatchHistoryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ?
       AND rowid <= (SELECT rowid FROM messages WHERE id = ?)
     ORDER BY rowid ASC`
  ).all(request.source_conversation_id, request.source_event_id) as MessageRow[];
  return rows.map(message => ({
    speakerLabel: speakerLabel(message),
    fromAgent: message.sender_kind === 'bot' && message.sender_id === bot.id,
    content: message.content,
  }));
}

function failRequest(requestId: string, attemptId: string | null, code: string, message: string): void {
  engine.transaction(() => {
    if (attemptId) engine.finishAttempt(attemptId, { outcome: 'failed', errorCategory: code, errorMessage: message });
    const current = engine.getWorkRequest(requestId);
    if (!current || (current.state !== 'queued' && current.state !== 'running')) return;
    engine.transitionWorkRequest(requestId, { from: current.state, to: 'failed', errorCode: code, errorMessage: message });
  });
}

// NOT-469: the process's leased dispatcher (lib/dispatcher). Limits and
// lease timing come from BOTMANCERS_DISPATCH_* (deterministic defaults).
let dispatcher: Dispatcher = createDispatcher(db, engine);

// Test seam: a fresh dispatcher (owner, limits, clock) for this process.
export function configureDispatcher(options: DispatcherOptions = {}): Dispatcher {
  dispatcher = createDispatcher(db, engine, options);
  return dispatcher;
}

export function currentDispatcher(): Dispatcher {
  return dispatcher;
}

// Thrown inside a commit transaction to roll it back when the run may
// still be live: Agent Deck became unreachable while a known run was
// observed (NOT-468 F7), or a launch POST failed without proving that no
// run started. The Attempt stays open and reconciliation retries; with no
// run id that is a same-key re-POST, which returns the run if it exists.
class DeferCommit extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Commit deferred: ${reason}`);
    this.reason = reason;
  }
}

// One Attempt for a queued canonical request, under its validated policy
// (a direct message is a read-only conversation turn; there is no
// automatic review or resume child): claim
// it (queued -> running) with one launch Attempt, run the selected agent
// through its single-Attempt adapter (NOT-467: ./attempt-executor records
// the runtime provenance), then project the reply into the source
// conversation and complete, or fail with a typed code. The adapter never
// writes conversation messages; the projection below does.
//
// NOT-472: a Wake-created request also sees its objective and referenced
// results, and a revision resumes the Session Binding of the
// implementation it names (fail closed when there is none). Edit-authorized
// work binds the session it reports so a later revision can resume it.
// Once the request is terminal, lib/coordinator-loop routes the reply's
// Wakes and continues the coordinator; those requests dispatch here too.
//
// NOT-487: implementation and revision turns prepare Git finalization; the
// Attempt's baseline and candidate manifest are persisted with it. A
// coordinator's accepted finalization decision (recorded by the loop
// follow-up) is submitted here, and its outcome returns to the coordinator.
//
// NOT-469: the claim is a lease (lib/dispatcher). The claim, the Attempt,
// and its launch intent commit in one transaction before the adapter runs;
// the terminal commit is fenced by the lease. A request refused for
// capacity stays queued and is drained when a lease is released.
async function runDispatch(requestId: string): Promise<void> {
  const claimed = await runTurn(requestId);
  // A request that left the queue without a claim (failed before launch)
  // may have been holding back younger deferred work: drain it too.
  afterRequest(requestId, claimed || engine.getWorkRequest(requestId)?.state !== 'queued');
}

function afterRequest(requestId: string, released: boolean): void {
  for (const next of continueAfterTerminal(requestId)) void startAgentDispatch(next);
  advanceExchangeOf(requestId);
  for (const id of openFinalizationIds()) if (!submittedThisProcess.has(id)) void startFinalization(id);
  if (released) drainDeferred();
}

function drainDeferred(): void {
  for (const id of dispatcher.deferredRequestIds()) if (!inFlight.has(id)) void startAgentDispatch(id);
}

// Whether this call claimed (and so later released or handed off) a lease.
async function runTurn(requestId: string): Promise<boolean> {
  const request = engine.getWorkRequest(requestId);
  if (!request || request.state !== 'queued') return false;
  // NOT-473: a retry in its backoff is not claimable yet (the claim
  // refuses it too; this only skips preparing a launch for nothing).
  if (request.next_eligible_at !== null && dispatcher.now() < request.next_eligible_at) return false;
  const bot = bots.getById(request.target_agent_id);
  if (!bot) {
    failRequest(requestId, null, 'agent_unavailable', 'The agent is no longer registered.');
    return false;
  }
  // NOT-471: the stored policy snapshot is re-validated against the
  // request before anything launches. An unknown kind, unsupported
  // authority, or malformed snapshot fails the request with its reason;
  // no Attempt is created and no adapter runs.
  const authorized = authorizeWorkRequest(request);
  if (!authorized.ok) {
    try {
      engine.transitionWorkRequest(requestId, {
        from: 'queued', to: 'failed', expectedVersion: request.version,
        reason: 'policy_rejected', errorCode: authorized.code, errorMessage: authorized.reason,
      });
    } catch (error) {
      if (!(error instanceof EngineStoreError && error.code === 'stale_state')) throw error;
    }
    return false;
  }
  const policy = authorized.policy;
  // NOT-456: the attempt adapter records the dispatched agent identity
  // (hermes|cursor|claude|codex|muse), never Agent Deck.
  const agent = agentForDispatch(bot);
  // NOT-497: an exchange source hop resumes exactly its selected binding.
  const resume = exchanges.resumeFor(request, agent) ?? resumeBindingFor(request, agent);
  if (!resume.ok) {
    try {
      engine.transitionWorkRequest(requestId, {
        from: 'queued', to: 'failed', expectedVersion: request.version,
        reason: 'session_unavailable', errorCode: 'session_unavailable', errorMessage: resume.reason,
      });
    } catch (error) {
      if (!(error instanceof EngineStoreError && error.code === 'stale_state')) throw error;
    }
    return false;
  }
  let prepared: PreparedDispatch | null = null;
  let unprepared: DispatchFailure | null = null;
  try {
    prepared = prepareDispatch({
      bot,
      history: [...historyFor(request, bot), ...turnContext(request), ...(exchanges.turnContext(request) ?? [])],
      toolProfile: policy.tool_profile,
      sessionBinding: resume.binding ? { bindingId: resume.binding.id, externalSessionId: resume.binding.external_session_id } : null,
      ...('freshSession' in resume && resume.freshSession ? { freshSession: true } : {}),
      prepareFinalization: policy.execution_kind === 'implementation' || policy.execution_kind === 'revision',
    });
  } catch (error) {
    unprepared = error instanceof DispatchFailure
      ? error
      : new DispatchFailure('runtime_failed', 'The agent runtime did not complete the turn.');
  }
  const snapshot = { agent, agent_id: bot.id, execution_kind: policy.execution_kind, tool_profile: policy.tool_profile, policy_rule: policy.rule };
  let started: { lease: DispatchLease; attempt: PreparedAttempt | string } | null;
  // NOT-473: the Attempt's cancellation signal and deadline. The deadline
  // (its own timeout or the request deadline, whichever is first) is
  // recorded in the launch snapshot and passed to the adapter.
  const controller = new AbortController();
  let waitingBehind: string | undefined;
  try {
    started = engine.transaction(() => {
      const claim = dispatcher.claim(requestId, { expectedVersion: request.version, data: { agent } });
      if (!claim.ok) {
        waitingBehind = claim.blockedBy;
        return null;
      }
      if (prepared) {
        const startedAt = dispatcher.now();
        const deadlineAt = dispatcher.control.attemptDeadlineFor(claim.request, startedAt);
        const input = { ...prepared.input, deadlineAt, signal: controller.signal };
        const attempt = beginAttempt(engine, requestId, { agent, adapter: prepared.adapter, input, snapshot, now: startedAt });
        dispatcher.recordLaunchIntent(claim.lease, attempt.attempt.id, prepared.adapter.name, prepared.adapter.launchIntent?.(attempt.input) ?? null);
        exchanges.hopClaimed(requestId, attempt.attempt.id, startedAt);
        return { lease: claim.lease, attempt };
      }
      const unpreparedAttempt = engine.createAttempt(requestId, {
        kind: 'launch',
        adapter: agent,
        toolProfile: policy.tool_profile,
        launchSnapshot: snapshot,
      });
      exchanges.hopClaimed(requestId, unpreparedAttempt.id, unpreparedAttempt.started_at);
      return { lease: claim.lease, attempt: unpreparedAttempt.id };
    });
  } catch (error) {
    if (error instanceof EngineStoreError && error.code === 'stale_state') return false;
    throw error;
  }
  if (!started) {
    // NOT-475: the slot belongs to older queued work; make sure it is
    // dispatched (joined when already running). This request stays
    // deferred and drains when a lease is released.
    if (waitingBehind) void startAgentDispatch(waitingBehind);
    return false;
  }
  const { lease } = started;
  if (!prepared || typeof started.attempt === 'string') {
    const failure = unprepared ?? new DispatchFailure('runtime_failed', 'The agent runtime did not complete the turn.');
    const attemptId = typeof started.attempt === 'string' ? started.attempt : started.attempt.attempt.id;
    engine.transaction(() => {
      dispatcher.assertHeld(lease);
      failRequest(requestId, attemptId, failure.code, failure.message);
      dispatcher.release(lease, 'failed');
    });
    return true;
  }

  const attemptId = started.attempt.attempt.id;
  localWork.set(requestId, { attemptId, controller });
  await withHeartbeat(lease, async () => {
    dispatchFault('before_launch', requestId);
    try {
      const ran = await runAttempt(engine, started.attempt as PreparedAttempt, prepared.adapter, {
        // A worker whose lease was taken over writes no runtime events or
        // external ids: the new owner reconciles the run.
        fence: () => dispatcher.holds(lease),
        onEvent: event => {
          // The executor has already persisted the run id for 'started'.
          if (event.type === 'started') dispatchFault('after_run_id_persisted', requestId);
          recordBaselineEvent(lease, attemptId, event);
        },
        // An exchange hop's output is redacted and bounded before it is stored.
        sanitize: result => exchanges.sanitizeHopResult(request, result),
        project: (result, attempt) => commitTurn(lease, request, attempt, result),
      });
      if (ran.abandoned) await recordExternalCancel(ran.abandoned, { localSignalled: true, launched: true });
      if (ran.projected?.retryAt != null) scheduleRetry(requestId, ran.projected.retryAt);
    } catch (error) {
      handleUncommitted(lease, attemptId, error);
    }
  }, controller);
  if (localWork.get(requestId)?.attemptId === attemptId) localWork.delete(requestId);
  return true;
}

// NOT-473: Attempts this process is running, by request, with the signal
// that stops them (cancellation, or an Attempt abandoned by enforcement).
const localWork = new Map<string, { attemptId: string; controller: AbortController }>();

// Starts a scheduled retry once its backoff ends. The durable
// next_eligible_at is authoritative: a sweep also starts eligible retries,
// so a retry survives a restart and this timer is only a shortcut.
function scheduleRetry(requestId: string, at: number): void {
  const timer = setTimeout(() => { void startAgentDispatch(requestId); }, Math.max(0, at - dispatcher.now()));
  if (timer.unref) timer.unref();
}

// Queued retries whose backoff has ended, oldest first.
function eligibleRetryIds(): string[] {
  return (db.prepare(`
    SELECT id FROM work_requests
    WHERE state = 'queued' AND legacy_agent_request_id IS NULL AND executor = 'dispatcher' AND next_eligible_at IS NOT NULL AND next_eligible_at <= ?
    ORDER BY next_eligible_at ASC, id ASC
  `).all(dispatcher.now()) as { id: string }[]).map(row => row.id);
}

// After an Attempt was abandoned: stop this process's wait for it, then
// ask the runtime to stop the run where the transport supports it. The
// result is recorded as is; Botmancers never claims a hard stop it did
// not get.
async function stopAbandoned(abandoned: AbandonedAttempt): Promise<void> {
  const local = localWork.get(abandoned.requestId);
  if (local && local.attemptId === abandoned.attemptId) {
    local.controller.abort();
    // The abandoned worker may never return (a stalled runtime). Keep
    // waiting for it under its own key so a retry of the request can
    // start now instead of joining it.
    const running = inFlight.get(abandoned.requestId);
    if (running) {
      const key = `abandoned:${abandoned.attemptId}`;
      inFlight.delete(abandoned.requestId);
      inFlight.set(key, running);
      void running.finally(() => { if (inFlight.get(key) === running) inFlight.delete(key); });
    }
  }
  await recordExternalCancel(abandoned, { localSignalled: !!local && local.attemptId === abandoned.attemptId, launched: abandoned.launched });
}

// Asks the runtime to stop an abandoned run where its transport can, and
// records the answer. launched: the Attempt is known to have started a
// run even without a run id (a transport like Hermes has none), so a
// missing id means the run cannot be addressed, not that none exists.
async function recordExternalCancel(
  abandoned: Pick<AbandonedAttempt, 'requestId' | 'attemptId' | 'externalRunId' | 'transport'>
    & { reason: AbandonedAttempt['reason'] | LocallyAbandonedAttempt['reason']; externalCancel?: 'failed' | null },
  options: { localSignalled: boolean; launched: boolean },
): Promise<void> {
  const reconciler = abandoned.transport ? adapterForTransport(abandoned.transport)?.reconciler ?? null : null;
  let status: 'requested' | 'failed' | 'unsupported' | 'not_launched';
  // The transport already asked the runtime to stop the run and failed.
  if (abandoned.externalCancel === 'failed') status = 'failed';
  else if (!abandoned.externalRunId) status = options.launched ? 'unsupported' : 'not_launched';
  else if (!reconciler?.cancel) status = 'unsupported';
  else status = await reconciler.cancel(abandoned.externalRunId);
  engine.appendEvent(abandoned.requestId, {
    type: 'external_cancel',
    attemptId: abandoned.attemptId,
    data: { status, reason: abandoned.reason, external_run_id: abandoned.externalRunId, transport: abandoned.transport, local_signalled: options.localSignalled },
    now: dispatcher.now(),
  });
}

// Fenced: dropped once the lease is no longer held.
function recordBaselineEvent(lease: DispatchLease, attemptId: string, event: AttemptEvent): void {
  if (event.type === 'progress' && event.detail.phase === 'finalization_prepared'
    && typeof event.detail.baseline_ref === 'string' && typeof event.detail.baseline_digest === 'string') {
    const baseline = { baselineRef: event.detail.baseline_ref, baselineDigest: event.detail.baseline_digest };
    engine.transaction(() => {
      if (dispatcher.holds(lease)) recordAttemptBaseline(attemptId, baseline, event.at);
    });
  }
}

async function withHeartbeat<T>(lease: DispatchLease, fn: () => Promise<T>, controller?: AbortController): Promise<T> {
  const timer = setInterval(() => {
    try {
      dispatcher.heartbeat(lease);
      // NOT-473: a cancellation requested from any process (or a request
      // another worker already ended) stops this worker's Attempt.
      const current = engine.getWorkRequest(lease.requestId);
      if (controller && current && (current.cancel_requested_at !== null || TERMINAL_STATES.includes(current.state))) controller.abort();
    } catch (error) { console.error('Dispatch heartbeat failed:', error); }
  }, dispatcher.config.heartbeatMs);
  if (timer.unref) timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// A commit that did not happen: the lease moved to another worker (which
// reconciles the same run), or the run may still be live (DeferCommit).
function handleUncommitted(lease: DispatchLease, attemptId: string | null, error: unknown): void {
  if (error instanceof LeaseLostError) return;
  if (error instanceof DeferCommit) {
    try {
      dispatcher.defer(lease, error.reason, attemptId);
    } catch (deferError) {
      if (!(deferError instanceof LeaseLostError)) throw deferError;
    }
    return;
  }
  throw error;
}

// The terminal commit of one Attempt result, inside the transaction that
// finishes the Attempt and fenced by the lease: project the reply into the
// source conversation and complete, or fail with a typed code, then
// release the lease. Shared by a live run and a reattached one.
//
// NOT-473: a cancellation intent or a passed request deadline decides
// before the result does: the request ends cancelled or timed out and a
// successful result is kept as evidence only. A failure is settled under
// the request's bounded retry policy (retry scheduled, exhausted, operator
// attention, or failed); retryAt names a scheduled retry.
function commitTurn(lease: DispatchLease, request: WorkRequest, attempt: WorkAttempt, result: AttemptResult): { retryAt: number | null } {
  dispatchFault('before_terminal_commit', request.id);
  dispatcher.assertHeld(lease);
  if (result.status === 'failed' && result.failure?.code === 'agent_deck_unreachable' && attempt.external_run_id) {
    throw new DeferCommit('unreachable');
  }
  if (result.status === 'failed' && result.launchUnconfirmed && !attempt.external_run_id) {
    throw new DeferCommit('launch_unconfirmed');
  }
  const requestId = request.id;
  const now = dispatcher.now();
  recordPreparedEvidence(request, attempt, result, now);
  const current = engine.getWorkRequest(requestId) ?? request;
  const cancelled = current.cancel_requested_at !== null;
  if (cancelled || (current.deadline_at !== null && now >= current.deadline_at)) {
    if (cancelled) {
      engine.transitionWorkRequest(requestId, {
        from: 'running', to: 'cancelled', reason: 'cancel_requested', errorCode: 'cancelled',
        errorMessage: current.cancel_reason ?? 'The request was cancelled.', data: { attempt_outcome: attempt.outcome }, now,
      });
    } else {
      engine.transitionWorkRequest(requestId, {
        from: 'running', to: 'failed', reason: 'timed_out', errorCode: 'timed_out', errorMessage: 'The request passed its deadline.',
        data: { deadline_at: current.deadline_at, attempt_outcome: attempt.outcome }, now,
      });
    }
    if (result.status === 'completed') recordLateResult(engine, attempt, result, now);
    dispatcher.release(lease, cancelled ? 'cancelled' : 'timed_out');
    return { retryAt: null };
  }
  if (result.status !== 'completed' || result.output === null) {
    const failure = dispatchFailureFor(result);
    // A run the runtime would not stop may still be working: never
    // retried automatically (a second Attempt would race it); an operator
    // decides.
    const settled = dispatcher.control.settleFailure(requestId, {
      category: result.status === 'completed' ? 'result_contract' : result.failure?.category ?? 'runtime_failed',
      code: result.failure?.code ?? null,
      errorCode: failure.code,
      errorMessage: failure.message,
      ...(result.externalCancel === 'failed' ? { attention: 'external_cancel_failed' } : {}),
    }, now);
    dispatcher.release(lease, settled.outcome);
    return { retryAt: settled.decision.action === 'retry' ? settled.decision.nextEligibleAt : null };
  }
  // NOT-497: an exchange hop projects through the exchange (answer to the
  // origin conversation, packet stored, destination session bound) and
  // the exchange advances in this same transaction.
  const hop = hopOf(request);
  if (hop) {
    const hopResult = exchanges.commitHop(request, attempt, result, now);
    engine.transitionWorkRequest(requestId, { from: 'running', to: 'completed', result: hopResult, now });
    dispatcher.release(lease, 'completed');
    // A queued destination hop is dispatched by afterRequest.
    exchanges.advance(hop.exchangeId, now);
    return { retryAt: null };
  }
  const replyId = randomUUID();
  db.prepare(
    'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(replyId, request.source_conversation_id, 'bot', request.target_agent_id, 'bot', requestId, result.output, now);
  if (request.tool_profile === 'edit' && result.externalSessionId) {
    engine.bindSession({
      agentId: request.target_agent_id, adapter: attempt.adapter, externalSessionId: result.externalSessionId,
      conversationId: request.source_conversation_id, requestId, sourceAttemptId: attempt.id, now,
    });
  }
  engine.transitionWorkRequest(requestId, { from: 'running', to: 'completed', result: { reply_message_id: replyId }, now });
  dispatcher.release(lease, 'completed');
  return { retryAt: null };
}

function observationData(observation: RunObservation | null): Record<string, unknown> | null {
  if (!observation) return null;
  return {
    kind: observation.kind,
    ...(observation.kind === 'run' ? { state: observation.state } : {}),
    ...(observation.kind === 'accepted' ? { run_id: observation.runId } : {}),
    ...(observation.kind === 'rejected' ? { status: observation.status, code: observation.code } : {}),
  };
}

// NOT-469: reconciles one taken-over request from its persisted Attempt and
// public runtime evidence, through the accepted NOT-468 decision table
// (lib/dispatcher). Never relaunches an ambiguous run.
//
// NOT-473: a cancellation intent or a passed deadline wins at every
// boundary, not only on entry: each reconciliation write (and each step
// after runtime I/O) runs under controlled(), which in the same
// transaction asserts the lease and re-runs forced enforcement. When
// enforcement ends the request, nothing more is decided here: the
// abandoned run is stopped where the runtime can stop it.
async function reconcileRequest(lease: DispatchLease): Promise<void> {
  const request = engine.getWorkRequest(lease.requestId);
  if (!request || request.state !== 'running') {
    dispatcher.release(lease, 'stale');
    return;
  }
  const controlled = async <T>(write: () => T, won?: () => void): Promise<{ won: true } | { won: false; value: T }> => {
    const outcome = engine.transaction((): { enforced: EnforcedRequest } | { value: T } => {
      dispatcher.assertHeld(lease);
      const enforced = dispatcher.control.enforceRequest(request.id, dispatcher.now(), { force: true });
      if (enforced) {
        won?.();
        return { enforced };
      }
      return { value: write() };
    });
    if ('enforced' in outcome) {
      if (outcome.enforced.abandoned) await stopAbandoned(outcome.enforced.abandoned);
      return { won: true };
    }
    return { won: false, value: outcome.value };
  };
  let openAttemptId: string | null = null;
  try {
    // A request whose cancellation was requested (its worker is gone:
    // this sweep took the lease over) or whose deadline passed is not
    // reconciled into a result: its Attempt is abandoned.
    if ((await controlled(() => undefined)).won) return;
    const attempt = engine.listAttempts(request.id).find(row => row.finished_at === null);
    if (!attempt) {
      // A running request with no open Attempt never launched under it.
      engine.transaction(() => {
        dispatcher.assertHeld(lease);
        engine.transitionWorkRequest(request.id, {
          from: 'running', to: 'failed', reason: 'retryable', errorCode: 'interrupted',
          errorMessage: 'The request was interrupted before its Attempt was recorded.',
        });
        dispatcher.release(lease, 'interrupted');
      });
      return;
    }
    openAttemptId = attempt.id;
    let snapshot: Record<string, unknown> = {};
    try { snapshot = JSON.parse(attempt.launch_snapshot) as Record<string, unknown>; } catch { /* no transport: unobservable */ }
    const adapter = typeof snapshot.transport === 'string' ? adapterForTransport(snapshot.transport) : null;
    const reconciler = adapter?.reconciler ?? null;
    const decidedEvent = (phase: 'launch' | 'run', decision: ReconcileDecision, observation: RunObservation | null, runId: string | null) => {
      engine.appendEvent(request.id, {
        type: 'reconcile_decided', attemptId: attempt.id,
        data: { phase, ...decision, external_run_id: runId, observation: observationData(observation) },
      });
    };
    const decided = async (phase: 'launch' | 'run', decision: ReconcileDecision, observation: RunObservation | null, runId: string | null) =>
      !(await controlled(() => decidedEvent(phase, decision, observation, runId))).won;

    let runId = attempt.external_run_id;
    let decision: ReconcileDecision;
    let observation: RunObservation | null = null;
    if (!runId) {
      const intent = dispatcher.launchIntent(attempt.id);
      decision = decideWithoutRunId({ reconcilable: !!reconciler, intent, currentGrantFingerprint: reconciler?.currentGrantFingerprint() ?? null });
      if (decision.action === 'repost' && reconciler && intent?.body && intent.idempotency_key) {
        // The decision to re-POST is durable before the POST; its answer
        // is recorded as a second decision below. Nothing is POSTed once
        // the request was cancelled or passed its deadline.
        if (!(await decided('launch', decision, null, null))) return;
        observation = await reconciler.repost({ idempotencyKey: intent.idempotency_key, body: intent.body });
        decision = decideRepostResult(observation);
        if (observation.kind === 'accepted') {
          const accepted = observation.runId;
          // The accepted run id is persisted before any control decision,
          // so a cancellation or deadline can address the run it names.
          const late = acceptRepostedRun(lease, request.id, attempt.id, accepted, adapter?.name ?? null);
          if (late) {
            await recordExternalCancel(late, { localSignalled: false, launched: true });
            return;
          }
          runId = accepted;
        }
      }
      if (!(await decided('launch', decision, observation, runId))) return;
    } else if (!reconciler) {
      decision = { action: 'interrupted', reason: 'runtime_unobservable' };
      if (!(await decided('run', decision, null, runId))) return;
    } else {
      observation = await reconciler.inspect(runId);
      decision = decideWithRunId(observation);
      if (!(await decided('run', decision, observation, runId))) return;
    }

    const prepare = snapshot.prepare_finalization === true;
    switch (decision.action) {
      case 'defer':
        await controlled(() => dispatcher.defer(lease, decision.reason, attempt.id));
        return;
      case 'attention':
        await controlled(() => dispatcher.setAttention(lease, {
          attemptId: attempt.id, reason: decision.reason, detail: observation ? JSON.stringify(observationData(observation)) : null,
        }));
        return;
      case 'interrupted_attention': {
        // Keep what the dead run left for the operator, then end the
        // Attempt interrupted and stop automation (never auto-retry).
        const evidence = prepare && reconciler && runId ? await reconciler.evidence(runId) : null;
        const keepEvidence = (finished: WorkAttempt | null | undefined) => {
          if (evidence && finished) recordPreparedEvidence(request, finished, { finalization: evidence } as AttemptResult);
        };
        await controlled(() => {
          keepEvidence(engine.finishAttempt(attempt.id, {
            outcome: 'interrupted', errorCategory: 'interrupted', errorMessage: `Agent Deck run ${runId} died.`,
          }));
          dispatcher.setAttention(lease, { attemptId: attempt.id, reason: decision.reason });
        }, () => keepEvidence(engine.getAttempt(attempt.id)));
        return;
      }
      case 'fail':
        await controlled(() => {
          engine.finishAttempt(attempt.id, { outcome: 'failed', errorCategory: decision.category, errorMessage: `Agent Deck refused the launch (${decision.code}).` });
          engine.transitionWorkRequest(request.id, {
            from: 'running', to: 'failed', reason: 'retryable', errorCode: 'runtime_failed', errorMessage: 'The agent runtime did not start the turn.',
          });
          dispatcher.release(lease, 'failed');
        });
        return;
      case 'interrupted':
        await controlled(() => {
          engine.finishAttempt(attempt.id, {
            outcome: 'interrupted', errorCategory: 'interrupted', errorMessage: 'The runtime cannot be observed after a restart; the outcome is unknown.',
          });
          engine.transitionWorkRequest(request.id, {
            from: 'running', to: 'failed', reason: 'retryable', errorCode: 'interrupted',
            errorMessage: 'The agent turn was interrupted by a restart. It was not relaunched.',
          });
          dispatcher.release(lease, 'interrupted');
        });
        return;
      case 'repost':
      case 'reattach':
        break;
    }
    if (!reconciler || !runId) return;
    const followRunId = runId;
    const bindingId = typeof snapshot.session_binding_id === 'string' ? snapshot.session_binding_id : null;
    const binding = bindingId
      ? db.prepare('SELECT external_session_id FROM session_bindings WHERE id = ?').get(bindingId) as { external_session_id: string } | undefined
      : undefined;
    const controller = new AbortController();
    // Registered with the last control check, so a cancel command from
    // here on signals the follow.
    if ((await controlled(() => localWork.set(request.id, { attemptId: attempt.id, controller }))).won) return;
    await withHeartbeat(lease, async () => {
      const followed = await reconciler.follow(followRunId, {
        resumeSessionId: binding?.external_session_id ?? null,
        prepareFinalization: prepare,
        deadlineAt: typeof snapshot.deadline_at === 'number' ? snapshot.deadline_at : null,
        signal: controller.signal,
      }, event => recordBaselineEvent(lease, attempt.id, event));
      const result = exchanges.sanitizeHopResult(request, followed);
      let abandoned: LocallyAbandonedAttempt | null = null;
      const committed = engine.transaction(() => {
        // Abandoned meanwhile (cancellation or a deadline): evidence only.
        const current = engine.getAttempt(attempt.id);
        if (current && current.finished_at !== null) {
          recordLateResult(engine, current, result, dispatcher.now());
          return { retryAt: null };
        }
        dispatcher.assertHeld(lease);
        if (result.status === 'failed' && result.failure?.code === 'agent_deck_unreachable') throw new DeferCommit('unreachable');
        // A followed run whose cancel the runtime did not accept was only
        // abandoned, exactly as in runAttempt.
        abandoned = adapter ? abandonedLocally(attempt, adapter, controller.signal, result) : null;
        const finished = abandoned ? recordAbandonedResult(engine, abandoned, result) : recordAttemptResult(engine, attempt.id, result);
        return commitTurn(lease, request, finished, result);
      });
      if (abandoned) await recordExternalCancel(abandoned, { localSignalled: true, launched: true });
      if (committed.retryAt !== null) scheduleRetry(request.id, committed.retryAt);
    }, controller).finally(() => {
      if (localWork.get(request.id)?.attemptId === attempt.id) localWork.delete(request.id);
    });
  } catch (error) {
    handleUncommitted(lease, openAttemptId, error);
  }
}

// Persists the run id a reconcile re-POST was answered with. When the
// Attempt was abandoned while the POST was in flight (a deadline enforced
// by another sweep), the run is recorded on it as evidence and returned so
// the caller asks the runtime to stop it; otherwise null.
function acceptRepostedRun(lease: DispatchLease, requestId: string, attemptId: string, runId: string, adapterName: string | null): AbandonedAttempt | null {
  return engine.transaction((): AbandonedAttempt | null => {
    const current = engine.getAttempt(attemptId);
    if (!current) return null;
    if (current.finished_at === null) {
      dispatcher.assertHeld(lease);
      engine.recordAttemptExternalIds(attemptId, { externalRunId: runId });
      engine.appendEvent(requestId, {
        type: 'runtime_started', attemptId,
        data: { adapter: adapterName, external_run_id: runId, recovered: true },
      });
      return null;
    }
    db.prepare('UPDATE work_attempts SET external_run_id = ? WHERE id = ? AND external_run_id IS NULL').run(runId, attemptId);
    engine.appendEvent(requestId, {
      type: 'runtime_started', attemptId,
      data: { adapter: adapterName, external_run_id: runId, recovered: true, after_abandon: true },
    });
    const reason = current.outcome === 'timed_out' ? 'timed_out' : current.outcome === 'cancelled' ? 'cancelled' : 'retried';
    let transport: string | null = null;
    try { const snapshot = JSON.parse(current.launch_snapshot) as { transport?: unknown }; transport = typeof snapshot.transport === 'string' ? snapshot.transport : null; } catch { /* none */ }
    return { requestId, attemptId, externalRunId: runId, transport, reason, launched: true };
  });
}

// NOT-469: one recovery sweep. Takes over expired leases, leases of
// exited local processes, and unleased running requests, reconciles each,
// then drains capacity-deferred requests. Runs at startup and
// periodically; safe to run from several workers at once.
export function sweepDispatch(): Promise<void> {
  const tasks: Promise<void>[] = [];
  // NOT-473: deadlines and overdue cancellations first, so nothing past
  // them is reconciled or launched.
  for (const enforced of dispatcher.control.enforceDue()) {
    tasks.push((enforced.abandoned ? stopAbandoned(enforced.abandoned) : Promise.resolve())
      .then(() => afterRequest(enforced.requestId, true))
      .catch(error => { console.error('Request enforcement follow-up failed:', error); }));
  }
  for (const item of dispatcher.recoverable()) {
    const key = `reconcile:${item.requestId}`;
    if (inFlight.has(key) || inFlight.has(item.requestId)) continue;
    const lease = dispatcher.takeOver(item);
    if (!lease) continue;
    const promise = reconcileRequest(lease)
      .then(() => afterRequest(item.requestId, !dispatcher.holds(lease)))
      .catch(error => {
        console.error('Dispatch reconciliation failed unexpectedly:', error);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    tasks.push(promise);
  }
  drainDeferred();
  for (const id of eligibleRetryIds()) if (!inFlight.has(id)) void startAgentDispatch(id);
  return Promise.all(tasks).then(() => undefined);
}

// ---------------------------------------------------------------------
// NOT-473: cancel and retry commands (lib/work-request-control). The
// decision commits first; then this process's worker is signalled, the
// runtime is asked to stop an abandoned run where it can, and loop
// follow-ups run for a request that ended.

export interface RequestCommandOptions {
  actor?: ControlActor;
  reason?: string | null;
  authorize?: ControlAuthorizer;
}

export async function cancelWorkRequest(requestId: string, options: RequestCommandOptions = {}): Promise<CancelResult> {
  const result = dispatcher.control.cancel(requestId, options);
  if (result.outcome === 'cancel_requested' && !result.replayed) {
    // The worker ends the request cancelled once its Attempt returns.
    localWork.get(requestId)?.controller.abort();
  }
  if (result.abandoned) await stopAbandoned(result.abandoned);
  if (result.outcome === 'cancelled' && !result.replayed) afterRequest(requestId, true);
  return result;
}

export async function retryWorkRequest(requestId: string, options: RequestCommandOptions = {}): Promise<RetryResult> {
  const result = dispatcher.control.retry(requestId, options);
  if (result.abandoned) await stopAbandoned(result.abandoned);
  if (result.outcome === 'retry_scheduled') void startAgentDispatch(requestId);
  return result;
}

// Default authorization of the principal-facing commands: a participant
// of the request's source conversation, as for reading it.
const participantMayControl: ControlAuthorizer = (actor, request) =>
  isPrincipalKind(actor.kind) && isParticipant(request.source_conversation_id, { kind: actor.kind, id: actor.id });

function controlError(error: unknown): never {
  if (error instanceof ControlError) {
    throw new AgentApiError('request_not_found', 'No request with that id is visible to this principal.');
  }
  throw error;
}

export async function cancelAgentRequest(principal: Principal, requestId: string, reason: string | null = null): Promise<CancelResult> {
  assertKnownPrincipal(principal);
  try {
    return await cancelWorkRequest(requestId, { actor: principal, reason, authorize: participantMayControl });
  } catch (error) {
    return controlError(error);
  }
}

export async function retryAgentRequest(principal: Principal, requestId: string): Promise<RetryResult> {
  assertKnownPrincipal(principal);
  try {
    return await retryWorkRequest(requestId, { actor: principal, authorize: participantMayControl });
  } catch (error) {
    return controlError(error);
  }
}

// ---------------------------------------------------------------------
// NOT-475: the owner's grant commands. The decision commits first (owner
// only, lib/wake-router decideWakeGrant); then an admitted request is
// dispatched, and a denied one runs its loop follow-up so the coordinator
// is told no work ran.

export interface WakeCommandCaller {
  category: CallerCategory;
  principal: Principal;
}

export function decideWakeGrantCommand(wakeId: string, decision: 'allow' | 'deny', caller: WakeCommandCaller): GrantDecisionResult {
  const result = decideWakeGrant({ wakeId, decision, caller });
  if (result.request && result.runnable) void startAgentDispatch(result.request.id);
  if (result.request && result.ended) for (const next of continueAfterTerminal(result.request.id)) void startAgentDispatch(next);
  return result;
}

// Re-checks a blocked or unavailable Wake (grant, target availability)
// and dispatches its request once it is queued.
export function retryWakeCommand(wakeId: string): RoutedWake {
  const result = retryWake(wakeId);
  if (result.request?.state === 'queued') void startAgentDispatch(result.request.id);
  return result;
}

export function revokeWakeGrantCommand(grantId: string, caller: WakeCommandCaller): { grant: WakeGrant; revoked: boolean } {
  return revokeWakeGrant(grantId, caller);
}

const inFlight = new Map<string, Promise<void>>();

// Starts (or joins) the dispatch of one queued request. Requests past
// 'queued' are never re-dispatched, so exact retries launch nothing.
export function startAgentDispatch(requestId: string): Promise<void> {
  const running = inFlight.get(requestId);
  if (running) return running;
  const promise: Promise<void> = runDispatch(requestId)
    .catch(error => {
      console.error('Agent dispatch failed unexpectedly:', error);
    })
    .finally(() => {
      if (inFlight.get(requestId) === promise) inFlight.delete(requestId);
    });
  inFlight.set(requestId, promise);
  return promise;
}

// NOT-487: submits one open finalization (joined when already running),
// then returns its outcome to the coordinator. A finalization left open by
// a transport failure stays open for the next recovery pass.
// Finalizations submitted since this process started. A new decision
// starts only its own; recoverCoordinatorLoops retries every open one.
const submittedThisProcess = new Set<string>();

export function startFinalization(finalizationId: string): Promise<void> {
  const key = `finalization:${finalizationId}`;
  const running = inFlight.get(key);
  if (running) return running;
  submittedThisProcess.add(finalizationId);
  const promise = runFinalization(finalizationId)
    .then(row => {
      if (row && row.state !== 'preparing') for (const next of continueAfterFinalization(row.id)) void startAgentDispatch(next);
    })
    .catch(error => {
      console.error('Finalization failed unexpectedly:', error instanceof Error ? error.message : 'unknown error');
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

// Resolves once no dispatch (including coordinator loop follow-ups it
// started) is in flight.
export async function waitForAgentDispatchIdle(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
}

// NOT-472 restart recovery: replays terminal requests' loop follow-ups
// from durable state (idempotent) and dispatches what is still queued.
export function recoverCoordinatorLoops(): Promise<void> {
  return Promise.all([
    // NOT-469: reconcile open Attempts before anything new is claimed.
    sweepDispatch(),
    ...pendingCoordinatorWork().map(startAgentDispatch),
    ...openFinalizationIds().map(startFinalization),
    // NOT-497: advance every open exchange from its hops' durable state
    // and dispatch its queued hop (never a failed one again).
    ...recoverExchanges().map(startAgentDispatch),
  ]).then(() => undefined);
}

// ---------------------------------------------------------------------
// NOT-497: session-targeted Ask and Continue exchanges
// (lib/session-exchanges). Hops are Work Requests this dispatcher runs; the
// commands here create, read, and cancel exchanges for the owner.

export const exchanges = createExchangeStore(db, engine);

// After a hop request left the queue or ended: advance its exchange and
// dispatch the hop it queued (a Continue's destination).
function advanceExchangeOf(requestId: string): void {
  const row = exchanges.forHopRequest(requestId);
  if (!row) return;
  try {
    for (const id of exchanges.advance(row.id)) void startAgentDispatch(id);
  } catch (error) {
    console.error('Exchange advance failed:', error instanceof Error ? error.message : 'unknown error');
  }
}

function recoverExchanges(): string[] {
  const ids: string[] = [];
  for (const id of exchanges.openIds()) {
    try {
      ids.push(...exchanges.advance(id));
    } catch (error) {
      console.error('Exchange recovery failed:', error instanceof Error ? error.message : 'unknown error');
    }
  }
  return ids;
}

export function createExchangeCommand(input: CreateExchangeInput): { exchange: ExchangeView; created: boolean; dispatched: Promise<void> } {
  const { exchange, created } = exchanges.create(input);
  const dispatched = dispatchExchange(exchange.id);
  return { exchange: exchanges.view(exchange.id), created, dispatched };
}

// Advances one exchange and dispatches its queued hop. An exact replay
// dispatches whatever is still queued (idempotent). NOT-499: the service
// API creates exchanges in its own transaction and dispatches through this.
export function dispatchExchange(id: string): Promise<void> {
  return Promise.all(exchanges.advance(id).map(startAgentDispatch)).then(() => undefined);
}

export function getExchangeView(id: string): ExchangeView {
  return exchanges.view(id);
}

// Owner cancellation while non-terminal: the intent is recorded once, the
// open hop request is cancelled (a running Attempt is signalled and its
// result discarded), and the exchange ends cancelled once that hop has
// ended. A queued destination is never launched after it.
export async function cancelExchangeCommand(
  id: string, actor: { kind: string; id: string }, reason: string | null = null,
): Promise<{ exchange: ExchangeView; replayed: boolean }> {
  const { hopRequestId, replayed } = exchanges.requestCancel(id, actor, reason);
  if (hopRequestId) {
    const request = engine.getWorkRequest(hopRequestId);
    if (request && !TERMINAL_STATES.includes(request.state)) {
      try {
        await cancelWorkRequest(hopRequestId, { actor, reason: reason ?? 'The exchange was cancelled.' });
      } catch (error) {
        if (!(error instanceof ControlError)) throw error;
      }
    }
  }
  exchanges.advance(id);
  return { exchange: exchanges.view(id), replayed };
}

export { ExchangeError };

// Engine event types in the documented request event vocabulary
// (accepted > dispatched > runtime_started > completed|failed). Attempt
// bookkeeping stays internal.
const INTERNAL_EVENT_TYPES = [
  'attempt_started', 'attempt_finished', 'session_bound', 'backfilled', 'runtime_progress', 'policy_selected',
  // NOT-469 dispatcher bookkeeping.
  'dispatch_claimed', 'dispatch_released', 'dispatch_deferred', 'dispatch_lease_taken_over', 'launch_intent_recorded',
  'reconcile_decided', 'reconcile_deferred', 'attention_set',
  // NOT-473 evidence of abandoned Attempts.
  'attempt_abandoned', 'external_cancel', 'late_result_recorded',
];

function apiEventType(event: EngineEvent): string | null {
  if (event.type === 'state_changed') {
    const to = event.data ? (JSON.parse(event.data) as { to?: WorkRequestState }).to : undefined;
    if (to === 'running') return 'dispatched';
    if (to === 'completed') return 'completed';
    if (to === 'failed' || to === 'cancelled') return 'failed';
    return to ?? null;
  }
  if (INTERNAL_EVENT_TYPES.includes(event.type)) return null;
  return event.type;
}

function workRequestView(request: WorkRequest): AgentRequestView {
  const result = request.result ? (JSON.parse(request.result) as { reply_message_id?: string; answer_message_id?: string }) : null;
  // NOT-499: a service's session message is an Ask hop. Its caller sees it
  // in the origin conversation it asked from (never the session's own
  // thread): the accepted message is the one the service sent there and
  // the reply is the Ask answer.
  const ask = hopOf(request)?.hop === 'ask' ? exchanges.forHopRequest(request.id) : undefined;
  const replyId = ask ? result?.answer_message_id : result?.reply_message_id;
  const reply = replyId
    ? (db.prepare('SELECT id, content FROM messages WHERE id = ?').get(replyId) as { id: string; content: string } | undefined)
    : undefined;
  const askedMessage = ask
    ? db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND request_id = ? AND sender_kind = ? ORDER BY rowid ASC LIMIT 1")
      .get(ask.origin_conversation_id, request.id, ask.requester_kind) as { id: string } | undefined
    : undefined;
  const failed = request.state === 'failed' || request.state === 'cancelled';
  return {
    requestId: publicRequestId(request),
    conversationId: ask ? ask.origin_conversation_id : request.source_conversation_id,
    agentId: request.target_agent_id,
    acceptedMessageId: askedMessage ? askedMessage.id : request.source_event_id,
    state: apiStateOf(request.state),
    reply: reply ? { messageId: reply.id, content: reply.content } : null,
    failure: failed ? { code: request.error_code ?? request.state, message: request.error_message ?? '' } : null,
    events: engine.listEvents(request.id).flatMap(event => {
      const type = apiEventType(event);
      return type ? [{ type, at: event.created_at }] : [];
    }),
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

// A request accepted before NOT-465 keeps the id its caller was given.
function publicRequestId(request: WorkRequest): string {
  return request.legacy_agent_request_id ?? request.id;
}

// The canonical Work Request behind a public request id, when the principal
// participates in its source conversation (NOT-491: the MCP bridge reads
// the lifecycle state through this same check), or (NOT-499) it is a hop
// of an exchange the principal requested.
export function getAuthorizedWorkRequest(principal: Principal, requestId: string): WorkRequest {
  assertKnownPrincipal(principal);
  const migrated = db.prepare('SELECT id FROM work_requests WHERE legacy_agent_request_id = ?').get(requestId) as { id: string } | undefined;
  const request = engine.getWorkRequest(migrated ? migrated.id : requestId);
  if (!request || !(isParticipant(request.source_conversation_id, principal) || requestedExchangeHop(principal, request))) {
    throw new AgentApiError('request_not_found', 'No request with that id is visible to this principal.');
  }
  return request;
}

function requestedExchangeHop(principal: Principal, request: WorkRequest): boolean {
  if (!hopOf(request)) return false;
  const row = exchanges.forHopRequest(request.id);
  return !!row && row.requester_kind === principal.kind && row.requester_id === principal.id;
}

export function getAgentRequest(principal: Principal, requestId: string): AgentRequestView {
  return workRequestView(getAuthorizedWorkRequest(principal, requestId));
}

const CONVERSATION_TYPE_VIEW: Record<string, ConversationView['type']> = {
  agent: 'agent',
  bot: 'direct',
  group: 'group',
};

export function getConversation(principal: Principal, conversationId: string): ConversationView {
  assertKnownPrincipal(principal);
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | { id: string; type: string; origin_kind: PrincipalKind | null; origin_id: string | null }
    | undefined;
  if (!conversation || !isParticipant(conversation.id, principal)) {
    throw new AgentApiError('conversation_not_found', 'No conversation with that id is visible to this principal.');
  }
  const participants = db.prepare(
    'SELECT participant_kind, participant_id, joined_at FROM conversation_participants WHERE conversation_id = ? ORDER BY joined_at ASC, rowid ASC'
  ).all(conversation.id) as { participant_kind: PrincipalKind; participant_id: string; joined_at: number }[];
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC'
  ).all(conversation.id) as MessageRow[];
  return {
    conversationId: conversation.id,
    type: CONVERSATION_TYPE_VIEW[conversation.type] ?? 'agent',
    origin: conversation.origin_kind && conversation.origin_id
      ? { kind: conversation.origin_kind, id: conversation.origin_id }
      : null,
    participants: participants.map(row => ({ kind: row.participant_kind, id: row.participant_id, joinedAt: row.joined_at })),
    messages: rows.map((row, index) => ({
      messageId: row.id,
      seq: index + 1,
      sender: senderOf(row, conversation),
      content: row.content,
      requestId: row.request_id,
      createdAt: row.created_at,
    })),
    events: projector.listConversationEvents(conversation.id),
  };
}

// Legacy UI user messages carry no sender id; they were written by the
// conversation's UI owner origin.
function senderOf(row: MessageRow, conversation: { origin_kind: PrincipalKind | null; origin_id: string | null }): Principal {
  const kind: PrincipalKind = row.sender_kind ?? (row.sender_type === 'bot' ? 'bot' : 'person');
  if (row.sender_id) return { kind, id: row.sender_id };
  if (kind !== 'bot' && conversation.origin_kind === kind && conversation.origin_id) {
    return { kind, id: conversation.origin_id };
  }
  return { kind, id: 'unknown' };
}
