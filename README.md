# Botmancers

Botmancers is a registry, launcher, and session router for configured agents.
A bot binds an identity to a runtime, configuration source, execution target,
and launch policy. Registered bots can request work from one another while
Botmancers tracks the task, launches or resumes the target agent, and routes the
result back.

The end goal is a Grok-like teammate app: a person tells a bot a task in one
conversation, and bots delegate to each other, ask back, or answer in that same
conversation with no workflow UI or forms. Conversational delegation between
bots is the core engine. Botmancers exists to make that delegation trustworthy
through transparent per-bot configuration of skills, rules, and template source.
The builder -> reviewer -> resumed-builder coding loop is the first slice toward
that end goal: a personal agent delegating implementation to Claude, review to
Codex, and revision back to the original Claude session without manual prompt
copying. Hermes is one optional runtime for a bot, not the product itself.

This is currently a product hypothesis grounded in the owner's repeated manual
workflow, not a validated market or moat claim. The initial buyer hypothesis is
developers and small teams already using multiple coding-agent runtimes. The
first proof is repeat use and active sharing of a complete delegation/review
loop, not the amount of registry or protocol infrastructure built.

The chosen wedge is cross-runtime implementation and review inside the agent
conversation the developer already uses. Full agent hosting, a generic agent
chat room, and a configuration marketplace are adjacent possibilities, but they
are not the current product. The implementation must test whether this wedge is
urgent before coding-agent hosts absorb it as a feature.

[Todos](https://todos.dev/) is the closest known product-level substitute: it
already orchestrates multiple coding-agent runtimes, machines, persistent task
context, and independent review. Botmancers should proceed only if direct trials
show that configuration-faithful bots, agent-initiated delegation, and returning
work to an existing agent conversation solve needs that a Todos-style workspace
does not.

The repository separates intended behavior from technical proposals:

- [Product requirements](docs/product-requirements.md) records the agreed goal,
  definitions, requirements, acceptance scenarios, and non-requirements.
- [Implementation plan](docs/implementation-plan.md) records the proposed
  architecture, candidate integrations, schema, and migration sequence.
- [Runtime contract v0](docs/runtime-contract-v0.md) records the provisional
  typed boundary required before implementing the first real adapter.
- [Caller contract v0](docs/control-plane-contract-v0.md) records the
  provisional MCP/API surface used by personal agents and people.

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
