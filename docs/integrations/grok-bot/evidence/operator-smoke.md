# Real Cursor Grok Bot smoke: operator record (NOT-493)

Status: **pending operator run**. The real Cursor Grok Bot smoke needs a
human operator with a Cursor Grok Bot workspace and an authenticated HTTPS or
private-network route to the bridge. The automated builder sandbox has neither,
so it cannot perform this run. NOT-493's three `[operator]` acceptance criteria
and its exit predicate stay open until this record is filled in and committed.
Fill this in by following the steps in
[`../README.md`](../README.md#real-grok-bot-smoke-operator). Redact every token,
digest, and public hostname you do not want published. Replace them with
`<redacted>`. Never paste an `Authorization` value.

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
