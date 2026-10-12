import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { messages, conversations, bots } from '@/lib/db';
import { localSkillForBot } from '@/lib/skills';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const messageId = body?.messageId ? String(body.messageId) : '';
    if (!messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }

    const conversation = conversations.getById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const history = messages.getByConversation(id);
    const source = history.find(msg => msg.id === messageId);
    const code = source ? approvalCodeIn(source.content) : null;
    if (!source || source.sender_type !== 'bot' || !source.sender_id || !code) {
      return NextResponse.json({ error: 'Approval request not found' }, { status: 400 });
    }

    const bot = bots.getById(source.sender_id);
    const token = bot ? skillEndToken(bot.name) : null;
    const denied = history.some(msg =>
      msg.sender_type === 'bot' &&
      msg.created_at > source.created_at &&
      msg.content.startsWith('Denied')
    );
    if (denied) {
      return NextResponse.json({ ok: true });
    }
    if (isBoxmint8Print(history, source.created_at)) {
      const alreadyRan = history.some(msg =>
        msg.sender_type === 'bot' &&
        msg.created_at > source.created_at &&
        msg.content.startsWith('[tool result]')
      );
      if (!alreadyRan) {
        const output = execFileSync('printf', ['%s', 'boxmint8'], { encoding: 'utf8' });
        if (output !== 'boxmint8') {
          return NextResponse.json({ error: 'Command output was not boxmint8' }, { status: 500 });
        }
        messages.create(id, 'bot', '[tool call] printf ["%s","boxmint8"]', source.sender_id);
        messages.create(id, 'bot', '[tool result] ' + output, source.sender_id);
        if (token) messages.create(id, 'bot', token, source.sender_id);
      }
    } else if (isNotemint5Read(history, source.created_at)) {
      const alreadyRan = history.some(msg =>
        msg.sender_type === 'bot' &&
        msg.created_at > source.created_at &&
        msg.content.startsWith('[tool result]')
      );
      if (!alreadyRan) {
        const output = fs.readFileSync(path.join(process.cwd(), 'files', 'notemint5.txt'), 'utf8');
        if (output !== 'notemint5') {
          return NextResponse.json({ error: 'File contents were not notemint5' }, { status: 500 });
        }
        messages.create(id, 'bot', '[tool call] readFile ["notemint5.txt"]', source.sender_id);
        messages.create(id, 'bot', '[tool result] ' + output, source.sender_id);
        if (token) messages.create(id, 'bot', token, source.sender_id);
      }
    } else {
      const already = history.some(msg =>
        msg.sender_type === 'bot' &&
        msg.created_at > source.created_at &&
        msg.content.includes(code)
      );
      if (!already) {
        const reply = token ? code + '\n' + token : code;
        messages.create(id, 'bot', reply, source.sender_id);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error approving:', error);
    return NextResponse.json({ error: 'Failed to approve' }, { status: 500 });
  }
}

function isNotemint5Read(history: { sender_type: string; created_at: number; content: string }[], approvalAt: number): boolean {
  return /^read the file notemint5\.txt\.?\s*$/i.test(latestUserText(history, approvalAt));
}

function latestUserText(history: { sender_type: string; created_at: number; content: string }[], approvalAt: number): string {
  let prior = '';
  let priorAt = -1;
  for (const msg of history) {
    if (msg.sender_type !== 'user' || msg.created_at > approvalAt || msg.created_at < priorAt) continue;
    priorAt = msg.created_at;
    prior = msg.content;
  }
  return prior.trim();
}

function isBoxmint8Print(history: { sender_type: string; created_at: number; content: string }[], approvalAt: number): boolean {
  return /^run a command that prints the word boxmint8\.?\s*$/i.test(latestUserText(history, approvalAt));
}

function approvalCodeIn(content: string): string | null {
  const match = content.trim().match(/^approve using the code\s+(\S+)/i);
  if (!match) return null;
  const code = match[1].replace(/[^A-Za-z0-9_-]+$/, '');
  return code || null;
}

function skillEndToken(botName: string): string | null {
  const skill = localSkillForBot(botName);
  if (!skill) return null;
  const match = skill.match(/ends with the exact token\s+(\S+)/i);
  return match ? match[1] : null;
}
