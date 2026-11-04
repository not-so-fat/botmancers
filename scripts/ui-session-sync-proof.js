#!/usr/bin/env node
// NOT-547: real-browser proof of session sync status, Refresh, and truthful
// empty states. Seeds four Agents into the running app's database (via
// --db, the same BOTMANCERS_DB_PATH the app serves), then drives headless
// Chrome over the DevTools protocol at desktop and narrow widths:
// - SyncNever (never synced): "has not synced sessions yet", Last synced never;
// - SyncFailed (failed): "Could not read Codex sessions: ..." with Retry;
// - SyncScoped (none in scope): "3 sessions exist outside ..." with a Config link;
// - SyncEmpty (none exist): "has no sessions yet";
// - after Refresh on SyncEmpty: "Synced: 0 imported, 0 updated" and an updated time.
// Every state checks the header (Last synced + Refresh), no horizontal
// overflow or clipped drawer content (especially at 390 px), and captures
// a screenshot. Keyboard: Refresh is Tab-reached and Enter-activated with
// the result announced in role="status"; Retry is Tab-reached (not
// activated, since it would fire a real provider sync). Writes screenshots,
// a trace, a receipt, and a summary under --out (default
// docs/evidence/NOT-547). Refuses to run on a dirty worktree so the receipt
// binds to exactly the committed HEAD. No mocks.
//
// Usage: BOTMANCERS_DB_PATH=.temporal/session-sync-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43547   (other shell)
//        node scripts/ui-session-sync-proof.js [--url http://127.0.0.1:43547] [--out docs/evidence/NOT-547] [--db .temporal/session-sync-fixture.db]
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
const URL_BASE = arg('--url', 'http://127.0.0.1:43547');
const OUT = arg('--out', path.join('docs', 'evidence', 'NOT-547'));
const DB_PATH = path.resolve(arg('--db', path.join('.temporal', 'session-sync-fixture.db')));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x800', width: 390, height: 800, mobile: true },
];
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().split('\n')
  .filter(line => line.trim() && !line.endsWith(' next-env.d.ts')).join('\n');

