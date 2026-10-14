#!/usr/bin/env node
// NOT-449: real-browser proof that a missing Hermes configuration renders as
// application status, not as something the agent said. Against a running
// Botmancers started WITHOUT HERMES_API_SERVER_KEY, it creates a Hermes agent
// through the real POST /api/bots, sends a real message from the composer so
// the real turn posts the stored missing-config failure, then drives headless
// Chrome over the DevTools protocol at desktop and narrow sizes:
// - the thread shows a status callout (role=status) with no agent name, not
//   a .msg-bot card, and the accessibility tree announces it as a status;
// - primary copy is short; the exact stored diagnostic opens under Details
//   and the Copy control puts it on the clipboard;
// - the roster preview reads "Hermes needs configuration", never the
//   bracketed sentinel;
// - the conversation API still reads back the exact stored text, in order.
// No dependencies beyond Node 22+ (global WebSocket) and a local Chrome.
//
// Usage: env -u HERMES_API_SERVER_KEY BOTMANCERS_DB_PATH=.temporal/proof.db npx next dev -p 43219   (other shell)
//        node scripts/ui-runtime-failure-proof.js [--url http://127.0.0.1:43219] [--out .agent-dealer-visual-qa]
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
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SENTINEL = '[Hermes configuration missing: HERMES_API_SERVER_KEY is not set. Set it to enable persistent Hermes turns. No fallback transport attempted.]';
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

