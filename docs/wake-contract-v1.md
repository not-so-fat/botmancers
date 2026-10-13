# Botmancers Wake contract v1

Status: **accepted product contract and PoC result**

Effective: October 13, 2026

Authority: [Botmancers core engine](core-engine.md)

## Decision

The primary product flow is a daily conversation with a coordinator Agent such as
Tank. The person explains the outcome to Tank. Tank wakes developer and reviewer
Agents, receives every result back in the same conversation, and decides whether
to continue, revise, change specialists, or finish.

Botmancers owns reliable delivery, durable state, authority enforcement, session
continuity, and result return. Tank owns orchestration and satisfaction. The engine
does not automatically advance a fixed implementation/review/revision workflow.

## Agent identity and target resolution

Agent names are unique within one Botmancers instance after trimming and
case-insensitive normalization. Display casing is preserved. A Wake uses the Agent
name because that is what Agents and people understand; Botmancers resolves it to
one stable Agent ID before accepting work and stores both the ID and display-name
snapshot.

An ambiguous target is a data-integrity error, not a reason to choose the first
match. Existing duplicate names must be migrated before structured Wake routing is
enabled.

## Transport

An Agent emits a fenced block in its normal response:

````text
```botmancers-wake
{
  "version": 1,
  "target": "Dev",
  "executionKind": "implementation",
  "objective": "Implement the accepted notification requirements."
}
```
````

Text outside the block remains an ordinary Agent message. The raw block is not
rendered as conversational prose; a valid block becomes a typed, visible Wake
event. Multiple blocks are processed in source order.

An invalid block launches nothing. Botmancers records a validation failure and
continues the source Agent with a concise correction so it can retry safely.

## Envelope

The machine-readable schema is
[`contracts/wake-v1.schema.json`](contracts/wake-v1.schema.json). Fixtures live in
[`contracts/wake-v1.fixtures.json`](contracts/wake-v1.fixtures.json).

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Integer `1` |
| `target` | yes | Unique Agent display name, resolved case-insensitively |
| `executionKind` | yes | `conversation`, `implementation`, `review`, or `revision` |
| `objective` | yes | Concrete outcome for the target Agent |
| `contextWorkRequests` | no | Canonical Work Request references whose results provide context |
| `resumeWorkRequest` | revision only | Canonical implementation Work Request whose Session Binding must resume |
| `limits` | no | Narrower attempt/deadline hints; never broader than engine policy |

The envelope cannot contain a tool profile, Agent Deck, working directory,
runtime, external run/session ID, caller identity, target Agent ID, grant, budget,
or idempotency key.

Botmancers derives and validates:

- source conversation and event;
- requesting and resolved target Agent IDs;
- parent/root lineage and wake depth;
- idempotency key from source event, block position, and normalized payload;
- grant and policy snapshot;
- tool profile from execution kind;
- opaque Session Binding for a validated revision reference.

References must belong to the same accessible conversation lineage. A revision
must target the same developer as the referenced implementation unless an explicit
future handoff contract says otherwise.

## Authority

| Execution kind | Authority | Behavior |
| --- | --- | --- |
| `conversation` | read-only | Discuss, research, explain, or ask a specialist |
| `implementation` | edit | Start explicitly requested workspace work |
| `review` | read-only | Inspect implementation evidence and report findings |
| `revision` | edit | Resume the referenced implementation session |

The first turn in any direct conversation is read-only. When a person asks a coding
Agent directly to implement, the Agent emits an `implementation` Wake to itself.
The additional visible turn is an accepted safety and latency tradeoff: failures
do not mutate the workspace, and explanations do not gain edit authority merely
because of phrasing or Agent type.

## Coordinator loop

The canonical loop is:

1. Person asks Tank for an outcome.
2. Tank emits an `implementation` Wake to Dev.
3. Dev's result returns to Tank with its Work Request reference.
4. Tank chooses a distinct reviewer and emits a `review` Wake with the
   implementation reference in `contextWorkRequests`.
5. Reviewer findings return to Tank.
6. Tank decides whether it is satisfied. If not, Tank emits a `revision` Wake to
   Dev with the implementation reference in `resumeWorkRequest` and review work in
   `contextWorkRequests`.
7. The loop may continue until Tank is satisfied or a safety limit stops it.

If the person names a reviewer, Tank uses it. Otherwise Tank may choose a distinct
launchable Agent; if no suitable choice is clear, Tank asks the person. Reviewer
output advises Tank but does not itself trigger a revision.

## Legacy compatibility

Legacy `WAKE <name>: <message>` may be translated only to a v1 `conversation` Wake.
It cannot request implementation, review, revision, resume, or edit authority.
Agents must use the structured envelope for those execution kinds. This keeps
legacy conversations readable without allowing free-form syntax to bypass the
authority boundary.

## Rejected alternatives

- **Engine-owned automatic implementation/review/revision:** rejected because Tank
  owns requirements, evaluates quality, and may need multiple conversations with
  either specialist.
- **Edit-by-default coding Agents:** rejected because explanation requests would
  gain unnecessary workspace authority.
- **Natural-language classification as authority:** rejected because ambiguous
  text must not be the security boundary.
- **Workflow form or per-message mode picker:** rejected because delegation should
  remain conversational.
- **Runtime/session IDs in Agent output:** rejected because Botmancers owns opaque
  continuity and validation.
