#!/usr/bin/env node
// NOT-475: real-browser proof that Wake safety outcomes are visible and
// actionable in the owner's thread. --seed writes an isolated database with
// a coordinator (Tank) whose reply asks for edit work from Dev and from
// Builder (both blocked on the owner's grant), plus a conversation chain
// Tank -> Helper -> Reviewer -> Codex whose next hop passes the depth limit
// (rejected). Against Botmancers started on that database, the drive mode
// opens Tank's thread in headless Chrome at desktop and mobile sizes:
// - both blocked Wakes show as status notices with Allow / Deny, the
//   rejected Wake shows with no actions;
// - clicking Allow on Dev's Wake shows it allowed (no actions left);
// - clicking Deny on Builder's Wake shows it denied (no actions left);
// - the Wake rows read back allowed/denied through the API.
// Agents are Hermes with no HERMES_API_SERVER_KEY, so the allowed turn
// stops at the stored missing-configuration failure; nothing external runs.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/wake-notice.db node scripts/ui-wake-notice-proof.js --seed
//        env -u HERMES_API_SERVER_KEY BOTMANCERS_DB_PATH=.temporal/wake-notice.db npx next dev -H 127.0.0.1 -p 43219   (other shell)
//        node scripts/ui-wake-notice-proof.js [--url http://127.0.0.1:43219] [--out .agent-dealer-visual-qa]
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
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];

