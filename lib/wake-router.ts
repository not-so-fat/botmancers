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
// request ends. A review never targets the Agent whose implementation it
// reviews.
//
// NOT-475: Wake safety (lib/wake-safety; contract Check order and
// composition). One fixed order, stopping at the first unmet check:
//   1. envelope, tracked lineage, references, depth, root budget -> rejected
//   2. target name resolution                                      -> unavailable
//   3. policy checks on the resolved Agent                         -> rejected
//   4. edit grant (implementation/revision)                        -> blocked, grant_required
//   5. launchability and availability                              -> blocked, target_*
//   6. accepted: the request is queued and waits for capacity
// Depth and root budget are counted inside the routing IMMEDIATE
// transaction, so concurrent replies in one lineage cannot overshoot, and
// a replayed event returns its stored Wakes without counting again. Every
// Work Request a Wake creates records the caller principal, target, grant
// rule and grant, and the policy snapshot used (wake_safety_decisions);
// decideWakeGrant is the owner's Allow / Deny.
import { randomUUID } from 'crypto';
import db, { bots, engine, resolveWakeTarget, type Bot, type Message, type Principal } from './db';
import { agentTransport, resolveAgent } from './bot-definition';
import { loadHermesConfig } from './hermes';
import type { SafetyDecisionInput, WorkRequest } from './engine-store';
import { selectExecutionPolicy, type ExecutionPolicySnapshot } from './execution-policy';
import { parseWakes, wakeIdempotencyKey, wakePayload, type WakeCandidate, type WakeEnvelope, type WakeSyntax } from './wake';
import {
  WAKE_SAFETY_VERSION,
  activeEditGrant,
  assertOwner,
  ensureEditGrant,
  isOwnerPrincipal,
  needsEditGrant,
  wakeSafetyLimits,
  WakeSafetyError,
  type CallerCategory,
  type GrantRule,
  type WakeGrant,
} from './wake-safety';

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
  // Recorded before NOT-475; projects as wake_rejected.
  | 'limit_exceeded'
  | 'reviewer_not_independent'
  | 'depth_exceeded'
  | 'root_budget_exhausted'
  | 'untracked_lineage'
  | 'grant_required'
  | 'grant_denied';

// NOT-475: approved limits per root lineage (lib/wake-safety). Depth counts
// Agent-to-Agent hops (work_requests.wake_depth); the root budget counts
// Wake-created Work Requests in any state.
export const WAKE_MAX_DEPTH = wakeSafetyLimits().maxWakeDepth;
export const WAKE_ROOT_BUDGET = wakeSafetyLimits().rootBudget;
export const WAKE_MAX_SPECIALIST_REQUESTS = WAKE_ROOT_BUDGET;

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
  limit_value: number | null;
  observed_value: number | null;
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

// Whether a configured Agent's launch adapter can take work right now.
// Agent Deck HTTP attempts perform their authenticated availability check
// at launch; unlike the retired CLI path, a non-loopback workspace server
// is a supported transport and must not be rejected here.
export function defaultAvailability(bot: Bot): TargetAvailability {
  if (agentTransport(resolveAgent(bot).agent) === 'hermes-gateway') {
    return loadHermesConfig()
      ? { available: true }
      : { available: false, reason: 'The Hermes gateway is not configured (HERMES_API_SERVER_KEY is unset).' };
  }
  return { available: true };
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

type Unrouted = {
  status: 'rejected' | 'unavailable'; code: WakeReasonCode; reason: string; target?: { id: string; name: string };
  limit?: number; observed?: number;
};
// grant: the rule that admitted the Wake (null while grant_required).
type Routable = {
  status: 'accepted' | 'blocked'; code: WakeReasonCode | null; reason: string | null; target: { id: string; name: string };
  policy: ExecutionPolicySnapshot; grant: { rule: GrantRule; id: string | null } | null;
};
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

// Wake-created Work Requests in one root lineage, in any state (blocked
// and cancelled included). Read inside the routing transaction, so it
// includes requests created earlier in the same reply.
function rootBudgetUsed(rootRequestId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM work_requests WHERE root_request_id = ? AND wake_event_id IS NOT NULL')
    .get(rootRequestId) as { n: number }).n;
}

