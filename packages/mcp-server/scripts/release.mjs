// Release gate for the botmancers package. Never mutates the registry: it
// verifies, then prints the operator's publish steps.
//
//   node scripts/release.mjs                  full check (requires a clean git tree)
//   node scripts/release.mjs --tag <tag>      also require the git tag to be botmancers-v<version> (CI)
//   node scripts/release.mjs --allow-dirty    skip the clean-tree check (local iteration only)
//
// Checks, in order: version consistency (package.json, CHANGELOG, README pin,
// tag), clean git state, tests, package contents, provenance/attestation
// support, `npm publish --dry-run`, and a canary install of the exact tarball
// into a clean temporary project.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_DIR, checkManifest, packManifest } from './check-pack.mjs';

const args = process.argv.slice(2);
const tagAt = args.indexOf('--tag');
const gitTag = tagAt >= 0 ? args[tagAt + 1] : null;
const allowDirty = args.includes('--allow-dirty');

const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/release-botmancers.yml');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const version = pkg.version;
let failed = false;

function step(name, fn) {
  try {
    const detail = fn();
    process.stdout.write(`PASS  ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`FAIL  ${name} — ${error.message.trim().split('\n').slice(-8).join('\n      ')}\n`);
  }
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

process.stdout.write(`botmancers release check (dry run, no registry mutation): ${pkg.name}@${version}\n`);
let commit = 'unknown';
try { commit = run('git', ['rev-parse', 'HEAD']).trim(); } catch { /* not a checkout */ }
process.stdout.write(`commit ${commit}\n\n`);

step('version consistency', () => {
  assert(SEMVER.test(version), `package.json version ${version} is not SemVer`);
  const changelog = readFileSync(join(PACKAGE_DIR, 'CHANGELOG.md'), 'utf8');
  const entry = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  assert(entry.test(changelog), `CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry`);
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8');
  const pins = [...readme.matchAll(/npx botmancers@(\d[^\s`]*)/g)].map(match => match[1]);
  assert(pins.length > 0 && pins.every(pin => pin === version), `README pinned examples (${pins.join(', ') || 'none'}) must all be ${version}`);
  const cliVersion = run(process.execPath, ['dist/cli.js', '--version']).trim();
  assert(cliVersion === version, `built CLI reports ${cliVersion}; run npm run build`);
  if (gitTag) assert(gitTag === `botmancers-v${version}`, `git tag ${gitTag} does not match botmancers-v${version}`);
  return `package.json, CHANGELOG, README pin, CLI${gitTag ? `, tag ${gitTag}` : ''} all ${version}`;
});

step('changelog entry', () => {
  const changelog = readFileSync(join(PACKAGE_DIR, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split(/^## /m).find(part => part.startsWith(`[${version}]`)) ?? '';
  assert(/^- \S/m.test(section), `the ${version} changelog entry lists no changes`);
  return `## [${version}] has ${section.match(/^- /gm).length} item(s)`;
});

step('clean git state', () => {
  if (allowDirty) return 'skipped (--allow-dirty)';
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: REPO_ROOT }).trim();
  assert(status === '', `uncommitted changes:\n${status}`);
  return 'no uncommitted or untracked files';
});

step('tests', () => {
  const out = run('npm', ['test']);
  const pass = /ℹ pass (\d+)/.exec(out)?.[1];
  const fail = /ℹ fail (\d+)/.exec(out)?.[1];
  assert(fail === '0', `npm test reported ${fail} failure(s)`);
  return `npm test: ${pass} passed, 0 failed`;
});

step('package contents', () => {
  const entry = packManifest();
  const problems = checkManifest(entry);
  assert(problems.length === 0, problems.join('; '));
  return `${entry.entryCount} files, allowlist only: ${entry.files.map(file => file.path).sort().join(' ')}`;
});

step('provenance and attestation support', () => {
  assert(pkg.publishConfig?.provenance === true, 'publishConfig.provenance must be true');
  assert(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public');
  assert(pkg.publishConfig?.tag === 'canary', 'publishConfig.tag must be canary so a publish never lands on latest directly');
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT }).trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  const declared = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  assert(declared === remote, `repository.url ${declared} must match origin ${remote} (provenance verification)`);
  assert(existsSync(WORKFLOW), 'release workflow .github/workflows/release-botmancers.yml is missing');
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert(/id-token:\s*write/.test(workflow), 'release workflow must grant id-token: write');
  assert(/npm publish[^\n]*--provenance/.test(workflow), 'release workflow must publish with --provenance');
  assert(/release:check[^\n]*--tag/.test(workflow), 'release workflow must run release:check against the tag');
  return 'publishConfig provenance/public/canary, repository matches origin, workflow has id-token: write and --provenance';
});

step('npm publish --dry-run', () => {
  const out = run('npm', ['publish', '--dry-run', '--ignore-scripts', '--provenance=false'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return `would publish ${out.trim().split('\n').pop()} with dist-tag canary`;
});

step('canary install of the exact tarball', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-release-'));
  try {
    const [entry] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir]));
    const tarball = join(dir, entry.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const out = run(process.execPath, ['scripts/smoke-install.mjs', '--tarball', tarball]);
    assert(/^PASS clean-install smoke/m.test(out), out);
    return `${entry.filename} ${integrity} installed into a clean project; npx botmancers served health, tools/list, tools/call`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  process.stdout.write('\nRelease check FAILED. Nothing was published.\n');
  process.exit(1);
}
process.stdout.write(`
Release check PASSED for botmancers@${version}. Nothing was published.
Operator steps (see packages/mcp-server/RELEASING.md):
  1. git tag botmancers-v${version} ${commit.slice(0, 12)} && git push origin botmancers-v${version}
     -> CI re-runs this check and publishes with provenance to dist-tag "canary"
  2. node packages/mcp-server/scripts/smoke-install.mjs --registry ${version}
  3. npm dist-tag add botmancers@${version} latest     (2FA; promotes the verified canary to stable)
`);
