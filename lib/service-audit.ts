// NOT-499: the append-only audit trail of service API calls.
//
// Every /api/v0 read and mutation an authenticated service principal makes
// appends one row: when, which principal, which operation and capability,
// the target's safe Botmancers reference (Agent, session, conversation,
// exchange, or request id), the outcome, and a stable error code. Rows never
// hold a prompt, transcript, token, credential, provider id, or working
// directory: every field is a fixed vocabulary value or a reference that
// must look like a Botmancers id (anything else is stored as "[invalid]"),
// and each is bounded. Rows cannot be updated or deleted.
import type Database from 'better-sqlite3';
import type { Principal } from './db';

type Db = Database.Database;

// allowed: served. denied: authorization (not granted, unknown target,
// rate limited, wrong principal kind). rejected: invalid input. error:
// internal failure.
export type AuditOutcome = 'allowed' | 'denied' | 'rejected' | 'error';
export type AuditTargetKind = 'grants' | 'agent' | 'session' | 'conversation' | 'exchange' | 'request';

export interface AuditInput {
  principal: Principal;
  operation: string;
  capability: string;
  targetKind: AuditTargetKind;
  targetRef?: string | null;
  agentId?: string | null;
  outcome: AuditOutcome;
  code?: string | null;
  at?: number;
}

export interface AuditEvent {
  id: number;
  at: number;
  principal: string;
  operation: string;
  capability: string;
  target_kind: AuditTargetKind;
  target_ref: string | null;
  agent_id: string | null;
  outcome: AuditOutcome;
  code: string | null;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const WORD = /^[a-z][a-z0-9_.:-]{0,63}$/;

function safeRef(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return REF.test(value) ? value : '[invalid]';
}

function safeWord(value: string | null | undefined, fallback: string): string {
  return value && WORD.test(value) ? value : fallback;
}

export function createServiceAudit(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
      operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
      capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('grants', 'agent', 'session', 'conversation', 'exchange', 'request')),
      target_ref TEXT CHECK (target_ref IS NULL OR length(target_ref) <= 128),
      agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) <= 128),
      outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'rejected', 'error')),
      code TEXT CHECK (code IS NULL OR length(code) <= 64)
    );
    CREATE INDEX IF NOT EXISTS idx_service_audit_principal ON service_audit_events(principal, id);
    CREATE TRIGGER IF NOT EXISTS trg_service_audit_no_update BEFORE UPDATE ON service_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'service_audit_events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_service_audit_no_delete BEFORE DELETE ON service_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'service_audit_events are append-only');
    END;
  `);
  const insert = db.prepare(`
    INSERT INTO service_audit_events (at, principal, operation, capability, target_kind, target_ref, agent_id, outcome, code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return {
    append(input: AuditInput): void {
      const principal = `${input.principal.kind}:${safeRef(input.principal.id) ?? '[invalid]'}`;
      insert.run(
        input.at ?? Date.now(), principal.slice(0, 200),
        safeWord(input.operation, 'unknown'), safeWord(input.capability, 'none'), input.targetKind,
        safeRef(input.targetRef), safeRef(input.agentId), input.outcome,
        input.code ? safeWord(input.code, 'unknown') : null,
      );
    },
    // Newest first; principal filters to one "kind:id".
    list(options: { principal?: string; limit?: number } = {}): AuditEvent[] {
      const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
      return (options.principal
        ? db.prepare('SELECT * FROM service_audit_events WHERE principal = ? ORDER BY id DESC LIMIT ?').all(options.principal, limit)
        : db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT ?').all(limit)) as AuditEvent[];
    },
  };
}

export type ServiceAudit = ReturnType<typeof createServiceAudit>;
