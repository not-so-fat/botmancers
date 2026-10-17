#!/usr/bin/env node
// NOT-498: real-browser proof of session-targeted Ask and Continue, the
// inline exchange cards, and the Agent Exchanges ledger, against the exact
// committed HEAD.
//
// Starts, all on loopback and from this worktree:
// - a deterministic fake Agent Deck run API (test-support/fake-agent-deck-api)
//   whose runs are held until this script releases them, so intermediate
//   exchange states are observable; it also answers deck discovery;
// - the real Botmancers app (`next dev`) over a fresh DB seeded with the
//   shared session-catalog fixture (scripts/seed-sessions-fixture.js) and
//   pointed at that fake;
// - headless Chrome over the DevTools protocol.
//
// Desktop (1280x800):
// - Dev's Sessions: ended and non-resumable rows explain why actions are
//   unavailable; the resumable row's Ask this session opens with Enter,
//   Escape closes it and focus returns to the action;
// - Ask: empty Send is refused with a field error and no request; a double
//   Send makes one request while Send is disabled; that request is answered
//   with a mocked 503 (the one mocked route; CDP Fetch interception), the
//   draft is kept and an alert shown; Try again makes exactly one more
//   request, with the same payload and idempotency key, which the real
//   server accepts. The payload names the selected session, the question,
//   and the origin thread;
// - the Ask card shows "Asking the session" in the origin (Dev) and source
//   (Tank) threads, then "Answered" after the run is released;
// - Continue with… → Scout: the card moves Extracting handoff → Delivering
//   handoff → Handed off, seen in the origin and destination (Scout)
//   threads; the payload names the session, destination Agent, objective;
// - the rail's Exchanges entry opens the ledger: both records, newest
//   first; All/Ask/Continue, status, and Agent filters; filter-zero state;
//   the detail timeline and backlinks; a backlink opens the thread with
//   the card focused;
// - Ask on Dev's group-room session: the Design review group is a linked
//   thread; its ledger backlink opens the group thread page with the card
//   focused, live then terminal.
// Narrow (390x844): the ledger list and detail are full-height pages, and
// the detail's back control returns focus to the row that opened it;
// thread cards, the group thread page, the Sessions actions, and the
// Continue dialog fit with no clipping or horizontal overflow.
// Every page: no provider session id in the DOM or text.
//
// Refuses a dirty worktree. Writes screenshots, a trace, and
// exchanges-proof-receipt.json (HEAD, viewports, sha256 per screenshot,
// recorded POST bodies) under --out.
//
// Usage: node scripts/ui-exchanges-proof.js [--port 43498] [--out .agent-dealer-visual-qa]
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('--port', '43498'));
const OUT = path.resolve(ROOT, arg('--out', '.agent-dealer-visual-qa'));
const URL_BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESKTOP = { name: 'desktop-1280x800', width: 1280, height: 800, mobile: false };
const NARROW = { name: 'narrow-390x844', width: 390, height: 844, mobile: true };
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
const HEAD = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no', { cwd: ROOT }).toString().trim();
const DB_PATH = path.join(ROOT, '.temporal', 'exchanges-proof.db');

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Fixture: the shared session catalog, Agents on the fake Agent Deck.
function seed(deckUrl) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename, { alias: { '@': ROOT } });
  const db = jiti('../lib/db.ts');
  const settings = jiti('../lib/agent-deck-settings.ts');
  const { seedSessionCatalog, EXTERNAL_IDS } = require('../test-support/session-catalog-fixture');
  const fixture = seedSessionCatalog(db);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-exchanges-proof-work-'));
  db.default.prepare('UPDATE bots SET working_directory = ?').run(workdir);
  settings.setAgentDeckServerUrl(deckUrl);
  db.default.close();
  return { fixture, EXTERNAL_IDS };
}

