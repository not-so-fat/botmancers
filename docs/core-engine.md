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
instructions, capabilities, and a registration (NOT-502, see
[`docs/design/agent-registration.md`](design/agent-registration.md)): one
runtime connection (whose provider is the Agent type: `Hermes`, `Cursor`,
`Claude`, `Codex`, or `Muse Code`), an explicit session scope, an optional
default workspace, a launch profile (`direct` or `agent_deck`), a launch
policy, and an optional home session. Only the `agent_deck` profile carries a
selected Agent Deck and its optional working directory.

Agent names are unique within one Botmancers instance under case-insensitive,
trimmed comparison. The display name is preserved, while Botmancers resolves every
wake to exactly one stable Agent ID. Renaming an Agent does not rewrite historical
wake targets.

Agent Deck is an optional launch profile. It is not an Agent and it is not
presented as a runtime; a direct profile never contacts it. An Agent without a usable launch configuration remains readable, but a
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

### Session catalog

Each Agent's **Sessions** view (thread header → Sessions) lists its Session
Bindings so the owner can recognize a runtime context without handling provider
IDs. It is a read model over `session_bindings` (`lib/session-catalog.ts`); it
adds no table and writes nothing; since NOT-503 it also reads the provider-session
registry (`provider_sessions`).

- **Reference.** A session is named by its Botmancers reference: the Session
  Binding's own id. It is the only identifier in the catalog's normal responses
  and UI.
- **Metadata.** Agent and adapter (plus transport from the source Attempt's
  launch snapshot); a title from the owning Work Request's first intent line,
  else the group name, else `<Agent name> · <created date/time>`; origin
  Conversation and Work Request (a binding scoped to only one of them takes the
  other from what is recorded: the Work Request from its source Attempt, the
  Conversation from the Work Request's source conversation); `active` (unreleased) or `ended` (released);
  created, ended, and last-activity times (the newest of binding, release,
  source Attempt, and resuming Attempts); and `resumable` (exactly the binding a revision
  would resume: active, scoped to its own implementation or revision Work
  Request together with that request's source conversation, and bound under
  the adapter the Agent dispatches today; a sparse request-only or
  conversation-only binding, or one left by an earlier runtime, is not
  resumable). Workspace
  and deck appear only when the stored launch snapshot recorded them; nothing is
  probed live.
- **Routes.** `GET /api/bots/:id/sessions?status=active|ended|all` (newest
  activity first, then newest binding, then reference) and
  `GET /api/bots/:id/sessions/:ref`. Both sit behind the owner boundary
  (`proxy.ts`). An unknown Agent or reference is 404; a reference belonging to
  another Agent is the same 404.
- **External session IDs.** The opaque provider session ID is never part of a
  summary, a detail, or the default UI. The single exception is the explicitly
  labeled local debug disclosure ("Local debug: provider session ID", with a
  Copy action), which requests `?debug=external_session_id` on the detail
  route. The MCP bridge and `/api/v0` do not expose the catalog, and their
  non-disclosure contract (`docs/mcp-bridge.md`, Privacy) is unchanged.
- **Native sessions and state (NOT-503).** The catalog also lists the
  Agent's native sessions from the provider-session registry (see Provider
  sessions below) beside its bindings, in one reference space. Each row adds
  `source` (`botmancers` for a binding, `native` for an imported or
  provider-started session) and `state`: `availability` (`available` |
  `missing`), `lifecycle` (`open` | `archived`), `resumable` (what the provider
  last said, `null` when never asked), `busy`, and `synced_at`. These are
  independent of `status`: a released binding stays `ended` while its provider
  may still report it resumable, and a missing session is listed with
  `availability: missing`, never dropped. A native session's `status` follows
  its lifecycle (`open` is `active`, `archived` is `ended`); its top-level
  `resumable` stays the NOT-496 engine-resume answer and is always `false`.
  The service API (`/api/v0`) carries `source` and `state` additively; the MCP
  v2 session item omits them. Both carry the additive `usage` summary
  (Session usage, below).

### Provider sessions

