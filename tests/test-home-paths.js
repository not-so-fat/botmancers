#!/usr/bin/env node
// NOT-494: BOTMANCERS_HOME roots the core engine's state regardless of cwd;
// explicit path variables still win; a checkout without a home keeps the
// historical cwd-relative defaults. Also boots lib/db under a home from two
// cwd values and checks the database lands (and persists) under the home.
'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./support/repo-root');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { alias: { '@': ROOT } });
const home = jiti('../lib/home.ts');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botmancers-home-paths-')));
const cwdA = path.join(tmp, 'cwd-a');
const cwdB = path.join(tmp, 'cwd-b');
const bmHome = path.join(tmp, 'home');
fs.mkdirSync(cwdA);
fs.mkdirSync(cwdB);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const originalCwd = process.cwd();
try {
  test('with BOTMANCERS_HOME every default is under the home from any cwd', () => {
    const env = { BOTMANCERS_HOME: bmHome };
    for (const cwd of [cwdA, cwdB]) {
      process.chdir(cwd);
      assert.equal(home.dbPath(env), path.join(bmHome, 'data/botmancers.db'));
      assert.equal(home.filesRootPath(env), path.join(bmHome, 'files'));
      assert.equal(home.skillsRootPath(env), path.join(bmHome, 'skills'));
      assert.equal(home.waitLogPath(env), path.join(bmHome, 'logs/specialist-waits.jsonl'));
    }
  });

  test('explicit path variables override the home', () => {
    process.chdir(cwdA);
    const env = {
      BOTMANCERS_HOME: bmHome,
      BOTMANCERS_DB_PATH: path.join(tmp, 'x.db'),
      BOTMANCERS_FILES_ROOT: path.join(tmp, 'f'),
      BOTMANCERS_SKILLS_ROOT: path.join(tmp, 's'),
      HERMES_WAIT_LOG_PATH: path.join(tmp, 'w.jsonl'),
    };
    assert.equal(home.dbPath(env), path.join(tmp, 'x.db'));
    assert.equal(home.filesRootPath(env), path.join(tmp, 'f'));
    assert.equal(home.skillsRootPath(env), path.join(tmp, 's'));
    assert.equal(home.waitLogPath(env), path.join(tmp, 'w.jsonl'));
  });

  test('a checkout without BOTMANCERS_HOME keeps the cwd-relative defaults', () => {
    process.chdir(cwdB);
    assert.equal(home.botmancersHome({}), null);
    assert.equal(home.dbPath({}), 'botmancers.db');
    assert.equal(home.filesRootPath({}), path.join(cwdB, 'files'));
    assert.equal(home.skillsRootPath({}), path.join(cwdB, 'skills'));
    assert.equal(home.waitLogPath({}), path.join(cwdB, '.temporal/specialist-waits.jsonl'));
  });
} finally {
  process.chdir(originalCwd);
}

// lib/db opens its file at import, so each boot is a fresh process.
const boot = (cwd, script) => execFileSync(process.execPath, ['-e', `
  const { createJiti } = require(${JSON.stringify(require.resolve('jiti'))});
  const jiti = createJiti(${JSON.stringify(path.join(ROOT, 'x.js'))}, { alias: { '@': ${JSON.stringify(ROOT)} } });
  const db = jiti(${JSON.stringify(path.join(ROOT, 'lib/db.ts'))});
  ${script}
`], { cwd, env: { ...process.env, BOTMANCERS_HOME: bmHome, BOTMANCERS_DB_PATH: '', BOTMANCERS_NO_AUTOPROCESS: '1' }, encoding: 'utf8' });

test('lib/db creates its database under the home and reads it back from another cwd', () => {
  boot(cwdA, `db.default.prepare("CREATE TABLE IF NOT EXISTS home_probe (v TEXT)").run(); db.default.prepare("INSERT INTO home_probe VALUES ('persisted')").run();`);
  assert.ok(fs.existsSync(path.join(bmHome, 'data/botmancers.db')), 'database under the home');
  assert.ok(!fs.existsSync(path.join(cwdA, 'botmancers.db')), 'nothing written to cwd A');
  const out = boot(cwdB, `process.stdout.write(db.default.prepare("SELECT v FROM home_probe").get().v);`);
  assert.equal(out, 'persisted');
  assert.ok(!fs.existsSync(path.join(cwdB, 'botmancers.db')), 'nothing written to cwd B');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