// The fake Agent Deck: every run is held until released by hop kind.
async function startDeck() {
  const { createFakeAgentDeck } = require('../test-support/fake-agent-deck-api');
  const fake = createFakeAgentDeck();
  const runs = [];
  const hopOf = body => {
    const text = typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body.prompt ?? '');
    if (text.includes('[Session Ask')) return 'ask';
    if (text.includes('[Session Continue handoff')) return 'extract';
    if (text.includes('[Session Continue]')) return 'deliver';
    return 'other';
  };
  const RESULTS = {
    ask: 'The catalog reads the canonical session_bindings table joined with Work Requests and Attempts.',
    extract: JSON.stringify({
      objective: 'Ship the Agent Exchanges ledger and inline cards',
      decisions: ['Cards read state from the exchange API, never from prose'],
      constraints: ['No graph views or autonomous loops'],
      artifacts: ['lib/session-catalog.ts', 'app/exchanges/page.tsx'],
      open_questions: ['Should the ledger paginate later?'],
    }),
    deliver: 'Picked up the ledger work in a fresh session. Starting with the filters.',
    other: 'ok',
  };
  fake.onStart = body => {
    const kind = hopOf(body);
    runs.push({ kind, body });
    return { hold: true, result: RESULTS[kind] };
  };
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/api/launch/decks')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { decks: [{ id: 'deck-builder', name: 'builder' }] } }));
        return;
      }
      const response = fake.handle(req.method, req.url, req.headers, text);
      if (req.method === 'POST' && req.url === '/api/agent-runs' && response.body?.data?.runId) {
        const last = runs[runs.length - 1];
        if (last && !last.runId) last.runId = response.body.data.runId;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const release = kind => {
    const pending = runs.filter(run => run.kind === kind && run.runId && !run.released);
    for (const run of pending) {
      run.released = true;
      fake.release(run.runId);
    }
    return pending.length;
  };
  const started = kind => runs.filter(run => run.kind === kind && run.runId).length;
  const sessionIds = () => [...fake.runs.values()].map(run => run.sessionId);
  return { fake, url, server, release, started, sessionIds, runs };
}

async function startApp(token) {
  const log = fs.openSync(path.join(OUT, 'next-dev.log'), 'w');
  const proc = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, BOTMANCERS_DB_PATH: DB_PATH, BOTMANCERS_NO_AUTOPROCESS: '1', AGENT_DECK_RUN_TOKEN: token },
    stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 600; i++) {
    try {
      const res = await fetch(`${URL_BASE}/api/health`);
      if (res.ok) return proc;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  proc.kill();
  throw new Error('next dev did not become healthy');
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-exchanges-proof-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, wsUrl: targets.find(t => t.type === 'page').webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) || []), fn]);
  return new Promise(resolve => { ws.onopen = () => resolve({ send, on, close: () => ws.close() }); });
}

// Horizontal clipping/overflow for the given selectors, and page overflow.
const LAYOUT = selectors => `(() => {
  const vw = document.documentElement.clientWidth;
  const clipped = [];
  for (const el of document.querySelectorAll(${JSON.stringify(selectors)})) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).display === 'none') continue;
    if (r.left < -0.5 || r.right > vw + 0.5 || el.scrollWidth > el.clientWidth + 1) clipped.push((el.className || el.tagName) + ': ' + el.textContent.trim().slice(0, 40));
  }
  return { clipped, pageOverflow: document.documentElement.scrollWidth > vw + 1, vw };
})()`;

