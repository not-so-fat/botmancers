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
import { agentTransport, resolveAgent, type BotAgent } from './bot-definition';
import {
  HermesError,
  hermesChat,
  hermesProfilePathForBot,
  hermesSessionIdForBot,
  loadHermesConfig,
  type HermesChatMessage,
} from './hermes';
import { awaitDeckRunEnd, parseDeckRuntime, startDeckRun } from './agent-deck-run';
import {
  getAgentDeckServerUrl,
  isLocalAgentDeckUrl,
  resolveAndEnsureBotWorkdir,
} from './agent-deck-settings';

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

function hermesMessagesFor(turn: DispatchTurn): HermesChatMessage[] {
  return [
    { role: 'system', content: systemPromptFor(turn.bot) },
    ...turn.history.map(entry => entry.fromAgent
      ? { role: 'assistant', content: entry.content }
      : { role: 'user', content: `[From ${entry.speakerLabel}] ${entry.content}` }),
  ];
}

function deckPromptFor(turn: DispatchTurn): string {
  const transcript = turn.history
    .map(entry => `[${entry.fromAgent ? 'you' : entry.speakerLabel}] ${entry.content}`)
    .join('\n\n');
  return `${systemPromptFor(turn.bot)}\n\nConversation so far (reply to the last message):\n\n${transcript}`;
}

async function dispatchHermes(turn: DispatchTurn, hooks: DispatchHooks): Promise<string> {
  const config = loadHermesConfig();
  if (!config) {
    throw new DispatchFailure('agent_unavailable', 'The agent runtime is not configured.');
  }
  hooks.onStarted?.();
  try {
    return await hermesChat({
      config,
      profilePath: hermesProfilePathForBot(turn.bot),
      sessionId: hermesSessionIdForBot(turn.bot.id, config),
      messages: hermesMessagesFor(turn),
      ...(hermesFetch ? { fetchImpl: hermesFetch } : {}),
    });
  } catch (error) {
    const category = error instanceof HermesError ? error.code : 'unknown';
    throw new DispatchFailure('runtime_failed', `The agent runtime did not complete the turn (${category}).`);
  }
}

// NOT-462: an ordinary direct conversation/API turn, not the composite
// implementation workflow (delegateCodingViaDeck), so it stays read-only.
async function dispatchDeckRun(turn: DispatchTurn, hooks: DispatchHooks): Promise<string> {
  const resolved = resolveAgent(turn.bot);
  if (!resolved.deck_id) {
    throw new DispatchFailure('agent_unavailable', AGENT_DECK_NOT_SELECTED);
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
  let runId: string;
  try {
    const started = await startDeckRun({
      deck: resolved.deck_id,
      client: parseDeckRuntime(resolved.agent),
      cwd,
      prompt: deckPromptFor(turn),
      tools: 'readonly',
      detach: true,
    });
    runId = started.runId;
  } catch {
    throw new DispatchFailure('runtime_failed', 'The agent runtime did not start the turn.');
  }
  hooks.onStarted?.();
  try {
    const awaited = await awaitDeckRunEnd(runId);
    return awaited.result;
  } catch {
    throw new DispatchFailure('runtime_failed', 'The agent runtime did not complete the turn.');
  }
}

export async function dispatchToAgent(turn: DispatchTurn, hooks: DispatchHooks = {}): Promise<string> {
  const resolved = resolveAgent(turn.bot);
  if (!resolved.launchable) {
    throw new DispatchFailure('agent_unavailable', AGENT_DECK_NOT_SELECTED);
  }
  return agentTransport(resolved.agent) === 'hermes-gateway'
    ? dispatchHermes(turn, hooks)
    : dispatchDeckRun(turn, hooks);
}
