// Offline tests for scripts/release-publish-ci.mjs. The registry check is
// injected through NPM_BIN (a stub npm on PATH) and the release check through
// GH_BIN (a stub gh), so no network is needed: version already published ->
// publish skipped but the GitHub Release still ensured; registry 404 -> would
// publish (and the live path publishes with provenance, then creates the
// release); any other registry error -> fail closed with no publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH_ARGS, classifyRegistryProbe, extractChangelogNotes } from '../scripts/release-publish-ci.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'release-publish-ci.mjs');
const version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const tag = `v${version}`;

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

// A stub gh that logs every invocation and answers `release view` /
// `release create` per mode.
function stubGh(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-release-ci-test-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const stub = join(dir, 'gh-stub.sh');
  writeFileSync(stub, `#!/bin/sh
echo "$@" >> '${log}'
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  case '${mode}' in
    exists) echo '{"tagName":"${tag}"}' ;;
    *) echo "could not find a Release for tag name \\"${tag}\\"" >&2; exit 1 ;;
  esac
elif [ "$1" = "release" ] && [ "$2" = "create" ]; then
  case '${mode}' in
    missing) echo "https://github.com/not-so-fat/botmancers/releases/tag/${tag}" ;;
    *) echo "stub gh: create failed" >&2; exit 1 ;;
  esac
fi
`);
  chmodSync(stub, 0o755);
  return { stub, log };
}

function run(args, { npmBin, ghBin }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NPM_BIN: npmBin, GH_BIN: ghBin },
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

test('extractChangelogNotes: body without the header, null when missing', () => {
  const changelog = readFileSync(join(HERE, '..', 'CHANGELOG.md'), 'utf8');
  const notes = extractChangelogNotes(changelog, version);
  assert.ok(notes && notes.length > 0);
  assert.equal(notes.includes(`## [${version}]`), false);
  assert.match(notes, /^- /m);
  assert.equal(extractChangelogNotes(changelog, '0.0.0'), null);
  assert.equal(extractChangelogNotes('# Changelog\n\n## [Unreleased]\n', version), null);
});

test('the publish command carries provenance and the latest dist-tag, with no credential flag', () => {
  assert.deepEqual(PUBLISH_ARGS, ['publish', '--provenance', '--tag', 'latest', '--loglevel', 'verbose']);
  assert.ok(!PUBLISH_ARGS.some(arg => /otp|token|auth/i.test(arg)));
});

test('version already on npm -> publish skipped, release already exists, exit 0', () => {
  const npm = stubNpm('published');
  const gh = stubGh('exists');
  const ran = run(['--tag', tag], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /already on npm; skipping publish/);
  assert.ok(calls(npm.log).some(line => line.startsWith('view ')), 'checked the registry');
  assert.ok(!calls(npm.log).some(line => line.startsWith('publish')), 'never published');
  assert.ok(calls(gh.log).some(line => line.startsWith('release view ')), 'checked the release');
  assert.ok(!calls(gh.log).some(line => line.startsWith('release create ')), 'never re-created the release');
  assert.match(ran.stdout, new RegExp(`GitHub Release ${tag.replace(/\./g, '\\.')} already exists`));
});

test('version already on npm but release missing -> release created, exit 0', () => {
  const npm = stubNpm('published');
  const gh = stubGh('missing');
  const ran = run(['--tag', tag], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /already on npm; skipping publish/);
  assert.ok(!calls(npm.log).some(line => line.startsWith('publish')), 'never published');
  assert.equal(calls(gh.log).filter(line => line.startsWith('release create ')).length, 1);
  assert.match(ran.stdout, new RegExp(`created GitHub Release ${tag.replace(/\./g, '\\.')}`));
});

test('registry 404 + --dry -> would publish and would create the release, exit 0, no calls', () => {
  const npm = stubNpm('missing');
  const gh = stubGh('missing');
  const ran = run(['--tag', tag, '--dry'], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`would publish botmancers@${version.replace(/\./g, '\\.')}`));
  assert.match(ran.stdout, /--provenance --tag latest/);
  assert.match(ran.stdout, new RegExp(`would create the GitHub Release ${tag.replace(/\./g, '\\.')}`));
  assert.ok(!calls(npm.log).some(line => line.startsWith('publish')), 'dry run never publishes');
  assert.deepEqual(calls(gh.log), []);
});

test('registry 404 -> publishes with provenance, then creates the release', () => {
  const npm = stubNpm('missing');
  const gh = stubGh('missing');
  const ran = run(['--tag', tag], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 0, ran.stderr);
  const published = calls(npm.log).filter(line => line.startsWith('publish'));
  assert.equal(published.length, 1);
  assert.equal(published[0], PUBLISH_ARGS.join(' '));
  assert.match(ran.stdout, new RegExp(`published botmancers@${version.replace(/\./g, '\\.')}`));
  const created = calls(gh.log).filter(line => line.startsWith('release create '));
  assert.equal(created.length, 1);
  assert.ok(created[0].includes(tag) && created[0].includes('--notes-file'), 'release created from notes');
  assert.match(ran.stdout, new RegExp(`created GitHub Release ${tag.replace(/\./g, '\\.')}`));
});

test('release creation failure -> exit 1 after the publish', () => {
  const npm = stubNpm('missing');
  const gh = stubGh('broken');
  const ran = run(['--tag', tag], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 1);
  assert.equal(calls(npm.log).filter(line => line.startsWith('publish')).length, 1);
  assert.match(ran.stderr, /release create/);
});

test('any other registry error -> fail closed, exit 1, no publish or release call', () => {
  const npm = stubNpm('error');
  const gh = stubGh('missing');
  const ran = run(['--tag', tag], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /failing closed, nothing published/);
  assert.ok(!calls(npm.log).some(line => line.startsWith('publish')), 'never published');
  assert.deepEqual(calls(gh.log), []);
});

test('tag that does not match the package version -> refuse before touching the registry', () => {
  const npm = stubNpm('missing');
  const gh = stubGh('missing');
  const ran = run(['--tag', 'v0.0.0'], { npmBin: npm.stub, ghBin: gh.stub });
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /does not match v/);
  assert.deepEqual(calls(npm.log), []);
  assert.deepEqual(calls(gh.log), []);
});
