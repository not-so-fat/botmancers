// NOT-470: conversation projection of Wake and Work Request lifecycle
// events (docs/core-engine.md, Conversation). The engine event log
// (engine_events) is canonical; this module projects it into typed
// conversation_events rows that the UI and /api/v0 conversation reads
// expose through one read model (listConversationEvents).
//
//   engine_events (per request, by sequence)
//     -> projectionsFor: zero or more typed parts per event
//     -> conversation_events (id = engine event id + part)
//
// Idempotency: a row's id is derived from its engine event, and a cursor
// per request records the last sequence read, so replaying, redelivering,
// or reprojecting after a restart writes nothing new. Every projected
// value is a function of the event log and immutable rows (request
// identity and policy, finished attempts, terminal results), so a rebuild
// from the same events produces the same rows.
//
// Order: a request's events project in sequence order and sort_at never
// decreases within a request; a conversation orders by (sort_at, request
// created_at, request id, sequence, part), so interleaved requests stay
// distinguishable and each keeps its own order.
//
// Success: request_completed carries success = true only when the latest
// Attempt before it finished with outcome succeeded. Transport acceptance
// (runtime_started) projects as request_running.
//
// Requests backfilled from legacy agent_requests project nothing; their
// messages remain the readable history.
//
// NOT-487: reviewed Git finalization projects from the implementation's
// own event log (lib/agent-deck-finalization): its candidate manifest as an
// artifact, then preparing, committed, blocked, failed, or canceled with
// run/attempt/review linkage and public commit/tree/manifest identifiers.
// A decision that authorizes nothing projects as finalization_rejected on
// the coordinator request that carried it.
//
// NOT-473: request control projects as its own kinds: cancel requested
// (the durable intent), cancelled, timed out (failed with reason
// timed_out), retry scheduled (queued again under the bounded policy, or by
// an operator), and retries exhausted (failed with reason
// retries_exhausted). Abandoned Attempts, external cancel answers, and late
// results stay internal evidence.
//
// NOT-475: Wake safety. A rejected Wake projects as wake_rejected from the
// Wake row itself (it has no Work Request or engine event, so it never
// shows request_* lifecycle text). A blocked Wake shows its reason, with
// Allow / Deny actions only while it waits for the owner's grant; a later
// reason change (wake_reblocked) shows again. A blocked request admitted by
// the owner or by a recovered target projects as wake_accepted; Deny as
// request_cancelled. A capacity deferral shows as request_queued waiting
// for capacity, and a stopped lineage as lineage_stopped. Grant audit
// events (grant_requested, grant_approved, grant_denied, grant_revoked) stay
// internal.
import type Database from 'better-sqlite3';
import type { EngineEvent, WorkAttempt, WorkRequest, WorkRequestState } from './engine-store';

export type ConversationEventKind =
  | 'wake_accepted'
  | 'wake_blocked'
  | 'request_queued'
  | 'request_blocked'
  | 'request_running'
  | 'request_waiting'
  | 'request_completed'
  | 'request_failed'
  | 'request_cancelled'
  | 'question'
  | 'result'
  | 'artifact'
  | 'finalization_preparing'
  | 'finalization_committed'
  | 'finalization_blocked'
  | 'finalization_failed'
  | 'finalization_canceled'
  | 'finalization_rejected'
  | 'request_cancel_requested'
  | 'request_timed_out'
  | 'request_retry_scheduled'
  | 'request_retries_exhausted'
  | 'wake_rejected'
  | 'lineage_stopped';

export const CONVERSATION_EVENT_KINDS: ConversationEventKind[] = [
  'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
  'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
  'question', 'result', 'artifact',
  'finalization_preparing', 'finalization_committed', 'finalization_blocked',
  'finalization_failed', 'finalization_canceled', 'finalization_rejected',
  'request_cancel_requested', 'request_timed_out', 'request_retry_scheduled', 'request_retries_exhausted',
  'wake_rejected', 'lineage_stopped',
];

export interface ConversationEventRow {
  id: string;
  conversation_id: string;
  // Null for a row projected from a rejected Wake.
  engine_event_id: string | null;
  part: number;
  request_id: string | null;
  request_sequence: number;
  attempt_id: string | null;
  wake_id: string | null;
  kind: ConversationEventKind;
  state: WorkRequestState | null;
  text: string;
  data: string;
  sort_at: number;
  request_created_at: number;
  created_at: number;
}

