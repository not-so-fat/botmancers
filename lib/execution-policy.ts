// NOT-471: the one execution-policy authority (docs/core-engine.md, Tool
// authority; Delegation and review policy). Every canonical Work Request
// carries exactly one execution kind and the tool profile this module maps
// it to; nothing else (Agent type, message text, adapter) chooses authority.
//
//   conversation -> readonly   implementation -> edit
//   review       -> readonly   revision       -> edit
//
// Selection is per entry point and fails closed:
//
// - A direct message (UI or /api/v0) is always one read-only conversation
//   turn, whatever it says and whichever Agent it addresses. A coding Agent
//   asked directly to implement may emit a visible implementation Wake to
//   itself; that Wake, not the message, carries edit authority.
// - A structured Wake (botmancers-wake v1) may request any kind; a
//   revision must name the Work Request it resumes, nothing else may.
// - A legacy `WAKE <name>:` directive is a conversation Wake only.
// - NOT-472: a coordinator continuation (the engine returning a
//   specialist result to the Agent that woke it) is a read-only
//   conversation turn only.
// - NOT-497: every hop of an owner's session exchange (an Ask, a Continue
//   handoff extraction, and the Continue delivery) is a read-only
//   conversation turn only. An exchange never carries edit authority.
//
// The selected policy is frozen into the request's policy snapshot. The
// dispatcher re-validates that snapshot against the request row before any
// adapter launches (authorizeWorkRequest); unknown kinds, unsupported
// authority, and malformed snapshots never reach a runtime.
//
// Snapshots and policy events hold only kinds, profiles, entry points, and
// rule names: no prompt text, session ids, or credentials.

export type ExecutionKind = 'conversation' | 'implementation' | 'review' | 'revision';
export type ToolProfile = 'readonly' | 'edit';
export type PolicyEntryPoint = 'ui' | 'api' | 'wake' | 'continuation' | 'exchange';
export type WakeSyntaxKind = 'structured' | 'legacy';

export const EXECUTION_KINDS: readonly ExecutionKind[] = Object.freeze(['conversation', 'implementation', 'review', 'revision']);
export const TOOL_PROFILES: readonly ToolProfile[] = Object.freeze(['readonly', 'edit']);
export const POLICY_ENTRY_POINTS: readonly PolicyEntryPoint[] = Object.freeze(['ui', 'api', 'wake', 'continuation', 'exchange']);

// Tool authority per execution kind. It is explicit on every request and
// never inferred from the Agent type.
export const TOOL_PROFILE_FOR_KIND: Readonly<Record<ExecutionKind, ToolProfile>> = Object.freeze({
  conversation: 'readonly',
  implementation: 'edit',
  review: 'readonly',
  revision: 'edit',
});

export const EXECUTION_POLICY_VERSION = 1;

// Why a policy was selected; recorded for audit.
export type PolicyRule =
  | 'direct_message_conversation'
  | 'structured_wake'
  | 'legacy_wake_conversation'
  | 'coordinator_continuation'
  | 'session_exchange_conversation';

export interface ExecutionPolicySnapshot {
  policy_version: typeof EXECUTION_POLICY_VERSION;
  execution_kind: ExecutionKind;
  tool_profile: ToolProfile;
  entry_point: PolicyEntryPoint;
  rule: PolicyRule;
}

export type PolicyErrorCode = 'unknown_execution_kind' | 'unsupported_authority' | 'malformed_policy';

export type PolicySelection =
  | { ok: true; policy: ExecutionPolicySnapshot }
  | { ok: false; code: PolicyErrorCode; reason: string };

export interface PolicyRequest {
  entryPoint: PolicyEntryPoint;
  // Requested kind, unvalidated (it may come from an envelope).
  executionKind: unknown;
  // Wakes only.
  wakeSyntax?: WakeSyntaxKind;
  resumesWorkRequest?: boolean;
}

export function isExecutionKind(value: unknown): value is ExecutionKind {
  return typeof value === 'string' && (EXECUTION_KINDS as readonly string[]).includes(value);
}

function rejected(code: PolicyErrorCode, reason: string): PolicySelection {
  return { ok: false, code, reason };
}

// Which rule allows `kind` from this entry point, or why none does.
function ruleFor(entryPoint: unknown, kind: ExecutionKind, wakeSyntax: unknown, resumes: boolean): PolicyRule | { code: PolicyErrorCode; reason: string } {
  if (entryPoint === 'ui' || entryPoint === 'api') {
    if (kind !== 'conversation') {
      return { code: 'unsupported_authority', reason: `A direct message runs as a read-only conversation turn, not ${kind}.` };
    }
    return 'direct_message_conversation';
  }
  if (entryPoint === 'continuation') {
    if (kind !== 'conversation') {
      return { code: 'unsupported_authority', reason: `A coordinator continuation runs as a read-only conversation turn, not ${kind}.` };
    }
    return 'coordinator_continuation';
  }
  if (entryPoint === 'exchange') {
    if (kind !== 'conversation') {
      return { code: 'unsupported_authority', reason: `A session exchange runs as a read-only conversation turn, not ${kind}.` };
    }
    return 'session_exchange_conversation';
  }
  if (entryPoint !== 'wake') return { code: 'unsupported_authority', reason: 'Unknown policy entry point.' };
  if (wakeSyntax === 'legacy') {
    if (kind !== 'conversation') {
      return { code: 'unsupported_authority', reason: `A legacy WAKE directive runs as a conversation turn, not ${kind}.` };
    }
    return 'legacy_wake_conversation';
  }
  if (wakeSyntax !== 'structured') return { code: 'unsupported_authority', reason: 'Unknown Wake syntax.' };
  if ((kind === 'revision') !== resumes) {
    return {
      code: 'unsupported_authority',
      reason: kind === 'revision' ? 'A revision names the Work Request it resumes.' : 'Only a revision resumes a Work Request.',
    };
  }
  return 'structured_wake';
}

