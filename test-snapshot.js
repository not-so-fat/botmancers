#!/usr/bin/env node
// NOT-442/NOT-456: agent + Agent Deck launch-snapshot test
// (deterministic, no network). Proves: identical config yields an
// identical hash; the snapshot carries one agent identity plus its Agent
// Deck selection (deck ID, effective working directory) for every agent,
// Hermes included, and no runtime field; a migrated row records its
// unresolved legacy reference with a null deck ID and the
// needs-deck-selection marker; loop integration flushes Hermes and
// coding-agent snapshots with the transport that actually ran.

const assert = require('node:assert');
const { buildSnapshotInput, canonicalJson, hashSnapshot } = require('./lib/snapshot');

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
  'deck_id',
  'deck_name',
  'description',
  'import_operation_id',
  'import_schema_version',
  'memories',
  'name',
  'needs_deck_selection',
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
console.log('PASS: hash is stable under key reordering with sorted canonical keys (agent, no runtime)');
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

// 5. NOT-456 Hermes snapshot: Hermes is an agent with the same Agent
// Deck selection as every other agent.
const hermesInput = buildSnapshotInput(bot({ agent: 'hermes', deck_id: 'deck-123', working_directory: '/tmp/hermes-work' }), skill());
assert.strictEqual(hermesInput.agent, 'hermes', 'Hermes snapshot must record agent=hermes');
assert.strictEqual(hermesInput.deck_id, 'deck-123', 'Hermes snapshot records its selected deck ID');
assert.strictEqual(hermesInput.working_directory, '/tmp/hermes-work', 'Hermes snapshot records its working directory');
assert.strictEqual(hermesInput.needs_deck_selection, false, 'Hermes with a deck does not need selection');
assert.strictEqual(buildSnapshotInput(bot(), skill()).agent, 'hermes', 'missing agent reads as hermes');
console.log('PASS: Hermes snapshot assertion: agent=hermes with its deck ID and working directory');
passed += 1;

// 6. Coding-agent snapshot: agent, deck ID, and effective working
// directory round-trip and change the launch hash.
const deckInput = buildSnapshotInput(
  bot({ agent: 'codex', deck_id: 'deck-123', working_directory: '/tmp/hermes-work' }),
  skill()
);
assert.strictEqual(deckInput.agent, 'codex', 'snapshot must record agent=codex');
assert.strictEqual(deckInput.deck_id, 'deck-123', 'snapshot must record the resolved deck ID');
assert.notStrictEqual(hashSnapshot(hermesInput), hashSnapshot(deckInput), 'agent must be part of the hashed input');
const redecked = buildSnapshotInput(
  bot({ agent: 'codex', deck_id: 'deck-999', working_directory: '/tmp/hermes-work' }),
  skill()
);
assert.notStrictEqual(hashSnapshot(deckInput), hashSnapshot(redecked), 'a changed deck ID must change the hash');
console.log('PASS: coding-agent snapshot assertion: agent, deck ID, and working directory round-trip and change the launch hash');
passed += 1;

