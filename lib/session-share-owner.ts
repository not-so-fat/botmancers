// NOT-519: the owner's lifecycle surface for temporary session shares
// (docs/session-shares.md; design §6 child 5). Everything here is behind the
// loopback owner boundary (proxy.ts, lib/owner-boundary) and the owner-only
// guard below; services keep their own /api/v0 shares routes (NOT-515).
//
//   - owner views of every share (whoever created it): state, a display
//     status (active, exhausted, answering, recovering, expired, revoked),
//     expiry, turn usage, audience, and whether its Slack thread is posted.
//     Botmancers references and owner-chosen Slack ids only: never a
//     provider id, working directory, Deck, runtime, token, or transcript;
//   - newest-first pagination with an opaque cursor;
//   - create (the owner is the creator) and an idempotent revoke, both the
//     NOT-515 store's own (createShare / revokeShare);
//   - the share policy: the Slack audience allowlist and each Agent's
//     share_from_turn, read from and written to config/session-shares.json
//     with the store's own validator, atomically (0600, rename), only over
//     the revision the owner saw. Turning share_from_turn off revokes the
//     Agent's live SessionContexts in the same call (NOT-517);
//   - the expired-share sweeper's server loop.
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import db, { UI_OWNER_PRINCIPAL, bots } from './db';
import {
  SHARE_LIMITS,
  ShareError,
  createShare,
  loadSessionSharesConfig,
  parseSessionSharesConfig,
  resetSessionSharesConfigCache,
  revokeShare,
  sessionSharesPath,
  shareInflight,
  shareRow,
  shareState,
  shareToolAccess,
  sweepExpiredShares,
  isSlackAudience,
  SessionSharesConfigError,
  SESSION_SHARES_VERSION,
  type ShareRow,
  type ShareState,
  type ShareToolAccess,
  type SlackAudience,
} from './session-shares';
import { revokeAgentSessionContexts } from './session-context';
import { agentProviderCapabilities } from './provider-sessions';
import { SESSION_CONTEXT_HEADER } from './session-context-launch';

export class OwnerShareError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'OwnerShareError';
    this.code = code;
    this.status = status;
  }
}

export function ownerShareErrorBody(error: unknown): { body: { error: { code: string; message: string } }; status: number } {
  if (error instanceof OwnerShareError) return { body: { error: { code: error.code, message: error.message } }, status: error.status };
  if (error instanceof ShareError) return { body: { error: { code: error.code, message: error.message } }, status: error.status };
  const code = (error as { code?: unknown })?.code;
  const status = (error as { status?: unknown })?.status;
  if (typeof code === 'string' && typeof status === 'number' && /^[a-z_]{1,64}$/.test(code)) {
    return { body: { error: { code, message: (error as Error).message } }, status };
  }
  console.error('Session share owner route failed:', error instanceof Error ? error.message : 'unknown error');
  return { body: { error: { code: 'internal_error', message: 'The share request failed.' } }, status: 500 };
}

// The owner boundary (proxy.ts) proves loopback and same-origin. A request
// that presents a service credential (a bearer token or a session context)
// is a service, not the owner, whatever its origin: it is refused here too.
export function requireOwnerCaller(request: Request): void {
  if (request.headers.get('authorization') !== null || request.headers.get(SESSION_CONTEXT_HEADER) !== null) {
    throw new OwnerShareError('owner_origin_required', 'Owner share routes are for the Botmancers UI; services use /api/v0/shares.', 403);
  }
}

// ---------------------------------------------------------------------
// Views.

export type OwnerShareStatus = 'active' | 'exhausted' | 'answering' | 'recovering' | 'expired' | 'revoked';

export interface OwnerShareView {
  share_ref: string;
  agent: { id: string; name: string | null };
  session_ref: string;
  authority: 'ask';
  // read_only, or full_access (edits, shell, network) the owner granted.
  tool_access: ShareToolAccess;
  state: ShareState;
  status: OwnerShareStatus;
  audience: SlackAudience;
  created_via: ShareRow['created_via'];
  created_by: 'owner' | 'service' | 'current_session';
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  max_turns: number;
  turns_used: number;
  // The share's Slack thread: posted once the relay anchors it.
  thread: { posted: boolean; posted_at: number | null };
}

