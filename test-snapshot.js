#!/usr/bin/env node
// Targeted test for the launch-snapshot hash (NOT-394).
// Proves: identical config yields an identical hash; one changed rule yields
// a different hash. Exercises the real lib/snapshot.js used by the app.

const assert = require('node:assert');
const { buildSnapshotInput, canonicalJson, hashSnapshot, withDeckLaunch } = require('./lib/snapshot');

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
  'coding_runtime',
  'deck_name',
  'description',
  'import_operation_id',
  'import_schema_version',
  'memories',
  'name',
  'persistent_runtime',
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

// 4. Remembered facts are part of the input: same facts give the same hash,
// a changed fact gives a different hash, and unread facts (null) differ
// from read-but-empty ([]) so early-return launches stay distinguishable.
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

// 5. NOT-433: the immutable snapshot contains the effective persistent
// runtime, coding runtime, deck name, and working directory used for the
// launch. A legacy bot (no path keys at all) records Hermes with null
// coding fields: explicitly unconfigured, never invented.
const legacyInput = buildSnapshotInput(bot(), skill());
assert.strictEqual(legacyInput.persistent_runtime, 'hermes', 'legacy snapshot must default the persistent runtime to hermes');
console.log('PASS: snapshot-field assertion: persistent_runtime defaults to hermes for legacy bots');
passed += 1;

assert.strictEqual(legacyInput.coding_runtime, null, 'legacy snapshot must not invent a coding runtime');
console.log('PASS: snapshot-field assertion: coding_runtime is null for legacy bots');
passed += 1;

assert.strictEqual(legacyInput.deck_name, null, 'legacy snapshot must not invent a deck name');
assert.strictEqual(legacyInput.working_directory, null, 'legacy snapshot must not invent a working directory');
console.log('PASS: snapshot-field assertion: deck_name and working_directory are null for legacy bots');
passed += 1;

