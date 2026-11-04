#!/usr/bin/env node
// NOT-543: real-app proof for direct Agent registration. Drives the running
// app (default http://localhost:43123, started from this checkout with an
// isolated BOTMANCERS_HOME) in headless Chrome over CDP:
//
// 1. registers a Codex Agent through New Agent (connection, scope,
//    workspace, policy) and checks that no launch-profile or deck
//    control exists and no /api/agent-deck/* request is made;
// 2. reloads the Agent's Config page and confirms the read view, Edit,
//    and reload show the direct registration and request no deck;
// 3. captures desktop 1440x900 and mobile 390x800 screenshots.
//
// Usage: node scripts/agent-registration-proof.js [--url URL] [--out DIR]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://localhost:43123');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESKTOP = { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false };
const MOBILE = { name: 'mobile-390x800', width: 390, height: 800, mobile: true };

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
  return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-reg-proof-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  return { proc, profile, wsUrl: page.webSocketDebuggerUrl };
}

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) onEvent(msg);
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browserRequests = [];
  const chrome = await launchChrome();
  // Never leave a headless browser polling the app after a failed run.
  process.on('exit', () => chrome.proc.kill());
  const cdp = await connect(chrome.wsUrl, msg => {
    if (msg.method === 'Network.requestWillBeSent') {
      browserRequests.push(msg.params.request.url);
      if (process.env.PROOF_TRACE) console.log(`  [browser] ${new Date().toISOString()} ${msg.params.request.url} frame=${msg.params.frameId} doc=${msg.params.documentURL}`);
    }
  });
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  };
  const waitFor = async (expression, label, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(150);
    }
    check(false, `timed out waiting for ${label}`);
    return false;
  };
  const viewport = vp => cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
  const navigate = async url => {
    await cdp.send('Page.navigate', { url });
    await sleep(500);
    await waitFor('document.readyState === "complete"', `load ${url}`);
  };
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  screenshot: ${file}`);
  };
  const deckRequests = () => browserRequests.filter(url => url.includes('/api/agent-deck/'));
  const reset = () => {
    console.log(`  [reset] ${new Date().toISOString()}`);
    browserRequests.length = 0;
  };
  // React-controlled form helpers (dispatch the events React listens to).
  const helpers = `
    window.__setValue = (sel, value) => {
      const el = document.querySelector(sel);
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    };
    window.__click = sel => { document.querySelector(sel).click(); return true; };
    true;
  `;

  async function scrollDialogToEnd() {
    await evaluate('(() => { const b = document.querySelector(".new-agent-body"); b.scrollTop = b.scrollHeight; return true; })()');
    await sleep(200);
  }

  async function showAgentCard(selector = '[data-field=runtime-read]') {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('section').scrollIntoView({ block: 'start' }), true`);
    await sleep(200);
  }

  async function openNewAgent() {
    await evaluate(helpers);
    await waitFor('!!document.querySelector("button.add-btn")', 'New button');
    await evaluate('document.querySelector("button.add-btn").click(), true');
    await waitFor('!!document.querySelector("#bot-connection")', 'New Agent dialog with connections');
  }

  console.log('\n(1) Register a Codex Agent (desktop)');
  await viewport(DESKTOP);
  reset();
  await navigate(`${URL_BASE}/`);
  await openNewAgent();
  await evaluate(`__setValue('#bot-name', 'Direct Codex')`);
  await evaluate(`__setValue('#bot-connection', 'rc-local-codex')`);
  await evaluate(`__click('input[name="bot-scope"][value="workspaces"]')`);
  await waitFor('!!document.querySelector("#bot-workspaces")', 'workspace list');
  await evaluate(`__setValue('#bot-workspaces', '/Users/owner/work/botmancers')`);
  await evaluate(`__setValue('#bot-default-workspace', '/Users/owner/work/botmancers')`);
  await sleep(300);
  check(await evaluate('!document.querySelector("[data-field=launch-profile]") && !document.querySelector("[data-field=deck]") && !document.querySelector("#bot-deck") && !document.querySelector("#bot-workdir")'), 'no launch-profile or deck controls rendered');
  await shot('desktop-1440x900-new-agent-direct');
  await scrollDialogToEnd();
  await shot('desktop-1440x900-new-agent-direct-policy');
  await evaluate('document.querySelector(".new-agent-dialog button[type=submit]").click(), true');
  // NOT-547: Create shows the one-line session sync result; Done closes.
  await waitFor('!![...document.querySelectorAll(".new-agent-dialog button")].find(b => b.textContent.trim() === "Done")', 'Done after the sync line');
  await shot('desktop-1440x900-new-agent-sync-line');
  await evaluate('[...document.querySelectorAll(".new-agent-dialog button")].find(b => b.textContent.trim() === "Done").click(), true');
  await waitFor('!document.querySelector(".new-agent-dialog")', 'dialog closes after Done');
  check(deckRequests().length === 0, `no Agent Deck request while registering the Agent (browser=${deckRequests().length})`);

  const agents = await (await fetch(`${URL_BASE}/api/bots`)).json();
  const direct = agents.find(a => a.name === 'Direct Codex');
  check(direct && direct.launch_profile === undefined && direct.deck_id === undefined && direct.runtime_connection_id === 'rc-local-codex', `direct Agent stored: ${JSON.stringify(direct && { connection: direct.runtime_connection_id, scope: direct.session_scope, policy: direct.policy })}`);

  console.log('\n(2) Reload the Agent');
  await navigate(`${URL_BASE}/`);
  await waitFor(`document.body.innerText.includes('Agent: Codex')`, 'roster line for the Agent');
  await shot('desktop-1440x900-roster-reloaded');
  reset();
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'Config read view');
  await showAgentCard();
  await shot('desktop-1440x900-config-direct');
  await evaluate(helpers);
  await evaluate(`Array.from(document.querySelectorAll('[data-field=runtime-read] button')).find(b => b.textContent.trim() === 'Edit').click(), true`);
  await waitFor('!!document.querySelector("#cfg-connection")', 'Config edit form');
  await sleep(500);
  await showAgentCard('.registration-fields');
  await shot('desktop-1440x900-config-direct-edit');
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'Config after reload');
  await sleep(500);
  check(deckRequests().length === 0, `Config (read, Edit, reload) requested no deck (browser=${deckRequests().length})`);

  console.log('\n(3) Mobile 390x800');
  await viewport(MOBILE);
  reset();
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'Config (mobile)');
  await evaluate(`document.querySelector('[data-field=runtime-read]').scrollIntoView({ block: 'start' }), true`);
  await sleep(300);
  await shot('mobile-390x800-config-direct');
  check(deckRequests().length === 0, 'mobile: Config requested no deck');
  await navigate(`${URL_BASE}/`);
  await openNewAgent();
  await evaluate(helpers);
  await scrollDialogToEnd();
  const fits = await evaluate('(() => { const r = document.querySelector(".new-agent-dialog").getBoundingClientRect(); return r.left >= 16 && r.right <= innerWidth - 16 && r.bottom <= innerHeight - 16; })()');
  check(fits, 'mobile: New Agent dialog stays inside a 16px inset');
  await shot('mobile-390x800-new-agent-direct');

  cdp.close();
  chrome.proc.kill();
  console.log(failures ? `\nPROOF RESULT: FAIL (${failures})` : '\nPROOF RESULT: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
