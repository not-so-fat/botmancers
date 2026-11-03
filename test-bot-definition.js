#!/usr/bin/env node
// NOT-543: direct-only Agent contract test (deterministic, no network).
// Supersedes the NOT-456 version: one agent identity launching direct,
// no launch profile, no deck.
//
// Proves:
// (1) the canonical agent enum is exactly hermes|cursor|claude|codex|muse
//     (Hermes, Cursor, Claude, Codex, Muse Code) and nothing offers Agent
//     Deck as an agent, transport, module, route, or UI control, in
//     source or in serialized bots;
// (2) POST/PATCH /api/bots store the agent from the runtime connection,
//     require connection + scope + policy, and reject unknown agents,
//     removed launch fields, and legacy runtime fields without partial
//     writes;
// (3) every legacy row shape migrates deterministically on DB load (agent
//     assigned, direct launch values, registration fallback) while
//     conversations, messages, provenance, and launch snapshots are
//     preserved;
// (4) Hermes and the four coding agents share one capability + dispatch
//     contract (agent plus registered connection and scope), with no
//     separate runtime mode and no removed transport;
// (5) unconfigured rows stay readable, cannot launch, and never regain a
//     deck; configuring them resolves them.

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
const reg = jiti('./lib/agent-registration.ts');
const probe = jiti('./lib/runtime-probe.ts');
const dispatch = jiti('./lib/agent-dispatch.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
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
const WORKROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-bot-definition-ws-'));
const LEGACY_KEYS = ['runtime', 'agent_client', 'persistent_runtime', 'coding_runtime', 'needs_deck_reselection',
  'deck_id', 'deck_name', 'working_directory', 'needs_deck_selection', 'launch_profile'];
const READ_ONLY = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };

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
  check('Hermes uses the gateway transport', def.agentTransport('hermes') === 'hermes-gateway');
  check('coding agents use the session-provider transport', ['cursor', 'claude', 'codex', 'muse'].every(a => def.agentTransport(a) === 'session-provider'));
  check('removed deck constants are gone', def.DECK_REQUIRED_ERROR === undefined && def.LEGACY_DECK_NAME_FIELD_ERROR === undefined
    && def.DIRECT_DECK_ERROR === undefined && def.DIRECT_WORKDIR_ERROR === undefined && def.PROFILE_REQUIRED_ERROR === undefined);

  // The obsolete Agent Deck execution/configuration surface is deleted,
  // not deprecated: modules, routes, UI, harness, and commands.
  for (const file of ['lib/agent-deck-api.ts', 'lib/agent-deck-attempt.ts', 'lib/agent-deck-run.ts', 'lib/agent-deck-finalization.ts',
    'lib/agent-deck-settings.ts', 'lib/finalize-decision.ts', 'app/components/AgentDeckRuntime.tsx', 'test-support/fake-agent-deck-api.js',
    'test-agent-deck-run.js', 'test-agent-deck-finalization.js', 'test-agent-deck-settings.js', 'docs/claude-via-deck.md']) {
    check(`${file} is deleted`, !fs.existsSync(path.join(ROOT, file)));
  }
  check('app/api/agent-deck routes are deleted', !fs.existsSync(path.join(ROOT, 'app/api/agent-deck')));
  const packageScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  check('no agent-deck package command remains', Object.keys(packageScripts).every(name => !/deck/i.test(name)), Object.keys(packageScripts).filter(name => /deck/i.test(name)).join(','));
  for (const file of ['lib/bot-definition.ts', 'lib/bot-runtime-ui.ts', 'app/page.tsx']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(`${file}: no "Runtime: Agent Deck" copy`, !source.includes('Runtime: Agent Deck') && !source.includes("label: 'Agent Deck'"));
  }
  const uiSource = fs.readFileSync(path.join(ROOT, 'lib/bot-runtime-ui.ts'), 'utf8');
  check('UI helpers offer no runtime option list', !/RUNTIME_OPTIONS|value: 'agent-deck'/.test(uiSource));
  const newAgentDialog = fs.existsSync(path.join(ROOT, 'app/components/NewAgentDialog.tsx'))
    ? fs.readFileSync(path.join(ROOT, 'app/components/NewAgentDialog.tsx'), 'utf8') : '';
  check('New Agent dialog has no launch-profile or deck control', !/launch_profile|launchProfile|deck_id|deckId|Agent Deck/.test(newAgentDialog));

  // ---- (2) API validation ---------------------------------------------------
  console.log('\n(2) Create/update validation');
  const created = {};
  for (const agent of FIVE) {
    const res = await call('POST', {
      name: `Agent-${agent}`,
      agent,
      runtime_connection_id: reg.localConnectionId(agent),
      session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, agent)] },
      policy: READ_ONLY,
    });
    created[agent] = res.json;
    check(
      `POST agent=${agent} on its connection stores the agent and is launchable`,
      res.status === 200 && res.json.agent === agent && res.json.runtime_connection_id === reg.localConnectionId(agent)
        && res.json.launchable === true && res.json.launch_blocker === null,
      JSON.stringify(res)
    );
    const row = rowOf(res.json.id);
    check(
      `stored row for ${agent}: agent set, removed launch columns cleared, legacy runtime never written`,
      row.agent === agent && row.launch_profile === 'direct' && row.deck_id === null && row.working_directory === null
        && row.needs_deck_selection === 0 && row.runtime === null && row.agent_client === null,
      JSON.stringify({ agent: row.agent, profile: row.launch_profile, runtime: row.runtime, agent_client: row.agent_client })
    );
    check(`serialized ${agent} bot exposes no legacy launch keys`, LEGACY_KEYS.every(key => !(key in res.json)), Object.keys(res.json).join(','));
  }
  const follows = await call('POST', {
    name: 'FollowsConnection', runtime_connection_id: reg.localConnectionId('claude'),
    session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY,
  });
  check('POST without agent follows the connection provider', follows.status === 200 && follows.json.agent === 'claude');

  const rejectCases = [
    ['missing connection', { name: 'NoConn', agent: 'codex' }, /Runtime connection is required/],
    ['missing scope', { name: 'NoScope', agent: 'codex', runtime_connection_id: reg.localConnectionId('codex') }, /Session scope is required/],
    ['missing policy', { name: 'NoPolicy', agent: 'codex', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' } }, /Launch policy is required/],
    ['unknown agent', { name: 'Watson', agent: 'watson', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /does not match the runtime connection provider/],
    ['agent-deck as agent', { name: 'DeckAsAgent', agent: 'agent-deck', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /does not match the runtime connection provider/],
    ['launch_profile field', { name: 'Profile', agent: 'codex', launch_profile: 'direct', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /no longer accepted/],
    ['deck_id field', { name: 'Decked', agent: 'codex', deck_id: 'd1', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /no longer accepted/],
    ['deck_name field', { name: 'Named', agent: 'codex', deck_name: 'd1', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /no longer accepted/],
    ['working_directory field', { name: 'Workdir', agent: 'codex', working_directory: '/w', runtime_connection_id: reg.localConnectionId('codex'), session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY }, /no longer accepted/],
    ['legacy runtime field', { name: 'Legacy', runtime: 'agent-deck', agent_client: 'codex' }, /no longer accepted/],
    ['legacy runtime=hermes', { name: 'LegacyH', runtime: 'hermes' }, /no longer accepted/],
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
    ['launch_profile', { launch_profile: 'direct' }],
    ['deck_id', { deck_id: 'd1' }],
    ['deck_name', { deck_name: 'relay-deck' }],
    ['working_directory', { working_directory: '/w' }],
    ['legacy runtime', { runtime: 'hermes' }],
    ['legacy agent_client', { agent_client: 'claude' }],
  ];
  for (const [label, fields] of patchRejects) {
    const before = rowOf(target.id);
    const res = await call('PATCH', { id: target.id, name: 'Renamed', pinned: true, avatar: { color: 'teal' }, ...fields });
    const after = rowOf(target.id);
    check(
      `PATCH rejects ${label} with 400 and no partial write (name/pin/avatar/agent/registration unchanged)`,
      res.status === 400 && JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify({ status: res.status, error: res.json.error })
    );
  }
  const switched = await call('PATCH', { id: target.id, agent: 'muse' });
  check('PATCH agent alone moves to that provider’s local connection', switched.status === 200 && switched.json.agent === 'muse'
    && switched.json.runtime_connection_id === reg.localConnectionId('muse') && switched.json.launchable === true, JSON.stringify(switched.json));
  const toHermes = await call('PATCH', { id: target.id, agent: 'hermes' });
  check('switching to Hermes moves to the Hermes connection (Hermes is an agent, not a mode)', toHermes.json.agent === 'hermes'
    && toHermes.json.runtime_connection_id === reg.localConnectionId('hermes'), JSON.stringify(toHermes.json));

  const listed = await botsRoute.GET();
  const list = await listed.json();
  check('GET /api/bots serializes agent + direct state for every bot, no legacy keys',
    list.length > 0 && list.every(bot => FIVE.includes(bot.agent) && 'runtime_connection_id' in bot
      && 'session_scope' in bot && 'launchable' in bot && LEGACY_KEYS.every(key => !(key in bot))));

  // ---- (5) unconfigured rows --------------------------------------------------
  console.log('\n(5) Unconfigured rows');
  const imported = db.bots.createFromImport(
    { name: 'Imported', title: 'Imported', description: 'Imported bot.' },
    { source_provider: 'test', template_id: 't1', template_url: 'https://example.test/t1', import_schema_version: '1', import_operation_id: `op-${process.pid}`, import_timestamp: Date.now() }
  );
  const importedView = db.serializeAgent(db.bots.getById(imported.id));
  check('imported bot reads back as Hermes launching direct with a fallback scope',
    importedView.agent === 'hermes' && importedView.launchable === true && importedView.session_scope.kind === 'workspaces', JSON.stringify(importedView));
  const stale = db.bots.create({ name: 'Stale', title: '', description: 'Legacy.', agent: 'codex', deck_name: 'relay-deck' });
  raw.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(stale.id);
  const staleView = db.serializeAgent(db.bots.getById(stale.id));
  check('unconfigured row stays readable with no deck in the read shape',
    staleView.agent === 'codex' && staleView.launchable === false && staleView.launch_blocker === 'session_scope'
    && LEGACY_KEYS.every(key => !(key in staleView)));
  check('legacy deck_name stays in storage only (history, never serialized)',
    rowOf(stale.id).deck_name === 'relay-deck' && !('deck_name' in staleView));
  const configured = await call('PATCH', { id: stale.id, session_scope: { kind: 'workspaces', workspaces: ['/tmp/stale'] } });
  check('configuring a scope resolves the row', configured.status === 200 && configured.json.launchable === true && configured.json.launch_blocker === null, JSON.stringify(configured.json));

  let launches = 0;
  dispatch.setAttemptAdapterOverride(transport => {
    launches += 1;
    return { name: transport, run: async () => ({ status: 'completed', adapter: transport, externalRunId: 'r', externalSessionId: null, output: 'reply', artifacts: [], startedAt: 1, finishedAt: 1, failure: null }) };
  });
  const stillBroken = db.bots.create({ name: 'StillBroken', title: '', description: '', agent: 'codex' });
  raw.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(stillBroken.id);
  let code = null;
  try {
    await dispatch.dispatchToAgent({ bot: db.bots.getById(stillBroken.id), history: [{ speakerLabel: 'user', fromAgent: false, content: 'hi' }] });
  } catch (error) {
    code = error.code;
  }
  check('dispatch refuses the unconfigured row as agent_unavailable', code === 'agent_unavailable', String(code));
  check('no adapter ran for the unconfigured row', launches === 0, `launches=${launches}`);
  dispatch.setAttemptAdapterOverride(null);

  // ---- (4) capability + dispatch for all five agents ------------------------
  console.log('\n(4) One agent contract for Hermes and the coding agents');
  probe.setHermesAdapterProbe(() => true);
  probe.setRuntimeProbeProcess(async argv => {
    if (argv[1] === '--version') {
      return ['codex', 'claude'].includes(argv[0])
        ? { stdout: `${argv[0]} 1.0\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'not found', exitCode: 127 };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  });
  const ready = await probe.listAvailableAgents();
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
  check('unknown or unprobed values are dropped from availability',
    JSON.stringify(def.buildAvailabilityPayload(['hermes', 'agent-deck', 'watson'])) === JSON.stringify({ agents: [{ agent: 'hermes', label: 'Hermes', launchable: true }] }));
  probe.setHermesAdapterProbe(() => false);
  check('Hermes is advertised only when its gateway adapter is ready', !(await probe.listAvailableAgents()).includes('hermes'));
  probe.setHermesAdapterProbe(null);
  probe.resetRuntimeProbeProcessForTests();

  dispatch.setAttemptAdapterOverride(transport => ({
    name: transport,
    run: async () => ({ status: 'completed', adapter: transport, externalRunId: 'r', externalSessionId: null, output: `${transport} reply`, artifacts: [], startedAt: 1, finishedAt: 1, failure: null }),
  }));
  for (const agent of FIVE) {
    const made = await call('POST', {
      name: `Dispatch-${agent}`,
      agent,
      runtime_connection_id: reg.localConnectionId(agent),
      session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, `dispatch-${agent}`)] },
      policy: READ_ONLY,
    });
    const bot = db.bots.getById(made.json.id);
    const prepared = dispatch.prepareDispatch({ bot, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hello' }] });
    const reply = await dispatch.dispatchToAgent({ bot, history: [{ speakerLabel: 'user', fromAgent: false, content: 'hello' }] });
    check(`agentForDispatch reports ${agent}`, dispatch.agentForDispatch(bot) === agent);
    if (agent === 'hermes') {
      check('Hermes dispatches through its gateway adapter only', prepared.adapter.name === 'hermes-gateway' && reply === 'hermes-gateway reply');
    } else {
      check(`${agent} dispatches through the session-provider adapter`, prepared.adapter.name === 'session-provider' && reply === 'session-provider reply'
        && prepared.input.target.agent === agent && typeof prepared.input.cwd === 'string');
    }
  }
  dispatch.setAttemptAdapterOverride(null);
  check('no coding-agent dispatch can select a removed transport', dispatch.adapterForTransport('agent-deck-run') === null && dispatch.adapterForTransport('agent-deck-api') === null);

  // ---- (3) migration of every legacy shape ---------------------------------
  console.log('\n(3) Deterministic migration (pure rule)');
  const pure = [
    [{ runtime: 'hermes' }, { agent: 'hermes', migrated: true }],
    [{ runtime: 'hermes', deck_id: 'kept' }, { agent: 'hermes', migrated: true }],
    ...['codex', 'claude', 'cursor', 'muse'].map(client => [
      { runtime: 'agent-deck', agent_client: client, deck_id: `d-${client}`, working_directory: '/w' },
      { agent: client, migrated: true },
    ]),
    [{ runtime: 'agent-deck', agent_client: 'codex', deck_name: 'relay-deck' }, { agent: 'codex', migrated: true }],
    [{ runtime: 'agent-deck', agent_client: 'watson', deck_id: 'd1' }, { agent: 'hermes', migrated: true }],
    [{ runtime: null, coding_runtime: 'muse', deck_name: 'legacy', working_directory: '/w' }, { agent: 'muse', migrated: true }],
    [{ runtime: null, coding_runtime: 'claude', deck_name: null, working_directory: '/w' }, { agent: 'hermes', migrated: true }],
    [{ runtime: null }, { agent: 'hermes', migrated: true }],
    [{ agent: 'cursor', deck_id: 'd9', runtime: 'hermes' }, { agent: 'cursor', migrated: false }],
    [{ agent: 'watson' }, { agent: 'hermes', migrated: true }],
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
    { id: 'm-hermes', runtime: 'hermes', agent_client: null, deck_id: null, deck_name: null, working_directory: null, needs: 0, expectAgent: 'hermes' },
    { id: 'm-claude', runtime: 'agent-deck', agent_client: 'claude', deck_id: 'deck-live', deck_name: null, working_directory: '/tmp/claude-work', needs: 0, expectAgent: 'claude' },
    { id: 'm-cursor', runtime: 'agent-deck', agent_client: 'cursor', deck_id: 'deck-c', deck_name: null, working_directory: null, needs: 0, expectAgent: 'cursor' },
    { id: 'm-muse', runtime: 'agent-deck', agent_client: 'muse', deck_id: 'deck-m', deck_name: null, working_directory: null, needs: 0, expectAgent: 'muse' },
    { id: 'm-unresolved', runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/relay', needs: 1, expectAgent: 'codex' },
    { id: 'm-pre442', runtime: null, coding_runtime: 'codex', agent_client: null, deck_id: null, deck_name: 'old-deck', working_directory: '/tmp/old', needs: 0, expectAgent: 'codex' },
    { id: 'm-imported', runtime: 'hermes', agent_client: null, deck_id: null, deck_name: null, working_directory: null, needs: 0, provenance: true, expectAgent: 'hermes' },
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
    // Post-NOT-446 shape (origin already bound).
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
    const expectedScope = JSON.stringify([row.working_directory || `~/.botmancers/${row.id}`]);
    const ok = got && got.agent === row.expectAgent
      && got.launch_profile === 'direct' && got.deck_id === null && got.working_directory === null && got.needs_deck_selection === 0
      && got.runtime_connection_id === `rc-local-${row.expectAgent}`
      && got.session_scope_kind === 'workspaces' && got.session_scope_items === expectedScope
      && got.policy_mode === 'read_only' && got.allow_new_sessions === 1 && got.allow_resume_with_edits === 0;
    console.log(`  before ${row.id}: runtime=${row.runtime} agent_client=${row.agent_client} coding_runtime=${row.coding_runtime ?? null} deck_id=${row.deck_id} wd=${row.working_directory}`);
    console.log(`  after  ${row.id}: agent=${got && got.agent} profile=${got && got.launch_profile} connection=${got && got.runtime_connection_id} scope=${got && got.session_scope_items}`);
    check(`DB migration ${row.id} -> direct ${row.expectAgent} with fallback registration`, ok, JSON.stringify(got));
    if (got) {
      check(`${row.id}: legacy deck_name kept in storage, selection cleared`, got.deck_name === row.deck_name);
      const view = def.serializeBot(got);
      check(`${row.id}: launchable direct with its fallback scope`, view.launchable === true && view.launch_blocker === null);
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
  fs.rmSync(WORKROOT, { recursive: true, force: true });
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
