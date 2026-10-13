import fs from 'fs';
import { bots, conversations, messages, queue, groups, mcpServers, launchSnapshots, memories, oneShots, routines } from './db';
import { parseApprovalCode, parseDraft, parseFileNames, serializeDraft } from './draft';
import { createDraft, parseDraftRequest } from './draft-producer';
import {
  artifactCardText,
  parseFileWriteRequest,
  parseTypedResult,
  resolveArtifactPath,
  validateArtifact,
  writeArtifactFile,
} from './artifacts';
import { mcpTurn } from './mcp';
import { applySkillEndToken, readSkillState } from './skills';
import { buildSnapshotInput, hashSnapshot } from './snapshot';
import {
  loadHermesConfig,
  hermesChat,
  hermesProfilePathForBot,
  hermesSessionIdForBot,
  appendHermesWaitLog,
  HermesError,
} from './hermes';
import type { HermesConfig } from './hermes';
import type { Bot, Conversation, Message, OneShot, QueueItem, Routine } from './db';
import { parseFileReadAsk, parsePublicPageReadAsk, parseCodingLimbAsk, serializeRun } from './run';
import { beginFileReadRun, beginPublicPageReadRun, beginCodingLimbRun, beginCommandRun } from './run-child';
import { commandRunPage, parseCommandAsk } from './commands';
import { handleCosBirthRequest } from './birth';
import {
  createPendingQuestion,
  findAnsweredByAnswer,
  findByTask,
  listAskedForConversation,
  parseAskMarker,
  parseAskRequest,
  pendingForBot,
  clearForConversation as clearPendingQuestions,
  resolveQuestion,
  resumePrompt,
  setQuestionMessage,
} from './ask';
import {
  approvalCardText,
  createApprovalRequest,
  getApprovalByCode,
  mintApprovalCode,
  raiseApprovalFromUserInstruction,
  recordModelApproval,
  setApprovalMessage,
  ApprovalActionRefused,
} from './approvals';
import {
  delegateCodingViaDeck,
  parseDeckRuntime,
  DECK_REVIEW_FOCUS_DEFAULT,
} from './agent-deck-run';
import type { DeckDelegationResult } from './agent-deck-run';
import {
  agentTransport,
  resolveAgent,
  type BotAgent,
} from './bot-definition';
import {
  getAgentDeckServerUrl,
  isLocalAgentDeckUrl,
  remoteLaunchUnsupportedMessage,
  resolveAndEnsureBotWorkdir,
} from './agent-deck-settings';

// Conversational delegation limits (NOT-395). Placeholder values until the
// owner confirms them; change one line here. Tests assert these constants.
export const DELEGATION_MAX_DEPTH = 3;
export const DELEGATION_MAX_DELEGATED_TURNS = 8;

export const DELEGATION_DEPTH_REASON =
  `[Delegation limit] Depth limit reached (max ${DELEGATION_MAX_DEPTH} handoffs). No further handoff.`;
export const DELEGATION_BUDGET_REASON =
  `[Delegation limit] Budget limit reached (max ${DELEGATION_MAX_DELEGATED_TURNS} delegated turns per user message). No further delegated turn.`;
// NOT-442: prompts no longer advertise a DECK directive. Ordinary turns
// dispatch through the bot's own stored agent (see agentForBot and
// processAgentDeckTurn); the model is never asked to route work, so no
// capability-probe text is presented and no probe state is cached here.

export const DELEGATION_STOPPED_REASON =
  '[Delegation stopped] Delegation stopped. No further handoffs or delegated turns.';

interface DelegationFrame {
  delegateId: string;
  callerId: string;
}

interface DelegationChain {
  userMessageId: string;
  handoffs: number;
  turns: number;
  stopped: boolean;
  frames: DelegationFrame[];
}

const delegationChains = new Map<string, DelegationChain>();

// NOT-435: the embedded example model loop is removed. Hermes turns run
// on the persistent Hermes gateway and record HERMES_GATEWAY_TRANSPORT;
// Cursor/Claude/Codex/Muse Code turns launch through `agent-deck run` and
// record AGENT_DECK_TRANSPORT. Both are adapters of the same agent +
// Agent Deck contract (NOT-456).
export const HERMES_GATEWAY_TRANSPORT = 'hermes-gateway';
export const AGENT_DECK_TRANSPORT = 'agent-deck';

// NOT-456: every stored bot resolves to exactly one agent
// (hermes|cursor|claude|codex|muse); a missing agent reads as Hermes.
export function agentForBot(bot: Pick<Bot, 'agent'>): BotAgent {
  return resolveAgent(bot).agent;
}

function transportForBot(bot: Pick<Bot, 'agent'>): string {
  return agentTransport(agentForBot(bot)) === 'hermes-gateway' ? HERMES_GATEWAY_TRANSPORT : AGENT_DECK_TRANSPORT;
}

// Visible thread error when an agent cannot launch because no Agent Deck
// is selected. Applies to every agent, Hermes included. The legacy
// free-text deck name (when present) is named so the owner knows what to
// select; no deck discovery runs here and no ID is ever guessed from it.
export function deckNeedsSelectionMessage(botName: string, legacyDeckName: string | null): string {
  const legacy = legacyDeckName ? ` (legacy deck "${legacyDeckName}")` : '';
  return `[Deck needs selection] ${botName} cannot launch: no Agent Deck is selected${legacy}. Select a deck before launching.`;
}

// Visible thread error when the persistent Hermes gateway is not
// configured. Posted as the bot's reply so the failure is visible in
// the thread; no fallback transport is attempted after this.
export const HERMES_MISSING_CONFIG_MESSAGE =
  '[Hermes configuration missing: HERMES_API_SERVER_KEY is not set. Set it to enable persistent Hermes turns. No fallback transport attempted.]';

// Visible thread error when the persistent Hermes gateway is configured
// but unreachable or rejects the turn. No fallback transport is
// attempted after this.
export function hermesTurnFailureMessage(botName: string, error: unknown): string {
  const detail = error instanceof HermesError ? error.message : String(error);
  const short = detail.length > 200 ? detail.slice(0, 197) + '...' : detail;
  return `[Hermes turn failed for ${botName}: ${short}]`;
}

// In-flight Hermes gateway pokes per conversation, so Stop aborts them.
// Entries are removed as each poke settles; an abort rejects its fetch.
const hermesInFlight = new Map<string, Set<AbortController>>();

function trackHermesPoke(conversationId: string, controller: AbortController): void {
  let active = hermesInFlight.get(conversationId);
  if (!active) {
    active = new Set();
    hermesInFlight.set(conversationId, active);
  }
  active.add(controller);
}

function untrackHermesPoke(conversationId: string, controller: AbortController): void {
  const active = hermesInFlight.get(conversationId);
  if (!active) return;
  active.delete(controller);
  if (active.size === 0) hermesInFlight.delete(conversationId);
}

function abortHermesPokes(conversationId: string): number {
  const active = hermesInFlight.get(conversationId);
  if (!active || active.size === 0) return 0;
  const count = active.size;
  for (const controller of active) {
    try {
      controller.abort();
    } catch {
      // Aborting never fails a Stop.
    }
  }
  hermesInFlight.delete(conversationId);
  return count;
}

function delegationChainFor(conversationId: string, latestUserId: string | null): DelegationChain | null {
  if (!latestUserId) return null;
  const existing = delegationChains.get(conversationId);
  if (existing && existing.userMessageId === latestUserId) return existing;
  const fresh: DelegationChain = { userMessageId: latestUserId, handoffs: 0, turns: 0, stopped: false, frames: [] };
  delegationChains.set(conversationId, fresh);
  return fresh;
}

function callerFor(chain: DelegationChain | null, delegateId: string): string | null {
  if (!chain) return null;
  for (let i = chain.frames.length - 1; i >= 0; i--) {
    if (chain.frames[i].delegateId === delegateId) return chain.frames[i].callerId;
  }
  return null;
}

function popCaller(chain: DelegationChain, delegateId: string): string | null {
  for (let i = chain.frames.length - 1; i >= 0; i--) {
    if (chain.frames[i].delegateId === delegateId) {
      const callerId = chain.frames[i].callerId;
      chain.frames.splice(i, 1);
      return callerId;
    }
  }
  return null;
}

export function getDelegationState(conversationId: string): DelegationChain | null {
  return delegationChains.get(conversationId) ?? null;
}

// Stop cancels queued delegated turns for this thread and prevents further
// handoffs in the current chain. A later user message starts a fresh chain.
// Returns true when something was actually stopped.
export function stopDelegation(conversationId: string): boolean {
  const conversationMessages = messages.getByConversation(conversationId);
  const latestUser = [...conversationMessages].reverse().find(msg => msg.sender_type === 'user');
  let chain: DelegationChain | null = null;
  if (latestUser) {
    const existing = delegationChains.get(conversationId);
    if (existing && existing.userMessageId === latestUser.id) {
      chain = existing;
    } else {
      chain = { userMessageId: latestUser.id, handoffs: 0, turns: 0, stopped: false, frames: [] };
      delegationChains.set(conversationId, chain);
    }
  }
  const alreadyStopped = chain?.stopped ?? false;
  const hadActivity = !!chain && (chain.turns > 0 || chain.handoffs > 0);
  const cancelled = queue.cancelPending(conversationId);
  const aborted = abortHermesPokes(conversationId);
  let clearedAsks = 0;
  try {
    clearedAsks = clearPendingQuestions(conversationId);
  } catch (error) {
    console.error('Error clearing pending questions:', error);
  }
  if (chain) chain.stopped = true;
  const stoppedSomething = cancelled > 0 || aborted > 0 || clearedAsks > 0 || (hadActivity && !alreadyStopped);
  if (stoppedSomething) {
    messages.create(conversationId, 'bot', DELEGATION_STOPPED_REASON);
  }
  return stoppedSomething;
}

export interface DelegationStubContext {
  botId: string;
  botName: string;
  conversationId: string;
  sent: Array<{ role: string; content: string }>;
  hermesSessionId?: string | null;
  transport?: string;
}

export type DelegationChatStub = (ctx: DelegationStubContext) => string | Promise<string>;

let delegationChatStub: DelegationChatStub | null = null;

export function setDelegationChatStub(stub: DelegationChatStub | null): void {
  delegationChatStub = stub;
}

export function resetDelegationForTests(): void {
  delegationChains.clear();
  delegationChatStub = null;
  for (const conversationId of [...hermesInFlight.keys()]) {
    abortHermesPokes(conversationId);
  }
}

export const ONE_SHOT_MESSAGE = '[one-shot]';

