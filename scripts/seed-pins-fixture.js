#!/usr/bin/env node
// NOT-507: seed an isolated DB for the session-actions proof
// (scripts/ui-session-pins-proof.js). A Codex Agent "Forge" on the
// deterministic fake codex binary (test-support/fake-codex.js) whose past
// sessions cover the action states: an open session (Ask from this context
// and Resume work here), an archived one that still resumes, and one the
// runtime no longer has (missing). Forge's policy allows workspace write and
// resuming with edits; Hand off to… stays unavailable for native sessions.
// Also writes the codex wrapper the app must run with.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/pins-fixture.db.
// Usage: node scripts/seed-pins-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/pins-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 \
//          BOTMANCERS_CODEX_BIN=.temporal/pins-fixture-codex FAKE_CODEX_STATE=.temporal/pins-fixture-codex.json \
//          npx next dev -H 127.0.0.1 -p 43507
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'pins-fixture.db');
const DIR = path.dirname(DB_PATH);
const STATE = path.resolve(process.env.FAKE_CODEX_STATE || path.join(DIR, 'pins-fixture-codex.json'));
const BIN = path.resolve(process.env.BOTMANCERS_CODEX_BIN || path.join(DIR, 'pins-fixture-codex'));
const WORK = path.resolve(DIR, 'pins-fixture-work');
fs.mkdirSync(WORK, { recursive: true });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
fs.rmSync(STATE, { force: true });
fs.writeFileSync(BIN, `#!/bin/sh\nFAKE_CODEX_STATE='${STATE}' exec '${process.execPath}' '${path.resolve(__dirname, '..', 'test-support', 'fake-codex.js')}' "$@"\n`);
fs.chmodSync(BIN, 0o755);
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_CODEX_BIN = BIN;
process.env.FAKE_CODEX_STATE = STATE;

const { seedFakeCodex } = require('../test-support/fake-codex');
seedFakeCodex(STATE, [
  { id: 'thr-uploader-SECRET', cwd: WORK, name: 'Fix the uploader retry', turns: [['Fix the uploader retry', 'Retry now backs off; tests pending'], ['Which tests?', 'upload.test.ts']] },
  { id: 'thr-spike-SECRET', cwd: WORK, name: 'Archived parser spike', archived: true, turns: [['Spike the parser', 'Spike notes saved']] },
  { id: 'thr-gone-SECRET', cwd: WORK, name: 'Old dependency audit', turns: [['Audit deps', 'Two outdated']] },
]);

const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': path.resolve(__dirname, '..') } });
const dbModule = jiti('../lib/db.ts');
const ps = jiti('../lib/provider-sessions.ts');
const codex = jiti('../lib/codex-session-provider.ts');
const db = dbModule.default;

async function main() {
  const connection = dbModule.runtimeConnections.create({ provider: 'codex', label: 'Codex', host: 'This computer' });
  const forge = dbModule.bots.create({
    name: 'Forge', title: 'Implementer', description: 'Native Codex sessions', agent: 'codex', runtime_connection_id: connection.id, launch_profile: 'direct',
    session_scope_kind: 'all_provider_sessions', session_scope_items: '[]',
    policy_mode: 'workspace_write', allow_new_sessions: 0, allow_resume_with_edits: 1,
  });
  dbModule.bots.create({ name: 'Scout', title: 'Researcher', description: 'Reads things', agent: 'claude', deck_id: 'deck-builder' });
  let cursor = null;
  do {
    cursor = (await ps.syncAgentSessions(db, forge.id, { cursor })).next_cursor;
  } while (cursor);
  // The runtime loses one session after discovery: it reads as missing.
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state.threads['thr-gone-SECRET'].deleted = true;
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  const goneRef = db.prepare('SELECT id FROM provider_sessions WHERE agent_id = ? AND provider_session_id = ?').get(forge.id, 'thr-gone-SECRET').id;
  await ps.refreshProviderSession(db, forge.id, goneRef).catch(() => undefined);
  codex.shutdownDefaultCodexRuntime();
  const count = db.prepare('SELECT COUNT(*) AS n FROM provider_sessions WHERE agent_id = ?').get(forge.id).n;
  console.log(`Seeded ${DB_PATH}: Forge ${forge.id} with ${count} Codex sessions; codex wrapper ${BIN}.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