// The one read model both conversation surfaces return.
export interface ConversationEventView {
  eventId: string;
  seq: number;
  kind: ConversationEventKind;
  requestId: string | null;
  requestSequence: number;
  attemptId: string | null;
  wakeId: string | null;
  engineEventId: string | null;
  state: WorkRequestState | null;
  text: string;
  data: Record<string, unknown>;
  createdAt: number;
}

interface Part {
  kind: ConversationEventKind;
  attemptId: string | null;
  text: string;
  data: Record<string, unknown>;
}

type Db = Database.Database;

function parse(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function withReason(text: string, reason: string | null): string {
  return reason ? `${text}: ${reason}` : text;
}

// A Wake's stored state reason is "<code>: <reason>".
function wakeReason(stateReason: string | null): { code: string | null; reason: string | null } {
  if (!stateReason) return { code: null, reason: null };
  const match = /^([a-z_]+): ([\s\S]*)$/.exec(stateReason);
  return match ? { code: match[1], reason: match[2] } : { code: null, reason: stateReason };
}

const GRANT_REQUIRED_TEXT = 'needs your approval for edit work';

function wakeBlockedPart(target: string, code: string | null, reason: string | null, identity: Record<string, unknown>): Part {
  const grant = code === 'grant_required';
  const shown = grant ? GRANT_REQUIRED_TEXT : reason;
  return {
    kind: 'wake_blocked', attemptId: null,
    text: shown ? `Wake blocked: ${target} — ${shown}` : `Wake blocked: ${target}`,
    data: { ...identity, target_name: target, reason_code: code, reason, actions: grant ? ['allow', 'deny'] : [] },
  };
}

interface WakeRow {
  id: string;
  source_conversation_id: string;
  requested_target: string | null;
  target_name_snapshot: string | null;
  target_agent_id: string | null;
  execution_kind: string | null;
  requester_agent_id: string;
  parent_request_id: string | null;
  root_request_id: string | null;
  depth: number;
  status: string;
  reason_code: string | null;
  reason: string | null;
  limit_value: number | null;
  observed_value: number | null;
  created_at: number;
  updated_at: number;
}

// The one line a rejected Wake shows (contract, Denied, exhausted, and
// unknown behavior). Pure over the Wake row, which is final once rejected.
export function wakeRejectedText(wake: Pick<WakeRow, 'requested_target' | 'target_name_snapshot' | 'reason_code' | 'reason' | 'limit_value' | 'observed_value'>): string {
  const target = wake.target_name_snapshot ?? wake.requested_target ?? 'an unnamed target';
  switch (wake.reason_code) {
    case 'untracked_lineage': return 'Wake not started: its source turn is not tracked work';
    case 'depth_exceeded': return `Wake not started: ${target} — depth limit ${wake.limit_value ?? '?'} reached`;
    case 'root_budget_exhausted': return `Wake not started: ${target} — this work already used ${wake.observed_value ?? wake.limit_value ?? '?'} Wakes`;
    default: return wake.reason ? `Wake not started: ${target} — ${wake.reason}` : `Wake not started: ${target}`;
  }
}

// Request state and the latest finished Attempt as of one event.
interface Replay {
  state: WorkRequestState | null;
  lastFinished: { attemptId: string; outcome: string | null } | null;
}

export function createConversationProjector(db: Db) {
  const getRequest = db.prepare('SELECT * FROM work_requests WHERE id = ?');
  const getAttempt = db.prepare('SELECT * FROM work_attempts WHERE id = ?');
  const listEvents = db.prepare('SELECT * FROM engine_events WHERE request_id = ? ORDER BY sequence ASC');
  const getCursor = db.prepare('SELECT sequence FROM conversation_projection_cursors WHERE request_id = ?');
  const setCursor = db.prepare(`
    INSERT INTO conversation_projection_cursors (request_id, sequence) VALUES (?, ?)
    ON CONFLICT (request_id) DO UPDATE SET sequence = excluded.sequence WHERE excluded.sequence > sequence
  `);
  const insertRow = db.prepare(`
    INSERT OR IGNORE INTO conversation_events (
      id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id,
      kind, state, text, data, sort_at, request_created_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function attemptRow(id: string | null): WorkAttempt | undefined {
    return id ? getAttempt.get(id) as WorkAttempt | undefined : undefined;
  }

  // Parts for one engine event. Pure over the event, the request's
  // immutable fields, finished attempts, and the replayed state before it.
  function projectionsFor(event: EngineEvent, request: WorkRequest, before: Replay): Part[] {
    const data = parse(event.data);
    const policy = parse(request.policy_snapshot);
    const wake = request.wake_event_id !== null;
    const target = str(policy.target_name_snapshot) ?? request.target_agent_id;
    const identity = { target_agent_id: request.target_agent_id, execution_kind: request.execution_kind, tool_profile: request.tool_profile };

    switch (event.type) {
      case 'accepted': {
        // A request that starts blocked projects from its blocked event.
        if (data.state === 'blocked') return [];
        if (wake) {
          return [{
            kind: 'wake_accepted', attemptId: null,
            text: `Wake accepted: ${target} (${request.execution_kind})`,
            data: {
              ...identity, target_name: target, requester_kind: request.requester_kind, requester_id: request.requester_id,
              parent_request_id: request.parent_request_id, depth: request.depth, wake_depth: request.wake_depth,
              grant_rule: str(policy.grant_rule), grant_id: str(policy.grant_id),
            },
          }];
        }
        return [{ kind: 'request_queued', attemptId: null, text: 'Queued', data: { ...identity, requester_kind: request.requester_kind, requester_id: request.requester_id } }];
      }
      case 'state_changed': {
        const to = str(data.to) as WorkRequestState | null;
        const from = str(data.from);
        const reason = str(data.reason);
        switch (to) {
          case 'blocked':
            // A Wake whose request started blocked (accepted as blocked).
            if (wake && from === 'queued' && before.state === 'blocked') {
              const parsed = wakeReason(reason);
              return [wakeBlockedPart(target, parsed.code, parsed.reason, identity)];
            }
            return [{ kind: 'request_blocked', attemptId: null, text: withReason('Blocked', reason), data: { from, reason } }];
          case 'queued':
            if (reason === 'retry_scheduled') {
              const attempts = typeof data.attempt_count === 'number' ? data.attempt_count : null;
              const max = typeof data.max_attempts === 'number' ? data.max_attempts : null;
              return [{
                kind: 'request_retry_scheduled', attemptId: before.lastFinished?.attemptId ?? null,
                text: data.manual === true
                  ? `Retry requested${attempts !== null && max !== null ? ` (Attempt ${attempts + 1} of ${max})` : ''}`
                  : `Retry scheduled${attempts !== null && max !== null ? ` (Attempt ${attempts + 1} of ${max})` : ''}${typeof data.delay_ms === 'number' ? ` in ${data.delay_ms} ms` : ''}`,
                data: {
                  from, reason, manual: data.manual === true, attempt_count: attempts, max_attempts: max,
                  next_eligible_at: data.next_eligible_at ?? null, delay_ms: data.delay_ms ?? null,
                  category: data.category ?? null, outcome: before.lastFinished?.outcome ?? null,
                },
              }];
            }
            // A blocked Wake admitted by the owner's grant or a recovered
            // target: accepted now.
            if (wake && from === 'blocked' && (reason === 'grant_approved' || reason === 'target_available')) {
              return [{
                kind: 'wake_accepted', attemptId: null,
                text: `Wake accepted: ${target} (${request.execution_kind})`,
                data: {
                  ...identity, target_name: target, requester_kind: request.requester_kind, requester_id: request.requester_id,
                  parent_request_id: request.parent_request_id, depth: request.depth, wake_depth: request.wake_depth,
                  reason, grant_rule: data.grant_rule ?? null, grant_id: data.grant_id ?? null,
                },
              }];
            }
            return [{ kind: 'request_queued', attemptId: null, text: withReason('Queued again', reason), data: { from, reason } }];
          case 'running':
            return [{ kind: 'request_running', attemptId: null, text: 'Running', data: { phase: 'dispatched', from } }];
          case 'waiting':
            return [{ kind: 'request_waiting', attemptId: null, text: withReason('Waiting', reason), data: { from, reason } }];
          case 'completed': {
            const finished = before.lastFinished;
            const success = finished?.outcome === 'succeeded';
            const parts: Part[] = [{
              kind: 'request_completed', attemptId: finished?.attemptId ?? null,
              text: success ? 'Completed' : 'Completed without a successful Attempt outcome',
              data: { success, outcome: finished?.outcome ?? null },
            }];
            if (success && finished) {
              const attempt = attemptRow(finished.attemptId);
              const result = parse(request.result);
              parts.push({
                kind: 'result', attemptId: finished.attemptId,
                text: attempt?.output ?? 'Result recorded',
                data: { reply_message_id: str(result.reply_message_id), has_output: typeof attempt?.output === 'string' },
              });
            }
            return parts;
          }
          case 'failed':
          case 'cancelled': {
            const finished = before.lastFinished;
            const code = request.error_code ?? str(data.error_code);
            const message = request.error_message;
            if (to === 'failed' && reason === 'timed_out') {
              return [{
                kind: 'request_timed_out', attemptId: finished?.attemptId ?? null,
                text: 'Timed out: the request passed its deadline',
                data: { success: false, error_code: code, reason, deadline_at: data.deadline_at ?? null, from, outcome: finished?.outcome ?? null },
              }];
            }
            if (to === 'failed' && reason === 'retries_exhausted') {
              return [{
                kind: 'request_retries_exhausted', attemptId: finished?.attemptId ?? null,
                text: withReason(`Retries exhausted after ${data.attempt_count ?? '?'} of ${data.max_attempts ?? '?'} Attempts`, message ?? code),
                data: {
                  success: false, error_code: code, error_message: message, reason,
                  attempt_count: data.attempt_count ?? null, max_attempts: data.max_attempts ?? null, outcome: finished?.outcome ?? null,
                },
              }];
            }
            return [{
              kind: to === 'failed' ? 'request_failed' : 'request_cancelled',
              attemptId: finished?.attemptId ?? null,
              text: to === 'failed'
                ? withReason('Failed', message ?? code)
                // A cancellation command names its own reason (set once).
                : reason === 'cancel_requested' ? withReason('Cancelled', request.cancel_reason)
                  : reason === 'grant_denied' ? 'Cancelled: owner denied edit Wake'
                    : withReason('Cancelled', reason ?? message),
              data: { success: false, error_code: code, error_message: message, reason, outcome: finished?.outcome ?? null },
            }];
          }
          default:
            return [];
        }
      }
      case 'runtime_started': {
        // Transport acceptance: the runtime took the work. Not success.
        const adapter = str(data.adapter);
        return [{
          kind: 'request_running', attemptId: event.attempt_id,
          text: adapter ? `Running on ${adapter}` : 'Running',
          data: { phase: 'runtime_started', adapter, external_run_id: str(data.external_run_id), success: false },
        }];
      }
      case 'wake_reblocked':
        return [wakeBlockedPart(target, str(data.reason_code), str(data.reason), identity)];
      case 'dispatch_deferred':
        // Allowed work waiting for a global or per-target slot: queued,
        // never a denial. Recorded once per wait.
        return [{
          kind: 'request_queued', attemptId: null,
          text: 'Queued: waiting for capacity',
          data: {
            waiting_for: 'capacity', limit: str(data.reason), active_global: data.active_global ?? null, active_target: data.active_target ?? null,
            max_global: data.max_global ?? null, max_per_target: data.max_per_target ?? null,
          },
        }];
      case 'lineage_stopped':
        return [{
          kind: 'lineage_stopped', attemptId: null,
          text: data.reason === 'continuation_budget_exhausted'
            ? `Stopped: coordinator continuation limit ${data.limit ?? '?'} reached`
            : withReason('Stopped', str(data.reason)),
          data,
        }];
      case 'cancel_requested': {
        const reason = str(data.reason);
        return [{
          kind: 'request_cancel_requested', attemptId: null,
          text: withReason('Cancel requested', reason),
          data: { by: str(data.by), reason, state: str(data.state) },
        }];
      }
      case 'question': {
        const question = str(data.question) ?? '';
        return [{ kind: 'question', attemptId: event.attempt_id, text: question, data: { question } }];
      }
      case 'attempt_finished': {
        const attempt = attemptRow(event.attempt_id);
        if (!attempt) return [];
        let artifacts: unknown[] = [];
        try {
          const parsed = JSON.parse(attempt.artifacts);
          if (Array.isArray(parsed)) artifacts = parsed;
        } catch { /* no artifacts */ }
        // A candidate manifest projects from its own event, with its digests.
        return artifacts.filter(artifact => !(artifact && typeof artifact === 'object' && (artifact as Record<string, unknown>).kind === 'candidate_manifest')).map(artifact => {
          const ref = artifact && typeof artifact === 'object' ? artifact as Record<string, unknown> : { ref: String(artifact) };
          const kind = str(ref.kind) ?? 'artifact';
          const value = str(ref.ref) ?? '';
          return { kind: 'artifact' as const, attemptId: attempt.id, text: `Artifact (${kind}): ${value}`, data: { artifact_kind: kind, ref: value, outcome: attempt.outcome } };
        });
      }
      case 'candidate_manifest_recorded': {
        const digest = str(data.manifest_digest);
        const count = typeof data.file_count === 'number' ? data.file_count : 0;
        return [{
          kind: 'artifact', attemptId: event.attempt_id,
          text: `Candidate manifest ${digest}: ${count} ${count === 1 ? 'file' : 'files'} on base ${str(data.base_commit)}`,
          data: { artifact_kind: 'candidate_manifest', ref: digest, ...data },
        }];
      }
      case 'candidate_manifest_unavailable':
        return [{
          kind: 'finalization_blocked', attemptId: event.attempt_id,
          text: withReason('Not finalizable', str(data.reason_code)),
          data: { phase: 'candidate', ...data },
        }];
      case 'finalization_preparing':
        return [{
          kind: 'finalization_preparing', attemptId: event.attempt_id,
          text: `Finalization preparing: manifest ${str(data.manifest_digest)} (${data.file_count ?? 0} files), review ${str(data.review_request_id)}`,
          data,
        }];
      case 'finalization_retry_pending':
        return [{
          kind: 'finalization_preparing', attemptId: event.attempt_id,
          text: withReason('Finalization waiting to retry', str(data.reason_code)),
          data: { retry: true, ...data },
        }];
      case 'finalization_committed':
        return [{
          kind: 'finalization_committed', attemptId: event.attempt_id,
          text: `Finalization committed: commit ${str(data.commit)} (tree ${str(data.tree)}, manifest ${str(data.result_manifest_digest) ?? str(data.manifest_digest)})`,
          data: { success: true, ...data },
        }];
      case 'finalization_blocked':
      case 'finalization_failed':
      case 'finalization_canceled': {
        const label = event.type === 'finalization_blocked' ? 'blocked' : event.type === 'finalization_failed' ? 'failed' : 'canceled';
        return [{
          kind: event.type, attemptId: event.attempt_id,
          text: withReason(`Finalization ${label}`, str(data.reason_code)),
          data: { success: false, ...data },
        }];
      }
      case 'finalization_rejected':
        return [{
          kind: 'finalization_rejected', attemptId: null,
          text: withReason('Finalization not started', str(data.reason_code)),
          data,
        }];
      default:
        // attempt_started, session_bound, runtime_progress: internal.
        return [];
    }
  }

  function advance(replay: Replay, event: EngineEvent): void {
    const data = parse(event.data);
    if (event.type === 'accepted' && str(data.state)) replay.state = data.state as WorkRequestState;
    if (event.type === 'state_changed' && str(data.to)) replay.state = data.to as WorkRequestState;
    if (event.type === 'attempt_finished' && event.attempt_id) {
      replay.lastFinished = { attemptId: event.attempt_id, outcome: str(data.outcome) };
    }
  }

  // Projects every not-yet-read event of one request, in sequence order.
  // Returns the number of rows written.
  function projectRequest(requestId: string): number {
    return db.transaction((): number => {
      const request = getRequest.get(requestId) as WorkRequest | undefined;
      if (!request) return 0;
      const cursor = (getCursor.get(requestId) as { sequence: number } | undefined)?.sequence ?? 0;
      const events = listEvents.all(requestId) as EngineEvent[];
      const last = events.length > 0 ? events[events.length - 1].sequence : 0;
      if (last <= cursor) return 0;
      const replay: Replay = { state: null, lastFinished: null };
      let sortAt = 0;
      let written = 0;
      for (const event of events) {
        sortAt = Math.max(sortAt, event.created_at);
        const before: Replay = { ...replay };
        advance(replay, event);
        if (event.sequence <= cursor || request.legacy_agent_request_id !== null) continue;
        const parts = projectionsFor(event, request, before);
        parts.forEach((part, index) => {
          written += insertRow.run(
            `${event.id}:${index}`, request.source_conversation_id, event.id, index, request.id, event.sequence,
            part.attemptId, request.wake_event_id, part.kind, replay.state, part.text, JSON.stringify(part.data),
            sortAt, request.created_at, event.created_at
          ).changes;
        });
      }
      setCursor.run(requestId, last);
      return written;
    }).immediate();
  }

  // One row per rejected Wake, keyed by the Wake. A rejection is final, so
  // the row is a pure function of the Wake row and is written once.
  function projectRejectedWakes(conversationId: string): number {
    const rows = db.prepare(`
      SELECT w.* FROM wakes w
      WHERE w.source_conversation_id = ? AND w.status = 'rejected'
        AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.id = 'wake:' || w.id || ':0')
      ORDER BY w.created_at ASC, w.position ASC
    `).all(conversationId) as WakeRow[];
    let written = 0;
    for (const wake of rows) {
      const data = {
        wake_id: wake.id, target_name: wake.target_name_snapshot ?? wake.requested_target, target_agent_id: wake.target_agent_id,
        execution_kind: wake.execution_kind, requester_agent_id: wake.requester_agent_id, parent_request_id: wake.parent_request_id,
        reason_code: wake.reason_code, reason: wake.reason,
        limit: wake.limit_value, observed: wake.observed_value, work_request_id: null,
      };
      written += insertRow.run(
        `wake:${wake.id}:0`, wake.source_conversation_id, null, 0, null, 0, null, wake.id, 'wake_rejected', null,
        wakeRejectedText(wake), JSON.stringify(data), wake.updated_at, wake.created_at, wake.updated_at
      ).changes;
    }
    return written;
  }

  // Catches the whole conversation up. Safe to call on every read.
  function projectConversation(conversationId: string): number {
    return db.transaction((): number => {
      const ids = db.prepare(
        'SELECT id FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at ASC, id ASC'
      ).all(conversationId) as { id: string }[];
      return ids.reduce((sum, row) => sum + projectRequest(row.id), 0) + projectRejectedWakes(conversationId);
    }).immediate();
  }

  // Redelivery entry point: projects the event's request up to and
  // including it (earlier events first, so order holds).
  function projectEvent(event: Pick<EngineEvent, 'request_id'>): number {
    return projectRequest(event.request_id);
  }

  function listConversationEventRows(conversationId: string): ConversationEventRow[] {
    return db.prepare(`
      SELECT * FROM conversation_events WHERE conversation_id = ?
      ORDER BY sort_at ASC, request_created_at ASC, COALESCE(request_id, wake_id) ASC, request_sequence ASC, part ASC
    `).all(conversationId) as ConversationEventRow[];
  }

  // Projects any pending events, then returns the ordered read model.
  function listConversationEvents(conversationId: string): ConversationEventView[] {
    projectConversation(conversationId);
    return listConversationEventRows(conversationId).map((row, index) => ({
      eventId: row.id,
      seq: index + 1,
      kind: row.kind,
      requestId: row.request_id,
      requestSequence: row.request_sequence,
      attemptId: row.attempt_id,
      wakeId: row.wake_id,
      engineEventId: row.engine_event_id,
      state: row.state,
      text: row.text,
      data: parse(row.data),
      createdAt: row.created_at,
    }));
  }

  return { projectRequest, projectConversation, projectEvent, listConversationEventRows, listConversationEvents };
}

export type ConversationProjector = ReturnType<typeof createConversationProjector>;
