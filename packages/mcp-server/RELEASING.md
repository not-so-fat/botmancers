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
   cd packages/mcp-server
   npm ci
   npm run build
   npm run release:check
   ```

   This checks version consistency, the changelog entry, a clean git tree,
   the tests, package contents against the allowlist, provenance support,
   `npm publish --dry-run`, and a canary install of the exact tarball into a
   clean temporary project. It also checks that the release workflow runs on
   Node 24 and enforces npm 11.5.1 or newer, and that the local toolchain
   meets the same floor: npm trusted publishing (OIDC) needs npm >= 11.5.1
   and Node >= 22.14. It never writes to the registry.

   Save the evidence for the release ticket, bound to the commit you will tag
   (the transcripts record the commit SHA and exact version):

   ```sh
   mkdir -p release-evidence
   npm run release:check -- --out release-evidence/release-dry-run.txt
   npm run check:pack -- --out release-evidence/pack-manifest.txt
   npm run smoke:install -- --out release-evidence/clean-install-smoke.txt
   ```

   `release-evidence/` is outside the package `files` allowlist, so it is
   never published. Commit it in a follow-up commit that touches only that
   directory, so the recorded SHA is the code that was checked.
3. **Tag**:

   ```sh
   git tag botmancers-vX.Y.Z && git push origin botmancers-vX.Y.Z
   ```

   The `release-botmancers` workflow then runs `release:check --tag ...`
   again and runs `npm publish --provenance --access public --tag canary`.
   That attaches a signed SLSA provenance attestation that links the tarball
   to this repository, workflow, and commit.
4. **Canary smoke from the registry**, run from any machine:

   ```sh
   node packages/mcp-server/scripts/smoke-install.mjs --registry X.Y.Z --out smoke.txt
   npm view botmancers@X.Y.Z dist.integrity
   npm audit signatures            # inside the smoke project, or any project that installed it
   ```

5. **Promote to stable.** This requires an interactive 2FA prompt:

   ```sh
   npm dist-tag add botmancers@X.Y.Z latest
   ```

6. Record the npm URL (`https://www.npmjs.com/package/botmancers/v/X.Y.Z`),
   the integrity value, and the redacted smoke transcript on the release
   ticket.

If a canary is bad, do not promote it. Fix the problem, then release the
next patch version. Run `npm deprecate botmancers@X.Y.Z "<reason>"` for a
version that has already reached users. Unpublishing is a last resort.

## First publication (one-time operator actions)

The release ticket records these actions:

1. Create the npm organization `botmancers`, which reserves the
   `@botmancers/*` scope. Enable 2FA for every member, set to "auth and
   writes".
2. Confirm that `botmancers` is still unclaimed: `npm view botmancers` should
   return 404.
3. The first publish cannot use trusted publishing, because npm configures it
   per existing package. It runs in GitHub Actions, where nobody can answer
   an OTP prompt, so the token must be allowed to publish without one. Create
   a **granular access token** on npmjs.com with:
   - Packages and scopes: **Read and write**. The package does not exist
     yet, so it cannot be selected individually; use the account that will
     own it, grant no organization access, and rely on the short expiry.
   - **Bypass two-factor authentication** enabled. Without it, npm rejects a
     noninteractive publish from an account that has 2FA for writes.
   - An expiry of 1 day, and an IP allowlist if your CI supports one.

   Store it only as the `NPM_TOKEN` secret of the `npm-publish` GitHub
   environment. Then run steps 2 to 5 above. Delete and revoke it right after
   the first publish (step 4 below); it is the only 2FA-bypassing credential
   and must not outlive that release.
4. After the package exists, configure it on npmjs.com under **Settings →
   Trusted publishing** with GitHub Actions, repository
   `not-so-fat/botmancers`, workflow `release-botmancers.yml`, and
   environment `npm-publish`. Under the allowed actions, **select the direct
   `npm publish` action**. New trusted-publisher configurations default to
   staged publishing only, and the workflow runs `npm publish`, so without
   this setting every later release is rejected. Save, then confirm the
   configuration lists `npm publish` as allowed. Then delete the `NPM_TOKEN`
   secret and revoke the token. Later releases authenticate through OIDC
   only.
5. Under package settings, set **Publishing access** to "Require two-factor
   authentication and disallow tokens", and add the org as a maintainer.
6. From a clean directory, run
   `npx botmancers@<exact version> --version` and the registry smoke test.
