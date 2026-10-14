# Botmancers core engine: conversations and wakes

Status: **authoritative product and architecture contract**

Effective: October 13, 2026

Owner: Botmancers

This document supersedes the earlier dual-runtime and single-runtime design
experiments. When code, tickets, or older documents disagree with this document,
this document is the intended product and the disagreement is migration work.

## Product promise

Botmancers lets a developer stay in one durable conversation while configured
agents can wake one another, perform bounded work, and return results to that same
conversation without the developer copying prompts, outputs, or session IDs.

The conversation and its wake history are the product. Runtimes, Agent Deck,
queues, and review loops are implementation machinery that serve that experience.

## Product model

### Agent

An Agent is the persistent identity the person talks to or wakes. It has a name,
instructions, capabilities, an Agent type (`Hermes`, `Cursor`, `Claude`, `Codex`,
or `Muse Code`), a selected Agent Deck, and an optional working directory.

Agent names are unique within one Botmancers instance under case-insensitive,
trimmed comparison. The display name is preserved, while Botmancers resolves every
wake to exactly one stable Agent ID. Renaming an Agent does not rewrite historical
wake targets.

Agent Deck is launch configuration. It is not an Agent and it is not presented as
a runtime. An Agent without a usable launch configuration remains readable, but a
wake that requires execution must fail closed with a clear explanation.

### Conversation

A Conversation is the durable primary object. It owns an ordered event history:

- human and Agent messages;
- wakes and their targets;
- work status and questions;
- results and artifact references;
- failures, cancellations, and recovery events.

The UI and API are two views over the same conversation model. They must not create
different execution semantics.

### Coordinator Agent

A Conversation may have a coordinator Agent such as Tank. The coordinator holds
the ongoing product context, talks with the person, chooses which specialist to
wake, evaluates returned work, and decides whether the outcome is satisfactory.

Botmancers delivers specialist results back to the coordinator and schedules a
read-only continuation turn. Botmancers does not decide that implementation must
automatically lead to review or that review findings must automatically lead to a
revision. Those are coordinator decisions expressed as new Wakes.

### Wake

A Wake is an Agent-directed request originating from a conversation event. It says
who should act and what outcome is wanted. It is not a workflow definition.

Agents emit the versioned, validated envelope defined in
[Wake contract v1](wake-contract-v1.md). One envelope addresses one target Agent.
The engine derives caller identity, stable target ID, lineage, idempotency, grants,
tool authority, and session binding; Agents cannot put runtime/session IDs or a
broader tool profile into the envelope.

Accepting a wake creates exactly one durable Work Request with an idempotency key.
If the target is unavailable, the request remains queued or becomes explicitly
blocked; it is never silently lost.

### Work Request

A Work Request is the durable unit of requested work. It records:

- source conversation and source event;
- requesting identity and target Agent;
- intent and execution kind;
- parent request and wake lineage;
- policy snapshot, including tool authority;
- lifecycle state and terminal result.

The minimum lifecycle is `queued`, `running`, `waiting`, `completed`, `failed`, and
`cancelled`. State transitions are persisted before they are projected into the
conversation.

### Attempt

An Attempt is one launch or resume of a Work Request. It records the immutable
launch snapshot, adapter, external run/session identifiers, timestamps, outcome,
and artifact references. Retries and revisions create new Attempts; they do not
erase earlier evidence.

### Session binding

A Session Binding is opaque runtime continuity for an Agent doing work in a
Conversation or Work Request. Botmancers stores it so a later revision can resume
the correct session, but users do not have to manage it.

## One engine

All entry points use one control path:

```text
UI or API message
    -> append conversation event
    -> resolve wake
    -> create durable work request
    -> dispatch attempt
    -> runtime adapter
    -> persist attempt events
    -> project result into the same conversation
    -> continue the coordinator Agent
```

There is one Work Request store, one state machine, and one dispatcher. Separate
queues or lifecycle models for the web UI and `/api/v0` are transitional and must
converge rather than remain parallel engines.

Runtime adapters translate the shared attempt contract:

- The Hermes adapter talks to the persistent Hermes gateway.
- The Agent Deck adapter launches supported coding Agents through
  `agent-deck run` and resumes their external session when requested.

Adapters do not decide product workflow. They receive a target, prompt, working
directory, deck, tool profile, and optional session binding; they return events,
session data, results, and errors.

## Tool authority

Tool authority is explicit policy on every Work Request and Attempt. An adapter
must not infer it from the Agent type or silently replace it with a default.

The initial profiles are:

| Execution kind | Tool profile | Purpose |
| --- | --- | --- |
| Conversation or explanation | `readonly` | Inspect and answer without changing the workspace |
| Implementation | `edit` | Make the explicitly requested change |
| Review | `readonly` | Inspect the implementation and report findings |
| Revision after review | `edit` | Resume the implementation session and address findings |

Unsupported authority fails closed. Edit authority is never granted merely because
the target is a coding Agent.

## Reviewed Git finalization

A sandboxed coding Agent owns working-tree edits but does not receive broader host
or `.git` authority merely to create a commit. Botmancers owns the workflow decision:
it records the Agent Deck baseline reference, persists Agent Deck's terminal
candidate path-and-digest manifest, obtains explicit reviewer and coordinator
acceptance, and submits that same immutable manifest. Agent Deck owns the host-local
mechanism that discovers the candidate manifest, validates the approved copy, and
creates one audited commit.

Finalization is run-scoped, separately authorized, idempotent, and fail-closed on a
base/ref race, changed pre-existing dirty path, unexpected path, digest mismatch, or
Git lock conflict. It preserves unrelated user changes. Push and PR creation remain
separate authorized steps. The detailed contract and PoC evidence are in
[the October 13 Git-finalization decision](design/2026-10-13-git-finalization-contract.md).

