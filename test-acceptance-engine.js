#!/usr/bin/env node
// NOT-476: the canonical fake-adapter acceptance suite for the conversation /
// Wake engine (docs/acceptance-harness.md).
//
//   npm run test:acceptance                 every scenario
//   npm run test:acceptance -- talk-answer  named scenarios only
//   npm run test:acceptance -- --list       the fixture list
//   npm run test:acceptance -- --keep       keep passing scenario roots too
//
// Each scenario runs in its own process inside its own disposable harness
// root (temporary SQLite database, data root, HOME, Git workspace, and a
// PATH with only node and git), with an environment built from scratch: no
// live server, network, credentials, or installed coding runtime. A passing
// scenario's root is removed; a failing one is kept and its path printed.
// The runner also proves the developer's Botmancers state and this
// repository's working tree are unchanged by the run.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const harnessLib = require('./test-support/acceptance/harness.js');
const { SCENARIOS } = require('./test-support/acceptance/scenarios.js');

const CHILD_SCENARIO = process.env.BOTMANCERS_ACCEPTANCE_SCENARIO;

if (CHILD_SCENARIO) {
  runScenarioChild(CHILD_SCENARIO).then(code => process.exit(code), error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
} else {
  runSuite(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------
// Scenario process.
async function runScenarioChild(name) {
  const scenario = SCENARIOS.find(entry => entry.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const { createContext } = require('./test-support/acceptance/engine-context.js');
  const ctx = createContext(name);
  console.log(`[${name}] ${scenario.title}`);
  await scenario.run(ctx);
  await ctx.service.waitForAgentDispatchIdle();
  ctx.isolationCheck(ctx.guards.blockedConnections.length === 0, `no non-loopback network connection was attempted (${ctx.guards.blockedConnections.join(', ') || 'none'})`);
  const runtimes = ctx.guards.spawned.filter(command => command !== 'git');
  ctx.isolationCheck(runtimes.length === 0, `no runtime process was spawned (${runtimes.join(', ') || 'none'})`);
  const { results } = ctx;
  process.stdout.write(`\nACCEPTANCE_RESULT ${JSON.stringify(results)}\n`);
  return results.failed === 0 && results.engine > 0 && results.conversation > 0 ? 0 : 1;
}

function runChild(harness, scenarioName, extraEnv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [__filename], {
      cwd: harness.root,
      env: harness.env({ BOTMANCERS_ACCEPTANCE_SCENARIO: scenarioName, ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
  });
}

// ---------------------------------------------------------------------
// Runner.
async function runSuite(args) {
  const keep = args.includes('--keep');
  const names = args.filter(arg => !arg.startsWith('--'));
  if (args.includes('--list')) {
    for (const scenario of SCENARIOS) {
      console.log(`${scenario.name}\n  ${scenario.title}\n  fixtures: ${scenario.fixtures.join('; ')}`);
    }
    return 0;
  }
  const unknown = names.filter(name => !SCENARIOS.some(entry => entry.name === name));
  if (unknown.length) {
    console.error(`unknown scenario(s): ${unknown.join(', ')} (see --list)`);
    return 2;
  }
  const selected = names.length ? SCENARIOS.filter(entry => names.includes(entry.name)) : SCENARIOS.filter(entry => !entry.selfTestOnly);
  const before = harnessLib.snapshotProductionState();
  const summary = [];
  for (const scenario of selected) {
    const harness = harnessLib.createHarness(scenario.name, { keep });
    const started = Date.now();
    const run = await runChild(harness, scenario.name, {});
    fs.writeFileSync(path.join(harness.logs, 'scenario.stdout.log'), run.out);
    fs.writeFileSync(path.join(harness.logs, 'scenario.stderr.log'), run.err);
    const line = run.out.split('\n').find(entry => entry.startsWith('ACCEPTANCE_RESULT '));
    const result = line ? JSON.parse(line.slice('ACCEPTANCE_RESULT '.length)) : null;
    const ok = run.code === 0 && !!result && result.failed === 0 && result.engine > 0 && result.conversation > 0;
    process.stdout.write(run.out.split('\n').filter(entry => !entry.startsWith('ACCEPTANCE_RESULT ')).join('\n'));
    const details = ok ? '' : [
      `exit: ${run.code ?? run.signal}`,
      result ? `failed assertions:\n${result.failures.join('\n')}` : 'no result line (the scenario crashed)',
      result && (result.engine === 0 || result.conversation === 0) ? 'the scenario asserted no engine or no conversation state' : '',
      run.err ? `stderr (tail):\n${run.err.slice(-2000)}` : '',
    ].filter(Boolean).join('\n\n');
    const preserved = harness.finish(ok, details);
    summary.push({ name: scenario.name, ok, ms: Date.now() - started, result, preserved });
    if (!ok) {
      console.log(`  ${run.err ? run.err.slice(-1500) : ''}`);
      console.log(`  FAILED: ${scenario.name}; artifacts preserved at ${preserved}`);
    }
  }
  const changes = harnessLib.diffSnapshots(before, harnessLib.snapshotProductionState());
  console.log('\nAcceptance summary');
  for (const entry of summary) {
    const counts = entry.result ? `${entry.result.passed} passed, ${entry.result.failed} failed (engine ${entry.result.engine}, conversation ${entry.result.conversation})` : 'no result';
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'} ${entry.name.padEnd(20)} ${counts} ${entry.ms}ms${entry.preserved ? ` -> ${entry.preserved}` : ''}`);
  }
  console.log(`  ${changes.length === 0 ? 'PASS' : 'FAIL'} production Botmancers state and repository working tree unchanged${changes.length ? `:\n    ${changes.join('\n    ')}` : ''}`);
  const ok = summary.every(entry => entry.ok) && changes.length === 0;
  console.log(`\nTEST RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}
