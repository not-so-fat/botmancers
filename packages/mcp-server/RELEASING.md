# Releasing the `botmancers` npm package

This document is for maintainers and is not shipped in the package. The
publishable package is this directory only. The repository root is the
private Botmancers app, which has the same name and `"private": true`.
**Never run `npm publish` from the repository root.**

## Versioning

- The package follows SemVer. While it is `0.x`, a minor bump may change the
  CLI or its configuration, and a patch release is for fixes only.
- The MCP tool contract (`botmancers.mcp.v1`, in
  `schemas/botmancers.mcp.v1.tools.json`) is a copy of
  `docs/contracts/mcp-bridge-v1.tools.json`. `npm test` fails if the two
  differ. A contract change is made in the app first, then copied here and
  released.
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

## Dist-tags: canary, then stable

Every version is first published to the `canary` dist-tag:
`publishConfig.tag` is `canary`, and the workflow passes `--tag canary`. It
moves to `latest` only after a registry install of that exact version passes
the smoke test. On the very first publish, npm also points `latest` at the
canary version, because a package must have a `latest` tag. Run the
registry smoke test before announcing that release.

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
   that `app/` was built from this commit and version, the tests, package
   contents against the allowlist (including the bundled UI/core runtime),
   provenance support, `npm publish --dry-run`, and canary installs of the
   exact tarball into clean temporary projects: bridge-only
   (`smoke-install.mjs`) and the full product (`smoke-product-install.mjs`:
   `setup`, `start --daemon`, UI, `/api/v0`, bridge against the same engine,
   restart, `status`/`doctor`/`stop`). It also checks that the release workflow runs on
   Node 24 and enforces npm 11.5.1 or newer, and that the local toolchain
   meets the same floor: npm trusted publishing (OIDC) needs npm >= 11.5.1
   and Node >= 22.14. It never writes to the registry.

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
3. **Tag**:

   ```sh
   git tag botmancers-vX.Y.Z && git push origin botmancers-vX.Y.Z
   ```

   The `release-botmancers` workflow then runs `release:check --tag ...`
   again and runs `npm publish --provenance --access public --tag canary`
   through `scripts/publish-ci.sh` (see "Publish authentication" below).
   That attaches a signed SLSA provenance attestation that links the tarball
   to this repository, workflow, and commit.
4. **Canary smoke from the registry**, run from any machine:

   ```sh
   node packages/mcp-server/scripts/smoke-install.mjs --registry X.Y.Z --out smoke.txt
   node packages/mcp-server/scripts/smoke-product-install.mjs --registry X.Y.Z --out product-smoke.txt
   npm view botmancers@X.Y.Z dist.integrity
   npm audit signatures            # inside the smoke project, or any project that installed it
   ```

5. **Promote to stable.** This requires an interactive 2FA prompt:

   ```sh
   npm dist-tag add botmancers@X.Y.Z latest
   ```

6. **Operator friend-path check** (0.2.0 onward), from a clean macOS user
   account with Node 20+: `npm install -g botmancers@X.Y.Z` (canary),
   `botmancers setup`, `botmancers start --daemon --open`, create and reopen a
   conversation in the UI, call MCP `botmancers_health` and `tools/list`
   against the same installation, `botmancers stop && botmancers start --daemon`,
   and confirm the conversation remains. Keep the transcript, a UI screenshot,
   and the MCP transcript.
7. Record the npm URL (`https://www.npmjs.com/package/botmancers/v/X.Y.Z`),
   the integrity value, and the redacted smoke transcript on the release
   ticket.

If a canary is bad, do not promote it. Fix the problem, then release the
next patch version. Run `npm deprecate botmancers@X.Y.Z "<reason>"` for a
version that has already reached users. Unpublishing is a last resort.

## Publish authentication

The workflow's publish step (`scripts/publish-ci.sh`) picks one mode:

- **Bootstrap token**: the `npm-publish` environment has a non-empty
  `NPM_TOKEN` secret. The script exports it as `NODE_AUTH_TOKEN` and logs a
  warning that token mode was used.
- **Trusted publishing (OIDC)**: the secret is absent. The script unsets
  `NODE_AUTH_TOKEN` (setup-node exports a placeholder for the whole job) and
  removes setup-node's generated `_authToken=${NODE_AUTH_TOKEN}` npmrc entry.
  An empty or placeholder token suppresses npm's OIDC exchange and fails
  with `ENEEDAUTH`/`E404`, so neither may reach `npm publish`. It logs
  `trusted publishing (OIDC); NODE_AUTH_TOKEN unset`.

