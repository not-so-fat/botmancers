#!/usr/bin/env node
// NOT-502: registered Agent on a runtime connection (deterministic, no
// network, no Agent Deck server).
//
// Proves:
// (1) persistence: runtime connections are separate from Agents; an Agent
//     stores connection, explicit scope, optional default workspace,
//     launch profile, policy, and optional home session on its own row
//     (no duplicated identity); create, edit, reload, a shared connection,
//     and cross-Agent home-session references;
// (2) API validation: every allowed and rejected combination of profile,
//     deck, scope, default workspace, policy, and home session; rejected
//     requests write nothing (create and edit);
// (3) direct profiles never need or contact Agent Deck (dispatch and the
//     deck proxy are never reached); Agent Deck profiles still need a deck;
// (4) migration: a pre-NOT-502 database (rows with a deck, unresolved
//     rows, conversations, work requests, attempts, session bindings,
//     wake grants, snapshots, service-grant file) migrates with every
//     non-bots table byte-for-byte preserved, legacy deck references kept,
//     unresolved rows unlaunchable, and no widened authority; idempotent.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-registration-test-${process.pid}.db`);
const MIGRATION_DB_PATH = path.join(os.tmpdir(), `botmancers-registration-migration-test-${process.pid}.db`);
const GRANTS_PATH = path.join(os.tmpdir(), `botmancers-registration-grants-${process.pid}.json`);
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
const dispatch = jiti('./lib/agent-dispatch.ts');
const agentLoop = jiti('./lib/agent.ts');
const botsRoute = jiti('./app/api/bots/route.ts');
const connectionsRoute = jiti('./app/api/runtime-connections/route.ts');
const raw = db.default;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function jsonRequest(url, method, body) {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function call(method, body) {
  const res = await botsRoute[method](jsonRequest('http://localhost:43123/api/bots', method, body));
  return { status: res.status, json: await res.json() };
}
async function connection(body) {
  const res = await connectionsRoute.POST(jsonRequest('http://localhost:43123/api/runtime-connections', 'POST', body));
  return { status: res.status, json: await res.json() };
}
const botCount = () => raw.prepare('SELECT COUNT(*) AS n FROM bots').get().n;
const rowOf = id => raw.prepare('SELECT * FROM bots WHERE id = ?').get(id);

// Any fetch reaching Agent Deck (or anywhere) during a direct-profile path
// is a failure of "direct launch must not contact Agent Deck".
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetched.push(String(url));
  throw new Error(`unexpected network call to ${url}`);
};

const READ_ONLY = { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false };
const WRITE = { mode: 'workspace_write', allow_new_sessions: true, allow_resume_with_edits: true };

