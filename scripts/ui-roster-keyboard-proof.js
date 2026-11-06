#!/usr/bin/env node
// NOT-448: real-browser proof that roster agent rows and their actions are
// keyboard operable. Drives a running Botmancers (seeded with
// scripts/seed-design-fixture.js) through headless Chrome over the DevTools
// protocol, using real key events only for the keyboard paths:
// - accessibility tree: every visible agent exposes one button named by the
//   agent plus one "Actions for <agent>" menu button; no nested controls and
//   no Group copy anywhere in the roster;
// - Tab from page start reaches every row in visual order, each focused row
//   shows the whole-row outline, Enter and Space open an agent;
// - the Actions trigger opens a menu whose items (Pin/Unpin, Mark as Unread,
//   Rename agent, Hide from sidebar, Config, Delete agent…) are each invoked
//   with the keyboard, with focus always landing on a visible control;
// - hidden agents keep the same open button and Actions trigger, whose menu
//   offers Unhide;
// - pointer selection, right-click, ordering and Manage agents still work.
// Mutations are undone in-run (unpin, rename back, unhide, delete cancelled).
// Writes screenshots, AX snapshots and a trace under --out, stamped with HEAD.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/design-fixture.db npm run dev   (other shell)
//        node scripts/ui-roster-keyboard-proof.js [--url http://127.0.0.1:3333] [--out .agent-dealer-visual-qa]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:3333');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const TARGET = 'Cedar';
const KEYS = {
  Tab: 9, Enter: 13, ' ': 32, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Backspace: 8,
};
const HEAD = execSync('git rev-parse HEAD').toString().trim();

