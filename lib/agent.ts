import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { bots, conversations, messages, queue, groups, mcpServers } from './db';
import { mcpTurn } from './mcp';
import { localSkillForBot } from './skills';
import type { Message, QueueItem } from './db';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy',
  baseURL: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
});

const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

let isProcessing = false;

export async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      const item = queue.getNext();
      if (!item) break;

      queue.markProcessing(item.id);

      try {
        await processQueueItem(item);
        queue.markCompleted(item.id, 'completed');
      } catch (error) {
        console.error('Error processing queue item:', error);
        queue.markCompleted(item.id, 'failed');
      }
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

  const conversation = conversations.getById(item.conversation_id);
  if (!conversation) {
    console.error('Conversation not found:', item.conversation_id);
    return;
  }

  const conversationMessages = messages.getByConversation(item.conversation_id);
  const latestUser = [...conversationMessages].reverse().find(msg => msg.sender_type === 'user');
  let openGroupTurn = false;
  if (conversation.type === 'group' && latestUser && !userAddressedBot(latestUser, bot)) {
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
        setImmediate(() => processQueue());
        return;
      }
      messages.create(item.conversation_id, 'bot', ask.word, bot.id);
      setImmediate(() => processQueue());
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

  const wakeHowTo = openGroupTurn
    ? `Do not use WAKE on this turn. Do not hand off. Do not repeat an earlier handoff.`
    : `You can communicate with other bots by using the WAKE command:
- To send a message to another bot: WAKE <bot_name>: <message>
- To send a message to the group: WAKE GROUP: <message>

Examples:
- WAKE Alice: Can you research this topic?
- WAKE GROUP: I've completed my analysis.

Important: Only use WAKE when you need to hand off work to another bot or inform the group. For regular responses to the user, just reply normally.`;

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

  if (!process.env.OPENAI_API_KEY) {
    messages.create(
      item.conversation_id,
      'bot',
      'Error: OPENAI_API_KEY not configured. Please set the environment variable to enable bot responses.',
      bot.id
    );
    return;
  }

  const sent = [
    { role: 'system' as const, content: systemPrompt },
    ...chatMessages,
    { role: 'system' as const, content: standingReminder },
  ];
  const localSkill = localSkillForBot(bot.name);
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
  appendPromptLog({ bot: bot.name, conversation_id: item.conversation_id, messages: sent });

  const completion = await openai.chat.completions.create({
    model,
    messages: sent,
  });

  const responseContent = completion.choices[0]?.message?.content || 'No response';

  if (openGroupTurn && (declinedGroupTurn(responseContent) || cannedGroupHandoff(responseContent))) {
    setImmediate(() => processQueue());
    return;
  }
  
  const wakeMatch = responseContent.match(/WAKE\s+(\w+):\s*([\s\S]+)/);
  
  if (wakeMatch) {
    const [, target, message] = wakeMatch;
    
    if (target.toUpperCase() === 'GROUP' && conversation.type === 'group') {
      const textOnly = message.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '').trim();
      if (textOnly) {
        messages.create(item.conversation_id, 'bot', textOnly, bot.id);
        const groupMembers = groups.getMembers(conversation.group_id!);
        const otherBot = groupMembers.find(b => b.id !== bot.id);
        if (otherBot) {
          queue.enqueue(item.conversation_id, otherBot.id);
        }
      }
    } else {
      const targetBot = bots.getAll().find(b => b.name.toLowerCase() === target.toLowerCase());
      if (targetBot) {
        messages.create(item.conversation_id, 'bot', `[Handing off to ${targetBot.name}]\n${message.trim()}`, bot.id);
        
        const targetConversation = conversations.getByBotId(targetBot.id);
        if (targetConversation) {
          messages.create(targetConversation.id, 'bot', `[From ${bot.name}]\n${message.trim()}`, bot.id);
          queue.enqueue(targetConversation.id, targetBot.id);
        }
      } else {
        messages.create(item.conversation_id, 'bot', responseContent, bot.id);
      }
    }
  } else {
    messages.create(item.conversation_id, 'bot', responseContent, bot.id);
  }
  
  setImmediate(() => processQueue());
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

setInterval(() => {
  processQueue().catch(console.error);
}, 2000);
