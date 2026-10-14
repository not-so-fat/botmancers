// NOT-466: the Wake router (docs/core-engine.md, Wake; docs/wake-contract-v1.md).
// Turns the Wakes in one Agent reply (a source conversation event) into
// durable engine objects:
//
//   parse structured blocks + legacy WAKE (lib/wake)
//     -> validate the envelope and its Work Request references
//     -> resolve the target name to exactly one Agent (never a Group)
//     -> check the target can launch
//     -> create one canonical Work Request (queued, or blocked with a reason)
//     -> record the Wake row with its outcome and durable lineage
//
// in one transaction. Every Wake is recorded: a missing target is
// `unavailable`, an unlaunchable one `blocked`, an invalid envelope
// `rejected`; none is dropped or reported as success. retryWake recovers
// unavailable and blocked Wakes from durable state.
//
// Identity and lineage come from durable rows only. The requester is the
// source message's sender; parent, root, depth, and root Wake come from
// the parent Work Request and its Wake. Nothing here reads the in-memory
// delegation chain in lib/agent.ts. Dispatching an Attempt is the
// dispatcher's job, not the router's.
//
// Idempotency: the key is source event + position + normalized payload
// (lib/wake wakeIdempotencyKey). Routing the same event again, in this
// process or after a restart, returns the stored Wakes and writes nothing.
//
// NOT-472: every Work Request a Wake creates records where its result
// returns (policy_snapshot.return_to: the requesting Agent and source
// conversation); lib/coordinator-loop continues that Agent when the
// request ends. Loop safety limits (depth, specialist budget, open
// requests) are checked per lineage before a request is created, and a
// review never targets the Agent whose implementation it reviews.
import { randomUUID } from 'crypto';
import db, { bots, engine, resolveWakeTarget, type Bot, type Message } from './db';
import { agentTransport, resolveAgent } from './bot-definition';
import { getAgentDeckServerUrl, isLocalAgentDeckUrl, remoteLaunchUnsupportedMessage } from './agent-deck-settings';
import { loadHermesConfig } from './hermes';
import type { WorkRequest } from './engine-store';
import { selectExecutionPolicy, type ExecutionPolicySnapshot } from './execution-policy';
import { parseWakes, wakeIdempotencyKey, wakePayload, type WakeCandidate, type WakeEnvelope, type WakeSyntax } from './wake';

export type WakeStatus = 'accepted' | 'blocked' | 'unavailable' | 'rejected';

export type WakeReasonCode =
  | 'invalid_envelope'
  | 'invalid_reference'
  | 'unsupported_policy'
  | 'target_is_group'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_unconfigured'
  | 'target_unavailable'
  | 'limit_exceeded'
  | 'reviewer_not_independent';

// NOT-472: coordinator loop safety limits, per root lineage. Values are
// placeholders until the owner confirms them; change one line here.
export const WAKE_MAX_DEPTH = 48;
export const WAKE_MAX_SPECIALIST_REQUESTS = 24;
export const WAKE_MAX_OPEN_REQUESTS = 16;

