#!/usr/bin/env node
// NOT-543: New Agent + Config registration UI (no browser, no network).
// Supersedes the NOT-502 version: four concepts, no launch profile, no deck.
//
// Proves, through server-rendered components, pure helpers, and source
// assertions:
// (1) the four concepts render as separate, labelled controls in order:
//     runtime connection, session scope, default workspace, policy
//     (+ home session on Config);
// (2) no Agent Deck control, fetch, or state exists anywhere in the UI;
// (3) loading, validation, and connection-error states;
// (4) keyboard operation: native radios/checkboxes/selects/buttons with
//     names, legends, and described errors; no click-only elements;
// (5) desktop and narrow layouts (dialog inset, Config read rows stack);
// (6) the UI body round-trips through the real API: create, reload, edit.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-registration-ui-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HERMES_API_SERVER_KEY = 'test-hermes-key';
process.env.HERMES_BASE_URL = 'http://127.0.0.1:65530';

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const db = jiti('../lib/db.ts');
const ui = jiti('../lib/bot-runtime-ui.ts');
const regUi = jiti('../lib/agent-registration-ui.ts');
const reg = jiti('../lib/agent-registration.ts');
const view = jiti('../app/components/AgentRegistration.tsx');
const botsRoute = jiti('../app/api/bots/route.ts');

