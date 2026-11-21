# Real Cursor Grok Bot smoke: operator record (NOT-493)

> **Historical record (NOT-493, botmancers@0.1.0 era; labelled in NOT-650).**
> Kept as a linked reference only. Do not fill this file in or commit new
> runs: new operator smoke records go to a GitHub Release attachment or a CI
> artifact (see [docs/PUBLISHING.md](../../../PUBLISHING.md)). The current
> package pin is in [`../README.md`](../README.md); the 0.1.0 steps below are
> as written at the time.

Status: **pending operator run**. The real Cursor Grok Bot smoke needs a
human operator with a Cursor Grok Bot workspace and an authenticated HTTPS or
private-network route to the bridge. The automated builder sandbox has neither,
so it cannot perform this run. NOT-493's three `[operator]` acceptance criteria
and its exit predicate stay open until this record is filled in and committed.
Fill this in by following the steps in
[`../README.md`](../README.md#real-grok-bot-smoke-operator). Redact every token,
digest, and public hostname you do not want published. Replace them with
`<redacted>`. Never paste an `Authorization` value.

## Preflight blocker (recorded 2026-10-15)

The smoke must run against the exact published package, but that package is
not on the registry yet:

```
$ npm view botmancers versions --json
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/botmancers - Not found
```

Before running the steps below, the operator must:

1. Publish `botmancers@0.1.0` through the NOT-492 release flow. Then confirm that
   `npm view botmancers@0.1.0 version` prints `0.1.0`, and that
   `npm run test:grok-handoff -- --registry 0.1.0` passes.
2. Open an authenticated HTTPS or approved private-network route to
   `127.0.0.1:43124/mcp`. This publishes an endpoint outside the machine, so it
   needs an operator's approval. An automated session must not open it on its own.
3. Connect the bridge in Cursor's Grok Bot plugin settings. This needs an
   interactive Cursor account session.

No real Grok Bot evidence below has been filled in. Every `<...>` placeholder
is still unfilled.

## Environment

- Botmancers commit: `<git rev-parse HEAD>`
- Bridge: `npx --yes botmancers@0.1.0`. `botmancers --version` printed: `<...>`
- Route: `<cloudflared | caddy | other>` to `127.0.0.1:43124`, with Host rewritten. Public host: `<redacted>`
- Service id: `grok-bot`. Allowlisted coordinators: `<names>`
- Route check: `POST /mcp` without a token returned `<401>`, and `GET /` returned `<404>`

## 1. Grok Bot plugin configuration and tool list

```
<plugin settings with the token shown as <redacted>>
```

Tools listed by Grok Bot (must be exactly these four):

- [ ] `botmancers_start_task`
- [ ] `botmancers_get_request`
- [ ] `botmancers_get_conversation`
- [ ] `botmancers_health`

## 2. First run

- Grok invocation / chat id: `<...>`
- `idempotency_key`: `grok-smoke-<date>-1`
- `request_id`: `<...>`
- `conversation_id`: `<...>`
- Statuses Grok polled: `<pending -> running -> succeeded>`
- Final reply (from `botmancers_get_conversation`):

```
<coordinator reply>
```

Correlation (`node scripts/mcp-handoff-correlate.js --request-id <request_id> --key grok-smoke-<date>-1`):

```json
<paste /tmp/grok-smoke-1.json>
```

- [ ] `verdict.no_external_elevation` is `true`, and every other `verdict` field is `true`, including `direct_requester_is_expected_service`, `direct_request_is_lineage_root`, `lineage_root_principal_is_expected_service`, and `intake_is_expected_service`
- [ ] only the direct request (`origin: "external"`) names `service:grok-bot`, and every other request in `lineage` has `origin` `wake` or `engine_continuation`

## 3. Repeat with the same invocation id

- `replayed`: `<true>`. The ids match the first run: `<yes/no>`
- Correlation after the repeat:

```json
<paste /tmp/grok-smoke-2.json>
```

- [ ] `counts` is identical to the first run (`intakes_for_key: 1`)
- [ ] the coordinator did not run again (no new `engine_events` for the request)
