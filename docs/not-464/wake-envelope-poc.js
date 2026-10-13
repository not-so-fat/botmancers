// NOT-464 throwaway PoC: the structured Wake envelope v1 (docs/core-engine.md,
// "Wake envelope v1"). Fixture-only. Nothing in lib/ or app/ imports this file;
// dependent builders reimplement the contract inside the engine.
'use strict';

const WAKE_VERSION = 'botmancers.wake/v1';
const WAKE_FENCE = /```botmancers-wake[ \t]*\n([\s\S]*?)\n```/g;
const LEGACY_WAKE = /WAKE\s+([A-Za-z0-9_-]+)\s*:\s*([\s\S]*)/i;
const IMPLEMENT_COMMAND = /^\/implement(?:\s+review:([A-Za-z0-9_-]+))?(?:\s+([\s\S]*))?$/;

const MAX_WAKES_PER_EVENT = 4;
const OUTCOME_MAX = 8000;
const FOCUS_MAX = 1000;
const POLICY_BOUNDS = {
  max_revisions: { min: 0, max: 2, default: 1 },
  timeout_seconds: { min: 60, max: 3600, default: 1800 },
};

// Kinds a producer may request. review and revision exist only as
// engine-created children of an implementation wake.
const PRODUCER_KINDS = ['conversation', 'implementation'];
const ENGINE_KINDS = ['review', 'revision'];
const TOOLS_BY_KIND = Object.freeze({
  conversation: 'readonly',
  implementation: 'edit',
  review: 'readonly',
  revision: 'edit',
});
const EDIT_CAPABLE_TYPES = ['Cursor', 'Claude', 'Codex', 'Muse Code'];

// Runtime and launch details belong to Attempts and Session Bindings. A
// producer naming any of them is rejected, at any depth.
const RUNTIME_KEYS = [
  'session_id', 'sessionId', 'run_id', 'runId', 'attempt_id', 'thread_id',
  'resume', 'deck', 'deck_id', 'cwd', 'working_directory', 'tools',
  'tool_profile', 'runtime', 'adapter',
];
// Stamped by the engine from the authenticated source event.
const ENGINE_KEYS = ['lineage', 'idempotency_key', 'requested_by', 'parent_request_id'];

const ALLOWED_KEYS = {
  root: ['version', 'target', 'kind', 'outcome', 'reviewer', 'policy'],
  reviewer: ['agent', 'focus'],
  policy: Object.keys(POLICY_BOUNDS),
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findAgent(roster, name) {
  if (typeof name !== 'string') return null;
  return roster.find(agent => agent.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function scanForbiddenKeys(value, path, errors) {
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (RUNTIME_KEYS.includes(key)) errors.push({ code: 'runtime_field_forbidden', path: at });
    else if (ENGINE_KEYS.includes(key)) errors.push({ code: 'engine_field_forbidden', path: at });
    scanForbiddenKeys(child, at, errors);
  }
}

function checkKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (RUNTIME_KEYS.includes(key) || ENGINE_KEYS.includes(key)) continue;
    if (!allowed.includes(key)) errors.push({ code: 'unknown_field', path: path ? `${path}.${key}` : key });
  }
}

function checkPolicy(policy, hasReviewer, errors) {
  const resolved = {};
  for (const [key, bounds] of Object.entries(POLICY_BOUNDS)) resolved[key] = bounds.default;
  if (policy === undefined) return resolved;
  if (!isObject(policy)) {
    errors.push({ code: 'invalid_policy', path: 'policy' });
    return resolved;
  }
  checkKeys(policy, ALLOWED_KEYS.policy, 'policy', errors);
  for (const [key, bounds] of Object.entries(POLICY_BOUNDS)) {
    if (policy[key] === undefined) continue;
    const value = policy[key];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      errors.push({ code: 'policy_out_of_bounds', path: `policy.${key}` });
    } else {
      resolved[key] = value;
    }
  }
  if (policy.max_revisions !== undefined && !hasReviewer) {
    errors.push({ code: 'policy_requires_reviewer', path: 'policy.max_revisions' });
  }
  return resolved;
}

