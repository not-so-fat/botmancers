#!/usr/bin/env node
// NOT-442: single-runtime launch-snapshot test (deterministic, no network).
// Proves: identical config yields an identical hash; the snapshot carries
// the single selected runtime plus the resolved Agent Deck client, deck ID,
// and effective working directory only when applicable; a migrated row
// records its unresolved legacy reference with a null deck ID and the
// needs-reselection marker; loop integration flushes Hermes and Agent Deck
// snapshots with the transport that actually ran.

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
  'agent_client',
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
  'needs_deck_reselection',
  'runtime',
  'skill_content',
  'skill_path',
  'skill_present',
  'source_provider',
  'template_id',
  'template_url',
  'title',
  'working_directory',
]);
console.log('PASS: hash is stable under key reordering with sorted canonical keys');
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

// 5. NOT-442 Hermes snapshot: the single selected runtime is hermes and
// every Agent Deck field is null (only applicable for agent-deck bots).
const hermesInput = buildSnapshotInput(bot({ runtime: 'hermes' }), skill());
assert.strictEqual(hermesInput.runtime, 'hermes', 'Hermes snapshot must record runtime=hermes');
console.log('PASS: Hermes snapshot assertion: runtime is hermes');
passed += 1;
assert.strictEqual(hermesInput.agent_client, null, 'Hermes snapshot must not carry an agent client');
assert.strictEqual(hermesInput.deck_id, null, 'Hermes snapshot must not carry a deck ID');
assert.strictEqual(hermesInput.working_directory, null, 'Hermes snapshot must not carry a working directory');
assert.strictEqual(hermesInput.needs_deck_reselection, false, 'Hermes snapshot never needs re-selection');
console.log('PASS: Hermes snapshot assertion: agent client, deck ID, and working directory are null');
passed += 1;

// 6. NOT-442 Agent Deck snapshot: the resolved client, deck ID, and
// effective working directory round-trip and change the launch hash.
const deckInput = buildSnapshotInput(
  bot({ runtime: 'agent-deck', agent_client: 'codex', deck_id: 'deck-123', working_directory: '/tmp/relay-work' }),
  skill()
);
assert.strictEqual(deckInput.runtime, 'agent-deck', 'snapshot must record runtime=agent-deck');
assert.strictEqual(deckInput.agent_client, 'codex', 'snapshot must record the resolved agent client');
assert.strictEqual(deckInput.deck_id, 'deck-123', 'snapshot must record the resolved deck ID');
assert.strictEqual(deckInput.working_directory, '/tmp/relay-work', 'snapshot must record the effective working directory');
assert.notStrictEqual(hashSnapshot(hermesInput), hashSnapshot(deckInput), 'runtime must be part of the hashed input');
const redecked = buildSnapshotInput(
  bot({ runtime: 'agent-deck', agent_client: 'codex', deck_id: 'deck-999', working_directory: '/tmp/relay-work' }),
  skill()
);
assert.notStrictEqual(hashSnapshot(deckInput), hashSnapshot(redecked), 'a changed deck ID must change the hash');
console.log('PASS: Agent Deck snapshot assertion: resolved client, deck ID, and working directory round-trip and change the launch hash');
passed += 1;

