#!/usr/bin/env node
// NOT-548: real-browser proof of the paged, searchable Sessions drawer.
// Seeds the 788-row session-list fixture (test-support/session-list-fixture.js,
// Agent "Claude") into the running app's database (via --db, the same
// BOTMANCERS_DB_PATH the app serves), then drives headless Chrome over the
// DevTools protocol at desktop and narrow widths:
// - first page: 50 recognizable rows (title + workspace folder + last
//   activity) and a Load more control;
// - Load more: 100 rows;
// - search "pong": exactly the "Reply with exactly: pong" row;
// - workspace filter (/Users/owner/work/shop): only that workspace's rows;
// - a search that matches nothing: the truthful empty state with Clear search.
// Every state checks the row count, no horizontal overflow or clipped drawer
// content (especially at 390 px), and captures a screenshot. Writes
// screenshots, a trace, a receipt, and a summary under --out (default
// docs/evidence/NOT-548). Refuses to run on a dirty worktree so the receipt
// binds to exactly the committed HEAD. No mocks.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/session-list-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43548   (other shell)
//        node scripts/ui-session-list-proof.js [--url http://127.0.0.1:43548] [--out docs/evidence/NOT-548] [--db .temporal/session-list-fixture.db]
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
const URL_BASE = arg('--url', 'http://127.0.0.1:43548');
const OUT = arg('--out', path.join('docs', 'evidence', 'NOT-548'));
const DB_PATH = path.resolve(arg('--db', path.join('.temporal', 'session-list-fixture.db')));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().split('\n')
  .filter(line => line.trim() && !line.endsWith(' next-env.d.ts')).join('\n');

const AGENT = 'Claude';
const SEARCH_FRAGMENT = 'pong';
const FILTER_WORKSPACE = '/Users/owner/work/shop';

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

function seed() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
  const dbModule = jiti('../lib/db.ts');
  const db = dbModule.default;
  const names = [AGENT, 'Archivist'];
  const existing = db.prepare(`SELECT id FROM bots WHERE name IN (${names.map(() => '?').join(',')})`).all(...names);
  for (const row of existing) db.prepare('DELETE FROM provider_sessions WHERE agent_id = ?').run(row.id);
  if (existing.length > 0) dbModule.bots.removeMany(existing.map(row => row.id));
  const { seedSessionList } = require('../test-support/session-list-fixture');
  const fixture = seedSessionList(dbModule);
  const filtered = fixture.sessions.filter(s => s.workspace === FILTER_WORKSPACE).length;
  db.close();
  log(`Seeded ${DB_PATH}: ${AGENT} with ${fixture.sessions.length} sessions (${filtered} in ${FILTER_WORKSPACE}).`);
  return { total: fixture.sessions.length, filtered };
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-list-proof-'));
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

const LAYOUT = `(() => {
  const drawer = document.querySelector('.sessions-drawer');
  const d = drawer.getBoundingClientRect();
  const clipped = [];
  for (const el of drawer.querySelectorAll('.sessions-filter-btn, .manage-count, .exchange-started, .sessions-state, .session-link, .pin-word, .sessions-search, .sessions-workspace, .sessions-more, .session-title, .session-workspace, .session-activity')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < d.left - 0.5 || r.right > d.right + 0.5 || el.scrollWidth > el.clientWidth + 1) clipped.push(el.className + ': ' + el.textContent.trim().slice(0, 60));
  }
  return {
    drawer: { left: d.left, right: d.right, top: d.top, bottom: d.bottom, width: d.width },
    viewport: { width: innerWidth, height: innerHeight },
    overflowX: drawer.scrollWidth > drawer.clientWidth + 1,
    clipped,
  };
})()`;

const ROW_COUNT = "document.querySelectorAll('.sessions-drawer .session-row').length";
const SHOWN_COUNT = "document.querySelector('.sessions-drawer .manage-count')?.textContent.trim() ?? ''";
const HAS_LOAD_MORE = "[...document.querySelectorAll('.sessions-drawer .sessions-more button')].some(b => b.textContent.trim() === 'Load more')";

