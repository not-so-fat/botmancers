import { createHash } from 'crypto';
import type { ExecutionKind } from './engine-store';

// NOT-466: Wake contract v1 (docs/wake-contract-v1.md). Pure parsing and
// validation of the Wakes in one Agent reply: structured
// ```botmancers-wake``` blocks plus the retained legacy `WAKE <name>:
// <message>` syntax. Legacy directives are translated into a v1
// `conversation` envelope and pass through the same validator, so they can
// never carry broader authority than a structured Wake.

export type WakeSyntax = 'structured' | 'legacy';

export interface WakeEnvelope {
  version: 1;
  target: string;
  executionKind: ExecutionKind;
  objective: string;
  contextWorkRequests?: string[];
  resumeWorkRequest?: string;
  limits?: { maxAttempts?: number; deadlineSeconds?: number };
}

export type WakeValidation =
  | { ok: true; envelope: WakeEnvelope }
  | { ok: false; reason: string };

// One Wake found in a reply, in source order. `position` is its index
// among all candidates (valid or not) and feeds the idempotency key.
export interface WakeCandidate {
  position: number;
  syntax: WakeSyntax;
  // Exact source text of the block or directive.
  raw: string;
  validation: WakeValidation;
}

const ENVELOPE_KEYS = new Set(['version', 'target', 'executionKind', 'objective', 'contextWorkRequests', 'resumeWorkRequest', 'limits']);
const LIMIT_KEYS = new Set(['maxAttempts', 'deadlineSeconds']);
const EXECUTION_KINDS = new Set<string>(['conversation', 'implementation', 'review', 'revision']);

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function boundedInteger(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

// Mirrors contracts/wake-v1.schema.json. Unknown fields fail closed, so
// a tool profile, deck, runtime, session, caller, or grant can never be
// smuggled in. Returns a normalized copy (trimmed target and objective,
// only the fields present).
export function validateWakeEnvelope(value: unknown): WakeValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'envelope must be a JSON object' };
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !ENVELOPE_KEYS.has(key));
  if (unknown.length > 0) return { ok: false, reason: `unknown field ${unknown.join(', ')}` };
  if (input.version !== 1) return { ok: false, reason: 'version must be 1' };
  if (!boundedString(input.target, 120)) return { ok: false, reason: 'target must be a non-empty Agent name (max 120 characters)' };
  if (typeof input.executionKind !== 'string' || !EXECUTION_KINDS.has(input.executionKind)) return { ok: false, reason: 'unknown executionKind' };
  if (!boundedString(input.objective, 20000)) return { ok: false, reason: 'objective must be non-empty (max 20000 characters)' };

  const envelope: WakeEnvelope = {
    version: 1,
    target: input.target.trim(),
    executionKind: input.executionKind as ExecutionKind,
    objective: input.objective.trim(),
  };

  if (input.contextWorkRequests !== undefined) {
    const refs = input.contextWorkRequests;
    if (!Array.isArray(refs) || refs.length > 8 || refs.some(ref => !boundedString(ref, 160))) {
      return { ok: false, reason: 'contextWorkRequests must be at most 8 Work Request references' };
    }
    if (new Set(refs).size !== refs.length) return { ok: false, reason: 'contextWorkRequests must be unique' };
    envelope.contextWorkRequests = [...refs] as string[];
  }

  const hasResume = Object.prototype.hasOwnProperty.call(input, 'resumeWorkRequest');
  if (envelope.executionKind === 'revision') {
    if (!hasResume || !boundedString(input.resumeWorkRequest, 160)) return { ok: false, reason: 'revision requires resumeWorkRequest' };
    envelope.resumeWorkRequest = input.resumeWorkRequest;
  } else if (hasResume) {
    return { ok: false, reason: 'resumeWorkRequest is revision-only' };
  }

  if (input.limits !== undefined) {
    const limits = input.limits;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return { ok: false, reason: 'limits must be an object' };
    const record = limits as Record<string, unknown>;
    if (Object.keys(record).some(key => !LIMIT_KEYS.has(key))) return { ok: false, reason: 'unknown limits field' };
    if (record.maxAttempts !== undefined && !boundedInteger(record.maxAttempts, 1, 10)) return { ok: false, reason: 'limits.maxAttempts must be 1-10' };
    if (record.deadlineSeconds !== undefined && !boundedInteger(record.deadlineSeconds, 1, 86400)) return { ok: false, reason: 'limits.deadlineSeconds must be 1-86400' };
    envelope.limits = {};
    if (record.maxAttempts !== undefined) envelope.limits.maxAttempts = record.maxAttempts as number;
    if (record.deadlineSeconds !== undefined) envelope.limits.deadlineSeconds = record.deadlineSeconds as number;
  }

  return { ok: true, envelope };
}

