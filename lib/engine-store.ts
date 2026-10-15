import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import {
  TOOL_PROFILE_FOR_KIND,
  isExecutionKind,
  selectExecutionPolicy,
  validateExecutionPolicy,
  type ExecutionKind,
  type ExecutionPolicySnapshot,
  type ToolProfile,
} from './execution-policy';
import { requestControlDefaultsFromEnv, validateRetryPolicy, type RetryPolicy } from './request-policy';

// NOT-463: canonical core-engine persistence (docs/core-engine.md). One
// Work Request store, immutable Attempts, opaque Session Bindings, and an
// append-only per-request engine event log. NOT-465: UI and /api/v0
// message intake create their Work Requests here (lib/conversation-intake).
// NOT-477: the pre-NOT-465 agent_requests lifecycle is retired; migration 14
// copies it here and archives its tables (archiveLegacyAgentRequests).
// Migration 15 does the same for the UI loop's processing_queue
// (retireProcessingQueue): UI thread turns are Work Requests run by the UI
// turn executor (RequestExecutor), and their delegation accounting is the
// durable delegation_chains table.
// NOT-466: Agent Wakes are recorded in wakes and create theirs through
// lib/wake-router.
//
// Foreign keys are enforced by triggers because the shared connection
// runs with PRAGMA foreign_keys off (legacy tables were never written
// under enforcement). The declared FOREIGN KEY clauses document the same
// relations and also hold if enforcement is ever switched on.

export { TOOL_PROFILE_FOR_KIND };
export type { ExecutionKind, ToolProfile };

export type WorkRequestState = 'queued' | 'blocked' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type AttemptKind = 'launch' | 'resume';
export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'timed_out';
export type RequesterKind = 'person' | 'bot' | 'service';

