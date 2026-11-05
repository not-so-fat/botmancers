# Typical user flows

**Status:** Living map · **Owner of:** the end-to-end journeys a person (or an agent acting for them) takes through Botmancers · **Last aligned:** 2026-11-04 (botmancers 0.8.0)

This file answers one question: *what do people actually do with Botmancers, start to finish?* Other docs own the details of each step ([core-engine.md](core-engine.md) for the engine contract, [mcp-bridge.md](mcp-bridge.md) and [service-grants.md](service-grants.md) for the MCP tools and grants, [session-shares.md](session-shares.md) and [slack-transport.md](slack-transport.md) for sharing and Slack, [packages/mcp-server/README.md](../packages/mcp-server/README.md) for install and commands). This file owns the **sequence**.

**Rule:** a flow links to the owner doc for every fact. It never restates tool schemas, flags, or file layouts. Flow IDs never change; a retired flow stays with a note.

## The idea in one paragraph

A coding agent's past sessions hold knowledge: why a design was chosen, what was tried, what is still open. Botmancers keeps those sessions reachable. The owner registers an **Agent** over a local runtime (Claude Code, Codex, Cursor, Muse) and chooses which workspaces and sessions it may touch. Then someone else can **ask that session a question** and get an answer with the session's context: the owner from the UI, another coding agent over MCP, or people in a Slack thread. An Agent can also hand work to another Agent. Every path is bounded by the owner's grants and shares, and the caller never sees provider session ids, working directories, or credentials.

## Actors

| Actor | Who |
|-------|-----|
| **Owner** | The person on whose Mac Botmancers runs. Registers Agents, sets scope, grants access, creates shares. Single-user, local-first. |
| **Agent** | A registered coding agent: a name, a runtime connection, a session scope, a policy. Its turns run as local sessions of its own provider CLI. |
| **Caller** | Another coding agent (Claude Code, Codex, Cursor, any MCP client) that reaches Agents through the MCP bridge with the owner's grants. |
| **Asker** | A person in an allowlisted Slack channel who asks a shared session questions in a thread. |

## Flow index

