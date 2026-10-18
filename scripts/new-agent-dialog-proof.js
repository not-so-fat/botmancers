#!/usr/bin/env node
// NOT-447: real-browser proof for the New Agent dialog. Drives a running
// Botmancers through headless Chrome over the DevTools protocol with real
// key events, at desktop, narrow, and short viewports:
// - opening New with the keyboard yields exactly one aria-modal dialog named
//   "New Agent" in Chrome's accessibility tree, and no background control
//   (New, Manage agents, Settings, roster rows) is exposed there or focusable;
// - focus starts on Name; Tab and Shift+Tab are traced by focused control
//   until they wrap; Escape closes and focus is back on New;
// - geometry: anchored under New when there is room, inside a 16px inset,
//   header and actions visible, every field reachable by scrolling the body;
// - no Group wording appears in the dialog.
// No dependencies beyond Node 22+ (global WebSocket) and a local Chrome.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev   (other shell)
//        node scripts/new-agent-dialog-proof.js [--url http://localhost:3333] [--out .agent-dealer-visual-qa]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://localhost:3333');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const INSET = 16;
const VIEWPORTS = [
  { name: 'desktop-1280x720', width: 1280, height: 720, mobile: false, anchored: true },
  { name: 'narrow-390x844', width: 390, height: 844, mobile: true, anchored: true },
  { name: 'narrow-360x640', width: 360, height: 640, mobile: true, anchored: true },
  { name: 'short-1280x420', width: 1280, height: 420, mobile: false, anchored: false },
];

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
  return { proc, profile, wsUrl: page.webSocketDebuggerUrl };
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

