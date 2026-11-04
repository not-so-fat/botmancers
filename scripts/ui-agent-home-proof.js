#!/usr/bin/env node
// NOT-549 exact-HEAD browser proof. Requires the seeded real app to already
// be listening; writes screenshots and a SHA-bound receipt under --out.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const BASE = arg('--url', 'http://127.0.0.1:43499');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const VIEWPORTS = [{ name: 'desktop-1440x900', width: 1440, height: 900, mobile: false }, { name: 'narrow-390x800', width: 390, height: 800, mobile: true }];
const checks = [];
const screenshots = [];
let failures = 0;
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-home-proof-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, profile, ws: targets.find(target => target.type === 'page').webSocketDebuggerUrl };
}

async function connect(url) {
  const ws = new WebSocket(url); let next = 1; const pending = new Map();
  ws.onmessage = event => { const msg = JSON.parse(event.data); if (!pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); };
  await new Promise(resolve => { ws.onopen = resolve; });
  return { send: (method, params = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }), close: () => ws.close() };
}

async function main() {
  if (DIRTY) throw new Error(`tracked worktree changes invalidate exact-HEAD proof:\n${DIRTY}`);
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const browser = await chrome(); const cdp = await connect(browser.ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const evaluate = async expression => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100); } return false; };
  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    check(await waitFor("location.pathname.startsWith('/agents/') && document.querySelector('[data-agent-overview]')"), `${viewport.name}: populated workspace resolves to Overview`);
    const state = await evaluate(`({ path: location.pathname, composer: !!document.querySelector('.composer, textarea[placeholder="Say something"]'), tabs: [...document.querySelectorAll('.agent-tabs a')].map(a => a.textContent.trim()), selected: document.querySelector('.agent-tabs a[aria-current="page"]')?.textContent.trim(), overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
    check(!state.composer, `${viewport.name}: no ambient composer`);
    check(state.selected === 'Overview' && ['Overview','Sessions','Conversations','Slack','Activity','Config'].every(label => state.tabs.includes(label)), `${viewport.name}: complete nav with selected-tab semantics`);
    check(!state.overflow, `${viewport.name}: no horizontal viewport overflow`);
    const focus = await evaluate(`(() => { const a = document.querySelector('.agent-tabs a'); a.focus(); const s = getComputedStyle(a); return { visible: a.matches(':focus-visible'), outline: s.outlineStyle, label: a.textContent.trim() }; })()`);
    check(focus.label === 'Overview' && focus.visible && focus.outline !== 'none', `${viewport.name}: keyboard focus is visible`);
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    const file = path.join(OUT, `${viewport.name}.png`); fs.writeFileSync(file, png);
    screenshots.push({ file, viewport: `${viewport.width}x${viewport.height}`, sha256: crypto.createHash('sha256').update(png).digest('hex') });
  }
  await cdp.send('Page.navigate', { url: `${BASE}/agents/not-a-real-agent` });
  check(await waitFor("document.body.innerText.includes('Agent not found')"), 'invalid Agent state is truthful');
  cdp.close(); browser.proc.kill(); fs.rmSync(browser.profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'agent-home-proof-receipt.json'), JSON.stringify({ head: HEAD, app: `${BASE} real Next.js app, seeded canonical DB, no mocks`, checks, screenshots }, null, 2));
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exit(1); });
