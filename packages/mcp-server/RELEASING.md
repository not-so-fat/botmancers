# Releasing the `botmancers` npm package

This document is for maintainers and is not shipped in the package. The
publishable package is this directory only. The repository root is the
private Botmancers app, which has the same name and `"private": true`.
**Never run `npm publish` from the repository root.**

## Versioning

- The package follows SemVer. While it is `0.x`, a minor bump may change the
  CLI or its configuration, and a patch release is for fixes only.
- The MCP tool contract (`botmancers.mcp.v2`, in
  `schemas/botmancers.mcp.v2.tools.json`) is a byte-for-byte copy of
  `docs/contracts/mcp-bridge-v2.tools.json`, and the frozen
  `schemas/botmancers.mcp.v1.tools.json` of
  `docs/contracts/mcp-bridge-v1.tools.json`. `npm test` fails if either pair
  differs. A contract change is made in the app first
  (`npm run test:mcp-bridge -- --write-contract`), then copied here and
  released. v1 never changes; changes within v2 are additive, and a breaking
  change is a new contract version (`docs/mcp-bridge.md`, Versioning).
- One version is recorded in four places: `package.json` `version`, a
  `## [x.y.z] - YYYY-MM-DD` entry in `CHANGELOG.md`, every
  `npx botmancers@x.y.z` example in `README.md`, and the git tag
  `botmancers-vx.y.z`. `release:check` verifies that they agree.
- The build tools (`typescript`, `@types/node`) are pinned to exact versions
  and locked in this directory's `package-lock.json`, which is committed.
  The release workflow installs them with `npm ci`, so a tagged commit
  compiles with the same tools as its dry run. `release:check` fails if the
  lockfile is missing, uncommitted, or out of sync with `package.json`, if a
  build tool is not pinned exactly, if the workflow does not use `npm ci`, or
  if the installed tools differ from the lock. To change a tool version, edit
  the pin, run `npm install` in this directory, and commit both files.

## Publishing

A release is published once, straight to `latest`, by
`release-botmancers.yml`: after the `check` job passes on the tag, the
`publish` job publishes this directory with npm trusted publishing (OIDC, no
credential) as `npm publish --provenance --tag latest`. An agent runs the
whole release: it prepares and merges, pushes the tag with
`npm run release:tag:push`, then watches `release-botmancers.yml` to the end
and checks `npm view botmancers@X.Y.Z version`. Nobody logs in to npm
anywhere, and no npm credential lives in GitHub secrets or on any machine.
There is no canary dist-tag. The `botmancers` trusted publisher on npmjs.com
(GitHub Actions, `not-so-fat` / `botmancers`, workflow
`release-botmancers.yml`, environment `npm`) is configured once by the owner
and never touched per release; only the owner can change it. The safety net
is before the publish: `release:check` installs the
exact tarball into clean projects (bridge-only, full product)
and `release-botmancers.yml` runs the same check on the tag, on the release
runner. The managed install path (`scripts/install.sh`, the launcher, staged
upgrades, rollback) is covered by `npm test`'s managed suite instead of an
exact-tarball smoke. `npm run release:publish` (from the repository root, a
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

1. **Prepare** on a branch: bump `version` in `package.json`, add the
   CHANGELOG entry, and update the README pinned example. Merge to `main`.
2. **Dry run.** From a clean checkout of the merge commit, run:

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
   the managed-install suite: `scripts/install.sh`, the launcher, staged
   upgrades, rollback), package contents against the allowlist (including the
   bundled UI/core runtime), publish configuration, `npm publish --dry-run`,
   and canary installs of the exact tarball into clean temporary projects:
   bridge-only (`smoke-install.mjs`) and the full product
   (`smoke-product-install.mjs`: `setup`, `start --daemon`, UI, `/api/v0`,
   bridge against the same engine, restart, `status`/`doctor`/`stop`). It
   never writes to the registry.

   Save the evidence for the release ticket, bound to the commit you will tag
   (the transcripts record the commit SHA and exact version):

   ```sh
   npm run release:check -- --out /tmp/release-dry-run.txt     # needs the clean tree, so first
   npm pack --ignore-scripts --pack-destination /tmp           # the exact tarball, no rebuild
   mkdir -p release-evidence && cp /tmp/release-dry-run.txt release-evidence/
   npm run check:pack -- --out release-evidence/pack-manifest.txt
   npm run smoke:install -- --tarball /tmp/botmancers-X.Y.Z.tgz --out release-evidence/clean-install-smoke.txt
   npm run smoke:product -- --tarball /tmp/botmancers-X.Y.Z.tgz --out release-evidence/product-install-smoke.txt
   ```

   Pass `--tarball` to the smokes: without it they run `npm pack`, whose
   `prepack` rebuilds `app/` from the (now dirty) tree.

   `release-evidence/` is outside the package `files` allowlist, so it is
   never published. Commit it in a follow-up commit that touches only that
   directory, so the recorded SHA is the code that was checked.
