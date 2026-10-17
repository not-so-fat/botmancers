#!/usr/bin/env node
// NOT-496: real-browser proof of the selected-Agent Sessions flow. Drives a
// running Botmancers seeded with scripts/seed-sessions-fixture.js through
// headless Chrome over the DevTools protocol, at desktop and narrow widths:
// - open Dev, reach the thread header's Sessions control with Tab, open it
//   with Enter; focus moves into the drawer;
// - every canonical binding is listed (5 active, 2 ended) by title, state,
//   last activity, and origin; the Active/Ended filters narrow the list;
// - no drawer content is clipped or overflows horizontally, the drawer fits
//   the viewport, and no external provider session id is anywhere in the
//   default page (text or DOM); the drawer has no text input;
// - Details lists the runs in the session; Escape closes and focus returns
//   to Sessions;
// - the origin link opens the source thread (Tank), whose own Sessions view
//   shows the empty state;
// - desktop only: the labeled local debug disclosure is the one place the
//   provider session id appears, with a Copy action.
// Writes screenshots, a trace, and sessions-proof-receipt.json (HEAD, clean
// tree, viewports, sha256 of every screenshot) under --out. Refuses to run on
// a dirty worktree so the receipt binds to exactly the committed HEAD. No mocks.
//
// Usage: node scripts/seed-sessions-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/sessions-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43496   (other shell)
//        node scripts/ui-sessions-proof.js [--url http://127.0.0.1:43496] [--out .agent-dealer-visual-qa]
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { EXTERNAL_IDS } = require('../test-support/session-catalog-fixture');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:43496');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const SECRETS = [...Object.values(EXTERNAL_IDS), `${EXTERNAL_IDS.direct}-next`];

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-sessions-proof-'));
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

const FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { name: 'body', inDrawer: false };
  return {
    name: (el.getAttribute('aria-label') || el.textContent || '').trim(),
    inDrawer: !!el.closest('.sessions-drawer'),
    focusVisible: el.matches(':focus-visible'),
    outline: getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth,
    expanded: el.getAttribute('aria-expanded'),
  };
})()`;

// Horizontal clipping and overflow inside the drawer, and drawer fit.
const LAYOUT = `(() => {
  const drawer = document.querySelector('.sessions-drawer');
  const d = drawer.getBoundingClientRect();
  const clipped = [];
  for (const el of drawer.querySelectorAll('.session-row, .session-title, .manage-meta dd, .session-head, .sessions-filter-btn, .manage-head button')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < d.left - 0.5 || r.right > d.right + 0.5 || el.scrollWidth > el.clientWidth + 1) clipped.push(el.className + ': ' + el.textContent.trim().slice(0, 40));
  }
  return {
    drawer: { left: d.left, right: d.right, top: d.top, bottom: d.bottom, width: d.width },
    viewport: { width: innerWidth, height: innerHeight },
    overflowX: drawer.scrollWidth > drawer.clientWidth + 1,
    clipped,
  };
})()`;

async function run() {
  if (DIRTY) throw new Error(`worktree has uncommitted tracked changes; commit before proving HEAD:\n${DIRTY}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the seeded sessions fixture; no mocks)`);
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

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
  const press = async key => {
    const text = key === 'Enter' ? '\r' : undefined;
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: key, text, windowsVirtualKeyCode: KEYS[key] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: KEYS[key] });
    await sleep(200);
  };
  const click = selectorExpr => evaluate(`(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const screenshots = [];
  const shot = async (vp, state) => {
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(file, png);
    screenshots.push({ viewport: vp.name, state, file, sha256: crypto.createHash('sha256').update(png).digest('hex') });
    log(`  screenshot ${file}`);
  };
  const noSecrets = async label => {
    const page = await evaluate('document.documentElement.outerHTML + "\\n" + document.body.innerText');
    const found = SECRETS.filter(secret => page.includes(secret));
    return check(found.length === 0, `${label}: no external provider session id in text or DOM${found.length ? ` (found ${found.join(', ')})` : ''}`);
  };
  const rows = () => evaluate(`[...document.querySelectorAll('.sessions-drawer .session-row')].map(li => ({
    title: li.querySelector('.session-title').textContent.trim(),
    status: li.querySelector('.session-status').textContent.trim(),
    meta: Object.fromEntries([...li.querySelectorAll('.manage-meta > div')].map(d => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()])),
  }))`);
  const listReady = "document.querySelector('.sessions-drawer .sessions-list')";
  const layout = async (vp, label) => {
    const l = await evaluate(LAYOUT);
    check(!l.overflowX && l.clipped.length === 0, `${label}: no horizontal overflow or clipped content in the drawer${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
    check(l.drawer.left >= -0.5 && l.drawer.right <= l.viewport.width + 0.5 && l.drawer.bottom <= l.viewport.height + 0.5, `${label}: drawer fits the ${vp.width}x${vp.height} viewport (width ${Math.round(l.drawer.width)})`);
  };

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelectorAll('[data-open-bot]').length >= 3", 'roster rows');
    await click(byText('[data-open-bot]', 'Dev'));
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Dev'", 'Dev thread');
    await sleep(500);

    // Keyboard: Config link, then Tab to Sessions, Enter opens.
    await evaluate(`${byText('.thread-bar a', 'Config')}.focus()`);
    await press('Tab');
    let f = await evaluate(FOCUS);
    check(f.name === 'Sessions' && f.focusVisible && f.outline.startsWith('solid') && f.expanded === 'false', `Tab from Config reaches Sessions with a visible focus ring (${f.outline})`);
    await shot(vp, 'sessions-focus');
    await press('Enter');
    await waitFor("document.querySelector('.sessions-drawer')", 'Sessions drawer');
    f = await evaluate(FOCUS);
    check(f.inDrawer && f.name === 'Close', 'Enter opens the drawer and focus moves into it (Close)');
    await waitFor(listReady, 'session list');
    const all = await rows();
    check(all.length === 7, `All lists every canonical binding of Dev (${all.length})`);
    check(all.filter(r => r.status === 'Active').length === 5 && all.filter(r => r.status === 'Ended').length === 2, 'five active and two ended sessions');
    check(all[0].title === 'Add the session catalog read model' && all[0].status === 'Active' && all[0].meta.Origin === 'Tank thread'
      && all[0].meta['Work request'] === 'Implementation · completed' && all[0].meta.Workspace === '/Users/owner/work/botmancers',
      'newest activity first: the resumed implementation, with origin thread, work request, and stored workspace');
    check(all.some(r => r.title === 'Group Design review') && all.some(r => /^Dev · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(r.title)), 'group and fallback titles are recognizable');
    check(all.every(r => r.meta['Last activity'] && r.meta.Origin), 'every row shows last activity and origin');
    const reqOnly = all.find(r => r.title === 'Explain the session binding lifecycle');
    const convOnly = all.find(r => r.title === 'Summarize the open review threads');
    check(!!reqOnly && reqOnly.meta.Origin === 'Dev thread' && reqOnly.meta['Work request'] === 'Conversation · completed',
      'a request-only binding shows its Work Request\'s source thread');
    check(!!convOnly && convOnly.meta.Origin === 'Tank thread' && convOnly.meta['Work request'] === 'Review · completed' && convOnly.meta.Workspace === '/Users/owner/work/botmancers',
      'a conversation-only binding shows its source Attempt\'s Work Request and workspace');
    check(await evaluate("document.querySelectorAll('.sessions-drawer input, .sessions-drawer textarea, .sessions-drawer [contenteditable]').length === 0"), 'no raw ID entry in the drawer');
    await noSecrets('All');
    await layout(vp, 'All');
    await shot(vp, 'sessions-all');

    await click(byText('.sessions-filter-btn', 'Ended'));
    await waitFor(`${listReady} && document.querySelectorAll('.sessions-drawer .session-row').length === 2`, 'ended list');
    const ended = await rows();
    check(ended.length === 2 && ended.every(r => r.status === 'Ended' && r.meta.Ended), 'Ended shows only released sessions, with their end time');
    await layout(vp, 'Ended');
    await shot(vp, 'sessions-ended');
    await click(byText('.sessions-filter-btn', 'Active'));
    await waitFor(`${listReady} && document.querySelectorAll('.sessions-drawer .session-row').length === 5`, 'active list');
    check((await rows()).every(r => r.status === 'Active'), 'Active shows only unreleased sessions');
    await click(byText('.sessions-filter-btn', 'All'));
    await waitFor(`${listReady} && document.querySelectorAll('.sessions-drawer .session-row').length === 7`, 'all list again');

    await click("document.querySelector('.sessions-drawer .session-row .session-toggle')");
    await waitFor("document.querySelectorAll('.session-attempts li').length === 2", 'session details');
    const runs = await evaluate("[...document.querySelectorAll('.session-attempts li')].map(li => li.textContent.trim())");
    check(/Started the session · succeeded/.test(runs[0]) && /Resumed the session · succeeded/.test(runs[1]), 'Details lists the run that started the session and the one that resumed it');
    check(await evaluate("document.querySelector('.session-debug').open === false"), 'the local debug disclosure starts closed');
    await noSecrets('Details');
    await layout(vp, 'Details');
    await shot(vp, 'session-details');

    if (!vp.mobile) {
      await click("document.querySelector('.session-debug summary')");
      await waitFor("document.querySelector('.session-debug-value code')", 'debug value');
      const debug = await evaluate("({ label: document.querySelector('.session-debug summary').textContent.trim(), value: document.querySelector('.session-debug-value code').textContent.trim(), copy: document.querySelector('.session-debug-value button').textContent.trim() })");
      check(debug.label === 'Local debug: provider session ID' && debug.value === EXTERNAL_IDS.implementation && debug.copy === 'Copy',
        'only the explicitly labeled local debug disclosure reveals the provider session id, with a Copy action');
      await shot(vp, 'debug-disclosure');
    }

    await press('Escape');
    check(await evaluate("!document.querySelector('.sessions-drawer')"), 'Escape closes the drawer');
    await sleep(200);
    f = await evaluate(FOCUS);
    check(f.name === 'Sessions', 'focus returns to Sessions');
    await noSecrets('Closed');

    // Follow the origin back to Tank's thread.
    await click("document.querySelector('.thread-bar [aria-haspopup=\"dialog\"]')");
    await waitFor(listReady, 'session list (reopened)');
    await click(byText('.session-link', 'Tank thread'));
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Tank'", 'Tank thread');
    check(await evaluate("!document.querySelector('.sessions-drawer')"), 'the origin link opens the source thread (Tank) and closes the drawer');
    await shot(vp, 'origin-thread');
    await click("document.querySelector('.thread-bar [aria-haspopup=\"dialog\"]')");
    await waitFor(listReady, 'Tank session list');
    const empty = await evaluate("document.querySelector('.sessions-drawer .sessions-list').textContent.trim()");
    check(/Tank has no sessions yet/.test(empty), 'an Agent without bindings shows the empty state');
    await layout(vp, 'Empty');
    await shot(vp, 'sessions-empty');
    await press('Escape');
  }

  cdp.close();
  chrome.proc.kill();
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'sessions-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'sessions-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, mocks: false, result: failures === 0 ? 'pass' : 'fail', failures,
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
