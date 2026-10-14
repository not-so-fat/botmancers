#!/usr/bin/env node
// NOT-461: real-browser proof that the UI is agent-only. Drives a running
// Botmancers (seeded with scripts/seed-design-fixture.js, which stores two
// legacy groups) through headless Chrome over the DevTools protocol, at
// desktop and narrow viewports:
// - a fetch/XHR spy installed before page scripts plus CDP network events
//   record every request; none may hit /api/groups or ?groupId=;
// - each visited state (New, roster, Hidden, mentions, thread, row menu,
//   Manage agents, delete confirmation) is screenshotted and its visible
//   text must not mention a group;
// - group rows and their conversation-owned records are digested from the
//   SQLite file before and after the session and must match byte-for-byte.
// No dependencies beyond Node 22+ (global WebSocket) and a local Chrome.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm start   (other shell)
//        BOTMANCERS_DB_PATH=.temporal/design-fixture.db node scripts/ui-agent-only-proof.js \
//          [--url http://127.0.0.1:43123] [--out .agent-dealer-visual-qa]
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:43123');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'design-fixture.db');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1280x720', width: 1280, height: 720, mobile: false },
  { name: 'narrow-390x844', width: 390, height: 844, mobile: true },
];
const GROUP_REQUEST = /\/api\/groups|[?&]groupId=/;
const GROUP_COPY = /\bgroups?\b/i;

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
  return ok;
}

function groupDigest() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const groupConvs = "SELECT id FROM conversations WHERE type = 'group'";
    const tables = {
      groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
      group_members: db.prepare('SELECT * FROM group_members ORDER BY group_id, bot_id').all(),
      conversations: db.prepare("SELECT * FROM conversations WHERE type = 'group' ORDER BY id").all(),
      messages: db.prepare(`SELECT * FROM messages WHERE conversation_id IN (${groupConvs}) ORDER BY id`).all(),
      conversation_participants: db.prepare(
        `SELECT * FROM conversation_participants WHERE conversation_id IN (${groupConvs}) ORDER BY conversation_id, participant_kind, participant_id`
      ).all(),
    };
    const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
    return { hash: crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex'), counts };
  } finally {
    db.close();
  }
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

