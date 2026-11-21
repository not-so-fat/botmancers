#!/usr/bin/env node
// NOT-507: registered-Agent messaging and exact-session pins
// (lib/session-pins, lib/session-actions, lib/service-api, lib/mcp-bridge-v2).
// Proves: the registered-Agent resolution matrix (home, archived-resumable,
// busy, missing, no workspace, forbidden new session, started under
// policy); an exact-session pin holds every
// follow-up on the same ref, never retargets after a provider failure or a
// busy session, survives a Botmancers restart (a real second process on the
// same database), and stops only on an explicit detach or switch; turn and
// pin idempotency with row and event counts; Resume work here needs the
// runtime's authority, the Agent's policy, and explicit approval (NOT-556:
// no grant); the audit covers the resolved Agent, session, capability, and
// final action for allowed, rejected, and denied (unknown target or another
// service's pin) calls, with no provider id anywhere; and the MCP tools return
// the same contract with a structured recovery hint.
// Self-contained: isolated SQLite and state files, no network, no socket.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = require('./support/repo-root');
const RESTART = process.argv[2] === 'restart';
const TAG = process.env.NOT507_TAG || `${process.pid}`;
const TMP = path.join(os.tmpdir(), `botmancers-session-pins-${TAG}`);
const DB_PATH = path.join(TMP, 'botmancers.db');
const STATE = path.join(TMP, 'provider.json');
const IDS_PATH = path.join(TMP, 'ids.json');
if (!RESTART) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SERVICE_TOKENS = `grok-bot=sha256:${'a'.repeat(64)},other-bot=sha256:${'b'.repeat(64)}`;
for (const name of Object.keys(process.env)) if (/^AGENT_DECK/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('network disabled in this test'); };

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const dbModule = jiti('../lib/db.ts');
const contract = jiti('../lib/session-provider.ts');
const ps = jiti('../lib/provider-sessions.ts');
const pins = jiti('../lib/session-pins.ts');
const actions = jiti('../lib/session-actions.ts');
const { serviceOperations, resetServiceApiRateLimits } = jiti('../lib/service-api-http.ts');
const mcp = jiti('../lib/mcp-bridge-v2.ts');
const fake = require('./support/fake-session-provider');

const db = dbModule.default;
let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures++; console.log(`  FAIL: ${label}`); }
  return condition;
}
async function rejects(promise, code, label) {
  try {
    await promise;
    return assert(false, `${label} (did not throw)`);
  } catch (error) {
    return assert(error && error.code === code, `${label} (got: ${error && (error.code || error.message)})`);
  }
}
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const SECRET = /SECRET/;
const grok = { kind: 'service', id: 'grok-bot' };
const other = { kind: 'service', id: 'other-bot' };
const sendsTo = id => fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn' && call.session === id).length;
const sends = () => fake.providerCalls(STATE, 'sendTurn');

function agent(name, connectionId, policy, extra = {}) {
  const bot = dbModule.bots.create({
    name, title: 'Native', description: 'Native sessions', agent: 'codex', runtime_connection_id: connectionId, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]',
    policy_mode: policy.mode, allow_new_sessions: policy.newSessions ? 1 : 0, allow_resume_with_edits: policy.resumeEdits ? 1 : 0,
  });
  if (extra.defaultWorkspace) db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run(extra.defaultWorkspace, bot.id);
  return bot;
}

function nativeRef(agentId, providerId) {
  return db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(agentId, providerId).id;
}

async function syncAll(agentId) {
  let cursor = null;
  do {
    cursor = (await ps.syncAgentSessions(db, agentId, { cursor })).next_cursor;
  } while (cursor);
}

function registerFake(connectionId) {
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
}

if (RESTART) restart().catch(fatal);
else main().catch(fatal);

function fatal(error) {
  console.error(error);
  process.exit(1);
}

