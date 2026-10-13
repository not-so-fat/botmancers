# NOT-464: Wake envelope v1 fixtures (decision evidence)

Evidence for the [Wake envelope v1](../core-engine.md#wake-envelope-v1) section of
`docs/core-engine.md`, recorded on October 13, 2026. Throwaway PoC: nothing in
`lib/` or `app/` imports these files, and dependent builders reimplement the
contract inside the engine.

| File | Contents |
| --- | --- |
| `fixtures.json` | Agent roster with wake grants; the three flows with expected envelopes, Work Request plans, and event sequences; negative direct-message fixtures; structured validation fixtures; legacy `WAKE` compatibility fixtures. |
| `wake-envelope-poc.js` | Fixture-only parser, validator, and Work Request planner. |
| `wake-envelope-poc.test.js` | Checks every fixture against the PoC. |

Run: `node docs/not-464/wake-envelope-poc.test.js`

## Flows

1. **Hermes → Codex implement → Claude review.** A human message to Hermes is one
   read-only turn (`wr_hermes_turn`). Hermes's reply carries a structured
   `implementation` wake for Codex with reviewer Claude. Plan: `wr_implement`
   (Codex, `edit`, parent `wr_hermes_turn`) → `wr_review_1` (Claude, `readonly`,
   parent `wr_implement`) → revision Attempt 2 on `wr_implement` (`edit`, resumes
   the stored Session Binding). Launch authority in time order:
   `readonly → edit → readonly → edit`. No envelope contains a runtime, session,
   deck, or tool field.
2. **Codex explains a module.** One `conversation` envelope, one read-only Work
   Request, one Attempt. Negative fixtures show that "please implement …" without
   the command, `/implement` in the middle of a message, a pasted structured block
   in a human message, a Codex self-wake (structured or legacy), and a Codex
   `implementation` wake to Claude without a grant all fail to produce edit
   authority.
3. **Codex asked directly to implement.** `/implement review:Claude <outcome>`
   gives an `implementation` envelope with `origin: command`; launch authority
   `edit → readonly → edit`. Without `review:`, a single `edit` request.

## Open decision

The `/implement` command is the **proposed** direct-implementation rule. It needs
product owner approval, recorded on the issue or PR, before the core-engine
section loses its "proposed" status. Rejected alternatives are listed in
`docs/core-engine.md`.

## Validator output

```text
Flows
 flow-1: Hermes wakes Codex to implement and Claude to review
  PASS: step 1: no rejections
  PASS: step 1: envelope matches fixture
  PASS: step 1: no runtime/session identifiers in envelope
  PASS: step 1: Work Request plan matches fixture
  PASS: step 2: no rejections
  PASS: step 2: envelope matches fixture
  PASS: step 2: no runtime/session identifiers in envelope
  PASS: step 2: Work Request plan matches fixture
  PASS: events: Work Requests match the planned target and tool profile, in order
  PASS: events: every parent was created earlier (lineage is a tree)
  PASS: events: attempt tool sequence matches the plan
  PASS: events: result projects into the source conversation
 flow-2: a person asks Codex to explain a module
  PASS: step 1: no rejections
  PASS: step 1: envelope matches fixture
  PASS: step 1: no runtime/session identifiers in envelope
  PASS: step 1: Work Request plan matches fixture
  PASS: events: Work Requests match the planned target and tool profile, in order
  PASS: events: every parent was created earlier (lineage is a tree)
  PASS: events: attempt tool sequence matches the plan
  PASS: events: result projects into the source conversation
 flow-3: a person asks Codex directly to implement a change
  PASS: step 1: no rejections
  PASS: step 1: envelope matches fixture
  PASS: step 1: no runtime/session identifiers in envelope
  PASS: step 1: Work Request plan matches fixture
  PASS: step 2: no rejections
  PASS: step 2: kinds implementation
  PASS: step 2: no runtime/session identifiers in envelope
  PASS: step 2: Work Request plan matches fixture
  PASS: events: Work Requests match the planned target and tool profile, in order
  PASS: events: every parent was created earlier (lineage is a tree)
  PASS: events: attempt tool sequence matches the plan
  PASS: events: result projects into the source conversation
  PASS: flow-1: launch authority in time order is readonly -> edit -> readonly -> edit
  PASS: flow-2: one read-only turn, no implementation/review/revision
  PASS: flow-3: direct command launches edit -> readonly -> edit
Negative direct-message and authority fixtures
  PASS: explain: natural-language 'implement' without the command stays read-only
  PASS: explain: /implement not at the start is not a command
  PASS: explain: a structured-looking human message is plain text
  PASS: explain: Codex cannot escalate its read-only turn by waking itself
  PASS: explain: Codex cannot escalate through legacy WAKE to itself
  PASS: explain: Codex lacks an implementation grant to wake Claude
  PASS: command: reviewer cannot be the builder
  PASS: command: empty outcome
  PASS: command: unknown reviewer
  PASS: command: Hermes cannot be given edit authority
Structured validation fixtures
  PASS: session id is rejected
  PASS: resume binding inside reviewer is rejected
  PASS: tool authority cannot be supplied
  PASS: deck and cwd cannot be supplied
  PASS: lineage is engine-stamped
  PASS: idempotency key is engine-stamped
  PASS: review kind is engine-only
  PASS: revision kind is engine-only
  PASS: reviewer requires implementation
  PASS: unsupported version
  PASS: unknown field
  PASS: unknown target
  PASS: revision budget is bounded
  PASS: timeout is bounded
  PASS: revision budget needs a reviewer
  PASS: outcome is bounded
Legacy WAKE compatibility fixtures
  PASS: legacy WAKE is always a read-only conversation wake, whatever the text says
  PASS: legacy WAKE cannot smuggle structured fields
  PASS: several legacy WAKE lines become several conversation wakes
  PASS: structured block wins over legacy text in the same reply
  PASS: legacy WAKE GROUP is not a Work Request wake
  PASS: more than four wakes in one event are rejected

ALL PASS
```
