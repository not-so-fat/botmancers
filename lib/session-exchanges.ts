// NOT-497: session-targeted Ask and Continue exchanges (docs/core-engine.md,
// Session exchanges).
//
// The owner names one Agent session by its Botmancers reference (the
// Session Binding id, lib/session-catalog) and either
//
//   - asks it one bounded question (Ask): exactly one read-only
//     conversation turn that resumes that exact binding, whose answer is
//     returned to the origin conversation; or
//   - hands its context to another Agent (Continue): one read-only turn on
//     the source binding extracts a bounded, structured handoff packet;
//     only once that packet is stored does a second read-only turn launch
//     the destination Agent in a fresh session it owns. The destination
//     never resumes, adopts, or sees the source provider session id.
//
// Each hop is a canonical Work Request run by the leased dispatcher
// (lib/agent-conversations), under the session_exchange_conversation
// execution policy (read-only only, lib/execution-policy), one Attempt, and
// no Wake routing from any hop's output. The exchange row is
// durable: hop creation, claim, and result projection commit in the same
// transaction as the exchange state they move, and advanceExchange derives
// any remaining step from the hops' durable state, so a restart (or a hop
// that failed without a result) leaves a truthful state. A failed or
// cancelled exchange is never retried automatically; a new exchange with a
// new idempotency key is the retry.
//
// Rows and events hold Botmancers ids only: never a provider session id or
// a credential. A packet or answer that echoes the source provider session
// id is redacted before it is stored or delivered.
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { resolveAgent } from './bot-definition';
import {
  EXCHANGE_LIMITS,
  EXCHANGE_TERMINAL_STATES,
  EXCHANGE_TRANSITIONS,
  TERMINAL_STATES,
  type EngineStore,
  type ExchangeMode,
  type ExchangeState,
  type SessionBinding,
  type WorkAttempt,
  type WorkRequest,
} from './engine-store';
import { selectExecutionPolicy } from './execution-policy';
import { DEFAULT_RETRY_POLICY } from './request-policy';
import { WAKE_SAFETY_VERSION } from './wake-safety';
import type { AttemptResult } from './attempt-adapter';
import type { DispatchHistoryEntry } from './agent-dispatch';

export { EXCHANGE_LIMITS };
export type { ExchangeMode, ExchangeState };

type Db = Database.Database;

// Hop Work Requests are requested by this engine service on the owner's
// behalf; the owner stays the requester of the exchange and the safety
// principal of every hop.
export const EXCHANGE_REQUESTER = Object.freeze({ kind: 'service' as const, id: 'botmancers-exchanges' });
export const EXCHANGE_SPEAKER = 'Botmancers';
export const EXCHANGE_MODES: readonly ExchangeMode[] = ['ask', 'continue'];

export type ExchangeHop = 'ask' | 'extract' | 'deliver';

