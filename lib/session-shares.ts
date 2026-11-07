// NOT-515: durable temporary session shares (docs/service-access.md,
// Session shares; docs/design/2026-10-24-session-share-preflight.md).
//
// A share is one read-only Ask pin (NOT-507, lib/session-pins) on exactly
// one Botmancers session_ref, with a TTL, a turn limit, one allowlisted
// audience, and revocation. The pin's requester is the reserved engine
// principal service:botmancers-session-share, which holds no Agent grant
// (lib/service-grants refuses it in the grants document): the share itself
// is the only authority its turns have, so a share never broadens a
// long-lived grant. The pin's eligibility checks, exact-session dispatch,
// turn idempotency, and answers are NOT-507's; this module adds:
//
//   - rows (session_shares) and an append-only event log
//     (session_share_events), created like lib/service-audit;
//   - expiry (computed from expires_at), revocation (detaches the pin in
//     the same commit), the turn limit, and the in-flight guard: one
//     question at a time per share, claimed durably before dispatch and
//     recovered after a restart;
//   - the owner's share configuration document,
//
//       <BOTMANCERS_HOME>/config/session-shares.json
//
//     (BOTMANCERS_SESSION_SHARES_PATH overrides the path), version 1:
//
//       {
//         "version": 1,
//         "audiences": [{ "kind": "slack", "team_id": "T…", "channel_id": "C…" }],
//         "agents": [{ "agent": "<agent id>", "share_from_turn": true }]
//       }
//
//     and it fails closed: owner-only
//     (0600), bounded, strict JSON, no unknown field, no duplicate, no
//     wildcard, only registered Agents. Missing or invalid, no audience is
//     allowed and share_from_turn is off for every Agent;
//   - askShare, the internal entry the Slack relay will call (not a route
//     or MCP tool), audited as shares.ask on the share's session_ref.
//
// Grants (shares:create) and visibility are checked by the caller
// (lib/service-api). Rows hold Botmancers references only: never a provider
// id, working directory, Deck, runtime, model, prompt, or answer.
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import db, { serviceAudit, type Principal } from './db';
import { botmancersHome } from './home';
import { serviceRedactor } from './service-redaction';
import { PinError, createPin, detachPin, readPin, sendPinTurn, sessionOwner, type PinTurnView } from './session-pins';

export const SHARE_PRINCIPAL: Principal = Object.freeze({ kind: 'service', id: 'botmancers-session-share' }) as Principal;

export const SHARE_LIMITS = Object.freeze({
  ttl: Object.freeze({ min: 300, default: 3600, max: 86400 }),
  turns: Object.freeze({ min: 1, default: 20, max: 100 }),
  questionChars: 4000,
  replyChars: 3000,
});

export type ShareErrorCode =
  | 'invalid_request'
  | 'session_not_found'
  | 'share_not_found'
  | 'share_expired'
  | 'share_revoked'
  | 'share_turn_in_progress'
  | 'share_turn_limit'
  | 'audience_not_allowed'
  | 'idempotency_conflict';

export const SHARE_ERROR_STATUS: Record<ShareErrorCode, number> = {
  invalid_request: 400,
  session_not_found: 404,
  share_not_found: 404,
  share_expired: 410,
  share_revoked: 410,
  share_turn_in_progress: 409,
  share_turn_limit: 409,
  audience_not_allowed: 403,
  idempotency_conflict: 409,
};

export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode, message: string) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
  get status(): number {
    return SHARE_ERROR_STATUS[this.code];
  }
}

export interface SlackAudience {
  kind: 'slack';
  team_id: string;
  channel_id: string;
}

export type ShareState = 'active' | 'expired' | 'revoked';
export type ShareCreatedVia = 'session_ref' | 'current_session';

export interface ShareRow {
  id: string;
  creator_kind: Principal['kind'];
  creator_id: string;
  idempotency_key: string;
  request_hash: string;
  agent_id: string;
  session_ref: string;
  pin_ref: string;
  authority: 'ask';
  audience_kind: 'slack';
  audience_team_id: string;
  audience_channel_id: string;
  created_via: ShareCreatedVia;
  ttl_seconds: number;
  max_turns: number;
  turns_used: number;
  state: 'active' | 'revoked';
  inflight_key: string | null;
  inflight_owner: string | null;
  inflight_turn_ref: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  updated_at: number;
}

