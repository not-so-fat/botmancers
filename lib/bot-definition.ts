// NOT-433: Bot-definition runtime-path contract.
//
// A bot definition carries two distinct runtime concerns:
// - persistent_runtime: the persistent conversational runtime. Today the
//   only value is 'hermes', which is also the default for rows that predate
//   this ticket (legacy and imported bots read back as Hermes).
// - coding path: a local coding-agent launch path made of coding_runtime
//   (exactly codex|claude|cursor|muse, launched only through the NOT-395
//   agent-deck adapter), deck_name, and working_directory. Existing and
//   imported bots have no trustworthy deck or working directory, so those
//   stay null (explicitly unconfigured) until the owner supplies them.
//
// This module holds the shared validation/serialization used by the API
// routes and the deterministic tests. Plain TypeScript with no I/O so the
// plain-node test suite can load it through jiti.
import { resolveAvatar, type AvatarConfig } from './avatar';

export const PERSISTENT_RUNTIME_HERMES = 'hermes' as const;

export const PERSISTENT_RUNTIMES = [PERSISTENT_RUNTIME_HERMES] as const;

export type PersistentRuntime = (typeof PERSISTENT_RUNTIMES)[number];

// Mirrors DECK_RUNTIMES in ./agent-deck-run (the NOT-395 adapter). The
// enum alone never marks a runtime launchable; only the capability probe
// (probeDeckRuntime / listAvailableDeckRuntimes) advertises launchability.
export const CODING_RUNTIMES = ['codex', 'claude', 'cursor', 'muse'] as const;

export type CodingRuntime = (typeof CODING_RUNTIMES)[number];

export class InvalidCodingRuntimeError extends Error {
  readonly code = 'invalid-coding-runtime';
  constructor(value: unknown) {
    super(
      `Invalid coding runtime: ${JSON.stringify(String(value))}. Expected one of ${CODING_RUNTIMES.join('|')}.`
    );
  }
}

export interface CodingPathInput {
  coding_runtime?: unknown;
  deck_name?: unknown;
  working_directory?: unknown;
}

export interface BotLike {
  name?: unknown;
  persistent_runtime?: string | null;
  coding_runtime?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
}

// Persistent runtime: Hermes is the default. Null/undefined/blank reads
// back as 'hermes' (this is the default, not an invented coding path).
// Any other non-blank value fails closed.
export function normalizePersistentRuntime(value: unknown): PersistentRuntime {
  if (value === null || value === undefined) return PERSISTENT_RUNTIME_HERMES;
  const text = String(value).trim();
  if (!text) return PERSISTENT_RUNTIME_HERMES;
  if ((PERSISTENT_RUNTIMES as readonly string[]).includes(text)) {
    return text as PersistentRuntime;
  }
  throw new Error(
    `Invalid persistent runtime: ${JSON.stringify(text)}. Expected one of ${PERSISTENT_RUNTIMES.join('|')}.`
  );
}

// Coding runtime: null/undefined/blank means "not supplied" (null, never
// invented). A supplied value must be exactly one of the four runtimes.
export function normalizeCodingRuntime(value: unknown): CodingRuntime | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if ((CODING_RUNTIMES as readonly string[]).includes(text)) {
    return text as CodingRuntime;
  }
  throw new InvalidCodingRuntimeError(value);
}

function normalizePathText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function normalizeDeckName(value: unknown): string | null {
  return normalizePathText(value);
}

export function normalizeWorkingDirectory(value: unknown): string | null {
  return normalizePathText(value);
}

// Launchability gate for a manually created bot: when the caller marks the
// bot launchable, the full coding path must be present and valid. Returns
// the API error strings (empty when launchable); throws nothing.
export function validateLaunchableCodingPath(input: CodingPathInput): string[] {
  const errors: string[] = [];
  let runtime: CodingRuntime | null = null;
  try {
    runtime = normalizeCodingRuntime(input.coding_runtime);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!runtime) {
    errors.push(
      `Invalid coding runtime: ${JSON.stringify(String(input.coding_runtime ?? ''))}. Expected one of ${CODING_RUNTIMES.join('|')}.`
    );
  }
  if (!normalizeDeckName(input.deck_name)) {
    errors.push('Deck name is required for a launchable bot.');
  }
  if (!normalizeWorkingDirectory(input.working_directory)) {
    errors.push('Working directory is required for a launchable bot.');
  }
  return errors;
}

export interface CodingPath {
  configured: boolean;
  persistent_runtime: PersistentRuntime;
  coding_runtime: CodingRuntime | null;
  deck_name: string | null;
  working_directory: string | null;
}

