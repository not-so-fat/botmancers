#!/usr/bin/env node
// NOT-509: seed an isolated DB with the session-usage fixture
// (test-support/session-usage-fixture.js): Ledger's past sessions with a
// complete-cost Claude session, a token-only Codex session, a partial
// session with an interrupted run, a reported $0.00 session, and one from
// before usage was recorded. Written through the canonical engine store and
// the attempt executor's result path.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/usage-fixture.db.
// Usage: node scripts/seed-usage-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/usage-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43509
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'usage-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const executor = jiti('../lib/attempt-executor.ts');
const { seedSessionUsage } = require('../test-support/session-usage-fixture');

const fixture = seedSessionUsage(db, executor);
console.log(`Seeded ${DB_PATH}: Ledger ${fixture.agent.id}, ${Object.keys(fixture.sessions).length} sessions with reported usage states.`);
