// Release gate for the botmancers package. Never mutates the registry: it
// verifies, then prints the operator's publish steps.
//
//   node scripts/release.mjs                  full check (requires a clean git tree)
//   node scripts/release.mjs --tag <tag>      also require the git tag to be botmancers-v<version> (CI)
//   node scripts/release.mjs --allow-dirty    skip the clean-tree check (local iteration only)
//   node scripts/release.mjs --out file       also save the transcript
//
// Checks, in order: version consistency (package.json, CHANGELOG, README pin,
// tag), clean git state, locked build toolchain (committed package-lock.json,
// exact devDependency pins, `npm ci` in the workflow, installed tools match
// the lock), the packaged app build (app/ built from this commit and
// version), tests, package contents, publish
// config, `npm publish --dry-run`, and canary installs of the exact tarball
// into clean temporary projects: bridge-only, the full product, and the
// managed install (scripts/install.sh, launcher, staged N+1, restart, rollback).
// Run `npm run build && npm run build:app` first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_DIR, checkManifest, packManifest } from './check-pack.mjs';

const args = process.argv.slice(2);
const tagAt = args.indexOf('--tag');
const gitTag = tagAt >= 0 ? args[tagAt + 1] : null;
const allowDirty = args.includes('--allow-dirty');
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args[outAt + 1] : null;

const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/release-botmancers.yml');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const version = pkg.version;
let failed = false;
const transcript = [];
const print = text => {
  transcript.push(text);
  process.stdout.write(text);
  // Append as we go, so a process that dies mid-run still leaves its transcript.
  if (outFile) appendFileSync(outFile, text);
};
const finish = code => {
  // Exit only once stdout has drained; a bare process.exit() can cut a piped transcript short.
  process.stdout.write('', () => process.exit(code));
};

