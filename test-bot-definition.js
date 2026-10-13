#!/usr/bin/env node
// NOT-442: single bot runtime contract test (deterministic, no network).
//
// Proves: the bot-definition schema and create/read/update API accept only
// runtime=hermes or runtime=agent-deck (Agent Deck requires one of
// codex|claude|cursor|muse plus a deck ID; Hermes rejects Agent Deck-only
// fields); the deterministic migration converts every complete legacy
// coding path to agent-deck (legacy deck_name preserved only as an
// unresolved reference, null deck ID, needs-reselection) with zero
// deck-discovery calls, while every incomplete/absent path becomes hermes.

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

// --- Criterion 1: valid Hermes round trip (default for newly created bots).
const hermesCreated = db.bots.create({
  name: 'Herald',
  title: 'Herald',
  description: 'Converses persistently.',
  runtime: 'hermes',
  agent_client: null,
  deck_id: null,
  deck_name: null,
  working_directory: null,
  needs_deck_reselection: 0,
});
console.log(`valid Hermes round trip: runtime=${hermesCreated.runtime} agent_client=${hermesCreated.agent_client} deck_id=${hermesCreated.deck_id}`);
check('valid Hermes bot stores runtime=hermes', hermesCreated.runtime === 'hermes', JSON.stringify(hermesCreated.runtime));
const hermesReadBack = db.bots.getById(hermesCreated.id);
const hermesView = def.serializeBot(hermesReadBack);
console.log(`Hermes read-back: runtime=${hermesView.runtime} agent_client=${hermesView.agent_client} deck_id=${hermesView.deck_id} launchable=${hermesView.launchable}`);
check(
  'Hermes read-back resolves to hermes with cleared Agent Deck fields',
  hermesView.runtime === 'hermes' && hermesView.agent_client === null && hermesView.deck_id === null &&
    hermesView.deck_name === null && hermesView.working_directory === null && hermesView.launchable === true,
  JSON.stringify({ runtime: hermesView.runtime, agent_client: hermesView.agent_client, deck_id: hermesView.deck_id })
);

// --- Criterion 1: valid Agent Deck round trip.
const deckCreated = db.bots.create({
  name: 'Relay',
  title: 'Coding Relay',
  description: 'Launches a local coding agent directly.',
  runtime: 'agent-deck',
  agent_client: 'codex',
  deck_id: 'deck-123',
  deck_name: null,
  working_directory: '/tmp/relay-work',
  needs_deck_reselection: 0,
});
console.log(`valid Agent Deck round trip: runtime=${deckCreated.runtime} agent_client=${deckCreated.agent_client} deck_id=${deckCreated.deck_id} working_directory=${deckCreated.working_directory}`);
check('valid Agent Deck bot stores its client and deck ID', deckCreated.runtime === 'agent-deck' && deckCreated.agent_client === 'codex' && deckCreated.deck_id === 'deck-123', JSON.stringify(deckCreated));
const deckReadBack = db.bots.getById(deckCreated.id);
const deckView = def.serializeBot(deckReadBack);
check(
  'Agent Deck read-back resolves with its stored configuration',
  deckView.runtime === 'agent-deck' && deckView.agent_client === 'codex' && deckView.deck_id === 'deck-123' &&
    deckView.working_directory === '/tmp/relay-work' && deckView.launchable === true,
  JSON.stringify(deckView)
);
check('agent-client enum matches the run-adapter runtimes', JSON.stringify(def.AGENT_CLIENTS) === JSON.stringify(deck.DECK_RUNTIMES));

// --- Criterion 1: invalid fixtures (mixed/partial) are rejected.
const unknownRuntime = def.validateCreateRuntimePath({ runtime: 'watson' });
console.log(`invalid mixed fixture unknown-runtime: ${unknownRuntime.errors[0] || '(no error)'}`);
check('unknown runtime is rejected', unknownRuntime.errors.length > 0 && /Invalid runtime/.test(unknownRuntime.errors[0]), JSON.stringify(unknownRuntime.errors));

