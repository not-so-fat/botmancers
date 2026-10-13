// NOT-442: single bot runtime contract.
//
// Each bot resolves to exactly one runtime:
//
// - 'hermes': the persistent conversational runtime (default for newly
//   created bots). Hermes bots reject Agent Deck-only fields.
// - 'agent-deck': an ordinary message launches the stored agent client
//   (exactly codex|claude|cursor|muse) on the stored deck ID directly,
//   with the stored working directory as an optional override. No
//   Hermes turn runs first and no Hermes-generated DECK directive is
//   parsed: the stored configuration IS the launch.
//
// An Agent Deck bot whose deck was never resolved (migrated legacy rows)
// carries the old free-text deck_name as an unresolved reference, a null
// deck ID, and needs_deck_reselection=true, and cannot launch until the
// owner selects a deck ID (NOT-443/NOT-445 resolve the name only through
// deck discovery, never by guessing).
//
// This module is pure (no I/O, no network) so the plain-node test suite
// can load it through jiti. The DB migration in ./db.ts applies
// migrateLegacyRuntimeFields to every runtime-less row.
import { resolveAvatar, type AvatarConfig } from './avatar';

export const RUNTIME_HERMES = 'hermes' as const;
export const RUNTIME_AGENT_DECK = 'agent-deck' as const;

export const RUNTIMES = [RUNTIME_HERMES, RUNTIME_AGENT_DECK] as const;

export type BotRuntime = (typeof RUNTIMES)[number];

// Mirrors DECK_RUNTIMES in ./agent-deck-run (the run adapter). The enum
// alone never marks a client launchable; only the capability probe
// (probeDeckRuntime / listAvailableDeckRuntimes) advertises launchability.
export const AGENT_CLIENTS = ['codex', 'claude', 'cursor', 'muse'] as const;

export type AgentClient = (typeof AGENT_CLIENTS)[number];

export class InvalidRuntimeError extends Error {
  readonly code = 'invalid-runtime';
  constructor(value: unknown) {
    super(
      `Invalid runtime: ${JSON.stringify(String(value))}. Expected one of ${RUNTIMES.join('|')}.`
    );
  }
}

export class InvalidAgentClientError extends Error {
  readonly code = 'invalid-agent-client';
  constructor(value: unknown) {
    super(
      `Invalid agent client: ${JSON.stringify(String(value))}. Expected one of ${AGENT_CLIENTS.join('|')}.`
    );
  }
}

export interface BotLike {
  name?: unknown;
  runtime?: string | null;
  agent_client?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_reselection?: boolean | number | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
}

// Runtime: Hermes is the default for newly created bots.
// Null/undefined/blank reads back as 'hermes'. Any other value fails
// closed.
export function normalizeRuntime(value: unknown): BotRuntime {
  if (value === null || value === undefined) return RUNTIME_HERMES;
  const text = String(value).trim();
  if (!text) return RUNTIME_HERMES;
  if ((RUNTIMES as readonly string[]).includes(text)) {
    return text as BotRuntime;
  }
  throw new InvalidRuntimeError(value);
}

// Agent client: null/undefined/blank means "not supplied" (null, never
// invented). A supplied value must be exactly one of the four clients.
export function normalizeAgentClient(value: unknown): AgentClient | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if ((AGENT_CLIENTS as readonly string[]).includes(text)) {
    return text as AgentClient;
  }
  throw new InvalidAgentClientError(value);
}

function normalizeIdText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// Resolved deck ID. Only a selected ID launches; the legacy free-text
// deck_name never resolves to an ID here (NOT-443/NOT-445 resolve it
// through deck discovery only).
export function normalizeDeckId(value: unknown): string | null {
  return normalizeIdText(value);
}

// Unresolved deck reference: the migrated legacy free-text deck name,
// preserved so the owner can re-select it. Null once a deck ID is
// selected. Never used as a launch target.
export function normalizeDeckName(value: unknown): string | null {
  return normalizeIdText(value);
}

// Optional working-directory override for Agent Deck launches. Null
// means "launch with the process working directory".
export function normalizeWorkingDirectory(value: unknown): string | null {
  return normalizeIdText(value);
}

