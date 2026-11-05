#!/usr/bin/env node
// NOT-551 exact-HEAD real-app proof. Seed with seed-agent-conversations-fixture.js,
// serve that DB, then run this script. No route or network mocks are used.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
const BASE = arg('--url', 'http://127.0.0.1:43551');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const FIXTURE = JSON.parse(fs.readFileSync(arg('--fixture', '.temporal/agent-conversations-fixture.json'), 'utf8'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const VIEWPORTS = [{ name: 'desktop-1440x900', width: 1440, height: 900, mobile: false }, { name: 'narrow-390x800', width: 390, height: 800, mobile: true }];
const checks = []; const screenshots = []; let failures = 0;
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-conversations-proof-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let index = 0; index < 100 && !fs.existsSync(portFile); index++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, profile, ws: targets.find(target => target.type === 'page').webSocketDebuggerUrl };
}

async function connect(url) {
  const ws = new WebSocket(url); let next = 1; const pending = new Map();
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (!pending.has(msg.id)) return; const item = pending.get(msg.id); pending.delete(msg.id); msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result); };
  await new Promise(resolve => { ws.onopen = resolve; });
  return { send: (method, params = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }), close: () => ws.close() };
}

async function main() {
  if (DIRTY) throw new Error(`tracked changes invalidate exact-HEAD proof:\n${DIRTY}`);
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch(); const cdp = await connect(browser.ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const evaluate = async expression => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async expression => { for (let index = 0; index < 150; index++) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100); } return false; };
  const shot = async (viewport, state) => { const data = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data; const png = Buffer.from(data, 'base64'); const file = path.join(OUT, `${viewport.name}-${state}.png`); fs.writeFileSync(file, png); screenshots.push({ file, viewport: `${viewport.width}x${viewport.height}`, sha256: crypto.createHash('sha256').update(png).digest('hex') }); };

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await cdp.send('Page.navigate', { url: `${BASE}/agents/${FIXTURE.agentId}/conversations` });
    check(await waitFor("document.querySelectorAll('.conversation-list li').length === 4"), `${viewport.name}: all direct, group, Agent, and Slack-origin rows load`);
    const list = await evaluate(`({ text: document.body.innerText, overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
    check(['Ada conversation','Group Release room','Agent conversation','Service slack:C_RELEASES','Origin:','87 messages'].every(value => list.text.includes(value)), `${viewport.name}: participant, origin, type, and count hierarchy is recognizable`);
    check(!list.overflow, `${viewport.name}: list has no viewport overflow`);
    await shot(viewport, 'list');

    await cdp.send('Page.navigate', { url: `${BASE}/agents/${FIXTURE.agentId}/conversations/${FIXTURE.directId}` });
    check(await waitFor("document.querySelector('[data-conversation-writable=\"true\"]') && document.querySelector('.conversation-composer')"), `${viewport.name}: direct history is writable`);
    const writable = await evaluate(`(() => { const list = document.querySelector('.conversation-message-list'); const input = document.querySelector('.conversation-composer textarea'); return { long: list.scrollHeight > list.clientHeight, composer: !!input, focus: document.activeElement === input, cards: document.body.innerText.includes('New Email') && document.body.innerText.includes('Approve') && document.body.innerText.includes('Download release-report.txt') }; })()`);
    check(writable.long && writable.composer && writable.cards, `${viewport.name}: long scrolling history keeps drafts, approvals, artifacts, and composer`);
    check(writable.focus, `${viewport.name}: writable composer receives keyboard focus`);
    await shot(viewport, 'writable-detail');

    await cdp.send('Page.navigate', { url: `${BASE}/agents/${FIXTURE.agentId}/conversations/${FIXTURE.externalId}` });
    check(await waitFor("document.querySelector('[data-conversation-writable=\"false\"]')"), `${viewport.name}: external history loads read-only`);
    const readonly = await evaluate(`({ composer: !!document.querySelector('.conversation-composer'), explanation: document.body.innerText.includes('Read-only history') && document.body.innerText.includes('external service'), overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
    check(!readonly.composer && readonly.explanation, `${viewport.name}: read-only state has no composer and explains why`);
    check(!readonly.overflow, `${viewport.name}: read-only detail has no viewport overflow`);
    await shot(viewport, 'readonly-detail');
  }
  cdp.close(); browser.proc.kill(); fs.rmSync(browser.profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'agent-conversations-proof-receipt.json'), JSON.stringify({ head: HEAD, app: `${BASE} real Next.js app, seeded canonical DB, no mocks`, checks, screenshots }, null, 2));
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exit(1); });