const unknownClient = def.validateCreateRuntimePath({ runtime: 'agent-deck', agent_client: 'watson', deck_id: 'd1' });
console.log(`invalid mixed fixture unknown-client: ${unknownClient.errors[0] || '(no error)'}`);
check('unknown agent client is rejected', unknownClient.errors.length > 0 && /Invalid agent client/.test(unknownClient.errors[0]), JSON.stringify(unknownClient.errors));

const missingClient = def.validateCreateRuntimePath({ runtime: 'agent-deck', deck_id: 'd1' });
console.log(`invalid partial fixture missing-client: ${missingClient.errors[0] || '(no error)'}`);
check('agent-deck without a client is rejected', missingClient.errors.some(e => /agent client/i.test(e)), JSON.stringify(missingClient.errors));

const missingDeckId = def.validateCreateRuntimePath({ runtime: 'agent-deck', agent_client: 'claude' });
console.log(`invalid partial fixture missing-deck-id: ${missingDeckId.errors[0] || '(no error)'}`);
check('agent-deck without a deck ID is rejected', missingDeckId.errors.some(e => /Deck ID is required/.test(e)), JSON.stringify(missingDeckId.errors));

const hermesWithDeckFields = def.validateCreateRuntimePath({ runtime: 'hermes', agent_client: 'codex', deck_id: 'd1' });
console.log(`invalid mixed fixture hermes-with-deck-fields: ${hermesWithDeckFields.errors[0] || '(no error)'}`);
check('Hermes with Agent Deck fields is rejected', hermesWithDeckFields.errors.some(e => /not accepted for a Hermes bot/.test(e)), JSON.stringify(hermesWithDeckFields.errors));

// PATCH contract: unknown runtime/client rejected, blank values clear.
const badUpdate = def.validateUpdateRuntimePath({ runtime: 'watson' });
check('update with an unknown runtime is rejected', badUpdate.errors.length > 0 && /Invalid runtime/.test(badUpdate.errors[0]), JSON.stringify(badUpdate.errors));
const badClientUpdate = def.validateUpdateRuntimePath({ agent_client: 'watson' });
check('update with an unknown agent client is rejected', badClientUpdate.errors.length > 0 && /Invalid agent client/.test(badClientUpdate.errors[0]), JSON.stringify(badClientUpdate.errors));

// PATCH contract against the stored row: agent-deck requires a client.
const hermesRow = { runtime: 'hermes', agent_client: null, deck_id: null, deck_name: null, working_directory: null, needs_deck_reselection: 0 };
const switchNoClient = def.validateUpdateRuntimePath({ runtime: 'agent-deck' }, hermesRow);
console.log(`invalid update fixture switch-without-client: ${switchNoClient.errors[0] || '(no error)'}`);
check('switching to agent-deck without a client is rejected', switchNoClient.errors.some(e => /agent client/i.test(e)), JSON.stringify(switchNoClient.errors));

const deckRow = { runtime: 'agent-deck', agent_client: 'codex', deck_id: 'deck-123', deck_name: null, working_directory: '/tmp/w', needs_deck_reselection: 0 };
const clearClient = def.validateUpdateRuntimePath({ agent_client: '' }, deckRow);
console.log(`invalid update fixture clear-client: ${clearClient.errors[0] || '(no error)'}`);
check('clearing the client on an agent-deck bot is rejected', clearClient.errors.some(e => /agent client/i.test(e)), JSON.stringify(clearClient.errors));

const nullClientDeck = def.validateUpdateRuntimePath({ agent_client: '', deck_id: 'deck-999' }, deckRow);
console.log(`invalid update fixture null-client-with-deck: ${nullClientDeck.errors[0] || '(no error)'}`);
check('deck ID with a null client is rejected', nullClientDeck.errors.some(e => /agent client/i.test(e)), JSON.stringify(nullClientDeck.errors));

// Switching to agent-deck without a deck ID is rejected on any stored
// row that is not already an unresolved migrated row: only the
// migration may introduce the needs-reselection state.
const switchNoDeck = def.validateUpdateRuntimePath({ runtime: 'agent-deck', agent_client: 'codex' }, hermesRow);
console.log(`invalid update fixture switch-without-deck-id: ${switchNoDeck.errors[0] || '(no error)'}`);
check('switching to agent-deck without a deck ID is rejected', switchNoDeck.errors.some(e => /Deck ID is required/.test(e)), JSON.stringify(switchNoDeck.errors));

