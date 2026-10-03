import OpenAI from 'openai';
import { bots, conversations, messages, queue, groups } from './db';

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

async function processQueueItem(item: { conversation_id: string; bot_id: string }) {
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
  
  const chatMessages = conversationMessages.map(msg => ({
    role: msg.sender_type === 'user' ? 'user' as const : 'assistant' as const,
    content: msg.sender_id
      ? `[Message from ${getBotName(msg.sender_id)}]\n${msg.content}`
      : msg.content,
  }));

  const systemPrompt = `You are ${bot.name}, ${bot.title}.

${bot.description}

You can communicate with other bots by using the WAKE command:
- To send a message to another bot: WAKE <bot_name>: <message>
- To send a message to the group: WAKE GROUP: <message>

Examples:
- WAKE Alice: Can you research this topic?
- WAKE GROUP: I've completed my analysis.

Important: Only use WAKE when you need to hand off work to another bot or inform the group. For regular responses to the user, just reply normally.`;

  if (!process.env.OPENAI_API_KEY) {
    messages.create(
      item.conversation_id,
      'bot',
      'Error: OPENAI_API_KEY not configured. Please set the environment variable to enable bot responses.',
      bot.id
    );
    return;
  }

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...chatMessages,
    ],
  });

  const responseContent = completion.choices[0]?.message?.content || 'No response';
  
  const wakeMatch = responseContent.match(/WAKE\s+(\w+):\s*(.+)/s);
  
  if (wakeMatch) {
    const [, target, message] = wakeMatch;
    
    if (target.toUpperCase() === 'GROUP' && conversation.type === 'group') {
      messages.create(item.conversation_id, 'bot', message.trim(), bot.id);
      
      const groupMembers = groups.getMembers(conversation.group_id!);
      const otherBot = groupMembers.find(b => b.id !== bot.id);
      if (otherBot) {
        queue.enqueue(item.conversation_id, otherBot.id);
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

function getBotName(botId: string): string {
  const bot = bots.getById(botId);
  return bot?.name || 'Unknown';
}

setInterval(() => {
  processQueue().catch(console.error);
}, 2000);