export function normalizeNeedsDeckReselection(value: unknown): boolean {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true';
  }
  return false;
}

export interface ResolvedRuntime {
  runtime: BotRuntime;
  agent_client: AgentClient | null;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_reselection: boolean;
  // Hermes bots are always launchable (they chat). Agent Deck bots
  // launch only with a valid client, a selected deck ID, and no pending
  // re-selection.
  launchable: boolean;
}

// Resolved single runtime for a stored bot row. Unknown stored runtimes
// fail closed to Hermes; Hermes rows never report Agent Deck fields.
export function resolveRuntime(bot: BotLike): ResolvedRuntime {
  let runtime: BotRuntime;
  try {
    runtime = normalizeRuntime(bot.runtime);
  } catch {
    runtime = RUNTIME_HERMES;
  }
  if (runtime !== RUNTIME_AGENT_DECK) {
    return {
      runtime: RUNTIME_HERMES,
      agent_client: null,
      deck_id: null,
      deck_name: null,
      working_directory: null,
      needs_deck_reselection: false,
      launchable: true,
    };
  }
  let agent_client: AgentClient | null = null;
  try {
    agent_client = normalizeAgentClient(bot.agent_client);
  } catch {
    agent_client = null;
  }
  const deck_id = normalizeDeckId(bot.deck_id);
  const deck_name = normalizeDeckName(bot.deck_name);
  const working_directory = normalizeWorkingDirectory(bot.working_directory);
  const needs_deck_reselection = normalizeNeedsDeckReselection(bot.needs_deck_reselection);
  const launchable = agent_client !== null && deck_id !== null && !needs_deck_reselection;
  return { runtime, agent_client, deck_id, deck_name, working_directory, needs_deck_reselection, launchable };
}

export function isAgentDeckBot(bot: BotLike): boolean {
  return resolveRuntime(bot).runtime === RUNTIME_AGENT_DECK;
}

// Effective working directory for an Agent Deck launch: the stored
// override, or the caller-supplied fallback (the process working
// directory at dispatch time). NOT-443 dispatch no longer uses this
// fallback: lib/agent-deck-settings resolveAndEnsureBotWorkdir resolves
// a missing override to ~/.botmancers/{botId} instead.
export function effectiveWorkingDirectory(bot: BotLike, fallback: string): string {
  const override = normalizeWorkingDirectory(bot.working_directory);
  return override ?? fallback;
}

export interface LegacyRuntimeRow {
  runtime?: unknown;
  // Legacy dual-model fields (NOT-433/NOT-434): read-only inputs to the
  // migration below. New code never reads them for dispatch.
  persistent_runtime?: unknown;
  coding_runtime?: unknown;
  agent_client?: unknown;
  deck_id?: unknown;
  deck_name?: unknown;
  working_directory?: unknown;
  needs_deck_reselection?: unknown;
}

export interface MigratedRuntimeFields {
  runtime: BotRuntime;
  agent_client: AgentClient | null;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_reselection: boolean;
  // True when the row carried no new-shape runtime and the rule assigned
  // one. False when the row already stored a runtime (untouched).
  migrated: boolean;
}

function legacyCompleteCodingPath(row: LegacyRuntimeRow): {
  client: AgentClient;
  deck_name: string;
  working_directory: string;
} | null {
  let client: AgentClient | null = null;
  try {
    client = normalizeAgentClient(row.coding_runtime);
  } catch {
    return null;
  }
  if (!client) return null;
  const deck_name = normalizeDeckName(row.deck_name);
  const working_directory = normalizeWorkingDirectory(row.working_directory);
  if (!deck_name || !working_directory) return null;
  return { client, deck_name, working_directory };
}

