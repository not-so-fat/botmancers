# Agent Activity

Agent Activity is the owner's secondary operational history for one Agent. Overview remains the default Agent destination; Activity answers “what changed?” and links each item to the owning Sessions, Conversations, Slack, Exchanges, or Config surface for actions and complete detail.

## Projection contract

`lib/agent-activity.ts` is a read-only projection. It creates no event table and reads these canonical families:

- Session Binding creation/release, provider-session registry discovery, and allow-listed provider-session events for missing availability, turns, and sync failures. Periodic `session_synced` heartbeats are intentionally omitted.
- Conversation creation and allow-listed typed `conversation_events` lifecycle rows. Message content is never interpreted as lifecycle or severity.
- Session Exchange events for creation, queued/started steps, durable state changes, and structured handoff refusals.
- SessionShare events, canonical expiry timestamps, and Slack share-thread creation rows.

Items have a stable kind and source-derived id, canonical timestamp, human summary, Agent/source target, severity and attention flag, and a small allow-listed details object. Ordering is newest first with an opaque cursor bound to the Agent and filter. The `sessions`, `conversations`, `slack`, and `errors` filters select those projected fields; they do not search prose.

The owner endpoint is `GET /api/bots/:id/activity`. A missing Agent and an Agent/event mismatch disclose no cross-Agent data. The Overview preview calls this same projection with a four-item limit. Every canonical source query applies the page cursor and a per-source `ORDER BY`/`LIMIT`, so the preview poll and full timeline do not scan unbounded history.

## Deliberate exclusions

Activity does not read or return provider transcripts, arbitrary message content, exchange instructions or outcomes, credentials, opaque provider session/turn/run ids, unredacted runtime payloads, or filesystem paths. It does not infer task completion, participants, operations, or severity from prose. Provider log files are not consulted.

“Raw details” is collapsed by default and means only the bounded, allow-listed structured fields already present on an Activity item. It is not a transcript or payload viewer. The global Exchanges ledger and the Agent-scoped source pages remain authoritative for actions and full product detail.

## Verification

- `npm run test:agent-activity` covers two-Agent isolation, every event family and filter, false-positive prose, stable cursor pagination, target links, UI states, and forbidden-sentinel redaction.
- `npm run proof:agent-activity` seeds the real app and captures the Activity/Overview path at desktop and narrow viewports when the runtime can launch a browser and loopback server.
