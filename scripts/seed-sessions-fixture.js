#!/usr/bin/env node
// NOT-496: seed an isolated DB with the session-catalog fixture
// (test-support/session-catalog-fixture.js): Dev with active and ended
// Session Bindings from Tank's thread, its own thread, and a group room, and
// Scout with one of its own. Written through the canonical engine store.
// Honors BOTMANCERS_DB_PATH; defaults to .temporal/sessions-fixture.db.
// Usage: node scripts/seed-sessions-fixture.js
//        BOTMANCERS_DB_PATH=.temporal/sessions-fixture.db BOTMANCERS_NO_AUTOPROCESS=1 npx next dev -H 127.0.0.1 -p 43496
'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'sessions-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch { /* fresh start */ }
}
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const { seedSessionCatalog } = require('../test-support/session-catalog-fixture');

const fixture = seedSessionCatalog(db);
console.log(`Seeded ${DB_PATH}: Dev ${fixture.agents.dev.id}, Scout ${fixture.agents.scout.id}, ${Object.keys(fixture.bindings).length} session bindings.`);
