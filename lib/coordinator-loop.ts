// NOT-472: coordinator-led loops (docs/core-engine.md, Coordinator Agent and
// Delegation and review policy; docs/wake-contract-v1.md, Coordinator loop).
//
// The engine delivers; the coordinator decides. When a canonical Work
// Request ends, continueAfterTerminal:
//
//   1. routes the Wakes in its reply (lib/wake-router), so a coordinator
//      turn that emits implementation, review, or revision Wakes creates
//      exactly those requests and nothing else;
//   2. tells the replying Agent, in one read-only continuation turn, about
//      any of those Wakes that did not start (rejected, unavailable,
//      blocked), so it never assumes work happened that did not;
//   3. returns a Wake-created request's terminal result to the Agent that
//      woke it (policy_snapshot.return_to) as exactly one read-only
//      continuation turn carrying the canonical Work Request reference and
//      the result evidence.
//
// Nothing here picks a next stage: an implementation result does not wake
// a reviewer and a review does not wake a revision. Only a coordinator's
// own Wake does. The loop ends when the coordinator replies without a
// Wake or a safety limit (lib/wake-router limits, the continuation budget
// below) stops it.
//
// Idempotency: continuations are keyed by what they continue (the
// specialist request, or the Wake source event) under one engine
// requester, and Wake routing is keyed by source event, so replaying a
// terminal request, in this process or after a restart, creates nothing
// new. pendingCoordinatorWork rebuilds the same state from durable rows.
//
// Continuation context names Work Requests by canonical id only; external
// run and session identifiers stay in Attempts and Session Bindings.
import db, { bots, engine, type Message } from './db';
import type { SessionBinding, WorkRequest } from './engine-store';
import { selectExecutionPolicy } from './execution-policy';
import { routeAgentWakes, WakeRouterError, type RoutedWake } from './wake-router';
import type { DispatchHistoryEntry } from './agent-dispatch';

// Continuation turns per root lineage. Placeholder value until the owner
// confirms it; change one line here.
export const COORDINATOR_MAX_CONTINUATIONS = 32;

// The engine itself requests continuation turns.
export const ENGINE_REQUESTER = { kind: 'service', id: 'botmancers-engine' } as const;

export const ENGINE_SPEAKER = 'Botmancers';

const RESULT_EVIDENCE_LIMIT = 8000;

export interface ReturnTarget {
  agentId: string;
  conversationId: string;
}

interface StoredPolicy {
  source?: string;
  return_to?: { agent_id?: unknown; conversation_id?: unknown };
  resume_work_request?: unknown;
  context_work_requests?: unknown;
}

function storedPolicy(request: WorkRequest): StoredPolicy {
  try {
    const parsed = JSON.parse(request.policy_snapshot) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredPolicy : {};
  } catch {
    return {};
  }
}

export function isContinuation(request: WorkRequest): boolean {
  return request.requester_kind === ENGINE_REQUESTER.kind && request.requester_id === ENGINE_REQUESTER.id
    && storedPolicy(request).source === 'coordinator_continuation';
}

// Where a Wake-created request's result returns, or null for any other
// request (a direct message, a continuation).
export function returnTargetOf(request: WorkRequest): ReturnTarget | null {
  if (!request.wake_event_id) return null;
  const back = storedPolicy(request).return_to;
  if (!back || typeof back.agent_id !== 'string' || typeof back.conversation_id !== 'string') return null;
  return { agentId: back.agent_id, conversationId: back.conversation_id };
}

function agentName(id: string): string {
  return bots.getById(id)?.name ?? `agent:${id}`;
}

// The reply message a completed request projected, sent by its target.
function replyOf(request: WorkRequest): Message | null {
  if (request.state !== 'completed' || !request.result) return null;
  let replyId: unknown;
  try {
    replyId = (JSON.parse(request.result) as { reply_message_id?: unknown }).reply_message_id;
  } catch {
    return null;
  }
  if (typeof replyId !== 'string') return null;
  const reply = db.prepare('SELECT * FROM messages WHERE id = ?').get(replyId) as Message | undefined;
  return reply && reply.sender_type === 'bot' && reply.sender_id === request.target_agent_id ? reply : null;
}

function bounded(text: string): string {
  return text.length > RESULT_EVIDENCE_LIMIT ? `${text.slice(0, RESULT_EVIDENCE_LIMIT)}\n[truncated]` : text;
}

