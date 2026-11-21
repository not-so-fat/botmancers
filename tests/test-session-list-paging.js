#!/usr/bin/env node
// NOT-548: the paged, searchable owner session list. Proves over the
// deterministic 788-row fixture (test-support/session-list-fixture.js):
// GET /api/bots/:id/sessions accepts limit (default 50, clamped to 200),
// cursor, q (a case-insensitive title substring), and workspace (an exact
// path), and answers next_cursor; status filtering and the newest-activity
// ordering are unchanged from listAgentSessions; a blank stored title falls
// back to <workspace folder> · <date>. The catalog functions carry the
// page math; the route tests below prove the query wiring end to end.
// Self-contained: isolated SQLite file, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-session-list-paging-${process.pid}.db`);
function removeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb();
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
// The session list probes an Agent's runtime; never this machine's codex.
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('./lib/db.ts');
const catalog = jiti('./lib/session-catalog.ts');
const { startRouteHost } = require('./test-support/acceptance/route-host');
const { COUNT, WORKSPACES, seedSessionList } = require('./test-support/session-list-fixture');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
const fmt = ms => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function walkPages(agentId, query) {
  const refs = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = catalog.listAgentSessionPage(db, agentId, { ...query, cursor });
    refs.push(...page.sessions.map(s => s.ref));
    pages++;
    cursor = page.next_cursor;
    if (!cursor) return { refs, pages };
    if (pages > 100) throw new Error('paging did not terminate');
  }
}

