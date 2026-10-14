#!/usr/bin/env node
// NOT-454: real-browser proof of the empty agent-thread state. Adds one
// zero-message agent per viewport to a running Botmancers DB, then drives
// headless Chrome over the DevTools protocol at desktop and narrow sizes:
// - selecting the agent shows the empty note naming it above the composer;
// - while the messages read is held, the thread shows loading, not empty;
// - when the read fails, the thread shows the failure alert, not empty;
// - once reads succeed again the empty note returns, and sending the first
//   real message removes it; the conversation API reads back exactly that
//   message (nothing synthetic stored).
// No dependencies beyond Node 22+ (global WebSocket) and a local Chrome.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm start   (other shell)
//        BOTMANCERS_DB_PATH=.temporal/design-fixture.db node scripts/ui-empty-thread-proof.js \
//          [--url http://127.0.0.1:43123] [--out .agent-dealer-visual-qa]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:43123');
const OUT = arg('--out', '.agent-dealer-visual-qa');
process.env.BOTMANCERS_DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'design-fixture.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
  return ok;
}

function freshAgent(viewport) {
  const { createJiti } = require('jiti');
  const db = createJiti(__filename)('../lib/db.ts');
  const name = `Juniper-${viewport.width}-${Date.now().toString(36)}`;
  const bot = db.bots.create({ name, title: '', description: '' });
  return { bot, conversationId: db.conversations.getByBotId(bot.id).id };
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-proof-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  return { proc, profile, wsUrl: page.webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise(resolve => {
    ws.onopen = () => resolve({ send, on: fn => listeners.push(fn), close: () => ws.close() });
  });
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  const held = [];
  cdp.on(msg => {
    if (msg.method === 'Fetch.requestPaused') held.push(msg.params.requestId);
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expression, label, ms = 10000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const rowByName = name => `[...document.querySelectorAll('.bot-row, .card')].find(node => node.querySelector('.bot-name')?.textContent.trim() === ${JSON.stringify(name)})`;
  const threadState = () => evaluate(`(() => ({
    name: document.querySelector('.thread-name')?.textContent.trim(),
    empty: document.querySelector('.thread-empty')?.innerText.replace(/\\s+/g, ' ').trim() || null,
    status: document.querySelector('.messages [role=status]')?.textContent.trim() || null,
    alert: document.querySelector('.messages [role=alert]')?.textContent.trim() || null,
    messages: document.querySelectorAll('.msg-you, .msg-bot').length,
    placeholder: document.querySelector('.composer textarea')?.getAttribute('placeholder'),
    emptyControls: document.querySelectorAll('.thread-empty button, .thread-empty input, .thread-empty a, .thread-empty textarea').length,
    emptyAboveComposer: (() => {
      const e = document.querySelector('.thread-empty-hint');
      const c = document.querySelector('.composer');
      return !!e && !!c && e.getBoundingClientRect().bottom <= c.getBoundingClientRect().top;
    })(),
  }))()`);
  const shot = async (vp, state) => {
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  screenshot ${file}`);
  };
  const readBack = async conversationId => (await fetch(`${URL_BASE}/api/conversations/${conversationId}/messages`)).json();

  for (const vp of VIEWPORTS) {
    const { bot, conversationId } = freshAgent(vp);
    console.log(`\n${vp.name} (agent ${bot.name})`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor(rowByName(bot.name), 'new agent in roster');

    // Empty: a successful zero-message read.
    await evaluate(`${rowByName(bot.name)}.click()`);
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(bot.name)} && document.querySelector('.thread-empty')`, 'empty state');
    let s = await threadState();
    console.log(`  empty: ${JSON.stringify(s)}`);
    check(s.empty === `No messages with ${bot.name} yet. Say something below to start the conversation.`, 'empty state names the selected agent and points to the composer');
    check(s.placeholder === 'Say something' && s.emptyAboveComposer, 'copy sits above the unchanged "Say something" composer');
    check(s.emptyControls === 0 && !/group/i.test(s.empty), 'empty state has no controls and no group wording');
    check((await readBack(conversationId)).length === 0, 'API reads back zero stored messages after viewing');
    await shot(vp, 'empty');

    // Loading: hold every messages read for this thread.
    held.length = 0;
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/conversations/${conversationId}/messages*`, requestStage: 'Request' }] });
    await cdp.send('Page.reload');
    await waitFor(rowByName(bot.name), 'roster after reload');
    await evaluate(`${rowByName(bot.name)}.click()`);
    await waitFor(`document.querySelector('.messages [role=status]')`, 'loading note');
    s = await threadState();
    console.log(`  loading: ${JSON.stringify(s)}`);
    check(s.status === 'Loading messages…' && s.empty === null && s.alert === null, 'held read shows loading, not empty');
    await shot(vp, 'loading');

    // Error: fail the held reads.
    for (const requestId of held.splice(0)) await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    await waitFor(`document.querySelector('.messages [role=alert]')`, 'error alert');
    for (const requestId of held.splice(0)) await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    s = await threadState();
    console.log(`  error: ${JSON.stringify(s)}`);
    check(s.alert === 'Couldn’t load messages. Trying again…' && s.empty === null && s.status === null, 'failed read shows the failure alert, not empty');
    await shot(vp, 'error');

    // Recovery: reads succeed again, the poll restores the empty state.
    await cdp.send('Fetch.disable');
    for (const requestId of held.splice(0)) await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    await waitFor(`document.querySelector('.thread-empty')`, 'empty state after recovery');
    check((await threadState()).alert === null, 'recovered read clears the failure alert');

    // First message: the real composer send removes the state.
    const text = `first real message ${vp.name}`;
    await evaluate(`document.querySelector('.composer textarea').focus()`);
    await cdp.send('Input.insertText', { text });
    await evaluate(`document.querySelector('.send-btn').click()`);
    await waitFor(`document.querySelector('.msg-you')`, 'first message in thread');
    s = await threadState();
    console.log(`  first-message: ${JSON.stringify(s)}`);
    check(s.empty === null && s.status === null && s.alert === null && s.messages === 1, 'first real message replaces the empty state');
    const stored = await readBack(conversationId);
    console.log(`  read-back: ${JSON.stringify(stored.map(m => [m.sender_type, m.content]))}`);
    check(stored.length === 1 && stored[0].sender_type === 'user' && stored[0].content === text, 'API reads back exactly the one real message (no synthetic entry)');
    await shot(vp, 'first-message');
  }

  cdp.close();
  chrome.proc.kill();
  console.log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error('empty-thread proof crashed:', error);
  process.exit(1);
});
