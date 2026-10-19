#!/usr/bin/env node
// NOT-507: real-browser proof of the three session actions in the Sessions
// drawer. Drives a running Botmancers seeded with scripts/seed-pins-fixture.js
// (a Codex Agent on the deterministic fake codex binary) through headless
// Chrome over the DevTools protocol, at desktop and narrow widths:
// - Forge's past sessions are recognizable by title and tags: the open
//   session offers Ask from this context and Resume work here, the archived
//   one still resumes, the missing one offers nothing and says to choose
//   another session; Hand off to… explains why it is unavailable for a
//   native session;
// - keyboard: Enter on Resume work here opens the dialog with focus in the
//   instruction; Send without the approval is refused with a field error
//   and focus on the approval; with it the turn runs on that exact session,
//   the drawer confirms, and focus returns to the action;
// - the instruction and the session's answer arrive in Forge's thread;
//   Ask from this context on the archived session answers there too;
// - no drawer or dialog content is clipped or overflows horizontally, and
//   no provider session id appears in the page.
// Writes screenshots, a trace, and session-pins-proof-receipt.json (HEAD,
// viewports, sha256 of every screenshot) under --out. Refuses a dirty
// worktree so the receipt binds to the committed HEAD. No mocks.
//
// Usage: node scripts/seed-pins-fixture.js   (prints the dev-server command)
//        node scripts/ui-session-pins-proof.js [--url http://127.0.0.1:43507] [--out .agent-dealer-visual-qa]
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg('--url', 'http://127.0.0.1:43507');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const KEYS = { Tab: 9, Enter: 13, Escape: 27, ' ': 32 };
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain').toString().trim();
const TITLES = { open: 'Fix the uploader retry', archived: 'Archived parser spike', missing: 'Old dependency audit' };

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-pins-proof-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, wsUrl: targets.find(t => t.type === 'page').webSocketDebuggerUrl };
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

const LAYOUT = scope => `(() => {
  const box = document.querySelector(${JSON.stringify(scope)});
  const d = box.getBoundingClientRect();
  const clipped = [];
  for (const el of box.querySelectorAll('.session-row, .session-action, .session-unavailable li, .manage-tag, p, label, textarea, .form-actions')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < d.left - 0.5 || r.right > d.right + 0.5 || el.scrollWidth > el.clientWidth + 1) clipped.push(el.className + ': ' + el.textContent.trim().slice(0, 40));
  }
  return { overflowX: box.scrollWidth > box.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
})()`;

