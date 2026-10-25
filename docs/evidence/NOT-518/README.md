# NOT-518 evidence

Runbook: [`docs/slack-transport.md`](../../slack-transport.md#operator-smoke-real-workspace).

| Criterion | Evidence | Status |
|---|---|---|
| Transport adapter, lifecycle (persist → ack → dispatch, disconnect/close reconnect, redelivery dedup, stop), managed-start matrix, secrets, dependencies | `npm run test:slack-transport` (real `SocketModeClient`/`WebClient` on a loopback fake Slack, injected fake clients, the real relay and SessionShare) | green locally; CI step "Slack Socket Mode transport, managed start, and secret redaction (NOT-518)" |
| Real-workspace share-thread smoke | `slack-relay-smoke.txt` (redacted transcript of `npm run smoke:slack-relay`, starting with the tested implementation HEAD SHA) | **PASS** at `2ede68067ea3a91819d4d0513d35d0bd41d59973` |

The smoke script was rehearsed end to end against the local fake Slack
(`--slack-api-url`): RESULT PASS, one provider turn across a withheld ack, a
forced reconnect, and a redelivery. A rehearsal transcript says `REHEARSAL`
and does not satisfy the workspace criterion.

The recorded real-workspace run also finished `RESULT PASS`: Slack redelivered
the intentionally unacknowledged event after reconnect, the relay classified
it as `duplicate_event`, and the share retained exactly one provider turn and
one reply. The evidence-only commit that adds this transcript does not change
the tested runtime.