function budgetProblem(rootRequestId: string): Unrouted | null {
  const { rootBudget } = wakeSafetyLimits();
  const used = rootBudgetUsed(rootRequestId);
  if (used < rootBudget) return null;
  return {
    status: 'rejected', code: 'root_budget_exhausted', limit: rootBudget, observed: used,
    reason: `This work already used ${used} Wakes (limit ${rootBudget}).`,
  };
}

// Step 1 limits of the lineage this Wake would extend.
function limitProblem(parent: WorkRequest): Unrouted | null {
  const { maxWakeDepth } = wakeSafetyLimits();
  const depth = parent.wake_depth + 1;
  if (depth > maxWakeDepth) {
    return {
      status: 'rejected', code: 'depth_exceeded', limit: maxWakeDepth, observed: depth,
      reason: `This work is already ${parent.wake_depth} Wakes deep (limit ${maxWakeDepth}).`,
    };
  }
  return budgetProblem(parent.root_request_id);
}

// The caller, and the parent turn its Wake extends, for steps 3-6.
interface WakeCaller {
  agentId: string;
  parent: WorkRequest | null;
}

// Self-wake exemption: an implementation Wake to the caller itself, from a
// turn that is a direct message by the human owner (root principal
// person:local-owner, categorized human_owner at intake, depth 0, not a
// Wake or continuation turn).
function ownerDirectSelfWake(envelope: WakeEnvelope, target: { id: string }, caller: WakeCaller): boolean {
  const parent = caller.parent;
  if (envelope.executionKind !== 'implementation' || target.id !== caller.agentId || !parent) return false;
  if (parent.wake_event_id !== null || parent.wake_depth !== 0 || parent.parent_request_id !== null || parent.target_agent_id !== caller.agentId) return false;
  if (!isOwnerPrincipal({ kind: parent.root_principal_kind ?? '', id: parent.root_principal_id ?? '' })) return false;
  const first = engine.listSafetyDecisions(parent.id)[0];
  return first?.principal_type === 'human_owner';
}

// Step 4: the grant rule that admits this Wake, or null when the owner
// must approve one first.
function grantFor(envelope: WakeEnvelope, target: { id: string }, caller: WakeCaller): { rule: GrantRule; id: string | null } | null {
  if (!needsEditGrant(envelope.executionKind)) return { rule: 'readonly_default', id: null };
  if (ownerDirectSelfWake(envelope, target, caller)) return { rule: 'owner_direct_self_wake', id: null };
  const grant = activeEditGrant(caller.agentId, target.id);
  return grant ? { rule: 'edit_grant', id: grant.id } : null;
}

// Target resolution by name, then the launch checks. Used by first routing
// and by retrying an unavailable Wake (which has no target yet).
function resolveOutcome(envelope: WakeEnvelope, syntax: WakeSyntax, caller: WakeCaller): Outcome {
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
  return checkTarget(envelope, syntax, { id: resolved.agentId, name: resolved.displayName }, caller);
}

// Resume constraint, configuration, and availability of one resolved
// Agent. A blocked Wake's retry calls this on its stored target, never on
// whichever Agent now holds the requested name.
function checkTarget(envelope: WakeEnvelope, syntax: WakeSyntax, target: { id: string; name: string }, caller: WakeCaller): Outcome {
  const rootRequestId = caller.parent?.root_request_id ?? null;
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
  // An independent review: the reviewer did not do the work it reviews,
  // whether or not the Wake references that work.
  if (envelope.executionKind === 'review') {
    const reviewsOwnWork = (envelope.contextWorkRequests ?? []).some(ref => {
      const reviewed = engine.getWorkRequest(ref);
      return reviewed && ['implementation', 'revision'].includes(reviewed.execution_kind) && reviewed.target_agent_id === target.id;
    }) || (rootRequestId !== null && !!db.prepare(
      "SELECT 1 FROM work_requests WHERE root_request_id = ? AND target_agent_id = ? AND execution_kind IN ('implementation', 'revision') LIMIT 1"
    ).get(rootRequestId, target.id));
    if (reviewsOwnWork) {
      return { status: 'rejected', code: 'reviewer_not_independent', reason: `${target.name} did the work under review; wake a different reviewer or ask the person.`, target };
    }
  }
  // The grant is asked before availability: only the owner can satisfy
  // it, and an unlaunchable target never hides a pending approval.
  const grant = grantFor(envelope, target, caller);
  if (!grant) {
    return { status: 'blocked', code: 'grant_required', reason: `${target.name} needs your approval for edit work.`, target, policy, grant: null };
  }
  return availabilityOutcome(target, policy, grant);
}

