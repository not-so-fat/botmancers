#!/usr/bin/env node
// NOT-502: New Agent + Config registration UI (no browser, no network).
//
// Proves, through server-rendered components, pure helpers, and source
// assertions:
// (1) the five concepts render as separate, labelled controls in order:
//     runtime connection, session scope, default workspace, launch
//     profile, policy (+ home session on Config);
// (2) Agent Deck controls render only for the agent_deck profile, and a
//     direct profile never requests the Agent Deck list;
// (3) loading, validation, and Agent Deck-unavailable states;
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

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const db = jiti('./lib/db.ts');
const ui = jiti('./lib/bot-runtime-ui.ts');
const regUi = jiti('./lib/agent-registration-ui.ts');
const reg = jiti('./lib/agent-registration.ts');
const view = jiti('./app/components/AgentRegistration.tsx');
const botsRoute = jiti('./app/api/bots/route.ts');

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
function deckState(status, extra) {
  return { ...ui.initialDeckListState(), status, checkedAt: 1, serverUrl: 'http://127.0.0.1:1111', ...extra };
}
const CONNECTED = deckState('connected', { decks: [{ id: 'builder', name: 'builder' }], cachedDecks: [{ id: 'builder', name: 'builder' }] });
const NOT_FETCHED = ui.initialDeckListState();

