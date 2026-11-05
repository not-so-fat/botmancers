#!/usr/bin/env node
// NOT-550 exact-HEAD browser proof for the Agent Sessions review page.
// Requires the seeded real app already listening; writes screenshots and a
// SHA-bound receipt under --out. Seeds are applied with
// scripts/seed-agent-sessions-page-fixture.js into the same BOTMANCERS_DB_PATH
// the app serves. No mocks.
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
const BASE = arg('--url', 'http://127.0.0.1:43550');
const OUT = arg('--out', '.agent-dealer-visual-qa');
const META = arg('--meta', path.join('.temporal', 'agent-sessions-page-fixture.meta.json'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse HEAD').toString().trim();
const DIRTY = execSync('git status --porcelain --untracked-files=no').toString().trim();
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'narrow-390x800', width: 390, height: 800, mobile: true },
];
const SECRETS = [
  'thr-review-open-SECRET',
  'thr-review-ended-SECRET',
  'thr-review-missing-SECRET',
  'work-agent-origin-SECRET',
  'work-human-origin-SECRET',
];
const checks = [];
const screenshots = [];
let failures = 0;
const check = (ok, label) => {
  checks.push({ ok: !!ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-sessions-proof-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) throw new Error('Chrome DevToolsActivePort missing');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, profile, ws: targets.find(target => target.type === 'page').webSocketDebuggerUrl };
}