async function run() {
  if (DIRTY) throw new Error(`worktree is dirty; commit before proving HEAD:\n${DIRTY}`);
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the seeded pins fixture, fake codex binary; no mocks)`);
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
  const waitFor = async (expression, label, ms = 30000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const press = async key => {
    const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: key === ' ' ? 'Space' : key, text, windowsVirtualKeyCode: KEYS[key] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: KEYS[key] });
    await sleep(200);
  };
  const click = expr => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`);
  const focusEl = expr => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.focus(); return true; })()`);
  const typeText = async text => {
    await cdp.send('Input.insertText', { text });
    await sleep(100);
  };
  const focusName = () => evaluate("(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 60) : ''; })()");
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const rowOf = title => `[...document.querySelectorAll('.sessions-drawer .session-row')].find(li => li.querySelector('.session-title').textContent.trim() === ${JSON.stringify(title)})`;
  const actionOf = (title, action) => `${rowOf(title)}.querySelector('[data-session-action="${action}"]')`;
  const screenshots = [];
  const shot = async (vp, state, scrollTo = null) => {
    if (scrollTo) await evaluate(`${scrollTo}.scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(file, png);
    screenshots.push({ viewport: vp.name, state, file, sha256: crypto.createHash('sha256').update(png).digest('hex') });
    log(`  screenshot ${file}`);
  };
  const layout = async (label, scope) => {
    const l = await evaluate(LAYOUT(scope));
    check(!l.overflowX && l.clipped.length === 0, `${label}: no horizontal overflow or clipped content${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
  };
  const noSecrets = async label => {
    const page = await evaluate('document.documentElement.outerHTML');
    check(!/SECRET/.test(page), `${label}: no provider session id in the page`);
  };
  const openSessions = async () => {
    await click(byText('.thread-bar button', 'Sessions'));
    await waitFor("document.querySelectorAll('.sessions-drawer .session-row').length === 3", 'three Forge sessions');
  };
  const rowInfo = title => evaluate(`(() => {
    const li = ${rowOf(title)};
    return {
      tags: [...li.querySelectorAll('.session-head .manage-tag')].map(t => t.textContent.trim()),
      actions: [...li.querySelectorAll('.session-action')].map(b => b.textContent.trim()),
      reasons: [...li.querySelectorAll('.session-unavailable li')].map(r => r.textContent.trim()),
    };
  })()`);

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelectorAll('[data-open-bot]').length >= 1", 'roster rows', 180000);
    await click(byText('[data-open-bot]', 'Forge'));
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Forge'", 'Forge thread');
    await sleep(500);
    await openSessions();

    const open = await rowInfo(TITLES.open);
    check(open.actions.join('|') === 'Ask from this context|Resume work here' && open.reasons.length === 1 && /^Hand off to… is unavailable/.test(open.reasons[0]),
      `open session: ${open.actions.join(', ')}; ${open.reasons[0]}`);
    const archived = await rowInfo(TITLES.archived);
    check(archived.tags.includes('Archived') && archived.actions.join('|') === 'Ask from this context|Resume work here', `archived session: tags ${archived.tags.join(', ')}; still resumes`);
    const missing = await rowInfo(TITLES.missing);
    check(missing.tags.join() === 'Missing' && missing.actions.length === 0 && missing.reasons.slice(0, 2).every(r => /choose another session/.test(r)),
      `missing session: no action; "${missing.reasons[0]}"`);
    check(!(await evaluate("document.querySelector('.sessions-drawer').innerText")).match(/Ask this session|Continue with/), 'the old Ask this session / Continue with… copy is gone');
    await noSecrets('session rows');
    await layout('session rows', '.sessions-drawer');
    await shot(vp, 'sessions-actions');
    if (vp.mobile) await shot(vp, 'sessions-missing', rowOf(TITLES.missing));

    log('Resume work here: keyboard, approval, exact session');
    await focusEl(actionOf(TITLES.open, 'resume'));
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog[data-exchange-mode=\"resume\"]')", 'Resume dialog');
    check(await evaluate("document.querySelector('.exchange-dialog h2').textContent === 'Resume work here' && document.activeElement === document.querySelector('.exchange-dialog textarea')"),
      'Enter opens Resume work here with focus in the instruction');
    check(await evaluate("document.querySelector('.sessions-drawer').inert === true"), 'the drawer is inert under the dialog');
    await typeText(vp.mobile ? 'Add the missing upload test' : 'Finish the retry tests');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await sleep(300);
    check(await evaluate("document.activeElement?.type === 'checkbox' && document.querySelector('.exchange-dialog').innerText.includes('Approve edits in this session to resume work here.')"),
      'Send without approval: refused with a field error, focus on the approval');
    await layout('Resume dialog', '.exchange-dialog');
    await shot(vp, 'resume-approval-required');
    await press(' ');
    check(await evaluate("document.querySelector('.exchange-dialog input[type=checkbox]').checked"), 'Space ticks the approval');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await waitFor("!document.querySelector('.exchange-dialog')", 'Resume sent', 30000);
    const started = await evaluate("document.querySelector('.exchange-started').textContent.trim()");
    check(/^Resumed work in Forge’s session/.test(started), `drawer confirms: "${started}"`);
    await sleep(200);
    check((await focusName()) === 'Resume work here', 'focus returns to Resume work here');
    await noSecrets('after Resume');

    if (!vp.mobile) {
      log('Ask from this context on the archived session');
      await focusEl(actionOf(TITLES.archived, 'ask'));
      await press('Enter');
      await waitFor("document.querySelector('.exchange-dialog[data-exchange-mode=\"ask\"]')", 'Ask dialog');
      check(await evaluate("document.querySelector('.exchange-dialog h2').textContent === 'Ask from this context' && document.querySelector('.exchange-dialog').innerText.includes('this exact session, read-only')"),
        'Ask from this context: read-only on this exact session');
      await typeText('What did the spike conclude?');
      await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
      await waitFor("!document.querySelector('.exchange-dialog')", 'Ask sent', 30000);
      check(/^Asked Forge’s session/.test(await evaluate("document.querySelector('.exchange-started').textContent.trim()")), 'drawer confirms the Ask');
      await press('Escape');
      await waitFor("!document.querySelector('.sessions-drawer')", 'drawer closed');
      await waitFor("document.querySelector('.messages')?.innerText.includes('What did the spike conclude?')", 'Ask in thread');
      const thread = await evaluate("document.querySelector('.messages').innerText");
      check(thread.includes('Finish the retry tests') && thread.includes('What did the spike conclude?'), 'both turns appear in Forge’s thread');
      const answered = await waitFor("document.querySelectorAll('.messages .message-row, .messages [data-message-id]').length >= 4 || (document.querySelector('.messages').innerText.match(/fake|Done|reply|ok/i))", 'answers in thread', 30000);
      check(answered, 'the sessions’ answers arrive in Forge’s thread');
      await noSecrets('thread');
      await shot(vp, 'thread-after-resume-and-ask');
    } else {
      await press('Escape');
    }
  }

  cdp.close();
  chrome.proc.kill();
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'session-pins-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'session-pins-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, mocks: false, result: failures === 0 ? 'pass' : 'fail', failures,
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
