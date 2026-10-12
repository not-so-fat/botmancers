// Ask-and-wait (NOT-415): durable pending questions.
//
// A bot that needs input parks: its question is stored as a pending_questions
// row (conversation, bot, question text, originating task message, status
// asked/answered/expired) and posted as an ordinary bot message. The next user
// message in that thread resolves the row and resumes the same bot turn with
// the original task attached. State lives in SQLite, so it survives restarts;
// nothing here is held in memory.
//
// Two triggers create a row:
// - the model emits a structured ask marker (parseAskMarker), or
// - the user's request says to ask first (parseAskRequest).
//
// The snapshot recognised one sentence shape and re-derived state by scanning
// history. This module generalises the sentence (snapshot shape is one case
// among paraphrases) and replaces the history scan with the durable row.

import { randomUUID } from 'crypto';
import db from './db';

export type PendingQuestionStatus = 'asked' | 'answered' | 'expired';

export interface PendingQuestion {
  id: string;
  conversation_id: string;
  bot_id: string;
  question: string;
  task_message_id: string | null;
  task_content: string | null;
  question_message_id: string | null;
  answer_message_id: string | null;
  answer: string | null;
  status: PendingQuestionStatus;
  created_at: number;
  resolved_at: number | null;
}

function rowToPending(row: Record<string, unknown>): PendingQuestion {
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    bot_id: String(row.bot_id),
    question: String(row.question),
    task_message_id: (row.task_message_id as string | null) ?? null,
    task_content: (row.task_content as string | null) ?? null,
    question_message_id: (row.question_message_id as string | null) ?? null,
    answer_message_id: (row.answer_message_id as string | null) ?? null,
    answer: (row.answer as string | null) ?? null,
    status: row.status as PendingQuestionStatus,
    created_at: Number(row.created_at),
    resolved_at: (row.resolved_at as number | null) ?? null,
  };
}

