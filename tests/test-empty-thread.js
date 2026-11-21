#!/usr/bin/env node
// NOT-454: intentional empty agent-thread state.
//
// Proves, without a browser:
// (1) a selected zero-message agent renders one short note naming that agent
//     and pointing to the existing "Say something" composer;
// (2) loading (no read yet, read in flight, a read for another thread) and a
//     failed read render their own feedback and never the empty state;
// (3) the state is gone once the first real user or agent message exists,
//     and reading an empty thread through the real UI routes stores nothing:
//     the conversation API reads back exactly the real messages;
// (4) the empty markup carries no controls, suggested prompts, provider
//     setup copy, or group terminology, and app/page.tsx renders it from the
//     thread-state view rather than from a synthetic message.
// Components render through react-dom/server against an isolated SQLite
// file. No dev server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-empty-thread-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const db = jiti('../lib/db.ts');
const state = jiti('../lib/thread-state.ts');
const ThreadState = jiti('../app/components/ThreadState.tsx').default;
const conversationRoute = jiti('../app/api/conversations/route.ts');
const messagesRoute = jiti('../app/api/conversations/[id]/messages/route.ts');

let failures = 0;
function assert(condition, label) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures++;
  return condition;
}

const render = (view, agentName) => renderToStaticMarkup(React.createElement(ThreadState, { view, agentName }));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function readMessages(conversationId) {
  const res = await messagesRoute.GET(
    new Request(`http://ui.test/api/conversations/${conversationId}/messages`),
    { params: Promise.resolve({ id: conversationId }) }
  );
  return { status: res.status, json: await res.json() };
}