// Step 5-6 for a resolved, granted target.
function availabilityOutcome(target: { id: string; name: string }, policy: ExecutionPolicySnapshot, grant: { rule: GrantRule; id: string | null }): Routable {
  const bot = bots.getById(target.id) as Bot;
  const agent = resolveAgent(bot);
  if (!agent.launchable) {
    // NOT-502: one reason per launch blocker; a direct profile never
    // reports a missing deck.
    const reason = agent.launch_blocker === 'launch_profile'
      ? `${target.name} has no Agent Deck selected and no launch profile chosen.`
      : agent.launch_blocker === 'session_scope'
        ? `${target.name} has no session scope.`
        : agent.launch_blocker === 'direct_runtime'
          ? `${target.name} launches directly; direct ${agent.agent} sessions are not available yet.`
          : agent.needs_deck_selection
            ? `${target.name} has no Agent Deck selected.`
            : `${target.name} has an unsupported Agent type.`;
    return { status: 'blocked', code: 'target_unconfigured', reason, target, policy, grant };
  }
  const availability = (availabilityOverride ?? defaultAvailability)(bot);
  if (!availability.available) return { status: 'blocked', code: 'target_unavailable', reason: availability.reason, target, policy, grant };
  return { status: 'accepted', code: null, reason: null, target, policy, grant };
}

// The policy snapshot one evaluation used: version, root principal, depth,
// grant, and the root budget after this request.
function safetySnapshot(input: { rootPrincipal: { kind: string; id: string }; wakeDepth: number; grant: Routable['grant']; rootRequestId: string | null; counting: boolean }): Record<string, unknown> {
  const limits = wakeSafetyLimits();
  const used = input.rootRequestId ? rootBudgetUsed(input.rootRequestId) : 0;
  return {
    safety_version: WAKE_SAFETY_VERSION,
    root_principal: input.rootPrincipal,
    wake_depth: input.wakeDepth,
    grant_rule: input.grant?.rule ?? null,
    grant_id: input.grant?.id ?? null,
    root_budget: { used: used + (input.counting ? 1 : 0), limit: limits.rootBudget },
    safety_limits: { max_wake_depth: limits.maxWakeDepth, root_budget: limits.rootBudget },
  };
}

function decisionFor(outcome: Routable, wakeId: string, requesterId: string, snapshot: Record<string, unknown>, now: number): SafetyDecisionInput {
  return {
    principalType: 'agent_principal',
    principal: { kind: 'bot', id: requesterId },
    decision: outcome.status === 'accepted' ? 'allowed' : 'blocked',
    reasonCode: outcome.code,
    grantRule: outcome.grant?.rule ?? null,
    grantId: outcome.grant?.id ?? null,
    wakeId,
    snapshot,
    now,
  };
}

function createRequest(wake: Pick<Wake, 'id' | 'idempotency_key' | 'source_conversation_id' | 'source_event_id' | 'requester_agent_id' | 'parent_request_id' | 'root_wake_id' | 'syntax'>,
  envelope: WakeEnvelope, outcome: Routable, now: number): WorkRequest {
  const parent = wake.parent_request_id ? engine.getWorkRequest(wake.parent_request_id) ?? null : null;
  if (!parent) throw new WakeRouterError('invalid_input', 'A Wake creates work only in a tracked lineage.');
  const snapshot = safetySnapshot({
    rootPrincipal: { kind: parent.root_principal_kind ?? 'unknown', id: parent.root_principal_id ?? 'unknown' },
    wakeDepth: parent.wake_depth + 1,
    grant: outcome.grant,
    rootRequestId: parent.root_request_id,
    counting: true,
  });
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
    safetySnapshot: snapshot,
    safety: decisionFor(outcome, wake.id, wake.requester_agent_id, snapshot, now),
    now,
  });
  if (outcome.code === 'grant_required') grantRequested(request, wake.id, now);
  return request;
}

function grantRequested(request: WorkRequest, wakeId: string, now: number): void {
  engine.appendEvent(request.id, {
    type: 'grant_requested',
    data: { wake_id: wakeId, caller_agent_id: request.requester_id, target_agent_id: request.target_agent_id, authority: 'edit', execution_kind: request.execution_kind },
    now,
  });
}

