# NOT-651: npm runtime tarball size — where the bytes go

Status: investigation. Local measurements are byte-exact for a locally built
`botmancers@0.11.1` pack; the 0.11.1 registry baseline in §4 and the S3
trial in §5 are operator-measured from the real registry tarball
(networked host, Linux Node 24, 2026-11-20). Remaining evidence — the
PR-head smokes and the Linear comment — is tracked in §7.

## 1. Recommendation

**Safe to ship now** (drops only clearly-unneeded, never-loaded files; no
behaviour change; `check-pack` asserts them):

- **S1 — `app/.next` build artifacts**: `trace`, `trace-build`, `types/`,
  `diagnostics/`, `lock`, and the empty `cache/` dir. Not in
  `required-server-files.json`; the 0.7.0 release assembly never contained
  them, so production already runs without them.
- **S2 — `app/node_modules/@emnapi`**: ships only because file-tracing
  follows `@img/sharp-wasm32`, which `build-app.mjs` already drops via
  `SKIPPED_MODULES`. Nothing else in the assembly requires it (verified by
  grep over the assembled `app/`).
- **S3 — `app/.next/**/*.nft.json`**: the 84 per-entry
  output-file-tracing manifests (6.31 MB unpacked). Operator repack trial
  on the registry 0.11.1 contents: −6.31 MB unpacked / −1.76 MB
  compressed (−10.6%), −84 files; the pruned tree serves `/`,
  `/api/bots`, and `/api/health` (all 200) on Node 24. Nothing at
  runtime reads them — no reference in the generated `server.js`, in
  `next/dist/server`, or in our `lib/`/`app/` sources; the sole in-repo
  reader is the build-time `next internal static-routes-info` analysis
  command, which never runs against the shipped assembly.

**Proposal for Yusuke** (do not merge; each needs a networked full-product
smoke and/or changes coverage):

- **P1 — prune build/dev-only weight from the traced `next/` set.**
  The registry trace is already much leaner than the local one
  (`next/` 14.57 MB / 988 files vs 25.28 MB / 1,271 locally), but it
  still carries `dist/server/capsize-font-metrics.json` (4.30 MB) and
  `dist/server/dev` (0.41 MB). The local runtime statically references
  into those dirs (`build/output/log`, `lib/typescript/loadTsConfig`,
  `dev/browser-logs/file-logger`), so any pruning needs module-level
  load proof — and per the operator these stay proposal-only for Yusuke
  (Next internals).
- **P2 — `better-sqlite3` prebuild subsetting.** All 8 prebuilds
  (16,896,640 B unpacked, ~8.76 MB of the compressed tarball; operator
  confirms 8 prebuilds of 1.90–2.44 MB each in 0.11.1) ship today;
  dropping any platform (e.g. `win32-arm64`, −1.90 MB / −0.94 MB gzip)
  changes native coverage. Decision for Yusuke.
- **P3 — `@slack/web-api` file sweep on the release trace, confirmed.**
  0.11.1 carries ~0.54 MB of `@slack` (vs 13 files / 177,329 B
  locally) — the whole-`dist/` sweep persists. Tightening the trace
  could save ~300 KB unpacked, but those files may be dynamically
  required (the Slack relay uses `WebClient` methods at runtime), so
  this needs instrumented proof, not a blind prune.

**Investigated, zero yield (no action):** `*.md`/docs, `*.d.ts`, and
test/spec files inside `app/node_modules` — the local assembly contains
none (file tracing only copies referenced files), and the operator
confirms they total <0.1 MB in the registry build too; `dist/*.d.ts`
are the bridge's public API types and stay; `LICENSE` files stay for
attribution.

Expected release impact of shipping S1+S2+S3: **S3 saves ~1.76 MB
compressed (−10.6%) on the Turbopack release build** (operator repack
trial, §5); S1+S2 are ≈ 0 bytes there (Turbopack emits none of these
into `standalone/` — see the 0.7.0 evidence below; the §7 grep checks
on the PR-head tarball close this out),
−577,832 B unpacked / −37,048 B compressed on a webpack-style
assembly. S1+S2 are worth shipping anyway: they make the assembly
deterministic across builders and make `check-pack` pass on any
`standalone/` input (today a webpack-built assembly fails the gate on
`app/.next/types/validator.ts` and a checkout path inside `app/.next/trace`).