// Resolved coding path for a stored bot row. Legacy and imported rows carry
// null coding fields and report configured: false; nothing is invented.
export function resolveCodingPath(bot: BotLike): CodingPath {
  const persistent_runtime = normalizePersistentRuntime(bot.persistent_runtime);
  let coding_runtime: CodingRuntime | null = null;
  try {
    coding_runtime = normalizeCodingRuntime(bot.coding_runtime);
  } catch {
    coding_runtime = null;
  }
  const deck_name = normalizeDeckName(bot.deck_name);
  const working_directory = normalizeWorkingDirectory(bot.working_directory);
  const configured = coding_runtime !== null && deck_name !== null && working_directory !== null;
  return { configured, persistent_runtime, coding_runtime, deck_name, working_directory };
}

export function isCodingPathConfigured(bot: BotLike): boolean {
  return resolveCodingPath(bot).configured;
}

export interface SerializedBot {
  persistent_runtime: PersistentRuntime;
  coding_runtime: CodingRuntime | null;
  deck_name: string | null;
  working_directory: string | null;
  coding_configured: boolean;
  coding_path: CodingPath;
  avatar_config: AvatarConfig;
}

// API read shape: legacy/imported bots stay readable and report their
// coding path as unconfigured until the owner supplies it. Avatar fields
// resolve to the NOT-431 defaults (Chief of Staff gets the crown) until
// the owner configures them.
export function serializeBot<T extends BotLike>(bot: T): T & SerializedBot {
  const coding_path = resolveCodingPath(bot);
  return {
    ...bot,
    persistent_runtime: coding_path.persistent_runtime,
    coding_runtime: coding_path.coding_runtime,
    deck_name: coding_path.deck_name,
    working_directory: coding_path.working_directory,
    coding_configured: coding_path.configured,
    coding_path,
    avatar_config: resolveAvatar(bot),
  };
}

export interface AvailabilityEntry {
  runtime: string;
  launchable: boolean;
}

export interface NormalizedRuntimePath {
  persistent_runtime: PersistentRuntime;
  coding_runtime: CodingRuntime | null;
  deck_name: string | null;
  working_directory: string | null;
}

// Shared create contract for POST /api/bots: validates the supplied
// runtime path and, when the caller marks the bot launchable, requires the
// full coding path (runtime, deck name, working directory). Returns the API
// error strings (empty when acceptable) plus the normalized values to store.
export function validateCreateRuntimePath(body: Record<string, unknown>): {
  errors: string[];
  normalized: NormalizedRuntimePath;
} {
  const errors: string[] = [];
  let persistent_runtime: PersistentRuntime = PERSISTENT_RUNTIME_HERMES;
  try {
    persistent_runtime = normalizePersistentRuntime(body.persistent_runtime);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let coding_runtime: CodingRuntime | null = null;
  try {
    coding_runtime = normalizeCodingRuntime(body.coding_runtime);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const deck_name = normalizeDeckName(body.deck_name);
  const working_directory = normalizeWorkingDirectory(body.working_directory);
  if (body.launchable === true) {
    for (const error of validateLaunchableCodingPath({ coding_runtime: body.coding_runtime, deck_name: body.deck_name, working_directory: body.working_directory })) {
      if (!errors.includes(error)) errors.push(error);
    }
  }
  return { errors, normalized: { persistent_runtime, coding_runtime, deck_name, working_directory } };
}

// Shared update contract for PATCH /api/bots: validates only the supplied
// fields. Unknown coding/persistent runtimes are rejected; blank values
// clear a coding field back to unconfigured.
export function validateUpdateRuntimePath(body: Record<string, unknown>): {
  errors: string[];
  fields: { persistent_runtime?: string | null; coding_runtime?: string | null; deck_name?: string | null; working_directory?: string | null };
} {
  const errors: string[] = [];
  const fields: { persistent_runtime?: string | null; coding_runtime?: string | null; deck_name?: string | null; working_directory?: string | null } = {};
  if (body.persistent_runtime !== undefined) {
    try {
      normalizePersistentRuntime(body.persistent_runtime);
      fields.persistent_runtime = body.persistent_runtime === null ? null : String(body.persistent_runtime);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.coding_runtime !== undefined) {
    try {
      const runtime = normalizeCodingRuntime(body.coding_runtime);
      fields.coding_runtime = runtime;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.deck_name !== undefined) {
    fields.deck_name = normalizeDeckName(body.deck_name);
  }
  if (body.working_directory !== undefined) {
    fields.working_directory = normalizeWorkingDirectory(body.working_directory);
  }
  return { errors, fields };
}

// Availability response: includes ONLY runtimes returned ready by the
// NOT-395 capability probe. Enum membership alone never marks a runtime
// launchable, so unknown or unprobed values are dropped here.
export function buildAvailabilityPayload(ready: readonly unknown[]): { runtimes: AvailabilityEntry[] } {
  const runtimes: AvailabilityEntry[] = [];
  for (const runtime of ready) {
    if (typeof runtime === 'string' && (CODING_RUNTIMES as readonly string[]).includes(runtime)) {
      runtimes.push({ runtime, launchable: true });
    }
  }
  return { runtimes };
}
