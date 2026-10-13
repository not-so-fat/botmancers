// NOT-456: Agent + Agent Deck bot contract.
//
// Every bot stores two independent choices:
//
// - agent: the executable agent, exactly one of
//   hermes | cursor | claude | codex | muse (Hermes, Cursor, Claude,
//   Codex, Muse Code). Agent Deck is never an agent.
// - deck_id: the Agent Deck selected from the workspace Agent Deck
//   server. Agent Deck is the orchestration/configuration context every
//   agent launches with, for Hermes exactly as for the coding agents.
//
// The working directory is an optional launch override. A bot launches
// only with a valid agent and a selected deck ID. Rows without a selected
// deck (migrated legacy rows, internally created bots) stay readable,
// carry needs_deck_selection=true, and cannot launch until the owner
// selects a deck ID. A legacy free-text deck_name is kept only as an
// unresolved reference: no deck ID is ever guessed from a name.
//
// Legacy columns (runtime, agent_client, persistent_runtime,
// coding_runtime, needs_deck_reselection) are migration inputs only: the
// API rejects them on write, serialization strips them, and new rows
// never write them.
//
// This module is pure (no I/O, no network) so the plain-node test suite
// can load it through jiti. The DB migration in ./db.ts applies
// migrateLegacyAgentFields to every row without an agent.
import { resolveAvatar, type AvatarConfig } from './avatar';

export const AGENT_HERMES = 'hermes' as const;

// Canonical, ordered agent enum.
export const AGENTS = ['hermes', 'cursor', 'claude', 'codex', 'muse'] as const;

export type BotAgent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<BotAgent, string> = {
  hermes: 'Hermes',
  cursor: 'Cursor',
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse Code',
};

// Default agent for bots created without an explicit choice (internal
// birth/import/duplicate paths). The deck is never defaulted.
export const DEFAULT_AGENT: BotAgent = AGENT_HERMES;

// Launch adapter per agent. Every agent launches on its selected deck;
// the adapter is only the transport that serves the turn. Hermes turns
// run on the persistent Hermes gateway, the coding agents through
// `agent-deck run --client <agent>`.
export type AgentTransport = 'hermes-gateway' | 'agent-deck-run';

export const AGENT_TRANSPORTS: Record<BotAgent, AgentTransport> = {
  hermes: 'hermes-gateway',
  cursor: 'agent-deck-run',
  claude: 'agent-deck-run',
  codex: 'agent-deck-run',
  muse: 'agent-deck-run',
};

export function agentTransport(agent: BotAgent): AgentTransport {
  return AGENT_TRANSPORTS[agent];
}

export function agentLabel(agent: string | null | undefined): string {
  return (AGENTS as readonly string[]).includes(String(agent)) ? AGENT_LABELS[agent as BotAgent] : String(agent ?? '');
}

export class InvalidAgentError extends Error {
  readonly code = 'invalid-agent';
  constructor(value: unknown) {
    super(`Invalid agent: ${JSON.stringify(String(value))}. Expected one of ${AGENTS.join('|')}.`);
  }
}

export class InvalidDeckIdError extends Error {
  readonly code = 'invalid-deck';
  constructor(value: unknown) {
    super(`Invalid deck ID: ${JSON.stringify(typeof value === 'string' ? value : String(value))}. Select a deck from the configured Agent Deck server.`);
  }
}

export const DECK_REQUIRED_ERROR = 'Deck ID is required. Select an Agent Deck before saving this agent.';
export const AGENT_REQUIRED_ERROR = `Agent is required. Expected one of ${AGENTS.join('|')}.`;
export const LEGACY_RUNTIME_FIELD_ERROR =
  'Fields runtime/agent_client are no longer accepted. Send agent (hermes|cursor|claude|codex|muse) and deck_id instead.';
export const LEGACY_DECK_NAME_FIELD_ERROR =
  'deck_name is a read-only legacy reference. Select a deck_id from the configured Agent Deck server instead.';

export interface BotLike {
  name?: unknown;
  agent?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: boolean | number | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
}

