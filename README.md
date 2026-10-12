# Botmancers

Botmancers lets a developer stay in one conversation while a persistent bot
delegates coding work to local coding agents on the Mac.

The user's bot runs persistently on Hermes. Each bot also has a coding-agent
path consisting of a runtime (`codex`, `claude`, `cursor`, or `muse`), an Agent
Deck deck, and a working directory. Botmancers launches that path through
`agent-deck run`.

When asked to implement and review a change, the bot hands implementation to
the configured coding agent, hands its result to a reviewer agent, resumes the
original coding session with the review, and returns the revised result in the
same conversation. The user does not copy prompts or session identifiers and
does not configure a workflow form.

The roster and per-bot configuration page show the persistent runtime and the
coding runtime plus deck. Only runtimes with a real, available launch path are
offered. The thread shows the handoff, launched run/session, review, resume,
final result, and failure as conversational events.

The embedded OpenAI-compatible example loop is legacy and is being removed. It
is not part of the Botmancers execution architecture and has no replacement
generic-model role.

This remains a product hypothesis grounded in the owner's repeated manual
workflow. The first proof is repeat use of the complete
implementation → review → resumed-implementation loop from the conversation
the developer already uses.

See [Product requirements](<docs/product-requirements.md>) for the complete
behavioral contract.

## Current status

The current application is an early compatibility shell. It can:

- create bots and groups;
- chat through an embedded example model loop;
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

## Run the embedded compatibility prototype

1. Install dependencies:

```bash
npm install
```

2. Optionally set an OpenAI-compatible API key for model responses:

```bash
export OPENAI_API_KEY=your-key-here
```

Optional configuration:

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1  # optional
export OPENAI_MODEL=gpt-3.5-turbo                    # optional
```

3. Start the development server:

```bash
npm run dev
```

4. Open http://localhost:43123

The app will work without an API key, but the embedded example loop will return
an explicit error instead of a model response. This loop is a compatibility
prototype and is not the required Botmancers execution architecture.
