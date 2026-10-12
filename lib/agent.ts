import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { bots, conversations, messages, queue, groups, mcpServers, launchSnapshots, approvals, memories, oneShots, routines } from './db';
import { parseApprovalCode, parseFileNames, isSafeFileName, outboundDraftFromUser, serializeDraft } from './draft';
import { mcpTurn } from './mcp';
import { readSkillState } from './skills';
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
import { beginFileReadRun, beginPublicPageReadRun, beginCodingLimbRun } from './run-child';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy',
  baseURL: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
});

const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

// Conversational delegation limits (NOT-395). Placeholder values until the
// owner confirms them; change one line here. Tests assert these constants.
export const DELEGATION_MAX_DEPTH = 3;
export const DELEGATION_MAX_DELEGATED_TURNS = 8;

export const DELEGATION_DEPTH_REASON =
  `[Delegation limit] Depth limit reached (max ${DELEGATION_MAX_DEPTH} handoffs). No further handoff.`;
export const DELEGATION_BUDGET_REASON =
  `[Delegation limit] Budget limit reached (max ${DELEGATION_MAX_DELEGATED_TURNS} delegated turns per user message). No further delegated turn.`;
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

export const MAIN_TRANSPORT = 'openai';
export const HERMES_GATEWAY_TRANSPORT = 'hermes-gateway';

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
  if (chain) chain.stopped = true;
  const stoppedSomething = cancelled > 0 || aborted > 0 || (hadActivity && !alreadyStopped);
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
// Transport rides alongside the held input (never inside the hash): main-path
// turns record MAIN_TRANSPORT, gateway pokes HERMES_GATEWAY_TRANSPORT.
const pendingSnapshots = new Map<string, { json: string; hash: string; transport: string }>();