let failures = 0;
const trace = [];
function log(line) {
  console.log(line);
  trace.push(line);
}
function check(ok, label) {
  log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
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

// Describes document.activeElement for the trace.
const FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { kind: 'body' };
  const row = el.closest('.bot-row, .card');
  const after = el.matches('.row-open') ? getComputedStyle(el, '::after') : null;
  const own = getComputedStyle(el);
  return {
    kind: el.matches('.row-open') ? 'open' : el.matches('.row-actions') ? 'actions' : el.getAttribute('role') || el.tagName.toLowerCase(),
    name: el.getAttribute('aria-label') || el.textContent.trim() || el.value || '',
    row: row && row.querySelector('[data-open-bot]') ? row.querySelector('[data-open-bot]').textContent.trim() : null,
    focusVisible: el.matches(':focus-visible'),
    ring: after ? after.outlineStyle + ' ' + after.outlineWidth + ' ' + after.outlineColor : own.outlineStyle + ' ' + own.outlineWidth,
    expanded: el.getAttribute('aria-expanded'),
  };
})()`;

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the seeded design fixture; no mocks)`);
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
  const waitFor = async (expression, label, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const press = async (key, times = 1) => {
    for (let i = 0; i < times; i++) {
      const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
      const code = key === ' ' ? 'Space' : key;
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, text, windowsVirtualKeyCode: KEYS[key] });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: KEYS[key] });
      await sleep(60);
    }
    await sleep(150);
  };
  const focus = () => evaluate(FOCUS);
  const api = name => evaluate(`fetch('/api/bots').then(r => r.json()).then(list => list.find(b => b.name === ${JSON.stringify(name)}) || null)`);
  const threadName = () => evaluate(`document.querySelector('.thread-name')?.textContent.trim() || null`);
  const shot = async (vp, state) => {
    await sleep(200);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    log(`  screenshot ${file}`);
  };
  // AX nodes inside the first element matching `scope` (the roster or menu).
  const axSnapshot = async (vp, state, scope, filter) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: scope });
    const { nodes } = await cdp.send('Accessibility.queryAXTree', { nodeId });
    const picked = nodes
      .filter(n => !n.ignored && n.role && filter(n.role.value, n.name?.value || ''))
      .map(n => ({
        role: n.role.value,
        name: n.name?.value || '',
        ...Object.fromEntries((n.properties || []).filter(p => ['focusable', 'expanded', 'hasPopup', 'focused'].includes(p.name)).map(p => [p.name, p.value.value])),
      }));
    const file = path.join(OUT, `${vp.name}-ax-${state}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ head: HEAD, state, scope, nodes: picked }, null, 2)}\n`);
    log(`  ax snapshot ${file} (${picked.length} nodes)`);
    return picked;
  };
  // Keyboard-only start: reload, drop focus to the document, Tab forward.
  const fromStart = async () => {
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelectorAll('.row-open').length > 0", 'roster rows');
    await sleep(600);
    await evaluate('document.activeElement && document.activeElement.blur()');
  };
  const tabTo = async (predicate, label, max = 40) => {
    for (let i = 0; i < max; i++) {
      await press('Tab');
      const f = await focus();
      if (predicate(f)) return f;
    }
    check(false, `Tab never reached ${label}`);
    return null;
  };
  const openMenuOn = async name => {
    const f = await tabTo(f => f.kind === 'actions' && f.row === name, `Actions for ${name}`);
    await press('Enter');
    await waitFor("document.querySelector('.row-menu')", 'row menu');
    return f;
  };
  const menuTo = async label => {
    for (let i = 0; i < 8; i++) {
      const f = await focus();
      if (f.kind === 'menuitem' && f.name === label) return true;
      await press('ArrowDown');
    }
    return check(false, `menu item ${label} reachable by ArrowDown`);
  };

  for (const vp of VIEWPORTS) {
    log(`\n${vp.name}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await fromStart();

    // 1. Semantics: one named open button + one named actions trigger per row.
    const rows = await evaluate(`[...document.querySelectorAll('.roster')][0] ? [...[...document.querySelectorAll('.roster')][0].children].map(row => {
      const r = row.getBoundingClientRect();
      return {
        cls: row.className,
        opens: [...row.querySelectorAll('[data-open-bot]')].map(b => ({ tag: b.tagName, type: b.type, name: b.textContent.trim() })),
        triggers: [...row.querySelectorAll('.row-actions')].map(b => ({ tag: b.tagName, label: b.getAttribute('aria-label'), popup: b.getAttribute('aria-haspopup'), visible: b.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility !== 'hidden' })),
        rowRole: row.getAttribute('role'), rowTab: row.getAttribute('tabindex'),
        top: Math.round(r.top + scrollY), left: Math.round(r.left),
      };
    }) : []`);
    if (rows.length === 0) throw new Error('roster did not render (is the app hydrated? dev mode needs a localhost URL)');
    const names = rows.map(row => row.opens[0]?.name);
    log(`  roster (visual order): ${JSON.stringify(names)}`);
    check(rows.length >= 6, `populated fixture shows ${rows.length} agent rows`);
    check(rows.every(row => row.opens.length === 1 && row.opens[0].tag === 'BUTTON' && row.opens[0].type === 'button'), 'every row has exactly one <button type=button> open control');
    check(rows.every(row => row.triggers.length === 1 && row.triggers[0].tag === 'BUTTON' && row.triggers[0].label === `Actions for ${row.opens[0].name}` && row.triggers[0].popup === 'menu' && row.triggers[0].visible), 'every row has one visible "Actions for <agent>" menu button');
    check(rows.every(row => !row.rowRole && !row.rowTab), 'row containers are not pseudo-controls (no role/tabindex)');
    check(rows.every((row, i) => i === 0 || row.top > rows[i - 1].top), 'DOM order matches top-to-bottom visual order');
    check(names[0] === 'chief-of-staff' && rows[0].cls.includes('card'), 'Chief of Staff card stays first');
    const nested = await evaluate(`document.querySelectorAll('button button, button a, button input, a button, a a, .row-open *:is(button, a, input, [tabindex])').length`);
    check(nested === 0, `no nested interactive controls in the document (found ${nested})`);
    const rosterCopy = await evaluate(`(() => { const r = document.querySelector('.rail'); return r.innerText + ' ' + [...r.querySelectorAll('[aria-label],[title]')].map(n => (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')).join(' '); })()`);
    check(!/\bgroups?\b/i.test(rosterCopy), 'roster shows no Group row, action, or label');
    const ax = await axSnapshot(vp, 'roster', '.roster', (role, name) => ['button', 'link'].includes(role) && (names.includes(name) || /^Actions for /.test(name)));
    check(names.every(name => ax.filter(n => n.role === 'button' && n.name === name).length === 1), 'AX tree: one button named by each agent');
    check(names.every(name => ax.some(n => n.role === 'button' && n.name === `Actions for ${name}` && n.hasPopup === 'menu')), 'AX tree: one "Actions for <agent>" menu button per agent');

    // 2. Keyboard trace from page start through every row.
    const seen = [];
    for (let i = 0; i < 3 + rows.length * 2 + 2; i++) {
      await press('Tab');
      const f = await focus();
      seen.push(f);
      log(`  Tab ${String(i + 1).padStart(2)} -> ${f.kind} "${f.name}"${f.row ? ` [row ${f.row}]` : ''} focusVisible=${f.focusVisible} ring=${f.ring}`);
      if (f.kind === 'open' && f.row === names[1]) await shot(vp, 'focus-row');
    }
    const opens = seen.filter(f => f.kind === 'open').map(f => f.row);
    check(JSON.stringify(opens) === JSON.stringify(names), 'Tab reaches every agent row in visual order');
    check(seen.filter(f => f.kind === 'open').every(f => f.focusVisible && /^solid 2px/.test(f.ring)), 'every focused row shows the 2px whole-row outline');
    check(seen.filter(f => f.kind === 'actions').every(f => f.focusVisible && /^solid 2px/.test(f.ring)), 'every focused Actions trigger shows an outline');
    check(seen.every(f => f.kind !== 'body'), 'focus never falls to the document during the trace');

    // 3. Enter and Space open agents.
    await fromStart();
    await tabTo(f => f.kind === 'open' && f.row === 'Bob', 'Bob row');
    await press('Enter');
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Bob'`, 'Bob thread');
    check(await threadName() === 'Bob', 'Enter on Bob row opens Bob');
    await fromStart();
    await tabTo(f => f.kind === 'open' && f.row === 'Alice', 'Alice row');
    await press(' ');
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Alice'`, 'Alice thread');
    check(await threadName() === 'Alice', 'Space on Alice row opens Alice');
    check(await evaluate(`document.querySelector('[data-open-bot]:is([aria-current=true])')?.textContent.trim()`) === 'Alice', 'opened row carries aria-current');
    await shot(vp, 'opened-by-space');

    // 4. Row actions menu, every item through the keyboard.
    await fromStart();
    const trigger = await openMenuOn(TARGET);
    check(!!trigger && trigger.focusVisible, `Tab reaches visible "Actions for ${TARGET}" trigger`);
    let f = await focus();
    check(f.kind === 'menuitem', `Enter opens the menu and focuses "${f.name}"`);
    const items = await evaluate(`[...document.querySelectorAll('.row-menu [role=menuitem]')].map(n => n.textContent.trim())`);
    log(`  menu: ${JSON.stringify(items)}`);
    check(JSON.stringify(items) === JSON.stringify(['Pin', 'Mark as Unread', 'Rename agent', 'Hide from sidebar', 'Config', 'Delete agent…']), 'menu lists Pin, Mark as Unread, Rename agent, Hide from sidebar, Config, Delete agent…');
    check(await evaluate(`document.querySelector('.row-actions[aria-expanded=true]')?.getAttribute('aria-label')`) === `Actions for ${TARGET}`, 'trigger reports aria-expanded=true');
    await axSnapshot(vp, 'row-menu', '.row-menu', role => ['menu', 'menuitem'].includes(role));
    await shot(vp, 'row-menu');
    const walk = [];
    for (let i = 0; i < items.length; i++) { walk.push((await focus()).name); await press('ArrowDown'); }
    walk.push((await focus()).name);
    await press('End'); walk.push((await focus()).name);
    await press('Home'); walk.push((await focus()).name);
    await press('ArrowUp'); walk.push((await focus()).name);
    log(`  arrow walk: ${JSON.stringify(walk)}`);
    check(walk.slice(0, items.length).join('|') === items.join('|') && walk[items.length] === items[0] && walk.at(-3) === items.at(-1) && walk.at(-2) === items[0] && walk.at(-1) === items.at(-1), 'ArrowDown/ArrowUp wrap, Home/End jump');
    await press('Escape');
    f = await focus();
    check(!(await evaluate("!!document.querySelector('.row-menu')")) && f.kind === 'actions' && f.row === TARGET && f.expanded === 'false', 'Escape closes the menu and returns focus to the trigger');

    // Pin then Unpin.
    await press('Enter'); await menuTo('Pin'); await press('Enter');
    await sleep(400);
    check((await api(TARGET)).pinned === 1, `Pin pins ${TARGET}`);
    f = await focus();
    check(f.kind === 'actions' && f.row === TARGET, 'focus returns to the trigger after Pin');
    const order = await evaluate(`[...[...document.querySelectorAll('.roster')][0].querySelectorAll('[data-open-bot]')].map(b => b.textContent.trim())`);
    const listed = await evaluate(`fetch('/api/bots').then(r => r.json())`);
    const rank = name => name === 'chief-of-staff' ? 0 : listed.find(b => b.name === name).pinned ? 1 : 2;
    log(`  order after pin: ${JSON.stringify(order)}`);
    check(order.every((name, i) => i === 0 || rank(order[i - 1]) <= rank(name)) && order.indexOf(TARGET) < order.findIndex(name => rank(name) === 2), 'pinned agent moves into the pinned block after Chief of Staff');
    await press('Enter');
    check(await evaluate(`document.activeElement.textContent.trim()`) === 'Unpin', 'menu now offers Unpin');
    await press('Enter');
    await sleep(400);
    check((await api(TARGET)).pinned === 0, `Unpin unpins ${TARGET}`);

    // Mark as Unread.
    await fromStart();
    await openMenuOn(TARGET); await menuTo('Mark as Unread'); await press('Enter');
    await sleep(400);
    check((await api(TARGET)).unread === 1, `Mark as Unread sets unread on ${TARGET}`);

    // Rename agent and rename back.
    await openMenuOn(TARGET); await menuTo('Rename agent'); await press('Enter');
    f = await focus();
    check(f.kind === 'input' && f.name === `Rename ${TARGET}`, 'Rename agent focuses the "Rename <agent>" input');
    await cdp.send('Input.insertText', { text: 'X' });
    await press('Enter');
    await sleep(500);
    f = await focus();
    check(!!(await api(`${TARGET}X`)) && f.kind === 'open' && f.row === `${TARGET}X`, 'Enter saves the rename and focus returns to the row');
    await shot(vp, 'after-rename');
    await openMenuOn(`${TARGET}X`); await menuTo('Rename agent'); await press('Enter');
    await press('Backspace'); await press('Enter');
    await sleep(500);
    check(!!(await api(TARGET)), 'rename back restores the name');

    // Hide from sidebar, then Unhide by keyboard.
    await fromStart();
    await openMenuOn(TARGET); await menuTo('Hide from sidebar'); await press('Enter');
    await sleep(500);
    f = await focus();
    check((await api(TARGET)).hidden === 1 && f.name === 'Hidden', 'Hide hides the agent and focus moves to the Hidden toggle');
    await press('Enter');
    const hiddenRows = await evaluate(`[...document.querySelectorAll('.roster:has(> .pin-word) > .bot-row')].map(row => ({
      opens: [...row.querySelectorAll('[data-open-bot]')].map(b => ({ tag: b.tagName, name: b.textContent.trim() })),
      triggers: [...row.querySelectorAll('.row-actions')].map(b => ({ label: b.getAttribute('aria-label'), popup: b.getAttribute('aria-haspopup'), visible: b.getBoundingClientRect().width > 0 })),
    }))`);
    log(`  hidden list: ${JSON.stringify(hiddenRows.map(row => row.opens[0]?.name))}`);
    check(hiddenRows.length >= 1 && hiddenRows.every(row => row.opens.length === 1 && row.opens[0].tag === 'BUTTON' && row.triggers.length === 1 && row.triggers[0].label === `Actions for ${row.opens[0].name}` && row.triggers[0].popup === 'menu' && row.triggers[0].visible), 'every hidden agent has one open button and one visible "Actions for <agent>" menu button');
    const hiddenAx = await axSnapshot(vp, 'hidden-roster', '.roster:has(> .pin-word)', (role, name) => ['button', 'link'].includes(role));
    check(!hiddenAx.some(n => n.name === 'Unhide'), 'AX tree: no bare, identically named "Unhide" buttons in the hidden list');
    f = await tabTo(f => f.kind === 'open' && f.row === TARGET, `hidden ${TARGET} row`);
    check(!!f && f.focusVisible && /^solid 2px/.test(f.ring), `Tab reaches hidden ${TARGET} row with the whole-row outline`);
    await shot(vp, 'hidden-row-focus');
    await press('Enter');
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(TARGET)}`, `hidden ${TARGET} thread`);
    check(await threadName() === TARGET, `Enter on the hidden ${TARGET} row opens it`);
    await tabTo(f => f.kind === 'actions' && f.row === TARGET, `Actions for hidden ${TARGET}`);
    await press('Enter');
    await waitFor("document.querySelector('.row-menu')", 'hidden row menu');
    const hiddenItems = await evaluate(`[...document.querySelectorAll('.row-menu [role=menuitem]')].map(n => n.textContent.trim())`);
    log(`  hidden menu: ${JSON.stringify(hiddenItems)}`);
    check(JSON.stringify(hiddenItems) === JSON.stringify(['Pin', 'Mark as Unread', 'Rename agent', 'Unhide', 'Config', 'Delete agent…']), 'hidden row menu offers Unhide alongside the other row actions');
    await axSnapshot(vp, 'hidden-row-menu', '.row-menu', role => ['menu', 'menuitem'].includes(role));
    await menuTo('Unhide');
    await shot(vp, 'hidden-unhide');
    await press('Enter');
    await sleep(500);
    f = await focus();
    check((await api(TARGET)).hidden === 0 && f.kind === 'open' && f.row === TARGET, `Unhide restores the agent and focuses its row (focus: ${f.kind} "${f.name}")`);

    // Config navigates to the agent config page.
    await fromStart();
    await openMenuOn(TARGET); await menuTo('Config'); await press('Enter');
    const id = (await api(TARGET)).id;
    await waitFor(`location.pathname === '/agents/${id}/config'`, 'config page');
    check(await evaluate('location.pathname') === `/agents/${id}/config`, 'Config opens the agent config page');
    await shot(vp, 'config');

    // Delete opens the shared confirmation; cancel returns focus to the row.
    await fromStart();
    await openMenuOn(TARGET); await menuTo('Delete agent…'); await press('Enter');
    await waitFor("document.querySelector('[data-testid=delete-agents-dialog]')", 'delete dialog');
    check(await evaluate(`document.querySelector('[data-testid=delete-agents-dialog] .delete-names')?.textContent.includes(${JSON.stringify(TARGET)})`), `Delete agent… opens the confirmation for ${TARGET}`);
    await shot(vp, 'delete-confirm');
    await press('Escape');
    await sleep(400);
    f = await focus();
    check(!!(await api(TARGET)) && f.kind === 'open' && f.row === TARGET, 'cancelling delete keeps the agent and focuses its row');

    // 5. Pointer: click anywhere on a row, right-click menu, Manage agents.
    const box = await evaluate(`(() => { const row = [...document.querySelectorAll('.bot-row')].find(r => r.querySelector('[data-open-bot]').textContent.trim() === 'Pine'); row.scrollIntoView({ block: 'center' }); const r = row.querySelector('.mark-avatar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Pine'`, 'Pine thread');
    check(await threadName() === 'Pine', 'pointer click on the row avatar opens the agent');
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    await waitFor("document.querySelector('.row-menu')", 'context menu');
    check(await evaluate(`document.querySelector('.row-menu').getAttribute('aria-label')`) === 'Actions for Pine', 'right-click still opens the row menu');
    await press('Escape');
    await fromStart();
    await tabTo(f => f.name === 'Manage agents', 'Manage agents');
    await press('Enter');
    await waitFor("document.querySelector('[role=dialog]')", 'Manage agents panel');
    check(await evaluate(`document.querySelector('[role=dialog]').innerText.includes('Select all shown')`), 'Manage agents opens with bulk selection');
    await shot(vp, 'manage-agents');
    await press('Escape');
    await sleep(300);
    f = await focus();
    check(f.name === 'Manage agents', 'closing Manage agents returns focus to its button');
  }

  cdp.close();
  await new Promise(resolve => {
    chrome.proc.once('exit', resolve);
    chrome.proc.kill();
  });
  fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  log(`\n${failures === 0 ? 'PROOF RESULT: PASS' : `PROOF RESULT: FAIL (${failures})`} at ${HEAD}`);
  fs.writeFileSync(path.join(OUT, 'roster-keyboard-trace.txt'), `${trace.join('\n')}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error('roster keyboard proof crashed:', error);
  process.exit(1);
});