async function api(method, url, body) {
  const res = await fetch(`${URL_BASE}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return { proc, profile, wsUrl: page.webSocketDebuggerUrl, browserWsUrl: browser.webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise(resolve => {
    ws.onopen = () => resolve({ send, close: () => ws.close() });
  });
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const name = `Chief-${Date.now().toString(36)}`;
  const created = await api('POST', '/api/bots', { name, agent: 'hermes', deck_id: 'planner' });
  const bot = created;
  console.log(`agent ${name} (${bot.id}) agent=${bot.agent} deck=${bot.deck_id}`);

  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  const browser = await connect(chrome.browserWsUrl);
  await browser.send('Browser.grantPermissions', { origin: new URL(URL_BASE).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Accessibility.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expression, label, ms = 30000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(200);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const rowByName = `[...document.querySelectorAll('.bot-row, .card')].find(node => node.querySelector('.bot-name')?.textContent.trim() === ${JSON.stringify(name)})`;
  const shot = async (vp, state) => {
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  screenshot ${file}`);
  };
  const threadState = () => evaluate(`(() => {
    const notice = document.querySelector('.messages .runtime-failure');
    const details = notice?.querySelector('details');
    const row = ${rowByName};
    return {
      notice: !!notice,
      role: notice?.getAttribute('role') || null,
      kind: notice?.dataset.runtimeFailure || null,
      insideBotCard: !!notice?.closest('.msg-bot'),
      speakerInWrapper: !!notice?.parentElement?.querySelector('.msg-name'),
      title: notice?.querySelector('.runtime-failure-title')?.textContent.replace(/\\s+/g, ' ').trim() || null,
      recovery: notice?.querySelector('.runtime-failure-recovery')?.innerText.trim() || null,
      detailsOpen: !!details?.open,
      detailVisible: !!notice?.querySelector('.runtime-failure-detail')?.checkVisibility(),
      detailText: notice?.querySelector('.runtime-failure-detail')?.textContent || null,
      copyLabel: notice?.querySelector('.runtime-failure-copy')?.textContent || null,
      botCardsWithSentinel: [...document.querySelectorAll('.msg-bot')].filter(n => n.textContent.includes('Hermes configuration missing')).length,
      userMessages: [...document.querySelectorAll('.msg-you .msg-body')].map(n => n.textContent.trim()),
      preview: row?.querySelector('.bot-preview')?.textContent.trim() ?? null,
    };
  })()`);

  for (const [index, vp] of VIEWPORTS.entries()) {
    console.log(`\n${vp.name}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor(rowByName, 'agent in roster');
    await evaluate(`${rowByName}.click()`);
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(name)}`, 'agent thread');

    if (index === 0) {
      // The real turn: send from the composer; the server posts the stored failure.
      await evaluate(`document.querySelector('.composer textarea').focus()`);
      await cdp.send('Input.insertText', { text: 'hello chief' });
      await evaluate(`document.querySelector('.send-btn').click()`);
    }
    // The creation turn already failed once; wait for the reply to the send.
    await waitFor(`document.querySelector('.messages .msg-you') && document.querySelectorAll('.messages .runtime-failure').length >= 2`, 'runtime failure status after the user message');
    await waitFor(`${rowByName}?.querySelector('.bot-preview')`, 'roster preview');
    let s = await threadState();
    console.log(`  collapsed: ${JSON.stringify(s)}`);
    check(s.role === 'status' && s.kind === 'hermes-config-missing', 'thread: the failure is a role=status callout classified as missing Hermes configuration');
    check(!s.insideBotCard && !s.speakerInWrapper && s.botCardsWithSentinel === 0, 'thread: no bot card or agent name carries the failure');
    check(s.title === 'ErrorHermes needs configuration' && !!s.recovery && !s.recovery.includes('[') && !s.recovery.includes('HERMES_API_SERVER_KEY'), 'thread: concise severity + title + recovery copy, no raw sentinel');
    check(!s.detailsOpen && !s.detailVisible, 'thread: the raw diagnostic stays collapsed until asked for');
    check(s.userMessages.includes('hello chief'), 'thread: the user message renders as before');
    check(s.preview === 'Hermes needs configuration' && !/[[\]]|HERMES_API_SERVER_KEY/.test(s.preview), 'roster: short stable status preview, no bracketed sentinel');

    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const status = nodes.find(n => n.role?.value === 'status' && !n.ignored);
    const statusTree = status ? nodes.filter(n => n === status || (status.childIds || []).includes(n.nodeId) || n.parentId === status.nodeId)
      .map(n => ({ role: n.role?.value, name: n.name?.value })) : [];
    console.log(`  a11y status subtree: ${JSON.stringify(statusTree)}`);
    check(!!status && /^error hermes needs configuration$/i.test(status.name?.value || ''), 'a11y: the accessibility tree exposes a status named by its severity and title');
    if (index === 0) fs.writeFileSync(path.join(OUT, 'a11y-status-node.json'), JSON.stringify({ status, statusTree }, null, 2));
    await shot(vp, 'status');

    await evaluate(`document.querySelector('.messages .runtime-failure summary').click()`);
    await waitFor(`document.querySelector('.messages .runtime-failure details').open`, 'details open');
    await evaluate(`document.querySelector('.messages .runtime-failure-copy').click()`);
    await waitFor(`document.querySelector('.messages .runtime-failure-copy').textContent !== 'Copy details'`, 'copy result');
    s = await threadState();
    const clip = await evaluate(`navigator.clipboard.readText().catch(e => 'clipboard error: ' + e.message)`);
    console.log(`  expanded: detailVisible=${s.detailVisible} copyLabel=${JSON.stringify(s.copyLabel)} clipboard=${JSON.stringify(clip)}`);
    check(s.detailsOpen && s.detailVisible && s.detailText === SENTINEL, 'details: "Details" reveals the exact stored diagnostic');
    check(s.copyLabel === 'Copied' && clip === SENTINEL, 'copy: "Copy details" puts the exact diagnostic on the clipboard');
    await shot(vp, 'details');
  }

  const conversation = await api('GET', `/api/conversations?botId=${encodeURIComponent(bot.id)}`);
  const stored = await api('GET', `/api/conversations/${conversation.id}/messages`);
  console.log(`\nread-back: ${JSON.stringify(stored.map(m => [m.sender_type, m.content]))}`);
  // The agent's creation turn also hits the missing key, so a failure row
  // precedes the user's message; the reply to it follows in order.
  const userAt = stored.findIndex(m => m.sender_type === 'user' && m.content === 'hello chief');
  check(userAt >= 0 && stored.slice(userAt + 1).some(m => m.sender_type === 'bot' && m.sender_id === bot.id && m.content === SENTINEL),
    'history: the user message is stored, followed by the exact failure text as the agent row');
  const rendered = await evaluate(`document.querySelectorAll('.messages .msg-you, .messages .msg-bot, .messages .msg-status').length`);
  check(rendered === stored.length, `thread: renders exactly the ${stored.length} stored messages in place`);

  cdp.close();
  browser.close();
  chrome.proc.kill();
  console.log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error('runtime-failure proof crashed:', error);
  process.exit(1);
});