async function main() {
  // ---- (1) persistence ----------------------------------------------------
  console.log('\n(1) Runtime connections and registered Agents');
  const created = await connection({ provider: 'codex', label: 'Codex on Yusuke’s Mac', host: 'Yusuke’s Mac' });
  check('POST /api/runtime-connections creates a connection', created.status === 200 && created.json.provider === 'codex' && created.json.agent_count === 0, JSON.stringify(created.json));
  const codexConn = created.json.id;
  const secret = await connection({ provider: 'codex', label: 'With token', token: 'sk-nope' });
  check('connections refuse credentials', secret.status === 400 && /credentials/.test(secret.json.error), JSON.stringify(secret.json));
  const badProvider = await connection({ provider: 'agent-deck', label: 'Nope' });
  check('connections refuse a provider outside the Agent runtimes', badProvider.status === 400, JSON.stringify(badProvider.json));
  const noLabel = await connection({ provider: 'hermes', label: '  ' });
  check('connections require a name', noLabel.status === 400 && noLabel.json.error === reg.CONNECTION_LABEL_REQUIRED_ERROR);

  const direct = await call('POST', {
    name: 'Direct Codex',
    description: 'Reviews code.',
    runtime_connection_id: codexConn,
    launch_profile: 'direct',
    session_scope: { kind: 'workspaces', workspaces: ['/Users/owner/work/botmancers', '/Users/owner/work/other'] },
    default_workspace: '/Users/owner/work/botmancers/app',
    policy: READ_ONLY,
  });
  check('direct Codex Agent registers without a deck', direct.status === 200 && direct.json.launch_profile === 'direct' && direct.json.deck_id === null && direct.json.needs_deck_selection === false, JSON.stringify(direct.json));
  check('direct Agent: agent follows the connection provider', direct.json.agent === 'codex' && direct.json.runtime_connection.label === 'Codex on Yusuke’s Mac');
  check('direct Agent: scope, default workspace, policy read back', JSON.stringify(direct.json.session_scope) === JSON.stringify({ kind: 'workspaces', workspaces: ['/Users/owner/work/botmancers', '/Users/owner/work/other'], sessions: [] })
    && direct.json.default_workspace === '/Users/owner/work/botmancers/app'
    && JSON.stringify(direct.json.policy) === JSON.stringify(READ_ONLY), JSON.stringify(direct.json));
  check('direct Codex: registration complete but direct coding launch waits for provider sessions', direct.json.launchable === false && direct.json.launch_blocker === 'direct_runtime');
  check('read shape exposes no raw registration storage columns', !('session_scope_items' in direct.json) && !('policy_mode' in direct.json));

  const deckAgent = await call('POST', {
    name: 'Deck Codex',
    runtime_connection_id: codexConn,
    launch_profile: 'agent_deck',
    deck_id: 'deck-builder',
    working_directory: '/Users/owner/work/botmancers',
    session_scope: { kind: 'all_provider_sessions' },
    policy: WRITE,
  });
  check('Agent Deck Codex Agent registers with its deck', deckAgent.status === 200 && deckAgent.json.launch_profile === 'agent_deck' && deckAgent.json.deck_id === 'deck-builder' && deckAgent.json.launchable === true, JSON.stringify(deckAgent.json));
  check('two Agents share one runtime connection', deckAgent.json.runtime_connection_id === direct.json.runtime_connection_id);
  const listed = await (await connectionsRoute.GET()).json();
  check('the shared connection counts both Agents', listed.connections.find(c => c.id === codexConn).agent_count === 2, JSON.stringify(listed));
  check('Agent identity stays on the bots row only (connections hold no Agent fields)',
    JSON.stringify(raw.prepare('PRAGMA table_info(runtime_connections)').all().map(c => c.name)) === JSON.stringify(['id', 'provider', 'label', 'host', 'created_at']));

  const hermesDirect = await call('POST', {
    name: 'Direct Hermes',
    runtime_connection_id: reg.localConnectionId('hermes'),
    launch_profile: 'direct',
    session_scope: { kind: 'workspaces', workspaces: ['~/notes'] },
    policy: READ_ONLY,
  });
  check('Hermes keeps working: a direct Hermes Agent is launchable without a deck', hermesDirect.status === 200 && hermesDirect.json.launchable === true && hermesDirect.json.deck_id === null, JSON.stringify(hermesDirect.json));

  // Reload: a fresh read of the stored rows.
  const reloaded = await (await botsRoute.GET()).json();
  const reDirect = reloaded.find(b => b.id === direct.json.id);
  const reDeck = reloaded.find(b => b.id === deckAgent.json.id);
  check('reload: direct Agent keeps profile, scope, default workspace, policy', reDirect.launch_profile === 'direct' && reDirect.deck_id === null && reDirect.default_workspace === '/Users/owner/work/botmancers/app' && reDirect.policy.mode === 'read_only');
  check('reload: Agent Deck Agent keeps its deck and workspace override', reDeck.launch_profile === 'agent_deck' && reDeck.deck_id === 'deck-builder' && reDeck.working_directory === '/Users/owner/work/botmancers' && reDeck.session_scope.kind === 'all_provider_sessions');

  // Edit.
  const edited = await call('PATCH', { id: direct.json.id, policy: { mode: 'workspace_write', allow_new_sessions: false, allow_resume_with_edits: true }, default_workspace: '' });
  check('edit: policy and default workspace update in place', edited.status === 200 && edited.json.policy.mode === 'workspace_write' && edited.json.policy.allow_new_sessions === false && edited.json.default_workspace === null && edited.json.launch_profile === 'direct', JSON.stringify(edited.json));
  const toDeck = await call('PATCH', { id: direct.json.id, launch_profile: 'agent_deck', deck_id: 'deck-review' });
  check('edit: direct -> agent_deck with a deck', toDeck.status === 200 && toDeck.json.launch_profile === 'agent_deck' && toDeck.json.deck_id === 'deck-review', JSON.stringify(toDeck.json));
  const backDirect = await call('PATCH', { id: direct.json.id, launch_profile: 'direct' });
  check('edit: agent_deck -> direct drops the Agent Deck settings', backDirect.status === 200 && backDirect.json.deck_id === null && backDirect.json.working_directory === null && rowOf(direct.json.id).deck_id === null, JSON.stringify(backDirect.json));
  const claudeConn = (await connection({ provider: 'claude', label: 'Claude on the studio Mac', host: 'Studio' })).json.id;
  const moved = await call('PATCH', { id: direct.json.id, runtime_connection_id: claudeConn });
  check('edit: moving to another connection changes the agent with it, keeping the Agent ID', moved.status === 200 && moved.json.agent === 'claude' && moved.json.id === direct.json.id && rowOf(direct.json.id).agent === 'claude');
  await call('PATCH', { id: direct.json.id, runtime_connection_id: codexConn });

  // Home session: must belong to this Agent.
  const conv = db.conversations.getByBotId(direct.json.id);
  const otherConv = db.conversations.getByBotId(deckAgent.json.id);
  const mine = db.engine.bindSession({ agentId: direct.json.id, adapter: 'codex', externalSessionId: 'prov-sess-SECRET-mine', conversationId: conv.id, now: Date.now() });
  const theirs = db.engine.bindSession({ agentId: deckAgent.json.id, adapter: 'codex', externalSessionId: 'prov-sess-SECRET-theirs', conversationId: otherConv.id, now: Date.now() });
  const beforeForeign = JSON.stringify(rowOf(direct.json.id));
  const foreign = await call('PATCH', { id: direct.json.id, home_session_id: theirs.id, policy: READ_ONLY });
  check('home session of another Agent is rejected with nothing written', foreign.status === 400 && foreign.json.error === reg.HOME_SESSION_FOREIGN_ERROR && JSON.stringify(rowOf(direct.json.id)) === beforeForeign, JSON.stringify(foreign.json));
  const unknown = await call('PATCH', { id: direct.json.id, home_session_id: 'no-such-session' });
  check('unknown home session is rejected', unknown.status === 400 && unknown.json.error === reg.HOME_SESSION_FOREIGN_ERROR);
  const home = await call('PATCH', { id: direct.json.id, home_session_id: mine.id });
  check('own home session is stored and read back by its Botmancers ref', home.status === 200 && home.json.home_session_id === mine.id, JSON.stringify(home.json));
  check('no provider session id appears in the Agent read shape', !JSON.stringify(home.json).includes('SECRET'));
  const homeOnCreate = await call('POST', { name: 'Home on create', runtime_connection_id: codexConn, launch_profile: 'direct', session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY, home_session_id: mine.id });
  check('a new Agent cannot claim an existing Agent’s session as home', homeOnCreate.status === 400 && homeOnCreate.json.error === reg.HOME_SESSION_FOREIGN_ERROR);
  const sessionScope = await call('PATCH', { id: direct.json.id, session_scope: { kind: 'sessions', sessions: [mine.id] } });
  check('session scope of the Agent’s own sessions saves', sessionScope.status === 200 && sessionScope.json.session_scope.kind === 'sessions', JSON.stringify(sessionScope.json));
  const foreignScope = await call('PATCH', { id: direct.json.id, session_scope: { kind: 'sessions', sessions: [mine.id, theirs.id] } });
  check('session scope naming another Agent’s session is rejected', foreignScope.status === 400 && foreignScope.json.error === reg.SCOPE_SESSION_FOREIGN_ERROR);
  const homeOutside = await call('PATCH', { id: deckAgent.json.id, session_scope: { kind: 'sessions', sessions: [theirs.id] }, home_session_id: theirs.id });
  check('Agent Deck Agent: own session scope + home session saves', homeOutside.status === 200 && homeOutside.json.home_session_id === theirs.id);

  // ---- (2) API validation matrix ----------------------------------------
  console.log('\n(2) Create/edit validation matrix (fail closed, no partial writes)');
  const base = { runtime_connection_id: codexConn, session_scope: { kind: 'workspaces', workspaces: ['/w'] }, policy: READ_ONLY };
  const allowed = [
    ['direct + workspaces', { ...base, launch_profile: 'direct' }],
    ['direct + all sessions', { ...base, launch_profile: 'direct', session_scope: { kind: 'all_provider_sessions' } }],
    ['direct + default workspace inside scope', { ...base, launch_profile: 'direct', default_workspace: '/w/app' }],
    ['direct + default workspace with all sessions', { ...base, launch_profile: 'direct', session_scope: { kind: 'all_provider_sessions' }, default_workspace: '~/code' }],
    ['direct + workspace_write + resume edits', { ...base, launch_profile: 'direct', policy: WRITE }],
    ['agent_deck + deck', { ...base, launch_profile: 'agent_deck', deck_id: 'deck-1' }],
    ['agent_deck + deck + workdir', { ...base, launch_profile: 'agent_deck', deck_id: 'deck-1', working_directory: '/w' }],
    ['agent_deck + flags omitted (false)', { ...base, launch_profile: 'agent_deck', deck_id: 'deck-1', policy: { mode: 'read_only' } }],
    ['legacy { agent, deck_id } shape', { agent: 'claude', deck_id: 'deck-legacy' }],
  ];
  let n = 0;
  for (const [label, body] of allowed) {
    const res = await call('POST', { name: `Allowed ${++n}`, ...body });
    check(`allowed: ${label}`, res.status === 200, JSON.stringify(res.json));
  }
  const legacy = await call('POST', { name: 'Legacy shape', agent: 'muse', deck_id: 'deck-legacy' });
  check('legacy shape becomes agent_deck on the local connection scoped to its default workdir',
    legacy.json.launch_profile === 'agent_deck' && legacy.json.runtime_connection_id === reg.localConnectionId('muse')
      && JSON.stringify(legacy.json.session_scope.workspaces) === JSON.stringify([`~/.botmancers/${legacy.json.id}`])
      && JSON.stringify(legacy.json.policy) === JSON.stringify(reg.MIGRATED_POLICY), JSON.stringify(legacy.json));

  const rejected = [
    ['missing profile', { ...base }, reg.PROFILE_REQUIRED_ERROR],
    ['unknown profile', { ...base, launch_profile: 'remote' }, reg.PROFILE_INVALID_ERROR],
    ['missing connection', { ...base, runtime_connection_id: undefined, launch_profile: 'direct' }, reg.CONNECTION_REQUIRED_ERROR],
    ['unknown connection', { ...base, runtime_connection_id: 'rc-nope', launch_profile: 'direct' }, reg.CONNECTION_NOT_FOUND_ERROR],
    ['agent contradicts connection', { ...base, agent: 'hermes', launch_profile: 'direct' }, reg.CONNECTION_PROVIDER_MISMATCH_ERROR],
    ['agent_deck without deck', { ...base, launch_profile: 'agent_deck' }, def.DECK_REQUIRED_ERROR],
    ['agent_deck with blank deck', { ...base, launch_profile: 'agent_deck', deck_id: '  ' }, def.DECK_REQUIRED_ERROR],
    ['agent_deck with malformed deck', { ...base, launch_profile: 'agent_deck', deck_id: 'has space' }, /Invalid deck ID/],
    ['direct with a deck', { ...base, launch_profile: 'direct', deck_id: 'deck-1' }, reg.DIRECT_DECK_ERROR],
    ['direct with an Agent Deck workdir', { ...base, launch_profile: 'direct', working_directory: '/w' }, reg.DIRECT_WORKDIR_ERROR],
    ['missing scope', { ...base, launch_profile: 'direct', session_scope: undefined }, reg.SCOPE_REQUIRED_ERROR],
    ['scope without kind', { ...base, launch_profile: 'direct', session_scope: { workspaces: ['/w'] } }, reg.SCOPE_REQUIRED_ERROR],
    ['unknown scope kind', { ...base, launch_profile: 'direct', session_scope: { kind: 'everything' } }, reg.SCOPE_INVALID_ERROR],
    ['empty workspace scope', { ...base, launch_profile: 'direct', session_scope: { kind: 'workspaces', workspaces: [] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    ['blank-only workspace scope', { ...base, launch_profile: 'direct', session_scope: { kind: 'workspaces', workspaces: ['  '] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    ['empty session scope', { ...base, launch_profile: 'direct', session_scope: { kind: 'sessions', sessions: [] } }, reg.SCOPE_EMPTY_SESSIONS_ERROR],
    ['session scope on a new Agent', { ...base, launch_profile: 'direct', session_scope: { kind: 'sessions', sessions: [mine.id] } }, reg.SCOPE_SESSION_FOREIGN_ERROR],
    ['all sessions with a list', { ...base, launch_profile: 'direct', session_scope: { kind: 'all_provider_sessions', workspaces: ['/w'] } }, reg.SCOPE_ALL_WITH_LIST_ERROR],
    ['mixed workspaces and sessions', { ...base, launch_profile: 'direct', session_scope: { kind: 'workspaces', workspaces: ['/w'], sessions: ['s'] } }, reg.SCOPE_MIXED_ERROR],
    ['relative workspace', { ...base, launch_profile: 'direct', session_scope: { kind: 'workspaces', workspaces: ['work'] } }, reg.WORKSPACE_PATH_ERROR],
    ['relative default workspace', { ...base, launch_profile: 'direct', default_workspace: 'work' }, reg.WORKSPACE_PATH_ERROR],
    ['default workspace outside scope', { ...base, launch_profile: 'direct', default_workspace: '/elsewhere' }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    ['default workspace sharing only a prefix', { ...base, launch_profile: 'direct', default_workspace: '/w2' }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    ['missing policy', { ...base, launch_profile: 'direct', policy: undefined }, reg.POLICY_REQUIRED_ERROR],
    ['policy without mode', { ...base, launch_profile: 'direct', policy: { allow_new_sessions: true } }, reg.POLICY_REQUIRED_ERROR],
    ['unknown policy mode', { ...base, launch_profile: 'direct', policy: { mode: 'admin' } }, reg.POLICY_MODE_ERROR],
    ['non-boolean policy flag', { ...base, launch_profile: 'direct', policy: { mode: 'read_only', allow_new_sessions: 'yes' } }, reg.POLICY_FLAG_ERROR],
    ['resume with edits under read_only', { ...base, launch_profile: 'direct', policy: { mode: 'read_only', allow_resume_with_edits: true } }, reg.POLICY_RESUME_EDITS_ERROR],
    ['legacy runtime field', { ...base, launch_profile: 'direct', runtime: 'agent-deck' }, def.LEGACY_RUNTIME_FIELD_ERROR],
    ['legacy deck_name', { ...base, launch_profile: 'agent_deck', deck_id: 'd', deck_name: 'x' }, def.LEGACY_DECK_NAME_FIELD_ERROR],
    ['nothing but a name', {}, reg.CONNECTION_REQUIRED_ERROR],
  ];
  for (const [label, body] of rejected) {
    const before = botCount();
    const connectionsBefore = raw.prepare('SELECT COUNT(*) AS n FROM runtime_connections').get().n;
    const res = await call('POST', { name: `Rejected ${label}`, ...body });
    const matches = typeof body === 'object' && (label === 'agent contradicts connection'
      ? res.json.errors && res.json.errors.includes(reg.CONNECTION_PROVIDER_MISMATCH_ERROR)
      : res.json.errors && res.json.errors.some(error => (expectedMatch(error))));
    function expectedMatch(error) {
      const expected = rejected.find(entry => entry[0] === label)[2];
      return expected instanceof RegExp ? expected.test(error) : error === expected;
    }
    check(`rejected create: ${label}`, res.status === 400 && matches && botCount() === before
      && raw.prepare('SELECT COUNT(*) AS n FROM runtime_connections').get().n === connectionsBefore, JSON.stringify(res.json));
  }

  // Edit matrix against one stored Agent Deck Agent and one direct Agent.
  const deckRow = (await call('POST', { name: 'Edit target deck', ...base, launch_profile: 'agent_deck', deck_id: 'deck-edit', working_directory: '/w' })).json;
  const directRow = (await call('POST', { name: 'Edit target direct', ...base, launch_profile: 'direct' })).json;
  const editRejected = [
    [deckRow, 'clear profile', { launch_profile: null }, reg.PROFILE_REQUIRED_ERROR],
    [deckRow, 'blank deck on agent_deck', { deck_id: '' }, def.DECK_REQUIRED_ERROR],
    [deckRow, 'direct while sending a deck', { launch_profile: 'direct', deck_id: 'deck-edit' }, reg.DIRECT_DECK_ERROR],
    [directRow, 'deck_id on a direct Agent', { deck_id: 'deck-x' }, reg.DIRECT_DECK_ERROR],
    [directRow, 'workdir on a direct Agent', { working_directory: '/w' }, reg.DIRECT_WORKDIR_ERROR],
    [directRow, 'agent_deck without a deck', { launch_profile: 'agent_deck' }, def.DECK_REQUIRED_ERROR],
    [directRow, 'empty scope', { session_scope: { kind: 'workspaces', workspaces: [] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    [directRow, 'null scope', { session_scope: null }, reg.SCOPE_REQUIRED_ERROR],
    [directRow, 'scope that strands the default workspace', { default_workspace: '/w/app', session_scope: { kind: 'workspaces', workspaces: ['/other'] } }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    [directRow, 'resume edits under read_only', { policy: { mode: 'read_only', allow_resume_with_edits: true } }, reg.POLICY_RESUME_EDITS_ERROR],
    [directRow, 'unknown connection', { runtime_connection_id: 'rc-missing' }, reg.CONNECTION_NOT_FOUND_ERROR],
    // A valid field next to an invalid one: the valid one is not written.
    [directRow, 'valid name + invalid policy', { name: 'Renamed?', policy: { mode: 'nope' } }, reg.POLICY_MODE_ERROR],
  ];
  for (const [target, label, patch, expected] of editRejected) {
    const before = JSON.stringify(rowOf(target.id));
    const res = await call('PATCH', { id: target.id, ...patch });
    const ok = res.status === 400 && res.json.errors && res.json.errors.includes(expected) && JSON.stringify(rowOf(target.id)) === before;
    check(`rejected edit: ${label} (row unchanged)`, ok, JSON.stringify(res.json));
  }
  const editAllowed = [
    [deckRow, 'switch deck', { deck_id: 'deck-edit-2' }, json => json.deck_id === 'deck-edit-2'],
    [deckRow, 'clear workdir override', { working_directory: '' }, json => json.working_directory === null],
    [deckRow, 'switch to direct', { launch_profile: 'direct' }, json => json.launch_profile === 'direct' && json.deck_id === null],
    [directRow, 'switch to agent_deck with deck', { launch_profile: 'agent_deck', deck_id: 'deck-e' }, json => json.launch_profile === 'agent_deck' && json.launchable === true],
    [directRow, 'all sessions scope', { session_scope: { kind: 'all_provider_sessions' } }, json => json.session_scope.kind === 'all_provider_sessions'],
    [directRow, 'legacy deck_id alone on agent_deck', { deck_id: 'deck-f' }, json => json.deck_id === 'deck-f'],
  ];
  for (const [target, label, patch, expectFn] of editAllowed) {
    const res = await call('PATCH', { id: target.id, ...patch });
    check(`allowed edit: ${label}`, res.status === 200 && expectFn(res.json), JSON.stringify(res.json));
  }

  // ---- (3) direct never contacts Agent Deck ------------------------------
  console.log('\n(3) Direct launch never contacts Agent Deck');
  await call('PATCH', { id: direct.json.id, session_scope: { kind: 'all_provider_sessions' }, home_session_id: '' });
  let failure = null;
  try {
    dispatch.prepareDispatch({ bot: db.bots.getById(direct.json.id), history: [] });
  } catch (error) {
    failure = error;
  }
  check('direct Codex dispatch fails closed with a non-deck reason', failure && failure.code === 'agent_unavailable' && failure.message === dispatch.DIRECT_LAUNCH_UNAVAILABLE, String(failure && failure.message));
  const hermesPrepared = dispatch.prepareDispatch({ bot: db.bots.getById(hermesDirect.json.id), history: [] });
  check('direct Hermes dispatch prepares on the gateway with no deck', hermesPrepared.adapter.name === 'hermes-gateway' && hermesPrepared.input.deck === null);
  check('direct thread notice never mentions a deck', !/Deck/.test(agentLoop.launchBlockedMessage(db.bots.getById(direct.json.id))));
  const unresolved = db.bots.create({ name: 'Unresolved', title: '', description: '', agent: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/relay' });
  check('unresolved row notice still asks for a deck or a direct choice', /\[Deck needs selection\].*relay-deck.*Direct/.test(agentLoop.launchBlockedMessage(db.bots.getById(unresolved.id))));
  // The direct Hermes Agent's pre-existing greeting turn may reach the
  // (unreachable) Hermes gateway; nothing may reach anything else.
  const nonGateway = fetched.filter(url => !url.startsWith(process.env.HERMES_BASE_URL));
  check('no Agent Deck (or other) network call on any direct path', nonGateway.length === 0, nonGateway.join(','));

  // Unresolved row: readable, not launchable, legacy edits keep it unresolved.
  const unresolvedView = db.serializeAgent(db.bots.getById(unresolved.id));
  check('unresolved row reads back with no profile and is not launchable', unresolvedView.launch_profile === null && unresolvedView.needs_launch_profile === true && unresolvedView.launchable === false && unresolvedView.deck_name === 'relay-deck');
  const workdirOnly = await call('PATCH', { id: unresolved.id, working_directory: '/tmp/relay-2' });
  check('legacy workdir edit leaves the row unresolved', workdirOnly.status === 200 && workdirOnly.json.launch_profile === null && workdirOnly.json.launchable === false);
  const policyOnly = await call('PATCH', { id: unresolved.id, policy: WRITE });
  check('a registration edit on an unresolved row must choose a profile', policyOnly.status === 400 && policyOnly.json.errors.includes(reg.PROFILE_REQUIRED_ERROR));
  const chooseDirect = await call('PATCH', { id: unresolved.id, launch_profile: 'direct' });
  check('owner explicitly chooses direct: resolves, Agent Deck settings dropped, legacy deck name kept', chooseDirect.status === 200 && chooseDirect.json.launch_profile === 'direct' && chooseDirect.json.deck_id === null && chooseDirect.json.deck_name === 'relay-deck', JSON.stringify(chooseDirect.json));

  // ---- (4) migration --------------------------------------------------------
  console.log('\n(4) Pre-NOT-502 database migration (before/after fixture)');
  fs.writeFileSync(GRANTS_PATH, '{"version":1,"services":{}}\n');
  const childEnv = { ...process.env, BOTMANCERS_DB_PATH: MIGRATION_DB_PATH, BOTMANCERS_SERVICE_GRANTS_PATH: GRANTS_PATH };
  // Seed with the current code (conversations, work requests, attempts,
  // session bindings, snapshots, wake grants), then strip every NOT-502
  // column and table to reproduce the pre-NOT-502 schema exactly.
  execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    const jiti = createJiti(${JSON.stringify(path.join(ROOT, 'seed.js'))}, { alias: { '@': ${JSON.stringify(ROOT)} } });
    const db = jiti('./lib/db.ts');
    const { seedSessionCatalog } = require('./test-support/session-catalog-fixture.js');
    seedSessionCatalog(db);
    const raw = db.default;
    const t = Date.now();
    db.bots.create({ name: 'Pending', title: '', description: 'Needs reselection.', agent: 'claude', deck_id: 'deck-stale', needs_deck_selection: 1, working_directory: '/tmp/pending' });
    db.bots.create({ name: 'Relay', title: '', description: 'Legacy deck name.', agent: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/relay' });
    db.bots.create({ name: 'Plain Hermes', title: '', description: 'No deck.', agent: 'hermes' });
    for (const conv of raw.prepare('SELECT id FROM conversations').all()) db.messages.create(conv.id, 'user', 'hello ' + conv.id);
    const ids = raw.prepare('SELECT id FROM bots ORDER BY created_at').all().map(r => r.id);
    raw.prepare("INSERT INTO wake_grants (id, caller_agent_id, target_agent_id, authority, granted_by_kind, granted_by_id, created_at) VALUES ('wg-1', ?, ?, 'edit', 'person', 'local-owner', ?)").run(ids[1], ids[0], t);
    for (const id of ids) {
      raw.prepare('INSERT INTO launch_snapshots (id, bot_id, created_at, hash, snapshot, transport) VALUES (?, ?, ?, ?, ?, ?)').run('snap-' + id, id, t, 'e'.repeat(64), JSON.stringify({ deck_id: 'x' }), 'agent-deck');
    }
    for (const column of ['runtime_connection_id', 'launch_profile', 'session_scope_kind', 'session_scope_items', 'default_workspace', 'policy_mode', 'allow_new_sessions', 'allow_resume_with_edits', 'home_session_id']) {
      raw.exec('ALTER TABLE bots DROP COLUMN ' + column);
    }
    raw.exec('DROP TABLE runtime_connections');
    raw.pragma('wal_checkpoint(TRUNCATE)');
  `], { cwd: ROOT, env: childEnv });
  const Database = require('better-sqlite3');
  const tablesOf = conn => conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('bots', 'runtime_connections') ORDER BY name").all().map(r => r.name);
  const dumpOf = conn => Object.fromEntries(tablesOf(conn).map(name => [name, conn.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  // color is re-derived on every load (pre-existing), so it is not compared.
  const legacyColumns = 'id, name, name_key, title, description, avatar, agent, deck_id, deck_name, working_directory, needs_deck_selection, hermes_profile, created_at';
  const pre = new Database(MIGRATION_DB_PATH);
  check('fixture is the pre-NOT-502 schema', !pre.prepare('PRAGMA table_info(bots)').all().some(c => c.name === 'launch_profile')
    && !pre.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runtime_connections'").get());
  const beforeDump = JSON.stringify(dumpOf(pre));
  const beforeBots = pre.prepare(`SELECT ${legacyColumns} FROM bots ORDER BY id`).all();
  const counts = Object.fromEntries(['conversations', 'messages', 'work_requests', 'work_attempts', 'session_bindings', 'wake_grants', 'launch_snapshots'].map(t => [t, pre.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  pre.close();
  check('fixture carries conversations, work requests, attempts, session bindings, grants, snapshots',
    Object.values(counts).every(n => n > 0), JSON.stringify(counts));
  const grantsBefore = fs.readFileSync(GRANTS_PATH, 'utf8');

  const loadDb = () => execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    createJiti(${JSON.stringify(path.join(ROOT, 'loader.js'))})('./lib/db.ts');
  `], { cwd: ROOT, env: childEnv });
  loadDb();
  const post = new Database(MIGRATION_DB_PATH);
  const after = post.prepare('SELECT * FROM bots ORDER BY id').all();
  console.log('  before -> after');
  for (const row of beforeBots) {
    const got = after.find(r => r.id === row.id);
    console.log(`  ${row.name}: agent=${row.agent} deck_id=${row.deck_id} needs=${row.needs_deck_selection} wd=${row.working_directory} -> profile=${got.launch_profile} connection=${got.runtime_connection_id} scope=${got.session_scope_kind}:${got.session_scope_items} policy=${got.policy_mode}/${got.allow_new_sessions}/${got.allow_resume_with_edits}`);
    const expectedProfile = row.deck_id && !row.needs_deck_selection ? 'agent_deck' : null;
    check(`${row.name}: ${expectedProfile ?? 'unresolved'} profile`, got.launch_profile === expectedProfile);
    check(`${row.name}: local connection for its agent`, got.runtime_connection_id === `rc-local-${row.agent}`);
    check(`${row.name}: scope is exactly its launch workspace (no widened authority)`, got.session_scope_kind === 'workspaces'
      && got.session_scope_items === JSON.stringify([row.working_directory || `~/.botmancers/${row.id}`]));
    check(`${row.name}: conservative policy, no default workspace, no home session`, got.policy_mode === 'read_only' && got.allow_new_sessions === 1 && got.allow_resume_with_edits === 0 && got.default_workspace === null && got.home_session_id === null);
    const view = def.serializeBot(got);
    check(`${row.name}: launchable only as before (with a selected deck)`, view.launchable === (expectedProfile === 'agent_deck'));
  }
  check('identity and legacy deck references preserved verbatim', JSON.stringify(post.prepare(`SELECT ${legacyColumns} FROM bots ORDER BY id`).all()) === JSON.stringify(beforeBots));
  check('every non-bots table (conversations, messages, work requests, attempts, session bindings, grants, snapshots, events) preserved byte-for-byte', JSON.stringify(dumpOf(post)) === beforeDump);
  check('service-grant file untouched', fs.readFileSync(GRANTS_PATH, 'utf8') === grantsBefore);
  check('one shared local connection per provider', JSON.stringify(post.prepare('SELECT provider FROM runtime_connections ORDER BY provider').all().map(r => r.provider)) === JSON.stringify([...def.AGENTS].sort()));
  const firstPass = JSON.stringify(post.prepare('SELECT * FROM bots ORDER BY id').all()) + JSON.stringify(post.prepare('SELECT * FROM runtime_connections ORDER BY id').all());
  post.close();
  loadDb();
  const again = new Database(MIGRATION_DB_PATH);
  check('migration is idempotent on reload', JSON.stringify(again.prepare('SELECT * FROM bots ORDER BY id').all()) + JSON.stringify(again.prepare('SELECT * FROM runtime_connections ORDER BY id').all()) === firstPass);
  again.close();

  globalThis.fetch = realFetch;
  removeDb(DB_PATH);
  removeDb(MIGRATION_DB_PATH);
  fs.rmSync(GRANTS_PATH, { force: true });
  if (failures > 0) {
    console.log(`\ntest:agent-registration: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\ntest:agent-registration: all assertions passing');
}

main().catch(error => {
  console.error(`FAIL: agent-registration test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
