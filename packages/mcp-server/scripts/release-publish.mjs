// Manual fallback: publishes the tagged release to npm (dist-tag latest) from a fresh
// clone of the tag, so the tarball is built from exactly the tagged commit, never from
// a working tree. The normal path is release.yml, which publishes with
// trusted publishing once its tag check is green; use this script only when CI cannot
// publish. Run it from the repository root:
//
//   npm run publish:packages                     publish; npm prints a link to approve in the browser (passkey/web login)
//   npm run publish:packages -- --otp 123456     publish with an authenticator code instead
//   npm run publish:packages -- --dry            do everything except publish
//
// The tag is v<version of origin/main>, the one `npm run release:finish` created.
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
  process.stderr.write(`publish:packages: ${message}\n`);
  process.exit(1);
};
if (otpAt >= 0 && !/^\d{6,8}$/.test(otp ?? '')) fail('--otp needs the 6 to 8 digit code from your authenticator');

const out = (command, commandArgs, cwd) => execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (command, commandArgs, cwd) => {
  process.stdout.write(`$ ${command} ${commandArgs.join(' ').replace(/--otp \d+/, '--otp ******')}\n`);
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit' });
};

out('git', ['fetch', '--tags', 'origin', 'main'], process.cwd());
const version = JSON.parse(out('git', ['show', 'origin/main:packages/mcp-server/package.json'], process.cwd())).version;
const tag = `v${version}`;
const origin = out('git', ['remote', 'get-url', 'origin'], process.cwd());
if (!out('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], process.cwd())) fail(`${tag} is not on origin; run npm run release:finish first`);
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
  run('npm', dry ? ['publish', '--dry-run'] : otp ? ['publish', '--otp', otp] : ['publish'], pkg);
  if (!dry) {
    // npm publish can exit 0 before the registry lists the version, or without publishing at all
    // (browser login), so only claim success once the registry shows it.
    let seen = '';
    for (let attempt = 0; attempt < 24 && !seen; attempt++) {
      try {
        seen = out('npm', ['view', `botmancers@${version}`, 'version', 'dist.integrity', 'dist-tags', '--prefer-online'], process.cwd());
      } catch {
        execFileSync('sleep', ['5']);
      }
    }
    if (!seen) fail(`npm publish exited 0 but botmancers@${version} is not on the registry after 2 minutes; check https://www.npmjs.com/package/botmancers before re-running`);
    process.stdout.write(`published botmancers@${version}\n${seen}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