const switchNoDeckFull = def.validateUpdateRuntimePath({ runtime: 'agent-deck', agent_client: 'codex', deck_id: 'deck-123' }, hermesRow);
check('switching to agent-deck with a client and deck ID is accepted', switchNoDeckFull.errors.length === 0, JSON.stringify(switchNoDeckFull.errors));

const unresolvedWorkdir = def.validateUpdateRuntimePath(
  { working_directory: '/tmp/other' },
  { runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/w', needs_deck_reselection: 1 }
);
check(
  'updating an unresolved migrated row without a deck ID stays allowed',
  unresolvedWorkdir.errors.length === 0,
  JSON.stringify(unresolvedWorkdir.errors)
);

// Defense in depth: a direct client-less merge is flagged, never launchable.
const clientLessMerge = def.applyRuntimeUpdate(deckRow, { agent_client: null, deck_id: 'deck-999' });
console.log(`client-less merge: needs_deck_reselection=${clientLessMerge.needs_deck_reselection} launchable=${def.resolveRuntime({ ...deckRow, agent_client: null }).launchable}`);
check(
  'client-less merge is flagged as needing re-selection and not launchable',
  clientLessMerge.needs_deck_reselection === true &&
    def.resolveRuntime({ runtime: 'agent-deck', agent_client: null, deck_id: 'deck-999' }).launchable === false,
  JSON.stringify(clientLessMerge)
);

// Valid update: selecting a deck ID on a needs-reselection row resolves it.
const unresolvedRow = { runtime: 'agent-deck', agent_client: 'codex', deck_id: null, deck_name: 'relay-deck', working_directory: '/tmp/w', needs_deck_reselection: 1 };
const reselect = def.validateUpdateRuntimePath({ deck_id: 'deck-123' }, unresolvedRow);
const reselected = def.applyRuntimeUpdate(unresolvedRow, reselect.fields);
console.log(`valid update fixture reselect: errors=${reselect.errors.length} deck_id=${reselected.deck_id} needs_deck_reselection=${reselected.needs_deck_reselection}`);
check(
  'selecting a deck ID resolves the re-selection marker',
  reselect.errors.length === 0 && reselected.deck_id === 'deck-123' &&
    reselected.deck_name === null && reselected.needs_deck_reselection === false,
  JSON.stringify({ errors: reselect.errors, reselected })
);

// Switching to hermes clears Agent Deck fields.
db.bots.updateRuntimePath(deckCreated.id, { runtime: 'hermes' });
const clearedToHermes = def.serializeBot(db.bots.getById(deckCreated.id));
check(
  'switching to hermes clears Agent Deck fields',
  clearedToHermes.runtime === 'hermes' && clearedToHermes.agent_client === null && clearedToHermes.deck_id === null &&
    clearedToHermes.working_directory === null && clearedToHermes.needs_deck_reselection === false,
  JSON.stringify(clearedToHermes)
);
// Restore the deck bot for later suites (independent DB files, but keep tidy).
db.bots.updateRuntimePath(deckCreated.id, { runtime: 'agent-deck', agent_client: 'codex', deck_id: 'deck-123', working_directory: '/tmp/relay-work' });

// --- Criterion 2: deterministic migration fixtures (pure, no network).
// Count deck-discovery calls: the migration must never fetch.
let deckDiscoveryCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  deckDiscoveryCalls += 1;
  if (originalFetch) return originalFetch(...args);
  throw new Error('fetch not available in test sandbox');
};