const AGENTS = [
  { key: 'never', name: 'SyncNever', expect: /has not synced sessions yet/ },
  { key: 'failed', name: 'SyncFailed', expect: /Could not read Codex sessions/ },
  { key: 'scoped', name: 'SyncScoped', expect: /3 sessions exist outside/ },
  { key: 'empty', name: 'SyncEmpty', expect: /has no sessions yet/ },
];

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
  const names = AGENTS.map(a => a.name);
  const existing = db.prepare(`SELECT id FROM bots WHERE name IN (${names.map(() => '?').join(',')})`).all(...names);
  if (existing.length > 0) dbModule.bots.removeMany(existing.map(row => row.id));
  const findConn = (provider, label) => {
    const row = db.prepare('SELECT id FROM runtime_connections WHERE provider = ? AND label = ?').get(provider, label);
    if (row) return row.id;
    return dbModule.runtimeConnections.create({ provider, label, host: 'Proof' }).id;
  };
  const codexConn = findConn('codex', 'Sync proof Codex');
  const hermesConn = findConn('hermes', 'Sync proof Hermes');
  const make = (name, agent, conn, kind, items) => dbModule.bots.create({
    name, title: '', description: '', agent, runtime_connection_id: conn,
    session_scope_kind: kind, session_scope_items: JSON.stringify(items),
    policy_mode: 'read_only', allow_new_sessions: 1, allow_resume_with_edits: 0,
  });
  const never = make('SyncNever', 'codex', codexConn, 'workspaces', ['/work/never']);
  const failed = make('SyncFailed', 'codex', codexConn, 'all_provider_sessions', []);
  const scoped = make('SyncScoped', 'codex', codexConn, 'workspaces', ['/work/empty']);
  const empty = make('SyncEmpty', 'hermes', hermesConn, 'all_provider_sessions', []);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO provider_session_events (id, agent_id, session_ref, turn_id, type, detail, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)');
  insert.run(crypto.randomUUID(), failed.id, 'sync_failed', JSON.stringify({ error_code: 'provider_unavailable' }), now);
  insert.run(crypto.randomUUID(), scoped.id, 'sync_completed', JSON.stringify({ imported: 0, rejected_out_of_scope: 3, complete: true }), now - 5 * 60_000);
  insert.run(crypto.randomUUID(), empty.id, 'sync_completed', JSON.stringify({ imported: 0, rejected_out_of_scope: 0, complete: true }), now - 2 * 60_000);
  db.close();
  log(`Seeded ${DB_PATH}: ${names.join(', ')} (never ${never.id}, failed ${failed.id}, scoped ${scoped.id}, empty ${empty.id})`);
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-sync-proof-'));
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
  for (const el of drawer.querySelectorAll('.sessions-filter-btn, .manage-count, .exchange-started, .sessions-state, .session-link, .pin-word')) {
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

async function run() {
  if (DIRTY) throw new Error(`worktree has uncommitted tracked changes; commit before proving HEAD:\n${DIRTY}`);
  seed();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  log(`app ${URL_BASE} (real Next.js app on the session-sync fixture; no mocks)`);
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
  // Real Tab travel from a deterministic start (the drawer's Close button):
  // proves the control is Tab-reachable without depending on where focus
  // landed when the drawer opened.
  const tabTo = async text => {
    await evaluate("document.querySelector('.sessions-drawer .cancel-btn').focus()");
    for (let i = 0; i < 20; i++) {
      await press('Tab');
      const there = await evaluate(`document.activeElement?.textContent.trim() === ${JSON.stringify(text)} && document.activeElement?.closest('.sessions-drawer') !== null`);
      if (there) return true;
    }
    return false;
  };
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
    check(!l.overflowX && l.clipped.length === 0, `${label}: no horizontal overflow or clipped sync content${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
    check(l.drawer.left >= -0.5 && l.drawer.right <= l.viewport.width + 0.5 && l.drawer.bottom <= l.viewport.height + 0.5, `${label}: drawer fits the ${vp.width}x${vp.height} viewport`);
  };
  const openDrawer = async name => {
    await click(byText('[data-open-bot]', name));
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(name)}`, `${name} thread`);
    await sleep(300);
    await click("document.querySelector('.thread-bar [aria-haspopup=\"dialog\"]')");
    await waitFor("document.querySelector('.sessions-drawer .sessions-list')", `${name} session list`);
  };

  for (const vp of VIEWPORTS) {
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/` });
    await waitFor(`[...document.querySelectorAll('[data-open-bot]')].some(el => el.textContent.trim() === 'SyncEmpty')`, 'sync fixture roster');

    for (const agent of AGENTS) {
      await openDrawer(agent.name);
      const empty = await evaluate("document.querySelector('.sessions-drawer .sessions-list').textContent.trim()");
      check(agent.expect.test(empty), `${agent.key}: empty state matches ${agent.expect} (${empty.slice(0, 90)})`);
      const header = await evaluate("document.querySelector('.sessions-drawer .sessions-filter').textContent.trim()");
      check(/Last synced (never|just now|\d+ (minute|hour|day)s? ago)/.test(header) && header.includes('Refresh'),
        `${agent.key}: header shows Last synced with relative time and Refresh (${header.slice(0, 80)})`);
      check(await evaluate("document.querySelector('.sessions-drawer .sessions-filter-btn:not([aria-pressed])')?.textContent.trim() === 'Refresh'"),
        `${agent.key}: Refresh is a labeled button`);
      if (agent.key === 'failed') {
        check(await evaluate("[...document.querySelectorAll('.sessions-drawer .sessions-state button')].some(b => b.textContent.trim() === 'Retry')"),
          'failed: Retry is offered');
        check(await tabTo('Retry'), 'failed: Retry is reachable by Tab');
      }
      if (agent.key === 'scoped') {
        const link = await evaluate("({ text: document.querySelector('.sessions-drawer .sessions-state a')?.textContent.trim() ?? '', href: document.querySelector('.sessions-drawer .sessions-state a')?.getAttribute('href') ?? '' })");
        check(/Widen the scope/.test(link.text) && /\/bots\/.+\/config/.test(link.href), `scoped: Config link to widen the scope (${link.text} ${link.href})`);
      }
      await layout(vp, agent.key);
      await shot(vp, agent.key);
      await press('Escape');
      check(await evaluate("!document.querySelector('.sessions-drawer')"), `${agent.key}: Escape closes the drawer`);
    }

    // After Refresh on the empty Hermes Agent: deterministic empty success,
    // driven by keyboard (Tab to Refresh, Enter to activate).
    await openDrawer('SyncEmpty');
    check(await tabTo('Refresh'), 'after Refresh: Refresh is reachable by Tab');
    await press('Enter');
    await waitFor("document.querySelector('.sessions-drawer .exchange-started[role=\"status\"]')?.textContent.includes('Synced:')", 'sync result');
    const result = await evaluate("document.querySelector('.sessions-drawer .exchange-started[role=\"status\"]').textContent.trim()");
    check(/Synced: 0 imported, 0 updated/.test(result), `after Refresh: imported and updated counts announced (${result})`);
    const headerAfter = await evaluate("document.querySelector('.sessions-drawer .sessions-filter').textContent.trim()");
    check(/Last synced just now/.test(headerAfter), `after Refresh: last-synced time updated (${headerAfter.slice(0, 80)})`);
    await layout(vp, 'after-refresh');
    await shot(vp, 'after-refresh');
    await press('Escape');
  }

  cdp.close();
  chrome.proc.kill();
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'session-sync-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'session-sync-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, db: DB_PATH, mocks: false,
    result: failures === 0 ? 'pass' : 'fail', failures,
    states: [...AGENTS.map(a => a.key), 'after-refresh'],
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`), screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), `# NOT-547 session sync proof\n\n- HEAD: ${HEAD}\n- App: ${URL_BASE} (real Next.js app, no mocks)\n- Fixture: ${DB_PATH} (SyncNever, SyncFailed, SyncScoped, SyncEmpty)\n- States: never, failed with Retry, none in scope with count 3, none exist, after Refresh\n- Viewports: 1440x900, 390x800 (no text overflows at 390 px)\n- Keyboard: Refresh Tab-reached and Enter-activated with the result in role="status"; Retry Tab-reached\n- Result: ${failures === 0 ? 'pass' : `${failures} failure(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
