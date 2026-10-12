// Approval engine (NOT-416): one general mechanism for bot actions that need
// the owner's okay before they run.
//
// A request stores { id, conversation_id, bot_id, code, action_type,
// action_args, status pending/approved/denied/executed }. The thread card keeps
// the snapshot text `Approve using the code <code>`; Approve runs the pending
// action exactly once, Deny cancels it, and both are recorded and shown.
//
// Only registered, allowlisted actions run: unknown action types are rejected,
// never executed. The pending action never runs until approved.
//
// Server-only: this module uses node imports (fs, child_process). The client
// thread UI keeps parsing codes with lib/draft.

import { randomBytes, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import db, { bots, messages } from './db';
import { isSafeFileName, parseApprovalCode } from './draft';
import { localSkillForBot } from './skills';

export type ApprovalActionType = 'read_file' | 'run_command' | 'send_draft';

export const APPROVAL_ACTION_TYPES: readonly ApprovalActionType[] = [
  'read_file',
  'run_command',
  'send_draft',
];

export function isApprovalActionType(value: unknown): value is ApprovalActionType {
  return (
    typeof value === 'string' &&
    (APPROVAL_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export type ApprovalRequestStatus = 'pending' | 'approved' | 'denied' | 'executed';

export interface ApprovalRequest {
  id: string;
  conversation_id: string;
  bot_id: string | null;
  code: string;
  action_type: string | null;
  action_args: Record<string, unknown> | null;
  message_id: string | null;
  status: ApprovalRequestStatus;
  result: string | null;
  created_at: number;
  resolved_at: number | null;
}

export const APPROVAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function rowToRequest(row: Record<string, unknown>): ApprovalRequest {
  let args: Record<string, unknown> | null = null;
  if (typeof row.action_args === 'string' && row.action_args) {
    try {
      const parsed: unknown = JSON.parse(row.action_args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = null;
    }
  }
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    bot_id: (row.bot_id as string | null) ?? null,
    code: String(row.code),
    action_type: (row.action_type as string | null) ?? null,
    action_args: args,
    message_id: (row.message_id as string | null) ?? null,
    status: row.status as ApprovalRequestStatus,
    result: (row.result as string | null) ?? null,
    created_at: Number(row.created_at),
    resolved_at: (row.resolved_at as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

export interface ApprovalActionContext {
  conversationId: string;
  botId: string | null;
}

export interface ApprovalActionResult {
  ok: boolean;
  lines: string[];
  result: string;
}

export class ApprovalActionRefused extends Error {}

function refused(reason: string): never {
  throw new ApprovalActionRefused(reason);
}

function readFileArgs(args: Record<string, unknown> | null): string {
  const name = args?.name;
  if (typeof name !== 'string' || !name) refused('read_file needs a file name');
  if (!isSafeFileName(name)) refused(`refused: unsafe file name ${JSON.stringify(name)}`);
  const root = path.resolve(process.cwd(), 'files');
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) {
    refused(`refused: path traversal in ${JSON.stringify(name)}`);
  }
  return name;
}

const PRINT_WORD_PATTERN = /^[A-Za-z0-9_-]+$/;

function runCommandArgs(args: Record<string, unknown> | null): string {
  // Stub allowlist until the command-runs ticket wires the full registry:
  // exactly `printf %s <word>`, no shell, one safe word.
  if (args?.command !== undefined && args.command !== 'printf') {
    refused('refused: command not allowlisted');
  }
  if (args?.format !== undefined && args.format !== '%s') {
    refused('refused: command not allowlisted');
  }
  const word = args?.word;
  if (typeof word !== 'string' || !PRINT_WORD_PATTERN.test(word) || word.length > 64) {
    refused('refused: command not allowlisted');
  }
  return word;
}

function sendDraftArgs(args: Record<string, unknown> | null): {
  recipient: string;
  body: string;
} {
  const recipient = args?.recipient;
  const body = args?.body;
  if (typeof recipient !== 'string' || !recipient.trim()) {
    refused('send_draft needs a recipient');
  }
  if (typeof body !== 'string' || !body.trim()) refused('send_draft needs a body');
  if (args?.channel !== undefined && args.channel !== 'email' && args.channel !== 'slack') {
    refused('send_draft channel must be email or slack');
  }
  return { recipient: recipient.trim(), body: body.trim() };
}

export interface ApprovalActionHandler {
  validate: (args: Record<string, unknown> | null) => void;
  run: (args: Record<string, unknown> | null, ctx: ApprovalActionContext) => ApprovalActionResult;
}

export const APPROVAL_ACTIONS: Record<ApprovalActionType, ApprovalActionHandler> = {
  read_file: {
    validate: args => {
      readFileArgs(args);
    },
    run: (args) => {
      const name = readFileArgs(args);
      const filePath = path.join(path.resolve(process.cwd(), 'files'), name);
      const contents = fs.readFileSync(filePath, 'utf8');
      return {
        ok: true,
        lines: [
          `[tool call] readFile ${JSON.stringify([name])}`,
          `[tool result] ${contents}`,
        ],
        result: contents,
      };
    },
  },
  run_command: {
    validate: args => {
      runCommandArgs(args);
    },
    run: (args) => {
      const word = runCommandArgs(args);
      const output = execFileSync('printf', ['%s', word], { encoding: 'utf8' });
      return {
        ok: true,
        lines: [
          `[tool call] printf ${JSON.stringify(['%s', word])}`,
          `[tool result] ${output}`,
        ],
        result: output,
      };
    },
  },
  send_draft: {
    validate: args => {
      sendDraftArgs(args);
    },
    run: (args) => {
      // Recorded in the thread only; sending real external messages stays out
      // of scope (non-goal).
      const { recipient, body } = sendDraftArgs(args);
      const line = `[Sent to ${recipient}] ${body}`;
      return { ok: true, lines: [line], result: line };
    },
  },
};

// ---------------------------------------------------------------------------
// Request store
// ---------------------------------------------------------------------------

export function getApprovalByCode(
  conversationId: string,
  code: string
): ApprovalRequest | undefined {
  const row = db
    .prepare('SELECT * FROM approval_requests WHERE conversation_id = ? AND code = ?')
    .get(conversationId, code) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : undefined;
}

export function getApprovalByMessage(messageId: string): ApprovalRequest | undefined {
  const row = db
    .prepare('SELECT * FROM approval_requests WHERE message_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(messageId) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : undefined;
}

export function listApprovals(conversationId: string): ApprovalRequest[] {
  const rows = db
    .prepare(
      'SELECT * FROM approval_requests WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
    )
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToRequest);
}

// Creates a pending request. Unknown action types and invalid args are
// rejected (throw); nothing is ever stored for them. Re-creating the same
// (conversation, code) returns the existing row, so a retried ask never
// double-stores.
export function createApprovalRequest(args: {
  conversationId: string;
  botId?: string | null;
  code: string;
  actionType?: string | null;
  actionArgs?: Record<string, unknown> | null;
  messageId?: string | null;
}): ApprovalRequest {
  const code = (args.code || '').trim();
  if (!APPROVAL_CODE_PATTERN.test(code)) throw new Error('approval code is required');
  const actionType = args.actionType ?? null;
  const actionArgs = args.actionArgs ?? null;
  if (actionType !== null) {
    if (!isApprovalActionType(actionType)) {
      throw new ApprovalActionRefused(`refused: unknown action type ${JSON.stringify(actionType)}`);
    }
    APPROVAL_ACTIONS[actionType].validate(actionArgs);
  }
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO approval_requests
      (id, conversation_id, bot_id, code, action_type, action_args, message_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    randomUUID(),
    args.conversationId,
    args.botId ?? null,
    code,
    actionType,
    actionArgs ? JSON.stringify(actionArgs) : null,
    args.messageId ?? null,
    now
  );
  const row = getApprovalByCode(args.conversationId, code);
  if (!row) throw new Error('failed to store approval request');
  return row;
}

export function setApprovalMessage(conversationId: string, code: string, messageId: string): void {
  db.prepare(
    'UPDATE approval_requests SET message_id = ? WHERE conversation_id = ? AND code = ?'
  ).run(messageId, conversationId, code);
}

// Minted codes for gated actions (the plain code ask carries the user's own
// code). Sanitized to the approval-code alphabet.
export function mintApprovalCode(prefix: string): string {
  const slug =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16) || 'gate';
  return `${slug}-${randomBytes(2).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Decide: approve executes once, deny cancels, repeats are no-ops
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approve' | 'deny';

export interface ApprovalOutcome {
  status: ApprovalRequestStatus;
  code: string;
  ran: boolean;
  already: boolean;
  refused?: string;
}

export function skillEndToken(botName: string | null | undefined): string | null {
  if (!botName) return null;
  const skill = localSkillForBot(botName);
  if (!skill) return null;
  const match = skill.match(/ends with the exact token\s+(\S+)/i);
  return match ? match[1] : null;
}

function endTokenFor(botId: string | null): string | null {
  if (!botId) return null;
  const bot = bots.getById(botId);
  return skillEndToken(bot?.name);
}

function postAs(request: ApprovalRequest, content: string): void {
  messages.create(
    request.conversation_id,
    'bot',
    content,
    request.bot_id ?? undefined
  );
}

// Resolves one pending request. Approve with an action runs that action
// exactly once (compare-and-swap pending -> approved -> executed); approve
// without an action records approved; deny records denied with `Denied ...`
// and runs nothing. Any decision on a resolved request is a no-op returning
// the stored status. Unknown action types and invalid args are refused: the
// row stays pending and nothing is posted or run.
export function decideApproval(
  conversationId: string,
  code: string,
  decision: ApprovalDecision
): ApprovalOutcome {
  const request = getApprovalByCode(conversationId, code);
  if (!request) throw new Error('Approval request not found');
  if (request.status !== 'pending') {
    return { status: request.status, code, ran: false, already: true };
  }

  if (decision === 'deny') {
    const updated = db.prepare(
      "UPDATE approval_requests SET status = 'denied', resolved_at = ? WHERE conversation_id = ? AND code = ? AND status = 'pending'"
    ).run(Date.now(), conversationId, code);
    if (Number(updated.changes) !== 1) {
      const current = getApprovalByCode(conversationId, code);
      return { status: current?.status ?? 'denied', code, ran: false, already: true };
    }
    postAs(request, `Denied ${code}`);
    const token = endTokenFor(request.bot_id);
    if (token) postAs(request, token);
    return { status: 'denied', code, ran: false, already: false };
  }

  // Approve: validate before flipping any state, so a refused action leaves
  // the row pending and posts nothing.
  if (request.action_type !== null && !isApprovalActionType(request.action_type)) {
    return {
      status: 'pending',
      code,
      ran: false,
      already: false,
      refused: `refused: unknown action type ${JSON.stringify(request.action_type)}`,
    };
  }
  if (request.action_type !== null) {
    try {
      APPROVAL_ACTIONS[request.action_type].validate(request.action_args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'pending', code, ran: false, already: false, refused: reason };
    }
  }

  const claimed = db.prepare(
    "UPDATE approval_requests SET status = 'approved', resolved_at = ? WHERE conversation_id = ? AND code = ? AND status = 'pending'"
  ).run(Date.now(), conversationId, code);
  if (Number(claimed.changes) !== 1) {
    const current = getApprovalByCode(conversationId, code);
    return { status: current?.status ?? 'approved', code, ran: false, already: true };
  }

  // Plain approval: no action to run, approved is terminal.
  if (request.action_type === null) {
    const token = endTokenFor(request.bot_id);
    postAs(request, token ? `${code}\n${token}` : code);
    return { status: 'approved', code, ran: false, already: false };
  }

  let outcome: ApprovalActionResult;
  try {
    outcome = APPROVAL_ACTIONS[request.action_type].run(request.action_args, {
      conversationId,
      botId: request.bot_id,
    });
  } catch (error) {
    // The action ran exactly once and failed: record the failure like a
    // result so a repeat approve stays a no-op instead of retrying.
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { ok: false, lines: [`[tool result] Error: ${detail}`], result: `Error: ${detail}` };
  }
  for (const line of outcome.lines) postAs(request, line);
  const token = endTokenFor(request.bot_id);
  if (token) postAs(request, token);
  db.prepare(
    'UPDATE approval_requests SET status = ?, result = ? WHERE conversation_id = ? AND code = ?'
  ).run('executed', outcome.result, conversationId, code);
  return { status: 'executed', code, ran: outcome.ok, already: false };
}

// ---------------------------------------------------------------------------
// Instruction parsing (generalised snapshot shapes, not keyword triggers)
// ---------------------------------------------------------------------------

// The thread card text, kept byte-for-byte for compatibility.
export function approvalCardText(code: string): string {
  return `Approve using the code ${code}`;
}

function cleanCode(raw: string): string | null {
  const code = raw.replace(/^[`"'"]+|[`"'"]+$/g, '').replace(/[^A-Za-z0-9_-]+$/, '');
  return APPROVAL_CODE_PATTERN.test(code) ? code : null;
}

// A user's instruction to be asked for approval by a code, then wait.
// Snapshot shape ("ask me to approve using the code X then wait") plus
// paraphrases ("please ask me to approve with the code Y and wait"). The
// message must name asking, approving, a code, and waiting; anything else
// (including bare "approve this") returns null.
export function parseApprovalAsk(userContent: string): string | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  if (!/\bask\b/i.test(text)) return null;
  if (!/\bapprov(?:e|al)\b/i.test(text)) return null;
  if (!/\bcode\b/i.test(text)) return null;
  if (!/\bwait\b/i.test(text)) return null;
  const match = text.match(/code\s*:?\s*[`"'"]?([A-Za-z0-9][A-Za-z0-9_.-]*)[`"'"]?/i);
  if (!match) return null;
  return cleanCode(match[1]);
}

// A gated file read: snapshot shape ("read the file <name>") plus paraphrases
// ("please show me the contents of <name>"). The name is captured as written;
// the registry validates it, so traversal names parse here and are refused
// there, never executed.
export function parseGatedFileRead(userContent: string): { name: string } | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  const match = text.match(
    /^(?:please\s+|could you\s+)?(read|open|cat|display|show)\s+(?:me\s+)?(?:the\s+)?(?:file\s+|contents\s+of\s+(?:the\s+)?(?:file\s+)?)(\S+?)\s*(?:for me\s*)?[.?!]?\s*$/i
  );
  if (!match) return null;
  // The verb alone is not a file read ("read my mind", "show restraint"):
  // the shape above requires the file/contents phrase.
  const name = match[2]
    .replace(/^[`"'"]+|[`"'"]+$/g, '')
    .replace(/[.?!]+$/, '');
  if (!name) return null;
  return { name };
}

// A gated command: snapshot shape ("run a command that prints the word <word>")
// plus paraphrases ("please execute a command to print the word <word>").
// Anything without the full run-command-print-word shape returns null, so
// open-ended "run ..." asks never become actions.
export function parseGatedCommand(userContent: string): { word: string } | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  const match = text.match(
    /^(?:please\s+)?(run|execute)\s+(?:a\s+)?command\s+(?:that\s+prints|to\s+print|printing)\s+(?:the\s+)?word\s+([A-Za-z0-9_-]+)\s*[.?!]?\s*$/i
  );
  if (!match) return null;
  return { word: match[2] };
}

export interface ModelApprovalAsk {
  code: string;
  actionType: ApprovalActionType | null;
  actionArgs: Record<string, unknown> | null;
}

// A bot (model) reply raising an approval request: prose containing
// `approve using the code <code>`, optionally with a structured action line
// `[approval-action] {"type": "read_file", "name": "..."}` carrying the gated
// action. An unknown type or malformed args drops the action (plain code
// request); unknown types are never executed.
export function parseApprovalMarker(modelReply: string): ModelApprovalAsk | null {
  const code = parseApprovalCode(modelReply || '');
  if (!code || !APPROVAL_CODE_PATTERN.test(code)) return null;
  const marker = (modelReply || '').match(/\[approval-action\]\s*(\{[\s\S]*?\})\s*(?:\r?\n|$)/i);
  if (!marker) return { code, actionType: null, actionArgs: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(marker[1]);
  } catch {
    return { code, actionType: null, actionArgs: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { code, actionType: null, actionArgs: null };
  }
  const row = parsed as Record<string, unknown>;
  if (!isApprovalActionType(row.type)) {
    return { code, actionType: null, actionArgs: null };
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'type') rest[key] = value;
  }
  try {
    APPROVAL_ACTIONS[row.type].validate(rest);
  } catch {
    return { code, actionType: null, actionArgs: null };
  }
  return { code, actionType: row.type, actionArgs: rest };
}

// Raises a pending request from a user's instruction in a direct thread:
// a gated file read, a gated command, or a plain approve-by-code ask (in
// that order; the first matching shape wins). Returns false when the message
// is not an approval ask. A refused ask (path traversal, invalid args)
// returns true with nothing raised and nothing run. Retries never repost:
// when a card for a live request already follows the user message, the ask
// is consumed silently.
export function raiseApprovalFromUserInstruction(args: {
  conversationId: string;
  botId: string;
  botName: string;
  userMessage: { content: string; created_at: number };
  thread: Array<{
    sender_type: string;
    sender_id?: string | null;
    content: string;
    created_at: number;
  }>;
}): boolean {
  const { conversationId, botId, botName, userMessage, thread } = args;
  const fileRead = parseGatedFileRead(userMessage.content);
  const command = fileRead ? null : parseGatedCommand(userMessage.content);
  const plainCode = fileRead || command ? null : parseApprovalAsk(userMessage.content);
  if (!fileRead && !command && !plainCode) return false;

  const alreadyRaised = thread.some(
    msg =>
      msg.sender_type === 'bot' &&
      msg.sender_id === botId &&
      msg.created_at > userMessage.created_at &&
      (() => {
        const code = parseApprovalCode(msg.content);
        return !!code && !!getApprovalByCode(conversationId, code);
      })()
  );
  if (alreadyRaised) return true;

  let code: string;
  let actionType: ApprovalActionType | null;
  let actionArgs: Record<string, unknown> | null;
  if (fileRead) {
    code = freshCode(conversationId, `read-${fileRead.name}`);
    actionType = 'read_file';
    actionArgs = { name: fileRead.name };
  } else if (command) {
    code = freshCode(conversationId, `run-${command.word}`);
    actionType = 'run_command';
    actionArgs = { command: 'printf', format: '%s', word: command.word };
  } else {
    code = plainCode as string;
    actionType = null;
    actionArgs = null;
  }

  try {
    createApprovalRequest({
      conversationId,
      botId,
      code,
      actionType,
      actionArgs,
    });
  } catch (error) {
    // Refused (traversal, invalid args): raise nothing, run nothing.
    if (error instanceof ApprovalActionRefused) return true;
    throw error;
  }
  const token = skillEndToken(botName);
  const card = token ? `${approvalCardText(code)}\n${token}` : approvalCardText(code);
  const posted = messages.create(conversationId, 'bot', card, botId);
  setApprovalMessage(conversationId, code, posted.id);
  return true;
}

function freshCode(conversationId: string, prefix: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = mintApprovalCode(prefix);
    if (!getApprovalByCode(conversationId, code)) return code;
  }
  return mintApprovalCode(`${prefix}-${Date.now().toString(36)}`);
}

// Records a model reply's approval ask as a pending request (idempotent per
// conversation+code). Replies without a code are untouched.
export function recordModelApproval(
  conversationId: string,
  message: { id: string; sender_id?: string | null; content: string }
): ApprovalRequest | null {
  const ask = parseApprovalMarker(message.content);
  if (!ask) return null;
  const row = createApprovalRequest({
    conversationId,
    botId: message.sender_id ?? null,
    code: ask.code,
    actionType: ask.actionType,
    actionArgs: ask.actionArgs,
    messageId: message.id,
  });
  if (!row.message_id) setApprovalMessage(conversationId, ask.code, message.id);
  return row;
}