async function run() {
  if (DIRTY) throw new Error(`worktree has uncommitted tracked changes; commit before proving HEAD:\n${DIRTY}`);
  const expected = seed();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the 788-row session-list fixture; no mocks)`);
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
  const setSearch = value => evaluate(`(() => {
    const input = document.querySelector('.sessions-drawer .sessions-search');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const setWorkspace = value => evaluate(`(() => {
    const select = document.querySelector('.sessions-drawer .sessions-workspace');
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const screenshots = [];
  const shot = async (vp, state) => {
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(file, png);
    screenshots.push({ viewport: vp.name, state, file: path.basename(file), sha256: crypto.createHash('sha256').update(png).digest('hex') });
    log(`  screenshot ${file}`);
  };
  const layout = async (vp, label) => {
    const l = await evaluate(LAYOUT);
    check(!l.overflowX && l.clipped.length === 0, `${label}: no horizontal overflow or clipped drawer content${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
    check(l.drawer.left >= -0.5 && l.drawer.right <= l.viewport.width + 0.5 && l.drawer.bottom <= l.viewport.height + 0.5, `${label}: drawer fits the ${vp.width}x${vp.height} viewport`);
  };
  const openDrawer = async () => {
    await click(byText('[data-open-bot]', AGENT));
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(AGENT)}`, `${AGENT} thread`);
    await sleep(300);
    await click("document.querySelector('.thread-bar [aria-haspopup=\"dialog\"]')");
    await waitFor("document.querySelector('.sessions-drawer .sessions-list')", `${AGENT} session list`);
  };
  const rowCounts = {};

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor(`[...document.querySelectorAll('[data-open-bot]')].some(el => el.textContent.trim() === ${JSON.stringify(AGENT)})`, 'session-list fixture roster');
    await openDrawer();
    await waitFor(`${ROW_COUNT} > 0`, 'first page rows');

    const firstRows = await evaluate(ROW_COUNT);
    const firstShown = await evaluate(SHOWN_COUNT);
    log(`  rows: first page ${firstRows} (${firstShown})`);
    check(firstRows === 50 && firstShown === '50 shown', `first page renders 50 of ${expected.total} rows (${firstRows}, "${firstShown}")`);
    check(await evaluate(HAS_LOAD_MORE), 'first page offers Load more');
    const head = await evaluate(`(() => {
      const row = document.querySelector('.sessions-drawer .session-row .session-head');
      return { title: row?.querySelector('.session-title')?.textContent.trim() ?? '', folder: row?.querySelector('.session-workspace')?.textContent.trim() ?? '', activity: row?.querySelector('.session-activity')?.textContent.trim() ?? '' };
    })()`);
    check(head.title.length > 0 && head.folder.length > 0 && head.activity.length > 0,
      `rows are recognizable: title plus workspace folder plus last activity ("${head.title}" · ${head.folder} · ${head.activity})`);
    check(await evaluate("!!document.querySelector('.sessions-drawer .sessions-search') && !!document.querySelector('.sessions-drawer .sessions-workspace')"),
      'search box and workspace filter sit beside the status filter');
    await layout(vp, 'first-page');
    await shot(vp, 'first-page');

    await click(byText('.sessions-drawer .sessions-more button', 'Load more'));
    await waitFor(`${ROW_COUNT} === 100`, 'second page rows');
    const moreRows = await evaluate(ROW_COUNT);
    log(`  rows: after Load more ${moreRows}`);
    check(moreRows === 100 && await evaluate(HAS_LOAD_MORE), 'Load more appends the next page (100 rows, more remain)');
    await layout(vp, 'load-more');
    await shot(vp, 'load-more');

    check(await setSearch(SEARCH_FRAGMENT), 'search box accepts input');
    await waitFor(`${ROW_COUNT} === 1`, 'search results');
    const searchTitle = await evaluate("document.querySelector('.sessions-drawer .session-row .session-title')?.textContent.trim() ?? ''");
    const searchShown = await evaluate(SHOWN_COUNT);
    log(`  rows: search "${SEARCH_FRAGMENT}" 1 ("${searchShown}")`);
    check(searchTitle === 'Reply with exactly: pong' && searchShown === '1 shown' && !await evaluate(HAS_LOAD_MORE),
      `a title fragment narrows the list to the matching session ("${searchTitle}")`);
    await layout(vp, 'search');
    await shot(vp, 'search');
    await setSearch('');

    check(await setWorkspace(FILTER_WORKSPACE), 'workspace filter accepts a workspace');
    await waitFor(`${ROW_COUNT} === ${expected.filtered}`, 'workspace results');
    const filteredRows = await evaluate(ROW_COUNT);
    const filteredShown = await evaluate(SHOWN_COUNT);
    const allInWorkspace = await evaluate(`[...document.querySelectorAll('.sessions-drawer .session-row .session-workspace')].every(el => el.getAttribute('title') === ${JSON.stringify(FILTER_WORKSPACE)})`);
    log(`  rows: workspace filter ${filteredRows} ("${filteredShown}")`);
    check(filteredRows === expected.filtered && allInWorkspace && !await evaluate(HAS_LOAD_MORE),
      `the workspace filter shows only ${FILTER_WORKSPACE} (${filteredRows} rows)`);
    await layout(vp, 'workspace');
    await shot(vp, 'workspace');
    await setWorkspace('');

    await setSearch('no such title fragment xyz');
    await waitFor("document.querySelector('.sessions-drawer .sessions-state')?.textContent.includes('No sessions match')", 'empty search state');
    check(await evaluate("[...document.querySelectorAll('.sessions-drawer .sessions-state button')].some(b => b.textContent.trim() === 'Clear search')"),
      'a search that matches nothing offers Clear search');
    await shot(vp, 'search-empty');
    await click(byText('.sessions-drawer .sessions-state button', 'Clear search'));
    await waitFor(`${ROW_COUNT} === 50`, 'cleared search restores the first page');

    rowCounts[vp.name] = { firstPage: firstRows, afterLoadMore: moreRows, search: 1, workspace: filteredRows };
    await press('Escape');
    check(await evaluate("!document.querySelector('.sessions-drawer')"), 'Escape closes the drawer');
  }

  cdp.close();
  chrome.proc.kill();
  log(`\nrow counts: ${JSON.stringify(rowCounts)}`);
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'session-list-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'session-list-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, db: DB_PATH, mocks: false,
    result: failures === 0 ? 'pass' : 'fail', failures,
    fixture: { agent: AGENT, sessions: expected.total, workspace: FILTER_WORKSPACE, workspaceSessions: expected.filtered },
    states: ['first-page', 'load-more', 'search', 'workspace', 'search-empty'],
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), rowCounts, screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), `# NOT-548 session list proof\n\n- HEAD: ${HEAD}\n- App: ${URL_BASE} (real Next.js app, no mocks)\n- Fixture: ${DB_PATH} (${AGENT}, ${expected.total} sessions)\n- States: first page (50 rows + Load more), Load more (100), search "${SEARCH_FRAGMENT}" (1), workspace filter (${expected.filtered}), empty search with Clear search\n- Viewports: 1440x900, 390x800 (no text overflows at 390 px)\n- Result: ${failures === 0 ? 'pass' : `${failures} failure(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
