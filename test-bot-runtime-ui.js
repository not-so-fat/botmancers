#!/usr/bin/env node
// NOT-445/NOT-456: agent + Agent Deck bot UI regression coverage.
//
// Proves, without a browser:
// (1) New Agent offers exactly one Agent (Hermes, Cursor, Claude, Codex,
//     Muse Code; Hermes pre-selected) plus the Agent Deck and working
//     directory every agent needs; no Runtime picker exists and Agent
//     Deck is never an agent option. The submit payload for every agent
//     goes through the real POST /api/bots handler and reads back one
//     agent and one deck.
// (2) Settings round-trips the one workspace server URL through the real
//     settings handler, and the deck picker / status line render the
//     loading, connected, empty, malformed, unreachable, unconfigured, and
//     retry states. The browser only calls /api/agent-deck/decks; the
//     proxy only calls <server>/api/launch/decks (never /api/decks).
// (3) The default workdir is shown as ~/.botmancers/{agentID}, stays
//     implicit when untouched, and an override round-trips create/edit/reset.
// (4) Roster and config render one "Agent: <agent> · Agent Deck: <deck>"
//     summary for every fixture, including migrated, unavailable-deck,
//     and non-local states; never "Runtime: Agent Deck".
// (5) Same-thread Agent Deck observations render in order.
// (6) NOT-457: New Agent and Config render Agent (fieldset/legend, five
//     options in order), then a required, label-associated Agent Deck
//     control, then the optional working directory, in every deck state;
//     Config saves agent / deck / workdir independently for Hermes and
//     Cursor; no user-facing source calls Agent Deck a runtime.
// (7) NOT-447: New Agent is one named modal dialog outside an inert page,
//     anchored under New with a 16px safe inset, and Tab/Shift+Tab wrap
//     inside it; Escape closes and focus returns to New.
// Components render through react-dom/server. Self-contained: isolated
// SQLite file, mocked upstream fetch, injected process seam. No dev
// server, no API key, no network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-bot-runtime-ui-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const ROOT = __dirname;
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT }, jsx: { runtime: 'automatic' } });
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const db = jiti('./lib/db.ts');
const agent = jiti('./lib/agent.ts');
const deck = jiti('./lib/agent-deck-run.ts');
const settingsLib = jiti('./lib/agent-deck-settings.ts');
const ui = jiti('./lib/bot-runtime-ui.ts');
const view = jiti('./app/components/AgentDeckRuntime.tsx');
const botsRoute = jiti('./app/api/bots/route.ts');
const settingsRoute = jiti('./app/api/agent-deck/settings/route.ts');
const decksRoute = jiti('./app/api/agent-deck/decks/route.ts');

const { bots, conversations, messages, workspaceSettings } = db;

let failures = 0;

function log(line) {
  console.log(line);
}

function assert(condition, label) {
  if (condition) {
    log(`  PASS: ${label}`);
  } else {
    failures++;
    log(`  FAIL: ${label}`);
  }
}

function render(component, props) {
  return renderToStaticMarkup(React.createElement(component, props));
}

function has(html, needle) {
  return html.includes(needle);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function jsonRequest(method, url, body) {
  return new Request(`http://localhost:43123${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const postBot = body => botsRoute.POST(jsonRequest('POST', '/api/bots', body));
const patchBot = body => botsRoute.PATCH(jsonRequest('PATCH', '/api/bots', body));

async function listedBot(id) {
  const res = await botsRoute.GET();
  const list = await res.json();
  return list.find(bot => bot.id === id);
}

// Upstream Agent Deck server mock: every proxy request is recorded.
const upstreamUrls = [];
let upstreamMode = 'connected';
const UPSTREAM_BODIES = {
  connected: { success: true, data: { decks: [{ id: 'planner', name: 'planner' }, { id: 'research', name: 'research' }] } },
  empty: { success: true, data: { decks: [] } },
  malformed: { success: true, data: { decks: [{ id: 42 }] } },
};
globalThis.fetch = async (url, init) => {
  upstreamUrls.push(`${(init && init.method) || 'GET'} ${url}`);
  if (upstreamMode === 'unreachable') throw new TypeError('fetch failed: connect ECONNREFUSED');
  const body = UPSTREAM_BODIES[upstreamMode];
  return { ok: true, status: 200, json: async () => body };
};

// Browser-side fetch: the UI's shared fetcher goes through the real
// Botmancers proxy handler.
const appUrls = [];
const appFetch = async url => {
  appUrls.push(`GET ${url}`);
  if (url !== ui.DECKS_ENDPOINT) throw new Error(`unexpected app request ${url}`);
  const res = await decksRoute.GET();
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

let clock = new Date(2026, 9, 13, 14, 2, 11).getTime();
const now = () => clock;

async function loadDecks(previous) {
  return ui.fetchDeckList(appFetch, previous || ui.initialDeckListState(), now);
}

function deckState(status, extra) {
  return { ...ui.initialDeckListState(), status, checkedAt: clock, serverUrl: 'http://127.0.0.1:1111', ...extra };
}

const CONNECTED = deckState('connected', {
  decks: [{ id: 'planner', name: 'planner' }, { id: 'research', name: 'research' }],
  cachedDecks: [{ id: 'planner', name: 'planner' }, { id: 'research', name: 'research' }],
});

function sectionHtml(form, state, extra) {
  return render(view.AgentSection, {
    idPrefix: 'bot',
    variant: 'modal',
    form,
    onChange() {},
    deckState: state,
    onRetry() {},
    workdirPlaceholder: '',
    workdirHint: ui.NEW_BOT_WORKDIR_HINT,
    ...extra,
  });
}

function checkedValue(html, name) {
  const match = new RegExp(`<input type="radio" name="${name}" checked="" value="([^"]+)"`).exec(html);
  return match ? match[1] : null;
}

function visibleFields(html) {
  return ['runtime', 'agent', 'deck', 'workdir'].filter(field => has(html, `data-field="${field}"`));
}

