// NOT-543: direct-only dispatch for the agent conversation API.
//
// Callers name an agent; this module routes the turn through that Agent's
// own runtime connection and returns only the reply text or a typed
// failure. Hermes turns run on the persistent Hermes gateway; every
// coding-agent turn (Cursor, Claude, Codex, Muse Code) runs a direct
// local provider Session through the SessionProvider-backed adapter
// (./session-provider-attempt). No coding-agent dispatch contacts Agent
// Deck: there is no deck, launch profile, run token, or remote grant.
//
// Completion is typed by the adapter contract, never read from reply
// prose: a Hermes turn completes when the gateway answers the chat
// request with HTTP 200, and a coding-agent turn completes only when the
// provider turn ends completed. The start acknowledgement is transport
// acceptance, not completion.
//
// Failure messages are fixed per category so adapter output (which can
// carry paths, stderr, or gateway error bodies) never reaches the caller.
import type { Bot } from './db';
import { agentTransport, resolveAgent, type AgentTransport, type BotAgent } from './bot-definition';
import { directLaunchWorkspace, readStoredScope } from './agent-registration';
import { ensureBotWorkdir } from './agent-workdir';
import { hermesProfilePathForBot } from './hermes';
import { createHermesAttemptAdapter } from './hermes-attempt';
import { createSessionProviderAttemptAdapter } from './session-provider-attempt';
import { TOOL_PROFILE_FOR_KIND, type ToolProfile } from './engine-store';
import type { AttemptAdapter, AttemptInput, AttemptResult } from './attempt-adapter';

export type DispatchFailureCode = 'agent_unavailable' | 'runtime_failed';

export class DispatchFailure extends Error {
  readonly code: DispatchFailureCode;
  constructor(code: DispatchFailureCode, message: string) {
    super(message);
    this.name = 'DispatchFailure';
    this.code = code;
  }
}

export const CONNECTION_NOT_CHOSEN = 'The agent has no runtime connection. Choose one in Config.';
export const SESSION_SCOPE_MISSING = 'The agent has no session scope. Choose one in Config.';
export const AGENT_TYPE_UNSUPPORTED = 'The agent has an unsupported Agent type.';
export const DEFAULT_WORKSPACE_MISSING =
  'The agent has no default workspace for a new session. Set one in Config, or resume one of its sessions.';
export const SESSIONS_SCOPE_CANNOT_START =
  'This turn starts a new session but the agent is limited to selected sessions.';

function blockedDispatchMessage(blocker: ReturnType<typeof resolveAgent>['launch_blocker']): string {
  if (blocker === 'connection') return CONNECTION_NOT_CHOSEN;
  if (blocker === 'session_scope') return SESSION_SCOPE_MISSING;
  return AGENT_TYPE_UNSUPPORTED;
}

export interface DispatchHistoryEntry {
  speakerLabel: string;
  fromAgent: boolean;
  content: string;
}

export interface DispatchTurn {
  bot: Bot;
  // Conversation history up to and including the accepted message, in
  // order. fromAgent marks the target agent's own earlier replies.
  history: DispatchHistoryEntry[];
  // Explicit tool authority for this turn. Direct conversation turns are
  // read-only (TOOL_PROFILE_FOR_KIND.conversation) when omitted; it is
  // never derived from the agent type.
  toolProfile?: ToolProfile;
  // NOT-472: opaque session to resume (a revision). Omitted: a fresh launch.
  sessionBinding?: AttemptInput['sessionBinding'];
  // NOT-497: launch in a new runtime session (a Continue destination).
  freshSession?: boolean;
}