function threadOf(shareRef: string): { posted: boolean; posted_at: number | null } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'slack_share_threads'").get()) return { posted: false, posted_at: null };
  const row = db.prepare('SELECT created_at FROM slack_share_threads WHERE share_ref = ?').get(shareRef) as { created_at: number } | undefined;
  return row ? { posted: true, posted_at: row.created_at } : { posted: false, posted_at: null };
}

export function ownerShareStatus(row: ShareRow, now?: number): OwnerShareStatus {
  const state = shareState(row, now);
  if (state !== 'active') return state;
  const inflight = shareInflight(row);
  if (inflight !== 'none') return inflight;
  return row.turns_used >= row.max_turns ? 'exhausted' : 'active';
}

export function ownerShareView(row: ShareRow, now?: number): OwnerShareView {
  return {
    share_ref: row.id,
    agent: { id: row.agent_id, name: bots.getById(row.agent_id)?.name ?? null },
    session_ref: row.session_ref,
    authority: 'ask',
    tool_access: shareToolAccess(row),
    state: shareState(row, now),
    status: ownerShareStatus(row, now),
    audience: { kind: 'slack', team_id: row.audience_team_id, channel_id: row.audience_channel_id },
    created_via: row.created_via,
    created_by: row.created_via === 'current_session' ? 'current_session'
      : row.creator_kind === UI_OWNER_PRINCIPAL.kind && row.creator_id === UI_OWNER_PRINCIPAL.id ? 'owner' : 'service',
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    max_turns: row.max_turns,
    turns_used: row.turns_used,
    thread: threadOf(row.id),
  };
}

// ---------------------------------------------------------------------
// Listing.

export const OWNER_SHARE_PAGE = Object.freeze({ default: 50, max: 100 });
const LIST_PARAMS = ['session_ref', 'agent_id', 'state', 'cursor', 'limit'];
const STATES: ShareState[] = ['active', 'expired', 'revoked'];

function encodeCursor(row: { created_at: number; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: number; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && Number.isInteger(parsed[0]) && typeof parsed[1] === 'string' && /^shr_[A-Za-z0-9_-]{1,64}$/.test(parsed[1])) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch { /* invalid below */ }
  throw new OwnerShareError('invalid_request', 'cursor is not one this list returned.', 400);
}

export function listOwnerShares(params: URLSearchParams): { shares: OwnerShareView[]; next_cursor: string | null } {
  for (const name of params.keys()) {
    if (!LIST_PARAMS.includes(name)) throw new OwnerShareError('invalid_request', `${name} is not a parameter of this list.`, 400);
  }
  const one = (name: string): string | null => {
    const values = params.getAll(name);
    if (values.length > 1) throw new OwnerShareError('invalid_request', `${name} may be given once.`, 400);
    if (values.length === 0) return null;
    if (values[0].trim() === '' || values[0].length > 200) throw new OwnerShareError('invalid_request', `${name} must be one value.`, 400);
    return values[0];
  };
  const sessionRef = one('session_ref');
  const agentId = one('agent_id');
  const state = one('state');
  if (state !== null && !(STATES as string[]).includes(state)) throw new OwnerShareError('invalid_request', 'state must be active, expired, or revoked.', 400);
  const limitText = one('limit');
  const limit = limitText === null ? OWNER_SHARE_PAGE.default : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > OWNER_SHARE_PAGE.max) {
    throw new OwnerShareError('invalid_request', `limit must be an integer from 1 to ${OWNER_SHARE_PAGE.max}.`, 400);
  }
  const cursorText = one('cursor');
  const after = cursorText === null ? null : decodeCursor(cursorText);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (sessionRef !== null) { where.push('session_ref = ?'); args.push(sessionRef); }
  if (agentId !== null) { where.push('agent_id = ?'); args.push(agentId); }
  if (after) { where.push('(created_at < ? OR (created_at = ? AND id > ?))'); args.push(after.at, after.at, after.id); }
  const rows = db.prepare(`SELECT * FROM session_shares ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id ASC`)
    .all(...args) as ShareRow[];
  const matching = state === null ? rows : rows.filter(row => shareState(row) === state);
  const page = matching.slice(0, limit);
  return {
    shares: page.map(row => ownerShareView(row)),
    next_cursor: matching.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

export function requireOwnerShare(shareRef: string): ShareRow {
  const row = shareRow(shareRef);
  if (!row) throw new OwnerShareError('share_not_found', 'No share with that reference.', 404);
  return row;
}

// ---------------------------------------------------------------------
// Create and revoke.

const CREATE_FIELDS = ['audience', 'ttl_seconds', 'max_turns', 'tool_access', 'idempotency_key'];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new OwnerShareError('invalid_request', `${field} must be an integer.`, 400);
  return value;
}

