// NOT-502: registration form + read view helpers (pure, no I/O except the
// injected fetchers). The New Agent dialog and the per-Agent Config card
// render five separate concepts, in this order:
//
//   Runtime connection · Session scope · Default workspace ·
//   Launch profile (Agent Deck controls only for agent_deck) · Policy
//
// plus the optional home session on Config. Provider session IDs and
// runtime credentials never appear: sessions are named by their
// Botmancers session title and ref only.
import { AGENT_LABELS, agentLabel, type BotAgent } from './bot-definition';
import {
  LAUNCH_PROFILE_LABELS,
  POLICY_MODE_LABELS,
  SCOPE_KIND_LABELS,
  isWorkspacePath,
  workspaceContains,
  type LaunchPolicy,
  type LaunchProfile,
  type PolicyMode,
  type ScopeKind,
  type SessionScope,
} from './agent-registration';
import {
  DECK_SLOT_COPY,
  deckLabel,
  defaultWorkdirFor,
  isDeckUnavailable,
  type DeckListState,
} from './bot-runtime-ui';

export const CONNECTIONS_ENDPOINT = '/api/runtime-connections';

export interface ConnectionOption {
  id: string;
  provider: BotAgent;
  label: string;
  host: string;
  agent_count?: number;
}

export type ConnectionListStatus = 'loading' | 'ready' | 'error';

export interface ConnectionListState {
  status: ConnectionListStatus;
  connections: ConnectionOption[];
  error: string;
}

export interface SessionOption {
  ref: string;
  title: string;
  status: string;
}

export interface RegistrationFormInput {
  connectionId: string;
  scopeKind: ScopeKind | '';
  // One workspace path per line.
  workspaces: string;
  sessions: string[];
  defaultWorkspace: string;
  launchProfile: LaunchProfile | '';
  deckId: string;
  workingDirectory: string;
  policyMode: PolicyMode;
  allowNewSessions: boolean;
  allowResumeWithEdits: boolean;
  homeSessionId: string;
}

// Nothing that grants authority is pre-chosen: no connection, no scope,
// no launch profile. Policy starts at the narrowest mode.
export const DEFAULT_REGISTRATION_FORM: RegistrationFormInput = {
  connectionId: '',
  scopeKind: '',
  workspaces: '',
  sessions: [],
  defaultWorkspace: '',
  launchProfile: '',
  deckId: '',
  workingDirectory: '',
  policyMode: 'read_only',
  allowNewSessions: true,
  allowResumeWithEdits: false,
  homeSessionId: '',
};

export const LABELS = {
  connection: 'Runtime connection',
  scope: 'Session scope',
  defaultWorkspace: 'Default workspace (optional)',
  launchProfile: 'Launch profile',
  policy: 'Policy',
  homeSession: 'Home session (optional)',
} as const;

export const HINTS = {
  connection: 'The runtime installation or account this Agent uses. Several Agents can share one.',
  workspaces: 'One absolute path per line. An empty scope never means unrestricted.',
  sessions: 'Only this Agent’s own Botmancers sessions can be selected.',
  noSessions: 'This Agent has no sessions yet. Choose workspaces or all sessions for now.',
  allSessions: 'Every session this runtime can see. Choose this only on purpose.',
  defaultWorkspace: 'Where new sessions start. Convenience only — not a permission.',
  direct: 'Launches the runtime directly. Agent Deck is not contacted.',
  agentDeck: 'Launches through a verified Agent Deck from the configured server.',
  resumeEdits: 'Needs Workspace write.',
  homeSession: 'A stable session to return to. Must be one of this Agent’s sessions.',
  addConnection: 'Stores a name and host only. Credentials stay with the runtime.',
} as const;

export const ERRORS = {
  connection: 'Pick a runtime connection.',
  scope: 'Choose a session scope.',
  workspaces: 'Add at least one workspace.',
  workspacePath: 'Workspaces must be absolute paths (or start with ~/).',
  sessions: 'Select at least one session.',
  defaultWorkspacePath: 'The default workspace must be an absolute path (or start with ~/).',
  defaultWorkspaceOutside: 'The default workspace must be inside one of the selected workspaces.',
  launchProfile: 'Choose Direct or Agent Deck.',
  deck: 'Select an Agent Deck for this agent.',
  resumeEdits: 'Resume with edits needs the Workspace write policy.',
} as const;

