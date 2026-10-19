// NOT-509: persistence and session read model for provider-reported usage
// (engine migration 18, usage_samples). One sample per Attempt or provider
// turn that reached a runtime, under a unique sample_key, so replays, a
// reconciled Attempt after a restart, and late results are idempotent:
// a later write may fill a metric that was still unknown, never add to or
// overwrite a reported one. The pure normalization and aggregation live in
// ./usage; this module only stores and reads.
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { aggregateUsage, normalizeUsage, type NormalizedUsage, type UsageSource, type UsageSummary } from './usage';

type Db = Database.Database;

export interface UsageSampleInput {
  agentId: string;
  provider: string;
  usage: NormalizedUsage | null;
  observedAt: number;
  now?: number;
}

function hasTable(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_samples'").get();
}

function write(db: Db, key: string, refs: { attemptId: string | null; sessionRef: string | null; turnId: string | null }, input: UsageSampleInput): void {
  if (!hasTable(db)) return;
  const usage = normalizeUsage(input.usage);
  const now = input.now ?? Date.now();
  db.prepare(`
    INSERT INTO usage_samples (
      id, sample_key, agent_id, attempt_id, session_ref, turn_id, provider, source,
      input_tokens, output_tokens, cost_usd, breakdown, observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sample_key) DO UPDATE SET
      input_tokens = COALESCE(usage_samples.input_tokens, excluded.input_tokens),
      output_tokens = COALESCE(usage_samples.output_tokens, excluded.output_tokens),
      cost_usd = COALESCE(usage_samples.cost_usd, excluded.cost_usd),
      breakdown = COALESCE(usage_samples.breakdown, excluded.breakdown),
      source = CASE WHEN usage_samples.source = 'none' THEN excluded.source ELSE usage_samples.source END,
      updated_at = CASE
        WHEN (usage_samples.input_tokens IS NULL AND excluded.input_tokens IS NOT NULL)
          OR (usage_samples.output_tokens IS NULL AND excluded.output_tokens IS NOT NULL)
          OR (usage_samples.cost_usd IS NULL AND excluded.cost_usd IS NOT NULL)
        THEN excluded.updated_at ELSE usage_samples.updated_at END
  `).run(
    randomUUID(), key, input.agentId, refs.attemptId, refs.sessionRef, refs.turnId, String(input.provider).slice(0, 100),
    usage?.source ?? 'none', usage?.input_tokens ?? null, usage?.output_tokens ?? null, usage?.cost_usd ?? null,
    usage?.breakdown ? JSON.stringify(usage.breakdown) : null, input.observedAt, now, now,
  );
}

// The sample of one Attempt (a launch or a resume of a Session Binding).
export function recordAttemptUsageSample(db: Db, attemptId: string, input: UsageSampleInput): void {
  write(db, `attempt:${attemptId}`, { attemptId, sessionRef: null, turnId: null }, input);
}

// The sample of one provider turn (lib/provider-sessions).
export function recordTurnUsageSample(db: Db, turnId: string, sessionRef: string, input: UsageSampleInput): void {
  write(db, `turn:${turnId}`, { attemptId: null, sessionRef, turnId }, input);
}

// ---- session read model ----

// One sample as the session detail shows it: Botmancers references only.
export interface SessionUsageSampleView {
  kind: 'attempt' | 'turn';
  // The Attempt's number within its Work Request; null for a provider turn.
  attempt_number: number | null;
  // start | send for a provider turn; launch | resume for an Attempt.
  turn_kind: string | null;
  provider: string;
  source: UsageSource;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  observed_at: number;
}

interface SampleRow {
  ref: string;
  kind: 'attempt' | 'turn';
  attempt_number: number | null;
  turn_kind: string | null;
  provider: string;
  source: UsageSource;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  observed_at: number;
  sample_key: string;
}

// The samples of every session of one Agent (or of one reference), keyed
// by session reference. A Session Binding's samples are its source
// Attempt's and every Attempt that resumed it, plus provider turns on its
// registry row; a native session's are its provider turns.
function sampleRows(db: Db, agentId: string, ref: string | null): SampleRow[] {
  if (!hasTable(db)) return [];
  const only = ref === null ? '' : 'AND b.id = ?';
  const onlyTurn = ref === null ? '' : 'AND s.session_ref = ?';
  const args = ref === null ? [agentId, agentId, agentId] : [agentId, ref, agentId, ref, agentId, ref];
  return db.prepare(`
    SELECT b.id AS ref, 'attempt' AS kind, a.attempt_number, a.kind AS turn_kind, s.provider, s.source,
      s.input_tokens, s.output_tokens, s.cost_usd, s.observed_at, s.sample_key
    FROM session_bindings b
    JOIN work_attempts a ON a.id = b.source_attempt_id
    JOIN usage_samples s ON s.attempt_id = a.id
    WHERE b.agent_id = ? ${only}
    UNION ALL
    SELECT b.id AS ref, 'attempt' AS kind, a.attempt_number, a.kind AS turn_kind, s.provider, s.source,
      s.input_tokens, s.output_tokens, s.cost_usd, s.observed_at, s.sample_key
    FROM session_bindings b
    JOIN work_attempts a ON a.resumed_session_binding_id = b.id AND a.id IS NOT b.source_attempt_id
    JOIN usage_samples s ON s.attempt_id = a.id
    WHERE b.agent_id = ? ${only}
    UNION ALL
    SELECT s.session_ref AS ref, 'turn' AS kind, NULL AS attempt_number, t.kind AS turn_kind, s.provider, s.source,
      s.input_tokens, s.output_tokens, s.cost_usd, s.observed_at, s.sample_key
    FROM usage_samples s
    LEFT JOIN provider_session_turns t ON t.id = s.turn_id
    WHERE s.agent_id = ? AND s.turn_id IS NOT NULL ${onlyTurn}
    ORDER BY observed_at ASC, sample_key ASC
  `).all(...args) as SampleRow[];
}

function view(row: SampleRow): SessionUsageSampleView {
  return {
    kind: row.kind,
    attempt_number: row.attempt_number,
    turn_kind: row.turn_kind,
    provider: row.provider,
    source: row.source,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: row.cost_usd,
    observed_at: row.observed_at,
  };
}

export function emptyUsage(): UsageSummary {
  return aggregateUsage([]);
}

// Usage summary per session reference for one Agent. A session with no
// sample is absent: callers use emptyUsage() (every metric unavailable).
export function agentSessionUsage(db: Db, agentId: string): Map<string, UsageSummary> {
  const grouped = new Map<string, SampleRow[]>();
  for (const row of sampleRows(db, agentId, null)) {
    const list = grouped.get(row.ref) ?? [];
    list.push(row);
    grouped.set(row.ref, list);
  }
  return new Map([...grouped].map(([ref, rows]) => [ref, aggregateUsage(rows)]));
}

export function sessionUsageSamples(db: Db, agentId: string, ref: string): { usage: UsageSummary; samples: SessionUsageSampleView[] } {
  const rows = sampleRows(db, agentId, ref);
  return { usage: aggregateUsage(rows), samples: rows.map(view) };
}
