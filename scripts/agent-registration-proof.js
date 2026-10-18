#!/usr/bin/env node
// NOT-502: real-app proof for Agent registration. Drives the running app
// (default http://localhost:43123, started from this checkout with an
// isolated BOTMANCERS_HOME) in headless Chrome over CDP:
//
// 1. points the workspace Agent Deck setting at a loopback stub that
//    serves GET /api/launch/decks and records every request it gets;
// 2. registers a direct Codex Agent through New Agent and checks that no
//    Agent Deck request was made (browser and stub);
// 3. registers an Agent Deck-backed Codex Agent (the deck list loads only
//    once Agent Deck is picked);
// 4. reloads both Agents' Config pages and confirms the direct Agent's
//    page (read view, Edit, reload) never requests a deck;
// 5. captures desktop 1440x900 and mobile 390x800 screenshots.
//
// Usage: node scripts/agent-registration-proof.js [--url URL] [--out DIR]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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

function startDeckStub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/launch/decks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decks: [{ id: 'deck-builder', name: 'builder' }, { id: 'deck-review', name: 'review' }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}

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
  const stub = await startDeckStub();
  const settings = await fetch(`${URL_BASE}/api/agent-deck/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_url: stub.url }),
  });
  check(settings.ok, `workspace Agent Deck server -> loopback stub ${stub.url}`);

  const browserRequests = [];
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl, msg => {
    if (msg.method === 'Network.requestWillBeSent') browserRequests.push(msg.params.request.url);
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
  const deckRequests = () => browserRequests.filter(url => url.includes('/api/agent-deck/decks'));
  const reset = () => {
    browserRequests.length = 0;
    stub.hits.length = 0;
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

  async function openNewAgent() {
    await evaluate(helpers);
    await waitFor('!!document.querySelector("button.add-btn")', 'New button');
    await evaluate('document.querySelector("button.add-btn").click(), true');
    await waitFor('!!document.querySelector("#bot-connection")', 'New Agent dialog with connections');
  }

  async function fillCommon(name) {
    await evaluate(`__setValue('#bot-name', ${JSON.stringify(name)})`);
    await evaluate(`__setValue('#bot-connection', 'rc-local-codex')`);
  }

  console.log('\n(1) Register a direct Codex Agent (desktop)');
  await viewport(DESKTOP);
  reset();
  await navigate(`${URL_BASE}/`);
  await openNewAgent();
  await fillCommon('Direct Codex');
  await evaluate(`__click('input[name="bot-scope"][value="workspaces"]')`);
  await waitFor('!!document.querySelector("#bot-workspaces")', 'workspace list');
  await evaluate(`__setValue('#bot-workspaces', '/Users/owner/work/botmancers')`);
  await evaluate(`__setValue('#bot-default-workspace', '/Users/owner/work/botmancers')`);
  await evaluate(`__click('input[name="bot-profile"][value="direct"]')`);
  await sleep(300);
  check(await evaluate('!document.querySelector("[data-field=deck]") && !document.querySelector("#bot-workdir")'), 'Direct chosen: no Agent Deck controls rendered');
  await shot('desktop-1440x900-new-agent-direct');
  await evaluate('document.querySelector(".new-agent-dialog button[type=submit]").click(), true');
  await waitFor('!document.querySelector(".new-agent-dialog")', 'dialog closes after Create');
  check(deckRequests().length === 0 && stub.hits.length === 0, `no Agent Deck request while registering the direct Agent (browser=${deckRequests().length}, stub=${stub.hits.length})`);

  console.log('\n(2) Register an Agent Deck-backed Codex Agent (desktop)');
  await openNewAgent();
  await fillCommon('Deck Codex');
  await evaluate(`__click('input[name="bot-scope"][value="all_provider_sessions"]')`);
  await evaluate(`__click('input[name="bot-profile"][value="agent_deck"]')`);
  await waitFor('!!document.querySelector("#bot-deck") && document.querySelectorAll("#bot-deck option").length > 1', 'deck list from the stub');
  await evaluate(`__setValue('#bot-deck', 'deck-builder')`);
  check(deckRequests().length > 0 && stub.hits.includes('GET /api/launch/decks'), 'picking Agent Deck loads the verified deck list');
  await shot('desktop-1440x900-new-agent-agent-deck');
  await evaluate('document.querySelector(".new-agent-dialog button[type=submit]").click(), true');
  await waitFor('!document.querySelector(".new-agent-dialog")', 'dialog closes after Create');

  const agents = await (await fetch(`${URL_BASE}/api/bots`)).json();
  const direct = agents.find(a => a.name === 'Direct Codex');
  const deck = agents.find(a => a.name === 'Deck Codex');
  check(direct && direct.launch_profile === 'direct' && direct.deck_id === null && direct.runtime_connection_id === 'rc-local-codex', `direct Agent stored: ${JSON.stringify(direct && { profile: direct.launch_profile, deck: direct.deck_id, scope: direct.session_scope, policy: direct.policy })}`);
  check(deck && deck.launch_profile === 'agent_deck' && deck.deck_id === 'deck-builder' && deck.runtime_connection_id === direct.runtime_connection_id, 'Agent Deck Agent stored with its deck on the shared connection');

  console.log('\n(3) Reload both Agents');
  await navigate(`${URL_BASE}/`);
  await waitFor(`document.body.innerText.includes('Launch: Direct') && document.body.innerText.includes('Agent Deck: builder')`, 'roster lines for both Agents');
  await shot('desktop-1440x900-roster-reloaded');
  reset();
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'direct Config read view');
  await shot('desktop-1440x900-config-direct');
  await evaluate(helpers);
  await evaluate(`Array.from(document.querySelectorAll('[data-field=runtime-read] button')).find(b => b.textContent.trim() === 'Edit').click(), true`);
  await waitFor('!!document.querySelector("#cfg-connection")', 'direct Config edit form');
  await sleep(500);
  await shot('desktop-1440x900-config-direct-edit');
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'direct Config after reload');
  await sleep(500);
  check(deckRequests().length === 0 && stub.hits.length === 0, `direct Agent Config (read, Edit, reload) requested no deck (browser=${deckRequests().length}, stub=${stub.hits.length})`);
  await navigate(`${URL_BASE}/bots/${deck.id}/config`);
  await waitFor(`!!document.querySelector("[data-field=runtime-read]") && document.querySelector("[data-field=runtime-read]").innerText.includes('builder')`, 'Agent Deck Config shows its deck');
  await shot('desktop-1440x900-config-agent-deck');

  console.log('\n(4) Mobile 390x800');
  await viewport(MOBILE);
  reset();
  await navigate(`${URL_BASE}/bots/${direct.id}/config`);
  await waitFor('!!document.querySelector("[data-field=runtime-read]")', 'direct Config (mobile)');
  await evaluate(`document.querySelector('[data-field=runtime-read]').scrollIntoView({ block: 'start' }), true`);
  await sleep(300);
  await shot('mobile-390x800-config-direct');
  check(deckRequests().length === 0, 'mobile: direct Config requested no deck');
  await navigate(`${URL_BASE}/`);
  await openNewAgent();
  await evaluate(`__click('input[name="bot-profile"][value="direct"]')`);
  await evaluate(`document.querySelector('[data-field=launch-profile]').scrollIntoView({ block: 'center' }), true`);
  await sleep(300);
  const fits = await evaluate('(() => { const r = document.querySelector(".new-agent-dialog").getBoundingClientRect(); return r.left >= 16 && r.right <= innerWidth - 16 && r.bottom <= innerHeight - 16; })()');
  check(fits, 'mobile: New Agent dialog stays inside a 16px inset');
  await shot('mobile-390x800-new-agent-direct');

  cdp.close();
  chrome.proc.kill();
  stub.server.close();
  console.log(failures ? `\nPROOF RESULT: FAIL (${failures})` : '\nPROOF RESULT: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