const SPY = `(() => {
  window.__requests = [];
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => {
    window.__requests.push(typeof input === 'string' ? input : (input && input.url) || String(input));
    return of(input, init);
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    window.__requests.push(String(url));
    return oo.apply(this, arguments);
  };
})();`;

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const before = groupDigest();
  console.log(`group digest before: sha256=${before.hash} ${JSON.stringify(before.counts)}`);
  check(before.counts.groups > 0 && before.counts.group_members > 0 && before.counts.messages > 0, 'fixture stores legacy groups, memberships, and messages');

  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  const network = [];
  cdp.on(msg => {
    if (msg.method === 'Network.requestWillBeSent') network.push(`${msg.params.request.method} ${msg.params.request.url}`);
  });
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });

  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expression, label, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const click = (selector, text) => evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(node => ${text ? `node.textContent.trim() === ${JSON.stringify(text)}` : 'true'});
    if (!el) throw new Error('no element ${selector} ${text || ''}');
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`);
  // Match the row by its exact agent name, not its preview text: Bob's
  // preview "[Handing off to Alice]" must not be mistaken for Alice's row.
  const rowByName = name => `[...document.querySelectorAll('.bot-row, .card')].find(node => node.querySelector('.bot-name')?.textContent.trim() === ${JSON.stringify(name)})`;
  const rightClick = async name => {
    const target = await evaluate(`(() => {
      const el = ${rowByName(name)};
      if (!el) throw new Error('no roster row ${name}');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
      return el.querySelector('.bot-name').textContent.trim();
    })()`);
    console.log(`  context menu opened on: ${target}`);
    check(target === name, `row menu targets ${name}`);
  };
  const press = async key => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13 });
  };
  const typeInto = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await cdp.send('Input.insertText', { text });
  };

  for (const vp of VIEWPORTS) {
    console.log(`\n${vp.name}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    const shot = async (state, check) => {
      await sleep(250);
      const text = await evaluate('document.body.innerText');
      const titles = await evaluate(`[...document.querySelectorAll('[aria-label],[title],[placeholder]')].map(n => [n.getAttribute('aria-label'), n.getAttribute('title'), n.getAttribute('placeholder')].filter(Boolean).join(' ')).join(' | ')`);
      const hit = (text.match(GROUP_COPY) || titles.match(GROUP_COPY));
      checkFn(!hit, `${state}: no group wording in visible text or labels${hit ? ` (found "${hit[0]}")` : ''}`);
      if (check) await check();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${vp.name}-${state}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  screenshot ${file}`);
    };
    const checkFn = check;

    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelector('.bot-row')", 'roster');
    await shot('roster', async () => {
      const names = await evaluate(`[...document.querySelectorAll('.bot-row, .card')].map(n => n.textContent.trim().slice(0, 40))`);
      console.log(`  roster rows: ${JSON.stringify(names)}`);
      checkFn(!names.some(n => /Research Team|ClickproofGrove/.test(n)), 'roster renders agents only (stored legacy groups hidden)');
    });

    await click('button.add-btn', 'New');
    await waitFor("document.querySelector('form.bot-form')", 'New Agent panel');
    await shot('new-agent', async () => {
      const panel = await evaluate(`(() => {
        const form = document.querySelector('form.bot-form');
        const root = form.closest('[role=dialog]') || form.parentElement;
        return {
          heading: [...root.querySelectorAll('h2')].map(h => h.textContent.trim()),
          tabs: root.querySelectorAll('[role=tab],[role=tablist]').length,
          radios: [...root.querySelectorAll('[role=radiogroup]')].map(n => n.getAttribute('aria-label')),
          checkboxes: root.querySelectorAll('input[type=checkbox]').length,
        };
      })()`);
      console.log(`  New panel: ${JSON.stringify(panel)}`);
      checkFn(panel.heading.includes('New Agent') && panel.tabs === 0 && panel.checkboxes === 0, 'New opens one New Agent panel with no kind tab or member picker');
    });
    await press('Escape');
    await sleep(200);
    if (await evaluate("!!document.querySelector('form.bot-form')")) await click('button', 'Cancel');

    await evaluate(`${rowByName('Bob')}.querySelector('.row-open').click()`);
    await waitFor("document.querySelector('.composer textarea')", 'composer');
    await typeInto('.composer textarea', '@');
    await waitFor("document.querySelector('.mention-list')", 'mention list');
    await shot('mentions', async () => {
      const items = await evaluate(`[...document.querySelectorAll('.mention-list button')].map(b => b.textContent.trim())`);
      const agents = await evaluate(`fetch('/api/bots').then(r => r.json()).then(list => list.map(b => '@' + b.name))`);
      console.log(`  mention items: ${JSON.stringify(items)}`);
      checkFn(items.length > 0 && items.every(item => agents.includes(item)), 'composer mentions suggest agents only');
    });
    await cdp.send('Input.insertText', { text: 'Alice hello from the agent-only proof' });
    await click('.send-btn');
    await waitFor(`document.body.innerText.includes('hello from the agent-only proof')`, 'sent message in thread');
    await shot('thread');

    await rightClick('Alice');
    await waitFor("document.querySelector('.row-menu')", 'row menu');
    await shot('row-menu', async () => {
      const items = await evaluate(`[...document.querySelectorAll('.row-menu [role=menuitem]')].map(b => b.textContent.trim())`);
      console.log(`  row menu: ${JSON.stringify(items)}`);
    });
    await click('.row-menu [role=menuitem]', 'Hide from sidebar');
    await waitFor("[...document.querySelectorAll('button.pin-word')].some(b => b.textContent.trim() === 'Hidden')", 'Hidden toggle');
    await click('button.pin-word', 'Hidden');
    await waitFor("[...document.querySelectorAll('.card-name')].some(n => n.textContent.trim() === 'Alice')", 'Alice in hidden agents');
    await evaluate(`[...document.querySelectorAll('.card-name')].find(n => n.textContent.trim() === 'Alice').closest('.card').scrollIntoView({ block: 'center' })`);
    await shot('hidden-agents', async () => {
      const hidden = await evaluate(`(() => {
        const card = [...document.querySelectorAll('.card-name')].find(n => n.textContent.trim() === 'Alice').closest('.card');
        const r = card.getBoundingClientRect();
        return { names: [...document.querySelectorAll('.card-name')].map(n => n.textContent.trim()), inView: r.top >= 0 && r.bottom <= innerHeight };
      })()`);
      console.log(`  hidden agents: ${JSON.stringify(hidden.names)}`);
      checkFn(hidden.names.includes('Alice') && hidden.inView, 'hidden-agents card shows Alice in view');
    });
    await evaluate(`[...document.querySelectorAll('.card-name')].find(n => n.textContent.trim() === 'Alice').closest('.card').querySelector('button.pin-word').click()`);
    await sleep(300);

    await rightClick('Bob');
    await waitFor("document.querySelector('.row-menu')", 'row menu');
    await click('.row-menu [role=menuitem]', 'Delete agent…');
    await waitFor("document.querySelector('[data-testid=delete-agents-dialog] .delete-names')", 'delete preview');
    await shot('delete-confirm', async () => {
      const legacy = await evaluate(`!!document.querySelector('[data-testid=delete-legacy-impact]')`);
      checkFn(!legacy, 'delete confirmation shows no stored-group impact');
    });
    await click('[data-testid=delete-agents-dialog] button', 'Cancel');
    await sleep(200);

    await click('button.add-btn', 'Manage agents');
    await waitFor("document.querySelector('[role=dialog]')", 'Manage agents panel');
    await shot('manage-agents');
    await press('Escape');
    await sleep(300);
  }

  const spied = await evaluate('window.__requests');
  const groupHits = [...network, ...spied].filter(url => GROUP_REQUEST.test(url));
  fs.writeFileSync(path.join(OUT, 'network.txt'), `${network.join('\n')}\n\n# in-page fetch/XHR spy (last page load)\n${spied.join('\n')}\n`);
  console.log(`\nnetwork: ${network.length} CDP requests, ${spied.length} spied in the last page; group requests=${JSON.stringify(groupHits)}`);
  check(network.some(url => url.includes('/api/bots')) && groupHits.length === 0, 'browser requested agents and never /api/groups or ?groupId=');

  cdp.close();
  await new Promise(resolve => {
    chrome.proc.once('exit', resolve);
    chrome.proc.kill();
  });
  fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  const after = groupDigest();
  console.log(`group digest after:  sha256=${after.hash} ${JSON.stringify(after.counts)}`);
  check(after.hash === before.hash, 'stored group rows, memberships, conversations, messages, and participants byte-for-byte unchanged');
  console.log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('proof crashed:', err);
  process.exit(1);
});
