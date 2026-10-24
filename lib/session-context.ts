// NOT-517: launch-bound session contexts, the only credential of
// share-current (docs/design/2026-10-24-session-share-preflight.md §2;
// docs/service-grants.md, Share the current session).
//
// A context is minted by Botmancers for one launch it makes of a Claude Code
// or Codex turn, and only while the owner has share_from_turn on for that
// Agent (config/session-shares.json, lib/session-shares):
//
//   token     bmsc_ + 256 random bits (base64url); only its SHA-256 is stored
//   binding   one (agent_id, session_ref, launch); a launch is a Claude turn
//             process, a Codex thread load in Botmancers' app-server
//             (thread/start, or the first thread/resume in that process), or
//             one codex exec process
//   delivery  an HTTP header on the MCP entry Botmancers writes for that
//             launch, pointed at its own /api/v0/mcp (the providers' launch
//             arguments; never argv, a tool argument, or model-visible text)
//
// It authenticates only the reserved principal
// service:botmancers-session-context, and that principal can call only
// share-current (lib/service-api-http, lib/mcp-http). It is valid while its
// launch is live and a Botmancers turn on its session_ref runs, and for at
// most 15 minutes after the last such turn. It is ended when the launch ends
// (turn process exit, thread unload, app-server exit, a Botmancers restart
// for a process-bound launch) and revoked when the owner turns
// share_from_turn off. Because it names exactly one session_ref, a stale or
// replayed token fails closed and never points at another session.
//
// Rows hold Botmancers references only: the provider launch id (a Claude
// turn id, a Codex load or exec run id) is kept only as a SHA-256 digest.
import { createHash, randomBytes } from 'crypto';
import db, { bots, type Principal } from './db';
import { shareFromTurnEnabled } from './session-shares';
import { SESSION_CONTEXT_HEADER } from './session-context-launch';

export {
  SESSION_CONTEXT_ENV,
  SESSION_CONTEXT_EXEC_ENV,
  SESSION_CONTEXT_HEADER,
  SESSION_CONTEXT_MCP_SERVER,
  SHARE_CURRENT_CLAUDE_TOOL,
  SHARE_CURRENT_TOOL,
  claudeMcpConfig,
  codexExecMcpArgs,
  codexThreadMcpConfig,
  withoutSessionContextEnv,
} from './session-context-launch';
export const SESSION_CONTEXT_SERVICE_ID = 'botmancers-session-context';
export const SESSION_CONTEXT_PRINCIPAL: Principal = Object.freeze({ kind: 'service', id: SESSION_CONTEXT_SERVICE_ID }) as Principal;
export const SESSION_CONTEXT_IDLE_MS = 15 * 60 * 1000;
// Where launches reach Botmancers' MCP endpoint (default: this server's
// loopback port).
export const SESSION_CONTEXT_URL_ENV = 'BOTMANCERS_SESSION_CONTEXT_URL';

export const SESSION_CONTEXT_REASONS = ['missing', 'ambiguous', 'unsupported', 'unknown', 'stale', 'revoked'] as const;
export type SessionContextReason = (typeof SESSION_CONTEXT_REASONS)[number];

export type SessionLaunchKind = 'claude_turn' | 'codex_thread_load' | 'codex_exec';
export type SessionContextEndReason =
  | 'process_exit' | 'turn_end' | 'thread_unload' | 'app_server_exit' | 'restart' | 'launch_failed' | 'idle_timeout' | 'session_changed' | 'owner_off' | 'revoked';

const TOKEN = /^bmsc_[A-Za-z0-9_-]{43}$/;
const HEADER_LIMIT = 4096;