// Deterministic NOT-442 migration for one stored row. Pure: no I/O and
// no network calls (deck discovery never runs here).
//
// - A row that already stores a runtime is returned untouched.
// - A runtime-less row with a complete valid legacy coding path (valid
//   client plus non-blank deck_name and working_directory) becomes
//   agent-deck: it retains its agent client and working-directory
//   override, keeps the legacy free-text deck_name only as an unresolved
//   reference, stores no deck ID, and is marked as needing deck
//   re-selection before it can launch.
// - Every other runtime-less row (partial, invalid, imported, or
//   unconfigured) becomes hermes with all Agent Deck fields cleared.
export function migrateLegacyRuntimeFields(row: LegacyRuntimeRow): MigratedRuntimeFields {
  const hasRuntime =
    row.runtime !== null && row.runtime !== undefined && String(row.runtime).trim() !== '';
  if (hasRuntime) {
    try {
      const runtime = normalizeRuntime(row.runtime);
      if (runtime === RUNTIME_AGENT_DECK) {
        let agent_client: AgentClient | null = null;
        try {
          agent_client = normalizeAgentClient(row.agent_client);
        } catch {
          agent_client = null;
        }
        return {
          runtime,
          agent_client,
          deck_id: normalizeDeckId(row.deck_id),
          deck_name: normalizeDeckName(row.deck_name),
          working_directory: normalizeWorkingDirectory(row.working_directory),
          needs_deck_reselection: normalizeNeedsDeckReselection(row.needs_deck_reselection),
          migrated: false,
        };
      }
      return {
        runtime: RUNTIME_HERMES,
        agent_client: null,
        deck_id: null,
        deck_name: null,
        working_directory: null,
        needs_deck_reselection: false,
        migrated: false,
      };
    } catch {
      // Invalid stored runtime falls through to the legacy rule, which
      // fails closed to hermes unless a complete legacy path exists.
    }
  }
  const complete = legacyCompleteCodingPath(row);
  if (complete) {
    return {
      runtime: RUNTIME_AGENT_DECK,
      agent_client: complete.client,
      deck_id: null,
      deck_name: complete.deck_name,
      working_directory: complete.working_directory,
      needs_deck_reselection: true,
      migrated: true,
    };
  }
  return {
    runtime: RUNTIME_HERMES,
    agent_client: null,
    deck_id: null,
    deck_name: null,
    working_directory: null,
    needs_deck_reselection: false,
    migrated: true,
  };
}

export interface SerializedBot {
  runtime: BotRuntime;
  agent_client: AgentClient | null;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_reselection: boolean;
  launchable: boolean;
  avatar_config: AvatarConfig;
}

// API read shape: exactly one runtime plus its resolved configuration.
// Legacy dual-model keys (persistent_runtime/coding_runtime) are
// stripped: responses carry the single runtime only. Avatar fields
// resolve to the NOT-431 defaults until the owner configures them.
export function serializeBot<T extends BotLike>(bot: T): Omit<T, 'persistent_runtime' | 'coding_runtime'> & SerializedBot {
  const resolved = resolveRuntime(bot);
  const { persistent_runtime: _droppedPersistent, coding_runtime: _droppedCoding, ...rest } = bot as BotLike & {
    persistent_runtime?: unknown;
    coding_runtime?: unknown;
  };
  void _droppedPersistent;
  void _droppedCoding;
  return {
    ...rest,
    runtime: resolved.runtime,
    agent_client: resolved.agent_client,
    deck_id: resolved.deck_id,
    deck_name: resolved.deck_name,
    working_directory: resolved.working_directory,
    needs_deck_reselection: resolved.needs_deck_reselection,
    launchable: resolved.launchable,
    avatar_config: resolveAvatar(bot),
  } as Omit<T, 'persistent_runtime' | 'coding_runtime'> & SerializedBot;
}

export interface AvailabilityEntry {
  runtime: string;
  launchable: boolean;
}

export interface NormalizedRuntimePath {
  runtime: BotRuntime;
  agent_client: AgentClient | null;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_reselection: boolean;
}