async function connect(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  await new Promise(resolve => { ws.onopen = resolve; });
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function main() {
  if (DIRTY) throw new Error(`tracked worktree changes invalidate exact-HEAD proof:\n${DIRTY}`);
  if (!fs.existsSync(META)) throw new Error(`missing fixture meta at ${META}; run seed-agent-sessions-page-fixture.js first`);
  const fixture = JSON.parse(fs.readFileSync(META, 'utf8'));
  const agentId = fixture.agent?.id;
  const agentName = fixture.agent?.name || 'Reviewer';
  if (!agentId) throw new Error('fixture meta is missing agent.id');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chrome();
  const cdp = await connect(browser.ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const evaluate = async expression => (await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })).result.value;
  const waitFor = async (expression, ms = 15000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (await evaluate(`!!(${expression})`)) return true;
      await sleep(100);
    }
    return false;
  };
  const press = async key => {
    const code = key === 'Tab' ? 'Tab' : key;
    const vk = key === 'Tab' ? 9 : (key === 'Enter' ? 13 : 27);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const shot = async (name) => {
    const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, png);
    screenshots.push({ file: path.relative(process.cwd(), file), sha256: crypto.createHash('sha256').update(png).digest('hex') });
  };

  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
    });
    await cdp.send('Page.navigate', { url: `${BASE}/agents/${encodeURIComponent(agentId)}/sessions` });
    check(await waitFor("document.querySelector('[data-agent-sessions-page] .sessions-list')"),
      `${viewport.name}: Sessions page list loads`);

    const list = await evaluate(`(() => {
      const page = document.querySelector('[data-agent-sessions-page]');
      const rows = [...document.querySelectorAll('.session-scan-row')].map(li => ({
        title: li.querySelector('.session-title')?.textContent.trim() || '',
        status: li.querySelector('.session-status')?.textContent.trim() || '',
        activity: li.querySelector('.session-activity')?.textContent.trim() || '',
        workspace: li.querySelector('.session-workspace')?.textContent.trim() || '',
        chips: [...li.querySelectorAll('.session-origin-chip, .session-state-tag')].map(el => el.textContent.trim()),
        attention: li.querySelector('.session-attention')?.textContent.trim() || '',
        body: li.innerText,
      }));
      return {
        heading: page?.querySelector('h2')?.textContent.trim() || '',
        tabs: [...document.querySelectorAll('.agent-tabs a')].map(a => a.textContent.trim()),
        selectedTab: document.querySelector('.agent-tabs a[aria-current="page"]')?.textContent.trim() || '',
        filters: !!document.querySelector('.sessions-search') && !!document.querySelector('.sessions-workspace')
          && [...document.querySelectorAll('.sessions-status-filter button')].map(b => b.textContent.trim()).join('|') === 'All|Active|Ended',
        refresh: [...document.querySelectorAll('.agent-sessions-sync button')].some(b => /Refresh|Refreshing/.test(b.textContent)),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        rows,
        body: page?.innerText || '',
      };
    })()`);

    check(list.heading.includes(agentName) && list.selectedTab === 'Sessions'
      && ['Overview', 'Sessions', 'Conversations', 'Slack', 'Activity', 'Config'].every(label => list.tabs.includes(label)),
      `${viewport.name}: Agent shell keeps Sessions selected`);
    check(list.filters && list.refresh, `${viewport.name}: status/search/workspace filters and Refresh remain`);
    check(list.rows.length >= 4, `${viewport.name}: seeded session mix is listed (${list.rows.length})`);
    check(list.rows.some(row => row.status === 'Active') && list.rows.some(row => row.status === 'Ended')
      && list.rows.some(row => row.chips.includes('Missing'))
      && list.rows.some(row => row.chips.includes('Resumable') || /action/.test(row.attention)),
      `${viewport.name}: active/ended/missing/resumable scan states are recognizable`);
    check(list.rows.some(row => row.chips.includes('Human origin'))
      && list.rows.some(row => row.chips.some(chip => /Agent$/.test(chip) || chip === 'Agent origin')),
      `${viewport.name}: Human and Agent origin chips appear when canonical`);
    check(list.rows.every(row => row.title && row.activity && !/Reported usage|Started|Work request|Slack share|unavailable:|provider session ID/.test(row.body)),
      `${viewport.name}: collapsed rows keep operational prose out`);
    check(!list.overflow, `${viewport.name}: no horizontal viewport overflow`);
    check(SECRETS.every(secret => !list.body.includes(secret)), `${viewport.name}: list markup keeps provider ids out`);
    await shot(`${viewport.name}-list`);

    // Select the first actionable / open session and prove progressive detail.
    const selected = await evaluate(`(() => {
      const preferred = [...document.querySelectorAll('.session-scan-button')].find(btn => {
        const row = btn.closest('.session-scan-row');
        return row?.querySelector('.session-status')?.textContent.trim() === 'Active'
          && !row.querySelector('.session-state-tag.is-missing');
      }) || document.querySelector('.session-scan-button');
      if (!preferred) return null;
      preferred.focus();
      preferred.click();
      return preferred.querySelector('.session-title')?.textContent.trim() || '';
    })()`);
    check(!!selected && await waitFor("document.querySelector('[data-session-detail]')"),
      `${viewport.name}: selecting a row opens session detail`);

    const detail = await evaluate(`(() => {
      const pane = document.querySelector('[data-session-detail]');
      const text = pane?.innerText || '';
      const focus = document.activeElement;
      return {
        title: pane?.querySelector('h3')?.textContent.trim() || '',
        focused: focus === pane?.querySelector('h3'),
        hasMeta: ['Last activity', 'Started', 'Runtime', 'Reported usage', 'Workspace', 'Origin', 'Actions', 'Slack share', 'Runs and usage', 'Local debug: provider session ID']
          .every(label => text.includes(label)),
        hasShare: /Share to Slack|Active share|No active share|Session sharing/.test(text),
        listHidden: getComputedStyle(document.querySelector('.sessions-list-pane')).display === 'none',
        detailShown: getComputedStyle(document.querySelector('.sessions-detail-pane')).display !== 'none',
        body: text,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`);
    check(detail.title === selected && detail.hasMeta,
      `${viewport.name}: detail restores metadata, actions, usage, origin, shares, debug`);
    check(detail.focused, `${viewport.name}: focus moves to the detail heading`);
    if (viewport.mobile) {
      check(detail.listHidden && detail.detailShown, `${viewport.name}: narrow width swaps to full-width detail`);
    } else {
      check(!detail.listHidden && detail.detailShown, `${viewport.name}: desktop keeps master-detail side by side`);
    }
    check(!detail.overflow && SECRETS.every(secret => !detail.body.includes(secret)),
      `${viewport.name}: detail stays unclipped with safe identifiers`);
    await shot(`${viewport.name}-detail`);

    // Close detail and prove focus returns to the opening row control.
    await evaluate(`document.querySelector('.session-detail-close')?.click()`);
    check(await waitFor("!document.querySelector('[data-session-detail]')"),
      `${viewport.name}: Back to session list closes detail`);
    const returned = await evaluate(`(() => {
      const active = document.activeElement;
      return !!(active && active.classList.contains('session-scan-button')
        && active.querySelector('.session-title')?.textContent.trim() === ${JSON.stringify(selected)});
    })()`);
    check(returned, `${viewport.name}: focus returns to the selected scan row`);

    // Keyboard: Tab reaches Sessions nav and a scan row / Refresh.
    await evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
    let reachedNav = false;
    let reachedScan = false;
    let visibleFocus = false;
    for (let i = 0; i < 80 && !(reachedNav && reachedScan); i++) {
      await press('Tab');
      const focus = await evaluate(`(() => {
        const a = document.activeElement;
        if (!(a instanceof HTMLElement)) return {};
        const s = getComputedStyle(a);
        return {
          nav: a.matches('.agent-tabs a') && a.textContent.trim() === 'Sessions',
          scan: a.matches('.session-scan-button') || a.matches('.sessions-filter-btn') || a.matches('.sessions-search'),
          visible: a.matches(':focus-visible') && s.outlineStyle !== 'none',
        };
      })()`);
      if (focus.nav) reachedNav = true;
      if (focus.scan) reachedScan = true;
      if ((focus.nav || focus.scan) && focus.visible) visibleFocus = true;
    }
    check(reachedNav && reachedScan, `${viewport.name}: Tab reaches Sessions nav and page controls`);
    check(visibleFocus, `${viewport.name}: keyboard focus is visible`);

    // Thread-header Sessions deep link lands on the same page.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    check(await waitFor(`[...document.querySelectorAll('[data-open-bot]')].some(el => el.textContent.trim() === ${JSON.stringify(agentName)})`),
      `${viewport.name}: roster shows seeded Agent`);
    await evaluate(`([...document.querySelectorAll('[data-open-bot]')].find(el => el.textContent.trim() === ${JSON.stringify(agentName)}) || { click() {} }).click()`);
    check(await waitFor(`document.querySelector('.thread-name')?.textContent.trim() === ${JSON.stringify(agentName)}`),
      `${viewport.name}: opens Agent conversation`);
    await evaluate(`document.querySelector('.thread-bar a.attach-word[href*="/sessions"]')?.click()`);
    check(await waitFor("location.pathname.includes('/sessions') && document.querySelector('[data-agent-sessions-page]')"),
      `${viewport.name}: thread header Sessions navigates to the full page`);
    check(await evaluate("!document.querySelector('.sessions-drawer') && !document.querySelector('[aria-modal=\"true\"].sessions-drawer')"),
      `${viewport.name}: no Sessions modal drawer remains`);
  }

  cdp.close();
  browser.proc.kill();
  fs.rmSync(browser.profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, 'agent-sessions-page-proof-receipt.json'), JSON.stringify({
    head: HEAD,
    app: `${BASE} real Next.js app, seeded canonical DB, no mocks`,
    agent: fixture.agent,
    checks,
    screenshots,
    viewports: VIEWPORTS.map(v => `${v.width}x${v.height}`),
    result: failures === 0 ? 'pass' : 'fail',
    failures,
  }, null, 2));
  if (failures) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
