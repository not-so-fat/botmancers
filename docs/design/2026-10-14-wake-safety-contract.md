# Wake safety: principals, grants, and limits

Status: **proposed — awaiting product-owner approval** (see [Approval](#approval)).
Merging the PR that introduces this document is the accepted revision.

Date: October 14, 2026

Ticket: NOT-474

Authority: [Botmancers core engine](../core-engine.md), section *Wake safety policy*

Fixtures: [`contracts/wake-safety-v1.fixtures.json`](../contracts/wake-safety-v1.fixtures.json)

## Decision

Botmancers is a local, single-owner product. The smallest policy that bounds
runaway delegation without importing a multi-tenant authorization system is:

1. **Four principal types**, each with a stated trust boundary: the human owner,
   an authenticated API principal, an Agent principal, and unknown. Identity is
   never stronger than the transport that carries it.
2. **Read-only Wakes are allowed by default; edit Wakes need an owner grant.**
   `conversation` and `review` Wakes between registered Agents need no grant.
   `implementation` and `revision` Wakes need a durable edit grant for the exact
   (caller Agent, target Agent) pair. The first such Wake without a grant waits,
   visibly, for the owner to allow or deny it. One exemption: an Agent the owner is
   talking to directly may wake itself for implementation.
3. **Four limits**: wake depth **3**, root budget **12** Wake-created requests,
   global concurrency **4** running Attempts, per-target concurrency **1** running
   Attempt. The coordinator continuation cap is derived, not a fifth setting:
   2 × root budget = **24**.
4. **Every refusal is recorded and shown.** A denied, exhausted, or unattributable
   Wake creates a durable Wake row and a visible conversation event, never a
   request lifecycle that implies work ran. Unauthenticated HTTP requests are
   refused before anything is persisted.

## Caller inventory

Every way a caller reaches the engine today, mapped to a principal type. Paths are
relative to the repository root.

| Caller | Route or code path | Today | Principal type | Trust boundary |
| --- | --- | --- | --- | --- |
| Web UI message | `POST /api/conversations/[id]/messages` → `lib/conversation-intake.ts` | Hard-coded `UI_OWNER_PRINCIPAL` (`person:local-owner`); no check | **Human owner**, *only* within the loopback boundary below | Whoever can reach the port. `next dev`/`next start -p 43123` listen on every interface, so today any LAN host is "the owner" |
| UI approve/deny, Stop, draft | `app/api/conversations/[id]/{approve,deny,stop,draft}`, `.../messages/[messageId]/stop` | Unauthenticated | **Human owner** (same boundary) | Same as above; these are the override and recovery controls |
| Agent configuration | `app/api/bots/**` (create, rename, config, skill, import, manage, delete), `app/api/groups`, `app/api/mcp`, `app/api/agent-deck/**`, `app/api/files/[name]` | Unauthenticated | **Human owner** (same boundary) | Same as above. These surfaces name Wake targets (Agent names, Deck, working directory, imported instructions) |
| Marketplace handoff | `app/api/marketplace-handoff/**`, `app/api/import-capabilities` | Unauthenticated | **Human owner** (same boundary) | Redirect/import helpers; cannot wake |
| Agent conversation API | `POST /api/v0/agents/{agentId}/messages`, `GET /api/v0/conversations/{id}`, `GET /api/v0/requests/{id}` → `lib/agent-api.ts` | Injected authenticator; none ships, so every call fails `authentication_unavailable` (503) | **Authenticated API principal** (`person`, `bot`, or `service` as the authenticator vouches) | Exactly as strong as the operator-installed authenticator. A body-declared principal is never trusted |
| Canonical Agent reply Wakes | `lib/coordinator-loop.ts` `continueAfterTerminal` → `lib/wake-router.ts` `routeAgentWakes(sourceEventId, parentRequestId)` | Requester derived from the reply's sender and checked against the parent Work Request | **Agent principal** | Identity is strong (engine-derived from a request the engine dispatched). Intent is untrusted: Agent output can be steered by anything the Agent read |
| Legacy Agent reply Wakes | `lib/agent.ts` `parseWakeDirectives`, `handleHermesWakeTurn`, group handoffs; in-memory `delegationChains` | Caller = the bot whose queue turn it was; lineage in process memory; `conversation` only | **Agent principal, legacy lineage** | Identity from the queue item; lineage lost on restart. Bounded by `DELEGATION_MAX_*` only |
| Coordinator continuations | `lib/coordinator-loop.ts` `continuation()` | `service:botmancers-engine` requester | **Engine (internal)** — not a Wake caller | Never emits Wakes itself; the coordinator's reply to a continuation is an Agent-principal reply |
| Timers and routines | `lib/agent.ts` `fireTimerTick`, `armRoutine`, `armDurableOneShot` | Queue turns with no request row | **Human owner (scheduled)** | The owner configured the schedule; runs as one read-only turn |
| Outbound adapters | Hermes gateway (`HERMES_API_SERVER_KEY`), Agent Deck run API (`AGENT_DECK_RUN_TOKEN`) | Botmancers authenticates *to* them | not a caller | No inbound callback reaches the engine |
| Text that looks like a Wake in a human or API message | Intake stores it as message content | Never parsed as a Wake (`routeAgentWakes` requires a bot sender) | **Unknown** if it were treated as a Wake | Must stay text |
| Agent message with no dispatched parent request | `routeAgentWakes` without `parentRequestId` | Starts a fresh lineage at depth 0 | **Unknown / unattributed** | A fresh root would reset depth and budget, so such Wakes must not route |
| Anything else (foreign origin, failed authenticator) | — | — | **Unknown** | Refused before persistence |

Target-naming surfaces a builder must keep consistent with grants: the Wake
`target` name, `resumeWorkRequest` and `contextWorkRequests` references, UI
`@mention` and `mentionedBotId`, `/api/v0` `agentId`, Agent rename, Agent import,
and legacy group handoff text. Grants key on stable Agent IDs, so a rename never
moves a grant to a different Agent, and a retried `unavailable` Wake is grant-checked
against whatever Agent its name resolves to at retry time.

## Principals

| Principal | Recorded as | Authenticated by | May | May not |
| --- | --- | --- | --- | --- |
| Human owner | `person:local-owner` | **Loopback boundary**: server bound to `127.0.0.1`, `Host` is `127.0.0.1:<port>` or `localhost:<port>`, and every mutating request is same-origin (`Origin` matches, or `Sec-Fetch-Site: same-origin`) | Send messages; allow, deny, revoke grants; Stop any lineage; configure Agents | — |
| Authenticated API principal | `{kind, id}` from the authenticator | The operator-installed `/api/v0` authenticator | Send direct (read-only) messages to Agents it may reach; read conversations it participates in | Allow, deny, or revoke grants; act as an Agent principal for Wakes (a `bot`-kind API principal is still an API principal) |
| Agent principal | `bot:<agentId>` on the Wake row | The engine: the reply was produced by a Work Request it dispatched to that Agent | Emit Wakes within grants and limits | Approve its own or anyone's grant; declare caller, grant, budget, or tool profile |
| Unknown | not persisted as a principal | — | Nothing | Write any row, launch anything |

The loopback boundary is honest about what the transport proves: "a process on this
machine, via a same-origin page." It is not user authentication. Exposing
Botmancers beyond loopback is an operator decision that requires installing an
authenticator first and is out of scope here.

Every Work Request records its **root principal** (the principal of the intake that
started its lineage) so audits and the self-wake rule can tell owner-rooted work
from API-rooted work.

## Grant default for Agent-to-Agent Wakes

| Model | Usability (Flows A, B, C) | Escalation risk | Migration impact |
| --- | --- | --- | --- |
| **A. Default-allow** (today) | Best: no prompts | High: one steered read-only turn (a researcher reading hostile text) can emit an `implementation` Wake and gain edit authority in another Agent's workspace | None |
| **B. Default-deny, owner pre-configures pairs** | Poor: Flow B fails until the owner finds a settings surface that does not exist yet (and the config UI is out of scope); Flow A unaffected | Lowest | Breaking: every existing coordinator stops delegating |
| **C. Owner approval on first use, every kind** | Fair: Flow B prompts for Dev *and* reviewer; every read-only consult prompts too | Low | Non-breaking, but noisy for harmless reads |
| **D. Read-only default-allow; edit needs a pair grant approved on first use** *(recommended)* | Good: Flow A unchanged; Flow B prompts once per coordinator–developer pair, ever; reviewers never prompt; Flow C unchanged | Low where it matters: the only escalation (read-only → edit) needs the owner once per pair; read-only fan-out is bounded by depth, budget, and concurrency | Non-breaking: the first edit Wake per pair after upgrade waits for one click |

Recommendation: **D**.

Rules:

- `conversation` and `review` Wakes: allowed between any two registered Agents.
  Recorded `grant_rule: "readonly_default"`.
- `implementation` and `revision` Wakes: allowed when an unrevoked
  `edit` grant exists for (caller Agent ID, target Agent ID). Recorded
  `grant_rule: "edit_grant"` with the grant ID.
- **Self-wake exemption:** an `implementation` Wake whose target is the caller is
  allowed without a grant when its parent request is a direct message from the
  human owner (root principal `person:local-owner`, wake depth 0). Recorded
  `grant_rule: "owner_direct_self_wake"`. An API-rooted or Wake-rooted self-wake
  needs a grant like any other edit Wake.
- A grant never expands the target's authority: the target still runs with its own
  Deck, working directory, and the tool profile of the execution kind.
- Revoking a grant affects only Wakes routed afterwards. Accepted requests keep
  their frozen policy snapshot. Deleting either Agent deletes its grants.

### Human override and recovery

When an edit Wake has no grant, the Wake is recorded `blocked` with
`reason_code: "grant_required"` and its Work Request is created in `blocked`. The
source conversation shows the blocked Wake with two owner actions:

- **Allow** — persists the (caller, target, `edit`) grant, records
  `grant_approved`, and moves the request `blocked → queued`. Later edit Wakes for
  the pair route without asking.
- **Deny** — records `grant_denied`, moves the request `blocked → cancelled` with
  reason `grant_denied`, and creates no grant. The cancellation returns to the
  coordinator through the existing result continuation, so it is told no work ran.

Pending approvals do not expire; they hold one unit of the root budget until
decided or until the owner presses **Stop**, which cancels every open request in
the lineage (including pending approvals) with reason `stopped_by_owner`. The owner
can **Revoke** a grant at any time (a minimal owner-only route; no configuration
page redesign).

## Limits

| Limit | Default | Counts | When reached |
| --- | --- | --- | --- |
| Wake depth | **3** | Agent-to-Agent hops from the root request. A root intake request is depth 0; a Wake-created request is its parent turn's depth + 1; a coordinator continuation runs at the depth of the Agent it continues | New Wake `rejected`, `depth_exceeded` |
| Root budget | **12** | Wake-created Work Requests in one root lineage, in any state, including blocked and cancelled | New Wake `rejected`, `root_budget_exhausted` |
| Coordinator continuations | **24** (= 2 × root budget, derived) | Continuation requests in one root lineage | No further continuation; lineage stops with `continuation_budget_exhausted` |
| Global concurrency | **4** | Running Attempts across all adapters and lineages | Request stays `queued` (not a denial) |
| Per-target concurrency | **1** | Running Attempts per target Agent | Request stays `queued` (not a denial) |

Why these numbers:

- **Depth 3** covers Flow B at depth 1 (Tank → Dev, Tank → reviewer, Tank → Dev
  revision are all depth 1 because each result returns to Tank at depth 0), a
  self-wake at depth 1, and one level of sub-delegation with headroom. It equals the
  existing legacy `DELEGATION_MAX_DEPTH`. The router's current depth (48) counts
  continuations as hops, so it really measured loop length; the root budget now
  does that job.
- **Budget 12** allows implementation + review + five revision/review rounds in one
  root. Past that the owner should be involved anyway. Request count, not cost:
  token or payment metering is out of scope.
- **Global 4** keeps a laptop responsive with several coding Agents; **per-target 1**
  avoids two sessions editing one working directory and keeps one Agent's
  conversations ordered. Because a coordinator's turn ends before its Wakes route,
  no turn waits on another, so per-target 1 cannot deadlock.
- Admission is FIFO by request creation time among requests whose target has a free
  slot; a busy target does not block other targets.
- Envelope `limits` stay narrowing hints only and never raise any value above.

The previous per-root open-request cap (`WAKE_MAX_OPEN_REQUESTS = 16`) is retired:
global and per-target concurrency plus the root budget bound the same thing.

## Denied, exhausted, and unknown behavior

Principle: refuse before launch, persist the refusal where a trusted principal
caused it, show it in the source conversation as *not started*, and tell the
coordinator.

| Situation | Wake row | Work Request | Conversation shows | Coordinator | Audit |
| --- | --- | --- | --- | --- | --- |
| Edit Wake, no grant | `blocked`, `grant_required` | created `blocked` | `wake_blocked`: "Wake blocked: Dev — needs your approval for edit work" with Allow / Deny | nothing until decided | `grant_requested` engine event |
| Owner allows | `accepted` | `blocked → queued` | `wake_accepted`, then normal lifecycle | normal result return | `grant_approved` + grant row |
| Owner denies | stays `blocked`, `reason_code` → `grant_denied` | `blocked → cancelled`, reason `grant_denied` | `request_cancelled`: "Cancelled: owner denied edit Wake" | one result continuation saying no work ran | `grant_denied` |
| Depth reached | `rejected`, `depth_exceeded` | none | `wake_rejected`: "Wake not started: Dev — depth limit 3 reached" | one `[Wake not started]` continuation | Wake row with `limit`, `observed` |
| Root budget reached | `rejected`, `root_budget_exhausted` | none | `wake_rejected`: "Wake not started: Dev — this work already used 12 Wakes" | same | same |
| Continuation cap reached | — | none | `lineage_stopped`: "Stopped: coordinator continuation limit 24 reached" | not continued | engine event on the last request |
| Waiting for capacity | `accepted` | `queued` | `request_queued` with `data.waiting_for: "capacity"` | — | — |
| Agent reply with no dispatched parent request | `rejected`, `unattributed_wake` | none | `wake_rejected`: "Wake not started: its source turn is not tracked work" | none (no parent to continue) | Wake row |
| Wake-like text in a human or API message | none | none | the message text only | — | — |
| `/api/v0` with no authenticator | none | none | nothing (no trusted conversation) | — | HTTP 503 `authentication_unavailable`; server log |
| `/api/v0` authentication fails | none | none | nothing | — | HTTP 401 `unauthenticated`; server log |
| API principal tries to allow/deny/revoke | none | unchanged | unchanged | — | HTTP 403 `owner_required` |
| UI route from a foreign origin or host | none | none | nothing | — | HTTP 403 `owner_origin_required`; server log |

Unknown principals never write durable rows: persisting attacker-supplied input
would let an unauthenticated caller fill the database or forge history. Refusals by
known principals are always durable.

`wake_rejected` is a new conversation event kind projected from the Wake row, not
from a Work Request, so a refused Wake never appears with `request_*` lifecycle
text. Existing `limit_exceeded` rows remain readable and project as
`wake_rejected`.

Machine-checkable cases for every row above are in the
[fixtures](../contracts/wake-safety-v1.fixtures.json).

## Audit evidence

Each Wake-created Work Request's `policy_snapshot` gains:

```json
{
  "safety_version": 1,
  "root_principal": { "kind": "person", "id": "local-owner" },
  "wake_depth": 1,
  "grant_rule": "edit_grant",
  "grant_id": "grant-tank-dev-edit",
  "root_budget": { "used": 3, "limit": 12 }
}
```

New durable records:

- `wake_grants(id, caller_agent_id, target_agent_id, authority = 'edit',
  granted_by_kind, granted_by_id, source_wake_id, created_at, revoked_at,
  revoked_by_kind, revoked_by_id)`, unique on unrevoked (caller, target, authority).
- Engine events `grant_requested`, `grant_approved`, `grant_denied`,
  `grant_revoked`, `lineage_stopped`, each naming the Wake, grant, and deciding
  principal. No prompt text or credentials.
- `work_requests.wake_depth` and `work_requests.root_principal_kind/id`.

## Migration

- **Existing Agents:** no grants are seeded. The first edit Wake per
  (coordinator, developer) pair after upgrade waits for one owner Allow. Seeding
  from history was rejected: those pairs were never owner-approved, and seeding
  would bless anything a steered Agent did before this policy existed.
- **In-flight work:** requests accepted before the upgrade keep their frozen
  policy snapshot and run unchanged. New checks apply to newly routed Wakes and to
  retries of `unavailable` Wakes (which create new requests).
- **Lineage columns:** backfill `wake_depth` by walking each request's parent chain
  (Wake-created: parent turn + 1; continuation: depth of the Agent it continues;
  intake: 0) and `root_principal` from the root request's requester. Rows that
  cannot be resolved get depth 0 and root principal `unknown`, which disables the
  self-wake exemption for them.
- **Constants:** `WAKE_MAX_DEPTH` 48 → 3 (new depth semantics),
  `WAKE_MAX_SPECIALIST_REQUESTS` 24 → 12, `WAKE_MAX_OPEN_REQUESTS` removed,
  `COORDINATOR_MAX_CONTINUATIONS` 32 → 24. Legacy `DELEGATION_MAX_DEPTH` stays 3;
  `DELEGATION_MAX_DELEGATED_TURNS` 8 → 12 so the legacy path tells the same story
  until it converges.
- **Legacy Wake path** (`lib/agent.ts`): stays `conversation`-only and needs no
  grant. Its in-memory chain is replaced by Work Requests in the convergence work
  already listed in the core engine; until then it is bounded by the legacy
  constants above.
- **Network exposure:** `dev` and `start` bind `-H 127.0.0.1`. Anyone currently
  reaching Botmancers from another host loses access until an authenticator exists;
  this is intentional.
- **`/api/v0`:** unchanged. Still fails closed without an operator authenticator.
  API principals gain no grant authority.

## Builder checklist

Each item is one testable slice; none needs a new policy decision.

1. Loopback boundary: bind scripts to `127.0.0.1`; reject non-loopback `Host` and
   cross-origin mutating requests on every UI route with 403
   `owner_origin_required` before reading the body.
2. Lineage: add `wake_depth` and `root_principal` columns with backfill; route
   Wakes only with a dispatched parent request (`unattributed_wake` otherwise).
3. Limits: depth 3 and root budget 12 in `lib/wake-router.ts` with distinct reason
   codes; continuation cap 24 in `lib/coordinator-loop.ts` with
   `lineage_stopped`.
4. Grants: `wake_grants` table, `grant_required` blocking, owner-only
   allow/deny/revoke routes, self-wake exemption, policy-snapshot fields.
5. Projection: `wake_rejected` and `lineage_stopped` event kinds; Allow/Deny
   actions on `grant_required` blocked Wakes.
6. Admission: global 4 and per-target 1 running Attempts with FIFO admission
   across `startAgentDispatch` callers, including restart recovery.
7. Fixtures: drive each case in `wake-safety-v1.fixtures.json` through the real
   router, loop, and projection.

## Non-goals

Authentication or authorization code in this change; organization or multi-tenant
roles; payment or token metering; cloud runner security; Agent configuration UI
redesign.

## Approval

The product owner approves this contract by accepting this document revision or
commenting approval on the PR. Values to confirm:

- [ ] Grant default **D**: read-only Wakes default-allow; edit Wakes need a durable
      per-pair grant approved on first use; owner-direct self-wake exempt.
- [ ] Override and recovery: **Allow** creates a durable pair grant (no one-time
      option); **Deny** cancels only this Wake; pending approvals never expire;
      **Stop** cancels the lineage; **Revoke** is available any time.
- [ ] Wake depth **3**.
- [ ] Root budget **12** Wake-created requests (continuation cap derived as **24**).
- [ ] Global concurrency **4** running Attempts.
- [ ] Per-target concurrency **1** running Attempt.
- [ ] Loopback-only binding is the owner boundary; non-loopback use waits for an
      authenticator.
- [ ] No grant seeding on migration.
