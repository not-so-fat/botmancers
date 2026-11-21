#!/usr/bin/env node
// NOT-442/NOT-456/NOT-543: agent + direct-launch snapshot test
// (deterministic, no network). Proves: identical config yields an
// identical hash; the snapshot carries one agent identity plus its direct
// launch registration (runtime connection, default workspace, effective
// working directory) for every agent, Hermes included, and no runtime or
// deck field; legacy deck fields are not part of the snapshot; loop
// integration flushes Hermes and coding-agent snapshots with the
// transport that actually ran; an unconfigured row cannot launch and its
// snapshot records the null connection.

const assert = require('node:assert');
const { buildSnapshotInput, canonicalJson, hashSnapshot } = require('../lib/snapshot');

function bot(overrides = {}) {
  return {
    name: 'Alice',
    title: 'Research Assistant',
    description: 'You are Alice, a research assistant.',
    source_provider: null,
    template_id: null,
    template_url: null,
    import_schema_version: null,
    import_operation_id: null,
    ...overrides,
  };
}

function skill(overrides = {}) {
  return { path: 'skills/Alice/SKILL.md', present: false, content: null, ...overrides };
}

let passed = 0;

// 1. Identical config yields an identical hash.
const first = buildSnapshotInput(bot(), skill());
const second = buildSnapshotInput(bot(), skill());
assert.strictEqual(hashSnapshot(first), hashSnapshot(second), 'same config must give same hash');
assert.match(hashSnapshot(first), /^[0-9a-f]{64}$/, 'hash must be 64 lowercase hex chars');
console.log('PASS: identical config yields an identical hash');
passed += 1;

// 2. Canonicalisation: key order of the input object does not affect the hash,
// and the canonical JSON uses sorted key order.
const reordered = {};
for (const key of Object.keys(first).reverse()) reordered[key] = first[key];
assert.strictEqual(hashSnapshot(reordered), hashSnapshot(first), 'key order must not affect the hash');
const keys = Object.keys(JSON.parse(canonicalJson(first)));
assert.deepStrictEqual(keys, [...keys].sort(), 'canonical JSON keys must be sorted');
assert.deepStrictEqual(keys, [
  'agent',
  'avatar_accessory',
  'avatar_color',
  'avatar_eyes',
  'avatar_hands',
  'default_workspace',
  'description',
  'import_operation_id',
  'import_schema_version',
  'memories',
  'name',
  'runtime_connection_id',
  'skill_content',
  'skill_path',
  'skill_present',
  'source_provider',
  'template_id',
  'template_url',
  'title',
  'working_directory',
]);
assert.ok(!keys.includes('runtime') && !keys.includes('agent_client'), 'snapshot has no runtime/agent_client field');
assert.ok(!keys.some(key => /deck/i.test(key)), 'snapshot has no deck field');
console.log('PASS: hash is stable under key reordering with sorted canonical keys (agent, no runtime, no deck)');
passed += 1;

// 3. One changed rule yields a different hash.
const changedRule = buildSnapshotInput(bot({ description: 'You are Alice. Be brief.' }), skill());
assert.notStrictEqual(hashSnapshot(first), hashSnapshot(changedRule), 'changed rule must give a different hash');
console.log('PASS: one changed rule yields a different hash');
passed += 1;

// 4. Remembered facts are part of the input.
const withFacts = buildSnapshotInput(bot(), skill(), ['I like green tea.', 'My dog is named Biscuit.']);
const withFactsAgain = buildSnapshotInput(bot(), skill(), ['I like green tea.', 'My dog is named Biscuit.']);
assert.strictEqual(hashSnapshot(withFacts), hashSnapshot(withFactsAgain), 'same facts must give same hash');
const changedFact = buildSnapshotInput(bot(), skill(), ['I like black tea.', 'My dog is named Biscuit.']);
assert.notStrictEqual(hashSnapshot(withFacts), hashSnapshot(changedFact), 'changed fact must give a different hash');
assert.notStrictEqual(hashSnapshot(first), hashSnapshot(withFacts), 'facts must change the hash vs never-read');
const readEmpty = buildSnapshotInput(bot(), skill(), []);
assert.notStrictEqual(hashSnapshot(first), hashSnapshot(readEmpty), 'null facts must differ from an empty list');
console.log('PASS: same facts give the same hash, a changed fact gives a different hash');
passed += 1;

