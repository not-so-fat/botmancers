// NOT-446: runtime-neutral dispatch for the agent conversation API.
//
// Callers name an agent; this module routes the turn through that bot's
// single stored runtime (NOT-442) and returns only the reply text or a
// typed failure. Completion is typed by the adapter contract, never read
// from reply prose: a Hermes turn completes when the gateway answers the
// chat request with HTTP 200, and an Agent Deck turn completes only when
// `agent-deck run log --follow` reports an end event and run status is not
// error/died. The detach acknowledgement from `agent-deck run` is a
// transport acknowledgement, not completion.
//
// Failure messages are fixed per category so adapter output (which can
// carry URLs, stderr, or gateway error bodies) never reaches the caller.
import type { Bot } from './db';
import { resolveRuntime, RUNTIME_AGENT_DECK, type BotRuntime } from './bot-definition';
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

export function runtimeForDispatch(bot: Bot): BotRuntime {
  return resolveRuntime(bot).runtime;
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

async function dispatchAgentDeck(turn: DispatchTurn, hooks: DispatchHooks): Promise<string> {
  const resolved = resolveRuntime(turn.bot);
  if (!resolved.launchable || !resolved.agent_client || !resolved.deck_id) {
    throw new DispatchFailure('agent_unavailable', 'The agent has no launchable runtime selection.');
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
      client: parseDeckRuntime(resolved.agent_client),
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
  return runtimeForDispatch(turn.bot) === RUNTIME_AGENT_DECK
    ? dispatchAgentDeck(turn, hooks)
    : dispatchHermes(turn, hooks);
}