// Agent: null/undefined/blank means "not supplied". A supplied value must
// be exactly one of the five agents.
export function normalizeAgent(value: unknown): BotAgent | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if ((AGENTS as readonly string[]).includes(text)) return text as BotAgent;
  throw new InvalidAgentError(value);
}

function normalizeIdText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// Selected deck ID read from storage. Only a selected ID launches; the
// legacy free-text deck_name never resolves to an ID here.
export function normalizeDeckId(value: unknown): string | null {
  return normalizeIdText(value);
}

// Deck ID supplied by a create/update request: a non-blank string with
// no whitespace or control characters. Blank returns null (the caller
// decides whether that is "missing"); anything else malformed throws.
const DECK_ID_MAX_LENGTH = 200;

function isWellFormedDeckId(text: string): boolean {
  if (text.length > DECK_ID_MAX_LENGTH || /\s/.test(text)) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function parseRequestDeckId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new InvalidDeckIdError(value);
  const text = value.trim();
  if (!text) return null;
  if (!isWellFormedDeckId(text)) throw new InvalidDeckIdError(value);
  return text;
}

// Unresolved legacy deck reference, preserved so the owner can re-select
// it. Null once a deck ID is selected. Never used as a launch target.
export function normalizeDeckName(value: unknown): string | null {
  return normalizeIdText(value);
}

// Optional working-directory override. Null means "launch with the
// per-bot default workdir" (~/.botmancers/{botId}).
export function normalizeWorkingDirectory(value: unknown): string | null {
  return normalizeIdText(value);
}

function normalizeFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true';
  }
  return false;
}

export function normalizeNeedsDeckSelection(value: unknown): boolean {
  return normalizeFlag(value);
}

export interface ResolvedAgent {
  agent: BotAgent;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_selection: boolean;
  // Launches only with a valid agent, a selected deck ID, and no pending
  // deck selection. Identical rule for every agent, Hermes included.
  launchable: boolean;
}

// Resolved agent + deck for a stored bot row. A missing agent reads as
// the default; an unknown stored agent fails closed (not launchable).
export function resolveAgent(bot: BotLike): ResolvedAgent {
  let agent: BotAgent = DEFAULT_AGENT;
  let agentValid = true;
  try {
    agent = normalizeAgent(bot.agent) ?? DEFAULT_AGENT;
  } catch {
    agentValid = false;
  }
  const deck_id = normalizeDeckId(bot.deck_id);
  const deck_name = normalizeDeckName(bot.deck_name);
  const working_directory = normalizeWorkingDirectory(bot.working_directory);
  const needs_deck_selection = deck_id === null || normalizeNeedsDeckSelection(bot.needs_deck_selection);
  const launchable = agentValid && !needs_deck_selection;
  return { agent, deck_id, deck_name, working_directory, needs_deck_selection, launchable };
}

export function isLaunchable(bot: BotLike): boolean {
  return resolveAgent(bot).launchable;
}

export interface LegacyAgentRow {
  agent?: unknown;
  // Legacy inputs (NOT-433 dual model, NOT-442 single runtime). Read only
  // by the migration below; never written by new code.
  runtime?: unknown;
  agent_client?: unknown;
  persistent_runtime?: unknown;
  coding_runtime?: unknown;
  needs_deck_reselection?: unknown;
  deck_id?: unknown;
  deck_name?: unknown;
  working_directory?: unknown;
  needs_deck_selection?: unknown;
}

export interface MigratedAgentFields {
  agent: BotAgent;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_selection: boolean;
  // True when the row carried no agent and the rule assigned one. False
  // when the row already stored a valid agent (untouched).
  migrated: boolean;
}

// The four coding agents that the legacy runtime=agent-deck shape stored
// as agent_client (and the NOT-433 shape as coding_runtime).
const LEGACY_DECK_CLIENTS: readonly string[] = ['codex', 'claude', 'cursor', 'muse'];

function legacyClient(value: unknown): BotAgent | null {
  const text = normalizeIdText(value);
  return text && LEGACY_DECK_CLIENTS.includes(text) ? (text as BotAgent) : null;
}

