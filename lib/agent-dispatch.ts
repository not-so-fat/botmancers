// NOT-446: runtime-neutral dispatch for the agent conversation API.
//
// Callers name an agent; this module routes the turn through that bot's
// stored agent on its selected Agent Deck (NOT-456) and returns only the
// reply text or a typed failure. Every agent follows one contract: it
// launches only when an Agent Deck is selected, and its adapter
// (AGENT_TRANSPORTS) serves the turn. Completion is typed by the adapter contract, never read
// from reply prose: a Hermes turn completes when the gateway answers the
// chat request with HTTP 200, and a coding-agent turn completes only when
// `agent-deck run log --follow` reports an end event and run status is not
// error/died. The detach acknowledgement from `agent-deck run` is a
// transport acknowledgement, not completion.
//
// Failure messages are fixed per category so adapter output (which can
// carry URLs, stderr, or gateway error bodies) never reaches the caller.
import type { Bot } from './db';
import { agentTransport, resolveAgent, type AgentTransport, type BotAgent } from './bot-definition';
import { hermesProfilePathForBot } from './hermes';
import { createHermesAttemptAdapter } from './hermes-attempt';
import { createAgentDeckAttemptAdapter } from './agent-deck-run';
import {
  getAgentDeckServerUrl,
  isLocalAgentDeckUrl,
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
  'agent-deck-run': () => createAgentDeckAttemptAdapter(),
};

let adapterOverride: ((transport: AgentTransport) => AttemptAdapter) | null = null;

// Test seam: replaces the transport adapter selection. Pass null to restore.
export function setAttemptAdapterOverride(next: ((transport: AgentTransport) => AttemptAdapter) | null): void {
  adapterOverride = next;
}

function adapterFor(transport: AgentTransport): AttemptAdapter {
  return adapterOverride ? adapterOverride(transport) : ATTEMPT_ADAPTERS[transport]();
}

export function prepareDispatch(turn: DispatchTurn): PreparedDispatch {
  const resolved = resolveAgent(turn.bot);
  if (!resolved.launchable || !resolved.deck_id) {
    throw new DispatchFailure('agent_unavailable', AGENT_DECK_NOT_SELECTED);
  }
  const base = {
    prompt: { kind: 'conversation' as const, system: systemPromptFor(turn.bot), history: turn.history },
    deck: resolved.deck_id,
    toolProfile: turn.toolProfile ?? TOOL_PROFILE_FOR_KIND.conversation,
    sessionBinding: turn.sessionBinding ?? null,
    correlation: {},
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
  if (!isLocalAgentDeckUrl(getAgentDeckServerUrl())) {
    throw new DispatchFailure('agent_unavailable', 'The agent runtime is not reachable from this engine.');
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
    input: { ...base, target: { agentId: turn.bot.id, agent: resolved.agent }, cwd },
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
  if (category === 'unavailable') {
    return new DispatchFailure('agent_unavailable', 'The agent runtime is not available.');
  }
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