// True when the thread's latest user message belongs to a stopped chain.
// Timer arming checks this so a stopped routine does not enqueue a
// suppressed launch on every poll; a later user message starts a fresh
// chain and the timers resume.
function chainStoppedForLatestUser(conversationId: string): boolean {
  const conversationMessages = messages.getByConversation(conversationId);
  const latestUser = [...conversationMessages].reverse().find(msg => msg.sender_type === 'user');
  if (!latestUser) return false;
  const chain = delegationChains.get(conversationId);
  return !!chain && chain.userMessageId === latestUser.id && chain.stopped;
}

// True when the thread's latest user message belongs to a chain whose
// delegation budget is spent. Timer arming checks this (like the stopped
// check above) so an exhausted budget defers ticks instead of enqueueing a
// budget-refused launch on every heartbeat; the next user message starts a
// fresh chain and the preserved tick fires then.
function chainBudgetExhaustedForLatestUser(conversationId: string): boolean {
  const conversationMessages = messages.getByConversation(conversationId);
  const latestUser = [...conversationMessages].reverse().find(msg => msg.sender_type === 'user');
  if (!latestUser) return false;
  const chain = delegationChains.get(conversationId);
  return !!chain && chain.userMessageId === latestUser.id && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS;
}

// True while the latest user message has no bot reply after it, so a tick
// never steals a user's turn.
function userAwaitingReply(conversationMessages: Message[], latestUser: Message | null): boolean {
  if (!latestUser) return false;
  const userIdx = conversationMessages.findIndex(msg => msg.id === latestUser.id);
  return userIdx >= 0 && !conversationMessages.slice(userIdx + 1).some(msg =>
    msg.sender_type === 'bot'
  );
}

// Tick launches use this instead of userAwaitingReply directly. A
// taught-timer phrase is answered by the arming itself: teaching is silent
// by design (the tick is the reply), so in a direct bot thread it must not
// block ticks. Without this bypass a taught routine/one-shot never posts:
// the tick launch sees the unanswered teaching message, falls through to
// the teaching hook, and re-arms the already-due row with wait 0 in a
// tight loop. Scoped to bot threads, the only place the teaching hook runs.
function tickBlockedByUserTurn(
  conversationId: string,
  conversationMessages: Message[],
  latestUser: Message | null
): boolean {
  if (!latestUser) return false;
  if (!userAwaitingReply(conversationMessages, latestUser)) return false;
  const conversation = conversations.getById(conversationId);
  if (conversation?.type !== 'bot') return true;
  return routineTeachWord(latestUser.content) === null && oneShotTeachDelayMs(latestUser.content) === null;
}

// Non-consuming twin of consumeDueTimerTick: true when this launch would
// consume a due one-shot or routine tick for the owning bot.
function peekDueTimerTick(
  conversationId: string,
  botId: string,
  conversationMessages: Message[],
  latestUser: Message | null
): boolean {
  if (tickBlockedByUserTurn(conversationId, conversationMessages, latestUser)) return false;
  const now = Date.now();
  const pendingOneShot = oneShots.pending(conversationId);
  if (pendingOneShot && pendingOneShot.bot_id === botId && pendingOneShot.due_at <= now) return true;
  const routine = routines.forConversation(conversationId);
  if (routine && routine.bot_id === botId && routine.next_due_at <= now) return true;
  return false;
}

// Claims one due one-shot or routine tick for this launch and posts it.
// Returns true when the launch is fully consumed by the tick. Only the
// owning bot's launch consumes a row, and only when no user message is
// still awaiting a reply, so a tick never steals a user's turn.
function consumeDueTimerTick(
  conversationId: string,
  botId: string,
  conversationMessages: Message[],
  latestUser: Message | null
): boolean {
  if (tickBlockedByUserTurn(conversationId, conversationMessages, latestUser)) return false;
  const now = Date.now();
  const pendingOneShot = oneShots.pending(conversationId);
  if (
    pendingOneShot &&
    pendingOneShot.bot_id === botId &&
    pendingOneShot.due_at <= now &&
    oneShots.claim(pendingOneShot.id)
  ) {
    messages.create(conversationId, 'bot', ONE_SHOT_MESSAGE, botId);
    return true;
  }
  const routine = routines.forConversation(conversationId);
  if (routine && routine.bot_id === botId && routine.next_due_at <= now) {
    return routines.postIfDue(routine.id, now);
  }
  return false;
}

const durableOneShotTimers = new Set<string>();
const routineTimers = new Set<string>();

// A timer tick only enqueues a launch; the launch itself claims and posts
// the tick, so Stop and the delegation limits apply to it unchanged.
function fireTimerTick(conversationId: string, botId: string): void {
  if (chainStoppedForLatestUser(conversationId)) return;
  if (chainBudgetExhaustedForLatestUser(conversationId)) return;
  if (queue.countPending(conversationId) > 0) return;
  queue.enqueue(conversationId, botId);
  chainProcessQueue();
}

function armDurableOneShot(row: OneShot): void {
  if (row.fired || durableOneShotTimers.has(row.id)) return;
  if (chainStoppedForLatestUser(row.conversation_id)) return;
  if (chainBudgetExhaustedForLatestUser(row.conversation_id)) return;
  if (queue.countPending(row.conversation_id) > 0) return;
  durableOneShotTimers.add(row.id);
  const wait = Math.max(0, row.due_at - Date.now());
  setTimeout(() => {
    durableOneShotTimers.delete(row.id);
    fireTimerTick(row.conversation_id, row.bot_id);
  }, wait);
}

function armRoutine(row: Routine): void {
  if (routineTimers.has(row.id)) return;
  if (chainStoppedForLatestUser(row.conversation_id)) return;
  if (chainBudgetExhaustedForLatestUser(row.conversation_id)) return;
  if (queue.countPending(row.conversation_id) > 0) return;
  routineTimers.add(row.id);
  const wait = Math.max(0, row.next_due_at - Date.now());
  setTimeout(() => {
    routineTimers.delete(row.id);
    fireTimerTick(row.conversation_id, row.bot_id);
  }, wait);
}

// Re-arm timers for all stored one-shots and routines. Called on process
// start and on the heartbeat interval; the extras test calls it directly.
export function resumeLoopTimers(): void {
  for (const row of oneShots.unfired()) armDurableOneShot(row);
  for (const row of routines.all()) armRoutine(row);
}

const ROUTINE_EVERY_MS = 24 * 60 * 60 * 1000;
const ROUTINE_FIRST_DUE_MS = 8000;
const ONE_SHOT_DEFAULT_DELAY_MS = 60_000;

// Test hook: the extras test shortens the taught-routine first due so
// Scenario 5 can wait past it without an 8s sleep. Default unchanged.
function taughtRoutineFirstDueMs(): number {
  const override = Number(process.env.BOTMANCERS_ROUTINE_FIRST_DUE_MS);
  if (Number.isFinite(override) && override >= 0) return override;
  return ROUTINE_FIRST_DUE_MS;
}

// Taught timers (NOT-411): the reference's fixed teaching phrases,
// generalised. `Reply with the word <word>` teaches any word (the reference
// only taught routinemint2 to chief-of-staff); `Set a one-shot[ in N
// seconds]` teaches a durable one-shot with a chosen delay. Full-string
// matches so `Reply with exactly the word X` and longer one-shot sentences
// never collide.
function routineTeachWord(text: string): string | null {
  const match = text.trim().match(/^reply with the word (\S+?)\.?$/i);
  if (!match) return null;
  const word = match[1].replace(/^[`"'"]+|[`"'"]+$/g, '');
  return word || null;
}

function oneShotTeachDelayMs(text: string): number | null {
  const match = text.trim().match(/^set a one-shot(?: in (\d+) seconds?)?\.?$/i);
  if (!match) return null;
  if (match[1]) return Number(match[1]) * 1000;
  return ONE_SHOT_DEFAULT_DELAY_MS;
}

function scheduleTaughtRoutine(conversationId: string, botId: string, word: string): void {
  const existing = routines.forConversation(conversationId);
  if (existing) {
    armRoutine(existing);
    return;
  }
  armRoutine(routines.create(conversationId, botId, word, Date.now() + taughtRoutineFirstDueMs(), ROUTINE_EVERY_MS));
}

function scheduleTaughtOneShot(conversationId: string, botId: string, delayMs: number): void {
  const existing = oneShots.pending(conversationId);
  if (existing) {
    armDurableOneShot(existing);
    return;
  }
  armDurableOneShot(oneShots.create(conversationId, botId, Date.now() + delayMs));
}

const AUTO_PROCESS = process.env.BOTMANCERS_NO_AUTOPROCESS !== '1';

function chainProcessQueue(): void {
  if (AUTO_PROCESS) setImmediate(() => processQueue());
}

let isProcessing = false;

// Snapshot inputs captured at config read time, held for the run, and
// written when the queue item is marked terminal. Keyed by queue item id.
// A rules/skill edit during an in-flight run never changes the held values.
// Transport rides alongside the held input (never inside the hash): ordinary
// turns and gateway pokes record HERMES_GATEWAY_TRANSPORT.
const pendingSnapshots = new Map<string, { json: string; hash: string; transport: string }>();

function holdSnapshot(
  item: QueueItem,
  bot: Bot,
  skill: { path: string | null; present: boolean | null; content: string | null },
  facts: string[] | null = null,
  transport: string = transportForBot(bot)
): void {
  const input = buildSnapshotInput(bot, skill, facts);
  pendingSnapshots.set(item.id, { json: JSON.stringify(input), hash: hashSnapshot(input), transport });
}

function flushSnapshot(item: QueueItem): void {
  const held = pendingSnapshots.get(item.id);
  pendingSnapshots.delete(item.id);
  if (!held) return;
  try {
    launchSnapshots.record(item.id, item.bot_id, held.hash, held.json, held.transport);
  } catch (error) {
    console.error('Error recording launch snapshot:', error);
  }
}

// Drops the held snapshot without recording it, for turns where nothing
// launches and nothing posts (unaddressed group turns, stopped chains,
// turns with no task): a launch snapshot must describe what actually
// ran, never a turn that stayed silent. Paths that post a refusal or a
// failure keep their snapshot and flush normally.
function dropSnapshot(item: QueueItem): void {
  pendingSnapshots.delete(item.id);
}

// Latest `[Handing off to <bot>]` task addressed to this bot after the
// latest user message, if any. A WAKE- or handoff-delegated Agent Deck
// turn runs this task; a direct turn runs the latest user message.
function handoffTaskFor(conversationMessages: Message[], botName: string): string | null {
  let lastUserIdx = -1;
  for (let i = 0; i < conversationMessages.length; i++) {
    if (conversationMessages[i].sender_type === 'user') lastUserIdx = i;
  }
  if (lastUserIdx < 0) return null;
  const needle = `[Handing off to ${botName}]`;
  for (let i = conversationMessages.length - 1; i > lastUserIdx; i--) {
    const msg = conversationMessages[i];
    if (msg.sender_type === 'bot' && msg.content.includes(needle)) {
      const task = msg.content.slice(msg.content.indexOf(needle) + needle.length).trim();
      return task || null;
    }
  }
  return null;
}