export interface DispatchHooks {
  // Called once the runtime acknowledged the launch. Not completion.
  onStarted?: () => void;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

let hermesFetch: FetchImpl | null = null;

export function setAgentDispatchHermesFetch(fetchImpl: FetchImpl | null): void {
  hermesFetch = fetchImpl;
}

export function agentForDispatch(bot: Bot): BotAgent {
  return resolveAgent(bot).agent;
}

function systemPromptFor(bot: Bot): string {
  const who = bot.title ? `${bot.name} (${bot.title})` : bot.name;
  return `You are ${who}.\n${bot.description}`;
}

// NOT-467: runtime adapter selection plus launch-input resolution for one
// direct turn. Workflow policy stays with the caller; the adapter receives
// the resolved working directory and explicit tool profile.
export interface PreparedDispatch {
  agent: BotAgent;
  adapter: AttemptAdapter;
  input: AttemptInput;
}

// Both transports satisfy the one AttemptAdapter contract (type-checked
// here); selection is by the agent's transport only.
export const ATTEMPT_ADAPTERS: Record<AgentTransport, () => AttemptAdapter> = {
  'hermes-gateway': () => createHermesAttemptAdapter({ fetchImpl: hermesFetch }),
  'session-provider': () => createSessionProviderAttemptAdapter(),
};

let adapterOverride: ((transport: AgentTransport) => AttemptAdapter) | null = null;

// Test seam: replaces the transport adapter selection. Pass null to restore.
export function setAttemptAdapterOverride(next: ((transport: AgentTransport) => AttemptAdapter) | null): void {
  adapterOverride = next;
}

function adapterFor(transport: AgentTransport): AttemptAdapter {
  return adapterOverride ? adapterOverride(transport) : ATTEMPT_ADAPTERS[transport]();
}

// NOT-469: the adapter for a transport name recorded in a launch snapshot
// (AttemptAdapter.name), used to reconcile an Attempt after a restart.
// Removed transports ('agent-deck-run', 'agent-deck-api') have no adapter:
// their open Attempts reconcile as interrupted, never relaunched.
export function adapterForTransport(name: string): AttemptAdapter | null {
  if (name === 'hermes-gateway') return adapterFor('hermes-gateway');
  if (name === 'session-provider') return createSessionProviderAttemptAdapter();
  return null;
}

// The explicit absolute workspace a fresh direct turn starts in: the
// Agent's default workspace, else its single selected workspace. Created
// on demand immediately before launch, like the former per-bot default.
// Resumes never reach here: the session names its own workspace.
function freshLaunchWorkspace(bot: Bot): string {
  const workspace = directLaunchWorkspace(bot);
  if (!workspace) {
    const scope = readStoredScope(bot);
    throw new DispatchFailure(
      'agent_unavailable',
      scope?.kind === 'sessions' ? SESSIONS_SCOPE_CANNOT_START : DEFAULT_WORKSPACE_MISSING,
    );
  }
  try {
    return ensureBotWorkdir(workspace);
  } catch {
    throw new DispatchFailure('agent_unavailable', 'The agent working directory is unavailable.');
  }
}

export function prepareDispatch(turn: DispatchTurn): PreparedDispatch {
  const resolved = resolveAgent(turn.bot);
  if (!resolved.launchable) {
    throw new DispatchFailure('agent_unavailable', blockedDispatchMessage(resolved.launch_blocker));
  }
  const base = {
    prompt: { kind: 'conversation' as const, system: systemPromptFor(turn.bot), history: turn.history },
    toolProfile: turn.toolProfile ?? TOOL_PROFILE_FOR_KIND.conversation,
    sessionBinding: turn.sessionBinding ?? null,
    correlation: {},
    ...(turn.freshSession ? { freshSession: true } : {}),
  };
  if (agentTransport(resolved.agent) === 'hermes-gateway') {
    return {
      agent: resolved.agent,
      adapter: adapterFor('hermes-gateway'),
      input: {
        ...base,
        target: { agentId: turn.bot.id, agent: resolved.agent, hermesProfilePath: hermesProfilePathForBot(turn.bot) },
        cwd: null,
      },
    };
  }
  // An exact session binding resumes that session; any other turn starts
  // fresh in the allowed default/selected workspace.
  const cwd = base.sessionBinding ? null : freshLaunchWorkspace(turn.bot);
  return {
    agent: resolved.agent,
    adapter: adapterFor('session-provider'),
    input: {
      ...base,
      target: { agentId: turn.bot.id, agent: resolved.agent },
      cwd,
    },
  };
}

// Fixed caller-facing text per failure category, so adapter diagnostics
// (paths, stderr, gateway error bodies) never reach the caller. A stable
// provider code is kept in brackets so the owner can act on it.
export function dispatchFailureFor(result: AttemptResult): DispatchFailure {
  const category = result.failure?.category ?? 'runtime_failed';
  if (result.adapter === 'hermes-gateway') {
    if (category === 'unavailable') {
      return new DispatchFailure('agent_unavailable', 'The agent runtime is not configured.');
    }
    return new DispatchFailure('runtime_failed', `The agent runtime did not complete the turn (${result.failure?.code ?? 'unknown'}).`);
  }
  const code = typeof result.failure?.code === 'string' && result.failure.code ? ` [${result.failure.code}]` : '';
  if (category === 'unavailable' || category === 'unsupported_authority') {
    return new DispatchFailure('agent_unavailable', `The agent runtime is not available${code}.`);
  }
  if (category === 'cancelled') return new DispatchFailure('runtime_failed', 'The agent run was cancelled.');
  if (category === 'launch_failed') {
    return new DispatchFailure('runtime_failed', 'The agent runtime did not start the turn.');
  }
  return new DispatchFailure('runtime_failed', 'The agent runtime did not complete the turn.');
}

export function replyFor(result: AttemptResult): string {
  if (result.status !== 'completed' || result.output === null) throw dispatchFailureFor(result);
  return result.output;
}

// Compatibility entry: one direct turn through the shared single-Attempt
// adapter contract, returning only the reply text or a typed failure.
export async function dispatchToAgent(turn: DispatchTurn, hooks: DispatchHooks = {}): Promise<string> {
  const prepared = prepareDispatch(turn);
  const result = await prepared.adapter.run(prepared.input, event => {
    if (event.type === 'started') hooks.onStarted?.();
  });
  return replyFor(result);
}