export interface Wake {
  id: string;
  idempotency_key: string;
  source_conversation_id: string;
  source_event_id: string;
  position: number;
  syntax: WakeSyntax;
  payload: string;
  requester_agent_id: string;
  requested_target: string | null;
  target_agent_id: string | null;
  target_name_snapshot: string | null;
  execution_kind: WakeEnvelope['executionKind'] | null;
  parent_request_id: string | null;
  root_request_id: string | null;
  root_wake_id: string;
  depth: number;
  status: WakeStatus;
  reason_code: WakeReasonCode | null;
  reason: string | null;
  work_request_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoutedWake {
  wake: Wake;
  request: WorkRequest | null;
  // False when the Wake was already recorded (a reprocessed event).
  created: boolean;
}

export type WakeRouterErrorCode = 'invalid_input' | 'source_not_found' | 'parent_mismatch' | 'idempotency_conflict' | 'not_found';

export class WakeRouterError extends Error {
  readonly code: WakeRouterErrorCode;
  constructor(code: WakeRouterErrorCode, message: string) {
    super(message);
    this.name = 'WakeRouterError';
    this.code = code;
  }
}

export type TargetAvailability = { available: true } | { available: false; reason: string };
export type AvailabilityProbe = (bot: Bot) => TargetAvailability;

// Whether a configured Agent's launch adapter can take work right now:
// Hermes needs the gateway configured; Agent Deck launches need a local
// Agent Deck server.
export function defaultAvailability(bot: Bot): TargetAvailability {
  if (agentTransport(resolveAgent(bot).agent) === 'hermes-gateway') {
    return loadHermesConfig()
      ? { available: true }
      : { available: false, reason: 'The Hermes gateway is not configured (HERMES_API_SERVER_KEY is unset).' };
  }
  const serverUrl = getAgentDeckServerUrl();
  return isLocalAgentDeckUrl(serverUrl)
    ? { available: true }
    : { available: false, reason: remoteLaunchUnsupportedMessage(serverUrl) };
}

let availabilityOverride: AvailabilityProbe | null = null;

// Test seam: replaces the launch-availability check. Pass null to restore.
export function setWakeAvailabilityProbe(next: AvailabilityProbe | null): void {
  availabilityOverride = next;
}

const getWakeRow = db.prepare('SELECT * FROM wakes WHERE id = ?');
const getWakeByKey = db.prepare('SELECT * FROM wakes WHERE idempotency_key = ?');
const getWakeByPosition = db.prepare('SELECT * FROM wakes WHERE source_event_id = ? AND position = ?');

export function getWake(id: string): Wake | undefined {
  return getWakeRow.get(id) as Wake | undefined;
}

export function listWakesForEvent(sourceEventId: string): Wake[] {
  return db.prepare('SELECT * FROM wakes WHERE source_event_id = ? ORDER BY position ASC').all(sourceEventId) as Wake[];
}

function routed(wake: Wake, created: boolean): RoutedWake {
  return { wake, request: wake.work_request_id ? engine.getWorkRequest(wake.work_request_id) ?? null : null, created };
}

type Unrouted = { status: 'rejected' | 'unavailable'; code: WakeReasonCode; reason: string; target?: { id: string; name: string } };
type Routable = { status: 'accepted' | 'blocked'; code: WakeReasonCode | null; reason: string | null; target: { id: string; name: string }; policy: ExecutionPolicySnapshot };
type Outcome = Unrouted | Routable;

function routable(outcome: Outcome): outcome is Routable {
  return outcome.status === 'accepted' || outcome.status === 'blocked';
}

function groupNamed(name: string): boolean {
  return !!db.prepare('SELECT 1 FROM groups WHERE lower(trim(name)) = lower(trim(?))').get(name);
}

// References must exist in the same lineage: the parent's root when the
// Wake has a parent, else the source conversation.
function referenceProblem(envelope: WakeEnvelope, conversationId: string, parent: WorkRequest | null): string | null {
  const refs = [...(envelope.contextWorkRequests ?? []), ...(envelope.resumeWorkRequest ? [envelope.resumeWorkRequest] : [])];
  for (const ref of refs) {
    const found = engine.getWorkRequest(ref);
    const inLineage = !!found && (parent
      ? found.root_request_id === parent.root_request_id
      : found.source_conversation_id === conversationId);
    if (!inLineage) return `Work Request ${ref} is not in this conversation lineage.`;
  }
  return null;
}

// Depth, budget, and concurrency of the lineage this Wake would extend.
// Counts include requests created earlier in the same reply.
function limitProblem(parent: WorkRequest | null): string | null {
  if (!parent) return null;
  if (parent.depth + 1 > WAKE_MAX_DEPTH) return `This work is already ${parent.depth} Wakes deep (limit ${WAKE_MAX_DEPTH}).`;
  const counts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN terminal_at IS NULL THEN 1 ELSE 0 END) AS open
    FROM work_requests WHERE root_request_id = ? AND wake_event_id IS NOT NULL
  `).get(parent.root_request_id) as { total: number; open: number | null };
  if (counts.total >= WAKE_MAX_SPECIALIST_REQUESTS) {
    return `This work already woke ${counts.total} specialists (limit ${WAKE_MAX_SPECIALIST_REQUESTS}).`;
  }
  if ((counts.open ?? 0) >= WAKE_MAX_OPEN_REQUESTS) {
    return `This work already has ${counts.open} specialist requests open (limit ${WAKE_MAX_OPEN_REQUESTS}).`;
  }
  return null;
}

// Target resolution by name, then the launch checks. Used by first routing
// and by retrying an unavailable Wake (which has no target yet).
function resolveOutcome(envelope: WakeEnvelope, syntax: WakeSyntax): Outcome {
  const resolved = resolveWakeTarget(envelope.target);
  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous') {
      return { status: 'unavailable', code: 'target_ambiguous', reason: `More than one Agent is named ${envelope.target}; rename one to restore routing.` };
    }
    if (groupNamed(envelope.target)) {
      return { status: 'rejected', code: 'target_is_group', reason: `${envelope.target} is a Group; wake one Agent by name.` };
    }
    return { status: 'unavailable', code: 'target_not_found', reason: `No Agent is named ${envelope.target}.` };
  }
  return checkTarget(envelope, syntax, { id: resolved.agentId, name: resolved.displayName });
}

// Resume constraint, configuration, and availability of one resolved
// Agent. A blocked Wake's retry calls this on its stored target, never on
// whichever Agent now holds the requested name.
function checkTarget(envelope: WakeEnvelope, syntax: WakeSyntax, target: { id: string; name: string }): Outcome {
  // NOT-471: authority comes from the envelope's explicit kind under the
  // central rules (structured: any kind, revision resumes; legacy:
  // conversation only), never from the target's Agent type.
  const selection = selectExecutionPolicy({
    entryPoint: 'wake',
    executionKind: envelope.executionKind,
    wakeSyntax: syntax,
    resumesWorkRequest: !!envelope.resumeWorkRequest,
  });
  if (!selection.ok) return { status: 'rejected', code: 'unsupported_policy', reason: selection.reason, target };
  const policy = selection.policy;
  if (envelope.resumeWorkRequest) {
    const resume = engine.getWorkRequest(envelope.resumeWorkRequest);
    if (!resume || resume.target_agent_id !== target.id || !['implementation', 'revision'].includes(resume.execution_kind)) {
      return { status: 'rejected', code: 'invalid_reference', reason: 'A revision resumes an implementation Work Request of the same Agent.', target };
    }
  }
  // An independent review: the reviewer did not do the work it reviews.
  if (envelope.executionKind === 'review') {
    for (const ref of envelope.contextWorkRequests ?? []) {
      const reviewed = engine.getWorkRequest(ref);
      if (reviewed && ['implementation', 'revision'].includes(reviewed.execution_kind) && reviewed.target_agent_id === target.id) {
        return { status: 'rejected', code: 'reviewer_not_independent', reason: `${target.name} did the work under review; wake a different reviewer or ask the person.`, target };
      }
    }
  }
  const bot = bots.getById(target.id) as Bot;
  const agent = resolveAgent(bot);
  if (!agent.launchable) {
    const reason = agent.needs_deck_selection
      ? `${target.name} has no Agent Deck selected.`
      : `${target.name} has an unsupported Agent type.`;
    return { status: 'blocked', code: 'target_unconfigured', reason, target, policy };
  }
  const availability = (availabilityOverride ?? defaultAvailability)(bot);
  if (!availability.available) return { status: 'blocked', code: 'target_unavailable', reason: availability.reason, target, policy };
  return { status: 'accepted', code: null, reason: null, target, policy };
}

function createRequest(wake: Pick<Wake, 'id' | 'idempotency_key' | 'source_conversation_id' | 'source_event_id' | 'requester_agent_id' | 'parent_request_id' | 'root_wake_id' | 'syntax'>,
  envelope: WakeEnvelope, outcome: Routable, now: number): WorkRequest {
  const { request } = engine.createOrGetWorkRequest({
    sourceConversationId: wake.source_conversation_id,
    sourceEventId: wake.source_event_id,
    requester: { kind: 'bot', id: wake.requester_agent_id },
    targetAgentId: outcome.target.id,
    intent: envelope.objective,
    executionKind: outcome.policy.execution_kind,
    toolProfile: outcome.policy.tool_profile,
    idempotencyKey: wake.idempotency_key,
    parentRequestId: wake.parent_request_id,
    wakeEventId: wake.id,
    policy: {
      source: 'wake',
      wake_version: 1,
      wake_syntax: wake.syntax,
      root_wake_id: wake.root_wake_id,
      requested_target: envelope.target,
      target_name_snapshot: outcome.target.name,
      context_work_requests: envelope.contextWorkRequests ?? [],
      resume_work_request: envelope.resumeWorkRequest ?? null,
      limits: envelope.limits ?? {},
      // NOT-472: the result returns to the requesting Agent in the
      // source conversation.
      return_to: { agent_id: wake.requester_agent_id, conversation_id: wake.source_conversation_id },
    },
    executionPolicy: outcome.policy,
    initialState: outcome.status === 'blocked' ? 'blocked' : 'queued',
    stateReason: outcome.status === 'blocked' ? `${outcome.code}: ${outcome.reason}` : null,
    now,
  });
  return request;
}

function routeCandidate(candidate: WakeCandidate, source: Message, requesterId: string, parent: WorkRequest | null, now: number): RoutedWake {
  const key = wakeIdempotencyKey(source.id, candidate);
  const existing = getWakeByKey.get(key) as Wake | undefined;
  if (existing) return routed(existing, false);
  if (getWakeByPosition.get(source.id, candidate.position)) {
    throw new WakeRouterError('idempotency_conflict', `Wake ${candidate.position} of event ${source.id} was already recorded with a different payload.`);
  }

  const id = randomUUID();
  const parentWake = parent?.wake_event_id ? getWake(parent.wake_event_id) : undefined;
  const base = {
    id,
    idempotency_key: key,
    source_conversation_id: source.conversation_id,
    source_event_id: source.id,
    requester_agent_id: requesterId,
    parent_request_id: parent?.id ?? null,
    root_wake_id: parentWake?.root_wake_id ?? id,
    syntax: candidate.syntax,
  };

  let envelope: WakeEnvelope | null = null;
  let outcome: Outcome;
  if (!candidate.validation.ok) {
    outcome = { status: 'rejected', code: 'invalid_envelope', reason: candidate.validation.reason };
  } else {
    envelope = candidate.validation.envelope;
    const problem = referenceProblem(envelope, source.conversation_id, parent);
    const limit = problem ? null : limitProblem(parent);
    outcome = problem ? { status: 'rejected', code: 'invalid_reference', reason: problem }
      : limit ? { status: 'rejected', code: 'limit_exceeded', reason: limit }
        : resolveOutcome(envelope, candidate.syntax);
  }

  const request = envelope && routable(outcome)
    ? createRequest(base, envelope, outcome, now)
    : null;
  db.prepare(`
    INSERT INTO wakes (
      id, idempotency_key, source_conversation_id, source_event_id, position, syntax, payload,
      requester_agent_id, requested_target, target_agent_id, target_name_snapshot, execution_kind,
      parent_request_id, root_request_id, root_wake_id, depth, status, reason_code, reason,
      work_request_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, key, source.conversation_id, source.id, candidate.position, candidate.syntax, wakePayload(candidate),
    requesterId, envelope?.target ?? null, outcome.target?.id ?? null, outcome.target?.name ?? null, envelope?.executionKind ?? null,
    parent?.id ?? null, request?.root_request_id ?? parent?.root_request_id ?? null, base.root_wake_id,
    request?.depth ?? (parent ? parent.depth + 1 : 0), outcome.status, outcome.code, outcome.reason,
    request?.id ?? null, now, now
  );
  return routed(getWake(id) as Wake, true);
}