A **SessionProvider** (`lib/session-provider.ts`) is the transport-neutral
boundary to the sessions a coding-agent runtime holds natively, including ones
that existed before Botmancers. It is selected by the registered Agent's
runtime connection (`registerSessionProvider({ connectionId } | { provider })`),
never by Agent Deck. Real runtime adapters register by provider kind: `claude`
connections get the direct Claude Code provider
([claude-session-provider.md](claude-session-provider.md), NOT-506), and Cursor
connections get the direct Cursor CLI/SDK provider
([providers/cursor.md](providers/cursor.md)), which also supports explicit
scoped import (`importProviderSession`) for a version that cannot list. The
direct Codex provider is installed by default for `codex` connections
([integrations/codex-direct.md](integrations/codex-direct.md)); explicit
registrations win. Muse connections get the direct Muse MSP provider
(Direct Muse Code sessions, below; NOT-508). `AttemptAdapter` remains the
per-turn seam of the Work Request engine.

- **Contract.** `capabilities()` reports `list`, `search`, `read`, `resume`,
  `start`, `cancel`, `usage`, the enforceable authority modes (`read_only`,
  `workspace_write`), and `max_page_size`. Operations: bounded
  `listSessions` (scope, optional query, cursor, limit), `getSession`
  (`null` means missing), paged `readTranscript`, `startSession` (explicit
  absolute workspace), `sendTurn` (exact session), `observeTurn` (to a
  terminal result; a signal or deadline ends only the wait), and idempotent
  `cancelTurn` (`cancelled` | `already_terminal`). Every turn call carries an
  explicit authority, an idempotency key, cancellation/deadline, and
  correlation ids. Results are typed `{ ok, value | error }`; a provider
  never throws for runtime failures.
- **Registry.** Engine migration 17 adds `provider_sessions`: a stable
  Botmancers reference (`id`), the owning Agent and runtime connection, the
  private `provider_session_id`, an optional one-to-one `binding_id`, title,
  workspace, provider created/updated times, the state facts above,
  capabilities, and `last_synced_at`. Every existing Session Binding is
  backfilled under its own id (references never change), and `bindSession`
  registers new ones the same way. A partial unique index on (Agent,
  connection, provider session) for unlinked rows makes repeated discovery
  idempotent; the same provider id on another connection or Agent is another
  session. `provider_session_turns` records each start/send turn under the
  requester's idempotency key, and `provider_session_events` is the
  append-only audit (imports, syncs, refusals by count, missing, turn
  lifecycle, cancel requests); neither names a provider id.
- **Botmancers owns policy** (`lib/provider-sessions.ts`). Discovery imports
  only sessions inside the registered scope (selected workspaces, selected
  references, or the explicit all-provider-sessions choice; a missing scope
  imports nothing). Starting requires the `start` capability,
  `allow_new_sessions`, and a workspace inside the scope; sending requires
  `resume`, a session the provider reports available, resumable, and idle,
  and (for native sessions) still in scope. `workspace_write` requires the
  provider to support it and the Agent's `workspace_write` policy (plus
  `allow_resume_with_edits` for a send); authority is never inferred from the
  provider or workspace. An unsupported capability is refused before the
  provider is called. Turns are replayed by idempotency key (a different body
  is `idempotency_conflict`), observed from the persisted provider turn id
  (also after a restart), and a repeated cancel is `already_terminal`.
- **Reported usage.** Engine migration 19 adds nullable `input_tokens`,
  `output_tokens`, and `total_cost_usd` to `provider_session_turns`, exactly
  as the runtime reported them (explicit zero kept, never estimated); turn
  views carry them as `usage`. The same result also records the turn's one
  `usage_samples` row (migration 18, below).
- **Disclosure.** Provider session and turn ids appear only in the registry.
  Turn views, transcript pages (the session's own id is redacted from
  text), catalog rows, events, and service responses carry Botmancers
  references only; the service redactor treats every registry id as private.
  `?debug=external_session_id` on the owner detail route remains the single
  exception, for native sessions too.

#### Direct Muse Code sessions

`lib/muse-session-provider.ts` is the provider for runtime connections whose
provider is `muse` (kind `muse-msp`). It speaks the stable Muse Session
Protocol (MSP v1) to `muse serve` over stdio; Agent Deck stays an optional
alternate launch profile and is never required.