## 2. Method and fidelity

Measurement script: `packages/mcp-server/scripts/pack-report.mjs`
(`node scripts/pack-report.mjs <tarball.tgz|pack.json> [--top N] [--json]`).
It reads either a real `.tgz` (tar index parsed in-process, no extraction)
or saved `npm pack --json` / `--dry-run --json` output, and prints
compressed bytes, unpacked bytes, file count, bytes per top-level directory,
top-N `app/node_modules` packages, top-N `app/.next` subtrees, and the
`better-sqlite3/prebuilds` subtotal.

The developer sandbox has no network and forbids `listen()`, so the stock
`npm run build:app` cannot run there as-is. The local measurement build
(`main` at `3f05617`-plus-branch, package `0.11.1`) differs from a release
build in three bounded, documented ways — none of which affects the
exclusion deltas:

1. **Webpack instead of Turbopack** (`next build --webpack`). Turbopack
   cannot run in the sandbox at all: even PostCSS evaluation spawns a
   helper that binds a port (`binding to a port: Operation not permitted`).
   Effect: the bundler *split* differs (webpack externalises more into
   `app/node_modules`, Turbopack bundles more into `app/.next/server`),
   but the total is within a few percent; every locally trialled file
   class exists in both builds. The S3 class (`.nft.json`) is the
   exception — the Turbopack release emits 84 manifests the local
   webpack build does not, so S3's delta comes from the operator's
   repack trial instead. See §4–§5.
2. **Offline Google-Fonts substitution.** `next/font/google` fetches CSS at
   build time. The local build used Next's own
   `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` hook with the genuine Geist
   latin/latin-ext `.woff2` bytes that ship inside the `next` package
   (`next/dist/next-devtools/server/font/`), one `@font-face` per subset
   Google returns (5 for Geist, 6 for Geist Mono; non-latin subsets reuse
   the latin file as a size proxy). Local font payload: 11 files,
   ~300 KB. A networked build downloads the true per-subset files
   (same order of magnitude). No trialled exclusion touches
   `.next/static/media`, so all deltas are exact.
3. **Type validation skipped** (`typescript.ignoreBuildErrors` via a
   scratch env-gated config patch, reverted after the build). The webpack
   route-type validator rejects pre-existing route helper exports
   (`GROUP_MIN_MEMBERS`, …) that the stock Turbopack build accepts; skipping
   the check does not change emitted output. Both scratch patches
   (`app/layout.tsx` was tried first, then `next.config.ts`) were fully
   reverted — `git status` shows only the new investigation files.

Trials ran in scratch copies (`rsync` of the assembled package, deletions
applied, real `npm pack --ignore-scripts`, reported with the same script),
so every before/after pair is a true compressed/unpacked measurement, not
an estimate. Each trial's `app/server.js` was boot-tested: in this sandbox
a healthy server boots all the way to `listen EPERM` (the sandbox blocks
the socket); anything less (e.g. `Cannot find module`) is a boot failure.
Boot success does **not** prove lazy per-route chunks load — full route
coverage needs the operator's networked smokes.

The §4 registry row and the §5 S3 row are operator-supplied (networked
host, Linux Node 24, 2026-11-20): `npm pack botmancers@0.11.1` in an
empty dir for the baseline, then a scratch repack of the 0.11.1
contents minus `app/.next/**/*.nft.json` with the same gzip settings
for the trial. Repacking re-gzips with a different byte stream than
the registry tarball, so the S3 trial compares against a *repacked*
baseline (16.54 MB) rather than the registry bytes (16.49 MB) — the
−1.76 MB delta is apples-to-apples. All operator MB figures are 10⁶
bytes (16,486,447 B ≈ 16.49 MB), and the per-area subtotals reconcile
exactly (see §4).

## 3. Where the bytes go (local build, `botmancers-0.11.1.tgz`)