// Canonical reference plus result evidence of one request. Failure text
// is the request's fixed caller-facing message, never adapter output.
export function resultEvidence(request: WorkRequest): string {
  const lines = [
    `Work Request: ${request.id}`,
    `Agent: ${agentName(request.target_agent_id)}`,
    `Execution kind: ${request.execution_kind}`,
    `State: ${request.state}`,
  ];
  const reply = replyOf(request);
  if (reply) lines.push(`Result:\n${bounded(reply.content)}`);
  else if (request.state === 'failed' || request.state === 'cancelled') {
    lines.push(`Failure: ${request.error_code ?? request.state}${request.error_message ? ` - ${request.error_message}` : ''}`);
  } else if (request.terminal_at === null) lines.push('Result: not finished yet.');
  return lines.join('\n');
}

const NEXT_STEP = [
  'You coordinate this work. Decide the next step yourself: reply to the person, ask a question,',
  'or emit a botmancers-wake block (one per Agent). Reference earlier work with "contextWorkRequests";',
  'a revision names the implementation it resumes in "resumeWorkRequest". Never report a review that',
  'did not run.',
].join(' ');

function resultContinuationText(request: WorkRequest): string {
  return [
    `[Work Request result] ${agentName(request.target_agent_id)} finished the ${request.execution_kind} you requested.`,
    resultEvidence(request),
    NEXT_STEP,
  ].join('\n\n');
}

function wakeOutcomeText(unstarted: RoutedWake[]): string {
  const lines = unstarted.map(({ wake }) => {
    const target = wake.target_name_snapshot ?? wake.requested_target ?? 'an unnamed target';
    const kind = wake.execution_kind ?? 'unknown';
    const state = wake.status === 'blocked' ? 'is waiting (blocked)' : `was ${wake.status}`;
    return `- Wake ${wake.position + 1} (${kind}) to ${target} ${state}: ${wake.reason ?? wake.reason_code ?? 'no reason recorded'}`
      + (wake.work_request_id ? ` Work Request: ${wake.work_request_id}.` : ' No Work Request was created.');
  });
  return [
    `[Wake not started] ${unstarted.length === 1 ? 'One Wake' : `${unstarted.length} Wakes`} from your last message did not start any work:`,
    lines.join('\n'),
    NEXT_STEP,
  ].join('\n\n');
}

const getEngineRequestByKey = db.prepare(
  'SELECT * FROM work_requests WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?'
);

interface ContinuationSpec {
  key: string;
  coordinatorId: string;
  conversationId: string;
  sourceEventId: string;
  parent: WorkRequest;
  intent: string;
  continues: 'result' | 'wake_outcome';
  subjects: string[];
  now: number;
}

// Create-or-get one continuation turn. An existing one is returned as is
// (its context was frozen when it was created); a new one is subject to
// the per-lineage continuation budget.
function continuation(spec: ContinuationSpec): WorkRequest | null {
  const existing = getEngineRequestByKey.get(ENGINE_REQUESTER.kind, ENGINE_REQUESTER.id, spec.key) as WorkRequest | undefined;
  if (existing) return existing;
  if (!bots.getById(spec.coordinatorId)) return null;
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(spec.conversationId)) return null;
  const used = db.prepare(
    'SELECT COUNT(*) AS n FROM work_requests WHERE root_request_id = ? AND requester_kind = ? AND requester_id = ?'
  ).get(spec.parent.root_request_id, ENGINE_REQUESTER.kind, ENGINE_REQUESTER.id) as { n: number };
  if (used.n >= COORDINATOR_MAX_CONTINUATIONS) {
    const noted = db.prepare("SELECT 1 FROM engine_events WHERE request_id = ? AND type = 'continuation_limited'").get(spec.parent.id);
    if (!noted) {
      engine.appendEvent(spec.parent.id, {
        type: 'continuation_limited',
        data: { limit: COORDINATOR_MAX_CONTINUATIONS, continues: spec.continues },
        now: spec.now,
      });
    }
    return null;
  }
  const selection = selectExecutionPolicy({ entryPoint: 'continuation', executionKind: 'conversation' });
  if (!selection.ok) return null;
  return engine.createOrGetWorkRequest({
    sourceConversationId: spec.conversationId,
    sourceEventId: spec.sourceEventId,
    requester: ENGINE_REQUESTER,
    targetAgentId: spec.coordinatorId,
    intent: spec.intent,
    executionKind: selection.policy.execution_kind,
    toolProfile: selection.policy.tool_profile,
    idempotencyKey: spec.key,
    parentRequestId: spec.parent.id,
    policy: { source: 'coordinator_continuation', continues: spec.continues, work_requests: spec.subjects },
    executionPolicy: selection.policy,
    now: spec.now,
  }).request;
}