export const CONNECTIONS_LOADING_COPY = 'Loading runtime connections…';
export const CONNECTIONS_ERROR_COPY = "Couldn't load runtime connections — retry.";

export function initialConnectionListState(): ConnectionListState {
  return { status: 'loading', connections: [], error: '' };
}

export function connectionOptionLabel(connection: Pick<ConnectionOption, 'provider' | 'label'>): string {
  return `${connection.label} · ${AGENT_LABELS[connection.provider] ?? connection.provider}`;
}

export function parseConnectionList(body: unknown): ConnectionOption[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const list = (body as Record<string, unknown>).connections;
  if (!Array.isArray(list)) return null;
  const out: ConnectionOption[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.provider !== 'string' || typeof record.label !== 'string') return null;
    out.push({
      id: record.id,
      provider: record.provider as BotAgent,
      label: record.label,
      host: typeof record.host === 'string' ? record.host : '',
      agent_count: typeof record.agent_count === 'number' ? record.agent_count : undefined,
    });
  }
  return out;
}

export function workspaceLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export type RegistrationField =
  | 'connection'
  | 'scope'
  | 'workspaces'
  | 'sessions'
  | 'defaultWorkspace'
  | 'launchProfile'
  | 'deck'
  | 'policy';

export interface RegistrationFormView {
  // Field-level validation messages (shown after a submit attempt).
  errors: Partial<Record<RegistrationField, string>>;
  // Whether Agent Deck controls (deck + workdir) render at all.
  showsAgentDeck: boolean;
  submitDisabled: boolean;
  // A blocking environment state (deck list or connection list), not a
  // user error.
  blocker: string;
}

// Client-side mirror of the server contract (lib/agent-registration):
// the server still validates everything; this only explains why Create /
// Save cannot succeed yet. The deck list matters only for agent_deck.
export function registrationFormView(
  form: RegistrationFormInput,
  deckState: DeckListState,
  connections: ConnectionListState,
): RegistrationFormView {
  const errors: Partial<Record<RegistrationField, string>> = {};
  if (!form.connectionId) errors.connection = ERRORS.connection;
  const workspaces = workspaceLines(form.workspaces);
  if (!form.scopeKind) errors.scope = ERRORS.scope;
  else if (form.scopeKind === 'workspaces') {
    if (workspaces.length === 0) errors.workspaces = ERRORS.workspaces;
    else if (!workspaces.every(isWorkspacePath)) errors.workspaces = ERRORS.workspacePath;
  } else if (form.scopeKind === 'sessions' && form.sessions.length === 0) errors.sessions = ERRORS.sessions;
  const defaultWorkspace = form.defaultWorkspace.trim();
  if (defaultWorkspace) {
    if (!isWorkspacePath(defaultWorkspace)) errors.defaultWorkspace = ERRORS.defaultWorkspacePath;
    else if (form.scopeKind === 'workspaces' && !errors.workspaces && !workspaces.some(ws => workspaceContains(ws, defaultWorkspace))) {
      errors.defaultWorkspace = ERRORS.defaultWorkspaceOutside;
    }
  }
  if (!form.launchProfile) errors.launchProfile = ERRORS.launchProfile;
  else if (form.launchProfile === 'agent_deck' && !form.deckId.trim()) errors.deck = ERRORS.deck;
  if (form.allowResumeWithEdits && form.policyMode !== 'workspace_write') errors.policy = ERRORS.resumeEdits;

  const showsAgentDeck = form.launchProfile === 'agent_deck';
  let blocker = '';
  let envBlocked = false;
  if (connections.status !== 'ready') {
    envBlocked = true;
    blocker = connections.status === 'error' ? CONNECTIONS_ERROR_COPY : '';
  } else if (showsAgentDeck && deckState.status !== 'connected') {
    envBlocked = true;
    blocker = deckState.status === 'loading' ? '' : DECK_SLOT_COPY[deckState.status];
  }
  return { errors, showsAgentDeck, submitDisabled: envBlocked, blocker };
}

