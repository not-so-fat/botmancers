// NOT-477: UI thread turns are canonical Work Requests (docs/core-engine.md,
// One engine). The UI turn executor (lib/agent) runs every turn of a UI
// thread from work_requests; there is no separate queue table.
//
//   UI message route     -> executor ui_message      (adopt, right after
//                           conversation intake accepts the message)
//   the executor itself  -> executor ui_continuation (enqueue: a handoff
//                           target, a report-back to the caller, a timer
//                           tick, a new Agent's greeting, a gateway poke)
//
// Lifecycle: queued -> running when the executor starts the turn, then
// completed (or failed when the turn threw). Stop cancels the thread's
// queued turns (reason stopped). A coding-Agent message turn that reaches
// launch is handed to the dispatcher (running -> queued, executor
// 'dispatcher'), which runs its one Attempt under the request's policy.
// The dispatcher never selects, recovers, or enforces UI executor rows.
//
// Restart: a UI turn left running by a previous process is failed with
// ui_turn_interrupted (recoverInterrupted) and is not run again; queued
// turns run in order.
//
// A continuation names the turn that caused it as its parent, so the
// thread's work keeps one canonical lineage.
import { randomUUID } from 'crypto';
import db, { engine } from './db';
import {
  EngineStoreError,
  UI_TURN_INTERRUPTED,
  UI_TURN_INTERRUPTED_MESSAGE,
  UI_TURN_REQUESTER,
  uiTurnExecutionPolicy,
  type WorkRequest,
} from './engine-store';

export interface UiTurn {
  // The Work Request id.
  id: string;
  conversation_id: string;
  bot_id: string;
  created_at: number;
  // 'message': accepted by UI intake; 'continuation': created here.
  kind: 'message' | 'continuation';
}

export type UiTurnReason = 'turn' | 'handoff' | 'report_back' | 'tick' | 'greeting' | 'gateway_poke';

export interface EnqueueUiTurnOptions {
  reason?: UiTurnReason;
  // The turn that caused this one (lineage parent).
  parentRequestId?: string | null;
  // A delegated turn (a handoff or poke target) carries the legacy-WAKE
  // conversation policy; anything else the direct-message one.
  delegated?: boolean;
  // Start the turn now (queued -> running) instead of leaving it for the
  // executor's next pick. Used for gateway pokes, which run concurrently.
  start?: boolean;
}

const UI_EXECUTORS = "('ui_message', 'ui_continuation')";

function toTurn(request: WorkRequest): UiTurn {
  return {
    id: request.id,
    conversation_id: request.source_conversation_id,
    bot_id: request.target_agent_id,
    created_at: request.created_at,
    kind: request.executor === 'ui_continuation' ? 'continuation' : 'message',
  };
}

function isUiTurn(request: WorkRequest | undefined): request is WorkRequest {
  return !!request && (request.executor === 'ui_message' || request.executor === 'ui_continuation');
}

function ignoreStale(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof EngineStoreError && error.code === 'stale_state') return false;
    throw error;
  }
}