// Fake local machine for the same-thread trace.
const resumeSessions = {};
let runCounter = 0;
let failImplLog = false;
deck.setDeckRunProcess(async argv => {
  if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
    const runId = argv[3];
    const sessionId = resumeSessions[runId] || `ses-opaque-for-${runId}`;
    return {
      stdout: JSON.stringify({ runId, deck: 'planner', client: 'codex', state: 'ended', sessionId, logPath: `/tmp/fake-runs/${runId}/run.jsonl` }),
      stderr: '',
      exitCode: 0,
    };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
    const runId = argv[3];
    const session = resumeSessions[runId] || `ses-opaque-for-${runId}`;
    const lines = failImplLog
      ? [JSON.stringify({ t: 'text', text: 'working' }), JSON.stringify({ t: 'error', message: 'agent-deck run run-9f2c died' })]
      : [JSON.stringify({ t: 'text', text: 'working' }), JSON.stringify({ t: 'result', sessionId: session, result: `done by ${runId}` }), JSON.stringify({ t: 'end', sessionId: session })];
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  if (argv[0] === 'agent-deck' && argv[1] === 'run') {
    runCounter++;
    const runId = `run-fake-${runCounter}`;
    const resumeIdx = argv.indexOf('--resume');
    if (resumeIdx >= 0) resumeSessions[runId] = argv[resumeIdx + 1];
    return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-runs/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
});

async function settingsSection() {
  log('\n[2] Workspace settings: one server URL + deck-list states');
  workspaceSettings.clearForTests();
  const initial = await (await settingsRoute.GET()).json();
  log(`  GET ${ui.SETTINGS_ENDPOINT} -> ${JSON.stringify(initial)}`);
  assert(initial.server_url === 'http://127.0.0.1:1111', 'settings: unset workspace URL reads back the loopback default');
  const putRes = await settingsRoute.PUT(jsonRequest('PUT', ui.SETTINGS_ENDPOINT, { server_url: ' http://127.0.0.1:2222/ ' }));
  const put = await putRes.json();
  log(`  PUT ${ui.SETTINGS_ENDPOINT} {"server_url":" http://127.0.0.1:2222/ "} -> ${putRes.status} ${JSON.stringify(put)}`);
  assert(putRes.status === 200 && put.server_url === 'http://127.0.0.1:2222', 'settings: Save stores the one normalized workspace URL');
  const readBack = await (await settingsRoute.GET()).json();
  assert(readBack.server_url === 'http://127.0.0.1:2222', `settings: read-back returns the saved URL (${readBack.server_url})`);
  const badRes = await settingsRoute.PUT(jsonRequest('PUT', ui.SETTINGS_ENDPOINT, { server_url: 'ftp://nope' }));
  const bad = await badRes.json();
  log(`  PUT ${ui.SETTINGS_ENDPOINT} {"server_url":"ftp://nope"} -> ${badRes.status} ${bad.error}`);
  assert(badRes.status === 400 && typeof bad.error === 'string' && bad.error.length > 0, 'settings: invalid URL is rejected with the server error text (rendered verbatim inline)');
  assert((await (await settingsRoute.GET()).json()).server_url === 'http://127.0.0.1:2222', 'settings: rejected save leaves the stored URL unchanged');

  const loading = ui.initialDeckListState();
  const loadingStatus = render(view.SettingsStatus, { state: loading, onRetry() {} });
  const loadingSlot = sectionHtml({ agent: 'codex', deckId: '', workingDirectory: '' }, loading);
  log(`  [loading] status="${ui.settingsStatusLine(loading)}" slot="${ui.deckSlotCopy(loading)}"`);
  assert(has(loadingStatus, 'Status: ○ Checking the Agent Deck server…') && !has(loadingStatus, '>Retry<'), 'loading: settings shows the checking line with no Retry');
  assert(has(loadingSlot, 'Loading decks…') && !has(loadingSlot, '<select'), 'loading: deck slot reads "Loading decks…" with no dropdown');
  assert(ui.runtimeFormView({ agent: 'codex', deckId: '' }, loading).submitDisabled === true, 'loading: Create/Save is disabled');

  const expectations = [
    { mode: 'empty', status: 'empty', line: 'Status: ○ Connected — no decks on this server.', retry: true },
    { mode: 'malformed', status: 'malformed', line: "Status: ○ The server returned decks this app can't read.", retry: true },
    { mode: 'connected', status: 'connected', line: 'Status: ● Connected · 2 decks · checked 14:02:11', retry: false },
    { mode: 'unreachable', status: 'unreachable', line: "Status: ○ Can't reach the Agent Deck server.", retry: true },
  ];
  let previous = ui.initialDeckListState();
  for (const expected of expectations) {
    upstreamMode = expected.mode;
    const before = upstreamUrls.length;
    const state = await loadDecks(previous);
    previous = state;
    const statusHtml = render(view.SettingsStatus, { state, onRetry() {} });
    const slotHtml = sectionHtml({ agent: 'codex', deckId: '', workingDirectory: '' }, state);
    log(`  [${expected.mode}] upstream=${upstreamUrls.slice(before).join(', ')} state=${state.status} status="${ui.settingsStatusLine(state)}" slot="${ui.deckSlotCopy(state) ?? '<select>'}"`);
    assert(state.status === expected.status, `${expected.mode}: proxy response classifies as ${expected.status}`);
    assert(has(statusHtml, escapeHtml(expected.line)), `${expected.mode}: settings status line reads "${expected.line}"`);
    assert(has(statusHtml, '>Retry<') === expected.retry, `${expected.mode}: settings Retry ${expected.retry ? 'shown' : 'hidden'}`);
    if (expected.status === 'connected') {
      assert(
        has(slotHtml, '<select') && has(slotHtml, `>${escapeHtml(ui.DECK_PLACEHOLDER)}</option>`) &&
        has(slotHtml, '<option value="planner" title="planner">planner</option>') &&
        has(slotHtml, '<option value="research" title="research">research</option>'),
        'connected: dropdown lists exactly the returned deck ids with the "Select an Agent Deck…" placeholder'
      );
      assert(ui.runtimeFormView({ agent: 'codex', deckId: '' }, state).submitDisabled === false, 'connected: Agent Deck Create is enabled');
    } else {
      assert(has(slotHtml, escapeHtml(ui.DECK_SLOT_COPY[expected.status])) && !has(slotHtml, '<select') && !has(slotHtml, 'data-field="deck" type="text"'),
        `${expected.mode}: deck slot shows the blocking copy and never a dropdown or free-text input`);
      assert(has(slotHtml, '>Retry<'), `${expected.mode}: deck slot offers Retry`);
      const formView = ui.runtimeFormView({ agent: 'codex', deckId: '' }, state);
      assert(formView.submitDisabled === true && formView.blocker === ui.DECK_SLOT_COPY[expected.status], `${expected.mode}: Agent Deck Create/Save disabled with the blocking reason`);
      assert(ui.runtimeFormView({ agent: 'hermes', deckId: '' }, state).submitDisabled === true, `${expected.mode}: Hermes create is blocked too (every agent needs an Agent Deck)`);
    }
  }
  assert(previous.cachedDecks && previous.cachedDecks.map(d => d.id).join(',') === 'planner,research', 'unreachable: the last successful list stays cached for availability checks');

  upstreamMode = 'connected';
  clock += 60000;
  const retried = await loadDecks(previous);
  log(`  [retry] after unreachable -> ${retried.status} "${ui.settingsStatusLine(retried)}"`);
  assert(retried.status === 'connected' && ui.settingsStatusLine(retried) === 'Status: ● Connected · 2 decks · checked 14:03:11', 'retry: Retry re-issues the request and recovers to connected');

  const thrown = await ui.fetchDeckList(async () => { throw new Error('network down'); }, retried, now);
  assert(thrown.status === 'unreachable' && thrown.cachedDecks.map(d => d.id).join(',') === 'planner,research', 'unreachable: a failed browser request (network/timeout) is unreachable and keeps the cache');

  const unconfigured = ui.deckListStateFromResponse({ ok: true, status: 200, body: { server_url: '', decks: [] } }, ui.initialDeckListState(), clock);
  const unconfiguredStatus = render(view.SettingsStatus, { state: unconfigured, onRetry() {} });
  const unconfiguredSlot = sectionHtml({ agent: 'codex', deckId: '', workingDirectory: '' }, unconfigured);
  log(`  [unconfigured] status="${ui.settingsStatusLine(unconfigured)}" slot="${ui.deckSlotCopy(unconfigured)}"`);
  assert(has(unconfiguredStatus, 'Status: ○ No Agent Deck server set.') && !has(unconfiguredStatus, '>Retry<'), 'unconfigured: settings line with no Retry');
  assert(has(unconfiguredSlot, 'No Agent Deck server set — add it in Settings.') && has(unconfiguredSlot, 'href="/settings"') && !has(unconfiguredSlot, '>Retry<'), 'unconfigured: slot links to Settings with no Retry');

  const grantBody = { error: 'Agent Deck server refused deck discovery with GRANT_REQUIRED.', code: 'grant-required', server_url: 'http://127.0.0.1:2222' };
  assert(ui.deckListStateFromResponse({ ok: false, status: 502, body: grantBody }, ui.initialDeckListState(), clock).status === 'unreachable', 'grant-required: a refused discovery is shown as unreachable, never retried via /api/decks');

  log(`  app request URLs: ${[...new Set(appUrls)].join(', ')}`);
  log(`  upstream request URLs: ${[...new Set(upstreamUrls)].join(', ')}`);
  assert(appUrls.length > 0 && appUrls.every(url => url === `GET ${ui.DECKS_ENDPOINT}`), 'requests: the UI only calls the Botmancers proxy GET /api/agent-deck/decks');
  assert(upstreamUrls.length > 0 && upstreamUrls.every(url => url === 'GET http://127.0.0.1:2222/api/launch/decks'), 'requests: the proxy only calls GET <saved URL>/api/launch/decks');
  assert(![...appUrls, ...upstreamUrls].some(url => /\/api\/decks(\?|$)/.test(url)), 'requests: nothing ever calls /api/decks');
}

async function newBotSection() {
  log('\n[1] New Agent: one Agent choice plus the Agent Deck every agent needs');
  const defaultForm = ui.DEFAULT_RUNTIME_FORM;
  const defaultHtml = sectionHtml(defaultForm, CONNECTED);
  log(`  [default] visible fields: name, ${visibleFields(defaultHtml).join(', ')}`);
  assert(checkedValue(defaultHtml, 'bot-agent') === 'hermes', 'default: Agent picker pre-selects Hermes');
  assert(visibleFields(defaultHtml).join(',') === 'agent,deck,workdir', 'default: Agent + Agent Deck + Working directory are visible; no Runtime picker');
  assert(ui.runtimeFormView(defaultForm, CONNECTED).fields.join(',') === 'name,agent,deck,workdir', 'form view lists name,agent,deck,workdir');
  assert(!has(defaultHtml, '>Runtime<') && !has(defaultHtml, 'value="agent-deck"'), 'no Runtime label and no Agent Deck agent option');
  assert(!has(defaultHtml, 'Chat:') && !has(defaultHtml, 'Code:') && !has(defaultHtml, 'Server URL'), 'no dual-runtime or per-bot URL copy');
  assert(
    ui.AGENT_OPTIONS.map(option => option.label).join('|') === 'Hermes|Cursor|Claude|Codex|Muse Code' &&
    ui.AGENT_OPTIONS.map(option => option.value).join('|') === 'hermes|cursor|claude|codex|muse',
    'agents: options are exactly Hermes, Cursor, Claude, Codex, Muse Code in order'
  );
  assert(ui.AGENT_OPTIONS.every(option => has(defaultHtml, `value="${option.value}"`) && has(defaultHtml, ` ${escapeHtml(option.label)}</label>`)), 'agents: every option renders with its display label');
  assert(!/<option value="[^"]+" title="[^"]+" selected="">/.test(defaultHtml), 'deck has no pre-selection until the user picks one');

  const created = {};
  for (const option of ui.AGENT_OPTIONS) {
    const agentName = option.value;
    const form = { agent: agentName, deckId: 'planner', workingDirectory: '' };
    const html = sectionHtml(form, CONNECTED);
    assert(checkedValue(html, 'bot-agent') === agentName, `${option.label}: agent picker selects ${agentName}`);
    assert(has(html, 'href="/settings"') && has(html, escapeHtml(ui.NON_LOCAL_NOTE)), `${option.label}: links to Settings and carries the non-local note`);
    const body = ui.newBotSubmitBody({ name: `Bot ${agentName}`, ...form });
    log(`  [${agentName}] submit payload: ${JSON.stringify(body)}`);
    assert(
      body.agent === agentName && body.deck_id === 'planner' && !('working_directory' in body) && !('runtime' in body) && !('agent_client' in body),
      `${option.label}: submit sends agent and deck_id only (no runtime fields, untouched workdir omitted)`
    );
    const res = await postBot(body);
    const saved = await res.json();
    assert(res.status === 200 && saved.agent === agentName && saved.deck_id === 'planner' && saved.launchable === true && !('runtime' in saved),
      `${option.label}: POST /api/bots stores one launchable agent on its deck (got ${res.status})`);
    const listed = await listedBot(saved.id);
    const line = ui.rosterRuntimeLine(listed, CONNECTED);
    log(`  [${agentName}] roster: "${line}"`);
    assert(line === `Agent: ${option.label} · Agent Deck: planner`, `${option.label}: roster reads back "Agent: ${option.label} · Agent Deck: planner"`);
    created[agentName] = saved;
  }

  const missingDeck = ui.newBotSubmitBody({ name: 'NoDeck', ...defaultForm });
  const missingRes = await postBot(missingDeck);
  const missingErr = await missingRes.json();
  log(`  [no deck chosen] client copy="${ui.SELECT_DECK_ERROR}" server 400="${missingErr.error}"`);
  assert(missingRes.status === 400 && typeof missingErr.error === 'string', 'a deck-less submit is rejected for Hermes too (the modal blocks it first with "Select an Agent Deck for this agent.")');
  return created;
}

async function workdirSection(created) {
  log('\n[3] Working directory: implicit default, override create/read/edit/reset');
  const html = sectionHtml({ agent: 'codex', deckId: 'planner', workingDirectory: '' }, CONNECTED);
  log(`  [default] hint: "${ui.NEW_BOT_WORKDIR_HINT}"`);
  assert(has(html, escapeHtml('Default: ~/.botmancers/{agentID}')) && has(html, 'data-field="workdir" aria-describedby="bot-workdir-hint bot-workdir-note" placeholder="" value=""'), 'default: New Agent shows a blank workdir input with the ~/.botmancers/{agentID} hint');
  assert(!/~\/\.botmancers\/(hermes|codex|claude|cursor|muse)\b/.test(html), 'default: the hint never substitutes an agent name for {agentID}');

  const implicit = await listedBot(created.codex.id);
  const implicitView = ui.configRuntimeView(implicit, CONNECTED);
  const home = '/home/tester';
  log(`  [implicit] stored working_directory=${JSON.stringify(implicit.working_directory)} config="${implicitView.workingDirectory}" launch=${settingsLib.resolveBotWorkdir(implicit.id, implicit.working_directory, home)}`);
  assert(implicit.working_directory === null, 'implicit: untouched workdir stores no override');
  assert(implicitView.workingDirectory === `Working directory: ~/.botmancers/${implicit.id}`, 'implicit: config shows the resolved default with no (custom) marker');
  assert(settingsLib.resolveBotWorkdir(implicit.id, implicit.working_directory, home) === path.join(home, '.botmancers', implicit.id), 'implicit: the launch path matches the displayed default');
  const seed = ui.runtimeFormFromBot(implicit);
  assert(seed.workingDirectory === '', 'edit: the default-workdir bot opens with a blank workdir input');
  const untouched = ui.configRuntimePatchBody(implicit.id, seed);
  assert(untouched.working_directory === '', 'edit: saving an untouched workdir keeps it implicit');
  const typedDefault = ui.configRuntimePatchBody(implicit.id, { ...seed, workingDirectory: `~/.botmancers/${implicit.id}` });
  assert(typedDefault.working_directory === '', 'edit: typing the default path verbatim still stores no override');

  const overrideBody = ui.newBotSubmitBody({ name: 'Custom', agent: 'claude', deckId: 'research', workingDirectory: '  /Users/you/workspace/codes  ' });
  log(`  [create override] payload: ${JSON.stringify(overrideBody)}`);
  assert(overrideBody.working_directory === '/Users/you/workspace/codes', 'create: a typed override is submitted (trimmed)');
  const overrideSaved = await (await postBot(overrideBody)).json();
  const overrideRead = await listedBot(overrideSaved.id);
  const overrideView = ui.configRuntimeView(overrideRead, CONNECTED);
  log(`  [read-back override] config="${overrideView.summary}" / "${overrideView.workingDirectory}"`);
  assert(overrideRead.working_directory === '/Users/you/workspace/codes', 'read-back: override round-trips through POST /api/bots');
  assert(overrideView.workingDirectory === 'Working directory: /Users/you/workspace/codes (custom)', 'read-back: config marks the override (custom)');
  assert(ui.runtimeFormFromBot(overrideRead).workingDirectory === '/Users/you/workspace/codes', 'edit: the override pre-fills the workdir input');

  const editBody = ui.configRuntimePatchBody(implicit.id, { ...seed, workingDirectory: '/tmp/edited-workdir' });
  log(`  [edit] PATCH payload: ${JSON.stringify(editBody)}`);
  const editRes = await patchBot(editBody);
  const edited = await listedBot(implicit.id);
  assert(editRes.status === 200 && edited.working_directory === '/tmp/edited-workdir', 'edit: a new override round-trips through PATCH /api/bots');
  assert(ui.configRuntimeView(edited, CONNECTED).workingDirectory === 'Working directory: /tmp/edited-workdir (custom)', 'edit: config shows the edited override (custom)');

  const resetBody = ui.configRuntimePatchBody(implicit.id, { ...ui.runtimeFormFromBot(edited), workingDirectory: '' });
  log(`  [reset] PATCH payload: ${JSON.stringify(resetBody)}`);
  const resetRes = await patchBot(resetBody);
  const reset = await listedBot(implicit.id);
  log(`  [reset] stored=${JSON.stringify(reset.working_directory)} config="${ui.configRuntimeView(reset, CONNECTED).workingDirectory}" roster="${ui.rosterRuntimeLine(reset, CONNECTED)}"`);
  assert(resetRes.status === 200 && reset.working_directory === null, 'reset: clearing the input restores the implicit default');
  assert(reset.agent === 'codex' && reset.launchable === true && ui.rosterRuntimeLine(reset, CONNECTED) === 'Agent: Codex · Agent Deck: planner', 'reset: the bot keeps its agent and Agent Deck');
  assert(ui.configRuntimeView(reset, CONNECTED).workingDirectory === `Working directory: ~/.botmancers/${implicit.id}`, 'reset: config shows the default without (custom)');
}

async function rosterConfigSection(created) {
  log('\n[4] Roster + config: one agent + Agent Deck summary per fixture');
  const hermes = await (await postBot({ name: 'Plain', deck_id: 'research' })).json();
  const configured = await listedBot(created.claude.id);
  const goneRes = await patchBot({ id: created.cursor.id, deck_id: 'gone-deck' });
  assert(goneRes.status === 200, 'fixture: cursor bot points at a deck absent from the server');
  const gone = await listedBot(created.cursor.id);
  const migratedRow = bots.create({
    name: 'Legacy', title: '', description: '',
    agent: 'codex', deck_id: null, deck_name: 'planner',
    working_directory: '/Users/you/legacy',
  });
  const migrated = await listedBot(migratedRow.id);

  const unreachableCached = deckState('unreachable', { cachedDecks: [{ id: 'planner', name: 'planner' }, { id: 'research', name: 'research' }] });
  const unreachableBare = deckState('unreachable', { cachedDecks: null });
  const unconfigured = deckState('unconfigured', { serverUrl: '' });
  const remote = { ...CONNECTED, serverUrl: 'http://10.0.0.5:1111' };

  const hermesPending = await listedBot(bots.create({ name: 'Imported Hermes', title: '', description: '', agent: 'hermes' }).id);
  const fixtures = [
    { label: 'Hermes agent', bot: hermes, state: CONNECTED, roster: 'Agent: Hermes · Agent Deck: research', config: 'Agent: Hermes · Agent Deck: research', notice: null },
    { label: 'Hermes agent without a deck', bot: hermesPending, state: CONNECTED, roster: 'Agent: Hermes · Agent Deck: not selected — select in Config', config: 'Agent: Hermes · Agent Deck: not selected', notice: 'No Agent Deck selected. Pick a deck from the configured server before this agent can run.' },
    { label: 'Claude agent (deck on server)', bot: configured, state: CONNECTED, roster: 'Agent: Claude · Agent Deck: planner', config: 'Agent: Claude · Agent Deck: planner', notice: null },
    { label: 'Unavailable saved deck (fresh list)', bot: gone, state: CONNECTED, roster: 'Agent: Cursor · Agent Deck: gone-deck (deck unavailable — see Config)', config: 'Agent: Cursor · Agent Deck: gone-deck (deck unavailable)', notice: ui.UNAVAILABLE_DECK_NOTICE },
    { label: 'Unavailable saved deck (cached list, outage)', bot: gone, state: unreachableCached, roster: 'Agent: Cursor · Agent Deck: gone-deck (deck unavailable — see Config)', config: 'Agent: Cursor · Agent Deck: gone-deck (deck unavailable)', notice: ui.UNAVAILABLE_DECK_NOTICE },
    { label: 'Deck in cache during outage', bot: configured, state: unreachableCached, roster: 'Agent: Claude · Agent Deck: planner', config: 'Agent: Claude · Agent Deck: planner', notice: null },
    { label: 'Outage with no cached list', bot: gone, state: unreachableBare, roster: 'Agent: Cursor · Agent Deck: gone-deck', config: 'Agent: Cursor · Agent Deck: gone-deck', notice: ui.UNCHECKED_DECK_NOTICE },
    { label: 'No server configured', bot: gone, state: unconfigured, roster: 'Agent: Cursor · Agent Deck: gone-deck', config: 'Agent: Cursor · Agent Deck: gone-deck', notice: ui.UNCONFIGURED_DECK_NOTICE },
    { label: 'Migrated agent awaiting deck selection', bot: migrated, state: CONNECTED, roster: 'Agent: Codex · Agent Deck: not selected — select in Config', config: 'Agent: Codex · Agent Deck: not selected', notice: 'No Agent Deck selected (was "planner"). Pick a deck from the configured server before this agent can run.' },
    { label: 'Non-local workspace server', bot: configured, state: remote, roster: 'Agent: Claude · Agent Deck: planner', config: 'Agent: Claude · Agent Deck: planner', notice: ui.REMOTE_SERVER_LIMITATION },
  ];
  for (const fixture of fixtures) {
    const roster = ui.rosterRuntimeLine(fixture.bot, fixture.state);
    const config = ui.configRuntimeView(fixture.bot, fixture.state);
    log(`  [${fixture.label}] roster="${roster}" config="${config.summary}" notices=${JSON.stringify(config.notices)} action="${config.action}"`);
    assert(roster === fixture.roster, `${fixture.label}: roster line`);
    assert(config.summary === fixture.config, `${fixture.label}: config summary`);
    assert(fixture.notice === null ? config.notices.length === 0 : config.notices.includes(fixture.notice), `${fixture.label}: config notice`);
    assert(config.action === 'Edit', `${fixture.label}: config action "Edit"`);
    assert(!/Chat:|Code:|Runtime:/.test(roster + config.summary) && !roster.includes('\n'), `${fixture.label}: exactly one line, no Chat:/Code:/Runtime:`);
    const parts = ui.rosterRuntimeParts(fixture.bot, fixture.state);
    assert(parts.prefix + parts.deck + parts.suffix === roster, `${fixture.label}: roster parts join back to the line`);
  }
  const staleUuidParts = ui.rosterRuntimeParts(
    { id: 'b2', agent: 'codex', deck_id: '00000000-dead-4bee-8000-000000000000', launchable: true },
    CONNECTED
  );
  log(`  [uuid unavailable deck] parts=${JSON.stringify(staleUuidParts)}`);
  assert(staleUuidParts.deck === '00000000-dead-4bee-8000-000000000000' && staleUuidParts.suffix === ui.ROSTER_UNAVAILABLE_SUFFIX, 'roster parts: a UUID-only deck truncates separately from the unavailable marker');
  const uuidState = deckState('connected', { decks: [{ id: '078fde81-3422-4630-8dce-c22070c4d09a', name: 'planner' }] });
  const uuidBot = { id: 'b1', agent: 'codex', deck_id: '078fde81-3422-4630-8dce-c22070c4d09a', launchable: true };
  const uuidHtml = sectionHtml({ agent: 'codex', deckId: '', workingDirectory: '' }, uuidState);
  log(`  [uuid deck ids] roster="${ui.rosterRuntimeLine(uuidBot, uuidState)}" no-list="${ui.rosterRuntimeLine(uuidBot, null)}"`);
  assert(has(uuidHtml, '<option value="078fde81-3422-4630-8dce-c22070c4d09a" title="078fde81-3422-4630-8dce-c22070c4d09a">planner</option>'), 'deck names: dropdown labels each option with the server name and submits the id');
  assert(ui.rosterRuntimeLine(uuidBot, uuidState) === 'Agent: Codex · Agent Deck: planner', 'deck names: summary shows the deck name when the list is known');
  assert(ui.rosterRuntimeLine(uuidBot, null) === 'Agent: Codex · Agent Deck: 078fde81-3422-4630-8dce-c22070c4d09a', 'deck names: summary falls back to the stored id when no list is known');
  assert(ui.configRuntimeView(migrated, CONNECTED).workingDirectory === 'Working directory: /Users/you/legacy (custom)', 'migrated: the carried-over workdir shows as (custom)');
  const migratedSeed = ui.runtimeFormFromBot(migrated);
  assert(migratedSeed.deckId === '' && migratedSeed.agent === 'codex', 'migrated: edit opens with no deck so the owner must pick one from the server');
  const reselect = await patchBot(ui.configRuntimePatchBody(migrated.id, { ...migratedSeed, deckId: 'planner', workingDirectory: '/Users/you/legacy' }));
  const resolved = await listedBot(migrated.id);
  log(`  [migrated -> re-selected] roster="${ui.rosterRuntimeLine(resolved, CONNECTED)}" launchable=${resolved.launchable}`);
  assert(reselect.status === 200 && resolved.launchable === true && resolved.deck_name === null && ui.rosterRuntimeLine(resolved, CONNECTED) === 'Agent: Codex · Agent Deck: planner', 'migrated: picking a deck resolves the agent to launchable');

  const editHtml = render(view.AgentSection, {
    idPrefix: 'cfg', variant: 'config', form: ui.runtimeFormFromBot(gone), onChange() {}, deckState: CONNECTED, onRetry() {},
    savedDeckId: gone.deck_id, workdirPlaceholder: ui.defaultWorkdirFor(gone.id), workdirHint: ui.configWorkdirHint(gone.id),
  });
  assert(has(editHtml, '<option value="gone-deck" title="gone-deck" selected="">gone-deck (saved)</option>') && has(editHtml, escapeHtml(ui.SAVED_DECK_MISSING_NOTE)), 'config edit: the saved-but-missing deck stays displayed with the keep-it note');
  assert(has(editHtml, `placeholder="~/.botmancers/${gone.id}"`) && !has(editHtml, 'Server URL'), 'config edit: workdir placeholder shows this bot\'s default; no per-bot URL');
  const toHermesBody = ui.configRuntimePatchBody(gone.id, { ...ui.runtimeFormFromBot(gone), agent: 'hermes' });
  assert(JSON.stringify(toHermesBody) === `{"id":"${gone.id}","agent":"hermes","deck_id":"gone-deck","working_directory":""}`, 'config edit: saving sends agent + deck_id (+ workdir), never runtime');
  const toHermesRes = await patchBot(toHermesBody);
  const nowHermes = await listedBot(gone.id);
  assert(toHermesRes.status === 200 && ui.rosterRuntimeLine(nowHermes, CONNECTED) === 'Agent: Hermes · Agent Deck: gone-deck (deck unavailable — see Config)', 'config edit: switching to Hermes keeps the Agent Deck selection');

  for (const url of ['http://127.0.0.1:1111', 'http://localhost:1111', 'http://[::1]:1111', 'http://10.0.0.5:1111', 'https://deck.example.com']) {
    assert(ui.isLocalServerUrl(url) === settingsLib.isLocalAgentDeckUrl(url), `non-local: UI locality check matches the launch guard for ${url}`);
  }
}

async function traceSection() {
  log('\n[5] Same-thread Agent Deck trace');
  agent.setDelegationChatStub(async () => 'hello there');
  const bot = bots.create({ name: 'Delegator', title: '', description: '', deck_id: 'planner' });
  const conv = conversations.getByBotId(bot.id);
  const result = await deck.delegateCodingViaDeck({
    conversationId: conv.id, botId: bot.id, deck: 'planner', client: 'codex', cwd: '/tmp/fake-cwd',
    task: 'Add rate limiting to the login route', reviewFocus: deck.DECK_REVIEW_FOCUS_DEFAULT,
  });
  assert(!!result, 'trace: launch-through-result sequence completes');
  const thread = messages.getByConversation(conv.id).filter(m => m.sender_type === 'bot').map(m => m.content);
  const kinds = ui.orderedDeckEventKinds(thread);
  assert(JSON.stringify(kinds) === JSON.stringify(['handoff', 'run', 'review', 'resume', 'result']), `trace: observations render in order (${kinds.join(' > ')})`);
  const labels = thread.flatMap(t => t.split('\n')).map(line => ui.deckEventDisplay(line)).filter(Boolean);
  for (const item of labels) log(`  ${item.label}: ${item.detail.split('\n')[0].slice(0, 90)}`);
  assert(labels.map(item => item.label).join(' > ') === 'Agent Deck launch > Agent Deck run > Agent Deck review > Agent Deck resume > Agent Deck result', 'trace: each line is labelled as an Agent Deck observation');
  assert(labels[0].detail.includes('agent=codex') && labels[0].detail.includes('deck=planner'), 'trace: launch carries the selected agent and deck verbatim');
  assert(!labels.some(item => /Hermes|handoff/i.test(item.label)), 'trace: no label describes a Hermes-to-code handoff');
  const runLine = thread.find(t => t.includes('[Deck run]'));
  assert(!!runLine && runLine.includes('runId=run-fake-1') && runLine.includes('sessionId=ses-opaque-for-run-fake-1'), 'trace: run carries the opaque run and session ids verbatim');

  const failingBot = bots.create({ name: 'Failer', title: '', description: '', deck_id: 'planner' });
  const failingConv = conversations.getByBotId(failingBot.id);
  failImplLog = true;
  let threw = false;
  try {
    await deck.delegateCodingViaDeck({
      conversationId: failingConv.id, botId: failingBot.id, deck: 'planner', client: 'codex', cwd: '/tmp/fake-cwd',
      task: 'Break the build', reviewFocus: deck.DECK_REVIEW_FOCUS_DEFAULT,
    });
  } catch {
    threw = true;
  } finally {
    failImplLog = false;
  }
  const failingThread = messages.getByConversation(failingConv.id).filter(m => m.sender_type === 'bot').map(m => m.content);
  const failingKinds = ui.orderedDeckEventKinds(failingThread);
  assert(threw && failingKinds[0] === 'handoff' && failingKinds[failingKinds.length - 1] === 'failed', `failure: launch then failure render in the originating thread (${failingKinds.join(' > ')})`);
  const failed = ui.deckEventDisplay(failingThread.find(t => t.includes('[Deck failed]')));
  assert(failed.label === 'Agent Deck failed' && failed.detail.includes('agent=codex') && failed.detail.includes('deck=planner'), 'failure: labelled Agent Deck failed with agent and deck');
  assert(ui.deckEventDisplay(agent.deckNeedsSelectionMessage('Relay', null)).label === 'Agent Deck needs a deck', 'trace: the needs-selection notice renders as an Agent Deck event');
  assert(ui.deckEventDisplay('[Deck needs reselection] Relay cannot launch: no deck ID is selected.').label === 'Agent Deck needs a deck', 'trace: pre-NOT-456 needs-reselection notices still render');
  assert(ui.deckEventDisplay('plain reply') === null, 'trace: ordinary bot text is untouched');
  deck.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);
}