- **Probe.** The `initialize` handshake supplies the Muse version, the MSP
  envelope schema version, and session durability. Muse older than 1.4.0 or
  a schema other than 1 is `unsupported` and reports no capability; an
  ephemeral host can start sessions but cannot list, read, or resume them;
  a credential failure is `auth_required` and a missing binary
  `binary_missing` (both `provider_unavailable` to callers).
- **Operations.** `session/list` (host cursor, bounded limit, `sessionId`
  filter for a selected-sessions scope, `name`/`title` text filter for
  search, refused as `unsupported` when the host does not echo it),
  `session/read` (metadata, inline history paged locally, `lastTurn`; it
  never attaches), `session/start` + `turn/start` in the explicit workspace,
  `session/resume` + `turn/start` on the exact session, `turn/completed` and
  `session/tokenUsage` notifications for observation, and `turn/cancel`.
  Every command carries a fresh UUIDv7 `commandId`; nothing else is sent.
- **Authority.** `muse serve` fixes its sandbox at startup, so there is one
  host per authority: `read_only` runs with `--disable-write
  --disable-shell`, `workspace_write` with the default posture. Approval mode
  is `denyUnmatched`. A busy session is refused, never queued or steered.
- **Facts.** MSP v1 has no archive state, so lifecycle is `open`;
  resumable means a durable host persisted the session; busy means
  `running` or an active turn. Subagent children and malformed rows are
  skipped. Usage is `turn/completed.usage`, else the sum of the turn's
  `session/tokenUsage` records (a field any record omits is unknown), else
  null. MSP reports no per-turn cost, so cost is never estimated.
- **Restart.** Muse ids stay private (the turn id is
  `<sessionId>:<turnId>`). After a Botmancers restart, observe reads the
  durable session: its `lastTurn` gives the terminal; a turn that died with
  its host is `failed` with `host_lost`, and no replacement session is
  started. Resume reloads the same session in its own workspace.
- **Configuration.** `BOTMANCERS_MUSE_BIN` (default `muse`) and
  `BOTMANCERS_MUSE_SERVE_ARGS` (a JSON array of extra `muse serve` flags,
  for example `["--provider","echo"]`).
- **Smoke.** `node scripts/muse-msp-smoke.js` imports and resumes a real
  past session through a real `muse serve` across a Botmancers restart
  (transcript: [evidence/NOT-508/muse-msp-smoke.md](evidence/NOT-508/muse-msp-smoke.md)).

### Session usage

Sessions show the token usage and cost their providers **reported**: never
estimated from a pricing table, a model guess, or a subscription plan, and
never 0 unless the provider said 0.

