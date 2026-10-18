#!/usr/bin/env node
// NOT-456: Agent + Agent Deck contract test (deterministic, no network).
//
// Proves:
// (1) the canonical agent enum is exactly hermes|cursor|claude|codex|muse
//     (Hermes, Cursor, Claude, Codex, Muse Code) and nothing offers Agent
//     Deck as an agent or runtime, in source or in serialized bots;
// (2) POST/PATCH /api/bots store the agent independently from deck_id,
//     require a selected deck, and reject unknown agents, malformed decks,
//     and legacy runtime fields without partial writes;
// (3) every legacy row shape migrates deterministically on DB load while
//     conversations, messages, provenance, launch snapshots, deck
//     references, and working directories are preserved;
// (4) Hermes and the four coding agents share one capability + dispatch
//     contract (agent plus selected deck), with no separate runtime mode;
// (5) unresolved rows stay readable, cannot launch, and never get a deck
//     ID guessed from their legacy deck name.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-bot-definition-test-${process.pid}.db`);
const MIGRATION_DB_PATH = path.join(os.tmpdir(), `botmancers-agent-migration-test-${process.pid}.db`);
function removeDb(file) {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* fresh start */ }
  }
}
removeDb(DB_PATH);
removeDb(MIGRATION_DB_PATH);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.HERMES_API_SERVER_KEY = 'test-hermes-key';
process.env.HERMES_BASE_URL = 'http://127.0.0.1:65530';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const db = jiti('./lib/db.ts');
const def = jiti('./lib/bot-definition.ts');
const deck = jiti('./lib/agent-deck-run.ts');
const deckApi = jiti('./lib/agent-deck-api.ts');
const deckAttempt = jiti('./lib/agent-deck-attempt.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
const { createFakeAgentDeck } = require('./test-support/fake-agent-deck-api.js');
const raw = db.default;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function jsonRequest(method, body) {
  return new Request('http://localhost:43123/api/bots', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function call(method, body) {
  const res = await botsRoute[method](jsonRequest(method, body));
  return { status: res.status, json: await res.json() };
}
const botCount = () => raw.prepare('SELECT COUNT(*) AS n FROM bots').get().n;
const rowOf = id => raw.prepare('SELECT * FROM bots WHERE id = ?').get(id);

const FIVE = ['hermes', 'cursor', 'claude', 'codex', 'muse'];
const LEGACY_KEYS = ['runtime', 'agent_client', 'persistent_runtime', 'coding_runtime', 'needs_deck_reselection'];

async function main() {
  // ---- (1) canonical enum + source assertions -----------------------------
  console.log('\n(1) Canonical agent enum');
  check('AGENTS is exactly hermes,cursor,claude,codex,muse in order', JSON.stringify(def.AGENTS) === JSON.stringify(FIVE), JSON.stringify(def.AGENTS));
  check(
    'agent labels are Hermes, Cursor, Claude, Codex, Muse Code',
    FIVE.map(a => def.AGENT_LABELS[a]).join('|') === 'Hermes|Cursor|Claude|Codex|Muse Code',
    JSON.stringify(def.AGENT_LABELS)
  );
  check('Agent Deck is not an agent', !def.AGENTS.includes('agent-deck') && !Object.values(def.AGENT_LABELS).includes('Agent Deck'));
  check('no runtime enum is exported', def.RUNTIMES === undefined && def.RUNTIME_AGENT_DECK === undefined && def.AGENT_CLIENTS === undefined);
  check('Hermes uses the same deck-selected contract (gateway adapter)', def.agentTransport('hermes') === 'hermes-gateway');
  check('coding agents use the deck-run adapter', ['cursor', 'claude', 'codex', 'muse'].every(a => def.agentTransport(a) === 'agent-deck-run'));
  for (const file of ['lib/bot-definition.ts', 'lib/bot-runtime-ui.ts', 'app/components/AgentDeckRuntime.tsx', 'app/page.tsx', 'app/bots/[id]/config/page.tsx']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(`${file}: no "Runtime: Agent Deck" copy`, !source.includes('Runtime: Agent Deck') && !source.includes("label: 'Agent Deck'"));
  }
  const uiSource = fs.readFileSync(path.join(ROOT, 'lib/bot-runtime-ui.ts'), 'utf8');
  check('UI helpers offer no runtime option list', !/RUNTIME_OPTIONS|value: 'agent-deck'/.test(uiSource));
  check('agent-deck-run CLI clients stay the four coding agents', JSON.stringify(deck.DECK_RUNTIMES) === JSON.stringify(['codex', 'claude', 'cursor', 'muse']));

  // ---- (2) API validation ---------------------------------------------------
  console.log('\n(2) Create/update validation');
  const created = {};
  for (const agent of FIVE) {
    const res = await call('POST', { name: `Agent-${agent}`, agent, deck_id: `deck-${agent}` });
    created[agent] = res.json;
    check(
      `POST agent=${agent} with a deck stores agent and deck independently`,
      res.status === 200 && res.json.agent === agent && res.json.deck_id === `deck-${agent}` && res.json.launchable === true && res.json.needs_deck_selection === false,
      JSON.stringify(res)
    );
    const row = rowOf(res.json.id);
    check(
      `stored row for ${agent}: agent column set, legacy runtime/agent_client never written`,
      row.agent === agent && row.deck_id === `deck-${agent}` && row.runtime === null && row.agent_client === null,
      JSON.stringify({ agent: row.agent, runtime: row.runtime, agent_client: row.agent_client })
    );
    check(`serialized ${agent} bot exposes no legacy runtime keys`, LEGACY_KEYS.every(key => !(key in res.json)), Object.keys(res.json).join(','));
  }
  const defaulted = await call('POST', { name: 'Defaulted', deck_id: 'deck-default' });
  check('POST without agent defaults to hermes (deck still required)', defaulted.status === 200 && defaulted.json.agent === 'hermes');

  const rejectCases = [
    // NOT-502: without a deck the request is not the legacy Agent Deck
    // shape, so it fails closed on the missing registration instead.
    ['missing deck', { name: 'NoDeck', agent: 'codex' }, /Runtime connection is required/],
    ['blank deck', { name: 'BlankDeck', agent: 'hermes', deck_id: '   ' }, /Deck ID is required/],
    ['non-string deck', { name: 'ObjDeck', agent: 'claude', deck_id: { id: 'x' } }, /Invalid deck ID/],
    ['numeric deck', { name: 'NumDeck', agent: 'claude', deck_id: 42 }, /Invalid deck ID/],
    ['whitespace deck', { name: 'SpaceDeck', agent: 'claude', deck_id: 'two words' }, /Invalid deck ID/],
    ['unknown agent', { name: 'Watson', agent: 'watson', deck_id: 'd1' }, /Invalid agent/],
    ['agent-deck as agent', { name: 'DeckAsAgent', agent: 'agent-deck', deck_id: 'd1' }, /Invalid agent/],
    ['legacy runtime field', { name: 'Legacy', runtime: 'agent-deck', agent_client: 'codex', deck_id: 'd1' }, /no longer accepted/],
    ['legacy runtime=hermes', { name: 'LegacyH', runtime: 'hermes', deck_id: 'd1' }, /no longer accepted/],
    ['client-written deck_name', { name: 'Named', agent: 'codex', deck_id: 'd1', deck_name: 'guess-me' }, /read-only legacy reference/],
  ];
  for (const [label, body, pattern] of rejectCases) {
    const before = botCount();
    const res = await call('POST', body);
    check(`POST rejects ${label} with 400 and creates nothing`, res.status === 400 && pattern.test(res.json.error) && botCount() === before, JSON.stringify(res));
  }

  const target = created.codex;
  const patchRejects = [
    ['unknown agent', { agent: 'watson' }],
    ['blank agent', { agent: '' }],
    ['agent-deck as agent', { agent: 'agent-deck' }],
    ['cleared deck', { deck_id: '' }],
    ['malformed deck', { deck_id: 'a b' }],
    ['legacy runtime', { runtime: 'hermes' }],
    ['legacy agent_client', { agent_client: 'claude' }],
    ['deck_name write', { deck_name: 'relay-deck' }],
  ];
  for (const [label, fields] of patchRejects) {
    const before = rowOf(target.id);
    const res = await call('PATCH', { id: target.id, name: 'Renamed', pinned: true, avatar: { color: 'teal' }, ...fields });
    const after = rowOf(target.id);
    check(
      `PATCH rejects ${label} with 400 and no partial write (name/pin/avatar/agent/deck unchanged)`,
      res.status === 400 && JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify({ status: res.status, error: res.json.error })
    );
  }
  const switched = await call('PATCH', { id: target.id, agent: 'muse' });
  check('PATCH agent alone keeps the deck selection', switched.status === 200 && switched.json.agent === 'muse' && switched.json.deck_id === 'deck-codex' && switched.json.launchable === true, JSON.stringify(switched.json));
  const redecked = await call('PATCH', { id: target.id, deck_id: 'deck-next', working_directory: '/tmp/next' });
  check('PATCH deck alone keeps the agent', redecked.status === 200 && redecked.json.agent === 'muse' && redecked.json.deck_id === 'deck-next' && redecked.json.working_directory === '/tmp/next', JSON.stringify(redecked.json));
  const toHermes = await call('PATCH', { id: target.id, agent: 'hermes' });
  check('switching to Hermes keeps the deck and workdir (Hermes is an agent, not a mode)', toHermes.json.agent === 'hermes' && toHermes.json.deck_id === 'deck-next' && toHermes.json.working_directory === '/tmp/next', JSON.stringify(toHermes.json));

  const listed = await botsRoute.GET();
  const list = await listed.json();
  check('GET /api/bots serializes agent + Agent Deck state for every bot', list.length > 0 && list.every(bot => FIVE.includes(bot.agent) && 'deck_id' in bot && typeof bot.needs_deck_selection === 'boolean' && LEGACY_KEYS.every(key => !(key in bot))));

  // ---- (5) unresolved rows --------------------------------------------------
  console.log('\n(5) Unresolved rows');
  const imported = db.bots.createFromImport(
    { name: 'Imported', title: 'Imported', description: 'Imported bot.' },
    { source_provider: 'test', template_id: 't1', template_url: 'https://example.test/t1', import_schema_version: '1', import_operation_id: `op-${process.pid}`, import_timestamp: Date.now() }
  );
  const importedView = def.serializeBot(db.bots.getById(imported.id));
  check('imported bot reads back as hermes needing Agent Deck selection', importedView.agent === 'hermes' && importedView.deck_id === null && importedView.needs_deck_selection === true && importedView.launchable === false, JSON.stringify(importedView));
  const stale = db.bots.create({ name: 'Stale', title: '', description: 'Legacy.', agent: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/stale' });
  const staleView = def.serializeBot(db.bots.getById(stale.id));
  check('unresolved row stays readable with its legacy deck reference', staleView.agent === 'codex' && staleView.deck_name === 'relay-deck' && staleView.working_directory === '/tmp/stale');
  check('unresolved row: no deck ID guessed from the name, not launchable', staleView.deck_id === null && staleView.needs_deck_selection === true && staleView.launchable === false);
  const workdirPatch = await call('PATCH', { id: stale.id, working_directory: '/tmp/stale-2' });
  check('editing an unresolved row without a deck keeps it unresolved', workdirPatch.json.needs_deck_selection === true && workdirPatch.json.deck_id === null && workdirPatch.json.deck_name === 'relay-deck');

  let deckCalls = 0;
  let hermesCalls = 0;
  deck.setDeckRunProcess(async () => { deckCalls += 1; return { stdout: '', stderr: 'must not run', exitCode: 1 }; });
  dispatch.setAgentDispatchHermesFetch(async () => { hermesCalls += 1; return new Response('{}', { status: 500 }); });
  for (const bot of [db.bots.getById(stale.id), db.bots.getById(imported.id)]) {
    let code = null;
    try {
      await dispatch.dispatchToAgent({ bot, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hi' }] });
    } catch (error) {
      code = error.code;
    }
    check(`dispatch refuses unresolved ${bot.agent} row (${bot.name}) as agent_unavailable`, code === 'agent_unavailable', String(code));
  }
  check('no adapter (deck run or Hermes gateway) ran for unresolved rows', deckCalls === 0 && hermesCalls === 0, `deck=${deckCalls} hermes=${hermesCalls}`);
  const selected = await call('PATCH', { id: stale.id, deck_id: 'deck-picked' });
  check('selecting a deck resolves the row and drops the legacy name', selected.json.deck_id === 'deck-picked' && selected.json.deck_name === null && selected.json.needs_deck_selection === false && selected.json.launchable === true, JSON.stringify(selected.json));

  // ---- (4) capability + dispatch for all five agents ------------------------
  console.log('\n(4) One agent + deck contract for Hermes and the coding agents');
  deck.setHermesAdapterProbe(() => true);
  deck.setDeckRunProcess(async argv => {
    if (argv[1] === '--version') {
      return ['codex', 'claude', 'agent-deck'].includes(argv[0])
        ? { stdout: `${argv[0]} 1.0\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'not found', exitCode: 127 };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  });
  const ready = await deck.listAvailableAgents();
  check('capability probe lists Hermes alongside probe-ready coding agents', JSON.stringify(ready) === JSON.stringify(['hermes', 'claude', 'codex']), JSON.stringify(ready));
  const payload = def.buildAvailabilityPayload(ready);
  check(
    'availability payload lists agents (labels) and never Agent Deck',
    JSON.stringify(payload) === JSON.stringify({ agents: [
      { agent: 'hermes', label: 'Hermes', launchable: true },
      { agent: 'claude', label: 'Claude', launchable: true },
      { agent: 'codex', label: 'Codex', launchable: true },
    ] }),
    JSON.stringify(payload)
  );
  deck.setHermesAdapterProbe(() => false);
  check('Hermes is advertised only when its gateway adapter is ready', !(await deck.listAvailableAgents()).includes('hermes'));
  deck.setHermesAdapterProbe(null);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-agent-contract-'));
  const starts = [];
  deck.setDeckRunProcess(async argv => {
    if (argv[1] === 'run' && argv[2] === 'status') {
      return { stdout: JSON.stringify({ runId: argv[3], deck: 'x', client: 'x', state: 'ended', sessionId: 's', logPath: '/tmp/x' }), stderr: '', exitCode: 0 };
    }
    if (argv[1] === 'run' && argv[2] === 'log') {
      return { stdout: `${JSON.stringify({ t: 'result', sessionId: 's', result: `deck reply ${argv[3]}` })}\n${JSON.stringify({ t: 'end' })}\n`, stderr: '', exitCode: 0 };
    }
    if (argv[1] === 'run') {
      starts.push(argv);
      return { stdout: `run run-${starts.length} detached: pid 1 log /tmp/x\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  });
  const fakeApi = createFakeAgentDeck({ token: 'bot_definition_fixture_bearer' });
  process.env.AGENT_DECK_RUN_TOKEN = fakeApi.token;
  fakeApi.onStart = body => ({ result: `deck reply ${body.client}` });
  deckApi.setAgentDeckApiFetch(fakeApi.fetch);
  deckAttempt.setAgentDeckApiPollIntervalForTests(0);
  const hermesRequests = [];
  dispatch.setAgentDispatchHermesFetch(async (url, init) => {
    hermesRequests.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hermes reply' } }] }), { status: 200 });
  });
  for (const agent of FIVE) {
    const bot = db.bots.create({ name: `Dispatch-${agent}`, title: '', description: 'Replies.', agent, deck_id: `deck-run-${agent}`, working_directory: workdir });
    const startsBefore = starts.length;
    const apiStartsBefore = fakeApi.calls('POST', '/api/agent-runs').length;
    const hermesBefore = hermesRequests.length;
    const reply = await dispatch.dispatchToAgent({ bot, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hello' }] });
    check(`agentForDispatch reports ${agent}`, dispatch.agentForDispatch(bot) === agent);
    if (agent === 'hermes') {
      check('Hermes with a selected deck dispatches through its gateway adapter only', reply === 'hermes reply' && hermesRequests.length === hermesBefore + 1 && starts.length === startsBefore && fakeApi.calls('POST', '/api/agent-runs').length === apiStartsBefore);
    } else {
      const request = fakeApi.calls('POST', '/api/agent-runs').at(-1);
      check(
        `${agent} with a selected deck dispatches through the authenticated Agent Deck API`,
        starts.length === startsBefore && fakeApi.calls('POST', '/api/agent-runs').length === apiStartsBefore + 1
          && request.body.deckId === `deck-run-${agent}` && request.body.client === agent && request.body.cwd === workdir
          && request.body.tools === 'readonly' && request.body.prepareFinalization === undefined
          && request.headers.authorization === `Bearer ${fakeApi.token}` && hermesRequests.length === hermesBefore && reply.startsWith('deck reply'),
        JSON.stringify(request)
      );
    }
  }
  check('canonical coding-agent dispatch spawns zero Agent Deck CLI runs', starts.length === 0, JSON.stringify(starts));
  deckApi.setAgentDeckApiFetch(null);
  deckAttempt.setAgentDeckApiPollIntervalForTests(null);
  delete process.env.AGENT_DECK_RUN_TOKEN;
  deck.resetDeckRunProcessForTests();
  dispatch.setAgentDispatchHermesFetch(null);
  fs.rmSync(workdir, { recursive: true, force: true });

  // ---- (3) migration of every legacy shape ---------------------------------
  console.log('\n(3) Deterministic migration (pure rule)');
  const pure = [
    [{ runtime: 'hermes' }, { agent: 'hermes', deck_id: null, needs_deck_selection: true }],
    [{ runtime: 'hermes', deck_id: 'kept' }, { agent: 'hermes', deck_id: 'kept', needs_deck_selection: false }],
    ...['codex', 'claude', 'cursor', 'muse'].map(client => [
      { runtime: 'agent-deck', agent_client: client, deck_id: `d-${client}`, working_directory: '/w' },
      { agent: client, deck_id: `d-${client}`, working_directory: '/w', needs_deck_selection: false },
    ]),
    [{ runtime: 'agent-deck', agent_client: 'codex', deck_name: 'relay-deck', needs_deck_reselection: 1 }, { agent: 'codex', deck_id: null, deck_name: 'relay-deck', needs_deck_selection: true }],
    [{ runtime: 'agent-deck', agent_client: 'codex', deck_id: 'd1', needs_deck_reselection: 1 }, { agent: 'codex', deck_id: 'd1', needs_deck_selection: true }],
    [{ runtime: 'agent-deck', agent_client: 'watson', deck_id: 'd1' }, { agent: 'hermes', deck_id: 'd1', needs_deck_selection: true }],
    [{ runtime: null, coding_runtime: 'muse', deck_name: 'legacy', working_directory: '/w' }, { agent: 'muse', deck_id: null, deck_name: 'legacy', needs_deck_selection: true }],
    [{ runtime: null, coding_runtime: 'claude', deck_name: null, working_directory: '/w' }, { agent: 'hermes', deck_id: null, needs_deck_selection: true }],
    [{ runtime: null }, { agent: 'hermes', deck_id: null, needs_deck_selection: true }],
    [{ agent: 'cursor', deck_id: 'd9', runtime: 'hermes' }, { agent: 'cursor', deck_id: 'd9', needs_deck_selection: false, migrated: false }],
  ];
  for (const [input, expected] of pure) {
    const first = def.migrateLegacyAgentFields(input);
    const again = def.migrateLegacyAgentFields(input);
    const matches = Object.entries(expected).every(([key, value]) => first[key] === value);
    check(`migrate ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, matches && JSON.stringify(first) === JSON.stringify(again), JSON.stringify(first));
  }

  console.log('\n(3) Deterministic migration (DB load, fixtures before/after)');
  const loadDb = () => execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    createJiti(${JSON.stringify(path.join(ROOT, 'loader.js'))})('./lib/db.ts');
  `], { cwd: ROOT, env: { ...process.env, BOTMANCERS_DB_PATH: MIGRATION_DB_PATH } });
  loadDb();
  const Database = require('better-sqlite3');
  const mig = new Database(MIGRATION_DB_PATH);
  const t = Date.now();
  const fixtures = [
    { id: 'm-hermes', runtime: 'hermes', agent_client: null, deck_id: null, deck_name: null, working_directory: null, needs: 0, expect: { agent: 'hermes', deck_id: null, needs_deck_selection: 1 } },
    { id: 'm-claude', runtime: 'agent-deck', agent_client: 'claude', deck_id: 'deck-live', deck_name: null, working_directory: '/tmp/claude-work', needs: 0, expect: { agent: 'claude', deck_id: 'deck-live', working_directory: '/tmp/claude-work', needs_deck_selection: 0 } },
    { id: 'm-cursor', runtime: 'agent-deck', agent_client: 'cursor', deck_id: 'deck-c', deck_name: null, working_directory: null, needs: 0, expect: { agent: 'cursor', deck_id: 'deck-c', needs_deck_selection: 0 } },
    { id: 'm-muse', runtime: 'agent-deck', agent_client: 'muse', deck_id: 'deck-m', deck_name: null, working_directory: null, needs: 0, expect: { agent: 'muse', deck_id: 'deck-m', needs_deck_selection: 0 } },
    { id: 'm-unresolved', runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/relay', needs: 1, expect: { agent: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/relay', needs_deck_selection: 1 } },
    { id: 'm-pre442', runtime: null, coding_runtime: 'codex', agent_client: null, deck_id: null, deck_name: 'old-deck', working_directory: '/tmp/old', needs: 0, expect: { agent: 'codex', deck_id: null, deck_name: 'old-deck', needs_deck_selection: 1 } },
    { id: 'm-imported', runtime: 'hermes', agent_client: null, deck_id: null, deck_name: null, working_directory: null, needs: 0, provenance: true, expect: { agent: 'hermes', needs_deck_selection: 1 } },
  ];
  for (const [index, row] of fixtures.entries()) {
    mig.prepare(
      'INSERT INTO bots (id, name, title, description, color, created_at, runtime, agent_client, coding_runtime, deck_id, deck_name, working_directory, needs_deck_reselection, agent, source_provider, template_id, template_url, import_schema_version, import_operation_id, import_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)'
    ).run(
      row.id, `Legacy ${row.id}`, '', 'Legacy rules.', '#C6F54A', t + index,
      row.runtime, row.agent_client, row.coding_runtime ?? null, row.deck_id, row.deck_name, row.working_directory, row.needs,
      row.provenance ? 'marketplace' : null, row.provenance ? 'tmpl-1' : null, row.provenance ? 'https://example.test/tmpl-1' : null,
      row.provenance ? '1.0.0' : null, row.provenance ? `op-mig-${process.pid}` : null, row.provenance ? t : null
    );
    // Post-NOT-446 shape (origin already bound), as at 63070e3.
    mig.prepare("INSERT INTO conversations (id, type, bot_id, origin_kind, origin_id, created_at) VALUES (?, 'bot', ?, 'person', 'local-owner', ?)").run(`conv-${row.id}`, row.id, t);
    mig.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, 'user', NULL, ?, ?)").run(`msg-u-${row.id}`, `conv-${row.id}`, `hello ${row.id}`, t);
    mig.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, created_at) VALUES (?, ?, 'bot', ?, ?, ?)").run(`msg-b-${row.id}`, `conv-${row.id}`, row.id, `reply ${row.id}`, t + 1);
    mig.prepare('INSERT INTO launch_snapshots (id, bot_id, created_at, hash, snapshot, transport) VALUES (?, ?, ?, ?, ?, ?)').run(
      `snap-${row.id}`, row.id, t, 'f'.repeat(64), JSON.stringify({ runtime: row.runtime, agent_client: row.agent_client, deck_id: row.deck_id }), row.runtime === 'agent-deck' ? 'agent-deck' : 'hermes-gateway'
    );
  }
  const snapshotOf = conn => ({
    conversations: conn.prepare('SELECT * FROM conversations ORDER BY id').all(),
    messages: conn.prepare('SELECT id, conversation_id, sender_type, sender_id, content, created_at FROM messages ORDER BY id').all(),
    launch_snapshots: conn.prepare('SELECT * FROM launch_snapshots ORDER BY id').all(),
    provenance: conn.prepare('SELECT id, source_provider, template_id, template_url, import_schema_version, import_operation_id, import_timestamp FROM bots ORDER BY id').all(),
  });
  const before = snapshotOf(mig);
  const legacyBefore = mig.prepare('SELECT id, runtime, agent_client, coding_runtime FROM bots ORDER BY id').all();
  mig.close();

  loadDb();
  const after1 = new Database(MIGRATION_DB_PATH);
  const migrated = Object.fromEntries(after1.prepare('SELECT * FROM bots').all().map(row => [row.id, row]));
  for (const row of fixtures) {
    const got = migrated[row.id];
    const ok = got && Object.entries(row.expect).every(([key, value]) => got[key] === value);
    console.log(`  before ${row.id}: runtime=${row.runtime} agent_client=${row.agent_client} coding_runtime=${row.coding_runtime ?? null} deck_id=${row.deck_id} deck_name=${row.deck_name} wd=${row.working_directory}`);
    console.log(`  after  ${row.id}: agent=${got && got.agent} deck_id=${got && got.deck_id} deck_name=${got && got.deck_name} wd=${got && got.working_directory} needs_deck_selection=${got && got.needs_deck_selection}`);
    check(`DB migration ${row.id} -> ${JSON.stringify(row.expect)}`, ok, JSON.stringify(got));
    if (got) {
      check(`${row.id}: deck_id/deck_name/working_directory preserved verbatim`, got.deck_id === row.deck_id && got.deck_name === row.deck_name && got.working_directory === row.working_directory);
      const view = def.serializeBot(got);
      check(`${row.id}: launchable only with a deck`, view.launchable === (row.deck_id !== null && row.needs === 0));
    }
  }
  const afterState = snapshotOf(after1);
  check('conversations preserved byte-for-byte', JSON.stringify(afterState.conversations) === JSON.stringify(before.conversations));
  check('messages preserved byte-for-byte', JSON.stringify(afterState.messages) === JSON.stringify(before.messages));
  check('launch snapshots preserved byte-for-byte', JSON.stringify(afterState.launch_snapshots) === JSON.stringify(before.launch_snapshots));
  check('import provenance preserved byte-for-byte', JSON.stringify(afterState.provenance) === JSON.stringify(before.provenance));
  check('legacy columns left as read-only migration inputs', JSON.stringify(after1.prepare('SELECT id, runtime, agent_client, coding_runtime FROM bots ORDER BY id').all()) === JSON.stringify(legacyBefore));
  const firstPass = JSON.stringify(after1.prepare('SELECT * FROM bots ORDER BY id').all());
  after1.close();
  loadDb();
  const after2 = new Database(MIGRATION_DB_PATH);
  check('migration is idempotent on reload', JSON.stringify(after2.prepare('SELECT * FROM bots ORDER BY id').all()) === firstPass);
  after2.close();

  removeDb(DB_PATH);
  removeDb(MIGRATION_DB_PATH);
  if (failures > 0) {
    console.log(`\ntest:bot-definition: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\ntest:bot-definition: all assertions passing');
}

main().catch(error => {
  console.error(`FAIL: bot-definition test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
