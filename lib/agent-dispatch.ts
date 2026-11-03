// NOT-446: runtime-neutral dispatch for the agent conversation API.
//
// Callers name an agent; this module routes the turn through that bot's
// stored agent on its selected Agent Deck (NOT-456), or directly for a
// direct launch profile (NOT-502) and returns only the
// reply text or a typed failure. Every agent follows one contract: it
// launches only when an Agent Deck is selected, and its adapter
// (AGENT_TRANSPORTS) serves the turn. Completion is typed by the adapter contract, never read
// from reply prose: a Hermes turn completes when the gateway answers the
// chat request with HTTP 200, and a coding-agent turn completes only when
// the public Agent Deck event API reports a terminal result and status is
// not error/died. The start acknowledgement is transport acceptance, not
// completion.
//
// Failure messages are fixed per category so adapter output (which can
// carry URLs, stderr, or gateway error bodies) never reaches the caller.
//
// NOT-487: canonical coding-agent turns run through the Agent Deck public
// run API (./agent-deck-attempt), authenticated with the server-only
// AGENT_DECK_RUN_TOKEN. The `agent-deck run` CLI adapter (./agent-deck-run)
// remains only for legacy non-canonical turns; an API failure never falls
// back to it.
import fs from 'fs';
import path from 'path';
import type { Bot } from './db';
import { agentTransport, resolveAgent, type AgentTransport, type BotAgent } from './bot-definition';
import { hermesProfilePathForBot } from './hermes';
import { createHermesAttemptAdapter } from './hermes-attempt';
import { createAgentDeckApiAttemptAdapter } from './agent-deck-attempt';
import { createSessionProviderAttemptAdapter } from './session-provider-attempt';
import { AGENT_DECK_API_MESSAGES, type AgentDeckApiErrorCode } from './agent-deck-api';
import {
  resolveAndEnsureBotWorkdir,
} from './agent-deck-settings';
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

export const AGENT_DECK_NOT_SELECTED = 'The agent has no Agent Deck selected.';
// NOT-502: fixed caller-facing text for the other launch blockers.
export const LAUNCH_PROFILE_NOT_CHOSEN = 'The agent has no launch profile chosen.';
export const SESSION_SCOPE_MISSING = 'The agent has no session scope.';
export const DIRECT_LAUNCH_UNAVAILABLE = 'Direct launch is not available for this agent yet.';

function blockedDispatchMessage(blocker: ReturnType<typeof resolveAgent>['launch_blocker']): string {
  if (blocker === 'launch_profile') return LAUNCH_PROFILE_NOT_CHOSEN;
  if (blocker === 'session_scope') return SESSION_SCOPE_MISSING;
  if (blocker === 'direct_runtime') return DIRECT_LAUNCH_UNAVAILABLE;
  return AGENT_DECK_NOT_SELECTED;
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
  // NOT-487: the caller's request to prepare Git finalization (an
  // implementation or revision). Honored only for an Agent Deck edit turn
  // whose working directory is inside a Git worktree.
  prepareFinalization?: boolean;
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
// the resolved deck, working directory, and explicit tool profile.
export interface PreparedDispatch {
  agent: BotAgent;
  adapter: AttemptAdapter;
  input: AttemptInput;
}

// Both transports satisfy the one AttemptAdapter contract (type-checked
// here); selection is by the agent's transport only.
export const ATTEMPT_ADAPTERS: Record<AgentTransport, () => AttemptAdapter> = {
  'hermes-gateway': () => createHermesAttemptAdapter({ fetchImpl: hermesFetch }),
  'agent-deck-run': () => createAgentDeckApiAttemptAdapter(),
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
// NOT-542: 'session-provider' is registered here for restart lookup only;
// normal dispatch still selects Agent Deck until the cutover ticket.
export function adapterForTransport(name: string): AttemptAdapter | null {
  if (name === 'hermes-gateway') return adapterFor('hermes-gateway');
  if (name === 'agent-deck-api') return adapterFor('agent-deck-run');
  if (name === 'session-provider') return createSessionProviderAttemptAdapter();
  return null;
}

// Whether a working directory is inside a Git worktree (a `.git` entry in
// it or an ancestor). A filesystem read only: no Git command runs here.
export function isInGitWorktree(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function prepareDispatch(turn: DispatchTurn): PreparedDispatch {
  const resolved = resolveAgent(turn.bot);
  // NOT-502: only the agent_deck profile carries (and needs) a deck. A
  // direct profile is launchable only on a transport that never contacts
  // Agent Deck (Hermes); nothing here reaches Agent Deck for it.
  if (!resolved.launchable || (resolved.launch_profile === 'agent_deck' && !resolved.deck_id)) {
    throw new DispatchFailure('agent_unavailable', blockedDispatchMessage(resolved.launch_blocker));
  }
  const base = {
    prompt: { kind: 'conversation' as const, system: systemPromptFor(turn.bot), history: turn.history },
    deck: resolved.deck_id,
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
  let cwd: string;
  try {
    cwd = resolveAndEnsureBotWorkdir(turn.bot.id, resolved.working_directory);
  } catch {
    throw new DispatchFailure('agent_unavailable', 'The agent working directory is unavailable.');
  }
  return {
    agent: resolved.agent,
    adapter: adapterFor('agent-deck-run'),
    input: {
      ...base,
      target: { agentId: turn.bot.id, agent: resolved.agent },
      cwd,
      ...(turn.prepareFinalization && base.toolProfile === 'edit' && isInGitWorktree(cwd) ? { prepareFinalization: true } : {}),
    },
  };
}

// Fixed caller-facing text per failure category, so adapter diagnostics
// (URLs, stderr, gateway error bodies) never reach the caller.
export function dispatchFailureFor(result: AttemptResult): DispatchFailure {
  const category = result.failure?.category ?? 'runtime_failed';
  if (result.adapter === 'hermes-gateway') {
    if (category === 'unavailable') {
      return new DispatchFailure('agent_unavailable', 'The agent runtime is not configured.');
    }
    return new DispatchFailure('runtime_failed', `The agent runtime did not complete the turn (${result.failure?.code ?? 'unknown'}).`);
  }
  // NOT-487: Agent Deck API failures name their stable, actionable reason
  // (token, grant, or server) without echoing the transport diagnostics.
  const apiCode = result.adapter === 'agent-deck-api' ? apiFailureCode(result) : null;
  if (apiCode) return new DispatchFailure('agent_unavailable', `${AGENT_DECK_API_MESSAGES[apiCode]} [${apiCode}]`);
  if (category === 'unavailable') {
    return new DispatchFailure('agent_unavailable', 'The agent runtime is not available.');
  }
  if (category === 'cancelled') return new DispatchFailure('runtime_failed', 'The agent run was cancelled.');
  if (category === 'launch_failed') {
    return new DispatchFailure('runtime_failed', 'The agent runtime did not start the turn.');
  }
  return new DispatchFailure('runtime_failed', 'The agent runtime did not complete the turn.');
}

const API_UNAVAILABLE: AgentDeckApiErrorCode[] = ['agent_deck_token_missing', 'agent_deck_unauthorized', 'agent_deck_forbidden', 'agent_deck_unreachable'];

function apiFailureCode(result: AttemptResult): AgentDeckApiErrorCode | null {
  const code = result.failure?.code as AgentDeckApiErrorCode | null | undefined;
  return code && API_UNAVAILABLE.includes(code) ? code : null;
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
