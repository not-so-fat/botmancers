// Merges the release PR, tags the merge commit, and pushes the tag, which
// starts release.yml (the release check, then the npm publish with trusted
// publishing and the GitHub Release). Run it as
// `npm run release:finish -- <pr-number>` from the repository root. No npm
// login is needed anywhere, and this command itself publishes nothing.
//
//   npm run release:finish -- 109          wait for CI, merge, tag, push
//   npm run release:finish -- 109 --dry    print what it would do; merges nothing
//
// It refuses unless the PR is open, from a release/* branch into main. It
// waits for every check to succeed, then squash-merges. The tag is made from
// origin/main (never the working tree) and refuses when the tag already
// exists on the remote or locally at another commit, or when origin/main has
// no "## [<version>]" CHANGELOG entry.
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const pr = args.find(arg => /^\d+$/.test(arg));
const fail = message => {
  process.stderr.write(`release:finish: ${message}\n`);
  process.exit(1);
};
if (!pr) fail('usage: npm run release:finish -- <pr-number> [--dry]');

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = message => process.stdout.write(`${message}\n`);

const info = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'state,baseRefName,headRefName']));
if (info.state !== 'OPEN') fail(`PR #${pr} is ${info.state}, not OPEN`);
if (info.baseRefName !== 'main') fail(`PR #${pr} targets ${info.baseRefName}, not main`);
if (!info.headRefName.startsWith('release/')) fail(`PR #${pr} is from ${info.headRefName}, not a release/* branch`);

if (!dry) {
  say(`waiting for the checks on PR #${pr} (${info.headRefName})`);
  let green = false;
  for (let attempt = 0; attempt < 40 && !green; attempt++) {
    if (attempt > 0) spawnSync('sleep', ['30']);
    const view = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'state,statusCheckRollup']));
    if (view.state !== 'OPEN') fail(`PR #${pr} is ${view.state}, not OPEN`);
    const checks = view.statusCheckRollup ?? [];
    const failed = checks.filter(check => check.conclusion && check.conclusion !== 'SUCCESS');
    if (failed.length) {
      fail(`PR #${pr} checks failed: ${failed.map(check => `${check.name}=${check.conclusion}`).join(', ')}`);
    }
    const pending = checks.filter(check => !check.conclusion);
    if (checks.length && !pending.length) {
      green = true;
    } else {
      say(`attempt ${attempt + 1}/40: ${checks.length ? `${pending.length} check(s) still running` : 'no checks reported yet'}; waiting 30s`);
    }
  }
  if (!green) fail(`PR #${pr} checks did not all succeed within 20 minutes`);
  say(`PR #${pr} checks are green`);
}

run('git', ['fetch', 'origin', info.headRefName]);
const version = JSON.parse(run('git', ['show', `origin/${info.headRefName}:packages/mcp-server/package.json`])).version;
say(`${dry ? 'would merge' : 'merging'} PR #${pr} (${info.headRefName}) as "Release botmancers ${version} (#${pr})", then tag ${`v${version}`} and push`);
if (dry) process.exit(0);

run('gh', ['pr', 'merge', pr, '--squash', '--subject', `Release botmancers ${version} (#${pr})`]);
say(`merged #${pr}`);

run('git', ['fetch', '--tags', 'origin', 'main']);
const sha = run('git', ['rev-parse', 'origin/main']);
const mainVersion = JSON.parse(run('git', ['show', 'origin/main:packages/mcp-server/package.json'])).version;
const tag = `v${mainVersion}`;
const changelog = run('git', ['show', 'origin/main:packages/mcp-server/CHANGELOG.md']);
if (!new RegExp(`^## \\[${mainVersion.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
  fail(`origin/main CHANGELOG.md has no "## [${mainVersion}] - YYYY-MM-DD" entry`);
}
if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`${tag} already exists on origin; bump the version instead of moving a published tag`);
const local = run('git', ['tag', '--list', tag]) ? run('git', ['rev-list', '-n', '1', tag]) : null;
if (local && local !== sha) fail(`local ${tag} points at ${local.slice(0, 12)}, not origin/main ${sha.slice(0, 12)}; delete it with git tag -d ${tag}`);

say(`tagging ${tag} at ${sha.slice(0, 12)} (origin/main) and pushing`);
if (!local) run('git', ['tag', tag, sha]);
run('git', ['push', 'origin', tag]);
say(`pushed ${tag}; watch the release run to the end, then check npm view botmancers@${mainVersion} version`);
