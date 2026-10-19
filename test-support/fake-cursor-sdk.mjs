// NOT-505: a fake Cursor SDK module for the capability-gated fallback
// (lib/cursor-session-provider SDK_RUNNER). It shares the fake CLI's state
// directory ($FAKE_CURSOR_STATE) and logs calls as sdk_* ops. Agent.list
// exists only when FAKE_CURSOR_SDK_LIST=1. Unlike the CLI, resuming an
// unknown chat throws.
import fs from 'fs';
import path from 'path';

const dir = process.env.FAKE_CURSOR_STATE;
const chatsPath = path.join(dir, 'chats.json');
const load = () => (fs.existsSync(chatsPath) ? JSON.parse(fs.readFileSync(chatsPath, 'utf8')) : { counter: 0, chats: {} });
const save = state => fs.writeFileSync(chatsPath, JSON.stringify(state, null, 2));
const log = entry => fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ ...entry, cwd: process.cwd(), correlation: process.env.BOTMANCERS_CORRELATION || null })}\n`);

export const version = '0.9.0-fake';

export const Agent = {
  async create({ cwd }) {
    log({ op: 'sdk_create', workspace: cwd });
    const state = load();
    state.counter += 1;
    const id = `fake-sdk-chat-${state.counter}-SECRET`;
    state.chats[id] = { cwd, title: null, created_at: Date.now(), updated_at: Date.now(), history: [] };
    save(state);
    return { id };
  },
  async resume(id, { cwd, mode }) {
    log({ op: 'sdk_resume', resume: id, workspace: cwd, mode });
    if (!load().chats[id]) throw new Error('no such chat');
    return {
      async *stream(prompt) {
        yield { type: 'system', subtype: 'init', cwd, session_id: id };
        if (prompt.includes('[hold]')) {
          await new Promise(() => setInterval(() => {}, 1000));
        }
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `fake sdk reply: ${prompt}` }] }, session_id: id };
        yield { type: 'result', subtype: 'success', is_error: false, result: `fake sdk reply: ${prompt}`, session_id: id, usage: { inputTokens: 11, outputTokens: 3 } };
      },
    };
  },
  ...(process.env.FAKE_CURSOR_SDK_LIST === '1' ? {
    async list() {
      log({ op: 'sdk_list' });
      return Object.entries(load().chats).map(([id, chat]) => ({ id, cwd: chat.cwd, title: chat.title, createdAt: chat.created_at, updatedAt: chat.updated_at }));
    },
  } : {}),
};
