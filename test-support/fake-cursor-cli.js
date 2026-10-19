#!/usr/bin/env node
// NOT-505: a deterministic stand-in for the Cursor Agent CLI
// (`cursor-agent`), shaped after the stream-json a real 2026.10.16 CLI
// prints (see test-support/cursor-stream-fixtures). State lives in
// $FAKE_CURSOR_STATE/chats.json; every invocation is appended to
// $FAKE_CURSOR_STATE/calls.jsonl so tests can count process calls.
//
// Variants ($FAKE_CURSOR_VARIANT): listless (default; `ls` is an
// interactive picker, like the real CLI), listing (`ls --output-format
// json`), broken (`--version` fails: no usable CLI).
//
// Like the real CLI, `--resume <unknown id>` silently starts a fresh chat
// under that id; the fake records it as op 'fresh_on_resume' so tests can
// prove the provider never lets that happen.
//
// Prompt directives: [hold] (runs until killed), [slow] (completes after
// 800 ms), [fail] (error result), [exit] (exits 3 with no result),
// [mismatch] (init reports another chat), [usage:partial|missing|malformed|
// repeated|cost].
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_CURSOR_STATE;
const variant = process.env.FAKE_CURSOR_VARIANT || 'listless';
const chatsPath = path.join(dir, 'chats.json');
const loadChats = () => (fs.existsSync(chatsPath) ? JSON.parse(fs.readFileSync(chatsPath, 'utf8')) : { counter: 0, chats: {} });
const saveChats = state => fs.writeFileSync(chatsPath, JSON.stringify(state, null, 2));
const logCall = entry => fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ ...entry, cwd: process.cwd(), correlation: process.env.BOTMANCERS_CORRELATION || null })}\n`);
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

if (argv[0] === '--version') {
  logCall({ op: 'version' });
  if (variant === 'broken') process.exit(1);
  process.stdout.write(variant === 'listing' ? '2027.1.0-fake\n' : '2026.10.16-fake\n');
  process.exit(0);
}

if (argv[0] === 'ls' && argv[1] === '--help') {
  logCall({ op: 'ls_help' });
  process.stdout.write('Usage: agent ls [options]\n\nResume a chat session\n\nOptions:\n');
  if (variant === 'listing') process.stdout.write('  --output-format <format>  Output format: json\n');
  process.stdout.write('  -h, --help  Display help for command\n');
  process.exit(0);
}

if (argv[0] === 'ls') {
  logCall({ op: 'ls' });
  if (variant !== 'listing' || flag('--output-format') !== 'json') {
    process.stderr.write('ERROR Raw mode is not supported on the current process.stdin\n');
    process.exit(1);
  }
  const state = loadChats();
  const sessions = Object.entries(state.chats).filter(([, chat]) => !chat.deleted)
    .map(([id, chat]) => ({ id, cwd: chat.cwd, title: chat.title, createdAt: chat.created_at, updatedAt: chat.updated_at }));
  process.stdout.write(JSON.stringify({ sessions }));
  process.exit(0);
}

if (argv[0] === 'create-chat') {
  logCall({ op: 'create_chat' });
  const state = loadChats();
  state.counter += 1;
  const id = `fake-chat-${state.counter}-SECRET`;
  state.chats[id] = { cwd: process.cwd(), title: null, created_at: Date.now(), updated_at: Date.now(), history: [] };
  saveChats(state);
  process.stdout.write(`${id}\n`);
  process.exit(0);
}

if (argv.includes('--print')) {
  const id = flag('--resume');
  const prompt = argv[argv.length - 1];
  const workspace = flag('--workspace');
  logCall({ op: 'turn', resume: id, workspace, mode: flag('--mode'), force: argv.includes('--force'), format: flag('--output-format'), prompt });
  const state = loadChats();
  if (!state.chats[id]) {
    // The real CLI does this; the provider must never get here.
    logCall({ op: 'fresh_on_resume' });
    state.chats[id] = { cwd: process.cwd(), title: null, created_at: Date.now(), updated_at: Date.now(), history: [] };
  }
  state.chats[id].history.push(['user', prompt]);
  saveChats(state);
  const sid = prompt.includes('[mismatch]') ? 'another-chat-SECRET' : id;
  emit({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: workspace || process.cwd(), session_id: sid, model: 'Auto', permissionMode: 'default' });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: sid });
  const finish = () => {
    if (prompt.includes('[exit]')) {
      process.stdout.write('not json at all\n');
      process.exit(3);
    }
    const reply = `fake cursor reply: ${prompt}`;
    emit({ type: 'thinking', subtype: 'delta', text: 'Thinking', session_id: sid, timestamp_ms: Date.now() });
    emit({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'note.txt' } } }, session_id: sid, timestamp_ms: Date.now() });
    emit({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'note.txt' }, result: { success: {} } } }, session_id: sid, timestamp_ms: Date.now() });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: sid });
    let usage = { inputTokens: 100 + prompt.length, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const extra = {};
    if (prompt.includes('[usage:partial]')) usage = { inputTokens: 42 };
    if (prompt.includes('[usage:malformed]')) { usage = { inputTokens: '12', outputTokens: -3 }; extra.total_cost_usd = 'cheap'; }
    if (prompt.includes('[usage:cost]')) extra.total_cost_usd = 0.0123;
    const result = {
      type: 'result', subtype: prompt.includes('[fail]') ? 'error' : 'success', duration_ms: 10, is_error: prompt.includes('[fail]'),
      result: prompt.includes('[fail]') ? null : reply, session_id: sid, request_id: 'req-1', ...extra,
    };
    if (!prompt.includes('[usage:missing]')) result.usage = usage;
    emit(result);
    if (prompt.includes('[usage:repeated]')) emit({ ...result, usage: { inputTokens: 999999, outputTokens: 999999 } });
    const after = loadChats();
    after.chats[id].history.push(['assistant', reply]);
    after.chats[id].updated_at = Date.now();
    saveChats(after);
    process.exit(prompt.includes('[fail]') ? 1 : 0);
  };
  if (prompt.includes('[hold]')) {
    process.on('SIGTERM', () => process.exit(143));
    setInterval(() => {}, 1000);
  } else if (prompt.includes('[slow]')) setTimeout(finish, 800);
  else finish();
} else {
  logCall({ op: 'unknown', argv });
  process.exit(2);
}