db.exec(`
  CREATE TABLE IF NOT EXISTS session_contexts (
    id TEXT PRIMARY KEY CHECK (id LIKE 'sctx_%'),
    token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
    agent_id TEXT NOT NULL,
    -- The public session_ref the context names; null until a started
    -- session is recorded (then bound once).
    session_ref TEXT,
    -- The registry row whose turns keep the context live (the same ref, or
    -- the provider row behind a binding).
    registry_ref TEXT,
    launch_kind TEXT NOT NULL CHECK (launch_kind IN ('claude_turn', 'codex_thread_load', 'codex_exec')),
    launch_digest TEXT NOT NULL,
    -- Set for a launch that cannot outlive the Botmancers process (a thread
    -- load in its app-server child).
    process_ref TEXT,
    -- The Botmancers turn whose launch this is (a Claude turn process, a
    -- codex exec run); null for a Codex thread load, which outlives a turn.
    turn_ref TEXT,
    state TEXT NOT NULL CHECK (state IN ('live', 'ended', 'revoked')),
    end_reason TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_contexts_launch ON session_contexts(launch_digest, state);
  CREATE INDEX IF NOT EXISTS idx_session_contexts_agent ON session_contexts(agent_id, state);
  CREATE INDEX IF NOT EXISTS idx_session_contexts_turn ON session_contexts(turn_ref, state);
`);

export interface SessionContextRow {
  id: string;
  token_sha256: string;
  agent_id: string;
  session_ref: string | null;
  registry_ref: string | null;
  launch_kind: SessionLaunchKind;
  launch_digest: string;
  process_ref: string | null;
  turn_ref: string | null;
  state: 'live' | 'ended' | 'revoked';
  end_reason: SessionContextEndReason | null;
  created_at: number;
  ended_at: number | null;
  updated_at: number;
}

// ---------------------------------------------------------------------
// Clock and process identity (test seams). The process reference is the
// same for every module instance in one Node process (pid and start time),
// so route bundles that load this module separately agree on it.

let clock: () => number = () => Date.now();
export function setSessionContextClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

let processOverride: string | null = null;
function processRef(): string {
  return processOverride ?? `${process.pid}:${Math.round(performance.timeOrigin)}`;
}
export function simulateSessionContextRestart(): void {
  processOverride = randomBytes(9).toString('base64url');
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

// The provider launch id never reaches the database in the clear.
function launchDigest(kind: SessionLaunchKind, ref: string): string {
  return sha256(`botmancers-session-launch\n${kind}\n${ref}`);
}

export function sessionContextUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[SESSION_CONTEXT_URL_ENV] || '').trim();
  if (explicit) return explicit;
  const port = /^\d{1,5}$/.test((env.PORT || '').trim()) ? env.PORT!.trim() : '3333';
  return `http://127.0.0.1:${port}/api/v0/mcp`;
}

// ---------------------------------------------------------------------
// Minting.

export interface SessionLaunch {
  kind: SessionLaunchKind;
  // The provider's own launch id (a Claude turn id, a Codex load id or
  // thread id, an exec run id): opaque here, stored only as a digest.
  ref: string;
}

export interface MintedSessionContext {
  id: string;
  // The secret. Handed only to the provider's launch configuration.
  token: string;
  url: string;
}

function registryRefOf(sessionRef: string): string | null {
  const native = db.prepare('SELECT id FROM provider_sessions WHERE id = ?').get(sessionRef) as { id: string } | undefined;
  if (native) return native.id;
  const bound = db.prepare('SELECT id FROM provider_sessions WHERE binding_id = ?').get(sessionRef) as { id: string } | undefined;
  return bound?.id ?? null;
}

function ownerOf(sessionRef: string): string | null {
  const binding = db.prepare('SELECT agent_id FROM session_bindings WHERE id = ?').get(sessionRef) as { agent_id: string } | undefined;
  if (binding) return binding.agent_id;
  const native = db.prepare('SELECT agent_id FROM provider_sessions WHERE id = ?').get(sessionRef) as { agent_id: string } | undefined;
  return native?.agent_id ?? null;
}