// Legacy adapter: `WAKE <name>: <message>` becomes a v1 `conversation`
// Wake and nothing else. The message is objective text only; whatever it
// says (including JSON that looks like an envelope) grants no authority.
export function legacyWakeEnvelope(target: string, message: string): Record<string, unknown> {
  return { version: 1, target, executionKind: 'conversation', objective: message };
}

const FENCE = /```botmancers-wake[^\S\r\n]*\r?\n([\s\S]*?)```/g;
// Same directive shape lib/agent.ts parseWakeDirectives accepts.
const LEGACY = /WAKE\s+([A-Za-z0-9_-]+)\s*:/gi;

function parseLegacy(segment: string, offset: number): { at: number; raw: string; target: string; message: string }[] {
  const starts = [...segment.matchAll(LEGACY)];
  return starts.map((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index as number : segment.length;
    const raw = segment.slice(match.index as number, end);
    return { at: offset + (match.index as number), raw: raw.trim(), target: match[1], message: raw.slice(match[0].length).trim() };
  });
}

// Every Wake in a reply, in source order. Text outside structured blocks
// is scanned for legacy directives; text inside a block never is.
export function parseWakes(content: string): WakeCandidate[] {
  const found: { at: number; syntax: WakeSyntax; raw: string; validation: WakeValidation }[] = [];
  let cursor = 0;
  const legacyIn = (from: number, to: number) => {
    for (const directive of parseLegacy(content.slice(from, to), from)) {
      // Groups are not an execution primitive: WAKE GROUP is not a Wake.
      const validation: WakeValidation = directive.target.toUpperCase() === 'GROUP'
        ? { ok: false, reason: 'group wakes are not supported; wake one Agent by name' }
        : directive.message.length === 0
          ? { ok: false, reason: 'objective must be non-empty (max 20000 characters)' }
          : validateWakeEnvelope(legacyWakeEnvelope(directive.target, directive.message));
      found.push({ at: directive.at, syntax: 'legacy', raw: directive.raw, validation });
    }
  };
  for (const match of content.matchAll(FENCE)) {
    const at = match.index as number;
    legacyIn(cursor, at);
    let validation: WakeValidation;
    try {
      validation = validateWakeEnvelope(JSON.parse(match[1]));
    } catch {
      validation = { ok: false, reason: 'block is not valid JSON' };
    }
    found.push({ at, syntax: 'structured', raw: match[0], validation });
    cursor = at + match[0].length;
  }
  legacyIn(cursor, content.length);
  return found
    .sort((a, b) => a.at - b.at)
    .map((entry, position) => ({ position, syntax: entry.syntax, raw: entry.raw, validation: entry.validation }));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

// Normalized payload of a candidate: the validated envelope, or the raw
// text when invalid. Key order never changes the identity.
export function wakePayload(candidate: WakeCandidate): string {
  return JSON.stringify(canonical(candidate.validation.ok
    ? { syntax: candidate.syntax, envelope: candidate.validation.envelope }
    : { syntax: candidate.syntax, raw: candidate.raw }));
}

// Idempotency key: source event, position, and normalized payload.
export function wakeIdempotencyKey(sourceEventId: string, candidate: WakeCandidate): string {
  const digest = createHash('sha256').update(wakePayload(candidate)).digest('hex').slice(0, 32);
  return `wake:v1:${sourceEventId}:${candidate.position}:${digest}`;
}