export const uiTurns = {
  get(id: string): UiTurn | undefined {
    const request = engine.getWorkRequest(id);
    return isUiTurn(request) ? toTurn(request) : undefined;
  },

  // Every UI turn of a conversation (any state), oldest first.
  listByConversation(conversationId: string): (UiTurn & { state: WorkRequest['state'] })[] {
    return (db.prepare(`
      SELECT * FROM work_requests WHERE source_conversation_id = ? AND executor IN ${UI_EXECUTORS}
      ORDER BY created_at ASC, rowid ASC
    `).all(conversationId) as WorkRequest[]).map(request => ({ ...toTurn(request), state: request.state }));
  },

  // One continuation turn for botId in conversationId. Null when the
  // Agent or the conversation no longer exists (nothing to run).
  enqueue(conversationId: string, botId: string, options: EnqueueUiTurnOptions = {}): UiTurn | null {
    if (!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId)) return null;
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return null;
    const reason = options.reason ?? 'turn';
    const latest = db.prepare(
      'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ).get(conversationId) as { id: string } | undefined;
    const parent = options.parentRequestId ? engine.getWorkRequest(options.parentRequestId) : undefined;
    const executionPolicy = uiTurnExecutionPolicy(options.delegated === true);
    return engine.transaction(() => {
      const { request } = engine.createOrGetWorkRequest({
        sourceConversationId: conversationId,
        // A turn with no message yet (a new Agent's greeting) names its
        // conversation.
        sourceEventId: latest?.id ?? conversationId,
        requester: UI_TURN_REQUESTER,
        targetAgentId: botId,
        intent: reason,
        executionKind: executionPolicy.execution_kind,
        toolProfile: executionPolicy.tool_profile,
        idempotencyKey: `ui-turn:${randomUUID()}`,
        parentRequestId: parent ? parent.id : null,
        policy: { source: 'ui_turn', reason },
        executionPolicy,
        // The UI executor applies Stop and the delegation limits itself;
        // no deadline is enforced on its turns.
        deadlineAt: null,
        executor: 'ui_continuation',
      });
      if (options.start) engine.transitionWorkRequest(request.id, { from: 'queued', to: 'running', reason: reason });
      return toTurn(engine.getWorkRequest(request.id) as WorkRequest);
    });
  },

  // The oldest queued UI turn.
  next(): UiTurn | undefined {
    const request = db.prepare(`
      SELECT * FROM work_requests WHERE state = 'queued' AND executor IN ${UI_EXECUTORS}
      ORDER BY created_at ASC, rowid ASC LIMIT 1
    `).get() as WorkRequest | undefined;
    return request ? toTurn(request) : undefined;
  },

  // queued -> running. False when the turn is no longer queued.
  start(id: string): boolean {
    const request = engine.getWorkRequest(id);
    if (!isUiTurn(request) || request.state !== 'queued') return false;
    return ignoreStale(() => {
      engine.transitionWorkRequest(id, { from: 'queued', to: 'running', expectedVersion: request.version });
    });
  },

  // running -> completed or failed. A turn already handed to the
  // dispatcher (or otherwise no longer running) is left alone.
  finish(id: string, outcome: 'completed' | 'failed'): void {
    const request = engine.getWorkRequest(id);
    if (!isUiTurn(request) || request.state !== 'running') return;
    ignoreStale(() => {
      engine.transitionWorkRequest(id, outcome === 'completed'
        ? { from: 'running', to: 'completed', expectedVersion: request.version }
        : {
            from: 'running', to: 'failed', expectedVersion: request.version,
            reason: 'ui_turn_failed', errorCode: 'ui_turn_failed', errorMessage: 'The UI turn failed.',
          });
    });
  },

  // Hands a running UI message turn to the dispatcher: back to queued
  // (reason ui_turn_handoff) with executor 'dispatcher', in one
  // transaction. False when it is not a running UI message turn.
  handOff(id: string): boolean {
    return engine.transaction(() => {
      const request = engine.getWorkRequest(id);
      if (!request || request.executor !== 'ui_message' || request.state !== 'running') return false;
      engine.transitionWorkRequest(id, { from: 'running', to: 'queued', expectedVersion: request.version, reason: 'ui_turn_handoff' });
      db.prepare("UPDATE work_requests SET executor = 'dispatcher' WHERE id = ?").run(id);
      return true;
    });
  },

  // The UI route's dispatch seam: the accepted, still queued Work Requests
  // of a UI message become UI message turns. Runs synchronously after the
  // intake transaction, before any dispatcher pass can see them.
  adopt(requestIds: string[]): void {
    const adopt = db.prepare(
      "UPDATE work_requests SET executor = 'ui_message' WHERE id = ? AND state = 'queued' AND executor = 'dispatcher'"
    );
    engine.transaction(() => {
      for (const id of requestIds) adopt.run(id);
    });
  },

  // Stop: cancels the conversation's queued UI turns. Returns how many.
  cancelPending(conversationId: string): number {
    const ids = (db.prepare(
      `SELECT id FROM work_requests WHERE source_conversation_id = ? AND state = 'queued' AND executor IN ${UI_EXECUTORS}`
    ).all(conversationId) as { id: string }[]).map(row => row.id);
    return cancelQueued(ids);
  },

  cancelPendingForBot(botId: string): number {
    const ids = (db.prepare(
      `SELECT id FROM work_requests WHERE target_agent_id = ? AND state = 'queued' AND executor IN ${UI_EXECUTORS}`
    ).all(botId) as { id: string }[]).map(row => row.id);
    return cancelQueued(ids);
  },

  countPending(conversationId?: string): number {
    const row = conversationId
      ? db.prepare(`SELECT COUNT(*) AS n FROM work_requests WHERE state = 'queued' AND executor IN ${UI_EXECUTORS} AND source_conversation_id = ?`).get(conversationId)
      : db.prepare(`SELECT COUNT(*) AS n FROM work_requests WHERE state = 'queued' AND executor IN ${UI_EXECUTORS}`).get();
    return (row as { n: number }).n;
  },

  // Restart reconciliation: a UI turn left running by a previous process
  // never finished. It is failed (ui_turn_interrupted), not run again.
  recoverInterrupted(): number {
    const ids = (db.prepare(
      `SELECT id FROM work_requests WHERE state = 'running' AND executor IN ${UI_EXECUTORS} ORDER BY created_at ASC, rowid ASC`
    ).all() as { id: string }[]).map(row => row.id);
    let failed = 0;
    for (const id of ids) {
      const done = ignoreStale(() => {
        engine.transitionWorkRequest(id, {
          from: 'running', to: 'failed', reason: UI_TURN_INTERRUPTED,
          errorCode: UI_TURN_INTERRUPTED, errorMessage: UI_TURN_INTERRUPTED_MESSAGE,
        });
      });
      if (done) failed++;
    }
    return failed;
  },
};

function cancelQueued(ids: string[]): number {
  let cancelled = 0;
  for (const id of ids) {
    if (ignoreStale(() => { engine.transitionWorkRequest(id, { from: 'queued', to: 'cancelled', reason: 'stopped' }); })) cancelled++;
  }
  return cancelled;
}