// Deterministic NOT-456 migration for one stored row. Pure: no I/O and
// no network calls (deck discovery never runs here, and no deck ID is
// guessed from a deck name).
//
// - A row that already stores a valid agent is returned untouched.
// - runtime=hermes becomes agent=hermes.
// - runtime=agent-deck with agent_client becomes that agent.
// - A pre-NOT-442 row (no runtime) with a complete legacy coding path
//   (valid coding_runtime plus non-blank deck_name and working_directory)
//   becomes that coding agent; any other pre-NOT-442 row becomes hermes.
// - A runtime=agent-deck row whose client is missing or invalid becomes
//   hermes (the default) and is marked as needing deck selection.
//
// deck_id, deck_name, and working_directory are always carried over
// verbatim. needs_deck_selection is set whenever no deck ID is stored or
// the legacy row was already marked for re-selection.
export function migrateLegacyAgentFields(row: LegacyAgentRow): MigratedAgentFields {
  const deck_id = normalizeDeckId(row.deck_id);
  const deck_name = normalizeDeckName(row.deck_name);
  const working_directory = normalizeWorkingDirectory(row.working_directory);
  try {
    const stored = normalizeAgent(row.agent);
    if (stored) {
      return {
        agent: stored,
        deck_id,
        deck_name,
        working_directory,
        needs_deck_selection: deck_id === null || normalizeNeedsDeckSelection(row.needs_deck_selection),
        migrated: false,
      };
    }
  } catch {
    // Unknown stored agent falls through to the legacy rule.
  }
  const runtime = normalizeIdText(row.runtime);
  let agent: BotAgent = DEFAULT_AGENT;
  let forceSelection = normalizeFlag(row.needs_deck_reselection);
  if (runtime === 'agent-deck') {
    const client = legacyClient(row.agent_client);
    if (client) agent = client;
    else forceSelection = true;
  } else if (runtime !== 'hermes') {
    const client = legacyClient(row.coding_runtime);
    if (client && deck_name && working_directory) {
      agent = client;
      forceSelection = true;
    }
  }
  return {
    agent,
    deck_id,
    deck_name,
    working_directory,
    needs_deck_selection: deck_id === null || forceSelection,
    migrated: true,
  };
}

// Storage columns that are never part of the public read shape.
const LEGACY_KEYS = ['runtime', 'agent_client', 'persistent_runtime', 'coding_runtime', 'needs_deck_reselection'] as const;

type LegacyKey = (typeof LEGACY_KEYS)[number];

export interface SerializedBot {
  agent: BotAgent;
  deck_id: string | null;
  deck_name: string | null;
  working_directory: string | null;
  needs_deck_selection: boolean;
  launchable: boolean;
  avatar_config: AvatarConfig;
}

// API read shape: one agent identity plus one Agent Deck selection state.
// Legacy runtime keys are stripped. Avatar fields resolve to the NOT-431
// defaults until the owner configures them.
export function serializeBot<T extends BotLike>(bot: T): Omit<T, LegacyKey> & SerializedBot {
  const resolved = resolveAgent(bot);
  const rest: Record<string, unknown> = { ...(bot as Record<string, unknown>) };
  for (const key of LEGACY_KEYS) delete rest[key];
  return {
    ...rest,
    agent: resolved.agent,
    deck_id: resolved.deck_id,
    deck_name: resolved.deck_name,
    working_directory: resolved.working_directory,
    needs_deck_selection: resolved.needs_deck_selection,
    launchable: resolved.launchable,
    avatar_config: resolveAvatar(bot),
  } as Omit<T, LegacyKey> & SerializedBot;
}

export interface NormalizedAgentSelection {
  agent: BotAgent;
  deck_id: string;
  working_directory: string | null;
}

function rejectLegacyFields(body: Record<string, unknown>, errors: string[]): void {
  if (body.runtime !== undefined || body.agent_client !== undefined) {
    errors.push(LEGACY_RUNTIME_FIELD_ERROR);
  }
  if (body.deck_name !== undefined) {
    errors.push(LEGACY_DECK_NAME_FIELD_ERROR);
  }
}