Full `pack-report` output for the locally built tarball
(`npm pack --ignore-scripts`; dry-run `--json` reports identical bytes):

```
pack-report: botmancers-0.11.1.tgz
compressed: 16,916,317 B (16.13 MiB)
unpacked:   53,050,420 B (50.59 MiB) in 2,674 files

bytes per top-level directory (share of unpacked):
  52,561,103 B (50.13 MiB)   99.1%   2640 files  app
      216,747 B (0.21 MiB)    0.4%     26 files  dist
      191,530 B (0.18 MiB)    0.4%      2 files  schemas
       55,763 B (0.05 MiB)    0.1%      4 files  (root)
       25,277 B (0.02 MiB)    0.0%      2 files  skills

top 15 app/node_modules packages (share of unpacked):
  25,283,419 B (24.11 MiB)   47.7%   1271 files  app/node_modules/next
  16,927,356 B (16.14 MiB)   31.9%     33 files  app/node_modules/better-sqlite3
    1,312,873 B (1.25 MiB)    2.5%     14 files  app/node_modules/react-dom
      339,057 B (0.32 MiB)    0.6%    599 files  app/node_modules/caniuse-lite
      238,556 B (0.23 MiB)    0.4%      2 files  app/node_modules/axios
      187,695 B (0.18 MiB)    0.4%      3 files  app/node_modules/mime-db
      177,329 B (0.17 MiB)    0.3%     13 files  app/node_modules/@slack/web-api
      134,191 B (0.13 MiB)    0.3%     15 files  app/node_modules/ws
      111,635 B (0.11 MiB)    0.2%     12 files  app/node_modules/source-map-js
       68,530 B (0.07 MiB)    0.1%     10 files  app/node_modules/react
       66,477 B (0.06 MiB)    0.1%      4 files  app/node_modules/@emnapi/runtime
       46,438 B (0.04 MiB)    0.1%      2 files  app/node_modules/baseline-browser-mapping
       38,324 B (0.04 MiB)    0.1%      8 files  app/node_modules/@slack/socket-mode
       30,917 B (0.03 MiB)    0.1%      7 files  app/node_modules/@swc/helpers
       24,239 B (0.02 MiB)    0.0%      6 files  app/node_modules/p-queue
  ... and 40 smaller packages
better-sqlite3 prebuilds: 16,896,640 B (16.11 MiB) in 8 files

top 15 app/.next subtrees (share of unpacked):
    4,607,774 B (4.39 MiB)    8.7%    324 files  app/.next/server
    1,404,194 B (1.34 MiB)    2.6%    112 files  app/.next/static
      467,200 B (0.45 MiB)    0.9%      1 files  app/.next/trace
       44,025 B (0.04 MiB)    0.1%      4 files  app/.next/types
       19,989 B (0.02 MiB)    0.0%      1 files  app/.next/routes-manifest.json
       10,391 B (0.01 MiB)    0.0%      1 files  app/.next/required-server-files.json
        5,292 B (0.01 MiB)    0.0%      1 files  app/.next/app-path-routes-manifest.json
        3,969 B (0.00 MiB)    0.0%      1 files  app/.next/prerender-manifest.json
          511 B (0.00 MiB)    0.0%      1 files  app/.next/build-manifest.json
          130 B (0.00 MiB)    0.0%      2 files  app/.next/diagnostics
           21 B (0.00 MiB)    0.0%      1 files  app/.next/BUILD_ID
           20 B (0.00 MiB)    0.0%      1 files  app/.next/package.json
            2 B (0.00 MiB)    0.0%      1 files  app/.next/react-loadable-manifest.json
            0 B (0.00 MiB)    0.0%      1 files  app/.next/lock
```

Area totals (exact, from the pack file list):

| area               | unpacked bytes | files |
|--------------------|---------------:|------:|
| `app/node_modules` |     45,241,260 |  2160 |
| `app/.next`        |      6,563,518 |   452 |
| `app/public`       |        748,535 |    25 |
| `dist`             |        216,747 |    26 |
| `schemas`          |        191,530 |     2 |
| `(root)`           |         55,763 |     4 |
| `skills`           |         25,277 |     2 |
| `app` root files   |          7,790 |     3 |

