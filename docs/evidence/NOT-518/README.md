# NOT-518 evidence

Runbook: [`docs/slack-transport.md`](../../slack-transport.md#operator-smoke-real-workspace).

| Criterion | Evidence | Status |
|---|---|---|
| Transport adapter, lifecycle (persist → ack → dispatch, disconnect/close reconnect, redelivery dedup, stop), managed-start matrix, secrets, dependencies | `npm run test:slack-transport` (real `SocketModeClient`/`WebClient` on a loopback fake Slack, injected fake clients, the real relay and SessionShare) | green locally; CI step "Slack Socket Mode transport, managed start, and secret redaction (NOT-518)" |
| Real-workspace share-thread smoke | `slack-relay-smoke.txt` (redacted transcript of `npm run smoke:slack-relay`, starting with the exact HEAD SHA) | **pending: operator** (needs a Slack app, its two tokens, and a person to reply in the thread) |

The smoke script was rehearsed end to end against the local fake Slack
(`--slack-api-url`): RESULT PASS, one provider turn across a withheld ack, a
forced reconnect, and a redelivery. A rehearsal transcript says `REHEARSAL`
and does not satisfy the workspace criterion.