// A configured bot records the resolved path verbatim, and a changed deck
// changes the hash, so past launches remain inspectable.
const configuredInput = buildSnapshotInput(
  bot({ persistent_runtime: 'hermes', coding_runtime: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/relay-work' }),
  skill()
);
assert.strictEqual(configuredInput.persistent_runtime, 'hermes', 'snapshot must record the effective persistent runtime');
assert.strictEqual(configuredInput.coding_runtime, 'codex', 'snapshot must record the coding runtime');
assert.strictEqual(configuredInput.deck_name, 'relay-deck', 'snapshot must record the deck name');
assert.strictEqual(configuredInput.working_directory, '/tmp/relay-work', 'snapshot must record the working directory');
assert.notStrictEqual(hashSnapshot(legacyInput), hashSnapshot(configuredInput), 'coding path must be part of the hashed input');
const redecked = buildSnapshotInput(
  bot({ persistent_runtime: 'hermes', coding_runtime: 'codex', deck_name: 'other-deck', working_directory: '/tmp/relay-work' }),
  skill()
);
assert.notStrictEqual(hashSnapshot(configuredInput), hashSnapshot(redecked), 'a changed deck must change the hash');
console.log('PASS: snapshot-field assertion: configured path round-trips and changes the launch hash');
passed += 1;

// 6. NOT-433 repair: withDeckLaunch records the EFFECTIVE launch values,
// not the stored configuration. A bot stored as codex/relay-deck/
// tmp/relay-work whose turn actually runs claude on another deck/cwd
// snapshots claude/other-deck//tmp/other-work; the persistent runtime
// and all non-coding fields pass through untouched.
const storedInput = buildSnapshotInput(
  bot({ persistent_runtime: 'hermes', coding_runtime: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/relay-work' }),
  skill()
);
const effectiveInput = withDeckLaunch(storedInput, {
  coding_runtime: 'claude',
  deck_name: 'other-deck',
  working_directory: '/tmp/other-work',
});
assert.strictEqual(effectiveInput.coding_runtime, 'claude', 'effective coding runtime must win over the stored path');
assert.strictEqual(effectiveInput.deck_name, 'other-deck', 'effective deck must win over the stored path');
assert.strictEqual(effectiveInput.working_directory, '/tmp/other-work', 'effective working directory must win over the stored path');
console.log('PASS: snapshot-field assertion: effective deck-launch runtime, deck, and working directory win over the stored path');
passed += 1;

assert.strictEqual(effectiveInput.persistent_runtime, 'hermes', 'persistent runtime must pass through the deck-launch overlay');
assert.strictEqual(effectiveInput.name, 'Alice', 'identity fields must pass through the deck-launch overlay');
assert.notStrictEqual(hashSnapshot(storedInput), hashSnapshot(effectiveInput), 'effective values must change the launch hash');
console.log('PASS: snapshot-field assertion: persistent runtime and identity pass through while the launch hash changes');
passed += 1;

// 7. Loop integration: a bot STORED as codex/relay-deck//tmp/relay-work
// whose DECK turn actually runs claude on another deck/cwd flushes a
// snapshot with the effective values. Exercises the real queue loop,
// the stub model, and the agent-deck process seam; no network, no key.
async function main() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const DB_PATH = path.join(os.tmpdir(), `botmancers-snapshot-deck-test-${process.pid}.db`);
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
  }
  process.env.BOTMANCERS_DB_PATH = DB_PATH;
  process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
  delete process.env.OPENAI_API_KEY;

  const { createJiti } = require('jiti');
  const jiti = createJiti(__filename);
  const db = jiti('./lib/db.ts');
  const agent = jiti('./lib/agent.ts');
  const deckRun = jiti('./lib/agent-deck-run.ts');

  const botRow = db.bots.create({
    name: 'Relay',
    title: 'Coding Relay',
    description: 'Relays implementation work to a local coding agent.',
    persistent_runtime: 'hermes',
    coding_runtime: 'codex',
    deck_name: 'relay-deck',
    working_directory: '/tmp/relay-work',
  });
  const conv = db.conversations.getByBotId(botRow.id);
  assert.ok(conv, 'relay thread exists');

  // The actual launch runs elsewhere: another deck assignment, another cwd.
  const deckCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-snap-cwd-'));
  fs.mkdirSync(path.join(deckCwd, '.agent-deck'), { recursive: true });
  fs.writeFileSync(
    path.join(deckCwd, '.agent-deck', 'use.json'),
    JSON.stringify({ version: 3, deckId: 'actual-deck-id', deckName: 'actual-deck' })
  );
  process.env.BOTMANCERS_DECK_CWD = deckCwd;

  let runs = 0;
  deckRun.setDeckRunProcess(async argv => {
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'status') {
      const runId = argv[3];
      const sessionId = runId === 'run-deck-2' ? `ses-for-${runId}` : 'ses-deck-impl';
      return {
        stdout: JSON.stringify({
          runId, deck: 'actual-deck-id', client: 'claude', state: 'ended', sessionId,
          startedAt: '2026-10-12T00:00:00.000Z', lastLogTs: '2026-10-12T00:01:00.000Z',
          logPath: `/tmp/fake-deck/${runId}/run.jsonl`,
        }),
        stderr: '', exitCode: 0,
      };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run' && argv[2] === 'log') {
      const runId = argv[3];
      const body = runId === 'run-deck-2' ? 'review says: looks good' : `output of ${runId}`;
      const lines = [
        JSON.stringify({ t: 'text', ts: '2026-10-12T00:00:30.000Z', text: 'working' }),
        JSON.stringify({ t: 'result', sessionId: `ses-for-${runId}`, subtype: 'success', result: body }),
        JSON.stringify({ t: 'end', sessionId: `ses-for-${runId}` }),
      ].join('\n') + '\n';
      return { stdout: lines, stderr: '', exitCode: 0 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === 'run') {
      runs += 1;
      const runId = `run-deck-${runs}`;
      return { stdout: `run ${runId} detached: pid 4242 log /tmp/fake-deck/${runId}/run.jsonl\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected command: ${argv.join(' ')}`, exitCode: 1 };
  });

  // The directive runtime (claude) deliberately differs from the stored
  // coding runtime (codex): the snapshot must record what ran.
  agent.setDelegationChatStub(() => 'DECK claude: Implement the widget.');
  db.messages.create(conv.id, 'user', 'Build the widget through the coding agent.');
  db.queue.enqueue(conv.id, botRow.id);
  let processed = 0;
  while (processed < 40 && await agent.processNextQueueItem()) {
    processed += 1;
  }

  delete process.env.BOTMANCERS_DECK_CWD;
  deckRun.setDeckRunProcess(null);
  agent.setDelegationChatStub(null);
  agent.resetDelegationForTests();

  const rows = db.launchSnapshots.listByBot(botRow.id);
  assert.ok(rows.length >= 1, 'a launch snapshot was flushed for the deck turn');
  const flushed = JSON.parse(rows[rows.length - 1].snapshot);
  console.log(`flushed snapshot coding path: persistent_runtime=${flushed.persistent_runtime} coding_runtime=${flushed.coding_runtime} deck_name=${flushed.deck_name} working_directory=${flushed.working_directory}`);
  assert.strictEqual(flushed.persistent_runtime, 'hermes', 'flushed snapshot must carry the effective persistent runtime');
  console.log('PASS: snapshot-field assertion: flushed snapshot carries the effective persistent runtime');
  passed += 1;

  assert.strictEqual(flushed.coding_runtime, 'claude', 'flushed snapshot must carry the directive runtime, not the stored codex path');
  assert.strictEqual(flushed.deck_name, 'actual-deck-id', 'flushed snapshot must carry the resolved deck, not the stored relay-deck path');
  assert.strictEqual(flushed.working_directory, deckCwd, 'flushed snapshot must carry the resolved cwd, not the stored path');
  console.log('PASS: snapshot-field assertion: flushed snapshot carries the effective coding runtime, deck, and working directory used for the launch');
  passed += 1;

  try { fs.rmSync(deckCwd, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
  console.log(`\ntest:snapshot: ${passed}/12 assertions passing`);
}

main().catch(error => {
  console.error(`FAIL: deck-launch snapshot integration threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
