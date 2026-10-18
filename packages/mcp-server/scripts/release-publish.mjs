// Publishes the tagged release to npm (dist-tag latest) from a fresh clone of the tag,
// so the tarball is built from exactly the tagged commit, never from a working tree.
// Run it from the repository root once release-botmancers.yml is green on the tag:
//
//   npm run release:publish -- --otp 123456    publish (the 2FA code is the only manual input)
//   npm run release:publish -- --dry           do everything except publish
//
// The tag is botmancers-v<version of origin/main>, the one `npm run release:tag:push` created.
// It refuses when that tag is not on the remote or the version is already on the registry.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const otpAt = args.indexOf('--otp');
const otp = otpAt >= 0 ? args[otpAt + 1] : null;
const fail = message => {
  process.stderr.write(`release:publish: ${message}\n`);
  process.exit(1);
};
if (!dry && !/^\d{6,8}$/.test(otp ?? '')) fail('pass the npm 2FA code: npm run release:publish -- --otp <code> (or --dry)');

const out = (command, commandArgs, cwd) => execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (command, commandArgs, cwd) => {
  process.stdout.write(`$ ${command} ${commandArgs.join(' ').replace(/--otp \d+/, '--otp ******')}\n`);
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit' });
};

out('git', ['fetch', '--tags', 'origin', 'main'], process.cwd());
const version = JSON.parse(out('git', ['show', 'origin/main:packages/mcp-server/package.json'], process.cwd())).version;
const tag = `botmancers-v${version}`;
const origin = out('git', ['remote', 'get-url', 'origin'], process.cwd());
if (!out('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], process.cwd())) fail(`${tag} is not on origin; run npm run release:tag:push first`);
let published = '';
try {
  published = out('npm', ['view', `botmancers@${version}`, 'version'], process.cwd());
} catch {
  // E404: not published yet, which is what we want.
}
if (published) fail(`botmancers@${version} is already on the registry; bump the version instead`);

const dir = mkdtempSync(join(tmpdir(), 'botmancers-publish-'));
try {
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, origin, dir], process.cwd());
  const pkg = join(dir, 'packages/mcp-server');
  run('npm', ['ci', '--no-audit', '--no-fund'], dir);
  run('npm', ['ci', '--no-audit', '--no-fund'], pkg);
  run('npm', ['run', 'build'], pkg);
  run('npm', ['run', 'build:app'], pkg);
  run('npm', ['run', 'release:check', '--', '--tag', tag], pkg);
  run('npm', dry ? ['publish', '--dry-run'] : ['publish', '--otp', otp], pkg);
  if (!dry) {
    process.stdout.write(`published botmancers@${version}\n`);
    process.stdout.write(`${out('npm', ['view', `botmancers@${version}`, 'version', 'dist.integrity', 'dist-tags'], process.cwd())}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