| ID | Flow | Status | Verified by |
|----|------|--------|-------------|
| [F1](#f1-install-and-start-botmancers) | Install and start Botmancers | Shipped | `release:check` canary installs; registry smokes |
| [F2](#f2-register-an-agent-over-your-local-sessions) | Register an Agent over your local sessions | Shipped | `npm run test:acceptance` |
| [F3](#f3-ask-or-continue-a-past-session-from-the-ui) | Ask or Continue a past session from the UI | Shipped | `npm run smoke:direct` |
| [F4](#f4-let-another-coding-agent-ask-a-past-session) | Let another coding agent ask a past session | Shipped | `npm run test:mcp-bridge`, `test:service-grants` |
| [F5](#f5-share-a-session-to-a-slack-thread) | Share a session to a Slack thread | Shipped (operator smoke) | `npm run test:slack-relay`, `smoke:slack-relay` |
| [F6](#f6-let-a-running-agent-share-its-own-session) | Let a running Agent share its own session | Shipped (Claude Code, Codex) | `smoke:not-517-share-current` |
| [F7](#f7-hand-work-from-one-agent-to-another) | Hand work from one Agent to another | Shipped | `npm run smoke:direct` |
| [F8](#f8-review-and-message-an-agents-conversations) | Review and message an Agent's conversations | Shipped | `npm run test:agent-conversations-ui-api` |

Adjacent, not owned here: Agent Deck is no longer part of execution as of 0.7.0 (Agents launch direct); Hermes is the optional persistent conversation runtime ([core-engine.md](core-engine.md)).

---

## F1. Install and start Botmancers

- **Actor / goal:** Owner, new machine. Get the UI, engine, and MCP bridge running.
- **Trigger:** The owner wants to try Botmancers.
- **Preconditions:** macOS or Linux, Node.js 20.9+ (22+ recommended), npm.

| # | Owner does | Observable result |
|---|------------|-------------------|
| 1 | Run the managed install (`curl … install.sh \| bash`, see [Quick start](../packages/mcp-server/README.md#quick-start-the-full-product)) | `botmancers --version` prints the version; the launcher is at `~/.local/bin/botmancers` |
| 2 | `botmancers setup` | `~/.botmancers` exists (owner-only) with a service token digest and an MCP token |
| 3 | `botmancers start --daemon --open` | Browser opens the UI at `http://127.0.0.1:3333`; the bridge listens on `http://127.0.0.1:3332/mcp` |
| 4 | `botmancers doctor` | `result: ok`; missing provider CLIs or Hermes show as warnings only |

- **Success:** `botmancers status` reports `healthy` with the core and bridge on the same version.
- **Common failures:** a port in use (`start` exits 6), `~/.local/bin` not on `PATH`, no provider CLI installed (warning; Agents cannot launch until one is).
- **Owner docs:** [packages/mcp-server/README.md](../packages/mcp-server/README.md), [RELEASING.md](../packages/mcp-server/RELEASING.md).

## F2. Register an Agent over your local sessions

- **Actor / goal:** Owner. Make a coding agent's past and future sessions reachable, inside a boundary the owner chose.
- **Trigger:** The owner wants others to be able to ask what an agent already knows.
- **Preconditions:** F1 done; the provider CLI (`claude`, `codex`, `cursor`, or `muse`) installed and signed in.

| # | Owner does | Observable result |
|---|------------|-------------------|
| 1 | In the UI, **New Agent** | The registration form opens |
| 2 | Pick the **runtime connection** (for example `Claude on this computer`) | The Agent is tied to that local runtime; Settings shows the runtime as available |
| 3 | Choose the **session scope**: workspaces, selected sessions, or all sessions the runtime can see | The Agent's Sessions drawer lists the sessions inside that scope |
| 4 | Set the optional default workspace and the **policy** (`Read only` or `Workspace write`; may start new sessions; may resume with edits) | The Agent appears in the roster with its connection |

- **Success:** the Agent is launchable and its Sessions drawer shows recognizable titles and Botmancers session references.
- **Common failures:** an empty scope never means unrestricted, so the Agent stays unlaunchable until a scope is chosen; a missing CLI or connection fails closed naming the fix.
- **Owner docs:** [README](../README.md), [core-engine.md](core-engine.md), [claude-session-provider.md](claude-session-provider.md), [integrations/codex-direct.md](integrations/codex-direct.md), [providers/cursor.md](providers/cursor.md).

## F3. Ask or Continue a past session from the UI

- **Actor / goal:** Owner. Get an answer from a past session, or pick its work back up.
- **Trigger:** The owner remembers that an earlier session knew something.

| # | Owner does | Observable result |
|---|------------|-------------------|
| 1 | Open the Agent's **Sessions** drawer and pick a session | The row shows its title and session reference |
| 2 | **Ask** a question from that context | A read-only turn runs in that exact session; the answer appears in the conversation |
| 3 | Or **Continue** with the session | The work resumes in the same session (needs a policy that allows edits) |

- **Success:** the answer comes from the named session, not a fresh one, and the thread shows which session answered.
- **Common failures:** an ended, missing, or busy session cannot take an Ask and the drawer says why.
- **Owner docs:** [wake-contract-v1.md](wake-contract-v1.md), [core-engine.md](core-engine.md).

## F4. Let another coding agent ask a past session

- **Actor / goal:** Caller (for example the owner's other coding agent). Pull knowledge from an Agent's session without the owner copying anything.
- **Trigger:** A coding agent working on related code needs context a past session has.
- **Preconditions:** F1 and F2 done; the owner has granted the caller access to that Agent.

| # | Who does | Observable result |
|---|---------|-------------------|
| 1 | Owner: `botmancers setup --client codex\|cursor\|claude` | The client is connected to the bridge and gets the collaboration skill ([Client setup](../packages/mcp-server/README.md#client-setup-and-the-collaboration-skill)) |
| 2 | Owner: grant that caller the capabilities it needs on that Agent ([service-grants.md](service-grants.md)) | `botmancers_capabilities` lists the granted Agents and operations |
| 3 | Caller: `botmancers_list_agents`, then `botmancers_list_sessions` | Granted Agents and their sessions by title and Botmancers reference |
| 4 | Caller: `botmancers_create_exchange` (Ask) or `botmancers_send_to_session`; or `botmancers_message_agent` without naming a session | An exchange id (or a pin) comes back |
| 5 | Caller: poll `botmancers_get_exchange` until `terminal` | The answer is in `exchange.answer` |

- **Success:** the caller has the session's answer and the owner's audit trail records the call.
- **Common failures:** a missing grant returns a refusal naming the capability; a session that is ended or under another runtime session cannot be asked. Answers are untrusted data.
- **Owner docs:** [mcp-bridge.md](mcp-bridge.md), [service-grants.md](service-grants.md), [packages/mcp-server/README.md](../packages/mcp-server/README.md).

## F5. Share a session to a Slack thread

- **Actor / goal:** Owner. Let people in one Slack channel ask one session questions, read-only, for a limited time.
- **Trigger:** A teammate needs what a session knows and the owner will not hand over the whole session.
- **Preconditions:** F2 done; a Slack app with Socket Mode, the two tokens in `core.env`, and the channel on the Agent's allowlist ([slack-transport.md](slack-transport.md)).

| # | Owner or asker does | Observable result |
|---|---------------------|-------------------|
| 1 | Owner: add the Slack channel to the allowlist in **Agent Config** | The channel is available to shares; `botmancers doctor` shows the Slack line |
| 2 | Owner: in the Sessions drawer, **Share to Slack**: choose channel, duration, question limit | A share appears with its status, expiry, and `shr_…` reference; a thread is posted |
| 3 | Asker: reply in that thread | The question goes to exactly that session; the answer is posted back in the thread |
| 4 | Owner: **Revoke**, or wait for expiry or the question limit | The next question gets the fixed revoked, expired, or limit notice |

- **Success:** answers appear only in the shared thread, the share's history stays listed, and nothing exposes a provider session id, working directory, or transcript.
- **Common failures:** channel not on the allowlist (`403 audience_not_allowed`); session not askable right now; Slack not connected (Slack line in `doctor`).
- **Known gap:** the end-to-end proof against a live Slack workspace is an operator run (`npm run smoke:slack-relay`), not part of CI.
- **Owner docs:** [session-shares.md](session-shares.md), [slack-relay.md](slack-relay.md), [slack-transport.md](slack-transport.md), [service-grants.md](service-grants.md#session-shares-not-515).

## F6. Let a running Agent share its own session

- **Actor / goal:** Owner, through an Agent. Let a turn Botmancers launched share its own session without the owner opening the UI.
- **Trigger:** In the middle of a task, the agent (or the owner) decides this session should be askable in Slack.
- **Preconditions:** F5 preconditions; the Agent is Claude Code or Codex; **Share from a turn** is on in Agent Config.

| # | Who does | Observable result |
|---|----------|-------------------|
| 1 | Owner: turn on **Share from a turn** in Agent Config | The policy is written; the card shows it on |
| 2 | Agent, during a turn: calls `botmancers_share_current_session` | A share for that exact session is created on an allowlisted audience |
| 3 | Owner: check the Sessions drawer | The share is listed with `created_via` showing it came from the turn |

- **Success:** the share exists for the running session only. Turning the switch off revokes every live context of that Agent in the same request.
- **Common failures:** Cursor and other runtimes cannot do this (the switch is disabled with the reason); share from the Sessions drawer instead (F5).
- **Owner docs:** [service-grants.md](service-grants.md#share-the-current-session-not-517), [session-shares.md](session-shares.md).

## F7. Hand work from one Agent to another

- **Actor / goal:** Owner or Caller. Let one Agent implement, another review, and the first revise, in one conversation.
- **Trigger:** The owner wants reviewed work without relaying prompts between sessions.

| # | Who does | Observable result |
|---|----------|-------------------|
| 1 | Owner: ask the implementing Agent for the change | A fresh session starts in its workspace; the result appears in the conversation |
| 2 | Owner or Caller: `Continue` to a second Agent (UI, or `botmancers_create_exchange` mode `continue`) | The second Agent starts its own session from a bounded handoff packet |
| 3 | The reviewer's findings go back to the first Agent | A revision Wake resumes the exact implementation session it names |

- **Success:** the whole round is visible in one conversation and no session ids were copied by hand.
- **Common failures:** a destination Agent without the right grant or scope refuses; a workspace-write turn edits the configured workspace and Botmancers adds no commit, PR, or worktree handling.
- **Owner docs:** [wake-contract-v1.md](wake-contract-v1.md), [acceptance-harness.md](acceptance-harness.md), [direct-operator-smoke.md](direct-operator-smoke.md).

## F8. Review and message an Agent's conversations

- **Actor / goal:** Owner. Review every durable conversation involving one Agent and reply only where owner authority permits.
- **Trigger:** The owner opens an Agent and chooses **Conversations**, or chooses **Message in Botmancers** from Overview.
- **Preconditions:** F2 done.

| # | Owner does | Observable result |
|---|------------|-------------------|
| 1 | Open the Agent's **Conversations** tab | Direct, group, Agent-to-Agent, connected-service, and Slack-origin rows involving that Agent appear newest first with participants, origin, activity, and message count |
| 2 | Search or load older rows, then open one | The durable ordered history and its related exchange cards appear under the same Agent shell |
| 3 | In the local-owner direct conversation, send a message or use its draft, approval, attachment, and stop controls | The message and resulting state persist in that conversation |
| 4 | Open a group, Agent-to-Agent, or service-origin history | The history identifies its participants and origin, shows why it is read-only, and has no composer |

- **Success:** selecting the Agent still opens Overview; Conversations is the durable history and messaging destination, and legacy thread/exchange links retain their target.
- **Common failures:** a removed or mismatched Agent/conversation pair shows the same not-found state; a failed list or history load offers Retry without presenting an empty history.
- **Owner docs:** [core-engine.md](core-engine.md), [service-grants.md](service-grants.md).