// A blocked request whose Wake reason changed without a state change (the
// owner allowed but the target cannot launch, or a retry found the grant
// revoked): the conversation shows the current reason.
function reblocked(request: WorkRequest, code: WakeReasonCode, reason: string, now: number): void {
  engine.reblockWorkRequest(request.id, { reason: `${code}: ${reason}`, type: 'wake_reblocked', data: { reason_code: code, reason }, now });
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
  } else if (!parent) {
    // An Agent principal whose turn the engine did not dispatch: identity
    // is known, lineage is not, and a fresh root would reset depth and
    // budget. Recorded, never routed.
    envelope = candidate.validation.envelope;
    outcome = { status: 'rejected', code: 'untracked_lineage', reason: 'Its source turn is not tracked work, so the Wake cannot start a lineage.' };
  } else {
    envelope = candidate.validation.envelope;
    const problem = referenceProblem(envelope, source.conversation_id, parent);
    outcome = problem ? { status: 'rejected', code: 'invalid_reference', reason: problem }
      : limitProblem(parent) ?? resolveOutcome(envelope, candidate.syntax, { agentId: requesterId, parent });
  }

  const request = envelope && routable(outcome)
    ? createRequest(base, envelope, outcome, now)
    : null;
  db.prepare(`
    INSERT INTO wakes (
      id, idempotency_key, source_conversation_id, source_event_id, position, syntax, payload,
      requester_agent_id, requested_target, target_agent_id, target_name_snapshot, execution_kind,
      parent_request_id, root_request_id, root_wake_id, depth, status, reason_code, reason,
      work_request_id, limit_value, observed_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, key, source.conversation_id, source.id, candidate.position, candidate.syntax, wakePayload(candidate),
    requesterId, envelope?.target ?? null, outcome.target?.id ?? null, outcome.target?.name ?? null, envelope?.executionKind ?? null,
    parent?.id ?? null, request?.root_request_id ?? parent?.root_request_id ?? null, base.root_wake_id,
    request?.wake_depth ?? (parent ? parent.wake_depth + 1 : 0), outcome.status, outcome.code, outcome.reason,
    request?.id ?? null, routable(outcome) ? null : outcome.limit ?? null, routable(outcome) ? null : outcome.observed ?? null, now, now
  );
  return routed(getWake(id) as Wake, true);
}

export interface RouteWakesInput {
  // The Agent reply message that carries the Wakes.
  sourceEventId: string;
  // The Work Request whose turn produced that reply, when there is one.
  // Without it the reply has untracked lineage: its Wakes are recorded
  // rejected (untracked_lineage) and create no work.
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

// Recovery from durable state. An unavailable Wake re-checks the root
// budget (its request was never counted), re-resolves its target and, once
// found, creates its Work Request through steps 3-6; if the name now
// resolves to something no Wake may target, it becomes rejected. A blocked
// Wake re-runs steps 3-6 against its stored target Agent: a grant revoked
// since asks again (grant_required), a launchable granted target moves its
// request from blocked to queued, and one that stays blocked records the
// current reason. Accepted, rejected, and owner-denied Wakes are returned
// unchanged.
export function retryWake(wakeId: string, now: number = Date.now()): RoutedWake {
  return db.transaction((): RoutedWake => {
    const wake = getWake(wakeId);
    if (!wake) throw new WakeRouterError('not_found', `No Wake ${wakeId}.`);
    if (wake.status !== 'unavailable' && wake.status !== 'blocked') return routed(wake, false);
    if (wake.reason_code === 'grant_denied') return routed(wake, false);
    const envelope = (JSON.parse(wake.payload) as { envelope: WakeEnvelope }).envelope;
    const update = db.prepare(`
      UPDATE wakes SET status = ?, reason_code = ?, reason = ?, target_agent_id = ?, target_name_snapshot = ?,
        work_request_id = ?, root_request_id = ?, limit_value = ?, observed_value = ?, updated_at = ?
      WHERE id = ?
    `);
    const parent = wake.parent_request_id ? engine.getWorkRequest(wake.parent_request_id) ?? null : null;
    const caller: WakeCaller = { agentId: wake.requester_agent_id, parent };

    if (wake.status === 'unavailable') {
      const outcome: Outcome = !parent
        ? { status: 'rejected', code: 'untracked_lineage', reason: 'Its source turn is not tracked work, so the Wake cannot start a lineage.' }
        : budgetProblem(parent.root_request_id) ?? resolveOutcome(envelope, wake.syntax, caller);
      if (!routable(outcome)) {
        // Still unresolved: keep it visible with the current reason. A
        // rejection is terminal, so status and reason never disagree.
        if (outcome.status !== wake.status || outcome.code !== wake.reason_code || outcome.reason !== wake.reason) {
          update.run(outcome.status, outcome.code, outcome.reason, null, null, null, wake.root_request_id,
            outcome.limit ?? null, outcome.observed ?? null, now, wake.id);
        }
        return routed(getWake(wake.id) as Wake, false);
      }
      const request = createRequest(wake, envelope, outcome, now);
      update.run(outcome.status, outcome.code, outcome.reason, outcome.target.id, outcome.target.name, request.id, request.root_request_id, null, null, now, wake.id);
      return routed(getWake(wake.id) as Wake, true);
    }

    // Blocked: the request already names its target. Re-check that Agent,
    // even if it was renamed and another Agent now holds the name.
    const request = engine.getWorkRequest(wake.work_request_id as string) as WorkRequest;
    const stored = bots.getById(request.target_agent_id) as Bot | undefined;
    if (!stored || request.state !== 'blocked') return routed(wake, false);
    const outcome = checkTarget(envelope, wake.syntax, { id: stored.id, name: stored.name }, caller);
    return settleBlocked(wake, request, outcome, 'target_available', now);
  }).immediate();
}

// Applies a re-evaluated outcome to a blocked Wake and its blocked request.
function settleBlocked(wake: Wake, request: WorkRequest, outcome: Outcome, queuedReason: 'target_available' | 'grant_approved', now: number): RoutedWake {
  const update = db.prepare('UPDATE wakes SET status = ?, reason_code = ?, reason = ?, updated_at = ? WHERE id = ?');
  if (outcome.status === 'blocked') {
    if (outcome.code === wake.reason_code && outcome.reason === wake.reason) return routed(wake, false);
    update.run('blocked', outcome.code, outcome.reason, now, wake.id);
    const snapshot = safetySnapshot({
      rootPrincipal: { kind: request.root_principal_kind ?? 'unknown', id: request.root_principal_id ?? 'unknown' },
      wakeDepth: request.wake_depth, grant: outcome.grant, rootRequestId: null, counting: false,
    });
    engine.recordSafetyDecision(request.id, decisionFor(outcome, wake.id, wake.requester_agent_id, snapshot, now));
    if (outcome.code === 'grant_required') grantRequested(request, wake.id, now);
    reblocked(request, outcome.code as WakeReasonCode, outcome.reason as string, now);
    return routed(getWake(wake.id) as Wake, false);
  }
  if (outcome.status !== 'accepted') return routed(wake, false);
  // The decision that makes the request runnable commits with its
  // blocked -> queued transition.
  const snapshot = safetySnapshot({
    rootPrincipal: { kind: request.root_principal_kind ?? 'unknown', id: request.root_principal_id ?? 'unknown' },
    wakeDepth: request.wake_depth, grant: outcome.grant, rootRequestId: null, counting: false,
  });
  engine.recordSafetyDecision(request.id, decisionFor(outcome, wake.id, wake.requester_agent_id, snapshot, now));
  engine.transitionWorkRequest(request.id, { from: 'blocked', to: 'queued', reason: queuedReason, data: { grant_rule: outcome.grant?.rule ?? null, grant_id: outcome.grant?.id ?? null }, now });
  update.run('accepted', null, null, now, wake.id);
  return routed(getWake(wake.id) as Wake, true);
}

export interface GrantDecisionResult extends RoutedWake {
  decision: 'allow' | 'deny';
  grant: WakeGrant | null;
  // The request is now queued and may be dispatched.
  runnable: boolean;
  // The request ended (Deny); its result continuation follows from
  // lib/coordinator-loop continueAfterTerminal.
  ended: boolean;
}

// The owner's Allow / Deny of a blocked edit Wake (contract, Human override
// and recovery). Allow persists the (caller, target, edit) grant, records
// grant_approved, then re-runs availability: a launchable target becomes
// accepted and its request moves blocked -> queued (grant_approved);
// otherwise both stay blocked on the availability reason. Deny records
// grant_denied and cancels the request (blocked -> cancelled, grant_denied);
// no grant is created. Only offered while the reason is grant_required; a
// repeated decision returns the stored outcome and changes nothing.
export function decideWakeGrant(input: {
  wakeId: string;
  decision: 'allow' | 'deny';
  caller: { category: CallerCategory; principal: Principal };
  now?: number;
}): GrantDecisionResult {
  assertOwner(input.caller.category);
  if (input.decision !== 'allow' && input.decision !== 'deny') throw new WakeRouterError('invalid_input', 'decision must be allow or deny.');
  const now = input.now ?? Date.now();
  return db.transaction((): GrantDecisionResult => {
    const wake = getWake(input.wakeId);
    if (!wake) throw new WakeSafetyError('not_found', `No Wake ${input.wakeId}.`);
    const request = wake.work_request_id ? engine.getWorkRequest(wake.work_request_id) : undefined;
    const settled = (entry: RoutedWake, grant: WakeGrant | null): GrantDecisionResult => ({
      ...entry, decision: input.decision, grant,
      runnable: entry.request?.state === 'queued', ended: entry.request?.terminal_at !== null && entry.request?.terminal_at !== undefined,
    });
    if (wake.status !== 'blocked' || wake.reason_code !== 'grant_required' || !request || request.state !== 'blocked') {
      // Already decided this way: replay, not an error.
      const pair = request ? activeEditGrant(wake.requester_agent_id, request.target_agent_id) ?? null : null;
      if (input.decision === 'deny' && wake.reason_code === 'grant_denied') return { ...settled(routed(wake, false), null), runnable: false };
      if (input.decision === 'allow' && pair && wake.reason_code !== 'grant_denied') return { ...settled(routed(wake, false), pair), runnable: false };
      throw new WakeSafetyError('not_pending', 'This Wake is not waiting for an owner grant decision.');
    }
    const decidedBy = { kind: input.caller.principal.kind, id: input.caller.principal.id };
    if (input.decision === 'deny') {
      db.prepare("UPDATE wakes SET reason_code = 'grant_denied', reason = ?, updated_at = ? WHERE id = ?")
        .run('The owner denied this edit Wake.', now, wake.id);
      engine.appendEvent(request.id, { type: 'grant_denied', data: { wake_id: wake.id, caller_agent_id: wake.requester_agent_id, target_agent_id: request.target_agent_id, authority: 'edit', decided_by: decidedBy }, now });
      engine.recordSafetyDecision(request.id, {
        principalType: 'human_owner', principal: decidedBy, decision: 'denied', reasonCode: 'grant_denied', wakeId: wake.id,
        snapshot: { safety_version: WAKE_SAFETY_VERSION, decision: 'deny', decided_by: decidedBy }, now,
      });
      engine.transitionWorkRequest(request.id, {
        from: 'blocked', to: 'cancelled', reason: 'grant_denied', expectedVersion: request.version,
        errorCode: 'grant_denied', errorMessage: 'The owner denied this edit Wake; no work ran.', now,
      });
      return settled(routed(getWake(wake.id) as Wake, false), null);
    }
    const { grant } = ensureEditGrant({ callerAgentId: wake.requester_agent_id, targetAgentId: request.target_agent_id, grantedBy: decidedBy, sourceWakeId: wake.id, now });
    engine.appendEvent(request.id, { type: 'grant_approved', data: { wake_id: wake.id, grant_id: grant.id, caller_agent_id: grant.caller_agent_id, target_agent_id: grant.target_agent_id, authority: 'edit', decided_by: decidedBy }, now });
    const envelope = (JSON.parse(wake.payload) as { envelope: WakeEnvelope }).envelope;
    const target = bots.getById(request.target_agent_id) as Bot;
    const parent = wake.parent_request_id ? engine.getWorkRequest(wake.parent_request_id) ?? null : null;
    const outcome = checkTarget(envelope, wake.syntax, { id: target.id, name: target.name }, { agentId: wake.requester_agent_id, parent });
    return settled(settleBlocked(wake, request, outcome, 'grant_approved', now), grant);
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
