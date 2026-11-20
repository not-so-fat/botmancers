// Offline tests for scripts/release-publish-ci.mjs. The registry check is
// injected through NPM_BIN (a stub npm on PATH), so no network is needed:
// version already published -> publish skipped; registry 404 -> would
// publish (and the live path publishes with provenance); any other registry
// error -> fail closed with no publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH_ARGS, classifyRegistryProbe } from '../scripts/release-publish-ci.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'release-publish-ci.mjs');
const version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const tag = `botmancers-v${version}`;

// A stub npm that logs every invocation and answers `view` per mode. Once a
// publish call is logged, `view` reports the version, like the real registry
// after a publish.
function stubNpm(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-publish-ci-test-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const stub = join(dir, 'npm-stub.sh');
  writeFileSync(stub, `#!/bin/sh
echo "$@" >> '${log}'
if [ "$1" = "view" ]; then
  if grep -q '^publish' '${log}' 2>/dev/null; then
    echo '${version}'
  else
    case '${mode}' in
      published) echo '${version}' ;;
      missing)
        echo "npm error 404 Not Found - GET https://registry.npmjs.org/botmancers - Not found" >&2
        echo "npm error 404  'botmancers@${version}' is not in this registry." >&2
        exit 1 ;;
      error)
        echo "npm error code ENEEDAUTH" >&2
        echo "npm error Unable to authenticate" >&2
        exit 1 ;;
    esac
  fi
elif [ "$1" = "publish" ]; then
  echo "stub published: $@"
fi
`);
  chmodSync(stub, 0o755);
  return { stub, log };
}

function run(args, npmBin) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NPM_BIN: npmBin },
  });
}

const calls = log => readFileSync(log, 'utf8').split('\n').filter(Boolean);

test('classifyRegistryProbe: published, missing, and fail-closed errors', () => {
  assert.equal(classifyRegistryProbe({ status: 0, output: `${version}\n`, version }), 'published');
  assert.equal(classifyRegistryProbe({ status: 1, output: "npm error 404  'botmancers@9.9.9' is not in this registry.", version: '9.9.9' }), 'missing');
  assert.equal(classifyRegistryProbe({ status: 1, output: 'npm error 404 Not Found - GET https://registry.npmjs.org/botmancers', version }), 'missing');
  assert.equal(classifyRegistryProbe({ status: 1, output: 'npm error code EAI_AGAIN', version }), 'error');
  assert.equal(classifyRegistryProbe({ status: 1, output: 'npm error code ENEEDAUTH', version }), 'error');
  assert.equal(classifyRegistryProbe({ status: 1, output: '', version }), 'error');
  assert.equal(classifyRegistryProbe({ status: 0, output: '\n', version }), 'error');
  assert.equal(classifyRegistryProbe({ status: 0, output: '0.0.0\n', version }), 'error');
});

test('the publish command carries provenance and the latest dist-tag, with no credential flag', () => {
  assert.deepEqual(PUBLISH_ARGS, ['publish', '--provenance', '--tag', 'latest', '--loglevel', 'verbose']);
  assert.ok(!PUBLISH_ARGS.some(arg => /otp|token|auth/i.test(arg)));
});

test('version already on npm -> publish skipped, exit 0', () => {
  const { stub, log } = stubNpm('published');
  const ran = run(['--tag', tag], stub);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /already on npm; skipping publish/);
  assert.ok(calls(log).some(line => line.startsWith('view ')), 'checked the registry');
  assert.ok(!calls(log).some(line => line.startsWith('publish')), 'never published');
});

test('registry 404 + --dry -> would publish, exit 0, no publish call', () => {
  const { stub, log } = stubNpm('missing');
  const ran = run(['--tag', tag, '--dry'], stub);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`would publish botmancers@${version.replace(/\./g, '\\.')}`));
  assert.match(ran.stdout, /--provenance --tag latest/);
  assert.ok(!calls(log).some(line => line.startsWith('publish')), 'dry run never publishes');
});

test('registry 404 -> publishes with provenance, then sees the version', () => {
  const { stub, log } = stubNpm('missing');
  const ran = run(['--tag', tag], stub);
  assert.equal(ran.status, 0, ran.stderr);
  const published = calls(log).filter(line => line.startsWith('publish'));
  assert.equal(published.length, 1);
  assert.equal(published[0], PUBLISH_ARGS.join(' '));
  assert.match(ran.stdout, new RegExp(`published botmancers@${version.replace(/\./g, '\\.')}`));
});

test('any other registry error -> fail closed, exit 1, no publish call', () => {
  const { stub, log } = stubNpm('error');
  const ran = run(['--tag', tag], stub);
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /failing closed, nothing published/);
  assert.ok(!calls(log).some(line => line.startsWith('publish')), 'never published');
});

test('tag that does not match the package version -> refuse before touching the registry', () => {
  const { stub, log } = stubNpm('missing');
  const ran = run(['--tag', 'botmancers-v0.0.0'], stub);
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /does not match botmancers-v/);
  assert.deepEqual(calls(log), []);
});
