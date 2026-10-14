# NOT-468 decision record: Agent Deck run reconciliation across a Botmancers restart

**Status:** accepted. The product owner approved the fail-closed recovery policy on Linear NOT-468 (comment `248fa4f5-39e0-4aa5-9cf2-f7e7f0fa34a8`). Two amendments from that approval are applied below: a `died` run always sets the operator-attention flag (the Attempt itself becomes terminal `interrupted`; see the decision table), and the no-run-TTL result is accepted in place of an expired-run-id transcript.
**Date:** 2026-10-14
**Evidence:** [transcripts/](./transcripts/README.md). The real runs used Botmancers `7d0fa92` (with NOT-487) and Agent Deck `92e3293` (with NOT-480, NOT-481, and NOT-486). The edits were real Codex `edit` runs launched through Botmancers' canonical path (`startAgentDispatch` → `runTurn` → `createAgentDeckApiAttemptAdapter`) against a disposable Git workspace. The harness is `scripts/not-468-restart-poc.js`. It is investigation tooling with no production code changes.

## Question

Botmancers can restart while an Agent Deck run is starting, running, or already terminal. What can it then recover through the public run API alone? Can it do so without launching a second logical run, and what should the durable dispatcher do in each case?

## Answer in one paragraph

Everything needed is recoverable through the public API as long as Botmancers still holds the **run id** and the **same grant**. That includes the state, the full ordered events from `seq` 1, the final `result`, the opaque `sessionId`, the finalization baseline, and the candidate manifest. A completed run's session was resumed after a restart and came back byte-for-byte identical. If the run id was lost (a crash between the 202 and persistence), a re-POST with the deterministic Attempt key (`botmancers-attempt-<attemptId>`) and a byte-identical body returns the original run without launching. This held before and after an Agent Deck restart. Today, however, **Botmancers does none of this**: its startup recovery made zero Agent Deck calls in all 9 captured restart passes (s1, s2, s3, s4, N5, the two N7 passes, N8, and C1) and left every `running` request with an open Attempt forever. Two conditions lead to duplication or loss. First, idempotency and run visibility are **grant-scoped**: a re-POST under a rotated grant launched a real second run. Second, the reattach body must re-render byte-identically, which Botmancers can verify only through `prompt_hash`.

## Observed results per boundary

All restarts are fresh Node processes that see only durable SQLite state. In every row, "launches" counts the logical runs that Agent Deck created for the Attempt (13 distinct run ids, matching 13 run directories on the host).

