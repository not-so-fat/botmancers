# Publishing the `botmancers` npm package

An agent runs the whole release. The owner only asks for it.

```sh
npm run release:prepare -- patch --summary "why this release"   # branch, bump, PR
npm run release:finish -- <pr-number>                            # wait for CI, merge, tag vX.Y.Z, push
# watch the release run to the end, then:
npm view botmancers@X.Y.Z version
```

## What publishes

The publishable package is `packages/mcp-server` only. The repository root
is the private Botmancers app, which has the same name and `"private": true`.
**Never run `npm publish` from the repository root.**

Deviation from the shared convention, recorded: `CHANGELOG.md` stays in
`packages/mcp-server` (not at the repository root) because it ships inside
the npm package.

## Versioning

- The package follows SemVer. While it is `0.x`, a minor bump may change the
  CLI or its configuration, and a patch release is for fixes only.
- One version is recorded in four places: `package.json` `version`, a
  `## [x.y.z] - YYYY-MM-DD` entry in `CHANGELOG.md`, every
  `npx botmancers@x.y.z` example in `README.md`, and the git tag `vx.y.z`.
  `release:check` verifies that they agree.
- The MCP tool contract (`botmancers.mcp.v2`, in
  `schemas/botmancers.mcp.v2.tools.json`) is a byte-for-byte copy of
  `docs/contracts/mcp-bridge-v2.tools.json`, and the frozen
  `schemas/botmancers.mcp.v1.tools.json` of
  `docs/contracts/mcp-bridge-v1.tools.json`. `npm test` fails if either pair
  differs. A contract change is made in the app first
  (`npm run test:mcp-bridge -- --write-contract`), then copied here and
  released. v1 never changes; changes within v2 are additive, and a breaking
  change is a new contract version (`docs/mcp-bridge.md`, Versioning).
- The build tools (`typescript`, `@types/node`) are pinned to exact versions
  and locked in the package's `package-lock.json`, which is committed. The
  release workflow installs them with `npm ci`, so a tagged commit compiles
  with the same tools as its dry run. `release:check` fails if the lockfile
  is missing, uncommitted, or out of sync with `package.json`, if a build
  tool is not pinned exactly, if the workflow does not use `npm ci`, or if
  the installed tools differ from the lock. To change a tool version, edit
  the pin, run `npm install` in `packages/mcp-server`, and commit both files.

## Publishing

A release is published once, straight to `latest`, by `release.yml`: after
the `check` job passes on the tag, the `publish` job publishes
`packages/mcp-server` with npm trusted publishing (OIDC, no credential) as
`npm publish --tag latest`, then creates the GitHub Release
`vX.Y.Z` from the CHANGELOG entry. There is no explicit `--provenance`: the
repository is private, and npm rejects a provenance bundle from a private
repository (`E422 ... Unsupported GitHub Actions source repository
visibility: "private"`). Under trusted publishing npm attaches provenance on
its own if the repository is ever made public. Nobody logs in to npm anywhere, and no
npm credential lives in GitHub secrets or on any machine. There is no canary
dist-tag. The `botmancers` trusted publisher on npmjs.com (GitHub Actions,
`not-so-fat` / `botmancers`, workflow `release.yml`, environment `npm`) is
configured once by the owner and never touched per release; only the owner
can change it. The safety net is before the publish: `release:check`
installs the exact tarball into clean projects (bridge-only, full product)
and `release.yml` runs the same check on the tag, on the release runner. The
managed install path (`scripts/install.sh`, the launcher, staged upgrades,
rollback) is covered by `npm test`'s managed suite instead of an
exact-tarball smoke. `npm run publish:packages` (from the repository root, a
fresh clone of the tag, the maintainer's npm login) stays as the documented
manual fallback for when CI cannot publish.

Two rules:

- A failed release keeps its version. While `botmancers@X.Y.Z` is not on npm,
  fix the problem, merge, delete the tag locally and on the remote, and
  re-push the same tag on the fixed commit (step 4). Only a version that is
  already on npm is immutable.
- An OIDC `package not found` failure (followed by `ENEEDAUTH`) means the
  npmjs.com trusted publisher entry is wrong or missing, which only the owner
  changes on npmjs.com. No repository change fixes it.

## Procedure

1. **Prepare.** From a clean checkout of `main`, run:

   ```sh
   npm run release:prepare -- <patch|minor|major|X.Y.Z> --summary "why this release"
   ```

   It bumps `packages/mcp-server/package.json` and its lockfile, stubs the
   CHANGELOG entry from the summary, updates the README pins, runs build +
   `release:check` (dry run, no registry mutation), commits
   `Ship X.Y.Z: <why>` on branch `release/X.Y.Z`, and opens the PR against
   `main`. `--dry` commits locally but skips the push and the PR. Review the
   stubbed CHANGELOG entry on the PR; amend the branch if the release needs
   more than the summary line.
2. **Dry run.** `release:prepare` already ran it; `ci` re-runs the same check
   on the PR. To re-run by hand from a clean checkout:

   ```sh
   npm ci                      # repository root: the app the package bundles
   cd packages/mcp-server
   npm ci
   npm run build
   npm run build:app           # next build (standalone) assembled into app/
   npm run release:check
   ```

   This checks version consistency, the changelog entry, a clean git tree,
   that `app/` was built from this commit and version, the tests (including
   the managed-install suite), package contents against the allowlist,
   publish configuration, `npm publish --dry-run`, and canary installs of
   the exact tarball into clean temporary projects. It never writes to the
   registry. Save the transcript for the release ticket with
   `npm run release:check -- --out /tmp/release-dry-run.txt`.
3. **Finish.** Once the PR's checks are green (or while they run; the command
   waits), from the repository root:

   ```sh
   npm run release:finish -- <pr-number>   # waits for CI, squash-merges, tags vX.Y.Z, pushes
   ```

   `npm run release:finish -- <pr-number> --dry` previews. The tag is read
   from `origin/main`, never the working tree; use this instead of tagging
   by hand. The `release` workflow then runs `release:check --tag ...` on
   the tag in the `check` job, and the `publish` job publishes to npm and
   creates the GitHub Release once the check is green.