function showMigration(label, before, after) {
  console.log(
    `migration fixture ${label}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
  );
}

const completeBefore = { runtime: null, coding_runtime: 'codex', deck_name: 'relay-deck', working_directory: '/tmp/relay-work' };
const completeAfter = def.migrateLegacyRuntimeFields({ ...completeBefore });
showMigration('complete', completeBefore, completeAfter);
console.log(`complete legacy path: legacy deck_name="${completeAfter.deck_name}" deck_id=${completeAfter.deck_id} needs_deck_reselection=${completeAfter.needs_deck_reselection}`);
check(
  'complete legacy coding path becomes agent-deck with the legacy name as an unresolved reference',
  completeAfter.runtime === 'agent-deck' && completeAfter.agent_client === 'codex' &&
    completeAfter.deck_name === 'relay-deck' && completeAfter.deck_id === null &&
    completeAfter.needs_deck_reselection === true && completeAfter.working_directory === '/tmp/relay-work',
  JSON.stringify(completeAfter)
);

const partialBefore = { runtime: null, coding_runtime: 'claude', deck_name: null, working_directory: '/tmp/w' };
const partialAfter = def.migrateLegacyRuntimeFields({ ...partialBefore });
showMigration('partial-missing-deck', partialBefore, partialAfter);
check(
  'partial path (missing deck name) becomes hermes with cleared fields',
  partialAfter.runtime === 'hermes' && partialAfter.agent_client === null && partialAfter.deck_id === null &&
    partialAfter.deck_name === null && partialAfter.working_directory === null && partialAfter.needs_deck_reselection === false,
  JSON.stringify(partialAfter)
);

const partialCwdBefore = { runtime: null, coding_runtime: 'cursor', deck_name: 'some-deck', working_directory: null };
const partialCwdAfter = def.migrateLegacyRuntimeFields({ ...partialCwdBefore });
showMigration('partial-missing-cwd', partialCwdBefore, partialCwdAfter);
check(
  'partial path (missing working directory) becomes hermes',
  partialCwdAfter.runtime === 'hermes' && partialCwdAfter.deck_name === null,
  JSON.stringify(partialCwdAfter)
);

const invalidClientBefore = { runtime: null, coding_runtime: 'watson', deck_name: 'd', working_directory: '/tmp/w' };
const invalidClientAfter = def.migrateLegacyRuntimeFields({ ...invalidClientBefore });
showMigration('partial-invalid-client', invalidClientBefore, invalidClientAfter);
check('invalid client becomes hermes', invalidClientAfter.runtime === 'hermes', JSON.stringify(invalidClientAfter));

const importedBefore = { runtime: null };
const importedAfter = def.migrateLegacyRuntimeFields({ ...importedBefore });
showMigration('imported', importedBefore, importedAfter);
check('imported row without a coding path becomes hermes', importedAfter.runtime === 'hermes' && importedAfter.migrated === true, JSON.stringify(importedAfter));

const unconfiguredBefore = { runtime: null, coding_runtime: null, deck_name: null, working_directory: null };
const unconfiguredAfter = def.migrateLegacyRuntimeFields({ ...unconfiguredBefore });
showMigration('unconfigured', unconfiguredBefore, unconfiguredAfter);
check('unconfigured row becomes hermes', unconfiguredAfter.runtime === 'hermes' && unconfiguredAfter.deck_name === null, JSON.stringify(unconfiguredAfter));

const alreadyHermes = def.migrateLegacyRuntimeFields({ runtime: 'hermes', agent_client: 'codex', deck_id: 'd1' });
check('row that already stores a runtime is untouched (hermes)', alreadyHermes.runtime === 'hermes' && alreadyHermes.migrated === false, JSON.stringify(alreadyHermes));

// Imported bots are Hermes with no Agent Deck path at the DB layer.
const imported = db.bots.createFromImport(
  { name: 'Imported', title: 'Imported', description: 'Imported bot.' },
  { source_provider: 'test', template_id: 't1', template_url: 'https://example.test/t1', import_schema_version: '1', import_operation_id: `op-${process.pid}`, import_timestamp: Date.now() }
);
const importedView = def.serializeBot(db.bots.getById(imported.id));
console.log(`imported row: runtime=${importedView.runtime} agent_client=${importedView.agent_client} deck_id=${importedView.deck_id}`);
check('imported bot reads back as hermes', importedView.runtime === 'hermes' && importedView.agent_client === null, JSON.stringify(importedView));

globalThis.fetch = originalFetch;
console.log(`deck-discovery calls during migration: ${deckDiscoveryCalls}`);
check('migration performs zero deck-discovery calls (no network)', deckDiscoveryCalls === 0, `got ${deckDiscoveryCalls}`);

async function main() {
  // Availability still follows the capability probe, never the enum.
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
