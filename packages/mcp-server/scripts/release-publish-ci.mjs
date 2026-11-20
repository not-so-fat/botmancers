// Publishes this package to npm from the checked-out tag (the publish job of
// release-botmancers.yml) with npm trusted publishing: the job's OIDC
// identity is exchanged for a short-lived publish grant, so no credential is
// configured anywhere. Run it from packages/mcp-server:
//
//   node scripts/release-publish-ci.mjs --tag botmancers-vX.Y.Z
//   node scripts/release-publish-ci.mjs --tag botmancers-vX.Y.Z --dry   report only, never publishes
//
// It refuses when the tag does not match the package version. When
// botmancers@X.Y.Z is already on the registry it skips, so re-running the
// workflow finishes cleanly. When the registry answers 404 it publishes with
// `npm publish --provenance --tag latest --loglevel verbose`. Any other
// registry answer fails closed: no publish, nonzero exit.
//
// NPM_BIN overrides the npm executable (tests point it at a stub); every npm
// call runs with packages/mcp-server as its working directory, never the
// repository root.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLISH_ARGS = ['publish', '--provenance', '--tag', 'latest', '--loglevel', 'verbose'];
const POLL_ATTEMPTS = 24;
const POLL_SLEEP_SECONDS = 5;

// status/output of `npm view botmancers@<version> version` -> decision.
// A 200 whose body is not exactly the version is unexpected (fail closed);
// only an E404-shaped answer means "not published yet".
export function classifyRegistryProbe({ status, output, version }) {
  if (status === 0) return output.trim() === version ? 'published' : 'error';
  return /(E404|404 Not Found|is not in (the|this) registry)/i.test(output) ? 'missing' : 'error';
}

function probe(npmBin, version, extraArgs = []) {
  const ran = spawnSync(npmBin, ['view', `botmancers@${version}`, 'version', ...extraArgs], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  });
  return { status: ran.status ?? 1, output: `${ran.stdout ?? ''}\n${ran.stderr ?? ''}` };
}

async function main(argv, env) {
  const args = argv.slice(2);
  const dry = args.includes('--dry') || args.includes('--dry-run');
  const tagAt = args.indexOf('--tag');
  const tag = tagAt >= 0 ? args[tagAt + 1] : null;
  const fail = message => {
    process.stderr.write(`release:publish:ci: ${message}\n`);
    process.exitCode = 1;
  };
  if (!tag) {
    fail('usage: node scripts/release-publish-ci.mjs --tag botmancers-vX.Y.Z [--dry]');
    return;
  }

  const npmBin = env.NPM_BIN || 'npm';
  const version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
  if (tag !== `botmancers-v${version}`) {
    fail(`git tag ${tag} does not match botmancers-v${version}; refusing to publish`);
    return;
  }

  const first = probe(npmBin, version);
  const decision = classifyRegistryProbe({ ...first, version });
  if (decision === 'published') {
    process.stdout.write(`release:publish:ci: botmancers@${version} is already on npm; skipping publish\n`);
    return;
  }
  if (decision === 'error') {
    fail(`could not check the registry for botmancers@${version} (failing closed, nothing published):\n${first.output.trim()}`);
    return;
  }
  if (dry) {
    process.stdout.write(`release:publish:ci: would publish botmancers@${version} with ${npmBin} ${PUBLISH_ARGS.join(' ')} (dry run)\n`);
    return;
  }

  process.stdout.write(`$ ${npmBin} ${PUBLISH_ARGS.join(' ')}\n`);
  const published = spawnSync(npmBin, PUBLISH_ARGS, { cwd: PACKAGE_DIR, stdio: 'inherit', env });
  if ((published.status ?? 1) !== 0) {
    fail(`${npmBin} ${PUBLISH_ARGS.join(' ')} exited ${published.status ?? 'unknown'}; nothing was published by this run`);
    return;
  }
  // npm publish can exit 0 before the registry lists the version, so only
  // claim success once the registry shows it.
  let seen = '';
  for (let attempt = 0; attempt < POLL_ATTEMPTS && !seen; attempt++) {
    if (attempt > 0) execFileSync('sleep', [String(POLL_SLEEP_SECONDS)]);
    const check = probe(npmBin, version, ['--prefer-online']);
    if (classifyRegistryProbe({ ...check, version }) === 'published') seen = check.output.trim();
  }
  if (!seen) {
    fail(`npm publish exited 0 but botmancers@${version} is not on the registry after ${POLL_ATTEMPTS * POLL_SLEEP_SECONDS} seconds; check https://www.npmjs.com/package/botmancers before re-running`);
    return;
  }
  process.stdout.write(`published botmancers@${version}\n${seen}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv, process.env);