function fields(form, options = {}) {
  const deck = options.deck ?? NOT_FETCHED;
  const connections = options.connections ?? READY;
  return renderToStaticMarkup(React.createElement(view.RegistrationFields, {
    idPrefix: options.idPrefix ?? 'bot',
    variant: options.variant ?? 'modal',
    form,
    onChange() {},
    view: regUi.registrationFormView(form, deck, connections),
    showErrors: options.showErrors ?? false,
    connections,
    onRetryConnections() {},
    onAddConnection: async () => 'nope',
    deckState: deck,
    onRetryDecks() {},
    workdirPlaceholder: '',
    workdirHint: ui.NEW_BOT_WORKDIR_HINT,
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
  launchProfile: 'direct',
};
const DECK_FORM = { ...DIRECT_FORM, launchProfile: 'agent_deck', deckId: 'builder' };

function jsonRequest(method, body) {
  return new Request('http://localhost:43123/api/bots', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function call(method, body) {
  const res = await botsRoute[method](jsonRequest(method, body));
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log('\n(1) Five separate concepts, in order');
  const html = fields(DIRECT_FORM);
  const order = ['data-field="connection"', 'data-field="scope"', 'data-field="default-workspace"', 'data-field="launch-profile"', 'data-field="policy"'];
  const positions = order.map(marker => html.indexOf(marker));
  assert(positions.every(p => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]), 'connection, scope, default workspace, launch profile, policy render in order', JSON.stringify(positions));
  for (const label of Object.values(regUi.LABELS).filter(l => l !== regUi.LABELS.homeSession)) {
    assert(html.includes(`>${label}</`), `visible label "${label}"`);
  }
  assert(!html.includes(regUi.LABELS.homeSession), 'New Agent has no home session control (a new Agent has no sessions)');
  assert(html.includes('Codex on this computer · Codex') && html.includes('Add connection'), 'connection picker lists connections with their runtime and offers Add connection');
  assert(!/SECRET|external_session_id|token/i.test(html), 'no provider session id or credential field');
  assert(html.includes(reg.SCOPE_KIND_LABELS.all_provider_sessions) && /<input type="radio" disabled="" name="bot-scope" value="sessions"/.test(html), 'scope: all sessions is an explicit option; imported sessions are disabled without sessions');
  assert(html.includes(regUi.HINTS.defaultWorkspace), 'default workspace is labelled as convenience, not permission');

  console.log('\n(2) Agent Deck controls only for agent_deck');
  assert(!html.includes('data-field="deck"') && !html.includes('Working directory') && !html.includes(ui.SETTINGS_LINK_COPY), 'direct: no deck slot, workdir, or Agent Deck settings link');
  const deckHtml = fields(DECK_FORM, { deck: CONNECTED });
  assert(deckHtml.includes('data-field="deck"') && deckHtml.includes('Working directory (optional)') && deckHtml.includes('>builder</option>'), 'agent_deck: deck select and workdir render');
  const noneHtml = fields({ ...DIRECT_FORM, launchProfile: '' });
  assert(!noneHtml.includes('data-field="deck"'), 'no profile chosen: no Agent Deck controls');
  const directView = regUi.registrationFormView(DIRECT_FORM, NOT_FETCHED, READY);
  assert(directView.submitDisabled === false && !regUi.hasRegistrationErrors(directView), 'direct: Create is enabled while the deck list was never fetched');
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  const modal = pageSource.slice(pageSource.indexOf('function BotModal('));
  assert(!/useEffect\(\(\) => \{\s*onRetryDecks\(\);/.test(modal) && /launchProfile === 'agent_deck' && form\.launchProfile !== 'agent_deck'\) onRetryDecks\(\)/.test(modal), 'New Agent fetches the deck list only when Agent Deck is picked');
  assert(/useDeckList\(decksEnabled\)/.test(pageSource) && /bots\.some\(bot => bot\.launch_profile === 'agent_deck'\)/.test(pageSource), 'roster requests decks only with an Agent Deck Agent present');
  const configSource = fs.readFileSync(path.join(ROOT, 'app', 'bots', '[id]', 'config', 'page.tsx'), 'utf8');
  assert(/decksEnabled = data\?\.bot\.launch_profile === 'agent_deck' \|\| runtimeForm\?\.launchProfile === 'agent_deck'/.test(configSource) && /useDeckList\(Boolean\(decksEnabled\)\)/.test(configSource), 'Config of a direct Agent never requests the deck list');
  const hookSource = fs.readFileSync(path.join(ROOT, 'app', 'components', 'useDeckList.ts'), 'utf8');
  assert(/if \(!enabled\) return;/.test(hookSource), 'useDeckList(enabled=false) issues no request');

  console.log('\n(3) Loading, validation, Agent Deck unavailable');
  const loadingHtml = fields(DIRECT_FORM, { connections: LOADING_CONN });
  assert(loadingHtml.includes(regUi.CONNECTIONS_LOADING_COPY) && loadingHtml.includes('role="status"'), 'connections loading: status copy');
  assert(regUi.registrationFormView(DIRECT_FORM, NOT_FETCHED, LOADING_CONN).submitDisabled, 'connections loading: Create disabled');
  const errorHtml = fields(DIRECT_FORM, { connections: ERROR_CONN });
  assert(errorHtml.includes(regUi.CONNECTIONS_ERROR_COPY.replace(/'/g, '&#x27;')) && errorHtml.includes('>Retry</button>'), 'connections error: copy + Retry');
  const deckLoading = regUi.registrationFormView(DECK_FORM, deckState('loading'), READY);
  assert(deckLoading.submitDisabled, 'agent_deck while decks load: Create disabled');
  for (const status of ['unreachable', 'unconfigured', 'empty', 'malformed']) {
    const state = deckState(status);
    const v = regUi.registrationFormView(DECK_FORM, state, READY);
    const h = fields(DECK_FORM, { deck: state });
    assert(v.submitDisabled && v.blocker === ui.DECK_SLOT_COPY[status] && h.includes(ui.DECK_SLOT_COPY[status].replace(/'/g, '&#x27;')), `Agent Deck ${status}: copy shown, Create disabled`);
    assert(!regUi.registrationFormView(DIRECT_FORM, state, READY).submitDisabled, `Agent Deck ${status} never blocks a direct Agent`);
  }
  const empty = regUi.registrationFormView(regUi.DEFAULT_REGISTRATION_FORM, NOT_FETCHED, READY);
  assert(JSON.stringify(Object.keys(empty.errors).sort()) === JSON.stringify(['connection', 'launchProfile', 'scope']), 'blank form: connection, scope, and launch profile are required (nothing defaulted)', JSON.stringify(empty.errors));
  const cases = [
    [{ ...DIRECT_FORM, workspaces: '' }, 'workspaces', regUi.ERRORS.workspaces],
    [{ ...DIRECT_FORM, workspaces: 'relative/path' }, 'workspaces', regUi.ERRORS.workspacePath],
    [{ ...DIRECT_FORM, defaultWorkspace: '/elsewhere' }, 'defaultWorkspace', regUi.ERRORS.defaultWorkspaceOutside],
    [{ ...DIRECT_FORM, scopeKind: 'sessions', sessions: [] }, 'sessions', regUi.ERRORS.sessions],
    [{ ...DECK_FORM, deckId: '' }, 'deck', regUi.ERRORS.deck],
    [{ ...DIRECT_FORM, allowResumeWithEdits: true }, 'policy', regUi.ERRORS.resumeEdits],
  ];
  for (const [form, field, message] of cases) {
    assert(regUi.registrationFormView(form, CONNECTED, READY).errors[field] === message, `validation: ${field} -> "${message}"`);
  }
  const invalidHtml = fields({ ...regUi.DEFAULT_REGISTRATION_FORM }, { showErrors: true });
  assert(invalidHtml.includes(`id="bot-connection-error"`) && invalidHtml.includes('aria-invalid="true"') && /aria-describedby="[^"]*bot-connection-error/.test(invalidHtml)
    && (invalidHtml.match(/role="alert"/g) || []).length === 3, 'shown errors are role=alert, linked by aria-describedby, controls aria-invalid');
  const allHtml = fields({ ...DIRECT_FORM, scopeKind: 'all_provider_sessions' });
  assert(allHtml.includes(regUi.HINTS.allSessions) && !allHtml.includes('id="bot-workspaces"'), 'all sessions: explicit hint, no workspace list');

  console.log('\n(4) Keyboard operation');
  assert(!/<div[^>]*onClick|<span[^>]*onClick/.test(fs.readFileSync(path.join(ROOT, 'app', 'components', 'AgentRegistration.tsx'), 'utf8')), 'no click-only div/span controls');
  for (const group of ['bot-scope', 'bot-profile', 'bot-policy']) {
    assert((html.match(new RegExp(`<input type="radio"[^>]*name="${group}"`, 'g')) || []).length >= 2, `${group}: named native radio group (arrow keys move within it)`);
  }
  assert(/role="radiogroup" aria-labelledby="bot-profile-legend"/.test(html) && html.includes('id="bot-profile-legend"'), 'radio groups are labelled by their legends');
  assert(/<select id="bot-connection"[^>]*aria-labelledby="bot-connection-legend"/.test(html), 'connection select is labelled');
  assert((html.match(/type="checkbox"/g) || []).length === 2 && /type="checkbox" disabled=""/.test(html), 'policy flags are native checkboxes; resume-with-edits disabled under read only');
  assert(/<button type="button"[^>]*aria-expanded="false"[^>]*>Add connection…<\/button>/.test(html), 'Add connection is a button with aria-expanded');
  const focusCss = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  assert(/\.form-card input\[type="checkbox"\]:focus-visible/.test(focusCss), 'checkboxes show a visible focus ring');

  console.log('\n(5) Desktop and narrow layouts');
  const dialog = jiti('./lib/new-agent-dialog.ts');
  const desktop = dialog.newAgentDialogPlacement({ left: 24, bottom: 120 }, { width: 1440, height: 900 });
  const narrow = dialog.newAgentDialogPlacement({ left: 24, bottom: 120 }, { width: 390, height: 800 });
  assert(desktop.maxHeight > 0 && narrow.left >= dialog.DIALOG_INSET && narrow.maxHeight <= 800 - 2 * dialog.DIALOG_INSET, 'dialog stays inside the viewport at 1440x900 and 390x800 (body scrolls)');
  assert(/\.new-agent-body \{[^}]*overflow-y: auto/.test(focusCss) && /\.reg-option-hint \{[^}]*display: block/.test(focusCss), 'the longer form scrolls inside the dialog; option hints wrap under their radio');
  const configHtml = fields(DECK_FORM, { variant: 'config', idPrefix: 'cfg', deck: CONNECTED, includeHomeSession: true, sessions: [{ ref: 'sess-1', title: 'Fix login', status: 'active' }] });
  assert(configHtml.includes(regUi.LABELS.homeSession) && configHtml.includes('>Fix login (active)</option>') && !/<input[^>]*disabled=""[^>]*value="sessions"/.test(configHtml), 'Config: home session select and the sessions scope offer the Agent’s own sessions');
  assert(/flex flex-col sm:flex-row/.test(configSource), 'Config read rows stack on narrow screens and align on desktop');

  console.log('\n(6) Read views and the real API round trip');
  const created = await call('POST', regUi.registrationCreateBody('Direct Codex', DIRECT_FORM));
  assert(created.status === 200 && created.json.launch_profile === 'direct' && created.json.deck_id === null, 'New Agent body creates a direct Agent', JSON.stringify(created.json));
  assert(!('deck_id' in regUi.registrationCreateBody('x', DIRECT_FORM)), 'direct create body sends no deck_id');
  const reloaded = (await (await botsRoute.GET()).json()).find(b => b.id === created.json.id);
  const seeded = regUi.registrationFormFromBot(reloaded);
  assert(JSON.stringify(seeded) === JSON.stringify(DIRECT_FORM), 'reload: Config form seeds exactly what New Agent saved', JSON.stringify(seeded));
  const read = regUi.registrationReadView(reloaded, null);
  assert(JSON.stringify(read.rows.map(r => r.key)) === JSON.stringify(['connection', 'scope', 'defaultWorkspace', 'launchProfile', 'policy', 'homeSession']), 'direct read view: no Agent Deck rows', JSON.stringify(read.rows));
  assert(read.rows.find(r => r.key === 'launchProfile').value === 'Direct' && read.notices.some(n => /direct launch/.test(n)), 'direct read view names the profile and the pending direct runtime');
  assert(ui.rosterRuntimeLine(reloaded, NOT_FETCHED) === 'Agent: Codex · Launch: Direct', 'roster: direct Agent shows no Agent Deck', ui.rosterRuntimeLine(reloaded, NOT_FETCHED));
  const deckCreated = await call('POST', regUi.registrationCreateBody('Deck Codex', DECK_FORM));
  const deckReloaded = (await (await botsRoute.GET()).json()).find(b => b.id === deckCreated.json.id);
  assert(deckCreated.status === 200 && JSON.stringify(regUi.registrationFormFromBot(deckReloaded)) === JSON.stringify(DECK_FORM), 'Agent Deck Agent round-trips through create + reload');
  const deckRead = regUi.registrationReadView(deckReloaded, CONNECTED);
  assert(deckRead.rows.some(r => r.key === 'deck' && r.value === 'builder') && deckRead.rows.some(r => r.key === 'workdir'), 'Agent Deck read view adds deck and working directory rows');
  const edited = await call('PATCH', regUi.registrationPatchBody(created.json.id, { ...seeded, policyMode: 'workspace_write', allowResumeWithEdits: true }));
  assert(edited.status === 200 && edited.json.policy.allow_resume_with_edits === true && edited.json.launch_profile === 'direct', 'Config save body edits policy in place', JSON.stringify(edited.json));
  const legacy = db.bots.create({ name: 'Legacy', title: '', description: '', agent: 'codex', deck_name: 'relay-deck' });
  const legacyView = (await (await botsRoute.GET()).json()).find(b => b.id === legacy.id);
  assert(regUi.registrationFormFromBot(legacyView).launchProfile === '' && regUi.registrationReadView(legacyView, null).notices.some(n => n.includes('Choose Direct or Agent Deck') && n.includes('relay-deck')), 'unresolved Agent: Config asks the owner to choose, naming the legacy deck');

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
