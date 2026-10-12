#!/usr/bin/env node
// NOT-433: bot-definition contract test (deterministic, no network).
//
// Proves: a bot round-trips Hermes plus a validated Agent Deck coding path;
// unknown coding runtimes and launchable bots missing deck/working-directory
// are rejected with the API errors the routes return; pre-migration rows
// read back without invented values and report unconfigured; the
// availability payload lists only probe-ready runtimes.
//
// Self-contained: isolated SQLite file, injected process seam at the
// agent-deck process boundary. No dev server (loopback listen() is
// unavailable in this sandbox), no API key, no real runs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.tmpdir(), `botmancers-bot-definition-test-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('./lib/db.ts');
const def = jiti('./lib/bot-definition.ts');
const deck = jiti('./lib/agent-deck-run.ts');

let failures = 0;

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ''}`);
}

function check(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail);
}

// --- Criterion 1: create and read a bot with Hermes + a full coding path.
const created = db.bots.create({
  name: 'Relay',
  title: 'Coding Relay',
  description: 'Relays implementation work to a local coding agent.',
  persistent_runtime: 'hermes',
  coding_runtime: 'codex',
  deck_name: 'relay-deck',
  working_directory: '/tmp/relay-work',
});
console.log(`saved bot fields: persistent_runtime=${created.persistent_runtime} coding_runtime=${created.coding_runtime} deck_name=${created.deck_name} working_directory=${created.working_directory}`);
check('create persists the Hermes persistent runtime', created.persistent_runtime === 'hermes', JSON.stringify(created.persistent_runtime));

const readBack = db.bots.getById(created.id);
console.log(`read-back bot fields: persistent_runtime=${readBack.persistent_runtime} coding_runtime=${readBack.coding_runtime} deck_name=${readBack.deck_name} working_directory=${readBack.working_directory}`);
check(
  'read-back bot carries the codex|claude|cursor|muse coding path',
  readBack.coding_runtime === 'codex' && readBack.deck_name === 'relay-deck' && readBack.working_directory === '/tmp/relay-work',
  JSON.stringify({ coding_runtime: readBack.coding_runtime, deck_name: readBack.deck_name, working_directory: readBack.working_directory })
);
const serialized = def.serializeBot(readBack);
check('serialized bot reports its coding path as configured', serialized.coding_configured === true && serialized.coding_path.configured === true);
check('coding enum matches the NOT-395 adapter runtimes', JSON.stringify(def.CODING_RUNTIMES) === JSON.stringify(deck.DECK_RUNTIMES));

// --- Criterion 2: validation rejects bad input with the API errors.
const unknownRuntime = def.validateCreateRuntimePath({
  name: 'Bad', launchable: true, coding_runtime: 'watson', deck_name: 'd', working_directory: '/tmp/w',
});
console.log(`validation case unknown-coding-runtime: expected API error: ${unknownRuntime.errors[0]}`);
check(
  'unknown coding runtime is rejected',
  unknownRuntime.errors.length > 0 && /Invalid coding runtime/.test(unknownRuntime.errors[0]) && /codex\|claude\|cursor\|muse/.test(unknownRuntime.errors[0]),
  JSON.stringify(unknownRuntime.errors)
);

const missingDeck = def.validateCreateRuntimePath({
  name: 'NoDeck', launchable: true, coding_runtime: 'claude', working_directory: '/tmp/w',
});
console.log(`validation case launchable-missing-deck: expected API error: ${missingDeck.errors[0]}`);
check(
  'launchable bot with a missing deck name is rejected',
  missingDeck.errors.some(e => e === 'Deck name is required for a launchable bot.'),
  JSON.stringify(missingDeck.errors)
);

const missingCwd = def.validateCreateRuntimePath({
  name: 'NoCwd', launchable: true, coding_runtime: 'cursor', deck_name: 'd',
});
console.log(`validation case launchable-missing-working-directory: expected API error: ${missingCwd.errors[0]}`);
check(
  'launchable bot with a missing working directory is rejected',
  missingCwd.errors.some(e => e === 'Working directory is required for a launchable bot.'),
  JSON.stringify(missingCwd.errors)
);

// A non-launchable manual create without a coding path stays acceptable.
const draft = def.validateCreateRuntimePath({ name: 'Draft' });
check('non-launchable create without a coding path has no errors', draft.errors.length === 0, JSON.stringify(draft.errors));

// PATCH contract: unknown runtime rejected, blanks clear to unconfigured.
const badUpdate = def.validateUpdateRuntimePath({ coding_runtime: 'watson' });
check('update with an unknown coding runtime is rejected', badUpdate.errors.length > 0 && /Invalid coding runtime/.test(badUpdate.errors[0]));
db.bots.updateRuntimePath(created.id, { deck_name: '', working_directory: '' });
const cleared = def.serializeBot(db.bots.getById(created.id));
check('blank deck/working-directory clears the coding path to unconfigured', cleared.coding_configured === false && cleared.coding_path.deck_name === null);
db.bots.updateRuntimePath(created.id, { coding_runtime: 'muse', deck_name: 'relay-deck', working_directory: '/tmp/relay-work' });
const restored = def.serializeBot(db.bots.getById(created.id));
check('owner-supplied path restores the coding path to configured', restored.coding_configured === true && restored.coding_runtime === 'muse');

// --- Criterion 3: pre-migration rows invent nothing and read unconfigured.
const Database = require('better-sqlite3');
const raw = new Database(DB_PATH);
raw.prepare(
  'INSERT INTO bots (id, name, title, description, created_at) VALUES (?, ?, ?, ?, ?)'
).run('legacy-bot-1', 'Legacy', 'Old Bot', 'Created before NOT-433.', Date.now());
raw.close();
const legacy = db.bots.getById('legacy-bot-1');
const legacyView = def.serializeBot(legacy);
console.log(`legacy-bot compatibility: persistent_runtime=${legacyView.persistent_runtime} coding_runtime=${legacyView.coding_runtime} deck_name=${legacyView.deck_name} working_directory=${legacyView.working_directory} coding_configured=${legacyView.coding_configured}`);
check(
  'legacy-bot compatibility assertion: pre-migration row invents no coding runtime, deck, or working directory and reports unconfigured',
  legacyView.persistent_runtime === 'hermes' &&
    legacyView.coding_runtime === null &&
    legacyView.deck_name === null &&
    legacyView.working_directory === null &&
    legacyView.coding_configured === false &&
    legacyView.coding_path.configured === false,
  JSON.stringify(legacyView.coding_path)
);

// --- Criterion 5: availability follows the capability probe, never the enum.
async function main() {
  // Fixture: only the codex launch path is installed; claude/cursor/muse
  // binaries are missing, so only codex may be advertised.
  deck.setDeckRunProcess(async argv => {
    if (argv[0] === 'codex' && argv[1] === '--version') return { stdout: 'codex-cli 0.157.1\n', stderr: '', exitCode: 0 };
    if ((argv[0] === 'claude' || argv[0] === 'cursor' || argv[0] === 'muse') && argv[1] === '--version') {
      return { stdout: '', stderr: `command not found: ${argv[0]}`, exitCode: 127 };
    }
    if (argv[0] === 'agent-deck' && argv[1] === '--version') return { stdout: 'agent-deck 2.1.0\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'unexpected probe', exitCode: 1 };
  });
  const ready = await deck.listAvailableDeckRuntimes();
  const payload = def.buildAvailabilityPayload(ready);
  console.log(`availability payload (codex ready, others unavailable): ${JSON.stringify(payload)}`);
  check(
    'availability includes only probe-ready clients',
    payload.runtimes.length === 1 && payload.runtimes[0].runtime === 'codex' && payload.runtimes[0].launchable === true,
    JSON.stringify(payload)
  );

  // Fixture: agent-deck CLI itself missing, so no runtime is launchable even
  // though every value is a valid enum member.
  deck.setDeckRunProcess(async () => ({ stdout: '', stderr: 'command not found', exitCode: 127 }));
  const noneReady = await deck.listAvailableDeckRuntimes();
  const emptyPayload = def.buildAvailabilityPayload(noneReady);
  console.log(`availability payload (launcher unavailable): ${JSON.stringify(emptyPayload)}`);
  check(
    'enum membership alone never marks a runtime launchable',
    emptyPayload.runtimes.length === 0,
    JSON.stringify(emptyPayload)
  );
  deck.resetDeckRunProcessForTests();

  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* cleanup */ }
  }
  if (failures > 0) {
    console.log(`\ntest:bot-definition: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\ntest:bot-definition: all assertions passing');
}

main().catch(error => {
  console.error(`FAIL: availability probe test threw: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