export interface SessionExchange {
  id: string;
  requester_kind: 'person' | 'bot' | 'service';
  requester_id: string;
  idempotency_key: string;
  request_hash: string;
  mode: ExchangeMode;
  origin_conversation_id: string;
  source_agent_id: string;
  source_binding_id: string;
  destination_agent_id: string | null;
  destination_conversation_id: string | null;
  destination_binding_id: string | null;
  instruction: string;
  state: ExchangeState;
  source_request_id: string | null;
  source_attempt_id: string | null;
  destination_request_id: string | null;
  destination_attempt_id: string | null;
  answer_message_id: string | null;
  packet: string | null;
  failure_code: string | null;
  failure_message: string | null;
  cancel_requested_at: number | null;
  cancel_requested_by: string | null;
  cancel_reason: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface ExchangeEvent {
  id: string;
  exchange_id: string;
  sequence: number;
  type: string;
  data: string | null;
  created_at: number;
}

export type ExchangeErrorCode =
  | 'invalid_request'
  | 'authority_not_allowed'
  | 'recursive_exchange'
  | 'conversation_not_found'
  | 'agent_not_found'
  | 'session_not_found'
  | 'session_ended'
  | 'session_not_resumable'
  | 'source_session_busy'
  | 'agent_unavailable'
  | 'destination_invalid'
  | 'idempotency_conflict'
  | 'exchange_not_found'
  | 'exchange_terminal'
  | 'invalid_transition';

export const EXCHANGE_ERROR_STATUS: Record<ExchangeErrorCode, number> = {
  invalid_request: 400,
  authority_not_allowed: 403,
  recursive_exchange: 403,
  conversation_not_found: 404,
  agent_not_found: 404,
  session_not_found: 404,
  session_ended: 409,
  session_not_resumable: 409,
  source_session_busy: 409,
  agent_unavailable: 409,
  destination_invalid: 400,
  idempotency_conflict: 409,
  exchange_not_found: 404,
  exchange_terminal: 409,
  invalid_transition: 409,
};

export class ExchangeError extends Error {
  readonly code: ExchangeErrorCode;
  constructor(code: ExchangeErrorCode, message: string) {
    super(message);
    this.name = 'ExchangeError';
    this.code = code;
  }
  get status(): number {
    return EXCHANGE_ERROR_STATUS[this.code];
  }
}

export interface CreateExchangeInput {
  requester: { kind: 'person' | 'bot' | 'service'; id: string };
  idempotencyKey: string;
  mode: ExchangeMode;
  originConversationId: string;
  sourceAgentId: string;
  sessionRef: string;
  destinationAgentId?: string | null;
  destinationConversationId?: string | null;
  instruction: string;
  // A caller asking for other authority is refused; the only kind an
  // exchange runs is a read-only conversation turn.
  executionKind?: unknown;
  now?: number;
}

export interface HandoffPacket {
  objective: string;
  decisions: string[];
  constraints: string[];
  artifacts: string[];
  open_questions: string[];
}

const PACKET_LISTS = ['decisions', 'constraints', 'artifacts', 'open_questions'] as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function redact(text: string, secret: string | null): string {
  return secret && secret.length > 0 ? text.split(secret).join('[redacted session id]') : text;
}

const TRUNCATED = '\n[truncated]';

// At most `limit` characters, the truncation marker included.
export function boundOutput(text: string, limit: number): { content: string; truncated: boolean } {
  if (text.length <= limit) return { content: text, truncated: false };
  if (limit <= TRUNCATED.length) return { content: text.slice(0, limit), truncated: true };
  return { content: `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`, truncated: true };
}

function firstLine(text: string, limit = 80): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

// The bounded, structured handoff packet a Continue extraction must
// return: exactly one JSON object (optionally in a ```json fence) with a
// non-empty objective and string lists, within EXCHANGE_LIMITS. Unknown
// fields are dropped. Anything else is refused with an actionable reason.
export function parseHandoffPacket(output: string): { ok: true; packet: HandoffPacket } | { ok: false; reason: string } {
  if (output.length > EXCHANGE_LIMITS.extractionOutputChars) {
    return { ok: false, reason: `The extraction output exceeds ${EXCHANGE_LIMITS.extractionOutputChars} characters.` };
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  const body = (fenced ? fenced[1] : output).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, reason: 'The handoff packet is not a JSON object.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'The handoff packet is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'The handoff packet is not a JSON object.' };
  const input = parsed as Record<string, unknown>;
  if (!nonEmpty(input.objective)) return { ok: false, reason: 'The handoff packet has no objective.' };
  if (input.objective.length > EXCHANGE_LIMITS.packetObjectiveChars) {
    return { ok: false, reason: `The handoff packet objective exceeds ${EXCHANGE_LIMITS.packetObjectiveChars} characters.` };
  }
  const packet: HandoffPacket = { objective: input.objective.trim(), decisions: [], constraints: [], artifacts: [], open_questions: [] };
  for (const key of PACKET_LISTS) {
    const value = input[key] ?? [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return { ok: false, reason: `The handoff packet field ${key} must be a list of strings.` };
    }
    if (value.length > EXCHANGE_LIMITS.packetListItems) {
      return { ok: false, reason: `The handoff packet field ${key} has ${value.length} entries (limit ${EXCHANGE_LIMITS.packetListItems}).` };
    }
    if (value.some(item => item.length > EXCHANGE_LIMITS.packetItemChars)) {
      return { ok: false, reason: `An entry of the handoff packet field ${key} exceeds ${EXCHANGE_LIMITS.packetItemChars} characters.` };
    }
    packet[key] = (value as string[]).map(item => item.trim()).filter(item => item.length > 0);
  }
  if (JSON.stringify(packet).length > EXCHANGE_LIMITS.packetChars) {
    return { ok: false, reason: `The handoff packet exceeds ${EXCHANGE_LIMITS.packetChars} characters.` };
  }
  return { ok: true, packet };
}

function redactPacket(packet: HandoffPacket, secret: string | null): HandoffPacket {
  return {
    objective: redact(packet.objective, secret),
    decisions: packet.decisions.map(item => redact(item, secret)),
    constraints: packet.constraints.map(item => redact(item, secret)),
    artifacts: packet.artifacts.map(item => redact(item, secret)),
    open_questions: packet.open_questions.map(item => redact(item, secret)),
  };
}

const READ_ONLY_RULES = 'This is a read-only turn: do not edit files, change state, start other work, or emit Wakes.';

function askPrompt(exchangeId: string, instruction: string): string {
  return [
    `[Session Ask from the owner] Exchange: ${exchangeId}`,
    `Answer one question from the context of this session. ${READ_ONLY_RULES} Reply with the answer only.`,
    `Question:\n${instruction}`,
  ].join('\n\n');
}

function extractionPrompt(exchangeId: string, destinationName: string, instruction: string): string {
  return [
    `[Session Continue handoff from the owner] Exchange: ${exchangeId}`,
    `The owner is handing this session's work to ${destinationName}, who starts a fresh session and cannot see this one. ${READ_ONLY_RULES}`,
    'Reply with exactly one JSON object and nothing else:',
    '{"objective": string, "decisions": [string], "constraints": [string], "artifacts": [string], "open_questions": [string]}',
    `objective: what ${destinationName} should achieve. decisions: what was decided and why. constraints: requirements and limits to respect. artifacts: files, branches, Work Requests, and other references. open_questions: what is still unresolved.`,
    `Limits: objective at most ${EXCHANGE_LIMITS.packetObjectiveChars} characters; each list at most ${EXCHANGE_LIMITS.packetListItems} entries of at most ${EXCHANGE_LIMITS.packetItemChars} characters.`,
    `Owner instruction:\n${instruction}`,
  ].join('\n\n');
}

function packetList(title: string, items: string[]): string {
  return `${title}:\n${items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '(none)'}`;
}

// The first line names the handoff (the destination session's title in the
// session catalog).
function deliveryPrompt(exchangeId: string, sourceName: string, packet: HandoffPacket, instruction: string): string {
  return [
    `Continue from ${sourceName}: ${firstLine(packet.objective)}`,
    `[Session Continue] Exchange: ${exchangeId}`,
    `The owner handed you this work from ${sourceName}'s session. You start a fresh session of your own: ${sourceName}'s session is not available to you, and this handoff packet is everything carried over.`,
    `Objective:\n${packet.objective}`,
    packetList('Decisions', packet.decisions),
    packetList('Constraints', packet.constraints),
    packetList('Artifacts and references', packet.artifacts),
    packetList('Open questions', packet.open_questions),
    `Owner instruction:\n${instruction}`,
  ].join('\n\n');
}

interface HopPolicy {
  source?: unknown;
  exchange_id?: unknown;
  hop?: unknown;
  resume_session_binding?: unknown;
}

export interface HopRef {
  exchangeId: string;
  hop: ExchangeHop;
  resumeBindingId: string | null;
}

// The exchange hop a Work Request runs, or null for any other request.
// Only this service's own requests count, whatever a policy claims.
export function hopOf(request: Pick<WorkRequest, 'requester_kind' | 'requester_id' | 'policy_snapshot'>): HopRef | null {
  if (request.requester_kind !== EXCHANGE_REQUESTER.kind || request.requester_id !== EXCHANGE_REQUESTER.id) return null;
  let policy: HopPolicy;
  try {
    policy = JSON.parse(request.policy_snapshot) as HopPolicy;
  } catch {
    return null;
  }
  if (!policy || policy.source !== 'session_exchange' || typeof policy.exchange_id !== 'string') return null;
  if (policy.hop !== 'ask' && policy.hop !== 'extract' && policy.hop !== 'deliver') return null;
  return {
    exchangeId: policy.exchange_id,
    hop: policy.hop,
    resumeBindingId: typeof policy.resume_session_binding === 'string' ? policy.resume_session_binding : null,
  };
}

// freshSession: the turn must launch in a new runtime session (a Continue
// delivery), never the runtime's standing one.
export type ExchangeResume = { ok: true; binding: SessionBinding | null; freshSession?: boolean } | { ok: false; reason: string };

export interface ExchangeView {
  id: string;
  mode: ExchangeMode;
  state: ExchangeState;
  requester: { kind: string; id: string };
  origin_conversation_id: string;
  instruction: string;
  source: { agent_id: string; agent_name: string | null; session_ref: string };
  destination: { agent_id: string; agent_name: string | null; conversation_id: string; session_ref: string | null } | null;
  hops: {
    source: HopView | null;
    destination: HopView | null;
  };
  answer: { message_id: string; conversation_id: string; content: string } | null;
  packet: HandoffPacket | null;
  failure: { code: string; message: string } | null;
  cancel: { requested_at: number; reason: string | null } | null;
  events: { sequence: number; type: string; at: number; data: Record<string, unknown> | null }[];
  limits: typeof EXCHANGE_LIMITS;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface HopView {
  request_id: string;
  attempt_id: string | null;
  state: string;
  execution_kind: string;
  tool_profile: string;
}

export function createExchangeStore(db: Db, engine: EngineStore) {
  const getRow = db.prepare('SELECT * FROM session_exchanges WHERE id = ?');
  const getByKey = db.prepare('SELECT * FROM session_exchanges WHERE requester_kind = ? AND requester_id = ? AND idempotency_key = ?');
  const getByHop = db.prepare('SELECT * FROM session_exchanges WHERE source_request_id = ? OR destination_request_id = ?');
  const getBinding = db.prepare('SELECT * FROM session_bindings WHERE id = ?');
  const getBot = db.prepare('SELECT * FROM bots WHERE id = ?');
  const insertEventRow = db.prepare(`
    INSERT INTO session_exchange_events (id, exchange_id, sequence, type, data, created_at)
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM session_exchange_events WHERE exchange_id = ?
  `);

  function requireExchange(id: string): SessionExchange {
    const row = getRow.get(id) as SessionExchange | undefined;
    if (!row) throw new ExchangeError('exchange_not_found', `No exchange ${id}.`);
    return row;
  }

  function event(exchangeId: string, type: string, data: Record<string, unknown> | null, at: number): void {
    insertEventRow.run(randomUUID(), exchangeId, type, json(data), at, exchangeId);
  }

  function agentName(id: string | null): string | null {
    if (!id) return null;
    return (getBot.get(id) as { name: string } | undefined)?.name ?? null;
  }

  function terminal(state: ExchangeState): boolean {
    return EXCHANGE_TERMINAL_STATES.includes(state);
  }

  // Compare-and-set on state and version; the change and its event commit
  // together or not at all.
  function move(row: SessionExchange, to: ExchangeState, at: number, fields: { reason?: string; failureCode?: string; failureMessage?: string } = {}): SessionExchange {
    if (!EXCHANGE_TRANSITIONS[row.state].includes(to)) {
      throw new ExchangeError('invalid_transition', `Cannot move an exchange from ${row.state} to ${to}.`);
    }
    const ends = terminal(to);
    const changed = db.prepare(`
      UPDATE session_exchanges SET state = ?, version = version + 1, updated_at = ?, terminal_at = ?,
        failure_code = ?, failure_message = ?
      WHERE id = ? AND state = ? AND version = ?
    `).run(
      to, at, ends ? at : null,
      to === 'failed' ? fields.failureCode ?? 'failed' : row.failure_code,
      to === 'failed' ? fields.failureMessage ?? 'The exchange failed.' : row.failure_message,
      row.id, row.state, row.version
    );
    if (changed.changes !== 1) throw new ExchangeError('invalid_transition', `Exchange ${row.id} changed concurrently.`);
    event(row.id, 'state_changed', {
      from: row.state, to, reason: fields.reason ?? null,
      ...(to === 'failed' ? { failure_code: fields.failureCode ?? 'failed' } : {}),
    }, at);
    return requireExchange(row.id);
  }

  function setRefs(row: SessionExchange, refs: Partial<Pick<SessionExchange,
    'source_request_id' | 'source_attempt_id' | 'destination_request_id' | 'destination_attempt_id' | 'destination_binding_id' | 'answer_message_id' | 'packet'>>, at: number): SessionExchange {
    const keys = Object.keys(refs) as (keyof typeof refs)[];
    if (keys.length === 0) return row;
    const changed = db.prepare(`UPDATE session_exchanges SET ${keys.map(key => `${key} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
      .run(...keys.map(key => refs[key] ?? null), at, row.id, row.version);
    if (changed.changes !== 1) throw new ExchangeError('invalid_transition', `Exchange ${row.id} changed concurrently.`);
    return requireExchange(row.id);
  }

  function safety(requester: { kind: string; id: string }) {
    const snapshot = {
      safety_version: WAKE_SAFETY_VERSION,
      root_principal: { kind: requester.kind, id: requester.id },
      grant_rule: 'readonly_default',
      grant_id: null,
      exchange: true,
    };
    return {
      safetySnapshot: snapshot,
      safety: { principalType: 'human_owner' as const, principal: requester, decision: 'allowed' as const, grantRule: 'readonly_default', snapshot },
    };
  }

  function policyFor() {
    const selected = selectExecutionPolicy({ entryPoint: 'exchange', executionKind: 'conversation' });
    if (!selected.ok) throw new Error(selected.reason);
    return selected.policy;
  }

  // The conversation a binding's resumption must run in: its own scope, or
  // its Work Request's source conversation (the resume scope triggers in
  // lib/engine-store compare both).
  function scopeConversationOf(binding: SessionBinding): string | null {
    if (binding.conversation_id) return binding.conversation_id;
    if (binding.request_id) return engine.getWorkRequest(binding.request_id)?.source_conversation_id ?? null;
    return null;
  }

  function hopRequest(row: SessionExchange, hop: ExchangeHop, fields: {
    conversationId: string; targetAgentId: string; intent: string; parentRequestId: string | null; resumeBindingId: string | null; now: number;
  }): WorkRequest {
    const requester = { kind: row.requester_kind, id: row.requester_id };
    const key = `exchange:${row.id}:${hop}`;
    if (fields.intent.length > EXCHANGE_LIMITS.promptChars) {
      throw new ExchangeError('invalid_request', `The ${hop} prompt exceeds ${EXCHANGE_LIMITS.promptChars} characters.`);
    }
    return engine.createOrGetWorkRequest({
      sourceConversationId: fields.conversationId,
      sourceEventId: key,
      requester: EXCHANGE_REQUESTER,
      targetAgentId: fields.targetAgentId,
      intent: fields.intent,
      executionKind: 'conversation',
      toolProfile: 'readonly',
      idempotencyKey: key,
      parentRequestId: fields.parentRequestId,
      policy: {
        source: 'session_exchange', exchange_id: row.id, hop,
        ...(fields.resumeBindingId ? { resume_session_binding: fields.resumeBindingId } : {}),
      },
      executionPolicy: policyFor(),
      rootPrincipal: requester,
      // One Attempt: a failed hop is never retried automatically.
      retryPolicy: { ...DEFAULT_RETRY_POLICY },
      ...safety(requester),
      now: fields.now,
    }).request;
  }

  function validateShape(input: CreateExchangeInput): void {
    if (!input.requester || !nonEmpty(input.requester.id) || !['person', 'bot', 'service'].includes(input.requester.kind)) {
      throw new ExchangeError('invalid_request', 'A requester principal is required.');
    }
    // Only the owner starts an exchange: no Agent, hop turn, or service
    // can start one from inside another.
    if (input.requester.kind !== 'person') {
      throw new ExchangeError('recursive_exchange', 'Exchanges are started by the owner; an Agent or exchange hop cannot start another exchange.');
    }
    if (!nonEmpty(input.idempotencyKey) || input.idempotencyKey.length > 200) {
      throw new ExchangeError('invalid_request', 'An idempotency key (1-200 characters) is required.');
    }
    if (!EXCHANGE_MODES.includes(input.mode)) throw new ExchangeError('invalid_request', 'mode must be "ask" or "continue".');
    if (!nonEmpty(input.originConversationId)) throw new ExchangeError('invalid_request', 'origin_conversation_id is required.');
    if (!nonEmpty(input.sourceAgentId)) throw new ExchangeError('invalid_request', 'source.agent_id is required.');
    if (!nonEmpty(input.sessionRef)) throw new ExchangeError('invalid_request', 'source.session_ref is required.');
    if (!nonEmpty(input.instruction)) throw new ExchangeError('invalid_request', 'instruction is required.');
    if (input.instruction.length > EXCHANGE_LIMITS.instructionChars) {
      throw new ExchangeError('invalid_request', `instruction exceeds ${EXCHANGE_LIMITS.instructionChars} characters.`);
    }
    if (input.executionKind !== undefined) {
      const selected = selectExecutionPolicy({ entryPoint: 'exchange', executionKind: input.executionKind });
      if (!selected.ok) throw new ExchangeError('authority_not_allowed', `${selected.reason} An exchange never requests edit authority.`);
    }
    if (input.mode === 'ask' && (input.destinationAgentId != null || input.destinationConversationId != null)) {
      throw new ExchangeError('destination_invalid', 'An Ask returns to the origin conversation and takes no destination.');
    }
    if (input.mode === 'continue') {
      if (!nonEmpty(input.destinationAgentId)) throw new ExchangeError('destination_invalid', 'A Continue names destination.agent_id.');
      if (input.destinationAgentId === input.sourceAgentId) {
        throw new ExchangeError('destination_invalid', 'A Continue hands off to another Agent; the destination cannot be the source Agent.');
      }
      if (input.destinationConversationId != null && !nonEmpty(input.destinationConversationId)) {
        throw new ExchangeError('destination_invalid', 'destination.conversation_id must be a non-empty string when present.');
      }
    }
  }

  function requireLaunchable(agentId: string, label: string): { id: string; name: string; agent: string } {
    const bot = getBot.get(agentId) as ({ id: string; name: string } & Record<string, unknown>) | undefined;
    if (!bot) throw new ExchangeError('agent_not_found', `No ${label} Agent ${agentId}.`);
    const resolved = resolveAgent(bot as Parameters<typeof resolveAgent>[0]);
    if (!resolved.launchable) throw new ExchangeError('agent_unavailable', `The ${label} Agent ${bot.name} has no Agent Deck selected.`);
    return { id: bot.id, name: bot.name, agent: resolved.agent };
  }

  function isParticipant(conversationId: string, principal: { kind: string; id: string }): boolean {
    return !!db.prepare(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND participant_kind = ? AND participant_id = ?'
    ).get(conversationId, principal.kind, principal.id);
  }

  function requireVisibleConversation(id: string, requester: { kind: string; id: string }, label: string): void {
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id) || !isParticipant(id, requester)) {
      throw new ExchangeError('conversation_not_found', `No ${label} conversation ${id} is visible to the owner.`);
    }
  }

