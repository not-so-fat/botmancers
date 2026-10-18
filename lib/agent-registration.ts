// NOT-502: registered-Agent contract on top of a runtime connection.
//
// A runtime connection is one usable runtime installation/account on one
// host ("Codex on this computer"). It stores only a provider, a label,
// and a host label: never credentials. A registered Agent is the existing
// bots row (identity: ID, name, rules, avatar) plus these explicit
// choices, stored on the same row so identity is never duplicated:
//
// - runtime_connection_id: exactly one connection. Many Agents may share
//   one. The connection's provider is the Agent's agent (the legacy
//   `agent` column is kept in sync as a compatibility read).
// - session scope: selected workspaces, selected imported sessions (the
//   Agent's own Botmancers session refs), or the explicit
//   all-provider-visible-sessions choice. An empty scope never means
//   unrestricted: it fails validation and reads back unlaunchable.
// - default_workspace: optional convenience for new sessions, never an
//   authorization scope. With a workspace scope it must sit inside one of
//   the selected workspaces.
// - launch_profile: direct | agent_deck. Only agent_deck carries a deck
//   ID and the Agent Deck working-directory override; direct never
//   contacts Agent Deck. A stored null is an unresolved legacy row: it
//   stays readable and unlaunchable until the owner chooses.
// - policy: read_only | workspace_write, allow_new_sessions,
//   allow_resume_with_edits (requires workspace_write).
// - home_session_id: optional Botmancers session ref that must belong to
//   this Agent.
//
// Pure (no I/O): lookups the validator needs arrive through
// RegistrationContext so the plain-node tests load it through jiti.
import {
  AGENTS,
  AGENT_LABELS,
  DECK_REQUIRED_ERROR,
  normalizeAgent,
  parseRequestDeckId,
  type BotAgent,
} from './bot-definition';

export const LAUNCH_PROFILES = ['direct', 'agent_deck'] as const;
export type LaunchProfile = (typeof LAUNCH_PROFILES)[number];