// 5. NOT-456/NOT-543 Hermes snapshot: Hermes is an agent with the same
// direct launch registration as every other agent.
const hermesInput = buildSnapshotInput(bot({ agent: 'hermes', runtime_connection_id: 'rc-hermes', default_workspace: '/tmp/hermes-work' }), skill());
assert.strictEqual(hermesInput.agent, 'hermes', 'Hermes snapshot must record agent=hermes');
assert.strictEqual(hermesInput.runtime_connection_id, 'rc-hermes', 'Hermes snapshot records its runtime connection');
assert.strictEqual(hermesInput.default_workspace, '/tmp/hermes-work', 'Hermes snapshot records its default workspace');
assert.strictEqual(buildSnapshotInput(bot(), skill()).agent, 'hermes', 'missing agent reads as hermes');
console.log('PASS: Hermes snapshot assertion: agent=hermes with its runtime connection and default workspace');
passed += 1;

// 6. Coding-agent snapshot: agent, runtime connection, and workspaces
// round-trip and change the launch hash.
const directInput = buildSnapshotInput(
  bot({ agent: 'codex', runtime_connection_id: 'rc-codex', default_workspace: '/tmp/codex-work', working_directory: '/tmp/codex-work' }),
  skill()
);
assert.strictEqual(directInput.agent, 'codex', 'snapshot must record agent=codex');
assert.strictEqual(directInput.runtime_connection_id, 'rc-codex', 'snapshot must record the runtime connection');
assert.strictEqual(directInput.default_workspace, '/tmp/codex-work', 'snapshot must record the default workspace');
assert.notStrictEqual(hashSnapshot(hermesInput), hashSnapshot(directInput), 'agent must be part of the hashed input');
const reconnected = buildSnapshotInput(
  bot({ agent: 'codex', runtime_connection_id: 'rc-codex-2', default_workspace: '/tmp/codex-work', working_directory: '/tmp/codex-work' }),
  skill()
);
assert.notStrictEqual(hashSnapshot(directInput), hashSnapshot(reconnected), 'a changed runtime connection must change the hash');
console.log('PASS: coding-agent snapshot assertion: agent, connection, and workspaces round-trip and change the launch hash');
passed += 1;

// 7. Legacy deck fields are not part of the snapshot: a row carrying the
// removed launch columns hashes exactly like one without them, and a
// missing connection reads null.
const legacyInput = buildSnapshotInput(
  bot({ agent: 'codex', deck_id: 'deck-123', deck_name: 'relay-deck', working_directory: '/tmp/relay-work', needs_deck_selection: 1 }),
  skill()
);
assert.strictEqual(legacyInput.agent, 'codex', 'legacy row keeps agent=codex');
assert.ok(!('deck_id' in legacyInput) && !('deck_name' in legacyInput) && !('needs_deck_selection' in legacyInput),
  'legacy deck fields leave no key in the snapshot');
assert.strictEqual(legacyInput.runtime_connection_id, null, 'a row without a connection reads null');
assert.strictEqual(hashSnapshot(legacyInput), hashSnapshot(buildSnapshotInput(bot({ agent: 'codex', working_directory: '/tmp/relay-work' }), skill())),
  'legacy deck fields do not change the hash');
console.log('PASS: legacy-row assertion: removed deck fields are not in the snapshot and do not change the hash');
passed += 1;

// 8. NOT-431 avatar fields remain part of the hashed input.
const avatarBase = buildSnapshotInput(bot(), skill());
assert.strictEqual(avatarBase.avatar_color, null, 'unconfigured snapshot must not invent an avatar color');
const avatarConfigured = buildSnapshotInput(
  bot({ avatar_color: 'teal', avatar_eyes: 'happy', avatar_hands: 'waving', avatar_accessory: 'hat' }),
  skill()
);
assert.strictEqual(avatarConfigured.avatar_color, 'teal', 'snapshot must record the avatar color');
assert.notStrictEqual(hashSnapshot(avatarBase), hashSnapshot(avatarConfigured), 'avatar configuration must be part of the hashed input');
console.log('PASS: snapshot-field assertion: avatar fields round-trip and changing one changes the launch hash');
passed += 1;