// 7. NOT-442 migrated-row assertion: the legacy free-text deck name is
// preserved only as an unresolved reference with a null deck ID and the
// needs-reselection marker.
const migratedInput = buildSnapshotInput(
  bot({ runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/relay-work', needs_deck_reselection: 1 }),
  skill()
);
assert.strictEqual(migratedInput.runtime, 'agent-deck', 'migrated snapshot keeps runtime=agent-deck');
assert.strictEqual(migratedInput.deck_name, 'relay-deck', 'migrated snapshot preserves the legacy deck name as an unresolved reference');
assert.strictEqual(migratedInput.deck_id, null, 'migrated snapshot stores no deck ID');
assert.strictEqual(migratedInput.needs_deck_reselection, true, 'migrated snapshot is marked as needing deck re-selection');
console.log('PASS: migrated-row assertion: legacy deck name preserved as unresolved reference with null deck ID and needs-reselection');
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
    runtime: 'hermes',
    agent_client: null,
    deck_id: null,
    deck_name: null,
    working_directory: null,
    needs_deck_reselection: 0,
  });
  const heraldConv = db.conversations.getByBotId(herald.id);
  assert.ok(heraldConv, 'herald thread exists');
  db.messages.create(heraldConv.id, 'user', 'Hello Herald.');
  db.queue.enqueue(heraldConv.id, herald.id);
  let processed = 0;
  while (processed < 20 && await agent.processNextQueueItem()) processed += 1;
  assert.strictEqual(hermesStubCalls, 1, 'Hermes direct-dispatch assertion: ordinary Hermes message uses the Hermes session');
  assert.strictEqual(deckCallsDuringHermes, 0, 'Hermes direct-dispatch assertion: opposite adapter (agent-deck) was not invoked');
  console.log('PASS: Hermes direct-dispatch assertion: ordinary message uses the Hermes session, agent-deck adapter not invoked');
  passed += 1;
  const heraldSnaps = db.launchSnapshots.listByBot(herald.id);
  assert.ok(heraldSnaps.length >= 1, 'a launch snapshot was flushed for the Hermes turn');
  assert.strictEqual(heraldSnaps[heraldSnaps.length - 1].transport, 'hermes-gateway', 'Hermes turn records the hermes-gateway transport');
  const heraldFlushed = JSON.parse(heraldSnaps[heraldSnaps.length - 1].snapshot);
  console.log(`flushed Hermes snapshot: runtime=${heraldFlushed.runtime} agent_client=${heraldFlushed.agent_client} deck_id=${heraldFlushed.deck_id} working_directory=${heraldFlushed.working_directory}`);
  assert.strictEqual(heraldFlushed.runtime, 'hermes', 'flushed Hermes snapshot carries runtime=hermes');
  assert.strictEqual(heraldFlushed.agent_client, null, 'flushed Hermes snapshot carries no agent client');
  console.log('PASS: Hermes snapshot assertion: flushed snapshot carries the single selected runtime with no deck fields');
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
    runtime: 'agent-deck',
    agent_client: 'codex',
    deck_id: 'deck-123',
    deck_name: null,
    working_directory: workdir,
    needs_deck_reselection: 0,
  });
  const relayConv = db.conversations.getByBotId(relay.id);
  assert.ok(relayConv, 'relay thread exists');
  db.messages.create(relayConv.id, 'user', 'Build the widget.');
  db.queue.enqueue(relayConv.id, relay.id);
  processed = 0;
  while (processed < 20 && await agent.processNextQueueItem()) processed += 1;
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
  console.log(`flushed Agent Deck snapshot: runtime=${relayFlushed.runtime} agent_client=${relayFlushed.agent_client} deck_id=${relayFlushed.deck_id} working_directory=${relayFlushed.working_directory}`);
  assert.strictEqual(relayFlushed.runtime, 'agent-deck', 'flushed deck snapshot carries runtime=agent-deck');
  assert.strictEqual(relayFlushed.agent_client, 'codex', 'flushed deck snapshot carries the resolved client');
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
    runtime: 'agent-deck',
    agent_client: 'codex',
    deck_id: null,
    deck_name: 'relay-deck',
    working_directory: workdir,
    needs_deck_reselection: 1,
  });
  const migratedConv = db.conversations.getByBotId(migrated.id);
  db.messages.create(migratedConv.id, 'user', 'Build the widget.');
  db.queue.enqueue(migratedConv.id, migrated.id);
  processed = 0;
  while (processed < 20 && await agent.processNextQueueItem()) processed += 1;
  const migratedSnaps = db.launchSnapshots.listByBot(migrated.id);
  assert.ok(migratedSnaps.length >= 1, 'a launch snapshot was flushed for the migrated row');
  const migratedFlushed = JSON.parse(migratedSnaps[migratedSnaps.length - 1].snapshot);
  console.log(`flushed migrated snapshot: runtime=${migratedFlushed.runtime} deck_name=${migratedFlushed.deck_name} deck_id=${migratedFlushed.deck_id} needs_deck_reselection=${migratedFlushed.needs_deck_reselection}`);
  assert.strictEqual(migratedFlushed.deck_name, 'relay-deck', 'migrated snapshot preserves the legacy name');
  assert.strictEqual(migratedFlushed.deck_id, null, 'migrated snapshot stores no deck ID');
  assert.strictEqual(migratedFlushed.needs_deck_reselection, true, 'migrated snapshot keeps the needs-reselection marker');
  console.log('PASS: migrated-row assertion: flushed snapshot preserves the unresolved reference with null deck ID and needs-reselection');
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