export function hasRegistrationErrors(view: RegistrationFormView): boolean {
  return Object.keys(view.errors).length > 0;
}

function scopeBody(form: RegistrationFormInput): Record<string, unknown> {
  if (form.scopeKind === 'workspaces') return { kind: 'workspaces', workspaces: workspaceLines(form.workspaces) };
  if (form.scopeKind === 'sessions') return { kind: 'sessions', sessions: form.sessions };
  return { kind: form.scopeKind };
}

function policyBody(form: RegistrationFormInput): LaunchPolicy {
  return {
    mode: form.policyMode,
    allow_new_sessions: form.allowNewSessions,
    allow_resume_with_edits: form.allowResumeWithEdits,
  };
}

// New Agent body. Agent Deck fields are sent only for agent_deck; the
// workdir override only when typed.
export function registrationCreateBody(name: string, form: RegistrationFormInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(name ?? '').trim(),
    runtime_connection_id: form.connectionId,
    launch_profile: form.launchProfile || null,
    session_scope: scopeBody(form),
    policy: policyBody(form),
  };
  const defaultWorkspace = form.defaultWorkspace.trim();
  if (defaultWorkspace) body.default_workspace = defaultWorkspace;
  if (form.launchProfile === 'agent_deck') {
    body.deck_id = form.deckId.trim();
    const workdir = form.workingDirectory.trim();
    if (workdir) body.working_directory = workdir;
  }
  return body;
}

// Config save body: the whole visible registration. A blank or
// default-equal workdir clears the override.
export function registrationPatchBody(botId: string, form: RegistrationFormInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: botId,
    runtime_connection_id: form.connectionId,
    launch_profile: form.launchProfile || null,
    session_scope: scopeBody(form),
    default_workspace: form.defaultWorkspace.trim(),
    policy: policyBody(form),
    home_session_id: form.homeSessionId,
  };
  if (form.launchProfile === 'agent_deck') {
    const typed = form.workingDirectory.trim();
    body.deck_id = form.deckId.trim();
    body.working_directory = typed && typed !== defaultWorkdirFor(botId) ? typed : '';
  }
  return body;
}

export interface RegisteredAgentLike {
  id?: string | null;
  agent?: string | null;
  runtime_connection_id?: string | null;
  runtime_connection?: { id: string; provider: string; label: string; host: string } | null;
  launch_profile?: string | null;
  session_scope?: SessionScope | null;
  default_workspace?: string | null;
  policy?: LaunchPolicy | null;
  home_session_id?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: boolean | number | null;
  launchable?: boolean | null;
  launch_blocker?: string | null;
}

export function registrationFormFromBot(bot: RegisteredAgentLike): RegistrationFormInput {
  const scope = bot.session_scope ?? null;
  const profile = bot.launch_profile === 'direct' || bot.launch_profile === 'agent_deck' ? bot.launch_profile : '';
  const pendingDeck = bot.needs_deck_selection === true || bot.needs_deck_selection === 1;
  const workdir = (bot.working_directory ?? '').trim();
  return {
    connectionId: bot.runtime_connection_id ?? '',
    scopeKind: scope?.kind ?? '',
    workspaces: scope?.kind === 'workspaces' ? scope.workspaces.join('\n') : '',
    sessions: scope?.kind === 'sessions' ? [...scope.sessions] : [],
    defaultWorkspace: bot.default_workspace ?? '',
    launchProfile: profile,
    deckId: profile === 'agent_deck' && !pendingDeck ? (bot.deck_id ?? '').trim() : '',
    workingDirectory: profile === 'agent_deck' && workdir && workdir !== defaultWorkdirFor(bot.id ?? '') ? workdir : '',
    policyMode: bot.policy?.mode ?? 'read_only',
    allowNewSessions: bot.policy ? bot.policy.allow_new_sessions : true,
    allowResumeWithEdits: bot.policy ? bot.policy.allow_resume_with_edits : false,
    homeSessionId: bot.home_session_id ?? '',
  };
}

// ---- read view ----