// The one selection function every canonical request creator calls.
export function selectExecutionPolicy(request: PolicyRequest): PolicySelection {
  if (!isExecutionKind(request.executionKind)) {
    return rejected('unknown_execution_kind', `Unknown execution kind ${JSON.stringify(String(request.executionKind))}.`);
  }
  const kind = request.executionKind;
  const rule = ruleFor(request.entryPoint, kind, request.wakeSyntax, request.resumesWorkRequest === true);
  if (typeof rule !== 'string') return rejected(rule.code, rule.reason);
  return {
    ok: true,
    policy: Object.freeze({
      policy_version: EXECUTION_POLICY_VERSION,
      execution_kind: kind,
      tool_profile: TOOL_PROFILE_FOR_KIND[kind],
      entry_point: request.entryPoint,
      rule,
    }),
  };
}

const SNAPSHOT_KEYS = new Set(['policy_version', 'execution_kind', 'tool_profile', 'entry_point', 'rule']);

// Structural and semantic check of a stored or supplied snapshot: the
// exact key set, a known version, a known kind mapped to its profile, and
// a rule that selection would produce for that entry point.
export function validateExecutionPolicy(value: unknown): PolicySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return rejected('malformed_policy', 'The execution policy snapshot is missing.');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== SNAPSHOT_KEYS.size || keys.some(key => !SNAPSHOT_KEYS.has(key))) {
    return rejected('malformed_policy', 'The execution policy snapshot has unexpected fields.');
  }
  if (input.policy_version !== EXECUTION_POLICY_VERSION) {
    return rejected('malformed_policy', 'Unsupported execution policy version.');
  }
  if (!isExecutionKind(input.execution_kind)) {
    return rejected('unknown_execution_kind', `Unknown execution kind ${JSON.stringify(String(input.execution_kind))}.`);
  }
  if (!(TOOL_PROFILES as readonly unknown[]).includes(input.tool_profile)) {
    return rejected('unsupported_authority', `Unsupported tool profile ${JSON.stringify(String(input.tool_profile))}.`);
  }
  if (TOOL_PROFILE_FOR_KIND[input.execution_kind] !== input.tool_profile) {
    return rejected('unsupported_authority', `Execution kind ${input.execution_kind} requires the ${TOOL_PROFILE_FOR_KIND[input.execution_kind]} tool profile.`);
  }
  const allowed: Record<PolicyRule, { entry: PolicyEntryPoint[]; kinds: ExecutionKind[] }> = {
    direct_message_conversation: { entry: ['ui', 'api'], kinds: ['conversation'] },
    legacy_wake_conversation: { entry: ['wake'], kinds: ['conversation'] },
    coordinator_continuation: { entry: ['continuation'], kinds: ['conversation'] },
    session_exchange_conversation: { entry: ['exchange'], kinds: ['conversation'] },
    structured_wake: { entry: ['wake'], kinds: [...EXECUTION_KINDS] },
  };
  const rule = typeof input.rule === 'string' ? allowed[input.rule as PolicyRule] : undefined;
  if (!rule || !rule.entry.includes(input.entry_point as PolicyEntryPoint)) {
    return rejected('malformed_policy', 'The execution policy rule does not match its entry point.');
  }
  if (!rule.kinds.includes(input.execution_kind)) {
    return rejected('unsupported_authority', `Rule ${input.rule} does not grant ${input.execution_kind}.`);
  }
  return { ok: true, policy: Object.freeze({ ...(input as unknown as ExecutionPolicySnapshot) }) };
}

// Pre-launch gate over a persisted Work Request: its stored snapshot must
// be valid and agree with the request's own kind and profile columns.
export function authorizeWorkRequest(request: { execution_kind: unknown; tool_profile: unknown; policy_snapshot: unknown }): PolicySelection {
  if (!isExecutionKind(request.execution_kind)) {
    return rejected('unknown_execution_kind', `Unknown execution kind ${JSON.stringify(String(request.execution_kind))}.`);
  }
  let stored: unknown;
  try {
    stored = typeof request.policy_snapshot === 'string' ? JSON.parse(request.policy_snapshot) : null;
  } catch {
    return rejected('malformed_policy', 'The policy snapshot is not valid JSON.');
  }
  const snapshot = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>).execution_policy
    : undefined;
  const checked = validateExecutionPolicy(snapshot);
  if (!checked.ok) return checked;
  if (checked.policy.execution_kind !== request.execution_kind || checked.policy.tool_profile !== request.tool_profile) {
    return rejected('unsupported_authority', 'The Work Request authority does not match its policy snapshot.');
  }
  if ((stored as Record<string, unknown>).tool_profile !== request.tool_profile) {
    return rejected('malformed_policy', 'The policy snapshot tool profile does not match the Work Request.');
  }
  return checked;
}