export interface RouteWakesInput {
  // The Agent reply message that carries the Wakes.
  sourceEventId: string;
  // The Work Request whose turn produced that reply, when there is one.
  // Without it the Wakes start a new lineage (depth 0).
  parentRequestId?: string | null;
  now?: number;
}

// Records every Wake in one Agent reply. Safe to call any number of times
// for the same event: already-recorded Wakes are returned unchanged.
export function routeAgentWakes(input: RouteWakesInput): RoutedWake[] {
  if (typeof input.sourceEventId !== 'string' || !input.sourceEventId.trim()) {
    throw new WakeRouterError('invalid_input', 'sourceEventId is required.');
  }
  return db.transaction((): RoutedWake[] => {
    const source = db.prepare('SELECT * FROM messages WHERE id = ?').get(input.sourceEventId) as Message | undefined;
    if (!source) throw new WakeRouterError('source_not_found', `No conversation event ${input.sourceEventId}.`);
    // Caller identity is derived, never supplied: the Agent that sent it.
    if (source.sender_type !== 'bot' || !source.sender_id || !bots.getById(source.sender_id)) {
      throw new WakeRouterError('invalid_input', 'Wakes are routed only from an Agent message.');
    }
    let parent: WorkRequest | null = null;
    if (input.parentRequestId) {
      parent = engine.getWorkRequest(input.parentRequestId) ?? null;
      if (!parent) throw new WakeRouterError('not_found', `No parent Work Request ${input.parentRequestId}.`);
      if (parent.target_agent_id !== source.sender_id || parent.source_conversation_id !== source.conversation_id) {
        throw new WakeRouterError('parent_mismatch', 'The parent Work Request was not run by this Agent in this conversation.');
      }
    }
    const now = input.now ?? Date.now();
    return parseWakes(source.content).map(candidate => routeCandidate(candidate, source, source.sender_id as string, parent, now));
  }).immediate();
}

