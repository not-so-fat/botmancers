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
  | 'artifact';

export const CONVERSATION_EVENT_KINDS: ConversationEventKind[] = [
  'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
  'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
  'question', 'result', 'artifact',
];

export interface ConversationEventRow {
  id: string;
  conversation_id: string;
  engine_event_id: string;
  part: number;
  request_id: string;
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
  requestId: string;
  requestSequence: number;
  attemptId: string | null;
  wakeId: string | null;
  engineEventId: string;
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
            data: { ...identity, target_name: target, requester_kind: request.requester_kind, requester_id: request.requester_id, parent_request_id: request.parent_request_id, depth: request.depth },
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
              return [{
                kind: 'wake_blocked', attemptId: null,
                text: withReason(`Wake blocked: ${target}`, reason),
                data: { ...identity, target_name: target, reason },
              }];
            }
            return [{ kind: 'request_blocked', attemptId: null, text: withReason('Blocked', reason), data: { from, reason } }];
          case 'queued':
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
            return [{
              kind: to === 'failed' ? 'request_failed' : 'request_cancelled',
              attemptId: finished?.attemptId ?? null,
              text: to === 'failed' ? withReason('Failed', message ?? code) : withReason('Cancelled', reason ?? message),
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
        return artifacts.map(artifact => {
          const ref = artifact && typeof artifact === 'object' ? artifact as Record<string, unknown> : { ref: String(artifact) };
          const kind = str(ref.kind) ?? 'artifact';
          const value = str(ref.ref) ?? '';
          return { kind: 'artifact' as const, attemptId: attempt.id, text: `Artifact (${kind}): ${value}`, data: { artifact_kind: kind, ref: value, outcome: attempt.outcome } };
        });
      }
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

  // Catches the whole conversation up. Safe to call on every read.
  function projectConversation(conversationId: string): number {
    return db.transaction((): number => {
      const ids = db.prepare(
        'SELECT id FROM work_requests WHERE source_conversation_id = ? ORDER BY created_at ASC, id ASC'
      ).all(conversationId) as { id: string }[];
      return ids.reduce((sum, row) => sum + projectRequest(row.id), 0);
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
      ORDER BY sort_at ASC, request_created_at ASC, request_id ASC, request_sequence ASC, part ASC
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