4. **Publish (automatic).** The `publish` job runs only after `check`
   passes; nobody logs in to npm anywhere. Watch the `release` run to the
   end, then verify from any machine:

   ```sh
   npm view botmancers@X.Y.Z version
   ```

   If the publish step finds `botmancers@X.Y.Z` already on npm it skips the
   publish but still ensures the GitHub Release exists, so re-running the
   workflow finishes the rest. If the run fails before the version is on
   npm, the release keeps its version: fix the problem, merge, delete the
   tag locally and on the remote, and re-push the same tag on the fixed
   commit:

   ```sh
   git tag -d vX.Y.Z && git push origin :vX.Y.Z
   npm run release:finish -- <new-pr-number>   # re-pushes the same tag on the fixed origin/main
   ```

   Only a version that is already on npm is immutable: a bad published
   version gets the next patch version (and `npm deprecate`), never a moved
   tag. If the publish step fails with an OIDC `package not found` error
   (followed by `ENEEDAUTH`), the npmjs.com trusted publisher entry is wrong
   or missing; only the owner can fix it on npmjs.com, no repository change
   helps.

   Preview what the publish step would do without publishing (it reports
   "already on npm; skipping publish" for a shipped version):

   ```sh
   cd packages/mcp-server
   node scripts/release-publish-ci.mjs --tag vX.Y.Z --dry
   ```

   Manual fallback only: `npm run publish:packages` from the repository root
   publishes from a fresh clone of the tag with the maintainer's npm login.
   It refuses when the tag is not on `origin` or the version is already on
   the registry.
5. **Registry smoke**, from any machine:

   ```sh
   node packages/mcp-server/scripts/smoke-install.mjs --registry X.Y.Z --out smoke.txt
   node packages/mcp-server/scripts/smoke-product-install.mjs --registry X.Y.Z --out product-smoke.txt
   npm view botmancers@X.Y.Z dist.integrity
   ```

6. **Operator friend-path check** (the managed install), from a clean macOS
   user account with Node 20.9+ and npm: install N with
   `curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash`
   (prefix `BOTMANCERS_VERSION=X.Y.Z` to pin), `botmancers setup`,
   `botmancers start --daemon --open`, create a conversation, call
   `botmancers_health` and `tools/list`; once N+1 is on `latest`, confirm
   background staging, activate at one restart, and roll back with
   `botmancers install --to N`. Keep the redacted transcript, health
   responses, and before/after hashes.
7. Record the npm URL (`https://www.npmjs.com/package/botmancers/v/X.Y.Z`),
   the integrity value, the GitHub Release URL, and the redacted smoke
   transcript on the release ticket.

If a published version is bad, do not move its tag. Fix the problem and
release the next patch version. Run `npm deprecate botmancers@X.Y.Z "<reason>"`
for a version that has already reached users. Unpublishing is a last resort.
A release that fails before its version is on npm keeps the version instead:
fix, merge, delete and re-push the same tag on the fixed commit (step 4).
