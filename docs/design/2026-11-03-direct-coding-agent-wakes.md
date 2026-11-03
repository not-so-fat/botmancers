# Direct local coding-agent Wakes without Agent Deck — design

Ticket: NOT-541 (design and source of truth only; not queued in Agent Dealer).
Execution: NOT-542 (direct adapter, no product path change), then NOT-543
(cutover, migration, Agent Deck removal). NOT-542 blocks NOT-543. Neither
is a child of NOT-541.
Status: accepted direction. Where this document and older Agent Deck material
disagree (`docs/claude-via-deck.md`, the Agent Deck sections of
`docs/core-engine.md`, `docs/runner-boundary-requirements.md`,
`docs/design/2026-10-13-git-finalization-contract.md`,
`docs/evidence/NOT-468/decision-record.md`), this document wins for coding-agent
launches. Hermes is unchanged.

## 1. Decision

Botmancers launches local coding Agents (Claude, Codex, Cursor, Muse)
directly through the runtime installed on the machine, using the
SessionProviders that already exist (`lib/claude-session-provider.ts`,
`lib/codex-session-provider.ts`, `lib/cursor-session-provider.ts`,
`lib/muse-session-provider.ts`). Agent Deck is **not** a launch prerequisite,
launch profile, fallback, or local authorization mechanism. Nothing on the
coding-agent launch path reads an Agent Deck URL, deck id, run token, or
grant, and nothing falls back to Agent Deck when a direct launch fails.

Agent Deck services and remote runners are not kept "for later". If a
concrete need for them appears, they are designed again from that need.

## 2. User outcome

A person talks with Claude, asks it to get a Codex review, and the two
Agents iterate through Botmancers until the coordinator declares consensus,
escalates, or reaches the configured round cap. The person installs and signs
into the coding-agent CLIs they choose. They do not select a deck, configure
an Agent Deck run token, approve a remote-agent grant, or write Wake JSON by
hand.

## 3. Ownership

| Concern | Owner |
|---|---|
| Wake lineage, Work Requests, Attempts, retries, round caps | Botmancers engine (`lib/engine-store.ts`, `lib/dispatcher.ts`, `lib/coordinator-loop.ts`) |
| Wake and service grants, owner approval, Wake safety, concurrency limits | Botmancers (`lib/wake-safety.ts`, `lib/service-grants.ts`, `lib/approvals.ts`). **Unchanged.** |
| Session continuity (which session a revision resumes) | Botmancers Session Bindings and provider-session registry (`session_bindings`, `provider_sessions`) |
| Scope, launch policy, turn idempotency, turn audit | `lib/provider-sessions.ts` |
| Start, resume, observe, cancel, usage for a given runtime | The SessionProvider for the Agent's runtime connection |
| Translating one Attempt into provider calls | **New** direct AttemptAdapter (NOT-542) |
| Hermes turns | Existing Hermes gateway adapter (`lib/hermes-attempt.ts`). **Unchanged.** |

The provider never decides orchestration, never widens authority, and never
writes conversation messages. The engine never sees a provider session or
turn identifier.

## 4. Target architecture

```text
Wake / Work Request / Attempt engine          (lib/dispatcher, lib/attempt-executor)
    -> direct SessionProvider AttemptAdapter  (new: lib/session-provider-attempt.ts)
        -> lib/provider-sessions              (scope, policy, idempotency, audit, registry)
            -> Claude | Codex | Cursor | Muse SessionProvider
                -> installed local coding-agent runtime

Hermes Agents -> lib/hermes-attempt (gateway), as today.
```

`AttemptAdapterName` gains `'session-provider'`. After NOT-543 the only
names are `'hermes-gateway'` and `'session-provider'`.

## 5. The direct AttemptAdapter contract (NOT-542)

The adapter implements the existing `AttemptAdapter` interface
(`lib/attempt-adapter.ts`) with `externalCancel: true` and a `reconciler`. It
calls `lib/provider-sessions.ts` (`startProviderSession`, `sendProviderTurn`,
`observeProviderTurn`, `cancelProviderTurn`), **not** the raw provider. That
way the registered scope, launch policy, provider capabilities, turn
idempotency, audit, usage samples, and NOT-517 session-context minting
behave exactly as they already do for session turns.

### 5.1 Input translation

