#!/usr/bin/env node
// NOT-553 exact-HEAD real-app proof. Seed with
// scripts/seed-agent-activity-fixture.js and start this worktree's app first.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const BASE = arg('--url', 'http://127.0.0.1:43553');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const VIEWPORTS = [{ name: 'desktop-1440x900', width: 1440, height: 900, mobile: false }, { name: 'narrow-390x800', width: 390, height: 800, mobile: true }];
const checks = []; const screenshots = []; let failures = 0;
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-activity-proof-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, profile, ws: targets.find(target => target.type === 'page').webSocketDebuggerUrl };
}
async function connect(url) {
  const ws = new WebSocket(url); let next = 1; const pending = new Map();
  ws.onmessage = event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return; pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); };
  await new Promise(resolve => { ws.onopen = resolve; });
  return { send: (method, params = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }), close: () => ws.close() };
}

async function main() {
  if (DIRTY) throw new Error(`tracked worktree changes invalidate exact-HEAD proof:\n${DIRTY}`);
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchChrome(); const cdp = await connect(browser.ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const evaluate = async expression => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async expression => { for (let i = 0; i < 200; i++) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100); } return false; };
  const byText = (selector, value) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(value)})`;
  const click = expression => evaluate(`(() => { const el=${expression}; if(!el)return false; el.click(); return true; })()`);
  const shot = async (name, viewport) => { const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'); const file = path.join(OUT, `${viewport.name}-${name}.png`); fs.writeFileSync(file, png); screenshots.push({ file, viewport: `${viewport.width}x${viewport.height}`, sha256: crypto.createHash('sha256').update(png).digest('hex') }); };
  const agents = await (await fetch(`${BASE}/api/bots`)).json();
  const forge = (Array.isArray(agents) ? agents : agents.bots).find(agent => agent.name === 'Forge');
  if (!forge) throw new Error('Forge is not in the seeded app');

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await cdp.send('Page.navigate', { url: `${BASE}/agents/${encodeURIComponent(forge.id)}` });
    check(await waitFor("document.querySelector('[data-agent-overview]')"), `${viewport.name}: Overview remains the default`);
    check(await waitFor("document.querySelector('.agent-activity-list.is-compact')"), `${viewport.name}: Overview uses the shared recent projection`);
    await click(byText('a', 'View activity'));
    check(await waitFor("document.querySelector('[data-agent-activity-page]')"), `${viewport.name}: Activity opens under the Agent shell`);
    const state = await evaluate(`(() => ({ open: !!document.querySelector('.agent-activity-details[open]'), rows: document.querySelectorAll('.agent-activity-item').length, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.querySelector('[data-agent-activity-page]').innerText }))()`);
    check(state.rows >= 5 && !state.open, `${viewport.name}: readable timeline and raw detail collapsed`);
    check(!state.overflow && !/private-provider|xox[ab]-|\/Users\//.test(state.text), `${viewport.name}: narrow-safe and protected data absent`);
    await shot('timeline', viewport);
    await click("document.querySelector('.agent-activity-details summary')");
    check(await waitFor("document.querySelector('.agent-activity-details[open]')"), `${viewport.name}: safe Raw details disclosure opens`);
    await click(byText('.agent-activity-filters button', 'Errors'));
    check(await waitFor("document.querySelectorAll('.agent-activity-item').length > 0 && [...document.querySelectorAll('.agent-activity-item')].every(el => el.classList.contains('is-error'))"), `${viewport.name}: Errors filter is deterministic`);
    await shot('errors', viewport);
    await evaluate('document.activeElement?.blur()');
    let focused = false;
    for (let i = 0; i < 80 && !focused; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      focused = await evaluate("document.activeElement?.matches('.agent-activity button, .agent-activity a, .agent-activity summary') && document.activeElement.matches(':focus-visible')");
    }
    check(focused, `${viewport.name}: keyboard reaches a visible Activity control`);
  }
  cdp.close(); browser.proc.kill(); fs.rmSync(browser.profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'agent-activity-proof-receipt.json'), JSON.stringify({ head: HEAD, app: `${BASE} real Next.js app with deterministic canonical fixture`, checks, screenshots }, null, 2));
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exit(1); });