export async function createOwnerShare(agentId: string, sessionRef: string, body: unknown): Promise<{ share: OwnerShareView; replayed: boolean }> {
  if (!bots.getById(agentId)) throw new OwnerShareError('session_not_found', 'No session with that reference.', 404);
  if (!isObject(body)) throw new OwnerShareError('invalid_request', 'The body must be a JSON object.', 400);
  const unknown = Object.keys(body).find(key => !CREATE_FIELDS.includes(key));
  if (unknown !== undefined) throw new OwnerShareError('invalid_request', `${unknown} is not a field of this request.`, 400);
  const audience = isObject(body.audience) ? { kind: 'slack', ...body.audience } : body.audience;
  if (!isSlackAudience(audience)) {
    throw new OwnerShareError('invalid_request', 'audience must be { team_id: "T…", channel_id: "C…" } from the share allowlist.', 400);
  }
  const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
  const toolAccess = body.tool_access ?? 'read_only';
  if (toolAccess !== 'read_only' && toolAccess !== 'full_access') {
    throw new OwnerShareError('invalid_request', 'tool_access must be "read_only" or "full_access".', 400);
  }
  const { share, created } = await createShare({
    creator: UI_OWNER_PRINCIPAL, sessionRef, agentId, audience,
    ttlSeconds: optionalInteger(body.ttl_seconds, 'ttl_seconds'), maxTurns: optionalInteger(body.max_turns, 'max_turns'),
    toolAccess, idempotencyKey: key, createdVia: 'session_ref',
  });
  return { share: ownerShareView(share), replayed: !created };
}

export function revokeOwnerShare(shareRef: string): { share: OwnerShareView; replayed: boolean } {
  requireOwnerShare(shareRef);
  const { share, replayed } = revokeShare(shareRef);
  return { share: ownerShareView(share), replayed };
}

// ---------------------------------------------------------------------
// The share policy (config/session-shares.json).

// share-current needs a per-launch MCP seam (design §1): Claude Code and
// Codex have one, Cursor and other runtimes do not.
const SHARE_CURRENT_PROVIDERS = new Set(['claude-code', 'codex-direct']);

export interface SharePolicyView {
  state: 'absent' | 'loaded' | 'invalid';
  // The first problem with the document, when it is invalid. Never its text.
  reason: string | null;
  // Pass back on update: the document changed since it was read otherwise.
  revision: string;
  audiences: SlackAudience[];
  agent: {
    id: string;
    share_from_turn: boolean;
    share_current: { supported: boolean; reason: string | null };
    // Whether a share of this Agent's sessions can be given full access.
    full_access: { supported: boolean; reason: string | null };
    live_contexts: number;
  };
  limits: { ttl_seconds: typeof SHARE_LIMITS.ttl; max_turns: typeof SHARE_LIMITS.turns; audiences: number };
}

const MAX_AUDIENCES = 512;

function revisionOf(file: string | null): { revision: string; text: string | null } {
  if (!file) return { revision: 'absent', text: null };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { revision: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32), text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 'absent', text: null };
    return { revision: 'unreadable', text: null };
  }
}

function shareCurrentSupport(agentId: string): { supported: boolean; reason: string | null } {
  let kind: string | null = null;
  try {
    kind = agentProviderCapabilities(db, agentId)?.provider_kind ?? null;
  } catch {
    kind = null;
  }
  if (kind && SHARE_CURRENT_PROVIDERS.has(kind)) return { supported: true, reason: null };
  return {
    supported: false,
    reason: kind === 'cursor'
      ? 'Cursor has no per-launch MCP configuration, so a Cursor turn cannot share its own session. Share it from Sessions instead.'
      : 'This runtime cannot share its own session from a turn. Share it from Sessions instead.',
  };
}