export const POLICY_MODES = ['read_only', 'workspace_write'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const SCOPE_KINDS = ['workspaces', 'sessions', 'all_provider_sessions'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const LOCAL_HOST = 'This computer';

export interface RuntimeConnection {
  id: string;
  provider: BotAgent;
  label: string;
  host: string;
  created_at: number;
}

export interface SessionScope {
  kind: ScopeKind;
  // Exactly one list is non-empty for workspaces/sessions; both are
  // empty for all_provider_sessions.
  workspaces: string[];
  sessions: string[];
}

export interface LaunchPolicy {
  mode: PolicyMode;
  allow_new_sessions: boolean;
  allow_resume_with_edits: boolean;
}

export interface Registration {
  runtime_connection_id: string;
  launch_profile: LaunchProfile;
  deck_id: string | null;
  working_directory: string | null;
  session_scope: SessionScope;
  default_workspace: string | null;
  policy: LaunchPolicy;
  home_session_id: string | null;
}

// Policy for rows the owner never configured (migration and internal
// creates): the existing launch authority, never more. Conversation turns
// were already read-only and every turn could start a session; resuming
// with edits was never an owner-visible choice, so it stays off.
export const MIGRATED_POLICY: LaunchPolicy = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };

export const LAUNCH_PROFILE_LABELS: Record<LaunchProfile, string> = {
  direct: 'Direct',
  agent_deck: 'Agent Deck',
};

export const POLICY_MODE_LABELS: Record<PolicyMode, string> = {
  read_only: 'Read only',
  workspace_write: 'Workspace write',
};

export const SCOPE_KIND_LABELS: Record<ScopeKind, string> = {
  workspaces: 'Selected workspaces',
  sessions: 'Selected imported sessions',
  all_provider_sessions: 'All sessions this runtime can see',
};

export const CONNECTION_REQUIRED_ERROR = 'Runtime connection is required. Pick the runtime this Agent uses.';
export const CONNECTION_NOT_FOUND_ERROR = 'Runtime connection not found.';
export const CONNECTION_PROVIDER_MISMATCH_ERROR = 'agent does not match the runtime connection provider.';
export const PROFILE_REQUIRED_ERROR = 'Launch profile is required. Choose direct or agent_deck.';
export const PROFILE_INVALID_ERROR = 'Invalid launch profile. Expected direct or agent_deck.';
export const DIRECT_DECK_ERROR = 'A direct launch profile does not use Agent Deck. Remove deck_id or choose agent_deck.';
export const DIRECT_WORKDIR_ERROR =
  'working_directory is an Agent Deck setting. Use default_workspace for a direct launch profile.';
export const SCOPE_REQUIRED_ERROR =
  'Session scope is required. Select workspaces, select sessions, or explicitly choose all_provider_sessions.';
export const SCOPE_INVALID_ERROR = 'Invalid session scope kind. Expected workspaces, sessions, or all_provider_sessions.';
export const SCOPE_EMPTY_WORKSPACES_ERROR = 'Select at least one workspace. An empty scope is never unrestricted.';
export const SCOPE_EMPTY_SESSIONS_ERROR = 'Select at least one session. An empty scope is never unrestricted.';
export const SCOPE_ALL_WITH_LIST_ERROR = 'all_provider_sessions takes no workspace or session list.';
export const SCOPE_MIXED_ERROR = 'A session scope selects workspaces or sessions, not both.';
export const SCOPE_SESSION_FOREIGN_ERROR = 'A selected session does not belong to this Agent.';
export const WORKSPACE_PATH_ERROR = 'Workspaces must be absolute paths (or start with ~/).';
export const DEFAULT_WORKSPACE_OUTSIDE_ERROR = 'default_workspace must be inside one of the selected workspaces.';
export const POLICY_REQUIRED_ERROR = 'Launch policy is required. Choose read_only or workspace_write.';
export const POLICY_MODE_ERROR = 'Invalid policy mode. Expected read_only or workspace_write.';
export const POLICY_FLAG_ERROR = 'Policy flags allow_new_sessions and allow_resume_with_edits must be true or false.';
export const POLICY_RESUME_EDITS_ERROR = 'allow_resume_with_edits requires the workspace_write policy mode.';
export const HOME_SESSION_FOREIGN_ERROR = 'home_session_id must be one of this Agent’s own sessions.';
export const HOME_SESSION_OUT_OF_SCOPE_ERROR = 'home_session_id must be one of the selected sessions.';
export const CONNECTION_LABEL_REQUIRED_ERROR = 'Connection name is required.';
export const CONNECTION_PROVIDER_REQUIRED_ERROR = `Provider is required. Expected one of ${AGENTS.join('|')}.`;

export function isLaunchProfile(value: unknown): value is LaunchProfile {
  return typeof value === 'string' && (LAUNCH_PROFILES as readonly string[]).includes(value);
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return typeof value === 'string' && (SCOPE_KINDS as readonly string[]).includes(value);
}

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out : null;
}

export function localConnectionId(provider: BotAgent): string {
  return `rc-local-${provider}`;
}

export function localConnectionLabel(provider: BotAgent): string {
  return `${AGENT_LABELS[provider]} on ${LOCAL_HOST.toLowerCase()}`;
}

export function connectionDisplay(connection: Pick<RuntimeConnection, 'provider' | 'label'>): string {
  return `${connection.label} (${AGENT_LABELS[connection.provider] ?? connection.provider})`;
}

// ---- workspace paths ----

