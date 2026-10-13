# Runner boundary requirements (Botmancers app side)

> **Historical inventory — October 11, 2026.** Use the authoritative
> [core-engine design](core-engine.md) for current product boundaries. This file
> remains evidence for later runner work, not a current implementation contract.

Ticket: NOT-397. Owner: Lorekeeper. Status: requirements inventory only.

This document states, from the Botmancers app's point of view, what the app would need from a work queue, a status listener, and a runner that is not a laptop. It covers wake, delegation, and the runner boundary. It is the Botmancers side of a two-ticket split; the agent-dealer side is NOT-399, which compares these numbered requirements with what agent-dealer already has.

Sources: `docs/product-requirements.md` (R4, R6, R7, R8, Safety including the task and attempt lifecycles, and acceptance scenarios A, C, E). `docs/implementation-plan.md` (Runner, Conversation transport) and `docs/runtime-contract-v0.md` were not present in this tree, so no section is quoted from them; runner and transport expectations below are drawn from the product-requirements authority and state separation instead. No protocol or vendor is chosen here.

Currently agreed plan: delegation is caller-managed and Claude runs through the Agent SDK on the owner's Mac (NOT-395, NOT-396); wake latency is measured first (NOT-391); cloud wake, leases, and recovery are post-evidence-gate (NOT-390). Timing labels below use "Now" for what the evidence slice needs on the local path and "Post-evidence-gate" for what waits for the gate. Requirement ids (Q1-Q4, S1-S3, N1-N5) are stable so NOT-399 can reference them.

Non-goals: any Botmancers or agent-dealer code, schema, queue, listener, or runner; comparing with agent-dealer's actual capabilities (that is NOT-399); scheduling dealer implementation tickets; choosing a protocol or vendor.

## 1. Queue — delegated work intake and holding

### Q1 — Accept a delegation request

The queue accepts one delegation request from an authenticated caller and records it as one task addressed to a registered target bot.

- Serves: R6 — agent-initiated delegation without per-handoff human approval, with authenticated caller identity and explicit target grant.
- Interface — Input: delegation request carrying authenticated caller identity, target bot id, task intent, lineage and parent refs, and grant scope (workspace, permissions, budget, concurrency, depth).
- Interface — Output: accepted task id with initial queued state, or rejection with reason.
- Timing: Now — the evidence slice needs caller-managed task creation on the local path (NOT-395); the queue may be app-local for now.

### Q2 — Hold the request while the target is not running

A queued task for a target that is not running stays durable and claimable instead of failing or being lost.

- Serves: R8 — idle workers whose tasks, messages, session refs, and working context survive while the runtime is off.
- Interface — Input: queued task bound to a target that reports not-running or idle.
- Interface — Output: the same task still queued and durable until a runner claims it or a wake fires, with no silent loss.
- Timing: Post-evidence-gate — the evidence slice does not require waking an idle worker on demand; holding for offline or cloud targets waits for the idle wake-up gate (scenario C).

### Q3 — Order queued work per target

Claimants see a deterministic order for queued work so concurrent delegations do not race silently.

- Serves: R6 — bounded concurrent handoffs under explicit grants, plus Safety concurrency controls.
- Interface — Input: set of queued requests for one target with enqueue time and depth and budget attributes.
- Interface — Output: deterministic claim order per target (FIFO baseline with a stated tie-break) visible to claimants.
- Timing: Now — minimal per-target FIFO for the evidence slice; richer priority or scheduling is post-evidence-gate.

### Q4 — Create idempotently

Repeating the same creation request never creates duplicate work.

- Serves: R6 — one idempotent task per delegation (scenario A), plus Safety idempotent task creation and attempt dispatch.
- Interface — Input: delegation request carrying an idempotency key with the same caller, target, and intent digest.
- Interface — Output: the same task id returned for repeats, with no duplicate task or attempt created.
- Timing: Now — idempotent task creation is in-scope for the evidence slice.

## 2. Status listener — delegated work visibility

### S1 — Report queued, running, blocked, failed, or complete with a reason

A caller can determine the app-visible state of delegated work and why it is there, including terminal results.

