#!/usr/bin/env node
// NOT-543: direct-only registered Agent on a runtime connection
// (deterministic, no network). Supersedes the NOT-502 version: there is no
// launch profile and no deck.
//
// Proves:
// (1) persistence: runtime connections are separate from Agents; an Agent
//     stores connection, explicit scope, optional default workspace,
//     policy, and optional home session on its own row (no duplicated
//     identity); create, edit, reload, a shared connection, and
//     cross-Agent home-session references;
// (2) API validation: every allowed and rejected combination of
//     connection, scope, default workspace, policy, and home session;
//     removed launch fields (launch profile, deck, working-directory
//     override) and legacy runtime fields are rejected; rejected
//     requests write nothing (create and edit);
// (3) direct-only dispatch: coding Agents resolve the session-provider
//     adapter and Hermes the gateway, with no network on any direct
//     path; removed transports have no adapter; rows without a usable
//     connection or scope stay readable and unlaunchable with a
//     direct-runtime explanation;
// (4) migration: a pre-NOT-543 database (agent_deck rows, rows with no
//     usable scope, conversations, work requests, attempts, session
//     bindings, wake grants, snapshots, service-grant file) migrates
//     one way to direct with every non-bots table byte-for-byte
//     preserved, deck configuration cleared, invalid rows unlaunchable,
//     and no widened authority; idempotent.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DB_PATH = path.join(os.tmpdir(), `botmancers-agent-registration-test-${process.pid}.db`);
const MIGRATION_DB_PATH = path.join(os.tmpdir(), `botmancers-registration-migration-test-${process.pid}.db`);
const GRANTS_PATH = path.join(os.tmpdir(), `botmancers-registration-grants-${process.pid}.json`);
const WORKROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-registration-ws-'));
const WS_APP = path.join(WORKROOT, 'botmancers', 'app');
const WS_OTHER = path.join(WORKROOT, 'other');
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

