#!/usr/bin/env node
// NOT-445: single-runtime bot UI regression coverage.
//
// Proves, without a browser:
// (1) New Bot defaults to Hermes and shows the Agent Deck agent / deck /
//     working-directory controls only while Agent Deck is selected; the
//     submit payload for Hermes and every agent goes through the real
//     POST /api/bots handler and reads back one runtime.
// (2) Settings round-trips the one workspace server URL through the real
//     settings handler, and the deck picker / status line render the
//     loading, connected, empty, malformed, unreachable, unconfigured, and
//     retry states. The browser only calls /api/agent-deck/decks; the
//     proxy only calls <server>/api/launch/decks (never /api/decks).
// (3) The default workdir is shown as ~/.botmancers/{agentID}, stays
//     implicit when untouched, and an override round-trips create/edit/reset.
// (4) Roster and config render one runtime summary for every fixture,
//     including migrated, unavailable-deck, and non-local states.
// (5) Same-thread Agent Deck observations render in order and are
//     labelled as the bot's Agent Deck runtime.
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
  return render(view.RuntimeSection, {
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
  const loadingSlot = sectionHtml({ runtime: 'agent-deck', agentClient: 'codex', deckId: '', workingDirectory: '' }, loading);
  log(`  [loading] status="${ui.settingsStatusLine(loading)}" slot="${ui.deckSlotCopy(loading)}"`);
  assert(has(loadingStatus, 'Status: ○ Checking the Agent Deck server…') && !has(loadingStatus, '>Retry<'), 'loading: settings shows the checking line with no Retry');
  assert(has(loadingSlot, 'Loading decks…') && !has(loadingSlot, '<select'), 'loading: deck slot reads "Loading decks…" with no dropdown');
  assert(ui.runtimeFormView({ runtime: 'agent-deck', deckId: '' }, loading).submitDisabled === true, 'loading: Agent Deck Create/Save is disabled');

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
    const slotHtml = sectionHtml({ runtime: 'agent-deck', agentClient: 'codex', deckId: '', workingDirectory: '' }, state);
    log(`  [${expected.mode}] upstream=${upstreamUrls.slice(before).join(', ')} state=${state.status} status="${ui.settingsStatusLine(state)}" slot="${ui.deckSlotCopy(state) ?? '<select>'}"`);
    assert(state.status === expected.status, `${expected.mode}: proxy response classifies as ${expected.status}`);
    assert(has(statusHtml, escapeHtml(expected.line)), `${expected.mode}: settings status line reads "${expected.line}"`);
    assert(has(statusHtml, '>Retry<') === expected.retry, `${expected.mode}: settings Retry ${expected.retry ? 'shown' : 'hidden'}`);
    if (expected.status === 'connected') {
      assert(
        has(slotHtml, '<select') && has(slotHtml, `>${escapeHtml(ui.DECK_PLACEHOLDER)}</option>`) &&
        has(slotHtml, '<option value="planner" title="planner">planner</option>') &&
        has(slotHtml, '<option value="research" title="research">research</option>'),
        'connected: dropdown lists exactly the returned deck ids with the "Select a deck…" placeholder'
      );
      assert(ui.runtimeFormView({ runtime: 'agent-deck', deckId: '' }, state).submitDisabled === false, 'connected: Agent Deck Create is enabled');
    } else {
      assert(has(slotHtml, escapeHtml(ui.DECK_SLOT_COPY[expected.status])) && !has(slotHtml, '<select') && !has(slotHtml, 'data-field="deck" type="text"'),
        `${expected.mode}: deck slot shows the blocking copy and never a dropdown or free-text input`);
      assert(has(slotHtml, '>Retry<'), `${expected.mode}: deck slot offers Retry`);
      const formView = ui.runtimeFormView({ runtime: 'agent-deck', deckId: '' }, state);
      assert(formView.submitDisabled === true && formView.blocker === ui.DECK_SLOT_COPY[expected.status], `${expected.mode}: Agent Deck Create/Save disabled with the blocking reason`);
      assert(ui.runtimeFormView({ runtime: 'hermes', deckId: '' }, state).submitDisabled === false, `${expected.mode}: Hermes create is unaffected`);
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
  const unconfiguredSlot = sectionHtml({ runtime: 'agent-deck', agentClient: 'codex', deckId: '', workingDirectory: '' }, unconfigured);
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
  log('\n[1] New Bot: Hermes default, Agent Deck field visibility, submit payloads');
  const hermesForm = { runtime: 'hermes', agentClient: 'codex', deckId: '', workingDirectory: '' };
  const hermesHtml = sectionHtml(hermesForm, CONNECTED);
  log(`  [hermes] visible fields: name, ${visibleFields(hermesHtml).join(', ')}`);
  assert(checkedValue(hermesHtml, 'bot-runtime') === 'hermes', 'default: Runtime picker pre-selects Hermes');
  assert(visibleFields(hermesHtml).join(',') === 'runtime', 'hermes: only Name + Runtime are visible (no agent, deck, or workdir)');
  assert(ui.runtimeFormView(hermesForm, CONNECTED).fields.join(',') === 'name,runtime', 'hermes: form view lists name,runtime');
  assert(!has(hermesHtml, 'Chat:') && !has(hermesHtml, 'Code:') && !has(hermesHtml, 'Server URL'), 'hermes: no dual-runtime or per-bot URL copy');
  const hermesBody = ui.newBotSubmitBody({ name: 'Hermie', ...hermesForm, deckId: 'typed-then-switched', workingDirectory: '/tmp/discarded' });
  log(`  [hermes] submit payload: ${JSON.stringify(hermesBody)}`);
  assert(JSON.stringify(hermesBody) === '{"name":"Hermie"}', 'hermes: submit sends the name only (Agent Deck values discarded)');
  const hermesRes = await postBot(hermesBody);
  const hermesSaved = await hermesRes.json();
  assert(hermesRes.status === 200 && hermesSaved.runtime === 'hermes', `hermes: POST /api/bots creates a Hermes bot (got ${hermesRes.status})`);
  const hermesListed = await listedBot(hermesSaved.id);
  log(`  [hermes] roster: "${ui.rosterRuntimeLine(hermesListed, CONNECTED)}"`);
  assert(ui.rosterRuntimeLine(hermesListed, CONNECTED) === 'Runtime: Hermes', 'hermes: roster reads back "Runtime: Hermes"');

  const created = {};
  for (const agentClient of ui.AGENT_OPTIONS) {
    const form = { runtime: 'agent-deck', agentClient, deckId: 'planner', workingDirectory: '' };
    const html = sectionHtml(form, CONNECTED);
    log(`  [agent-deck/${agentClient}] visible fields: name, ${visibleFields(html).join(', ')}`);
    assert(visibleFields(html).join(',') === 'runtime,agent,deck,workdir', `${agentClient}: Agent Deck shows Agent + Deck + Working directory`);
    assert(
      ui.AGENT_OPTIONS.every(option => has(html, `value="${option}"`)) && checkedValue(html, 'bot-agent') === agentClient,
      `${agentClient}: agent picker offers exactly codex|claude|cursor|muse with ${agentClient} selected`
    );
    assert(has(html, 'href="/settings"') && has(html, escapeHtml(ui.NON_LOCAL_NOTE)) && !has(html, 'Server URL'), `${agentClient}: links to Settings, carries the non-local note, no per-bot URL`);
    const body = ui.newBotSubmitBody({ name: `Deck ${agentClient}`, ...form });
    log(`  [agent-deck/${agentClient}] submit payload: ${JSON.stringify(body)}`);
    assert(
      body.runtime === 'agent-deck' && body.agent_client === agentClient && body.deck_id === 'planner' && !('working_directory' in body),
      `${agentClient}: submit sends runtime, agent, deck, and omits the untouched workdir`
    );
    const res = await postBot(body);
    const saved = await res.json();
    assert(res.status === 200 && saved.runtime === 'agent-deck' && saved.agent_client === agentClient && saved.deck_id === 'planner' && saved.launchable === true,
      `${agentClient}: POST /api/bots stores one launchable Agent Deck runtime (got ${res.status})`);
    const listed = await listedBot(saved.id);
    const line = ui.rosterRuntimeLine(listed, CONNECTED);
    log(`  [agent-deck/${agentClient}] roster: "${line}"`);
    assert(line === `Runtime: Agent Deck · ${agentClient} · planner`, `${agentClient}: roster reads back the one runtime summary`);
    created[agentClient] = saved;
  }
  assert(ui.AGENT_OPTIONS.join('|') === 'codex|claude|cursor|muse', 'agents: supported values are exactly codex|claude|cursor|muse');

  const defaultForm = { runtime: 'agent-deck', agentClient: ui.AGENT_OPTIONS[0], deckId: '', workingDirectory: '' };
  const switched = sectionHtml(defaultForm, CONNECTED);
  assert(checkedValue(switched, 'bot-agent') === 'codex', 'agent-deck: first agent (codex) is pre-selected when Agent Deck is chosen');
  assert(!/<option value="[^"]+" title="[^"]+" selected="">/.test(switched), 'agent-deck: deck has no pre-selection until the user picks one');
  const missingDeck = ui.newBotSubmitBody({ name: 'NoDeck', ...defaultForm });
  const missingRes = await postBot(missingDeck);
  const missingErr = await missingRes.json();
  log(`  [agent-deck] no deck chosen: client copy="${ui.SELECT_DECK_ERROR}" server 400="${missingErr.error}"`);
  assert(missingRes.status === 400 && typeof missingErr.error === 'string', 'agent-deck: a deck-less submit is rejected (the modal blocks it first with "Select a deck for this bot.")');
  return created;
}

async function workdirSection(created) {
  log('\n[3] Working directory: implicit default, override create/read/edit/reset');
  const html = sectionHtml({ runtime: 'agent-deck', agentClient: 'codex', deckId: 'planner', workingDirectory: '' }, CONNECTED);
  log(`  [default] hint: "${ui.NEW_BOT_WORKDIR_HINT}"`);
  assert(has(html, escapeHtml('Default: ~/.botmancers/{agentID}')) && has(html, 'data-field="workdir" placeholder="" value=""'), 'default: New Bot shows a blank workdir input with the ~/.botmancers/{agentID} hint');
  assert(!/~\/\.botmancers\/(codex|claude|cursor|muse)\b/.test(html), 'default: the hint never substitutes an agent name for {agentID}');

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

  const overrideBody = ui.newBotSubmitBody({ name: 'Custom', runtime: 'agent-deck', agentClient: 'claude', deckId: 'research', workingDirectory: '  /Users/you/workspace/codes  ' });
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
  assert(reset.runtime === 'agent-deck' && reset.launchable === true && ui.rosterRuntimeLine(reset, CONNECTED) === 'Runtime: Agent Deck · codex · planner', 'reset: the bot keeps its Agent Deck runtime');
  assert(ui.configRuntimeView(reset, CONNECTED).workingDirectory === `Working directory: ~/.botmancers/${implicit.id}`, 'reset: config shows the default without (custom)');
}

async function rosterConfigSection(created) {
  log('\n[4] Roster + config: one runtime summary per fixture');
  const hermes = await (await postBot({ name: 'Plain' })).json();
  const configured = await listedBot(created.claude.id);
  const goneRes = await patchBot({ id: created.cursor.id, deck_id: 'gone-deck' });
  assert(goneRes.status === 200, 'fixture: cursor bot points at a deck absent from the server');
  const gone = await listedBot(created.cursor.id);
  const migratedRow = bots.create({
    name: 'Legacy', title: '', description: '',
    runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'planner',
    working_directory: '/Users/you/legacy', needs_deck_reselection: 1,
  });
  const migrated = await listedBot(migratedRow.id);

  const unreachableCached = deckState('unreachable', { cachedDecks: [{ id: 'planner', name: 'planner' }, { id: 'research', name: 'research' }] });
  const unreachableBare = deckState('unreachable', { cachedDecks: null });
  const unconfigured = deckState('unconfigured', { serverUrl: '' });
  const remote = { ...CONNECTED, serverUrl: 'http://10.0.0.5:1111' };

  const fixtures = [
    { label: 'Hermes bot', bot: hermes, state: CONNECTED, roster: 'Runtime: Hermes', config: 'Runtime: Hermes', notice: null, action: 'Change to Agent Deck' },
    { label: 'Agent Deck bot (deck on server)', bot: configured, state: CONNECTED, roster: 'Runtime: Agent Deck · claude · planner', config: 'Runtime: Agent Deck · claude · planner', notice: null, action: 'Edit' },
    { label: 'Unavailable saved deck (fresh list)', bot: gone, state: CONNECTED, roster: 'Runtime: Agent Deck · cursor · gone-deck (deck unavailable — see Config)', config: 'Runtime: Agent Deck · cursor · gone-deck (deck unavailable)', notice: ui.UNAVAILABLE_DECK_NOTICE, action: 'Edit' },
    { label: 'Unavailable saved deck (cached list, outage)', bot: gone, state: unreachableCached, roster: 'Runtime: Agent Deck · cursor · gone-deck (deck unavailable — see Config)', config: 'Runtime: Agent Deck · cursor · gone-deck (deck unavailable)', notice: ui.UNAVAILABLE_DECK_NOTICE, action: 'Edit' },
    { label: 'Deck in cache during outage', bot: configured, state: unreachableCached, roster: 'Runtime: Agent Deck · claude · planner', config: 'Runtime: Agent Deck · claude · planner', notice: null, action: 'Edit' },
    { label: 'Outage with no cached list', bot: gone, state: unreachableBare, roster: 'Runtime: Agent Deck · cursor · gone-deck', config: 'Runtime: Agent Deck · cursor · gone-deck', notice: ui.UNCHECKED_DECK_NOTICE, action: 'Edit' },
    { label: 'No server configured', bot: gone, state: unconfigured, roster: 'Runtime: Agent Deck · cursor · gone-deck', config: 'Runtime: Agent Deck · cursor · gone-deck', notice: ui.UNCONFIGURED_DECK_NOTICE, action: 'Edit' },
    { label: 'Migrated bot awaiting deck re-selection', bot: migrated, state: CONNECTED, roster: 'Runtime: Agent Deck · codex · deck not selected — re-select in Config', config: 'Runtime: Agent Deck · codex · deck not selected', notice: 'Migrated from the old coding path (was "planner"). Pick a deck from the configured server before this bot can run.', action: 'Edit' },
    { label: 'Non-local workspace server', bot: configured, state: remote, roster: 'Runtime: Agent Deck · claude · planner', config: 'Runtime: Agent Deck · claude · planner', notice: ui.REMOTE_SERVER_LIMITATION, action: 'Edit' },
  ];
  for (const fixture of fixtures) {
    const roster = ui.rosterRuntimeLine(fixture.bot, fixture.state);
    const config = ui.configRuntimeView(fixture.bot, fixture.state);
    log(`  [${fixture.label}] roster="${roster}" config="${config.summary}" notices=${JSON.stringify(config.notices)} action="${config.action}"`);
    assert(roster === fixture.roster, `${fixture.label}: roster line`);
    assert(config.summary === fixture.config, `${fixture.label}: config summary`);
    assert(fixture.notice === null ? config.notices.length === 0 : config.notices.includes(fixture.notice), `${fixture.label}: config notice`);
    assert(config.action === fixture.action, `${fixture.label}: config action "${fixture.action}"`);
    assert(!/Chat:|Code:/.test(roster + config.summary) && !roster.includes('\n'), `${fixture.label}: exactly one line, no Chat:/Code:`);
    const parts = ui.rosterRuntimeParts(fixture.bot, fixture.state);
    assert(parts.prefix + parts.deck + parts.suffix === roster, `${fixture.label}: roster parts join back to the line`);
  }
  const staleUuidParts = ui.rosterRuntimeParts(
    { id: 'b2', runtime: 'agent-deck', agent_client: 'codex', deck_id: '00000000-dead-4bee-8000-000000000000', launchable: true },
    CONNECTED
  );
  log(`  [uuid unavailable deck] parts=${JSON.stringify(staleUuidParts)}`);
  assert(staleUuidParts.deck === '00000000-dead-4bee-8000-000000000000' && staleUuidParts.suffix === ui.ROSTER_UNAVAILABLE_SUFFIX, 'roster parts: a UUID-only deck truncates separately from the unavailable marker');
  const uuidState = deckState('connected', { decks: [{ id: '078fde81-3422-4630-8dce-c22070c4d09a', name: 'planner' }] });
  const uuidBot = { id: 'b1', runtime: 'agent-deck', agent_client: 'codex', deck_id: '078fde81-3422-4630-8dce-c22070c4d09a', launchable: true };
  const uuidHtml = sectionHtml({ runtime: 'agent-deck', agentClient: 'codex', deckId: '', workingDirectory: '' }, uuidState);
  log(`  [uuid deck ids] roster="${ui.rosterRuntimeLine(uuidBot, uuidState)}" no-list="${ui.rosterRuntimeLine(uuidBot, null)}"`);
  assert(has(uuidHtml, '<option value="078fde81-3422-4630-8dce-c22070c4d09a" title="078fde81-3422-4630-8dce-c22070c4d09a">planner</option>'), 'deck names: dropdown labels each option with the server name and submits the id');
  assert(ui.rosterRuntimeLine(uuidBot, uuidState) === 'Runtime: Agent Deck · codex · planner', 'deck names: summary shows the deck name when the list is known');
  assert(ui.rosterRuntimeLine(uuidBot, null) === 'Runtime: Agent Deck · codex · 078fde81-3422-4630-8dce-c22070c4d09a', 'deck names: summary falls back to the stored id when no list is known');
  assert(ui.configRuntimeView(migrated, CONNECTED).workingDirectory === 'Working directory: /Users/you/legacy (custom)', 'migrated: the carried-over workdir shows as (custom)');
  const migratedSeed = ui.runtimeFormFromBot(migrated);
  assert(migratedSeed.deckId === '' && migratedSeed.agentClient === 'codex', 'migrated: edit opens with no deck so the owner must pick one from the server');
  const reselect = await patchBot(ui.configRuntimePatchBody(migrated.id, { ...migratedSeed, deckId: 'planner', workingDirectory: '/Users/you/legacy' }));
  const resolved = await listedBot(migrated.id);
  log(`  [migrated -> re-selected] roster="${ui.rosterRuntimeLine(resolved, CONNECTED)}" launchable=${resolved.launchable}`);
  assert(reselect.status === 200 && resolved.launchable === true && ui.rosterRuntimeLine(resolved, CONNECTED) === 'Runtime: Agent Deck · codex · planner', 'migrated: picking a deck resolves the bot to a launchable runtime');

  const editHtml = render(view.RuntimeSection, {
    idPrefix: 'cfg', variant: 'config', form: ui.runtimeFormFromBot(gone), onChange() {}, deckState: CONNECTED, onRetry() {},
    savedDeckId: gone.deck_id, workdirPlaceholder: ui.defaultWorkdirFor(gone.id), workdirHint: ui.configWorkdirHint(gone.id),
  });
  assert(has(editHtml, '<option value="gone-deck" title="gone-deck" selected="">gone-deck (saved)</option>') && has(editHtml, escapeHtml(ui.SAVED_DECK_MISSING_NOTE)), 'config edit: the saved-but-missing deck stays displayed with the keep-it note');
  assert(has(editHtml, `placeholder="~/.botmancers/${gone.id}"`) && !has(editHtml, 'Server URL'), 'config edit: workdir placeholder shows this bot\'s default; no per-bot URL');
  const hermesToDeck = ui.configRuntimePatchBody(hermes.id, { runtime: 'hermes', agentClient: 'codex', deckId: '', workingDirectory: '' });
  assert(JSON.stringify(hermesToDeck) === `{"id":"${hermes.id}","runtime":"hermes"}`, 'config edit: saving Hermes sends only the runtime');
  const toHermesRes = await patchBot(ui.configRuntimePatchBody(gone.id, { ...ui.runtimeFormFromBot(gone), runtime: 'hermes' }));
  const nowHermes = await listedBot(gone.id);
  assert(toHermesRes.status === 200 && ui.rosterRuntimeLine(nowHermes, CONNECTED) === 'Runtime: Hermes', 'config edit: switching to Hermes stores the Hermes runtime');

  for (const url of ['http://127.0.0.1:1111', 'http://localhost:1111', 'http://[::1]:1111', 'http://10.0.0.5:1111', 'https://deck.example.com']) {
    assert(ui.isLocalServerUrl(url) === settingsLib.isLocalAgentDeckUrl(url), `non-local: UI locality check matches the launch guard for ${url}`);
  }
}

async function traceSection() {
  log('\n[5] Same-thread Agent Deck trace');
  agent.setDelegationChatStub(async () => 'hello there');
  const bot = bots.create({ name: 'Delegator', title: '', description: '' });
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
  assert(labels.map(item => item.label).join(' > ') === 'Agent Deck launch > Agent Deck run > Agent Deck review > Agent Deck resume > Agent Deck result', 'trace: each line is labelled as the bot\'s Agent Deck runtime');
  assert(labels[0].detail.includes('runtime=codex') && labels[0].detail.includes('deck=planner'), 'trace: launch carries the selected agent and deck verbatim');
  assert(!labels.some(item => /Hermes|handoff/i.test(item.label)), 'trace: no label describes a Hermes-to-code handoff');
  const runLine = thread.find(t => t.includes('[Deck run]'));
  assert(!!runLine && runLine.includes('runId=run-fake-1') && runLine.includes('sessionId=ses-opaque-for-run-fake-1'), 'trace: run carries the opaque run and session ids verbatim');

  const failingBot = bots.create({ name: 'Failer', title: '', description: '' });
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
  assert(failed.label === 'Agent Deck failed' && failed.detail.includes('runtime=codex') && failed.detail.includes('deck=planner'), 'failure: labelled Agent Deck failed with agent and deck');
  assert(ui.deckEventDisplay('[Deck needs reselection] Relay cannot launch: no deck ID is selected.').label === 'Agent Deck needs a deck', 'trace: the needs-reselection notice renders as an Agent Deck event');
  assert(ui.deckEventDisplay('plain reply') === null, 'trace: ordinary bot text is untouched');
  deck.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);
}

async function main() {
  log('NOT-445 bot runtime UI test (real handlers, isolated DB, mocked Agent Deck server, react-dom/server)');
  log(`DB: ${DB_PATH}`);
  await settingsSection();
  const created = await newBotSection();
  await workdirSection(created);
  await rosterConfigSection(created);
  await traceSection();
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
