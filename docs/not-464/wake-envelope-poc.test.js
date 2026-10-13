#!/usr/bin/env node
// NOT-464 throwaway PoC test: validates docs/not-464/fixtures.json against
// the fixture-only parser. Run: node docs/not-464/wake-envelope-poc.test.js
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS like the root test-*.js files */

const assert = require('assert');
const fixtures = require('./fixtures.json');
const poc = require('./wake-envelope-poc.js');

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS: ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL: ${label}\n    ${String(error.message).split('\n').join('\n    ')}`);
  }
}

function contextFor(name) {
  return { ...fixtures.contexts[name], roster: fixtures.roster };
}

function resolve(entry, text, contextName) {
  const context = contextFor(contextName);
  return entry === 'human_message'
    ? poc.resolveHumanMessage(text, context)
    : poc.resolveAgentReply(text, context);
}

function errorCodes(result) {
  return result.rejected.flatMap(rejection => rejection.errors.map(error => error.code)).sort();
}

function containsRuntimeKey(value) {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => poc.RUNTIME_KEYS.includes(key) || containsRuntimeKey(child));
}

function plannedTools(plan) {
  return plan.flatMap(request => request.attempts.map(attempt => attempt.tools));
}

console.log('Flows');
for (const flow of fixtures.flows) {
  console.log(` ${flow.name}`);
  const planned = [];
  flow.steps.forEach((step, index) => {
    const result = resolve(step.entry, step.text, step.context);
    check(`step ${index + 1}: no rejections`, () => assert.deepStrictEqual(result.rejected, []));
    if (step.expect.wakes) {
      check(`step ${index + 1}: envelope matches fixture`, () => assert.deepStrictEqual(result.wakes, step.expect.wakes));
    }
    if (step.expect.kinds) {
      check(`step ${index + 1}: kinds ${step.expect.kinds.join(',')}`, () =>
        assert.deepStrictEqual(result.wakes.map(wake => wake.kind), step.expect.kinds));
    }
    check(`step ${index + 1}: no runtime/session identifiers in envelope`, () =>
      assert.ok(!result.wakes.some(containsRuntimeKey)));
    const plans = result.wakes.map(poc.planWorkRequests);
    check(`step ${index + 1}: Work Request plan matches fixture`, () => assert.deepStrictEqual(plans, step.expect.plans));
    if (!step.variant) planned.push(...plans.flat());
  });

  const created = flow.events.filter(event => event.type === 'work_request.created');
  check('events: Work Requests match the planned target and tool profile, in order', () =>
    assert.deepStrictEqual(
      created.map(event => [event.target, event.tools]),
      planned.map(request => [request.target, request.tools])
    ));
  check('events: every parent was created earlier (lineage is a tree)', () => {
    const seen = new Set();
    for (const event of created) {
      assert.ok(event.parent === null || seen.has(event.parent), `${event.request} parent ${event.parent}`);
      seen.add(event.request);
    }
  });
  check('events: attempt tool sequence matches the plan', () => {
    const started = flow.events.filter(event => event.type === 'attempt.started').map(event => event.tools);
    const expected = planned.flatMap(request => plannedTools([request]));
    // Order in time: plans list the implementation request first with its
    // revision attempt, so compare as multisets and check the time order below.
    assert.deepStrictEqual([...started].sort(), [...expected].sort());
  });
  check('events: result projects into the source conversation', () => {
    const source = flow.events[0].conversation;
    const projected = flow.events.filter(event => event.type === 'result.projected');
    assert.ok(projected.every(event => event.conversation === source));
  });
}

check('flow-1: launch authority in time order is readonly -> edit -> readonly -> edit', () => {
  const tools = fixtures.flows[0].events.filter(event => event.type === 'attempt.started').map(event => event.tools);
  assert.deepStrictEqual(tools, ['readonly', 'edit', 'readonly', 'edit']);
});
check('flow-2: one read-only turn, no implementation/review/revision', () => {
  const events = fixtures.flows[1].events;
  assert.deepStrictEqual(events.filter(event => event.type === 'attempt.started').map(event => event.tools), ['readonly']);
  assert.ok(!events.some(event => event.tools === 'edit' || event.kind === 'implementation' || event.kind === 'revision'));
  assert.strictEqual(events.filter(event => event.type === 'work_request.created').length, 1);
});
check('flow-3: direct command launches edit -> readonly -> edit', () => {
  const tools = fixtures.flows[2].events.filter(event => event.type === 'attempt.started').map(event => event.tools);
  assert.deepStrictEqual(tools, ['edit', 'readonly', 'edit']);
});

console.log('Negative direct-message and authority fixtures');
for (const fixture of fixtures.negative) {
  const result = resolve(fixture.entry, fixture.text, fixture.context);
  check(fixture.name, () => {
    assert.deepStrictEqual(result.wakes.map(wake => wake.kind), fixture.expect.kinds);
    if (fixture.expect.tools) {
      assert.deepStrictEqual(result.wakes.map(wake => poc.TOOLS_BY_KIND[wake.kind]), fixture.expect.tools);
      for (const wake of result.wakes) {
        assert.deepStrictEqual(plannedTools(poc.planWorkRequests(wake)), ['readonly']);
      }
    }
    assert.deepStrictEqual(errorCodes(result), [...(fixture.expect.errors ?? [])].sort());
  });
}

console.log('Structured validation fixtures');
for (const fixture of fixtures.structured_validation) {
  const result = poc.validateWake(fixture.input, contextFor(fixture.context), 'structured', 0);
  check(fixture.name, () => {
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.errors.map(error => error.code).sort(), [...fixture.errors].sort());
  });
}

console.log('Legacy WAKE compatibility fixtures');
for (const fixture of fixtures.legacy) {
  const result = poc.resolveAgentReply(fixture.text, contextFor(fixture.context));
  check(fixture.name, () => {
    assert.deepStrictEqual(result.wakes.map(wake => wake.kind), fixture.expect.kinds);
    assert.deepStrictEqual(result.wakes.map(wake => poc.TOOLS_BY_KIND[wake.kind]), fixture.expect.tools);
    assert.deepStrictEqual(result.wakes.map(wake => wake.lineage.origin), fixture.expect.origins);
    assert.deepStrictEqual(result.warnings, fixture.expect.warnings);
    assert.deepStrictEqual(errorCodes(result), [...(fixture.expect.errors ?? [])].sort());
    assert.ok(!result.wakes.some(containsRuntimeKey));
  });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
