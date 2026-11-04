// NOT-545: the session catalog stays fresh without re-registration. New
// provider sessions appear on their own through the server's sync loop
// (instrumentation.ts, next to the Slack runtime), and the owner can force
// one sync through POST /api/bots/:id/sessions/sync. Both paths share one
// in-process guard so the same Agent is never synced twice at once.
//
// The loop runs at startup and then every
// BOTMANCERS_SESSION_SYNC_INTERVAL_MS (default 900000, 0 disables): for
// each Agent it runs the full-history sync (syncHistoryAtRegistration,
// already page-capped), one Agent at a time, never inside a request
// handler. An Agent with a sync in flight is skipped; one Agent's failure
// is logged and does not stop the others. Discovery stays read-only: a
// sync lists sessions, it never starts one or sends a turn.
import type Database from 'better-sqlite3';
import db from './db';
import { syncHistoryAtRegistration } from './provider-sessions';

type Db = Database.Database;

export const SESSION_SYNC_INTERVAL_ENV = 'BOTMANCERS_SESSION_SYNC_INTERVAL_MS';
export const DEFAULT_SESSION_SYNC_INTERVAL_MS = 900_000;

// The loop's interval in milliseconds: the env override when it is a
// non-negative integer, else the default. 0 disables the loop.
export function sessionSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[SESSION_SYNC_INTERVAL_ENV] ?? '').trim();
  if (raw === '') return DEFAULT_SESSION_SYNC_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_SESSION_SYNC_INTERVAL_MS;
  return n;
}

// ---- the in-process guard ----

// One set per process, shared by every module graph Next builds
// (instrumentation and route handlers): the loop and the manual route
// never sync the same Agent concurrently.
const GUARD_KEY = Symbol.for('botmancers.session-sync-inflight');

function inflight(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!holder[GUARD_KEY]) holder[GUARD_KEY] = new Set();
  return holder[GUARD_KEY] as Set<string>;
}

// True when the caller now owns the Agent's sync; false when one is
// already running. Every true is paired with endAgentSync.
export function tryBeginAgentSync(agentId: string): boolean {
  const set = inflight();
  if (set.has(agentId)) return false;
  set.add(agentId);
  return true;
}

export function endAgentSync(agentId: string): void {
  inflight().delete(agentId);
}

export function isAgentSyncing(agentId: string): boolean {
  return inflight().has(agentId);
}

// ---- freshness ----

// The newest last_synced_at of the Agent's catalog rows, or null when the
// Agent has no rows yet. The manual route and GET .../sessions report it
// as `synced_at`.
export function agentSessionsSyncedAt(target: Db, agentId: string): number | null {
  const row = target.prepare(
    'SELECT MAX(last_synced_at) AS synced_at FROM provider_sessions WHERE agent_id = ?'
  ).get(agentId) as { synced_at: number | null } | undefined;
  return row?.synced_at ?? null;
}

// ---- one pass over every Agent ----

export interface SessionSyncTickResult {
  // Agents whose full history was synced this pass.
  synced: string[];
  // Agents with no session provider, or whose provider reports no `list`.
  unsupported: string[];
  // Agents skipped because a sync was already in flight.
  skipped_inflight: string[];
  // Agents whose listing broke; the pass continued past each one.
  failed: { agent_id: string; error_code: string }[];
}

export interface SessionSyncTickOptions {
  log?: (line: string) => void;
}

