const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/wake-v1.schema.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/wake-v1.fixtures.json'), 'utf8'));

const allowedKeys = new Set([
  'version',
  'target',
  'executionKind',
  'objective',
  'contextWorkRequests',
  'resumeWorkRequest',
  'limits',
]);
const executionKinds = new Set(['conversation', 'implementation', 'review', 'revision']);

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateWakeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  if (Object.keys(envelope).some(key => !allowedKeys.has(key))) return false;
  if (envelope.version !== 1) return false;
  if (!isNonEmptyString(envelope.target, 120)) return false;
  if (!executionKinds.has(envelope.executionKind)) return false;
  if (!isNonEmptyString(envelope.objective, 20000)) return false;

  if (envelope.contextWorkRequests !== undefined) {
    if (!Array.isArray(envelope.contextWorkRequests) || envelope.contextWorkRequests.length > 8) return false;
    if (envelope.contextWorkRequests.some(value => !isNonEmptyString(value, 160))) return false;
    if (new Set(envelope.contextWorkRequests).size !== envelope.contextWorkRequests.length) return false;
  }

  const hasResume = Object.prototype.hasOwnProperty.call(envelope, 'resumeWorkRequest');
  if (envelope.executionKind === 'revision') {
    if (!hasResume || !isNonEmptyString(envelope.resumeWorkRequest, 160)) return false;
  } else if (hasResume) {
    return false;
  }

  if (envelope.limits !== undefined) {
    if (!envelope.limits || typeof envelope.limits !== 'object' || Array.isArray(envelope.limits)) return false;
    if (Object.keys(envelope.limits).some(key => !['maxAttempts', 'deadlineSeconds'].includes(key))) return false;
    const { maxAttempts, deadlineSeconds } = envelope.limits;
    if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) return false;
    if (deadlineSeconds !== undefined && (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 86400)) return false;
  }

  return true;
}

assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.required, ['version', 'target', 'executionKind', 'objective']);

for (const fixture of fixtures.valid) {
  assert.equal(validateWakeEnvelope(fixture.envelope), true, `expected valid: ${fixture.name}`);
}
for (const fixture of fixtures.invalid) {
  assert.equal(validateWakeEnvelope(fixture.envelope), false, `expected invalid: ${fixture.name}`);
}

console.log(`Wake contract v1 fixtures passed: ${fixtures.valid.length} valid, ${fixtures.invalid.length} invalid.`);