function holdSnapshot(
  item: QueueItem,
  bot: Bot,
  skill: { path: string | null; present: boolean | null; content: string | null },
  facts: string[] | null = null,
  transport: string = MAIN_TRANSPORT
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
        msg.content === reply &&
        msg.created_at >= fromMsg.created_at
    );
    if (!hasReply) {
      targetMessageId = messages.create(targetConversation.id, 'bot', reply, target.id).id;
    }
  }

  const hasMirror = callerHistory.some(
    msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === target.id &&
      msg.content === reply &&
      msg.created_at >= roundAt
  );
  if (!hasMirror) {
    callerMessageId = messages.create(callerConversationId, 'bot', reply, target.id).id;
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
    recordApprovalIfPresent(conversation.id, messages.create(conversation.id, 'bot', prefix, bot.id));
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
  const isDelegatedTurn = delegatedTurn(conversationMessages, bot.name);
  const delegatingCallerId = callerFor(chain, bot.id);
  const delegatingCallerName = delegatingCallerId ? getBotName(delegatingCallerId) : null;

  // Timer-tick hook (NOT-411): a due one-shot or routine makes this launch
  // post its word instead of calling the model. Runs here, right behind the
  // Stop check and before any content-triggered hook, so a tick never
  // re-runs the draft, run, or MCP hooks with the stale latest user message.
  // Consumes one delegation turn like any other launch, and the budget
  // check inside refuses it once exhausted, so a tick never bypasses the
  // depth/budget limits or Stop. Delegated turns never consume a tick: a
  // WAKE handoff's launch answers the delegation, and the tick waits for its
  // own timer launch. A launch never consumes a tick while its user message
  // still awaits a reply.
  if (
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

  // Outbound-draft hook (NOT-410): a direct-thread ask mentioning email or
  // slack creates a draft card instead of a model reply. Runs behind the
  // stopped check above, consumes no delegation budget, and never fires
  // twice for the same user message. Position-based (not timestamp-based)
  // so a same-millisecond draft still counts as a reply.
  if (conversation.type === 'bot' && latestUser) {
    const draft = outboundDraftFromUser(latestUser.content);
    if (draft) {
      const userIdx = conversationMessages.findIndex(msg => msg.id === latestUser.id);
      const alreadyReplied = userIdx >= 0 && conversationMessages.slice(userIdx + 1).some(msg =>
        msg.sender_type === 'bot'
      );
      if (!alreadyReplied) {
        messages.create(item.conversation_id, 'bot', serializeDraft(draft), bot.id);
      }
      chainProcessQueue();
      return;
    }
  }

  // Taught-timer hook (NOT-411): a direct thread teaches its own bot a
  // durable one-shot or a recurring routine via the generalised reference
  // phrases. Silent like the reference: the tick itself is the reply.
  // Idempotent: an existing row is just re-armed. Runs behind the tick
  // check above, so a due tick never re-enters here.
  if (conversation.type === 'bot' && latestUser) {
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

  if (bot.name.toLowerCase() === 'chief-of-staff' && latestUser) {
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
  let openGroupTurn = false;
  // Delegated turns were addressed by a WAKE handoff, not by the user message,
  // so the open-group WAKE suppression must not apply to them.
  if (conversation.type === 'group' && latestUser && !isDelegatedTurn && !userAddressedBot(latestUser, bot)) {
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
  if (latestUser && latestUser.content.includes('{')) {
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
  holdSnapshot(item, bot, skillState, rememberedFacts);
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
  if (delegationChatStub) {
    responseContent = await delegationChatStub({
      botId: bot.id,
      botName: bot.name,
      conversationId: item.conversation_id,
      sent,
    });
  } else {
    if (!process.env.OPENAI_API_KEY) {
      messages.create(
        item.conversation_id,
        'bot',
        'Error: OPENAI_API_KEY not configured. Please set the environment variable to enable bot responses.',
        bot.id
      );
      return;
    }
    appendPromptLog({ bot: bot.name, conversation_id: item.conversation_id, messages: sent });

    const completion = await openai.chat.completions.create({
      model,
      messages: sent,
    });

    responseContent = completion.choices[0]?.message?.content || 'No response';
  }

  if (chain?.stopped) {
    chainProcessQueue();
    return;
  }

  if (openGroupTurn && (declinedGroupTurn(responseContent) || cannedGroupHandoff(responseContent))) {
    chainProcessQueue();
    return;
  }

  materializeFileArtifacts(responseContent);

  // Hermes gateway wake (NOT-413): when the gateway is configured and the
  // reply addresses only known specialists, poke them concurrently through
  // the one gateway. Anything else (no WAKE, GROUP, unknown target, or no
  // key) falls through to main's existing single-WAKE path byte-for-byte.
  const hermesConfig = loadHermesConfig();
  if (hermesConfig && !openGroupTurn) {
    const directives = parseWakeDirectives(responseContent);
    if (directives.length > 0) {
      const resolved = resolveWakeTargets(directives, conversation);
      const specialistTargets = resolved.filter(
        (target): target is { directive: WakeDirective; bot: Bot; group: false; unknown: false } =>
          !target.group && !target.unknown
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

  const wakeMatch = responseContent.match(/WAKE\s+(\w+):\s*([\s\S]+)/);

  if (wakeMatch) {
    const [, target, message] = wakeMatch;
    const isGroupWake = target.toUpperCase() === 'GROUP' && conversation.type === 'group';
    const targetBot = isGroupWake
      ? null
      : bots.getAll().find(b => b.name.toLowerCase() === target.toLowerCase());

    if (!isGroupWake && !targetBot) {
      recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', responseContent, bot.id));
      if (chain && !chain.stopped) {
        const callerId = popCaller(chain, bot.id);
        if (callerId) queue.enqueue(item.conversation_id, callerId);
      }
    } else {
      const matchIndex = wakeMatch.index ?? responseContent.indexOf(wakeMatch[0]);
      const prefix = responseContent.slice(0, matchIndex).trim();
      if (prefix) {
        recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', prefix, bot.id));
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
          recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', textOnly, bot.id));
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
    recordApprovalIfPresent(item.conversation_id, messages.create(item.conversation_id, 'bot', responseContent, bot.id));
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


// Approval-code hook (NOT-410): a bot reply containing
// `approve using the code <code>` opens a pending approval the thread UI
// renders as an Approve/Deny card. Replies without a code are untouched.
function recordApprovalIfPresent(conversationId: string, message: Message): void {
  try {
    const code = parseApprovalCode(message.content);
    if (!code) return;
    approvals.recordPending(conversationId, code, message.id);
  } catch (error) {
    console.error('Error recording approval:', error);
  }
}

// File-artifact hook (NOT-410): a `[file] <name>` marker followed by a fenced
// block materializes that block into files/<name> so the thread's download
// link serves it. Markers without a payload stay display-only; unsafe names
// are never written.
function materializeFileArtifacts(responseContent: string): void {
  try {
    const names = parseFileNames(responseContent);
    if (names.length === 0) return;
    const dir = path.join(process.cwd(), 'files');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
      if (!isSafeFileName(name)) continue;
      const payload = filePayloadAfter(responseContent, name);
      if (payload === null) continue;
      const filePath = path.join(dir, name);
      if (!filePath.startsWith(dir + path.sep)) continue;
      fs.writeFileSync(filePath, payload);
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
  const trimmed = text.trim().replace(/[.!\s]+$/, '');
  const match = trimmed.match(/^(?:(.+?),\s*)?reply with exactly the (?:word|token)\s+(\S+)$/i);
  if (!match) return null;
  const word = match[2].replace(/^[`"']+|[`"']+$/g, '');
  if (!word) return null;
  const named = match[1] ? match[1].trim() : null;
  return { word, named: named || null };
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

function appendPromptLog(entry: { bot: string; conversation_id: string; messages: unknown }) {
  try {
    const file = path.join(process.cwd(), '.temporal', 'model-prompts.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) {
    console.error('prompt log failed', error);
  }
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
