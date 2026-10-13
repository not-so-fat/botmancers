# Botmancers

Botmancers lets a developer stay in one conversation while a persistent bot
delegates coding work to local coding agents on the Mac.

Each bot has one Agent — Hermes, Cursor, Claude, Codex, or Muse Code — and
one Agent Deck selected from the workspace Agent Deck server, plus an optional
working directory. Agent Deck is the deck configuration every agent launches
with; it is not an agent or a runtime. Hermes turns run on the persistent
Hermes gateway; the coding agents launch through `agent-deck run`. A bot
without a selected Agent Deck stays readable but cannot launch.

When asked to implement and review a change, the bot hands implementation to
the configured coding agent, hands its result to a reviewer agent, resumes the
original coding session with the review, and returns the revised result in the
same conversation. The user does not copy prompts or session identifiers and
does not configure a workflow form.

The roster and per-bot configuration page show `Agent: <agent> · Agent Deck:
<deck>`. Availability lists only agents with a real, available launch path. The thread shows the handoff, launched run/session, review, resume,
final result, and failure as conversational events.

The embedded example model loop has been removed. It is not part of the
Botmancers execution architecture and has no replacement generic-model role.

This remains a product hypothesis grounded in the owner's repeated manual
workflow. The first proof is repeat use of the complete
implementation → review → resumed-implementation loop from the conversation
the developer already uses.

See [Product requirements](<docs/product-requirements.md>) for the complete
behavioral contract.

## Current status

The current application is an early compatibility shell. It can:

- create bots and groups;
- converse through the persistent Hermes runtime;
- route `@bot` and legacy `WAKE` handoffs;
- show a dark roster-and-thread UI with unread tracking;
- draft outbound message proposals, gate actions behind Approve/Deny
  approval requests, and write file artifacts from chat;
- run taught one-shots and recurring routines, and park a turn on one
  ask-and-wait question;
- import bot identity from the Grok marketplace boundary;
- persist state in SQLite;
- store the first proposed bot-definition, session, task, and lifecycle-event
  model.

The next milestone is one evidence-producing personal-agent -> builder ->
reviewer -> resumed-builder slice using one real execution path and the simplest
return transport. Wider cloud/local runners, provider adapters, and optional
Huddo-style transport come only after that slice tests the stable boundaries.
The UI must not present an adapter as available until its launch path is real.

## Run the app

1. Install dependencies:

```bash
npm install
```

2. Point the app at a running Hermes gateway for conversational turns:

```bash
export HERMES_API_SERVER_KEY=your-key-here
```

Optional configuration:

```bash
export HERMES_BASE_URL=http://127.0.0.1:8642  # default gateway origin
```

3. Start the development server:

```bash
npm run dev
```

4. Open http://localhost:43123

Conversational turns require Hermes configuration: without
`HERMES_API_SERVER_KEY`, a turn posts an explicit Hermes error instead of a
reply, and no fallback transport is attempted. Coding work is delegated to
local coding agents through `agent-deck run`.
