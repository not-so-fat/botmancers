// NOT-543: direct-only Agent contract.
//
// Every bot stores one executable agent, exactly one of
// hermes | cursor | claude | codex | muse (Hermes, Cursor, Claude,
// Codex, Muse Code), plus its registered-Agent choices (a required
// runtime connection, an explicit session scope, an optional default
// workspace, and a launch policy; see ./agent-registration).
//
// There is no launch profile, deck, or working-directory override:
// Hermes turns run on the persistent Hermes gateway and coding-agent
// turns run direct local provider Sessions through the Agent's runtime
// connection. A bot launches only with a valid agent, a runtime
// connection, and a usable session scope. Rows without them stay
// readable and unlaunchable until the owner configures them locally.
//
// Legacy columns (runtime, agent_client, persistent_runtime,
// coding_runtime, needs_deck_reselection, deck_id, deck_name,
// working_directory, needs_deck_selection, launch_profile) are migration
// inputs only: the API rejects them on write, serialization strips them,
// and new rows never write them.
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
// birth/import/duplicate paths).
export const DEFAULT_AGENT: BotAgent = AGENT_HERMES;

// Launch adapter per agent. Hermes turns run on the persistent Hermes
// gateway; the coding agents run direct local provider Sessions.
export type AgentTransport = 'hermes-gateway' | 'session-provider';

export const AGENT_TRANSPORTS: Record<BotAgent, AgentTransport> = {
  hermes: 'hermes-gateway',
  cursor: 'session-provider',
  claude: 'session-provider',
  codex: 'session-provider',
  muse: 'session-provider',
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

export const AGENT_REQUIRED_ERROR = `Agent is required. Expected one of ${AGENTS.join('|')}.`;
export const LEGACY_RUNTIME_FIELD_ERROR =
  'Fields runtime/agent_client are no longer accepted. Register with a runtime connection, session scope, and policy instead.';

// Legacy launch-configuration fields, rejected on write. Deck selection,
// the working-directory override, and the launch profile are not part of
// the direct product contract.
export const REMOVED_LAUNCH_FIELD_ERROR =
  'Fields launch_profile/deck_id/deck_name/working_directory are no longer accepted. An Agent launches direct from its runtime connection, session scope, default workspace, and policy.';

export interface BotLike {
  name?: unknown;
  agent?: string | null;
  runtime_connection_id?: string | null;
  session_scope_kind?: string | null;
  session_scope_items?: string | null;
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

export function normalizeConnectionId(value: unknown): string | null {
  return normalizeIdText(value);
}

// Why a bot cannot launch, most fundamental first. Null when launchable.
export type LaunchBlocker = 'agent' | 'connection' | 'session_scope' | null;

export interface ResolvedAgent {
  agent: BotAgent;
  runtime_connection_id: string | null;
  // Launches only with a valid agent, a runtime connection, and a
  // non-empty session scope. A missing connection or scope fails closed
  // with a direct-runtime explanation at dispatch.
  launchable: boolean;
  launch_blocker: LaunchBlocker;
}

function storedScopeUsable(bot: BotLike): boolean {
  if (!('session_scope_kind' in bot)) return true;
  const kind = bot.session_scope_kind;
  let items: unknown = [];
  try {
    items = bot.session_scope_items ? JSON.parse(bot.session_scope_items) : [];
  } catch {
    return false;
  }
  if (!Array.isArray(items)) return false;
  const count = items.filter(item => typeof item === 'string' && item.trim()).length;
  if (kind === 'all_provider_sessions') return count === 0;
  return (kind === 'workspaces' || kind === 'sessions') && count > 0;
}

// Resolved agent + launch state for a stored bot row. A missing agent
// reads as the default; an unknown stored agent fails closed.
export function resolveAgent(bot: BotLike): ResolvedAgent {
  let agent: BotAgent = DEFAULT_AGENT;
  let agentValid = true;
  try {
    agent = normalizeAgent(bot.agent) ?? DEFAULT_AGENT;
  } catch {
    agentValid = false;
  }
  const runtime_connection_id = normalizeConnectionId(bot.runtime_connection_id);
  let launch_blocker: LaunchBlocker = null;
  if (!agentValid) launch_blocker = 'agent';
  else if (!runtime_connection_id) launch_blocker = 'connection';
  else if (!storedScopeUsable(bot)) launch_blocker = 'session_scope';
  return { agent, runtime_connection_id, launchable: launch_blocker === null, launch_blocker };
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
  deck_name?: unknown;
  working_directory?: unknown;
}

export interface MigratedAgentFields {
  agent: BotAgent;
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

// Deterministic agent migration for one stored row. Pure: no I/O and no
// network calls. Only the agent identity is assigned here; launch
// configuration migrates separately (NOT-502 registration, NOT-543
// direct cutover).
//
// - A row that already stores a valid agent is returned untouched.
// - runtime=hermes becomes agent=hermes.
// - runtime=agent-deck with agent_client becomes that agent.
// - A pre-NOT-442 row (no runtime) with a complete legacy coding path
//   (valid coding_runtime plus non-blank deck_name and working_directory)
//   becomes that coding agent; any other pre-NOT-442 row becomes hermes.
// - A runtime=agent-deck row whose client is missing or invalid becomes
//   hermes (the default).
export function migrateLegacyAgentFields(row: LegacyAgentRow): MigratedAgentFields {
  try {
    const stored = normalizeAgent(row.agent);
    if (stored) return { agent: stored, migrated: false };
  } catch {
    // Unknown stored agent falls through to the legacy rule.
  }
  const runtime = normalizeIdText(row.runtime);
  let agent: BotAgent = DEFAULT_AGENT;
  if (runtime === 'agent-deck') {
    agent = legacyClient(row.agent_client) ?? DEFAULT_AGENT;
  } else if (runtime !== 'hermes') {
    const client = legacyClient(row.coding_runtime);
    const deckName = normalizeIdText(row.deck_name);
    const workingDirectory = normalizeIdText(row.working_directory);
    if (client && deckName && workingDirectory) agent = client;
  }
  return { agent, migrated: true };
}

// Storage columns that are never part of the public read shape: the
// NOT-433/NOT-442 runtime inputs and the removed NOT-456/NOT-502 launch
// configuration (deck selection, working-directory override, launch
// profile).
const LEGACY_KEYS = [
  'runtime', 'agent_client', 'persistent_runtime', 'coding_runtime', 'needs_deck_reselection',
  'deck_id', 'deck_name', 'working_directory', 'needs_deck_selection', 'launch_profile',
] as const;

type LegacyKey = (typeof LEGACY_KEYS)[number];

export interface SerializedBot {
  agent: BotAgent;
  runtime_connection_id: string | null;
  launchable: boolean;
  launch_blocker: LaunchBlocker;
  avatar_config: AvatarConfig;
}

// API read shape: one agent identity plus its direct launch state.
// Legacy launch keys are stripped. Avatar fields resolve to the NOT-431
// defaults until the owner configures them.
export function serializeBot<T extends BotLike>(bot: T): Omit<T, LegacyKey> & SerializedBot {
  const resolved = resolveAgent(bot);
  const rest: Record<string, unknown> = { ...(bot as Record<string, unknown>) };
  for (const key of LEGACY_KEYS) delete rest[key];
  return {
    ...rest,
    agent: resolved.agent,
    runtime_connection_id: resolved.runtime_connection_id,
    launchable: resolved.launchable,
    launch_blocker: resolved.launch_blocker,
    avatar_config: resolveAvatar(bot),
  } as Omit<T, LegacyKey> & SerializedBot;
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
