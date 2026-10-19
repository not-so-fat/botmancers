#!/usr/bin/env node
// NOT-509: real-browser proof of reported session usage in the Sessions
// drawer. Drives a running Botmancers seeded with
// scripts/seed-usage-fixture.js through headless Chrome over the DevTools
// protocol, at desktop and narrow widths:
// - open Ledger's Sessions; each row shows "Reported usage": the Claude
//   session its complete tokens and cost, the Codex session tokens with
//   "cost not reported" (no dollar value), the partial session a Partial
//   tag, the $0 session "$0.00", the pre-usage session "Not reported";
// - Details of the Claude session lists per-run usage and full totals;
//   Details of the partial session shows the unreported run as Not reported
//   and the Partial coverage line;
// - no drawer content is clipped or overflows horizontally, and no
//   provider session id appears in the page.
// Writes screenshots, a trace, and session-usage-proof-receipt.json (HEAD,
// clean tree, viewports, sha256 of every screenshot) under --out. Refuses
// to run on a dirty worktree so the receipt binds to the committed HEAD.
// No mocks.
//
// Usage: node scripts/seed-usage-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/usage-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43509   (other shell)
//        node scripts/ui-session-usage-proof.js [--url http://127.0.0.1:43509] [--out .agent-dealer-visual-qa]
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
const URL_BASE = arg('--url', 'http://127.0.0.1:43509');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const TITLES = {
  claude: 'Migrate the settings page to the new form kit',
  codex: 'Fix the flaky exchange ledger test',
  partial: 'Investigate the restart reconciliation gap',
  zero: 'Rename the avatar helpers',
};

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-usage-proof-'));
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

const LAYOUT = `(() => {
  const drawer = document.querySelector('.sessions-drawer');
  const d = drawer.getBoundingClientRect();
  const clipped = [];
  for (const el of drawer.querySelectorAll('.session-row, .manage-meta dd, .session-usage-totals dd, .session-usage-runs li, .session-usage-values')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < d.left - 0.5 || r.right > d.right + 0.5 || el.scrollWidth > el.clientWidth + 1) clipped.push(el.className + ': ' + el.textContent.trim().slice(0, 40));
  }
  return { overflowX: drawer.scrollWidth > drawer.clientWidth + 1, clipped };
})()`;