let failures = 0;
function assert(condition, label, detail) {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL: ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const READY = {
  status: 'ready',
  connections: [
    { id: 'rc-local-codex', provider: 'codex', label: 'Codex on this computer', host: 'This computer' },
    { id: 'rc-mac', provider: 'claude', label: 'Claude on Yusuke’s Mac', host: 'Yusuke’s Mac' },
  ],
  error: '',
};
const LOADING_CONN = regUi.initialConnectionListState();
const ERROR_CONN = { status: 'error', connections: [], error: 'HTTP 500' };

function fields(form, options = {}) {
  const connections = options.connections ?? READY;
  return renderToStaticMarkup(React.createElement(view.RegistrationFields, {
    idPrefix: options.idPrefix ?? 'bot',
    variant: options.variant ?? 'modal',
    form,
    onChange() {},
    view: regUi.registrationFormView(form, connections),
    showErrors: options.showErrors ?? false,
    connections,
    onRetryConnections() {},
    onAddConnection: async () => 'nope',
    workspacePlaceholder: '',
    workspaceHint: ui.NEW_AGENT_WORKSPACE_HINT,
    sessions: options.sessions,
    includeHomeSession: options.includeHomeSession,
  }));
}

const DIRECT_FORM = {
  ...regUi.DEFAULT_REGISTRATION_FORM,
  connectionId: 'rc-local-codex',
  scopeKind: 'workspaces',
  workspaces: '/Users/owner/work/botmancers',
  defaultWorkspace: '/Users/owner/work/botmancers',
};

function jsonRequest(method, body) {
  return new Request('http://localhost:43123/api/bots', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function call(method, body) {
  const res = await botsRoute[method](jsonRequest(method, body));
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log('\n(1) Four separate concepts, in order');
  const html = fields(DIRECT_FORM);
  const order = ['data-field="connection"', 'data-field="scope"', 'data-field="default-workspace"', 'data-field="policy"'];
  const positions = order.map(marker => html.indexOf(marker));
  assert(positions.every(p => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]), 'connection, scope, default workspace, policy render in order', JSON.stringify(positions));
  for (const label of [regUi.LABELS.connection, regUi.LABELS.scope, regUi.LABELS.defaultWorkspace, regUi.LABELS.policy]) {
    assert(html.includes(`>${label}</`) || html.includes(`>${label}<`), `visible label "${label}"`);
  }
  assert(!html.includes(regUi.LABELS.homeSession), 'New Agent has no home session control (a new Agent has no sessions)');
  assert(html.includes('Codex on this computer · Codex') && html.includes('Add connection'), 'connection picker lists connections with their runtime and offers Add connection');
  assert(!/SECRET|external_session_id|token/i.test(html), 'no provider session id or credential field');
  assert(html.includes(reg.SCOPE_KIND_LABELS.all_provider_sessions) && /<input type="radio" disabled="" name="bot-scope" value="sessions"/.test(html), 'scope: all sessions is an explicit option; imported sessions are disabled without sessions');
  assert(html.includes(regUi.HINTS.defaultWorkspace), 'default workspace is labelled as convenience, not permission');

  console.log('\n(2) No Agent Deck anywhere');
  assert(!/deck/i.test(html) && !html.includes('Working directory') && !html.includes('Launch profile'), 'direct form: no deck, workdir, or launch-profile control, copy, or state');
  assert(!/launch_profile|launchProfile|deckId|deck_id/.test(html), 'direct form: no removed field name in markup');
  assert(regUi.registrationFormView.length === 2, 'the form view takes only the form and the connection list (no deck state)');
  assert(!fs.existsSync(path.join(ROOT, 'app/components/useDeckList.ts')), 'useDeckList is deleted');
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  assert(!/useDeckList|launch_profile|launchProfile|agent-deck|Agent Deck/.test(pageSource), 'New Agent/roster source requests no deck list and names no profile');
  const configSource = fs.readFileSync(path.join(ROOT, 'app', 'agents', '[id]', 'config', 'page.tsx'), 'utf8');
  assert(!/useDeckList|launch_profile|launchProfile|agent-deck|Agent Deck/.test(configSource), 'Config source requests no deck list and names no profile');
  const componentSource = fs.readFileSync(path.join(ROOT, 'app', 'components', 'AgentRegistration.tsx'), 'utf8');
  assert(!/deck|Deck|launch_profile|launchProfile/.test(componentSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'registration component code has no deck or profile reference outside comments');

  console.log('\n(3) Loading, validation, connection errors');
  const loadingHtml = fields(DIRECT_FORM, { connections: LOADING_CONN });
  assert(loadingHtml.includes(regUi.CONNECTIONS_LOADING_COPY) && loadingHtml.includes('role="status"'), 'connections loading: status copy');
  assert(regUi.registrationFormView(DIRECT_FORM, LOADING_CONN).submitDisabled, 'connections loading: Create disabled');
  const errorHtml = fields(DIRECT_FORM, { connections: ERROR_CONN });
  assert(errorHtml.includes(regUi.CONNECTIONS_ERROR_COPY.replace(/'/g, '&#x27;')) && errorHtml.includes('>Retry</button>'), 'connections error: copy + Retry');
  assert(regUi.registrationFormView(DIRECT_FORM, ERROR_CONN).blocker === regUi.CONNECTIONS_ERROR_COPY, 'connections error: blocker copy for the form');
  const empty = regUi.registrationFormView(regUi.DEFAULT_REGISTRATION_FORM, READY);
  assert(JSON.stringify(Object.keys(empty.errors).sort()) === JSON.stringify(['connection', 'scope']), 'blank form: connection and scope are required (nothing defaulted)', JSON.stringify(empty.errors));
  const cases = [
    [{ ...DIRECT_FORM, workspaces: '' }, 'workspaces', regUi.ERRORS.workspaces],
    [{ ...DIRECT_FORM, workspaces: 'relative/path' }, 'workspaces', regUi.ERRORS.workspacePath],
    [{ ...DIRECT_FORM, defaultWorkspace: '/elsewhere' }, 'defaultWorkspace', regUi.ERRORS.defaultWorkspaceOutside],
    [{ ...DIRECT_FORM, scopeKind: 'sessions', sessions: [] }, 'sessions', regUi.ERRORS.sessions],
    [{ ...DIRECT_FORM, allowResumeWithEdits: true }, 'policy', regUi.ERRORS.resumeEdits],
  ];
  for (const [form, field, message] of cases) {
    assert(regUi.registrationFormView(form, READY).errors[field] === message, `validation: ${field} -> "${message}"`);
  }
  const invalidHtml = fields({ ...regUi.DEFAULT_REGISTRATION_FORM }, { showErrors: true });
  assert(invalidHtml.includes(`id="bot-connection-error"`) && invalidHtml.includes('aria-invalid="true"') && /aria-describedby="[^"]*bot-connection-error/.test(invalidHtml)
    && (invalidHtml.match(/role="alert"/g) || []).length === 2, 'shown errors are role=alert, linked by aria-describedby, controls aria-invalid');
  const allHtml = fields({ ...DIRECT_FORM, scopeKind: 'all_provider_sessions' });
  assert(allHtml.includes(regUi.HINTS.allSessions) && !allHtml.includes('id="bot-workspaces"'), 'all sessions: explicit hint, no workspace list');

  console.log('\n(4) Keyboard operation');
  assert(!/<div[^>]*onClick|<span[^>]*onClick/.test(componentSource), 'no click-only div/span controls');
  for (const group of ['bot-scope', 'bot-policy']) {
    assert((html.match(new RegExp(`<input type="radio"[^>]*name="${group}"`, 'g')) || []).length >= 2, `${group}: named native radio group (arrow keys move within it)`);
  }
  assert(/role="radiogroup" aria-labelledby="bot-scope-legend"/.test(html) && html.includes('id="bot-scope-legend"'), 'radio groups are labelled by their legends');
  assert(/<select id="bot-connection"[^>]*aria-labelledby="bot-connection-legend"/.test(html), 'connection select is labelled');
  assert((html.match(/type="checkbox"/g) || []).length === 2 && /type="checkbox" disabled=""/.test(html), 'policy flags are native checkboxes; resume-with-edits disabled under read only');
  assert(/<button type="button"[^>]*aria-expanded="false"[^>]*>Add connection…<\/button>/.test(html), 'Add connection is a button with aria-expanded');
  const focusCss = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  assert(focusCss.includes(':focus-visible'), 'visible focus styling exists');

  console.log('\n(5) Desktop and narrow layouts');
  const dialog = jiti('../lib/new-agent-dialog.ts');
  const desktop = dialog.newAgentDialogPlacement({ left: 24, bottom: 120 }, { width: 1440, height: 900 });
  const narrow = dialog.newAgentDialogPlacement({ left: 24, bottom: 120 }, { width: 390, height: 800 });
  assert(desktop.maxHeight > 0 && narrow.left >= dialog.DIALOG_INSET && narrow.maxHeight <= 800 - 2 * dialog.DIALOG_INSET, 'dialog stays inside the viewport at 1440x900 and 390x800 (body scrolls)');
  assert(/\.new-agent-body \{[^}]*overflow-y: auto/.test(focusCss) && /\.reg-option-hint \{[^}]*display: block/.test(focusCss), 'the longer form scrolls inside the dialog; option hints wrap under their radio');
  const configHtml = fields(DIRECT_FORM, { variant: 'config', idPrefix: 'cfg', includeHomeSession: true, sessions: [{ ref: 'sess-1', title: 'Fix login', status: 'active' }] });
  assert(configHtml.includes(regUi.LABELS.homeSession) && configHtml.includes('>Fix login (active)</option>') && !/<input[^>]*disabled=""[^>]*value="sessions"/.test(configHtml), 'Config: home session select and the sessions scope offer the Agent’s own sessions');
  assert(/flex flex-col sm:flex-row/.test(configSource), 'Config read rows stack on narrow screens and align on desktop');

  console.log('\n(6) Read views and the real API round trip');
  const created = await call('POST', regUi.registrationCreateBody('Direct Codex', DIRECT_FORM));
  assert(created.status === 200 && created.json.agent === 'codex' && created.json.launchable === true, 'New Agent body creates a launchable Codex Agent', JSON.stringify(created.json));
  const createKeys = Object.keys(regUi.registrationCreateBody('x', DIRECT_FORM));
  assert(!createKeys.some(k => /launch_profile|deck_id|deck_name|working_directory/.test(k)), 'create body sends only direct keys');
  const reloaded = (await (await botsRoute.GET()).json()).find(b => b.id === created.json.id);
  const seeded = regUi.registrationFormFromBot(reloaded);
  assert(JSON.stringify(seeded) === JSON.stringify(DIRECT_FORM), 'reload: Config form seeds exactly what New Agent saved', JSON.stringify(seeded));
  const read = regUi.registrationReadView(reloaded, null);
  assert(JSON.stringify(read.rows.map(r => r.key)) === JSON.stringify(['connection', 'scope', 'defaultWorkspace', 'policy', 'homeSession']), 'read view rows: connection, scope, default workspace, policy, home session', JSON.stringify(read.rows));
  assert(read.rows.find(r => r.key === 'connection').value === 'Codex on this computer (Codex · This computer)', 'read view names the connection, runtime, and host');
  assert(read.notices.length === 0, 'launchable Agent: no read notices');
  assert(ui.rosterRuntimeLine(reloaded) === 'Agent: Codex · Codex on this computer', 'roster: Agent plus its connection', ui.rosterRuntimeLine(reloaded));
  const edited = await call('PATCH', regUi.registrationPatchBody(created.json.id, { ...seeded, policyMode: 'workspace_write', allowResumeWithEdits: true }));
  assert(edited.status === 200 && edited.json.policy.allow_resume_with_edits === true, 'Config save body edits policy in place', JSON.stringify(edited.json));
  const legacy = db.bots.create({ name: 'Legacy', title: '', description: '', agent: 'codex', deck_name: 'relay-deck' });
  db.default.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(legacy.id);
  const legacyView = (await (await botsRoute.GET()).json()).find(b => b.id === legacy.id);
  assert(regUi.registrationFormFromBot(legacyView).scopeKind === '' && !('launchProfile' in regUi.registrationFormFromBot(legacyView)), 'unconfigured Agent: Config seeds a blank scope, no profile to choose');
  assert(regUi.registrationReadView(legacyView, null).notices.some(n => n.includes('Choose a session scope')), 'unconfigured Agent: Config asks the owner to choose a scope');
  assert(ui.rosterRuntimeLine(legacyView).endsWith(ui.ROSTER_CONFIG_SUFFIX), 'unconfigured Agent: roster points at Config');

  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
  if (failures > 0) {
    console.log(`\nTEST RESULT: FAIL (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\nTEST RESULT: PASS');
}

main().catch(error => {
  console.error(`FAIL: agent-registration-ui test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
