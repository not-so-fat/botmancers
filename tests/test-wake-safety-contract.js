// NOT-474: consistency of the wake safety fixtures with their contract
// (docs/design/2026-10-14-wake-safety-contract.md). Design-only: no engine
// code enforces these yet, so this checks that every case is explicit and
// that no refused or unauthenticated case pretends work ran.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = require('./support/repo-root');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/wake-safety-v1.fixtures.json'), 'utf8'));
const contract = fs.readFileSync(path.join(ROOT, fixtures.contract), 'utf8');
const coreEngine = fs.readFileSync(path.join(ROOT, 'docs/core-engine.md'), 'utf8');

const { limits } = fixtures;
assert.equal(limits.maxContinuations, 2 * limits.rootBudget, 'continuation cap is derived from the root budget');
for (const [label, value] of [
  ['Wake depth', limits.maxWakeDepth],
  ['Root budget', limits.rootBudget],
  ['Global concurrency', limits.globalConcurrency],
  ['Per-target concurrency', limits.perTargetConcurrency],
]) {
  assert(contract.includes(`${label} **${value}**`) || contract.includes(`| ${label} | **${value}** |`), `contract states ${label} ${value}`);
  assert(coreEngine.includes(`| ${label} | ${value} |`), `core engine states ${label} ${value}`);
}

const statuses = new Set(fixtures.wakeStatuses);
const reasons = new Set(fixtures.reasonCodes);
const audits = new Set(fixtures.auditEvents);
const principals = new Set(fixtures.principalTypes);
const httpCodes = new Set(fixtures.httpErrorCodes);
const grantRules = new Set(fixtures.grantRules);
const envelopeKeys = new Set(['version', 'target', 'executionKind', 'objective', 'contextWorkRequests', 'resumeWorkRequest', 'limits']);
const executionKinds = new Set(['conversation', 'implementation', 'review', 'revision']);
const workRanStates = new Set(['running', 'completed']);
const workRanKinds = new Set(['request_running', 'request_completed', 'wake_accepted']);
const availabilityReasons = new Set(['target_unavailable', 'target_unconfigured']);
const names = new Set();
const covered = { reasons: new Set(), principals: new Set(), http: new Set(), rules: new Set() };

