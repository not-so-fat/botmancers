import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { bots, conversations, messages, queue, groups, mcpServers, launchSnapshots, approvals } from './db';
import { parseApprovalCode, parseFileNames, isSafeFileName, outboundDraftFromUser, serializeDraft } from './draft';
import { mcpTurn } from './mcp';
import { readSkillState } from './skills';
import { buildSnapshotInput, hashSnapshot } from './snapshot';
import type { Bot, Message, QueueItem } from './db';
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
  if (chain) chain.stopped = true;
  const stoppedSomething = cancelled > 0 || (hadActivity && !alreadyStopped);
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
}

const AUTO_PROCESS = process.env.BOTMANCERS_NO_AUTOPROCESS !== '1';

function chainProcessQueue(): void {
  if (AUTO_PROCESS) setImmediate(() => processQueue());
}

let isProcessing = false;

// Snapshot inputs captured at config read time, held for the run, and
// written when the queue item is marked terminal. Keyed by queue item id.
// A rules/skill edit during an in-flight run never changes the held values.
const pendingSnapshots = new Map<string, { json: string; hash: string }>();

function holdSnapshot(
  item: QueueItem,
  bot: Bot,
  skill: { path: string | null; present: boolean | null; content: string | null }
): void {
  const input = buildSnapshotInput(bot, skill);
  pendingSnapshots.set(item.id, { json: JSON.stringify(input), hash: hashSnapshot(input) });
}

function flushSnapshot(item: QueueItem): void {
  const held = pendingSnapshots.get(item.id);
  pendingSnapshots.delete(item.id);
  if (!held) return;
  try {
    launchSnapshots.record(item.id, item.bot_id, held.hash, held.json);
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

  const systemPrompt = `You are ${bot.name}, ${bot.title}.

${wakeHowTo}

${standingBlock}`;

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
  const skillState = readSkillState(bot.name);
  holdSnapshot(item, bot, skillState);
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
  setInterval(() => {
    bots.touchSeen();
    processQueue().catch(console.error);
  }, 2000);
}
