// Publishes this package to npm from the checked-out tag (the publish job of
// release.yml) with npm trusted publishing: the job's OIDC identity is
// exchanged for a short-lived publish grant, so no credential is configured
// anywhere. Then it creates the GitHub Release from the CHANGELOG entry.
// Run it from packages/mcp-server:
//
//   node scripts/release-publish-ci.mjs --tag vX.Y.Z
//   node scripts/release-publish-ci.mjs --tag vX.Y.Z --dry   report only, never publishes
//
// It refuses when the tag does not match the package version. When
// botmancers@X.Y.Z is already on the registry it skips the publish but still
// ensures the GitHub Release exists, so re-running the workflow finishes the
// rest. When the registry answers 404 it publishes with
// `npm publish --provenance --tag latest --loglevel verbose`. Any other
// registry answer fails closed: no publish, nonzero exit.
//
// NPM_BIN overrides the npm executable and GH_BIN the gh executable (tests
// point them at stubs); every npm and gh call runs with packages/mcp-server
// as its working directory, never the repository root.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The release notes are the body of the `## [version] - date` CHANGELOG
// section, without the header line. Returns null when there is no entry.
export function extractChangelogNotes(changelog, version) {
  const section = changelog.split(/^## /m).find(part => part.startsWith(`[${version}]`));
  if (!section) return null;
  const body = section.split('\n').slice(1).join('\n').trim();
  return body || null;
}

function probe(npmBin, version, extraArgs = []) {
  const ran = spawnSync(npmBin, ['view', `botmancers@${version}`, 'version', ...extraArgs], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  });
  return { status: ran.status ?? 1, output: `${ran.stdout ?? ''}\n${ran.stderr ?? ''}` };
}

function ensureGitHubRelease({ ghBin, tag, version }) {
  const changelog = readFileSync(join(PACKAGE_DIR, 'CHANGELOG.md'), 'utf8');
  const notes = extractChangelogNotes(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md has no "## [${version}]" entry; refusing to create the GitHub Release`);
  const viewed = spawnSync(ghBin, ['release', 'view', tag, '--json', 'tagName'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  });
  if (viewed.status === 0) {
    process.stdout.write(`release-publish-ci: GitHub Release ${tag} already exists; skipping\n`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'botmancers-release-notes-'));
  try {
    const notesFile = join(dir, 'notes.md');
    writeFileSync(notesFile, `${notes}\n`);
    const created = spawnSync(ghBin, ['release', 'create', tag, '--title', tag, '--notes-file', notesFile], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    });
    if ((created.status ?? 1) === 0) {
      process.stdout.write(`created GitHub Release ${tag}\n${(created.stdout ?? '').trim()}\n`);
      return;
    }
    const output = `${created.stdout ?? ''}\n${created.stderr ?? ''}`;
    if (/already exists/i.test(output)) {
      process.stdout.write(`release-publish-ci: GitHub Release ${tag} already exists; skipping\n`);
      return;
    }
    throw new Error(`${ghBin} release create ${tag} failed:\n${output.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv, env) {
  const args = argv.slice(2);
  const dry = args.includes('--dry') || args.includes('--dry-run');
  const tagAt = args.indexOf('--tag');
  const tag = tagAt >= 0 ? args[tagAt + 1] : null;
  const fail = message => {
    process.stderr.write(`release-publish-ci: ${message}\n`);
    process.exitCode = 1;
  };
  if (!tag) {
    fail('usage: node scripts/release-publish-ci.mjs --tag vX.Y.Z [--dry]');
    return;
  }

  const npmBin = env.NPM_BIN || 'npm';
  const ghBin = env.GH_BIN || 'gh';
  const version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
  if (tag !== `v${version}`) {
    fail(`git tag ${tag} does not match v${version}; refusing to publish`);
    return;
  }

  const first = probe(npmBin, version);
  const decision = classifyRegistryProbe({ ...first, version });
  if (decision === 'published') {
    process.stdout.write(`release-publish-ci: botmancers@${version} is already on npm; skipping publish\n`);
    if (dry) return;
    try {
      ensureGitHubRelease({ ghBin, tag, version });
    } catch (error) {
      fail(error.message);
    }
    return;
  }
  if (decision === 'error') {
    fail(`could not check the registry for botmancers@${version} (failing closed, nothing published):\n${first.output.trim()}`);
    return;
  }
  if (dry) {
    process.stdout.write(`release-publish-ci: would publish botmancers@${version} with ${npmBin} ${PUBLISH_ARGS.join(' ')} (dry run)\n`);
    process.stdout.write(`release-publish-ci: would create the GitHub Release ${tag} from the CHANGELOG entry (dry run)\n`);
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
  try {
    ensureGitHubRelease({ ghBin, tag, version });
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv, process.env);