for (const fixture of fixtures.cases) {
  const { name, principal, action, expect } = fixture;
  assert(!names.has(name), `unique case name ${name}`);
  names.add(name);
  assert(principals.has(principal), `${name}: known principal type`);
  covered.principals.add(principal);

  if (action.envelope) {
    assert(Object.keys(action.envelope).every(key => envelopeKeys.has(key)), `${name}: envelope uses only v1 fields`);
    assert(action.envelope.version === 1 && executionKinds.has(action.envelope.executionKind), `${name}: envelope is v1`);
  }

  for (const event of expect.audit) assert(audits.has(event), `${name}: known audit event ${event}`);
  const kinds = expect.projection.map(part => part.kind);

  // Unknown principals have no attributable identity, so nothing is written.
  if (principal === 'unknown') assert.equal(expect.persisted, false, `${name}: an unknown principal persists nothing`);

  // No refused, denied, blocked, or unpersisted outcome may claim work ran.
  const refused = !expect.persisted
    || (expect.wake && ['rejected', 'blocked'].includes(expect.wake.status))
    || (expect.workRequest && ['blocked', 'cancelled'].includes(expect.workRequest.state));
  if (refused) {
    assert(!(expect.workRequest && workRanStates.has(expect.workRequest.state)), `${name}: a refused Wake has no running or completed request`);
    assert(!kinds.some(kind => workRanKinds.has(kind)), `${name}: a refused Wake projects no accepted or running work`);
  }

  if (!expect.persisted) {
    assert(expect.http && httpCodes.has(expect.http.code), `${name}: an unpersisted refusal names its HTTP code`);
    covered.http.add(expect.http.code);
    assert.equal(kinds.length, 0, `${name}: nothing persisted means nothing projected`);
    assert.equal(expect.audit.length, 0, `${name}: nothing persisted means no audit row`);
  }

  if (expect.wake) {
    assert(statuses.has(expect.wake.status), `${name}: known Wake status`);
    if (expect.wake.reasonCode !== null) {
      assert(reasons.has(expect.wake.reasonCode), `${name}: known reason code ${expect.wake.reasonCode}`);
      covered.reasons.add(expect.wake.reasonCode);
    }
    if (expect.wake.status === 'rejected') {
      assert.equal(expect.workRequest, null, `${name}: a rejected Wake creates no Work Request`);
      assert(kinds.includes('wake_rejected'), `${name}: a rejected Wake is visible as wake_rejected`);
    }
    if (expect.wake.status === 'accepted' || expect.wake.status === 'blocked') {
      assert(expect.workRequest, `${name}: an accepted or blocked Wake names its Work Request`);
    }
    if (expect.wake.reasonCode === 'edit_approval_required' && expect.persisted) {
      assert.equal(expect.workRequest.state, 'blocked', `${name}: a missing grant blocks, it does not run`);
      if (kinds.length > 0) {
        assert.deepEqual(expect.projection[0].actions, ['allow', 'deny'], `${name}: the owner can allow or deny`);
        assert(expect.audit.includes('grant_requested'), `${name}: the grant request is audited`);
      }
    }
    if (expect.wake.status === 'blocked' && expect.wake.reasonCode !== 'grant_denied') {
      assert.equal(expect.workRequest.state, 'blocked', `${name}: a blocked Wake's request is blocked`);
      assert.equal(expect.workRequest.reason, expect.wake.reasonCode, `${name}: Wake and request carry one current reason`);
    }
    if (expect.wake.reasonCode === 'grant_denied') {
      assert.equal(expect.workRequest.state, 'cancelled', `${name}: a denied grant cancels the request`);
    }
    if (availabilityReasons.has(expect.wake.reasonCode)) {
      assert(kinds.includes('wake_blocked'), `${name}: an availability block is visible`);
      assert.deepEqual(expect.projection[0].actions, [], `${name}: Allow and Deny are offered only for edit_approval_required`);
    }
    if (expect.workRequest && expect.workRequest.transition === 'blocked->queued') {
      assert.equal(expect.wake.status, 'accepted', `${name}: a request is queued only when its Wake is accepted`);
    }
    if (expect.wake.limit !== undefined) {
      assert(expect.wake.observed >= expect.wake.limit, `${name}: an exhausted limit records what was observed`);
    }
  }

  if (expect.workRequest === null) {
    assert(!kinds.some(kind => kind.startsWith('request_')), `${name}: no request lifecycle without a Work Request`);
  }
  if (expect.workRequest && expect.workRequest.grantRule) {
    assert(grantRules.has(expect.workRequest.grantRule), `${name}: known grant rule`);
    covered.rules.add(expect.workRequest.grantRule);
  }
  if (expect.workRequest && expect.workRequest.wakeDepth !== undefined) {
    assert(expect.workRequest.wakeDepth <= limits.maxWakeDepth, `${name}: accepted work stays within depth`);
  }
}

// Flow C: grant and availability blockers compose in the contract's order.
const flowC = fixtures.cases.filter(fixture => fixture.flow === 'C');
const unavailableTarget = fixture => fixture.given.targetAvailability && fixture.given.targetAvailability.available === false;
assert(flowC.some(fixture => unavailableTarget(fixture) && fixture.expect.wake.reasonCode === 'edit_approval_required'), 'Flow C: missing grant is asked before availability');
assert(flowC.some(fixture => fixture.action.decision === 'allow' && unavailableTarget(fixture) && fixture.expect.grant && fixture.expect.wake.reasonCode === 'target_unavailable'), 'Flow C: Allow on an unlaunchable target keeps the request blocked');
assert(flowC.some(fixture => fixture.action.type === 'retry_wake' && fixture.expect.workRequest.transition === 'blocked->queued'), 'Flow C: retry queues once the target can launch');
assert(flowC.some(fixture => fixture.action.decision === 'deny' && unavailableTarget(fixture) && fixture.expect.workRequest.state === 'cancelled'), 'Flow C: Deny wins regardless of availability');

assert.deepEqual([...covered.reasons].sort(), [...reasons].sort(), 'every reason code has a fixture');
assert.deepEqual([...covered.principals].sort(), [...principals].sort(), 'every principal type has a fixture');
assert.deepEqual([...covered.http].sort(), [...httpCodes].sort(), 'every HTTP refusal has a fixture');
assert.deepEqual([...covered.rules].sort(), [...grantRules].sort(), 'every grant rule has a fixture');

console.log(`Wake safety v1 fixtures passed: ${fixtures.cases.length} cases.`);