## Delegation and review policy

A normal message produces one Agent turn. Automatic implementation, review, and
resume are not the default behavior of every coding-Agent message.

When a person asks a coordinator such as Tank to implement something, Tank emits an
implementation Wake to a selected developer. Botmancers returns the result to the
same conversation and continues Tank. Tank then decides whether to ask questions,
wake a reviewer, request a revision, try another specialist, or report completion.

A review is a separate read-only Wake to a real reviewer Agent. When the person
names the reviewer, Tank uses that Agent. Otherwise Tank may choose a distinct,
launchable reviewer; if no choice is clearly suitable, Tank asks the person. The
engine never silently treats the developer as an independent reviewer.

A revision is a new edit-authorized Wake that references the canonical Work
Request to resume. Botmancers resolves that reference to the original developer's
opaque Session Binding. The coordinator may repeat developer and reviewer Wakes
until satisfied, subject to depth, attempt, concurrency, and budget limits.

If a person talks directly to a coding Agent and asks it to implement, its initial
turn remains read-only and may emit a visible implementation Wake to itself. This
adds a turn but prevents ordinary explanation requests from receiving edit
authority through text classification or Agent type alone.

## Concrete flows

### Flow A: talk and answer

1. A developer asks Codex to explain a module.
2. Botmancers appends the message and creates one read-only Work Request.
3. The adapter runs one attempt.
4. The answer and terminal state appear in the same conversation.

No review loop or edit authority is added.

### Flow B: Tank coordinates implementation and review

1. A developer asks Tank to implement a change and have Claude review it.
2. Tank emits an implementation Wake addressed to Dev; Botmancers persists the
   Wake and an edit-authorized Work Request.
3. Dev's result returns to the same conversation. Botmancers continues Tank with
   the result and its canonical Work Request reference.
4. Tank evaluates the result and emits a separate read-only review Wake addressed
   to Claude.
5. Claude's review returns to Tank. Tank may accept the work, ask either specialist
   a question, or emit an edit-authorized revision Wake to Dev referencing the
   original implementation Work Request.
6. Botmancers resumes Dev's opaque Session Binding. Results keep returning to Tank,
   which may repeat the loop until satisfied or a safety limit stops it.
7. Tank reports the final outcome, provenance, and artifacts to the developer in
   the original conversation.

The developer never moves text or session IDs between tools.

### Flow C: wake an unavailable Agent

1. An Agent wakes another configured Agent that is not currently launchable.
2. Botmancers persists the wake and Work Request before trying to launch.
3. The request remains queued or becomes blocked with a visible reason.
4. Recovery resumes from durable state; it does not depend on an in-memory chain.

## Reliability and provenance

- Create requests idempotently from the source event and target.
- Persist every state transition and attempt boundary.
- Recover `running` work after process restart by reconciling external run state or
  marking the attempt interrupted and retryable.
- Support cancellation and bounded timeouts at the Work Request level.
- Record requesting identity, target Agent, deck, working directory, tool profile,
  adapter, run/session IDs, prompts or prompt hashes, results, and artifacts.
- Enforce authenticated wake grants, concurrency, depth, and budget before launch.
- Never report success from transport acceptance alone; success requires a terminal
  attempt outcome.

## Current code and convergence

The current Agent identity plus Agent Deck model is directionally consistent with
this product. The following behaviors are transitional inconsistencies, not product
requirements:

- the web UI and `/api/v0` use different queue and lifecycle models;
- implementation and revision launches currently inherit read-only tools;
- delegation-chain continuity is held in process memory;
- the current review path reuses the same configured coding Agent;
- coding-Agent messages automatically enter an implementation/review/resume loop;
- the engine, rather than a coordinator Agent, currently owns parts of the review
  sequence;
- cancellation, timeout, recovery, grants, and complete provenance are incomplete.

Convergence should preserve existing working adapters while moving orchestration
above them:

| Current area | Intended responsibility |
| --- | --- |
| `lib/agent-conversations.ts` | Conversation events and projections only |
| `lib/agent.ts` | Compatibility facade, then removal after callers use the engine |
| `lib/agent-dispatch.ts` | Runtime adapter selection, not workflow policy |
| `lib/agent-deck-run.ts` | Agent Deck transport and session resume |
| SQLite queue tables | One Work Request, Attempt, and event model |

## Scope now

Build the smallest reliable local slice that proves:

- a durable conversation can create and display a wake;
- the wake becomes a durable Work Request;
- a supported local Agent runs with explicit tool authority;
- its result returns to the source conversation;
- restart, failure, and retry preserve understandable state.

Implementation/review/resume is an important composed flow, but it uses these same
primitives and coordinator Wakes rather than defining a separate engine-owned
workflow.

## Non-goals for the core slice

- a workflow builder, graph editor, or per-message mode picker;
- cloud runners or a general provider abstraction;
- separate Chat and Code identities on one Agent;
- automatic three-stage review for every coding-Agent message;
- an engine-owned fixed developer/reviewer loop that bypasses the coordinator;
- treating Groups as an execution primitive;
- silently falling back to an example model or another runtime;
- presenting unavailable launch paths as usable.

## Documentation policy

This file is the single current core-engine authority. Product-facing README text
should link here. Superseded design documents must carry a dated historical banner
and point here; they may remain as decision history but must not be used as current
requirements. Empirical proof documents may remain when clearly labeled as evidence
from a particular date and commit.

Delete a historical document only after confirming it contains no unique evidence
or migration context. New core behavior belongs here first, then in execution
tickets derived from this contract.

## Decision rule

Current code should become consistent with current product requirements. When they
conflict, first confirm that this document still expresses the intended user
experience, then change the code. Do not preserve an accidental implementation
constraint by rewriting the product around it.
