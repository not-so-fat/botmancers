#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.BOTMANCERS_DB_PATH || path.join('.temporal', 'agent-home-fixture.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) fs.rmSync(DB_PATH + suffix, { force: true });
process.env.BOTMANCERS_DB_PATH = DB_PATH;
process.env.BOTMANCERS_NO_AUTOPROCESS = '1';
process.env.BOTMANCERS_SKILLS_ROOT ||= path.join('.temporal', 'agent-home-skills');
fs.rmSync(process.env.BOTMANCERS_SKILLS_ROOT, { recursive: true, force: true });

const { createJiti } = require('jiti');
const jiti = createJiti(__filename);
const db = jiti('../lib/db.ts');
const { writeSkillForBot } = jiti('../lib/skills.ts');
const { seedSessionCatalog } = require('../tests/support/session-catalog-fixture');
const fixture = seedSessionCatalog(db);
db.bots.updateIdentity(fixture.agents.dev.id, 'Dev', 'Release implementer', 'Own release implementation.\nKeep changes scoped and prove the user path.');
writeSkillForBot('Dev', '# Implementation skill\nBuild coherent slices and report evidence.');
db.default.prepare('UPDATE bots SET runtime_connection_id = NULL WHERE id = ?').run(fixture.agents.scout.id);
console.log(`Seeded ${DB_PATH}: overview=${fixture.agents.dev.id}, blocked=${fixture.agents.scout.id}, empty=${fixture.agents.tank.id}`);
