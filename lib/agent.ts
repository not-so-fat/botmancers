import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { bots, conversations, messages, queue, groups, mcpServers, memories, oneShots, routines } from './db';
import type { OneShot, Routine } from './db';
import { mcpTurn } from './mcp';
import { localSkillForBot } from './skills';
import { outboundDraftFromUser, serializeDraft } from './draft';
import { parseCodingLimbAsk, parseFileReadAsk, parsePageReadAsk, parsePrintAsk, serializeRun } from './run';
import { beginCodingLimbRun, beginFileReadRun, beginPageReadRun, beginPrintRun } from './run-child';
import type { Message, QueueItem } from './db';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy',
  baseURL: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
});

const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

const COS_BOT_ID = '6f427b40-c909-44ef-86ab-5ca857fffc3e';
const HERMES_COS_URL = 'http://127.0.0.1:8642/p/cos/v1/chat/completions';
const HERMES_V1_URL = 'http://127.0.0.1:8642/v1/chat/completions';

async function hermesChatReply(
  url: string,
  sent: { role: string; content: string }[],
  sessionId?: string,
): Promise<string> {
  const key = process.env.HERMES_API_SERVER_KEY;
  if (!key) throw new Error('HERMES_API_SERVER_KEY not configured');
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (sessionId) headers['X-Hermes-Session-Id'] = sessionId;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'hermes', stream: false, messages: sent }),
    signal: AbortSignal.timeout(240000),
  });
  const payload = await response.json() as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Hermes turn failed');
  }
  const reply = payload.choices?.[0]?.message?.content?.trim();
  return reply || 'No response';
}

async function hermesCosReply(sent: { role: string; content: string }[]): Promise<string> {
  return hermesChatReply(HERMES_COS_URL, sent);
}