The workflow never sets `NODE_AUTH_TOKEN` itself; `release:check` and
`npm test` fail if it does, and `npm test` runs the script in both modes.

## First publication and the move to trusted publishing (one-time)

The release ticket records these actions. Do them in this order: the
bootstrap token stays active, unused, as the rollback until a trusted
publish has succeeded.

1. Create the npm organization `botmancers`, which reserves the
   `@botmancers/*` scope. Enable 2FA for every member, set to "auth and
   writes".
2. Confirm that `botmancers` is still unclaimed: `npm view botmancers` should
   return 404.
3. **Bootstrap token.** The first publish cannot use trusted publishing,
   because npm configures it per existing package. It runs in GitHub
   Actions, where nobody can answer an OTP prompt, so the token must be
   allowed to publish without one. Create a **granular access token** on
   npmjs.com with:
   - Packages and scopes: **Read and write**. The package does not exist
     yet, so it cannot be selected individually; use the account that will
     own it, and grant no organization access.
   - **Bypass two-factor authentication** enabled. Without it, npm rejects a
     noninteractive publish from an account that has 2FA for writes.
   - A short expiry that still covers the first publish, the follow-up
     release, and npm's two-day trusted-publisher validation window (3 days;
     never more than 7). Add an IP allowlist if your CI supports one.

   Store it only as the `NPM_TOKEN` secret of the `npm-publish` GitHub
   environment.
4. **Initial publish (token mode).** Run steps 1 to 5 of the procedure
   above for the initial version (`0.1.0`). The workflow log shows the
   bootstrap-token warning. Then run step 11 below for that version.
5. **Prepare the follow-up release before touching trusted publishing.** A
   published version can never be republished, so the trusted-publishing
   proof needs a new version: bump to the next patch (for example `0.1.1`),
   add its CHANGELOG entry, update the README pin, merge to `main`, and run
   the dry run (procedure step 2) so the release is ready to tag. Do not
   continue until you can tag it right away.
6. **Configure the trusted publisher immediately before tagging the
   follow-up release.** On npmjs.com, under the package's **Settings →
   Trusted publishing**, add GitHub Actions with repository
   `not-so-fat/botmancers`, workflow `release-botmancers.yml`, and
   environment `npm-publish`. Under the allowed actions, **select the direct
   `npm publish` action**. New trusted-publisher configurations default to
   staged publishing only, and the workflow runs `npm publish`, so without
   this setting the release is rejected. Save, then confirm the
   configuration lists `npm publish` as allowed.

   npm requires a new trusted-publisher configuration to complete its first
   successful trusted publish **within two days**; otherwise the
   configuration expires. The clock starts when you save it.
7. **Withhold the token, keep it as rollback.** Delete the `NPM_TOKEN`
   secret from the `npm-publish` GitHub environment so the follow-up
   release cannot fall back to token authentication. Do **not** revoke the
   token on npmjs.com yet.
8. **Follow-up release through OIDC, within the two days.** Tag and push the
   follow-up version (procedure step 3). Confirm in the workflow log that
   the publish step printed `trusted publishing (OIDC); NODE_AUTH_TOKEN
   unset` and succeeded, then confirm the version on the registry with its
   provenance (procedure step 4: `npm view botmancers@X.Y.Z dist.integrity`
   and `npm audit signatures`).

   **Rollback**, only if that publish fails: fix the trusted-publisher
   configuration (repository, workflow file name, environment, allowed
   `npm publish` action) and re-run the failed workflow while the two-day
   window is open. If it cannot succeed in that window, or the
   configuration has expired, delete the trusted-publisher configuration,
   put the still-active bootstrap token back as the `NPM_TOKEN` environment
   secret, and re-run the workflow to publish the follow-up version in
   token mode. Then repeat steps 5 to 8 with the next patch version before
   the token expires; if it expires first, create a new bootstrap token as
   in step 3.
9. **Only after a successful OIDC publish**, revoke the bootstrap token on
   npmjs.com and confirm the `NPM_TOKEN` environment secret is gone. It is
   the only 2FA-bypassing credential and must not outlive the transition.
10. Under package settings, set **Publishing access** to "Require two-factor
    authentication and disallow tokens", and add the org as a maintainer.
    Trusted publishing is not affected by this setting. Setup is complete
    only now; later releases authenticate through OIDC only.
11. From a clean directory, run `npx botmancers@<exact version> --version`
    and the registry smoke test for each published version.