// A context for one launch, or null when the owner has share_from_turn off
// for the Agent (or the session is not the Agent's). sessionRef is null for
// a launch that starts a new session: bindSessionContext names it once
// Botmancers has recorded the session.
export function mintSessionContext(input: {
  agentId: string;
  sessionRef: string | null;
  launch: SessionLaunch;
  processBound?: boolean;
  env?: NodeJS.ProcessEnv;
}): MintedSessionContext | null {
  sweepSessionContexts();
  if (!bots.getById(input.agentId) || !shareFromTurnEnabled(input.agentId)) return null;
  if (input.sessionRef !== null && ownerOf(input.sessionRef) !== input.agentId) return null;
  const token = `bmsc_${randomBytes(32).toString('base64url')}`;
  const id = `sctx_${randomBytes(16).toString('base64url')}`;
  const now = clock();
  db.prepare(`
    INSERT INTO session_contexts (id, token_sha256, agent_id, session_ref, registry_ref, launch_kind, launch_digest, process_ref, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
  `).run(
    id, sha256(token), input.agentId, input.sessionRef, input.sessionRef === null ? null : registryRefOf(input.sessionRef),
    input.launch.kind, launchDigest(input.launch.kind, input.launch.ref), input.processBound ? processRef() : null, now, now,
  );
  return { id, token, url: sessionContextUrl(input.env) };
}

// Names the session a start launch created. Only once, and only a session
// of the context's Agent; anything else ends the context (fail closed).
export function bindSessionContext(id: string, sessionRef: string): boolean {
  return db.transaction(() => {
    const row = contextRow(id);
    if (!row || row.state !== 'live') return false;
    if (row.session_ref !== null) return row.session_ref === sessionRef;
    if (ownerOf(sessionRef) !== row.agent_id) {
      endRow(row.id, 'ended', 'session_changed');
      return false;
    }
    db.prepare('UPDATE session_contexts SET session_ref = ?, registry_ref = ?, updated_at = ? WHERE id = ? AND session_ref IS NULL')
      .run(sessionRef, registryRefOf(sessionRef), clock(), id);
    return true;
  }).immediate();
}

// Links the contexts a turn's launch minted to the Botmancers turn, so the
// turn's end ends a per-turn launch (lib/provider-sessions finishTurn).
export function attachSessionContextsToTurn(ids: readonly string[], turnRef: string): void {
  const update = db.prepare("UPDATE session_contexts SET turn_ref = ?, updated_at = ? WHERE id = ? AND state = 'live' AND turn_ref IS NULL");
  const now = clock();
  for (const id of ids) update.run(turnRef, now, id);
}

export function contextRow(id: string): SessionContextRow | undefined {
  return db.prepare('SELECT * FROM session_contexts WHERE id = ?').get(id) as SessionContextRow | undefined;
}

// ---------------------------------------------------------------------
// Ending and revoking.

function endRow(id: string, state: 'ended' | 'revoked', reason: SessionContextEndReason): number {
  const now = clock();
  return db.prepare("UPDATE session_contexts SET state = ?, end_reason = ?, ended_at = ?, updated_at = ? WHERE id = ? AND state = 'live'")
    .run(state, reason, now, now, id).changes;
}

// The launch ended (its process exited, its thread unloaded, its app-server
// exited): every live context of it is stale from now on.
export function endSessionLaunch(launch: SessionLaunch, reason: SessionContextEndReason): number {
  const now = clock();
  return db.prepare("UPDATE session_contexts SET state = 'ended', end_reason = ?, ended_at = ?, updated_at = ? WHERE launch_digest = ? AND state = 'live'")
    .run(reason, now, now, launchDigest(launch.kind, launch.ref)).changes;
}

// The Botmancers turn ended: a launch that is that turn (a Claude turn
// process, a codex exec run) ends with it. A Codex thread load does not.
export function endTurnSessionContexts(turnRef: string, reason: SessionContextEndReason = 'turn_end'): number {
  const now = clock();
  return db.prepare(`
    UPDATE session_contexts SET state = 'ended', end_reason = ?, ended_at = ?, updated_at = ?
    WHERE turn_ref = ? AND state = 'live' AND launch_kind IN ('claude_turn', 'codex_exec')
  `).run(reason, now, now, turnRef).changes;
}

export function endSessionContext(id: string, reason: SessionContextEndReason): boolean {
  return endRow(id, 'ended', reason) === 1;
}

export function revokeSessionContext(id: string): boolean {
  return endRow(id, 'revoked', 'revoked') === 1;
}