export function isWorkspacePath(value: string): boolean {
  return value.startsWith('/') || value === '~' || value.startsWith('~/');
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function workspaceContains(parent: string, child: string): boolean {
  const p = stripTrailingSlash(parent);
  const c = stripTrailingSlash(child);
  if (p === c) return true;
  return c.startsWith(p === '/' ? '/' : `${p}/`);
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

// ---- stored row ⇄ domain ----

export interface RegistrationRow {
  agent?: string | null;
  runtime_connection_id?: string | null;
  launch_profile?: string | null;
  deck_id?: string | null;
  working_directory?: string | null;
  session_scope_kind?: string | null;
  session_scope_items?: string | null;
  default_workspace?: string | null;
  policy_mode?: string | null;
  allow_new_sessions?: number | boolean | null;
  allow_resume_with_edits?: number | boolean | null;
  home_session_id?: string | null;
  needs_deck_selection?: number | boolean | null;
}

// Stored scope, or null when nothing usable is stored (fails closed).
export function readStoredScope(row: RegistrationRow): SessionScope | null {
  const kind = row.session_scope_kind;
  if (!isScopeKind(kind)) return null;
  let items: string[] = [];
  if (row.session_scope_items) {
    try {
      const parsed = stringList(JSON.parse(row.session_scope_items));
      if (parsed === null) return null;
      items = parsed;
    } catch {
      return null;
    }
  }
  if (kind === 'all_provider_sessions') return items.length === 0 ? { kind, workspaces: [], sessions: [] } : null;
  if (items.length === 0) return null;
  return kind === 'workspaces' ? { kind, workspaces: items, sessions: [] } : { kind, workspaces: [], sessions: items };
}

export function scopeItems(scope: SessionScope): string[] {
  return scope.kind === 'workspaces' ? scope.workspaces : scope.kind === 'sessions' ? scope.sessions : [];
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function readStoredPolicy(row: RegistrationRow): LaunchPolicy | null {
  if (!isPolicyMode(row.policy_mode)) return null;
  return {
    mode: row.policy_mode,
    allow_new_sessions: flag(row.allow_new_sessions),
    allow_resume_with_edits: flag(row.allow_resume_with_edits),
  };
}

export function storedLaunchProfile(row: RegistrationRow): LaunchProfile | null {
  return isLaunchProfile(row.launch_profile) ? row.launch_profile : null;
}

// Columns written for one registration.
export function registrationColumns(reg: Registration): Record<string, string | number | null> {
  return {
    runtime_connection_id: reg.runtime_connection_id,
    launch_profile: reg.launch_profile,
    deck_id: reg.launch_profile === 'agent_deck' ? reg.deck_id : null,
    working_directory: reg.launch_profile === 'agent_deck' ? reg.working_directory : null,
    session_scope_kind: reg.session_scope.kind,
    session_scope_items: JSON.stringify(scopeItems(reg.session_scope)),
    default_workspace: reg.default_workspace,
    policy_mode: reg.policy.mode,
    allow_new_sessions: reg.policy.allow_new_sessions ? 1 : 0,
    allow_resume_with_edits: reg.policy.allow_resume_with_edits ? 1 : 0,
    home_session_id: reg.home_session_id,
    needs_deck_selection: 0,
  };
}

// ---- migration ----

export interface MigratedRegistration {
  runtime_connection_id: string;
  provider: BotAgent;
  // agent_deck for rows with a selected deck; null (unresolved) otherwise.
  launch_profile: LaunchProfile | null;
  session_scope_kind: ScopeKind;
  session_scope_items: string;
  policy_mode: PolicyMode;
  allow_new_sessions: number;
  allow_resume_with_edits: number;
}

// Deterministic NOT-502 migration for one bots row (after the NOT-456
// agent migration). The row keeps every existing column (deck_id,
// deck_name, working_directory, needs_deck_selection); this only adds the
// registration columns:
// - the local connection for its agent (shared by every row of that agent);
// - agent_deck when a deck ID is selected and no selection is pending,
//   otherwise null: unresolved, never silently direct;
// - a workspace scope of exactly the directory it already launched in
//   (the override, else ~/.botmancers/{id}), so authority never widens;
// - MIGRATED_POLICY.
export function migrateRegistration(row: {
  id: string;
  agent?: string | null;
  deck_id?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: number | boolean | null;
}): MigratedRegistration {
  let provider: BotAgent = 'hermes';
  try {
    provider = normalizeAgent(row.agent) ?? 'hermes';
  } catch {
    provider = 'hermes';
  }
  const deck = text(row.deck_id);
  const pending = flag(row.needs_deck_selection);
  const workspace = text(row.working_directory) ?? `~/.botmancers/${row.id}`;
  return {
    runtime_connection_id: localConnectionId(provider),
    provider,
    launch_profile: deck && !pending ? 'agent_deck' : null,
    session_scope_kind: 'workspaces',
    session_scope_items: JSON.stringify([workspace]),
    policy_mode: MIGRATED_POLICY.mode,
    allow_new_sessions: MIGRATED_POLICY.allow_new_sessions ? 1 : 0,
    allow_resume_with_edits: MIGRATED_POLICY.allow_resume_with_edits ? 1 : 0,
  };
}

// ---- request validation ----

export interface RegistrationContext {
  getConnection: (id: string) => RuntimeConnection | undefined;
  // The provider's local connection id, created on demand (legacy
  // agent+deck_id request compatibility only).
  localConnectionFor: (provider: BotAgent) => string;
  // Whether a Botmancers session ref belongs to the Agent. Always false
  // for an Agent that does not exist yet.
  sessionBelongsTo: (agentId: string | null, ref: string) => boolean;
}

export const REGISTRATION_KEYS = [
  'runtime_connection_id',
  'launch_profile',
  'session_scope',
  'default_workspace',
  'policy',
  'home_session_id',
] as const;

export function hasRegistrationUpdate(body: Record<string, unknown>): boolean {
  return REGISTRATION_KEYS.some(key => body[key] !== undefined);
}

function parseScope(value: unknown, errors: string[]): SessionScope | null {
  if (value === undefined || value === null) {
    errors.push(SCOPE_REQUIRED_ERROR);
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(SCOPE_REQUIRED_ERROR);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === undefined || record.kind === null || record.kind === '') {
    errors.push(SCOPE_REQUIRED_ERROR);
    return null;
  }
  if (!isScopeKind(record.kind)) {
    errors.push(SCOPE_INVALID_ERROR);
    return null;
  }
  const workspaces = stringList(record.workspaces);
  const sessions = stringList(record.sessions);
  if (workspaces === null || sessions === null) {
    errors.push('session_scope.workspaces and session_scope.sessions must be lists of strings.');
    return null;
  }
  const kind = record.kind;
  if (kind === 'all_provider_sessions') {
    if (workspaces.length > 0 || sessions.length > 0) {
      errors.push(SCOPE_ALL_WITH_LIST_ERROR);
      return null;
    }
    return { kind, workspaces: [], sessions: [] };
  }
  if (workspaces.length > 0 && sessions.length > 0) {
    errors.push(SCOPE_MIXED_ERROR);
    return null;
  }
  if (kind === 'workspaces') {
    if (sessions.length > 0) {
      errors.push(SCOPE_MIXED_ERROR);
      return null;
    }
    if (workspaces.length === 0) {
      errors.push(SCOPE_EMPTY_WORKSPACES_ERROR);
      return null;
    }
    if (!workspaces.every(isWorkspacePath)) {
      errors.push(WORKSPACE_PATH_ERROR);
      return null;
    }
    return { kind, workspaces, sessions: [] };
  }
  if (workspaces.length > 0) {
    errors.push(SCOPE_MIXED_ERROR);
    return null;
  }
  if (sessions.length === 0) {
    errors.push(SCOPE_EMPTY_SESSIONS_ERROR);
    return null;
  }
  return { kind, workspaces: [], sessions };
}

function parsePolicy(value: unknown, errors: string[]): LaunchPolicy | null {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(POLICY_REQUIRED_ERROR);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.mode === undefined || record.mode === null || record.mode === '') {
    errors.push(POLICY_REQUIRED_ERROR);
    return null;
  }
  if (!isPolicyMode(record.mode)) {
    errors.push(POLICY_MODE_ERROR);
    return null;
  }
  const flags: boolean[] = [];
  for (const key of ['allow_new_sessions', 'allow_resume_with_edits']) {
    const raw = record[key];
    if (raw === undefined) flags.push(false);
    else if (typeof raw === 'boolean') flags.push(raw);
    else {
      errors.push(POLICY_FLAG_ERROR);
      return null;
    }
  }
  const policy = { mode: record.mode, allow_new_sessions: flags[0], allow_resume_with_edits: flags[1] };
  if (policy.allow_resume_with_edits && policy.mode !== 'workspace_write') {
    errors.push(POLICY_RESUME_EDITS_ERROR);
    return null;
  }
  return policy;
}

function parseOptionalPath(value: unknown, errors: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(WORKSPACE_PATH_ERROR);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isWorkspacePath(trimmed)) {
    errors.push(WORKSPACE_PATH_ERROR);
    return null;
  }
  return trimmed;
}

// Cross-field rules shared by create and update, applied to the full
// candidate registration so a partial PATCH can never produce an invalid
// stored combination.
function checkRegistration(
  candidate: Registration,
  agentId: string | null,
  ctx: RegistrationContext,
  errors: string[],
): void {
  if (candidate.launch_profile === 'agent_deck' && !candidate.deck_id) errors.push(DECK_REQUIRED_ERROR);
  const scope = candidate.session_scope;
  if (scope.kind === 'sessions' && !scope.sessions.every(ref => ctx.sessionBelongsTo(agentId, ref))) {
    errors.push(SCOPE_SESSION_FOREIGN_ERROR);
  }
  if (candidate.default_workspace && scope.kind === 'workspaces' &&
      !scope.workspaces.some(ws => workspaceContains(ws, candidate.default_workspace as string))) {
    errors.push(DEFAULT_WORKSPACE_OUTSIDE_ERROR);
  }
  if (candidate.home_session_id) {
    if (!ctx.sessionBelongsTo(agentId, candidate.home_session_id)) errors.push(HOME_SESSION_FOREIGN_ERROR);
    else if (scope.kind === 'sessions' && !scope.sessions.includes(candidate.home_session_id)) {
      errors.push(HOME_SESSION_OUT_OF_SCOPE_ERROR);
    }
  }
}

function resolveConnection(
  body: Record<string, unknown>,
  ctx: RegistrationContext,
  errors: string[],
): RuntimeConnection | null {
  const id = text(body.runtime_connection_id);
  if (!id) {
    errors.push(CONNECTION_REQUIRED_ERROR);
    return null;
  }
  const connection = ctx.getConnection(id);
  if (!connection) {
    errors.push(CONNECTION_NOT_FOUND_ERROR);
    return null;
  }
  if (body.agent !== undefined && body.agent !== null && String(body.agent).trim() && String(body.agent).trim() !== connection.provider) {
    errors.push(CONNECTION_PROVIDER_MISMATCH_ERROR);
    return null;
  }
  return connection;
}

function parseDeck(value: unknown, errors: string[]): string | null {
  try {
    return parseRequestDeckId(value);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export interface ValidatedRegistration {
  errors: string[];
  registration: Registration | null;
  provider: BotAgent | null;
}

// Legacy create shape: { agent?, deck_id, working_directory? } with no
// registration keys. Kept so existing callers keep working: it is exactly
// the migration result for an Agent Deck row (local connection, the
// launch workspace as scope, MIGRATED_POLICY). A request without a
// registration and without a deck is not legacy: it fails with the
// missing-registration errors (never a silent direct profile).
export function isLegacyCreate(body: Record<string, unknown>): boolean {
  return !hasRegistrationUpdate(body) && body.deck_id !== undefined;
}

export function validateCreateRegistration(body: Record<string, unknown>, ctx: RegistrationContext): ValidatedRegistration {
  const errors: string[] = [];
  if (isLegacyCreate(body)) {
    let provider: BotAgent = 'hermes';
    try {
      provider = normalizeAgent(body.agent) ?? 'hermes';
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const deck_id = parseDeck(body.deck_id, errors);
    if (!deck_id && errors.length === 0) errors.push(DECK_REQUIRED_ERROR);
    const working_directory = text(body.working_directory);
    if (errors.length > 0) return { errors, registration: null, provider: null };
    return {
      errors,
      provider,
      registration: {
        runtime_connection_id: ctx.localConnectionFor(provider),
        launch_profile: 'agent_deck',
        deck_id,
        working_directory,
        // Filled with the Agent's default workdir once its ID exists.
        session_scope: { kind: 'workspaces', workspaces: working_directory ? [working_directory] : [], sessions: [] },
        default_workspace: null,
        policy: { ...MIGRATED_POLICY },
        home_session_id: null,
      },
    };
  }
  const connection = resolveConnection(body, ctx, errors);
  let profile: LaunchProfile | null = null;
  if (body.launch_profile === undefined || body.launch_profile === null || body.launch_profile === '') errors.push(PROFILE_REQUIRED_ERROR);
  else if (!isLaunchProfile(body.launch_profile)) errors.push(PROFILE_INVALID_ERROR);
  else profile = body.launch_profile;
  let deck_id: string | null = null;
  let working_directory: string | null = null;
  if (profile === 'direct') {
    if (text(body.deck_id)) errors.push(DIRECT_DECK_ERROR);
    if (text(body.working_directory)) errors.push(DIRECT_WORKDIR_ERROR);
  } else if (profile === 'agent_deck') {
    deck_id = parseDeck(body.deck_id, errors);
    working_directory = text(body.working_directory);
  }
  const scope = parseScope(body.session_scope, errors);
  const default_workspace = parseOptionalPath(body.default_workspace, errors);
  const policy = parsePolicy(body.policy, errors);
  const home_session_id = text(body.home_session_id);
  if (!connection || !profile || !scope || !policy || errors.length > 0) {
    return { errors, registration: null, provider: null };
  }
  const registration: Registration = {
    runtime_connection_id: connection.id,
    launch_profile: profile,
    deck_id,
    working_directory,
    session_scope: scope,
    default_workspace,
    policy,
    home_session_id,
  };
  checkRegistration(registration, null, ctx, errors);
  return errors.length > 0 ? { errors, registration: null, provider: null } : { errors, registration, provider: connection.provider };
}

// Current registration for a stored row, filling unresolved parts with
// null so an update must supply them.
export interface StoredRegistration {
  runtime_connection_id: string | null;
  launch_profile: LaunchProfile | null;
  deck_id: string | null;
  working_directory: string | null;
  session_scope: SessionScope | null;
  default_workspace: string | null;
  policy: LaunchPolicy | null;
  home_session_id: string | null;
}

export function storedRegistration(row: RegistrationRow): StoredRegistration {
  return {
    runtime_connection_id: text(row.runtime_connection_id),
    launch_profile: storedLaunchProfile(row),
    deck_id: text(row.deck_id),
    working_directory: text(row.working_directory),
    session_scope: readStoredScope(row),
    default_workspace: text(row.default_workspace),
    policy: readStoredPolicy(row),
    home_session_id: text(row.home_session_id),
  };
}

// PATCH: merge the supplied fields over the stored registration, then
// validate the whole candidate. Legacy compatibility on update:
// - agent alone moves the Agent to that provider's local connection;
// - deck_id alone (no launch_profile) is the owner choosing Agent Deck
//   for an unresolved or Agent Deck row, and an invalid combination on a
//   direct row.
// Switching to direct drops the Agent Deck settings (deck_id and the
// working-directory override); the legacy deck_name reference stays.
export function validateUpdateRegistration(
  agentId: string,
  row: RegistrationRow,
  body: Record<string, unknown>,
  ctx: RegistrationContext,
): ValidatedRegistration {
  const errors: string[] = [];
  const stored = storedRegistration(row);

  let connection: RuntimeConnection | null = null;
  if (body.runtime_connection_id !== undefined) {
    connection = resolveConnection(body, ctx, errors);
  } else if (body.agent !== undefined) {
    try {
      const provider = normalizeAgent(body.agent);
      if (!provider) errors.push(`Agent is required. Expected one of ${AGENTS.join('|')}.`);
      else {
        const current = stored.runtime_connection_id ? ctx.getConnection(stored.runtime_connection_id) : undefined;
        connection = current && current.provider === provider ? current : ctx.getConnection(ctx.localConnectionFor(provider)) ?? null;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else if (stored.runtime_connection_id) {
    connection = ctx.getConnection(stored.runtime_connection_id) ?? null;
    if (!connection) errors.push(CONNECTION_NOT_FOUND_ERROR);
  } else {
    errors.push(CONNECTION_REQUIRED_ERROR);
  }

  let profile: LaunchProfile | null = stored.launch_profile;
  if (body.launch_profile !== undefined) {
    if (!isLaunchProfile(body.launch_profile)) {
      errors.push(body.launch_profile === null || body.launch_profile === '' ? PROFILE_REQUIRED_ERROR : PROFILE_INVALID_ERROR);
      profile = null;
    } else profile = body.launch_profile;
  } else if (body.deck_id !== undefined && profile !== 'direct') {
    profile = 'agent_deck';
  }

  let deck_id = stored.deck_id;
  let working_directory = stored.working_directory;
  if (profile === 'direct') {
    if (body.deck_id !== undefined && text(body.deck_id)) errors.push(DIRECT_DECK_ERROR);
    if (body.working_directory !== undefined && text(body.working_directory)) errors.push(DIRECT_WORKDIR_ERROR);
    deck_id = null;
    working_directory = null;
  } else if (profile === 'agent_deck') {
    if (body.deck_id !== undefined) {
      deck_id = parseDeck(body.deck_id, errors);
    } else if (stored.launch_profile !== 'agent_deck' || flag(row.needs_deck_selection)) {
      // A row becoming Agent Deck (or with a pending re-selection) names
      // its deck in the same request: a stale legacy deck never resolves.
      deck_id = null;
    }
    if (body.working_directory !== undefined) working_directory = text(body.working_directory);
  } else if (errors.length === 0) {
    errors.push(PROFILE_REQUIRED_ERROR);
  }

  const scope = body.session_scope !== undefined ? parseScope(body.session_scope, errors) : stored.session_scope;
  if (body.session_scope === undefined && !scope) errors.push(SCOPE_REQUIRED_ERROR);
  const default_workspace = body.default_workspace !== undefined ? parseOptionalPath(body.default_workspace, errors) : stored.default_workspace;
  const policy = body.policy !== undefined ? parsePolicy(body.policy, errors) : stored.policy;
  if (body.policy === undefined && !policy) errors.push(POLICY_REQUIRED_ERROR);
  const home_session_id = body.home_session_id !== undefined ? text(body.home_session_id) : stored.home_session_id;

  if (!connection || !profile || !scope || !policy || errors.length > 0) {
    return { errors, registration: null, provider: null };
  }
  const registration: Registration = {
    runtime_connection_id: connection.id,
    launch_profile: profile,
    deck_id: profile === 'agent_deck' ? deck_id : null,
    working_directory: profile === 'agent_deck' ? working_directory : null,
    session_scope: scope,
    default_workspace,
    policy,
    home_session_id,
  };
  checkRegistration(registration, agentId, ctx, errors);
  return errors.length > 0 ? { errors, registration: null, provider: null } : { errors, registration, provider: connection.provider };
}

// ---- runtime connection create ----

export function validateConnectionInput(body: Record<string, unknown>): {
  errors: string[];
  fields: { provider: BotAgent; label: string; host: string } | null;
} {
  const errors: string[] = [];
  let provider: BotAgent | null = null;
  try {
    provider = normalizeAgent(body.provider);
    if (!provider) errors.push(CONNECTION_PROVIDER_REQUIRED_ERROR);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const label = text(body.label);
  if (!label) errors.push(CONNECTION_LABEL_REQUIRED_ERROR);
  else if (label.length > 80) errors.push('Connection name must be 80 characters or fewer.');
  const host = text(body.host) ?? LOCAL_HOST;
  if (host.length > 80) errors.push('Host must be 80 characters or fewer.');
  for (const key of ['token', 'api_key', 'apiKey', 'credentials', 'password', 'secret']) {
    if (body[key] !== undefined) errors.push('Runtime credentials stay with the runtime; a connection stores no secrets.');
  }
  if (errors.length > 0 || !provider || !label) return { errors: [...new Set(errors)], fields: null };
  return { errors, fields: { provider, label, host } };
}

// ---- read shape ----

export interface SerializedRegistration {
  runtime_connection_id: string | null;
  runtime_connection: { id: string; provider: BotAgent; label: string; host: string } | null;
  launch_profile: LaunchProfile | null;
  needs_launch_profile: boolean;
  session_scope: SessionScope | null;
  default_workspace: string | null;
  policy: LaunchPolicy | null;
  home_session_id: string | null;
}

export function serializeRegistration(row: RegistrationRow, connection: RuntimeConnection | undefined | null): SerializedRegistration {
  const stored = storedRegistration(row);
  return {
    runtime_connection_id: stored.runtime_connection_id,
    runtime_connection: connection
      ? { id: connection.id, provider: connection.provider, label: connection.label, host: connection.host }
      : null,
    launch_profile: stored.launch_profile,
    needs_launch_profile: stored.launch_profile === null,
    session_scope: stored.session_scope,
    default_workspace: stored.default_workspace,
    policy: stored.policy,
    home_session_id: stored.home_session_id,
  };
}