// NOT-456: one launch gate for every agent. A bot without a selected
// Agent Deck posts a visible notice (naming any legacy deck reference)
// and hands control back to its delegating caller; nothing launches.
function postDeckNeedsSelection(item: QueueItem, bot: Bot, chain: DelegationChain | null): void {
  messages.create(
    item.conversation_id,
    'bot',
    deckNeedsSelectionMessage(bot.name, resolveAgent(bot).deck_name),
    bot.id
  );
  if (chain && !chain.stopped) {
    const callerId = popCaller(chain, bot.id);
    if (callerId) queue.enqueue(item.conversation_id, callerId);
  }
  chainProcessQueue();
}

// NOT-442/NOT-456: direct deck-run dispatch. An ordinary message to a
// Cursor/Claude/Codex/Muse Code agent launches that agent on its selected
// deck ID directly: no Hermes turn runs first and no model-reply directive is
// parsed. The launch snapshot is held with the agent-deck transport and
// the effective working directory (stored override or
// ~/.botmancers/{botId}, created on demand), so it records what ran.
// NOT-443: a non-local workspace server URL fails explicitly here;
// remote `agent-deck run` targeting is unconfirmed.
async function processAgentDeckTurn(args: {
  item: QueueItem;
  bot: Bot;
  conversationMessages: Message[];
  latestUser: Message | null;
  chain: DelegationChain | null;
  openGroupTurn: boolean;
  delegated: boolean;
}): Promise<void> {
  const { item, bot, conversationMessages, latestUser, chain, openGroupTurn, delegated } = args;
  // Re-hold the snapshot captured at the bot-row read so every exit
  // below flushes the agent-deck transport with the stored configuration.
  holdSnapshot(item, bot, { path: null, present: null, content: null }, null, AGENT_DECK_TRANSPORT);
  // Unaddressed group turns stay silent: a deck launch is never spent
  // on a message nobody directed at this bot.
  if (openGroupTurn) {
    dropSnapshot(item);
    chainProcessQueue();
    return;
  }
  if (chain && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS) {
    messages.create(item.conversation_id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
    queue.cancelPending(item.conversation_id);
    chainProcessQueue();
    return;
  }
  const resolved = resolveAgent(bot);
  if (!resolved.launchable || !resolved.deck_id) {
    postDeckNeedsSelection(item, bot, chain);
    return;
  }
  let client;
  try {
    client = parseDeckRuntime(resolved.agent);
  } catch {
    messages.create(
      item.conversation_id,
      'bot',
      `[Deck failed] agent=${resolved.agent} deck=${resolved.deck_id} error=Invalid agent-deck run client.`,
      bot.id
    );
    if (chain && !chain.stopped) {
      const callerId = popCaller(chain, bot.id);
      if (callerId) queue.enqueue(item.conversation_id, callerId);
    }
    chainProcessQueue();
    return;
  }
  const task = (delegated ? handoffTaskFor(conversationMessages, bot.name) : null)
    ?? latestUser?.content
    ?? null;
  if (!task || !task.trim()) {
    // Nothing to run (for example the auto-enqueued greeting turn of a
    // freshly created bot): stay silent rather than launching an empty
    // run or posting a failure for a turn with no request.
    dropSnapshot(item);
    chainProcessQueue();
    return;
  }
  if (chain?.stopped) {
    dropSnapshot(item);
    chainProcessQueue();
    return;
  }
  // NOT-443: remote launch is unconfirmed. A non-local workspace server
  // URL fails explicitly here instead of running locally against a
  // same-named deck; no `agent-deck run` child starts on this path.
  const agentDeckServerUrl = getAgentDeckServerUrl();
  if (!isLocalAgentDeckUrl(agentDeckServerUrl)) {
    messages.create(item.conversation_id, 'bot', remoteLaunchUnsupportedMessage(agentDeckServerUrl), bot.id);
    if (chain && !chain.stopped) {
      const callerId = popCaller(chain, bot.id);
      if (callerId) queue.enqueue(item.conversation_id, callerId);
    }
    chainProcessQueue();
    return;
  }
  // NOT-443: per-bot default workdir (~/.botmancers/{botId}), created on
  // demand immediately before launch; a stored override wins.
  let cwd: string;
  try {
    cwd = resolveAndEnsureBotWorkdir(bot.id, resolved.working_directory);
  } catch (error) {
    messages.create(
      item.conversation_id,
      'bot',
      `[Deck failed] agent=${client} deck=${resolved.deck_id} error=${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      bot.id
    );
    if (chain && !chain.stopped) {
      const callerId = popCaller(chain, bot.id);
      if (callerId) queue.enqueue(item.conversation_id, callerId);
    }
    chainProcessQueue();
    return;
  }
  if (chain) chain.turns += 1;
  const skillState = readSkillState(bot.name);
  const rememberedFacts = memories.latestFacts(bot.id);
  // Re-hold with the resolved launch configuration: the stored agent
  // client and deck ID plus the effective working directory.
  holdSnapshot(
    item,
    { ...bot, agent: client, deck_id: resolved.deck_id, working_directory: cwd },
    skillState,
    rememberedFacts,
    AGENT_DECK_TRANSPORT
  );
  let deckDelegation: DeckDelegationResult | null = null;
  let deckFailed = false;
  try {
    deckDelegation = await delegateCodingViaDeck({
      conversationId: item.conversation_id,
      botId: bot.id,
      deck: resolved.deck_id,
      client,
      cwd,
      task: task.trim(),
      reviewFocus: DECK_REVIEW_FOCUS_DEFAULT,
      isStopped: () => chain?.stopped ?? false,
    });
  } catch {
    // [Deck failed] is already in the thread; the caller-managed return
    // below still runs so the caller can report it.
    deckFailed = true;
  }
  // A Stop-silent null (neither result nor failure) suppresses the
  // return, like every other stopped path.
  if ((deckDelegation || deckFailed) && chain && !chain.stopped) {
    const callerId = popCaller(chain, bot.id);
    if (callerId) queue.enqueue(item.conversation_id, callerId);
  }
  chainProcessQueue();
}

export async function processNextQueueItem(): Promise<boolean> {
  const item = queue.getNext();
  if (!item) return false;

  queue.markProcessing(item.id);

  try {
    await processQueueItem(item);
    queue.markCompleted(item.id, 'completed');
    flushSnapshot(item);
  } catch (error) {
    console.error('Error processing queue item:', error);
    queue.markCompleted(item.id, 'failed');
    flushSnapshot(item);
  }
  return true;
}

export async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (await processNextQueueItem()) {
      // Drains until empty; WAKE enqueues are picked up on the next iteration.
    }
  } finally {
    isProcessing = false;
  }
}

export interface WakeDirective {
  target: string;
  message: string;
}

// All WAKE directives in a model reply. General capability, not prove-shaped:
// case-insensitive, flexible spacing, bot names with dashes/underscores, any
// count. Empty tasks are dropped. The caller's user message phrasing never
// matters here; only the model reply is parsed.
export function parseWakeDirectives(responseContent: string): WakeDirective[] {
  return responseContent
    .split(/(?=WAKE\s+[A-Za-z0-9_-]+\s*:)/gi)
    .map(chunk => chunk.match(/WAKE\s+([A-Za-z0-9_-]+)\s*:\s*([\s\S]*)/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => ({ target: match[1], message: (match[2] || '').trim() }))
    .filter(directive => directive.message.length > 0);
}

type ResolvedWakeTarget =
  | { directive: WakeDirective; bot: Bot; group: false; unknown: false }
  | { directive: WakeDirective; bot: null; group: true; unknown: false }
  | { directive: WakeDirective; bot: null; group: false; unknown: true };

function resolveWakeTargets(
  directives: WakeDirective[],
  conversation: Conversation
): ResolvedWakeTarget[] {
  const all = bots.getAll();
  return directives.map(directive => {
    if (directive.target.toUpperCase() === 'GROUP' && conversation.type === 'group') {
      return { directive, bot: null, group: true as const, unknown: false as const };
    }
    const bot = all.find(candidate => candidate.name.toLowerCase() === directive.target.toLowerCase());
    if (bot) return { directive, bot, group: false as const, unknown: false as const };
    return { directive, bot: null, group: false as const, unknown: true as const };
  });
}

// One reply-mirroring mechanism for gateway pokes, reconciling same-thread
// caller-managed delegation with the snapshot's cross-thread copy: the
// specialist's reply lands once in the caller's thread (so the caller-managed
// report turn sees it as peer context) and once in the specialist's own
// thread behind a [From caller] handoff line (so the specialist thread keeps
// its continuity). Duplicate detection is scoped to the current delegation
// round: only an identical reply posted after this round's handoff marker
// suppresses the write, so a later round may legitimately post the same text
// again while a retried poke never double-posts.
export function mirrorSpecialistReply(args: {
  callerConversationId: string;
  caller: Bot;
  target: Bot;
  taskMessage: string;
  reply: string;
}): { callerMessageId: string | null; targetMessageId: string | null } {
  const { callerConversationId, caller, target, taskMessage, reply } = args;
  // One post-processed reply for both threads: a specialist whose skill says
  // replies end with the exact token T posts with T on the gateway path too.
  const posted = applySkillEndToken(target.name, reply);
  let callerMessageId: string | null = null;
  let targetMessageId: string | null = null;

  // Round boundary: this round's handoff marker in the caller thread. Each
  // wake turn posts a fresh marker, so the latest match always opens the
  // current round; a retried poke reuses it instead of opening a new one.
  const handoffLine = `[Handing off to ${target.name}]\n${taskMessage}`;
  const callerHistory = messages.getByConversation(callerConversationId);
  const handoffMsg = [...callerHistory].reverse().find(
    msg => msg.sender_type === 'bot' && msg.sender_id === caller.id && msg.content === handoffLine
  );
  const roundAt = handoffMsg ? handoffMsg.created_at : 0;

  const targetConversation = conversations.getByBotId(target.id);
  if (targetConversation && targetConversation.id !== callerConversationId) {
    const fromLine = `[From ${caller.name}]\n${taskMessage}`;
    let targetHistory = messages.getByConversation(targetConversation.id);
    let fromMsg = [...targetHistory].reverse().find(
      msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === caller.id &&
        msg.content === fromLine &&
        msg.created_at >= roundAt
    );
    if (!fromMsg) {
      fromMsg = messages.create(targetConversation.id, 'bot', fromLine, caller.id);
      targetHistory = messages.getByConversation(targetConversation.id);
    }
    const hasReply = targetHistory.some(
      msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === target.id &&
        msg.content === posted &&
        msg.created_at >= fromMsg.created_at
    );
    if (!hasReply) {
      targetMessageId = messages.create(targetConversation.id, 'bot', posted, target.id).id;
    }
  }

  const hasMirror = callerHistory.some(
    msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === target.id &&
      msg.content === posted &&
      msg.created_at >= roundAt
  );
  if (!hasMirror) {
    callerMessageId = messages.create(callerConversationId, 'bot', posted, target.id).id;
  }
  return { callerMessageId, targetMessageId };
}

function hermesFailureNotice(targetName: string, error: unknown): string {
  const detail = error instanceof HermesError ? error.message : String(error);
  const short = detail.length > 160 ? detail.slice(0, 157) + '...' : detail;
  return `[Specialist ${targetName} failed: ${short}]`;
}

// One gateway poke: a delegated turn served by the Hermes gateway instead of
// the serial queue. Owns a processing queue row (so the wait is visible and
// terminalizes completed/failed), a launch snapshot with the gateway
// transport, and one wait-log start/finish pair. Aborted by Stop via the
// conversation's AbortController set.
async function pokeSpecialistViaGateway(args: {
  caller: Bot;
  target: Bot;
  conversationId: string;
  taskMessage: string;
  chain: DelegationChain | null;
  hermesConfig: HermesConfig;
}): Promise<void> {
  const { caller, target, conversationId, taskMessage, chain, hermesConfig } = args;
  const wait = queue.enqueue(conversationId, target.id);
  queue.markProcessing(wait.id);
  const startedAt = Date.now();
  appendHermesWaitLog({
    event: 'wait_start',
    wait_id: wait.id,
    bot: target.name,
    bot_id: target.id,
    conversation_id: conversationId,
    caller: caller.name,
    started_at: startedAt,
  });

  const standingBlock = `Standing rules, verbatim. They are a hard constraint on this reply. They beat the user's request for detail, length, or thoroughness, and they beat every earlier reply:
${target.description}
If those rules limit the reply to one short sentence, the whole reply is that one short sentence and nothing more.`;

  const systemPrompt = `You are ${target.name}, ${target.title}.

You were delegated by @${caller.name}. Complete the task in your context and reply with your result in this thread.
Do not use WAKE on this turn. Do not hand off. Do not call tools. Answer only from the standing rules and the latest handoff message.

${standingBlock}`;

  const standingReminder = `Standing rules for the reply you are about to write, verbatim:
${target.description}
The standing rules decide the whole reply. If they require one short sentence, write one short clause and stop. Do not answer with a long sentence, a list, or extra detail.`;

  const rememberedFacts = memories.latestFacts(target.id);
  const skillState = readSkillState(target.name);
  holdSnapshot(wait, target, skillState, rememberedFacts, HERMES_GATEWAY_TRANSPORT);

  const sent: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Peer handoff from @${caller.name}:\n${taskMessage}` },
    { role: 'system', content: standingReminder },
  ];
  if (rememberedFacts.length > 0) {
    sent.push({ role: 'system', content: ['Remembered facts:', ...rememberedFacts.map(fact => '- ' + fact)].join('\n') });
  }
  if (skillState.content) {
    sent.push({ role: 'system', content: skillState.content });
  }

  const controller = new AbortController();
  trackHermesPoke(conversationId, controller);
  try {
    const reply = await hermesChat({
      config: hermesConfig,
      profilePath: hermesProfilePathForBot(target),
      sessionId: hermesSessionIdForBot(target.id, hermesConfig),
      messages: sent,
      signal: controller.signal,
    });
    const finishedAt = Date.now();
    if (chain?.stopped) {
      queue.markCompleted(wait.id, 'completed');
      flushSnapshot(wait);
      appendHermesWaitLog({
        event: 'wait_finish',
        wait_id: wait.id,
        bot: target.name,
        bot_id: target.id,
        conversation_id: conversationId,
        started_at: startedAt,
        finished_at: finishedAt,
        delivered: false,
      });
      return;
    }
    const { callerMessageId } = mirrorSpecialistReply({
      callerConversationId: conversationId,
      caller,
      target,
      taskMessage,
      reply,
    });
    queue.markCompleted(wait.id, 'completed');
    flushSnapshot(wait);
    appendHermesWaitLog({
      event: 'wait_finish',
      wait_id: wait.id,
      bot: target.name,
      bot_id: target.id,
      conversation_id: conversationId,
      started_at: startedAt,
      finished_at: finishedAt,
      message_id: callerMessageId,
      reply,
    });
  } catch (error) {
    const finishedAt = Date.now();
    queue.markCompleted(wait.id, 'failed');
    flushSnapshot(wait);
    appendHermesWaitLog({
      event: 'wait_failed',
      wait_id: wait.id,
      bot: target.name,
      bot_id: target.id,
      conversation_id: conversationId,
      started_at: startedAt,
      finished_at: finishedAt,
      code: error instanceof HermesError ? error.code : 'unknown',
      error: String(error),
    });
    // Aborted pokes stay silent: Stop promises no late messages. Genuine
    // failures leave one notice so the caller's report turn can see them.
    const aborted = error instanceof HermesError && error.code === 'aborted';
    if (!aborted && !chain?.stopped) {
      messages.create(conversationId, 'bot', hermesFailureNotice(target.name, error), caller.id);
    }
  } finally {
    untrackHermesPoke(conversationId, controller);
  }
}

// Gateway wake turn: the caller's reply addressed only known specialists, so
// every poke runs concurrently against the one gateway instead of draining
// serially through the queue. Each poke consumes one handoff and one turn of
// the existing limits; refused pokes post the same reasons as the main path.
// The caller is re-queued once for its report-back turn (caller-managed), and
// Stop aborts in-flight pokes and suppresses the return.
async function handleHermesWakeTurn(args: {
  bot: Bot;
  conversation: Conversation;
  chain: DelegationChain | null;
  responseContent: string;
  targets: { directive: WakeDirective; bot: Bot }[];
  hermesConfig: HermesConfig;
}): Promise<void> {
  const { bot, conversation, chain, responseContent, targets, hermesConfig } = args;
  if (chain?.stopped) {
    chainProcessQueue();
    return;
  }
  if (chain && chain.handoffs >= DELEGATION_MAX_DEPTH) {
    messages.create(conversation.id, 'bot', DELEGATION_DEPTH_REASON, bot.id);
    chainProcessQueue();
    return;
  }

  const depthRoom = chain ? DELEGATION_MAX_DEPTH - chain.handoffs : targets.length;
  const budgetRoom = chain ? DELEGATION_MAX_DELEGATED_TURNS - chain.turns : targets.length;
  const allowedCount = Math.max(0, Math.min(depthRoom, budgetRoom, targets.length));
  const allowed = targets.slice(0, allowedCount);

  if (allowed.length === 0) {
    if (depthRoom <= 0 || depthRoom <= budgetRoom) {
      messages.create(conversation.id, 'bot', DELEGATION_DEPTH_REASON, bot.id);
    } else {
      messages.create(conversation.id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
      queue.cancelPending(conversation.id);
    }
    chainProcessQueue();
    return;
  }

  const firstWakeAt = responseContent.search(/WAKE\s+[A-Za-z0-9_-]+\s*:/i);
  const prefix = (firstWakeAt >= 0 ? responseContent.slice(0, firstWakeAt) : '').trim();
  if (prefix) {
    recordApprovalIfPresent(conversation.id, messages.create(conversation.id, 'bot', applySkillEndToken(bot.name, prefix), bot.id));
  }
  for (const { directive, bot: targetBot } of allowed) {
    recordApprovalIfPresent(
      conversation.id,
      messages.create(conversation.id, 'bot', `[Handing off to ${targetBot.name}]\n${directive.message}`, bot.id)
    );
  }

  if (chain) {
    chain.handoffs += allowed.length;
    chain.turns += allowed.length;
  }

  await Promise.allSettled(
    allowed.map(({ directive, bot: targetBot }) =>
      pokeSpecialistViaGateway({
        caller: bot,
        target: targetBot,
        conversationId: conversation.id,
        taskMessage: directive.message,
        chain,
        hermesConfig,
      })
    )
  );

  if (allowed.length < targets.length) {
    if (depthRoom <= budgetRoom) {
      messages.create(conversation.id, 'bot', DELEGATION_DEPTH_REASON, bot.id);
    } else {
      messages.create(conversation.id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
      queue.cancelPending(conversation.id);
      chainProcessQueue();
      return;
    }
  }

  // Caller-managed return: one re-queue for the report-back turn, suppressed
  // by Stop. Budget for the report is enforced when that turn processes.
  if (chain && !chain.stopped) {
    queue.enqueue(conversation.id, bot.id);
  }
  chainProcessQueue();
}

async function processQueueItem(item: QueueItem) {
  const bot = bots.getById(item.bot_id);
  if (!bot) {
    console.error('Bot not found:', item.bot_id);
    return;
  }
  // Capture bot-row fields at the bot-row read. Skill fields stay null until
  // the skill-file read below, so early-return runs record the fields they
  // actually read and null for fields never read.
  holdSnapshot(item, bot, { path: null, present: null, content: null });

  const conversation = conversations.getById(item.conversation_id);
  if (!conversation) {
    console.error('Conversation not found:', item.conversation_id);
    return;
  }

  const conversationMessages = messages.getByConversation(item.conversation_id);
  const latestUser = [...conversationMessages].reverse().find(msg => msg.sender_type === 'user');

  const chain = delegationChainFor(item.conversation_id, latestUser ? latestUser.id : null);
  if (chain?.stopped) {
    chainProcessQueue();
    return;
  }

  // Ask-and-wait resume/park (NOT-415): a durable pending row replaces the
  // snapshot's history scan. When this bot parked a question, the next user
  // message in the thread is its answer: the first launch to process it wins
  // the asked->answered swap and resumes with the original task attached,
  // while a retried launch for the same answer sees the answered row and
  // stays silent, so the answer is used exactly once. A launch whose latest
  // user message is still the parked task parks again instead of re-asking.
  let askResume: { question: string; answer: string; taskContent: string | null } | null = null;
  if (latestUser) {
    const askedRow = pendingForBot(item.conversation_id, bot.id);
    if (askedRow) {
      if (latestUser.id === askedRow.task_message_id) {
        chainProcessQueue();
        return;
      }
      const resolved = resolveQuestion(askedRow.id, latestUser.id, latestUser.content);
      if (!resolved || !resolved.answer) {
        chainProcessQueue();
        return;
      }
      askResume = {
        question: resolved.question,
        answer: resolved.answer,
        taskContent: resolved.task_content,
      };
    } else if (findAnsweredByAnswer(item.conversation_id, bot.id, latestUser.id)) {
      chainProcessQueue();
      return;
    }
  }

  const isDelegatedTurn = delegatedTurn(conversationMessages, bot.name);
  const delegatingCallerId = callerFor(chain, bot.id);
  const delegatingCallerName = delegatingCallerId ? getBotName(delegatingCallerId) : null;

  // Timer-tick hook (NOT-411): a due one-shot or routine makes this launch
  // post its word instead of calling the model. Runs here, right behind the
  // Stop check and before any content-triggered hook, so a tick never
  // re-runs the birth, draft, run, or MCP hooks with the stale latest user
  // message. Consumes one delegation turn like any other launch, and the
  // budget check inside refuses it once exhausted, so a tick never bypasses
  // the depth/budget limits or Stop. Delegated turns never consume a tick: a
  // WAKE handoff's launch answers the delegation, and the tick waits for its
  // own timer launch. A launch never consumes a tick while its user message
  // still awaits a reply.
  if (
    !askResume &&
    !isDelegatedTurn &&
    peekDueTimerTick(item.conversation_id, bot.id, conversationMessages, latestUser ?? null)
  ) {
    if (chain && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS) {
      messages.create(item.conversation_id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
      queue.cancelPending(item.conversation_id);
      chainProcessQueue();
      return;
    }
    if (consumeDueTimerTick(item.conversation_id, bot.id, conversationMessages, latestUser ?? null)) {
      if (chain) chain.turns += 1;
      chainProcessQueue();
      return;
    }
    chainProcessQueue();
    return;
  }

  // Birth hook (NOT-414): the chief-of-staff (by name, never UUID) creates a
  // specialist or duplicates a bot from a chat message. Runs behind the Stop
  // check and the timer-tick hook and before every other content hook, so a
  // birth request never becomes a draft, a timer teach, or a run, while a
  // due tick still posts after a birth reply instead of being swallowed by
  // the already-answered birth request. Delegated turns skip it: a WAKE
  // handoff answers the delegation, not the latest user message.
  if (!askResume && bot.name.toLowerCase() === 'chief-of-staff' && latestUser && !isDelegatedTurn) {
    const handled = await handleCosBirthRequest(
      item.conversation_id,
      bot.id,
      latestUser,
      conversationMessages
    );
    if (handled) {
      chainProcessQueue();
      return;
    }
  }

  // Typed-draft hook (NOT-417): a direct-thread draft request (creation
  // verb + email/slack + body after that says/saying/note:) creates one
  // open draft card instead of a model reply. Plain mentions ("we should
  // email less") yield nothing and fall through. Runs behind the stopped
  // check, consumes no delegation budget, and never fires twice for the
  // same user message. Position-based (not timestamp-based) so a
  // same-millisecond draft still counts as a reply.
  if (!askResume && conversation.type === 'bot' && latestUser) {
    const request = parseDraftRequest(latestUser.content);
    if (request) {
      const userIdx = conversationMessages.findIndex(msg => msg.id === latestUser.id);
      const alreadyReplied = userIdx >= 0 && conversationMessages.slice(userIdx + 1).some(msg =>
        msg.sender_type === 'bot'
      );
      if (!alreadyReplied) {
        messages.create(item.conversation_id, 'bot', serializeDraft(createDraft(request)), bot.id);
      }
      chainProcessQueue();
      return;
    }
  }

  // Typed-file hook (NOT-417): a direct-thread file-write request writes one
  // artifact and posts one `[file]` link instead of a model reply.
  // Traversal, bad names and oversize content are refused (consumed,
  // nothing written, nothing posted). Overwriting an existing file raises a
  // `write_file` approval request instead of writing; approving runs the
  // write once. Repeat turns post nothing and rewrite nothing.
  if (!askResume && conversation.type === 'bot' && latestUser) {
    const fileRequest = parseFileWriteRequest(latestUser.content);
    if (fileRequest) {
      let valid: { name: string; content: string };
      try {
        valid = validateArtifact(fileRequest);
      } catch {
        chainProcessQueue();
        return;
      }
      const userIdx = conversationMessages.findIndex(msg => msg.id === latestUser.id);
      const afterUser = userIdx >= 0 ? conversationMessages.slice(userIdx + 1) : [];
      const alreadyPosted = afterUser.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.content.startsWith(artifactCardText(valid.name))
      );
      if (alreadyPosted) {
        chainProcessQueue();
        return;
      }
      let exists = false;
      try {
        exists = fs.existsSync(resolveArtifactPath(valid.name));
      } catch {
        chainProcessQueue();
        return;
      }
      if (exists) {
        if (!alreadyApprovalRaised(item.conversation_id, afterUser, bot.id)) {
          const code = freshWriteCode(item.conversation_id, valid.name);
          try {
            createApprovalRequest({
              conversationId: item.conversation_id,
              botId: bot.id,
              code,
              actionType: 'write_file',
              actionArgs: { name: valid.name, content: valid.content },
            });
          } catch (error) {
            if (error instanceof ApprovalActionRefused) {
              chainProcessQueue();
              return;
            }
            throw error;
          }
          const card = applySkillEndToken(bot.name, approvalCardText(code));
          const posted = messages.create(item.conversation_id, 'bot', card, bot.id);
          setApprovalMessage(item.conversation_id, code, posted.id);
        }
        chainProcessQueue();
        return;
      }
      try {
        writeArtifactFile(valid.name, valid.content, { allowOverwrite: false });
      } catch {
        chainProcessQueue();
        return;
      }
      messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, artifactCardText(valid.name)), bot.id);
      chainProcessQueue();
      return;
    }
  }

  // Taught-timer hook (NOT-411): a direct thread teaches its own bot a
  // durable one-shot or a recurring routine via the generalised reference
  // phrases. Silent like the reference: the tick itself is the reply.
  // Idempotent: an existing row is just re-armed. Runs behind the tick
  // check above, so a due tick never re-enters here.
  if (!askResume && conversation.type === 'bot' && latestUser) {
    const oneShotDelay = oneShotTeachDelayMs(latestUser.content);
    if (oneShotDelay !== null) {
      scheduleTaughtOneShot(item.conversation_id, bot.id, oneShotDelay);
      chainProcessQueue();
      return;
    }
    const routineWord = routineTeachWord(latestUser.content);
    if (routineWord) {
      scheduleTaughtRoutine(item.conversation_id, bot.id, routineWord);
      chainProcessQueue();
      return;
    }
  }

  if (!askResume && bot.name.toLowerCase() === 'chief-of-staff' && latestUser) {
    const commandAsk = parseCommandAsk(latestUser.content);
    if (commandAsk) {
      const runMessage = messages.create(
        item.conversation_id,
        'bot',
        serializeRun({ state: 'running', page: commandRunPage(commandAsk, null) }),
        bot.id
      );
      beginCommandRun(runMessage.id, commandAsk);
      chainProcessQueue();
      return;
    }
    const fileReadAsk = parseFileReadAsk(latestUser.content);
    if (fileReadAsk) {
      const runMessage = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
      beginFileReadRun(runMessage.id, fileReadAsk.seconds);
      chainProcessQueue();
      return;
    }
    const publicPageReadAsk = parsePublicPageReadAsk(latestUser.content);
    if (publicPageReadAsk) {
      const runMessage = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
      beginPublicPageReadRun(runMessage.id, publicPageReadAsk.seconds, publicPageReadAsk.url);
      chainProcessQueue();
      return;
    }
    const codingLimbAsk = parseCodingLimbAsk(latestUser.content);
    if (codingLimbAsk) {
      const runMessage = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
      beginCodingLimbRun(runMessage.id, codingLimbAsk.seconds);
      chainProcessQueue();
      return;
    }
  }

  // Approval hook (NOT-416): a direct-thread instruction asking for approval
  // (a gated file read, a gated command, or a plain approve-by-code ask)
  // raises a pending request and posts its card instead of calling the model.
  // Runs ahead of the ask-first hook below (snapshot order): an approval ask
  // also names asking and waiting, so it must be claimed here first. The
  // pending action never runs here; only the approve route executes it,
  // exactly once. Refused asks (path traversal, invalid shapes) raise
  // nothing and run nothing. A retry for an already-raised task posts no
  // second card.
  if (!askResume && conversation.type === 'bot' && latestUser) {
    const raised = raiseApprovalFromUserInstruction({
      conversationId: item.conversation_id,
      botId: bot.id,
      botName: bot.name,
      userMessage: latestUser,
      thread: conversationMessages,
    });
    if (raised) {
      chainProcessQueue();
      return;
    }
  }

  // Ask-first hook (NOT-415): the user's request says to ask one question
  // and wait. The question is stored durably and posted as an ordinary bot
  // card; the bot parks without calling the model. Single asker per task:
  // the first bot to process the request claims it and the rest park, so a
  // group ask posts once. A retry for an already-claimed task parks too.
  if (!askResume && latestUser) {
    const requested = parseAskRequest(latestUser.content);
    if (requested) {
      const claimed =
        listAskedForConversation(item.conversation_id).some(row => row.task_message_id === latestUser.id) ||
        findByTask(item.conversation_id, bot.id, latestUser.id);
      if (claimed) {
        chainProcessQueue();
        return;
      }
      const row = createPendingQuestion({
        conversationId: item.conversation_id,
        botId: bot.id,
        question: requested,
        taskMessageId: latestUser.id,
        taskContent: latestUser.content,
      });
      const posted = messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, requested), bot.id);
      setQuestionMessage(row.id, posted.id);
      recordApprovalIfPresent(item.conversation_id, posted);
      chainProcessQueue();
      return;
    }
  }

  let openGroupTurn = false;
  // Delegated turns were addressed by a WAKE handoff, not by the user message,
  // so the open-group WAKE suppression must not apply to them. Resume turns
  // are directed too: the pending row addressed this bot, not the room.
  if (!askResume && conversation.type === 'group' && latestUser && !isDelegatedTurn && !userAddressedBot(latestUser, bot)) {
    const queuedAfterPeer = conversationMessages.some(msg =>
      msg.sender_type === 'bot' &&
      !!msg.sender_id &&
      msg.sender_id !== bot.id &&
      msg.created_at > latestUser.created_at &&
      msg.created_at <= item.created_at
    );
    openGroupTurn = !queuedAfterPeer;
  }
  let toolContext: { role: 'user'; content: string } | null = null;
  if (!askResume && latestUser && latestUser.content.includes('{')) {
    for (const server of mcpServers.list()) {
      let args: string[] = [];
      try {
        const parsed = JSON.parse(server.args);
        if (Array.isArray(parsed)) args = parsed.map(part => String(part));
      } catch {
        args = [];
      }
      const ran = await mcpTurn(server.command, args, latestUser.content);
      if (!ran?.invocation) continue;
      messages.create(item.conversation_id, 'bot', `[mcp] tools: ${ran.tools.join(', ')}`, bot.id);
      messages.create(
        item.conversation_id,
        'bot',
        `[tool call] ${ran.invocation.name} ${JSON.stringify(ran.invocation.args)}`,
        bot.id
      );
      messages.create(item.conversation_id, 'bot', `[tool result] ${ran.invocation.text}`, bot.id);
      toolContext = {
        role: 'user',
        content: `Tool result ${ran.invocation.name} ${JSON.stringify(ran.invocation.args)} = ${ran.invocation.text}`,
      };
      break;
    }
  }

  // In-group handoff (NOT-418): generalises the snapshot's single
  // `@A hand this to B: reply with exactly the word W` template to any task:
  // `@Source hand this to Target: <task>`. The source posts one
  // `[Handing off to Target]` marker and enqueues the target through the
  // same depth/budget accounting as WAKE; Stop stops it. Exactly-once:
  // the source never re-posts/re-enqueues after its marker, and the target
  // never replies twice for the same user message. Non-participants stay
  // silent. Exact-word tasks (`reply with exactly the word W`) are answered
  // deterministically like the snapshot; general tasks fall through to the
  // model as a delegated turn.
  if (!askResume && conversation.type === 'group' && latestUser && conversation.group_id) {
    const handoff = parseGroupHandoff(latestUser.content);
    if (handoff) {
      const members = groups.getMembers(conversation.group_id);
      const target = members.find(member => memberNamed(member, handoff.toName));
      const isSource = userAddressedBot(latestUser, bot) && memberNamed(bot, handoff.fromName);
      if (isSource) {
        if (chain?.stopped) {
          chainProcessQueue();
          return;
        }
        if (!target || target.id === bot.id) {
          chainProcessQueue();
          return;
        }
        if (chain && chain.handoffs >= DELEGATION_MAX_DEPTH) {
          const alreadyRefused = conversationMessages.some(msg =>
            msg.sender_type === 'bot' &&
            msg.sender_id === bot.id &&
            msg.created_at > latestUser.created_at &&
            msg.content === DELEGATION_DEPTH_REASON
          );
          if (!alreadyRefused) {
            messages.create(item.conversation_id, 'bot', DELEGATION_DEPTH_REASON, bot.id);
          }
          chainProcessQueue();
          return;
        }
        if (chain && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS) {
          const alreadyRefused = conversationMessages.some(msg =>
            msg.sender_type === 'bot' &&
            msg.sender_id === bot.id &&
            msg.created_at > latestUser.created_at &&
            msg.content === DELEGATION_BUDGET_REASON
          );
          if (!alreadyRefused) {
            messages.create(item.conversation_id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
          }
          queue.cancelPending(item.conversation_id);
          chainProcessQueue();
          return;
        }
        const alreadyPassed = conversationMessages.some(msg =>
          msg.sender_type === 'bot' &&
          msg.sender_id === bot.id &&
          msg.created_at > latestUser.created_at &&
          msg.content.startsWith(`[Handing off to ${target.name}]`)
        );
        if (!alreadyPassed) {
          messages.create(
            item.conversation_id,
            'bot',
            `[Handing off to ${target.name}]\n${handoff.task}`,
            bot.id
          );
          queue.enqueue(item.conversation_id, target.id);
          if (chain) chain.handoffs += 1;
          chainProcessQueue();
          return;
        }
        // Already passed: a later WAKE to the source is answered once via the
        // model (so a handoff loop still runs under the depth limit); a plain
        // rerun without a WAKE stays silent.
        if (delegatedTurn(conversationMessages, bot.name)) {
          const wakeAt = Math.max(
            0,
            ...conversationMessages
              .filter(msg =>
                msg.sender_type === 'bot' &&
                msg.created_at > latestUser.created_at &&
                msg.content.includes(`[Handing off to ${bot.name}]`)
              )
              .map(msg => msg.created_at)
          );
          const alreadyAnsweredWake = conversationMessages.some(msg =>
            msg.sender_type === 'bot' &&
            msg.sender_id === bot.id &&
            msg.created_at > wakeAt
          );
          if (alreadyAnsweredWake) {
            chainProcessQueue();
            return;
          }
          // Else fall through to the model (do not return, do not consume).
        } else {
          chainProcessQueue();
          return;
        }
      } else if (target && bot.id === target.id) {
        if (chain?.stopped) {
          chainProcessQueue();
          return;
        }
        const markerExists = conversationMessages.some(msg =>
          msg.sender_type === 'bot' &&
          !!msg.sender_id &&
          msg.sender_id !== bot.id &&
          msg.created_at > latestUser.created_at &&
          msg.content.startsWith(`[Handing off to ${bot.name}]`)
        );
        if (!markerExists) {
          chainProcessQueue();
          return;
        }
        const exactTask = exactWordAsk(handoff.task);
        if (exactTask && (!exactTask.named || memberNamed(bot, exactTask.named))) {
          const alreadyReplied = conversationMessages.some(msg =>
            msg.sender_type === 'bot' &&
            msg.sender_id === bot.id &&
            msg.created_at > latestUser.created_at &&
            msg.content.trim() === exactTask.word
          );
          if (alreadyReplied) {
            chainProcessQueue();
            return;
          }
          if (chain && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS) {
            messages.create(item.conversation_id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
            queue.cancelPending(item.conversation_id);
            chainProcessQueue();
            return;
          }
          messages.create(item.conversation_id, 'bot', exactTask.word, bot.id);
          if (chain) chain.turns += 1;
          chainProcessQueue();
          return;
        }
        // General task: fall through to the model as a delegated turn, once
        // per handoff marker. A plain rerun without a new WAKE stays silent,
        // while a later WAKE to the target is answered (so a handoff loop
        // still runs under the depth limit).
        const wakeAt = Math.max(
          0,
          ...conversationMessages
            .filter(msg =>
              msg.sender_type === 'bot' &&
              msg.created_at > latestUser.created_at &&
              msg.content.includes(`[Handing off to ${bot.name}]`)
            )
            .map(msg => msg.created_at)
        );
        const alreadyRepliedToWake = conversationMessages.some(msg =>
          msg.sender_type === 'bot' &&
          msg.sender_id === bot.id &&
          msg.created_at > wakeAt
        );
        if (alreadyRepliedToWake) {
          chainProcessQueue();
          return;
        }
        // Fall through (do not return): delegatedTurn is true via the marker,
        // so the open-group suppression does not apply.
      } else {
        chainProcessQueue();
        return;
      }
    }
  }

  // NOT-456: agent + Agent Deck dispatch. Every agent launches only on a
  // selected deck. Cursor/Claude/Codex/Muse Code launch through
  // `agent-deck run` directly from the ordinary message; everything below
  // this branch is the Hermes gateway adapter. No model reply is parsed
  // for a DECK directive.
  const launch = resolveAgent(bot);
  if (agentTransport(launch.agent) === 'agent-deck-run') {
    await processAgentDeckTurn({
      item,
      bot,
      conversationMessages,
      latestUser: latestUser ?? null,
      chain,
      openGroupTurn,
      delegated: isDelegatedTurn,
    });
    return;
  }
  if (!launch.launchable) {
    // Unaddressed group turns stay silent, as for the coding agents.
    if (openGroupTurn) {
      dropSnapshot(item);
      chainProcessQueue();
      return;
    }
    postDeckNeedsSelection(item, bot, chain);
    return;
  }

  if (openGroupTurn && latestUser && conversation.group_id) {
    const ask = exactWordAsk(latestUser.content);
    if (ask) {
      const members = groups.getMembers(conversation.group_id);
      if (!shouldSayExactWord(bot, members, ask)) {
        chainProcessQueue();
        return;
      }
      messages.create(item.conversation_id, 'bot', ask.word, bot.id);
      chainProcessQueue();
      return;
    }
  }

  const history = openGroupTurn && latestUser ? [latestUser] : conversationMessages;
  const chatMessages = history.flatMap(msg => {
    const turn = modelTurn(msg, bot.id);
    return turn ? [turn] : [];
  });
  if (chatMessages.length === 0) {
    chatMessages.push({
      role: 'user',
      content: `You were just created. Greet in one short sentence and include your name. Do not use WAKE.`,
    });
  }
  if (toolContext) chatMessages.push(toolContext);
  if (askResume) {
    chatMessages.push({
      role: 'user',
      content: resumePrompt({
        question: askResume.question,
        answer: askResume.answer,
        taskContent: askResume.taskContent,
      }),
    });
  }

  // NOT-442: the model is never asked to route work. Hermes prompts
  // carry only the WAKE delegation rules; an agent-deck bot never reaches
  // this path (it dispatches directly in processAgentDeckTurn above).
  const delegatedHowTo = delegatingCallerName
    ? `You were delegated by @${delegatingCallerName}. Complete the task in your context and reply with your result in this thread.
Your reply will be returned to @${delegatingCallerName}, who manages the sequence and reports back.
Only use WAKE to sub-delegate part of this task to another bot:
- WAKE <bot_name>: <message>
Otherwise reply normally with your result; do not WAKE your caller back.`
    : `You can communicate with other bots by using the WAKE command:
- To send a message to another bot: WAKE <bot_name>: <message>
- To send a message to the group: WAKE GROUP: <message>

Examples:
- WAKE Alice: Can you research this topic?
- WAKE GROUP: I've completed my analysis.

Important: Only use WAKE when you need to hand off work to another bot or inform the group. When you hand off, you stay the caller: the delegate's reply will come back to you, and you decide the next step and the final report. For regular responses to the user, just reply normally.`;

  const wakeHowTo = openGroupTurn
    ? `Do not use WAKE on this turn. Do not hand off. Do not repeat an earlier handoff.`
    : delegatedHowTo;

  const standingBlock = openGroupTurn
    ? `Standing description, verbatim. It does not decide this reply. The open-group instruction beats it, including any rule inside it that says to WAKE, hand off, or acknowledge a handoff:
${bot.description}`
    : `Standing rules, verbatim. They are a hard constraint on this reply. They beat the user's request for detail, length, or thoroughness, and they beat every earlier reply:
${bot.description}
If those rules limit the reply to one short sentence, the whole reply is that one short sentence and nothing more.`;

  const rememberedFacts = memories.latestFacts(bot.id);
  const rememberedBlock = rememberedFacts.length === 0
    ? ''
    : [
        'Remembered facts:',
        ...rememberedFacts.map(fact => '- ' + fact),
        'These saved facts belong to this bot only. When the user asks about one of them, put that remembered fact in the reply even if the question does not repeat it. If the user is not asking about a remembered fact, do not recite this list. Do not store or invent facts from your own replies, tool lines, or group handoff lines. Standing rules and open-group instructions still apply.',
      ].join('\n');

  const systemPrompt = `You are ${bot.name}, ${bot.title}.

${wakeHowTo}

${standingBlock}${rememberedBlock ? `\n\n${rememberedBlock}` : ''}`;

  const standingReminder = openGroupTurn
    ? `This plain group turn is decided by the open-group instruction, not by your standing description. Do not use WAKE. Do not repeat an earlier handoff. Do not post "Please review my research". Do not acknowledge a handoff.`
    : `Standing rules for the reply you are about to write, verbatim:
${bot.description}
The standing rules decide the whole reply. If they require one short sentence, write one short clause and stop. Do not answer with a long sentence, a list, or extra detail.`;

  if (chain && chain.turns >= DELEGATION_MAX_DELEGATED_TURNS) {
    messages.create(item.conversation_id, 'bot', DELEGATION_BUDGET_REASON, bot.id);
    queue.cancelPending(item.conversation_id);
    chainProcessQueue();
    return;
  }
  if (chain) chain.turns += 1;

  const sent = [
    { role: 'system' as const, content: systemPrompt },
    ...chatMessages,
    { role: 'system' as const, content: standingReminder },
  ];
  if (rememberedBlock) {
    sent.push({ role: 'system' as const, content: rememberedBlock });
  }
  const skillState = readSkillState(bot.name);
  // NOT-442: this is the Hermes conversational path (agent-deck bots
  // dispatched above). The turn runs on the bot's Hermes session and
  // records the Hermes gateway transport. No model reply is routed to
  // Agent Deck: ordinary messages to agent-deck bots dispatch directly.
  // NOT-435 removed the embedded example model loop, so no fallback
  // transport exists after a Hermes failure.
  holdSnapshot(item, bot, skillState, rememberedFacts, HERMES_GATEWAY_TRANSPORT);
  const localSkill = skillState.content;
  if (localSkill) {
    sent.push({ role: 'system' as const, content: localSkill });
  }
  if (openGroupTurn && conversation.group_id && latestUser) {
    const peers = groups.getMembers(conversation.group_id)
      .filter(member => member.id !== bot.id)
      .map(member => member.title ? member.name + ' (' + member.title + ')' : member.name);
    const peerAlreadyReplied = conversationMessages.some(msg =>
      msg.sender_type === 'bot' &&
      !!msg.sender_id &&
      msg.sender_id !== bot.id &&
      msg.created_at > latestUser.created_at
    );
    const who = bot.title ? bot.name + ' (' + bot.title + ')' : bot.name;
    sent.push({
      role: 'system' as const,
      content: [
        'Open group turn. Nobody used @. This instruction beats your standing description, the WAKE rules, and every earlier message.',
        'Decide only from the latest user message:',
        latestUser.content,
        'Do not use WAKE. Do not repeat an earlier handoff. Do not post "Please review my research". Do not acknowledge a handoff.',
        'You are ' + who + '.',
        peers.length ? 'Other members: ' + peers.join(', ') + '.' : 'You are the only member.',
        peerAlreadyReplied
          ? 'A peer may already have posted. Ignore that if it is an earlier handoff. Still decide from the latest user message.'
          : 'No peer has replied yet.',
        'If the latest message asks a named role or person to say an exact word, only the member whose name or role fits replies, and the entire reply is that word and nothing else. Everyone else replies exactly PASS.',
        'If it asks for an exact word and names nobody: reply exactly PASS when your standing description tells you to WAKE or to hand off research. Otherwise the entire reply is that word and nothing else.',
        'If you stay silent, the entire reply is exactly PASS. PASS is discarded and not shown.',
        'If you reply, write the reply only. Do not include PASS.',
      ].join('\n'),
    });
  }
  let responseContent: string;
  // A Hermes turn goes through the bot's Hermes session. The
  // deterministic test stub stands in for the gateway reply when set
  // (existing loop tests), so those tests keep running without a
  // gateway; without a stub the turn requires Hermes configuration and
  // calls the gateway. Missing or unreachable Hermes configuration posts
  // a visible Hermes error and never falls back to another transport.
  {
    const hermesConfig = loadHermesConfig();
    const hermesSessionId = hermesConfig ? hermesSessionIdForBot(bot.id, hermesConfig) : null;
    if (delegationChatStub) {
      responseContent = await delegationChatStub({
        botId: bot.id,
        botName: bot.name,
        conversationId: item.conversation_id,
        sent,
        hermesSessionId,
        transport: HERMES_GATEWAY_TRANSPORT,
      });
    } else {
      if (!hermesConfig) {
        messages.create(item.conversation_id, 'bot', HERMES_MISSING_CONFIG_MESSAGE, bot.id);
        chainProcessQueue();
        return;
      }
      const controller = new AbortController();
      trackHermesPoke(item.conversation_id, controller);
      try {
        responseContent = await hermesChat({
          config: hermesConfig,
          profilePath: hermesProfilePathForBot(bot),
          sessionId: hermesSessionId as string,
          messages: sent.map(entry => ({ role: entry.role, content: entry.content })),
          signal: controller.signal,
        });
      } catch (error) {
        // Aborted ordinary turns stay silent: Stop promises no late
        // messages (same guard as the specialist poke path).
        const aborted = error instanceof HermesError && error.code === 'aborted';
        if (!aborted && !chain?.stopped) {
          messages.create(item.conversation_id, 'bot', hermesTurnFailureMessage(bot.name, error), bot.id);
        }
        chainProcessQueue();
        return;
      } finally {
        untrackHermesPoke(item.conversation_id, controller);
      }
    }
  }

  if (chain?.stopped) {
    chainProcessQueue();
    return;
  }

  // A handoff on an open group turn violates that turn's no-handoff
  // instruction the same way a canned WAKE does, so it is dropped silently.
  if (openGroupTurn && (declinedGroupTurn(responseContent) || cannedGroupHandoff(responseContent))) {
    chainProcessQueue();
    return;
  }

  materializeFileArtifacts(responseContent);

  // Typed-producer turn (NOT-417): the model returned a `[produce]`
  // draft/file result. A valid result becomes one `[draft]`/`[file]` card
  // (file writes use the same validator; overwrites gate through approval
  // instead); invalid markers fall through to the normal reply. The raw
  // marker is never posted. Once per turn: a retry for an already-posted
  // card posts nothing and rewrites nothing.
  const typed = parseTypedResult(responseContent);
  if (typed) {
    const userIdx = latestUser
      ? conversationMessages.findIndex(msg => msg.id === latestUser.id)
      : -1;
    const afterUser = userIdx >= 0 ? conversationMessages.slice(userIdx + 1) : [];
    if (typed.kind === 'draft') {
      const alreadyDrafted = afterUser.some(msg =>
        msg.sender_type === 'bot' && msg.sender_id === bot.id && parseDraft(msg.content)
      );
      if (!alreadyDrafted) {
        messages.create(
          item.conversation_id,
          'bot',
          serializeDraft(createDraft(typed.draft)),
          bot.id
        );
      }
      chainProcessQueue();
      return;
    }
    const validFile = typed.file;
    const alreadyPosted = afterUser.some(msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === bot.id &&
      msg.content.startsWith(artifactCardText(validFile.name))
    );
    if (alreadyPosted) {
      chainProcessQueue();
      return;
    }
    let exists = false;
    try {
      exists = fs.existsSync(resolveArtifactPath(validFile.name));
    } catch {
      chainProcessQueue();
      return;
    }
    if (exists) {
      if (!alreadyApprovalRaised(item.conversation_id, afterUser, bot.id)) {
        const code = freshWriteCode(item.conversation_id, validFile.name);
        try {
          createApprovalRequest({
            conversationId: item.conversation_id,
            botId: bot.id,
            code,
            actionType: 'write_file',
            actionArgs: { name: validFile.name, content: validFile.content },
          });
        } catch (error) {
          if (error instanceof ApprovalActionRefused) {
            chainProcessQueue();
            return;
          }
          throw error;
        }
        const card = applySkillEndToken(bot.name, approvalCardText(code));
        const posted = messages.create(item.conversation_id, 'bot', card, bot.id);
        setApprovalMessage(item.conversation_id, code, posted.id);
      }
      chainProcessQueue();
      return;
    }
    try {
      writeArtifactFile(validFile.name, validFile.content, { allowOverwrite: false });
    } catch {
      chainProcessQueue();
      return;
    }
    messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, artifactCardText(validFile.name)), bot.id);
    chainProcessQueue();
    return;
  }

  // Ask-marker turn (NOT-415): the model needs input, so the question is
  // stored durably and posted as an ordinary bot card, and the turn parks.
  // A delegate parks the same way in the shared thread: its caller frame is
  // left on the stack, so the resumed answer returns to the caller. The raw
  // marker is never posted. A retry for an already-parked task parks too.
  const askedMarker = parseAskMarker(responseContent);
  if (askedMarker) {
    const taskId = latestUser ? latestUser.id : null;
    const existing = pendingForBot(item.conversation_id, bot.id);
    if (existing && taskId && existing.task_message_id === taskId) {
      chainProcessQueue();
      return;
    }
    const row = createPendingQuestion({
      conversationId: item.conversation_id,
      botId: bot.id,
      question: askedMarker,
      taskMessageId: taskId,
      taskContent: latestUser ? latestUser.content : null,
    });
    const posted = messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, askedMarker), bot.id);
    setQuestionMessage(row.id, posted.id);
    recordApprovalIfPresent(item.conversation_id, posted);
    chainProcessQueue();
    return;
  }

  // Hermes gateway wake (NOT-413): when the gateway is configured and the
  // reply addresses only known specialists, poke them concurrently through
  // the one gateway. Anything else (no WAKE, GROUP, unknown target, or no
  // key) falls through to main's existing single-WAKE path byte-for-byte.
  const hermesConfig = loadHermesConfig();
  if (hermesConfig && !openGroupTurn) {
    const directives = parseWakeDirectives(responseContent);
    if (directives.length > 0) {
      const resolved = resolveWakeTargets(directives, conversation);
      // NOT-456: only launchable Hermes agents are poked through the
      // gateway; any other target falls through to the queued path,
      // which applies that agent's own adapter and deck gate.
      const specialistTargets = resolved.filter(
        (target): target is { directive: WakeDirective; bot: Bot; group: false; unknown: false } =>
          !target.group && !target.unknown &&
          agentTransport(resolveAgent(target.bot).agent) === 'hermes-gateway' &&
          resolveAgent(target.bot).launchable
      );
      if (specialistTargets.length === resolved.length) {
        await handleHermesWakeTurn({
          bot,
          conversation,
          chain,
          responseContent,
          targets: specialistTargets.map(target => ({ directive: target.directive, bot: target.bot })),
          hermesConfig,
        });
        return;
      }
    }
  }

  // NOT-442: no directive routing. A model reply is never parsed for a
  // DECK directive: agent-deck bots dispatch directly from the ordinary
  // message in processAgentDeckTurn, and Hermes replies stay
  // conversational (WAKE handoffs below are the only reply routing).

  const wakeMatch = responseContent.match(/WAKE\s+(\w+):\s*([\s\S]+)/);

  if (wakeMatch) {
    const [, target, message] = wakeMatch;
    const isGroupWake = target.toUpperCase() === 'GROUP' && conversation.type === 'group';
    const targetBot = isGroupWake
      ? null
      : bots.getAll().find(b => b.name.toLowerCase() === target.toLowerCase());

    if (!isGroupWake && !targetBot) {
      recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, responseContent), bot.id));
      if (chain && !chain.stopped) {
        const callerId = popCaller(chain, bot.id);
        if (callerId) queue.enqueue(item.conversation_id, callerId);
      }
    } else {
      const matchIndex = wakeMatch.index ?? responseContent.indexOf(wakeMatch[0]);
      const prefix = responseContent.slice(0, matchIndex).trim();
      if (prefix) {
        recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, prefix), bot.id));
      }

      if (chain?.stopped) {
        chainProcessQueue();
        return;
      }
      if (chain && chain.handoffs >= DELEGATION_MAX_DEPTH) {
        messages.create(item.conversation_id, 'bot', DELEGATION_DEPTH_REASON, bot.id);
        chainProcessQueue();
        return;
      }

      if (isGroupWake) {
        const textOnly = message.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '').trim();
        if (textOnly) {
          recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, textOnly), bot.id));
          const groupMembers = groups.getMembers(conversation.group_id!);
          const otherBot = groupMembers.find(b => b.id !== bot.id);
          if (otherBot) {
            queue.enqueue(item.conversation_id, otherBot.id);
            if (chain) {
              chain.handoffs += 1;
              chain.frames.push({ delegateId: otherBot.id, callerId: bot.id });
            }
          }
        }
      } else if (targetBot) {
        // Same-thread caller-managed delegation: the target replies in this
        // thread, so the draft, the check, and the final report stay together.
        // The caller stays on the stack; the delegate's reply returns to it.
        recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', `[Handing off to ${targetBot.name}]\n${message.trim()}`, bot.id));
        queue.enqueue(item.conversation_id, targetBot.id);
        if (chain) {
          chain.handoffs += 1;
          chain.frames.push({ delegateId: targetBot.id, callerId: bot.id });
        }
      }
    }
  } else {
    recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', applySkillEndToken(bot.name, responseContent), bot.id));
    // Caller-managed return: a delegated turn that finishes without a further
    // WAKE hands control back to its caller. Budget is enforced on the
    // caller's next turn; Stop suppresses the return.
    if (chain && !chain.stopped) {
      const callerId = popCaller(chain, bot.id);
      if (callerId) queue.enqueue(item.conversation_id, callerId);
    }
  }

  chainProcessQueue();
}


