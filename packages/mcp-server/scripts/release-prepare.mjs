// Prepares a release PR: bumps the package version, stubs the CHANGELOG entry,
// updates the README pins, verifies with build + release:check, commits on
// release/X.Y.Z, and opens the PR against main. Run from the repository root:
//
//   npm run release:prepare -- patch --summary "why this release"
//   npm run release:prepare -- 0.12.0 --summary "why this release"
//   npm run release:prepare -- patch --summary test --dry   commit locally, no push, no PR
//
// --dry still creates the branch and the commit; it only skips the push and
// `gh pr create`. --no-verify skips the build and release:check run (testing
// only); the default verification is what the PR's ci run repeats.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const fail = message => {
  process.stderr.write(`release:prepare: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const noVerify = args.includes('--no-verify');
const summaryAt = args.findIndex(arg => arg === '--summary' || arg.startsWith('--summary='));
let summary = null;
if (summaryAt >= 0) {
  const arg = args[summaryAt];
  summary = arg === '--summary' ? args[summaryAt + 1] : arg.slice('--summary='.length);
}
const bump = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--summary');
if (!bump || !summary) fail('usage: npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "<why>" [--dry]');

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = message => process.stdout.write(`${message}\n`);

const pkgPath = join(PACKAGE_DIR, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version;

function bumped(kind) {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function compare(a, b) {
  const pa = a.split('-');
  const pb = b.split('-');
  const na = pa[0].split('.').map(Number);
  const nb = pb[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (na[i] !== nb[i]) return na[i] - nb[i];
  }
  if (pa.length === pb.length) return 0;
  return pa.length === 1 ? 1 : -1;
}

let version;
if (['patch', 'minor', 'major'].includes(bump)) {
  version = bumped(bump);
} else if (SEMVER.test(bump)) {
  version = bump;
} else {
  fail(`bump ${bump} is not patch, minor, major, or SemVer X.Y.Z`);
}
if (compare(version, current) <= 0) fail(`version ${version} is not newer than the current ${current}`);

const branch = `release/${version}`;
const subject = `Ship ${version}: ${summary}`;

const status = git('status', '--porcelain', '--untracked-files=normal');
if (status) fail(`working tree is not clean:\n${status}`);
try {
  git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  fail(`branch ${branch} already exists locally`);
} catch {
  // Branch does not exist locally; create it below. (A remote branch with the
  // same name fails at push time with the ref to delete.)
}

// Cut the branch first, so every edit below lands on it.
git('checkout', '-b', branch);
say(`created branch ${branch} from ${git('rev-parse', '--short', 'HEAD')}`);

// package.json + its lockfile. Only the version fields change; the pinned
// build tools and their integrity hashes are untouched.
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const lockPath = join(PACKAGE_DIR, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
say(`bumped ${current} -> ${version} in package.json and package-lock.json`);

// CHANGELOG entry stub. release:check requires the dated header and at least
// one change bullet; the summary is that bullet.
const changelogPath = join(PACKAGE_DIR, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) fail(`CHANGELOG.md already has a ## [${version}] entry`);
if (!changelog.includes('## [Unreleased]\n')) fail('CHANGELOG.md has no ## [Unreleased] section to stub under');
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  changelogPath,
  changelog.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${today}\n\n- ${summary}\n`),
);
say(`stubbed CHANGELOG.md ## [${version}] - ${today}`);

// README pinned examples. release:check requires every pin to equal the
// version; @latest is not a pin and is left alone.
const readmePath = join(PACKAGE_DIR, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const pins = readme.match(new RegExp(`npx botmancers@${current.replace(/\./g, '\\.')}`, 'g')) ?? [];
if (pins.length === 0) fail(`README.md has no npx botmancers@${current} pin to update`);
writeFileSync(readmePath, readme.split(`npx botmancers@${current}`).join(`npx botmancers@${version}`));
say(`updated ${pins.length} README pin(s) to ${version}`);

if (!noVerify) {
  say('verifying: build + release:check (dry run, no registry mutation)');
  for (const step of [['npm', ['run', 'build']], ['npm', ['run', 'build:app']], ['node', ['scripts/release.mjs', '--allow-dirty']]]) {
    execFileSync(step[0], step[1], { cwd: PACKAGE_DIR, stdio: 'inherit' });
  }
  say('build + release:check passed');
}

git('add', 'packages/mcp-server/package.json', 'packages/mcp-server/package-lock.json', 'packages/mcp-server/CHANGELOG.md', 'packages/mcp-server/README.md');
git('commit', '-m', subject);
say(`committed "${subject}" on ${branch}`);

if (dry) {
  say(`dry run: skipping push and gh pr create for ${branch}`);
  process.exit(0);
}
git('push', '-u', 'origin', branch);
const body = `Release botmancers ${version}.\n\n${summary}\n\nPrepared with \`npm run release:prepare\`. The release:check dry run passed on this branch; ci re-runs it. Merge with \`npm run release:finish -- <pr-number>\`.`;
const pr = execFileSync('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', subject, '--body', body], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
say(`opened ${pr}`);
say(`merge with: npm run release:finish -- <pr-number>`);
