#!/usr/bin/env node
'use strict';
// Root deterministic test runner: `npm test`.
//
// Runs every tests/test-*.js suite except the documented exclusions below
// (live-server / manual checks, listed in tests/README.md), sequentially
// from the repository root, and fails fast on the first failure with the
// suite name. Optional argv substrings filter to matching suites:
//
//   node tests/run.js session-share   # only suites whose file name contains it
//
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = __dirname;
const ROOT = require('./support/repo-root');

// Live / credentialed / manual checks: NOT part of `npm test`. Each entry
// names the file and why it is excluded; see tests/README.md for how to run
// these checks and what they need.
const EXCLUDED = new Map([
  ['test-import.js', 'manual: needs a running dev server on port 43123'],
  ['test-import-marketplace-ui.js', 'manual: needs a running dev server (BOTMANCERS_TEST_PORT or 3333)'],
  ['test-acceptance-steps-1-7.js', 'live-server: historical walkthrough needing a developer server'],
]);

function main() {
  const filters = process.argv.slice(2);
  const suites = fs.readdirSync(TESTS_DIR)
    .filter(name => name.startsWith('test-') && name.endsWith('.js'))
    .filter(name => !EXCLUDED.has(name))
    .filter(name => filters.length === 0 || filters.some(f => name.includes(f)))
    .sort();
  if (suites.length === 0) {
    console.error(`tests/run.js: no suites match${filters.length ? ` (${filters.join(' ')})` : ''}`);
    process.exit(1);
  }
  let passed = 0;
  for (const suite of suites) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(TESTS_DIR, suite)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.error) {
      console.error(`FAIL ${suite}: could not start (${result.error.message})`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`FAIL ${suite}: exit ${result.status} (${seconds}s)`);
      process.exit(result.status ?? 1);
    }
    passed += 1;
    console.log(`ok ${suite} (${seconds}s)`);
  }
  console.log(`\ntests/run.js: ${passed} passed, 0 failed`
    + ` (excluded: ${[...EXCLUDED.keys()].join(', ')})`);
}

main();