3. **Tag**. Go back to the repository root (step 2 ends in
   `packages/mcp-server`, and the script is defined only in the root
   `package.json`), confirm `origin/main` is still the commit step 2 checked
   (or that commit plus the `release-evidence/` follow-up), then run:

   ```sh
   npm run release:tag:push    # tags origin/main, never the working tree
   ```

   `npm run release:ship -- <pr-number>` does the merge, this tag step, and
   the wait for the workflow in one command, once the PR's checks are green.
   Agents use it, so no per-command approval of `gh pr merge` is needed;
   `npm run release:ship -- <pr-number> --dry` previews.

   `release:tag:push` reads the version from `origin/main`, requires the CHANGELOG entry, and
   refuses to reuse a tag that exists on the remote or exists locally at a
   different commit. `npm run release:tag:push -- --dry` previews. Use it
   instead of tagging by hand.

   The `release-botmancers` workflow then runs `release:check --tag ...` on
   the tag in the `check` job, and the `publish` job publishes to npm once
   the check is green. Wait for the run to finish (step 4).
4. **Publish (automatic).** The `publish` job runs only after `check`
   passes and publishes with `npm publish --provenance --tag latest`; nobody
   logs in to npm anywhere. Watch the `release-botmancers` run to the end,
   then verify from any machine:

   ```sh
   npm view botmancers@X.Y.Z version
   ```

   If the publish step finds `botmancers@X.Y.Z` already on npm it skips, so
   re-running the workflow finishes the rest. If the run fails before the
   version is on npm, the release keeps its version: fix the problem, merge,
   delete the tag locally and on the remote, and re-push the same tag on the
   fixed commit:

   ```sh
   git tag -d botmancers-vX.Y.Z && git push origin :botmancers-vX.Y.Z
   npm run release:tag:push    # re-pushes the same tag on the fixed origin/main
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
   npm run release:publish:ci -- --tag botmancers-vX.Y.Z --dry
   ```

   Manual fallback only: `npm run release:publish` from the repository root
   publishes from a fresh clone of the tag with the maintainer's npm login.
   It refuses when the tag is not on `origin` or the version is already on
   the registry.
5. **Registry smoke**, from any machine:

   ```sh
   node packages/mcp-server/scripts/smoke-install.mjs --registry X.Y.Z --out smoke.txt
   node packages/mcp-server/scripts/smoke-product-install.mjs --registry X.Y.Z --out product-smoke.txt
   npm view botmancers@X.Y.Z dist.integrity
   ```

6. **Operator friend-path check** (0.3.0 onward: the managed install), from
   a clean macOS user account with Node 20.9+ and npm:
   1. Install N:
      `curl -fsSL https://raw.githubusercontent.com/not-so-fat/botmancers/main/scripts/install.sh | bash`
      (prefix it with `BOTMANCERS_VERSION=X.Y.Z` to pin N).
      Then run `botmancers setup`, `botmancers start --daemon --open`, create a
      conversation in the UI, and call MCP `botmancers_health` and
      `tools/list`. Record `shasum -a 256` of
      `~/.botmancers/config/core.env`, a file under `~/.botmancers/files/`,
      and a skill.
   2. Once N+1 is on `latest`, run `botmancers status` (or wait for the
      running product's daily check). Within a few minutes
      `~/.botmancers/update-state.json` shows `pendingVersion` N+1. `status`
      still shows `running core N, bridge N` and the UI keeps working. If
      `checkedAt` is less than 24 hours old, wait, or remove that field to
      force a check.
   3. Run `botmancers stop && botmancers start --daemon`. It prints
      `activated N+1 (was N)`. `curl -s 127.0.0.1:3333/api/health` and
      `curl -s 127.0.0.1:3332/healthz` report N+1, the conversation is
      still there, and the hashes match.
   4. Roll back: run `botmancers stop && botmancers install --to N && botmancers start --daemon`.
      Both health endpoints report N, and the same state and hashes are
      present.
   5. Run `BOTMANCERS_DISABLE_AUTOUPDATER=1 botmancers status` and confirm
      that `doctor` reports the updater as disabled.

   Keep the timestamped, redacted transcript, the health responses, a UI
   screenshot, `npm view botmancers@N dist.integrity` and the same for N+1,
   and the before/after hashes.
7. Record the npm URL (`https://www.npmjs.com/package/botmancers/v/X.Y.Z`),
   the integrity value, and the redacted smoke transcript on the release
   ticket.

If a published version is bad, do not move its tag. Fix the problem and
release the next patch version. Run `npm deprecate botmancers@X.Y.Z "<reason>"`
for a version that has already reached users. Unpublishing is a last resort.
A release that fails before its version is on npm keeps the version instead:
fix, merge, delete and re-push the same tag on the fixed commit (step 4).