// Creates an asked row. A bot holds at most one asked row per conversation:
// asking again supersedes (expires) its prior asked row, so a re-ask never
// leaves two live questions for the same bot.
export function createPendingQuestion(args: {
  conversationId: string;
  botId: string;
  question: string;
  taskMessageId?: string | null;
  taskContent?: string | null;
  questionMessageId?: string | null;
}): PendingQuestion {
  const question = args.question.trim();
  if (!question) throw new Error('question is required');
  const now = Date.now();
  const created = db.transaction(() => {
    db.prepare(
      "UPDATE pending_questions SET status = 'expired', resolved_at = ? WHERE conversation_id = ? AND bot_id = ? AND status = 'asked'"
    ).run(now, args.conversationId, args.botId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO pending_questions
        (id, conversation_id, bot_id, question, task_message_id, task_content, question_message_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'asked', ?)`
    ).run(
      id,
      args.conversationId,
      args.botId,
      question,
      args.taskMessageId ?? null,
      args.taskContent ?? null,
      args.questionMessageId ?? null,
      now
    );
    return getById(id) as PendingQuestion;
  })();
  return created;
}

export function getById(id: string): PendingQuestion | undefined {
  const row = db.prepare('SELECT * FROM pending_questions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPending(row) : undefined;
}

export function listForConversation(conversationId: string): PendingQuestion[] {
  const rows = db.prepare(
    'SELECT * FROM pending_questions WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToPending);
}

export function listAskedForConversation(conversationId: string): PendingQuestion[] {
  const rows = db.prepare(
    "SELECT * FROM pending_questions WHERE conversation_id = ? AND status = 'asked' ORDER BY created_at ASC, rowid ASC"
  ).all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToPending);
}

export function pendingForBot(conversationId: string, botId: string): PendingQuestion | undefined {
  const row = db.prepare(
    "SELECT * FROM pending_questions WHERE conversation_id = ? AND bot_id = ? AND status = 'asked' ORDER BY created_at DESC LIMIT 1"
  ).get(conversationId, botId) as Record<string, unknown> | undefined;
  return row ? rowToPending(row) : undefined;
}

export function setQuestionMessage(id: string, questionMessageId: string): void {
  db.prepare('UPDATE pending_questions SET question_message_id = ? WHERE id = ?').run(
    questionMessageId,
    id
  );
}

// Compare-and-swap asked -> answered. Returns false when the row was already
// resolved, so exactly one resume wins a racing double-process.
export function resolveQuestion(
  id: string,
  answerMessageId: string,
  answer: string
): PendingQuestion | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  const now = Date.now();
  const result = db.prepare(
    `UPDATE pending_questions SET status = 'answered', answer_message_id = ?, answer = ?, resolved_at = ?
     WHERE id = ? AND status = 'asked'`
  ).run(answerMessageId, trimmed, now, id);
  if (result.changes !== 1) return null;
  return getById(id) ?? null;
}

// Compare-and-swap asked -> expired. Answered rows are never expired.
export function expireQuestion(id: string): boolean {
  const result = db.prepare(
    "UPDATE pending_questions SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'asked'"
  ).run(Date.now(), id);
  return result.changes === 1;
}

// Stop path: every asked row in the thread expires. Returns the count.
export function clearForConversation(conversationId: string): number {
  const result = db.prepare(
    "UPDATE pending_questions SET status = 'expired', resolved_at = ? WHERE conversation_id = ? AND status = 'asked'"
  ).run(Date.now(), conversationId);
  return Number(result.changes);
}

// Duplicate guard: the answered row that already consumed this user message
// as its answer, if any. A retried launch with the same latest user message
// sees this and stays silent instead of resuming twice.
export function findAnsweredByAnswer(
  conversationId: string,
  botId: string,
  answerMessageId: string
): PendingQuestion | undefined {
  const row = db.prepare(
    "SELECT * FROM pending_questions WHERE conversation_id = ? AND bot_id = ? AND answer_message_id = ? AND status = 'answered' ORDER BY created_at DESC LIMIT 1"
  ).get(conversationId, botId, answerMessageId) as Record<string, unknown> | undefined;
  return row ? rowToPending(row) : undefined;
}

export function findByTask(
  conversationId: string,
  botId: string,
  taskMessageId: string
): PendingQuestion | undefined {
  const row = db.prepare(
    'SELECT * FROM pending_questions WHERE conversation_id = ? AND bot_id = ? AND task_message_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(conversationId, botId, taskMessageId) as Record<string, unknown> | undefined;
  return row ? rowToPending(row) : undefined;
}

// Routing helper for the messages route and tests: when a thread holds asked
// rows, only those bots resume on the next user message. Null means no
// pending state, so routing stays exactly as before.
export function resumeBotIdsForConversation(conversationId: string): string[] | null {
  const asked = listAskedForConversation(conversationId);
  if (asked.length === 0) return null;
  return [...new Set(asked.map(row => row.bot_id))];
}

// Structured ask marker emitted by the model. Accepted forms:
// - a line starting with [ASK] (case-insensitive): "[ASK] which city?"
// - an inline tag: "<ask>which city?</ask>"
// Returns the question text, or null when the reply carries no marker.
// Plain prose mentioning "ask" never matches: the brackets are required.
export function parseAskMarker(modelReply: string): string | null {
  if (!modelReply) return null;
  const tag = modelReply.match(/<ask>\s*([\s\S]*?)\s*<\/ask>/i);
  if (tag) {
    const question = tag[1].trim();
    return question || null;
  }
  for (const line of modelReply.split(/\r?\n/)) {
    const match = line.match(/^\s*\[ask\]\s*(.+?)\s*$/i);
    if (match) {
      const question = match[1].trim();
      if (question) return question;
    }
  }
  return null;
}

function cleanQuestion(raw: string): string | null {
  let question = raw.trim().replace(/\s+/g, ' ');
  // Drop a wrapping em-dash pair from "ask me first — q — then wait".
  question = question.replace(/^—\s*/, '').replace(/\s*—\s*$/, '').trim();
  // Drop a trailing wait clause that leaked past the capture.
  question = question.replace(/\s*,?\s*(?:then|and)\s+wait(?:\s+for\s+my\s+answer)?\s*[.!]?\s*$/i, '').trim();
  if (!question) return null;
  return question;
}

// A user's request to ask first. Generalised: the message must name asking
// and waiting, and the question is captured from the phrasing. Accepts the
// snapshot shape ("ask me one question: <q> then wait") plus paraphrases such
// as "please ask me this first and wait: <q>" and
// "ask me first — <q> — then wait for my answer". Normal messages (no ask,
// no wait, or neither a question nor a colon phrase) return null.
export function parseAskRequest(userContent: string): string | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  if (!/\bask\b/i.test(text)) return null;
  if (!/\bwait\b/i.test(text)) return null;

  const colonThenWait = text.match(/ask\b[^:—]*[:—]\s*(.+?)\s*(?:then|and)\s+wait\b/is);
  if (colonThenWait) {
    const cleaned = cleanQuestion(colonThenWait[1] || '');
    if (cleaned) return cleaned;
  }

  const askThenWait = text.match(/ask\b(.+?)\bthen\s+wait\b/is);
  if (askThenWait) {
    let inner = (askThenWait[1] || '').trim();
    inner = inner
      .replace(/^me\b\s*/i, '')
      .replace(/^(?:this|that|one|a)\b\s*/i, '')
      .replace(/^(?:question|thing)\b\s*/i, '')
      .replace(/^first\b\s*/i, '')
      .replace(/^[:—,\-\s]+/, '')
      .trim();
    const cleaned = cleanQuestion(inner);
    if (cleaned && cleaned.length >= 2) return cleaned;
  }

  const firstThenWait = text.match(/first\b\s*[:—]?\s*(.+?)\s*(?:then|and)\s+wait\b/is);
  if (firstThenWait) {
    const cleaned = cleanQuestion(firstThenWait[1] || '');
    if (cleaned) return cleaned;
  }

  return null;
}

// Resume context injected into the resumed model turn. Carries the original
// task alongside the answer so the bot continues the task it parked.
export function resumePrompt(args: {
  question: string;
  answer: string;
  taskContent: string | null;
}): string {
  const task = (args.taskContent || '').trim();
  const lines = [
    '[ask-resume] The person answered your parked question. Continue the original task using the answer exactly once.',
    `Question: ${args.question.trim()}`,
    `Answer: ${args.answer.trim()}`,
  ];
  if (task) lines.push(`Original task: ${task}`);
  lines.push('Reply with the continued task result. Do not ask the question again.');
  return lines.join('\n');
}