Two facts dominate everything else: `next` (47.7%) and `better-sqlite3`
(31.9%) are 80% of the unpacked tarball, and the 8 sqlite prebuilds alone
are ~8.76 MB of the ~16.9 MB compressed tarball (each `.node` gzips to
~50%; per-platform table in §6 P2).

## 4. Baselines: 0.11.1 (registry) vs local build

| pack | compressed | unpacked | files | `app/node_modules` | `app/.next` |
|------|-----------:|---------:|------:|-------------------:|------------:|
| 0.11.1 registry (operator, Node 24) | 16,486,447 B | 49.47 MB file bytes¹ | 2,563 | ~34.27 MB (1,630 files) | ~13.96 MB (871 files) |
| local main build (webpack, §2) | 16,916,317 B | 53,050,420 B | 2,674 | 45,241,260 B | 6,563,518 B |
| 0.7.0 release evidence (Turbopack, `release-evidence/pack-manifest.txt`) | 19,879,721 B | 59,234,879 B | 2,426 | ~35.5 MB | ~23.2 MB |

¹ The operator reports 49.47 MB of file bytes for the registry tarball
(the gunzipped tar *stream* is 51,494,400 B — file bytes plus tar
headers and 512-byte padding). `pack-report` sums file bytes, so the
local unpacked figure compares to 49.47×10⁶, not to the tar stream.

### 0.11.1 registry breakdown (operator)

- Top level: `app` 48.98 MB (2,529 files); `dist` 0.22 MB;
  `schemas` 0.19 MB; `README.md` 0.03 MB; `skills` 0.03 MB;
  `CHANGELOG.md` 0.02 MB.
- `app/`: `node_modules` 34.27 MB (1,630 files); `.next` 13.96 MB
  (871 files); `public` 0.75 MB (25 files).
- `app/node_modules`: `better-sqlite3` 16.93 MB (33 files; 8 prebuilds
  for linux/linuxmusl x64+arm64, darwin x64+arm64, win32 x64+arm64,
  1.90–2.44 MB each); `next` 14.57 MB (988 files; largest single file
  `dist/server/capsize-font-metrics.json` 4.30 MB, `compiled/next-server`
  1.73 MB, `server/dev` 0.41 MB); `react-dom` 1.31 MB; `@slack` 0.54 MB;
  `axios` 0.24 MB.
- `app/.next`: `server` 12.71 MB (`server/app/api` alone 6.12 MB),
  `static` 1.21 MB. By kind: `.js` 7.18 MB (448 files), **`.nft.json`
  6.31 MB (84 files)**, other JSON 0.09 MB.
- `.map`, README/LICENSE/`.md`, and `.d.ts` files inside `app/` total
  <0.1 MB — `build-app.mjs` already filters `.map` and `cache/`.

Notes:

- Units resolved: operator MB are 10⁶ bytes (16,486,447 B ≈ 16.49 MB),
  and the subtotals reconcile exactly (34.27 + 13.96 + 0.75 = 48.98;
  1,630 + 871 + 25 + 3 `app` root files = 2,529).
- Local-vs-0.11.1 totals agree within a few percent
  (compressed +2.6%, unpacked file bytes +7.2%, files 2,674 vs 2,563),
  but the bundler *split* differs systematically: webpack externalises
  into `app/node_modules` (local `next/` = 25,283,419 B / 1,271 files)
  while Turbopack bundles into `app/.next/server` (registry `next/` =
  14.57 MB / 988 files; registry `app/.next` = 13.96 MB vs 6.56 MB
  locally — of which 6.31 MB is the `.nft.json` set the local webpack
  build does not emit). Same modules, different suitcases.
- `better-sqlite3` matches across all three builds (locally 16,927,356 B
  / 33 files with 16,896,640 B of prebuilds; registry 16.93 MB /
  33 files), as do `react`, `react-dom`, `axios`, `mime-db`, and `ws` —
  the traced runtime core is bundler-stable.