function fieldOrder(html, prefix) {
  return [
    html.indexOf(`<legend id="${prefix}-agent-label"`),
    html.search(new RegExp(`<label[^>]*id="${prefix}-deck-label"[^>]*>Agent Deck</label>`)),
    html.indexOf(`for="${prefix}-workdir">Working directory (optional)</label>`),
  ];
}

function radioValues(html, name) {
  return [...html.matchAll(new RegExp(`<input type="radio" name="${name}"[^>]*value="([^"]+)"`, 'g'))].map(m => m[1]);
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'api' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

async function hierarchySection() {
  log('\n[6] NOT-457: Agent first, then Agent Deck, then optional working directory');
  const states = {
    loading: ui.initialDeckListState(),
    connected: CONNECTED,
    empty: deckState('empty'),
    malformed: deckState('malformed'),
    unreachable: deckState('unreachable'),
    unconfigured: deckState('unconfigured', { serverUrl: '' }),
  };
  for (const variant of ['modal', 'config']) {
    const prefix = variant === 'modal' ? 'bot' : 'cfg';
    for (const [status, state] of Object.entries(states)) {
      const html = render(view.AgentSection, {
        idPrefix: prefix, variant, form: { agent: 'cursor', deckId: '', workingDirectory: '' }, onChange() {}, deckState: state, onRetry() {},
        workdirPlaceholder: '', workdirHint: ui.NEW_BOT_WORKDIR_HINT,
      });
      const order = fieldOrder(html, prefix);
      const tag = `${variant}/${status}`;
      log(`  [${tag}] order(agent,deck,workdir)=${order.join(',')} agents=${radioValues(html, `${prefix}-agent`).join('|')}`);
      assert(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], `${tag}: Agent, then Agent Deck, then Working directory`);
      assert(radioValues(html, `${prefix}-agent`).join('|') === 'hermes|cursor|claude|codex|muse', `${tag}: one Agent group with exactly five options in order`);
      assert(has(html, `<fieldset class="agent-fieldset" data-field="agent"><legend id="${prefix}-agent-label"`) && has(html, `role="radiogroup" aria-labelledby="${prefix}-agent-label" aria-required="true"`), `${tag}: Agent group is a fieldset named by its legend`);
      assert(!/Runtime/.test(html) && !has(html, 'value="agent-deck"') && !/<input type="radio"[^>]*>\s*Agent Deck</.test(html), `${tag}: no Runtime copy and Agent Deck is never an Agent option`);
      assert(has(html, `id="${prefix}-workdir"`) && !/id="[^"]*-workdir"[^>]*required/.test(html) && has(html, `aria-describedby="${prefix}-workdir-hint ${prefix}-workdir-note"`), `${tag}: working directory is optional and described by its hint`);
      if (status === 'connected') {
        assert(has(html, `for="${prefix}-deck">Agent Deck</label>`) && /<select id="(bot|cfg)-deck"[^>]*aria-required="true"/.test(html), `${tag}: Agent Deck is a required <select> associated with its label`);
        assert(!/<select[^>]*\srequired=""/.test(html), `${tag}: no native required, so the "${ui.SELECT_DECK_ERROR}" validation is reachable on submit`);
      } else {
        assert(!has(html, '<select') && !has(html, `for="${prefix}-deck"`) && has(html, `role="group" aria-labelledby="${prefix}-deck-label"`) && /<p id="(bot|cfg)-deck" class="[^"]*" role="status">/.test(html) && has(html, escapeHtml(ui.DECK_SLOT_COPY[status])), `${tag}: Agent Deck slot is a group labelled "Agent Deck" whose status keeps its own text`);
        assert(has(html, '>Retry<') === ui.deckStateShowsRetry(state), `${tag}: Retry ${ui.deckStateShowsRetry(state) ? 'offered' : 'not offered'}`);
      }
    }
  }

  log('  Config saves each field independently (Hermes, Cursor)');
  for (const agentName of ['hermes', 'cursor']) {
    const label = agentName === 'hermes' ? 'Hermes' : 'Cursor';
    const saved = await (await postBot({ name: `Indie ${label}`, agent: agentName, deck_id: 'planner' })).json();
    const steps = [
      { field: 'deck', patch: { deckId: 'research' }, expect: { agent: agentName, deck_id: 'research', working_directory: null } },
      { field: 'workdir', patch: { workingDirectory: '/tmp/indie' }, expect: { agent: agentName, deck_id: 'research', working_directory: '/tmp/indie' } },
      { field: 'agent', patch: { agent: agentName === 'hermes' ? 'cursor' : 'hermes' }, expect: { agent: agentName === 'hermes' ? 'cursor' : 'hermes', deck_id: 'research', working_directory: '/tmp/indie' } },
    ];
    for (const step of steps) {
      const before = await listedBot(saved.id);
      const res = await patchBot(ui.configRuntimePatchBody(saved.id, { ...ui.runtimeFormFromBot(before), ...step.patch }));
      const after = await listedBot(saved.id);
      const got = { agent: after.agent, deck_id: after.deck_id, working_directory: after.working_directory };
      log(`  [${label}: edit ${step.field}] PATCH ${res.status} -> reload ${JSON.stringify(got)} roster="${ui.rosterRuntimeLine(after, CONNECTED)}"`);
      assert(res.status === 200 && JSON.stringify(got) === JSON.stringify(step.expect), `${label}: editing ${step.field} alone saves it and keeps the other fields`);
    }
  }

  const rendered = sourceFiles(path.join(ROOT, 'app')).concat([path.join(ROOT, 'lib', 'bot-runtime-ui.ts')]);
  const offenders = rendered.filter(file => /\bRuntime\s*:|>\s*Runtime\b|['"`]Runtime\b/.test(fs.readFileSync(file, 'utf8')));
  log(`  copy scan: ${rendered.length} UI source files; offenders=${JSON.stringify(offenders.map(f => path.relative(ROOT, f)))}`);
  assert(offenders.length === 0, 'copy: no UI source renders "Runtime: <anything>" or a Runtime label/string');
  const pageSource = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  const configSource = fs.readFileSync(path.join(ROOT, 'app', 'bots', '[id]', 'config', 'page.tsx'), 'utf8');
  assert(/>\s*New Agent\s*<\/h2>/.test(pageSource) && has(pageSource, 'aria-label="New Agent"') && !/New Group|aria-pressed=\{kind/.test(pageSource), 'copy: the modal titles the one agent form "New Agent" with no kind switch');
  assert(!/>\s*Bot\s*</.test(pageSource) && !has(pageSource, 'Rename Bot') && !has(pageSource, 'Failed to create bot') && !has(pageSource, "|| 'Bot'"), 'copy: no "Bot" label in the roster/modal');
  assert(has(configSource, 'Agent configuration') && has(configSource, 'Agent not found.') && !/Bot (configuration|not found)/.test(configSource), 'copy: Config page says Agent, not Bot');
  assert(ui.SELECT_DECK_ERROR === 'Select an Agent Deck for this agent.' && ui.DECK_PLACEHOLDER === 'Select an Agent Deck…', 'copy: validation and placeholder name the Agent Deck');
}

function dialogSection() {
  log('\n(7) NOT-447 New Agent dialog shell');
  const dialog = jiti('./lib/new-agent-dialog.ts');
  const page = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
  const shell = page.slice(page.indexOf('function BotModal('));
  const dialogs = shell.match(/role="dialog"/g) || [];
  assert(dialogs.length === 1 && has(shell, 'aria-modal="true"') && has(shell, 'aria-labelledby="new-agent-title"')
    && /<h2 id="new-agent-title"[^>]*>\s*New Agent\s*<\/h2>/.test(shell), 'one role="dialog" aria-modal="true" named by its "New Agent" heading');
  assert(/inert=\{showBotModal\}/.test(page) && page.indexOf('<BotModal') > page.indexOf('inert={showBotModal}')
    && /\{showBotModal && \(\s*<BotModal/.test(page), 'the page is inert while the dialog renders outside it');
  assert(/ref=\{newRef\}[^>]*aria-haspopup="dialog"/.test(page) && /setShowBotModal\(false\);\s*requestAnimationFrame\(\(\) => newRef\.current\?\.focus\(\)\)/.test(page), 'closing returns focus to New');
  assert(/nameRef\.current\?\.focus\(\)/.test(shell) && has(shell, 'ref={nameRef} id="bot-name"'), 'opening focuses the Name field');
  assert(/e\.key !== 'Escape'[^]*?onClose\(\)/.test(shell), 'Escape closes the dialog');
  assert(!/group|member-picks|setKind/i.test(shell), 'the dialog has no Group tab, member picker, or kind switch');

  const desktop = dialog.newAgentDialogPlacement({ left: 16, bottom: 110 }, { width: 1280, height: 720 });
  log(`  placement 1280x720 under New(16,110): ${JSON.stringify(desktop)}`);
  assert(desktop.top === 118 && desktop.left === 16 && desktop.maxHeight === 720 - 118 - 16, 'desktop: anchored 8px under New, body capped to the 16px bottom inset');
  const narrow = dialog.newAgentDialogPlacement({ left: 16, bottom: 110 }, { width: 390, height: 844 });
  log(`  placement 390x844: ${JSON.stringify(narrow)}`);
  assert(narrow.left === 16 && narrow.left + Math.min(dialog.DIALOG_WIDTH, 390 - 32) === 390 - 16 && narrow.top + narrow.maxHeight === 844 - 16, 'narrow: 16px inset on both sides and the bottom');
  const tiny = dialog.newAgentDialogPlacement({ left: 16, bottom: 110 }, { width: 360, height: 640 });
  log(`  placement 360x640: ${JSON.stringify(tiny)}`);
  assert(tiny.left === 16 && tiny.left + Math.min(dialog.DIALOG_WIDTH, 360 - 32) === 360 - 16, 'sub-390: the dialog shrinks to keep the 16px inset on both sides');
  const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
  const dialogRule = (css.match(/\.form-card\.new-agent-dialog\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/width:\s*min\(358px,\s*calc\(100vw - 32px\)\)/.test(dialogRule) && /max-width:\s*none/.test(dialogRule),
    'CSS: the dialog width rule outranks .form-card (width:100%, max-width:358px) so it shrinks with the viewport');
  const short = dialog.newAgentDialogPlacement({ left: 16, bottom: 110 }, { width: 1280, height: 420 });
  log(`  placement 1280x420: ${JSON.stringify(short)}`);
  assert(short.top === 16 && short.maxHeight === 420 - 32, 'short: moves to the top inset rather than squeezing under New');
  const farRight = dialog.newAgentDialogPlacement({ left: 1200, bottom: 60 }, { width: 1280, height: 720 });
  assert(farRight.left === 1280 - 16 - 358, 'an anchor near the right edge is clamped inside the inset');
  assert(JSON.stringify(dialog.newAgentDialogPlacement(null, { width: 390, height: 844 })) === JSON.stringify({ top: 16, left: 16, maxHeight: 812 }), 'no anchor: falls back to the inset corner');

  const order = ['Name', 'Hermes', 'Agent Deck', 'Working directory', 'Cancel', 'Create'];
  const wrap = dialog.wrapFocusTarget;
  assert(wrap(order, 'Create', false) === 'Name' && wrap(order, 'Name', true) === 'Create', 'Tab from the last control wraps to Name; Shift+Tab from Name wraps to the last');
  assert(wrap(order, 'Hermes', false) === null && wrap(order, 'Cancel', true) === null, 'Tab inside the sequence is left to the browser');
  assert(wrap(order, null, false) === 'Name' && wrap(order, 'outside', true) === 'Create', 'focus outside the dialog is pulled back in');
  assert(wrap([], 'Name', false) === null, 'no focusable controls: no wrap');
}

async function main() {
  log('NOT-445/NOT-456/NOT-457 agent + Agent Deck UI test (real handlers, isolated DB, mocked Agent Deck server, react-dom/server)');
  log(`DB: ${DB_PATH}`);
  await settingsSection();
  const created = await newBotSection();
  await workdirSection(created);
  await rosterConfigSection(created);
  await traceSection();
  await hierarchySection();
  dialogSection();
  log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures} assertion(s))`}`);
  return failures === 0;
}

function cleanup() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* best effort */ }
  }
}

main()
  .then(ok => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('bot-runtime-ui test crashed:', error);
    cleanup();
    process.exit(1);
  });