async function run() {
  if (DIRTY) throw new Error(`worktree has uncommitted tracked changes; commit before proving HEAD:\n${DIRTY}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  log(`HEAD ${HEAD}`);
  const deck = await startDeck();
  const { fixture, EXTERNAL_IDS } = seed(deck.url);
  const { dev, tank, scout } = fixture.agents;
  const implRef = fixture.bindings.implementation.id;
  const groupRef = fixture.bindings.group.id;
  const roomConvId = fixture.conversations.roomConv.id;
  log(`fake Agent Deck ${deck.url}; app ${URL_BASE} (real Next.js app and engine; the only mocked response is one 503 on POST /api/exchanges)`);
  const app = await startApp(deck.fake.token);
  const chrome = await launchChrome();
  const cdp = await connect(chrome.wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result.value;
  };
  const waitFor = async (expression, label, ms = 60000) => {
    for (let waited = 0; waited < ms; waited += 150) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(150);
    }
    return check(false, `timed out waiting for ${label}`);
  };
  const press = async key => {
    const text = key === 'Enter' ? '\r' : undefined;
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: key, text, windowsVirtualKeyCode: KEYS[key] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: KEYS[key] });
    await sleep(200);
  };
  const click = expr => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`);
  const focusEl = expr => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.focus(); return true; })()`);
  const typeInto = async (expr, text) => {
    await focusEl(expr);
    await cdp.send('Input.insertText', { text });
    await sleep(100);
  };
  const choose = (expr, value) => evaluate(`(() => {
    const el = ${expr};
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const implRow = `document.querySelector('.sessions-drawer [data-session-ref="${implRef}"]')`;
  const focusName = () => evaluate("(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 60) : ''; })()");
  const screenshots = [];
  const shot = async (vp, state) => {
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${vp.name}-${state}.png`);
    const png = Buffer.from(data, 'base64');
    fs.writeFileSync(file, png);
    screenshots.push({ viewport: vp.name, state, file: path.relative(ROOT, file), sha256: crypto.createHash('sha256').update(png).digest('hex') });
    log(`  screenshot ${path.relative(ROOT, file)}`);
  };
  const secrets = () => [...Object.values(EXTERNAL_IDS), `${EXTERNAL_IDS.direct}-next`, ...deck.sessionIds()];
  const noSecrets = async label => {
    const page = await evaluate('document.documentElement.outerHTML + "\\n" + document.body.innerText');
    const found = secrets().filter(secret => page.includes(secret));
    const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(await evaluate('document.body.innerText'));
    return check(found.length === 0 && !uuidText, `${label}: no provider session id in DOM/text and no raw id in visible text${found.length ? ` (found ${found.join(', ')})` : ''}`);
  };
  const layout = async (label, selectors) => {
    const l = await evaluate(LAYOUT(selectors));
    return check(!l.pageOverflow && l.clipped.length === 0, `${label}: no clipping or horizontal overflow at ${l.vw}px${l.clipped.length ? ` (${l.clipped.join(' | ')})` : ''}`);
  };
  const cardState = (conversationLabel, id) => evaluate(`(() => {
    const card = document.querySelector('.messages [data-exchange-id="${id}"]');
    return card ? { state: card.dataset.exchangeState, label: card.querySelector('.exchange-card-state').textContent.trim(), text: card.innerText } : null;
  })()`);
  const openThread = async (agent, name) => {
    await click(`document.querySelector('[data-open-bot="${agent.id}"]')`);
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(name)}`, `${name} thread`);
  };
  const openSessions = async () => {
    await click(byText('.thread-bar button', 'Sessions'));
    await waitFor(`${implRow}`, 'Sessions drawer with the implementation row');
  };

  // Network: every POST /api/exchanges from the page.
  const posts = [];
  let mockNext = false;
  let holdFirst = null;
  cdp.on('Fetch.requestPaused', async params => {
    if (params.request.method !== 'POST') {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    const body = JSON.parse(params.request.postData || '{}');
    posts.push(body);
    if (mockNext) {
      mockNext = false;
      await new Promise(resolve => { holdFirst = resolve; });
      await cdp.send('Fetch.fulfillRequest', {
        requestId: params.requestId, responseCode: 503,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ error: { code: 'internal_error', message: 'Botmancers is restarting. Your draft is kept; try again.' } })).toString('base64'),
      });
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: params.requestId });
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/exchanges', requestStage: 'Request' }] });

  let askId = null;
  let continueId = null;
  let groupAskId = null;
  try {
    // ================= Desktop =================
    const vp = DESKTOP;
    log(`\n== ${vp.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/?agent=${dev.id}` });
    await waitFor("document.querySelector('.thread-name')?.textContent.trim() === 'Dev'", 'Dev thread', 180000);
    check(await evaluate("!!document.querySelector('nav.rail-nav[aria-label=\"Workspace\"] a[href=\"/exchanges\"]')"), 'the rail exposes an Exchanges entry');
    await openSessions();

    log('Session actions');
    const rowInfo = await evaluate(`[...document.querySelectorAll('.sessions-drawer .session-row')].map(li => ({
      title: li.querySelector('.session-title').textContent.trim(),
      ended: li.classList.contains('is-ended'),
      actions: [...li.querySelectorAll('.session-action')].map(b => b.textContent.trim()),
      reason: li.querySelector('.session-unavailable')?.textContent.trim() ?? null,
    }))`);
    const impl = rowInfo.find(r => r.title === 'Add the session catalog read model' && !r.ended);
    check(!!impl && impl.actions.join('|') === 'Ask this session|Continue with…', 'the resumable session row offers Ask this session and Continue with…');
    check(rowInfo.filter(r => r.ended).every(r => r.actions.length === 0 && /has ended/.test(r.reason)), 'ended rows have no actions and explain why');
    check(rowInfo.some(r => !r.ended && r.actions.length === 0 && /can’t resume/.test(r.reason || '')), 'an active non-resumable row explains why actions are unavailable');
    await layout('Sessions drawer with actions', '.sessions-drawer .session-row, .session-action, .session-unavailable');
    await shot(vp, 'sessions-actions');

    log('Ask: keyboard, validation, duplicate submit, recoverable error, retry');
    await focusEl(`${implRow}.querySelector('.session-action')`);
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog[data-exchange-mode=\"ask\"]')", 'Ask dialog');
    check(await evaluate("document.activeElement?.id === document.querySelector('.exchange-dialog textarea').id"), 'Enter opens the Ask dialog and focus moves to the question field');
    check(await evaluate("document.querySelector('.sessions-drawer').inert === true"), 'the Sessions drawer is inert under the dialog');
    const askContext = await evaluate("document.querySelector('.exchange-source').textContent");
    check(/Dev/.test(askContext) && /Add the session catalog read model/.test(askContext) && /Last activity/.test(askContext), 'the dialog shows the recognizable source Agent, session title, and activity');
    check(await evaluate("document.querySelectorAll('.exchange-dialog input').length === 0") && !(await evaluate('document.querySelector(".exchange-dialog").innerText')).includes(implRef), 'no session-id entry and no session reference shown');
    await press('Escape');
    check(await evaluate("!document.querySelector('.exchange-dialog') && !!document.querySelector('.sessions-drawer')"), 'Escape closes only the dialog');
    await sleep(150);
    check((await focusName()) === 'Ask this session', 'focus returns to Ask this session');
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog')", 'Ask dialog (reopened)');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await sleep(300);
    check(await evaluate("document.querySelector('.exchange-field-error')?.textContent.trim() === 'Enter a question.' && document.querySelector('.exchange-dialog textarea').getAttribute('aria-invalid') === 'true'"), 'an empty question is refused with an associated field error');
    check(posts.length === 0, 'no request was sent for the invalid draft');
    const question = 'Which table does the session catalog read, and why?';
    await typeInto("document.querySelector('.exchange-dialog textarea')", question);
    mockNext = true;
    await evaluate("(() => { const b = document.querySelector('.exchange-dialog button[type=\"submit\"]'); b.click(); b.click(); })()");
    await sleep(600);
    check(posts.length === 1, `a double Send makes one request (${posts.length})`);
    check(await evaluate("document.querySelector('.exchange-dialog button[type=\"submit\"]').disabled === true && document.querySelector('.exchange-sending').textContent.trim() === 'Sending…'"), 'Send is disabled and Sending… is announced while the request is pending');
    await shot(vp, 'ask-sending');
    holdFirst();
    await waitFor("document.querySelector('.exchange-server-error')", 'server error alert');
    const afterError = await evaluate("({ alert: document.querySelector('.exchange-server-error').getAttribute('role'), text: document.querySelector('.exchange-server-error').textContent, draft: document.querySelector('.exchange-dialog textarea').value, button: document.querySelector('.exchange-dialog button[type=\"submit\"]').textContent.trim() })");
    check(afterError.alert === 'alert' && /draft is kept/.test(afterError.text) && afterError.draft === question && afterError.button === 'Try again', 'a server error is an alert, the draft is kept, and Send becomes Try again');
    await shot(vp, 'ask-error-draft-kept');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await waitFor("!document.querySelector('.exchange-dialog')", 'Ask dialog closes after the retry succeeds');
    check(posts.length === 2, `Try again makes exactly one more request (${posts.length} total for two user actions)`);
    const conv = await evaluate(`fetch('/api/conversations?botId=${dev.id}').then(r => r.json()).then(c => c.id)`);
    const askPayload = posts[1];
    check(JSON.stringify(posts[0]) === JSON.stringify(posts[1]), 'the retry repeats the same payload and idempotency key');
    check(askPayload.mode === 'ask' && askPayload.source.agent_id === dev.id && askPayload.source.session_ref === implRef && askPayload.instruction === question
      && askPayload.origin_conversation_id === conv && askPayload.destination === undefined, 'Ask payload: the selected session, the question, and the origin (Dev) thread');
    await sleep(150);
    check((await focusName()) === 'Ask this session', 'focus returns to the action after Send');
    check(/Asked Dev’s session/.test(await evaluate("document.querySelector('.exchange-started').textContent")), 'the drawer announces the started Ask');
    await press('Escape');
    check(await evaluate("!document.querySelector('.sessions-drawer')"), 'Escape closes the drawer');

    log('Ask: cards in linked threads');
    await waitFor("document.querySelector('.messages .exchange-card')", 'Ask card in Dev thread');
    askId = await evaluate("document.querySelector('.messages .exchange-card').dataset.exchangeId");
    await waitFor(`document.querySelector('.messages [data-exchange-id="${askId}"]')?.dataset.exchangeState === 'extracting'`, 'Ask extracting');
    let c = await cardState('Dev thread', askId);
    check(c && c.label === 'Asking the session' && /You → Dev/.test(c.text) && /Dev's session “Add the session catalog read model”/.test(c.text) && /Question/.test(c.text) && /Cancel/.test(c.text) && /Details/.test(c.text),
      'origin (Dev) thread: live Ask card with participants, session, question, Cancel, and Details');
    await shot(vp, 'ask-intermediate-origin-dev');
    await openThread(tank, 'Tank');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${askId}"]')`, 'Ask card in Tank thread');
    c = await cardState('Tank thread', askId);
    check(c && c.state === 'extracting', 'source (Tank) thread shows the same Ask card by exchange id');
    await shot(vp, 'ask-intermediate-source-tank');
    check(deck.release('ask') === 1, 'the held Ask run is released');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${askId}"]')?.dataset.exchangeState === 'completed'`, 'Ask completed in Tank thread');
    c = await cardState('Tank thread', askId);
    check(c.label === 'Answered' && !/Cancel/.test(c.text) && /Answer in Dev thread/.test(c.text), 'source thread: terminal card says Answered, without Cancel');
    await openThread(dev, 'Dev');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${askId}"]')?.dataset.exchangeState === 'completed'`, 'Ask completed in Dev thread');
    check(await evaluate("document.querySelector('.messages').innerText.includes('The catalog reads the canonical session_bindings table')"), 'the answer arrives in the origin thread');
    await layout('Dev thread with Ask card', '.exchange-card, .exchange-card p');
    await noSecrets('Dev thread after Ask');
    await shot(vp, 'ask-terminal-origin-dev');

    log('Continue with… → Scout');
    await openSessions();
    await focusEl(`${implRow}.querySelectorAll('.session-action')[1]`);
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog[data-exchange-mode=\"continue\"]')", 'Continue dialog');
    check(await evaluate("document.activeElement?.tagName === 'SELECT'"), 'focus starts on the destination picker');
    const options = await evaluate("[...document.querySelectorAll('.exchange-dialog select option')].map(o => o.textContent.trim())");
    check(!options.includes('Dev') && options.includes('Scout') && options.includes('Tank'), 'the destination picker lists the other Agents, never the source');
    check(/receives an extracted handoff/.test(await evaluate("document.querySelector('.exchange-hint').textContent")), 'the dialog explains the extracted handoff into a new session');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await sleep(300);
    check(await evaluate("document.querySelectorAll('.exchange-field-error').length === 2"), 'missing destination and objective are both refused');
    check(posts.length === 2, 'no request for the invalid Continue draft');
    await choose("document.querySelector('.exchange-dialog select')", scout.id);
    const objective = 'Take over the Agent Exchanges ledger: filters first, then the detail timeline.';
    await typeInto("document.querySelector('.exchange-dialog textarea')", objective);
    await shot(vp, 'continue-dialog');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await waitFor("!document.querySelector('.exchange-dialog')", 'Continue dialog closes');
    check(posts.length === 3, 'one Send, one request');
    const contPayload = posts[2];
    check(contPayload.mode === 'continue' && contPayload.source.session_ref === implRef && contPayload.destination?.agent_id === scout.id && contPayload.instruction === objective && contPayload.origin_conversation_id === conv,
      'Continue payload: the selected session, the destination Agent, and the objective');
    await press('Escape');
    await waitFor(`[...document.querySelectorAll('.messages .exchange-card')].some(el => el.dataset.exchangeId !== ${JSON.stringify(askId)})`, 'Continue card in Dev thread');
    continueId = await evaluate(`[...document.querySelectorAll('.messages .exchange-card')].find(el => el.dataset.exchangeId !== ${JSON.stringify(askId)}).dataset.exchangeId`);
    await waitFor(`document.querySelector('.messages [data-exchange-id="${continueId}"]')?.dataset.exchangeState === 'extracting'`, 'Continue extracting');
    c = await cardState('Dev thread', continueId);
    check(c.label === 'Extracting handoff' && /Dev → Scout/.test(c.text) && /Objective/.test(c.text), 'origin thread: Continue card shows Extracting handoff, Dev → Scout, and the objective');
    await shot(vp, 'continue-intermediate-extracting-dev');
    check(deck.release('extract') === 1, 'the held extraction run is released');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${continueId}"]')?.dataset.exchangeState === 'delivering'`, 'Continue delivering in Dev thread');
    await openThread(scout, 'Scout');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${continueId}"]')`, 'Continue card in Scout thread');
    c = await cardState('Scout thread', continueId);
    check(c.state === 'delivering' && c.label === 'Delivering handoff' && /Cancel/.test(c.text), 'destination (Scout) thread: the same card, Delivering handoff, with Cancel');
    await shot(vp, 'continue-intermediate-delivering-scout');
    for (let i = 0; i < 100 && deck.started('deliver') === 0; i++) await sleep(100);
    check(deck.release('deliver') === 1, 'the held delivery run is released');
    await waitFor(`document.querySelector('.messages [data-exchange-id="${continueId}"]')?.dataset.exchangeState === 'completed'`, 'Continue completed in Scout thread');
    c = await cardState('Scout thread', continueId);
    check(c.label === 'Handed off' && /Scout picked it up in a new session/.test(c.text) && !/Cancel/.test(c.text), 'destination thread: terminal card says Handed off with the outcome, without Cancel');
    const deliverRun = deck.runs.find(r => r.kind === 'deliver');
    check(!deliverRun.body.resumeSessionId && !JSON.stringify(deliverRun.body).includes(EXTERNAL_IDS.implementation), 'the destination launched a fresh session and never saw the source provider session id');
    await noSecrets('Scout thread after Continue');
    await shot(vp, 'continue-terminal-destination-scout');

    log('Ledger');
    await focusEl("document.querySelector('nav.rail-nav a')");
    await press('Enter');
    await waitFor("location.pathname === '/exchanges' && document.querySelectorAll('.ledger-row').length === 2", 'ledger rows', 120000);
    const ledgerRows = () => evaluate("[...document.querySelectorAll('.ledger-row')].map(b => ({ id: b.dataset.exchangeId, text: b.textContent }))");
    let lr = await ledgerRows();
    check(lr[0].id === continueId && lr[1].id === askId, 'newest activity first: the Continue, then the Ask');
    check(/Continue/.test(lr[0].text) && /Dev → Scout/.test(lr[0].text) && /Handed off/.test(lr[0].text) && /From Dev thread/.test(lr[0].text) && /Started .* UTC/.test(lr[0].text), 'a row shows mode, participants, state, origin, and timestamps');
    check(await evaluate("!!document.querySelector('main') && !!document.querySelector('h1')?.textContent.includes('Agent Exchanges')"), 'the ledger has a main landmark and h1');
    await click(byText('.ledger-mode button', 'Ask'));
    await sleep(200);
    lr = await ledgerRows();
    check(lr.length === 1 && lr[0].id === askId && (await evaluate("document.querySelector('.ledger-mode button[aria-pressed=\"true\"]').textContent.trim()")) === 'Ask', 'the Ask filter shows only the Ask (pressed state exposed)');
    await click(byText('.ledger-mode button', 'Continue'));
    await sleep(200);
    lr = await ledgerRows();
    check(lr.length === 1 && lr[0].id === continueId, 'the Continue filter shows only the Continue');
    await choose("document.querySelectorAll('.ledger-selects select')[0]", 'failed');
    await sleep(200);
    check(await evaluate("!!document.querySelector('[data-ledger-state=\"filtered-out\"]') && document.querySelectorAll('.ledger-row').length === 0"), 'a filter with no matches shows the filter-zero state');
    await shot(vp, 'ledger-filter-zero');
    await click(byText('.ledger-state button', 'Clear filters'));
    await sleep(200);
    await choose("document.querySelectorAll('.ledger-selects select')[1]", scout.id);
    await sleep(200);
    lr = await ledgerRows();
    check(lr.length === 1 && lr[0].id === continueId, 'the Agent filter (Scout) shows the Continue it received');
    await choose("document.querySelectorAll('.ledger-selects select')[1]", '');
    await sleep(2500);
    lr = await ledgerRows();
    check(lr.map(r => r.id).join() === [continueId, askId].join(), 'order is unchanged after a refresh');
    await click(`document.querySelector('.ledger-row[data-exchange-id="${continueId}"]')`);
    await waitFor(`document.querySelector('[data-exchange-detail="${continueId}"] .ledger-timeline li')`, 'Continue detail');
    const detail = await evaluate(`(() => {
      const d = document.querySelector('[data-exchange-detail="${continueId}"]');
      return {
        focused: document.activeElement === d.querySelector('h2'),
        timeline: [...d.querySelectorAll('.ledger-timeline li')].map(li => li.querySelector('.ledger-timeline-text').textContent.trim()),
        links: [...d.querySelectorAll('.ledger-links li')].map(li => li.textContent.trim()),
        packet: !!d.querySelector('[aria-label="Handoff packet"]'),
      };
    })()`);
    check(detail.focused, 'opening a row moves focus to the detail heading');
    check(detail.timeline[0] === 'You handed Dev\'s session to Scout' && detail.timeline.includes('Handoff packet extracted') && detail.timeline.includes('Scout started a new session')
      && detail.timeline.some(t => t.startsWith('Scout replied in')) && detail.timeline[detail.timeline.length - 1] === 'Now handed off', `ordered timeline of every hop (${detail.timeline.length} events)`);
    check(detail.links.length === 3 && /^Dev thread · Started here/.test(detail.links[0]) && /^Tank thread · Source session/.test(detail.links[1]) && /^Scout thread · Destination/.test(detail.links[2]), 'backlinks to the origin, source, and destination threads');
    check(detail.packet, 'the detail shows the extracted handoff packet');
    await layout('Ledger desktop', '.ledger-row, .ledger-detail, .ledger-detail p, .ledger-timeline li, .exchange-card');
    await noSecrets('Ledger detail');
    await shot(vp, 'ledger-continue-detail');
    await click(`document.querySelector('.ledger-row[data-exchange-id="${askId}"]')`);
    await waitFor(`document.querySelector('[data-exchange-detail="${askId}"] .ledger-timeline li')`, 'Ask detail');
    const askTimeline = await evaluate(`[...document.querySelectorAll('[data-exchange-detail="${askId}"] .ledger-timeline-text')].map(el => el.textContent.trim())`);
    check(askTimeline[0] === 'You asked Dev\'s session a question' && askTimeline.includes('Answer returned to Dev thread') && askTimeline[askTimeline.length - 1] === 'Now answered', 'the Ask timeline reconstructs the exchange');
    await shot(vp, 'ledger-ask-detail');
    await click(`[...document.querySelectorAll('[data-exchange-detail="${askId}"] .ledger-thread-link')].find(a => a.textContent.trim() === 'Tank thread')`);
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Tank' && document.activeElement?.dataset?.exchangeId === ${JSON.stringify(askId)}`, 'backlink opens Tank thread with the card focused');
    check(true, 'a backlink opens the linked thread and focuses the exchange card');
    await shot(vp, 'backlink-tank-card-focused');

    log('Ask on a group-room session: the group thread is linked');
    await openThread(dev, 'Dev');
    await click(byText('.thread-bar button', 'Sessions'));
    const groupRow = `document.querySelector('.sessions-drawer [data-session-ref="${groupRef}"]')`;
    await waitFor(groupRow, 'Sessions drawer with the group-room row');
    check(/Design review/.test(await evaluate(`${groupRow}.textContent`)), 'the group-room session is recognizable by its group');
    await focusEl(`${groupRow}.querySelector('.session-action')`);
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog[data-exchange-mode=\"ask\"]')", 'group Ask dialog');
    await typeInto("document.querySelector('.exchange-dialog textarea')", 'What did the design review settle on?');
    await click("document.querySelector('.exchange-dialog button[type=\"submit\"]')");
    await waitFor("!document.querySelector('.exchange-dialog')", 'group Ask dialog closes');
    check(posts.length === 4 && posts[3].source.session_ref === groupRef, 'one request names the group-room session');
    await press('Escape');
    await waitFor(`[...document.querySelectorAll('.messages .exchange-card')].some(el => ![${JSON.stringify(askId)}, ${JSON.stringify(continueId)}].includes(el.dataset.exchangeId))`, 'group Ask card in Dev thread');
    groupAskId = await evaluate(`[...document.querySelectorAll('.messages .exchange-card')].find(el => ![${JSON.stringify(askId)}, ${JSON.stringify(continueId)}].includes(el.dataset.exchangeId)).dataset.exchangeId`);
    await waitFor(`document.querySelector('.messages [data-exchange-id="${groupAskId}"]')?.dataset.exchangeState === 'extracting'`, 'group Ask extracting');
    await cdp.send('Page.navigate', { url: `${URL_BASE}/exchanges?id=${groupAskId}` });
    await waitFor(`document.querySelector('[data-exchange-detail="${groupAskId}"] .ledger-links li')`, 'group Ask detail', 120000);
    const groupLinks = await evaluate(`[...document.querySelectorAll('[data-exchange-detail="${groupAskId}"] .ledger-links li')].map(li => ({ text: li.textContent.trim(), href: li.querySelector('a')?.getAttribute('href') ?? null }))`);
    const groupLink = groupLinks.find(l => /^Group Design review/.test(l.text));
    check(groupLinks.length === 2 && groupLinks.every(l => l.href) && !!groupLink && groupLink.href === `/threads/${roomConvId}?exchange=${groupAskId}`, `every linked thread has a backlink, the group's opens its thread page (${groupLinks.map(l => l.text).join(' | ')})`);
    await click(`[...document.querySelectorAll('[data-exchange-detail="${groupAskId}"] .ledger-thread-link')].find(a => /^Group Design review/.test(a.textContent.trim()))`);
    await waitFor(`location.pathname === '/threads/${roomConvId}' && document.activeElement?.dataset?.exchangeId === ${JSON.stringify(groupAskId)}`, 'group thread page with the card focused', 120000);
    const gCard = await evaluate(`(() => { const c = document.querySelector('[data-exchange-id="${groupAskId}"]'); return { state: c.dataset.exchangeState, text: c.innerText, h1: document.querySelector('h1').textContent.trim(), main: !!document.querySelector('main') }; })()`);
    check(gCard.h1 === 'Group Design review' && gCard.main && gCard.state === 'extracting' && /Cancel/.test(gCard.text), 'the group thread page shows the live card (with Cancel) under the group heading');
    await shot(vp, 'group-thread-intermediate');
    for (let i = 0; i < 100 && deck.started('ask') < 2; i++) await sleep(100);
    check(deck.release('ask') === 1, 'the held group Ask run is released');
    await waitFor(`document.querySelector('[data-exchange-id="${groupAskId}"]')?.dataset.exchangeState === 'completed'`, 'group Ask completed on the group thread page');
    check(!/Cancel/.test(await evaluate(`document.querySelector('[data-exchange-id="${groupAskId}"]').innerText`)), 'the group thread page shows the terminal card without Cancel');
    await layout('Group thread desktop', '.exchange-card, .exchange-card p, .group-thread-list li');
    await noSecrets('Group thread');
    await shot(vp, 'group-thread-terminal');

    // ================= Narrow =================
    const nv = NARROW;
    log(`\n== ${nv.name} ==`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: nv.width, height: nv.height, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `${URL_BASE}/exchanges` });
    await waitFor("document.querySelectorAll('.ledger-row').length === 3", 'narrow ledger rows', 120000);
    const listPane = await evaluate("(() => { const l = document.querySelector('.ledger-list-pane').getBoundingClientRect(); return { listShown: l.width > 0, detailShown: getComputedStyle(document.querySelector('.ledger-detail-pane')).display !== 'none', width: l.width }; })()");
    check(listPane.listShown && !listPane.detailShown && listPane.width > 330, `narrow: the list is a full-width page with no squeezed detail column (${Math.round(listPane.width)}px)`);
    await layout('Ledger list narrow', '.ledger-row, .ledger-row span, .ledger-filters, .ledger-selects select, .ledger-mode button');
    await noSecrets('Narrow ledger');
    await shot(nv, 'ledger-list');
    await click(`document.querySelector('.ledger-row[data-exchange-id="${continueId}"]')`);
    await waitFor(`document.querySelector('[data-exchange-detail="${continueId}"] .ledger-timeline li')`, 'narrow detail');
    const detailPane = await evaluate("({ listShown: getComputedStyle(document.querySelector('.ledger-list-pane')).display !== 'none', back: getComputedStyle(document.querySelector('.ledger-detail-back')).display !== 'none' })");
    check(!detailPane.listShown && detailPane.back, 'narrow: the detail replaces the list as a full-height page with a back control');
    await layout('Ledger detail narrow', '.ledger-detail, .ledger-detail p, .ledger-timeline li, .ledger-links li, .exchange-card, .exchange-card p');
    await shot(nv, 'ledger-continue-detail');
    await click("document.querySelector('.ledger-detail-back')");
    await waitFor("getComputedStyle(document.querySelector('.ledger-list-pane')).display !== 'none' && location.search === ''", 'back to the list');
    await sleep(200);
    check(await evaluate(`document.activeElement === document.querySelector('.ledger-row[data-exchange-id="${continueId}"]')`), 'narrow: back returns to the list with focus on the row that opened the detail');
    await shot(nv, 'ledger-back-row-focused');
    await cdp.send('Page.navigate', { url: `${URL_BASE}/threads/${roomConvId}?exchange=${groupAskId}` });
    await waitFor(`document.activeElement?.dataset?.exchangeId === ${JSON.stringify(groupAskId)}`, 'narrow group thread with the card focused', 120000);
    await layout('Group thread narrow', '.exchange-card, .exchange-card p, .exchange-card span, .group-thread-list li, .group-thread-nav a');
    await noSecrets('Narrow group thread');
    await shot(nv, 'group-thread-card');
    await cdp.send('Page.navigate', { url: `${URL_BASE}/?agent=${dev.id}` });
    await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === 'Dev' && document.querySelectorAll('.messages .exchange-card').length === 3`, 'narrow Dev thread with its three cards', 120000);
    await evaluate(`document.querySelector('.messages [data-exchange-id="${askId}"]').scrollIntoView({ block: 'start' })`);
    await layout('Thread cards narrow', '.exchange-card, .exchange-card p, .exchange-card span');
    await noSecrets('Narrow thread');
    await shot(nv, 'thread-cards-dev');
    await openSessions();
    await evaluate(`${implRow}.scrollIntoView({ block: 'start' })`);
    await layout('Sessions actions narrow', '.sessions-drawer .session-row, .session-action, .session-unavailable');
    await shot(nv, 'sessions-actions');
    await focusEl(`${implRow}.querySelectorAll('.session-action')[1]`);
    await press('Enter');
    await waitFor("document.querySelector('.exchange-dialog')", 'narrow Continue dialog');
    await layout('Continue dialog narrow', '.exchange-dialog, .exchange-dialog p, .exchange-dialog select, .exchange-dialog textarea, .exchange-dialog .form-actions');
    await shot(nv, 'continue-dialog');
    await press('Escape');
    check(await evaluate("!document.querySelector('.exchange-dialog')"), 'narrow: Escape closes the dialog');
    check(posts.length === 4, `no extra exchange requests overall (${posts.length} POSTs for four Sends, one retried)`);
  } finally {
    cdp.close();
    chrome.proc.kill();
    app.kill();
    deck.server.close();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  fs.writeFileSync(path.join(OUT, 'exchanges-proof-trace.txt'), `${trace.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'exchanges-proof-receipt.json'), `${JSON.stringify({
    head: HEAD, cleanTree: true, app: URL_BASE, agentDeck: 'test-support/fake-agent-deck-api (loopback, held runs)',
    mocks: 'one mocked 503 response to the first POST /api/exchanges (CDP Fetch interception); everything else is the real app and engine',
    result: failures === 0 ? 'pass' : 'fail', failures, exchanges: { ask: askId, continue: continueId, groupAsk: groupAskId },
    posts, viewports: [`${DESKTOP.width}x${DESKTOP.height}`, `${NARROW.width}x${NARROW.height}`], screenshots, capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
