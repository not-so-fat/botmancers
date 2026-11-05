#!/usr/bin/env node
// NOT-552 exact-HEAD browser proof. Start the real Next.js app with
// scripts/seed-agent-slack-fixture.js first. This script drives the Overview
// entry, lifecycle filters/details, keyboard focus, and revoke confirmation
// at desktop and narrow viewports without live Slack credentials.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const BASE = arg('--url', 'http://127.0.0.1:43552');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const VIEWPORTS = [{ name: 'desktop-1440x900', width: 1440, height: 900, mobile: false }, { name: 'narrow-390x800', width: 390, height: 800, mobile: true }];
const checks = []; const screenshots = []; let failures = 0;
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-slack-proof-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
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
  const evaluate = async expression => { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const waitFor = async (expression, attempts = 300) => { for (let i = 0; i < attempts; i++) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100); } return false; };
  const click = expression => evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const shot = async (name, viewport) => {
    await sleep(250);
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    const file = path.join(OUT, `${viewport.name}-${name}.png`); fs.writeFileSync(file, png);
    screenshots.push({ file, viewport: `${viewport.width}x${viewport.height}`, sha256: crypto.createHash('sha256').update(png).digest('hex') });
  };
  const agents = await (await fetch(`${BASE}/api/bots`)).json();
  const forge = (Array.isArray(agents) ? agents : agents.bots).find(agent => agent.name === 'Forge');
  if (!forge) throw new Error('Forge is not in the seeded app');

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await cdp.send('Page.navigate', { url: `${BASE}/agents/${encodeURIComponent(forge.id)}` });
    check(await waitFor("document.querySelector('[data-agent-overview]')"), `${viewport.name}: Agent Overview loaded`);
    await click(byText('a', 'Share through Slack'));
    check(await waitFor("location.pathname.endsWith('/slack') && document.querySelector('[data-agent-slack-page]') && document.querySelectorAll('[data-share-status]').length === 6"), `${viewport.name}: Overview entry opens Slack with all six lifecycle states`);
    const state = await evaluate(`(() => { const root = document.querySelector('[data-agent-slack-page]'); return { text: root.innerText, statuses: [...root.querySelectorAll('[data-share-status]')].map(el => el.dataset.shareStatus), overflow: document.documentElement.scrollWidth > innerWidth + 1, scout: root.innerText.includes('Scout') }; })()`);
    check(['active','answering','recovering','exhausted','expired','revoked'].every(status => state.statuses.includes(status)), `${viewport.name}: every share lifecycle status is scannable`);
    check(/one optional Slack relay/.test(state.text) && /does not have a separate Slack app/.test(state.text) && /Shared session threads/.test(state.text), `${viewport.name}: relay and Agent shares are explicitly distinct`);
    check(!state.scout && !/SECRET|xox[ab]-|\/Users\//.test(state.text), `${viewport.name}: no other Agent or secret-bearing field is rendered`);
    check(!state.overflow, `${viewport.name}: no horizontal viewport overflow`);
    await shot('all-states', viewport);

    await click("document.querySelector('[data-share-status] .agent-slack-details summary')");
    check(await waitFor("document.querySelector('[data-share-status] .agent-slack-details[open]')"), `${viewport.name}: progressive details open`);
    const detail = await evaluate("document.querySelector('.agent-slack-share-details').innerText");
    check(/Owning session/.test(detail) && /Posted thread/.test(detail) && /Creation path/.test(detail) && /Ask only · exact session/.test(detail), `${viewport.name}: detail hierarchy names safe authority and navigation context`);
    await shot('details', viewport);

    await click(byText('.agent-slack-filters button', 'Revoked'));
    check(await waitFor(`document.querySelectorAll('[data-share-status]').length === 1 && document.querySelector('[data-share-status="revoked"]')`), `${viewport.name}: state filter reloads the owner list`);
    await click(byText('.agent-slack-filters button', 'All states'));
    check(await waitFor("document.querySelectorAll('[data-share-status]').length === 6"), `${viewport.name}: all-state filter restores the page`);
    await click(byText('button', 'Refresh'));
    check(await waitFor("document.querySelectorAll('[data-share-status]').length === 6 && ![...document.querySelectorAll('button')].some(b => b.textContent === 'Refreshing…')"), `${viewport.name}: manual refresh completes deterministically`);

    await evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
    let reached = false; let visible = false;
    for (let i = 0; i < 100 && !reached; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      const focus = await evaluate(`(() => { const el = document.activeElement; if (!(el instanceof HTMLElement)) return {}; const target = el.matches('.agent-slack-refresh, .agent-slack-filters button, .agent-slack-details summary, .agent-slack-revoke, .agent-slack a'); return { target, visible: target && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none' }; })()`);
      reached = focus.target; visible = focus.visible;
    }
    check(reached && visible, `${viewport.name}: keyboard traversal reaches a visibly focused Slack control`);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/agents/${encodeURIComponent(forge.id)}/slack` });
  await waitFor(`document.querySelector('[data-share-status="active"] [data-share-action="revoke"]')`);
  await click(`document.querySelector('[data-share-status="active"] [data-share-action="revoke"]')`);
  check(await waitFor(`document.querySelector('[data-share-action="confirm-revoke"]')`), 'desktop: revoke requires explicit confirmation');
  check(/next Slack question/.test(await evaluate("document.querySelector('.agent-slack-confirm').innerText")), 'desktop: confirmation explains the next-thread behavior');
  await shot('revoke-confirmation', VIEWPORTS[0]);
  await click(byText('.agent-slack-confirm button', 'Keep it'));
  check(await waitFor("document.activeElement?.dataset.shareAction === 'revoke'"), 'desktop: cancel returns focus to Revoke');
  await click(`document.querySelector('[data-share-status="active"] [data-share-action="revoke"]')`);
  await click(`document.querySelector('[data-share-action="confirm-revoke"]')`);
  check(await waitFor(`document.querySelectorAll('[data-share-status="revoked"]').length === 2`), 'desktop: confirmed revoke refreshes to the idempotent owner result');

  cdp.close(); browser.proc.kill(); fs.rmSync(browser.profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'agent-slack-proof-receipt.json'), JSON.stringify({ head: HEAD, app: `${BASE} real Next.js app, deterministic fixture, no live Slack workspace and no network mocks`, checks, screenshots }, null, 2));
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exit(1); });
