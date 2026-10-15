#!/usr/bin/env node
// NOT-476: self-tests of the acceptance harness (docs/acceptance-harness.md).
//
//   npm run test:acceptance:harness
//
// Proves, without network, credentials, or a coding runtime:
// - a harness root holds its own database, data root, HOME, Git workspace,
//   and node/git-only PATH under the temp directory; its environment
//   inherits no credentials; its route host binds an OS-assigned port;
// - the spawn guard refuses a forbidden command before it starts;
// - success removes the root, failure keeps it with FAILED.txt;
// - the runner (test-acceptance-engine.js) cleans up a passing scenario,
//   preserves and names a failing one, ignores a hostile environment
//   (production database path, tokens), runs in a stripped environment,
//   and leaves the configured production paths and this working tree as
//   they were;
// - the opt-in real Agent Deck smoke refuses a missing or non-disposable
//   workdir, a missing token or deck, and redacts secrets from its evidence
//   (exercised end to end against the fake Agent Deck over loopback).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const harnessLib = require('./test-support/acceptance/harness.js');
const guard = require('./test-support/acceptance/real-deck-guard.js');
const { createFakeAgentDeck } = require('./test-support/fake-agent-deck-api.js');

let failures = 0;
function assert(condition, label) {
  if (condition) console.log(`  PASS: ${label}`);
  else { failures += 1; console.log(`  FAIL: ${label}`); }
  return condition;
}

function run(command, args, env, cwd = __dirname) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => resolve({ code, out, err }));
  });
}

const tmp = fs.realpathSync(os.tmpdir());
const rootsOf = name => fs.readdirSync(tmp).filter(entry => entry.startsWith(`${harnessLib.ROOT_PREFIX}${name}-`)).sort();
const scratch = [];
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(tmp, `botmancers-harness-selftest-${prefix}-`));
  scratch.push(dir);
  return dir;
}
function gitRepo(dir, files = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  for (const [name, content] of Object.entries({ 'README.md': 'scratch\n', ...files })) fs.writeFileSync(path.join(dir, name), content);
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  return dir;
}