export interface ShareView {
  share_ref: string;
  agent_id: string;
  session_ref: string;
  authority: 'ask';
  state: ShareState;
  audience: SlackAudience;
  created_via: ShareCreatedVia;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  max_turns: number;
  turns_used: number;
}

export interface ShareEvent {
  sequence: number;
  type: 'created' | 'revoked' | 'turn_sent' | 'turn_refused';
  turn_ref: string | null;
  code: string | null;
  at: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS session_shares (
    id TEXT PRIMARY KEY CHECK (id LIKE 'shr_%'),
    creator_kind TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    pin_ref TEXT NOT NULL UNIQUE,
    authority TEXT NOT NULL CHECK (authority = 'ask'),
    audience_kind TEXT NOT NULL CHECK (audience_kind = 'slack'),
    audience_team_id TEXT NOT NULL,
    audience_channel_id TEXT NOT NULL,
    created_via TEXT NOT NULL CHECK (created_via IN ('session_ref', 'current_session')),
    ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds BETWEEN 300 AND 86400),
    max_turns INTEGER NOT NULL CHECK (max_turns BETWEEN 1 AND 100),
    turns_used INTEGER NOT NULL DEFAULT 0 CHECK (turns_used >= 0 AND turns_used <= max_turns),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    inflight_key TEXT,
    inflight_owner TEXT,
    inflight_turn_ref TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (creator_kind, creator_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_session_shares_creator ON session_shares(creator_kind, creator_id, created_at);
  CREATE TABLE IF NOT EXISTS session_share_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_ref TEXT NOT NULL REFERENCES session_shares(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('created', 'revoked', 'turn_sent', 'turn_refused')),
    turn_ref TEXT,
    code TEXT,
    at INTEGER NOT NULL,
    UNIQUE (share_ref, sequence)
  );
  -- Idempotent turn accounting: a turn is counted once, whatever replays it.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_session_share_turn_sent ON session_share_events(share_ref, turn_ref) WHERE type = 'turn_sent';
  CREATE TRIGGER IF NOT EXISTS trg_session_share_events_no_update BEFORE UPDATE ON session_share_events
  BEGIN
    SELECT RAISE(ABORT, 'session_share_events are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_session_share_events_no_delete BEFORE DELETE ON session_share_events
  BEGIN
    SELECT RAISE(ABORT, 'session_share_events are append-only');
  END;
`);

// ---------------------------------------------------------------------
// Clock and process identity (test seams).

let clock: () => number = () => Date.now();

export function setSessionShareClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

// A durable in-flight claim names the process that made it. A claim of
// another (earlier) process whose turn never committed is stale after a
// restart; one of this process is live while its ask runs.
let processId = randomBytes(9).toString('base64url');
const liveClaims = new Set<string>();

export function simulateSessionShareRestart(): void {
  processId = randomBytes(9).toString('base64url');
  liveClaims.clear();
}

// ---------------------------------------------------------------------
// The owner's share configuration document.

export const SESSION_SHARES_PATH_ENV = 'BOTMANCERS_SESSION_SHARES_PATH';
export const SESSION_SHARES_FILE = 'config/session-shares.json';
export const SESSION_SHARES_VERSION = 1;

const TEAM_ID = /^T[A-Z0-9]{2,20}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONFIG_MAX_BYTES = 64 * 1024;
const CONFIG_MAX_ENTRIES = 512;

export interface SessionSharesConfig {
  audiences: readonly SlackAudience[];
  shareFromTurn: ReadonlySet<string>;
}

export type SessionSharesState =
  | { state: 'absent'; path: string | null }
  | { state: 'invalid'; path: string; reason: string }
  | { state: 'loaded'; path: string; config: SessionSharesConfig };

export class SessionSharesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSharesConfigError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new SessionSharesConfigError(`${where} has an unknown field "${unknown}".`);
}

export function isSlackAudience(value: unknown): value is SlackAudience {
  return isObject(value) && Object.keys(value).every(key => ['kind', 'team_id', 'channel_id'].includes(key))
    && value.kind === 'slack' && typeof value.team_id === 'string' && TEAM_ID.test(value.team_id)
    && typeof value.channel_id === 'string' && CHANNEL_ID.test(value.channel_id);
}

// Parses and validates the document text; never returns a partial config.
export function parseSessionSharesConfig(text: string, knownAgents?: ReadonlySet<string>): SessionSharesConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new SessionSharesConfigError('The document is not valid JSON.');
  }
  if (!isObject(doc)) throw new SessionSharesConfigError('The document must be a JSON object.');
  onlyKeys(doc, ['version', 'audiences', 'agents'], 'The document');
  if (doc.version !== SESSION_SHARES_VERSION) throw new SessionSharesConfigError(`version must be ${SESSION_SHARES_VERSION}.`);
  const audiences = doc.audiences ?? [];
  const agents = doc.agents ?? [];
  if (!Array.isArray(audiences)) throw new SessionSharesConfigError('audiences must be a list.');
  if (!Array.isArray(agents)) throw new SessionSharesConfigError('agents must be a list.');
  if (audiences.length > CONFIG_MAX_ENTRIES || agents.length > CONFIG_MAX_ENTRIES) {
    throw new SessionSharesConfigError(`A list has more than ${CONFIG_MAX_ENTRIES} entries.`);
  }
  const seen = new Set<string>();
  const parsedAudiences: SlackAudience[] = audiences.map((entry, index) => {
    const where = `audiences[${index}]`;
    if (!isObject(entry)) throw new SessionSharesConfigError(`${where} must be an object.`);
    onlyKeys(entry, ['kind', 'team_id', 'channel_id'], where);
    if (!isSlackAudience(entry)) {
      throw new SessionSharesConfigError(`${where} must be { kind: "slack", team_id: "T…", channel_id: "C…" } with exact ids; wildcards are not allowed.`);
    }
    const key = `${entry.team_id}:${entry.channel_id}`;
    if (seen.has(key)) throw new SessionSharesConfigError(`${where} repeats an audience.`);
    seen.add(key);
    return Object.freeze({ kind: 'slack' as const, team_id: entry.team_id, channel_id: entry.channel_id });
  });
  const shareFromTurn = new Set<string>();
  const seenAgents = new Set<string>();
  agents.forEach((entry, index) => {
    const where = `agents[${index}]`;
    if (!isObject(entry)) throw new SessionSharesConfigError(`${where} must be an object.`);
    onlyKeys(entry, ['agent', 'share_from_turn'], where);
    if (typeof entry.agent !== 'string' || !AGENT_ID.test(entry.agent)) {
      throw new SessionSharesConfigError(`${where}.agent must be one Agent id; wildcards are not allowed.`);
    }
    if (knownAgents && !knownAgents.has(entry.agent)) throw new SessionSharesConfigError(`${where}.agent is not a registered Agent.`);
    if (typeof entry.share_from_turn !== 'boolean') throw new SessionSharesConfigError(`${where}.share_from_turn must be true or false.`);
    if (seenAgents.has(entry.agent)) throw new SessionSharesConfigError(`${where} repeats that Agent.`);
    seenAgents.add(entry.agent);
    if (entry.share_from_turn) shareFromTurn.add(entry.agent);
  });
  return { audiences: Object.freeze(parsedAudiences), shareFromTurn };
}

export function sessionSharesPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env[SESSION_SHARES_PATH_ENV] || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = botmancersHome(env);
  return home ? path.join(home, SESSION_SHARES_FILE) : null;
}

let configCache: { key: string; state: SessionSharesState } | null = null;

// The current document state, re-read when the file or the registered
// Agents change (so an edit applies on the next call, without a restart).
export function loadSessionSharesConfig(env: NodeJS.ProcessEnv = process.env): SessionSharesState {
  const file = sessionSharesPath(env);
  if (!file) return { state: 'absent', path: null };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', path: file };
    return { state: 'invalid', path: file, reason: 'The document cannot be read.' };
  }
  const agents = new Set((db.prepare('SELECT id FROM bots').all() as { id: string }[]).map(row => row.id));
  const agentsDigest = createHash('sha256').update([...agents].sort().join('\n'), 'utf8').digest('hex');
  const key = [file, stat.ino, stat.size, stat.mode, stat.uid, stat.mtimeMs, agentsDigest].join(':');
  if (configCache && configCache.key === key) return configCache.state;
  const state = readConfigState(file, stat, agents);
  configCache = { key, state };
  return state;
}

function readConfigState(file: string, stat: fs.Stats, agents: ReadonlySet<string>): SessionSharesState {
  if (!stat.isFile()) return { state: 'invalid', path: file, reason: 'The document is not a regular file.' };
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { state: 'invalid', path: file, reason: 'The document must be owned by the user running Botmancers.' };
  }
  if ((stat.mode & 0o077) !== 0) {
    return { state: 'invalid', path: file, reason: 'The document must not be readable or writable by group or others (chmod 600).' };
  }
  if (stat.size > CONFIG_MAX_BYTES) return { state: 'invalid', path: file, reason: `The document exceeds ${CONFIG_MAX_BYTES} bytes.` };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'invalid', path: file, reason: 'The document cannot be read.' };
  }
  try {
    return { state: 'loaded', path: file, config: parseSessionSharesConfig(text, agents) };
  } catch (error) {
    if (error instanceof SessionSharesConfigError) return { state: 'invalid', path: file, reason: error.message };
    throw error;
  }
}

export function resetSessionSharesConfigCache(): void {
  configCache = null;
}

export function audienceAllowed(audience: SlackAudience): boolean {
  const loaded = loadSessionSharesConfig();
  return loaded.state === 'loaded'
    && loaded.config.audiences.some(entry => entry.team_id === audience.team_id && entry.channel_id === audience.channel_id);
}

// The owner's per-Agent share-from-turn opt-in (default off; off for every
// Agent while the document is missing or invalid). Read on every call.
export function shareFromTurnEnabled(agentId: string): boolean {
  const loaded = loadSessionSharesConfig();
  return loaded.state === 'loaded' && loaded.config.shareFromTurn.has(agentId);
}

// ---------------------------------------------------------------------
// Rows, views, events.

const REF_LIMIT = 200;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function newShareRef(): string {
  return `shr_${randomBytes(16).toString('base64url')}`;
}

export function shareRow(shareRef: string): ShareRow | undefined {
  if (typeof shareRef !== 'string' || shareRef.length === 0 || shareRef.length > REF_LIMIT) return undefined;
  return db.prepare('SELECT * FROM session_shares WHERE id = ?').get(shareRef) as ShareRow | undefined;
}

function shareByKey(creator: Principal, key: string): ShareRow | undefined {
  return db.prepare('SELECT * FROM session_shares WHERE creator_kind = ? AND creator_id = ? AND idempotency_key = ?')
    .get(creator.kind, creator.id, key) as ShareRow | undefined;
}

export function shareState(row: ShareRow, now = clock()): ShareState {
  if (row.state === 'revoked') return 'revoked';
  return now >= row.expires_at ? 'expired' : 'active';
}

export function shareView(row: ShareRow, now = clock()): ShareView {
  return {
    share_ref: row.id,
    agent_id: row.agent_id,
    session_ref: row.session_ref,
    authority: 'ask',
    state: shareState(row, now),
    audience: { kind: 'slack', team_id: row.audience_team_id, channel_id: row.audience_channel_id },
    created_via: row.created_via,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    max_turns: row.max_turns,
    turns_used: row.turns_used,
  };
}

function appendEvent(shareRef: string, type: ShareEvent['type'], at: number, extra: { turnRef?: string | null; code?: string | null } = {}): void {
  db.prepare(`
    INSERT INTO session_share_events (share_ref, sequence, type, turn_ref, code, at)
    SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ? FROM session_share_events WHERE share_ref = ?
  `).run(shareRef, type, extra.turnRef ?? null, extra.code ?? null, at, shareRef);
}

export function shareEvents(shareRef: string): ShareEvent[] {
  return db.prepare('SELECT sequence, type, turn_ref, code, at FROM session_share_events WHERE share_ref = ? ORDER BY sequence ASC')
    .all(shareRef) as ShareEvent[];
}

// The creator's shares, newest first, optionally of one session.
export function sharesCreatedBy(creator: Principal, options: { sessionRef?: string | null } = {}): ShareRow[] {
  return (options.sessionRef
    ? db.prepare('SELECT * FROM session_shares WHERE creator_kind = ? AND creator_id = ? AND session_ref = ? ORDER BY created_at DESC, id ASC')
      .all(creator.kind, creator.id, options.sessionRef)
    : db.prepare('SELECT * FROM session_shares WHERE creator_kind = ? AND creator_id = ? ORDER BY created_at DESC, id ASC')
      .all(creator.kind, creator.id)) as ShareRow[];
}

// ---------------------------------------------------------------------
// Creating a share.

export interface CreateShareInput {
  creator: Principal;
  sessionRef: string;
  // Optional check: the Agent the caller expects to own the session.
  agentId?: string | null;
  audience: SlackAudience;
  ttlSeconds?: number | null;
  maxTurns?: number | null;
  idempotencyKey: string;
  createdVia?: ShareCreatedVia;
  // Runs inside the commit that creates the share (the service audit's
  // allowed event), and for an exact replay.
  onCommit?: (row: ShareRow) => void;
}

function bounded(value: number | null | undefined, limits: { min: number; default: number; max: number }, field: string): number {
  const resolved = value ?? limits.default;
  if (!Number.isInteger(resolved) || resolved < limits.min || resolved > limits.max) {
    throw new ShareError('invalid_request', `${field} must be an integer from ${limits.min} to ${limits.max}.`);
  }
  return resolved;
}

// The share pin's own key: derived from the creator and its key, so a retry
// after a crash reaches the same pin and never a second one.
function pinKeyOf(creator: Principal, key: string): string {
  return `share-${createHash('sha256').update(`${creator.kind}:${creator.id}\n${key}`).digest('hex').slice(0, 40)}`;
}

export async function createShare(input: CreateShareInput): Promise<{ share: ShareRow; created: boolean }> {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > REF_LIMIT) {
    throw new ShareError('invalid_request', `An idempotency key (1-${REF_LIMIT} characters) is required.`);
  }
  if (!isSlackAudience(input.audience)) {
    throw new ShareError('invalid_request', 'audience must be { kind: "slack", team_id: "T…", channel_id: "C…" }.');
  }
  const ttl = bounded(input.ttlSeconds, SHARE_LIMITS.ttl, 'ttl_seconds');
  const maxTurns = bounded(input.maxTurns, SHARE_LIMITS.turns, 'max_turns');
  const createdVia = input.createdVia ?? 'session_ref';
  const hash = sha256(['share', input.sessionRef, input.agentId ?? null, input.audience.team_id, input.audience.channel_id, ttl, maxTurns, createdVia]);
  const replay = shareByKey(input.creator, key);
  if (replay) {
    if (replay.request_hash !== hash) throw new ShareError('idempotency_conflict', 'That idempotency key was used for a different share.');
    db.transaction(() => input.onCommit?.(replay)).immediate();
    return { share: replay, created: false };
  }
  if (!audienceAllowed(input.audience)) {
    throw new ShareError('audience_not_allowed', 'That Slack channel is not on the share allowlist. Add it in Agent Config, under Session sharing.');
  }
  const agentId = sessionOwner(input.sessionRef);
  if (!agentId || (input.agentId && input.agentId !== agentId)) throw new ShareError('session_not_found', 'No session with that reference.');
  let inserted: ShareRow | null = null;
  // NOT-507 decides eligibility (ended, missing, not resumable): the share's
  // ask pin is created now on exactly this session, and the share row, its
  // created event, and the caller's audit event commit with it.
  const { pin } = await createPin({
    requester: SHARE_PRINCIPAL, sessionRef: input.sessionRef, agentId, action: 'ask', idempotencyKey: pinKeyOf(input.creator, key),
    onCommit: pinRow => {
      const now = clock();
      const shareRef = newShareRef();
      db.prepare(`
        INSERT INTO session_shares (
          id, creator_kind, creator_id, idempotency_key, request_hash, agent_id, session_ref, pin_ref, authority,
          audience_kind, audience_team_id, audience_channel_id, created_via, ttl_seconds, max_turns, turns_used, state,
          created_at, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ask', 'slack', ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
      `).run(
        shareRef, input.creator.kind, input.creator.id, key, hash, agentId, pinRow.session_ref, pinRow.id,
        input.audience.team_id, input.audience.channel_id, createdVia, ttl, maxTurns, now, now + ttl * 1000, now,
      );
      appendEvent(shareRef, 'created', now);
      inserted = shareRow(shareRef) as ShareRow;
      input.onCommit?.(inserted);
    },
  });
  if (inserted) return { share: inserted, created: true };
  // The pin already existed (a concurrent create with the same key won).
  const raced = db.prepare('SELECT * FROM session_shares WHERE pin_ref = ?').get(pin.id) as ShareRow | undefined;
  if (!raced) throw new ShareError('idempotency_conflict', 'That idempotency key is being used by a concurrent request; retry it.');
  if (raced.request_hash !== hash) throw new ShareError('idempotency_conflict', 'That idempotency key was used for a different share.');
  db.transaction(() => input.onCommit?.(raced)).immediate();
  return { share: raced, created: false };
}

// ---------------------------------------------------------------------
// Revoking a share: idempotent. The share's pin is detached in the same
// commit, so nothing can be sent on it afterwards.

export function revokeShare(shareRef: string, options: { onCommit?: (row: ShareRow) => void } = {}): { share: ShareRow; replayed: boolean } {
  return db.transaction(() => {
    const row = shareRow(shareRef);
    if (!row) throw new ShareError('share_not_found', 'No share with that reference.');
    if (row.state === 'revoked') {
      options.onCommit?.(row);
      return { share: row, replayed: true };
    }
    const now = clock();
    db.prepare("UPDATE session_shares SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(now, now, row.id);
    appendEvent(row.id, 'revoked', now);
    detachPin(SHARE_PRINCIPAL, row.pin_ref, { now });
    const updated = shareRow(row.id) as ShareRow;
    options.onCommit?.(updated);
    return { share: updated, replayed: false };
  }).immediate();
}

// ---------------------------------------------------------------------
// NOT-519: expiry. An expired share already refuses every question
// (shareState); the sweeper also detaches its Ask pin, so nothing can be
// sent on it by any path, and records that once in the service audit. It
// never changes the share row or its events (the share stays "expired", not
// "revoked"), never touches an active or revoked share, and is idempotent:
// a share whose pin is detached is not selected again. A turn already
// running when its share expires still finishes and is answered (a detached
// pin keeps its turns readable). Run at server start and periodically, so
// shares that expired while Botmancers was stopped are swept on restart.

export function sweepExpiredShares(): { swept: string[] } {
  const now = clock();
  const due = db.prepare(`
    SELECT s.id FROM session_shares s JOIN session_pins p ON p.id = s.pin_ref
    WHERE s.state = 'active' AND s.expires_at <= ? AND p.state = 'attached'
    ORDER BY s.expires_at, s.id LIMIT 500
  `).all(now) as { id: string }[];
  const swept: string[] = [];
  for (const { id } of due) {
    db.transaction(() => {
      const row = shareRow(id);
      if (!row || shareState(row, now) !== 'expired') return;
      const { replayed } = detachPin(SHARE_PRINCIPAL, row.pin_ref, { now });
      if (replayed) return;
      serviceAudit.append({
        principal: SHARE_PRINCIPAL, operation: 'shares.expire', capability: 'shares:ask', targetKind: 'session',
        targetRef: row.session_ref, agentId: row.agent_id, outcome: 'allowed', code: 'expired',
      });
      swept.push(id);
    }).immediate();
  }
  return { swept };
}

// NOT-519: what a share's in-flight markers mean for the owner: a question
// being answered now, or a claim an earlier Botmancers process made and
// never sent (freed by the next question, see settleInflight).
export function shareInflight(row: ShareRow): 'none' | 'answering' | 'recovering' {
  if (row.inflight_turn_ref) return 'answering';
  if (row.inflight_key) return row.inflight_owner === processId && liveClaims.has(row.id) ? 'answering' : 'recovering';
  return 'none';
}

// ---------------------------------------------------------------------
// Asking through a share (internal; the Slack relay's only entry).

export interface ShareTurn {
  turn_ref: string;
  state: PinTurnView['state'];
  // The redacted answer, bounded to SHARE_LIMITS.replyChars, once completed.
  answer: string | null;
  failure: { code: string } | null;
}

export interface AskShareResult {
  share: ShareView;
  turn: ShareTurn;
  replayed: boolean;
  // Resolves once the turn's result is recorded.
  settled: Promise<void>;
}

export interface AskShareInput {
  shareRef: string;
  question: string;
  // The canonical identity of the question (the Slack relay's hashed
  // message key): the NOT-507 pin-turn idempotency key, unchanged, so a lost
  // relay ledger still cannot dispatch twice.
  messageKey: string;
}

type AskFailureCode = ShareErrorCode | PinError['code'];

export class ShareAskError extends Error {
  readonly code: AskFailureCode;
  readonly status: number;
  constructor(code: AskFailureCode, message: string, status: number) {
    super(message);
    this.name = 'ShareAskError';
    this.code = code;
    this.status = status;
  }
}

function boundedAnswer(text: string | null): string | null {
  if (text === null) return null;
  const redacted = serviceRedactor().text(text);
  return redacted.length > SHARE_LIMITS.replyChars ? `${redacted.slice(0, SHARE_LIMITS.replyChars - 1)}…` : redacted;
}

function shareTurnOf(turn: PinTurnView): ShareTurn {
  return {
    turn_ref: turn.turn_ref,
    state: turn.state,
    answer: turn.state === 'completed' ? boundedAnswer(turn.answer) : null,
    failure: turn.failure ? { code: turn.failure.code } : null,
  };
}

async function pinTurn(row: ShareRow, turnRef: string): Promise<PinTurnView | null> {
  const { turns } = await readPin(SHARE_PRINCIPAL, row.pin_ref);
  return turns.find(turn => turn.turn_ref === turnRef) ?? null;
}

function existingTurnOnPin(messageKey: string): { pin_id: string } | undefined {
  return db.prepare('SELECT pin_id FROM session_pin_turns WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?')
    .get(SHARE_PRINCIPAL.kind, SHARE_PRINCIPAL.id, `turn:${messageKey}`) as { pin_id: string } | undefined;
}

function releaseClaim(shareRef: string, messageKey: string): void {
  db.prepare('UPDATE session_shares SET inflight_key = NULL, inflight_owner = NULL WHERE id = ? AND inflight_key = ? AND inflight_turn_ref IS NULL')
    .run(shareRef, messageKey);
}

// Clears an in-flight marker that no longer holds a running question: a
// finished turn, or a claim a previous process made and never committed.
async function settleInflight(row: ShareRow): Promise<'free' | 'busy'> {
  if (row.inflight_turn_ref) {
    const turn = await pinTurn(row, row.inflight_turn_ref);
    if (turn && turn.state === 'running') return 'busy';
    db.prepare('UPDATE session_shares SET inflight_turn_ref = NULL WHERE id = ? AND inflight_turn_ref = ?').run(row.id, row.inflight_turn_ref);
  }
  if (row.inflight_key) {
    if (row.inflight_owner === processId && liveClaims.has(row.id)) return 'busy';
    db.prepare('UPDATE session_shares SET inflight_key = NULL, inflight_owner = NULL WHERE id = ? AND inflight_key = ?').run(row.id, row.inflight_key);
  }
  return 'free';
}

export async function askShare(input: AskShareInput): Promise<AskShareResult> {
  const row = shareRow(input.shareRef);
  const audit = (outcome: 'allowed' | 'denied' | 'rejected', code: string | null) => serviceAudit.append({
    principal: SHARE_PRINCIPAL, operation: 'shares.ask', capability: 'shares:ask', targetKind: 'session',
    targetRef: row?.session_ref ?? null, agentId: row?.agent_id ?? null, outcome, code,
  });
  const fail = (code: AskFailureCode, message: string, status: number): never => {
    const outcome = code === 'invalid_request' || code === 'idempotency_conflict' ? 'rejected' : 'denied';
    db.transaction(() => {
      audit(outcome, code);
      if (row) appendEvent(row.id, 'turn_refused', clock(), { code });
    }).immediate();
    throw new ShareAskError(code, message, status);
  };
  const refuse = (code: ShareErrorCode, message: string): never => fail(code, message, SHARE_ERROR_STATUS[code]);
  if (!row) refuse('share_not_found', 'No share with that reference.');
  const share = row as ShareRow;
  if (typeof input.messageKey !== 'string' || input.messageKey.trim().length === 0 || input.messageKey.length > REF_LIMIT) {
    refuse('invalid_request', `A question key (1-${REF_LIMIT} characters) is required.`);
  }
  if (typeof input.question !== 'string' || input.question.trim().length === 0 || input.question.length > SHARE_LIMITS.questionChars) {
    refuse('invalid_request', `The question must be 1-${SHARE_LIMITS.questionChars} characters.`);
  }
  const state = shareState(share);
  if (state === 'revoked') refuse('share_revoked', 'This share was revoked.');
  if (state === 'expired') refuse('share_expired', 'This share has expired.');
  const send = () => sendPinTurn({
    requester: SHARE_PRINCIPAL, pinRef: share.pin_ref, content: input.question, idempotencyKey: input.messageKey,
    // The turn, its accounting, and the allowed audit event commit together.
    onCommit: (_pin, turn) => {
      const now = clock();
      const counted = db.prepare(`
        UPDATE session_shares SET turns_used = turns_used + 1, inflight_turn_ref = ?, inflight_key = NULL, inflight_owner = NULL, updated_at = ?
        WHERE id = ? AND turns_used < max_turns
      `).run(turn.id, now, share.id).changes;
      if (counted !== 1) throw new ShareError('share_turn_limit', 'This share has used all of its questions.');
      appendEvent(share.id, 'turn_sent', now, { turnRef: turn.id });
      audit('allowed', null);
    },
  });
  const mapped = (error: unknown): never => {
    if (error instanceof ShareAskError) throw error;
    if (error instanceof ShareError) refuse(error.code, error.message);
    if (error instanceof PinError) {
      // The pin is detached only by a revoke.
      if (error.code === 'pin_detached' || error.code === 'pin_not_found') refuse('share_revoked', 'This share was revoked.');
      fail(error.code, error.message, error.status);
    }
    throw error;
  };
  // An exact replay of a question already sent answers that turn again,
  // whatever happened since (in flight, limit reached), and writes nothing.
  const prior = existingTurnOnPin(input.messageKey);
  if (prior) {
    let result: Awaited<ReturnType<typeof sendPinTurn>>;
    try {
      result = await send();
    } catch (error) {
      return mapped(error);
    }
    if (result.replayed) audit('allowed', 'replayed');
    return { share: shareView(shareRow(share.id) as ShareRow), turn: shareTurnOf(result.turn), replayed: result.replayed, settled: result.settled };
  }
  if (share.turns_used >= share.max_turns) refuse('share_turn_limit', 'This share has used all of its questions.');
  if (await settleInflight(share) === 'busy') refuse('share_turn_in_progress', 'A question on this share is still being answered.');
  // Claim the share durably before anything is dispatched: a concurrent ask
  // loses here, and a crash leaves a claim the next process recovers.
  const claimed = db.prepare(`
    UPDATE session_shares SET inflight_key = ?, inflight_owner = ?
    WHERE id = ? AND state = 'active' AND inflight_key IS NULL AND inflight_turn_ref IS NULL AND turns_used < max_turns
  `).run(input.messageKey, processId, share.id).changes === 1;
  if (!claimed) {
    const now = shareRow(share.id) as ShareRow;
    if (shareState(now) === 'revoked') refuse('share_revoked', 'This share was revoked.');
    if (now.turns_used >= now.max_turns) refuse('share_turn_limit', 'This share has used all of its questions.');
    refuse('share_turn_in_progress', 'A question on this share is still being answered.');
  }
  liveClaims.add(share.id);
  try {
    const result = await send();
    return { share: shareView(shareRow(share.id) as ShareRow), turn: shareTurnOf(result.turn), replayed: result.replayed, settled: result.settled };
  } catch (error) {
    releaseClaim(share.id, input.messageKey);
    return mapped(error);
  } finally {
    liveClaims.delete(share.id);
  }
}

// The bounded, redacted answer of one turn of the share, or null while it
// runs. A finished turn frees the share for its next question.
export async function shareAnswer(shareRef: string, turnRef: string): Promise<ShareTurn | null> {
  const row = shareRow(shareRef);
  if (!row) throw new ShareError('share_not_found', 'No share with that reference.');
  const turn = await pinTurn(row, turnRef);
  if (!turn) throw new ShareError('share_not_found', 'No turn with that reference on this share.');
  if (turn.state === 'running') return null;
  db.prepare('UPDATE session_shares SET inflight_turn_ref = NULL WHERE id = ? AND inflight_turn_ref = ?').run(row.id, turnRef);
  return shareTurnOf(turn);
}