export const WORK_REQUEST_STATES: WorkRequestState[] = ['queued', 'blocked', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
export const TERMINAL_STATES: WorkRequestState[] = ['completed', 'failed', 'cancelled'];

// Allowed lifecycle edges. Terminal states have no outgoing edges.
// running -> queued and waiting -> queued return work to the queue (for
// example an interrupted attempt); whether to retry is the caller's policy.
export const WORK_REQUEST_TRANSITIONS: Record<WorkRequestState, WorkRequestState[]> = {
  queued: ['running', 'blocked', 'cancelled', 'failed'],
  blocked: ['queued', 'cancelled', 'failed'],
  running: ['waiting', 'queued', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'queued', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface WorkRequest {
  id: string;
  source_conversation_id: string;
  source_event_id: string;
  requester_kind: RequesterKind;
  requester_id: string;
  target_agent_id: string;
  intent: string;
  execution_kind: ExecutionKind;
  tool_profile: ToolProfile;
  parent_request_id: string | null;
  root_request_id: string;
  wake_event_id: string | null;
  depth: number;
  idempotency_key: string;
  request_hash: string;
  policy_snapshot: string;
  state: WorkRequestState;
  state_reason: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  version: number;
  legacy_agent_request_id: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  // NOT-473 request control (null on rows from before it).
  deadline_at: number | null;
  retry_policy: string | null;
  attempt_count: number;
  next_eligible_at: number | null;
  cancel_requested_at: number | null;
  cancel_requested_by: string | null;
  cancel_reason: string | null;
  // NOT-475 lineage safety (migration 13 backfills older rows).
  wake_depth: number;
  root_principal_kind: string | null;
  root_principal_id: string | null;
  // NOT-477 (migration 15): who runs the request (RequestExecutor).
  executor: RequestExecutor;
}

// NOT-477: which worker runs a Work Request. 'dispatcher' requests run
// through lib/dispatcher (leases, Attempts, recovery). A UI thread turn
// runs through the UI turn executor (lib/ui-turns, lib/agent): 'ui_message'
// is a turn accepted by UI intake, 'ui_continuation' one the executor
// created itself (a handoff, a report-back, a timer tick, a greeting). A
// UI message turn for a coding Agent is handed to the dispatcher (its
// executor becomes 'dispatcher') once the executor's hooks let it launch.
export type RequestExecutor = 'dispatcher' | 'ui_message' | 'ui_continuation';
export const REQUEST_EXECUTORS: RequestExecutor[] = ['dispatcher', 'ui_message', 'ui_continuation'];

// NOT-475: how a caller was categorized at its strongest available
// boundary (lib/wake-safety). Unknown callers never reach the store.
export type SafetyPrincipalType = 'human_owner' | 'api_principal' | 'agent_principal' | 'engine';
export type SafetyDecisionKind = 'allowed' | 'blocked' | 'denied';

export interface SafetyDecisionInput {
  principalType: SafetyPrincipalType;
  principal: { kind: string; id: string };
  decision: SafetyDecisionKind;
  reasonCode?: string | null;
  grantRule?: string | null;
  grantId?: string | null;
  wakeId?: string | null;
  // The policy evaluated (limits, depth, budget, grant), stored verbatim.
  snapshot: Record<string, unknown>;
  now?: number;
}

export interface SafetyDecision {
  id: string;
  request_id: string;
  sequence: number;
  wake_id: string | null;
  principal_type: SafetyPrincipalType;
  principal_kind: string;
  principal_id: string;
  target_agent_id: string;
  execution_kind: ExecutionKind;
  decision: SafetyDecisionKind;
  reason_code: string | null;
  grant_rule: string | null;
  grant_id: string | null;
  policy_snapshot: string;
  created_at: number;
}

export interface WorkAttempt {
  id: string;
  request_id: string;
  attempt_number: number;
  kind: AttemptKind;
  adapter: string;
  tool_profile: ToolProfile;
  launch_snapshot: string;
  launch_snapshot_hash: string;
  resumed_session_binding_id: string | null;
  external_run_id: string | null;
  external_session_id: string | null;
  outcome: AttemptOutcome | null;
  output: string | null;
  error_category: string | null;
  error_message: string | null;
  artifacts: string;
  started_at: number;
  finished_at: number | null;
}

export interface SessionBinding {
  id: string;
  agent_id: string;
  adapter: string;
  conversation_id: string | null;
  request_id: string | null;
  external_session_id: string;
  source_attempt_id: string | null;
  created_at: number;
  released_at: number | null;
}

export interface EngineEvent {
  id: string;
  request_id: string;
  sequence: number;
  attempt_id: string | null;
  type: string;
  data: string | null;
  created_at: number;
}

export type EngineStoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'stale_state'
  | 'attempt_conflict'
  | 'session_mismatch';

export class EngineStoreError extends Error {
  code: EngineStoreErrorCode;
  constructor(code: EngineStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type Db = Database.Database;

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const terminalList = TERMINAL_STATES.map(state => `'${state}'`).join(', ');
const stateList = WORK_REQUEST_STATES.map(state => `'${state}'`).join(', ');

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_engine_tables',
    up: db => {
      db.exec(`
        CREATE TABLE work_request_transitions (
          from_state TEXT NOT NULL,
          to_state TEXT NOT NULL,
          PRIMARY KEY (from_state, to_state)
        );

        CREATE TABLE work_requests (
          id TEXT PRIMARY KEY,
          source_conversation_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          requester_kind TEXT NOT NULL CHECK (requester_kind IN ('person', 'bot', 'service')),
          requester_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          intent TEXT NOT NULL,
          execution_kind TEXT NOT NULL CHECK (execution_kind IN ('conversation', 'implementation', 'review', 'revision')),
          tool_profile TEXT NOT NULL CHECK (tool_profile IN ('readonly', 'edit')),
          parent_request_id TEXT,
          root_request_id TEXT NOT NULL,
          wake_event_id TEXT,
          depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
          idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
          request_hash TEXT NOT NULL,
          policy_snapshot TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (${stateList})),
          state_reason TEXT,
          result TEXT,
          error_code TEXT,
          error_message TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          legacy_agent_request_id TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          terminal_at INTEGER,
          CHECK ((state IN (${terminalList})) = (terminal_at IS NOT NULL)),
          FOREIGN KEY (source_conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (target_agent_id) REFERENCES bots(id),
          FOREIGN KEY (parent_request_id) REFERENCES work_requests(id),
          FOREIGN KEY (root_request_id) REFERENCES work_requests(id)
        );

        CREATE UNIQUE INDEX idx_work_requests_idempotency
          ON work_requests(requester_kind, requester_id, idempotency_key);
        CREATE INDEX idx_work_requests_conversation
          ON work_requests(source_conversation_id, created_at);
        CREATE INDEX idx_work_requests_state
          ON work_requests(state, created_at);
        CREATE INDEX idx_work_requests_parent
          ON work_requests(parent_request_id) WHERE parent_request_id IS NOT NULL;

        CREATE TABLE session_bindings (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          conversation_id TEXT,
          request_id TEXT,
          external_session_id TEXT NOT NULL,
          source_attempt_id TEXT,
          created_at INTEGER NOT NULL,
          released_at INTEGER,
          CHECK (conversation_id IS NOT NULL OR request_id IS NOT NULL),
          FOREIGN KEY (agent_id) REFERENCES bots(id),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id),
          FOREIGN KEY (source_attempt_id) REFERENCES work_attempts(id)
        );

        CREATE UNIQUE INDEX idx_session_bindings_active
          ON session_bindings(agent_id, adapter, IFNULL(conversation_id, ''), IFNULL(request_id, ''))
          WHERE released_at IS NULL;

        CREATE TABLE work_attempts (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
          kind TEXT NOT NULL CHECK (kind IN ('launch', 'resume')),
          adapter TEXT NOT NULL CHECK (length(adapter) > 0),
          tool_profile TEXT NOT NULL CHECK (tool_profile IN ('readonly', 'edit')),
          launch_snapshot TEXT NOT NULL,
          launch_snapshot_hash TEXT NOT NULL,
          resumed_session_binding_id TEXT,
          external_run_id TEXT,
          external_session_id TEXT,
          outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out')),
          error_category TEXT,
          error_message TEXT,
          artifacts TEXT NOT NULL DEFAULT '[]',
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          CHECK ((outcome IS NULL) = (finished_at IS NULL)),
          CHECK ((kind = 'resume') = (resumed_session_binding_id IS NOT NULL)),
          UNIQUE (request_id, attempt_number),
          FOREIGN KEY (request_id) REFERENCES work_requests(id),
          FOREIGN KEY (resumed_session_binding_id) REFERENCES session_bindings(id)
        );

        CREATE UNIQUE INDEX idx_work_attempts_open
          ON work_attempts(request_id) WHERE finished_at IS NULL;

        CREATE TABLE engine_events (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          attempt_id TEXT,
          type TEXT NOT NULL CHECK (length(type) > 0),
          data TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (request_id, sequence),
          FOREIGN KEY (request_id) REFERENCES work_requests(id),
          FOREIGN KEY (attempt_id) REFERENCES work_attempts(id)
        );

        -- Foreign keys (insert/update side).
        CREATE TRIGGER trg_work_requests_fk_insert BEFORE INSERT ON work_requests
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.source_conversation_id')
            WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE id = NEW.source_conversation_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.target_agent_id')
            WHERE NOT EXISTS (SELECT 1 FROM bots WHERE id = NEW.target_agent_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.parent_request_id')
            WHERE NEW.parent_request_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.parent_request_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.root_request_id')
            WHERE NEW.root_request_id <> NEW.id
              AND NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.root_request_id);
        END;

        -- Identity, lineage, and policy are fixed at intake.
        CREATE TRIGGER trg_work_requests_immutable BEFORE UPDATE OF
          id, source_conversation_id, source_event_id, requester_kind, requester_id,
          target_agent_id, intent, execution_kind, tool_profile, parent_request_id,
          root_request_id, wake_event_id, depth, idempotency_key, request_hash,
          policy_snapshot, legacy_agent_request_id, created_at
        ON work_requests
        BEGIN
          SELECT RAISE(ABORT, 'work_requests identity, lineage, and policy are immutable');
        END;

        CREATE TRIGGER trg_work_requests_transition BEFORE UPDATE OF state ON work_requests
        WHEN NEW.state <> OLD.state
        BEGIN
          SELECT RAISE(ABORT, 'invalid work_requests state transition')
            WHERE NOT EXISTS (
              SELECT 1 FROM work_request_transitions WHERE from_state = OLD.state AND to_state = NEW.state
            );
        END;

        CREATE TRIGGER trg_work_requests_terminal BEFORE UPDATE ON work_requests
        WHEN OLD.state IN (${terminalList})
        BEGIN
          SELECT RAISE(ABORT, 'terminal work_requests are immutable');
        END;

        CREATE TRIGGER trg_session_bindings_fk BEFORE INSERT ON session_bindings
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.conversation_id')
            WHERE NEW.conversation_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.request_id')
            WHERE NEW.request_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.request_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.source_attempt_id')
            WHERE NEW.source_attempt_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_attempts WHERE id = NEW.source_attempt_id);
        END;

        -- A binding's session value is opaque and never rewritten; only
        -- release (supersession) may change.
        CREATE TRIGGER trg_session_bindings_immutable BEFORE UPDATE OF
          id, agent_id, adapter, conversation_id, request_id, external_session_id, source_attempt_id, created_at
        ON session_bindings
        BEGIN
          SELECT RAISE(ABORT, 'session_bindings are immutable');
        END;

        CREATE TRIGGER trg_work_attempts_fk BEFORE INSERT ON work_attempts
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_attempts.request_id')
            WHERE NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.request_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_attempts.resumed_session_binding_id')
            WHERE NEW.resumed_session_binding_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM session_bindings WHERE id = NEW.resumed_session_binding_id);
        END;

        -- Launch snapshot and authority never change after insert.
        CREATE TRIGGER trg_work_attempts_immutable BEFORE UPDATE OF
          id, request_id, attempt_number, kind, adapter, tool_profile,
          launch_snapshot, launch_snapshot_hash, resumed_session_binding_id, started_at
        ON work_attempts
        BEGIN
          SELECT RAISE(ABORT, 'work_attempts launch fields are immutable');
        END;

        -- External identifiers are recorded once, never rewritten.
        CREATE TRIGGER trg_work_attempts_external_ids BEFORE UPDATE OF external_run_id, external_session_id ON work_attempts
        WHEN (OLD.external_run_id IS NOT NULL AND NEW.external_run_id IS NOT OLD.external_run_id)
          OR (OLD.external_session_id IS NOT NULL AND NEW.external_session_id IS NOT OLD.external_session_id)
        BEGIN
          SELECT RAISE(ABORT, 'work_attempts external identifiers are set once');
        END;

        CREATE TRIGGER trg_work_attempts_finished BEFORE UPDATE ON work_attempts
        WHEN OLD.finished_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'finished work_attempts are immutable');
        END;

        CREATE TRIGGER trg_engine_events_fk BEFORE INSERT ON engine_events
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: engine_events.request_id')
            WHERE NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.request_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: engine_events.attempt_id')
            WHERE NEW.attempt_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_attempts WHERE id = NEW.attempt_id AND request_id = NEW.request_id);
        END;

        CREATE TRIGGER trg_engine_events_append_only BEFORE UPDATE ON engine_events
        BEGIN
          SELECT RAISE(ABORT, 'engine_events are append-only');
        END;
      `);
      const insertEdge = db.prepare('INSERT INTO work_request_transitions (from_state, to_state) VALUES (?, ?)');
      for (const from of WORK_REQUEST_STATES) {
        for (const to of WORK_REQUEST_TRANSITIONS[from]) insertEdge.run(from, to);
      }
    },
  },
  {
    version: 2,
    name: 'core_engine_referential_integrity',
    up: db => {
      db.exec(`
        -- Foreign keys (delete side): RESTRICT. A referenced row cannot be
        -- deleted while anything still points at it; deleteEngineRecords
        -- removes dependants first, in one transaction.
        CREATE TRIGGER trg_conversations_engine_restrict BEFORE DELETE ON conversations
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.source_conversation_id')
            WHERE EXISTS (SELECT 1 FROM work_requests WHERE source_conversation_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.conversation_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE conversation_id = OLD.id);
        END;

        CREATE TRIGGER trg_bots_engine_restrict BEFORE DELETE ON bots
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.target_agent_id')
            WHERE EXISTS (SELECT 1 FROM work_requests WHERE target_agent_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.agent_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE agent_id = OLD.id);
        END;

        CREATE TRIGGER trg_work_requests_restrict BEFORE DELETE ON work_requests
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.parent_request_id')
            WHERE EXISTS (
              SELECT 1 FROM work_requests
              WHERE id <> OLD.id AND (parent_request_id = OLD.id OR root_request_id = OLD.id)
            );
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_attempts.request_id')
            WHERE EXISTS (SELECT 1 FROM work_attempts WHERE request_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: engine_events.request_id')
            WHERE EXISTS (SELECT 1 FROM engine_events WHERE request_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.request_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE request_id = OLD.id);
        END;

        CREATE TRIGGER trg_work_attempts_restrict BEFORE DELETE ON work_attempts
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: engine_events.attempt_id')
            WHERE EXISTS (SELECT 1 FROM engine_events WHERE attempt_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.source_attempt_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE source_attempt_id = OLD.id);
        END;

        CREATE TRIGGER trg_session_bindings_restrict BEFORE DELETE ON session_bindings
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_attempts.resumed_session_binding_id')
            WHERE EXISTS (SELECT 1 FROM work_attempts WHERE resumed_session_binding_id = OLD.id);
        END;

        -- Session continuity: a binding belongs to one Agent and adapter in
        -- one scope, and its source attempt must come from that scope.
        CREATE TRIGGER trg_session_bindings_scope BEFORE INSERT ON session_bindings
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.agent_id')
            WHERE NOT EXISTS (SELECT 1 FROM bots WHERE id = NEW.agent_id);
          SELECT RAISE(ABORT, 'session binding does not match its work request')
            WHERE NEW.request_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM work_requests r
              WHERE r.id = NEW.request_id AND r.target_agent_id = NEW.agent_id
                AND (NEW.conversation_id IS NULL OR r.source_conversation_id = NEW.conversation_id)
            );
          SELECT RAISE(ABORT, 'session binding does not match its source attempt')
            WHERE NEW.source_attempt_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM work_attempts a JOIN work_requests r ON r.id = a.request_id
              WHERE a.id = NEW.source_attempt_id AND a.adapter = NEW.adapter AND r.target_agent_id = NEW.agent_id
                AND (NEW.request_id IS NULL OR a.request_id = NEW.request_id)
                AND (NEW.conversation_id IS NULL OR r.source_conversation_id = NEW.conversation_id)
            );
        END;

        -- A resume continues an active binding of the same Agent and
        -- adapter, from the same conversation and request lineage.
        CREATE TRIGGER trg_work_attempts_resume_scope BEFORE INSERT ON work_attempts
        WHEN NEW.resumed_session_binding_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'resumed session binding does not match the work request')
            WHERE NOT EXISTS (
              SELECT 1 FROM session_bindings b
              JOIN work_requests r ON r.id = NEW.request_id
              LEFT JOIN work_requests br ON br.id = b.request_id
              WHERE b.id = NEW.resumed_session_binding_id AND b.released_at IS NULL
                AND b.agent_id = r.target_agent_id AND b.adapter = NEW.adapter
                AND (b.conversation_id IS NULL OR b.conversation_id = r.source_conversation_id)
                AND (b.request_id IS NULL OR br.root_request_id = r.root_request_id)
            );
        END;
      `);
    },
  },
  {
    version: 3,
    name: 'core_engine_hardening',
    up: db => {
      const edges = WORK_REQUEST_STATES
        .flatMap(from => WORK_REQUEST_TRANSITIONS[from].map(to => `'${from}>${to}'`))
        .join(', ');
      db.exec(`
        -- The lifecycle allowlist lives in the trigger itself, so no data
        -- write can widen or break it. work_request_transitions stays as a
        -- readable copy and is locked against writes.
        DROP TRIGGER trg_work_requests_transition;
        CREATE TRIGGER trg_work_requests_transition BEFORE UPDATE OF state ON work_requests
        WHEN NEW.state <> OLD.state
        BEGIN
          SELECT RAISE(ABORT, 'invalid work_requests state transition')
            WHERE (OLD.state || '>' || NEW.state) NOT IN (${edges});
        END;

        CREATE TRIGGER trg_work_request_transitions_insert BEFORE INSERT ON work_request_transitions
        BEGIN
          SELECT RAISE(ABORT, 'work_request_transitions is read-only');
        END;
        CREATE TRIGGER trg_work_request_transitions_update BEFORE UPDATE ON work_request_transitions
        BEGIN
          SELECT RAISE(ABORT, 'work_request_transitions is read-only');
        END;
        CREATE TRIGGER trg_work_request_transitions_delete BEFORE DELETE ON work_request_transitions
        BEGIN
          SELECT RAISE(ABORT, 'work_request_transitions is read-only');
        END;

        -- Engine events are never deleted one by one. Aggregate cleanup
        -- (deleteEngineRecords) first marks the requests it removes in
        -- engine_event_purges; only events of a marked request may go.
        CREATE TABLE engine_event_purges (
          request_id TEXT PRIMARY KEY
        );
        CREATE TRIGGER trg_engine_events_no_delete BEFORE DELETE ON engine_events
        BEGIN
          SELECT RAISE(ABORT, 'engine_events are append-only')
            WHERE NOT EXISTS (SELECT 1 FROM engine_event_purges WHERE request_id = OLD.request_id);
        END;

        -- Foreign keys (parent-key update side): RESTRICT.
        CREATE TRIGGER trg_conversations_engine_restrict_update BEFORE UPDATE OF id ON conversations
        WHEN NEW.id IS NOT OLD.id
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.source_conversation_id')
            WHERE EXISTS (SELECT 1 FROM work_requests WHERE source_conversation_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.conversation_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE conversation_id = OLD.id);
        END;

        CREATE TRIGGER trg_bots_engine_restrict_update BEFORE UPDATE OF id ON bots
        WHEN NEW.id IS NOT OLD.id
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: work_requests.target_agent_id')
            WHERE EXISTS (SELECT 1 FROM work_requests WHERE target_agent_id = OLD.id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: session_bindings.agent_id')
            WHERE EXISTS (SELECT 1 FROM session_bindings WHERE agent_id = OLD.id);
        END;

        -- Attempt kind and continuity agree: only a resume names a binding.
        -- (Fresh schemas also carry this as a CHECK.)
        CREATE TRIGGER trg_work_attempts_kind BEFORE INSERT ON work_attempts
        WHEN (NEW.kind = 'resume') <> (NEW.resumed_session_binding_id IS NOT NULL)
        BEGIN
          SELECT RAISE(ABORT, 'work_attempts kind does not match resumed_session_binding_id');
        END;
      `);
    },
  },
  {
    version: 4,
    name: 'engine_event_purge_authority',
    up: db => {
      db.exec(`
        -- Purge authority no longer lives in data: any writer could insert
        -- an engine_event_purges row and then delete single events. The
        -- guard now asks engine_event_purge_authorized(), a connection
        -- function that is true only while deleteEngineRecords removes that
        -- request whole. Connections without it cannot delete events.
        DROP TRIGGER trg_engine_events_no_delete;
        DROP TABLE engine_event_purges;
        CREATE TRIGGER trg_engine_events_no_delete BEFORE DELETE ON engine_events
        BEGIN
          SELECT RAISE(ABORT, 'engine_events are append-only')
            WHERE NOT engine_event_purge_authorized(OLD.request_id);
        END;
      `);
    },
  },
  {
    version: 5,
    name: 'conversation_intakes',
    up: db => {
      db.exec(`
        -- NOT-465: one row per accepted conversation message, keyed by the
        -- requester's idempotency key. It names the source event (message)
        -- and the Work Requests created from it, so an exact retry replays
        -- the original identifiers whether or not any request was created.
        CREATE TABLE conversation_intakes (
          requester_kind TEXT NOT NULL CHECK (requester_kind IN ('person', 'bot', 'service')),
          requester_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
          request_hash TEXT NOT NULL,
          surface TEXT NOT NULL CHECK (surface IN ('ui', 'api')),
          conversation_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          work_request_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (requester_kind, requester_id, idempotency_key)
        );
        CREATE INDEX idx_conversation_intakes_conversation ON conversation_intakes(conversation_id);
      `);
    },
  },
  {
    version: 6,
    name: 'attempt_output',
    up: db => {
      db.exec(`
        -- NOT-467: the runtime output an Attempt returned, recorded with
        -- its terminal outcome (null while open or when none was returned).
        ALTER TABLE work_attempts ADD COLUMN output TEXT;
      `);
    },
  },
  {
    version: 7,
    name: 'wakes',
    up: db => {
      db.exec(`
        -- NOT-466: one row per Wake found in an Agent reply (lib/wake-router).
        -- Every Wake is kept, including ones whose target is missing or
        -- whose envelope is invalid, so nothing is silently dropped. An
        -- accepted or blocked Wake names its one Work Request. Lineage is
        -- durable: parent/root request and root Wake, never process memory.
        CREATE TABLE wakes (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
          source_conversation_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          syntax TEXT NOT NULL CHECK (syntax IN ('structured', 'legacy')),
          payload TEXT NOT NULL,
          requester_agent_id TEXT NOT NULL,
          requested_target TEXT,
          target_agent_id TEXT,
          target_name_snapshot TEXT,
          execution_kind TEXT CHECK (execution_kind IN ('conversation', 'implementation', 'review', 'revision')),
          parent_request_id TEXT,
          root_request_id TEXT,
          root_wake_id TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK (depth >= 0),
          status TEXT NOT NULL CHECK (status IN ('accepted', 'blocked', 'unavailable', 'rejected')),
          reason_code TEXT,
          reason TEXT,
          work_request_id TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (source_event_id, position),
          CHECK ((status IN ('accepted', 'blocked')) = (work_request_id IS NOT NULL)),
          CHECK (status = 'accepted' OR reason_code IS NOT NULL),
          FOREIGN KEY (source_conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (work_request_id) REFERENCES work_requests(id),
          FOREIGN KEY (parent_request_id) REFERENCES work_requests(id)
        );
        CREATE INDEX idx_wakes_conversation ON wakes(source_conversation_id, created_at);
        CREATE INDEX idx_wakes_status ON wakes(status, created_at);

        CREATE TRIGGER trg_wakes_fk BEFORE INSERT ON wakes
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: wakes.source_conversation_id')
            WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE id = NEW.source_conversation_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: wakes.parent_request_id')
            WHERE NEW.parent_request_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.parent_request_id);
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: wakes.work_request_id')
            WHERE NEW.work_request_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.work_request_id);
        END;

        -- Source, payload, and lineage are fixed when the Wake is recorded.
        CREATE TRIGGER trg_wakes_immutable BEFORE UPDATE OF
          id, idempotency_key, source_conversation_id, source_event_id, position, syntax, payload,
          requester_agent_id, requested_target, execution_kind, parent_request_id,
          root_wake_id, depth, created_at
        ON wakes
        BEGIN
          SELECT RAISE(ABORT, 'wakes source, payload, and lineage are immutable');
        END;

        -- Recovery only moves forward: an unavailable target may resolve
        -- or turn out unroutable (rejected), a blocked request may become
        -- accepted. The resolved target, Work
        -- Request, and root request (for a Wake without a parent, its own
        -- request) are set once.
        CREATE TRIGGER trg_wakes_recovery BEFORE UPDATE ON wakes
        BEGIN
          SELECT RAISE(ABORT, 'invalid wakes status change')
            WHERE NEW.status <> OLD.status
              AND (OLD.status || '>' || NEW.status) NOT IN ('unavailable>accepted', 'unavailable>blocked', 'unavailable>rejected', 'blocked>accepted');
          SELECT RAISE(ABORT, 'wakes target and work request are set once')
            WHERE (OLD.target_agent_id IS NOT NULL AND NEW.target_agent_id IS NOT OLD.target_agent_id)
              OR (OLD.target_name_snapshot IS NOT NULL AND NEW.target_name_snapshot IS NOT OLD.target_name_snapshot)
              OR (OLD.work_request_id IS NOT NULL AND NEW.work_request_id IS NOT OLD.work_request_id)
              OR (OLD.root_request_id IS NOT NULL AND NEW.root_request_id IS NOT OLD.root_request_id);
        END;
      `);
    },
  },
  {
    version: 8,
    name: 'conversation_events',
    up: db => {
      db.exec(`
        -- NOT-470: typed conversation projection of Wake and Work Request
        -- lifecycle events (lib/conversation-projection). One row per
        -- projected part of one engine event; the id is derived from the
        -- engine event id and part, so replay and redelivery never add a
        -- row. text is the human-facing line, data the machine-readable
        -- meaning. sort_at never decreases within a request, so ordering
        -- by (sort_at, request_created_at, request_id, request_sequence,
        -- part) keeps each request's own order while requests interleave.
        CREATE TABLE conversation_events (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          engine_event_id TEXT NOT NULL,
          part INTEGER NOT NULL CHECK (part >= 0),
          request_id TEXT NOT NULL,
          request_sequence INTEGER NOT NULL,
          attempt_id TEXT,
          wake_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN (
            'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
            'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
            'question', 'result', 'artifact'
          )),
          state TEXT CHECK (state IN (${stateList})),
          text TEXT NOT NULL,
          data TEXT NOT NULL,
          sort_at INTEGER NOT NULL,
          request_created_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (engine_event_id, part),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (engine_event_id) REFERENCES engine_events(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        CREATE INDEX idx_conversation_events_order
          ON conversation_events(conversation_id, sort_at, request_created_at, request_id, request_sequence, part);
        CREATE INDEX idx_conversation_events_request ON conversation_events(request_id);

        -- Last engine event sequence the projector has read per request,
        -- including events that project to nothing.
        CREATE TABLE conversation_projection_cursors (
          request_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );

        CREATE TRIGGER trg_conversation_events_immutable BEFORE UPDATE ON conversation_events
        BEGIN
          SELECT RAISE(ABORT, 'conversation_events are immutable');
        END;
      `);
    },
  },
  {
    version: 9,
    name: 'terminal_followups',
    up: db => {
      db.exec(`
        -- NOT-472: one row per canonical request that became terminal on
        -- this schema, written in the same transaction as the terminal
        -- transition. lib/coordinator-loop runs the follow-up (Wake
        -- routing, coordinator continuation) and sets done_at; restart
        -- recovery only replays rows still open. Requests that ended
        -- before this migration get no row, so their replies are never
        -- routed retroactively.
        CREATE TABLE terminal_followups (
          request_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          done_at INTEGER,
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        CREATE INDEX idx_terminal_followups_open ON terminal_followups(created_at) WHERE done_at IS NULL;
      `);
    },
  },
  {
    version: 10,
    name: 'reviewed_git_finalization',
    up: db => {
      db.exec(`
        -- NOT-487: reviewed Git finalization through Agent Deck
        -- (docs/design/2026-10-13-git-finalization-contract.md). Rows hold
        -- only public Agent Deck identifiers, repository-relative paths,
        -- digests, and modes: never file contents, host paths, or the
        -- Agent Deck bearer.
        --
        -- Public baseline of a prepared edit Attempt, captured before model
        -- work. Set once.
        CREATE TABLE attempt_finalization_baselines (
          attempt_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          external_run_id TEXT NOT NULL,
          baseline_ref TEXT NOT NULL,
          baseline_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES work_attempts(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );

        -- The ordered candidate manifest Agent Deck reported once the
        -- prepared run was terminal: the immutable review evidence that a
        -- finalization submits unchanged.
        CREATE TABLE candidate_manifests (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          external_run_id TEXT NOT NULL,
          baseline_ref TEXT NOT NULL,
          baseline_digest TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          manifest_digest TEXT NOT NULL,
          files TEXT NOT NULL,
          file_count INTEGER NOT NULL CHECK (file_count >= 0),
          created_at INTEGER NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES work_attempts(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        -- One accepted finalization decision and its outcome. The request
        -- body is exactly what was (or will be) submitted; the idempotency
        -- key is derived from the explicit acceptance event, implementation
        -- Attempt, review, and manifest. Replay and restart submit the same
        -- request, while a later acceptance can retry a terminal non-commit.
        CREATE TABLE finalizations (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) > 0),
          conversation_id TEXT NOT NULL,
          decision_event_id TEXT NOT NULL,
          decision_request_id TEXT NOT NULL,
          coordinator_agent_id TEXT NOT NULL,
          implementation_request_id TEXT NOT NULL,
          implementation_attempt_id TEXT NOT NULL,
          review_request_id TEXT NOT NULL,
          review_attempt_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          external_run_id TEXT NOT NULL,
          request_body TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('preparing', 'committed', 'blocked', 'failed', 'canceled')),
          submitted_at INTEGER,
          reason_code TEXT,
          reason TEXT,
          commit_id TEXT,
          tree_id TEXT,
          parent_commit TEXT,
          result_manifest_digest TEXT,
          file_count INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          CHECK ((state = 'preparing') = (finished_at IS NULL)),
          CHECK (state <> 'committed' OR commit_id IS NOT NULL),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (implementation_request_id) REFERENCES work_requests(id),
          FOREIGN KEY (implementation_attempt_id) REFERENCES work_attempts(id),
          FOREIGN KEY (review_request_id) REFERENCES work_requests(id),
          FOREIGN KEY (manifest_id) REFERENCES candidate_manifests(id)
        );
        CREATE INDEX idx_finalizations_open ON finalizations(created_at) WHERE finished_at IS NULL;
        CREATE INDEX idx_finalizations_attempt ON finalizations(implementation_attempt_id);

        CREATE TRIGGER trg_attempt_finalization_baselines_fk BEFORE INSERT ON attempt_finalization_baselines
        BEGIN
          SELECT RAISE(ABORT, 'attempt finalization baseline does not match its Attempt')
            WHERE NOT EXISTS (
              SELECT 1 FROM work_attempts
              WHERE id = NEW.attempt_id AND request_id = NEW.request_id AND external_run_id = NEW.external_run_id
            );
        END;
        CREATE TRIGGER trg_attempt_finalization_baselines_immutable BEFORE UPDATE ON attempt_finalization_baselines
        BEGIN
          SELECT RAISE(ABORT, 'attempt_finalization_baselines are immutable');
        END;
        CREATE TRIGGER trg_candidate_manifests_fk BEFORE INSERT ON candidate_manifests
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: candidate_manifests.attempt_id')
            WHERE NOT EXISTS (
              SELECT 1 FROM work_attempts a
              JOIN work_requests r ON r.id = a.request_id
              JOIN attempt_finalization_baselines b ON b.attempt_id = a.id
              WHERE a.id = NEW.attempt_id AND a.request_id = NEW.request_id
                AND a.external_run_id = NEW.external_run_id
                AND r.source_conversation_id = NEW.conversation_id
                AND b.external_run_id = NEW.external_run_id
                AND b.baseline_ref = NEW.baseline_ref AND b.baseline_digest = NEW.baseline_digest
            );
        END;
        CREATE TRIGGER trg_candidate_manifests_immutable BEFORE UPDATE ON candidate_manifests
        BEGIN
          SELECT RAISE(ABORT, 'candidate_manifests are immutable');
        END;
        CREATE TRIGGER trg_finalizations_fk BEFORE INSERT ON finalizations
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: finalizations.manifest_id')
            WHERE NOT EXISTS (
              SELECT 1 FROM candidate_manifests m
              JOIN work_attempts ia ON ia.id = NEW.implementation_attempt_id
              JOIN work_attempts ra ON ra.id = NEW.review_attempt_id
              JOIN work_requests ir ON ir.id = NEW.implementation_request_id
              JOIN work_requests rr ON rr.id = NEW.review_request_id
              JOIN work_requests dr ON dr.id = NEW.decision_request_id
              WHERE m.id = NEW.manifest_id AND m.attempt_id = ia.id AND m.request_id = ir.id
                AND m.external_run_id = NEW.external_run_id
                AND ia.request_id = ir.id AND ra.request_id = rr.id
                AND ir.source_conversation_id = NEW.conversation_id
                AND rr.source_conversation_id = NEW.conversation_id
                AND dr.source_conversation_id = NEW.conversation_id
                AND dr.target_agent_id = NEW.coordinator_agent_id
            );
        END;
        CREATE TRIGGER trg_finalizations_immutable BEFORE UPDATE OF
          id, idempotency_key, conversation_id, decision_event_id, decision_request_id, coordinator_agent_id,
          implementation_request_id, implementation_attempt_id, review_request_id, review_attempt_id,
          manifest_id, external_run_id, request_body, request_hash, created_at
        ON finalizations
        BEGIN
          SELECT RAISE(ABORT, 'finalizations decision and request are immutable');
        END;
        CREATE TRIGGER trg_finalizations_terminal BEFORE UPDATE ON finalizations
        WHEN OLD.finished_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'finished finalizations are immutable');
        END;
        CREATE TRIGGER trg_finalizations_submitted BEFORE UPDATE OF submitted_at ON finalizations
        WHEN OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at
        BEGIN
          SELECT RAISE(ABORT, 'finalizations submitted_at is set once');
        END;

        -- Conversation projection gains the finalization lifecycle kinds.
        -- SQLite cannot widen a CHECK in place, so the table is rebuilt
        -- with every row kept.
        CREATE TABLE conversation_events_v10 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          engine_event_id TEXT NOT NULL,
          part INTEGER NOT NULL CHECK (part >= 0),
          request_id TEXT NOT NULL,
          request_sequence INTEGER NOT NULL,
          attempt_id TEXT,
          wake_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN (
            'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
            'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
            'question', 'result', 'artifact',
            'finalization_preparing', 'finalization_committed', 'finalization_blocked',
            'finalization_failed', 'finalization_canceled', 'finalization_rejected'
          )),
          state TEXT CHECK (state IN (${stateList})),
          text TEXT NOT NULL,
          data TEXT NOT NULL,
          sort_at INTEGER NOT NULL,
          request_created_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (engine_event_id, part),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (engine_event_id) REFERENCES engine_events(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        INSERT INTO conversation_events_v10 SELECT
          id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id,
          kind, state, text, data, sort_at, request_created_at, created_at
        FROM conversation_events;
        DROP TABLE conversation_events;
        ALTER TABLE conversation_events_v10 RENAME TO conversation_events;
        CREATE INDEX idx_conversation_events_order
          ON conversation_events(conversation_id, sort_at, request_created_at, request_id, request_sequence, part);
        CREATE INDEX idx_conversation_events_request ON conversation_events(request_id);
        CREATE TRIGGER trg_conversation_events_immutable BEFORE UPDATE ON conversation_events
        BEGIN
          SELECT RAISE(ABORT, 'conversation_events are immutable');
        END;
      `);
    },
  },
  {
    version: 11,
    name: 'leased_dispatch',
    up: db => {
      db.exec(`
        -- NOT-469: leased dispatcher (lib/dispatcher). One row per request a
        -- worker owns. The token is a fencing value: heartbeat, release, and
        -- every fenced commit match it, so a worker whose lease was taken
        -- over can no longer write. An expired row is not free: its run may
        -- still be live, so it counts toward concurrency until a worker
        -- takes it over and reconciles it.
        CREATE TABLE dispatch_leases (
          request_id TEXT PRIMARY KEY,
          target_agent_id TEXT NOT NULL,
          owner TEXT NOT NULL CHECK (length(owner) > 0),
          token TEXT NOT NULL UNIQUE CHECK (length(token) > 0),
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        CREATE INDEX idx_dispatch_leases_target ON dispatch_leases(target_agent_id);
        CREATE INDEX idx_dispatch_leases_expiry ON dispatch_leases(expires_at);

        -- Launch intent, written with the Attempt before any adapter call:
        -- the exact start body (or null for a transport without external
        -- runs), its idempotency key, and a non-secret fingerprint of the
        -- launching grant. Reconciliation re-POSTs only this body, under
        -- this key, with this grant (NOT-468 decision table A).
        CREATE TABLE attempt_launch_intents (
          attempt_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          transport TEXT NOT NULL CHECK (length(transport) > 0),
          idempotency_key TEXT,
          body TEXT,
          body_hash TEXT,
          grant_fingerprint TEXT,
          owner TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          CHECK ((body IS NULL) = (body_hash IS NULL)),
          CHECK (body IS NULL OR idempotency_key IS NOT NULL),
          FOREIGN KEY (attempt_id) REFERENCES work_attempts(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        CREATE TRIGGER trg_attempt_launch_intents_fk BEFORE INSERT ON attempt_launch_intents
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: attempt_launch_intents.attempt_id')
            WHERE NOT EXISTS (SELECT 1 FROM work_attempts WHERE id = NEW.attempt_id AND request_id = NEW.request_id);
        END;
        CREATE TRIGGER trg_attempt_launch_intents_immutable BEFORE UPDATE ON attempt_launch_intents
        BEGIN
          SELECT RAISE(ABORT, 'attempt_launch_intents are immutable');
        END;

        -- Operator-attention flag, separate from the Attempt lifecycle. While
        -- one is open for a request the dispatcher makes no automatic
        -- launch, re-POST, retry, or resume for it. Only an operator clears
        -- it (cleared_at).
        CREATE TABLE dispatch_attention (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          attempt_id TEXT,
          reason TEXT NOT NULL CHECK (length(reason) > 0),
          detail TEXT,
          created_at INTEGER NOT NULL,
          cleared_at INTEGER,
          FOREIGN KEY (request_id) REFERENCES work_requests(id),
          FOREIGN KEY (attempt_id) REFERENCES work_attempts(id)
        );
        CREATE UNIQUE INDEX idx_dispatch_attention_open ON dispatch_attention(request_id) WHERE cleared_at IS NULL;
      `);
    },
  },
  {
    version: 12,
    name: 'request_control',
    up: db => {
      db.exec(`
        -- NOT-473: cancellation, deadlines, and bounded retries
        -- (lib/work-request-control, lib/request-policy). The deadline and
        -- retry policy are fixed at intake; null on older rows means no
        -- deadline and one Attempt. attempt_count counts claimed Attempts
        -- and never decreases; a queued retry is not claimable before
        -- next_eligible_at. The cancellation intent is recorded once.
        ALTER TABLE work_requests ADD COLUMN deadline_at INTEGER;
        ALTER TABLE work_requests ADD COLUMN retry_policy TEXT;
        ALTER TABLE work_requests ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
        ALTER TABLE work_requests ADD COLUMN next_eligible_at INTEGER;
        ALTER TABLE work_requests ADD COLUMN cancel_requested_at INTEGER;
        ALTER TABLE work_requests ADD COLUMN cancel_requested_by TEXT;
        ALTER TABLE work_requests ADD COLUMN cancel_reason TEXT;
        CREATE INDEX idx_work_requests_deadline ON work_requests(deadline_at) WHERE deadline_at IS NOT NULL;

        CREATE TRIGGER trg_work_requests_control_immutable BEFORE UPDATE OF deadline_at, retry_policy ON work_requests
        WHEN NEW.deadline_at IS NOT OLD.deadline_at OR NEW.retry_policy IS NOT OLD.retry_policy
        BEGIN
          SELECT RAISE(ABORT, 'work_requests deadline and retry policy are immutable');
        END;
        CREATE TRIGGER trg_work_requests_attempt_count BEFORE UPDATE OF attempt_count ON work_requests
        WHEN NEW.attempt_count < OLD.attempt_count
        BEGIN
          SELECT RAISE(ABORT, 'work_requests attempt_count never decreases');
        END;
        CREATE TRIGGER trg_work_requests_cancel_once BEFORE UPDATE OF cancel_requested_at, cancel_requested_by, cancel_reason ON work_requests
        WHEN OLD.cancel_requested_at IS NOT NULL AND (
          NEW.cancel_requested_at IS NOT OLD.cancel_requested_at
          OR NEW.cancel_requested_by IS NOT OLD.cancel_requested_by
          OR NEW.cancel_reason IS NOT OLD.cancel_reason
        )
        BEGIN
          SELECT RAISE(ABORT, 'work_requests cancellation intent is recorded once');
        END;

        -- Conversation projection gains the cancellation, timeout, and
        -- retry kinds (rebuilt with every row kept, as in version 10).
        CREATE TABLE conversation_events_v12 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          engine_event_id TEXT NOT NULL,
          part INTEGER NOT NULL CHECK (part >= 0),
          request_id TEXT NOT NULL,
          request_sequence INTEGER NOT NULL,
          attempt_id TEXT,
          wake_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN (
            'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
            'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
            'question', 'result', 'artifact',
            'finalization_preparing', 'finalization_committed', 'finalization_blocked',
            'finalization_failed', 'finalization_canceled', 'finalization_rejected',
            'request_cancel_requested', 'request_timed_out', 'request_retry_scheduled', 'request_retries_exhausted'
          )),
          state TEXT CHECK (state IN (${stateList})),
          text TEXT NOT NULL,
          data TEXT NOT NULL,
          sort_at INTEGER NOT NULL,
          request_created_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (engine_event_id, part),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (engine_event_id) REFERENCES engine_events(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        INSERT INTO conversation_events_v12 SELECT
          id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id,
          kind, state, text, data, sort_at, request_created_at, created_at
        FROM conversation_events;
        DROP TABLE conversation_events;
        ALTER TABLE conversation_events_v12 RENAME TO conversation_events;
        CREATE INDEX idx_conversation_events_order
          ON conversation_events(conversation_id, sort_at, request_created_at, request_id, request_sequence, part);
        CREATE INDEX idx_conversation_events_request ON conversation_events(request_id);
        CREATE TRIGGER trg_conversation_events_immutable BEFORE UPDATE ON conversation_events
        BEGIN
          SELECT RAISE(ABORT, 'conversation_events are immutable');
        END;
      `);
    },
  },
  {
    version: 13,
    name: 'wake_safety',
    up: db => {
      db.exec(`
        -- NOT-475: Wake safety (docs/design/2026-10-14-wake-safety-contract.md,
        -- lib/wake-safety). Lineage columns: wake_depth counts Agent-to-Agent
        -- hops from the root (a continuation runs at the depth of the Agent it
        -- continues) and the root principal is whoever started the lineage.
        -- Both are fixed at intake.
        ALTER TABLE work_requests ADD COLUMN wake_depth INTEGER NOT NULL DEFAULT 0 CHECK (wake_depth >= 0);
        ALTER TABLE work_requests ADD COLUMN root_principal_kind TEXT;
        ALTER TABLE work_requests ADD COLUMN root_principal_id TEXT;

        -- Owner-approved edit grants for one (caller Agent, target Agent)
        -- pair. Never seeded; revoked once, never rewritten or reused.
        CREATE TABLE wake_grants (
          id TEXT PRIMARY KEY,
          caller_agent_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          authority TEXT NOT NULL CHECK (authority = 'edit'),
          granted_by_kind TEXT NOT NULL,
          granted_by_id TEXT NOT NULL,
          source_wake_id TEXT,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER,
          revoked_by_kind TEXT,
          revoked_by_id TEXT,
          CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL) AND (revoked_at IS NULL) = (revoked_by_id IS NULL))
        );
        CREATE UNIQUE INDEX idx_wake_grants_active ON wake_grants(caller_agent_id, target_agent_id, authority) WHERE revoked_at IS NULL;
        CREATE TRIGGER trg_wake_grants_immutable BEFORE UPDATE ON wake_grants
        BEGIN
          SELECT RAISE(ABORT, 'wake_grants are immutable except for one revocation')
            WHERE OLD.revoked_at IS NOT NULL
              OR NEW.id IS NOT OLD.id OR NEW.caller_agent_id IS NOT OLD.caller_agent_id
              OR NEW.target_agent_id IS NOT OLD.target_agent_id OR NEW.authority IS NOT OLD.authority
              OR NEW.granted_by_kind IS NOT OLD.granted_by_kind OR NEW.granted_by_id IS NOT OLD.granted_by_id
              OR NEW.source_wake_id IS NOT OLD.source_wake_id OR NEW.created_at IS NOT OLD.created_at;
        END;

        -- One append-only row per safety evaluation of a Work Request: the
        -- categorized caller principal, target, decision, matched grant rule
        -- and grant, and the policy snapshot used. A request is runnable
        -- only while its latest decision is allowed (lib/dispatcher). A
        -- later policy change (a revoked grant, new limits) adds rows for
        -- later evaluations and never rewrites these.
        CREATE TABLE wake_safety_decisions (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          wake_id TEXT,
          principal_type TEXT NOT NULL CHECK (principal_type IN ('human_owner', 'api_principal', 'agent_principal', 'engine')),
          principal_kind TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          execution_kind TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked', 'denied')),
          reason_code TEXT,
          grant_rule TEXT,
          grant_id TEXT,
          policy_snapshot TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (request_id, sequence),
          CHECK (decision <> 'allowed' OR grant_rule IS NOT NULL),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        CREATE TRIGGER trg_wake_safety_decisions_fk BEFORE INSERT ON wake_safety_decisions
        BEGIN
          SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: wake_safety_decisions.request_id')
            WHERE NOT EXISTS (SELECT 1 FROM work_requests WHERE id = NEW.request_id);
        END;
        CREATE TRIGGER trg_wake_safety_decisions_immutable BEFORE UPDATE ON wake_safety_decisions
        BEGIN
          SELECT RAISE(ABORT, 'wake_safety_decisions are append-only');
        END;

        -- Depth and root-budget refusals name the limit and what was seen.
        ALTER TABLE wakes ADD COLUMN limit_value INTEGER;
        ALTER TABLE wakes ADD COLUMN observed_value INTEGER;

        -- Rejected Wakes project from the Wake row (no Work Request, no
        -- engine event), and a stopped lineage projects as its own kind.
        CREATE TABLE conversation_events_v13 (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          engine_event_id TEXT,
          part INTEGER NOT NULL CHECK (part >= 0),
          request_id TEXT,
          request_sequence INTEGER NOT NULL,
          attempt_id TEXT,
          wake_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN (
            'wake_accepted', 'wake_blocked', 'request_queued', 'request_blocked', 'request_running',
            'request_waiting', 'request_completed', 'request_failed', 'request_cancelled',
            'question', 'result', 'artifact',
            'finalization_preparing', 'finalization_committed', 'finalization_blocked',
            'finalization_failed', 'finalization_canceled', 'finalization_rejected',
            'request_cancel_requested', 'request_timed_out', 'request_retry_scheduled', 'request_retries_exhausted',
            'wake_rejected', 'lineage_stopped'
          )),
          state TEXT CHECK (state IN (${stateList})),
          text TEXT NOT NULL,
          data TEXT NOT NULL,
          sort_at INTEGER NOT NULL,
          request_created_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (engine_event_id, part),
          CHECK ((engine_event_id IS NULL) = (request_id IS NULL)),
          CHECK (request_id IS NOT NULL OR wake_id IS NOT NULL),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id),
          FOREIGN KEY (engine_event_id) REFERENCES engine_events(id),
          FOREIGN KEY (request_id) REFERENCES work_requests(id)
        );
        INSERT INTO conversation_events_v13 SELECT
          id, conversation_id, engine_event_id, part, request_id, request_sequence, attempt_id, wake_id,
          kind, state, text, data, sort_at, request_created_at, created_at
        FROM conversation_events;
        DROP TABLE conversation_events;
        ALTER TABLE conversation_events_v13 RENAME TO conversation_events;
        CREATE INDEX idx_conversation_events_order
          ON conversation_events(conversation_id, sort_at, request_created_at, request_id, request_sequence, part);
        CREATE INDEX idx_conversation_events_request ON conversation_events(request_id);
        CREATE INDEX idx_conversation_events_wake ON conversation_events(wake_id);
        CREATE TRIGGER trg_conversation_events_immutable BEFORE UPDATE ON conversation_events
        BEGIN
          SELECT RAISE(ABORT, 'conversation_events are immutable');
        END;
      `);
      backfillWakeSafety(db);
      db.exec(`
        CREATE TRIGGER trg_work_requests_safety_immutable BEFORE UPDATE OF wake_depth, root_principal_kind, root_principal_id ON work_requests
        WHEN NEW.wake_depth IS NOT OLD.wake_depth
          OR NEW.root_principal_kind IS NOT OLD.root_principal_kind
          OR NEW.root_principal_id IS NOT OLD.root_principal_id
        BEGIN
          SELECT RAISE(ABORT, 'work_requests wake depth and root principal are immutable');
        END;
      `);
    },
  },
  {
    version: 14,
    name: 'retire_legacy_agent_requests',
    up: db => {
      archiveLegacyAgentRequests(db);
    },
  },
  {
    // NOT-477: UI thread turns are Work Requests (executor), delegation
    // accounting is durable (delegation_chains), and the processing_queue
    // lifecycle is reconciled into work_requests and archived
    // (retireProcessingQueue).
    version: 15,
    name: 'ui_turns_on_work_requests',
    up: db => {
      db.exec(`
        ALTER TABLE work_requests ADD COLUMN executor TEXT NOT NULL DEFAULT 'dispatcher'
          CHECK (executor IN ('dispatcher', 'ui_message', 'ui_continuation'));
        CREATE INDEX idx_work_requests_executor ON work_requests(executor, state, created_at);

        -- Delegation accounting for one user message in one UI thread:
        -- handoffs (depth), delegated turns (budget), Stop, and the
        -- caller frames a delegate's reply returns to. One row per
        -- (conversation, user message); a later user message starts a
        -- fresh row.
        CREATE TABLE delegation_chains (
          conversation_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL,
          handoffs INTEGER NOT NULL DEFAULT 0 CHECK (handoffs >= 0),
          turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
          stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
          frames TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, user_message_id),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
      `);
      retireProcessingQueue(db);
    },
  },
];

// Migration 13 backfill (contract, Migration). Lineage: an intake root is
// depth 0, a Wake-created request its parent turn's depth + 1, a
// continuation the depth of the Agent it continues (for a result, the
// Wake's requester: one hop above the specialist). The root principal is
// the root request's requester. A row whose root cannot be resolved gets
// depth 0 and root principal unknown, which disables the self-wake
// exemption for it. No grants are seeded. Requests already runnable
// (queued, running, waiting) keep running under their frozen snapshot and
// get one allowed decision with rule pre_safety_migration; blocked ones get
// none, so their recovery goes through the new checks.
function backfillWakeSafety(db: Db): void {
  type Row = Pick<WorkRequest, 'id' | 'parent_request_id' | 'root_request_id' | 'wake_event_id' | 'requester_kind' | 'requester_id'
    | 'policy_snapshot' | 'state' | 'target_agent_id' | 'execution_kind' | 'legacy_agent_request_id' | 'created_at'>;
  const rows = db.prepare(`
    SELECT id, parent_request_id, root_request_id, wake_event_id, requester_kind, requester_id, policy_snapshot, state,
      target_agent_id, execution_kind, legacy_agent_request_id, created_at
    FROM work_requests ORDER BY created_at ASC, rowid ASC
  `).all() as Row[];
  const byId = new Map(rows.map(row => [row.id, row]));
  const policyOf = (row: Row): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(row.policy_snapshot) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  // A lineage resolves only when its whole parent chain exists, has no
  // cycle, stays within the declared root, and ends at that root.
  const resolvedChains = new Map<string, boolean>();
  const chainResolves = (row: Row): boolean => {
    const known = resolvedChains.get(row.id);
    if (known !== undefined) return known;
    const chain: Row[] = [];
    const seen = new Set<string>();
    let node: Row | undefined = row;
    let ok = false;
    while (node) {
      if (seen.has(node.id) || node.root_request_id !== row.root_request_id) break;
      const cached = resolvedChains.get(node.id);
      if (cached !== undefined) { ok = cached; break; }
      seen.add(node.id);
      chain.push(node);
      if (node.parent_request_id === null) { ok = node.id === row.root_request_id; break; }
      node = byId.get(node.parent_request_id);
    }
    for (const member of chain) resolvedChains.set(member.id, ok);
    return ok;
  };
  const depths = new Map<string, number>();
  // Only called for resolved rows, whose chains are finite and acyclic.
  const depthOf = (row: Row): number => {
    const known = depths.get(row.id);
    if (known !== undefined) return known;
    let depth = 0;
    const parent = row.parent_request_id ? byId.get(row.parent_request_id) : undefined;
    if (parent) {
      const parentDepth = depthOf(parent);
      const policy = policyOf(row);
      if (row.wake_event_id) depth = parentDepth + 1;
      else if (policy.source === 'coordinator_continuation' && policy.continues === 'result') depth = Math.max(parentDepth - 1, 0);
      else depth = parentDepth;
    }
    depths.set(row.id, depth);
    return depth;
  };
  const update = db.prepare('UPDATE work_requests SET wake_depth = ?, root_principal_kind = ?, root_principal_id = ? WHERE id = ?');
  const insertDecision = db.prepare(`
    INSERT INTO wake_safety_decisions (
      id, request_id, sequence, wake_id, principal_type, principal_kind, principal_id, target_agent_id, execution_kind,
      decision, reason_code, grant_rule, grant_id, policy_snapshot, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'allowed', NULL, 'pre_safety_migration', NULL, ?, ?)
  `);
  // Terminal rows are immutable; their lineage columns are filled while
  // the guard is lifted, then it is restored unchanged.
  db.exec('DROP TRIGGER trg_work_requests_terminal');
  for (const row of rows) {
    const root = byId.get(row.root_request_id);
    const resolved = !!root && chainResolves(row);
    const depth = resolved ? depthOf(row) : 0;
    const principal = resolved && root ? { kind: root.requester_kind, id: root.requester_id } : { kind: 'unknown', id: 'unknown' };
    update.run(depth, principal.kind, principal.id, row.id);
    if (row.legacy_agent_request_id === null && ['queued', 'running', 'waiting'].includes(row.state)) {
      const policy = policyOf(row);
      const principalType = policy.source === 'wake' ? 'agent_principal'
        : policy.source === 'coordinator_continuation' ? 'engine'
          : policy.surface === 'api' ? 'api_principal' : 'human_owner';
      insertDecision.run(
        randomUUID(), row.id, row.wake_event_id, principalType, row.requester_kind, row.requester_id, row.target_agent_id, row.execution_kind,
        JSON.stringify({ safety_version: 1, migrated: true, root_principal: principal, wake_depth: depth, grant_rule: 'pre_safety_migration' }),
        row.created_at
      );
    }
  }
  db.exec(`
    CREATE TRIGGER trg_work_requests_terminal BEFORE UPDATE ON work_requests
    WHEN OLD.state IN (${terminalList})
    BEGIN
      SELECT RAISE(ABORT, 'terminal work_requests are immutable');
    END;
  `);
}

// Requests whose events the running aggregate cleanup may delete, per
// connection. Module-private: only deleteEngineRecords fills it, and it is
// emptied before that function returns or throws.
const purgeAuthority = new WeakMap<Db, Set<string>>();

function purgeSet(db: Db): Set<string> {
  let set = purgeAuthority.get(db);
  if (!set) {
    set = new Set();
    purgeAuthority.set(db, set);
    const authorized = set;
    db.function('engine_event_purge_authorized', { deterministic: false }, (requestId: unknown) =>
      typeof requestId === 'string' && authorized.has(requestId) ? 1 : 0
    );
  }
  return set;
}

export const ENGINE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Applies pending versioned migrations. Safe to call on every open and
// from concurrent processes: each step runs in an IMMEDIATE transaction
// and rechecks its version. `through` stops after that version; migration
// tests use it to build a database as an older release left it.
export function migrateEngineSchema(db: Db, options: { through?: number } = {}): void {
  purgeSet(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (options.through !== undefined && migration.version > options.through) return;
    db.transaction(() => {
      if (applied.get(migration.version)) return;
      migration.up(db);
      record.run(migration.version, migration.name, Date.now());
    }).immediate();
  }
}

interface LegacyAgentRequestRow {
  id: string;
  principal_kind: string;
  principal_id: string;
  operation: string;
  idempotency_key: string;
  payload_hash: string;
  conversation_id: string;
  target_bot_id: string;
  accepted_message_id: string;
  runtime: string | null;
  state: string;
  reply_message_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
  content: string;
}

// Intake identity of a Work Request: the fields a caller supplies. A
// repeat of the same (requester, idempotency key) must carry the same
// hash to replay. Backfilled rows use the same function, so replaying a
// legacy request through create-or-get returns the backfilled row.
export function workRequestHash(fields: {
  sourceConversationId: string;
  sourceEventId: string;
  targetAgentId: string;
  intent: string;
  executionKind: ExecutionKind;
  toolProfile: ToolProfile;
  parentRequestId?: string | null;
  wakeEventId?: string | null;
  policy?: Record<string, unknown> | null;
}): string {
  return sha256(JSON.stringify([
    fields.sourceConversationId,
    fields.sourceEventId,
    fields.targetAgentId,
    fields.intent,
    fields.executionKind,
    fields.toolProfile,
    fields.parentRequestId ?? null,
    fields.wakeEventId ?? null,
    fields.policy ?? null,
  ]));
}

// NOT-477: retires the pre-NOT-465 agent_requests lifecycle. No code has
// written it since NOT-465 and no dispatcher advances it, so its rows are
// final. Every row that maps without guessing is copied into work_requests
// (an existing source conversation, accepted message, and target agent,
// and a principal kind the engine knows):
// - completed and failed rows keep their state, result, and error;
// - accepted and dispatched rows, which can never finish, become failed
//   with legacy_interrupted and their original state in the snapshot.
// Legacy request events are copied in their original order, followed by
// the interruption (if any) and a 'backfilled' event. No Attempt is
// synthesized: legacy rows recorded no launch snapshot. Idempotent via
// legacy_agent_request_id (an older release backfilled terminal rows on
// every open).
//
// Collision policy: legacy keys are unique per operation, canonical keys
// per requester only. Rows are visited oldest first (created_at, rowid);
// the first row to claim a (requester, idempotency key) is copied and any
// later row with the same identity, from another operation or already
// held by a canonical request, is kept in the archive only. The request
// hash is the canonical intake hash of the mapped fields (conversation
// execution, readonly profile, no caller policy), not the legacy payload
// hash; the legacy operation and runtime are kept in the policy snapshot.
//
// A copied send_message row also gets the conversation_intakes row the
// /api/v0 intake replays from, when its stored payload hash verifies the
// reconstructed fingerprint, so an exact retry of a pre-NOT-465 key still
// replays and a different payload still conflicts.
//
// Finally the tables are renamed to legacy_agent_requests_archive and
// legacy_agent_request_events_archive: every original row is kept
// verbatim, and nothing in the engine reads or writes them. Runs inside
// migration 14's transaction. Returns the number of copied requests.
export function archiveLegacyAgentRequests(db: Db): number {
  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!tableExists('agent_requests')) return 0;
  const hasEvents = tableExists('agent_request_events');
  const rows = db.prepare(`
    SELECT r.*, m.content AS content FROM agent_requests r
    JOIN conversations c ON c.id = r.conversation_id
    JOIN bots b ON b.id = r.target_bot_id
    JOIN messages m ON m.id = r.accepted_message_id AND m.conversation_id = r.conversation_id
    WHERE r.state IN ('completed', 'failed', 'accepted', 'dispatched')
      AND r.principal_kind IN ('person', 'bot', 'service')
      AND NOT EXISTS (SELECT 1 FROM work_requests w WHERE w.legacy_agent_request_id = r.id)
    ORDER BY r.created_at ASC, r.rowid ASC
  `).all() as LegacyAgentRequestRow[];
  const claimed = db.prepare(
    'SELECT 1 FROM work_requests WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?'
  );
  const legacyEvents = hasEvents
    ? db.prepare('SELECT type, data, created_at FROM agent_request_events WHERE request_id = ? ORDER BY created_at ASC, rowid ASC')
    : null;
  const insert = db.prepare(`
    INSERT INTO work_requests (
      id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
      intent, execution_kind, tool_profile, parent_request_id, root_request_id, wake_event_id, depth,
      idempotency_key, request_hash, policy_snapshot, state, state_reason, result, error_code, error_message,
      version, legacy_agent_request_id, created_at, updated_at, terminal_at, root_principal_kind, root_principal_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', 'readonly', NULL, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(
    'INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  );
  const now = Date.now();
  let copied = 0;
  for (const row of rows) {
    if (claimed.get(row.principal_kind, row.principal_id, row.idempotency_key)) continue;
    const id = randomUUID();
    const hash = workRequestHash({
      sourceConversationId: row.conversation_id,
      sourceEventId: row.accepted_message_id,
      targetAgentId: row.target_bot_id,
      intent: row.content,
      executionKind: 'conversation',
      toolProfile: 'readonly',
    });
    const interrupted = row.state === 'accepted' || row.state === 'dispatched';
    // Legacy agent API turns ran as conversation turns with the
    // read-only tool profile (docs/core-engine.md, Current code).
    const policy = JSON.stringify({
      tool_profile: 'readonly',
      source: 'legacy_agent_requests',
      legacy_operation: row.operation,
      legacy_runtime: row.runtime,
      ...(interrupted ? { legacy_state: row.state } : {}),
    });
    const terminalAt = interrupted ? Math.max(now, row.updated_at) : row.updated_at;
    insert.run(
      id, row.conversation_id, row.accepted_message_id, row.principal_kind, row.principal_id, row.target_bot_id,
      row.content, id,
      row.idempotency_key, hash, policy,
      interrupted ? 'failed' : row.state,
      interrupted ? LEGACY_INTERRUPTED : null,
      row.state === 'completed' ? JSON.stringify({ reply_message_id: row.reply_message_id }) : null,
      interrupted ? LEGACY_INTERRUPTED : row.state === 'failed' ? row.failure_code : null,
      interrupted ? LEGACY_INTERRUPTED_MESSAGE : row.state === 'failed' ? row.failure_message : null,
      row.id, row.created_at, terminalAt, terminalAt, row.principal_kind, row.principal_id
    );
    let sequence = 0;
    for (const event of (legacyEvents?.all(row.id) ?? []) as { type: string; data: string | null; created_at: number }[]) {
      insertEvent.run(randomUUID(), id, ++sequence, event.type, event.data, event.created_at);
    }
    if (interrupted) {
      insertEvent.run(
        randomUUID(), id, ++sequence, 'state_changed',
        JSON.stringify({ from: row.state === 'accepted' ? 'queued' : 'running', to: 'failed', reason: LEGACY_INTERRUPTED }), terminalAt
      );
    }
    insertEvent.run(
      randomUUID(), id, ++sequence, 'backfilled',
      JSON.stringify({ legacy_agent_request_id: row.id }), terminalAt
    );
    copied++;
  }
  seedLegacyIntakes(db);
  if (tableExists('legacy_agent_requests_archive')) {
    db.exec('INSERT INTO legacy_agent_requests_archive SELECT * FROM agent_requests; DROP TABLE agent_requests;');
  } else {
    db.exec('ALTER TABLE agent_requests RENAME TO legacy_agent_requests_archive');
  }
  if (hasEvents) {
    if (tableExists('legacy_agent_request_events_archive')) {
      db.exec('INSERT INTO legacy_agent_request_events_archive SELECT * FROM agent_request_events; DROP TABLE agent_request_events;');
    } else {
      db.exec('ALTER TABLE agent_request_events RENAME TO legacy_agent_request_events_archive');
    }
  }
  return copied;
}

export const LEGACY_INTERRUPTED = 'legacy_interrupted';
const LEGACY_INTERRUPTED_MESSAGE = 'Accepted before NOT-465 by the retired agent_requests dispatcher; it never reached a terminal state.';

// The /api/v0 intake fingerprint is [agentId, conversationId ?? null,
// content], the same array the legacy payload hash covered. A row whose
// hash matches neither the supplied-conversation nor the new-conversation
// form gets no intake row (its key then conflicts rather than replays).
function seedLegacyIntakes(db: Db): void {
  const rows = db.prepare(`
    SELECT w.id AS request_id, r.principal_kind, r.principal_id, r.idempotency_key, r.payload_hash,
      r.conversation_id, r.target_bot_id, r.accepted_message_id, r.created_at, m.content AS content
    FROM work_requests w
    JOIN agent_requests r ON r.id = w.legacy_agent_request_id
    JOIN messages m ON m.id = r.accepted_message_id
    WHERE r.operation = 'send_message'
      AND NOT EXISTS (
        SELECT 1 FROM conversation_intakes i
        WHERE i.requester_kind = r.principal_kind AND i.requester_id = r.principal_id AND i.idempotency_key = r.idempotency_key
      )
  `).all() as { request_id: string; principal_kind: string; principal_id: string; idempotency_key: string; payload_hash: string;
    conversation_id: string; target_bot_id: string; accepted_message_id: string; created_at: number; content: string }[];
  const insert = db.prepare(`
    INSERT INTO conversation_intakes (
      requester_kind, requester_id, idempotency_key, request_hash, surface,
      conversation_id, source_event_id, work_request_ids, created_at
    ) VALUES (?, ?, ?, ?, 'api', ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const fingerprint = [row.conversation_id, null]
      .map(conversationId => [row.target_bot_id, conversationId, row.content])
      .find(candidate => sha256(JSON.stringify(candidate)) === row.payload_hash);
    if (!fingerprint) continue;
    insert.run(
      row.principal_kind, row.principal_id, row.idempotency_key, sha256(JSON.stringify(['api', fingerprint])),
      row.conversation_id, row.accepted_message_id, JSON.stringify([row.request_id]), row.created_at
    );
  }
}

// NOT-477: the requester of the UI turns the UI turn executor creates
// itself (handoffs, report-backs, timer ticks, greetings).
export const UI_TURN_REQUESTER = Object.freeze({ kind: 'service' as const, id: 'botmancers-ui-turns' });

// The policy a UI continuation turn carries: a read-only conversation turn
// (a handoff target runs under the legacy-WAKE rule, everything else under
// the direct-message rule), exactly what the turn's launch selects.
export function uiTurnExecutionPolicy(delegated: boolean): ExecutionPolicySnapshot {
  const selection = selectExecutionPolicy(delegated
    ? { entryPoint: 'wake', executionKind: 'conversation', wakeSyntax: 'legacy' }
    : { entryPoint: 'ui', executionKind: 'conversation' });
  if (!selection.ok) throw new EngineStoreError('invalid_input', selection.reason);
  return selection.policy;
}

export const UI_TURN_INTERRUPTED = 'ui_turn_interrupted';
export const UI_TURN_INTERRUPTED_MESSAGE = 'The UI turn was interrupted before it finished; it is not run again.';

interface LegacyQueueRow {
  id: string;
  conversation_id: string;
  bot_id: string;
  status: string;
  work_request_id: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

// NOT-477: retires the processing_queue lifecycle. Each row was one UI
// loop turn; since NOT-471 a turn accepted by UI intake names its Work
// Request, which the loop left queued unless it handed it to the
// dispatcher. Rows are reconciled oldest first (created_at, rowid):
//
// - A row naming a request that is still queued gives that request to the
//   UI turn executor (executor ui_message). Its outcome becomes the
//   request's: pending stays queued (the executor runs it, as the loop
//   would have after a restart); completed and failed become completed and
//   failed (queued -> running -> terminal, reason legacy_queue_turn, at the
//   row's own times); processing becomes failed with ui_turn_interrupted
//   (the loop never re-ran a started row). A request already past queued
//   was dispatched and keeps its own outcome.
// - A pending row without a request (a loop-internal turn) becomes one
//   queued ui_continuation request for the same Agent and conversation, so
//   it still runs. Other rows without a request recorded only the loop's
//   bookkeeping and stay in the archive.
// - A row whose conversation or Agent is gone stays in the archive only.
// - A queued UI intake request with no row at all (schema 13 crashed
//   between committing it and writing its row) also goes to the UI turn
//   executor, by its intake provenance.
//
// Finally processing_queue is renamed to legacy_processing_queue_archive:
// every original row is kept verbatim and nothing reads or writes it.
// Runs inside migration 15's transaction. Returns the number of requests
// created or reconciled.
export function retireProcessingQueue(db: Db): number {
  const tableExists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!tableExists('processing_queue')) return 0;
  const columns = new Set((db.prepare('PRAGMA table_info(processing_queue)').all() as { name: string }[]).map(column => column.name));
  const requestColumn = columns.has('work_request_id') ? 'q.work_request_id' : 'NULL';
  const rows = db.prepare(`
    SELECT q.id, q.conversation_id, q.bot_id, q.status, ${requestColumn} AS work_request_id, q.created_at, q.started_at, q.completed_at
    FROM processing_queue q
    JOIN conversations c ON c.id = q.conversation_id
    JOIN bots b ON b.id = q.bot_id
    ORDER BY q.created_at ASC, q.rowid ASC
  `).all() as LegacyQueueRow[];
  const getRequest = db.prepare('SELECT * FROM work_requests WHERE id = ?');
  const setState = db.prepare(`
    UPDATE work_requests SET state = ?, state_reason = ?, version = version + 1, updated_at = ?,
      error_code = ?, error_message = ?, terminal_at = ?, executor = 'ui_message'
    WHERE id = ?
  `);
  const insertEvent = db.prepare(`
    INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at)
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, NULL, ?, ?, ? FROM engine_events WHERE request_id = ?
  `);
  const event = (requestId: string, type: string, data: unknown, at: number) =>
    insertEvent.run(randomUUID(), requestId, type, JSON.stringify(data), at, requestId);
  const latestMessage = db.prepare(
    'SELECT id FROM messages WHERE conversation_id = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
  );
  const insertRequest = db.prepare(`
    INSERT INTO work_requests (
      id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
      intent, execution_kind, tool_profile, parent_request_id, root_request_id, wake_event_id, depth,
      idempotency_key, request_hash, policy_snapshot, state, version, created_at, updated_at,
      wake_depth, root_principal_kind, root_principal_id, executor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', 'readonly', NULL, ?, NULL, 0, ?, ?, ?, 'queued', 0, ?, ?, 0, ?, ?, 'ui_continuation')
  `);
  const executionPolicy = uiTurnExecutionPolicy(false);
  let changed = 0;
  for (const row of rows) {
    if (row.work_request_id) {
      const request = getRequest.get(row.work_request_id) as WorkRequest | undefined;
      if (!request || request.state !== 'queued') continue;
      const startedAt = row.started_at ?? row.created_at;
      const endedAt = Math.max(row.completed_at ?? startedAt, startedAt);
      if (row.status === 'pending') {
        db.prepare("UPDATE work_requests SET executor = 'ui_message' WHERE id = ?").run(request.id);
      } else if (row.status === 'completed' || row.status === 'failed') {
        setState.run('running', null, startedAt, null, null, null, request.id);
        event(request.id, 'state_changed', { from: 'queued', to: 'running', reason: null, legacy_queue_id: row.id }, startedAt);
        setState.run(row.status, 'legacy_queue_turn', endedAt,
          row.status === 'failed' ? 'ui_turn_failed' : null,
          row.status === 'failed' ? 'The UI turn failed in the retired processing queue.' : null,
          endedAt, request.id);
        event(request.id, 'state_changed', { from: 'running', to: row.status, reason: 'legacy_queue_turn', legacy_queue_id: row.id }, endedAt);
      } else {
        const at = Math.max(Date.now(), startedAt);
        setState.run('running', null, startedAt, null, null, null, request.id);
        event(request.id, 'state_changed', { from: 'queued', to: 'running', reason: null, legacy_queue_id: row.id }, startedAt);
        setState.run('failed', UI_TURN_INTERRUPTED, at, UI_TURN_INTERRUPTED, UI_TURN_INTERRUPTED_MESSAGE, at, request.id);
        event(request.id, 'state_changed', { from: 'running', to: 'failed', reason: UI_TURN_INTERRUPTED, error_code: UI_TURN_INTERRUPTED, legacy_queue_id: row.id }, at);
      }
      changed++;
      continue;
    }
    if (row.status !== 'pending') continue;
    const id = randomUUID();
    const source = (latestMessage.get(row.conversation_id, row.created_at) as { id: string } | undefined)?.id ?? row.conversation_id;
    const policy = { source: 'legacy_processing_queue', legacy_queue_id: row.id };
    const hash = workRequestHash({
      sourceConversationId: row.conversation_id, sourceEventId: source, targetAgentId: row.bot_id, intent: 'turn',
      executionKind: 'conversation', toolProfile: 'readonly', policy: { ...policy, execution_policy: executionPolicy },
    });
    insertRequest.run(
      id, row.conversation_id, source, UI_TURN_REQUESTER.kind, UI_TURN_REQUESTER.id, row.bot_id, 'turn', id,
      `legacy-queue:${row.id}`, hash, JSON.stringify({ ...policy, execution_policy: executionPolicy, tool_profile: 'readonly' }),
      row.created_at, row.created_at, UI_TURN_REQUESTER.kind, UI_TURN_REQUESTER.id
    );
    event(id, 'accepted', { state: 'queued', execution_kind: 'conversation', tool_profile: 'readonly' }, row.created_at);
    event(id, 'backfilled', { legacy_queue_id: row.id }, row.created_at);
    changed++;
  }
  // Schema 13 committed a UI intake's Work Request before the route wrote
  // its processing_queue row, so a crash between the two left a queued UI
  // message request with no row. Its durable intake provenance (UI policy
  // snapshot, or a UI conversation_intakes row naming it) gives it to the
  // UI turn executor too. API and Wake requests stay with the dispatcher.
  changed += db.prepare(`
    UPDATE work_requests SET executor = 'ui_message'
    WHERE state = 'queued' AND executor = 'dispatcher' AND legacy_agent_request_id IS NULL
      AND parent_request_id IS NULL AND wake_event_id IS NULL
      AND (
        (json_extract(policy_snapshot, '$.source') = 'conversation_intake' AND json_extract(policy_snapshot, '$.surface') = 'ui')
        OR EXISTS (
          SELECT 1 FROM conversation_intakes i, json_each(i.work_request_ids) r
          WHERE i.surface = 'ui' AND r.value = work_requests.id
        )
      )
  `).run().changes;
  if (tableExists('legacy_processing_queue_archive')) {
    db.exec('INSERT INTO legacy_processing_queue_archive SELECT * FROM processing_queue; DROP TABLE processing_queue;');
  } else {
    db.exec('ALTER TABLE processing_queue RENAME TO legacy_processing_queue_archive');
  }
  return changed;
}

export interface CreateWorkRequestInput {
  sourceConversationId: string;
  sourceEventId: string;
  requester: { kind: RequesterKind; id: string };
  targetAgentId: string;
  intent: string;
  executionKind: ExecutionKind;
  toolProfile: ToolProfile;
  idempotencyKey: string;
  parentRequestId?: string | null;
  wakeEventId?: string | null;
  // Extra policy recorded verbatim alongside the tool profile.
  policy?: Record<string, unknown>;
  // NOT-471: the policy lib/execution-policy selected for this request.
  // Stored as policy_snapshot.execution_policy; the dispatcher launches
  // nothing for a request without a valid one.
  executionPolicy?: ExecutionPolicySnapshot;
  // Initial state: a wake whose target is not launchable may start blocked.
  initialState?: 'queued' | 'blocked';
  stateReason?: string | null;
  // NOT-473: absolute deadline (epoch ms) and bounded retry policy, fixed
  // at intake. Omitted: the BOTMANCERS_* defaults (no deadline, one
  // Attempt). Neither is part of the idempotency hash.
  deadlineAt?: number | null;
  retryPolicy?: RetryPolicy;
  // NOT-475: the lineage principal of a root request (default: the
  // requester; a child inherits its parent's), its wake depth (default: a
  // Wake-created child is one deeper than its parent, any other child at
  // the parent's depth), the safety decision recorded with it in the same
  // transaction, and the safety fields added to policy_snapshot. None is
  // part of the idempotency hash.
  rootPrincipal?: { kind: string; id: string };
  wakeDepth?: number;
  safety?: SafetyDecisionInput;
  safetySnapshot?: Record<string, unknown>;
  // NOT-477: who runs the request (default: the dispatcher). Not part of
  // the idempotency hash.
  executor?: RequestExecutor;
  now?: number;
}

export interface TransitionInput {
  from: WorkRequestState;
  to: WorkRequestState;
  expectedVersion?: number;
  reason?: string | null;
  result?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  data?: Record<string, unknown>;
  now?: number;
}

export interface CreateAttemptInput {
  kind: AttemptKind;
  adapter: string;
  toolProfile: ToolProfile;
  // Stored verbatim when a string; objects are serialized once.
  launchSnapshot: string | Record<string, unknown>;
  resumedSessionBindingId?: string | null;
  externalRunId?: string | null;
  externalSessionId?: string | null;
  now?: number;
}

export interface FinishAttemptInput {
  outcome: AttemptOutcome;
  output?: string | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
  artifacts?: unknown[];
  externalRunId?: string | null;
  externalSessionId?: string | null;
  now?: number;
}

export interface BindSessionInput {
  agentId: string;
  adapter: string;
  externalSessionId: string;
  conversationId?: string | null;
  requestId?: string | null;
  sourceAttemptId?: string | null;
  now?: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function createEngineStore(db: Db) {
  purgeSet(db);
  const getRequest = db.prepare('SELECT * FROM work_requests WHERE id = ?');
  const getByIdempotency = db.prepare(
    'SELECT * FROM work_requests WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?'
  );
  const getAttemptRow = db.prepare('SELECT * FROM work_attempts WHERE id = ?');
  const insertEventRow = db.prepare(`
    INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at)
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ? FROM engine_events WHERE request_id = ?
  `);
  const getEvent = db.prepare('SELECT * FROM engine_events WHERE id = ?');
  const getBinding = db.prepare('SELECT * FROM session_bindings WHERE id = ?');

  function requireRequest(id: string): WorkRequest {
    const row = getRequest.get(id) as WorkRequest | undefined;
    if (!row) throw new EngineStoreError('not_found', `No work request ${id}.`);
    return row;
  }

  function requireAttempt(id: string): WorkAttempt {
    const row = getAttemptRow.get(id) as WorkAttempt | undefined;
    if (!row) throw new EngineStoreError('not_found', `No attempt ${id}.`);
    return row;
  }

  function insertEvent(requestId: string, type: string, data: unknown, attemptId: string | null, at: number): EngineEvent {
    const id = randomUUID();
    insertEventRow.run(id, requestId, attemptId, type, json(data), at, requestId);
    return getEvent.get(id) as EngineEvent;
  }

  function validateCreate(input: CreateWorkRequestInput): void {
    if (!nonEmpty(input.sourceConversationId)) throw new EngineStoreError('invalid_input', 'sourceConversationId is required.');
    if (!nonEmpty(input.sourceEventId)) throw new EngineStoreError('invalid_input', 'sourceEventId is required.');
    if (!input.requester || !['person', 'bot', 'service'].includes(input.requester.kind) || !nonEmpty(input.requester.id)) {
      throw new EngineStoreError('invalid_input', 'A requester principal is required.');
    }
    if (!nonEmpty(input.targetAgentId)) throw new EngineStoreError('invalid_input', 'targetAgentId is required.');
    if (typeof input.intent !== 'string') throw new EngineStoreError('invalid_input', 'intent is required.');
    if (!isExecutionKind(input.executionKind)) throw new EngineStoreError('invalid_input', 'Unknown execution kind.');
    // Unsupported authority fails closed; it is never defaulted.
    if (TOOL_PROFILE_FOR_KIND[input.executionKind] !== input.toolProfile) {
      throw new EngineStoreError('invalid_input', `Execution kind ${input.executionKind} requires the ${TOOL_PROFILE_FOR_KIND[input.executionKind]} tool profile.`);
    }
    if (input.policy && Object.prototype.hasOwnProperty.call(input.policy, 'execution_policy')) {
      throw new EngineStoreError('invalid_input', 'The execution policy is passed as executionPolicy, never inside policy.');
    }
    if (input.executionPolicy !== undefined) {
      const checked = validateExecutionPolicy(input.executionPolicy);
      if (!checked.ok) throw new EngineStoreError('invalid_input', checked.reason);
      if (checked.policy.execution_kind !== input.executionKind || checked.policy.tool_profile !== input.toolProfile) {
        throw new EngineStoreError('invalid_input', 'The execution policy does not match the requested execution kind and tool profile.');
      }
    }
    if (!nonEmpty(input.idempotencyKey)) throw new EngineStoreError('invalid_input', 'idempotencyKey is required.');
    if (input.executor !== undefined && !REQUEST_EXECUTORS.includes(input.executor)) {
      throw new EngineStoreError('invalid_input', 'Unknown request executor.');
    }
    if (input.initialState && input.initialState !== 'queued' && input.initialState !== 'blocked') {
      throw new EngineStoreError('invalid_input', 'A work request starts queued or blocked.');
    }
    if (input.deadlineAt !== undefined && input.deadlineAt !== null && !Number.isSafeInteger(input.deadlineAt)) {
      throw new EngineStoreError('invalid_input', 'deadlineAt must be an epoch millisecond integer.');
    }
    if (input.retryPolicy !== undefined) {
      const checked = validateRetryPolicy(input.retryPolicy);
      if (!checked.ok) throw new EngineStoreError('invalid_input', checked.reason);
    }
  }

  const store = {
    // Runs fn in one IMMEDIATE transaction (nested calls use savepoints).
    transaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },

    // Exactly one durable request per (requester, idempotency key). A
    // repeat with the same payload returns the stored row and appends
    // nothing; a different payload is an idempotency conflict.
    createOrGetWorkRequest(input: CreateWorkRequestInput): { request: WorkRequest; created: boolean } {
      validateCreate(input);
      const callerPolicy = input.executionPolicy
        ? { ...(input.policy ?? {}), execution_policy: input.executionPolicy }
        : input.policy;
      const hash = workRequestHash({ ...input, policy: callerPolicy });
      return db.transaction(() => {
        const existing = getByIdempotency.get(input.requester.kind, input.requester.id, input.idempotencyKey) as WorkRequest | undefined;
        if (existing) {
          if (existing.request_hash !== hash) {
            throw new EngineStoreError('idempotency_conflict', 'The idempotency key was already used with a different request.');
          }
          return { request: existing, created: false };
        }
        const now = input.now ?? Date.now();
        const id = randomUUID();
        let rootId: string = id;
        let depth = 0;
        let wakeDepth = 0;
        let rootPrincipal = input.rootPrincipal ?? input.requester;
        if (input.parentRequestId) {
          const parent = getRequest.get(input.parentRequestId) as WorkRequest | undefined;
          if (!parent) throw new EngineStoreError('not_found', 'Parent work request not found.');
          rootId = parent.root_request_id;
          depth = parent.depth + 1;
          wakeDepth = input.wakeEventId ? parent.wake_depth + 1 : parent.wake_depth;
          rootPrincipal = { kind: parent.root_principal_kind ?? 'unknown', id: parent.root_principal_id ?? 'unknown' };
        }
        if (input.wakeDepth !== undefined) wakeDepth = input.wakeDepth;
        const state = input.initialState ?? 'queued';
        const policy = JSON.stringify({ ...(callerPolicy ?? {}), ...(input.safetySnapshot ?? {}), tool_profile: input.toolProfile });
        const defaults = requestControlDefaultsFromEnv();
        const retryPolicy = input.retryPolicy ?? defaults.retryPolicy;
        const deadlineAt = input.deadlineAt !== undefined ? input.deadlineAt : defaults.deadlineMs === null ? null : now + defaults.deadlineMs;
        db.prepare(`
          INSERT INTO work_requests (
            id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
            intent, execution_kind, tool_profile, parent_request_id, root_request_id, wake_event_id, depth,
            idempotency_key, request_hash, policy_snapshot, state, state_reason, version, created_at, updated_at,
            deadline_at, retry_policy, wake_depth, root_principal_kind, root_principal_id, executor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.sourceConversationId, input.sourceEventId, input.requester.kind, input.requester.id, input.targetAgentId,
          input.intent, input.executionKind, input.toolProfile, input.parentRequestId ?? null, rootId, input.wakeEventId ?? null, depth,
          input.idempotencyKey, hash, policy, state, input.stateReason ?? null, now, now,
          deadlineAt, JSON.stringify(retryPolicy), wakeDepth, rootPrincipal.kind, rootPrincipal.id, input.executor ?? 'dispatcher'
        );
        insertEvent(id, 'accepted', {
          state, execution_kind: input.executionKind, tool_profile: input.toolProfile,
          deadline_at: deadlineAt, retry_policy: retryPolicy,
        }, null, now);
        // Audit record of the selection: kinds, profile, entry point, and
        // rule only (no prompt text, sessions, or credentials).
        if (input.executionPolicy) insertEvent(id, 'policy_selected', { ...input.executionPolicy }, null, now);
        if (state === 'blocked') insertEvent(id, 'state_changed', { from: 'queued', to: 'blocked', reason: input.stateReason ?? null }, null, now);
        if (input.safety) store.recordSafetyDecision(id, { ...input.safety, now: input.safety.now ?? now });
        return { request: requireRequest(id), created: true };
      }).immediate();
    },

    getWorkRequest(id: string): WorkRequest | undefined {
      return getRequest.get(id) as WorkRequest | undefined;
    },

    // NOT-475: appends one safety decision for a request. Decisions are
    // never updated; the latest one is the request's current authority.
    recordSafetyDecision(requestId: string, input: SafetyDecisionInput): SafetyDecision {
      if (!['human_owner', 'api_principal', 'agent_principal', 'engine'].includes(input.principalType)) {
        throw new EngineStoreError('invalid_input', 'A categorized principal is required.');
      }
      if (!nonEmpty(input.principal?.kind) || !nonEmpty(input.principal?.id)) throw new EngineStoreError('invalid_input', 'A principal is required.');
      if (!['allowed', 'blocked', 'denied'].includes(input.decision)) throw new EngineStoreError('invalid_input', 'Unknown safety decision.');
      if (input.decision === 'allowed' && !nonEmpty(input.grantRule)) throw new EngineStoreError('invalid_input', 'An allowed decision names its grant rule.');
      return db.transaction((): SafetyDecision => {
        const request = requireRequest(requestId);
        const id = randomUUID();
        db.prepare(`
          INSERT INTO wake_safety_decisions (
            id, request_id, sequence, wake_id, principal_type, principal_kind, principal_id, target_agent_id, execution_kind,
            decision, reason_code, grant_rule, grant_id, policy_snapshot, created_at
          ) SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM wake_safety_decisions WHERE request_id = ?
        `).run(
          id, requestId, input.wakeId ?? null, input.principalType, input.principal.kind, input.principal.id,
          request.target_agent_id, request.execution_kind, input.decision, input.reasonCode ?? null,
          input.grantRule ?? null, input.grantId ?? null, JSON.stringify(input.snapshot), input.now ?? Date.now(), requestId
        );
        return db.prepare('SELECT * FROM wake_safety_decisions WHERE id = ?').get(id) as SafetyDecision;
      }).immediate();
    },

    listSafetyDecisions(requestId: string): SafetyDecision[] {
      return db.prepare('SELECT * FROM wake_safety_decisions WHERE request_id = ? ORDER BY sequence ASC').all(requestId) as SafetyDecision[];
    },

    latestSafetyDecision(requestId: string): SafetyDecision | undefined {
      return db.prepare('SELECT * FROM wake_safety_decisions WHERE request_id = ? ORDER BY sequence DESC LIMIT 1').get(requestId) as SafetyDecision | undefined;
    },

    // Compare-and-set: succeeds only when the stored state (and version,
    // when given) still match. The state change and its event commit
    // together or not at all.
    transitionWorkRequest(id: string, input: TransitionInput): WorkRequest {
      if (!WORK_REQUEST_TRANSITIONS[input.from]?.includes(input.to)) {
        throw new EngineStoreError('invalid_transition', `Cannot move a work request from ${input.from} to ${input.to}.`);
      }
      const terminal = TERMINAL_STATES.includes(input.to);
      return db.transaction(() => {
        const current = requireRequest(id);
        const now = input.now ?? Date.now();
        const changed = db.prepare(`
          UPDATE work_requests SET
            state = ?, state_reason = ?, version = version + 1, updated_at = ?,
            result = ?, error_code = ?, error_message = ?, terminal_at = ?
          WHERE id = ? AND state = ? AND (? IS NULL OR version = ?)
        `).run(
          input.to, input.reason ?? null, now,
          terminal ? json(input.result) : null,
          terminal ? input.errorCode ?? null : null,
          terminal ? input.errorMessage ?? null : null,
          terminal ? now : null,
          id, input.from, input.expectedVersion ?? null, input.expectedVersion ?? null
        );
        if (changed.changes !== 1) {
          throw new EngineStoreError(
            'stale_state',
            `Work request ${id} is ${current.state} at version ${current.version}, not ${input.from}${input.expectedVersion === undefined ? '' : ` at version ${input.expectedVersion}`}.`
          );
        }
        insertEvent(id, 'state_changed', {
          ...(input.data ?? {}),
          from: input.from,
          to: input.to,
          reason: input.reason ?? null,
          ...(input.errorCode ? { error_code: input.errorCode } : {}),
        }, null, now);
        // Only a dispatcher-owned request gets a coordinator follow-up. The
        // UI turn executor interprets its own replies (and their Wakes)
        // before it terminalizes the turn, so a follow-up there would route
        // the same reply a second time after a restart.
        if (terminal && current.legacy_agent_request_id === null && current.executor === 'dispatcher') {
          db.prepare('INSERT OR IGNORE INTO terminal_followups (request_id, created_at) VALUES (?, ?)').run(id, now);
        }
        return requireRequest(id);
      }).immediate();
    },

    // NOT-475: a blocked request whose reason changed without a state
    // change (a Wake now waiting on its target instead of the owner, or the
    // reverse). Compare-and-set on the blocked state; the reason and its
    // event commit together.
    reblockWorkRequest(id: string, input: { reason: string; type: string; data?: Record<string, unknown>; now?: number }): WorkRequest {
      return db.transaction(() => {
        const now = input.now ?? Date.now();
        const changed = db.prepare(
          "UPDATE work_requests SET state_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'blocked'"
        ).run(input.reason, now, id);
        if (changed.changes !== 1) throw new EngineStoreError('stale_state', `Work request ${id} is not blocked.`);
        insertEvent(id, input.type, input.data ?? {}, null, now);
        return requireRequest(id);
      }).immediate();
    },

    appendEvent(requestId: string, event: { type: string; data?: unknown; attemptId?: string | null; now?: number }): EngineEvent {
      if (!nonEmpty(event.type)) throw new EngineStoreError('invalid_input', 'Event type is required.');
      return db.transaction(() => {
        requireRequest(requestId);
        if (event.attemptId) {
          const attempt = requireAttempt(event.attemptId);
          if (attempt.request_id !== requestId) throw new EngineStoreError('invalid_input', 'The attempt belongs to another request.');
        }
        return insertEvent(requestId, event.type, event.data, event.attemptId ?? null, event.now ?? Date.now());
      }).immediate();
    },

    listEvents(requestId: string): EngineEvent[] {
      return db.prepare('SELECT * FROM engine_events WHERE request_id = ? ORDER BY sequence ASC').all(requestId) as EngineEvent[];
    },

    // A new Attempt for a running request. Earlier attempts are kept;
    // only one may be open at a time. The tool profile must match the
    // request's explicit authority.
    createAttempt(requestId: string, input: CreateAttemptInput): WorkAttempt {
      if (input.kind !== 'launch' && input.kind !== 'resume') throw new EngineStoreError('invalid_input', 'Unknown attempt kind.');
      if (!nonEmpty(input.adapter)) throw new EngineStoreError('invalid_input', 'adapter is required.');
      if (input.kind === 'resume' && !input.resumedSessionBindingId) {
        throw new EngineStoreError('invalid_input', 'A resume attempt names the session binding it resumes.');
      }
      if (input.kind === 'launch' && input.resumedSessionBindingId) {
        throw new EngineStoreError('invalid_input', 'A launch attempt does not resume a session binding.');
      }
      const snapshot = typeof input.launchSnapshot === 'string' ? input.launchSnapshot : JSON.stringify(input.launchSnapshot);
      if (typeof snapshot !== 'string' || snapshot.length === 0) {
        throw new EngineStoreError('invalid_input', 'A launch snapshot is required.');
      }
      return db.transaction(() => {
        const request = requireRequest(requestId);
        if (request.state !== 'running') {
          throw new EngineStoreError('attempt_conflict', `Attempts start only on running requests (request is ${request.state}).`);
        }
        if (input.toolProfile !== request.tool_profile) {
          throw new EngineStoreError('invalid_input', `The attempt tool profile must be ${request.tool_profile}.`);
        }
        const open = db.prepare('SELECT id FROM work_attempts WHERE request_id = ? AND finished_at IS NULL').get(requestId);
        if (open) throw new EngineStoreError('attempt_conflict', 'The request already has an open attempt.');
        if (input.resumedSessionBindingId) {
          const binding = getBinding.get(input.resumedSessionBindingId) as SessionBinding | undefined;
          if (!binding) throw new EngineStoreError('not_found', 'Session binding not found.');
          if (binding.released_at !== null) throw new EngineStoreError('session_mismatch', 'The session binding was released.');
          if (binding.agent_id !== request.target_agent_id || binding.adapter !== input.adapter) {
            throw new EngineStoreError('session_mismatch', 'The session binding belongs to another Agent or adapter.');
          }
          if (binding.conversation_id !== null && binding.conversation_id !== request.source_conversation_id) {
            throw new EngineStoreError('session_mismatch', 'The session binding belongs to another conversation.');
          }
          if (binding.request_id !== null && requireRequest(binding.request_id).root_request_id !== request.root_request_id) {
            throw new EngineStoreError('session_mismatch', 'The session binding belongs to an unrelated work request.');
          }
        }
        const now = input.now ?? Date.now();
        const id = randomUUID();
        const next = db.prepare(
          'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM work_attempts WHERE request_id = ?'
        ).get(requestId) as { n: number };
        db.prepare(`
          INSERT INTO work_attempts (
            id, request_id, attempt_number, kind, adapter, tool_profile, launch_snapshot, launch_snapshot_hash,
            resumed_session_binding_id, external_run_id, external_session_id, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, requestId, next.n, input.kind, input.adapter, input.toolProfile, snapshot, sha256(snapshot),
          input.resumedSessionBindingId ?? null, input.externalRunId ?? null, input.externalSessionId ?? null, now
        );
        insertEvent(requestId, 'attempt_started', { attempt_number: next.n, kind: input.kind, adapter: input.adapter }, id, now);
        return requireAttempt(id);
      }).immediate();
    },

    // Records external identifiers the runtime reported after launch.
    // Values are stored exactly as given; a set value never changes.
    recordAttemptExternalIds(attemptId: string, ids: { externalRunId?: string | null; externalSessionId?: string | null }): WorkAttempt {
      return db.transaction(() => {
        const attempt = requireAttempt(attemptId);
        if (attempt.finished_at !== null) throw new EngineStoreError('attempt_conflict', 'The attempt is already finished.');
        db.prepare('UPDATE work_attempts SET external_run_id = ?, external_session_id = ? WHERE id = ?').run(
          ids.externalRunId === undefined ? attempt.external_run_id : ids.externalRunId,
          ids.externalSessionId === undefined ? attempt.external_session_id : ids.externalSessionId,
          attemptId
        );
        return requireAttempt(attemptId);
      }).immediate();
    },

    finishAttempt(attemptId: string, input: FinishAttemptInput): WorkAttempt {
      if (!['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(input.outcome)) {
        throw new EngineStoreError('invalid_input', 'Unknown attempt outcome.');
      }
      return db.transaction(() => {
        const attempt = requireAttempt(attemptId);
        if (attempt.finished_at !== null) throw new EngineStoreError('attempt_conflict', 'The attempt is already finished.');
        const now = input.now ?? Date.now();
        db.prepare(`
          UPDATE work_attempts SET outcome = ?, output = ?, error_category = ?, error_message = ?, artifacts = ?,
            external_run_id = ?, external_session_id = ?, finished_at = ?
          WHERE id = ? AND finished_at IS NULL
        `).run(
          input.outcome, input.output ?? null, input.errorCategory ?? null, input.errorMessage ?? null, JSON.stringify(input.artifacts ?? []),
          input.externalRunId === undefined ? attempt.external_run_id : input.externalRunId,
          input.externalSessionId === undefined ? attempt.external_session_id : input.externalSessionId,
          now, attemptId
        );
        insertEvent(attempt.request_id, 'attempt_finished', {
          attempt_number: attempt.attempt_number,
          outcome: input.outcome,
          error_category: input.errorCategory ?? null,
        }, attemptId, now);
        return requireAttempt(attemptId);
      }).immediate();
    },

    getAttempt(id: string): WorkAttempt | undefined {
      return getAttemptRow.get(id) as WorkAttempt | undefined;
    },

    listAttempts(requestId: string): WorkAttempt[] {
      return db.prepare('SELECT * FROM work_attempts WHERE request_id = ? ORDER BY attempt_number ASC').all(requestId) as WorkAttempt[];
    },

    // Binds an opaque runtime session for an Agent in a conversation
    // and/or request. A new binding for the same scope releases the
    // previous one; bindings are never rewritten.
    bindSession(input: BindSessionInput): SessionBinding {
      if (!nonEmpty(input.agentId)) throw new EngineStoreError('invalid_input', 'agentId is required.');
      if (!nonEmpty(input.adapter)) throw new EngineStoreError('invalid_input', 'adapter is required.');
      if (!nonEmpty(input.externalSessionId)) throw new EngineStoreError('invalid_input', 'externalSessionId is required.');
      if (!input.conversationId && !input.requestId) {
        throw new EngineStoreError('invalid_input', 'A session binding is scoped to a conversation or work request.');
      }
      return db.transaction(() => {
        const now = input.now ?? Date.now();
        if (!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(input.agentId)) {
          throw new EngineStoreError('not_found', `No agent ${input.agentId}.`);
        }
        if (input.requestId) {
          const request = requireRequest(input.requestId);
          if (request.target_agent_id !== input.agentId) {
            throw new EngineStoreError('session_mismatch', 'The work request targets another Agent.');
          }
          if (input.conversationId && request.source_conversation_id !== input.conversationId) {
            throw new EngineStoreError('session_mismatch', 'The work request belongs to another conversation.');
          }
        }
        if (input.sourceAttemptId) {
          const attempt = requireAttempt(input.sourceAttemptId);
          const source = requireRequest(attempt.request_id);
          if (attempt.adapter !== input.adapter || source.target_agent_id !== input.agentId) {
            throw new EngineStoreError('session_mismatch', 'The source attempt ran another Agent or adapter.');
          }
          if (input.requestId && attempt.request_id !== input.requestId) {
            throw new EngineStoreError('session_mismatch', 'The source attempt belongs to another work request.');
          }
          if (input.conversationId && source.source_conversation_id !== input.conversationId) {
            throw new EngineStoreError('session_mismatch', 'The source attempt belongs to another conversation.');
          }
        }
        db.prepare(`
          UPDATE session_bindings SET released_at = ?
          WHERE agent_id = ? AND adapter = ? AND IFNULL(conversation_id, '') = ? AND IFNULL(request_id, '') = ?
            AND released_at IS NULL
        `).run(now, input.agentId, input.adapter, input.conversationId ?? '', input.requestId ?? '');
        const id = randomUUID();
        db.prepare(`
          INSERT INTO session_bindings (id, agent_id, adapter, conversation_id, request_id, external_session_id, source_attempt_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.agentId, input.adapter, input.conversationId ?? null, input.requestId ?? null,
          input.externalSessionId, input.sourceAttemptId ?? null, now
        );
        if (input.requestId) {
          insertEvent(input.requestId, 'session_bound', { binding_id: id, adapter: input.adapter }, input.sourceAttemptId ?? null, now);
        }
        return getBinding.get(id) as SessionBinding;
      }).immediate();
    },

    getActiveSessionBinding(scope: { agentId: string; adapter: string; conversationId?: string | null; requestId?: string | null }): SessionBinding | undefined {
      return db.prepare(`
        SELECT * FROM session_bindings
        WHERE agent_id = ? AND adapter = ? AND IFNULL(conversation_id, '') = ? AND IFNULL(request_id, '') = ?
          AND released_at IS NULL
      `).get(scope.agentId, scope.adapter, scope.conversationId ?? '', scope.requestId ?? '') as SessionBinding | undefined;
    },
  };
  return store;
}

export type EngineStore = ReturnType<typeof createEngineStore>;

// Delete-side cascade, run by the conversation and Agent delete paths
// before the referenced row goes (the RESTRICT triggers reject anything
// left behind). Starting from the requests and bindings that reference
// the conversation or Agent, it closes over everything that depends on
// them: descendant requests (parent or root lineage, even when sourced
// from another conversation), their attempts, attempts resuming a removed
// binding (with the whole request that owns it), and bindings scoped to
// or sourced from removed rows. Rows are
// then deleted dependants first. Callers run it inside their transaction.
function deleteEngineRecords(db: Db, seed: { requests: string; bindings: string; arg: string }): void {
  const ids = (sql: string, ...args: unknown[]) => (db.prepare(sql).all(...args) as { id: string }[]).map(row => row.id);
  const requests = new Set(ids(seed.requests, seed.arg));
  const bindings = new Set(ids(seed.bindings, seed.arg));
  const attempts = new Set<string>();
  const add = (set: Set<string>, found: string[]) => {
    let grew = false;
    for (const id of found) if (!set.has(id)) { set.add(id); grew = true; }
    return grew;
  };
  const list = (set: Set<string>) => JSON.stringify([...set]);
  const inSet = '(SELECT value FROM json_each(?))';
  for (;;) {
    const grewRequests = add(requests, ids(
      `SELECT id FROM work_requests WHERE parent_request_id IN ${inSet} OR root_request_id IN ${inSet}`,
      list(requests), list(requests)
    ));
    // An attempt removed with a binding takes its whole request with it:
    // events are only ever deleted as part of a removed request.
    const grewOwners = add(requests, ids(`SELECT request_id AS id FROM work_attempts WHERE id IN ${inSet}`, list(attempts)));
    const grewAttempts = add(attempts, ids(
      `SELECT id FROM work_attempts WHERE request_id IN ${inSet} OR resumed_session_binding_id IN ${inSet}`,
      list(requests), list(bindings)
    ));
    const grewBindings = add(bindings, ids(
      `SELECT id FROM session_bindings WHERE request_id IN ${inSet} OR source_attempt_id IN ${inSet}`,
      list(requests), list(attempts)
    ));
    if (!grewRequests && !grewOwners && !grewAttempts && !grewBindings) break;
  }
  // Authorize the append-only guard for exactly the requests removed
  // here, only for the duration of this delete.
  // Projections of removed requests go first: they name the events.
  db.prepare(`DELETE FROM conversation_events WHERE request_id IN ${inSet}`).run(list(requests));
  // NOT-487: finalization evidence goes with the requests it names.
  db.prepare(
    `DELETE FROM finalizations WHERE implementation_request_id IN ${inSet} OR review_request_id IN ${inSet} OR decision_request_id IN ${inSet}`
  ).run(list(requests), list(requests), list(requests));
  db.prepare(`DELETE FROM candidate_manifests WHERE request_id IN ${inSet}`).run(list(requests));
  db.prepare(`DELETE FROM attempt_finalization_baselines WHERE request_id IN ${inSet}`).run(list(requests));
  db.prepare(`DELETE FROM conversation_projection_cursors WHERE request_id IN ${inSet}`).run(list(requests));
  // NOT-475: safety decisions go with the requests they authorized.
  db.prepare(`DELETE FROM wake_safety_decisions WHERE request_id IN ${inSet}`).run(list(requests));
  // NOT-469: dispatch state goes with the requests it names.
  db.prepare(`DELETE FROM dispatch_leases WHERE request_id IN ${inSet}`).run(list(requests));
  db.prepare(`DELETE FROM attempt_launch_intents WHERE request_id IN ${inSet}`).run(list(requests));
  db.prepare(`DELETE FROM dispatch_attention WHERE request_id IN ${inSet}`).run(list(requests));
  const authorized = purgeSet(db);
  for (const id of requests) authorized.add(id);
  try {
    db.prepare(`DELETE FROM engine_events WHERE request_id IN ${inSet}`).run(list(requests));
  } finally {
    authorized.clear();
  }
  // Attempts and bindings reference each other (resume / source), but
  // never in a cycle: each reference was to a row that already existed.
  // Peel unreferenced rows until both sets are empty.
  while (attempts.size > 0 || bindings.size > 0) {
    const freeBindings = ids(
      `SELECT id FROM session_bindings WHERE id IN ${inSet}
         AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.resumed_session_binding_id = session_bindings.id)`,
      list(bindings)
    );
    for (const id of freeBindings) { db.prepare('DELETE FROM session_bindings WHERE id = ?').run(id); bindings.delete(id); }
    const freeAttempts = ids(
      `SELECT id FROM work_attempts WHERE id IN ${inSet}
         AND NOT EXISTS (SELECT 1 FROM session_bindings b WHERE b.source_attempt_id = work_attempts.id)`,
      list(attempts)
    );
    for (const id of freeAttempts) { db.prepare('DELETE FROM work_attempts WHERE id = ?').run(id); attempts.delete(id); }
    if (freeBindings.length === 0 && freeAttempts.length === 0) {
      throw new Error('Engine records could not be removed: unexpected attempt/binding reference cycle.');
    }
  }
  // Wakes go with the requests they created or descend from (with their
  // own projected rows, which name no request).
  db.prepare(
    `DELETE FROM conversation_events WHERE request_id IS NULL AND wake_id IN (SELECT id FROM wakes WHERE work_request_id IN ${inSet} OR parent_request_id IN ${inSet} OR root_request_id IN ${inSet})`
  ).run(list(requests), list(requests), list(requests));
  db.prepare(
    `DELETE FROM wakes WHERE work_request_id IN ${inSet} OR parent_request_id IN ${inSet} OR root_request_id IN ${inSet}`
  ).run(list(requests), list(requests), list(requests));
  db.prepare(`DELETE FROM terminal_followups WHERE request_id IN ${inSet}`).run(list(requests));
  const ordered =ids(`SELECT id FROM work_requests WHERE id IN ${inSet} ORDER BY depth DESC`, list(requests));
  for (const id of ordered) db.prepare('DELETE FROM work_requests WHERE id = ?').run(id);
}

export function deleteEngineRecordsForConversation(db: Db, conversationId: string): void {
  db.prepare('DELETE FROM conversation_intakes WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM delegation_chains WHERE conversation_id = ?').run(conversationId);
  db.prepare('DELETE FROM conversation_events WHERE conversation_id = ? AND request_id IS NULL').run(conversationId);
  db.prepare('DELETE FROM wakes WHERE source_conversation_id = ?').run(conversationId);
  deleteEngineRecords(db, {
    requests: 'SELECT id FROM work_requests WHERE source_conversation_id = ?',
    bindings: 'SELECT id FROM session_bindings WHERE conversation_id = ?',
    arg: conversationId,
  });
}

export function deleteEngineRecordsForAgent(db: Db, agentId: string): void {
  // A Wake the Agent requested stays while its request (to another Agent)
  // survives; deleteEngineRecords removes it with that request. Only the
  // Agent's unrouted Wakes, which nothing references, go now.
  db.prepare(`DELETE FROM conversation_events WHERE request_id IS NULL AND wake_id IN (
    SELECT id FROM wakes WHERE target_agent_id = ? OR (requester_agent_id = ? AND work_request_id IS NULL))`).run(agentId, agentId);
  db.prepare('DELETE FROM wakes WHERE target_agent_id = ? OR (requester_agent_id = ? AND work_request_id IS NULL)').run(agentId, agentId);
  // NOT-475: deleting either Agent deletes its grants.
  db.prepare('DELETE FROM wake_grants WHERE caller_agent_id = ? OR target_agent_id = ?').run(agentId, agentId);
  deleteEngineRecords(db, {
    requests: 'SELECT id FROM work_requests WHERE target_agent_id = ?',
    bindings: 'SELECT id FROM session_bindings WHERE agent_id = ?',
    arg: agentId,
  });
}
