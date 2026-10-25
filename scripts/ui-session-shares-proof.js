#!/usr/bin/env node
// NOT-519: real-browser proof of the owner's session-share lifecycle.
// Drives a running Botmancers seeded with scripts/seed-shares-fixture.js
// (Forge on the deterministic fake codex binary, an owner share policy, and
// shares in the ended and degraded states) through headless Chrome over the
// DevTools protocol, at desktop and narrow widths:
// - Sessions: each row's Slack share section names the exact session and
//   audience; the open session lists its expired and revoked shares and
//   offers Share to Slack; the archived one shows a used-up share (thread
//   posted) and a recovering one; the missing one offers no share and says
//   why;
// - Share to Slack on the open session creates an active share (waiting
//   for its thread); Revoke asks for confirmation, then the share reads
//   Revoked;
// - Agent Config: Session sharing shows the share_from_turn switch and the
//   allowlist; switching it off reports it; a malformed channel id is
//   refused before anything is sent; a valid one is added, then removed;
// - nothing is clipped or overflows horizontally, and no provider session
//   id, workspace path, or token appears in a share section.
// Writes screenshots, a trace, and session-shares-proof-receipt.json (HEAD,
// viewports, sha256 of every screenshot) under --out. Refuses a dirty
// worktree so the receipt binds to the committed HEAD. No mocks.
//
// Usage: node scripts/seed-shares-fixture.js   (prints the dev-server command)
//        node scripts/ui-session-shares-proof.js [--url http://127.0.0.1:43519] [--out .agent-dealer-visual-qa]
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
const URL_BASE = arg('--url', 'http://127.0.0.1:43519');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const HEAD = execSync('git rev-parse HEAD').toString().trim();
// `next dev` rewrites next-env.d.ts while it serves; nothing else may differ.
const DIRTY = execSync('git status --porcelain').toString().split('\n').filter(line => line.trim() && !line.endsWith(' next-env.d.ts')).join('\n');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-shares-proof-'));
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
  for (const el of box.querySelectorAll('.session-share, .session-action, .manage-tag, .session-share-form select, .session-share-form input, p, label, .share-policy-entry, .cfg-input, button')) {
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
  log(`app ${URL_BASE} (real Next.js app on the seeded shares fixture, fake codex binary; no mocks)`);
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
  const click = expr => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`);
  const setValue = (expr, value) => evaluate(`(() => {
    const el = ${expr};
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return true;
  })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const rowOf = title => `[...document.querySelectorAll('.sessions-drawer .session-row')].find(li => li.querySelector('.session-title').textContent.trim() === ${JSON.stringify(title)})`;
  const sharesOf = title => `${rowOf(title)}.querySelector('.session-shares')`;
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
  const noPrivate = async (label, selector) => {
    const page = await evaluate('document.documentElement.outerHTML');
    const sections = await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => el.outerHTML).join('')`);
    check(!/SECRET/.test(page) && sections.length > 0 && !/shares-fixture-work|\/Users\/|bmsc_|xoxb|xapp|codex-direct/.test(sections),
      `${label}: no provider session id in the page; no workspace, runtime, or token in the share sections`);
  };
  const shareInfo = title => evaluate(`(() => {
    const box = ${sharesOf(title)};
    return {
      statuses: [...box.querySelectorAll('[data-share-status]')].map(li => li.dataset.shareStatus),
      create: !!box.querySelector('[data-share-action="create"]'),
      revokes: box.querySelectorAll('[data-share-action="revoke"]').length,
      text: box.innerText,
    };
  })()`);
  const agents = await (await fetch(`${URL_BASE}/api/bots`)).json();
  const forge = (Array.isArray(agents) ? agents : agents.bots).find(bot => bot.name === 'Forge');

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelectorAll('[data-open-bot]').length >= 1", 'roster rows', 180000);
    await click(byText('[data-open-bot]', 'Forge'));
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Forge'", 'Forge thread');
    await sleep(500);
    await click(byText('.thread-bar button', 'Sessions'));
    await waitFor("document.querySelectorAll('.sessions-drawer .session-row').length === 3", 'three Forge sessions');
    await waitFor(`${sharesOf(TITLES.archived)}?.querySelectorAll('[data-share-status]').length >= 2`, 'seeded shares');

    const open = await shareInfo(TITLES.open);
    const ended = open.statuses.filter(s => s === 'expired' || s === 'revoked');
    check(open.create && ended.includes('expired') && ended.includes('revoked') && /Expired /.test(open.text) && /Revoked /.test(open.text),
      `open session: Share to Slack offered; history ${open.statuses.join(', ')}`);
    const archived = await shareInfo(TITLES.archived);
    check(archived.statuses.includes('exhausted') && archived.statuses.includes('recovering') && archived.revokes === 2
      && /3 of 3 questions used/.test(archived.text) && /Slack thread posted/.test(archived.text) && /interrupted by a Botmancers restart/.test(archived.text),
      `archived session: ${archived.statuses.join(', ')}, both revocable, thread posted, recovery explained`);
    check(/Slack channel C0RELEASE · workspace T0BMDEMO1/.test(archived.text), 'the audience is named by its Slack channel and workspace');
    const missing = await shareInfo(TITLES.missing);
    check(!missing.create && /Share to Slack is unavailable: the runtime no longer has this session/.test(missing.text),
      `missing session: no Share to Slack; "${missing.text.split('\n').find(l => /unavailable/.test(l))}"`);
    await noPrivate('session shares', '.session-shares');
    await layout('Sessions drawer with shares', '.sessions-drawer');
    await shot(vp, 'sessions-share-states', vp.mobile ? sharesOf(TITLES.open) : null);
    await shot(vp, 'sessions-share-exhausted-recovering', sharesOf(TITLES.archived));

    log('Share to Slack on the open session');
    await click(`${sharesOf(TITLES.open)}.querySelector('[data-share-action="create"]')`);
    await waitFor(`${sharesOf(TITLES.open)}.querySelector('.session-share-form')`, 'share form');
    const form = await evaluate(`${sharesOf(TITLES.open)}.querySelector('.session-share-form').innerText`);
    check(form.includes(TITLES.open) && form.includes('Forge') && /read-only Ask/.test(form), 'the form names the exact session and Agent, read-only');
    await setValue(`${sharesOf(TITLES.open)}.querySelectorAll('.session-share-form select')[0]`, '1');
    await setValue(`${sharesOf(TITLES.open)}.querySelectorAll('.session-share-form select')[1]`, '28800');
    await setValue(`${sharesOf(TITLES.open)}.querySelector('.session-share-form input')`, '0');
    await sleep(200);
    check(await evaluate(`${sharesOf(TITLES.open)}.querySelector('[data-share-action="submit"]').disabled && /whole number from 1 to 100/.test(${sharesOf(TITLES.open)}.innerText)`),
      'zero questions: refused in the form, Create share disabled');
    await setValue(`${sharesOf(TITLES.open)}.querySelector('.session-share-form input')`, '5');
    await layout('share form', '.sessions-drawer');
    await shot(vp, 'share-create-form', sharesOf(TITLES.open));
    await click(`${sharesOf(TITLES.open)}.querySelector('[data-share-action="submit"]')`);
    await waitFor(`${sharesOf(TITLES.open)}.querySelector('[data-share-status="active"]')`, 'active share', 30000);
    const created = await shareInfo(TITLES.open);
    check(created.statuses[0] === 'active' && /Slack channel C0RELEASE/.test(created.text) && /0 of 5 questions used/.test(created.text)
      && /Waiting for the Slack relay to post the thread/.test(created.text) && /Expires .*\(in (7 h 59 min|8 h)\)/.test(created.text),
      'created: Active, the chosen channel, 0 of 5 questions, 8 hours, waiting for its thread');
    await noPrivate('after create', '.session-shares');
    await shot(vp, 'share-created', sharesOf(TITLES.open));

    log('Revoke it');
    const liveItem = `${sharesOf(TITLES.open)}.querySelector('[data-share-status="active"]')`;
    await click(`${liveItem}.querySelector('[data-share-action="revoke"]')`);
    await waitFor(`${liveItem}.querySelector('[data-share-action="confirm-revoke"]')`, 'revoke confirmation');
    check(/next Slack question in its thread gets the revoked notice/.test(await evaluate(`${liveItem}.innerText`)), 'Revoke asks for confirmation and says what happens next');
    await shot(vp, 'share-revoke-confirm', liveItem);
    const ref = await evaluate(`${liveItem}.dataset.shareRef`);
    await click(`${liveItem}.querySelector('[data-share-action="confirm-revoke"]')`);
    await waitFor(`${sharesOf(TITLES.open)}.querySelector('[data-share-ref="${ref}"][data-share-status="revoked"]')`, 'revoked share', 30000);
    const after = await shareInfo(TITLES.open);
    check(!after.statuses.includes('active') && after.create, 'revoked: no live share left; Share to Slack offered again');
    await shot(vp, 'share-revoked', `${sharesOf(TITLES.open)}.querySelector('[data-share-ref="${ref}"]')`);

    log('Agent Config: Session sharing');
    await cdp.send('Page.navigate', { url: `${URL_BASE}/bots/${forge.id}/config` });
    await waitFor("document.querySelector('#session-sharing [data-share-policy=\"share_from_turn\"]')", 'Session sharing card', 120000);
    const card = '#session-sharing';
    const before = await evaluate(`({ on: document.querySelector('${card} [role=switch]').checked, channels: document.querySelectorAll('${card} .share-policy-entry').length })`);
    check(before.channels === 2, `the allowlist lists the two seeded channels (share_from_turn ${before.on ? 'on' : 'off'})`);
    await layout('Session sharing card', card);
    await shot(vp, 'agent-sharing-policy', card);
    await click(`document.querySelector('${card} [role=switch]')`);
    await waitFor(`document.querySelector('${card} [role=switch]').checked === ${!before.on} && /Share from a turn is ${before.on ? 'off' : 'on'}/.test(document.querySelector('${card}').innerText)`, 'toggle saved');
    check(true, `share_from_turn switched ${before.on ? 'off' : 'on'} and saved`);
    if (before.on) await shot(vp, 'agent-sharing-toggle-off', card);
    const inputs = `document.querySelectorAll('${card} .share-policy-add input')`;
    await setValue(`${inputs}[0]`, 'T0BMDEMO1');
    await setValue(`${inputs}[1]`, 'general');
    await click(`document.querySelector('${card} .share-policy-add button[type=submit]')`);
    await waitFor(`/Channel ID must look like/.test(document.querySelector('${card}').innerText)`, 'channel validation');
    check(await evaluate(`document.querySelectorAll('${card} .share-policy-entry').length === 2`), 'a malformed channel id is refused before anything is sent');
    await shot(vp, 'agent-allowlist-invalid', card);
    await setValue(`${inputs}[1]`, vp.mobile ? 'C0MOBILE1' : 'C0DESKTOP');
    await click(`document.querySelector('${card} .share-policy-add button[type=submit]')`);
    await waitFor(`document.querySelectorAll('${card} .share-policy-entry').length === 3`, 'channel added');
    check(true, 'a valid channel is added to the allowlist');
    await layout('Session sharing card after add', card);
    await shot(vp, 'agent-allowlist-added', card);
    // Restore the seeded policy for the next viewport.
    await click(`[...document.querySelectorAll('${card} .share-policy-remove')].at(-1)`);
    await waitFor(`document.querySelectorAll('${card} .share-policy-entry').length === 2`, 'channel removed');
    await click(`document.querySelector('${card} [role=switch]')`);
    await waitFor(`document.querySelector('${card} [role=switch]').checked === ${before.on}`, 'toggle restored');
  }

  cdp.close();
  chrome.proc.kill();
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'session-shares-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'session-shares-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, mocks: false, result: failures === 0 ? 'pass' : 'fail', failures,
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