// The owner turned share_from_turn off for the Agent: every live context of
// it is revoked now (resolution also re-reads the setting on every call).
export function revokeAgentSessionContexts(agentId: string): number {
  const now = clock();
  return db.prepare("UPDATE session_contexts SET state = 'revoked', end_reason = 'owner_off', ended_at = ?, updated_at = ? WHERE agent_id = ? AND state = 'live'")
    .run(now, now, agentId).changes;
}

// Revokes every live context of an Agent whose owner has share_from_turn
// off now (or that no longer exists). Run on every mint and resolve, so a
// toggle-off is durable on the next context use anywhere.
export function sweepSessionContexts(): number {
  const agents = db.prepare("SELECT DISTINCT agent_id FROM session_contexts WHERE state = 'live'").all() as { agent_id: string }[];
  let revoked = 0;
  for (const { agent_id } of agents) {
    if (!bots.getById(agent_id) || !shareFromTurnEnabled(agent_id)) revoked += revokeAgentSessionContexts(agent_id);
  }
  return revoked;
}

// ---------------------------------------------------------------------
// Resolution.

export type SessionContextResolution =
  | { ok: true; contextId: string; agentId: string; sessionRef: string }
  | { ok: false; reason: SessionContextReason };

// The header values a request carries, as the transport reports them
// (Headers.get joins a repeated header with ", ").
export function sessionContextHeader(headers: Headers): string | null {
  return headers.get(SESSION_CONTEXT_HEADER);
}

function lastTurnActivity(registryRef: string): { running: boolean; at: number | null } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_session_turns'").get()) return { running: false, at: null };
  const row = db.prepare(`
    SELECT MAX(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running, MAX(COALESCE(finished_at, created_at)) AS at
    FROM provider_session_turns WHERE session_ref = ?
  `).get(registryRef) as { running: number | null; at: number | null };
  return { running: row.running === 1, at: row.at };
}

// Exactly one live context, or why not. Never echoes the value. A context
// found stale or withdrawn here is ended durably as well.
export function resolveSessionContext(value: string | null | undefined): SessionContextResolution {
  const fail = (reason: SessionContextReason): SessionContextResolution => ({ ok: false, reason });
  sweepSessionContexts();
  if (value === null || value === undefined) return fail('missing');
  if (value.length > HEADER_LIMIT) return fail('unsupported');
  const values = value.split(/[\s,]+/).filter(Boolean);
  if (values.length === 0) return fail('missing');
  if (values.length > 1) return fail('ambiguous');
  // A provider id (a UUID, a chat id, a path) in place of a minted context.
  if (!TOKEN.test(values[0])) return fail('unsupported');
  const row = db.prepare('SELECT * FROM session_contexts WHERE token_sha256 = ?').get(sha256(values[0])) as SessionContextRow | undefined;
  if (!row) return fail('unknown');
  if (row.state === 'revoked') return fail('revoked');
  // The owner's opt-in is read on every call: turning it off (or deleting
  // the Agent) withdraws every live context of the Agent.
  if (!bots.getById(row.agent_id) || !shareFromTurnEnabled(row.agent_id)) {
    if (row.state === 'live') revokeAgentSessionContexts(row.agent_id);
    return fail('revoked');
  }
  if (row.state !== 'live') return fail('stale');
  // A start launch whose session is not recorded yet names no session.
  if (row.session_ref === null) return fail('stale');
  if (row.process_ref !== null && row.process_ref !== processRef()) {
    endRow(row.id, 'ended', 'restart');
    return fail('stale');
  }
  if (ownerOf(row.session_ref) !== row.agent_id) {
    endRow(row.id, 'ended', 'session_changed');
    return fail('stale');
  }
  const activity = row.registry_ref ? lastTurnActivity(row.registry_ref) : { running: false, at: null };
  if (!activity.running && clock() - Math.max(row.created_at, activity.at ?? 0) > SESSION_CONTEXT_IDLE_MS) {
    endRow(row.id, 'ended', 'idle_timeout');
    return fail('stale');
  }
  return { ok: true, contextId: row.id, agentId: row.agent_id, sessionRef: row.session_ref };
}
