import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import {
  TOOL_PROFILE_FOR_KIND,
  isExecutionKind,
  validateExecutionPolicy,
  type ExecutionKind,
  type ExecutionPolicySnapshot,
  type ToolProfile,
} from './execution-policy';

// NOT-463: canonical core-engine persistence (docs/core-engine.md). One
// Work Request store, immutable Attempts, opaque Session Bindings, and an
// append-only per-request engine event log. Legacy processing_queue and
// agent_requests stay in place and readable. NOT-465: UI and /api/v0
// message intake create their Work Requests here (lib/conversation-intake).
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
];

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

// Applies pending versioned migrations, then the idempotent legacy
// backfill. Safe to call on every open and from concurrent processes:
// each step runs in an IMMEDIATE transaction and rechecks its version.
export function migrateEngineSchema(db: Db): void {
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
    db.transaction(() => {
      if (applied.get(migration.version)) return;
      migration.up(db);
      record.run(migration.version, migration.name, Date.now());
    }).immediate();
  }
  backfillLegacyAgentRequests(db);
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

// Copies terminal agent_requests history into work_requests. Only rows
// that map without guessing are copied: a terminal state (completed or
// failed; accepted/dispatched rows still belong to the legacy dispatcher),
// an existing source conversation, accepted message, and target agent,
// and a principal kind the engine knows. Legacy request events are copied
// in their original order, followed by a 'backfilled' event. No Attempt is
// synthesized: legacy rows recorded no launch snapshot. Idempotent via
// legacy_agent_request_id; legacy rows are never modified or deleted.
//
// Collision policy: legacy keys are unique per operation, canonical keys
// per requester only. Rows are visited oldest first (created_at, rowid);
// the first row to claim a (requester, idempotency key) is copied and any
// later row with the same identity, from another operation or already
// held by a canonical request, stays legacy-only. The request hash is the
// canonical intake hash of the mapped fields (conversation execution,
// readonly profile, no caller policy), not the legacy payload hash; the
// legacy operation and runtime are kept in the policy snapshot only.
export function backfillLegacyAgentRequests(db: Db): number {
  const hasLegacy = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_requests'"
  ).get();
  if (!hasLegacy) return 0;
  return db.transaction((): number => {
    const rows = db.prepare(`
      SELECT r.*, m.content AS content FROM agent_requests r
      JOIN conversations c ON c.id = r.conversation_id
      JOIN bots b ON b.id = r.target_bot_id
      JOIN messages m ON m.id = r.accepted_message_id AND m.conversation_id = r.conversation_id
      WHERE r.state IN ('completed', 'failed')
        AND r.principal_kind IN ('person', 'bot', 'service')
        AND NOT EXISTS (SELECT 1 FROM work_requests w WHERE w.legacy_agent_request_id = r.id)
      ORDER BY r.created_at ASC, r.rowid ASC
    `).all() as LegacyAgentRequestRow[];
    const claimed = db.prepare(
      'SELECT 1 FROM work_requests WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?'
    );
    const legacyEvents = db.prepare(
      'SELECT type, data, created_at FROM agent_request_events WHERE request_id = ? ORDER BY created_at ASC, rowid ASC'
    );
    const insert = db.prepare(`
      INSERT INTO work_requests (
        id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
        intent, execution_kind, tool_profile, parent_request_id, root_request_id, wake_event_id, depth,
        idempotency_key, request_hash, policy_snapshot, state, state_reason, result, error_code, error_message,
        version, legacy_agent_request_id, created_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', 'readonly', NULL, ?, NULL, 0, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?)
    `);
    const insertEvent = db.prepare(
      'INSERT INTO engine_events (id, request_id, sequence, attempt_id, type, data, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
    );
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
      // Legacy agent API turns ran as conversation turns with the
      // read-only tool profile (docs/core-engine.md, Current code).
      const policy = JSON.stringify({
        tool_profile: 'readonly',
        source: 'legacy_agent_requests',
        legacy_operation: row.operation,
        legacy_runtime: row.runtime,
      });
      insert.run(
        id, row.conversation_id, row.accepted_message_id, row.principal_kind, row.principal_id, row.target_bot_id,
        row.content, id,
        row.idempotency_key, hash, policy, row.state,
        row.state === 'completed' ? JSON.stringify({ reply_message_id: row.reply_message_id }) : null,
        row.state === 'failed' ? row.failure_code : null,
        row.state === 'failed' ? row.failure_message : null,
        row.id, row.created_at, row.updated_at, row.updated_at
      );
      let sequence = 0;
      for (const event of legacyEvents.all(row.id) as { type: string; data: string | null; created_at: number }[]) {
        insertEvent.run(randomUUID(), id, ++sequence, event.type, event.data, event.created_at);
      }
      insertEvent.run(
        randomUUID(), id, ++sequence, 'backfilled',
        JSON.stringify({ legacy_agent_request_id: row.id }), row.updated_at
      );
      copied++;
    }
    return copied;
  }).immediate();
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
    if (input.initialState && input.initialState !== 'queued' && input.initialState !== 'blocked') {
      throw new EngineStoreError('invalid_input', 'A work request starts queued or blocked.');
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
        if (input.parentRequestId) {
          const parent = getRequest.get(input.parentRequestId) as WorkRequest | undefined;
          if (!parent) throw new EngineStoreError('not_found', 'Parent work request not found.');
          rootId = parent.root_request_id;
          depth = parent.depth + 1;
        }
        const state = input.initialState ?? 'queued';
        const policy = JSON.stringify({ ...(callerPolicy ?? {}), tool_profile: input.toolProfile });
        db.prepare(`
          INSERT INTO work_requests (
            id, source_conversation_id, source_event_id, requester_kind, requester_id, target_agent_id,
            intent, execution_kind, tool_profile, parent_request_id, root_request_id, wake_event_id, depth,
            idempotency_key, request_hash, policy_snapshot, state, state_reason, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          id, input.sourceConversationId, input.sourceEventId, input.requester.kind, input.requester.id, input.targetAgentId,
          input.intent, input.executionKind, input.toolProfile, input.parentRequestId ?? null, rootId, input.wakeEventId ?? null, depth,
          input.idempotencyKey, hash, policy, state, input.stateReason ?? null, now, now
        );
        insertEvent(id, 'accepted', { state, execution_kind: input.executionKind, tool_profile: input.toolProfile }, null, now);
        // Audit record of the selection: kinds, profile, entry point, and
        // rule only (no prompt text, sessions, or credentials).
        if (input.executionPolicy) insertEvent(id, 'policy_selected', { ...input.executionPolicy }, null, now);
        if (state === 'blocked') insertEvent(id, 'state_changed', { from: 'queued', to: 'blocked', reason: input.stateReason ?? null }, null, now);
        return { request: requireRequest(id), created: true };
      }).immediate();
    },

    getWorkRequest(id: string): WorkRequest | undefined {
      return getRequest.get(id) as WorkRequest | undefined;
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
  db.prepare(`DELETE FROM conversation_projection_cursors WHERE request_id IN ${inSet}`).run(list(requests));
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
  // Wakes go with the requests they created or descend from.
  db.prepare(
    `DELETE FROM wakes WHERE work_request_id IN ${inSet} OR parent_request_id IN ${inSet} OR root_request_id IN ${inSet}`
  ).run(list(requests), list(requests), list(requests));
  const ordered = ids(`SELECT id FROM work_requests WHERE id IN ${inSet} ORDER BY depth DESC`, list(requests));
  for (const id of ordered) db.prepare('DELETE FROM work_requests WHERE id = ?').run(id);
}

export function deleteEngineRecordsForConversation(db: Db, conversationId: string): void {
  db.prepare('DELETE FROM conversation_intakes WHERE conversation_id = ?').run(conversationId);
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
  db.prepare('DELETE FROM wakes WHERE target_agent_id = ? OR (requester_agent_id = ? AND work_request_id IS NULL)').run(agentId, agentId);
  deleteEngineRecords(db, {
    requests: 'SELECT id FROM work_requests WHERE target_agent_id = ?',
    bindings: 'SELECT id FROM session_bindings WHERE agent_id = ?',
    arg: agentId,
  });
}
