# Repository layout

An agent or contributor opening the public `not-so-fat/botmancers` checkout
can tell from this one document where the Next.js app, core engine, tests,
package manifest, generated runtime, lockfiles, changelog, and release guide
live — and which conventions new files must follow.

This document describes current reality. Planned moves are marked
**planned**; they are not done yet.

## 1. House-style guideline

Shared with agent-deck / agent-dealer. New files must follow it:

- Source lives with its owning app: `apps/<app>/` for apps,
  `packages/<pkg>/src/` for packages. In botmancers the root `app/` + `lib/`
  + `public/` is the Next.js app.
- Unit tests are colocated with their source where the runner supports it;
  cross-app tests and fixtures live in one discoverable `tests/` dir.
- One root `npm test` runs the suite.
- Live / credentialed checks are documented separately from the default suite.
- CI watches the paths its checks depend on.
- Repo-wide tools live in root `scripts/`; package builders live beside their
  manifest (`packages/<pkg>/scripts/`).
- Release commands live at the root and are documented in
  [docs/PUBLISHING.md](PUBLISHING.md).
- Generated output is gitignored, and shipped contents are verified from the
  real tarball — never from the working tree.
- The [README](../README.md) is the docs index: every guide is linked from it.
- Reproducible fixtures live beside their consumers.
- New run logs and screenshots go to CI artifacts or release attachments,
  not git.

## 2. Botmancers map

Two manifests are both named `botmancers`: the root
[package.json](../package.json) (the Next.js app plus the root test/release
scripts; not published) and
[packages/mcp-server/package.json](../packages/mcp-server/package.json) (the
published package).

| Area | Path | Notes |
| --- | --- | --- |
| Next.js routes | [app/](../app/) | Routes and UI of the Next.js app; app shell is [proxy.ts](../proxy.ts), [instrumentation.ts](../instrumentation.ts), [next.config.ts](../next.config.ts). |
| Core engine | [lib/](../lib/) | Engine source; contract in [docs/core-engine.md](core-engine.md). |
| Static assets | [public/](../public/) | Static assets served by the Next.js app. |
| Root tests | [tests/](../tests/) (`test-*.js`, 79 files) | One command: `npm test` runs every deterministic suite via [tests/run.js](../tests/run.js); `npm run test:<name>` runs one suite (e.g. `npm run test:acceptance`); `npm run test:mcp-server` runs the package suite. Live/credentialed/manual checks (`tests/test-import.js`, `test:marketplace-import`, `test:acceptance:live-server`, `test:grok-handoff`, `smoke:*`, `probe:*`, `proof:*`) are listed separately in [tests/README.md](../tests/README.md). |
| Test support | [tests/support/](../tests/support/) | Fakes, fixtures, and helpers used by the root tests, including the repo-root helper [tests/support/repo-root.js](../tests/support/repo-root.js). |
| Test fixtures | [tests/fixtures/](../tests/fixtures/) | Reproducible fixture inputs beside their consumers (one named dir per check, e.g. `session-share-preflight/`, `grok-handoff/`), each with a README saying what each file represents and where it came from. |
| Package source | [packages/mcp-server/src/](../packages/mcp-server/src/) | CLI and server source; `bin.botmancers` = `dist/cli.js` after build. |
| Package tests | [packages/mcp-server/test/](../packages/mcp-server/test/) | Run with `npm --prefix packages/mcp-server test` (builds first). |
| Package manifest + `files` | [packages/mcp-server/package.json](../packages/mcp-server/package.json) | Published manifest; `files` ships `dist`, `schemas`, `skills`, `app/`, `CHANGELOG.md`. Tarball contents verified by [packages/mcp-server/scripts/check-pack.mjs](../packages/mcp-server/scripts/check-pack.mjs). |
| Generated runtime | `packages/mcp-server/app/` + `packages/mcp-server/dist/` | **Generated, gitignored, not in git.** `app/` is built by [packages/mcp-server/scripts/build-app.mjs](../packages/mcp-server/scripts/build-app.mjs) (`npm run build:app`); `dist/` by `tsc` (`npm run build`). |
| Root lockfile | [package-lock.json](../package-lock.json) | Locks the Next.js app's dependencies. |
| Package lockfile | [packages/mcp-server/package-lock.json](../packages/mcp-server/package-lock.json) | Committed; locks the pinned build tools (`typescript`, `@types/node`); the release workflow installs with `npm ci`. |
| Package-local changelog | [packages/mcp-server/CHANGELOG.md](../packages/mcp-server/CHANGELOG.md) | Stays in the package (not at the root) because it ships inside the npm tarball. |
| Release commands | `release:prepare` / `release:finish` / `release:check` / `publish:packages` | Root `npm run` scripts delegating to `packages/mcp-server/scripts/`; see [docs/PUBLISHING.md](PUBLISHING.md). |
| Publishing guide | [docs/PUBLISHING.md](PUBLISHING.md) | The release procedure, versioning rules, and publish configuration. |
| Repo-wide tools | [scripts/](../scripts/) | Install script, smokes, probes, seed/proof helpers. |
| Package builders | [packages/mcp-server/scripts/](../packages/mcp-server/scripts/) | Build, release, smoke, and check scripts beside their manifest. |
| Historical evidence | (removed from the tree in NOT-650) | The former `docs/evidence/` + `docs/parity/` bulk and `packages/mcp-server/release-evidence/` transcripts stay reachable at commit-pinned URLs (`918166c`); the only committed captures left are the two `docs/parity/` MATCH screenshots the parity record keeps plus the small captures linked from the Grok Bot and Cursor provider docs. Reproducible fixtures live beside their consumers instead ([tests/fixtures/](../tests/fixtures/)); new run logs and screenshots go to CI artifacts or release attachments, not git. |

## 3. Where new things go

- New route or UI → [app/](../app/); new engine code → [lib/](../lib/);
  new static asset → [public/](../public/).
- New CLI/server code → [packages/mcp-server/src/](../packages/mcp-server/src/);
  its tests → [packages/mcp-server/test/](../packages/mcp-server/test/).
- New cross-cutting test or fixture → [tests/](../tests/)
  (`tests/test-*.js` plus [tests/support/](../tests/support/)).
- New reproducible fixture → beside its consumer ([tests/fixtures/](../tests/fixtures/)
  for root checks, `packages/mcp-server/test/fixtures/` for the package suite).
- New repo-wide tool → [scripts/](../scripts/); new package builder →
  [packages/mcp-server/scripts/](../packages/mcp-server/scripts/).
- New guide → `docs/`, linked from the [README](../README.md) docs index;
  release-related → [docs/PUBLISHING.md](PUBLISHING.md).
- New run log or screenshot → CI artifact or release attachment, not git.
- Never commit generated output (`packages/mcp-server/app/`,
  `packages/mcp-server/dist/`).
