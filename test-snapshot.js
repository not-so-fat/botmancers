#!/usr/bin/env node
// Targeted test for the launch-snapshot hash (NOT-394).
// Proves: identical config yields an identical hash; one changed rule yields
// a different hash. Exercises the real lib/snapshot.js used by the app.

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

console.log(`\ntest:snapshot: ${passed}/8 assertions passing`);
