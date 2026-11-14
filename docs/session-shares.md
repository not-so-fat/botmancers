# Session shares: the owner's lifecycle and operations

Status: NOT-519. Code: `lib/session-share-owner.ts` (owner views, policy
writes, sweeper loop), `lib/session-shares.ts` (`sweepExpiredShares`,
`shareInflight`), `app/components/SessionShares.tsx` (Sessions drawer),
`app/components/SharePolicyCard.tsx` (Agent Config), `lib/share-view.ts`, and
the `botmancers doctor` Slack line (`packages/mcp-server/src/product.ts`).
Tests: `npm run test:session-share-owner`, `npm run test:session-share-ui`,
and `packages/mcp-server/test/product.test.mjs` (doctor). Proof:
`scripts/seed-shares-fixture.js` + `scripts/ui-session-shares-proof.js`.
Design: [`design/2026-10-24-session-share-preflight.md`](design/2026-10-24-session-share-preflight.md)
§6 child 5. Builds on [`service-access.md`](service-access.md) (Session
shares, Share the current session), [`slack-relay.md`](slack-relay.md), and
[`slack-transport.md`](slack-transport.md).

A share lets people in one allowlisted Slack channel ask one Botmancers
session questions, read-only, until it expires, runs out of questions, or the
owner revokes it. This page is the owner's side: where shares are created,
inspected, and revoked; how the policy is set; how expiry is cleaned up; and
how to tell whether Slack is connected.

## From a session (Sessions drawer)

Every row of an Agent's Sessions drawer has a **Slack share** section.

- **Share to Slack** appears only when the session can take an Ask now (the
  same answer as *Ask from this context*: not ended, missing, not resumable,
  or busy) and the allowlist names at least one channel. Otherwise the
  section says why, and links to Agent Config when the allowlist is the
  reason. The form names the exact session and Agent and asks for a channel
  from the allowlist, a duration (5 minutes, 1 hour, 8 hours, 24 hours), how
  many questions are allowed (1–100, default 20), and **Tool access**:
  - **Read only** (default): the session reads files and answers.
  - **Full access**: the session's turns may edit files, run shell commands,
    and use the network on this computer, as the owner. Offered only for
    Claude Code and Codex Agents (the runtime must enforce it; otherwise the
    option is disabled with the reason). The form shows what is being
    granted before it is created. It is fixed for the share's lifetime: to
    change it, revoke and share again.

  Only the owner sets tool access, here. A service (`/api/v0/shares`, MCP
  `botmancers_create_share`) or a turn sharing its own session gets
  `403 authority_not_allowed` for `tool_access`; those shares are always
  read-only. The Agent's launch policy is not consulted: the share is the
  owner's explicit grant for that one session.
  Busy means a Claude Code process is working in the session (*a Claude
  Code process is working in this session*). A Claude Code CLI that is
  still open on the session but idle at its prompt does not block sharing;
  the open form says so in one line: "If Claude Code is still open on this
  session, don't type in it while the share is live. It won't see the Slack
  questions."
- Each share shows its **status**, expiry, questions used, the Slack channel
  and workspace ids, whether its Slack thread has been posted, its
  reference, and who made it. Status is one of:

  | Status | Meaning | The next Slack question |
  |---|---|---|
  | Active | live | is answered by the session |
  | Answering | a question is running | waits (`share_turn_in_progress` notice) |
  | Recovering | a question was claimed by an earlier Botmancers process and never sent | clears the claim and is answered |
  | Questions used | `turns_used = max_turns` | gets the limit notice |
  | Expired | past `expires_at` | gets the expired notice |
  | Revoked | revoked by the owner (or a service) | gets the revoked notice |

- **Copy reference** copies the `shr_…` reference (what `botmancers_get_share`
  and the service routes take). **Revoke** asks for confirmation; it detaches
  the share's Ask pin in the same commit, so the next question in its Slack
  thread gets the fixed `share_revoked` notice. A revoked or expired share
  stays listed; its history is never deleted.

Nothing in this section shows a provider session id, working directory, Deck,
runtime, token, or transcript.

## From Agent Config (Session sharing)

- **Share from a turn** (`share_from_turn`): an explicit per-Agent switch.
  On, a turn Botmancers launches for the Agent can share its own session
  (NOT-517 share-current). Off, no context is minted, and **turning it off
  revokes every live context of the Agent in the same request** (the answer
  reports how many). Claude Code and Codex Agents support it; for Cursor and
  other runtimes it is disabled with the reason, and sessions are shared from
  the Sessions drawer instead.
- **Slack channel allowlist**: the exact `(workspace T…, channel C…/G…)` pairs
  every share must use, for every Agent. Malformed ids, wildcards, and
  duplicates are refused before anything is written. Removing a channel stops
  its threads being answered (the relay drops channels off the list).

Both live in `config/session-shares.json` (NOT-515 format, owner-only 0600).
The card writes it through `PUT /api/bots/{id}/share-policy`, which:

- carries the `revision` the owner was looking at; if the file changed since
  (another tab, a hand edit), it answers `409 policy_conflict` and writes
  nothing — reload and apply again;
- builds the whole new document and validates it with the store's own parser
  before writing; any problem is `400` and nothing is written;
- writes atomically (temporary 0600 file, then rename), so a reader never sees
  a partial document and a restart reads the same policy;
- refuses to overwrite a hand-broken file (`409 policy_invalid`; the card
  shows the parser's reason). Entries for Agents that were deleted are
  pruned on the next write.

## Owner routes

Behind the loopback owner boundary (`proxy.ts`): a non-loopback host, or a
mutating request without same-origin proof, is `403 owner_origin_required`.
These routes also refuse any request carrying a service credential (an
`Authorization` header or a `Botmancers-Session-Context` header): services
use `/api/v0/shares` and see only their own shares.

| Route | Does |
|---|---|
| `GET /api/shares?session_ref&agent_id&state&cursor&limit` | every share, newest first; `limit` 1–100 (default 50); opaque `next_cursor` |
| `POST /api/shares/{share_ref}/revoke` | idempotent: `200 { share, replayed }`; `404 share_not_found` |
| `GET /api/bots/{id}/sessions/{ref}/shares` | that session's shares (`state`, `cursor`, `limit` only) |
| `POST /api/bots/{id}/sessions/{ref}/shares` | `{ audience: { team_id, channel_id }, ttl_seconds?, max_turns?, tool_access?: "read_only" \| "full_access", idempotency_key }` → `201`; exact replay `200`; same key, other body `409 idempotency_conflict`; off the allowlist `403 audience_not_allowed`; full access on a runtime that cannot enforce it `403 authority_not_allowed`; unknown or another Agent's session `404 session_not_found` |
| `GET` / `PUT /api/bots/{id}/share-policy` | the policy view / `{ revision, share_from_turn?, audiences? }` |

The owner view: `share_ref, agent { id, name }, session_ref, authority,
tool_access, state, status, audience, created_via, created_by, created_at, expires_at,
revoked_at, max_turns, turns_used, thread { posted, posted_at }`. Owner-made
shares are created by `person:local-owner`.

## Expiry: the sweeper

An expired share already refuses every question. The sweeper
(`sweepExpiredShares`) also detaches its Ask pin, so nothing can be sent on it
by any path:

- it selects only shares that are `active` in the row, past `expires_at`, and
  whose pin is still attached: an active share and a revoked share are never
  touched, and a swept share is never selected again (idempotent);
- it changes neither the share row nor its events: a swept share still reads
  **expired**, not revoked. It appends one `shares.expire` row
  (`service:botmancers-session-share`, `allowed`, code `expired`) to the
  service audit per share;
- a turn already running when its share expires still finishes, and its
  answer is still posted (a detached pin keeps its turns readable);
- the core server runs it at start — so shares that expired while Botmancers
  was stopped are cleaned up on restart — and then every minute
  (`instrumentation.ts`). The owner list routes also run it before listing.

## Slack health: `botmancers doctor`

`botmancers doctor` prints one `slack` line. With the product running it reads
the core's `GET /api/health` `slack` field (`lib/slack-runtime`); it never
posts to the core and never calls Slack. Stopped, it only says whether the
two tokens are present in `core.env` or the environment. Token values are
never printed, and a reason that is not a plain lowercase code is not echoed.

| Core state | Line |
|---|---|
| no tokens | `info  slack  Slack relay disabled (no Slack tokens configured)…` |
| one token, malformed token, no or invalid allowlist, workspace not allowlisted | `warn  slack  Slack relay misconfigured (<reason>); <fix>, then restart` |
| auth or connect failed | `warn  slack  Slack relay failed (<reason>); <fix>` |
| connecting | `info  slack  Slack relay connecting to Socket Mode` |
| connected | `ok    slack  Slack relay connected over Socket Mode (N reconnects since start)` |
| reconnecting | `warn  slack  Slack relay reconnecting to Socket Mode…` |

Slack is optional: no Slack state fails doctor.

## Operator check (real workspace)

With the tokens in `core.env` and the bot invited to an allowlisted channel:

1. `botmancers doctor` shows `ok slack … connected`.
2. Sessions → a session → **Share to Slack** → the channel. The share reads
   Active, then *Slack thread posted* once the relay anchors it.
3. Reply in that thread with a question; the answer arrives in the thread
   and the share shows `1 of N questions used`.
4. **Revoke** → confirm. Reply again: the thread gets *"This shared session is
   no longer available (the owner revoked the share)."* and the session gets
   no turn.

Record the redacted transcript with the HEAD SHA; it must show no provider
session id, workspace, session_ref, Agent id, or token.

## Limits and non-goals

The Sessions drawer loads an Agent's newest 100 shares. There is no Slack
OAuth or Marketplace installation, no multi-workspace administration, no
public invite link, and no write authority for Slack users.