// Validates one producer input against the source context and returns the
// engine-normalized envelope. Producer input never carries lineage,
// idempotency, tool authority, or runtime identifiers.
function validateWake(input, context, origin, wakeIndex) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: [{ code: 'not_an_object', path: '' }] };
  scanForbiddenKeys(input, '', errors);
  checkKeys(input, ALLOWED_KEYS.root, '', errors);

  if (input.version !== WAKE_VERSION) errors.push({ code: 'unsupported_version', path: 'version' });

  const target = isObject(input.target) ? findAgent(context.roster, input.target.agent) : null;
  if (isObject(input.target)) checkKeys(input.target, ['agent'], 'target', errors);
  if (!target) errors.push({ code: 'unknown_target', path: 'target.agent' });

  const kind = input.kind;
  if (ENGINE_KINDS.includes(kind)) errors.push({ code: 'engine_only_kind', path: 'kind' });
  else if (!PRODUCER_KINDS.includes(kind)) errors.push({ code: 'invalid_kind', path: 'kind' });

  const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
  if (!outcome || outcome.length > OUTCOME_MAX) errors.push({ code: 'invalid_outcome', path: 'outcome' });

  let reviewer = null;
  if (input.reviewer !== undefined && input.reviewer !== null) {
    if (!isObject(input.reviewer)) {
      errors.push({ code: 'invalid_reviewer', path: 'reviewer' });
    } else {
      checkKeys(input.reviewer, ALLOWED_KEYS.reviewer, 'reviewer', errors);
      const agent = findAgent(context.roster, input.reviewer.agent);
      const focus = input.reviewer.focus;
      if (kind !== 'implementation') errors.push({ code: 'reviewer_requires_implementation', path: 'reviewer' });
      if (!agent) errors.push({ code: 'unknown_reviewer', path: 'reviewer.agent' });
      else if (target && agent.id === target.id) errors.push({ code: 'reviewer_is_target', path: 'reviewer.agent' });
      if (focus !== undefined && (typeof focus !== 'string' || focus.length > FOCUS_MAX)) {
        errors.push({ code: 'invalid_reviewer_focus', path: 'reviewer.focus' });
      }
      if (agent) reviewer = { agent_id: agent.id, ...(typeof focus === 'string' ? { focus } : {}) };
    }
  }

  const policy = checkPolicy(input.policy, reviewer !== null, errors);

  const author = context.source_event.author;
  // An Agent never wakes itself: a self-wake would let a read-only turn
  // grant itself edit authority.
  if (author.type === 'agent' && target && author.agent_id === target.id) {
    errors.push({ code: 'self_wake', path: 'target.agent' });
  }
  if (kind === 'implementation' && target) {
    if (!EDIT_CAPABLE_TYPES.includes(target.type)) {
      errors.push({ code: 'edit_unsupported_for_target', path: 'target.agent' });
    }
    if (author.type === 'agent') {
      const requester = context.roster.find(agent => agent.id === author.agent_id);
      if (author.agent_id !== target.id && !requester?.wake_grants?.includes('implementation')) {
        errors.push({ code: 'grant_missing', path: 'kind' });
      }
    } else if (origin !== 'command') {
      // A person reaches implementation only through the explicit command.
      errors.push({ code: 'implementation_requires_command', path: 'kind' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    envelope: {
      version: WAKE_VERSION,
      target: { agent_id: target.id },
      kind,
      outcome,
      reviewer,
      policy: reviewer ? policy : { timeout_seconds: policy.timeout_seconds },
      lineage: {
        conversation_id: context.conversation.id,
        source_event_id: context.source_event.id,
        wake_index: wakeIndex,
        parent_request_id: context.parent_request_id ?? null,
        requested_by: author.type === 'agent' ? { type: 'agent', agent_id: author.agent_id } : { type: 'human' },
        origin,
      },
      idempotency_key: `wake:v1:${context.conversation.id}:${context.source_event.id}:${wakeIndex}:${target.id}`,
    },
  };
}

function legacyDirectives(text) {
  return text
    .split(/(?=WAKE\s+[A-Za-z0-9_-]+\s*:)/gi)
    .map(chunk => chunk.match(LEGACY_WAKE))
    .filter(Boolean)
    .map(match => ({ target: match[1], message: (match[2] || '').trim() }))
    .filter(directive => directive.message.length > 0);
}

// Agent reply: structured blocks win; legacy `WAKE <target>:` text is read
// only when no structured block exists, and only ever as a conversation wake.
function resolveAgentReply(text, context) {
  const warnings = [];
  const blocks = [...text.matchAll(WAKE_FENCE)].map(match => match[1]);
  const legacy = legacyDirectives(text);
  let inputs;
  if (blocks.length > 0) {
    if (legacy.length > 0) warnings.push('legacy_ignored_with_structured');
    inputs = blocks.map(body => {
      try {
        return { origin: 'structured', input: JSON.parse(body) };
      } catch {
        return { origin: 'structured', input: null, parseError: true };
      }
    });
  } else {
    inputs = [];
    for (const directive of legacy) {
      if (directive.target.toUpperCase() === 'GROUP') {
        warnings.push('legacy_group_not_a_wake');
        continue;
      }
      inputs.push({
        origin: 'legacy_wake',
        input: {
          version: WAKE_VERSION,
          target: { agent: directive.target },
          kind: 'conversation',
          outcome: directive.message,
        },
      });
    }
  }
  if (inputs.length > MAX_WAKES_PER_EVENT) {
    return { wakes: [], rejected: [{ errors: [{ code: 'too_many_wakes', path: '' }] }], warnings };
  }
  return collect(inputs, context, warnings);
}

// Human message in a direct conversation: the conversation Agent is the
// target. Only a leading `/implement` asks for edit authority.
function resolveHumanMessage(text, context) {
  const agent = context.roster.find(candidate => candidate.id === context.conversation.agent_id);
  const command = text.trim().match(IMPLEMENT_COMMAND);
  if (command) {
    const input = {
      version: WAKE_VERSION,
      target: { agent: agent.name },
      kind: 'implementation',
      outcome: command[2] ?? '',
      ...(command[1] ? { reviewer: { agent: command[1] } } : {}),
    };
    return collect([{ origin: 'command', input }], context, []);
  }
  const input = { version: WAKE_VERSION, target: { agent: agent.name }, kind: 'conversation', outcome: text };
  return collect([{ origin: 'direct_message', input }], context, []);
}

function collect(inputs, context, warnings) {
  const wakes = [];
  const rejected = [];
  inputs.forEach((entry, index) => {
    if (entry.parseError) {
      rejected.push({ index, errors: [{ code: 'invalid_json', path: '' }] });
      return;
    }
    const result = validateWake(entry.input, context, entry.origin, index);
    if (result.ok) wakes.push(result.envelope);
    else rejected.push({ index, errors: result.errors });
  });
  return { wakes, rejected, warnings };
}

// Work Request plan for one accepted envelope. Tool authority comes only
// from the kind; the envelope cannot name it.
function planWorkRequests(envelope) {
  const parent = envelope.lineage.parent_request_id;
  if (envelope.kind === 'conversation') {
    return [{ ref: 'turn', kind: 'conversation', target: envelope.target.agent_id, parent, tools: TOOLS_BY_KIND.conversation, attempts: [{ n: 1, tools: 'readonly', resume: null }] }];
  }
  const implementation = {
    ref: 'implement',
    kind: 'implementation',
    target: envelope.target.agent_id,
    parent,
    tools: TOOLS_BY_KIND.implementation,
    attempts: [{ n: 1, tools: TOOLS_BY_KIND.implementation, resume: null }],
  };
  if (!envelope.reviewer) return [implementation];
  for (let revision = 1; revision <= envelope.policy.max_revisions; revision++) {
    implementation.attempts.push({
      n: revision + 1,
      kind: 'revision',
      tools: TOOLS_BY_KIND.revision,
      resume: 'session_binding:implement',
      when: `review_${revision}_has_findings`,
    });
  }
  const reviews = [];
  for (let round = 1; round <= Math.max(1, envelope.policy.max_revisions); round++) {
    reviews.push({
      ref: `review_${round}`,
      kind: 'review',
      target: envelope.reviewer.agent_id,
      parent: 'implement',
      tools: TOOLS_BY_KIND.review,
      attempts: [{ n: 1, tools: TOOLS_BY_KIND.review, resume: null }],
      when: `implement_attempt_${round}_completed`,
    });
  }
  return [implementation, ...reviews];
}

module.exports = {
  WAKE_VERSION,
  RUNTIME_KEYS,
  TOOLS_BY_KIND,
  validateWake,
  resolveAgentReply,
  resolveHumanMessage,
  planWorkRequests,
};