function fullAccessSupport(agentId: string): { supported: boolean; reason: string | null } {
  let authorities: readonly string[] = [];
  try {
    authorities = agentProviderCapabilities(db, agentId)?.authorities ?? [];
  } catch {
    authorities = [];
  }
  return authorities.includes('full_access')
    ? { supported: true, reason: null }
    : { supported: false, reason: 'This runtime cannot run shared turns with full access. Claude Code and Codex Agents can.' };
}

function liveContexts(agentId: string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_contexts'").get()) return 0;
  return (db.prepare("SELECT COUNT(*) AS n FROM session_contexts WHERE agent_id = ? AND state = 'live'").get(agentId) as { n: number }).n;
}

export function sharePolicyView(agentId: string): SharePolicyView {
  if (!bots.getById(agentId)) throw new OwnerShareError('agent_not_found', 'Agent not found.', 404);
  const loaded = loadSessionSharesConfig();
  const { revision } = revisionOf(loaded.path);
  return {
    state: loaded.state,
    reason: loaded.state === 'invalid' ? loaded.reason : null,
    revision,
    audiences: loaded.state === 'loaded' ? loaded.config.audiences.map(a => ({ kind: 'slack' as const, team_id: a.team_id, channel_id: a.channel_id })) : [],
    agent: {
      id: agentId,
      share_from_turn: loaded.state === 'loaded' && loaded.config.shareFromTurn.has(agentId),
      share_current: shareCurrentSupport(agentId),
      full_access: fullAccessSupport(agentId),
      live_contexts: liveContexts(agentId),
    },
    limits: { ttl_seconds: SHARE_LIMITS.ttl, max_turns: SHARE_LIMITS.turns, audiences: MAX_AUDIENCES },
  };
}

interface PolicyDocument {
  version: number;
  audiences: { kind: 'slack'; team_id: string; channel_id: string }[];
  agents: { agent: string; share_from_turn: boolean }[];
}

function currentDocument(text: string | null, known: ReadonlySet<string>): PolicyDocument {
  if (text === null) return { version: SESSION_SHARES_VERSION, audiences: [], agents: [] };
  // Valid apart from Agents that no longer exist (pruned on write); any
  // other problem is the owner's to fix in the file: nothing is overwritten.
  try {
    parseSessionSharesConfig(text);
  } catch (error) {
    if (error instanceof SessionSharesConfigError) {
      throw new OwnerShareError('policy_invalid', `config/session-shares.json is invalid (${error.message}) Fix or remove the file, then reload.`, 409);
    }
    throw error;
  }
  const doc = JSON.parse(text) as Partial<PolicyDocument>;
  return {
    version: SESSION_SHARES_VERSION,
    audiences: (doc.audiences ?? []).map(a => ({ kind: 'slack' as const, team_id: a.team_id, channel_id: a.channel_id })),
    agents: (doc.agents ?? []).filter(entry => known.has(entry.agent)).map(entry => ({ agent: entry.agent, share_from_turn: entry.share_from_turn })),
  };
}

function parseAudiences(value: unknown): PolicyDocument['audiences'] {
  if (!Array.isArray(value)) throw new OwnerShareError('invalid_request', 'audiences must be a list.', 400);
  if (value.length > MAX_AUDIENCES) throw new OwnerShareError('invalid_request', `At most ${MAX_AUDIENCES} audiences.`, 400);
  return value.map((entry, index) => {
    if (!isObject(entry)) throw new OwnerShareError('invalid_request', `audiences[${index}] must be { team_id, channel_id }.`, 400);
    const unknown = Object.keys(entry).find(key => !['kind', 'team_id', 'channel_id'].includes(key));
    if (unknown !== undefined) throw new OwnerShareError('invalid_request', `audiences[${index}] has an unknown field "${unknown}".`, 400);
    if (entry.kind !== undefined && entry.kind !== 'slack') throw new OwnerShareError('invalid_request', `audiences[${index}].kind must be "slack".`, 400);
    return { kind: 'slack' as const, team_id: entry.team_id as string, channel_id: entry.channel_id as string };
  });
}