function seed() {
  const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'wake-notice.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': path.join(__dirname, '..') } });
  const db = jiti('../lib/db.ts');
  const router = jiti('../lib/wake-router.ts');
  const intake = jiti('../lib/conversation-intake.ts');
  const { bots, conversations, messages, UI_OWNER_PRINCIPAL } = db;
  router.setWakeAvailabilityProbe(() => ({ available: true }));

  const agent = name => bots.create({ deck_id: `deck-${name.toLowerCase()}`, name, title: name, description: name, agent: 'hermes' });
  const tank = agent('Tank');
  agent('Dev');
  agent('Builder');
  const helper = agent('Helper');
  const reviewer = agent('Reviewer');
  const codex = agent('Codex');
  const conversation = conversations.getByBotId(tank.id);
  const content = 'Ship notifications: have Dev implement it and Builder package it.';
  const turn = intake.acceptConversationMessage({
    surface: 'ui', requester: UI_OWNER_PRINCIPAL, idempotencyKey: 'seed-owner-1', conversation: { id: conversation.id },
    content, fingerprint: { content, target: tank.id }, route: () => ({ deliveries: [{ agentId: tank.id }] }), dispatch: () => {},
  }).requests[0];
  const block = envelope => '```botmancers-wake\n' + JSON.stringify(envelope) + '\n```';
  const reply = messages.create(conversation.id, 'bot', [
    'Routing the work.',
    block({ version: 1, target: 'Dev', executionKind: 'implementation', objective: 'Implement notifications.' }),
    block({ version: 1, target: 'Builder', executionKind: 'implementation', objective: 'Package the release.' }),
    block({ version: 1, target: 'Helper', executionKind: 'conversation', objective: 'Ask Reviewer.' }),
  ].join('\n'), tank.id);
  const routed = router.routeAgentWakes({ sourceEventId: reply.id, parentRequestId: turn.id });
  // Each hop's reply wakes the next; the fourth hop is past depth 3.
  let parent = routed[2].request;
  for (const [sender, target] of [[helper, 'Reviewer'], [reviewer, 'Codex'], [codex, 'Tank']]) {
    const hop = messages.create(conversation.id, 'bot', block({ version: 1, target, executionKind: 'conversation', objective: 'Pass it on.' }), sender.id);
    const next = router.routeAgentWakes({ sourceEventId: hop.id, parentRequestId: parent.id });
    routed.push(...next);
    parent = next[0].request;
  }
  for (const entry of routed) console.log(`wake ${entry.wake.id} -> ${entry.wake.requested_target}: ${entry.wake.status}/${entry.wake.reason_code}`);
  console.log(`seeded ${DB_PATH}`);
}

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
  return ok;
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
  return { proc, wsUrl: page.webSocketDebuggerUrl };
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

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

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
  const noticeFor = (target, tone) => `[...document.querySelectorAll('.messages [data-wake-notice${tone ? `="${tone}"` : ''}]')].filter(n => n.textContent.includes(${JSON.stringify(target)}))`;
  const notices = () => evaluate(`[...document.querySelectorAll('.messages [data-wake-notice]')].map(n => ({
    tone: n.dataset.wakeNotice, role: n.getAttribute('role'), text: n.querySelector('.wake-notice-line').textContent.replace(/\\s+/g, ' ').trim(),
    buttons: [...n.querySelectorAll('button')].map(b => b.textContent.trim()), inBotCard: !!n.closest('.msg-bot'),
    fits: n.getBoundingClientRect().right <= window.innerWidth + 0.5,
  }))`);
  const shot = async (vp, state) => {
    await evaluate(`(() => { const last = [...document.querySelectorAll('.messages [data-wake-notice]')].pop(); last?.scrollIntoView({ block: 'end' }); })()`);
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  screenshot ${file}`);
  };
  const openTank = async vp => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor(`document.querySelector('[data-open-bot]')`, 'roster');
    await evaluate(`[...document.querySelectorAll('[data-open-bot]')].find(b => b.textContent.trim() === 'Tank').click()`);
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Tank'`, 'Tank thread');
    await waitFor(`document.querySelectorAll('.messages [data-wake-notice]').length >= 3`, 'Wake notices');
  };

  console.log('\nblocked');
  for (const vp of VIEWPORTS) {
    console.log(vp.name);
    await openTank(vp);
    const list = await notices();
    console.log(`  ${JSON.stringify(list)}`);
    const dev = list.find(n => n.text.includes('Dev'));
    const builder = list.find(n => n.text.includes('Builder'));
    const deep = list.find(n => n.tone === 'rejected');
    check(dev?.tone === 'blocked' && dev.buttons.join(',') === 'Allow,Deny' && /needs your approval for edit work/.test(dev.text), 'Dev Wake blocked with Allow / Deny');
    check(builder?.tone === 'blocked' && builder.buttons.join(',') === 'Allow,Deny', 'Builder Wake blocked with Allow / Deny');
    check(!!deep && /depth limit 3 reached/.test(deep.text) && deep.buttons.length === 0, 'over-depth Wake rejected, no actions');
    check(list.every(n => n.role === 'status' && !n.inBotCard && n.fits), 'notices are status rows outside bot cards, within the viewport');
    await shot(vp, 'blocked');
  }

  console.log('\nallow Dev');
  await openTank(VIEWPORTS[0]);
  await evaluate(`${noticeFor('Dev', 'blocked')}[0].querySelector('button').click()`);
  await waitFor(`${noticeFor('Dev', 'allowed')}.length === 1`, 'Dev allowed');
  for (const vp of VIEWPORTS) {
    console.log(vp.name);
    await openTank(vp);
    await waitFor(`${noticeFor('Dev', 'allowed')}.length === 1`, 'Dev allowed');
    const list = await notices();
    console.log(`  ${JSON.stringify(list)}`);
    check(list.filter(n => n.text.includes('Dev')).every(n => n.buttons.length === 0), 'Dev: no actions left after Allow');
    check(list.find(n => n.text.includes('Builder') && n.tone === 'blocked')?.buttons.join(',') === 'Allow,Deny', 'Builder still pending');
    await shot(vp, 'allowed');
  }

  console.log('\ndeny Builder');
  await openTank(VIEWPORTS[0]);
  await evaluate(`[...${noticeFor('Builder', 'blocked')}[0].querySelectorAll('button')].find(b => b.textContent.trim() === 'Deny').click()`);
  await waitFor(`${noticeFor('Builder', 'denied')}.length === 1`, 'Builder denied');
  for (const vp of VIEWPORTS) {
    console.log(vp.name);
    await openTank(vp);
    await waitFor(`${noticeFor('Builder', 'denied')}.length === 1`, 'Builder denied');
    const list = await notices();
    console.log(`  ${JSON.stringify(list)}`);
    check(list.every(n => n.buttons.length === 0), 'no actions left after Allow and Deny');
    check(list.some(n => n.tone === 'denied' && /owner denied edit Wake/.test(n.text)), 'Builder shows denied');
    await shot(vp, 'denied');
  }

  cdp.close();
  chrome.proc.kill();
  console.log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv.includes('--seed')) seed();
else drive().catch(error => {
  console.error('wake notice proof crashed:', error);
  process.exit(1);
});