| AttemptInput field | Direct translation |
|---|---|
| `target.agentId` | The registered Agent. Its `runtime_connection_id` selects the provider through `sessionProviderFor`. A connection with no provider fails `unavailable` before any launch. |
| `prompt` | `text`: passed verbatim. `conversation`: rendered by the existing transcript renderer (`deckPromptForAttempt` in `lib/agent-deck-run.ts`). NOT-542 moves it, unchanged, to a neutral module (`lib/attempt-prompt.ts`) so that NOT-543 can delete `agent-deck-run.ts`. |
| `toolProfile` | `readonly` → `read_only`; `edit` → `workspace_write`. Checked against the Agent's launch policy and the provider's `authorities`. An unsupported mode fails `unsupported_authority` before launch. It is never downgraded or upgraded. |
| `cwd` | The `workspace` of a fresh start. It must be absolute and contained in the Agent's registered scope (`workspaceContains`). A resume ignores it: the provider resumes in the workspace the session recorded. |
| `deck` | Must be `null`. A non-null deck fails `launch_failed` with code `deck_not_supported`. NOT-543 deletes the field. |
| `sessionBinding` | Resume the **exact** session. `externalSessionId` holds a Botmancers provider-session **ref** (see 5.3), resolved through `provider_sessions` for this Agent. If the ref is missing, belongs to another Agent, is outside scope, is not resumable, or the provider reports a different session, the Attempt fails `session_mismatch`. It **never** substitutes a fresh session. |
| `freshSession` / no binding | `startProviderSession` in `cwd`. |
| `idempotency` | Requester = the Work Request's requester (`person`/`bot`/`service`). Key = `botmancers-attempt-<attemptId>`, the same deterministic per-Attempt key the NOT-468 work established. |
| `correlation` | Passed through unchanged to the provider call context. |
| `deadlineAt`, `signal` | Passed to `observeProviderTurn`. When either fires, the adapter calls `cancelProviderTurn` and sets `externalCancel` to `'requested'` (`cancelled` or `already_terminal`) or `'failed'`. |
| `prepareFinalization` | Not supported (section 9). The dispatch layer never sets it for a direct Attempt. If set anyway, the adapter fails `unsupported_authority` with code `finalization_not_supported` before launch. |

### 5.2 Result and failure mapping

`started` is emitted once the provider has returned a turn handle. Its
`externalRunId` is the Botmancers provider **turn ref**
(`provider_session_turns.id`) and its `externalSessionId` is the
provider-session **ref**. Neither is a provider identifier.

| Provider outcome | AttemptResult |
|---|---|
| turn `completed` | `completed`, `output` = turn output, `usage` from `usageFromEvent` (never estimated) |
| turn `failed` | `failed` / `runtime_failed`, `code` = provider failure code |
| turn `cancelled` (Botmancers asked) | `failed` / `cancelled` |
| `unavailable`, `auth_required`, `incompatible_version` | `failed` / `unavailable` (code kept) |
| `unsupported`, `unsupported_authority`, `permission_denied` | `failed` / `unsupported_authority` |
| `not_found`, `not_resumable` on a resume | `failed` / `session_mismatch` |
| `busy` | `failed` / `launch_failed`, code `busy`. The session is not replaced. |
| `usage_limit` | `failed` / `runtime_failed`, code `usage_limit` |
| `invalid_input` | `failed` / `launch_failed` |
| `idempotency_conflict` (same key, different turn) | `failed` / `launch_failed`, code `idempotency_conflict`. Nothing is launched. |
| signal / deadline | `failed` / `cancelled` or `timed_out`, with `externalCancel` set |
| start call threw or lost its answer after the provider may have launched | `failed` with `launchUnconfirmed: true`. The dispatcher keeps the Attempt open and reconciles (5.4). |

Caller-facing text stays fixed per category (`dispatchFailureFor`). A
provider diagnostic never reaches a user.

### 5.3 Opaque references

The engine's `session_bindings.external_session_id` and
`work_attempts.external_session_id` / `external_run_id` hold Botmancers
provider-session and provider-turn **refs**, not native provider ids. Native
ids remain private to `lib/provider-sessions.ts`, as they are today. As a
result, a session that a person picked from the session catalog and a
session that a Wake started are one kind of thing to the engine.

### 5.4 Durability, replay, and restart

The direct transport keeps the NOT-468 fail-closed policy. An ambiguous turn
is reattached, deferred, or flagged for operator attention. It is never
blindly relaunched.

- `launchIntent(input)`: `idempotencyKey` is `botmancers-attempt-<attemptId>`;
  `body` is the canonical JSON of `{agentId, connectionId, op: start|send,
  sessionRef|workspace, authority, prompt}`; `grantFingerprint` is `null`
  because no external grant exists. The dispatcher persists it before the
  adapter runs, exactly as today.
- `reconciler.currentGrantFingerprint()` returns `null` (it always matches).
- `reconciler.inspect(turnRef)` reads `provider_session_turns` and the
  provider's observation. `running` → `running`, `completed` → `ended`,
  `failed` → `error`, `cancelled` → `canceled`, provider `not_found` for a
  turn the registry holds → `died`, and an unknown ref → `not_found`.