// Shared create contract for POST /api/bots: agent defaults to Hermes
// when omitted, and a selected deck ID is always required. Unknown agents,
// malformed deck IDs, and legacy runtime fields are rejected.
export function validateCreateAgent(body: Record<string, unknown>): {
  errors: string[];
  normalized: NormalizedAgentSelection;
} {
  const errors: string[] = [];
  rejectLegacyFields(body, errors);
  let agent: BotAgent = DEFAULT_AGENT;
  try {
    agent = normalizeAgent(body.agent) ?? DEFAULT_AGENT;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  let deck_id: string | null = null;
  try {
    deck_id = parseRequestDeckId(body.deck_id);
    if (!deck_id) errors.push(DECK_REQUIRED_ERROR);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    errors,
    normalized: {
      agent,
      deck_id: deck_id ?? '',
      working_directory: normalizeWorkingDirectory(body.working_directory),
    },
  };
}

export interface AgentUpdateFields {
  agent?: BotAgent;
  deck_id?: string;
  working_directory?: string | null;
}

// Shared update contract for PATCH /api/bots: validates only the supplied
// fields. The agent can change but never clear; a supplied deck ID must be
// a selected (non-blank, well-formed) ID; a blank working directory clears
// the override. Legacy runtime fields and deck_name are rejected.
export function validateUpdateAgent(body: Record<string, unknown>): {
  errors: string[];
  fields: AgentUpdateFields;
} {
  const errors: string[] = [];
  const fields: AgentUpdateFields = {};
  rejectLegacyFields(body, errors);
  if (body.agent !== undefined) {
    try {
      const agent = normalizeAgent(body.agent);
      if (agent) fields.agent = agent;
      else errors.push(AGENT_REQUIRED_ERROR);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.deck_id !== undefined) {
    try {
      const deck_id = parseRequestDeckId(body.deck_id);
      if (deck_id) fields.deck_id = deck_id;
      else errors.push(DECK_REQUIRED_ERROR);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (body.working_directory !== undefined) {
    fields.working_directory = normalizeWorkingDirectory(body.working_directory);
  }
  return { errors, fields };
}

export function hasAgentUpdate(body: Record<string, unknown>): boolean {
  return ['agent', 'deck_id', 'working_directory', 'runtime', 'agent_client', 'deck_name'].some(key => body[key] !== undefined);
}

// Pure merge for PATCH. Selecting a deck ID resolves a pending deck
// selection and drops the legacy unresolved deck_name it replaces;
// changing only the agent or working directory keeps the deck state.
export function applyAgentUpdate(
  current: BotLike,
  update: AgentUpdateFields
): { agent: BotAgent; deck_id: string | null; deck_name: string | null; working_directory: string | null; needs_deck_selection: boolean } {
  const stored = resolveAgent(current);
  const agent = update.agent ?? stored.agent;
  const working_directory = update.working_directory !== undefined ? update.working_directory : stored.working_directory;
  if (update.deck_id !== undefined) {
    return { agent, deck_id: update.deck_id, deck_name: null, working_directory, needs_deck_selection: false };
  }
  return {
    agent,
    deck_id: stored.deck_id,
    deck_name: stored.deck_name,
    working_directory,
    needs_deck_selection: stored.needs_deck_selection,
  };
}

export interface AvailabilityEntry {
  agent: BotAgent;
  label: string;
  launchable: boolean;
}

// Availability response: includes ONLY agents whose launch adapter the
// capability probe reported ready. Enum membership alone never marks an
// agent launchable, so unknown or unprobed values are dropped here.
export function buildAvailabilityPayload(ready: readonly unknown[]): { agents: AvailabilityEntry[] } {
  const agents: AvailabilityEntry[] = [];
  for (const agent of AGENTS) {
    if (ready.includes(agent)) agents.push({ agent, label: AGENT_LABELS[agent], launchable: true });
  }
  return { agents };
}
