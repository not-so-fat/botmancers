#!/usr/bin/env node
// NOT-550: focused Agent Sessions page contract. Seeds the canonical session
// catalog with active, ended, resumable, Human-origin, and Agent-origin work,
// then proves compact rows and progressive detail without a provider-id leak.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-sessions-page-'));
process.env.BOTMANCERS_DB_PATH = path.join(temp, 'sessions.db');
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_PROVIDER = 'off';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const dbModule = jiti('./lib/db.ts');
const catalog = jiti('./lib/session-catalog.ts');
const view = jiti('./lib/session-view.ts');
const { SessionScanRow, SessionDetail } = jiti('./app/components/SessionsPanel.tsx');
const { seedSessionCatalog, EXTERNAL_IDS } = require('./test-support/session-catalog-fixture');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const actions = {
  ask: { available: true },
  resume: { available: true },
  handoff: { available: true },
};

try {
  const fixture = seedSessionCatalog(dbModule);
  const rows = catalog.listAgentSessions(dbModule.default, fixture.agents.dev.id, 'all');
  const byRef = Object.fromEntries(rows.map(row => [row.ref, row]));
  const agentOrigin = { ...byRef[fixture.bindings.implementation.id], actions, route: 'engine' };
  const humanOrigin = { ...byRef[fixture.bindings.requestOnly.id], actions, route: 'engine' };
  const ended = byRef[fixture.bindings.replaced.id];
  const missing = { ...agentOrigin, state: { ...agentOrigin.state, availability: 'missing' }, actions: {
    ask: { available: false, code: 'session_missing', reason: 'Ask from this context is unavailable: the runtime no longer reports this session.', recovery: 'choose_session' },
    resume: { available: false, code: 'session_missing', reason: 'Resume work here is unavailable: the runtime no longer reports this session.', recovery: 'choose_session' },
    handoff: { available: false, code: 'session_missing', reason: 'Hand off to… is unavailable: the runtime no longer reports this session.', recovery: 'choose_session' },
  } };

  test('canonical Work Request provenance distinguishes Human and Agent origins', () => {
    assert.deepEqual(view.sessionOriginChips(agentOrigin), ['Tank Agent', 'Tank thread']);
    assert.deepEqual(view.sessionOriginChips(humanOrigin), ['Human origin', 'Dev thread']);
    assert.equal(agentOrigin.origin.work_request.requester.kind, 'bot');
    assert.equal(humanOrigin.origin.work_request.requester.kind, 'person');
  });

  test('compact rows prioritize scan facts and keep operational prose out', () => {
    const html = render(SessionScanRow, { row: agentOrigin, selected: false, onSelect: () => {} });
    for (const text of [agentOrigin.title, 'Active', view.formatSessionDate(agentOrigin.last_activity_at), 'botmancers', 'Tank Agent', 'Tank thread', '3 actions available']) {
      assert.ok(html.includes(text), text);
    }
    for (const hidden of ['Reported usage', 'Started', 'Work request', 'Slack share', 'provider session ID', 'unavailable:']) {
      assert.equal(html.includes(hidden), false, hidden);
    }
  });

  test('state variants remain recognizable in collapsed rows', () => {
    const endedHtml = render(SessionScanRow, { row: ended, selected: false, onSelect: () => {} });
    const missingHtml = render(SessionScanRow, { row: missing, selected: true, onSelect: () => {} });
    assert.ok(endedHtml.includes('Ended'));
    assert.ok(missingHtml.includes('Missing') && missingHtml.includes('Review details') && missingHtml.includes('aria-current="true"'));
    assert.ok(agentOrigin.resumable && render(SessionScanRow, { row: agentOrigin, selected: false, onSelect: () => {} }).includes('Resumable'));
  });

  test('selected detail restores actions, explanations, metadata, shares, usage, origin, and debug disclosure', () => {
    const html = render(SessionDetail, {
      row: missing,
      agentId: fixture.agents.dev.id,
      headingRef: React.createRef(),
      origin: { conversationId: fixture.conversations.devConv.id, label: 'Dev conversation' },
      agents: Object.values(fixture.agents).map(agent => ({ id: agent.id, name: agent.name })),
      shares: [],
      sharePolicy: null,
      onClose: () => {},
      onAction: () => {},
      onSharesChanged: () => {},
    });
    for (const text of ['Session detail', 'Last activity', 'Started', 'Runtime', 'Reported usage', 'Workspace', 'Origin', 'Work request', 'Actions', 'Slack share', 'Runs and usage', 'Local debug: provider session ID']) {
      assert.ok(html.includes(text), text);
    }
    assert.ok(html.includes(`/agents/${fixture.agents.tank.id}/conversations`));
    assert.ok(html.includes('the runtime no longer reports this session'));
  });

  test('default row and detail markup never contain raw provider session ids', () => {
    const html = [
      render(SessionScanRow, { row: agentOrigin, selected: false, onSelect: () => {} }),
      render(SessionDetail, {
        row: agentOrigin, agentId: fixture.agents.dev.id, headingRef: React.createRef(),
        origin: { conversationId: fixture.conversations.devConv.id, label: 'Dev conversation' },
        agents: [], shares: [], sharePolicy: null, onClose: () => {}, onAction: () => {}, onSharesChanged: () => {},
      }),
    ].join('\n');
    for (const secret of Object.values(EXTERNAL_IDS)) assert.equal(html.includes(secret), false);
  });

  test('route, entry points, deep-link compatibility, and responsive master-detail source contracts are present', () => {
    const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
    const route = read('app/agents/[id]/sessions/page.tsx');
    const home = read('app/page.tsx');
    const overview = read('app/agents/[id]/page.tsx');
    const panel = read('app/components/SessionsPanel.tsx');
    const css = read('app/globals.css');
    assert.match(route, /<SessionsPanel/);
    assert.match(home, /sessions\?session=\$\{encodeURIComponent\(session\)\}/);
    assert.match(home, /window\.location\.replace\(dest\)/);
    assert.match(home, /href=\{\`\/agents\/\$\{encodeURIComponent\(activeConversation\.details\.id\)\}\/sessions\`\}/);
    assert.match(overview, /All sessions/);
    assert.equal(/sessionsOpen|sessions-drawer|onCardKeyDown/.test(panel + home), false);
    assert.equal(/aria-modal="true"/.test(panel), false);
    assert.match(panel, /router\.replace\(\`\/agents\/\$\{encodeURIComponent\(agentId\)\}\/sessions\?session=/);
    assert.match(panel, /sessions\/\$\{encodeURIComponent\(requestedRef\)\}/);
    assert.match(panel, /returnTo\.focus\(\)/);
    // NOT-555: selection is derived from ?session= + rows during render (kept
    // while rows load), never set from an effect body.
    assert.match(panel, /requestedRef && rows\.some\(row => row\.ref === requestedRef\) \? requestedRef : null/);
    assert.match(panel, /if \(syncedSelectedRef !== selectedRef\) setSelectedRef\(syncedSelectedRef\);/);
    assert.equal(/\}, \[requestedRef, rows\]\);/.test(panel), false);
    assert.match(css, /grid-template-columns: minmax\(18rem, 20rem\) minmax\(0, 1fr\)/);
    assert.match(css, /\.sessions-review\.has-detail \.sessions-list-pane/);
    assert.match(css, /--agent-inline:/);
    assert.match(css, /--agent-page-max:/);
    assert.match(css, /--agent-title-size:/);
    for (const selector of [
      '.agent-sessions-page',
      '.agent-overview',
      '.conversation-index',
      '.agent-slack',
      '.agent-activity',
      '.cfg-page.cfg-page-framed',
    ]) {
      assert.match(css, new RegExp(`${selector.replace(/\./g, '\\.')}[^{]*\\{[\\s\\S]*?padding:\\s*var\\(--agent-page-pad-block\\)\\s+var\\(--agent-inline\\)`),
        `${selector} shares the Agent page frame inset`);
    }
    assert.match(css, /\.agent-sessions-head h2[^{]*\{[\s\S]*?font-size:\s*var\(--agent-title-size\)/);
    assert.match(css, /\.agent-slack-intro h2[^{]*\{[\s\S]*?font-size:\s*var\(--agent-title-size\)/);
    assert.match(css, /\.agent-activity-intro h2[^{]*\{[\s\S]*?font-size:\s*var\(--agent-title-size\)/);
  });

  test('selecting a page-2 row under a filter must not refetch page 1', () => {
    // Catalog shape from the NOT-548 paging fixture: a workspace filter has a
    // next page, and that page-2 row is absent from a fresh page-1. Exact-ref
    // fallback is skipped while a filter is active, so a list refetch on
    // ?session= would clear selection — the panel must keep accumulated rows.
    const { seedSessionList, WORKSPACES } = require('./test-support/session-list-fixture');
    // Four rotating workspaces → need >200 rows so one workspace exceeds the
    // default page size of 50 and yields a Load-more cursor.
    const paging = seedSessionList(dbModule, { count: 220 });
    const workspace = WORKSPACES[1];
    const page1 = catalog.listAgentSessionPage(dbModule.default, paging.agent.id, { workspace });
    assert.equal(typeof page1.next_cursor, 'string');
    assert.equal(page1.sessions.length, 50);
    const page2 = catalog.listAgentSessionPage(dbModule.default, paging.agent.id, {
      workspace, cursor: page1.next_cursor,
    });
    assert.ok(page2.sessions.length > 0);
    const target = page2.sessions[0];
    assert.equal(page1.sessions.some(row => row.ref === target.ref), false,
      'the selected row is absent from a fresh page-1 under the same filter');
    const accumulated = [...page1.sessions, ...page2.sessions];
    assert.ok(accumulated.some(row => row.ref === target.ref),
      'Load more keeps the page-2 row available for URL-driven selection');

    const panel = fs.readFileSync(path.join(ROOT, 'app/components/SessionsPanel.tsx'), 'utf8');
    assert.match(panel, /Do not depend on requestedRef/);
    assert.match(panel, /\}, \[agentId, filter, query, workspaceFilter, attempt\]\);/);
    assert.equal(/\}, \[agentId, filter, query, workspaceFilter, attempt, requestedRef\]/.test(panel), false);
    assert.match(panel, /URL-driven selection cannot reset paging/);
    assert.match(panel, /if \(filter !== 'all' \|\| query\.trim\(\) \|\| workspaceFilter\) return;/);
    // Filter changes that drop the row clear the stale query param.
    assert.match(panel, /later matching filter does not silently reopen detail/);
    assert.match(panel, /if \(filter === 'all' && !query\.trim\(\) && !workspaceFilter\) return; \/\/ exact fetch may still land it/);
    assert.match(panel, /router\.replace\(`\/agents\/\$\{encodeURIComponent\(agentId\)\}\/sessions`, \{ scroll: false \}\)/);
    // Load more must drop refs already present (exact ?session= prepend onto page 1).
    assert.match(panel, /Drop already-present refs so Load more never/);
    assert.match(panel, /page\.filter\(row => !present\.has\(row\.ref\)\)/);
    const unfiltered1 = catalog.listAgentSessionPage(dbModule.default, paging.agent.id, {});
    assert.equal(typeof unfiltered1.next_cursor, 'string');
    const unfiltered2 = catalog.listAgentSessionPage(dbModule.default, paging.agent.id, {
      cursor: unfiltered1.next_cursor,
    });
    assert.ok(unfiltered2.sessions.length > 0);
    const deep = unfiltered2.sessions[0];
    const base = [deep, ...unfiltered1.sessions.filter(row => row.ref !== deep.ref)];
    const present = new Set(base.map(row => row.ref));
    const appended = [...base, ...unfiltered2.sessions.filter(row => !present.has(row.ref))];
    assert.equal(appended.filter(row => row.ref === deep.ref).length, 1,
      'deep-linked row appears once after Load more appends a page that includes it');
  });
} finally {
  dbModule.default.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