- Local-only traced packages (webpack over-tracing, all build-time-only —
  see P1): `caniuse-lite` (339,057 B / 599 files), `source-map-js`
  (111,635 B), `baseline-browser-mapping` (46,438 B), `@emnapi/runtime`
  (66,477 B). None appears in the 0.7.0 manifest; the operator's
  package list cuts off above their sizes, so the §7 grep checks on the
  PR-head tarball settle S2's release impact (expected: none).
- Opposite direction: the `@slack/web-api` sweep persists in 0.11.1
  (~0.54 MB of `@slack`, vs 13 files / 177,329 B locally at the same
  `7.19.0`). See P3.

## 5. Trials (scratch copies, real `npm pack`, same script)

| trial | deletion vs T0 | compressed | Δ compr. | unpacked | Δ unp. | files | boot |
|-------|----------------|-----------:|---------:|---------:|-------:|------:|------|
| T0 baseline | — | 16,916,317 | — | 53,050,420 | — | 2674 | ok (to `listen EPERM`) |
| **T1 (S1)** | `app/.next/{trace,types,diagnostics,lock}` + empty `cache/` | 16,893,451 | −22,866 (−0.14%) | 52,539,065 | −511,355 (−0.96%) | 2666 | ok |
| **T2 (S1+S2)** | T1 + `app/node_modules/@emnapi` | 16,879,269 | −37,048 (−0.22%) | 52,472,588 | −577,832 (−1.09%) | 2662 | ok |
| T3 (P1 bulk probe) | T2 + 16 build/dev-only subtrees incl. `next/dist/build` | 14,751,765 | −2,164,552 | 39,725,093 | −13,325,327 | 1793 | **FAIL** (`Cannot find module '../build/output/log'` from `next/dist/server/next.js`) |
| T3b | T3 minus `next/dist/build` (kept) | 15,048,992 | −1,867,325 | 40,987,727 | −12,062,693 | 1951 | **FAIL** (`Cannot find module '../../lib/typescript/loadTsConfig'`) |
| T3c | T3b minus `next/dist/lib/typescript` (kept) | 15,068,689 | −1,847,628 | 41,058,877 | −11,991,543 | 1962 | **FAIL** (`Cannot find module '../dev/browser-logs/file-logger'` from `server/node-environment-extensions/console-file.js`) |
| **S3 (operator repack of registry 0.11.1)** | `app/.next/**/*.nft.json` (84 files) | ~14.78 MB | −1.76 MB (−10.6%)¹ | 43.16 MB | −6.31 MB | 2,479 | ok (`/`, `/api/bots`, `/api/health` all 200 on Node 24) |

¹ Against the *repacked* 0.11.1 baseline (16.54 MB with the same gzip
settings), not the registry bytes (16.49 MB) — see §2.