// Approval-code hook (NOT-416): a bot reply containing
// `approve using the code <code>` opens a pending approval request the thread
// UI renders as an Approve/Deny card. Replies without a code are untouched.
function recordApprovalIfPresent(conversationId: string, message: Message): void {
  try {
    recordModelApproval(conversationId, message);
  } catch (error) {
    console.error('Error recording approval:', error);
  }
}

// Gated file-write helpers (NOT-417): an overwrite raises a `write_file`
// approval instead of writing. The already-raised check keeps retries from
// posting a second card for the same user message.
function alreadyApprovalRaised(
  conversationId: string,
  afterUser: Message[],
  botId: string
): boolean {
  return afterUser.some(msg => {
    if (msg.sender_type !== 'bot' || msg.sender_id !== botId) return false;
    const code = parseApprovalCode(msg.content);
    return !!code && !!getApprovalByCode(conversationId, code);
  });
}

function freshWriteCode(conversationId: string, name: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = mintApprovalCode(`write-${name}`);
    if (!getApprovalByCode(conversationId, code)) return code;
  }
  return mintApprovalCode(`write-${name}-${Date.now().toString(36)}`);
}

// File-artifact hook (NOT-410, validated by NOT-417): a `[file] <name>`
// marker followed by a fenced block materializes that block into the files
// root so the thread's download link serves it. Markers without a payload
// stay display-only; unsafe names, oversize payloads and existing files are
// never written.
function materializeFileArtifacts(responseContent: string): void {
  try {
    const names = parseFileNames(responseContent);
    if (names.length === 0) return;
    for (const name of names) {
      const payload = filePayloadAfter(responseContent, name);
      if (payload === null) continue;
      try {
        writeArtifactFile(name, payload, { allowOverwrite: false });
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.error('Error materializing file artifact:', error);
  }
}

function filePayloadAfter(responseContent: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = responseContent.split('\n');
  const index = lines.findIndex(line => new RegExp(`^\\s*\\[file\\]\\s*${escaped}\\s*$`, 'i').test(line));
  if (index < 0) return null;
  const fence = lines.slice(index + 1).join('\n').match(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/);
  if (!fence) return null;
  return fence[1].replace(/\r\n/g, '\n');
}

function delegatedTurn(conversationMessages: Message[], botName: string): boolean {
  let lastUserIdx = -1;
  for (let i = 0; i < conversationMessages.length; i++) {
    if (conversationMessages[i].sender_type === 'user') lastUserIdx = i;
  }
  if (lastUserIdx < 0) return false;
  const needle = `[Handing off to ${botName}]`;
  for (let i = lastUserIdx + 1; i < conversationMessages.length; i++) {
    const msg = conversationMessages[i];
    if (msg.sender_type === 'bot' && msg.content.includes(needle)) return true;
  }
  return false;
}

function userAddressedBot(msg: Message, bot: { id: string; name: string }): boolean {
  if (msg.handoff_targets) {
    try {
      const ids = JSON.parse(msg.handoff_targets);
      if (Array.isArray(ids) && ids.map(id => String(id)).includes(bot.id)) return true;
    } catch {
      // not a handoff list
    }
  }
  const needle = '@' + bot.name;
  let from = 0;
  while (from < msg.content.length) {
    const at = msg.content.indexOf(needle, from);
    if (at < 0) return false;
    const after = msg.content[at + needle.length];
    if (!after || /[\s.,!?:;]/.test(after)) return true;
    from = at + needle.length;
  }
  return false;
}

function declinedGroupTurn(text: string): boolean {
  const trimmed = text.trim().replace(/^`+|`+$/g, '').trim();
  return /^pass[.!]?$/i.test(trimmed);
}

function cannedGroupHandoff(text: string): boolean {
  return /WAKE\s+\w+\s*:/.test(text)
    || /please review my research/i.test(text)
    || /\[Handing off to\b/i.test(text);
}

function exactWordAsk(text: string): { word: string; named: string | null } | null {
  if (parseGroupHandoff(text)) return null;
  const trimmed = text.trim().replace(/[.!\s]+$/, '');
  const match = trimmed.match(/^(?:(.+?),\s*)?reply with exactly the (?:word|token)\s+(\S+)$/i);
  if (!match) return null;
  const word = match[2].replace(/^[`"']+|[`"']+$/g, '');
  if (!word) return null;
  const named = match[1] ? match[1].trim() : null;
  return { word, named: named || null };
}

// General in-group handoff (NOT-418): `@Source hand this to Target: <task>`
// with `hand off to` / `pass this to` variants. The snapshot's
// `@A hand this to B: reply with exactly the word W` is one task shape.
export function parseGroupHandoff(text: string): { fromName: string; toName: string; task: string } | null {
  const trimmed = text.trim().replace(/[.!\s]+$/, '');
  const match = trimmed.match(/^@(\S+)\s+(?:hand this to|hand off to|pass this to)\s+(.+?):\s*(.+)$/i);
  if (!match) return null;
  const fromName = match[1].replace(/^[`"'"]+|[`"'"]+$/g, '').trim();
  const toName = match[2].trim().replace(/^[`"'"]+|[`"'"]+$/g, '').trim();
  const task = match[3].trim();
  if (!fromName || !toName || !task) return null;
  return { fromName, toName, task };
}

function memberNamed(bot: { name: string; title: string }, named: string): boolean {
  const needle = named.trim().toLowerCase().replace(/^the\s+/, '');
  if (!needle) return false;
  if (bot.name.toLowerCase() === needle) return true;
  return (bot.title || '').trim().toLowerCase() === needle;
}

function standingHandoff(description: string): boolean {
  return /WAKE\s+\w+\s*:/.test(description) || /please review my research/i.test(description);
}

function shouldSayExactWord(
  bot: { id: string; name: string; title: string; description: string },
  members: { id: string; name: string; title: string; description: string }[],
  ask: { word: string; named: string | null }
): boolean {
  if (ask.named) return memberNamed(bot, ask.named);
  if (!standingHandoff(bot.description)) return true;
  const peerCanAnswer = members.some(member => member.id !== bot.id && !standingHandoff(member.description));
  return !peerCanAnswer;
}

function getBotName(botId: string): string {
  const bot = bots.getById(botId);
  return bot?.name || 'Unknown';
}

function handoffLine(msg: Message): string | null {
  if (!msg.handoff_targets) return null;
  try {
    const ids = JSON.parse(msg.handoff_targets);
    if (!Array.isArray(ids)) return null;
    const names = ids
      .map(id => bots.getById(String(id))?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return null;
    return `Peer handoff: ${names.map(name => '@' + name).join(' ')}`;
  } catch {
    return null;
  }
}

function modelTurn(msg: Message, selfId: string): { role: 'user'; content: string } | null {
  if (msg.sender_type === 'user') {
    const handoff = handoffLine(msg);
    if (!handoff) return { role: 'user', content: msg.content };
    const prior = messages.priorSentenceForHandoff(msg);
    if (prior) {
      return { role: 'user', content: `${handoff}\n${prior}\n${msg.content}` };
    }
    return { role: 'user', content: `${handoff}\n${msg.content}` };
  }
  if (msg.sender_type === 'bot' && msg.sender_id && msg.sender_id !== selfId) {
    return { role: 'user', content: `Peer handoff from @${getBotName(msg.sender_id)}:\n${msg.content}` };
  }
  return null;
}

if (AUTO_PROCESS) {
  bots.touchSeen();
  resumeLoopTimers();
  setInterval(() => {
    bots.touchSeen();
    resumeLoopTimers();
    processQueue().catch(console.error);
  }, 2000);
}