// Recovery from durable state. An unavailable Wake re-resolves its
// target and, once found, creates its Work Request; if the name now
// resolves to something no Wake may target, it becomes rejected. A
// blocked Wake whose target can now launch moves its request from blocked
// to queued; one that stays blocked records the current reason.
// Accepted and rejected Wakes are returned unchanged.
export function retryWake(wakeId: string, now: number = Date.now()): RoutedWake {
  return db.transaction((): RoutedWake => {
    const wake = getWake(wakeId);
    if (!wake) throw new WakeRouterError('not_found', `No Wake ${wakeId}.`);
    if (wake.status !== 'unavailable' && wake.status !== 'blocked') return routed(wake, false);
    const envelope = (JSON.parse(wake.payload) as { envelope: WakeEnvelope }).envelope;
    const update = db.prepare(`
      UPDATE wakes SET status = ?, reason_code = ?, reason = ?, target_agent_id = ?, target_name_snapshot = ?,
        work_request_id = ?, root_request_id = ?, updated_at = ?
      WHERE id = ?
    `);

    if (wake.status === 'unavailable') {
      const outcome = resolveOutcome(envelope, wake.syntax);
      if (!routable(outcome)) {
        // Still unresolved: keep it visible with the current reason. A
        // rejection is terminal, so status and reason never disagree.
        if (outcome.status !== wake.status || outcome.code !== wake.reason_code || outcome.reason !== wake.reason) {
          update.run(outcome.status, outcome.code, outcome.reason, null, null, null, wake.root_request_id, now, wake.id);
        }
        return routed(getWake(wake.id) as Wake, false);
      }
      const request = createRequest(wake, envelope, outcome, now);
      update.run(outcome.status, outcome.code, outcome.reason, outcome.target.id, outcome.target.name, request.id, request.root_request_id, now, wake.id);
      return routed(getWake(wake.id) as Wake, true);
    }

    // Blocked: the request already names its target. Re-check that Agent,
    // even if it was renamed and another Agent now holds the name.
    const request = engine.getWorkRequest(wake.work_request_id as string) as WorkRequest;
    const stored = bots.getById(request.target_agent_id) as Bot | undefined;
    if (!stored || request.state !== 'blocked') return routed(wake, false);
    const outcome = checkTarget(envelope, wake.syntax, { id: stored.id, name: stored.name });
    if (outcome.status === 'blocked' && (outcome.code !== wake.reason_code || outcome.reason !== wake.reason)) {
      update.run('blocked', outcome.code, outcome.reason, wake.target_agent_id, wake.target_name_snapshot, wake.work_request_id, wake.root_request_id, now, wake.id);
      return routed(getWake(wake.id) as Wake, false);
    }
    if (outcome.status !== 'accepted') return routed(wake, false);
    engine.transitionWorkRequest(request.id, { from: 'blocked', to: 'queued', reason: 'target_available', now });
    update.run('accepted', null, null, wake.target_agent_id, wake.target_name_snapshot, wake.work_request_id, wake.root_request_id, now, wake.id);
    return routed(getWake(wake.id) as Wake, true);
  }).immediate();
}

// Durable lineage of a Work Request: itself, then each parent up to the
// root, read only from work_requests.
export function walkLineage(requestId: string): WorkRequest[] {
  const chain: WorkRequest[] = [];
  let current = engine.getWorkRequest(requestId);
  while (current) {
    chain.push(current);
    if (!current.parent_request_id) break;
    current = engine.getWorkRequest(current.parent_request_id);
  }
  return chain;
}