  function addParticipant(conversationId: string, principal: { kind: string; id: string }, at: number): void {
    db.prepare(
      'INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_kind, participant_id, joined_at) VALUES (?, ?, ?, ?)'
    ).run(conversationId, principal.kind, principal.id, at);
  }

  function hashOf(input: CreateExchangeInput): string {
    return sha256(JSON.stringify([
      input.mode, input.originConversationId, input.sourceAgentId, input.sessionRef,
      input.destinationAgentId ?? null, input.destinationConversationId ?? null, input.instruction,
    ]));
  }

  const store = {
    // Exactly one exchange per (requester, idempotency key). A repeat with
    // the same payload returns the stored exchange whatever its state (a
    // failed exchange stays failed); a different payload is a conflict.
    // The exchange and its first hop Work Request commit together.
    create(input: CreateExchangeInput): { exchange: SessionExchange; created: boolean } {
      validateShape(input);
      const hash = hashOf(input);
      return db.transaction(() => {
        const existing = getByKey.get(input.requester.kind, input.requester.id, input.idempotencyKey) as SessionExchange | undefined;
        if (existing) {
          if (existing.request_hash !== hash) {
            throw new ExchangeError('idempotency_conflict', 'The idempotency key was already used with a different exchange.');
          }
          return { exchange: existing, created: false };
        }
        const now = input.now ?? Date.now();
        requireVisibleConversation(input.originConversationId, input.requester, 'origin');
        if (!getBot.get(input.sourceAgentId)) throw new ExchangeError('agent_not_found', `No source Agent ${input.sourceAgentId}.`);
        const binding = getBinding.get(input.sessionRef) as SessionBinding | undefined;
        // Unknown and another Agent's reference are the same refusal, as
        // in the session catalog.
        if (!binding || binding.agent_id !== input.sourceAgentId) {
          throw new ExchangeError('session_not_found', `Session ${input.sessionRef} is not a session of Agent ${input.sourceAgentId}.`);
        }
        if (binding.released_at !== null) throw new ExchangeError('session_ended', `Session ${binding.id} has ended and cannot be resumed.`);
        const source = requireLaunchable(input.sourceAgentId, 'source');
        if (binding.adapter !== source.agent) {
          throw new ExchangeError('session_not_resumable', `Session ${binding.id} was bound under ${binding.adapter}; ${source.name} now runs ${source.agent}.`);
        }
        const scope = scopeConversationOf(binding);
        if (!scope) throw new ExchangeError('session_not_resumable', `Session ${binding.id} has no conversation to resume in.`);
        if (db.prepare('SELECT 1 FROM session_exchanges WHERE source_binding_id = ? AND terminal_at IS NULL').get(binding.id)) {
          throw new ExchangeError('source_session_busy', `Session ${binding.id} already has an exchange in progress; wait for it or cancel it.`);
        }
        let destination: { id: string; name: string } | null = null;
        let destinationConversationId: string | null = null;
        if (input.mode === 'continue') {
          destination = requireLaunchable(input.destinationAgentId as string, 'destination');
          if (input.destinationConversationId) {
            requireVisibleConversation(input.destinationConversationId, input.requester, 'destination');
            destinationConversationId = input.destinationConversationId;
          } else {
            const thread = db.prepare('SELECT id FROM conversations WHERE bot_id = ?').get(destination.id) as { id: string } | undefined;
            if (!thread) throw new ExchangeError('destination_invalid', `${destination.name} has no direct thread; name destination.conversation_id.`);
            destinationConversationId = thread.id;
          }
        }
        const id = randomUUID();
        db.prepare(`
          INSERT INTO session_exchanges (
            id, requester_kind, requester_id, idempotency_key, request_hash, mode, origin_conversation_id,
            source_agent_id, source_binding_id, destination_agent_id, destination_conversation_id, instruction,
            state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        `).run(
          id, input.requester.kind, input.requester.id, input.idempotencyKey, hash, input.mode, input.originConversationId,
          input.sourceAgentId, binding.id, destination?.id ?? null, destinationConversationId, input.instruction, now, now
        );
        event(id, 'created', {
          mode: input.mode, source_agent_id: input.sourceAgentId, source_binding_id: binding.id,
          destination_agent_id: destination?.id ?? null, destination_conversation_id: destinationConversationId,
        }, now);
        const row = requireExchange(id);
        const hop: ExchangeHop = input.mode === 'ask' ? 'ask' : 'extract';
        const request = hopRequest(row, hop, {
          conversationId: scope,
          targetAgentId: input.sourceAgentId,
          intent: hop === 'ask' ? askPrompt(id, input.instruction) : extractionPrompt(id, destination?.name ?? 'another Agent', input.instruction),
          // The resume continues the binding's own lineage (the resume
          // scope triggers require it).
          parentRequestId: binding.request_id,
          resumeBindingId: binding.id,
          now,
        });
        const updated = setRefs(row, { source_request_id: request.id }, now);
        event(id, 'hop_queued', { hop, request_id: request.id }, now);
        return { exchange: updated, created: true };
      }).immediate();
    },

    get(id: string): SessionExchange | undefined {
      return getRow.get(id) as SessionExchange | undefined;
    },

    require: requireExchange,

    listEvents(id: string): ExchangeEvent[] {
      return db.prepare('SELECT * FROM session_exchange_events WHERE exchange_id = ? ORDER BY sequence ASC').all(id) as ExchangeEvent[];
    },

    forHopRequest(requestId: string): SessionExchange | undefined {
      return getByHop.get(requestId, requestId) as SessionExchange | undefined;
    },

    // The binding a source hop resumes: exactly the one the exchange
    // selected, still active, of the request's target Agent under the
    // adapter it dispatches. Anything else fails closed (never a fresh
    // session, never another binding). Null: not an exchange source hop.
    resumeFor(request: WorkRequest, adapter: string): ExchangeResume | null {
      const hop = hopOf(request);
      if (!hop) return null;
      if (hop.hop === 'deliver') return { ok: true, binding: null, freshSession: true };
      const row = store.get(hop.exchangeId);
      const binding = hop.resumeBindingId ? getBinding.get(hop.resumeBindingId) as SessionBinding | undefined : undefined;
      if (!row || !binding || row.source_binding_id !== binding.id || row.source_request_id !== request.id) {
        return { ok: false, reason: 'The exchange does not name this session.' };
      }
      if (binding.released_at !== null) return { ok: false, reason: 'The selected session has ended.' };
      if (binding.agent_id !== request.target_agent_id || binding.adapter !== adapter) {
        return { ok: false, reason: 'The selected session belongs to another Agent or runtime.' };
      }
      return { ok: true, binding };
    },

    // The turn prompt of a hop (its history is empty: the source event is
    // not a message). Null for any other request.
    turnContext(request: WorkRequest): DispatchHistoryEntry[] | null {
      if (!hopOf(request)) return null;
      return [{ speakerLabel: EXCHANGE_SPEAKER, fromAgent: false, content: request.intent }];
    },

    // In the dispatcher's claim transaction: records the hop's Attempt and,
    // for the source hop, moves the exchange to extracting.
    hopClaimed(requestId: string, attemptId: string, at: number): void {
      const row = store.forHopRequest(requestId);
      if (!row || terminal(row.state)) return;
      if (row.source_request_id === requestId) {
        const next = row.source_attempt_id ? row : setRefs(row, { source_attempt_id: attemptId }, at);
        if (next.state === 'queued') move(next, 'extracting', at, { reason: 'hop_started' });
        event(row.id, 'hop_started', { hop: row.mode === 'ask' ? 'ask' : 'extract', request_id: requestId, attempt_id: attemptId }, at);
        return;
      }
      if (!row.destination_attempt_id) setRefs(row, { destination_attempt_id: attemptId }, at);
      event(row.id, 'hop_started', { hop: 'deliver', request_id: requestId, attempt_id: attemptId }, at);
    },

    // Applied to a hop's adapter result before any of it is stored (the
    // Attempt output and error, late-result evidence, the projection): the
    // source session id is redacted and the output cut to the hop's bound.
    // Any other request's result is returned unchanged.
    sanitizeHopResult(request: WorkRequest, result: AttemptResult): AttemptResult {
      const hop = hopOf(request);
      const row = hop ? store.get(hop.exchangeId) : undefined;
      if (!hop || !row) return result;
      const sourceSecret = (getBinding.get(row.source_binding_id) as SessionBinding | undefined)?.external_session_id ?? null;
      const limit = hop.hop === 'ask' ? EXCHANGE_LIMITS.answerChars
        : hop.hop === 'extract' ? EXCHANGE_LIMITS.extractionOutputChars
          : EXCHANGE_LIMITS.replyChars;
      const bounded = result.output === null ? null : boundOutput(redact(result.output, sourceSecret), limit);
      return {
        ...result,
        output: bounded ? bounded.content : null,
        outputTruncated: result.outputTruncated === true || bounded?.truncated === true,
        failure: result.failure ? { ...result.failure, message: redact(result.failure.message, sourceSecret) } : null,
      };
    },

    // In the dispatcher's terminal commit of a successful hop Attempt
    // (before the hop request completes): projects the result and returns
    // the hop request's result. A cancelled exchange keeps nothing.
    commitHop(request: WorkRequest, attempt: WorkAttempt, result: AttemptResult, at: number): Record<string, unknown> {
      const hop = hopOf(request);
      const row = hop ? store.get(hop.exchangeId) : undefined;
      if (!hop || !row) return { exchange_id: hop?.exchangeId ?? null, discarded: 'exchange_missing' };
      if (terminal(row.state) || row.cancel_requested_at !== null) {
        event(row.id, 'hop_result_discarded', { hop: hop.hop, request_id: request.id, reason: terminal(row.state) ? row.state : 'cancel_requested' }, at);
        return { exchange_id: row.id, discarded: 'cancel_requested' };
      }
      const output = result.output ?? '';
      const sourceSecret = (getBinding.get(row.source_binding_id) as SessionBinding | undefined)?.external_session_id ?? null;
      if (hop.hop === 'ask') {
        const bounded = boundOutput(redact(output, sourceSecret), EXCHANGE_LIMITS.answerChars);
        const { content } = bounded;
        const truncated = bounded.truncated || result.outputTruncated === true;
        const messageId = randomUUID();
        db.prepare(
          'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(messageId, row.origin_conversation_id, 'bot', row.source_agent_id, 'bot', request.id, content, at);
        setRefs(row, { answer_message_id: messageId }, at);
        event(row.id, 'answer_returned', { request_id: request.id, attempt_id: attempt.id, message_id: messageId, conversation_id: row.origin_conversation_id, truncated }, at);
        // Not reply_message_id: an Ask answer routes no Wakes.
        return { exchange_id: row.id, answer_message_id: messageId };
      }
      if (hop.hop === 'extract') {
        // Output cut to the extraction bound before it was stored is
        // refused as oversized, never parsed.
        const parsed: ReturnType<typeof parseHandoffPacket> = result.outputTruncated
          ? { ok: false, reason: `The extraction output exceeds ${EXCHANGE_LIMITS.extractionOutputChars} characters.` }
          : parseHandoffPacket(output);
        if (!parsed.ok) {
          event(row.id, 'packet_rejected', { request_id: request.id, attempt_id: attempt.id, reason: parsed.reason }, at);
          move(row, 'failed', at, { reason: 'packet_invalid', failureCode: 'packet_invalid', failureMessage: parsed.reason });
          return { exchange_id: row.id, packet: 'rejected' };
        }
        const packet = redactPacket(parsed.packet, sourceSecret);
        setRefs(row, { packet: JSON.stringify(packet) }, at);
        event(row.id, 'packet_extracted', {
          request_id: request.id, attempt_id: attempt.id, size: JSON.stringify(packet).length,
          counts: Object.fromEntries(PACKET_LISTS.map(key => [key, packet[key].length])),
        }, at);
        return { exchange_id: row.id, packet: 'stored' };
      }
      // Delivery: the destination must report a session of its own, never
      // seen before (not the source's, not any bound one, not one any other
      // Attempt ran in), from a launch that asked the adapter for a fresh
      // session; otherwise the hand-off has no destination-owned session
      // and the exchange fails.
      const reported = result.externalSessionId ?? null;
      let launchedFresh = false;
      try {
        launchedFresh = (JSON.parse(attempt.launch_snapshot) as { fresh_session?: unknown }).fresh_session === true;
      } catch {
        launchedFresh = false;
      }
      const fresh = launchedFresh && !!reported && reported !== sourceSecret
        && !db.prepare('SELECT 1 FROM session_bindings WHERE external_session_id = ?').get(reported)
        && !db.prepare('SELECT 1 FROM work_attempts WHERE external_session_id = ? AND id != ?').get(reported, attempt.id);
      if (!fresh) {
        const reason = !launchedFresh ? 'not_fresh_launch' : reported ? 'reused' : 'not_reported';
        event(row.id, 'destination_session_rejected', { request_id: request.id, attempt_id: attempt.id, reason }, at);
        move(row, 'failed', at, {
          reason: 'destination_session_invalid', failureCode: 'destination_session_invalid',
          failureMessage: reported
            ? 'The destination Agent reported a session that is not new; the hand-off needs a fresh destination-owned session.'
            : 'The destination Agent reported no session; the hand-off needs a fresh destination-owned session.',
        });
        return { exchange_id: row.id, destination_session: 'rejected' };
      }
      // The reply goes to the destination conversation, and the session is
      // bound as a fresh binding the destination owns (scoped to its own
      // hop request).
      const replyId = randomUUID();
      const conversationId = row.destination_conversation_id as string;
      const bounded = boundOutput(redact(output, sourceSecret), EXCHANGE_LIMITS.replyChars);
      const { content } = bounded;
      const truncated = bounded.truncated || result.outputTruncated === true;
      db.prepare(
        'INSERT INTO messages (id, conversation_id, sender_type, sender_id, sender_kind, request_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(replyId, conversationId, 'bot', request.target_agent_id, 'bot', request.id, content, at);
      const bindingId = engine.bindSession({
        agentId: request.target_agent_id, adapter: attempt.adapter, externalSessionId: reported,
        conversationId, requestId: request.id, sourceAttemptId: attempt.id, now: at,
      }).id;
      setRefs(row, { destination_binding_id: bindingId }, at);
      event(row.id, 'destination_replied', {
        request_id: request.id, attempt_id: attempt.id, message_id: replyId, conversation_id: conversationId,
        session_ref: bindingId, truncated,
      }, at);
      // Not reply_message_id: a delivery reply routes no Wakes (the
      // exchange ends with this one destination turn).
      return { exchange_id: row.id, destination_message_id: replyId };
    },

    // Derives the next step from the hops' durable state. Idempotent: run
    // after any hop request ends, after a cancel, and at restart. Returns
    // queued hop requests to dispatch. Never retries a failed hop.
    advance(id: string, at: number = Date.now()): string[] {
      return db.transaction((): string[] => {
        let row = store.get(id);
        if (!row || terminal(row.state)) return [];
        if (row.state === 'queued' || row.state === 'extracting') {
          const source = row.source_request_id ? engine.getWorkRequest(row.source_request_id) : undefined;
          if (!source) {
            move(row, 'failed', at, { reason: 'hop_missing', failureCode: 'hop_missing', failureMessage: 'The source session turn is missing.' });
            return [];
          }
          if (!TERMINAL_STATES.includes(source.state)) {
            if (source.state !== 'queued' && row.state === 'queued') move(row, 'extracting', at, { reason: 'hop_started' });
            return source.state === 'queued' && row.cancel_requested_at === null ? [source.id] : [];
          }
          if (row.cancel_requested_at !== null || source.state === 'cancelled') {
            move(row, 'cancelled', at, { reason: row.cancel_requested_at !== null ? 'cancel_requested' : 'hop_cancelled' });
            return [];
          }
          if (source.state === 'failed') {
            move(row, 'failed', at, {
              reason: 'hop_failed', failureCode: 'source_turn_failed',
              failureMessage: `The source session turn failed (${source.error_code ?? 'failed'}): ${source.error_message ?? 'no detail'}`,
            });
            return [];
          }
          // The source hop completed.
          if (row.state === 'queued') row = move(row, 'extracting', at, { reason: 'hop_started' });
          if (row.mode === 'ask') {
            if (!row.answer_message_id) {
              move(row, 'failed', at, { reason: 'answer_missing', failureCode: 'answer_missing', failureMessage: 'The source session turn returned no answer.' });
              return [];
            }
            move(row, 'completed', at, { reason: 'answered' });
            return [];
          }
          if (!row.packet) {
            move(row, 'failed', at, { reason: 'packet_missing', failureCode: 'packet_missing', failureMessage: 'The source session turn returned no handoff packet.' });
            return [];
          }
          // Only now, with the packet stored, is the destination launched:
          // a fresh request with no session to resume.
          const packet = JSON.parse(row.packet) as HandoffPacket;
          const destinationConversationId = row.destination_conversation_id as string;
          const destinationAgentId = row.destination_agent_id as string;
          addParticipant(destinationConversationId, { kind: 'bot', id: destinationAgentId }, at);
          const delivery = hopRequest(row, 'deliver', {
            conversationId: destinationConversationId,
            targetAgentId: destinationAgentId,
            intent: deliveryPrompt(row.id, agentName(row.source_agent_id) ?? 'the source Agent', packet, row.instruction),
            parentRequestId: null,
            resumeBindingId: null,
            now: at,
          });
          row = setRefs(row, { destination_request_id: delivery.id }, at);
          event(row.id, 'hop_queued', { hop: 'deliver', request_id: delivery.id }, at);
          move(row, 'delivering', at, { reason: 'packet_extracted' });
          return [delivery.id];
        }
        // delivering
        const delivery = row.destination_request_id ? engine.getWorkRequest(row.destination_request_id) : undefined;
        if (!delivery) {
          move(row, 'failed', at, { reason: 'hop_missing', failureCode: 'hop_missing', failureMessage: 'The destination turn is missing.' });
          return [];
        }
        if (!TERMINAL_STATES.includes(delivery.state)) return delivery.state === 'queued' && row.cancel_requested_at === null ? [delivery.id] : [];
        if (row.cancel_requested_at !== null || delivery.state === 'cancelled') {
          move(row, 'cancelled', at, { reason: row.cancel_requested_at !== null ? 'cancel_requested' : 'hop_cancelled' });
          return [];
        }
        if (delivery.state === 'failed') {
          // Visible and final: a retry is a new exchange (new key).
          move(row, 'failed', at, {
            reason: 'hop_failed', failureCode: 'destination_turn_failed',
            failureMessage: `The destination turn failed (${delivery.error_code ?? 'failed'}): ${delivery.error_message ?? 'no detail'}`,
          });
          return [];
        }
        if (!row.destination_binding_id) {
          move(row, 'failed', at, {
            reason: 'destination_session_missing', failureCode: 'destination_session_invalid',
            failureMessage: 'The destination turn bound no fresh destination-owned session.',
          });
          return [];
        }
        move(row, 'completed', at, { reason: 'delivered' });
        return [];
      }).immediate();
    },

    // Records the owner's cancellation intent (once). Returns the hop
    // request to cancel, or null when none is open. A terminal exchange
    // cannot be cancelled.
    requestCancel(id: string, actor: { kind: string; id: string }, reason: string | null, at: number = Date.now()): { exchange: SessionExchange; hopRequestId: string | null; replayed: boolean } {
      return db.transaction(() => {
        const row = requireExchange(id);
        if (terminal(row.state)) throw new ExchangeError('exchange_terminal', `Exchange ${id} is already ${row.state}; it cannot be cancelled.`);
        const hopRequestId = row.state === 'delivering' ? row.destination_request_id : row.source_request_id;
        if (row.cancel_requested_at !== null) return { exchange: row, hopRequestId, replayed: true };
        db.prepare(
          'UPDATE session_exchanges SET cancel_requested_at = ?, cancel_requested_by = ?, cancel_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND cancel_requested_at IS NULL'
        ).run(at, `${actor.kind}:${actor.id}`, reason, at, id);
        event(id, 'cancel_requested', { by: `${actor.kind}:${actor.id}`, reason, state: row.state, request_id: hopRequestId }, at);
        return { exchange: requireExchange(id), hopRequestId, replayed: false };
      }).immediate();
    },

    // Non-terminal exchanges, oldest first (restart recovery).
    openIds(): string[] {
      return (db.prepare('SELECT id FROM session_exchanges WHERE terminal_at IS NULL ORDER BY created_at ASC, id ASC').all() as { id: string }[]).map(row => row.id);
    },

    view(id: string): ExchangeView {
      const row = requireExchange(id);
      const hopView = (requestId: string | null, attemptId: string | null): HopView | null => {
        const request = requestId ? engine.getWorkRequest(requestId) : undefined;
        if (!request) return null;
        return { request_id: request.id, attempt_id: attemptId, state: request.state, execution_kind: request.execution_kind, tool_profile: request.tool_profile };
      };
      const answer = row.answer_message_id
        ? db.prepare('SELECT id, conversation_id, content FROM messages WHERE id = ?').get(row.answer_message_id) as { id: string; conversation_id: string; content: string } | undefined
        : undefined;
      return {
        id: row.id,
        mode: row.mode,
        state: row.state,
        requester: { kind: row.requester_kind, id: row.requester_id },
        origin_conversation_id: row.origin_conversation_id,
        instruction: row.instruction,
        source: { agent_id: row.source_agent_id, agent_name: agentName(row.source_agent_id), session_ref: row.source_binding_id },
        destination: row.destination_agent_id && row.destination_conversation_id
          ? { agent_id: row.destination_agent_id, agent_name: agentName(row.destination_agent_id), conversation_id: row.destination_conversation_id, session_ref: row.destination_binding_id }
          : null,
        hops: { source: hopView(row.source_request_id, row.source_attempt_id), destination: hopView(row.destination_request_id, row.destination_attempt_id) },
        answer: answer ? { message_id: answer.id, conversation_id: answer.conversation_id, content: answer.content } : null,
        packet: row.packet ? JSON.parse(row.packet) as HandoffPacket : null,
        failure: row.state === 'failed' ? { code: row.failure_code ?? 'failed', message: row.failure_message ?? '' } : null,
        cancel: row.cancel_requested_at !== null ? { requested_at: row.cancel_requested_at, reason: row.cancel_reason } : null,
        events: store.listEvents(row.id).map(entry => ({
          sequence: entry.sequence, type: entry.type, at: entry.created_at,
          data: entry.data ? JSON.parse(entry.data) as Record<string, unknown> : null,
        })),
        limits: EXCHANGE_LIMITS,
        created_at: row.created_at,
        updated_at: row.updated_at,
        terminal_at: row.terminal_at,
      };
    },
  };
  return store;
}

export type ExchangeStore = ReturnType<typeof createExchangeStore>;

const BODY_KEYS = new Set(['mode', 'idempotency_key', 'origin_conversation_id', 'source', 'destination', 'instruction', 'execution_kind', 'tool_profile']);
const RECURSION_KEYS = ['exchange_id', 'parent_exchange_id'];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The POST /api/exchanges body (snake_case) as a create input for the
// owner. One source and at most one destination: lists are refused.
// Asking for any authority other than a read-only conversation turn, or
// naming another exchange to start from, is refused before anything runs.
export function exchangeInputFromBody(body: unknown, requester: CreateExchangeInput['requester']): CreateExchangeInput {
  if (!isObject(body)) throw new ExchangeError('invalid_request', 'The body must be a JSON object.');
  for (const key of RECURSION_KEYS) {
    if (key in body) throw new ExchangeError('recursive_exchange', 'An exchange cannot be started from another exchange.');
  }
  const unknown = Object.keys(body).filter(key => !BODY_KEYS.has(key));
  if (unknown.length > 0) throw new ExchangeError('invalid_request', `Unknown field ${unknown[0]}.`);
  if (body.tool_profile !== undefined && body.tool_profile !== 'readonly') {
    throw new ExchangeError('authority_not_allowed', 'An exchange runs read-only; it never requests edit authority.');
  }
  if (!isObject(body.source)) throw new ExchangeError('invalid_request', 'source must be one object { agent_id, session_ref }.');
  if (body.destination !== undefined && body.destination !== null && !isObject(body.destination)) {
    throw new ExchangeError('destination_invalid', 'destination must be one object { agent_id, conversation_id? }.');
  }
  const destination = isObject(body.destination) ? body.destination : null;
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw new ExchangeError('invalid_request', `${field} must be a string.`);
    return value;
  };
  const optional = (value: unknown, field: string): string | null => value === undefined || value === null ? null : text(value, field);
  return {
    requester,
    mode: text(body.mode, 'mode') as ExchangeMode,
    idempotencyKey: text(body.idempotency_key, 'idempotency_key'),
    originConversationId: text(body.origin_conversation_id, 'origin_conversation_id'),
    sourceAgentId: text(body.source.agent_id, 'source.agent_id'),
    sessionRef: text(body.source.session_ref, 'source.session_ref'),
    destinationAgentId: destination ? optional(destination.agent_id, 'destination.agent_id') : null,
    destinationConversationId: destination ? optional(destination.conversation_id, 'destination.conversation_id') : null,
    instruction: text(body.instruction, 'instruction'),
    ...(body.execution_kind !== undefined ? { executionKind: body.execution_kind } : {}),
  };
}

// The optional POST /api/exchanges/:id/cancel body: empty, or one JSON
// object with at most a reason. Anything else is refused before the
// cancellation runs.
export function cancelReasonFromBody(text: string): string | null {
  if (text.trim().length === 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ExchangeError('invalid_request', 'The body must be a JSON object.');
  }
  if (!isObject(body)) throw new ExchangeError('invalid_request', 'The body must be a JSON object.');
  const unknown = Object.keys(body).filter(key => key !== 'reason');
  if (unknown.length > 0) throw new ExchangeError('invalid_request', `Unknown field ${unknown[0]}.`);
  const value = body.reason;
  if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 500)) {
    throw new ExchangeError('invalid_request', 'reason must be a string of at most 500 characters.');
  }
  return typeof value === 'string' ? value : null;
}

export function exchangeErrorBody(error: ExchangeError): { error: { code: ExchangeErrorCode; message: string } } {
  return { error: { code: error.code, message: error.message } };
}
