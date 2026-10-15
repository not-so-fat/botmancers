// NOT-449: known runtime/setup failure observations, classified before
// normal bot-message rendering.
//
// The server posts these as bot-sender messages (lib/agent.ts) so the
// failure is durable and visible in the thread. The UI must not present
// them as something the bot said: the thread renders an application
// status callout and the roster shows a short stable state instead. The
// stored text is untouched and stays reachable as `detail`.
//
// Pure and client-safe: matches the sentinel shapes by pattern rather than
// importing lib/agent.ts (which pulls in the database). Unknown text is
// never classified, so unknown failures keep rendering as written. Agent
// Deck notices (including "[Deck needs selection]") keep their existing
// event presentation and are not classified here.

export type RuntimeFailureKind = 'hermes-config-missing' | 'hermes-turn-failed';

export type RuntimeFailureSeverity = 'error';

export interface RuntimeFailure {
  kind: RuntimeFailureKind;
  severity: RuntimeFailureSeverity;
  // Short stable state, used as the callout title and the roster preview.
  title: string;
  // One-line recovery direction shown under the title.
  recovery: string;
  // The exact stored message, for the Details/Copy affordance.
  detail: string;
}

const SEVERITY_LABELS: Record<RuntimeFailureSeverity, string> = {
  error: 'Error',
};

export function severityLabel(severity: RuntimeFailureSeverity): string {
  return SEVERITY_LABELS[severity];
}

interface FailureRule {
  kind: RuntimeFailureKind;
  severity: RuntimeFailureSeverity;
  pattern: RegExp;
  title: string;
  recovery: string;
}

const RULES: readonly FailureRule[] = [
  {
    kind: 'hermes-config-missing',
    severity: 'error',
    pattern: /^\[Hermes configuration missing: [^\n]*\]$/,
    title: 'Hermes needs configuration',
    recovery: 'This agent can’t reply until the Hermes API key is set on the Botmancers server. Set it, restart, then send your message again.',
  },
  {
    kind: 'hermes-turn-failed',
    severity: 'error',
    pattern: /^\[Hermes turn failed for [\s\S]*\]$/,
    title: 'Hermes couldn’t complete the turn',
    recovery: 'Check that the Hermes gateway is running and reachable, then send your message again.',
  },
];

export function classifyRuntimeFailure(content: string | null | undefined): RuntimeFailure | null {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const rule = RULES.find(item => item.pattern.test(text));
  if (!rule) return null;
  return {
    kind: rule.kind,
    severity: rule.severity,
    title: rule.title,
    recovery: rule.recovery,
    detail: text,
  };
}