async function main() {
  console.log('\nSession actions: labels and availability');
  assert(JSON.stringify(Object.values(actions.SESSION_ACTION_LABELS)) === JSON.stringify(['Ask from this context', 'Resume work here', 'Hand off to…']),
    'the three actions are Ask from this context, Resume work here, Hand off to…');
  const row = (state, extra = {}) => ({ source: 'native', status: 'active', resumable: true, agent: { name: 'Dev' },
    state: { availability: 'available', lifecycle: 'open', resumable: true, busy: false, ...state }, ...extra });
  const writeCtx = { route: 'provider', provider: { resume: true, authorities: ['read_only', 'workspace_write'] }, policy: { mode: 'workspace_write', allow_resume_with_edits: true } };
  const open = actions.sessionActions(row({}), writeCtx);
  assert(open.ask.available && open.resume.available && !open.handoff.available && open.handoff.code === 'action_unavailable',
    'open native session: ask and resume available; hand off needs a Botmancers-launched session');
  const archived = actions.sessionActions(row({ lifecycle: 'archived' }), writeCtx);
  assert(archived.ask.available && archived.resume.available, 'archived but resumable: ask and resume available');
  const busy = actions.sessionActions(row({ busy: true }), writeCtx);
  assert(!busy.ask.available && busy.ask.code === 'source_session_busy' && busy.ask.recovery === 'retry_later' && /Try again/.test(busy.ask.reason),
    'busy: unavailable with retry_later and recovery text');
  const missing = actions.sessionActions(row({ availability: 'missing' }), writeCtx);
  assert(!missing.ask.available && missing.ask.code === 'session_missing' && missing.ask.recovery === 'choose_session', 'missing: choose another session');
  const notResumable = actions.sessionActions(row({ resumable: false }), writeCtx);
  assert(notResumable.ask.code === 'session_not_resumable' && notResumable.resume.code === 'session_not_resumable', 'not resumable: every action refused');
  const readOnly = actions.sessionActions(row({}), { ...writeCtx, policy: { mode: 'read_only', allow_resume_with_edits: false } });
  assert(readOnly.ask.available && readOnly.resume.code === 'authority_not_allowed' && readOnly.resume.recovery === 'ask_owner', 'read-only policy: resume asks the owner');
  const noWrite = actions.sessionActions(row({}), { ...writeCtx, provider: { resume: true, authorities: ['read_only'] } });
  assert(noWrite.resume.code === 'action_unavailable', 'a runtime that cannot enforce workspace write: resume unavailable');
  const bound = actions.sessionActions({ ...row({ resumable: null }), source: 'botmancers' }, { route: 'engine', provider: null, policy: null });
  assert(bound.ask.available && bound.handoff.available && bound.resume.code === 'action_unavailable', 'Botmancers binding: ask and hand off; no resume with edits');
  const ended = actions.sessionActions({ ...row({ resumable: null }), source: 'botmancers', status: 'ended', resumable: false }, { route: 'engine', provider: null, policy: null });
  assert(!ended.ask.available && ended.ask.code === 'session_ended' && ended.handoff.code === 'session_ended', 'ended binding: nothing available');

  console.log('\nSetup: one runtime connection, a fake provider, five Agents');
  const { runtimeConnections } = dbModule;
  const connectionId = runtimeConnections.create({ provider: 'codex', label: 'Codex laptop', host: 'This computer' }).id;
  registerFake(connectionId);
  fake.seedFakeProvider(STATE, [
    { id: 'home-1-SECRET', title: 'Home session', workspace: '/work/a' },
    { id: 'old-1-SECRET', title: 'Archived spike', workspace: '/work/a', lifecycle: 'archived', resumable: true },
    { id: 'busy-1-SECRET', title: 'Busy work', workspace: '/work/a', busy: true },
    { id: 'gone-1-SECRET', title: 'Gone soon', workspace: '/work/a' },
    { id: 'pin-1-SECRET', title: 'Fix the uploader retry', workspace: '/work/a' },
    { id: 'pin-2-SECRET', title: 'Write release notes', workspace: '/work/a' },
  ]);
  const write = { mode: 'workspace_write', newSessions: true, resumeEdits: true };
  const homeAgent = agent('Home', connectionId, write);
  const writer = agent('Writer', connectionId, write, { defaultWorkspace: '/work/a' });
  const reader = agent('Reader', connectionId, { mode: 'read_only', newSessions: false });
  const nowhere = agent('Nowhere', connectionId, { mode: 'read_only', newSessions: true });
  const outsider = agent('Outsider', connectionId, { mode: 'read_only', newSessions: false });
  for (const bot of [homeAgent, writer, reader, outsider]) await syncAll(bot.id);
  // Each Agent keeps only the sessions its case needs.
  const keep = (bot, ids) => db.prepare(`DELETE FROM provider_sessions WHERE agent_id = ? AND provider_session_id NOT IN (${ids.map(() => '?').join(',')})`).run(bot.id, ...ids);
  keep(homeAgent, ['home-1-SECRET', 'old-1-SECRET']);
  keep(writer, ['pin-1-SECRET', 'pin-2-SECRET']);
  keep(reader, ['busy-1-SECRET']);
  keep(outsider, ['gone-1-SECRET']);
  const homeRef = nativeRef(homeAgent.id, 'home-1-SECRET');
  const oldRef = nativeRef(homeAgent.id, 'old-1-SECRET');
  db.prepare('UPDATE bots SET home_session_id = ? WHERE id = ?').run(homeRef, homeAgent.id);
  const pin1 = nativeRef(writer.id, 'pin-1-SECRET');
  const pin2 = nativeRef(writer.id, 'pin-2-SECRET');
  assert(true, `Agents Home, Writer, Reader, Nowhere, Outsider on ${connectionId.slice(0, 4)}…`);

  console.log('\nResolution matrix: registered-Agent messaging');
  const home = await pins.messageAgent({ requester: grok, agentId: homeAgent.id, content: 'Status?', idempotencyKey: 'home-1', mayStart: false });
  await home.settled;
  assert(home.resolution === 'home' && home.pin.session_ref === homeRef && home.pin.action === 'ask' && home.pin.authority === 'read_only',
    'home: the configured home session, as a read-only Ask pin');
  // The home session goes missing: the newest eligible scoped session (the archived, resumable one) is next.
  fake.mutateFakeProvider(STATE, state => { state.sessions['home-1-SECRET'].deleted = true; });
  const archivedPick = await pins.messageAgent({ requester: grok, agentId: homeAgent.id, content: 'Again?', idempotencyKey: 'home-2', mayStart: false });
  await archivedPick.settled;
  assert(archivedPick.resolution === 'newest' && archivedPick.pin.session_ref === oldRef, 'archived-resumable: a missing home session falls to the newest eligible scoped session');
  assert(db.prepare('SELECT availability FROM provider_sessions WHERE id = ?').get(homeRef).availability === 'missing', 'missing: the home session is recorded missing, not deleted');
  const turnsBefore = count('SELECT COUNT(*) AS n FROM session_pin_turns');
  await rejects(pins.messageAgent({ requester: grok, agentId: reader.id, content: 'x', idempotencyKey: 'busy-1', mayStart: true }),
    'source_session_busy', 'busy: the only eligible session is busy -> source_session_busy (never a new session)');
  fake.mutateFakeProvider(STATE, state => { state.sessions['gone-1-SECRET'].deleted = true; });
  await rejects(pins.messageAgent({ requester: other, agentId: outsider.id, content: 'x', idempotencyKey: 'gone-1', mayStart: true }),
    'no_eligible_session', 'missing + forbidden new session: no_eligible_session');
  await rejects(pins.messageAgent({ requester: grok, agentId: nowhere.id, content: 'x', idempotencyKey: 'nowhere-1', mayStart: true }),
    'workspace_required', 'no session and no default workspace: workspace_required (a missing workspace is never unrestricted)');
  const startsBefore = fake.providerCalls(STATE, 'startSession');
  // Writer's sessions are all busy for a moment: it would start a new one.
  fake.mutateFakeProvider(STATE, state => { state.sessions['pin-1-SECRET'].busy = true; state.sessions['pin-2-SECRET'].busy = true; });
  await rejects(pins.messageAgent({ requester: grok, agentId: writer.id, content: 'x', idempotencyKey: 'w-busy', mayStart: true }),
    'source_session_busy', 'busy sessions are waited on, never bypassed by starting a new one');
  fake.mutateFakeProvider(STATE, state => { state.sessions['pin-1-SECRET'].deleted = true; state.sessions['pin-2-SECRET'].deleted = true; state.sessions['pin-1-SECRET'].busy = false; state.sessions['pin-2-SECRET'].busy = false; });
  await rejects(pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Start please', idempotencyKey: 'w-start-0', mayStart: false }),
    'no_eligible_session', 'policy and workspace allow a start, but a caller that does not opt in (mayStart: false) never starts one');
  const started = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Start please', idempotencyKey: 'w-start', mayStart: true });
  await started.settled;
  const startCall = fake.loadFakeState(STATE).calls.filter(call => call.op === 'startSession').pop();
  assert(started.resolution === 'started' && started.pin.route === 'provider' && startCall.workspace === '/work/a' && startCall.authority === 'read_only'
    && fake.providerCalls(STATE, 'startSession') === startsBefore + 1, 'started: only under policy, in the default workspace, read-only');
  assert(count('SELECT COUNT(*) AS n FROM session_pin_turns') === turnsBefore + 1, 'refused messages wrote no turn rows');
  fake.mutateFakeProvider(STATE, state => { state.sessions['pin-1-SECRET'].deleted = false; state.sessions['pin-2-SECRET'].deleted = false; });
  await ps.refreshProviderSession(db, writer.id, pin1);
  await ps.refreshProviderSession(db, writer.id, pin2);
  const replay = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Start please', idempotencyKey: 'w-start', mayStart: true });
  assert(replay.replayed && replay.pin.id === started.pin.id && fake.providerCalls(STATE, 'startSession') === startsBefore + 1, 'a replayed message returns the same pin and starts nothing');
  await rejects(pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Different', idempotencyKey: 'w-start', mayStart: true }),
    'idempotency_conflict', 'the same key with different content is idempotency_conflict');

  console.log('\nNOT-619: fresh_session starts a new session even when an eligible one exists');
  // Default behaviour first (before fresh starts add newer sessions): the
  // flag omitted or false still resolves the newest eligible session.
  const stillNewest = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Usual?', idempotencyKey: 'w-usual', mayStart: true });
  await stillNewest.settled;
  const stillFalse = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Usual?', idempotencyKey: 'w-usual-f', mayStart: true, freshSession: false });
  await stillFalse.settled;
  assert(stillNewest.resolution === 'newest' && stillFalse.resolution === 'newest'
    && [pin1, pin2, started.pin.session_ref].includes(stillNewest.pin.session_ref)
    && [pin1, pin2, started.pin.session_ref].includes(stillFalse.pin.session_ref),
    'flag omitted or false: the newest eligible session is still chosen');
  const freshStarts = fake.providerCalls(STATE, 'startSession');
  // Writer has eligible sessions: fresh_session skips them all.
  const fresh1 = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Fresh eyes?', idempotencyKey: 'w-fresh-1', mayStart: true, freshSession: true });
  await fresh1.settled;
  const fresh2 = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Fresh eyes?', idempotencyKey: 'w-fresh-2', mayStart: true, freshSession: true });
  await fresh2.settled;
  const freshCall = fake.loadFakeState(STATE).calls.filter(call => call.op === 'startSession').pop();
  assert(fresh1.resolution === 'started' && fresh2.resolution === 'started'
    && fresh1.pin.session_ref !== pin1 && fresh1.pin.session_ref !== pin2
    && fresh2.pin.session_ref !== pin1 && fresh2.pin.session_ref !== pin2
    && fresh1.pin.session_ref !== fresh2.pin.session_ref
    && fresh1.pin.authority === 'read_only' && fresh2.pin.authority === 'read_only'
    && freshCall.authority === 'read_only' && freshCall.workspace === '/work/a'
    && fake.providerCalls(STATE, 'startSession') === freshStarts + 2,
    'fresh_session twice: two different new read-only session_refs in the default workspace, neither reuses pin-1 or pin-2');
  // Every start-branch gate still applies to a fresh session.
  await rejects(pins.messageAgent({ requester: grok, agentId: reader.id, content: 'x', idempotencyKey: 'fresh-nopolicy', mayStart: true, freshSession: true }),
    'no_eligible_session', 'fresh + policy forbids new sessions -> no_eligible_session (the busy session is skipped, not waited on)');
  await rejects(pins.messageAgent({ requester: grok, agentId: nowhere.id, content: 'x', idempotencyKey: 'fresh-nowhere', mayStart: true, freshSession: true }),
    'workspace_required', 'fresh + no default workspace -> workspace_required');
  const scoped = agent('Scoped', connectionId, write, { defaultWorkspace: '/work/a' });
  db.prepare('UPDATE bots SET session_scope_kind = ?, session_scope_items = ? WHERE id = ?').run('sessions', JSON.stringify(['pinned-ref']), scoped.id);
  await rejects(pins.messageAgent({ requester: grok, agentId: scoped.id, content: 'x', idempotencyKey: 'fresh-scoped', mayStart: true, freshSession: true }),
    'no_eligible_session', 'fresh + sessions-kind scope -> no_eligible_session');
  // The flag is part of the idempotency hash.
  const idem = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Same?', idempotencyKey: 'w-idem', mayStart: true, freshSession: true });
  await idem.settled;
  await rejects(pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Same?', idempotencyKey: 'w-idem', mayStart: true, freshSession: false }),
    'idempotency_conflict', 'the same key with a different fresh_session value is idempotency_conflict');
  const idemReplay = await pins.messageAgent({ requester: grok, agentId: writer.id, content: 'Same?', idempotencyKey: 'w-idem', mayStart: true, freshSession: true });
  assert(idemReplay.replayed && idemReplay.pin.id === idem.pin.id && fake.providerCalls(STATE, 'startSession') === freshStarts + 3,
    'the same key with the same flag replays and starts nothing');
  // An Agent with a configured home session: fresh_session skips the home
  // branch too, even when the home session is busy (which otherwise throws
  // before newest resolution or a start). Home borrows a default workspace
  // for the start; everything is restored below so later sections still
  // see Home with no default workspace and oldRef as the newest session.
  db.prepare('UPDATE bots SET default_workspace = ? WHERE id = ?').run('/work/a', homeAgent.id);
  fake.mutateFakeProvider(STATE, state => { state.sessions['home-1-SECRET'].deleted = false; state.sessions['home-1-SECRET'].busy = true; });
  await rejects(pins.messageAgent({ requester: grok, agentId: homeAgent.id, content: 'Still there?', idempotencyKey: 'h-busy', mayStart: true }),
    'source_session_busy', 'control: without the flag, a busy home session throws source_session_busy');
  const freshHome = await pins.messageAgent({ requester: grok, agentId: homeAgent.id, content: 'Fresh eyes?', idempotencyKey: 'h-fresh', mayStart: true, freshSession: true });
  await freshHome.settled;
  assert(freshHome.resolution === 'started' && freshHome.pin.authority === 'read_only'
    && freshHome.pin.session_ref !== homeRef && freshHome.pin.session_ref !== oldRef,
    'fresh_session on an Agent with a home session: started, a read-only ref different from the home and newest sessions');
  db.prepare('UPDATE bots SET default_workspace = NULL WHERE id = ?').run(homeAgent.id);
  db.prepare('DELETE FROM provider_session_turns WHERE session_ref = ?').run(freshHome.pin.session_ref);
  db.prepare('DELETE FROM provider_sessions WHERE id = ?').run(freshHome.pin.session_ref);
  fake.mutateFakeProvider(STATE, state => { state.sessions['home-1-SECRET'].deleted = true; state.sessions['home-1-SECRET'].busy = false; });
  await ps.refreshProviderSession(db, homeAgent.id, homeRef);
  assert(db.prepare('SELECT availability FROM provider_sessions WHERE id = ?').get(homeRef).availability === 'missing',
    'restored: the home session is recorded missing again');

  console.log('\nExact-session pins: follow-ups stay on the same ref');
  const created = await pins.createPin({ requester: grok, sessionRef: pin1, action: 'ask', idempotencyKey: 'p1' });
  const pinRef = created.pin.id;
  assert(created.created && created.pin.session_ref === pin1 && created.pin.resolution === 'exact', 'pin_session ask: an exact pin on the chosen session');
  const t1 = await pins.sendPinTurn({ requester: grok, pinRef, content: 'What did you change?', idempotencyKey: 't1' });
  await t1.settled;
  const t2 = await pins.sendPinTurn({ requester: grok, pinRef, content: 'And why?', idempotencyKey: 't2' });
  await t2.settled;
  const read = await pins.readPin(grok, pinRef);
  assert(read.turns.length === 2 && read.turns.every(turn => turn.state === 'completed' && /fake reply/.test(turn.answer)) && read.turns[1].seq === 2,
    'two follow-ups answered in order');
  assert(sendsTo('pin-1-SECRET') === 2 && sendsTo('pin-2-SECRET') === 0, 'both reached exactly the pinned session');
  const replayTurn = await pins.sendPinTurn({ requester: grok, pinRef, content: 'And why?', idempotencyKey: 't2' });
  assert(replayTurn.replayed && replayTurn.turn.turn_ref === t2.turn.turn_ref && sendsTo('pin-1-SECRET') === 2, 'a replayed turn sends nothing');
  await rejects(pins.sendPinTurn({ requester: grok, pinRef, content: 'Other', idempotencyKey: 't2' }), 'idempotency_conflict', 'turn key reuse with other content conflicts');

  console.log('\nProvider failure and busy: the target never changes');
  const eventsBefore = count('SELECT COUNT(*) AS n FROM session_pin_events WHERE pin_id = ?', pinRef);
  const sendsBefore = sends();
  fake.mutateFakeProvider(STATE, state => { state.failSends = 1; });
  await rejects(pins.sendPinTurn({ requester: grok, pinRef, content: 'Try', idempotencyKey: 't3' }), 'provider_failed', 'a runtime failure is provider_failed');
  fake.mutateFakeProvider(STATE, state => { state.sessions['pin-1-SECRET'].busy = true; });
  await rejects(pins.sendPinTurn({ requester: grok, pinRef, content: 'Try', idempotencyKey: 't4' }), 'source_session_busy', 'a busy pinned session is source_session_busy');
  fake.mutateFakeProvider(STATE, state => { state.sessions['pin-1-SECRET'].busy = false; });
  const after = pins.requirePin(grok, pinRef);
  assert(after.session_ref === pin1 && after.state === 'attached' && sendsTo('pin-2-SECRET') === 0 && sends() === sendsBefore + 1,
    'after both refusals the pin is still attached to the same ref and no other session was tried (busy is refused before the runtime)');
  assert(count("SELECT COUNT(*) AS n FROM session_pin_events WHERE pin_id = ? AND type = 'turn_refused'", pinRef) === 2
    && count('SELECT COUNT(*) AS n FROM session_pin_events WHERE pin_id = ?', pinRef) === eventsBefore + 2
    && count('SELECT COUNT(*) AS n FROM session_pin_turns WHERE pin_id = ?', pinRef) === 2, 'each refusal is one turn_refused event and no turn row');
  const t3 = await pins.sendPinTurn({ requester: grok, pinRef, content: 'Try', idempotencyKey: 't3' });
  await t3.settled;
  // Calls to pin-1: two answered, one failed, and this retry.
  assert(t3.turn.seq === 3 && sendsTo('pin-1-SECRET') === 4 && sendsTo('pin-2-SECRET') === 0, 'retrying the failed key later sends on the same session');
  let immutable = null;
  try { db.prepare('UPDATE session_pins SET session_ref = ? WHERE id = ?').run(pin2, pinRef); } catch (error) { immutable = error; }
  assert(immutable && /immutable/.test(immutable.message), 'the database refuses any retarget of a pin');

  console.log('\nResume work here: authority, policy, grant, approval');
  await rejects(pins.createPin({ requester: grok, sessionRef: pin2, action: 'resume', idempotencyKey: 'r0' }), 'approval_required', 'resume without approve_write -> approval_required');
  const resumed = await pins.createPin({ requester: grok, sessionRef: pin2, action: 'resume', approveWrite: true, idempotencyKey: 'r1' });
  const r1 = await pins.sendPinTurn({ requester: grok, pinRef: resumed.pin.id, content: 'Apply the fix', idempotencyKey: 'r1t' });
  await r1.settled;
  const resumeCall = fake.loadFakeState(STATE).calls.filter(call => call.op === 'sendTurn').pop();
  assert(resumed.pin.authority === 'workspace_write' && resumed.pin.approved_at !== null && resumeCall.authority === 'workspace_write' && resumeCall.session === 'pin-2-SECRET',
    'resume: same Agent, same exact session, workspace-write turn after explicit approval');
  const readerRef = nativeRef(reader.id, 'busy-1-SECRET');
  fake.mutateFakeProvider(STATE, state => { state.sessions['busy-1-SECRET'].busy = false; });
  await ps.refreshProviderSession(db, reader.id, readerRef);
  await rejects(pins.createPin({ requester: grok, sessionRef: readerRef, action: 'resume', approveWrite: true, idempotencyKey: 'r2' }),
    'authority_not_allowed', 'a read-only Agent policy refuses resume even with approval');

  console.log('\nOwner routes: the Sessions drawer');
  const ownerPinRoute = jiti('../app/api/bots/[id]/sessions/[ref]/pins/route.ts');
  const ownerListRoute = jiti('../app/api/bots/[id]/sessions/route.ts');
  const ownerConv = dbModule.conversations.getByBotId(writer.id).id;
  const ownerPost = (ref, body) => ownerPinRoute.POST(
    new Request('http://local/x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: writer.id, ref }) },
  ).then(async res => ({ status: res.status, json: await res.json() }));
  const listRes = await ownerListRoute.GET(new Request('http://local/x?status=all'), { params: Promise.resolve({ id: writer.id }) });
  const listJson = await listRes.json();
  const ownerRow = listJson.sessions.find(row => row.ref === pin2);
  assert(listRes.status === 200 && ownerRow && ownerRow.route === 'provider' && ownerRow.home === false && ownerRow.actions.resume.available === true
    && !JSON.stringify(listJson).match(SECRET), 'owner session list: route, home, and per-action availability, no provider id');
  const ownerPinsBefore = count('SELECT COUNT(*) AS n FROM session_pins');
  const noApproval = await ownerPost(pin2, { action: 'resume', content: 'Apply it', conversation_id: ownerConv, idempotency_key: 'own-r0' });
  assert(noApproval.status === 403 && noApproval.json.error.code === 'approval_required' && noApproval.json.error.recovery === 'approve_write'
    && count('SELECT COUNT(*) AS n FROM session_pins') === ownerPinsBefore, 'owner Resume work here without approval: approval_required, nothing written');
  const ownerSendsBefore = sendsTo('pin-2-SECRET');
  const ownerResume = await ownerPost(pin2, { action: 'resume', content: 'Apply it', conversation_id: ownerConv, approve_write: true, idempotency_key: 'own-r1' });
  assert(ownerResume.status === 202 && ownerResume.json.pin.session.ref === pin2 && ownerResume.json.pin.authority === 'workspace_write' && ownerResume.json.pin.approved === true
    && !JSON.stringify(ownerResume.json).match(SECRET), 'owner Resume work here with approval: 202, pinned to the exact session, workspace write');
  const ownerReplay = await ownerPost(pin2, { action: 'resume', content: 'Apply it', conversation_id: ownerConv, approve_write: true, idempotency_key: 'own-r1' });
  assert(ownerReplay.status === 200 && ownerReplay.json.replayed === true && ownerReplay.json.pin.pin_ref === ownerResume.json.pin.pin_ref
    && count('SELECT COUNT(*) AS n FROM session_pins') === ownerPinsBefore + 1, 'owner replay of the same key: 200, the same pin, one row');
  await pins.readPin(dbModule.UI_OWNER_PRINCIPAL, ownerResume.json.pin.pin_ref);
  assert(sendsTo('pin-2-SECRET') === ownerSendsBefore + 1, 'the owner turn reached exactly the selected session, once');
  const badField = await ownerPost(pin2, { action: 'resume', content: 'x', conversation_id: ownerConv, approve_write: true, idempotency_key: 'own-r2', runtime: 'claude' });
  assert(badField.status === 400 && badField.json.error.code === 'invalid_request', 'owner route refuses a caller-chosen execution control');

  // A runtime that learns its capabilities only once probed (Codex after a
  // Botmancers restart): the drawer and pins probe it first, so a
  // resumable session is not reported unreachable.
  contract.clearSessionProviders({ builtins: true });
  let probed = false;
  contract.registerSessionProvider({ connectionId }, () => {
    const inner = fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true });
    return {
      ...inner,
      capabilities: () => (probed ? inner.capabilities() : { ...inner.capabilities(), resume: false, start: false, authorities: [] }),
      ready: async () => { probed = true; return { ok: true, value: undefined }; },
    };
  });
  const cold = pins.sessionsWithActions(writer.id, [ownerRow]).map(row => row.route)[0];
  const warmList = await (await ownerListRoute.GET(new Request('http://local/x?status=all'), { params: Promise.resolve({ id: writer.id }) })).json();
  assert(cold === null && probed && warmList.sessions.find(row => row.ref === pin2).actions.resume.available === true,
    'a runtime that reports capabilities only after a probe: the session list probes it, then Resume work here is available');
  registerFake(connectionId);

  console.log('\nNOT-558: each unavailable cause names itself; provider text stays in the log');
  const causePin = await pins.createPin({ requester: grok, sessionRef: pin1, action: 'ask', idempotencyKey: 'cause-pin' });
  const sendRefusal = async key => {
    try {
      await pins.sendPinTurn({ requester: grok, pinRef: causePin.pin.id, content: 'Are you there?', idempotencyKey: key });
      return null;
    } catch (error) { return error; }
  };
  // 1. No session provider resolves for the Agent's runtime connection.
  contract.clearSessionProviders({ builtins: true });
  const noProvider = await sendRefusal('cause-1');
  // 2. The provider reports itself unavailable (its raw text is a secret).
  contract.clearSessionProviders({ builtins: true });
  contract.registerSessionProvider({ connectionId }, () => ({
    ...fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }),
    ready: async () => ({ ok: false, error: { code: 'unavailable', message: 'claude --version failed:\nSECRET-MARKER-123 not signed in' } }),
  }));
  const causeLog = [];
  const realConsoleError = console.error;
  console.error = (...args) => { causeLog.push(args.map(String).join(' ')); };
  let reported;
  try { reported = await sendRefusal('cause-2'); } finally { console.error = realConsoleError; }
  // 3. The session row belongs to another runtime connection than the
  // Agent's current one (session identity is immutable, so the Agent moves).
  const otherConnection = runtimeConnections.create({ provider: 'codex', label: 'Codex other', host: 'Elsewhere' }).id;
  registerFake(connectionId);
  contract.registerSessionProvider({ connectionId: otherConnection }, () => fake.createFakeSessionProvider({ statePath: STATE, ignoreScope: true }));
  db.prepare('UPDATE bots SET runtime_connection_id = ? WHERE id = ?').run(otherConnection, writer.id);
  const otherSession = await sendRefusal('cause-3');
  db.prepare('UPDATE bots SET runtime_connection_id = ? WHERE id = ?').run(connectionId, writer.id);
  registerFake(connectionId);
  const causes = [noProvider, reported, otherSession];
  assert(causes.every(error => error instanceof pins.PinError && error.code === 'agent_unavailable'),
    `all three causes surface as agent_unavailable (got ${causes.map(error => error && error.code).join(', ')})`);
  const causeMessages = causes.map(error => (error && error.message) || '');
  assert(new Set(causeMessages).size === 3, 'the three messages are pairwise different');
  assert(causeMessages[0].includes('no session provider'), `no provider: "${causeMessages[0]}"`);
  assert(causeMessages[1].includes('reported itself unavailable'), `provider unavailable: "${causeMessages[1]}"`);
  assert(causeMessages[2].includes('different runtime connection'), `other connection: "${causeMessages[2]}"`);
  const reportedJson = JSON.stringify(reported && pins.pinErrorBody(reported));
  assert(!causeMessages[1].includes('SECRET-MARKER-123') && !reportedJson.includes('SECRET-MARKER-123') && reportedJson.includes('agent_unavailable'),
    'the raw provider text reaches neither the caller message nor its JSON body');
  const causeLines = causeLog.filter(line => line.startsWith('Session provider refused a call:'));
  assert(causeLines.length === 1 && causeLines[0].includes(writer.id) && causeLines[0].includes('unavailable')
    && causeLines[0].includes('SECRET-MARKER-123') && !/[\r\n]/.test(causeLines[0]), 'the provider-reported cause writes one log line with the agent id, the code and the provider text');
  pins.detachPin(grok, causePin.pin.id);

  console.log('\nDetach and switch');
  const switched = await pins.createPin({ requester: grok, sessionRef: pin2, action: 'ask', idempotencyKey: 'p2', replacePinRef: pinRef });
  const old = pins.requirePin(grok, pinRef);
  assert(switched.replaced.id === pinRef && old.state === 'detached' && old.detach_reason === 'switched' && old.replaced_by === switched.pin.id,
    'switch: the old pin is detached in the same step, naming its replacement');
  await rejects(pins.sendPinTurn({ requester: grok, pinRef, content: 'x', idempotencyKey: 't5' }), 'pin_detached', 'a switched pin no longer sends');
  const detached = pins.detachPin(grok, switched.pin.id);
  const again = pins.detachPin(grok, switched.pin.id);
  assert(!detached.replayed && again.replayed && detached.pin.state === 'detached', 'detach is explicit and idempotent');
  await rejects(pins.sendPinTurn({ requester: grok, pinRef: switched.pin.id, content: 'x', idempotencyKey: 't6' }), 'pin_detached', 'a detached pin no longer sends');
  await rejects(pins.sendPinTurn({ requester: other, pinRef: resumed.pin.id, content: 'x', idempotencyKey: 't7' }), 'pin_not_found', 'another requester cannot see or use a pin');

  console.log('\nService access and audit');
  resetServiceApiRateLimits();
  const auditBefore = count('SELECT COUNT(*) AS n FROM service_audit_events');
  const lastAudit = () => db.prepare('SELECT * FROM service_audit_events ORDER BY id DESC LIMIT 1').get();
  const sessionsList = await serviceOperations.listSessions(grok, writer.id, { cursor: null, limit: null, status: null });
  const listed = sessionsList.body.items.find(item => item.ref === pin1);
  assert(sessionsList.status === 200 && listed && listed.title === 'Fix the uploader retry' && listed.home === false && listed.actions.ask.available === true,
    'sessions list: recognizable title, home flag, and per-action availability');
  const agentView = await serviceOperations.getAgent(grok, homeAgent.id);
  assert(agentView.body.messaging.home_session_ref === homeRef && agentView.body.messaging.default_workspace_set === false && !('default_workspace' in agentView.body.messaging),
    'agent view: how messaging resolves, never the workspace itself');
  const msg = await serviceOperations.messageAgent(grok, homeAgent.id, () => ({ content: 'Hello', idempotency_key: 'svc-1' }), null);
  let audit = lastAudit();
  assert(msg.status === 202 && msg.body.pin.session.ref === oldRef && audit.outcome === 'allowed' && audit.operation === 'agents.message'
    && audit.capability === 'sessions:message' && audit.target_kind === 'session' && audit.target_ref === oldRef && audit.agent_id === homeAgent.id,
  'allowed: audit names the resolved Agent, session, capability, and action');
  const freshSvc = await serviceOperations.messageAgent(grok, writer.id, () => ({ content: 'Fresh review?', idempotency_key: 'svc-fresh', fresh_session: true }), null);
  audit = lastAudit();
  assert(freshSvc.status === 202 && freshSvc.body.resolution === 'started' && !freshSvc.body.replayed
    && freshSvc.body.pin.session.ref !== pin1 && freshSvc.body.pin.session.ref !== pin2
    && freshSvc.body.pin.authority === 'read_only' && audit.outcome === 'allowed' && audit.capability === 'sessions:start' && audit.operation === 'agents.message.start',
    'NOT-619: the service route accepts fresh_session and starts a new read-only session, audited as sessions:start');
  const deckSvc = await serviceOperations.messageAgent(grok, writer.id, () => ({ content: 'Hello', idempotency_key: 'svc-deck', deck_id: 'x' }), null);
  assert(deckSvc.status === 403 && deckSvc.body.error.code === 'authority_not_allowed', 'NOT-619: deck_id on the message route is still refused');
  const badFresh = await serviceOperations.messageAgent(grok, writer.id, () => ({ content: 'Hello', idempotency_key: 'svc-badfresh', fresh_session: 'yes' }), null);
  assert(badFresh.status === 400 && badFresh.body.error.code === 'invalid_request', 'NOT-619: a non-boolean fresh_session is invalid_request');
  const forbiddenStart = await serviceOperations.messageAgent(grok, nowhere.id, () => ({ content: 'Hello', idempotency_key: 'svc-2' }), null);
  assert(forbiddenStart.status === 409 && forbiddenStart.body.error.code === 'workspace_required' && forbiddenStart.body.error.recovery === 'ask_owner'
    && lastAudit().outcome === 'rejected' && lastAudit().code === 'workspace_required', 'workspace_required: structured recovery, audited as rejected');
  const unknownAgent = await serviceOperations.messageAgent(other, 'no-such-agent', () => ({ content: 'Hello', idempotency_key: 'svc-3' }), null);
  assert(unknownAgent.status === 404 && unknownAgent.body.error.code === 'agent_not_found' && lastAudit().outcome === 'denied' && lastAudit().code === 'agent_not_found',
    'an unknown Agent is agent_not_found, audited as denied');
  const unknownSession = await serviceOperations.pinSession(other, 'no-such-ref', () => ({ action: 'ask', idempotency_key: 'svc-4' }), null);
  assert(unknownSession.status === 404 && unknownSession.body.error.code === 'session_not_found' && lastAudit().outcome === 'denied',
    'an unknown session pin: session_not_found, audited as denied');
  const resumeReadOnly = await serviceOperations.pinSession(grok, readerRef, () => ({ action: 'resume', approve_write: true, idempotency_key: 'svc-5' }), null);
  audit = lastAudit();
  assert(resumeReadOnly.status === 403 && resumeReadOnly.body.error.code === 'authority_not_allowed' && audit.capability === 'sessions:resume'
    && audit.operation === 'pins.resume' && audit.agent_id === reader.id,
  'resume on an Agent whose policy forbids it: authority_not_allowed, audited with the requested authority');
  const svcPin = await serviceOperations.pinSession(grok, pin1, () => ({ action: 'ask', idempotency_key: 'svc-6' }), null);
  const svcSend = await serviceOperations.sendToPin(grok, svcPin.body.pin.pin_ref, () => ({ content: 'One more', idempotency_key: 'svc-7' }), null);
  audit = lastAudit();
  assert(svcPin.status === 201 && svcSend.status === 202 && audit.operation === 'pins.send' && audit.target_ref === pin1 && audit.outcome === 'allowed',
    'pin and send through the service: audited on the exact session');
  // Pins are caller-owned: another service's send answers like a missing pin.
  const foreign = await serviceOperations.sendToPin(other, svcPin.body.pin.pin_ref, () => ({ content: 'Still there?', idempotency_key: 'svc-8' }), null);
  assert(foreign.status === 404 && foreign.body.error.code === 'pin_not_found' && lastAudit().outcome === 'denied',
    'another service cannot use the pin (pin_not_found), audited as denied');
  const auditRows = db.prepare('SELECT * FROM service_audit_events WHERE id > ?').all(auditBefore);
  assert(auditRows.length === 13, `every call appended exactly one audit row (${auditRows.length})`);
  const everything = JSON.stringify([auditRows, sessionsList.body, agentView.body, msg.body, svcPin.body, svcSend.body,
    db.prepare('SELECT * FROM session_pins').all(), db.prepare('SELECT * FROM session_pin_events').all(), db.prepare('SELECT * FROM session_pin_turns').all()]);
  assert(!SECRET.test(everything) && !everything.includes('/work/a'), 'no provider id or workspace path in any view, row, event, or audit');

  console.log('\nMCP: the same contract, with recovery');
  const call = async (name, args) => {
    try {
      return { data: await mcp.callMcpV2Tool(grok, name, args, { v1Operations: [] }) };
    } catch (error) {
      if (error instanceof mcp.McpV2Error) return { error: mcp.mcpV2ErrorBody(error).error };
      throw error;
    }
  };
  const listedMcp = await call('botmancers_list_sessions', { agent_id: writer.id });
  const pick = listedMcp.data.items.find(item => item.title === 'Write release notes');
  assert(pick && pick.actions.resume.available === true && !('state' in pick), 'list_sessions: pick a past session by title; actions shown');
  const mPin = await call('botmancers_pin_session', { session_ref: pick.ref, action: 'ask', idempotency_key: 'mcp-1' });
  const f1 = await call('botmancers_send_to_pin', { pin_ref: mPin.data.pin.pin_ref, content: 'First follow-up', idempotency_key: 'mcp-2' });
  const f2 = await call('botmancers_send_to_pin', { pin_ref: mPin.data.pin.pin_ref, content: 'Second follow-up', idempotency_key: 'mcp-3' });
  assert(f1.data.pin.session.ref === pick.ref && f2.data.pin.session.ref === pick.ref && f2.data.turn.seq === 2, 'two follow-ups on the same ref');
  const needsApproval = await call('botmancers_pin_session', { session_ref: pick.ref, action: 'resume', idempotency_key: 'mcp-4' });
  assert(needsApproval.error.code === 'approval_required' && needsApproval.error.recovery === 'approve_write', 'resume without approval: approval_required, recovery approve_write');
  const mResume = await call('botmancers_pin_session', { session_ref: pick.ref, action: 'resume', approve_write: true, replace_pin_ref: mPin.data.pin.pin_ref, idempotency_key: 'mcp-5' });
  assert(mResume.data.pin.authority === 'workspace_write' && mResume.data.replaced_pin_ref === mPin.data.pin.pin_ref, 'resume with explicit approval, switching from the ask pin');
  const authority = await call('botmancers_pin_session', { session_ref: pick.ref, action: 'ask', idempotency_key: 'mcp-6', runtime: 'x' });
  assert(authority.error.code === 'authority_not_allowed', 'a caller-chosen runtime is refused');
  const workspaceMcp = await call('botmancers_message_agent', { agent_id: nowhere.id, content: 'Hi', idempotency_key: 'mcp-7' });
  assert(workspaceMcp.error.code === 'workspace_required' && workspaceMcp.error.recovery === 'ask_owner', 'message_agent: workspace_required with recovery');
  const freshMcp = await call('botmancers_message_agent', { agent_id: writer.id, content: 'Fresh review?', idempotency_key: 'mcp-fresh', fresh_session: true });
  assert(freshMcp.data.resolution === 'started' && freshMcp.data.pin.authority === 'read_only'
    && freshMcp.data.pin.session.ref !== pin1 && freshMcp.data.pin.session.ref !== pin2,
    'NOT-619: message_agent with fresh_session: true starts a new read-only session');
  const deckMcp = await call('botmancers_message_agent', { agent_id: writer.id, content: 'Hi', idempotency_key: 'mcp-deck', deck_id: 'x' });
  assert(deckMcp.error.code === 'authority_not_allowed', 'NOT-619: message_agent with deck_id is still refused');
  const detachMcp = await call('botmancers_detach_pin', { pin_ref: mResume.data.pin.pin_ref });
  const afterDetach = await call('botmancers_send_to_pin', { pin_ref: mResume.data.pin.pin_ref, content: 'x', idempotency_key: 'mcp-8' });
  assert(detachMcp.data.pin.state === 'detached' && afterDetach.error.code === 'pin_detached' && afterDetach.error.recovery === 'pin_again', 'detach, then pin_detached with pin_again');

  console.log('\nRestart: a second process reloads the pin');
  const live = await pins.createPin({ requester: grok, sessionRef: pin1, action: 'ask', idempotencyKey: 'live' });
  const before = await pins.sendPinTurn({ requester: grok, pinRef: live.pin.id, content: '[hold] long question', idempotencyKey: 'live-1' });
  fs.writeFileSync(IDS_PATH, JSON.stringify({ connectionId, pinRef: live.pin.id, sessionRef: pin1, other: pin2, turnRef: before.turn.turn_ref }));
  const child = spawnSync(process.execPath, [__filename, 'restart'], { env: { ...process.env, NOT507_TAG: TAG }, encoding: 'utf8' });
  process.stdout.write(child.stdout);
  if (child.stderr.trim()) process.stdout.write(child.stderr);
  assert(child.status === 0, 'the restarted process held the same pin');

  console.log(`\n${failures === 0 ? 'TEST RESULT: PASS' : `TEST RESULT: FAIL (${failures})`}`);
  if (failures === 0) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

async function restart() {
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));
  registerFake(ids.connectionId);
  const pin = pins.requirePin(grok, ids.pinRef);
  assert(pin.session_ref === ids.sessionRef && pin.state === 'attached', 'after restart: the pin is attached to the same ref');
  // The held turn is cancelled by the runtime; the pin does not move.
  fake.mutateFakeProvider(STATE, state => {
    for (const turn of Object.values(state.turns)) if (turn.state === 'running') { turn.state = 'cancelled'; state.sessions[turn.session].busy = false; }
  });
  const read = await pins.readPin(grok, ids.pinRef);
  assert(read.turns.length === 1 && read.turns[0].turn_ref === ids.turnRef && read.turns[0].state === 'cancelled', 'after restart: the earlier turn is observed and recorded');
  const otherBefore = sendsTo('pin-2-SECRET');
  const next = await pins.sendPinTurn({ requester: grok, pinRef: ids.pinRef, content: 'Follow-up after restart', idempotencyKey: 'live-2' });
  await next.settled;
  assert(next.pin.session_ref === ids.sessionRef && next.turn.seq === 2 && sendsTo('pin-2-SECRET') === otherBefore, 'after restart: the follow-up goes to the same session');
  process.exit(failures === 0 ? 0 : 1);
}