async function main() {
  const fixture = seedSessionList(dbModule);
  const { agent, other, sessions, foreign, BASE, MIN } = fixture;
  assert(sessions.length === COUNT && COUNT === 788, `the fixture holds 788 sessions (got ${sessions.length})`);
  const unpaged = catalog.listAgentSessions(db, agent.id, 'all');
  assert(unpaged.length === 788, 'the unpaged catalog still lists all 788 rows');

  console.log('\nPage size: default 50, clamped to 200');
  assert(catalog.SESSION_LIST_LIMITS.default === 50 && catalog.SESSION_LIST_LIMITS.max === 200, 'limits are default 50, max 200');
  assert(catalog.parseSessionListLimit(null) === 50 && catalog.parseSessionListLimit('') === 50, 'a missing limit defaults to 50');
  assert(catalog.parseSessionListLimit('500') === 200 && catalog.parseSessionListLimit('200') === 200, 'a limit above 200 clamps to 200');
  assert(catalog.parseSessionListLimit('7') === 7, 'a small limit passes through');
  for (const bad of ['0', '-3', 'abc', '12.5']) {
    let threw = false;
    try { catalog.parseSessionListLimit(bad); } catch { threw = true; }
    assert(threw, `limit=${JSON.stringify(bad)} is rejected`);
  }
  const first = catalog.listAgentSessionPage(db, agent.id, {});
  assert(first.sessions.length === 50 && typeof first.next_cursor === 'string', 'the default first page holds 50 rows with a next_cursor');

  console.log('\nCursor: no duplicates or gaps across the 788 rows');
  const full = walkPages(agent.id, {});
  assert(full.pages === 16, `default pages cover 788 rows in 16 pages (got ${full.pages})`);
  assert(new Set(full.refs).size === 788, 'walking every page visits 788 distinct references');
  assert(JSON.stringify(full.refs) === JSON.stringify(unpaged.map(s => s.ref)), 'paged order is exactly the unpaged newest-activity order');
  const wide = walkPages(agent.id, { limit: 200 });
  assert(wide.pages === 4 && JSON.stringify(wide.refs) === JSON.stringify(full.refs), 'limit=200 walks the same 788 rows in 4 pages');
  const second = catalog.listAgentSessionPage(db, agent.id, { cursor: first.next_cursor });
  assert(second.sessions.length === 50 && second.sessions[0].ref === full.refs[50], 'the cursor continues where the first page ended');

  console.log('\nOrdering pins: ties break by creation, then reference');
  const idx = ref => full.refs.indexOf(ref);
  assert(idx('ses-list-0101') === idx('ses-list-0100') - 1, 'shared activity: the newer creation (101) sorts first');
  assert(idx('ses-list-0200') === idx('ses-list-0201') - 1, 'shared activity and creation: the lower reference (200) sorts first');
  assert(full.refs[0] === 'ses-list-0787', 'the newest activity (row 787) heads the list');

  console.log('\nq: case-insensitive title substring');
  const login = walkPages(agent.id, { q: 'login' });
  const loginUpper = walkPages(agent.id, { q: 'LOGIN' });
  assert(JSON.stringify(login.refs) === JSON.stringify(loginUpper.refs) && login.refs.length > 0, '"login" and "LOGIN" match the same non-empty set');
  const loginRows = login.refs.map(ref => unpaged.find(s => s.ref === ref));
  assert(loginRows.every(s => s.title.toLowerCase().includes('login')), 'every match contains the fragment');
  assert(loginRows.every(s => !s.title.includes('pong')), 'non-matching titles are excluded');
  const expectedLogin = unpaged.filter(s => s.title.toLowerCase().includes('login')).map(s => s.ref);
  assert(JSON.stringify(login.refs) === JSON.stringify(expectedLogin), 'q narrows the full newest-first order without reordering');
  const pong = catalog.listAgentSessionPage(db, agent.id, { q: '  PONG  ' });
  assert(pong.sessions.length === 1 && pong.sessions[0].ref === 'ses-list-0003' && pong.next_cursor === null,
    'a padded mixed-case fragment finds "Reply with exactly: pong" on one page');
  const none = catalog.listAgentSessionPage(db, agent.id, { q: 'no such title fragment xyz' });
  assert(none.sessions.length === 0 && none.next_cursor === null, 'a fragment that matches nothing answers an empty last page');

  console.log('\nworkspace: exact path filter');
  const shop = walkPages(agent.id, { workspace: WORKSPACES[1] });
  assert(shop.refs.length > 0 && shop.refs.length < 788, 'a workspace narrows the list without emptying it');
  assert(shop.refs.every(ref => unpaged.find(s => s.ref === ref).context.workspace === WORKSPACES[1]), 'every row carries exactly the filtered path');
  assert(!shop.refs.includes(foreign.ref) && !full.refs.includes(foreign.ref), 'the other Agent\'s session in a shared workspace is never listed');
  const prefix = catalog.listAgentSessionPage(db, agent.id, { workspace: '/Users/owner/work' });
  assert(prefix.sessions.length === 0 && prefix.next_cursor === null, 'a path prefix matches nothing: the filter is exact');
  const unknown = catalog.listAgentSessionPage(db, agent.id, { workspace: '/no/such/workspace' });
  assert(unknown.sessions.length === 0 && unknown.next_cursor === null, 'an unknown workspace answers an empty last page');

  console.log('\nstatus filtering is unchanged');
  for (const status of ['active', 'ended']) {
    const expected = catalog.listAgentSessions(db, agent.id, status).map(s => s.ref);
    const walked = walkPages(agent.id, { status });
    assert(expected.length > 0 && JSON.stringify(walked.refs) === JSON.stringify(expected),
      `status=${status} pages exactly the unpaged ${status} list (${expected.length} rows)`);
  }
  const activeQ = walkPages(agent.id, { status: 'active', q: 'login' });
  assert(activeQ.refs.length > 0 && activeQ.refs.every(ref => login.refs.includes(ref)), 'status and q combine (active logins are a subset of all logins)');

  console.log('\nBlank title fallback: <workspace folder> · <date>');
  const byRef = Object.fromEntries(unpaged.map(s => [s.ref, s]));
  assert(byRef['ses-list-0003'].title === 'Reply with exactly: pong', 'a stored title passes through untouched');
  assert(byRef['ses-list-0020'].title === `botmancers · ${fmt(BASE + 20 * MIN)}`, 'an empty title falls back to the workspace folder and date');
  assert(byRef['ses-list-0000'].title === `botmancers · ${fmt(BASE)}`, 'a null title falls back the same way');
  assert(byRef['ses-list-0010'].title === `Claude · ${fmt(BASE + 10 * MIN)}`, 'no title and no workspace falls back to the Agent name and date');

  console.log('\nOwner route wiring');
  const host = await startRouteHost({ jiti, repoRoot: ROOT });
  try {
    const page1 = await host.owner('GET', `/api/bots/${agent.id}/sessions`);
    assert(page1.status === 200 && page1.json.status === 'all' && page1.json.sessions.length === 50
      && typeof page1.json.next_cursor === 'string', 'the route defaults to 50 rows with next_cursor');
    assert(JSON.stringify(page1.json.sessions.map(s => s.ref)) === JSON.stringify(full.refs.slice(0, 50)),
      'the route\'s first page matches the catalog order');
    const page2 = await host.owner('GET', `/api/bots/${agent.id}/sessions?cursor=${encodeURIComponent(page1.json.next_cursor)}`);
    assert(page2.status === 200 && page2.json.sessions.length === 50
      && JSON.stringify(page2.json.sessions.map(s => s.ref)) === JSON.stringify(full.refs.slice(50, 100)),
      'the route\'s cursor returns the next 50 without overlap');
    const clamped = await host.owner('GET', `/api/bots/${agent.id}/sessions?limit=500`);
    assert(clamped.status === 200 && clamped.json.sessions.length === 200, 'the route clamps limit=500 to 200 rows');
    assert((await host.owner('GET', `/api/bots/${agent.id}/sessions?limit=0`)).status === 400, 'limit=0 is 400');
    assert((await host.owner('GET', `/api/bots/${agent.id}/sessions?limit=many`)).status === 400, 'a non-numeric limit is 400');
    assert((await host.owner('GET', `/api/bots/${agent.id}/sessions?status=released`)).status === 400, 'an unknown status is still 400');
    assert((await host.owner('GET', `/api/bots/${agent.id}/sessions?cursor=not-a-cursor`)).status === 400, 'a forged cursor is 400');
    const otherPage = await host.owner('GET', `/api/bots/${other.id}/sessions`);
    const crossCursor = encodeURIComponent(otherPage.json.next_cursor || 'e30');
    assert((await host.owner('GET', `/api/bots/${agent.id}/sessions?cursor=${crossCursor}`)).status === 400,
      'a cursor from another Agent\'s list is 400');
    const routeLogin = await host.owner('GET', `/api/bots/${agent.id}/sessions?q=${encodeURIComponent('LoGiN')}&limit=200`);
    const routeLoginRefs = routeLogin.json.sessions.map(s => s.ref);
    if (typeof routeLogin.json.next_cursor === 'string') {
      const routeLogin2 = await host.owner('GET', `/api/bots/${agent.id}/sessions?q=${encodeURIComponent('LoGiN')}&limit=200&cursor=${encodeURIComponent(routeLogin.json.next_cursor)}`);
      routeLoginRefs.push(...routeLogin2.json.sessions.map(s => s.ref));
    }
    assert(routeLogin.status === 200 && JSON.stringify(routeLoginRefs) === JSON.stringify(login.refs),
      'the route\'s q matches titles case-insensitively across pages');
    const routeShop = await host.owner('GET', `/api/bots/${agent.id}/sessions?workspace=${encodeURIComponent(WORKSPACES[1])}&limit=200`);
    assert(routeShop.status === 200 && routeShop.json.sessions.length === shop.refs.length
      && routeShop.json.sessions.every(s => s.context.workspace === WORKSPACES[1]), 'the route\'s workspace filter is exact');
    const routeActive = await host.owner('GET', `/api/bots/${agent.id}/sessions?status=active&limit=200`);
    assert(routeActive.status === 200 && routeActive.json.status === 'active'
      && routeActive.json.sessions.every(s => s.status === 'active'), 'status=active still filters on the route');
    assert((await host.owner('GET', '/api/bots/no-such-agent/sessions')).status === 404, 'an unknown Agent is still 404');
    assert(!JSON.stringify(page1.json).includes('SECRET') && !JSON.stringify(routeLogin.json).includes('SECRET'),
      'paged responses disclose no provider session id');
    const onlyRefShown = page1.json.sessions.every(s => typeof s.ref === 'string');
    assert(onlyRefShown, 'rows keep the Botmancers reference as their identifier');
  } finally {
    await host.close();
  }

  removeDb();
  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll session list paging checks passed.');
}

main().catch(error => {
  console.error(error);
  removeDb();
  process.exit(1);
});