- **Samples.** Engine migration 18 adds `usage_samples`: one row per Attempt
  (`attempt:<id>`) or provider turn (`turn:<id>`) that reached a runtime,
  under a unique `sample_key`, with nullable `input_tokens`, `output_tokens`,
  and `cost_usd`, the provider (the Attempt's adapter or the registry
  row's provider kind), the structured `source` it came from
  (`result`, `codex.turn_completed`, `normalized`, or `none`), the observed
  time, and a `breakdown` of whitelisted numeric counters only (cache reads
  and writes, reasoning tokens). The executor writes the sample with the
  Attempt's terminal record (`recordAttemptResult`), an abandoned Attempt's
  record, and a late result; restart reconciliation writes an all-unknown
  sample for a run that died. A later write for the same key only fills a
  metric that was still unknown: replays, late results, and a reconciled
  Attempt after a restart never add or overwrite. A launch refused before a
  run existed writes no sample. Earlier Attempts have none.
- **Parsing** (`lib/usage.ts`). Codex `turn.completed` usage (tokens, no
  cost), Claude/Cursor `result` usage with `total_cost_usd` (snake_case or
  camelCase), and Muse-compatible normalized usage (`input_tokens`,
  `output_tokens`, `cost_usd`, bare or under `usage`). A `result` event is
  cumulative and wins; Codex turns add up; an event replayed with the same
  `seq` counts once. Malformed values become unknown and unsupported or
  missing data yields no usage; the session result is never blocked. The
  Agent Deck adapter reads the run's events; a SessionProvider reports
  `ProviderTurnResult.usage`.
- **Summary.** Each metric is aggregated on its own: `sum` (null when no
  sample reported it), `known` and `total` sample counts, and `quality`
  `complete` (all reported), `partial` (some; the sum is a lower bound), or
  `unavailable` (none, or no samples). A Session Binding's samples are its
  source Attempt's, every Attempt that resumed it, and provider turns on its
  registry row; a native session's are its provider turns.
- **Surfaces.** Catalog summaries, `GET /api/bots/:id/sessions`, the service
  API list and detail, and the MCP v2 `botmancers_list_sessions` item carry
  the additive `usage` summary (optional in the v2 schema, so a client or an
  older server that omits it stays valid). Details add `usage_samples` (one
  per run or turn: kind, attempt number, turn kind, provider, source, the
  three values, observed time). The raw breakdown, sample keys, and
  provider ids are never returned. The Sessions view shows a compact row
  total (`1.2M in · 45.7k out · $3.34`), says "Not reported" or "cost not
  reported" for unknown values, labels partial coverage Partial with how
  many runs reported, and lists per-run usage in Details.

### Session pins

NOT-507 (`lib/session-pins.ts`, `lib/session-actions.ts`, engine migration
20). A pin is one requester's multi-turn conversation held on exactly one
session. Two address forms create one:

- **Registered Agent.** The caller names only the Agent. Botmancers uses its
  configured home session; else the newest eligible session in its scope
  (archived but resumable counts; a busy one is waited on, never bypassed);
  else, only when the Agent's policy allows new sessions and a default (or
  the single selected) workspace exists, a new read-only session (a service
  also needs `sessions:start`). Otherwise the answer is `workspace_required`
  or `no_eligible_session`: a missing workspace never means unrestricted.
- **Exact session.** The caller names a session reference.

Every later turn goes to the pinned `session_ref` and nowhere else, across
restarts, until the requester detaches the pin or switches (a new pin that
replaces it in the same commit). A refused or failed turn (busy, missing,
provider failure) is recorded as a `turn_refused` event and leaves the pin
where it was; the `session_ref` column is immutable.

The three session actions, shared by the Sessions view, the owner routes,
the service API, and MCP:

- **Ask from this context.** Read-only turns pinned to the source session.
- **Resume work here.** The same Agent in the same exact session with
  workspace-write authority, only when the runtime enforces it, the Agent's
  policy allows resuming with edits, and the requester explicitly approved
  (`approved_at`).
- **Hand off to….** The Continue exchange below, unchanged: a bounded
  packet to a different Agent in a fresh destination-owned session.

`session_pins` holds the pin (requester, idempotency key, Agent, session,
action, authority, resolution, route, conversation, approval, state);
`session_pin_turns` one row per turn (a provider turn or an Ask exchange);
`session_pin_events` the append-only audit. Rows name Botmancers references
only, never a provider id or workspace.

### Session exchanges

The owner can target one session by its reference in two explicit ways
(`lib/session-exchanges.ts`):

- **Ask.** Exactly one read-only conversation turn to the Agent that owns the
  session. It resumes exactly that Session Binding and returns its one answer
  to the origin conversation. Wakes in the answer route nothing.