// Any fetch during a direct path is a failure of "direct launch must not
// contact anything but the Hermes gateway" (the Hermes greeting turn).
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
    session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'botmancers'), WS_OTHER] },
    default_workspace: WS_APP,
    policy: READ_ONLY,
  });
  check('Codex Agent registers on its runtime connection', direct.status === 200 && direct.json.agent === 'codex'
    && direct.json.runtime_connection_id === codexConn && direct.json.launchable === true && direct.json.launch_blocker === null, JSON.stringify(direct.json));
  check('agent follows the connection provider', direct.json.agent === 'codex' && direct.json.runtime_connection.label === 'Codex on Yusuke’s Mac');
  check('scope, default workspace, policy read back', JSON.stringify(direct.json.session_scope) === JSON.stringify({ kind: 'workspaces', workspaces: [path.join(WORKROOT, 'botmancers'), WS_OTHER], sessions: [] })
    && direct.json.default_workspace === WS_APP
    && JSON.stringify(direct.json.policy) === JSON.stringify(READ_ONLY), JSON.stringify(direct.json));
  check('read shape has no launch profile, deck, or raw storage columns',
    !('launch_profile' in direct.json) && !('deck_id' in direct.json) && !('deck_name' in direct.json) && !('working_directory' in direct.json)
    && !('needs_deck_selection' in direct.json) && !('session_scope_items' in direct.json) && !('policy_mode' in direct.json));
  check('stored row keeps the cleared direct launch values', rowOf(direct.json.id).launch_profile === 'direct'
    && rowOf(direct.json.id).deck_id === null && rowOf(direct.json.id).working_directory === null);

  const second = await call('POST', {
    name: 'Second Codex',
    runtime_connection_id: codexConn,
    session_scope: { kind: 'all_provider_sessions' },
    policy: WRITE,
  });
  check('second Agent registers on the same connection', second.status === 200 && second.json.launchable === true, JSON.stringify(second.json));
  check('two Agents share one runtime connection', second.json.runtime_connection_id === direct.json.runtime_connection_id);
  const listed = await (await connectionsRoute.GET()).json();
  check('the shared connection counts both Agents', listed.connections.find(c => c.id === codexConn).agent_count === 2, JSON.stringify(listed));
  check('Agent identity stays on the bots row only (connections hold no Agent fields)',
    JSON.stringify(raw.prepare('PRAGMA table_info(runtime_connections)').all().map(c => c.name)) === JSON.stringify(['id', 'provider', 'label', 'host', 'created_at']));

  const hermesDirect = await call('POST', {
    name: 'Direct Hermes',
    runtime_connection_id: reg.localConnectionId('hermes'),
    session_scope: { kind: 'workspaces', workspaces: ['~/notes'] },
    policy: READ_ONLY,
  });
  check('Hermes keeps working: a Hermes Agent is launchable', hermesDirect.status === 200 && hermesDirect.json.launchable === true, JSON.stringify(hermesDirect.json));

  // Reload: a fresh read of the stored rows.
  const reloaded = await (await botsRoute.GET()).json();
  const reDirect = reloaded.find(b => b.id === direct.json.id);
  const reSecond = reloaded.find(b => b.id === second.json.id);
  check('reload: Agent keeps connection, scope, default workspace, policy', reDirect.runtime_connection_id === codexConn
    && reDirect.default_workspace === WS_APP && reDirect.policy.mode === 'read_only' && reDirect.launchable === true);
  check('reload: all-sessions scope reads back', reSecond.session_scope.kind === 'all_provider_sessions' && reSecond.policy.mode === 'workspace_write');

  // Edit.
  const edited = await call('PATCH', { id: direct.json.id, policy: { mode: 'workspace_write', allow_new_sessions: false, allow_resume_with_edits: true }, default_workspace: '' });
  check('edit: policy and default workspace update in place', edited.status === 200 && edited.json.policy.mode === 'workspace_write' && edited.json.policy.allow_new_sessions === false && edited.json.default_workspace === null, JSON.stringify(edited.json));
  const claudeConn = (await connection({ provider: 'claude', label: 'Claude on the studio Mac', host: 'Studio' })).json.id;
  const moved = await call('PATCH', { id: direct.json.id, runtime_connection_id: claudeConn });
  check('edit: moving to another connection changes the agent with it, keeping the Agent ID', moved.status === 200 && moved.json.agent === 'claude' && moved.json.id === direct.json.id && rowOf(direct.json.id).agent === 'claude');
  await call('PATCH', { id: direct.json.id, runtime_connection_id: codexConn });

  // Home session: must belong to this Agent.
  const conv = db.conversations.getByBotId(direct.json.id);
  const otherConv = db.conversations.getByBotId(second.json.id);
  const mine = db.engine.bindSession({ agentId: direct.json.id, adapter: 'codex', externalSessionId: 'prov-sess-SECRET-mine', conversationId: conv.id, now: Date.now() });
  const theirs = db.engine.bindSession({ agentId: second.json.id, adapter: 'codex', externalSessionId: 'prov-sess-SECRET-theirs', conversationId: otherConv.id, now: Date.now() });
  const beforeForeign = JSON.stringify(rowOf(direct.json.id));
  const foreign = await call('PATCH', { id: direct.json.id, home_session_id: theirs.id, policy: READ_ONLY });
  check('home session of another Agent is rejected with nothing written', foreign.status === 400 && foreign.json.error === reg.HOME_SESSION_FOREIGN_ERROR && JSON.stringify(rowOf(direct.json.id)) === beforeForeign, JSON.stringify(foreign.json));
  const unknown = await call('PATCH', { id: direct.json.id, home_session_id: 'no-such-session' });
  check('unknown home session is rejected', unknown.status === 400 && unknown.json.error === reg.HOME_SESSION_FOREIGN_ERROR);
  const home = await call('PATCH', { id: direct.json.id, home_session_id: mine.id });
  check('own home session is stored and read back by its Botmancers ref', home.status === 200 && home.json.home_session_id === mine.id, JSON.stringify(home.json));
  check('no provider session id appears in the Agent read shape', !JSON.stringify(home.json).includes('SECRET'));
  const homeOnCreate = await call('POST', { name: 'Home on create', runtime_connection_id: codexConn, session_scope: { kind: 'all_provider_sessions' }, policy: READ_ONLY, home_session_id: mine.id });
  check('a new Agent cannot claim an existing Agent’s session as home', homeOnCreate.status === 400 && homeOnCreate.json.error === reg.HOME_SESSION_FOREIGN_ERROR);
  const sessionScope = await call('PATCH', { id: direct.json.id, session_scope: { kind: 'sessions', sessions: [mine.id] } });
  check('session scope of the Agent’s own sessions saves', sessionScope.status === 200 && sessionScope.json.session_scope.kind === 'sessions', JSON.stringify(sessionScope.json));
  const foreignScope = await call('PATCH', { id: direct.json.id, session_scope: { kind: 'sessions', sessions: [mine.id, theirs.id] } });
  check('session scope naming another Agent’s session is rejected', foreignScope.status === 400 && foreignScope.json.error === reg.SCOPE_SESSION_FOREIGN_ERROR);
  const homeOutside = await call('PATCH', { id: second.json.id, session_scope: { kind: 'sessions', sessions: [theirs.id] }, home_session_id: theirs.id });
  check('own session scope + home session saves', homeOutside.status === 200 && homeOutside.json.home_session_id === theirs.id);
  await call('PATCH', { id: direct.json.id, session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'botmancers')] }, home_session_id: '' });

  // ---- (2) API validation matrix ----------------------------------------
  console.log('\n(2) Create/edit validation matrix (fail closed, no partial writes)');
  const base = { runtime_connection_id: codexConn, session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'w')] }, policy: READ_ONLY };
  const allowed = [
    ['workspaces scope', { ...base }],
    ['all sessions scope', { ...base, session_scope: { kind: 'all_provider_sessions' } }],
    ['default workspace inside scope', { ...base, default_workspace: path.join(WORKROOT, 'w', 'app') }],
    ['default workspace with all sessions', { ...base, session_scope: { kind: 'all_provider_sessions' }, default_workspace: '~/code' }],
    ['workspace_write + resume edits', { ...base, policy: WRITE }],
    ['agent matching the connection', { ...base, agent: 'codex' }],
  ];
  let n = 0;
  for (const [label, body] of allowed) {
    const res = await call('POST', { name: `Allowed ${++n}`, ...body });
    check(`allowed: ${label}`, res.status === 200, JSON.stringify(res.json));
  }

  const rejected = [
    ['missing connection', { ...base, runtime_connection_id: undefined }, reg.CONNECTION_REQUIRED_ERROR],
    ['unknown connection', { ...base, runtime_connection_id: 'rc-nope' }, reg.CONNECTION_NOT_FOUND_ERROR],
    ['agent contradicts connection', { ...base, agent: 'hermes' }, reg.CONNECTION_PROVIDER_MISMATCH_ERROR],
    ['launch_profile is removed', { ...base, launch_profile: 'direct' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    ['agent_deck profile is removed', { ...base, launch_profile: 'agent_deck' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    ['deck_id is removed', { ...base, deck_id: 'deck-1' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    ['deck_name is removed', { ...base, deck_name: 'Deck 1' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    ['working_directory is removed', { ...base, working_directory: path.join(WORKROOT, 'w') }, def.REMOVED_LAUNCH_FIELD_ERROR],
    ['missing scope', { ...base, session_scope: undefined }, reg.SCOPE_REQUIRED_ERROR],
    ['scope without kind', { ...base, session_scope: { workspaces: [path.join(WORKROOT, 'w')] } }, reg.SCOPE_REQUIRED_ERROR],
    ['unknown scope kind', { ...base, session_scope: { kind: 'everything' } }, reg.SCOPE_INVALID_ERROR],
    ['empty workspace scope', { ...base, session_scope: { kind: 'workspaces', workspaces: [] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    ['blank-only workspace scope', { ...base, session_scope: { kind: 'workspaces', workspaces: ['  '] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    ['empty session scope', { ...base, session_scope: { kind: 'sessions', sessions: [] } }, reg.SCOPE_EMPTY_SESSIONS_ERROR],
    ['session scope on a new Agent', { ...base, session_scope: { kind: 'sessions', sessions: [mine.id] } }, reg.SCOPE_SESSION_FOREIGN_ERROR],
    ['all sessions with a list', { ...base, session_scope: { kind: 'all_provider_sessions', workspaces: [path.join(WORKROOT, 'w')] } }, reg.SCOPE_ALL_WITH_LIST_ERROR],
    ['mixed workspaces and sessions', { ...base, session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'w')], sessions: ['s'] } }, reg.SCOPE_MIXED_ERROR],
    ['relative workspace', { ...base, session_scope: { kind: 'workspaces', workspaces: ['work'] } }, reg.WORKSPACE_PATH_ERROR],
    ['relative default workspace', { ...base, default_workspace: 'work' }, reg.WORKSPACE_PATH_ERROR],
    ['default workspace outside scope', { ...base, default_workspace: '/elsewhere' }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    ['default workspace sharing only a prefix', { ...base, default_workspace: `${path.join(WORKROOT, 'w')}2` }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    ['missing policy', { ...base, policy: undefined }, reg.POLICY_REQUIRED_ERROR],
    ['policy without mode', { ...base, policy: { allow_new_sessions: true } }, reg.POLICY_REQUIRED_ERROR],
    ['unknown policy mode', { ...base, policy: { mode: 'admin' } }, reg.POLICY_MODE_ERROR],
    ['non-boolean policy flag', { ...base, policy: { mode: 'read_only', allow_new_sessions: 'yes' } }, reg.POLICY_FLAG_ERROR],
    ['resume with edits under read_only', { ...base, policy: { mode: 'read_only', allow_resume_with_edits: true } }, reg.POLICY_RESUME_EDITS_ERROR],
    ['legacy runtime field', { ...base, runtime: 'agent-deck' }, def.LEGACY_RUNTIME_FIELD_ERROR],
    ['legacy agent_client field', { ...base, agent_client: 'codex' }, def.LEGACY_RUNTIME_FIELD_ERROR],
    ['nothing but a name', {}, reg.CONNECTION_REQUIRED_ERROR],
  ];
  for (const [label, body, expected] of rejected) {
    const before = botCount();
    const connectionsBefore = raw.prepare('SELECT COUNT(*) AS n FROM runtime_connections').get().n;
    const res = await call('POST', { name: `Rejected ${label}`, ...body });
    const matches = res.json.errors && res.json.errors.some(error => (expected instanceof RegExp ? expected.test(error) : error === expected));
    check(`rejected create: ${label}`, res.status === 400 && matches && botCount() === before
      && raw.prepare('SELECT COUNT(*) AS n FROM runtime_connections').get().n === connectionsBefore, JSON.stringify(res.json));
  }

  // Edit matrix against two stored Agents.
  const firstRow = (await call('POST', { name: 'Edit target one', ...base, default_workspace: path.join(WORKROOT, 'w') })).json;
  const secondRow = (await call('POST', { name: 'Edit target two', ...base })).json;
  const editRejected = [
    [firstRow, 'launch_profile on edit', { launch_profile: 'direct' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    [firstRow, 'deck_id on edit', { deck_id: 'deck-x' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    [firstRow, 'deck_name on edit', { deck_name: 'Deck X' }, def.REMOVED_LAUNCH_FIELD_ERROR],
    [firstRow, 'working_directory on edit', { working_directory: path.join(WORKROOT, 'w') }, def.REMOVED_LAUNCH_FIELD_ERROR],
    [firstRow, 'legacy runtime on edit', { runtime: 'hermes' }, def.LEGACY_RUNTIME_FIELD_ERROR],
    [secondRow, 'empty scope', { session_scope: { kind: 'workspaces', workspaces: [] } }, reg.SCOPE_EMPTY_WORKSPACES_ERROR],
    [secondRow, 'null scope', { session_scope: null }, reg.SCOPE_REQUIRED_ERROR],
    [secondRow, 'scope that strands the default workspace', { default_workspace: path.join(WORKROOT, 'w', 'app'), session_scope: { kind: 'workspaces', workspaces: [path.join(WORKROOT, 'other')] } }, reg.DEFAULT_WORKSPACE_OUTSIDE_ERROR],
    [secondRow, 'resume edits under read_only', { policy: { mode: 'read_only', allow_resume_with_edits: true } }, reg.POLICY_RESUME_EDITS_ERROR],
    [secondRow, 'unknown connection', { runtime_connection_id: 'rc-missing' }, reg.CONNECTION_NOT_FOUND_ERROR],
    // A valid field next to an invalid one: the valid one is not written.
    [secondRow, 'valid name + invalid policy', { name: 'Renamed?', policy: { mode: 'nope' } }, reg.POLICY_MODE_ERROR],
  ];
  for (const [target, label, patch, expected] of editRejected) {
    const before = JSON.stringify(rowOf(target.id));
    const res = await call('PATCH', { id: target.id, ...patch });
    const ok = res.status === 400 && res.json.errors && res.json.errors.includes(expected) && JSON.stringify(rowOf(target.id)) === before;
    check(`rejected edit: ${label} (row unchanged)`, ok, JSON.stringify(res.json));
  }
  const editAllowed = [
    [firstRow, 'rename', { name: 'Edit target one renamed' }, json => json.name === 'Edit target one renamed'],
    [firstRow, 'clear default workspace', { default_workspace: '' }, json => json.default_workspace === null],
    [firstRow, 'all sessions scope', { session_scope: { kind: 'all_provider_sessions' } }, json => json.session_scope.kind === 'all_provider_sessions'],
    [firstRow, 'move connection (agent follows)', { runtime_connection_id: claudeConn }, json => json.agent === 'claude' && json.runtime_connection_id === claudeConn],
    [secondRow, 'agent alone moves to that provider', { agent: 'muse' }, json => json.agent === 'muse' && json.runtime_connection_id === reg.localConnectionId('muse')],
    [secondRow, 'set a default workspace', { default_workspace: path.join(WORKROOT, 'w', 'app') }, json => json.default_workspace === path.join(WORKROOT, 'w', 'app')],
  ];
  for (const [target, label, patch, expectFn] of editAllowed) {
    const res = await call('PATCH', { id: target.id, ...patch });
    check(`allowed edit: ${label}`, res.status === 200 && expectFn(res.json), JSON.stringify(res.json));
  }

  // ---- (3) direct-only dispatch -------------------------------------------
  console.log('\n(3) Direct-only dispatch, no removed transport');
  await call('PATCH', { id: direct.json.id, session_scope: { kind: 'all_provider_sessions' }, home_session_id: '' });
  const seen = [];
  dispatch.setAttemptAdapterOverride(transport => {
    seen.push(transport);
    return { name: transport, run: async () => { throw new Error('must not launch in this test'); } };
  });
  try {
    for (const provider of ['codex', 'claude', 'cursor', 'muse']) {
      const createdAgent = await call('POST', {
        name: `Dispatch ${provider}`,
        runtime_connection_id: reg.localConnectionId(provider),
        session_scope: { kind: 'workspaces', workspaces: [WORKROOT] },
        default_workspace: WORKROOT,
        policy: READ_ONLY,
      });
      const prepared = dispatch.prepareDispatch({ bot: db.bots.getById(createdAgent.json.id), history: [] });
      check(`${provider} turn selects the session-provider adapter with a workspace`,
        prepared.adapter.name === 'session-provider' && prepared.input.cwd === WORKROOT && prepared.input.target.agent === provider);
    }
    const hermesPrepared = dispatch.prepareDispatch({ bot: db.bots.getById(hermesDirect.json.id), history: [] });
    check('Hermes dispatch prepares on the gateway', hermesPrepared.adapter.name === 'hermes-gateway' && hermesPrepared.input.cwd === null);
    check('every coding selection was session-provider, Hermes hermes-gateway',
      JSON.stringify(seen) === JSON.stringify(['session-provider', 'session-provider', 'session-provider', 'session-provider', 'hermes-gateway']));
  } finally {
    dispatch.setAttemptAdapterOverride(null);
  }
  check('removed transports have no adapter', dispatch.adapterForTransport('agent-deck-run') === null && dispatch.adapterForTransport('agent-deck-api') === null);
  check('restart lookup resolves the live transports',
    dispatch.adapterForTransport('session-provider')?.name === 'session-provider' && dispatch.adapterForTransport('hermes-gateway')?.name === 'hermes-gateway');

  // Fail closed without a connection or scope.
  const brokenConn = db.bots.create({ name: 'BrokenConn', title: '', description: '', agent: 'codex' });
  raw.prepare('UPDATE bots SET runtime_connection_id = NULL WHERE id = ?').run(brokenConn.id);
  let connFailure = null;
  try {
    dispatch.prepareDispatch({ bot: db.bots.getById(brokenConn.id), history: [] });
  } catch (error) { connFailure = error; }
  check('no runtime connection fails closed with a direct-runtime reason',
    connFailure && connFailure.code === 'agent_unavailable' && connFailure.message === dispatch.CONNECTION_NOT_CHOSEN, String(connFailure && connFailure.message));
  check('thread notice names the missing connection, never a deck',
    agentLoop.launchBlockedMessage(db.bots.getById(brokenConn.id)) === `[Agent unavailable] BrokenConn cannot launch: no runtime connection. Choose one in Config.`);
  const brokenScope = db.bots.create({ name: 'BrokenScope', title: '', description: '', agent: 'codex' });
  raw.prepare('UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?').run(brokenScope.id);
  let scopeFailure = null;
  try {
    dispatch.prepareDispatch({ bot: db.bots.getById(brokenScope.id), history: [] });
  } catch (error) { scopeFailure = error; }
  check('no session scope fails closed with a direct-runtime reason',
    scopeFailure && scopeFailure.code === 'agent_unavailable' && scopeFailure.message === dispatch.SESSION_SCOPE_MISSING, String(scopeFailure && scopeFailure.message));
  const brokenView = db.serializeAgent(db.bots.getById(brokenScope.id));
  check('unconfigured row reads back launchable=false with its blocker', brokenView.launchable === false && brokenView.launch_blocker === 'session_scope'
    && brokenView.session_scope === null && !('launch_profile' in brokenView));
  // The Hermes Agent's pre-existing greeting turn may reach the
  // (unreachable) Hermes gateway; nothing may reach anything else.
  const nonGateway = fetched.filter(url => !url.startsWith(process.env.HERMES_BASE_URL));
  check('no network call on any direct path', nonGateway.length === 0, nonGateway.join(','));

  // ---- (4) migration --------------------------------------------------------
  console.log('\n(4) Pre-NOT-543 database migration (before/after fixture)');
  fs.writeFileSync(GRANTS_PATH, '{"version":1,"services":{}}\n');
  const childEnv = { ...process.env, BOTMANCERS_DB_PATH: MIGRATION_DB_PATH, BOTMANCERS_SERVICE_GRANTS_PATH: GRANTS_PATH };
  // Seed with the current code (conversations, work requests, attempts,
  // session bindings, snapshots, wake grants), then backdate the removed
  // launch columns to the values the old code wrote, reproducing the
  // pre-NOT-543 rows exactly.
  execFileSync(process.execPath, ['-e', `
    process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
    const { createJiti } = require('jiti');
    const jiti = createJiti(${JSON.stringify(path.join(ROOT, 'seed.js'))}, { alias: { '@': ${JSON.stringify(ROOT)} } });
    const db = jiti('./lib/db.ts');
    const { seedSessionCatalog } = require('./test-support/session-catalog-fixture.js');
    seedSessionCatalog(db);
    const raw = db.default;
    const t = Date.now();
    const decked = db.bots.create({ name: 'Decked', title: '', description: 'Agent Deck coding Agent.', agent: 'codex' });
    const pending = db.bots.create({ name: 'Pending', title: '', description: 'Needed reselection.', agent: 'claude' });
    const plain = db.bots.create({ name: 'Plain Hermes', title: '', description: 'No deck.', agent: 'hermes' });
    const invalid = db.bots.create({ name: 'Invalid', title: '', description: 'No usable scope.', agent: 'codex' });
    const conv = db.conversations.getByBotId(decked.id);
    const binding = db.engine.bindSession({ agentId: decked.id, adapter: 'codex', externalSessionId: 'prov-decked-SECRET', conversationId: conv.id, now: t });
    db.bots.updateRegistration(decked.id, 'codex', {
      runtime_connection_id: decked.runtime_connection_id,
      session_scope: { kind: 'workspaces', workspaces: ['/Users/owner/work/botmancers'], sessions: [] },
      default_workspace: '/Users/owner/work/botmancers/app',
      policy: { mode: 'workspace_write', allow_new_sessions: true, allow_resume_with_edits: true },
      home_session_id: binding.id,
    });
    for (const conv of raw.prepare('SELECT id FROM conversations').all()) db.messages.create(conv.id, 'user', 'hello ' + conv.id);
    const ids = raw.prepare('SELECT id FROM bots ORDER BY created_at').all().map(r => r.id);
    raw.prepare("INSERT INTO wake_grants (id, caller_agent_id, target_agent_id, authority, granted_by_kind, granted_by_id, created_at) VALUES ('wg-1', ?, ?, 'edit', 'person', 'local-owner', ?)").run(ids[1], ids[0], t);
    for (const id of ids) {
      raw.prepare('INSERT INTO launch_snapshots (id, bot_id, created_at, hash, snapshot, transport) VALUES (?, ?, ?, ?, ?, ?)').run('snap-' + id, id, t, 'e'.repeat(64), JSON.stringify({ deck_id: 'x' }), 'agent-deck');
    }
    // Backdate to the pre-NOT-543 launch values.
    raw.prepare("UPDATE bots SET launch_profile = 'agent_deck', deck_id = 'deck-stale', working_directory = '/tmp/decked' WHERE id = ?").run(decked.id);
    raw.prepare("UPDATE bots SET launch_profile = 'agent_deck', deck_id = NULL, working_directory = '/tmp/pending', needs_deck_selection = 1 WHERE id = ?").run(pending.id);
    raw.prepare("UPDATE bots SET session_scope_kind = NULL, session_scope_items = NULL WHERE id = ?").run(invalid.id);
    raw.pragma('wal_checkpoint(TRUNCATE)');
  `], { cwd: ROOT, env: childEnv });
  const Database = require('better-sqlite3');
  const tablesOf = conn => conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('bots', 'runtime_connections') ORDER BY name").all().map(r => r.name);
  const dumpOf = conn => Object.fromEntries(tablesOf(conn).map(name => [name, conn.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const REGISTRATION_COLUMNS = 'runtime_connection_id, session_scope_kind, session_scope_items, default_workspace, policy_mode, allow_new_sessions, allow_resume_with_edits, home_session_id';
  const pre = new Database(MIGRATION_DB_PATH);
  check('fixture carries pre-NOT-543 agent_deck rows',
    pre.prepare("SELECT COUNT(*) AS n FROM bots WHERE launch_profile = 'agent_deck'").get().n === 2
    && pre.prepare("SELECT COUNT(*) AS n FROM bots WHERE deck_id IS NOT NULL OR working_directory IS NOT NULL OR needs_deck_selection <> 0").get().n === 2);
  const beforeDump = JSON.stringify(dumpOf(pre));
  const beforeReg = pre.prepare(`SELECT id, agent, ${REGISTRATION_COLUMNS} FROM bots ORDER BY id`).all();
  const beforeIds = pre.prepare('SELECT id, name, agent FROM bots ORDER BY id').all();
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
  for (const row of beforeReg) {
    const got = after.find(r => r.id === row.id);
    console.log(`  ${row.id.slice(0, 8)}: agent=${row.agent} -> profile=${got.launch_profile} deck=${got.deck_id} wd=${got.working_directory} needs=${got.needs_deck_selection}`);
    check(`${row.id.slice(0, 8)}: direct, deck configuration cleared`, got.launch_profile === 'direct'
      && got.deck_id === null && got.working_directory === null && got.needs_deck_selection === 0);
    check(`${row.id.slice(0, 8)}: Agent ID, connection, scope, policy, home/default kept`,
      got.agent === row.agent && got.runtime_connection_id === row.runtime_connection_id
      && got.session_scope_kind === row.session_scope_kind && got.session_scope_items === row.session_scope_items
      && got.default_workspace === row.default_workspace && got.policy_mode === row.policy_mode
      && got.allow_new_sessions === row.allow_new_sessions && got.allow_resume_with_edits === row.allow_resume_with_edits
      && got.home_session_id === row.home_session_id);
  }
  check('Agent identity preserved verbatim', JSON.stringify(post.prepare('SELECT id, name, agent FROM bots ORDER BY id').all()) === JSON.stringify(beforeIds));
  const deckedAfter = after.find(r => r.id === beforeIds.find(b => b.name === 'Decked').id);
  check('valid agent_deck row keeps its home session and default workspace',
    deckedAfter.home_session_id !== null && deckedAfter.default_workspace === '/Users/owner/work/botmancers/app'
    && deckedAfter.policy_mode === 'workspace_write');
  const invalidAfter = after.find(r => r.id === beforeIds.find(b => b.name === 'Invalid').id);
  check('invalid row stays unlaunchable and never regains a deck', invalidAfter.session_scope_kind === null
    && invalidAfter.launch_profile === 'direct' && invalidAfter.deck_id === null);
  const invalidView = def.serializeBot(invalidAfter);
  check('invalid row reads launchable=false with its blocker', invalidView.launchable === false && invalidView.launch_blocker === 'session_scope');
  check('every non-bots table (conversations, messages, work requests, attempts, session bindings, grants, snapshots, events) preserved byte-for-byte', JSON.stringify(dumpOf(post)) === beforeDump);
  check('service-grant file untouched', fs.readFileSync(GRANTS_PATH, 'utf8') === grantsBefore);
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
  fs.rmSync(WORKROOT, { recursive: true, force: true });
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