export interface RegistrationReadRow {
  key: 'connection' | 'scope' | 'defaultWorkspace' | 'launchProfile' | 'deck' | 'workdir' | 'policy' | 'homeSession';
  label: string;
  value: string;
}

export function scopeSummary(scope: SessionScope | null | undefined, sessions?: SessionOption[]): string {
  if (!scope) return 'Not set — this Agent cannot launch until a scope is chosen.';
  if (scope.kind === 'all_provider_sessions') return SCOPE_KIND_LABELS.all_provider_sessions;
  if (scope.kind === 'workspaces') return `${SCOPE_KIND_LABELS.workspaces}: ${scope.workspaces.join(', ')}`;
  const titles = scope.sessions.map(ref => sessions?.find(s => s.ref === ref)?.title ?? ref);
  return `${SCOPE_KIND_LABELS.sessions}: ${titles.join(', ')}`;
}

export function policySummary(policy: LaunchPolicy | null | undefined): string {
  if (!policy) return 'Not set';
  return [
    POLICY_MODE_LABELS[policy.mode],
    policy.allow_new_sessions ? 'new sessions allowed' : 'no new sessions',
    policy.allow_resume_with_edits ? 'resume with edits allowed' : 'no resume with edits',
  ].join(' · ');
}

export function connectionSummary(bot: RegisteredAgentLike): string {
  const connection = bot.runtime_connection;
  if (!connection) return 'Not set';
  return `${connection.label} (${agentLabel(connection.provider)} · ${connection.host})`;
}

export function launchProfileSummary(bot: RegisteredAgentLike): string {
  if (bot.launch_profile === 'direct') return LAUNCH_PROFILE_LABELS.direct;
  if (bot.launch_profile === 'agent_deck') return LAUNCH_PROFILE_LABELS.agent_deck;
  return 'Not chosen';
}

export interface RegistrationReadView {
  rows: RegistrationReadRow[];
  notices: string[];
}

// Config card read view. Agent Deck rows appear only for agent_deck.
export function registrationReadView(
  bot: RegisteredAgentLike,
  deckState: DeckListState | null,
  sessions?: SessionOption[],
): RegistrationReadView {
  const rows: RegistrationReadRow[] = [
    { key: 'connection', label: LABELS.connection, value: connectionSummary(bot) },
    { key: 'scope', label: LABELS.scope, value: scopeSummary(bot.session_scope, sessions) },
    { key: 'defaultWorkspace', label: 'Default workspace', value: bot.default_workspace || 'None' },
    { key: 'launchProfile', label: LABELS.launchProfile, value: launchProfileSummary(bot) },
  ];
  const notices: string[] = [];
  if (bot.launch_profile === 'agent_deck') {
    const pending = bot.needs_deck_selection === true || bot.needs_deck_selection === 1 || !(bot.deck_id ?? '').trim();
    rows.push({ key: 'deck', label: 'Agent Deck', value: pending ? 'not selected' : deckLabel(bot.deck_id ?? '', deckState) });
    const workdir = (bot.working_directory ?? '').trim();
    rows.push({ key: 'workdir', label: 'Working directory', value: workdir || defaultWorkdirFor(bot.id ?? '{agentID}') });
    if (!pending && isDeckUnavailable(bot, deckState)) notices.push("This deck isn't on the configured server right now. Pick another deck, or fix the server in Settings.");
  }
  rows.push({ key: 'policy', label: LABELS.policy, value: policySummary(bot.policy) });
  const home = bot.home_session_id ? sessions?.find(s => s.ref === bot.home_session_id)?.title ?? bot.home_session_id : 'None';
  rows.push({ key: 'homeSession', label: 'Home session', value: home });
  if (!bot.launch_profile) {
    const legacy = (bot.deck_name ?? '').trim();
    notices.push(`Choose Direct or Agent Deck before this Agent can run${legacy ? ` (was Agent Deck "${legacy}")` : ''}.`);
  } else if (bot.launch_blocker === 'direct_runtime') {
    notices.push('Registered for direct launch. Direct sessions for this runtime arrive in a later Botmancers version.');
  }
  return { rows, notices };
}