function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export interface SharePolicyUpdate {
  view: SharePolicyView;
  revoked_contexts: number;
}

// Applies { revision, share_from_turn?, audiences? } for one Agent. The
// whole new document is validated by the store's own parser before it is
// written; nothing is written when anything is wrong (fail closed).
export function updateSharePolicy(agentId: string, body: unknown): SharePolicyUpdate {
  if (!bots.getById(agentId)) throw new OwnerShareError('agent_not_found', 'Agent not found.', 404);
  if (!isObject(body)) throw new OwnerShareError('invalid_request', 'The body must be a JSON object.', 400);
  const unknown = Object.keys(body).find(key => !['revision', 'share_from_turn', 'audiences'].includes(key));
  if (unknown !== undefined) throw new OwnerShareError('invalid_request', `${unknown} is not a field of this request.`, 400);
  if (typeof body.revision !== 'string' || body.revision.length === 0 || body.revision.length > 64) {
    throw new OwnerShareError('invalid_request', 'revision (from the policy you are editing) is required.', 400);
  }
  if (body.share_from_turn !== undefined && typeof body.share_from_turn !== 'boolean') {
    throw new OwnerShareError('invalid_request', 'share_from_turn must be true or false.', 400);
  }
  if (body.share_from_turn === undefined && body.audiences === undefined) {
    throw new OwnerShareError('invalid_request', 'Give share_from_turn, audiences, or both.', 400);
  }
  const file = sessionSharesPath();
  if (!file) throw new OwnerShareError('policy_unavailable', 'Botmancers has no home directory to keep the share policy in.', 409);
  const known = new Set((db.prepare('SELECT id FROM bots').all() as { id: string }[]).map(row => row.id));
  // Read, compare, and write without yielding: concurrent updates in this
  // process are serialized, and one that read an older document loses.
  const { revision, text } = revisionOf(file);
  if (revision === 'unreadable') throw new OwnerShareError('policy_invalid', 'config/session-shares.json cannot be read.', 409);
  if (body.revision !== revision) {
    throw new OwnerShareError('policy_conflict', 'The share policy changed since you loaded it. Reload and apply your change again.', 409);
  }
  const doc = currentDocument(text, known);
  if (body.audiences !== undefined) doc.audiences = parseAudiences(body.audiences);
  const wasOn = doc.agents.some(entry => entry.agent === agentId && entry.share_from_turn);
  if (body.share_from_turn !== undefined) {
    doc.agents = doc.agents.filter(entry => entry.agent !== agentId);
    doc.agents.push({ agent: agentId, share_from_turn: body.share_from_turn as boolean });
    doc.agents.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  }
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    parseSessionSharesConfig(next, known);
  } catch (error) {
    if (error instanceof SessionSharesConfigError) throw new OwnerShareError('invalid_request', error.message, 400);
    throw error;
  }
  writeAtomically(file, next);
  resetSessionSharesConfigCache();
  // Off now: every live context of the Agent is revoked in this call, not
  // only on its next use.
  const revoked = wasOn && body.share_from_turn === false ? revokeAgentSessionContexts(agentId) : 0;
  return { view: sharePolicyView(agentId), revoked_contexts: revoked };
}

// ---------------------------------------------------------------------
// The sweeper's server loop (instrumentation.ts): once at start (shares
// that expired while Botmancers was stopped), then every minute.

export const SHARE_SWEEP_MS = 60_000;
const SWEEPER_KEY = Symbol.for('botmancers.share-sweeper');

export function runShareSweeperInServer(intervalMs = SHARE_SWEEP_MS): void {
  if (process.env.BOTMANCERS_NO_AUTOPROCESS === '1') return;
  const holder = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
  if (holder[SWEEPER_KEY]) return;
  const sweep = () => {
    try {
      const { swept } = sweepExpiredShares();
      if (swept.length) console.log(`Session shares: detached ${swept.length} expired share${swept.length === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('Session share sweep failed:', error instanceof Error ? error.message : 'unknown error');
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  holder[SWEEPER_KEY] = timer;
}
