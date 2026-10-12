# Botmancers product requirements

Status: baseline from the product discussion on October 11, 2026.

This document records the desired product behavior. It deliberately avoids
choosing databases, protocols, vendors, SDKs, or deployment architecture. Those
choices belong in [the implementation plan](implementation-plan.md).

## Goal

The end goal is a Grok-like teammate app: a person tells a bot a task in one
conversation, and bots delegate to each other, ask back, or answer in that same
conversation with no workflow UI or forms. Conversational delegation between
bots is the core engine. Botmancers exists to make that delegation trustworthy
through transparent per-bot configuration of skills, rules, and template source.

Let a person or registered agent delegate work to another configured agent,
have Botmancers launch or contact that agent, preserve the relevant session and
working context, and route the result back without manual prompt copying.

The motivating workflow is casual conversational delegation: while brainstorming
with a personal agent, the person asks it to send implementation to one
specialist and review to another specialist, then continue the original
conversation with the result. The builder -> reviewer -> resumed-builder coding
loop reaches that end goal through the same conversational path: the calling
agent runs the delegation steps in conversation rather than through a
control-plane workflow policy. Hermes is one optional runtime for a bot, not
the product itself.

This goal starts from the owner's repeated personal workflow. That is useful
problem evidence, but it is not yet evidence of a market or willingness to pay.

## Initial buyer hypothesis and evidence status

The initial, explicitly unvalidated buyer hypothesis is an independent software
developer or small development team that already pays for or regularly uses two
or more coding-agent runtimes. They currently coordinate implementation and
review by copying prompts, watching several sessions, and manually returning
feedback. The hypothesized outcome is less operator waiting and more tasks that
reach final review without intervention.

The adoption trigger is a working developer-reviewer loop that can be invoked
from the agent conversation the developer already uses. The share-test is
stronger than a positive reaction: after trying the loop, would the developer
install it in another repository, invite a teammate, or actively recommend it
to another multi-agent user?

Current evidence is deliberately separated:

| Evidence | Current status | What it establishes |
| --- | --- | --- |
| Owner's repeated manual workflow | Observed internal evidence | The problem is real for the owner and provides a concrete design case. |
| Existing runtimes and interoperability projects | Observed ecosystem evidence | The integrations are technically plausible; this does not establish demand. |
| [Todos product and public documentation](https://todos.dev/docs) | Observed adjacent-product evidence | A task-centric workspace can run many existing coding-agent runtimes across machines, persist context, and coordinate review. It is also a strong substitute; it does not establish separate demand for Botmancers. |
| Independent target-buyer usage or buyer-authored language | Not collected | Commercial urgency, adoption, and willingness to champion remain hypotheses. |

Before committing to broad infrastructure, collect at least three independent
target-buyer inputs and record their words, current workaround, frequency, and
share-test result. The external commit signal is three independent target users
completing the end-to-end loop more than once, with at least two asking to keep,
extend, or share it. Failure to obtain repeat usage or a champion after a small
set of qualified trials is a signal to narrow or abandon the product framing,
not a reason to harden more infrastructure.

Registry, launch, and protocol-adapter code is readily copyable. Botmancers
makes no current moat claim. A possible buyer-linked asset is a compounding set
of verified configuration recipes and execution evidence showing which bot
configurations reliably complete real workflows; whether that compounds into
defensibility must be demonstrated rather than assumed.

## Product definitions

### Bot

A bot is a launchable worker configuration. Its identity includes the agent
runtime, configuration source, execution target, and the policies needed to run
it.

Concrete examples include:

- Claude configured with one Agent Deck deck;
- Codex configured with one Agent Deck deck;
- one provider-managed Grok Bot agent;
- one Hermes persistent agent configuration.

A bot is stable across work sessions. A session is an execution/conversation
owned by that bot.

### Session

A session is a particular conversation and its provider or runtime state. A bot
may have multiple sessions. Botmancers must be able to address a particular past
session instead of relying only on "most recent" behavior.

### Task

A task is one delegated unit of work. It connects the requesting person or bot,
the assigned bot, the relevant conversation, session, working context, and
result.

A task records requested intent, not a particular process invocation. A task may
have several execution attempts because of retry, recovery, or resuming the
same assigned bot. Reviewer work or work assigned to another bot is a distinct
child task with its own intent and assignee. Each attempt uses one immutable
resolved launch snapshot and may create or reuse an explicit session binding.
Messages and runtime callbacks are observations; artifacts are separately
addressable outputs.

## Authority and state separation

Botmancers is authoritative for orchestration state. Runtimes, runners, and
conversation transports report observations and results; they do not directly
decide the task lifecycle.

| Record | Authority | Required rule |
| --- | --- | --- |
| Bot-definition version | Bot owner or delegated administrator | A mutable source may inform a future version but cannot rewrite prior launches. |
| Resolved launch snapshot | Botmancers control plane | Immutable for an attempt; includes source revision, effective settings, target, permissions, and digest. |
| Task intent and lineage | Botmancers control plane | Created from an authenticated request; child tasks retain their parent and origin. |
| Execution attempt | Botmancers control plane | Only the control plane applies legal lifecycle transitions from authenticated observations. |
| Session binding | Botmancers control plane | Maps a Botmancers session to an opaque runtime identifier and declared continuity capability. |
| Artifact manifest | Botmancers control plane | Records producer, content reference or digest, attempt, and provenance without treating the artifact as a lifecycle transition. |

The following concepts must remain distinct:

- task: the requested outcome and its lineage;
- attempt: one bounded execution of that task;
- session binding: continuity with a runtime conversation;
- event or message: an observation or communication item;
- artifact: an output that can be inspected or passed to another task.

A task may own many attempts, an attempt may emit many events and artifacts, and
a session binding may be reused by later attempts when the target runtime
supports it.

Every attempt of a task must preserve the task's requested outcome and assigned
bot. A retry may use a newer compatible bot-definition version only when policy
records why the change does not alter the requested authority, workspace, or
assignee. Otherwise Botmancers creates a replacement or child task rather than
silently changing the target.

## Functional requirements

### R1 — Register launchable bots

Users must be able to register a bot backed by a configuration they already
control. The configuration may live in Agent Deck, Grok Bot, Hermes, a coding
agent, or another supported source.

Registration must preserve the source reference rather than silently turning it
into an unrelated copy.

### R2 — Inspect effective configuration

Users must be able to see what will actually launch: runtime, configuration
source, inherited settings, local overrides, execution target, permissions, and
provenance.

The UI must distinguish configured, available, unavailable, and unsupported
capabilities.

Every launch must persist an immutable resolved launch snapshot. The
configuration source remains authoritative for future resolution; the snapshot
is authoritative for what a particular attempt actually launched.

### R3 — Launch work

Botmancers must actually launch or activate a registered bot. Merely producing
an invite link, prompt, or command for the user to run does not satisfy this
requirement.

For a persistent service, "launch" may mean verifying that it is reachable and
delivering work. For an idle process or managed agent, it means starting or
waking the runtime.

### R4 — Support local and cloud execution (Post-evidence-gate for cloud targets)

Cloud execution is a primary use case. A bot may run:

- on the user's local machine;
- on a user-controlled cloud machine that launches a local coding-agent process;
- through a provider-managed cloud-agent API;
- as an already-persistent agent service.

The product must not assume that the Botmancers web server and the agent runtime
share a machine.

Post-evidence-gate: the cloud execution targets above; the evidence slice
proves one real execution path first.

### R5 — Preserve and resume sessions

Botmancers must store provider or runtime session identifiers when available and
use them to continue a selected prior session.

When exact provider resumption is unavailable, Botmancers should create a
portable continuation from durable task context, workspace state, artifacts,
and relevant conversation history. The product must show which continuity mode
is being used.

### R6 — Allow agent-initiated delegation

Any registered agent may request work from another registered agent without a
human approval step for every handoff.

The receiving bot still runs with its own credentials, tools, permissions, and
limits. A delegation request does not inherit the sender's authority.

Every request must carry an authenticated caller identity. A target bot accepts
work only through an explicit grant covering allowed callers, workspace scope,
execution target, permissions, budget, concurrency, and delegation depth.
Runners must authenticate to the control plane. Removing per-handoff human
approval never grants a sender access to the target's credentials or expands
the target's configured authority.

### R7 — Route outcomes back

Botmancers must associate results, artifacts, failures, and review feedback with
the originating task and conversation. A caller must be able to determine
whether delegated work is queued, running, blocked, failed, or complete.
Returning only opaque artifact IDs is insufficient: authorized callers must be
able to inspect the result summary, review feedback, and content reference or
digest for every returned artifact.

### R8 — Permit idle workers (Post-evidence-gate for idle wake-up)

Non-persistent agents do not need to run continuously. Durable messages, tasks,
session references, and working context must survive while the runtime is off.
Wake latency should be low enough for conversational delegation.

Post-evidence-gate: idle wake-up without continuous polling; the evidence slice
does not require waking an idle worker on demand.

### R9 — Reuse communication infrastructure

Botmancers may use an existing communication mechanism when it satisfies the
product flow. Building a new chat protocol or owning the room experience is not
a product requirement.

## Safety and operational requirements

Agent-initiated work must have safeguards against accidental unbounded
execution, including idempotency, loop detection, bounded delegation depth,
concurrency controls, cancellation, and configurable time or spend limits.

These safeguards do not change R6: normal handoffs should not require repeated
human approval.

Tasks and attempts must follow explicit lifecycles. Only the control plane
applies these transitions; authenticated callers, runtimes, runners, and policy
workers request or provide evidence for them.

| Task state | Allowed next state | Transition owner or condition |
| --- | --- | --- |
| `pending` | `active`, `failed`, `cancelled` | Control plane accepts work, rejects it, or honors authorized cancellation. |
| `active` | `blocked`, `completed`, `failed`, `cancelled` | Policy evaluates attempt evidence or an authorized cancellation. |
| `blocked` | `active`, `failed`, `cancelled` | Named unblock owner resolves the condition, or policy terminalizes the task. |
| `completed`, `failed`, `cancelled` | none | Terminal and immutable. |

| Attempt state | Allowed next state | Transition owner or condition |
| --- | --- | --- |
| `created` | `dispatching`, `cancelled` | Dispatcher claims it, or authorized cancellation wins first. |
| `dispatching` | `running`, `recovery_required`, `failed`, `timed_out`, `cancelled` | Authenticated launch evidence, lease loss, mapped failure, deadline, or confirmed cancellation. |
| `running` | `waiting`, `recovery_required`, `succeeded`, `failed`, `timed_out`, `cancelled` | Authenticated runtime evidence interpreted by policy. |
| `waiting` | `running`, `recovery_required`, `succeeded`, `failed`, `timed_out`, `cancelled` | Required input arrives, lease is lost, or policy terminalizes the attempt. |
| `recovery_required` | `dispatching`, `running`, `failed`, `timed_out`, `cancelled` | Named recovery owner proves safe reconnection/re-dispatch or terminalizes the attempt. |
| `succeeded`, `failed`, `timed_out`, `cancelled` | none | Terminal and immutable. |

`blocked`, `waiting`, and `recovery_required` are non-terminal and must name the
party or condition that can make progress. Retrying is not a transition of a
terminal attempt: a retry command terminalizes or references the prior attempt,
then creates a new attempt with `retry_of` and the same task and assigned bot.

In-scope for the evidence slice: idempotent task creation, bounded delegation
depth, budget limits, and working single-task cancel.

Idempotency is scoped at least to task creation and attempt dispatch so
repeating either request cannot silently create duplicate work.

Post-evidence-gate: each non-terminal attempt must have a lease or heartbeat
policy and an accountable recovery action. The operational contract must cover
duplicate delivery, an offline runner, a lost callback, retry after timeout,
cancellation, partial artifacts, and manual recovery.

Post-evidence-gate: cancelling a root task must not orphan live descendant
work. The cancellation policy must either terminalize its descendants or retain
explicit ownership of them, and a late child result must not revive or complete
a cancelling parent. Working single-task cancel remains in-scope; only the
descendant-cascade behavior is post-gate.

## Acceptance scenarios

### A — Builder and reviewer

1. In an existing personal-agent conversation, a person asks for a prototype to
   be delegated and reviewed.
2. The personal agent creates one idempotent Botmancers task. The original
   conversation receives its task ID plus useful queued, running, blocked, and
   failure updates without opening a separate orchestration UI.
3. Botmancers resolves the registered builder and persists the exact launch
   snapshot before starting an attempt.
4. Botmancers launches the builder, records a launch or run ID, and binds the
   runtime's native session reference when one is available.
5. The builder returns a commit, files, or another inspectable final artifact
   with an artifact manifest.
6. The calling personal agent delegates the builder artifact to the reviewer
   bot as a child task, passing the artifact reference. Botmancers records the
   reviewer child task with its own assignee and links it to the builder task;
   the builder task waits while review is outstanding.
7. The calling agent consumes the reviewer's terminal result. In this scenario
   the reviewer returns `revise`, so the calling agent resumes the same builder
   task with the review feedback, routing feedback to the selected builder
   session when resumable. The resumed builder produces a revised artifact or
   an explicit failure.
8. The revised result and trace return to the original conversation.

The initial builder artifact alone does not complete the parent task. The
reviewer returns a typed `approve`, `revise`, or `reject` result. `Approve`
completes the parent with the initial final artifact, `revise` requires a
successful resumed-builder attempt and final artifact, and `reject` fails the
parent. A failed or blocked child leaves the parent blocked or causes the
calling agent to fail it; it never implies successful parent completion. The
calling agent owns selection of the bots, child-task creation, review-result
consumption, and any resumed-attempt creation. Botmancers records lineage and
routes results; no control-plane workflow policy creates children or consumes
reviews in this scenario.

No step requires copying a prompt or session identifier by hand.

The first real slice must retain enough evidence to inspect the resolved
configuration, every attempt ID, native session reference, artifact, review
feedback, resumed-builder output, and final return-to-origin delivery. Record
observed successes and failures before adding more runtime adapters.

### B — Resume an older session

1. A user opens a bot with multiple past sessions.
2. The user or another agent selects one past session and sends follow-up work.
3. Botmancers resumes that session when supported, or clearly uses portable
   continuation when it is not.

### C — Wake cloud execution (Post-evidence-gate)

Post-evidence-gate: this scenario requires idle wake-up and cloud execution.

1. A target agent is not currently running.
2. A task arrives from another registered agent.
3. Botmancers starts the configured local, remote, or provider-managed target.
4. Work begins and its status becomes visible without the target having polled
   continuously while idle.

### D — Preview and launch an exact configuration

1. A user registers one Agent Deck deck, or an equivalent external
   configuration, as one bot.
2. Before launch, Botmancers displays the source and revision, inherited values,
   overrides, target, permissions, capability availability, and resulting
   configuration digest.
3. A task launches the bot and records an immutable resolved snapshot.
4. The user can verify that the attempt used the displayed digest and can see
   any degraded or unsupported capability.

### E — Recover a stalled attempt (Post-evidence-gate)

Post-evidence-gate: this scenario requires the lease/heartbeat and recovery
contract.

1. An attempt is dispatched and then loses its runner heartbeat or callback.
2. Botmancers moves the attempt to `recovery_required`, records the recovery
   owner and reason, and does not complete the task or duplicate work.
3. Policy either proves safe reconnection and resumes the attempt, or
   terminalizes it before creating an explicitly linked retry attempt.
4. Any partial artifact remains visible with its provenance, and the final task
   state records which recovery path occurred.

## Explicit non-requirements

- An OpenAI-compatible model endpoint is not required.
- Any particular model API or coding-agent vendor is not required.
- Huddo is not required; it is one candidate communication mechanism.
- Todos is not required; it is a reference implementation and competing
  substitute to test before building overlapping workspace features.
- A permanently running LLM process is not required.
- Exact in-memory process restoration is not required.
- Botmancers does not need to implement a new model, coding harness, or chat
  protocol.

## Open product questions

- How should an agent select among several past sessions of the same target bot?
- What wake latency is acceptable for conversational use?
- Which limits are global, per bot, per task lineage, and user-overridable?
- How long should sessions, artifacts, and portable continuation data be retained?
- Which configuration differences require creating a new bot rather than a new
  session of an existing bot?
- Which named design partners will supply the first three independent inputs?
  No external buyer words or target roster has been collected yet.
- For the north-star workflow, what remains materially unsolved after trying
  Todos through its MCP surface with the owner's actual runtime configurations?