// Names the focused control the way a keyboard user would hear it.
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || el.textContent.trim();
  const kind = el.type === 'radio' ? 'radio' : el.tagName.toLowerCase();
  const where = el.closest('[role="dialog"]') ? 'dialog' : 'page';
  return kind + ' "' + label + '" (' + where + ')';
})()`;

const KEYS = {
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
};

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Accessibility.enable');

  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expression, label, ms = 15000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const press = async (key, shift = false) => {
    const base = { key, modifiers: shift ? 8 : 0, ...KEYS[key] };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, text: undefined });
    await sleep(60);
  };
  const focused = () => evaluate(FOCUSED);

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n${vp.name}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
      await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
      // Wait for hydration: React attaches its props to the New button.
      await waitFor(`[...document.querySelectorAll('.add-btn')].some(b => b.textContent.trim() === 'New' && Object.keys(b).some(k => k.startsWith('__reactProps')))`, 'hydrated New button');
      await sleep(400);

      // Open with the keyboard from New.
      await evaluate(`[...document.querySelectorAll('.add-btn')].find(b => b.textContent.trim() === 'New').focus()`);
      console.log(`  focus before open: ${await focused()}`);
      await press('Enter');
      await waitFor(`document.querySelector('[role="dialog"]')`, 'dialog');
      await sleep(250);
      const opened = await focused();
      console.log(`  Enter on New -> ${opened}`);
      check(opened === 'input "Name" (dialog)', 'opening moves focus to the Name field');

      const dom = await evaluate(`(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')];
        const d = dialogs[0];
        const title = d && document.getElementById(d.getAttribute('aria-labelledby'));
        const field = document.querySelector('.field');
        return {
          count: dialogs.length,
          modal: d && d.getAttribute('aria-modal'),
          name: title && title.textContent.trim(),
          fieldInert: !!(field && field.inert),
          dialogInsideField: !!(field && d && field.contains(d)),
          text: d ? d.innerText : '',
        };
      })()`);
      console.log(`  DOM: dialogs=${dom.count} aria-modal=${dom.modal} name="${dom.name}" page.inert=${dom.fieldInert} dialogInsidePage=${dom.dialogInsideField}`);
      check(dom.count === 1 && dom.modal === 'true' && dom.name === 'New Agent', 'exactly one aria-modal dialog named "New Agent"');
      check(dom.fieldInert && !dom.dialogInsideField, 'the page behind the dialog is inert and the dialog is outside it');
      check(!/\bgroups?\b|member/i.test(dom.text), 'no Group tab, member picker, or Group wording in the dialog');

      // Chrome's accessibility tree: one dialog, no background controls.
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const exposed = nodes.filter(n => !n.ignored);
      const axDialogs = exposed.filter(n => n.role?.value === 'dialog');
      const axNames = exposed.map(n => `${n.role?.value}:${n.name?.value || ''}`);
      const background = axNames.filter(entry => /^(button|link):(New|Manage agents|Settings)$/.test(entry) || /^heading:botmancers$/i.test(entry));
      console.log(`  AX: dialogs=${JSON.stringify(axDialogs.map(n => n.name?.value))} exposed controls=${JSON.stringify(axNames.filter(e => /^(button|textbox|radio|combobox|link|LabelText)/.test(e)))}`);
      check(axDialogs.length === 1 && axDialogs[0].name?.value === 'New Agent', 'accessibility tree exposes one dialog named "New Agent"');
      check(background.length === 0, `no background controls in the accessibility tree${background.length ? ` (found ${background.join(', ')})` : ''}`);

      // Keyboard trace: Tab forward until it wraps to Name, then Shift+Tab.
      const forward = [opened];
      for (let i = 0; i < 25; i++) {
        await press('Tab');
        const now = await focused();
        forward.push(now);
        if (now === opened) break;
      }
      console.log(`  Tab trace: ${forward.join(' -> ')}`);
      check(forward.length > 2 && forward[forward.length - 1] === opened, 'Tab wraps from the last control back to Name');
      check(forward.every(step => step.endsWith('(dialog)')), 'Tab never leaves the dialog');
      const lastControl = forward[forward.length - 2];
      await press('Tab', true);
      const back = await focused();
      console.log(`  Shift+Tab from Name -> ${back}`);
      check(back === lastControl && back.endsWith('(dialog)'), 'Shift+Tab from Name wraps to the last control');
      await press('Tab');
      check((await focused()) === opened, 'Tab from there returns to Name');

      // Geometry.
      const geo = await evaluate(`(() => {
        const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, left: b.left, right: b.right, bottom: b.bottom }; };
        const d = document.querySelector('[role="dialog"]');
        const body = d.querySelector('.new-agent-body');
        const fields = [...body.querySelectorAll('input, select, textarea, button, a[href]')];
        const unreachable = fields.filter(f => {
          f.scrollIntoView({ block: 'nearest' });
          const fb = f.getBoundingClientRect(); const bb = body.getBoundingClientRect();
          return fb.bottom > bb.bottom + 1 || fb.top < bb.top - 1;
        }).map(f => f.id || f.name || f.textContent.trim());
        body.scrollTop = 0;
        return {
          dialog: r(d),
          newBtn: r([...document.querySelectorAll('.add-btn')].find(b => b.textContent.trim() === 'New')),
          header: r(d.querySelector('.kind-row')),
          actions: r(d.querySelector('.form-actions')),
          bodyScrolls: body.scrollHeight > body.clientHeight,
          fields: fields.length,
          unreachable,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      })()`);
      const d = geo.dialog;
      console.log(`  geometry: viewport=${geo.vw}x${geo.vh} New=${JSON.stringify(geo.newBtn)} dialog=${JSON.stringify(d)} bodyScrolls=${geo.bodyScrolls} fields=${geo.fields}`);
      check(d.top >= INSET - 0.5 && d.left >= INSET - 0.5 && d.right <= geo.vw - INSET + 0.5 && d.bottom <= geo.vh - INSET + 0.5, 'dialog stays inside a 16px safe inset');
      if (vp.anchored) {
        check(d.top - geo.newBtn.bottom >= 0 && d.top - geo.newBtn.bottom <= 16 && Math.abs(d.left - geo.newBtn.left) <= 16, 'dialog is anchored directly under New');
      }
      check(geo.header.top >= d.top && geo.header.bottom <= geo.actions.top && geo.actions.bottom <= d.bottom + 0.5 && geo.actions.bottom <= geo.vh - INSET + 0.5, 'header and actions stay visible inside the dialog');
      check(geo.unreachable.length === 0, `every field scrolls into view inside the body${geo.unreachable.length ? ` (unreachable: ${geo.unreachable.join(', ')})` : ''}`);

      await sleep(150);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${vp.name}-new-agent.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  screenshot ${file}`);

      if (geo.bodyScrolls) {
        await evaluate(`(() => { const b = document.querySelector('.new-agent-body'); b.scrollTop = b.scrollHeight; })()`);
        await sleep(150);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const scrolled = path.join(OUT, `${vp.name}-new-agent-scrolled.png`);
        fs.writeFileSync(scrolled, Buffer.from(shot.data, 'base64'));
        console.log(`  screenshot ${scrolled}`);
      }

      await press('Escape');
      await sleep(250);
      const after = await focused();
      const gone = await evaluate(`!document.querySelector('[role="dialog"]') && !document.querySelector('.field').inert`);
      console.log(`  Escape -> dialog closed=${gone}, focus ${after}`);
      check(gone, 'Escape closes the dialog and the page is no longer inert');
      check(after === 'button "New" (page)', 'focus returns to New');
    }
  } finally {
    cdp.close();
    chrome.proc.kill();
    try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* Chrome may still be writing */ }
  }

  console.log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error('new-agent-dialog proof crashed:', error);
  process.exit(1);
});