async function main() {
  const productionBefore = harnessLib.snapshotProductionState();

  // ===================================================================
  console.log('Harness root layout and isolation');
  process.env.BOTMANCERS_SELFTEST_FAKE_TOKEN = 'adg_selftest_inherited_secret';
  const harness = harnessLib.createHarness('selftest');
  const root = fs.realpathSync(harness.root);
  assert(root.startsWith(tmp + path.sep) && path.basename(root).startsWith(harnessLib.ROOT_PREFIX), `root under the temp directory (${root})`);
  for (const key of ['dbPath', 'filesRoot', 'home', 'workspace', 'logs']) {
    assert(path.resolve(harness[key]).startsWith(harness.root + path.sep), `${key} inside the root`);
  }
  const env = harness.env();
  assert(env.BOTMANCERS_DB_PATH === harness.dbPath && env.BOTMANCERS_FILES_ROOT === harness.filesRoot && env.HOME === harness.home, 'environment points the database, data root, and HOME into the root');
  assert(!Object.keys(env).some(key => /TOKEN|SECRET|API_?KEY|HERMES|AGENT_DECK|CURSOR|ANTHROPIC|OPENAI/i.test(key)), `environment inherits no credentials (keys: ${Object.keys(env).join(',')})`);
  assert(fs.readdirSync(path.join(harness.root, 'bin')).sort().join(',') === 'git,node', 'PATH directory holds only node and git');
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: harness.workspace, env, encoding: 'utf8' }).trim();
  assert(log === 'acceptance baseline' && fs.existsSync(path.join(harness.workspace, guard.DISPOSABLE_MARKER)), 'disposable Git workspace: one baseline commit and the disposable marker');
  // Inside the root's environment: the route host binds an OS-assigned
  // port directly, and the spawn guard refuses forbidden commands before
  // they start (each would create a marker file if it ran).
  const marker = path.join(harness.root, 'forbidden-ran');
  const probe = `
    const { createContext } = require(${JSON.stringify(path.join(__dirname, 'test-support/acceptance/engine-context.js'))});
    const cp = require('child_process');
    const ctx = createContext('selftest-guards');
    const marker = ${JSON.stringify(marker)};
    const attempts = {
      spawnSync: () => cp.spawnSync('/usr/bin/touch', [marker]),
      spawn: () => cp.spawn('/usr/bin/touch', [marker]),
      execFile: () => cp.execFile('/usr/bin/touch', [marker]),
      execFileSync: () => cp.execFileSync('/usr/bin/touch', [marker]),
      exec: () => cp.exec('touch ' + marker),
      execSync: () => cp.execSync('git --version; touch ' + marker),
      nodeViaShell: () => cp.spawnSync(process.execPath, ['-e', 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "")'], { shell: true }),
    };
    const refused = {};
    for (const [name, fn] of Object.entries(attempts)) { try { fn(); refused[name] = false; } catch (e) { refused[name] = /refused/.test(e.message); } }
    const git = cp.execFileSync('git', ['--version'], { encoding: 'utf8' }).startsWith('git version');
    ctx.routeHost().then(async host => {
      const port = host.port;
      await host.close();
      setTimeout(() => {
        process.stdout.write('GUARDS ' + JSON.stringify({ port, refused, git, recorded: ctx.guards.refusedSpawns.length, spawned: ctx.guards.spawned }) + '\\n');
        process.exit(0);
      }, 200);
    });
  `;
  const probed = await run(process.execPath, ['-e', probe], harness.env(), harness.root);
  const guards = (() => { try { return JSON.parse(probed.out.split('\n').find(line => line.startsWith('GUARDS ')).slice(7)); } catch { return null; } })();
  assert(guards && guards.port > 0 && guards.port !== 43123, `the route host listens on an OS-assigned loopback port (${guards && guards.port}), not the developer server port${guards ? '' : `: ${probed.err.slice(-800)}`}`);
  assert(guards && Object.values(guards.refused).every(Boolean) && guards.recorded === Object.keys(guards.refused).length,
    `spawn guard refuses every non-git/node process and shell command (${guards && JSON.stringify(guards.refused)})`);
  assert(!fs.existsSync(marker), 'no refused command ever started (its marker file does not exist)');
  assert(guards && guards.git && guards.spawned.join(',') === 'git', 'git is still allowed and recorded');
  assert(harness.finish(true) === null && !fs.existsSync(harness.root), 'finish(success) removes the root');

  const failing = harnessLib.createHarness('selftest');
  const kept = failing.finish(false, 'why it failed');
  const note = kept && fs.readFileSync(path.join(kept, 'FAILED.txt'), 'utf8');
  assert(kept === failing.root && fs.existsSync(path.join(kept, 'workspace', '.git')) && /result: FAILED/.test(note) && /why it failed/.test(note) && note.includes(failing.dbPath),
    'finish(failure) keeps the root with FAILED.txt naming the database, workspace, and reason');
  fs.rmSync(kept, { recursive: true, force: true });

  // ===================================================================
  console.log('\nRunner: success cleans up, failure is preserved, hostile environment ignored');
  const realDb = path.join(harnessLib.REPO_ROOT, 'botmancers.db');
  const hostileEnv = {
    ...process.env,
    BOTMANCERS_DB_PATH: realDb,
    BOTMANCERS_FILES_ROOT: path.join(harnessLib.REPO_ROOT, 'files'),
    AGENT_DECK_RUN_TOKEN: 'adg_hostile_should_never_be_used',
    HERMES_API_SERVER_KEY: 'hermes_hostile_should_never_be_used',
  };
  const beforePass = rootsOf('talk-answer');
  const passed = await run(process.execPath, ['test-acceptance-engine.js', 'talk-answer'], hostileEnv);
  assert(passed.code === 0 && /TEST RESULT: PASS/.test(passed.out), `talk-answer passes under a hostile parent environment (exit ${passed.code})`);
  assert(JSON.stringify(rootsOf('talk-answer')) === JSON.stringify(beforePass), 'the passing scenario left no harness root behind');
  assert(!/hostile_should_never_be_used/.test(passed.out + passed.err), 'no inherited secret reached the scenario output');

  const failed = await run(process.execPath, ['test-acceptance-engine.js', 'self-test-failure'], process.env);
  const preserved = (/artifacts preserved at (\S+)/.exec(failed.out) || [])[1];
  assert(failed.code === 1 && /TEST RESULT: FAIL/.test(failed.out), `a failing scenario fails the run (exit ${failed.code})`);
  const failedNote = preserved && fs.existsSync(path.join(preserved, 'FAILED.txt')) ? fs.readFileSync(path.join(preserved, 'FAILED.txt'), 'utf8') : '';
  assert(!!preserved && fs.existsSync(path.join(preserved, 'db', 'botmancers.db')) && fs.existsSync(path.join(preserved, 'logs', 'scenario.stdout.log'))
    && /deliberate failure/.test(failedNote), `the failing root is preserved with its database, logs, and the failed assertion (${preserved})`);
  if (preserved) fs.rmSync(preserved, { recursive: true, force: true });

  const listed = await run(process.execPath, ['test-acceptance-engine.js', '--list'], process.env);
  const names = ['talk-answer', 'duplicate-wake', 'unavailable-target', 'restart-recovery', 'composed-review', 'lifecycle-controls', 'safety-denial'];
  assert(listed.code === 0 && names.every(name => listed.out.includes(`${name}\n`)), '--list names every core scenario with its fixtures');

  // ===================================================================
  console.log('\nClean environment: the default suite needs no server, network, credentials, or coding runtime');
  const emptyHome = scratchDir('home');
  const cleanEnv = { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: emptyHome, TMPDIR: os.tmpdir() };
  const clean = await run(process.execPath, ['test-acceptance-engine.js'], cleanEnv);
  const summary = clean.out.slice(clean.out.indexOf('Acceptance summary'));
  console.log(summary.split('\n').map(line => `    ${line}`).join('\n'));
  assert(clean.code === 0 && names.every(name => new RegExp(`PASS ${name}`).test(summary)), `full default suite passes in a stripped environment (exit ${clean.code})`);

  // ===================================================================
  console.log('\nReal Agent Deck smoke guardrails');
  const fakeHome = scratchDir('fakehome');
  const opts = { home: fakeHome };
  const code = fn => { try { fn(); return 'ok'; } catch (error) { return error.code || error.message; } };
  const plain = scratchDir('plain');
  const noMarker = gitRepo(scratchDir('nomarker'));
  const dirty = gitRepo(scratchDir('dirty'), { [guard.DISPOSABLE_MARKER]: 'yes\n' });
  fs.writeFileSync(path.join(dirty, 'uncommitted.txt'), 'x');
  const disposable = gitRepo(scratchDir('disposable'), { [guard.DISPOSABLE_MARKER]: 'yes\n' });
  fs.mkdirSync(path.join(fakeHome, '.botmancers', 'agent'), { recursive: true });
  const cases = [
    ['missing', undefined, 'workdir_missing'],
    ['blank', '  ', 'workdir_missing'],
    ['nonexistent', path.join(plain, 'nope'), 'workdir_not_found'],
    ['a file', path.join(noMarker, 'README.md'), 'workdir_not_directory'],
    ['filesystem root', '/', 'workdir_protected'],
    ['this repository', harnessLib.REPO_ROOT, 'workdir_protected'],
    ['inside this repository', path.join(harnessLib.REPO_ROOT, 'lib'), 'workdir_protected'],
    ['the home directory', fakeHome, 'workdir_protected'],
    ['~/.botmancers', path.join(fakeHome, '.botmancers', 'agent'), 'workdir_protected'],
    ['not a Git root', plain, 'workdir_not_git_root'],
    ['no disposable marker', noMarker, 'workdir_not_disposable'],
    ['uncommitted changes', dirty, 'workdir_dirty'],
    ['explicit disposable repository', disposable, 'ok'],
  ];
  for (const [label, dir, expected] of cases) {
    const got = code(() => guard.validateDisposableWorkdir(dir, opts));
    assert(got === expected, `${label}: ${expected} (got ${got})`);
  }

  const serverCases = [
    ['http://user:pass@127.0.0.1:1111', 'server_credentials'],
    ['http://token@127.0.0.1:1111', 'server_credentials'],
    ['http://127.0.0.1:1111/?token=abc', 'server_credentials'],
    ['http://127.0.0.1:1111/#secret', 'server_credentials'],
    ['ftp://127.0.0.1', 'invalid_argument'],
    ['not a url', 'invalid_argument'],
    ['http://127.0.0.1:1111/', 'ok'],
  ];
  for (const [url, expected] of serverCases) {
    assert(code(() => guard.validateServerUrl(url)) === expected, `server ${url}: ${expected}`);
  }
  assert(guard.validateServerUrl('https://deck.example/base/') === 'https://deck.example/base', 'server URL normalized without a trailing slash');
  const existingEvidence = path.join(scratchDir('existing'), 'evidence.json');
  fs.writeFileSync(existingEvidence, 'keep me\n');
  const configuredDb = path.join(scratchDir('configured-db'), 'botmancers.db');
  const evidenceCases = [
    ['inside the workdir', path.join(disposable, 'evidence.json'), {}, 'evidence_protected'],
    ['inside this repository', path.join(harnessLib.REPO_ROOT, 'smoke-evidence.json'), {}, 'evidence_protected'],
    ['inside ~/.botmancers', path.join(fakeHome, '.botmancers', 'evidence.json'), { home: fakeHome }, 'evidence_protected'],
    ['next to a configured database (its -wal)', `${configuredDb}-wal`, { protectedPaths: harnessLib.productionPaths({ BOTMANCERS_DB_PATH: configuredDb }) }, 'evidence_protected'],
    ['an existing file', existingEvidence, {}, 'evidence_exists'],
    ['a missing directory', path.join(plain, 'nope', 'evidence.json'), {}, 'evidence_invalid'],
    ['a new file elsewhere', path.join(plain, 'evidence.json'), {}, 'ok'],
  ];
  for (const [label, file, extra, expected] of evidenceCases) {
    const got = code(() => guard.validateEvidencePath(file, { workdir: disposable, ...extra }));
    assert(got === expected, `evidence ${label}: ${expected} (got ${got})`);
  }

  const smoke = (args, extraEnv = {}) => run(process.execPath, ['scripts/agent-deck-smoke.js', ...args], { ...process.env, AGENT_DECK_RUN_TOKEN: '', ...extraEnv });
  const smokeCases = [
    ['no --workdir', [], {}, /workdir_missing/],
    ['this repository as workdir', ['--workdir', harnessLib.REPO_ROOT, '--deck', 'd'], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /workdir_protected/],
    ['workdir without the marker', ['--workdir', noMarker, '--deck', 'd'], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /workdir_not_disposable/],
    ['no token', ['--workdir', disposable, '--deck', 'd'], {}, /token_missing/],
    ['no deck', ['--workdir', disposable], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /deck_missing/],
    ['a server URL with credentials', ['--workdir', disposable, '--deck', 'd', '--server', 'http://smokeuser:url-pass-123@127.0.0.1:1'], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /server_credentials/],
    ['evidence inside the workdir', ['--workdir', disposable, '--deck', 'd', '--evidence', path.join(disposable, 'evidence.json')], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /evidence_protected/],
    ['evidence inside this repository', ['--workdir', disposable, '--deck', 'd', '--evidence', path.join(harnessLib.REPO_ROOT, 'smoke-evidence.json')], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /evidence_protected/],
    ['evidence over an existing file', ['--workdir', disposable, '--deck', 'd', '--evidence', existingEvidence], { AGENT_DECK_RUN_TOKEN: 'adg_x_token_value' }, /evidence_exists/],
  ];
  for (const [label, args, extraEnv, pattern] of smokeCases) {
    const before = rootsOf('agent-deck-smoke');
    const result = await smoke(args, extraEnv);
    assert(result.code === 2 && pattern.test(result.err) && JSON.stringify(rootsOf('agent-deck-smoke')) === JSON.stringify(before),
      `smoke refuses ${label} (exit ${result.code}) before creating any state`);
    if (args.some(arg => /url-pass-123/.test(arg))) assert(!/url-pass-123/.test(result.out + result.err), 'the refusal never echoes the URL credential');
  }
  assert(!fs.existsSync(path.join(disposable, 'evidence.json')) && execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: disposable, encoding: 'utf8' }) === ''
    && !fs.existsSync(path.join(harnessLib.REPO_ROOT, 'smoke-evidence.json')) && fs.readFileSync(existingEvidence, 'utf8') === 'keep me\n',
  'refused evidence targets were never written: the workdir is clean, the repository has no evidence file, the existing file is intact');

  console.log('\nSmoke end to end against the fake Agent Deck over loopback (stand-in for a real server)');
  const secret = 'adg_selftest_SUPER_SECRET_value_42';
  const fake = createFakeAgentDeck({ token: secret });
  fake.onStart = body => ({ result: `Files: README.md. (echoing my credentials: Bearer ${secret})`, sessionId: 'smoke-session' });
  const url = await fake.listen();
  const evidencePath = path.join(scratchDir('evidence'), 'evidence.json');
  const smokeRun = await smoke(['--workdir', disposable, '--deck', 'deck-smoke', '--agent', 'codex', '--server', url, '--evidence', evidencePath], { AGENT_DECK_RUN_TOKEN: secret });
  await fake.close();
  const evidenceText = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath, 'utf8') : '';
  const evidence = evidenceText ? JSON.parse(evidenceText) : null;
  assert(smokeRun.code === 0 && /SMOKE RESULT: PASS/.test(smokeRun.out), `smoke passes against a loopback Agent Deck (exit ${smokeRun.code}${smokeRun.code ? `: ${smokeRun.out.slice(-800)} ${smokeRun.err.slice(-800)}` : ''})`);
  assert(evidence && evidence.run.request.state === 'completed' && /^run-/.test(evidence.run.attempts[0].externalRunId) && evidence.versions.node === process.version
    && evidence.versions.botmancers && evidence.deck === 'deck-smoke', 'evidence records versions, deck, request state, and the Agent Deck run id');
  assert(fake.calls('POST', '/api/agent-runs').length === 1 && fake.calls('POST', '/api/agent-runs')[0].body.tools === 'readonly'
    && fs.realpathSync(fake.calls('POST', '/api/agent-runs')[0].body.cwd) === disposable, 'one read-only run in the disposable workdir');
  assert(!evidenceText.includes(secret) && !smokeRun.out.includes(secret) && !smokeRun.err.includes(secret) && evidenceText.includes('Bearer [REDACTED]'),
    'the token never appears in the evidence or output (the echoed bearer is redacted)');
  assert(evidence && evidence.workdir.cleanAfter && evidence.workdir.headBefore === evidence.workdir.headAfter && evidence.productionStateUnchanged, 'workdir and production state unchanged');

  console.log('\nSmoke fails when the read-only turn modifies its workdir');
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
  const mutations = [
    ['dirties the workdir', cwd => fs.writeFileSync(path.join(cwd, 'written-by-agent.txt'), 'x'), ev => ev.workdir.cleanAfter === false],
    ['commits a new HEAD', cwd => execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'agent commit'], { cwd, env: gitEnv }), ev => ev.workdir.cleanAfter && ev.workdir.headBefore !== ev.workdir.headAfter],
  ];
  for (const [label, mutate, shape] of mutations) {
    const repo = gitRepo(scratchDir('mutated'), { [guard.DISPOSABLE_MARKER]: 'yes\n' });
    const mutating = createFakeAgentDeck({ token: secret });
    mutating.onStart = body => { mutate(body.cwd); return { result: 'Done.' }; };
    const mutatingUrl = await mutating.listen();
    const mutatedEvidencePath = path.join(scratchDir('evidence'), 'evidence.json');
    const mutated = await smoke(['--workdir', repo, '--deck', 'deck-smoke', '--server', mutatingUrl, '--evidence', mutatedEvidencePath], { AGENT_DECK_RUN_TOKEN: secret });
    await mutating.close();
    const mutatedEvidence = fs.existsSync(mutatedEvidencePath) ? JSON.parse(fs.readFileSync(mutatedEvidencePath, 'utf8')) : null;
    assert(mutated.code === 1 && /SMOKE RESULT: FAIL/.test(mutated.out) && mutatedEvidence && mutatedEvidence.result === 'failed'
      && mutatedEvidence.run.request.state === 'completed' && mutatedEvidence.workdir.unchanged === false && shape(mutatedEvidence),
      `a completed run that ${label} fails the smoke (exit ${mutated.code})`);
    const keptRoot = (/harness root preserved: (\S+)/.exec(mutated.out) || [])[1];
    if (keptRoot) fs.rmSync(keptRoot, { recursive: true, force: true });
  }

  console.log('    sample redacted evidence excerpt:');
  console.log(JSON.stringify({ run: evidence && { request: evidence.run.request, attempts: evidence.run.attempts, replyPreview: evidence.run.replyPreview }, versions: evidence && evidence.versions }, null, 2).split('\n').map(line => `      ${line}`).join('\n'));
  const redacted = guard.redact({ authorization: 'Bearer abc.def', apiKey: 'k-123456', nested: [{ note: 'token adg_live_123 and sk-abcdefghij' }], keep: 'hello' }, ['k-123456']);
  assert(redacted.authorization === '[REDACTED]' && redacted.apiKey === '[REDACTED]' && redacted.nested[0].note === 'token [REDACTED] and [REDACTED]' && redacted.keep === 'hello',
    'redact() scrubs secret-named fields, known values, and token patterns');
  const urlRedacted = guard.redact({ server: 'http://alice:hunter2@deck.example:1111/api', note: 'see https://ghost@deck.example/x and http://plain.example/a@b' }, []);
  assert(urlRedacted.server === 'http://[REDACTED]@deck.example:1111/api' && urlRedacted.note === 'see https://[REDACTED]@deck.example/x and http://plain.example/a@b',
    'redact() scrubs URL userinfo wherever it appears');

  // ===================================================================
  console.log('\nProduction-state snapshot: configured paths anywhere, at any depth');
  const configured = harnessLib.productionPaths({ BOTMANCERS_DB_PATH: configuredDb, BOTMANCERS_FILES_ROOT: path.join(tmp, 'configured-files') });
  assert([configuredDb, `${configuredDb}-wal`, `${configuredDb}-shm`, path.join(tmp, 'configured-files')].every(entry => configured.includes(entry)),
    'explicitly configured database (with -wal/-shm) and data root are checked even under the temp directory');
  const deepRoot = scratchDir('deep');
  const deepFile = path.join(deepRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'state.json');
  fs.mkdirSync(path.dirname(deepFile), { recursive: true });
  fs.writeFileSync(deepFile, '{"v":1}');
  const deepBefore = harnessLib.snapshotProductionState([deepRoot]);
  const { atime, mtime } = fs.statSync(deepFile);
  fs.writeFileSync(deepFile, '{"v":2}');
  fs.utimesSync(deepFile, atime, mtime);
  const deepChanges = harnessLib.diffSnapshots(deepBefore, harnessLib.snapshotProductionState([deepRoot]));
  assert(deepChanges.length === 1 && deepChanges[0].startsWith(deepFile), `a same-size rewrite of a file seven levels deep, with its mtime restored, is detected (${deepChanges.length} change(s))`);

  // ===================================================================
  console.log('\nProduction Botmancers state and this working tree');
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  const changes = harnessLib.diffSnapshots(productionBefore, harnessLib.snapshotProductionState());
  assert(changes.length === 0, `configured production paths and git status unchanged${changes.length ? `:\n    ${changes.join('\n    ')}` : ''}`);
  console.log(`    checked: ${harnessLib.productionPaths().join(', ')}`);

  console.log(failures === 0 ? '\nTEST RESULT: PASS' : `\nTEST RESULT: FAIL (${failures} assertion(s))`);
  return failures === 0 ? 0 : 1;
}

main().then(code => process.exit(code), error => {
  console.error(error);
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