- **Continue.** First, one read-only turn on the source session produces a
  bounded handoff packet: `objective`, `decisions`, `constraints`, `artifacts`,
  and `open_questions`, as one JSON object. Only after that packet is stored
  does Botmancers launch the destination Agent: a fresh read-only turn in the
  destination conversation (default: the destination Agent's direct thread),
  with no session to resume. The session the destination reports is bound as a
  new Session Binding that the destination owns. That session must be new:
  if the destination reports no session, the source's session, or any session
  already bound, the exchange fails with `destination_session_invalid` and
  nothing is bound. Wakes in the delivery reply route nothing, so the exchange
  ends with that one destination turn. The destination never
  resumes or receives the source provider session ID. Both hops link to one
  exchange.

Each exchange is one `session_exchanges` row plus append-only
`session_exchange_events`. A row holds the mode, the requester, the origin
conversation, the selected source binding and Agent, the destination Agent,
conversation, and binding, the instruction, the state, and set-once
references to the hop Work Requests, hop Attempts, answer message, and packet.
States move `queued -> extracting -> completed` for an Ask, and
`queued -> extracting -> delivering -> completed` for a Continue. Either can
end `failed` or `cancelled` instead. Triggers enforce the edges, the mode
rules (an Ask never delivers; a Continue cannot complete from `extracting`),
and the rule that a terminal exchange never changes. The answer reference must
name the source Agent's message in the origin conversation, produced by the
source hop request, and that message cannot be deleted under its exchange.

- **Hops are Work Requests.** The leased dispatcher runs each hop. A hop has
  the `exchange` entry point, the `session_exchange_conversation` rule
  (`conversation`/`readonly` only), one Attempt, and an allowed `human_owner`
  safety decision for the owner. A source hop continues the binding's own
  conversation and lineage, so the existing resume-scope checks still apply.
  Hop creation, claim, and result projection commit in the same transaction as
  the exchange state they move.
- **Validation.** The source reference must be an active binding of the named
  Agent, bound under the runtime that Agent dispatches today. The Agent must
  have an Agent Deck. A source session runs at most one open exchange at a
  time. Unknown references and other Agents' references get the same
  `session_not_found`. Requests for other authority (`authority_not_allowed`),
  non-owner requesters, and bodies that name another exchange
  (`recursive_exchange`) are refused before anything is written.
- **Limits.** One source and one destination per exchange. The instruction is
  at most 4000 characters. The packet is at most 16000 characters in total: an
  objective of at most 2000, and at most 20 entries of at most 500 characters
  in each list. The raw extraction output is at most 32000 characters; over
  that, the packet is refused. An Ask answer and a delivery reply are each
  stored at most 16000 characters long, including the `[truncated]` marker.
  A hop prompt is at most 24000 characters. A packet, answer, or reply
  that repeats the source provider session ID is redacted.
- **Cancellation and recovery.** Cancelling is allowed only while the
  exchange is non-terminal. The intent is recorded once and the open hop
  request is cancelled. The exchange reads `cancelled` once that hop has
  ended, and nothing launches after it. After any hop ends, and at startup
  (`recoverCoordinatorLoops`), the exchange advances from its hops' durable
  state. An interrupted hop fails the exchange; it is never relaunched.
- **Retry.** A failed exchange stays failed. Replaying its idempotency key
  returns it unchanged. Only a new exchange with a new key retries. Nothing
  loops on its own.
- **Routes.** `POST /api/exchanges` (201 for a new exchange, 200 for a replay),
  `GET /api/exchanges/:id`, and `POST /api/exchanges/:id/cancel` (409
  `exchange_terminal` once terminal). All three sit behind the owner boundary.
  Errors use `{ error: { code, message } }`. Responses carry Botmancers IDs
  only. The MCP bridge and `/api/v0` do not expose exchanges.

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
| Conversation or explanation (including every session exchange hop) | `readonly` | Inspect and answer without changing the workspace |
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
acceptance naming the exact implementation and review Attempts, and submits that
same immutable manifest. Agent Deck owns the host-local
mechanism that discovers the candidate manifest, validates the approved copy, and
creates one audited commit.

Finalization is run-scoped, separately authorized, idempotent, and fail-closed on a
base/ref race, changed pre-existing dirty path, unexpected path, digest mismatch, or
Git lock conflict. Replay and restart of one explicit acceptance reuse its stored
request and idempotency key. After a terminal non-commit, a later explicit acceptance
creates a new auditable request, so a coordinator can retry after an authorization or
transient operational failure; an open or committed finalization still prevents a
second request. It preserves unrelated user changes. Push and PR creation remain
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
3. The request remains queued or becomes blocked with a visible reason. An edit
   Wake without a grant is blocked on the grant first and on availability after the
   owner allows it (see [Wake safety policy](#grants)).
4. Recovery resumes from durable state; it does not depend on an in-memory chain.

## Wake safety policy

Botmancers is local and single-owner. Wake safety is a small fixed policy, not a
multi-tenant authorization system. The implementation contract, caller inventory,
alternatives, and fixtures are in
[the October 14 wake-safety contract](design/2026-10-14-wake-safety-contract.md).

### Principals

| Principal | Authenticated by | Trust |
| --- | --- | --- |
| Human owner (`person:local-owner`) | Loopback boundary: server bound to `127.0.0.1`, loopback `Host`, same-origin mutating request | May message, configure, allow/deny/revoke grants, and Stop. This proves "a same-origin page on this machine", not a user identity |
| Authenticated API principal | The `/api/v0` authenticator: the shipped service-token authenticator when `BOTMANCERS_SERVICE_TOKENS` is configured, or one the operator installs; with neither, the API fails closed | May send direct read-only messages. May not decide grants or act as an Agent |
| Agent principal (`bot:<agentId>`) | The engine: the message is stored with that registered Agent as sender; lineage is tracked when the engine also dispatched the parent Work Request | Identity is trusted; intent is not, because Agent output can be steered by what it read |
| Unknown | — | No attributable identity (failed or missing authentication, foreign origin, non-Agent sender offered to the router). Refused before anything is persisted |

Text that looks like a Wake in a human or API message is only text. An Agent reply
without a dispatched parent Work Request is still an Agent principal, but with
untracked lineage: it cannot start a lineage, and its Wakes are recorded as
rejected (`untracked_lineage`). Every Work Request records its root principal.

### Grants

- `conversation` and `review` Wakes are allowed between registered Agents without
  a grant.
- `implementation` and `revision` Wakes require a durable owner grant for the
  exact (caller Agent, target Agent) pair. Without one, the Wake and its Work
  Request are `blocked` with `grant_required`, and the source conversation offers
  the owner **Allow** (persist the pair grant and re-evaluate availability,
  queuing the request only when the target can launch) or **Deny**
  (cancel this request; the coordinator is told no work ran).
- An Agent the owner messages directly may wake itself for `implementation`
  without a grant. API-rooted and Wake-rooted self-wakes need a grant.
- Checks run in a fixed order and stop at the first unmet one: envelope,
  references, depth, and budget (rejected); target name (unavailable); resume and
  reviewer rules (rejected); **grant** (blocked, `grant_required`); **availability**
  (blocked, `target_unconfigured` or `target_unavailable`). Allow persists the grant
  and re-checks availability: the request is queued only if the target can launch,
  otherwise it stays blocked on availability and `retryWake` queues it later. Deny
  cancels regardless of availability. Retries re-check the grant.
- A grant never expands the target's own Deck, working directory, or the tool
  profile of the execution kind. Revocation affects every Wake not yet accepted. The owner
  can Stop a lineage at any time, cancelling its open requests and pending
  approvals.

### Limits

| Limit | Default | Behavior |
| --- | --- | --- |
| Wake depth | 3 | Agent-to-Agent hops from the root; a continuation runs at the depth of the Agent it continues. Beyond it: Wake rejected, `depth_exceeded` |
| Root budget | 12 | Wake-created Work Requests per root lineage. Beyond it: Wake rejected, `root_budget_exhausted` |
| Coordinator continuations | 24 | Derived as 2 × root budget. Beyond it: the lineage stops, visibly |
| Global concurrency | 4 | Running Attempts. Excess requests stay `queued` |
| Per-target concurrency | 1 | Running Attempts per target Agent. Excess requests stay `queued` |

Concurrency waits are not denials. Envelope `limits` may only narrow these values.

### Refusals

A refusal caused by a known principal (including an Agent with untracked lineage)
is durable and visible: the Wake row keeps its reason code, the source conversation
shows a `wake_rejected` or `wake_blocked` event, and the coordinator, when there is
a parent request to continue, receives one continuation saying no work ran. A
rejected Wake creates no Work Request, so it never projects any `request_*` event.
While blocked, a Wake's Work Request may project only `request_cancelled` (for
example, owner Deny, `grant_denied`); work that did not start never projects an
event implying execution or an outcome (`request_running`, `request_completed`,
`request_failed`, or result text). A refusal of an unknown
principal (missing or failed authentication, foreign origin, non-Agent sender)
returns an error and writes nothing.

## Reliability and provenance

- Create requests idempotently from the source event and target.
- Persist every state transition and attempt boundary.
- Recover `running` work after process restart by reconciling external run state or
  marking the attempt interrupted and retryable.
- Support cancellation and bounded timeouts at the Work Request level.
- Record requesting identity, target Agent, deck, working directory, tool profile,
  adapter, run/session IDs, prompts or prompt hashes, results, and artifacts.
- Enforce the [Wake safety policy](#wake-safety-policy) (principals, grants,
  depth, budget, and concurrency) before launch.
- Never report success from transport acceptance alone; success requires a terminal
  attempt outcome.

## Current code and convergence

The current Agent identity plus Agent Deck model is directionally consistent with
this product. Every unit of work, from every entry point, is a Work Request with
one lifecycle (`queued`, `running`, `waiting`, `blocked`, then `completed`,
`failed`, or `cancelled`) in `work_requests`. A request's `executor` names the
worker that runs it:

- `dispatcher` (`lib/dispatcher.ts`, `lib/agent-conversations.ts`): `/api/v0`
  messages, Wake-created requests, and coordinator continuations. Leases,
  Attempts, restart reconciliation, deadlines, and retries apply.
- `ui_message` and `ui_continuation`: the UI turn executor (`lib/ui-turns.ts`,
  `lib/agent.ts`) runs web UI thread turns one at a time, oldest first. It hosts
  the UI thread features: drafts, approvals, ask-and-wait, one-shots and
  routines, file artifacts, Agent birth, commands, and the legacy `WAKE` and
  group handoffs. A UI message is accepted by the shared conversation intake,
  and the intake transaction itself records its Work Requests for this
  executor (`ui_message`), so no dispatcher can claim them first.
  Turns the executor creates itself (a handoff target, a report-back to the
  caller, a timer tick, a new Agent's greeting, a gateway poke) are
  `ui_continuation` requests whose parent is the turn that caused them. A UI
  message to a coding Agent that reaches launch is handed to the dispatcher
  (`executor` becomes `dispatcher`) and runs as one read-only Attempt. Stop
  cancels the thread's queued turns. On restart, a UI turn left `running` fails
  with `ui_turn_interrupted` and is not run again.

The legacy `WAKE` handoffs keep their Stop, depth, budget, and caller-frame
accounting in `delegation_chains`, one durable row per user message, so a
restart keeps all of it. There is no separate queue table and no delegation
state in process memory.

Resolved since this contract was written:

- NOT-465: UI and `/api/v0` messages share one conversation intake, and the
  pre-NOT-465 `agent_requests` dispatcher is gone.
- NOT-469: one leased dispatcher with restart reconciliation, and global and
  per-target concurrency bounds.
- NOT-471: implementation and revision Wakes launch with edit authority, and
  everything else stays read-only.
- NOT-472: canonical requests no longer reach the composite review path.
  Wake-created requests return to their coordinator through one read-only
  continuation turn (`lib/coordinator-loop.ts`), reviews must target an Agent
  other than the developer, and revisions resume the implementation's Session
  Binding.
- NOT-475: Wake grants, depth, root budget, and the loopback owner boundary are
  enforced.
- NOT-477: the composite implement/review/resume helper is deleted. The
  `agent_requests` lifecycle and the UI loop's `processing_queue` are migrated
  into the canonical tables and archived, and the in-memory delegation-chain map
  is replaced by `delegation_chains` (see [Persistent schema](#persistent-schema)).
- NOT-491: `/api/v0` ships a service-token authenticator, and an MCP bridge at
  `/api/v0/mcp` lets an external agent start a read-only task with an
  allowlisted coordinator and poll it ([MCP bridge](mcp-bridge.md)).

Since NOT-473, Work Requests carry a durable cancellation intent, an absolute
deadline, and a bounded retry policy fixed at intake (`lib/request-policy.ts`,
`lib/work-request-control.ts`). Cancel and retry are idempotent transactional
commands. A request past its deadline fails with reason `timed_out` and never
launches, and a retryable failure retries within the policy's Attempt budget
with deterministic backoff. When a runtime cannot stop an external run, the
Attempt is abandoned and recorded as such, and any later result is kept as
evidence only.

Convergence should preserve existing working adapters while moving orchestration
above them:

| Current area | Intended responsibility |
| --- | --- |
| `lib/agent-conversations.ts` | Conversation events and projections only |
| `lib/agent.ts`, `lib/ui-turns.ts` | UI turn executor: UI thread features over UI turn Work Requests |
| `lib/agent-dispatch.ts` | Runtime adapter selection, not workflow policy |
| `lib/agent-deck-run.ts` | Agent Deck transport and session resume |
| `lib/session-catalog.ts` | Read-only Agent session catalog over Session Bindings (Sessions view) |
| `lib/usage.ts`, `lib/usage-samples.ts` | Provider-reported usage: parsing, aggregation with coverage, and idempotent samples |

### Persistent schema

All tables are SQLite tables in one database. The engine's tables are versioned by
`schema_migrations` (`lib/engine-store.ts`).

| Tables | Role |
| --- | --- |
| `work_requests`, `work_request_transitions`, `work_attempts`, `session_bindings`, `engine_events` | Canonical Work Requests and their transitions, immutable Attempts, opaque Session Bindings, and the per-request event log |
| `conversation_intakes` | One row per accepted message, keyed by the requester's idempotency key |
| `wakes`, `wake_grants`, `wake_safety_decisions`, `terminal_followups` | Wakes, owner grants, safety decisions, and coordinator follow-ups. A follow-up is written only with the terminal transition of a dispatcher-owned request; UI turn executor requests (`ui_message`, `ui_continuation`) never get one, because the executor routes its own replies |
| `dispatch_leases`, `dispatch_attention`, `attempt_launch_intents` | Leased dispatch and restart reconciliation |
| `attempt_finalization_baselines`, `candidate_manifests`, `finalizations` | Reviewed Git finalization |
| `conversation_events`, `conversation_projection_cursors` | Typed projection of engine events into conversations |
| `conversations`, `messages`, `conversation_participants` | Conversations and their ordered history |
| `delegation_chains` | Delegation accounting for UI thread turns: handoffs, delegated turns, Stop, and caller frames per user message |
| `usage_samples` | Provider-reported usage, one sample per Attempt or provider turn (migration 18); removed with the Attempt, registry row, or Agent |
| `session_exchanges`, `session_exchange_events` | Session-targeted Ask and Continue exchanges (migration 16) and their append-only events; removed with the Agent, conversation, hop request, or binding they name |
| `legacy_agent_requests_archive`, `legacy_agent_request_events_archive` | Evidence only. Every pre-NOT-465 `agent_requests` row and its events, verbatim. Nothing reads them except conversation deletion, which removes the conversation's rows (and their events). They exist only in databases that had the legacy tables |
| `legacy_processing_queue_archive` | Evidence only. Every `processing_queue` row, verbatim. Nothing reads it except conversation and Agent deletion, which remove their rows. It exists only in databases that had the queue |

Migration 14 (`retire_legacy_agent_requests`) copies each mappable legacy
request into `work_requests` and keeps its original id in
`legacy_agent_request_id`, so `/api/v0` still serves that id:

- Completed and failed requests keep their outcome.
- Accepted or dispatched requests that could never finish become `failed` with
  `legacy_interrupted`.
- Old idempotency keys replay through `conversation_intakes` when the stored
  payload hash verifies.

Rows that cannot be mapped without guessing stay in the archive only: a missing
conversation, Agent, or accepted message, or a key already held elsewhere.

Migration 15 (`ui_turns_on_work_requests`) adds `work_requests.executor` and
`delegation_chains`, then reconciles each `processing_queue` row:

- A row naming a Work Request that is still `queued` gives it to the UI turn
  executor. Its outcome becomes the request's: `pending` stays `queued`,
  `completed` and `failed` become `completed` and `failed` at the row's times,
  and `processing` becomes `failed` with `ui_turn_interrupted`. A request the
  dispatcher already ran keeps its own outcome.
- A `pending` row without a Work Request becomes one queued `ui_continuation`
  request for the same Agent and conversation.
- Any other row (finished loop bookkeeping, or a missing conversation or
  Agent) stays in the archive only.

Then the table is renamed to `legacy_processing_queue_archive`.

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
