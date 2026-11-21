#!/usr/bin/env node
// NOT-458: Grok Marketplace import lives in per-agent Config, not the rail.
//
// Proves, without a browser:
// (1) Placement: the rail (app/page.tsx) has no Marketplace control, note,
//     or state; the Config Template source card renders the control.
// (2) The control's idle, pending, unavailable, failed, and missing states
//     render inside one polite live region.
// (3) The handoff still derives its destination only from server-owned
//     CLONE_MARKET_URL and rejects unsafe / cross-origin return paths,
//     including returns to a Config page.
// (4) End to end with two distinct bot IDs: a handoff started from bot A's
//     Config imports bot B and returns to /agents/B/config; A is unchanged.
// (5) Repeating the import callback is idempotent and creates no duplicate.
// Self-contained: isolated SQLite file, real route handlers via jiti.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-marketplace-config-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
delete process.env.CLONE_MARKET_URL;

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const handoff = jiti('../lib/market-handoff.ts');
const view = jiti('../app/components/MarketplaceImport.tsx');
const handoffRoute = jiti('../app/api/marketplace-handoff/route.ts');
const statusRoute = jiti('../app/api/marketplace-handoff/status/route.ts');
const importRoute = jiti('../app/api/bots/import/route.ts');
const configRoute = jiti('../app/api/bots/[id]/config/route.ts');
const { bots } = jiti('../lib/db.ts');

const ORIGIN = 'http://localhost:43123';
const MARKET = 'https://market.example.test/botmancers/import';

let failures = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