// Shared create contract for POST /api/bots: Hermes is the default.
// Agent Deck requires a valid client plus a selected deck ID; the
// working-directory override stays optional. Non-blank Agent Deck fields
// on a Hermes bot are rejected (never silently stored). Legacy
// dual-model keys (persistent_runtime/coding_runtime) are not read:
// stored rows migrate through the DB migration, not the API.
export function validateCreateRuntimePath(body: Record<string, unknown>): {
  errors: string[];
  normalized: NormalizedRuntimePath;
} {
  const errors: string[] = [];
  let runtime: BotRuntime = RUNTIME_HERMES;
  try {
    runtime = normalizeRuntime(body.runtime);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let agent_client: AgentClient | null = null;
  try {
    agent_client = normalizeAgentClient(body.agent_client);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const deck_id = normalizeDeckId(body.deck_id);
  const deck_name = normalizeDeckName(body.deck_name);
  const working_directory = normalizeWorkingDirectory(body.working_directory);
  if (runtime === RUNTIME_AGENT_DECK) {
    if (!agent_client) {
      errors.push(
        `Invalid agent client: ${JSON.stringify(String((body.agent_client ?? '')))}. Expected one of ${AGENT_CLIENTS.join('|')}.`
      );
    }
    if (!deck_id) {
      errors.push('Deck ID is required for an agent-deck bot. Select a deck before creating it.');
    }
  } else if (agent_client !== null || deck_id !== null || deck_name !== null || working_directory !== null) {
    errors.push('Agent Deck fields are not accepted for a Hermes bot. Use runtime=agent-deck to store them.');
  }
  return {
    errors,
    normalized: {
      runtime,
      agent_client: runtime === RUNTIME_AGENT_DECK ? agent_client : null,
      deck_id: runtime === RUNTIME_AGENT_DECK ? deck_id : null,
      deck_name: runtime === RUNTIME_AGENT_DECK ? deck_name : null,
      working_directory: runtime === RUNTIME_AGENT_DECK ? working_directory : null,
      needs_deck_reselection: false,
    },
  };
}

// Shared update contract for PATCH /api/bots: validates only the
// supplied fields. Unknown runtimes/clients are rejected; blank values
// clear a field.
//
// When the stored row is supplied, the merged agent-deck state is also
// checked: an agent-deck bot requires a valid agent client (clearing it
// or leaving it absent is rejected, never stored as an unlaunchable
// row) and a selected deck ID, unless the stored row is already an
// unresolved migrated row (null deck ID / needs_deck_reselection, which
// only the migration produces and only deck re-selection resolves). A
// switch to agent-deck from any other stored state without a deck ID is
// rejected rather than stored as a new unlaunchable row. Without the
// stored row only a self-contained switch to agent-deck can be checked.
export function validateUpdateRuntimePath(body: Record<string, unknown>, current?: BotLike): {
  errors: string[];
  fields: { runtime?: BotRuntime; agent_client?: AgentClient | null; deck_id?: string | null; deck_name?: string | null; working_directory?: string | null };
} {
  const errors: string[] = [];
  const fields: { runtime?: BotRuntime; agent_client?: AgentClient | null; deck_id?: string | null; deck_name?: string | null; working_directory?: string | null } = {};
  if (body.runtime !== undefined) {
    try {
      fields.runtime = normalizeRuntime(body.runtime);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.agent_client !== undefined) {
    try {
      fields.agent_client = normalizeAgentClient(body.agent_client);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.deck_id !== undefined) {
    fields.deck_id = normalizeDeckId(body.deck_id);
  }
  if (body.deck_name !== undefined) {
    fields.deck_name = normalizeDeckName(body.deck_name);
  }
  if (body.working_directory !== undefined) {
    fields.working_directory = normalizeWorkingDirectory(body.working_directory);
  }
  // Merged agent-deck invariant: the resulting row must carry a valid
  // agent client and a selected deck ID, unless the stored row is
  // already an unresolved migrated row (needs-deck-reselection with no
  // deck ID): only the migration may introduce that state, and only
  // selecting a deck ID resolves it. Client absence has no such
  // representable state and is always rejected instead of stored.
  const stored = current !== undefined ? resolveRuntime(current) : null;
  const mergedRuntime = fields.runtime ?? stored?.runtime;
  if (mergedRuntime === RUNTIME_AGENT_DECK) {
    const mergedClient = fields.agent_client !== undefined ? fields.agent_client : stored?.agent_client;
    if (mergedClient === undefined) {
      // No stored row to merge with (fields.agent_client is absent
      // here): a self-contained switch to agent-deck must carry its
      // client in the same body.
      if (fields.runtime === RUNTIME_AGENT_DECK) {
        errors.push(
          `Invalid agent client: ${JSON.stringify(String(((body as Record<string, unknown>).agent_client ?? '')))}. Expected one of ${AGENT_CLIENTS.join('|')}.`
        );
      }
    } else if (mergedClient === null) {
      errors.push(
        `Invalid agent client: ${JSON.stringify(String(((body as Record<string, unknown>).agent_client ?? stored?.agent_client ?? '')))}. Expected one of ${AGENT_CLIENTS.join('|')}.`
      );
    }
    const mergedDeckId = fields.deck_id !== undefined ? fields.deck_id : stored?.deck_id;
    const storedUnresolved =
      stored !== null &&
      stored.runtime === RUNTIME_AGENT_DECK &&
      (stored.deck_id === null || stored.needs_deck_reselection === true);
    if (!storedUnresolved) {
      if (mergedDeckId === undefined) {
        // No stored row to merge with: a self-contained switch to
        // agent-deck must carry its deck ID in the same body.
        if (fields.runtime === RUNTIME_AGENT_DECK) {
          errors.push('Deck ID is required for an agent-deck bot. Select a deck before creating it.');
        }
      } else if (mergedDeckId === null) {
        errors.push('Deck ID is required for an agent-deck bot. Select a deck before creating it.');
      }
    }
  }
  return { errors, fields };
}

export interface RuntimeUpdateFields {
  runtime?: BotRuntime;
  agent_client?: AgentClient | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
}

// Pure runtime transition for PATCH: merges supplied fields onto the
// stored row and enforces the single-runtime invariants:
//
// - Switching to hermes clears every Agent Deck field.
// - Selecting a deck ID resolves the pending re-selection and drops the
//   legacy unresolved deck_name.
// - Switching to agent-deck without a deck ID keeps the unresolved
//   reference (if any) and requires re-selection before launch.
export function applyRuntimeUpdate(
  current: BotLike,
  update: RuntimeUpdateFields
): { runtime: BotRuntime; agent_client: AgentClient | null; deck_id: string | null; deck_name: string | null; working_directory: string | null; needs_deck_reselection: boolean } {
  const stored = resolveRuntime(current);
  const runtime = update.runtime ?? stored.runtime;
  if (runtime !== RUNTIME_AGENT_DECK) {
    return {
      runtime: RUNTIME_HERMES,
      agent_client: null,
      deck_id: null,
      deck_name: null,
      working_directory: null,
      needs_deck_reselection: false,
    };
  }
  const agent_client = update.agent_client !== undefined ? update.agent_client : stored.agent_client;
  const deck_id = update.deck_id !== undefined ? update.deck_id : stored.deck_id;
  // A freshly selected deck ID resolves any pending re-selection and
  // drops the legacy unresolved name it replaces, but only alongside a
  // valid agent client: a deck ID with no client is still unlaunchable.
  if (update.deck_id !== undefined && update.deck_id !== null) {
    return {
      runtime,
      agent_client,
      deck_id,
      deck_name: null,
      working_directory: update.working_directory !== undefined ? update.working_directory : stored.working_directory,
      needs_deck_reselection: agent_client === null,
    };
  }
  const deck_name = update.deck_name !== undefined ? update.deck_name : stored.deck_name;
  const working_directory = update.working_directory !== undefined ? update.working_directory : stored.working_directory;
  // Without a selected deck ID or a valid agent client the bot cannot
  // launch: selecting a deck ID is the only transition that clears the
  // marker (handled above). The API validator rejects client-less
  // merges, so this marker is defense in depth for direct callers.
  const needs_deck_reselection = deck_id === null || agent_client === null;
  return { runtime, agent_client, deck_id, deck_name, working_directory, needs_deck_reselection };
}

// Availability response: includes ONLY clients returned ready by the
// run-adapter capability probe. Enum membership alone never marks a
// client launchable, so unknown or unprobed values are dropped here.
export function buildAvailabilityPayload(ready: readonly unknown[]): { runtimes: AvailabilityEntry[] } {
  const runtimes: AvailabilityEntry[] = [];
  for (const runtime of ready) {
    if (typeof runtime === 'string' && (AGENT_CLIENTS as readonly string[]).includes(runtime)) {
      runtimes.push({ runtime, launchable: true });
    }
  }
  return { runtimes };
}
