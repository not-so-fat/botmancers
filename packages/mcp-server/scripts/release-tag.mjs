// Tags the merged release and pushes the tag, which starts release-botmancers.yml
// (the release check; it does not publish). Run it as `npm run release:tag:push` from the
// repository root, after the release PR is merged.
//
//   npm run release:tag:push            tag origin/main and push botmancers-v<version>
//   npm run release:tag:push -- --dry   print what it would do
//
// It reads the version from origin/main, not the working tree, so a stale or dirty
// checkout cannot tag the wrong commit. It refuses when the tag already exists
// locally at another commit or on the remote, or when origin/main has no
// "## [<version>]" CHANGELOG entry.
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = message => {
  process.stderr.write(`release:tag:push: ${message}\n`);
  process.exit(1);
};

git('fetch', '--tags', 'origin', 'main');
const sha = git('rev-parse', 'origin/main');
const version = JSON.parse(git('show', 'origin/main:packages/mcp-server/package.json')).version;
const tag = `botmancers-v${version}`;

const changelog = git('show', 'origin/main:packages/mcp-server/CHANGELOG.md');
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
  fail(`origin/main CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry`);
}
if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) fail(`${tag} already exists on origin; bump the version instead of moving a published tag`);
const local = git('tag', '--list', tag) ? git('rev-list', '-n', '1', tag) : null;
if (local && local !== sha) fail(`local ${tag} points at ${local.slice(0, 12)}, not origin/main ${sha.slice(0, 12)}; delete it with git tag -d ${tag}`);

process.stdout.write(`${dry ? 'would tag' : 'tagging'} ${tag} at ${sha.slice(0, 12)} (origin/main) and push\n`);
if (dry) process.exit(0);
if (!local) git('tag', tag, sha);
git('push', 'origin', tag);
process.stdout.write(`pushed ${tag}; watch release-botmancers, then run the registry smoke and promote to latest (2FA)\n`);
