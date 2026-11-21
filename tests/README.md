# Root tests

Deterministic suites live here as `tests/test-*.js` (79 files); shared fakes,
fixtures, and helpers live in `tests/support/`. The package suite stays in
`packages/mcp-server/test/` and is unchanged by this layout.

## The one command

```sh
npm test
```

runs every deterministic root suite via `node tests/run.js`: each
`tests/test-*.js` file except the four documented exclusions below, in
sorted order from the repository root, failing fast on the first failure
with the suite name. A passing run ends with `N passed, 0 failed`.

Run one suite by its alias (every `test:*` name from before the move still
exists, now pointing under `tests/`):

```sh
npm run test:acceptance
npm run test:session-shares
```

or filter the runner to matching file names:

```sh
node tests/run.js session-share
```

`test:attempt-adapter` runs two files
(`tests/test-attempt-adapter.js` and
`tests/test-session-provider-attempt-adapter.js`).

Environment: Node 24 with dev dependencies installed and `NODE_ENV` unset;
unset `PORT`, `AGENT_DECK_*`, and `CLAUDE*` before running suites. Loopback
`listen()` must be available (the route-host suites bind OS-assigned ports).

## Excluded from `npm test` (live / credentialed / manual)

These checks are deterministic-adjacent but need something `npm test` cannot
assume; run them individually.

| Check | Needs |
| --- | --- |
| `node tests/test-import.js` (no alias; historical import suite) | A running dev server on port 43123 (`npm run dev`), then run the file directly |
| `npm run test:marketplace-import` (`tests/test-import-marketplace-ui.js`) | A running dev server (`npm run dev`; `BOTMANCERS_TEST_PORT` or 3333), then run the alias |
| `npm run test:acceptance:live-server` (`tests/test-acceptance-steps-1-7.js`; historical walkthrough, kept as evidence) | A developer server serving this checkout (`BOTMANCERS_TEST_PORT` or 43123); see `ACCEPTANCE.md` |
| `npm run test:grok-handoff` (`tests/test-grok-handoff.js`) | Release time: it packs and installs the bridge and runs its MCP scenario over loopback (see `tests/fixtures/grok-handoff/README.md`); offline it reports the installed integrity and skips byte-identity, `--registry X.Y.Z` verifies it against the registry `dist.integrity` |
| `npm run smoke:direct` | A disposable Git workdir (`--workdir`, guarded by `tests/support/acceptance/smoke-guard.js`); real provider CLIs unless `BOTMANCERS_SMOKE_PROVIDER=fake` |
| `npm run smoke:cursor-session` | Installed, logged-in `cursor-agent` (or `BOTMANCERS_CURSOR_CLI`) plus network for Cursor |
| `npm run smoke:claude-provider` | Real, logged-in `claude` CLI (`--approve-write` for the write turn) |
| `npm run smoke:muse-msp` | Real `muse` CLI; `--provider meta` spends a billable model turn |
| `npm run smoke:slack-relay` | Real Slack workspace tokens (`BOTMANCERS_SLACK_APP_TOKEN`, `BOTMANCERS_SLACK_BOT_TOKEN`); runbook in `docs/slack-transport.md` |
| `npm run smoke:not-517-share-current` | Logged-in `claude` or `codex` CLI (spends a little usage) |
| `npm run probe:not-514-claude` / `:codex` / `:cursor` | The respective real CLI; default flags use isolated homes/configs (no login), `--home` spends usage |
| `npm run proof:*` (`agent-conversations`, `new-agent-dialog`, `agent-registration`, `session-sync-ui`, `session-list`, `agent-sessions-page`, `agent-home`, `agent-activity`, `agent-slack`) | The seeded real app already listening (seed with the matching `seed:*` script first) plus headless Chrome over CDP; no mocks |

`seed:*` scripts are helpers that seed fixture data for the `proof:*` runs,
not checks themselves.

## Conventions for new tests

- New cross-cutting test or fixture goes here (`tests/`), not at the root.
- Never use `__dirname` as the repo root: require the shared helper —
  `const ROOT = require('./support/repo-root');` — instead of hand-rolled
  `..` chains. `jiti('./…')`-style relative loads resolve from the test
  file, so they start with `../`.
- Support code goes in `tests/support/`; acceptance helpers resolve the repo
  root from their own depth (`tests/support/acceptance/*.js`).