// Everything that follows one terminal request, in one transaction.
// Returns the queued requests to dispatch (new or not yet dispatched).
export function continueAfterTerminal(requestId: string, now: number = Date.now()): string[] {
  return engine.transaction((): string[] => {
    const request = engine.getWorkRequest(requestId);
    if (!request || request.terminal_at === null || request.legacy_agent_request_id !== null) return [];
    const dispatch: string[] = [];
    const queued = (next: WorkRequest | null | undefined) => {
      if (next && next.state === 'queued') dispatch.push(next.id);
    };

    const reply = replyOf(request);
    if (reply) {
      let routed: RoutedWake[] = [];
      try {
        routed = routeAgentWakes({ sourceEventId: reply.id, parentRequestId: request.id, now });
      } catch (error) {
        if (!(error instanceof WakeRouterError)) throw error;
        console.error(`Wakes of ${reply.id} could not be routed:`, error.message);
      }
      for (const entry of routed) queued(entry.request);
      const unstarted = routed.filter(entry => entry.wake.status !== 'accepted');
      if (unstarted.length > 0) {
        queued(continuation({
          key: `continuation:v1:wakes:${reply.id}`,
          coordinatorId: request.target_agent_id,
          conversationId: reply.conversation_id,
          sourceEventId: reply.id,
          parent: request,
          intent: wakeOutcomeText(unstarted),
          continues: 'wake_outcome',
          subjects: unstarted.flatMap(entry => entry.wake.work_request_id ? [entry.wake.work_request_id] : []),
          now,
        }));
      }
    }

    const back = returnTargetOf(request);
    if (back) {
      queued(continuation({
        key: `continuation:v1:result:${request.id}`,
        coordinatorId: back.agentId,
        conversationId: back.conversationId,
        sourceEventId: reply?.id ?? request.source_event_id,
        parent: request,
        intent: resultContinuationText(request),
        continues: 'result',
        subjects: [request.id],
        now,
      }));
    }
    return dispatch;
  });
}

// Restart recovery: replays every terminal canonical request (idempotent)
// and returns the queued Wake and continuation requests still to run.
export function pendingCoordinatorWork(now: number = Date.now()): string[] {
  const terminal = db.prepare(
    'SELECT id FROM work_requests WHERE terminal_at IS NOT NULL AND legacy_agent_request_id IS NULL ORDER BY created_at ASC, id ASC'
  ).all() as { id: string }[];
  const ids = new Set<string>();
  for (const row of terminal) for (const id of continueAfterTerminal(row.id, now)) ids.add(id);
  return [...ids];
}

// The turn-specific context appended after the conversation history: the
// continuation text for a continuation, the Wake objective plus the
// results it references for a Wake-created request.
export function turnContext(request: WorkRequest): DispatchHistoryEntry[] {
  if (isContinuation(request)) return [{ speakerLabel: ENGINE_SPEAKER, fromAgent: false, content: request.intent }];
  if (!request.wake_event_id) return [];
  const policy = storedPolicy(request);
  const refs = Array.isArray(policy.context_work_requests) ? policy.context_work_requests.filter((ref): ref is string => typeof ref === 'string') : [];
  const parts = [`[${request.execution_kind} Wake from ${agentName(request.requester_id)}] Work Request: ${request.id}`, `Objective:\n${request.intent}`];
  if (typeof policy.resume_work_request === 'string') {
    parts.push(`This revision continues your session from Work Request ${policy.resume_work_request}.`);
  }
  for (const ref of refs) {
    const context = engine.getWorkRequest(ref);
    if (context && context.root_request_id === request.root_request_id) parts.push(`Context:\n${resultEvidence(context)}`);
  }
  return [{ speakerLabel: ENGINE_SPEAKER, fromAgent: false, content: parts.join('\n\n') }];
}

export type ResumeResolution = { ok: true; binding: SessionBinding | null } | { ok: false; reason: string };

// A revision resumes the opaque Session Binding of the implementation it
// names: same root lineage, same target Agent, an edit-authorized
// implementation or revision, and an active binding for that request.
// Anything else fails closed; a revision never falls back to a fresh
// session.
export function resumeBindingFor(request: WorkRequest, adapter: string): ResumeResolution {
  if (request.execution_kind !== 'revision') return { ok: true, binding: null };
  const ref = storedPolicy(request).resume_work_request;
  const resumed = typeof ref === 'string' ? engine.getWorkRequest(ref) : undefined;
  if (!resumed || resumed.root_request_id !== request.root_request_id || resumed.target_agent_id !== request.target_agent_id
    || !['implementation', 'revision'].includes(resumed.execution_kind)) {
    return { ok: false, reason: 'The revision does not reference an implementation of this Agent in this lineage.' };
  }
  const binding = engine.getActiveSessionBinding({
    agentId: request.target_agent_id,
    adapter,
    conversationId: resumed.source_conversation_id,
    requestId: resumed.id,
  });
  if (!binding) return { ok: false, reason: 'The session of the referenced implementation is not available to resume.' };
  return { ok: true, binding };
}