- `reconciler.repost(intent)` re-issues the same start/send with the same
  requester and key. `provider-sessions` replays from
  `provider_session_turns` when the row exists. If the process crashed
  between the provider launch and that row write, the **provider** must
  return the original turn for the key. This is a hard requirement on every
  provider and must survive a Botmancers restart. Claude (key files), Codex
  (`clientUserMessageId` plus exec-run lookup), and Cursor (journal state)
  persist it. Muse currently keeps `startKeys` in memory only, so NOT-542
  must make it durable or Muse fails the restart proof. A body that differs
  under the same key is refused with `idempotency_conflict` and launches
  nothing.
- `reconciler.follow(turnRef, …)` observes to a terminal result through the
  same path as the tail of `run()`.
- `reconciler.evidence()` returns no finalization evidence (`null` fields).
- `reconciler.cancel(turnRef)` calls `cancelProviderTurn`. A repeated cancel
  is `already_terminal`, so cancel is idempotent.

Every shipped provider already runs turns detached, with durable on-disk
state, so a turn outlives the Botmancers process that started it. NOT-542
must prove this for each provider.

### 5.5 Limits and cancellation

The dispatcher limits are unchanged: global 4 and per-target 1 (`lib/wake-safety`
defaults). Two edit turns therefore never share one Agent's working directory.
Cancellation of a Work Request aborts the Attempt's signal; the adapter stops
the provider turn. A turn whose cancel failed is abandoned, and any later result
is evidence only. This is the NOT-473 contract.

## 6. Concrete flows

### 6.1 Fresh review pair

1. A person starts a new Claude turn in an allowed workspace. A
   `conversation` Attempt runs with `read_only` through the direct adapter →
   `startProviderSession`, and its provider-session ref becomes the
   conversation's Session Binding.
2. Claude asks Botmancers to Wake Codex as a read-only reviewer (Wake
   contract v1, `execution_kind: review`, `readonly`). Wake safety and owner
   approval apply exactly as today.
3. The dispatcher claims the review request. The direct adapter starts a
   new Codex provider session in the requested workspace, and the review
   result returns to Claude as a continuation (`lib/coordinator-loop.ts`).
4. If Claude decides to revise, the revision Attempt (`edit` →
   `workspace_write`) carries Claude's original Session Binding and resumes
   that exact Claude session.
5. The loop ends at consensus, at escalation, or at the configured round cap.
   The protocol itself is unchanged.

### 6.2 Existing coordinator session

1. The person selects an existing Claude session that is already visible to
   the registered Agent (session catalog, inside scope).
2. Botmancers binds that session's ref and resumes it. If the resume fails,
   the Attempt fails `session_mismatch`; no fresh session is substituted.
3. A Codex review uses a fresh session, or an existing Codex session that was
   explicitly selected and bound the same way.
4. Every later Claude revision resumes the same bound Claude session.

## 7. Cutover and migration (NOT-543)

NOT-543 changes the product atomically. In one release, direct launch becomes
the only coding-agent path.

### 7.1 Dispatch

- `ATTEMPT_ADAPTERS` maps every coding agent to the direct adapter.
  `adapterForTransport('session-provider')` returns it.
- `resolveAgent` loses the `deck` and `direct_runtime` blockers. A coding
  Agent is launchable when it has a valid runtime connection, a usable scope,
  a launch policy, and (for fresh starts) a launch workspace.
- Coding-agent availability (`app/api/bots/availability`) comes from the
  provider's `ready()` probe, not from `agent-deck` CLI probes.

### 7.2 Registration migration

The migration is a one-way, idempotent engine migration:

| Existing row | After |
|---|---|
| `launch_profile = agent_deck`, valid connection and scope | `launch_profile = direct`. `deck_id`, `deck_name`, `needs_deck_selection` cleared. `working_directory` is kept as the launch workspace if it is absolute and inside scope; otherwise it is cleared and the Agent shows a `workspace` launch blocker until the owner picks one. |
| `launch_profile = direct` | Unchanged. |
| `launch_profile` unresolved (legacy) | Stays blocked. No Agent Deck assumption is made. |
| Hermes Agents | Unchanged. |

After migration, `launch_profile` has the single value `direct`. NOT-543 may
drop the column, or keep it as a constant, as long as no code branches on it.

### 7.3 Engine state

- Open Attempts whose adapter is `agent-deck-api` or `agent-deck-run` are not
  reconciled through Agent Deck. At first start after cutover, each one
  becomes terminal `interrupted` with the operator-attention flag (NOT-468
  table B, "manual attention"). Botmancers makes no Agent Deck call.
- Session Bindings created by the Agent Deck adapter are not resumable
  through the direct adapter. A revision that would resume one fails
  `session_mismatch`. The owner can instead select the underlying native
  session from the session catalog (flow 6.2). There is no automatic
  translation.
- Completed Attempts, Work Requests, Wakes, grants, approvals, usage, and
  conversation history are kept unchanged as history.

### 7.4 Removal inventory

