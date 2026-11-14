// NOT-507: the three session actions and when each is available. Pure (no
// I/O), shared by the Sessions drawer (app/components/SessionsPanel), the
// owner session routes, and the pin service (lib/session-pins), so the UI,
// the owner API, the service API, and MCP refuse the same things with the
// same reasons.
//
//   ask      Ask from this context: read-only turns pinned to the session.
//   resume   Resume work here: the same Agent in the same session with
//            workspace-write authority, only when the runtime enforces it,
//            the Agent's policy allows resuming with edits, and the caller
//            explicitly approves.
//   handoff  Hand off to…: a bounded handoff packet to another Agent, who
//            starts a fresh session of its own (the NOT-497 Continue).
//
// A session's route is how a turn reaches it: 'provider' through the
// Agent's SessionProvider (lib/provider-sessions), 'engine' as an Ask
// exchange on a Botmancers Session Binding (lib/session-exchanges), or null
// when nothing can reach it now.

export type SessionAction = 'ask' | 'resume' | 'handoff';
export const SESSION_ACTIONS: SessionAction[] = ['ask', 'resume', 'handoff'];

export type SessionRoute = 'provider' | 'engine' | null;

export const SESSION_ACTION_LABELS: Record<SessionAction, string> = {
  ask: 'Ask from this context',
  resume: 'Resume work here',
  handoff: 'Hand off to…',
};

// Stable codes, shared with the service API and MCP error envelopes.
export type ActionRefusalCode =
  | 'session_missing'
  | 'session_ended'
  | 'session_not_resumable'
  | 'source_session_busy'
  | 'action_unavailable'
  | 'authority_not_allowed';

// What the caller can do next.
export type Recovery = 'retry_later' | 'choose_session' | 'choose_action' | 'ask_owner' | 'approve_write' | 'pin_again';

export type ActionAvailability =
  | { available: true }
  | { available: false; code: ActionRefusalCode; reason: string; recovery: Recovery };

export type SessionActions = Record<SessionAction, ActionAvailability>;

export interface SessionActionRow {
  source: 'botmancers' | 'native';
  status: 'active' | 'ended';
  // The engine's own answer (an active binding a revision would resume).
  resumable: boolean;
  state: { availability: 'available' | 'missing'; lifecycle: 'open' | 'archived'; resumable: boolean | null; busy: boolean };
  agent: { name: string };
}

export interface SessionActionContext {
  route: SessionRoute;
  // The Agent's provider capabilities, or null without a SessionProvider.
  provider: { resume: boolean; authorities: string[] } | null;
  policy: { mode: 'read_only' | 'workspace_write'; allow_resume_with_edits: boolean } | null;
}

const RECOVERY: Record<ActionRefusalCode, Recovery> = {
  session_missing: 'choose_session',
  session_ended: 'choose_session',
  session_not_resumable: 'choose_session',
  source_session_busy: 'retry_later',
  action_unavailable: 'choose_action',
  authority_not_allowed: 'ask_owner',
};

// The recovery for every error code a pin, session, or exchange call can
// return (the service API and MCP add it to their error envelopes).
const ERROR_RECOVERY: Record<string, Recovery> = {
  ...RECOVERY,
  workspace_required: 'ask_owner',
  no_eligible_session: 'ask_owner',
  agent_unavailable: 'ask_owner',
  approval_required: 'approve_write',
  pin_not_found: 'pin_again',
  pin_detached: 'pin_again',
  provider_failed: 'retry_later',
  rate_limited: 'retry_later',
  // NOT-517: no exact session context; name the session explicitly.
  session_context_required: 'choose_session',
};

export function recoveryFor(code: string): Recovery | null {
  return Object.prototype.hasOwnProperty.call(ERROR_RECOVERY, code) ? ERROR_RECOVERY[code] : null;
}

function refuse(action: SessionAction, code: ActionRefusalCode, why: string): ActionAvailability {
  return { available: false, code, reason: `${SESSION_ACTION_LABELS[action]} is unavailable: ${why}`, recovery: RECOVERY[code] };
}

// The refusal every action shares: the session cannot take a turn now.
function reachable(action: SessionAction, row: SessionActionRow, route: SessionRoute): ActionAvailability {
  if (route === null) {
    return refuse(action, 'session_not_resumable', `nothing can reach this session under ${row.agent.name}’s current runtime. Its history stays here.`);
  }
  if (route === 'provider') {
    if (row.state.availability === 'missing') {
      return refuse(action, 'session_missing', 'the runtime no longer has this session. Its history stays here; choose another session.');
    }
    if (row.state.resumable === false) {
      return refuse(action, 'session_not_resumable', 'the runtime says this session can’t be resumed. Choose another session.');
    }
  } else {
    if (row.status === 'ended') return refuse(action, 'session_ended', 'this session has ended. Its history stays here.');
    if (!row.resumable) {
      return refuse(action, 'session_not_resumable', `Botmancers can’t resume this session under ${row.agent.name}’s current runtime.`);
    }
  }
  if (row.state.busy) return refuse(action, 'source_session_busy', 'a Claude Code process is working in this session. Try again when it finishes.');
  return { available: true };
}

export function sessionActions(row: SessionActionRow, ctx: SessionActionContext): SessionActions {
  const ask = reachable('ask', row, ctx.route);
  let resume = reachable('resume', row, ctx.route);
  if (resume.available) {
    if (ctx.route !== 'provider') {
      resume = refuse('resume', 'action_unavailable', 'this runtime can’t resume a session with edits. Ask from this context, or hand off to another Agent.');
    } else if (!ctx.provider?.authorities.includes('workspace_write')) {
      resume = refuse('resume', 'action_unavailable', 'this runtime can’t enforce edit access in a resumed session. Ask from this context instead.');
    } else if (!ctx.policy || ctx.policy.mode !== 'workspace_write') {
      resume = refuse('resume', 'authority_not_allowed', `${row.agent.name}’s policy is read only. The owner can allow workspace write in Config.`);
    } else if (!ctx.policy.allow_resume_with_edits) {
      resume = refuse('resume', 'authority_not_allowed', `${row.agent.name}’s policy doesn’t allow resuming with edits. The owner can allow it in Config.`);
    }
  }
  // Hand off keeps its NOT-497 semantics: the source turn is an engine
  // exchange on an active Botmancers binding.
  let handoff: ActionAvailability;
  if (row.source !== 'botmancers') {
    handoff = refuse('handoff', 'action_unavailable', 'hand off starts from a Botmancers-launched session. Ask from this context or resume this one instead.');
  } else {
    handoff = reachable('handoff', row, 'engine');
  }
  return { ask, resume, handoff };
}