function step(name, fn) {
  if (outFile) appendFileSync(outFile, `RUN   ${name}\n`);
  try {
    const detail = fn();
    print(`PASS  ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    failed = true;
    // execFileSync's message has the command and stderr only; the smokes explain themselves on stdout.
    const stdout = String(error.stdout ?? '').trim().split('\n').slice(-25).join('\n');
    const detail = `${error.message.trim().split('\n').slice(-(name === 'tests' ? 40 : 8)).join('\n')}${stdout && name !== 'tests' ? `\n${stdout}` : ''}`;
    print(`FAIL  ${name} — ${detail.split('\n').join('\n      ')}\n`);
  }
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

print(`botmancers release check (dry run, no registry mutation): ${pkg.name}@${version}\n`);
let commit = 'unknown';
try { commit = run('git', ['rev-parse', 'HEAD']).trim(); } catch { /* not a checkout */ }
print(`commit ${commit}\n\n`);

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

step('locked build toolchain', () => {
  const lockPath = join(PACKAGE_DIR, 'package-lock.json');
  assert(existsSync(lockPath), 'packages/mcp-server/package-lock.json is missing; the release build must be reproducible');
  try {
    run('git', ['ls-files', '--error-unmatch', 'package-lock.json']);
  } catch {
    throw new Error('package-lock.json is not committed');
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert(lock.lockfileVersion >= 2, `package-lock.json lockfileVersion ${lock.lockfileVersion} is too old for npm ci`);
  const root = lock.packages?.[''] ?? {};
  for (const field of ['dependencies', 'devDependencies']) {
    assert(JSON.stringify(root[field] ?? {}) === JSON.stringify(pkg[field] ?? {}),
      `package-lock.json ${field} do not match package.json; regenerate the lockfile`);
  }
  const require = createRequire(join(PACKAGE_DIR, 'package.json'));
  const pinned = [];
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    assert(SEMVER.test(spec), `devDependency ${name}@${spec} must be pinned to an exact version`);
    const locked = lock.packages[`node_modules/${name}`]?.version;
    assert(locked === spec, `package-lock.json locks ${name}@${locked}, package.json pins ${spec}`);
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
    assert(installed === locked, `installed ${name}@${installed} differs from the locked ${locked}; run npm ci`);
    pinned.push(`${name}@${locked}`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert(/^sha512-/.test(entry.integrity ?? ''), `${path} has no sha512 integrity in package-lock.json`);
    assert((entry.resolved ?? '').startsWith('https://registry.npmjs.org/'), `${path} does not resolve from registry.npmjs.org`);
  }
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert(/^\s*run:\s*npm ci\b/m.test(workflow), 'release workflow must install build tools with npm ci');
  assert(!/npm install(?! -g npm@)/.test(workflow), 'release workflow must not use npm install for build tools');
  return `package-lock.json committed, workflow uses npm ci, installed ${pinned.join(', ')} match the lock`;
});

step('packaged app build', () => {
  const infoPath = join(PACKAGE_DIR, 'app/BUILD_INFO.json');
  assert(existsSync(infoPath), 'app/ is not built; run npm run build:app');
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  assert(info.version === version, `app/ was built as ${info.version}, package is ${version}; run npm run build:app`);
  if (!allowDirty) {
    assert(info.commit === commit, `app/ was built from ${info.commit}, HEAD is ${commit}; run npm run build:app`);
    assert(!info.dirty, 'app/ was built from a dirty tree; commit, then run npm run build:app');
  }
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert(/npm run build:app/.test(workflow), 'release workflow must build the packaged app (npm run build:app)');
  assert(/working-directory:\s*\.\s*\n\s*run:\s*npm ci\b/.test(workflow), 'release workflow must install the app\'s locked dependencies with npm ci at the repository root');
  return `app/ ${info.version} from ${info.commit.slice(0, 12)}${info.dirty ? ' (dirty)' : ''}, next ${info.next}`;
});

step('tests', () => {
  let out;
  try {
    out = run('npm', ['test']);
  } catch (error) {
    // execFileSync's message carries only stderr (build warnings); the failing
    // test names and assertions are on stdout.
    const stdout = String(error.stdout ?? '');
    const failing = stdout.split('\n').filter(line => /^\s*(✖|not ok)|Error|expected|actual/.test(line)).slice(0, 30);
    throw new Error(`npm test failed (exit ${error.status})\n${(failing.length ? failing : stdout.split('\n').slice(-30)).join('\n')}`);
  }
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

step('publish configuration', () => {
  assert(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public');
  assert(pkg.publishConfig?.tag === undefined, 'publishConfig.tag must be unset: a publish goes straight to latest');
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT }).trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  const declared = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  assert(declared === remote, `repository.url ${declared} must match origin ${remote}`);
  assert(existsSync(WORKFLOW), 'release workflow .github/workflows/release-botmancers.yml is missing');
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert(!/npm publish/.test(workflow.replace(/^\s*#.*$/gm, '')), 'release workflow must not publish: the operator runs npm run release:publish with a 2FA code');
  assert(/release:check[^\n]*--tag/.test(workflow), 'release workflow must run release:check against the tag');
  return 'publishConfig public with no tag, repository matches origin, workflow checks the tag and does not publish';
});

step('managed install entry point', () => {
  const script = join(REPO_ROOT, 'scripts', 'install.sh');
  assert(existsSync(script), 'scripts/install.sh (the curl | bash managed install) is missing');
  const text = readFileSync(script, 'utf8');
  assert(/npx --yes "\$spec" install/.test(text) && /botmancers@\$\{BOTMANCERS_VERSION:-latest\}/.test(text), 'scripts/install.sh must run `npx botmancers@<latest|BOTMANCERS_VERSION> install`');
  assert((statSync(script).mode & 0o111) !== 0, 'scripts/install.sh must be executable');
  return 'scripts/install.sh runs npx botmancers@latest install (version-agnostic)';
});

step('npm publish --dry-run', () => {
  const out = run('npm', ['publish', '--dry-run', '--ignore-scripts', '--provenance=false'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return `would publish ${out.trim().split('\n').pop()} to latest`;
});

step('canary install of the exact tarball', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-release-'));
  try {
    const [entry] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { maxBuffer: 64 * 1024 * 1024 }));
    const tarball = join(dir, entry.filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const out = run(process.execPath, ['scripts/smoke-install.mjs', '--tarball', tarball]);
    assert(/^PASS clean-install smoke/m.test(out), out);
    const product = run(process.execPath, ['scripts/smoke-product-install.mjs', '--tarball', tarball], { maxBuffer: 16 * 1024 * 1024 });
    assert(/^PASS product install smoke/m.test(product), product);
    const managed = run(process.execPath, ['scripts/smoke-managed-install.mjs', '--tarball', tarball], { maxBuffer: 16 * 1024 * 1024 });
    assert(/^PASS managed install smoke/m.test(managed), managed);
    return `${entry.filename} ${integrity} installed into clean projects; npx botmancers served health, tools/list, tools/call; botmancers setup/start --daemon served the UI, /api/v0, and the bridge against the same engine, kept state across stop/start, and stopped cleanly; scripts/install.sh installed it as a managed release whose launcher ran the product, staged N+1 beside it, activated N+1 at one restart, rolled back, and kept user state`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  print('\nRelease check FAILED. Nothing was published.\n');
  finish(1);
  await new Promise(() => {}); // wait for the drain callback to exit
}
print(`
Release check PASSED for botmancers@${version}. Nothing was published.
Operator steps (see packages/mcp-server/RELEASING.md):
  1. npm run release:tag:push   (repository root; after the release PR is merged)
     -> CI re-runs this check against the tag (it does not publish)
  2. npm run release:publish -- --otp <code>   (operator; publishes to latest from a clean clone of the tag)
  3. node packages/mcp-server/scripts/smoke-install.mjs --registry ${version}
     node packages/mcp-server/scripts/smoke-product-install.mjs --registry ${version}
     BOTMANCERS_VERSION=${version} bash scripts/install.sh   (managed install from the registry, clean account)
`);
finish(0);