- Serves: R7 — callers determine whether delegated work is queued, running, blocked, failed, or complete, with inspectable results.
- Interface — Input: status query carrying authenticated caller identity and a task id (or child-task id).
- Interface — Output: one of queued, running, blocked, failed, or complete plus reason or owner, with result summary and artifact refs when available.
- Timing: Now — scenario A needs queued, running, blocked, and failure updates in the originating conversation for local runs.

### S2 — Deliver updates by push or poll

State transitions reach the caller either as pushed notifications or as a pollable feed, without losing the terminal outcome.

- Serves: R7 — outcomes return to the originating task and conversation without a separate orchestration UI.
- Interface — Input: subscription or poll cursor for one task's state transitions from the last seen position.
- Interface — Output: ordered transition notifications (push delivery or pollable feed) with the terminal outcome never silently lost.
- Timing: Now — polling suffices for the evidence slice on the local path; push without continuous idle polling is post-evidence-gate per R8.

### S3 — Restrict reads to authorized callers

Only callers within the grant can inspect a task's status and results; the sender gains no access to the target's credentials or authority.

- Serves: R7 — authorized callers inspect result summary, review feedback, and artifact refs, plus R6 authenticated caller identity and explicit grants.
- Interface — Input: read request carrying authenticated caller identity for a task and conversation scope.
- Interface — Output: result summary, review feedback, and artifact references or digests when authorized, else denial with reason.
- Timing: Now — authentication and read authorization for delegation and result routing belong to the evidence slice.

## 3. Non-laptop runner — wake, launch, report, stop

### N1 — Wake a target that is not running

A pending task can start its configured target even when that target has no running process, without the target polling continuously while idle.

- Serves: R8 — idle wake-up for conversational delegation, plus R4 remote and provider-managed execution targets.
- Interface — Input: wake request naming the target bot and the pending queued task ids requiring it.
- Interface — Output: target running and claiming work, or failure with reason when wake is impossible.
- Timing: Post-evidence-gate — idle wake-up without continuous polling is explicitly out of the evidence slice; wake latency is measured first (NOT-391).

### N2 — Start the target with a resolved launch snapshot

The runner starts exactly the configuration the control plane resolved, not a silently different one.

- Serves: R4 — local and cloud execution targets launched from the control plane's immutable resolved snapshot.
- Interface — Input: start request with an immutable resolved launch snapshot reference (source revision, effective settings, target, permissions, digest) and task and attempt binding.
- Interface — Output: attempt id bound to that exact snapshot digest, or rejection on snapshot or target mismatch.
- Timing: Post-evidence-gate — for non-laptop targets; snapshot plus launch on the local Mac path is proven now (NOT-395, NOT-396) and cloud or remote launch waits for the gate.

### N3 — Report observations and results back

Runner evidence returns to the control plane, which alone applies lifecycle transitions; artifacts stay separately addressable with provenance.

- Serves: R7 — results, artifacts, failures, and review feedback are associated with the originating task and conversation.
- Interface — Input: runner observation with attempt id, state evidence, result summary, and artifact manifest (producer, content reference or digest, provenance).
- Interface — Output: acknowledgement that the observation was recorded, with any lifecycle transition applied by the control plane only.
- Timing: Post-evidence-gate — for cross-machine report-back; the local completion signal (log tail and session id) suffices now (NOT-396).

### N4 — Stop running work on request

An authorized cancellation halts the runner's work and terminalizes the task without late results reviving it.

- Serves: R6 — safeguards against unbounded execution, with Safety working single-task cancel and explicit lifecycles.
- Interface — Input: stop request carrying authorized canceller identity for a task or attempt id.
- Interface — Output: cancelled terminal state with reason and confirmation that the runner halted with no late completion.
- Timing: Post-evidence-gate — for remote stop; local single-task Stop is in-scope now (NOT-395) and descendant-cascade behavior waits for the gate.

### N5 — Authenticate the runner to the control plane

Every runner call proves which target it speaks for; unknown or unauthorized runners are rejected.

- Serves: R6 — runners authenticate to the control plane and targets run with their own credentials, never the sender's authority.
- Interface — Input: runner credential with claimed target identity on every claim, status report, launch, and stop call.
- Interface — Output: acceptance for authenticated authorized runners, or rejection with reason otherwise.
- Timing: Post-evidence-gate — for non-laptop runners; the local Mac runner pattern is proven now and cross-machine authentication is enforced with cloud wake.

No dealer change is needed by the currently agreed plan, and nothing is built by this ticket.