NOT-543 deletes the following. It does not deprecate them.

- Adapters and clients: `lib/agent-deck-api.ts`, `lib/agent-deck-attempt.ts`,
  `lib/agent-deck-run.ts` (after moving the prompt renderer),
  `lib/agent-deck-settings.ts`, `lib/agent-deck-finalization.ts`.
- Endpoints: `app/api/agent-deck/settings` and `app/api/agent-deck/decks`.
- UI: `app/components/AgentDeckRuntime.tsx`, `app/components/useDeckList.ts`,
  the deck and launch-profile controls in `AgentRegistration`,
  `ManageAgentsPanel`, `app/settings/page.tsx`, the bot config page,
  `lib/agent-registration-ui.ts`, `lib/bot-runtime-ui.ts`, and the related CSS.
- Configuration and secrets: `AGENT_DECK_RUN_TOKEN`, the Agent Deck URL
  setting, remote-agent grants, and grant fingerprints.
- Scripts and tests: `scripts/agent-deck-smoke.js`,
  `scripts/not-468-restart-poc.js`, `test-agent-deck-*.js`. Replace them
  with direct equivalents where the behavior still exists.
- Active documentation: `docs/claude-via-deck.md`, the Agent Deck setup
  sections of `README.md`, `docs/core-engine.md`, `docs/product-requirements.md`,
  and the `packages/mcp-server` setup text that names Agent Deck as a launch
  requirement. Historical evidence under `docs/evidence/` stays as history.

The removal **keeps** the Botmancers Wake grants, service grants
(`lib/service-grants.ts`), owner approval rules, Wake safety decisions, and
concurrency limits. It also keeps the Agent Deck MCP that a person may
configure inside their own coding-agent runtime: that is the user's tool
setup, outside Botmancers' launch path, and Botmancers neither requires nor
removes it.

## 8. Scope

Included: fresh and exact-session coding-agent turns; `read_only` review and
`workspace_write` revision authority; durable replay, restart observation,
cancellation, usage, and failure mapping; the one-way registration migration;
removal of the Agent Deck launch and configuration surface; preservation of
Botmancers Wake and service grants and owner approval.

Excluded: optional Agent Deck MCP context, credentials, playbooks, or deck
equipment; remote or unattended execution; Agent Dealer runner-package
extraction; Git commit, PR, worktree, or replacement finalization automation;
new coding-agent providers; any redesign of the coordinator/reviewer
consensus protocol.

## 9. Consequence: Git finalization is retired with Agent Deck

NOT-487 finalization (baseline capture, candidate manifest, and the
`botmancers-finalize` commit) is implemented entirely by Agent Deck.
Replacement finalization automation is out of scope. Therefore:

- A direct Attempt never prepares finalization. Revision edits stay in the
  workspace as uncommitted changes for the person or their own tools to
  commit.
- The coordinator protocol is not redesigned. A `botmancers-finalize` block
  is still parsed, and every decision is answered through the existing
  "[Finalization not started]" continuation with the fixed reason
  `finalization_unavailable`. NOT-543 removes the finalization prompt text
  that invites such blocks, so coordinators stop producing them.

## 10. Proof

NOT-542 (no live path change). For each of Claude, Codex, Cursor, and Muse,
run against a fake runtime in tests and against the real CLI in a recorded
smoke where it is installed:

- fresh start, exact resume, resume-mismatch refusal (no fresh substitute);
- observe to completion with usage; cancel (and repeated cancel); deadline;
- replay of the same key (one turn); a different body under the same key
  (`idempotency_conflict`, nothing launched);
- restart: kill Botmancers after the launch and before the result is
  persisted, then restart and reconcile through `inspect`/`repost`/`follow`
  to exactly one turn;
- authority: `read_only` cannot write; `workspace_write` is refused when the
  policy or the provider does not allow it.

NOT-543:

- migration tests over fixture rows for every row type in 7.2 and the engine
  states in 7.3;
- a repository check that no runtime code imports or references Agent Deck
  (historical evidence excluded);
- an exact-HEAD local smoke with Agent Deck **stopped or uninstalled**: a
  person's Claude turn → Wake Codex read-only review → Claude revision that
  resumes its original session → consensus or round cap. The transcript and
  HEAD SHA are recorded under `docs/evidence/NOT-543/`.

## 11. Risks and open items

- Muse idempotency keys are in memory today (`startKeys`). NOT-542 must make
  them durable, or Muse cannot claim restart proof.
- The `session_bindings` active index is keyed by `adapter`. A binding
  recorded under `agent-deck-api` never collides with a `session-provider`
  binding, which is intended (7.3).
- Retiring finalization (9) removes a shipped capability. That follows
  directly from the decision and the exclusion of replacement finalization
  automation. If the owner wants finalization back, it needs its own design
  that does not depend on Agent Deck.