function source(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function handoffGet(query) {
  return handoffRoute.GET(new Request(`${ORIGIN}/api/marketplace-handoff${query}`, { headers: { host: 'localhost:43123' } }));
}

async function configExists(botId) {
  const res = await configRoute.GET(new Request(`${ORIGIN}/api/bots/${botId}/config`), { params: Promise.resolve({ id: botId }) });
  return res.ok;
}

function importBody(operationId, name) {
  return {
    schema_version: '1.0.0',
    operation_id: operationId,
    source_provider: 'grok-marketplace',
    template_id: 'tpl-cedar',
    template_url: 'https://market.example.test/t/tpl-cedar',
    bot: { name, title: 'Imported analyst', description: 'Imported rules.' },
  };
}

function postImport(body) {
  return importRoute.POST(new Request(`${ORIGIN}/api/bots/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function placementSection() {
  console.log('\n(1) Placement');
  const rail = source('app/page.tsx');
  for (const needle of ['Grok Marketplace', 'Marketplace', 'marketplace-handoff', 'import-btn', 'import-note', 'importMiss', 'importFromMarketplace']) {
    assert(!rail.includes(needle), `rail source has no "${needle}"`);
  }
  const css = source('app/globals.css');
  assert(!css.includes('.import-btn') && !css.includes('.import-note'), 'rail import styles are removed');

  const config = source('app/agents/[id]/config/page.tsx');
  const start = config.indexOf('<h2 className="cfg-title mb-3">Template source</h2>');
  const end = config.indexOf('Launch snapshots</h2>', start);
  const control = config.indexOf('<MarketplaceImportControl', start);
  assert(start > 0 && control > start && control < end, 'Config renders the import control inside the Template source card');
  assert(config.split('<MarketplaceImportControl').length === 2, 'Config renders the control exactly once');
  for (const file of ['app/settings/page.tsx']) {
    if (fs.existsSync(path.join(ROOT, file))) assert(!source(file).includes('Marketplace'), `${file} has no Marketplace import`);
  }
}

function statesSection() {
  console.log('\n(2) Control states');
  const html = phase => renderToStaticMarkup(React.createElement(view.MarketplaceImportControl, { phase, onImport: () => {} }));
  const expectations = {
    idle: { busy: false, text: handoff.MARKET_IMPORT_HINT, error: false },
    checking: { busy: true, text: 'Checking Grok Marketplace…', error: false },
    redirecting: { busy: true, text: 'Opening Grok Marketplace…', error: false },
    unavailable: { busy: false, text: handoff.MARKET_UNAVAILABLE, error: true },
    failed: { busy: false, text: handoff.MARKET_FAILED, error: true },
    missing: { busy: false, text: handoff.MARKET_MISSING, error: true },
  };
  for (const [phase, want] of Object.entries(expectations)) {
    const out = html(phase);
    const escaped = want.text.replace(/'/g, '&#x27;');
    assert(out.includes('>Import from Grok Marketplace</button>'), `${phase}: button is labelled "Import from Grok Marketplace"`);
    assert(out.includes('type="button"'), `${phase}: control is a real button`);
    assert(out.includes(`aria-busy="${want.busy}"`) && out.includes('disabled=""') === want.busy, `${phase}: busy=${want.busy}`);
    assert(out.includes('aria-describedby="cfg-market-import-status"'), `${phase}: button is described by the status line`);
    assert(/role="status" aria-live="polite"[^>]*>/.test(out) && out.includes(escaped), `${phase}: "${want.text}" is announced in the live region`);
    assert(out.includes('cfg-error') === want.error, `${phase}: error styling=${want.error}`);
  }
}

async function securitySection() {
  console.log('\n(3) Handoff security');
  const configReturn = `${ORIGIN}/agents/agent-a/config`;

  delete process.env.CLONE_MARKET_URL;
  let res = await statusRoute.GET();
  assert((await res.json()).configured === false, 'status: unconfigured without CLONE_MARKET_URL');
  res = await handoffGet(`?return=${encodeURIComponent(configReturn)}`);
  assert(res.status === 404, `unconfigured handoff from Config is 404 (got ${res.status})`);

  process.env.CLONE_MARKET_URL = `https://user:pw@market.example.test/botmancers/import?evil=1#frag`;
  res = await statusRoute.GET();
  assert((await res.json()).configured === true, 'status: configured with CLONE_MARKET_URL');

  const start = handoff.handoffStartPath(ORIGIN, '/agents/agent-a/config');
  assert(start === `/api/marketplace-handoff?return=${encodeURIComponent(configReturn)}`, 'Config starts the handoff with only a return parameter');
  res = await handoffGet(start.slice('/api/marketplace-handoff'.length));
  assert(res.status === 307, `same-origin Config return redirects (got ${res.status})`);
  const location = new URL(res.headers.get('location'));
  assert(location.origin + location.pathname === MARKET, 'destination comes from CLONE_MARKET_URL');
  assert(location.username === '' && location.password === '' && location.hash === '', 'destination drops userinfo and fragment');
  assert([...location.searchParams.keys()].join(',') === 'target,return', 'destination carries only target and return');
  assert(location.searchParams.get('return') === configReturn, 'return points back at the launching Config page');

  const rejected = [
    ['cross-origin return', `?return=${encodeURIComponent('https://evil.example/agents/a/config')}`],
    ['other-port return', `?return=${encodeURIComponent('http://localhost:9999/agents/a/config')}`],
    ['javascript: return', `?return=${encodeURIComponent('javascript:alert(1)')}`],
    ['relative return', `?return=${encodeURIComponent('/agents/a/config')}`],
    ['protocol-relative return', `?return=${encodeURIComponent('//evil.example/agents/a/config')}`],
    ['missing return', ''],
    ['client marketplace override', `?return=${encodeURIComponent(configReturn)}&marketplace=https://evil.example`],
    ['client destination override', `?return=${encodeURIComponent(configReturn)}&destination=https://evil.example`],
    ['duplicate return', `?return=${encodeURIComponent(configReturn)}&return=${encodeURIComponent('https://evil.example/')}`],
  ];
  for (const [label, query] of rejected) {
    res = await handoffGet(query);
    assert(res.status === 400 && !res.headers.get('location'), `${label} is rejected with 400 (got ${res.status})`);
  }

  const dirty = await handoffGet(`?return=${encodeURIComponent(`http://u:p@localhost:43123/agents/agent-a/config#x`)}`);
  const cleaned = new URL(new URL(dirty.headers.get('location')).searchParams.get('return'));
  assert(cleaned.username === '' && cleaned.password === '' && cleaned.hash === '', 'return userinfo and fragment are stripped');

  assert(handoff.importedBotId('') === null, 'no imported parameter: not a return');
  assert(handoff.importedBotId('?imported=../../settings') === '', 'path-traversal imported ID is malformed');
  assert(handoff.importedBotId('?imported=https%3A%2F%2Fevil.example') === '', 'URL imported ID is malformed');
  assert(handoff.importedConfigPath('abc-123') === '/agents/abc-123/config', 'return opens /agents/<id>/config');
  delete process.env.CLONE_MARKET_URL;
}

async function endToEndSection() {
  console.log('\n(4) Handoff return with two distinct bots');
  const a = bots.create({ name: 'Agent_A', title: 'Viewed agent', description: 'Rules for A.' });
  const before = JSON.stringify(bots.getById(a.id));

  process.env.CLONE_MARKET_URL = MARKET;
  const startRes = await handoffGet(handoff.handoffStartPath(ORIGIN, `/agents/${a.id}/config`).slice('/api/marketplace-handoff'.length));
  const returnUrl = new URL(startRes.headers.get('location')).searchParams.get('return');
  assert(returnUrl === `${ORIGIN}/agents/${a.id}/config`, 'handoff from A returns to A\'s Config page');
  delete process.env.CLONE_MARKET_URL;

  // The Marketplace calls the import endpoint, then sends the browser back.
  const imported = await (await postImport(importBody('op-not-458-e2e', 'Imported_B'))).json();
  const b = imported.bot;
  assert(imported.created === true && b.id !== a.id, 'import creates a distinct bot B');
  const back = new URL(returnUrl);
  back.searchParams.set(handoff.IMPORT_RETURN_QUERY, b.id);

  const result = await handoff.resolveImportReturn(back.search, a.id, configExists);
  assert(result.kind === 'open' && result.path === `/agents/${b.id}/config`, `return on A's Config opens B's Config (got ${JSON.stringify(result)})`);
  assert(JSON.stringify(bots.getById(a.id)) === before, 'bot A is unchanged by the import');

  const configRes = await configRoute.GET(new Request(`${ORIGIN}${result.path}`), { params: Promise.resolve({ id: b.id }) });
  const config = await configRes.json();
  assert(configRes.status === 200 && config.bot.id === b.id, 'B\'s Config page loads');
  assert(config.bot.source_provider === 'grok-marketplace' && config.bot.template_id === 'tpl-cedar'
    && config.bot.import_operation_id === 'op-not-458-e2e' && config.bot.import_schema_version === '1.0.0'
    && typeof config.bot.import_timestamp === 'number', 'B\'s Config shows its provenance');

  const missing = await handoff.resolveImportReturn('?imported=no-such-bot', a.id, configExists);
  assert(missing.kind === 'missing', 'unknown imported ID stays on A with an inline miss');
  const self = await handoff.resolveImportReturn(`?imported=${a.id}`, a.id, configExists);
  assert(self.kind === 'stay', 'imported ID equal to the current bot stays put');
  const thrown = await handoff.resolveImportReturn(`?imported=${b.id}`, a.id, async () => { throw new Error('offline'); });
  assert(thrown.kind === 'missing', 'unreachable lookup reports a miss instead of navigating');
  return b;
}

async function idempotencySection(b) {
  console.log('\n(5) Duplicate import callbacks');
  const count = bots.getAll().length;
  const again = await postImport(importBody('op-not-458-e2e', 'Imported_B'));
  const body = await again.json();
  assert(again.status === 200 && body.created === false && body.bot.id === b.id, 'same operation + same body returns the existing bot');
  const conflict = await postImport(importBody('op-not-458-e2e', 'Different_Name'));
  assert(conflict.status === 409, `same operation + different body is a 409 (got ${conflict.status})`);
  assert(bots.getAll().length === count, 'no duplicate bot is created');
  const ids = await handoff.resolveImportReturn(`?imported=${body.bot.id}`, 'other-agent', configExists);
  assert(ids.kind === 'open' && ids.path === `/agents/${b.id}/config`, 'repeated return opens the same imported Config');
}

async function main() {
  placementSection();
  statesSection();
  await securitySection();
  const b = await endToEndSection();
  await idempotencySection(b);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
}

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
}

main()
  .catch(error => {
    failures++;
    console.error(error);
  })
  .finally(() => {
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  });