async function main() {
  const bot = db.bots.create({ name: 'Juniper', title: '', description: '' });
  const convRes = await conversationRoute.GET(new Request(`http://ui.test/api/conversations?botId=${bot.id}`));
  const conv = await convRes.json();
  const other = 'another-thread';

  console.log('\n(1) Selected zero-message agent');
  const first = await readMessages(conv.id);
  assert(first.status === 200 && Array.isArray(first.json) && first.json.length === 0, 'UI route reads the new agent thread back as zero messages');
  const ready = { conversationId: conv.id, status: 'ready' };
  assert(state.threadView(ready, conv.id, first.json.length) === 'empty', 'a successful zero-message read is the empty view');
  const empty = render('empty', bot.name);
  console.log(`  empty markup: ${empty}`);
  assert(text(empty) === 'No messages with Juniper yet. Say something below to start the conversation.', 'empty copy names the agent and points to the composer');
  assert(/Say something/.test(empty) && /below/.test(empty), 'copy uses the composer’s own "Say something" wording');
  assert(text(empty).length <= 90, 'copy stays concise');
  assert(text(render('empty', 'Cedar')).startsWith('No messages with Cedar yet.'), 'copy follows the selected agent');

  console.log('\n(2) Loading and failure stay distinct');
  const cases = [
    ['no read yet', null, 'loading'],
    ['read in flight', { conversationId: conv.id, status: 'loading' }, 'loading'],
    ['last read belongs to another thread', { conversationId: other, status: 'ready' }, 'loading'],
    ['another thread failed', { conversationId: other, status: 'error' }, 'loading'],
    ['this thread failed', { conversationId: conv.id, status: 'error' }, 'error'],
  ];
  for (const [label, load, expected] of cases) {
    const got = state.threadView(load, conv.id, 0);
    assert(got === expected, `${label} -> ${expected} (got ${got})`);
  }
  const loading = render('loading', bot.name);
  const failed = render('error', bot.name);
  console.log(`  loading markup: ${loading}`);
  console.log(`  error markup: ${failed}`);
  assert(/role="status"/.test(loading) && text(loading) === state.THREAD_LOADING_COPY, 'loading renders its own status line');
  assert(/role="alert"/.test(failed) && text(failed) === state.THREAD_ERROR_COPY, 'a failed read renders its own alert');
  assert(!/data-thread-empty/.test(loading + failed) && !/No messages with/.test(loading + failed), 'neither loading nor failure shows the empty state');
  assert(loading !== failed, 'loading and failure feedback differ');

  console.log('\n(3) First real message removes the state; nothing synthetic is stored');
  const storedBefore = db.messages.getByConversation(conv.id).length;
  assert(storedBefore === 0, 'reading the empty thread stored no message');
  const userMsg = db.messages.create(conv.id, 'user', 'hello');
  const afterUser = await readMessages(conv.id);
  assert(afterUser.json.length === 1 && afterUser.json[0].id === userMsg.id, 'read-back holds exactly the real user message');
  assert(state.threadView(ready, conv.id, afterUser.json.length) === 'messages', 'first user message -> messages view');
  assert(render(state.threadView(ready, conv.id, afterUser.json.length), bot.name) === '', 'messages view renders no empty note');
  assert(state.threadView({ conversationId: conv.id, status: 'error' }, conv.id, 1) === 'messages', 'a later failed poll keeps real messages on screen');

  const solo = db.bots.create({ name: 'Rowan', title: '', description: '' });
  const soloConv = db.conversations.getByBotId(solo.id);
  db.messages.create(soloConv.id, 'bot', 'I am here.', solo.id);
  const afterBot = await readMessages(soloConv.id);
  assert(afterBot.json.length === 1 && afterBot.json[0].sender_type === 'bot', 'read-back holds exactly the real agent message');
  assert(state.threadView({ conversationId: soloConv.id, status: 'ready' }, soloConv.id, afterBot.json.length) === 'messages', 'first agent message -> messages view');

  // The page's own path: send through the UI messages route, then re-read
  // the thread the way loadMessages does after a send.
  const sent = db.bots.create({ name: 'Linden', title: '', description: '' });
  const sentConv = db.conversations.getByBotId(sent.id);
  const before = await readMessages(sentConv.id);
  assert(state.threadView({ conversationId: sentConv.id, status: 'ready' }, sentConv.id, before.json.length) === 'empty', 'send path starts from the empty view');
  const post = await messagesRoute.POST(
    new Request(`http://ui.test/api/conversations/${sentConv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'empty-thread-first' },
      body: JSON.stringify({ content: 'first words' }),
    }),
    { params: Promise.resolve({ id: sentConv.id }) }
  );
  assert(post.status >= 200 && post.status < 300, `UI send route accepts the first message (status ${post.status})`);
  const reloaded = await readMessages(sentConv.id);
  console.log(`  read-back after send: ${JSON.stringify(reloaded.json.map(m => [m.sender_type, m.content]))}`);
  assert(reloaded.json[0]?.sender_type === 'user' && reloaded.json[0].content === 'first words', 'reload after send reads back the real first message first');
  assert(!reloaded.json.some(m => /No messages with|Say something below/.test(m.content)), 'no stored message carries empty-state copy');
  assert(state.threadView({ conversationId: sentConv.id, status: 'ready' }, sentConv.id, reloaded.json.length) === 'messages', 'reload after send -> messages view');

  console.log('\n(4) No workflow, suggestions, provider copy, or groups');
  assert(!/<(button|input|textarea|select|form|a)\b/.test(empty), 'empty state contains no controls or links');
  assert(!/suggest|try asking|example|workflow|template|step|onboard/i.test(empty), 'no suggested prompts, templates, or workflow copy');
  assert(!/hermes|cursor|claude|codex|muse|openai|anthropic|agent deck|api key|provider/i.test(empty), 'no provider-specific setup copy');
  assert(!/group/i.test(empty + loading + failed), 'no group terminology');
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  const component = fs.readFileSync(path.join(ROOT, 'app', 'components', 'ThreadState.tsx'), 'utf8');
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'thread-state.ts'), 'utf8');
  assert(/<ThreadState view=\{view\} agentName=\{activeConversation\.details\.name\} \/>/.test(page), 'page renders the state from the selected agent’s thread view');
  assert(/\{computerOpen \? null : threadNote\}/.test(page), 'the message column shows the note when no computer covers it');
  assert(/className=\{view === 'messages' \? 'computer-band' : 'computer-band computer-band-note'\}[^>]*>\s*\{threadNote\}/.test(page), 'with the chief-of-staff computer open, the note sits in its see-through band');
  assert(/activeIdRef\.current = conv\.id;\s*setActiveConversation\(/.test(page), 'openBot retargets the stale-read guard before the new thread commits');
  assert(/threadView\(threadLoad, activeConversation\.id, messages\.length\)/.test(page), 'page derives the view from load status and real message count');
  assert(/setThreadLoad\(\{ conversationId: id, status: ok \? 'ready' : 'error' \}\)/.test(page), 'page records failed reads instead of treating them as empty');
  assert(!/group/i.test(component + lib), 'state sources carry no group terminology');
  assert(!/messages\.create|setMessages\(\[\s*\{/.test(component + lib + page), 'no synthetic message is created or injected');
}

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(error => {
    console.error('empty-thread test crashed:', error);
    cleanup();
    process.exit(1);
  });