| Boundary (Botmancers SIGKILL point) | Persisted Attempt at restart | Public API on restart | Recovered | Launches |
|---|---|---|---|---|
| **start-response**: after `202 {runId, starting}`, before persistence (s1, Attempt `3d72377d`) | open, `external_run_id = null`, no baseline | Nothing is readable without a run id. A re-POST with the same key and body returns `202` with the same `run-20261014T152347-7e5349` (state `running`). | The run id, then everything listed under terminal | 1 |
| **started**: run id persisted, before the first status read (s2, `62f49373`) | open, run id set, **no baseline row** | `starting`, `sessionId: null`, 0 events, `finalization.state: prepared` with `baselineRef` | The baseline from status. The result after reattach. | 1 |
| **running**: first `running` events page (s3, `be4bf11f`) | open, run id, baseline | `running`, session id already present, 2 ordered events | The session id mid-run, and the result after reattach | 1 |
| **terminal**: `ended` page seen, before `finishAttempt` (s4, `88b9ea03`) | open, run id, baseline | `ended`, 5 events (`4:result`, `5:end`), session, `/changes` with 1 file | Output `DONE-s4-terminal`, the session, and the manifest `308156…`. A reattach POST returned `state: ended` and did not relaunch. | 1 |
| **resume after restart** (s5 from s4's binding `9af43bee`) | completed implementation with an active Session Binding | The new run `run-20261014T152441-e8430e`. Its notice says it resumes the thread started by `…74465e` with the edit sandbox kept. Status `sessionId` equals the binding. | The same session (full-value equality) and a resume Attempt linked to the binding. The model recalled the previous turn's file. | 1 (the resume) |

Event invariants held in every read, including across Agent Deck restarts. `seq` is contiguous from 1. A page read with a terminal state already contains the terminal event (`result` + `end`, or `canceled`). A `died` run has **no** terminal event.

### Negative and interruption cases

| Case | Observed | Botmancers error mapping today |
|---|---|---|
| N1: unknown run id (status, events, cancel) | `404 RUN_NOT_FOUND` | `agent_deck_rejected`, status 404, deckCode `RUN_NOT_FOUND` |
| "Expired" run id | Not exercisable: Agent Deck `92e3293f67dbce3f396dad0a2b58f165fab2ac9f` has no run TTL or retention. Runs live under `runsRoot(home)` = `<AGENT_DECK_HOME>/runs` (`packages/backend/src/agent-run/records.ts:100`), and nothing in `packages/backend/src/agent-run/`, `packages/backend/src/agent-run-api/`, or `packages/backend/src/routes/agent-runs.ts` deletes a run (the only `fs.rmSync` calls, in `agent-run-api/git-finalize.ts`, remove Git index and lock temp files). A run id the index does not hold returns `404 RUN_NOT_FOUND` from `readableRun` (`packages/backend/src/routes/agent-runs.ts:268`, the 404 at line 276), which is the N1 response. No expired id was manufactured; the owner accepted this result. A lost or replaced run store therefore presents as N1. | `agent_deck_rejected` 404 `RUN_NOT_FOUND` → **manual attention** (table B) |
| N2: run read by another grant | `403 RESOURCE_OUT_OF_SCOPE` | `agent_deck_forbidden` |
| N3: same Attempt key, different body | `409 IDEMPOTENCY_CONFLICT`, nothing launched | `agent_deck_rejected` 409 |
| N4: resume an unknown session | `422 RESUME_UNVERIFIED`, nothing launched | `agent_deck_rejected` 422 |
| N5a: launching grant expired before restart | `401 GRANT_REQUIRED` on status and events | `agent_deck_unauthorized` |
| N5b: rotated (new) grant reads the run | `403 RESOURCE_OUT_OF_SCOPE`. The owner dashboard still sees `ended`. | `agent_deck_forbidden` |
| **N5c: reattach POST under the rotated grant** | **A second logical run was launched** (`run-20261014T152636-72c839`, host run directories 9 → 10). Botmancers' immutable external-id trigger then threw `SQLITE_CONSTRAINT_TRIGGER`, so durable state was not corrupted, but the duplicate model work had already happened. | — |
| N7: Agent Deck and Botmancers both SIGKILLed mid-run | While Agent Deck is down: `ECONNREFUSED`. After the Agent Deck restart: `died`, 1 event, no terminal event, and the orphaned Codex process was stopped (host: 1 → 0). A re-POST after the Agent Deck restart returned the **same** run (`state: died`). | `agent_deck_unreachable`. Reattach maps `died` to `failed`/`runtime_failed`, not `interrupted`. |
| N8: Agent Deck SIGKILLed under a live observer | The adapter failed the Attempt on the first refused events read (`failed`/`unavailable`, request `failed`). Its best-effort cancel was also refused. After the Agent Deck restart the run was `died`. | `agent_deck_unreachable` |
| C1: cancel after a Botmancers restart (running) | `canceled`, and a repeated cancel also returned `canceled`. `canceled` was the last event, with no `result`/`end`. The Codex process group was gone and the file was never written. | Cancellation **is** proven for a live run after restart. |

## Findings

- **F1: There is no reconciler today.** `recoverCoordinatorLoops()` made 0 Agent Deck calls and changed nothing in all 9 captured restart passes. `startAgentDispatch` skips any request that is not `queued`, so a `running` request with an open Attempt never progresses. The run keeps editing the workspace unobserved.
- **F2: The run id is persisted at the adapter's `started` event**, synchronously after the 202. Only the start-response window (s1) loses it. A same-key re-POST closes that window safely.
- **F3: Reattach depends on re-rendering the identical body.** Botmancers persists only `prompt_hash` (in the launch snapshot), not the start body. Re-rendering from conversation history matched the hash in all 6 reattaches. Any change to that history or to the bot's name or description would produce `409 IDEMPOTENCY_CONFLICT`, or, if the first POST never landed, a launch with a different prompt.
- **F4: Idempotency and visibility are per grant.** A run is readable only by the grant that started it, and the same key under a new grant is a new launch (N5c). Botmancers does not record which grant launched an Attempt.
- **F5: The baseline can be missing after a restart (s2).** It is recoverable from `GET status` → `finalization`. The candidate manifest exists only once the run is terminal, and `/changes` also answers for a `died` run (N7: 0 files).
- **F6: `died` is reported as `failed`.** The adapter has no interruption category. The engine already supports the `interrupted` outcome.
- **F7: The live adapter fails on one transient read error (N8).** Here Agent Deck really died, so the run became `died` and the result was consistent. But a brief outage of a healthy backend would leave a `failed` Attempt while the run continues to edit. That part is an inference and was not exercised.
- **F8: `ended` + `success` does not prove the task was done.** In s0 and s0b Codex refused (see F9), yet the run `ended` with a success `result` and an empty manifest. Reconciliation must stay mechanical; judging the result is the reviewer's job.
- **F9 (operator environment):** The owner's global Codex `agent-deck` plugin enforces a session-bootstrap gate that cannot pass for a deck that its MCP server does not host, so edits were refused. The PoC isolated `CODEX_HOME` (auth symlinked). Real Botmancers decks on the owner's main Agent Deck should not hit this, but the reason is worth knowing.

## Decision table (accepted dispatcher policy)

The dispatcher runs this at startup and for every Attempt that is still open, then periodically while `unreachable`. It uses only the persisted Attempt (`external_run_id`, launch snapshot, baseline rows) and the public API.

Each row decides two separate things:

1. **The Attempt transition.** The Attempt either stays **open** or becomes **terminal** with exactly one outcome.
2. **The attention flag.** This is a persisted operator-attention flag with a reason. It is separate from the Attempt lifecycle and can be set on an open or a terminal Attempt. While it is set, the dispatcher makes no automatic launch, re-POST, retry, or resume for that Attempt's request. Only an operator clears it.

Actions:

- **reconcile**: make the Attempt terminal with the outcome shown by API evidence. The flag is not set.
- **reattach**: keep the Attempt open and observe until terminal. The flag is not set.
- **defer**: keep the Attempt open and retry the reconcile with backoff. The flag is not set.
- **retry**: a fresh Attempt. This is automatic only when Agent Deck rejected the launch before any model work (table A pre-launch rejections). Once a run has existed, a fresh Attempt is never automatic (see `died`).
- **interrupted + attention**: make the Attempt terminal with outcome `interrupted` **and** set the flag. The `died` row uses this.
- **fail**: make the Attempt terminal with outcome `failed` and a category. The flag is not set.
- **manual attention** (when used alone): keep the Attempt **open** and set the flag. It is used where the run may still exist or still be running and Botmancers cannot observe it. Because the Attempt is open, the reconcile can run again after the operator fixes the cause (for example, restores the grant).

### A. The Attempt is open and has no run id

| Condition | Action |
|---|---|
| Re-rendered prompt matches `prompt_hash`, the deck/cwd/tools match the snapshot, and the grant is the launching grant | **Re-POST with the same key.** `202` returns the original run (s1) or, if the first POST never reached Agent Deck, the first launch. Persist the run id, then continue with B. |
| Re-POST returns `409 IDEMPOTENCY_CONFLICT` | **Manual attention.** A run exists that Botmancers cannot identify by id. |
| Re-POST returns a pre-launch rejection (`400`, `404 DECK_NOT_FOUND`, `422 WORKSPACE_*`/`PROFILE_UNSUPPORTED`/`RESUME_UNVERIFIED`/`FINALIZATION_INVALID`, `409 INDEX_DIRTY`, `503 CLIENT_UNAVAILABLE`) | **Fail** (`launch_failed`) with the stable code. A later **retry** is allowed because no model work ran. |
| `401` / `403` | **Manual attention: grant.** |
| Unreachable | **Defer.** Keep the Attempt open and retry the reconcile with backoff. |
| Prompt hash mismatch, or the grant differs from the launching grant | **Manual attention.** Never POST: it could conflict (N3) or duplicate (N5c). |

### B. The Attempt is open and has a run id (read-only first: `GET status`, then events from cursor 0)

| Observed | Action |
|---|---|
| `starting` / `running` | **Reattach.** Persist a missing baseline from `status.finalization` (F5). The deadline still applies: past it, **cancel** (C1) and record `timed_out`. |
| `ended` with a non-empty string `result` event | **Reconcile succeeded.** Record the output and `sessionId`. For a prepared run, read `/changes` into the candidate manifest. For an edit, bind the session. |
| `ended` without a valid result | **Fail** (`result_contract`). |
| `error` | **Fail** (`runtime_failed`). |
| `canceled` | **Reconcile cancelled.** |
| `died` | **Interrupted + attention.** First read `/changes` and persist it as the Attempt's manifest for the operator. Then make the Attempt **terminal** with outcome `interrupted`, not `failed` (F6), and **set the attention flag** with reason `run_died`. The run is dead (there is nothing left to observe), so the Attempt does not stay open. The flag, not an open Attempt, is what blocks automation. This holds **even when `/changes` lists no files**: an empty Git manifest cannot rule out shell, network, or other external side effects, and N7 shows model work had started (a model event and a live Codex process). Never auto-retry and never auto-resume a `died` run or session. A fresh Attempt requires explicit operator authorization, a review of possible side effects, a **new** idempotency key, and preserved prior evidence (the `died` run id, its events, and its manifest stay linked to the prior Attempt). |
| `404 RUN_NOT_FOUND` | **Manual attention.** Agent Deck does not hold the run: wrong server, or a lost, wiped, or replaced run store. Runs do not expire in `92e3293` (see the "Expired" row), so this is never treated as a normal expiry. Never relaunch automatically. |
| `401 GRANT_REQUIRED` | **Manual attention: grant expired or revoked.** Only the original grant can read the run. A new grant cannot (N5b) and must not re-POST (N5c). |
| `403 RESOURCE_OUT_OF_SCOPE` | **Manual attention: grant or deck mismatch.** |
| Unreachable / `5xx` | **Defer.** Keep the Attempt open and retry with backoff. After Agent Deck recovers, expect `died` if it crashed (N7). |

### C. The Attempt is already terminal

There is nothing to reconcile, and the dispatcher takes no action. (N8's `failed`/`unavailable` against Agent Deck's `died` is consistent. If F7 is fixed, a live observer would leave the Attempt open instead.)

### Resume (revision) after a restart

Resume only from an active Session Binding of a **reconciled** `ended` edit run on the same deck, cwd, and tools (Codex `same_profile_provenance`). `RESUME_UNVERIFIED` means **fail** with `session_unavailable`; Botmancers must never fall back to a fresh session (existing NOT-472 rule, unchanged). A reported session different from the binding stays **fail closed** (`session_mismatch`, existing adapter rule).

## Requirements this places on the dispatcher (for the implementation ticket, not done here)

1. Run the B-table reconcile at startup for every open Attempt whose transport is `agent-deck-api`, and the A table where the run id is null (F1).
2. Persist enough to re-POST safely: either the exact start body or its canonical hash plus the inputs, and a **non-secret fingerprint of the launching grant** (F3, F4).
3. Add a persisted operator-attention flag (with a reason) that is separate from the Attempt lifecycle and blocks all automatic launch, re-POST, retry, and resume for the request while set. Make a `died` Attempt terminal with outcome `interrupted` (F6) and set that flag; never create a fresh Attempt for it without operator authorization, a side-effect review, a new idempotency key, and preserved prior evidence. Treat a transient `unreachable` during observation as **defer**, not fail (F7).
4. Never re-POST under a grant that differs from the launching grant (N5c).

## Explicitly not claimed

- Cancellation of a `starting` run, of an in-flight finalization, and of a run owned by another backend process (`409 RUN_NOT_CANCELABLE`) was not exercised.
- A run ending in `error` was not produced. Its row follows the documented state contract.
- Only Codex was tested. Cloud runners and other clients are out of scope.
