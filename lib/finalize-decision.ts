// NOT-487: the coordinator's explicit finalization decision
// (docs/wake-contract-v1.md, Finalization decision). Pure parsing and
// validation of ```botmancers-finalize``` blocks in one Agent reply.
//
// The decision names the implementation (or revision) Work Request and the
// review Work Request it accepts. It carries no paths, digests, modes, or
// run identifiers: Botmancers submits the candidate manifest it persisted
// for that implementation, unchanged. Unknown fields fail closed, so a
// coordinator can never broaden or rewrite the manifest. Free-form prose
// ("looks good, ship it") is not a decision; only a valid block is.

export type FinalizeDecisionKind = 'accept' | 'reject';

export interface FinalizeDecision {
  version: 1;
  decision: FinalizeDecisionKind;
  implementationAttemptId: string;
  reviewAttemptId: string;
  commitMessage?: string;
}

export type FinalizeDecisionValidation =
  | { ok: true; decision: FinalizeDecision }
  | { ok: false; reason: string };

export interface FinalizeDecisionCandidate {
  position: number;
  validation: FinalizeDecisionValidation;
}

export const FINALIZE_COMMIT_MESSAGE_MAX = 2000;

const KEYS = new Set(['version', 'decision', 'implementationAttemptId', 'reviewAttemptId', 'commitMessage']);

function reference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

export function validateFinalizeDecision(value: unknown): FinalizeDecisionValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'decision must be a JSON object' };
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !KEYS.has(key));
  if (unknown.length > 0) return { ok: false, reason: `unknown field ${unknown.join(', ')} (the manifest is never supplied in a decision)` };
  if (input.version !== 1) return { ok: false, reason: 'version must be 1' };
  if (input.decision !== 'accept' && input.decision !== 'reject') return { ok: false, reason: 'decision must be "accept" or "reject"' };
  if (!reference(input.implementationAttemptId)) return { ok: false, reason: 'implementationAttemptId must name an Attempt' };
  if (!reference(input.reviewAttemptId)) return { ok: false, reason: 'reviewAttemptId must name an Attempt' };
  const decision: FinalizeDecision = {
    version: 1,
    decision: input.decision,
    implementationAttemptId: input.implementationAttemptId.trim(),
    reviewAttemptId: input.reviewAttemptId.trim(),
  };
  if (input.commitMessage !== undefined) {
    if (typeof input.commitMessage !== 'string' || input.commitMessage.trim().length === 0
      || input.commitMessage.length > FINALIZE_COMMIT_MESSAGE_MAX || input.commitMessage.includes('\u0000')) {
      return { ok: false, reason: `commitMessage must be non-empty text (max ${FINALIZE_COMMIT_MESSAGE_MAX} characters)` };
    }
    decision.commitMessage = input.commitMessage.trim();
  }
  return { ok: true, decision };
}

const FENCE = /```botmancers-finalize[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export function parseFinalizeDecisions(content: string): FinalizeDecisionCandidate[] {
  return [...content.matchAll(FENCE)].map((match, position) => {
    let validation: FinalizeDecisionValidation;
    try {
      validation = validateFinalizeDecision(JSON.parse(match[1]));
    } catch {
      validation = { ok: false, reason: 'block is not valid JSON' };
    }
    return { position, validation };
  });
}