// 7. Migrated-row assertion: the legacy free-text deck name is preserved
// only as an unresolved reference with a null deck ID and the
// needs-deck-selection marker.
const migratedInput = buildSnapshotInput(
  bot({ agent: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/relay-work', needs_deck_selection: 1 }),
  skill()
);
assert.strictEqual(migratedInput.agent, 'codex', 'migrated snapshot keeps agent=codex');
assert.strictEqual(migratedInput.deck_name, 'relay-deck', 'migrated snapshot preserves the legacy deck name as an unresolved reference');
assert.strictEqual(migratedInput.deck_id, null, 'migrated snapshot stores no deck ID');
assert.strictEqual(migratedInput.needs_deck_selection, true, 'migrated snapshot is marked as needing deck selection');
const noDeck = buildSnapshotInput(bot({ agent: 'hermes' }), skill());
assert.strictEqual(noDeck.needs_deck_selection, true, 'a row without a deck ID always needs selection');
console.log('PASS: migrated-row assertion: legacy deck name preserved as unresolved reference with null deck ID and needs-deck-selection');
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

// 9. Loop integration: an ordinary Hermes turn and an ordinary Agent Deck
// turn flush snapshots that describe what actually ran. Exercises the real
// queue loop with the stub model and the agent-deck process seam; no
// network, no key, no DECK directive parsed.
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
  const db = jiti('./lib/db.ts');
  const agent = jiti('./lib/agent.ts');
  const deckRun = jiti('./lib/agent-deck-run.ts');

  // Hermes direct dispatch: ordinary message uses the Hermes session path
  // (here the deterministic stub) and never touches the deck adapter.
  let hermesStubCalls = 0;
  let deckCallsDuringHermes = 0;
  deckRun.setDeckRunProcess(async () => {
    deckCallsDuringHermes += 1;
    return { stdout: '', stderr: 'must not launch deck for Hermes turn', exitCode: 1 };
  });
  agent.setDelegationChatStub(() => {
    hermesStubCalls += 1;
    return 'Hello from the Hermes session.';
  });
  const herald = db.bots.create({
    name: 'Herald',
    title: 'Herald',
    description: 'Answers directly.',
    agent: 'hermes',
    deck_id: 'deck-herald',
    deck_name: null,
    working_directory: null,
  });
  const heraldConv = db.conversations.getByBotId(herald.id);
  assert.ok(heraldConv, 'herald thread exists');
  db.messages.create(heraldConv.id, 'user', 'Hello Herald.');
  jiti('./lib/ui-turns.ts').uiTurns.enqueue(heraldConv.id, herald.id);
  let processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.strictEqual(hermesStubCalls, 1, 'Hermes direct-dispatch assertion: ordinary Hermes message uses the Hermes session');
  assert.strictEqual(deckCallsDuringHermes, 0, 'Hermes direct-dispatch assertion: opposite adapter (agent-deck) was not invoked');
  console.log('PASS: Hermes direct-dispatch assertion: ordinary message uses the Hermes session, agent-deck adapter not invoked');
  passed += 1;
  const heraldSnaps = db.launchSnapshots.listByBot(herald.id);
  assert.ok(heraldSnaps.length >= 1, 'a launch snapshot was flushed for the Hermes turn');
  assert.strictEqual(heraldSnaps[heraldSnaps.length - 1].transport, 'hermes-gateway', 'Hermes turn records the hermes-gateway transport');
  const heraldFlushed = JSON.parse(heraldSnaps[heraldSnaps.length - 1].snapshot);
  console.log(`flushed Hermes snapshot: agent=${heraldFlushed.agent} deck_id=${heraldFlushed.deck_id} working_directory=${heraldFlushed.working_directory}`);
  assert.strictEqual(heraldFlushed.agent, 'hermes', 'flushed Hermes snapshot carries agent=hermes');
  assert.strictEqual(heraldFlushed.deck_id, 'deck-herald', 'flushed Hermes snapshot carries its selected deck');
  assert.ok(!('runtime' in heraldFlushed), 'flushed Hermes snapshot has no runtime field');
  console.log('PASS: Hermes snapshot assertion: flushed snapshot carries agent=hermes plus its Agent Deck selection');
  passed += 1;

  // Agent Deck direct dispatch: ordinary message launches the stored
  // agent/deck/workdir directly without waiting for a DECK directive.
  agent.setDelegationChatStub(() => {
    throw new Error('Hermes adapter must not run for an agent-deck turn');
  });
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-snap-deck-'));
  let launched = null;
  let runCounter = 0;
  deckRun.setDeckRunProcess(async argv => {
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      return {
        stdout: JSON.stringify({ runId, deck: 'deck-123', client: 'codex', state: 'ended', sessionId: `ses-for-${runId}`, logPath: `/tmp/fake/${runId}.jsonl` }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const lines = [
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, result: `output of ${runId}` }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      runCounter += 1;
      launched = argv.slice();
      const runId = `run-deck-${runCounter}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected: ${argv.join(' ')}`, exitCode: 1 };
  });
  const relay = db.bots.create({
    name: 'Relay',
    title: 'Coding Relay',
    description: 'Launches directly.',
    agent: 'codex',
    deck_id: 'deck-123',
    deck_name: null,
    working_directory: workdir,
  });
  const relayConv = db.conversations.getByBotId(relay.id);
  assert.ok(relayConv, 'relay thread exists');
  db.messages.create(relayConv.id, 'user', 'Build the widget.');
  jiti('./lib/ui-turns.ts').uiTurns.enqueue(relayConv.id, relay.id);
  processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.ok(launched, 'Agent Deck direct-dispatch assertion: ordinary message launches the stored deck run');
  const flag = (argv, name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  assert.strictEqual(flag(launched, '--client'), 'codex', 'Agent Deck launch uses the stored agent client');
  assert.strictEqual(launched[2], 'deck-123', 'Agent Deck launch uses the stored deck ID');
  assert.strictEqual(flag(launched, '--cwd'), workdir, 'Agent Deck launch uses the stored working-directory override');
  console.log(`Agent Deck direct dispatch: client=${flag(launched, '--client')} deck=${launched[2]} cwd=${flag(launched, '--cwd')} (no DECK directive parsed)`);
  console.log('PASS: Agent Deck direct-dispatch assertion: ordinary message launches the stored agent/deck/workdir, Hermes adapter not invoked');
  passed += 1;
  const relaySnaps = db.launchSnapshots.listByBot(relay.id);
  assert.ok(relaySnaps.length >= 1, 'a launch snapshot was flushed for the deck turn');
  assert.strictEqual(relaySnaps[relaySnaps.length - 1].transport, 'agent-deck', 'deck turn records the agent-deck transport');
  const relayFlushed = JSON.parse(relaySnaps[relaySnaps.length - 1].snapshot);
  console.log(`flushed coding-agent snapshot: agent=${relayFlushed.agent} deck_id=${relayFlushed.deck_id} working_directory=${relayFlushed.working_directory}`);
  assert.strictEqual(relayFlushed.agent, 'codex', 'flushed deck snapshot carries agent=codex');
  assert.strictEqual(relayFlushed.deck_id, 'deck-123', 'flushed deck snapshot carries the resolved deck ID');
  assert.strictEqual(relayFlushed.working_directory, workdir, 'flushed deck snapshot carries the effective working directory');
  console.log('PASS: Agent Deck snapshot assertion: flushed snapshot carries the resolved client, deck ID, and working directory');
  passed += 1;

  // Migrated row: cannot launch until re-selection; the flushed snapshot
  // keeps the unresolved reference with a null deck ID and the marker.
  const migrated = db.bots.create({
    name: 'Migrated',
    title: 'Migrated',
    description: 'Migrated legacy row.',
    agent: 'codex',
    deck_id: null,
    deck_name: 'relay-deck',
    working_directory: workdir,
  });
  const migratedConv = db.conversations.getByBotId(migrated.id);
  db.messages.create(migratedConv.id, 'user', 'Build the widget.');
  jiti('./lib/ui-turns.ts').uiTurns.enqueue(migratedConv.id, migrated.id);
  processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  const migratedSnaps = db.launchSnapshots.listByBot(migrated.id);
  assert.ok(migratedSnaps.length >= 1, 'a launch snapshot was flushed for the migrated row');
  const migratedFlushed = JSON.parse(migratedSnaps[migratedSnaps.length - 1].snapshot);
  console.log(`flushed migrated snapshot: agent=${migratedFlushed.agent} deck_name=${migratedFlushed.deck_name} deck_id=${migratedFlushed.deck_id} needs_deck_selection=${migratedFlushed.needs_deck_selection}`);
  assert.strictEqual(migratedFlushed.deck_name, 'relay-deck', 'migrated snapshot preserves the legacy name');
  assert.strictEqual(migratedFlushed.deck_id, null, 'migrated snapshot stores no deck ID');
  assert.strictEqual(migratedFlushed.needs_deck_selection, true, 'migrated snapshot keeps the needs-deck-selection marker');
  console.log('PASS: migrated-row assertion: flushed snapshot preserves the unresolved reference with null deck ID and needs-deck-selection');
  passed += 1;

  // NOT-456: a Hermes agent without a selected deck cannot launch either:
  // the Hermes adapter is never called and the thread names the gap.
  let unresolvedHermesCalls = 0;
  agent.setDelegationChatStub(() => {
    unresolvedHermesCalls += 1;
    return 'must not run';
  });
  const pendingHermes = db.bots.create({ name: 'PendingHermes', title: '', description: 'No deck yet.', agent: 'hermes' });
  const pendingConv = db.conversations.getByBotId(pendingHermes.id);
  db.messages.create(pendingConv.id, 'user', 'Hello?');
  jiti('./lib/ui-turns.ts').uiTurns.enqueue(pendingConv.id, pendingHermes.id);
  processed = 0;
  while (processed < 20 && await agent.processNextUiTurn()) processed += 1;
  assert.strictEqual(unresolvedHermesCalls, 0, 'Hermes without a deck never reaches the Hermes adapter');
  const pendingThread = db.messages.getByConversation(pendingConv.id);
  assert.ok(pendingThread.some(m => m.sender_type === 'bot' && m.content.startsWith('[Deck needs selection] PendingHermes')), 'Hermes without a deck posts the needs-selection notice');
  const pendingSnaps = db.launchSnapshots.listByBot(pendingHermes.id);
  const pendingFlushed = JSON.parse(pendingSnaps[pendingSnaps.length - 1].snapshot);
  assert.strictEqual(pendingFlushed.agent, 'hermes', 'unlaunched Hermes snapshot records agent=hermes');
  assert.strictEqual(pendingFlushed.needs_deck_selection, true, 'unlaunched Hermes snapshot records needs_deck_selection');
  console.log('PASS: unresolved Hermes assertion: no deck selected -> no launch, visible notice, snapshot marks needs_deck_selection');
  passed += 1;

  deckRun.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);
  agent.resetDelegationForTests();
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
  console.log(`\ntest:snapshot: ${passed} assertions passing`);
}

main().catch(error => {
  console.error(`FAIL: snapshot test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