async function run() {
  if (DIRTY) throw new Error(`worktree has uncommitted tracked changes; commit before proving HEAD:\n${DIRTY}`);
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the seeded usage fixture; no mocks)`);
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
  const waitFor = async (expression, label, ms = 20000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const click = selectorExpr => evaluate(`(() => { const el = ${selectorExpr}; if (!el) return false; el.click(); return true; })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const rowOf = title => `[...document.querySelectorAll('.sessions-drawer .session-row')].find(li => li.querySelector('.session-title').textContent.trim() === ${JSON.stringify(title)})`;
  const screenshots = [];
  const shot = async (vp, state, clipTo = null) => {
    if (clipTo) await evaluate(`${clipTo}.scrollIntoView({ block: 'start' })`);
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(file, png);
    screenshots.push({ viewport: vp.name, state, file, sha256: crypto.createHash('sha256').update(png).digest('hex') });
    log(`  screenshot ${file}`);
  };
  const layout = async label => {
    const l = await evaluate(LAYOUT);
    check(!l.overflowX && l.clipped.length === 0, `${label}: no horizontal overflow or clipped content${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
  };
  const noSecrets = async label => {
    const page = await evaluate('document.documentElement.outerHTML');
    check(!/SECRET/.test(page), `${label}: no provider session id in the page`);
  };

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor("document.querySelectorAll('[data-open-bot]').length >= 1", 'roster rows');
    await click(byText('[data-open-bot]', 'Ledger'));
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Ledger'", 'Ledger thread');
    await sleep(500);
    await click(byText('.thread-bar button', 'Sessions'));
    await waitFor("document.querySelectorAll('.sessions-drawer .session-row').length === 5", 'five Ledger sessions');
    const usageOf = async title => evaluate(`(() => {
      const li = ${rowOf(title)};
      const d = [...li.querySelectorAll('.manage-meta > div')].find(div => div.querySelector('dt').textContent.trim() === 'Reported usage');
      return { visible: d.querySelector('.session-usage').textContent.trim(), sr: d.querySelector('.session-sr').textContent.trim(), partial: !!d.querySelector('.session-usage-tag') };
    })()`);
    const claude = await usageOf(TITLES.claude);
    check(claude.visible === '1.2M in · 45.7k out · $3.34' && !claude.partial, `Claude row: complete "${claude.visible}"`);
    const codex = await usageOf(TITLES.codex);
    check(codex.visible === '52.3k in · 7.9k out · cost not reported' && !codex.visible.includes('$') && !codex.partial, `Codex row: token-only "${codex.visible}", no dollar value`);
    const partial = await usageOf(TITLES.partial);
    check(partial.visible === '9.9k in · 1.2k out · cost not reported' && partial.partial && /partial, reported by 1 of 2 runs/.test(partial.sr),
      `partial row: "${partial.visible}" with a Partial tag and coverage for screen readers`);
    const zero = await usageOf(TITLES.zero);
    check(zero.visible === '640 in · 128 out · $0.00', `reported-zero row: "${zero.visible}"`);
    const legacy = await usageOf(await evaluate("[...document.querySelectorAll('.sessions-drawer .session-title')].map(el => el.textContent.trim()).find(t => t.startsWith('Ledger · '))"));
    check(legacy.visible === 'Not reported' && !legacy.visible.includes('$'), `pre-usage row: "${legacy.visible}"`);
    await noSecrets('rows');
    await layout('rows');
    await shot(vp, 'usage-rows');
    if (vp.mobile) await shot(vp, 'usage-rows-partial', rowOf(TITLES.partial));

    await click(`${rowOf(TITLES.claude)}.querySelector('.session-toggle')`);
    await waitFor("document.querySelectorAll('.session-usage-runs li').length === 2", 'Claude usage details');
    const claudeDetail = await evaluate(`({
      totals: [...document.querySelectorAll('.session-usage-totals > div')].map(d => d.querySelector('dt').textContent.trim() + ': ' + d.querySelector('.session-usage').textContent.trim() + ' / ' + d.querySelector('.session-usage-coverage').textContent.trim()),
      runs: [...document.querySelectorAll('.session-usage-runs li')].map(li => li.textContent.trim()),
    })`);
    check(claudeDetail.totals[0] === 'Input tokens: 1,203,456 / All 2 runs reported' && claudeDetail.totals[2] === 'Cost: $3.34 / All 2 runs reported',
      `Claude details totals: ${claudeDetail.totals.join(' | ')}`);
    check(/Started · run 1.*In 18,240.*Out 3,512.*Cost \$0\.42/.test(claudeDetail.runs[0]) && /Resumed · run 1.*In 1,185,216.*Cost \$2\.92/.test(claudeDetail.runs[1]),
      'Claude details list per-run usage');
    await layout('Claude details');
    await shot(vp, 'usage-details-complete', `${rowOf(TITLES.claude)}.querySelector('.session-usage-detail')`);
    await click(`${rowOf(TITLES.claude)}.querySelector('.session-toggle')`);

    await click(`${rowOf(TITLES.partial)}.querySelector('.session-toggle')`);
    await waitFor("document.querySelectorAll('.session-usage-runs li').length === 2", 'partial usage details');
    const partialDetail = await evaluate(`({
      totals: [...document.querySelectorAll('.session-usage-totals > div')].map(d => d.querySelector('dt').textContent.trim() + ': ' + d.querySelector('.session-usage').textContent.trim() + ' / ' + d.querySelector('.session-usage-coverage').textContent.trim()),
      runs: [...document.querySelectorAll('.session-usage-runs li')].map(li => li.textContent.trim()),
    })`);
    check(partialDetail.totals[0] === 'Input tokens: 9,876 / Partial: 1 of 2 runs reported' && partialDetail.totals[2] === 'Cost: Not reported / Not reported by any of 2 runs',
      `partial details totals: ${partialDetail.totals.join(' | ')}`);
    check(/In Not reported.*Out Not reported.*Cost Not reported/.test(partialDetail.runs[1]) && !/\$/.test(partialDetail.runs.join(' ')),
      'the interrupted run reads Not reported; no dollar value anywhere in the partial session');
    await layout('partial details');
    await noSecrets('details');
    await shot(vp, 'usage-details-partial', `${rowOf(TITLES.partial)}.querySelector('.session-usage-detail')`);
  }

  cdp.close();
  chrome.proc.kill();
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'session-usage-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'session-usage-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, mocks: false, result: failures === 0 ? 'pass' : 'fail', failures,
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