// 9. Loop integration: an ordinary Hermes turn and an ordinary direct
// coding turn flush snapshots that describe what actually ran. Exercises
// the real queue loop with the stub model and a scripted in-process
// direct provider; no network, no key, no directive parsed.
async function main() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const DB_PATH = path.join(os.tmpdir(), `botmancers-snapshot-direct-test-${process.pid}.db`);
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename);
  const db = jiti('../lib/db.ts');
  const agent = jiti('../lib/agent.ts');
  const providerContract = jiti('../lib/session-provider.ts');
  const fake = require('./support/fake-session-provider.js');

  const providerTurns = () => db.default.prepare('SELECT COUNT(*) AS n FROM provider_session_turns').get().n;
  const launches = [];
  const STATE = path.join(os.tmpdir(), `botmancers-snapshot-provider-${process.pid}.json`);
  fs.rmSync(STATE, { force: true });

  // Hermes direct dispatch: ordinary message uses the Hermes session path
  // (here the deterministic stub) and never touches a provider.
  let hermesStubCalls = 0;
  agent.setDelegationChatStub(() => {
    hermesStubCalls += 1;
    return 'Hello from the Hermes session.';
  });
  const herald = db.bots.create({
    name: 'Herald',
    title: 'Herald',
    description: 'Answers directly.',
    agent: 'hermes',
  });
  const heraldConv = db.conversations.getByBotId(herald.id);
  assert.ok(heraldConv, 'herald thread exists');
  db.messages.create(heraldConv.id, 'user', 'Hello Herald.');
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(heraldConv.id, herald.id);
  let processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.strictEqual(hermesStubCalls, 1, 'Hermes direct-dispatch assertion: ordinary Hermes message uses the Hermes session');
  assert.strictEqual(providerTurns(), 0, 'Hermes direct-dispatch assertion: opposite adapter (session-provider) was not invoked');
  console.log('PASS: Hermes direct-dispatch assertion: ordinary message uses the Hermes session, provider adapter not invoked');
  passed += 1;
  const heraldSnaps = db.launchSnapshots.listByBot(herald.id);
  assert.ok(heraldSnaps.length >= 1, 'a launch snapshot was flushed for the Hermes turn');
  assert.strictEqual(heraldSnaps[heraldSnaps.length - 1].transport, 'hermes-gateway', 'Hermes turn records the hermes-gateway transport');
  const heraldFlushed = JSON.parse(heraldSnaps[heraldSnaps.length - 1].snapshot);
  console.log(`flushed Hermes snapshot: agent=${heraldFlushed.agent} connection=${heraldFlushed.runtime_connection_id}`);
  assert.strictEqual(heraldFlushed.agent, 'hermes', 'flushed Hermes snapshot carries agent=hermes');
  assert.strictEqual(heraldFlushed.runtime_connection_id, db.bots.getById(herald.id).runtime_connection_id, 'flushed Hermes snapshot carries its runtime connection');
  assert.ok(!('runtime' in heraldFlushed), 'flushed Hermes snapshot has no runtime field');
  assert.ok(!Object.keys(heraldFlushed).some(key => /deck/i.test(key)), 'flushed Hermes snapshot has no deck field');
  console.log('PASS: Hermes snapshot assertion: flushed snapshot carries agent=hermes plus its direct registration');
  passed += 1;

  // Direct dispatch: an ordinary message to a codex agent launches its
  // direct provider Session without waiting for a directive.
  agent.setDelegationChatStub(() => {
    throw new Error('Hermes adapter must not run for a direct coding turn');
  });
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-snap-direct-'));
  const relay = db.bots.create({ name: 'Relay', title: 'Coding Relay', description: 'Launches directly.', agent: 'codex' });
  const connectionId = db.runtimeConnections.ensureLocal('codex');
  db.bots.updateRegistration(relay.id, 'codex', {
    runtime_connection_id: connectionId,
    session_scope: { kind: 'workspaces', workspaces: [workdir], sessions: [] },
    default_workspace: workdir,
    policy: { mode: 'read_only', allow_new_sessions: true, allow_resume_with_edits: false },
    home_session_id: null,
  });
  providerContract.registerSessionProvider({ connectionId }, () => {
    const inner = fake.createFakeSessionProvider({ statePath: STATE, kind: 'snapshot-main' });
    return {
      ...inner,
      startSession: async input => {
        launches.push({ kind: 'start', authority: input.authority, workspace: input.workspace });
        return inner.startSession(input);
      },
      sendTurn: async input => {
        launches.push({ kind: 'send', authority: input.authority });
        return inner.sendTurn(input);
      },
    };
  });
  fake.mutateFakeProvider(STATE, state => { state.results = ['relay output']; });
  const relayConv = db.conversations.getByBotId(relay.id);
  assert.ok(relayConv, 'relay thread exists');
  db.messages.create(relayConv.id, 'user', 'Build the widget.');
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(relayConv.id, relay.id);
  processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.strictEqual(launches.length, 1, 'direct-dispatch assertion: ordinary message launches one provider turn');
  assert.strictEqual(launches[0].authority, 'read_only', 'direct launch uses read_only authority');
  assert.strictEqual(launches[0].workspace, workdir, 'direct launch uses the default workspace');
  const relayThread = db.messages.getByConversation(relayConv.id).filter(m => m.sender_type === 'bot');
  assert.strictEqual(relayThread.length, 1, 'one bot reply in the thread');
  assert.strictEqual(relayThread[0].content, 'relay output', 'the reply carries the turn output');
  console.log(`direct dispatch: authority=${launches[0].authority} workspace=${launches[0].workspace} (no directive parsed)`);
  console.log('PASS: direct-dispatch assertion: ordinary message launches the stored registration, Hermes adapter not invoked');
  passed += 1;
  const relaySnaps = db.launchSnapshots.listByBot(relay.id);
  assert.ok(relaySnaps.length >= 1, 'a launch snapshot was flushed for the direct turn');
  assert.strictEqual(relaySnaps[relaySnaps.length - 1].transport, 'session-provider', 'direct turn records the session-provider transport');
  const relayFlushed = JSON.parse(relaySnaps[relaySnaps.length - 1].snapshot);
  console.log(`flushed coding-agent snapshot: agent=${relayFlushed.agent} connection=${relayFlushed.runtime_connection_id} default=${relayFlushed.default_workspace}`);
  assert.strictEqual(relayFlushed.agent, 'codex', 'flushed direct snapshot carries agent=codex');
  assert.strictEqual(relayFlushed.runtime_connection_id, connectionId, 'flushed direct snapshot carries the runtime connection');
  assert.strictEqual(relayFlushed.default_workspace, workdir, 'flushed direct snapshot carries the default workspace');
  console.log('PASS: direct snapshot assertion: flushed snapshot carries the agent, connection, and default workspace');
  passed += 1;

  // Unconfigured row: cannot launch until locally configured; the thread
  // names the gap and the flushed snapshot records the null connection.
  const turnsBefore = providerTurns();
  const migrated = db.bots.create({ name: 'Migrated', title: 'Migrated', description: 'Migrated legacy row.', agent: 'codex' });
  db.default.prepare('UPDATE bots SET runtime_connection_id = NULL WHERE id = ?').run(migrated.id);
  const migratedConv = db.conversations.getByBotId(migrated.id);
  db.messages.create(migratedConv.id, 'user', 'Build the widget.');
  jiti('../lib/ui-turns.ts').uiTurns.enqueue(migratedConv.id, migrated.id);
  processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.strictEqual(providerTurns(), turnsBefore, 'unconfigured row launches no provider turn');
  const migratedThread = db.messages.getByConversation(migratedConv.id).filter(m => m.sender_type === 'bot');
  assert.ok(migratedThread.some(m => m.content.startsWith('[Agent unavailable] Migrated') && m.content.includes('no runtime connection')),
    `unconfigured row posts the missing-connection notice (got ${migratedThread.map(m => m.content).join(' | ')})`);
  const migratedSnaps = db.launchSnapshots.listByBot(migrated.id);
  assert.ok(migratedSnaps.length >= 1, 'a launch snapshot was flushed for the unconfigured row');
  const migratedFlushed = JSON.parse(migratedSnaps[migratedSnaps.length - 1].snapshot);
  console.log(`flushed unconfigured snapshot: agent=${migratedFlushed.agent} connection=${migratedFlushed.runtime_connection_id}`);
  assert.strictEqual(migratedFlushed.agent, 'codex', 'unconfigured snapshot keeps agent=codex');
  assert.strictEqual(migratedFlushed.runtime_connection_id, null, 'unconfigured snapshot records the null connection');
  console.log('PASS: unconfigured-row assertion: no launch, visible notice, snapshot records the null connection');
  passed += 1;

  agent.setDelegationChatStub(null);
  agent.resetDelegationForTests();
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(STATE, { force: true }); } catch { /* best effort */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
  console.log(`\ntest:snapshot: ${passed} assertions passing`);
}

main().catch(error => {
  console.error(`FAIL: snapshot test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
