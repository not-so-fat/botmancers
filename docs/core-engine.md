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

### Wake

A Wake is an Agent-directed request originating from a conversation event. It says
who should act and what outcome is wanted. It is not a workflow definition. Every
wake, whatever produced it, is normalized into one versioned structured envelope
before it can create work; see [Wake envelope v1](#wake-envelope-v1).

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

## Delegation and review policy

A normal message produces one Agent turn. Automatic implementation, review, and
resume are not the default behavior of every coding-Agent message.

When the requested outcome explicitly includes implementation and review, the
orchestrator may create child Work Requests:

1. an implementation request for the selected builder;
2. a read-only review request for a configured reviewer;
3. an edit-authorized revision attempt that resumes the original builder session.

Each child is visible in the parent conversation. A reviewer is a real target
Agent selection, not the builder silently reviewing its own output. If no reviewer
is named, Botmancers completes implementation without claiming that independent
review happened.

## Wake envelope v1

Status: **proposed by NOT-464, pending product owner approval of the
direct-implementation rule below.** Fixtures, a throwaway validator, and its output
live in [`docs/not-464/`](not-464/README.md). Nothing in the engine is wired to
them yet.

### Shape

A wake is accepted only as this envelope. Producers supply the first block of
fields; the engine stamps the second block from the authenticated source event.

```json
{
  "version": "botmancers.wake/v1",
  "target": { "agent": "Codex" },
  "kind": "implementation",
  "outcome": "Add input validation to lib/commands.ts and cover it with tests.",
  "reviewer": { "agent": "Claude", "focus": "Validation coverage" },
  "policy": { "max_revisions": 1, "timeout_seconds": 1800 }
}
```

| Field | Set by | Rule |
| --- | --- | --- |
| `version` | producer | Exactly `botmancers.wake/v1`. Anything else is rejected. |
| `target.agent` | producer | A configured Agent name (case-insensitive), normalized to the Agent ID. Unknown names are rejected. |
| `kind` | producer | `conversation` or `implementation`. `review` and `revision` exist only as engine-created children and are rejected from producers. |
| `outcome` | producer | Requested outcome text, 1–8000 characters after trimming. |
| `reviewer` | producer, optional | Only with `implementation`. A configured Agent other than the target. Optional `focus` ≤ 1000 characters. |
| `policy.max_revisions` | producer, optional | Integer 0–2, default 1. Only with a reviewer. |
| `policy.timeout_seconds` | producer, optional | Integer 60–3600, default 1800, applied per Attempt. |
| `lineage` | engine | `conversation_id`, `source_event_id`, `wake_index` (position within the source event), `parent_request_id` (the Work Request whose turn produced the event, or null), `requested_by` (`human` or the Agent ID), `origin` (`direct_message`, `command`, `structured`, or `legacy_wake`). |
| `idempotency_key` | engine | `wake:v1:<conversation_id>:<source_event_id>:<wake_index>:<target_agent_id>`. Replaying the same event never creates a second Work Request. |

Validation is strict:

- Unknown fields are rejected at every level.
- Runtime and launch fields are rejected wherever they appear: session, run,
  attempt, or thread IDs, `resume`, deck, working directory, tool profile,
  runtime, and adapter. These belong to Attempts and Session Bindings, which the
  engine resolves from the target Agent.
- Engine fields (`lineage`, `idempotency_key`, `requested_by`,
  `parent_request_id`) supplied by a producer are rejected, not overwritten.
- One source event yields at most four wakes; more rejects all of them.
- A rejected wake creates no Work Request. The rejection codes are projected into
  the conversation so the requester can see why.

### Authority

Tool authority is derived only from `kind`; the envelope cannot name it.

| Kind | Work Requests created | Attempt authority in order |
| --- | --- | --- |
| `conversation` | one turn for the target | `readonly` |
| `implementation` | one implementation request for the target | `edit` |
| `implementation` + `reviewer` | implementation request; a child review request for the reviewer after each implementation Attempt completes; a revision Attempt on the implementation request, resuming its Session Binding, when a review has findings, up to `max_revisions` | `edit` → `readonly` → `edit` |

Who may ask for `implementation`:

- `edit` requires a target whose Agent type can edit (`Cursor`, `Claude`, `Codex`,
  `Muse Code`). A Hermes target is rejected.
- An Agent may never wake itself, in any kind. A read-only turn cannot grant itself
  edit authority.
- An Agent requesting `implementation` of another Agent needs an explicit
  `implementation` wake grant in its own configuration. Agents get no such grant by
  default; an orchestrator such as Hermes is granted it by the owner.
- A person requests `implementation` only with the `/implement` command below. A
  person's plain message is always `conversation`, whatever its wording.

### Producers

| Source | How it is read | Resulting kinds |
| --- | --- | --- |
| Plain human message in a direct conversation | Target is the conversation's Agent; the whole message is the outcome. | `conversation` only |
| Human message starting with `/implement` | `/implement [review:<Agent>] <outcome>` with the conversation's Agent as target. Only a leading command counts. | `implementation` |
| Agent reply | Each fenced ` ```botmancers-wake ` block holds one JSON producer envelope. | `conversation` or `implementation`, subject to the rules above |
| Agent reply with legacy `WAKE <Agent>: <text>` and no structured block | Compatibility adapter, see below. | `conversation` only |

Human messages are never parsed for `WAKE` text or for structured blocks; pasting
an envelope into a chat message is plain text. `/api/v0` messages follow the same
human-message rules in v1.

### Direct implementation rule

**Proposed decision (needs product owner approval):** a person asking a coding
Agent directly to implement a change types `/implement <outcome>`, optionally
`/implement review:<Agent> <outcome>`. Without the command, the request is a
read-only conversation turn; the Agent may answer with a plan and point at
`/implement`. This is a typed command, not a form or mode picker.

Rejected alternatives:

- **Structured self-wake.** The coding Agent decides, during its read-only turn, to
  wake itself with `implementation`. This makes model judgement of free text the
  authority boundary, which this contract forbids, and lets a read-only turn grant
  itself edit authority. Self-wakes are rejected outright.
- **Natural-language classification** (keyword or LLM) of "implement", "fix",
  "change". Not deterministic, not auditable, and a non-goal.
- **Edit by default for coding Agents.** Contradicts "edit authority is never granted
  merely because the target is a coding Agent" and is the current transitional bug.
- **Propose-then-confirm** (read-only turn proposes, the person approves with a
  button or "go"). Adds an approval surface per message and either a free-text
  confirmation to classify or a form-like card; reconsider later as sugar that emits
  the same `/implement` envelope.
- **Per-conversation or per-message mode picker.** Explicit non-goal.

### Legacy `WAKE` compatibility

Legacy free-form `WAKE <Agent>: <text>` in an Agent reply stays readable during
migration under these rules, and is retired when the engine's built-in Agent
prompts emit structured blocks:

- It always becomes a `conversation` wake with `origin: legacy_wake` and
  `readonly` authority. Its text is the outcome; no keyword, JSON, or field inside
  it changes the kind, adds a reviewer, or supplies runtime IDs.
- It passes the same envelope validation, including the self-wake ban and the
  four-wake limit.
- If a reply contains any structured block, legacy `WAKE` lines in it are ignored
  and a warning is recorded.
- `WAKE GROUP:` is not a Work Request wake; it keeps today's group-message behavior
  until groups are revisited, and grants no authority.
- The adapter is never extended. Removal is a follow-up ticket once no built-in
  prompt instructs Agents to write `WAKE`.

## Concrete flows

### Flow A: talk and answer

1. A developer asks Codex to explain a module.
2. Botmancers appends the message and creates one read-only Work Request.
3. The adapter runs one attempt.
4. The answer and terminal state appear in the same conversation.

No review loop or edit authority is added. The same holds when the message says
"please implement X" without `/implement`: it is still one read-only turn.

### Flow B: implement and review

1. A developer asks Hermes to have Codex implement a change and have Claude review
   it. That message is a read-only conversation turn for Hermes.
2. Hermes's reply carries a structured wake: target Codex, kind `implementation`,
   reviewer Claude. Hermes holds an `implementation` wake grant. Botmancers persists
   the wake and an edit-authorized implementation request whose parent is
   Hermes's turn.
3. On completion, Botmancers creates a read-only child review request addressed to
   Claude.
4. Findings create a revision attempt that resumes Codex's original session with
   edit authority.
5. The final outcome, provenance, and artifacts return to the original
   conversation.

The developer never moves text or session IDs between tools.

### Flow C: wake an unavailable Agent

1. An Agent wakes another configured Agent that is not currently launchable.
2. Botmancers persists the wake and Work Request before trying to launch.
3. The request remains queued or becomes blocked with a visible reason.
4. Recovery resumes from durable state; it does not depend on an in-memory chain.

### Flow D: ask a coding Agent directly to implement

1. A developer types `/implement review:Claude Add input validation` in their
   conversation with Codex.
2. Botmancers creates an edit-authorized implementation request for Codex.
3. The review and revision proceed as in Flow B, steps 3–5, in the same
   conversation.

Without `review:`, only the implementation request is created and no review is
claimed.

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
- Agent replies are routed by free-form `WAKE <target>:` text rather than the Wake
  envelope, with no wake grants and no self-wake ban;
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
primitives rather than defining a separate engine.

## Non-goals for the core slice

- a workflow builder, graph editor, or per-message mode picker;
- cloud runners or a general provider abstraction;
- separate Chat and Code identities on one Agent;
- automatic three-stage review for every coding-Agent message;
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
