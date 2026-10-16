// Release publish authentication: the workflow's publish step must hand npm a
// real bootstrap token when one is configured, and otherwise reach
// `npm publish` with NODE_AUTH_TOKEN absent (not empty) and no _authToken
// npmrc entry, so npm performs the trusted-publishing (OIDC) exchange. Runs
// scripts/publish-ci.sh against a fake npm that records what it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE_DIR, 'scripts/publish-ci.sh');
const WORKFLOW = join(PACKAGE_DIR, '../../.github/workflows/release-botmancers.yml');
// What actions/setup-node writes with registry-url, and the job-wide
// placeholder it exports.
const SETUP_NODE_NPMRC = '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\nalways-auth=false\n';
const SETUP_NODE_PLACEHOLDER = 'XXXXX-XXXXX-XXXXX-XXXXX';

function runPublishStep({ bootstrapToken, oidc = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-publish-auth-'));
  try {
    const bin = join(dir, 'bin');
    const home = join(dir, 'home');
    mkdirSync(bin);
    mkdirSync(home);
    const npmrc = join(dir, '.npmrc');
    writeFileSync(npmrc, SETUP_NODE_NPMRC);
    const record = join(dir, 'npm-call.json');
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  hasToken: Object.prototype.hasOwnProperty.call(process.env, 'NODE_AUTH_TOKEN'),
  token: process.env.NODE_AUTH_TOKEN ?? null,
  bootstrapVisible: 'BOOTSTRAP_NPM_TOKEN' in process.env,
  npmrc: readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8'),
}));
`);
    chmodSync(join(bin, 'npm'), 0o755);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      NPM_CONFIG_USERCONFIG: npmrc,
      NODE_AUTH_TOKEN: SETUP_NODE_PLACEHOLDER,
      // GitHub Actions substitutes a missing secret with an empty string.
      BOOTSTRAP_NPM_TOKEN: bootstrapToken ?? '',
    };
    if (oidc) env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.example/id';
    const result = spawnSync('bash', [SCRIPT], { cwd: PACKAGE_DIR, env, encoding: 'utf8' });
    let call = null;
    try { call = JSON.parse(readFileSync(record, 'utf8')); } catch { /* npm not reached */ }
    return { status: result.status, output: result.stdout + result.stderr, call };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bootstrap mode: a non-empty NPM_TOKEN reaches npm publish', () => {
  const { status, output, call } = runPublishStep({ bootstrapToken: 'npm_bootstrapSecret123' });
  assert.equal(status, 0, output);
  assert.deepEqual(call.args, ['publish', '--provenance', '--access', 'public', '--tag', 'canary']);
  assert.equal(call.token, 'npm_bootstrapSecret123');
  assert.equal(call.bootstrapVisible, false);
  assert.match(call.npmrc, /_authToken=\$\{NODE_AUTH_TOKEN\}/);
  assert.match(output, /bootstrap NPM_TOKEN \(token mode\)/);
  assert.doesNotMatch(output, /npm_bootstrapSecret123/);
});

test('OIDC mode: npm publish runs with NODE_AUTH_TOKEN absent, not empty, and no _authToken entry', () => {
  for (const bootstrapToken of ['', undefined]) {
    const { status, output, call } = runPublishStep({ bootstrapToken });
    assert.equal(status, 0, output);
    assert.deepEqual(call.args, ['publish', '--provenance', '--access', 'public', '--tag', 'canary']);
    assert.equal(call.hasToken, false, `NODE_AUTH_TOKEN reached npm as ${JSON.stringify(call.token)}`);
    assert.doesNotMatch(call.npmrc, /_authToken/);
    assert.match(call.npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
    assert.match(output, /trusted publishing \(OIDC\); NODE_AUTH_TOKEN unset/);
  }
});

test('OIDC mode without an id-token refuses to publish', () => {
  const { status, output, call } = runPublishStep({ bootstrapToken: '', oidc: false });
  assert.notEqual(status, 0);
  assert.equal(call, null);
  assert.match(output, /No GitHub OIDC token is available/);
});

test('the release workflow publishes only through the mode-selecting script', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^\s*run: bash scripts\/publish-ci\.sh$/m);
  assert.match(workflow, /^\s*BOOTSTRAP_NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}$/m);
  assert.doesNotMatch(workflow, /^\s*NODE_AUTH_TOKEN:/m);
  assert.doesNotMatch(workflow, /^\s*run:[^\n]*npm publish/m);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /registry-url: 'https:\/\/registry\.npmjs\.org'/);
  assert.match(workflow, /working-directory: packages\/mcp-server/);
});

test('RELEASING.md orders the trusted-publishing transition safely', () => {
  const doc = readFileSync(join(PACKAGE_DIR, 'RELEASING.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## First publication'));
  const checklist = [
    [/within two days/, 'two-day trusted-publisher validation window'],
    [/published version can never be republished[\s\S]*next patch/, 'explicit follow-up version bump'],
    [/immediately before tagging the\s+follow-up release/, 'configure trusted publisher just before the follow-up release'],
    [/Delete the `NPM_TOKEN`\s+secret[\s\S]*Do \*\*not\*\* revoke the\s+token/, 'withhold the secret but keep the token as rollback'],
    [/\*\*Rollback\*\*/, 'rollback procedure'],
    [/\*\*Only after a successful OIDC publish\*\*, revoke the bootstrap token/, 'post-success revocation'],
    [/disallow tokens/, 'disallow-tokens publishing access'],
  ];
  const missing = checklist.filter(([pattern]) => !pattern.test(section)).map(([, label]) => label);
  assert.deepEqual(missing, []);
  const order = ['Configure the trusted publisher', 'Withhold the token', 'Follow-up release through OIDC', 'Only after a successful OIDC publish', 'disallow tokens'];
  const positions = order.map(marker => section.indexOf(marker));
  assert.ok(positions.every(pos => pos >= 0), `missing step: ${order[positions.indexOf(-1)]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'transition steps are out of order');
  // The token must not be revoked before the OIDC proof.
  const proof = section.indexOf('Follow-up release through OIDC');
  assert.ok(!/revoke the (bootstrap )?token/i.test(section.slice(0, proof).replace(/Do \*\*not\*\* revoke the\s+token/g, '')),
    'the bootstrap token is revoked before the OIDC publish succeeds');
});