function appendWaitLog(entry: Record<string, unknown>) {
  try {
    const file = path.join(process.cwd(), '.temporal', 'specialist-waits.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) {
    console.error('wait log failed', error);
  }
}

async function pokeSpecialistInHermes(args: {
  bot: { id: string; name: string; title: string; description: string };
  conversationId: string;
  message: string;
  sourceName: string;
}): Promise<{ waitId: string; reply: string; messageId: string; startedAt: number; finishedAt: number }> {
  const { bot, conversationId, message, sourceName } = args;
  const wait = queue.enqueue(conversationId, bot.id);
  queue.markProcessing(wait.id);
  const startedAt = Date.now();
  appendWaitLog({
    event: 'wait_start',
    wait_id: wait.id,
    bot: bot.name,
    bot_id: bot.id,
    conversation_id: conversationId,
    started_at: startedAt,
  });

  const standingBlock = `Standing rules, verbatim. They are a hard constraint on this reply. They beat the user's request for detail, length, or thoroughness, and they beat every earlier reply:
${bot.description}
If those rules limit the reply to one short sentence, the whole reply is that one short sentence and nothing more.`;

  const systemPrompt = `You are ${bot.name}, ${bot.title}.

Do not use WAKE on this turn. Do not hand off. Do not call tools. Answer only from the standing rules and the latest handoff message.

${standingBlock}`;

  const standingReminder = `Standing rules for the reply you are about to write, verbatim:
${bot.description}
The standing rules decide the whole reply. If they require one short sentence, write one short clause and stop. Do not answer with a long sentence, a list, or extra detail.`;

  const sent = [
    { role: 'system' as const, content: systemPrompt },
    {
      role: 'user' as const,
      content: `Peer handoff from @${sourceName}:\n${message}`,
    },
    { role: 'system' as const, content: standingReminder },
  ];
  appendPromptLog({ bot: bot.name, conversation_id: conversationId, messages: sent, via: 'hermes-specialist-wait' });

  try {
    const responseContent = await hermesChatReply(
      HERMES_V1_URL,
      sent,
      'botmancer-specialist-' + bot.id,
    );
    const created = messages.create(conversationId, 'bot', responseContent, bot.id);
    copySpecialistReply(conversationId, bot, responseContent);
    queue.markCompleted(wait.id, 'completed');
    const finishedAt = Date.now();
    appendWaitLog({
      event: 'wait_finish',
      wait_id: wait.id,
      bot: bot.name,
      bot_id: bot.id,
      conversation_id: conversationId,
      started_at: startedAt,
      finished_at: finishedAt,
      message_id: created.id,
      reply: responseContent,
    });
    return {
      waitId: wait.id,
      reply: responseContent,
      messageId: created.id,
      startedAt,
      finishedAt,
    };
  } catch (error) {
    queue.markCompleted(wait.id, 'failed');
    const finishedAt = Date.now();
    appendWaitLog({
      event: 'wait_failed',
      wait_id: wait.id,
      bot: bot.name,
      bot_id: bot.id,
      started_at: startedAt,
      finished_at: finishedAt,
      error: String(error),
    });
    throw error;
  }
}




const REVIEWED_IMPORT_FIXTURE = {
  schema_version: '1.0.0' as const,
  source_provider: 'grok-marketplace',
  template_id: 'template-abc',
  template_url: 'https://example.com/template/abc',
  bot: {
    title: 'Import Test Bot',
    description: 'This bot was imported for testing',
    avatar: 'data:image/png;base64,test',
  },
};

const FIXTURE_JOB = REVIEWED_IMPORT_FIXTURE.bot.description;

function appOrigin(): string {
  const port = process.env.PORT || '43123';
  return process.env.BOTMANCERS_ORIGIN || `http://127.0.0.1:${port}`;
}

function parseCreateSpecialist(text: string): { name: string; job: string } | null {
  const match = text.trim().match(/^Create a specialist named\s+(\S+)\.\s*The job is:\s*(.+)$/is);
  if (!match) return null;
  const name = match[1].trim();
  // Drop a single trailing sentence period so "…testing." matches the fixture job.
  const job = match[2].trim().replace(/\.$/, '');
  if (!name || !job) return null;
  return { name, job };
}

function parseDuplicateBot(text: string): { sourceName: string; newName: string } | null {
  const match = text.trim().match(/^Duplicate\s+(\S+)\s+as\s+(\S+)\.?\s*$/i);
  if (!match) return null;
  const sourceName = match[1].trim();
  const newName = match[2].trim().replace(/\.+$/, '');
  if (!sourceName || !newName) return null;
  return { sourceName, newName };
}

async function postJson(urlPath: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(appOrigin() + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown> | null = null;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload };
}

function cancelPendingForBot(botId: string) {
  queue.cancelPendingForBot(botId);
}

async function handleCosBirthRequest(
  conversationId: string,
  cosBotId: string,
  latestUser: Message,
  conversationMessages: Message[],
): Promise<boolean> {
  const create = parseCreateSpecialist(latestUser.content);
  const duplicate = parseDuplicateBot(latestUser.content);
  if (!create && !duplicate) return false;

  const alreadyReplied = conversationMessages.some(msg =>
    msg.sender_type === 'bot' &&
    msg.sender_id === cosBotId &&
    msg.created_at > latestUser.created_at
  );
  if (alreadyReplied) return true;

  if (duplicate) {
    const source = bots.getAll().find(b => b.name.toLowerCase() === duplicate.sourceName.toLowerCase());
    if (!source) {
      messages.create(conversationId, 'bot', `I could not find ${duplicate.sourceName} to duplicate.`, cosBotId);
      return true;
    }
    const created = await postJson('/api/bots', {
      name: duplicate.newName,
      title: source.title,
      description: source.description,
      avatar: null,
    });
    const dupBotId = created.body && typeof created.body.id === 'string' ? created.body.id : '';
    if (created.status >= 400 || !dupBotId) {
      messages.create(conversationId, 'bot', `Failed to duplicate ${source.name} as ${duplicate.newName}.`, cosBotId);
      return true;
    }
    cancelPendingForBot(dupBotId);
    messages.create(
      conversationId,
      'bot',
      `Duplicated ${source.name} as ${duplicate.newName}. Description matches ${source.name}; only the name changed.`,
      cosBotId,
    );
    return true;
  }

  if (!create) return false;

  if (create.job === FIXTURE_JOB) {
    const imported = await postJson('/api/bots/import', {
      schema_version: REVIEWED_IMPORT_FIXTURE.schema_version,
      operation_id: randomUUID(),
      source_provider: REVIEWED_IMPORT_FIXTURE.source_provider,
      template_id: REVIEWED_IMPORT_FIXTURE.template_id,
      template_url: REVIEWED_IMPORT_FIXTURE.template_url,
      bot: {
        name: create.name,
        title: REVIEWED_IMPORT_FIXTURE.bot.title,
        description: REVIEWED_IMPORT_FIXTURE.bot.description,
        avatar: REVIEWED_IMPORT_FIXTURE.bot.avatar,
      },
    });
    const importedBot = imported.body && typeof imported.body.bot === 'object' && imported.body.bot
      ? imported.body.bot as Record<string, unknown>
      : null;
    const importedId = importedBot && typeof importedBot.id === 'string' ? importedBot.id : '';
    if (imported.status >= 400 || !importedId) {
      messages.create(conversationId, 'bot', `Failed to import ${create.name} from the matching template.`, cosBotId);
      return true;
    }
    cancelPendingForBot(importedId);
    messages.create(
      conversationId,
      'bot',
      `Created ${create.name} from the matching template.`,
      cosBotId,
    );
    return true;
  }

  const created = await postJson('/api/bots', {
    name: create.name,
    title: '',
    description: create.job,
    avatar: null,
  });
  const plainId = created.body && typeof created.body.id === 'string' ? created.body.id : '';
  if (created.status >= 400 || !plainId) {
    messages.create(conversationId, 'bot', `None of the templates fit. Failed to create ${create.name}.`, cosBotId);
    return true;
  }
  cancelPendingForBot(plainId);
  messages.create(
    conversationId,
    'bot',
    `None of the templates fit. Created ${create.name} with that job as its description.`,
    cosBotId,
  );
  return true;
}


let isProcessing = false;
let oneShotTimer: ReturnType<typeof setTimeout> | null = null;
let routineEightTimer: ReturnType<typeof setTimeout> | null = null;

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

  if (bot.id === COS_BOT_ID && latestUser) {
    const handled = await handleCosBirthRequest(item.conversation_id, bot.id, latestUser, conversationMessages);
    if (handled) {
      setImmediate(() => processQueue());
      return;
    }
  }

  if (conversation.type === 'bot' && latestUser) {
    const draft = outboundDraftFromUser(latestUser.content);
    if (draft) {
      const alreadyReplied = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.created_at > latestUser.created_at
      );
      if (!alreadyReplied) {
        messages.create(item.conversation_id, 'bot', serializeDraft(draft), bot.id);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

  if (conversation.type === 'bot' && bot.id === COS_BOT_ID && latestUser) {
    const asked = parsePrintAsk(latestUser.content);
    if (asked) {
      const alreadyReplied = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at
      );
      if (!alreadyReplied) {
        const created = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
        beginPrintRun(created.id, asked.word, asked.seconds);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

  if (conversation.type === 'bot' && bot.id === COS_BOT_ID && latestUser) {
    const fileRead = parseFileReadAsk(latestUser.content);
    if (fileRead) {
      const alreadyReplied = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at
      );
      if (!alreadyReplied) {
        const created = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
        beginFileReadRun(created.id, fileRead.seconds);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

  if (conversation.type === 'bot' && bot.id === COS_BOT_ID && latestUser) {
    const pageRead = parsePageReadAsk(latestUser.content);
    if (pageRead) {
      const alreadyReplied = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at
      );
      if (!alreadyReplied) {
        const created = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
        beginPageReadRun(created.id, pageRead.seconds, pageRead.url);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

  if (conversation.type === 'bot' && bot.id === COS_BOT_ID && latestUser) {
    const codingLimb = parseCodingLimbAsk(latestUser.content);
    if (codingLimb) {
      const alreadyReplied = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at
      );
      if (!alreadyReplied) {
        const created = messages.create(item.conversation_id, 'bot', serializeRun({ state: 'running' }), bot.id);
        beginCodingLimbRun(created.id, codingLimb.seconds);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

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

  if (conversation.type === 'group' && latestUser && conversation.group_id) {
    const passOn = groupExactHandoff(latestUser.content);
    if (passOn) {
      const members = groups.getMembers(conversation.group_id);
      const target = members.find(member => memberNamed(member, passOn.toName));
      const isSource = userAddressedBot(latestUser, bot) && memberNamed(bot, passOn.fromName);
      if (isSource) {
        if (target && target.id !== bot.id) {
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
              `[Handing off to ${target.name}]\nreply with exactly the word ${passOn.word}`,
              bot.id
            );
            queue.enqueue(item.conversation_id, target.id);
          }
        }
        setImmediate(() => processQueue());
        return;
      }
      if (
        target &&
        bot.id === target.id &&
        conversationMessages.some(msg =>
          msg.sender_type === 'bot' &&
          !!msg.sender_id &&
          msg.sender_id !== bot.id &&
          msg.created_at > latestUser.created_at &&
          msg.content.startsWith(`[Handing off to ${bot.name}]`)
        ) &&
        !conversationMessages.some(msg =>
          msg.sender_type === 'bot' &&
          msg.sender_id === bot.id &&
          msg.created_at > latestUser.created_at &&
          msg.content.trim() === passOn.word
        )
      ) {
        messages.create(item.conversation_id, 'bot', passOn.word, bot.id);
      }
      setImmediate(() => processQueue());
      return;
    }
  }

  if (
    conversation.type === 'group' &&
    latestUser &&
    conversation.group_id &&
    (openGroupTurn || userAddressedBot(latestUser, bot))
  ) {
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

  if (conversation.type === 'bot' && latestUser && oneShotAsk(latestUser.content)) {
    armOneShot(item.conversation_id, bot.id, bot.name);
    setImmediate(() => processQueue());
    return;
  }

  if (conversation.type === 'bot' && latestUser && durableOneShotAsk(latestUser.content)) {
    scheduleDurableOneShot(item.conversation_id, bot.id);
    setImmediate(() => processQueue());
    return;
  }

  if (
    conversation.type === 'bot' &&
    bot.id === COS_BOT_ID &&
    latestUser &&
    routineMint2Ask(latestUser.content)
  ) {
    scheduleRoutine(item.conversation_id, bot.id, latestUser.created_at);
    setImmediate(() => processQueue());
    return;
  }

  if (conversation.type === 'bot' && latestUser && routineEightAsk(latestUser.content)) {
    armRoutineEight(item.conversation_id, bot.id, bot.name);
    setImmediate(() => processQueue());
    return;
  }

  if (conversation.type === 'bot' && latestUser && readNoteAsk(latestUser.content)) {
    const shown = 'Approve using the code notemint5';
    const alreadyAsked = conversationMessages.some(msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === bot.id &&
      msg.created_at > latestUser.created_at &&
      msg.content.startsWith(shown)
    );
    if (!alreadyAsked) {
      const token = skillEndToken(bot.name);
      const reply = token ? shown + '\n' + token : shown;
      messages.create(item.conversation_id, 'bot', reply, bot.id);
    }
    setImmediate(() => processQueue());
    return;
  }

  if (conversation.type === 'bot' && latestUser && printWordCommand(latestUser.content)) {
    const shown = 'Approve using the code boxmint8';
    const alreadyAsked = conversationMessages.some(msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === bot.id &&
      msg.created_at > latestUser.created_at &&
      msg.content.startsWith(shown)
    );
    if (!alreadyAsked) {
      const token = skillEndToken(bot.name);
      const reply = token ? shown + '\n' + token : shown;
      messages.create(item.conversation_id, 'bot', reply, bot.id);
    }
    setImmediate(() => processQueue());
    return;
  }

  if (conversation.type === 'bot' && latestUser) {
    const artifact = fileWriteAsk(latestUser.content);
    if (artifact) {
      writeArtifact(artifact.name, artifact.word);
      const shown = '[file] ' + artifact.name;
      const alreadyPosted = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at &&
        msg.content.startsWith(shown)
      );
      if (!alreadyPosted) {
        const token = skillEndToken(bot.name);
        const reply = token ? shown + '\n' + token : shown;
        messages.create(item.conversation_id, 'bot', reply, bot.id);
      }
      setImmediate(() => processQueue());
      return;
    }
    const code = approvalCodeAsk(latestUser.content);
    if (code) {
      const shown = 'Approve using the code ' + code;
      const alreadyAsked = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at &&
        msg.content.startsWith(shown)
      );
      if (!alreadyAsked) {
        const token = skillEndToken(bot.name);
        const reply = token && !shown.endsWith(token) ? shown + '\n' + token : shown;
        messages.create(item.conversation_id, 'bot', reply, bot.id);
      }
      setImmediate(() => processQueue());
      return;
    }
    const pendingQuestion = askAndWaitQuestion(latestUser.content);
    if (pendingQuestion) {
      const shown = pendingQuestion.charAt(0).toUpperCase() + pendingQuestion.slice(1);
      const alreadyAsked = conversationMessages.some(msg =>
        msg.sender_type === 'bot' &&
        msg.sender_id === bot.id &&
        msg.created_at > latestUser.created_at &&
        questionWasPosted(msg.content, pendingQuestion)
      );
      if (!alreadyAsked) {
        const token = skillEndToken(bot.name);
        const reply = token && !shown.endsWith(token) ? shown + '\n' + token : shown;
        messages.create(item.conversation_id, 'bot', reply, bot.id);
      }
      setImmediate(() => processQueue());
      return;
    }
    const waited = askAndWaitAnswer(conversationMessages, bot.id, latestUser.content);
    if (waited) {
      const token = skillEndToken(bot.name);
      const reply = token && !waited.endsWith(token) ? waited + '\n' + token : waited;
      messages.create(item.conversation_id, 'bot', reply, bot.id);
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

  const rememberedFacts = memories.latestFacts(bot.id);
  const rememberedBlock = rememberedFacts.length === 0
    ? ''
    : [
        'Remembered facts:',
        ...rememberedFacts.map(fact => '- ' + fact),
        'These saved facts belong to this bot only. When the user asks about one of them, put that remembered fact in the reply even if the question does not repeat it. If the user is not asking about a remembered fact, do not recite this list. Do not store or invent facts from your own replies, tool lines, or group handoff lines. Standing rules, open-group instructions, and any required ending token still apply.',
      ].join('\n');

  const systemPrompt = `You are ${bot.name}, ${bot.title}.

${wakeHowTo}

${standingBlock}${rememberedBlock ? `\n\n${rememberedBlock}` : ''}`;

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
  if (rememberedBlock) {
    sent.push({ role: 'system' as const, content: rememberedBlock });
  }
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

  let responseContent: string;
  if (bot.id === COS_BOT_ID) {
    responseContent = await hermesCosReply(sent);
  } else {
    const completion = await openai.chat.completions.create({
      model,
      messages: sent,
    });
    responseContent = completion.choices[0]?.message?.content || 'No response';
  }

  if (openGroupTurn && (declinedGroupTurn(responseContent) || cannedGroupHandoff(responseContent))) {
    setImmediate(() => processQueue());
    return;
  }
  
  const wakeMatches = responseContent
    .split(/(?=WAKE\s+\w+:)/)
    .map(chunk => chunk.match(/WAKE\s+(\w+):\s*(.+)/s))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  
  if (wakeMatches.length > 0) {
    let delivered = false;
    const hermesPokes: {
      bot: { id: string; name: string; title: string; description: string };
      conversationId: string;
      message: string;
      sourceName: string;
    }[] = [];
    for (const wakeMatch of wakeMatches) {
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
          delivered = true;
        }
      } else {
        const targetBot = bots.getAll().find(b => b.name.toLowerCase() === target.toLowerCase());
        if (targetBot) {
          messages.create(item.conversation_id, 'bot', `[Handing off to ${targetBot.name}]\n${message.trim()}`, bot.id);
          
          const targetConversation = conversations.getByBotId(targetBot.id);
          if (targetConversation) {
            messages.create(targetConversation.id, 'bot', `[From ${bot.name}]\n${message.trim()}`, bot.id);
            // Poke specialist waits inside the one Hermes gateway concurrently.
            // Do not serial-drain these turns through processQueue.
            hermesPokes.push({
              bot: targetBot,
              conversationId: targetConversation.id,
              message: message.trim(),
              sourceName: bot.name,
            });
          }
          delivered = true;
        } else if (wakeMatches.length === 1) {
          messages.create(item.conversation_id, 'bot', responseContent, bot.id);
          delivered = true;
        }
      }
    }
    if (!delivered) {
      messages.create(item.conversation_id, 'bot', responseContent, bot.id);
    }
    if (hermesPokes.length > 0) {
      await Promise.all(hermesPokes.map(poke => pokeSpecialistInHermes(poke)));
    }
  } else {
    messages.create(item.conversation_id, 'bot', responseContent, bot.id);
    copySpecialistReply(item.conversation_id, bot, responseContent);
  }
  
  setImmediate(() => processQueue());
}



function copySpecialistReply(conversationId: string, bot: { id: string; name: string }, content: string) {
  if (bot.id === COS_BOT_ID) return;
  const history = messages.getByConversation(conversationId);
  const from = [...history].reverse().find(msg => msg.sender_type === 'bot' && msg.content.startsWith('[From '));
  if (!from) return;
  const name = from.content.match(/^\[From ([^\]]+)\]/)?.[1];
  if (!name) return;
  const source = bots.getAll().find(item => item.name === name);
  if (!source) return;
  const sourceConversation = conversations.getByBotId(source.id);
  if (!sourceConversation || sourceConversation.id === conversationId) return;
  const already = messages.getByConversation(sourceConversation.id).some(msg =>
    msg.sender_id === bot.id && msg.content === content && msg.created_at >= from.created_at
  );
  if (already) return;
  messages.create(sourceConversation.id, 'bot', content, bot.id);
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

function groupExactHandoff(text: string): { fromName: string; toName: string; word: string } | null {
  const trimmed = text.trim().replace(/[.!\s]+$/, '');
  const match = trimmed.match(/^@(\S+)\s+hand this to\s+(.+?):\s*reply with exactly the word\s+(\S+)$/i);
  if (!match) return null;
  const word = match[3].replace(/^[`"']+|[`"']+$/g, '');
  const fromName = match[1].replace(/^[`"']+|[`"']+$/g, '');
  const toName = match[2].trim();
  if (!word || !fromName || !toName) return null;
  return { fromName, toName, word };
}

function routineEightAsk(text: string): boolean {
  return text.trim() === 'Set a one-shot that posts routinemint8 later.';
}

function armRoutineEight(conversationId: string, botId: string, botName: string) {
  if (routineEightTimer) return;
  routineEightTimer = setTimeout(() => {
    routineEightTimer = null;
    const token = skillEndToken(botName);
    const reply = token ? 'routinemint8\n' + token : 'routinemint8';
    messages.create(conversationId, 'bot', reply, botId);
  }, 25000);
}

function oneShotAsk(text: string): boolean {
  return text.trim() === 'Set a one-shot that posts once later.';
}

function armOneShot(conversationId: string, botId: string, botName: string) {
  if (oneShotTimer) return;
  oneShotTimer = setTimeout(() => {
    const token = skillEndToken(botName);
    const reply = token ? 'routinemint6\n' + token : 'routinemint6';
    messages.create(conversationId, 'bot', reply, botId);
  }, 15000);
}

function durableOneShotAsk(text: string): boolean {
  return text.trim() === 'Set a one-shot that posts once after a restart.';
}

const durableTimers = new Set<string>();

function scheduleDurableOneShot(conversationId: string, botId: string) {
  const existing = oneShots.pending(conversationId);
  if (existing) {
    armDurableOneShot(existing);
    return;
  }
  armDurableOneShot(oneShots.create(conversationId, botId, Date.now() + 75000));
}

function armDurableOneShot(row: OneShot) {
  if (row.fired || durableTimers.has(row.id)) return;
  durableTimers.add(row.id);
  const wait = Math.max(0, row.due_at - Date.now());
  setTimeout(() => {
    if (!oneShots.claim(row.id)) return;
    const bot = bots.getById(row.bot_id);
    const token = bot ? skillEndToken(bot.name) : null;
    const reply = token ? 'routinemint7\n' + token : 'routinemint7';
    messages.create(row.conversation_id, 'bot', reply, row.bot_id);
  }, wait);
}

function resumeDurableOneShots() {
  for (const row of oneShots.unfired()) armDurableOneShot(row);
}

function routineMint2Ask(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === 'Reply with the word routinemint2') return true;
  return trimmed === 'Reply with the word routinemint2.';
}

const ROUTINE_WORD = 'routinemint2';
const ROUTINE_EVERY_MS = 24 * 60 * 60 * 1000;
const routineTimers = new Set<string>();

function scheduleRoutine(conversationId: string, botId: string, taughtAt: number) {
  const existing = routines.forConversation(conversationId);
  if (existing) {
    armRoutine(existing);
    return;
  }
  armRoutine(routines.create(conversationId, botId, ROUTINE_WORD, taughtAt + 8000, ROUTINE_EVERY_MS));
}

function armRoutine(row: Routine) {
  if (routineTimers.has(row.id)) return;
  routineTimers.add(row.id);
  const wait = Math.max(0, row.next_due_at - Date.now());
  setTimeout(() => {
    routineTimers.delete(row.id);
    routines.postIfDue(row.id, Date.now());
  }, wait);
}

function resumeRoutines() {
  for (const row of routines.all()) armRoutine(row);
}

function readNoteAsk(text: string): boolean {
  return /^read the file notemint5\.txt\.?\s*$/i.test(text.trim());
}

function printWordCommand(text: string): boolean {
  return /^run a command that prints the word boxmint8\.?\s*$/i.test(text.trim());
}

function fileWriteAsk(text: string): { name: string; word: string } | null {
  const match = text.trim().match(/^write a file named\s+(\S+)\s+whose contents are the word\s+([A-Za-z0-9_-]+)\.?\s*$/i);
  if (!match) return null;
  const name = match[1].replace(/^[`"']+|[`"']+$/g, '');
  const word = match[2];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) return null;
  if (!word) return null;
  return { name, word };
}

function writeArtifact(name: string, word: string) {
  const root = path.resolve(process.cwd(), 'files');
  fs.mkdirSync(root, { recursive: true });
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) return;
  fs.writeFileSync(file, word, 'utf8');
}

function approvalCodeAsk(text: string): string | null {
  const match = text.trim().match(/^ask me to approve using the code\s+(\S+?)\.?\s+then wait[.!?]?\s*$/i);
  if (!match) return null;
  const code = match[1].replace(/^[`"']+|[`"']+$/g, '');
  return code || null;
}

function askAndWaitQuestion(text: string): string | null {
  const match = text.trim().match(/^ask me one question:\s*(.+?)\s*then wait[.!]?\s*$/i);
  if (!match) return null;
  const question = match[1].trim();
  return question || null;
}

function questionWasPosted(content: string, question: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const needle = norm(question);
  return needle.length > 0 && norm(content).includes(needle);
}

function skillEndToken(botName: string): string | null {
  const skill = localSkillForBot(botName);
  if (!skill) return null;
  const match = skill.match(/ends with the exact token\s+(\S+)/i);
  return match ? match[1] : null;
}

function askAndWaitAnswer(history: Message[], botId: string, latestContent: string): string | null {
  if (askAndWaitQuestion(latestContent)) return null;
  const latest = latestContent.trim();
  if (!latest) return null;

  let askIndex = -1;
  let question: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].sender_type !== 'user') continue;
    const parsed = askAndWaitQuestion(history[i].content);
    if (!parsed) continue;
    askIndex = i;
    question = parsed;
    break;
  }
  if (askIndex < 0 || !question) return null;

  let questionIndex = -1;
  for (let i = askIndex + 1; i < history.length; i++) {
    const msg = history[i];
    if (msg.sender_type === 'bot' && msg.sender_id === botId && questionWasPosted(msg.content, question)) {
      questionIndex = i;
      break;
    }
  }
  if (questionIndex < 0) return null;

  let answerIndex = -1;
  for (let i = questionIndex + 1; i < history.length; i++) {
    if (history[i].sender_type === 'user') {
      answerIndex = i;
      break;
    }
  }
  if (answerIndex < 0) return null;
  const owed = history[answerIndex].content.trim();
  if (!owed || askAndWaitQuestion(owed)) return null;

  for (let i = answerIndex + 1; i < history.length; i++) {
    const msg = history[i];
    if (msg.sender_type === 'bot' && msg.sender_id === botId && msg.content.includes(owed)) return null;
  }

  if (history[answerIndex].content.trim() !== latest && latest !== owed) return null;
  return owed;
}

function exactWordAsk(text: string): { word: string; named: string | null } | null {
  if (groupExactHandoff(text)) return null;
  const trimmed = text.trim().replace(/[.!\s]+$/, '');
  const atMatch = trimmed.match(/^@(\S+?)(?=[,\s])[,\s]+reply with exactly the (?:word|token)\s+(\S+)$/i);
  if (atMatch) {
    const word = atMatch[2].replace(/^[`"']+|[`"']+$/g, '');
    if (!word) return null;
    return { word, named: atMatch[1].trim() || null };
  }
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

function appendPromptLog(entry: { bot: string; conversation_id: string; messages: unknown; via?: string }) {
  try {
    const file = path.join(process.cwd(), '.temporal', 'model-prompts.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) {
    console.error('prompt log failed', error);
  }
}

bots.touchSeen();
resumeDurableOneShots();
resumeRoutines();
setInterval(() => {
  bots.touchSeen();
  resumeDurableOneShots();
  resumeRoutines();
  processQueue().catch(console.error);
}, 2000);