T1/T2 boot identically to T0 (server initialises through route/manifest
load and stops only at the sandbox's `listen` block). T3/T3b/T3c are
proposal probes, not shippable states: each bulk drop breaks boot on a
*statically required* module inside a supposedly build-only directory,
which is exactly why requireable-`.js` pruning stays a proposal (§6 P1).
No further bisection was run — the pattern is established and the release
build likely omits these subtrees anyway (§4).

The S3 row is the operator's scratch trial, not a local one: the local
webpack assembly's whole `app/.next` is 6.56 MB — smaller than the
registry build's 6.31 MB of `.nft.json` alone — so the S3 filter has
nothing to drop locally. The operator deleted the 84 manifests from
the 0.11.1 contents, repacked, and ran `node server.js` from the
pruned tree: `/`, `/api/bots`, and `/api/health` all returned 200.

## 6. Candidate catalog and risk classification

Risk axes per the ticket: install behaviour, native platform coverage,
managed updater. "Ship" candidates must be zero on all three axes.

### Safe to ship now (shipped in this PR)

**S1 — `app/.next` build artifacts** (`trace`, `trace-build`, `types/`,
`diagnostics/`, `lock`, empty `cache/` dir).

- Numbers: −511,355 B unpacked / −22,866 B compressed locally, −8 files
  (T1). Expected release impact ≈ 0 (Turbopack `standalone/` does not
  contain them — absent from the 0.7.0 assembly; the §7 exclusion greps
  on the PR-head tarball confirm it).
- Why safe: none are listed in `.next/required-server-files.json`
  (verified against the built manifest); `trace`/`trace-build` are
  build telemetry the build writes and the server never reads (the
  runtime tracer keeps spans in memory / OTel); `types/` is consumed
  by `tsc` at build time only; `diagnostics/` holds bundle-analyzer
  output; `lock` is a 0-byte build lock. Production evidence: the 0.7.0
  release ran without all of them. Local evidence: T1 boots like T0.
- Side benefit: a webpack-style assembly currently **fails** `check-pack`
  (`forbidden (TypeScript source): app/.next/types/validator.ts`, and the
  builder's checkout path embedded in `app/.next/trace`); S1 fixes that
  class of failure for any builder.
- Risk: none on all three axes (no install-time code path, no native
  code, updater untouched).

**S2 — `app/node_modules/@emnapi`** (whole scope dir, 66,477 B / 4 files).

- Numbers: −66,477 B unpacked / −14,182 B compressed on top of T1 (T2).
  Expected release impact ≈ 0 (absent from 0.7.0; the §7 exclusion
  greps on the PR-head tarball confirm it).
- Why safe: `@emnapi/runtime` is required only by `@img/sharp-wasm32`
  (plus packages never traced: `sharp`, `@tailwindcss/oxide`,
  `@napi-rs/wasm-runtime` — reverse-deps checked via `package.json`
  grep), and `build-app.mjs` already drops `@img/*`. Verified zero
  remaining references by grepping the assembled `app/` (only the
  package's own `index.js`/`package.json` mention `emnapi`). T2 boots
  like T0.
- Risk: none on all three axes.

**S3 — `app/.next/**/*.nft.json`** (84 files, 6.31 MB unpacked in 0.11.1).

- Numbers: −6.31 MB unpacked / −1.76 MB compressed (−10.6%), −84 files
  (operator repack trial, §5). This is the only shipped exclusion with
  a real release impact.
- Why safe: the manifests are build-time output-file-tracing records —
  each sits next to the route `.js` it describes and lists that
  entry's traced dependencies for tooling. Nothing at runtime reads
  them: the operator confirmed neither the generated `server.js` nor
  `next/dist/server` references `nft.json` (re-verified by grep over
  the installed `next` package and our `lib/`/`app/` sources — the
  sole in-repo reader is the build-time `next internal
  static-routes-info` analysis command), and the pruned tree serves
  `/`, `/api/bots`, and `/api/health` (all 200) on Node 24. The
  shipped `.js` entries themselves are untouched — the filter drops
  only the `*.nft.json` siblings.
- Risk: none on all three axes (no install-time code path, no native
  code, updater untouched). The one residual — lazy per-route chunks
  beyond the three probed routes — is covered by the operator's
  PR-head product smoke (§7).

### Investigated, zero yield — no change

- **`*.md`/docs, `*.d.ts`, test/spec files under `app/node_modules`:**
  the assembly contains **zero** of each (verified over the 2,674-file
  pack list). File tracing only copies referenced files, so package
  READMEs, type declarations, and test dirs never enter `standalone/`.
  The only `.md` files in the tarball are the intentional top-level
  `README.md`, `CHANGELOG.md`, and the two skill docs; the only `.d.ts`
  files are the bridge's public `dist/*.d.ts` (kept — library API
  surface) plus `app/.next/types/*.d.ts` (dropped by S1).
- **`LICENSE` files** (`better-sqlite3/LICENSE`, `@vercel/nft/LICENSE`,
  2,129 B total): kept deliberately — MIT attribution must ship with
  the code.
- **`app/public`, `app/.next/static`, `.rsc`/`.html` payloads,
  `react-loadable-manifest.json`** (2 B, but listed in
  `required-server-files.json`), **`dist/*.d.ts`**: all runtime- or
  API-relevant; kept.

### Proposal for Yusuke (not in this PR)

**P1 — prune build/dev-only weight from the traced `next/` set.**
Locally ~12.75 MB / ~870 files look build-only (`dist/build` 1.26 MB,
`server/dev` 430 KB, compiled `babel`/`babel-packages` 2.9 MB,
`next-devtools` 863 KB, CSS toolchain ~730 KB, `@next/font` loader
1.35 MB, `capsize-font-metrics.json` 4.30 MB, TS tooling ~156 KB,
`@modelcontextprotocol` 251 KB) plus fellow travelers (`caniuse-lite`
339 KB / 599 files, `baseline-browser-mapping` 46 KB, `source-map-js`
112 KB). The operator's 0.11.1 numbers confirm the release trace
omits nearly all of it (`next/` 14.57 MB / 988 files vs 25.28 MB /
1,271 locally) — but `capsize-font-metrics.json` (4.30 MB, the
single largest file in the tarball) and `server/dev` (0.41 MB)
persist in the release trace, and the runtime *statically* requires
into those dirs (T3/T3b/T3c boot failures), so any pruning must be
module-level, guided by instrumented load tracing during a full
networked smoke (boot + every route + middleware), not by directory.
Per the operator, capsize removal and `server/dev` pruning are
proposal-only for Yusuke (Next internals). Suggested path: operator
captures `Module._load` during the product smoke on a networked host;
a follow-up proposes pruning exactly the never-loaded subset. Risk if
done wrong: install/runtime behaviour change — hence proposal-only.

**P2 — `better-sqlite3` prebuild subsetting.** Per-platform bytes
(unpacked → gzip), measured locally (identical to release — the
package copies `prebuilds/` wholesale; the operator confirms all 8
prebuilds ship in 0.11.1 at 1.90–2.44 MB each):

| prebuild | unpacked | gzip |
|----------|---------:|-----:|
| `linux-x64.node` | 2,226,168 | 1,126,916 |
| `linuxmusl-x64.node` | 2,435,680 | 1,224,691 |
| `linux-arm64.node` | 2,066,328 | 1,105,408 |
| `linuxmusl-arm64.node` | 2,312,112 | 1,245,712 |
| `darwin-arm64.node` | 1,980,736 | 992,319 |
| `darwin-x64.node` | 1,982,880 | 1,039,330 |
| `win32-x64.node` | 1,989,632 | 1,066,514 |
| `win32-arm64.node` | 1,903,104 | 936,696 |
| **total** | **16,896,640** | **~8,737,586** |

Dropping even the smallest-audience prebuild (`win32-arm64`: −1.90 MB
unpacked / −0.94 MB compressed, −5.5% of the tarball) changes native
platform coverage — managed installs run on user machines, where
macOS is common, so `darwin-*` must stay. Any subsetting is Yusuke's
call; no recommendation to drop is made here.

**P3 — `@slack/web-api` trace sweep, confirmed in 0.11.1.** The
registry build carries ~0.54 MB of `@slack` (0.7.0 shipped 390 files
/ 489,532 B; the local trace holds 13 / 177,329 B at the same
`7.19.0`) — Turbopack-NFT sweeps the package's `dist/`, likely by
expanding a dynamic require. Tightening the trace could save ~300 KB
unpacked — but only with proof those files are never dynamically
required (the Slack relay uses `WebClient` methods at runtime).

## 7. Operator evidence: received and remaining (networked host, Linux Node 24)

### Received 2026-11-20 (in this report and the PR body)

- **0.11.1 baseline** from `npm pack botmancers@0.11.1` in an empty
  dir: 16,486,447 B compressed; 49.47 MB file bytes in 2,563 files;
  full per-area breakdown in §4. MB are 10⁶ bytes.
- **S3 scratch trial**: 0.11.1 contents minus the 84 `.nft.json` files,
  repacked with the same gzip: ~14.78 MB compressed (−1.76 MB,
  −10.6% vs the 16.54 MB repacked baseline), 43.16 MB unpacked
  (−6.31 MB), 2,479 files; `node server.js` from the pruned tree
  serves `/`, `/api/bots`, `/api/health` (all 200). Neither the
  generated `server.js` nor `next/dist/server` references `nft.json`.
- **P1/P2/P3 scoping**: `next/` is 14.57 MB / 988 files in 0.11.1
  (bulk already omitted) but keeps `capsize-font-metrics.json`
  (4.30 MB) and `server/dev` (0.41 MB); all 8 prebuilds ship
  (1.90–2.44 MB each); `@slack` is 0.54 MB (sweep persists).
  Prebuild pruning, capsize removal, and `server/dev` pruning are
  proposal-only for Yusuke — measured, not shipped.

### Remaining: PR-head tarball (this branch, stock release build)

Build the candidate tarball on the networked host (stock `npm run
build && npm run build:app` in `packages/mcp-server`, then `npm
pack`), and:

1. **Pack report**: `node packages/mcp-server/scripts/pack-report.mjs
   ./botmancers-<version>.tgz` — paste the output in the PR body.
   Expect ~14.7–14.8 MB compressed and no `.nft.json` rows; the
   top-level/`app` split should otherwise match §4's 0.11.1 shape.
2. **Exclusion greps** (expect no matches):
   `tar tzf <tarball> | grep -E 'package/app/\.next/(trace|trace-build|types|diagnostics|lock|cache)'`;
   `tar tzf <tarball> | grep 'package/app/node_modules/@emnapi'`;
   `tar tzf <tarball> | grep -c '\.nft\.json$'` (expect 0).
3. **Entry points**: `bin.botmancers` is `dist/cli.js`, both schema
   exports resolve, and `app/server.js` boots (covered by the smokes).
4. **Smokes from a clean prefix**: bridge smoke, full-product install
   smoke (`setup`/`start`/`doctor`), and the managed install/upgrade
   suite. Paste transcripts in the PR body.
5. **Linear**: record the recommendation + numbers table (§1, §5) as a
   comment on NOT-651.

## 8. Shipped change (this PR)

- `packages/mcp-server/scripts/pack-report.mjs` (new): the measurement
  script (§2), with unit tests in `packages/mcp-server/test/pack-report.test.mjs`.
- `packages/mcp-server/scripts/build-app.mjs`: S1 — the `.next`
  assembly copy now also skips `trace`, `trace-build`, `types/`,
  `diagnostics/`, `lock`, and the `cache/` dir itself (previously only
  `.map` files and paths *under* `cache/`); S2 — `@emnapi` joins
  `SKIPPED_MODULES` next to `sharp`/`@img`/`detect-libc`; S3 — the
  `.next` copy drops `*.nft.json` via the exported `keepNextEntry`
  predicate (unit-tested in
  `packages/mcp-server/test/build-app.test.mjs`).
- `packages/mcp-server/scripts/check-pack.mjs`: asserts the S1/S2/S3
  patterns stay out (`app/.next/trace*`, `app/.next/{types,
  diagnostics}/`, `app/.next/lock`, `app/.next/cache`,
  `*.nft.json`, `app/node_modules/@emnapi/`) while the required entry
  points (`dist/cli.js`, both schema exports, `app/server.js`,
  `app/BUILD_INFO.json`, prebuilds, …) stay in; the S3 assertion is
  pinned in `packages/mcp-server/test/package.test.mjs`.
- This report.

Post-change verification. S1+S2 were verified on the local build in
the prior session: re-assembled via `build-app.mjs --skip-next`,
re-packed, `pack-report` matches the T2 prediction (16,879,269 /
52,472,588 / 2,662), `check-pack` passes, the server boots to `listen
EPERM` exactly like T0, and `bin.botmancers` plus both schema exports
are unchanged. S3 is verified by the `keepNextEntry` unit tests (3),
the `check-pack` forbidden-pattern test with a synthetic `.nft.json`
path, and the operator's repack + route smokes on the real 0.11.1
contents — the sandbox webpack assembly contains no `.nft.json` to
drop, so the filter is locally a no-op and its release impact comes
from the operator measurement. The full package suite (`npm run
test:mcp-server`), `check:pack` on the release build, and the
bridge/product/managed smokes run on CI and the networked operator
host (§7).
