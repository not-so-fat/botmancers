#!/usr/bin/env node
// NOT-548: seed an isolated DB with the 788-row session-list fixture
// (tests/support/session-list-fixture.js) for the real-app browser proof.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/session-list-fixture.db.
// Usage: node scripts/seed-session-list-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/session-list-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43496
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'session-list-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const { seedSessionList } = require('../tests/support/session-list-fixture');

const fixture = seedSessionList(db);
console.log(`Seeded ${DB_PATH}: Claude ${fixture.agent.id} with ${fixture.sessions.length} sessions, Archivist ${fixture.other.id}.`);