// One pass over every Agent, one Agent at a time: the full-history sync
// for each Agent whose provider reports `list` (probed first, like
// registration, so a runtime that learns `list` only once ready still
// syncs). An Agent with a sync in flight is skipped; one Agent's failure
// is logged and does not stop the others.
export async function runSessionSyncTick(
  target: Db = db,
  options: SessionSyncTickOptions = {}
): Promise<SessionSyncTickResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const agents = target.prepare('SELECT id FROM bots ORDER BY created_at ASC, id ASC').all() as { id: string }[];
  const out: SessionSyncTickResult = { synced: [], unsupported: [], skipped_inflight: [], failed: [] };
  for (const { id } of agents) {
    if (!tryBeginAgentSync(id)) {
      out.skipped_inflight.push(id);
      continue;
    }
    try {
      let result;
      try {
        result = await syncHistoryAtRegistration(target, id);
      } catch (error) {
        // syncHistoryAtRegistration already contains provider failures;
        // this is only for the truly unexpected (a broken database).
        const code = 'sync_failed';
        out.failed.push({ agent_id: id, error_code: code });
        log(`Session sync: Agent ${id} failed (${error instanceof Error ? error.message : 'unknown error'}).`);
        continue;
      }
      if (result.outcome === 'synced') {
        out.synced.push(id);
        if (result.imported > 0) log(`Session sync: Agent ${id} imported ${result.imported} session${result.imported === 1 ? '' : 's'}.`);
      } else if (result.outcome === 'unsupported') {
        out.unsupported.push(id);
      } else {
        out.failed.push({ agent_id: id, error_code: result.error_code ?? 'provider_failed' });
        log(`Session sync: Agent ${id} failed (${result.error_code ?? 'provider_failed'}).`);
      }
    } finally {
      endAgentSync(id);
    }
  }
  return out;
}

// ---- the server loop ----

interface LoopState {
  timer: NodeJS.Timeout | null;
  intervalMs: number | null;
  // The pass now running, if any: a slow pass delays the next one instead
  // of piling up.
  ticking: Promise<unknown> | null;
}

const LOOP_KEY = Symbol.for('botmancers.session-sync-loop');

function loopState(): LoopState {
  const holder = globalThis as unknown as Record<symbol, LoopState | undefined>;
  if (!holder[LOOP_KEY]) holder[LOOP_KEY] = { timer: null, intervalMs: null, ticking: null };
  return holder[LOOP_KEY] as LoopState;
}

export interface SessionSyncLoopStatus {
  running: boolean;
  interval_ms: number | null;
}

export function sessionSyncLoopStatus(): SessionSyncLoopStatus {
  const state = loopState();
  return { running: state.timer !== null, interval_ms: state.intervalMs };
}

export interface SessionSyncLoopOptions {
  // Overrides BOTMANCERS_SESSION_SYNC_INTERVAL_MS (tests).
  intervalMs?: number;
  log?: (line: string) => void;
  // Overrides the pass itself (tests).
  tick?: () => Promise<unknown>;
}

// Starts the loop: one pass at startup, then one every interval. 0
// disables the loop (no pass, no timer). Idempotent: starting a running
// loop changes nothing.
export function startSessionSyncLoop(options: SessionSyncLoopOptions = {}): SessionSyncLoopStatus {
  const state = loopState();
  if (state.timer) return sessionSyncLoopStatus();
  const intervalMs = options.intervalMs ?? sessionSyncIntervalMs();
  if (intervalMs === 0) return { running: false, interval_ms: 0 };
  state.intervalMs = intervalMs;
  const log = options.log ?? ((line: string) => console.log(line));
  const tick = options.tick ?? (() => runSessionSyncTick(db, { log }));
  const run = () => {
    if (state.ticking) return;
    state.ticking = tick().catch(error => {
      log(`Session sync pass failed (${error instanceof Error ? error.message : 'unknown error'}).`);
    }).finally(() => {
      state.ticking = null;
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  state.timer = timer;
  return sessionSyncLoopStatus();
}

// Stops the loop and clears its timer; a pass already running finishes.
export function stopSessionSyncLoop(): SessionSyncLoopStatus {
  const state = loopState();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.intervalMs = null;
  return sessionSyncLoopStatus();
}

// The core server's entry (instrumentation.ts): start once, stop on
// SIGTERM/SIGINT. BOTMANCERS_NO_AUTOPROCESS=1 (tests and scripts that
// import the engine) keeps the loop off.
export function runSessionSyncInServer(): void {
  if (process.env.BOTMANCERS_NO_AUTOPROCESS === '1') return;
  const shutdown = () => {
    stopSessionSyncLoop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  startSessionSyncLoop();
}
