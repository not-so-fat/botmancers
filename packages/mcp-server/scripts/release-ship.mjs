// Merges the release PR, tags the merge commit, and waits for release-botmancers.yml
// to check the tag and publish it to npm with trusted publishing. Run it as
// `npm run release:ship -- <pr-number>` from the repository root once the PR's
// checks are green. No npm login is needed anywhere.
//
//   npm run release:ship -- 109          merge, tag, push, wait for the tag check
//   npm run release:ship -- 109 --dry    print what it would do; merges nothing
//
// It refuses unless the PR is open, from a release/* branch into main, and every check is
// green. The tag itself is made by release-tag.mjs, which reads origin/main.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const pr = args.find(arg => /^\d+$/.test(arg));
const fail = message => {
  process.stderr.write(`release:ship: ${message}\n`);
  process.exit(1);
};
if (!pr) fail('usage: npm run release:ship -- <pr-number> [--dry]');

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const say = message => process.stdout.write(`${message}\n`);

const info = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'state,baseRefName,headRefName,statusCheckRollup']));
if (info.state !== 'OPEN') fail(`PR #${pr} is ${info.state}, not OPEN`);
if (info.baseRefName !== 'main') fail(`PR #${pr} targets ${info.baseRefName}, not main`);
if (!info.headRefName.startsWith('release/')) fail(`PR #${pr} is from ${info.headRefName}, not a release/* branch`);
const bad = info.statusCheckRollup.filter(check => (check.conclusion || check.status) !== 'SUCCESS');
if (!info.statusCheckRollup.length || bad.length) {
  fail(`PR #${pr} checks are not all green: ${bad.map(check => `${check.name}=${check.conclusion || check.status}`).join(', ') || 'none reported'}`);
}

run('git', ['fetch', 'origin', info.headRefName]);
const version = JSON.parse(run('git', ['show', `origin/${info.headRefName}:packages/mcp-server/package.json`])).version;
say(`${dry ? 'would merge' : 'merging'} PR #${pr} (${info.headRefName}) as "Release botmancers ${version} (#${pr})", then tag and watch`);
if (dry) process.exit(0);

run('gh', ['pr', 'merge', pr, '--squash', '--subject', `Release botmancers ${version} (#${pr})`]);
say(`merged #${pr}`);

const tagScript = join(dirname(fileURLToPath(import.meta.url)), 'release-tag.mjs');
say(run('node', [tagScript]));

const tag = `botmancers-v${version}`;
let runId = '';
for (let attempt = 0; attempt < 20 && !runId; attempt++) {
  const runs = JSON.parse(run('gh', ['run', 'list', '--workflow', 'release-botmancers.yml', '--branch', tag, '--limit', '1', '--json', 'databaseId']));
  runId = runs.length ? String(runs[0].databaseId) : '';
  if (!runId) spawnSync('sleep', ['3']);
}
if (!runId) fail(`no release-botmancers run appeared for ${tag}; check the Actions tab`);
say(`watching release-botmancers run ${runId} (about 4 minutes)`);
const watched = spawnSync('gh', ['run', 'watch', runId, '--exit-status', '--interval', '30'], { stdio: ['ignore', 'ignore', 'inherit'] });
if (watched.status !== 0) fail(`release-botmancers failed for ${tag}; while botmancers@${version} is not on npm, fix and re-push the same tag (RELEASING.md step 4)`);
say(`release-botmancers is green for ${tag}; botmancers@${version} is on npm. Verify: npm view botmancers@${version} version`);
