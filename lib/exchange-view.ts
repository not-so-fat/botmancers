// NOT-498: pure presentation helpers for session-targeted Ask and Continue
// in the UI: the session-row actions and their dialogs
// (app/components/ExchangeDialog), the inline exchange cards
// (app/components/ExchangeCard), and the Agent Exchanges ledger
// (app/exchanges/page). The shapes mirror lib/exchange-ledger's JSON. Every
// state shown comes from the exchange API's `state` and events, never from
// message prose; nothing here sees a provider session id.

import { formatSessionDate, type SessionRow } from './session-view';
import { SESSION_ACTION_LABELS, type ActionAvailability, type SessionAction, type SessionActions } from './session-actions';

export type ExchangeMode = 'ask' | 'continue';
export type ExchangeState = 'queued' | 'extracting' | 'delivering' | 'completed' | 'failed' | 'cancelled';

export const EXCHANGE_STATES: ExchangeState[] = ['queued', 'extracting', 'delivering', 'completed', 'failed', 'cancelled'];
export const TERMINAL_EXCHANGE_STATES: ExchangeState[] = ['completed', 'failed', 'cancelled'];
// The core's EXCHANGE_LIMITS.instructionChars.
export const INSTRUCTION_LIMIT = 4000;

export interface ExchangeConversationRef {
  id: string;
  kind: 'direct' | 'group' | 'agent_api';
  label: string;
  thread_agent_id: string | null;
}

export type ExchangeLinkRole = 'origin' | 'source' | 'destination';

export interface ExchangeLink extends ExchangeConversationRef {
  roles: ExchangeLinkRole[];
}

export interface ExchangeSummary {
  id: string;
  mode: ExchangeMode;
  state: ExchangeState;
  terminal: boolean;
  can_cancel: boolean;
  cancel_requested: boolean;
  instruction: string;
  source: { agent_id: string; agent_name: string; session_title: string; conversation: ExchangeConversationRef | null };
  destination: { agent_id: string; agent_name: string; session_title: string | null; conversation: ExchangeConversationRef | null } | null;
  origin: ExchangeConversationRef | null;
  links: ExchangeLink[];
  outcome: { answer: string | null; objective: string | null; reply: string | null };
  failure: { code: string; message: string } | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface ExchangeEventView {
  sequence: number;
  type: string;
  at: number;
  data: Record<string, unknown> | null;
}

export interface HandoffPacketView {
  objective: string;
  decisions: string[];
  constraints: string[];
  artifacts: string[];
  open_questions: string[];
}

export interface ExchangeDetail {
  summary: ExchangeSummary;
  events: ExchangeEventView[];
  packet: HandoffPacketView | null;
  answer: string | null;
}

export function isTerminal(state: ExchangeState): boolean {
  return TERMINAL_EXCHANGE_STATES.includes(state);
}

export function modeLabel(mode: ExchangeMode): string {
  return mode === 'ask' ? 'Ask' : 'Continue';
}

export function stateLabel(mode: ExchangeMode, state: ExchangeState): string {
  switch (state) {
    case 'queued': return 'Queued';
    case 'extracting': return mode === 'ask' ? 'Asking the session' : 'Extracting handoff';
    case 'delivering': return 'Delivering handoff';
    case 'completed': return mode === 'ask' ? 'Answered' : 'Handed off';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

// The label on a card or row: a cancel the owner asked for shows until the
// API reports the exchange cancelled.
export function liveStateLabel(summary: Pick<ExchangeSummary, 'mode' | 'state' | 'cancel_requested'>): string {
  if (summary.cancel_requested && !isTerminal(summary.state)) return 'Cancelling…';
  return stateLabel(summary.mode, summary.state);
}

// Visual tone: in progress, done, or stopped/failed.
export function stateTone(state: ExchangeState): 'active' | 'done' | 'stopped' {
  if (state === 'completed') return 'done';
  if (state === 'failed' || state === 'cancelled') return 'stopped';
  return 'active';
}

export function excerpt(text: string | null | undefined, limit = 140): string {
  const line = String(text ?? '').split('\n').map(part => part.trim()).filter(part => part.length > 0).join(' ');
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

export function formatExchangeTime(ts: number): string {
  return formatSessionDate(ts);
}

// "Dev's session “Add the session catalog read model”".
export function sessionLabel(summary: Pick<ExchangeSummary, 'source'>): string {
  return `${summary.source.agent_name}'s session “${summary.source.session_title}”`;
}

// Who the exchange runs between: the source Agent, and either the owner
// (an Ask answers back) or the destination Agent.
export function participantsLabel(summary: Pick<ExchangeSummary, 'mode' | 'source' | 'destination'>): string {
  if (summary.mode === 'ask') return `You → ${summary.source.agent_name}`;
  return `${summary.source.agent_name} → ${summary.destination?.agent_name ?? 'another Agent'}`;
}

export function instructionHeading(mode: ExchangeMode): string {
  return mode === 'ask' ? 'Question' : 'Objective';
}

// What a terminal exchange produced, or why it stopped. Null while live.
export function outcomeLine(summary: ExchangeSummary): string | null {
  if (summary.state === 'completed') {
    if (summary.mode === 'ask') {
      const where = summary.origin?.label ?? 'the origin thread';
      return summary.outcome.answer ? `Answer in ${where}: ${excerpt(summary.outcome.answer, 200)}` : `Answered in ${where}.`;
    }
    const who = summary.destination?.agent_name ?? 'The destination Agent';
    return summary.outcome.reply
      ? `${who} picked it up in a new session: ${excerpt(summary.outcome.reply, 200)}`
      : `${who} picked it up in a new session.`;
  }
  if (summary.state === 'failed') return summary.failure?.message || 'The exchange failed.';
  if (summary.state === 'cancelled') return 'Cancelled before it finished. Nothing more will run.';
  return null;
}

// What to do about a failure, by its stable code.
export function failureAdvice(summary: ExchangeSummary): string | null {
  if (summary.state !== 'failed') return null;
  switch (summary.failure?.code) {
    case 'packet_invalid':
    case 'packet_missing':
      return 'The source session did not return a usable handoff. Start a new Continue with a clearer objective.';
    case 'destination_session_invalid':
      return 'The destination did not start a fresh session. Check its runtime, then start a new Continue.';
    case 'destination_turn_failed':
      return 'Check the destination Agent’s runtime, then start a new Continue from the source session.';
    case 'source_turn_failed':
      return 'Check the source Agent’s runtime, then start a new exchange from its Sessions.';
    default:
      return 'Start a new exchange from the session to try again.';
  }
}

export function detailsHref(id: string): string {
  return `/exchanges?id=${encodeURIComponent(id)}`;
}

// Where a linked thread opens: an owner thread opens in the chat with its
// Agent selected; a group thread (no owner Agent) opens its own thread page
// (app/threads/[id]). Either way the exchange's card is brought into view.
// An Agent API conversation is not an owner thread and has no backlink.
export function threadHref(link: Pick<ExchangeConversationRef, 'id' | 'kind' | 'thread_agent_id'>, exchangeId?: string): string | null {
  const params = new URLSearchParams();
  if (link.thread_agent_id) {
    params.set('agent', link.thread_agent_id);
    if (exchangeId) params.set('exchange', exchangeId);
    return `/?${params.toString()}`;
  }
  if (link.kind !== 'group') return null;
  if (exchangeId) params.set('exchange', exchangeId);
  const query = params.toString();
  return `/threads/${encodeURIComponent(link.id)}${query ? `?${query}` : ''}`;
}

export function linkRoleLabel(roles: ExchangeLinkRole[]): string {
  const names: Record<ExchangeLinkRole, string> = { origin: 'Started here', source: 'Source session', destination: 'Destination' };
  return roles.map(role => names[role]).join(' · ');
}

// ----- Session-row actions ---------------------------------------------

export type SessionActionAvailability = { available: true } | { available: false; reason: string };

// Ask from this context and Hand off to… run only against a session
// Botmancers can resume (the catalog's `resumable`); others keep their
// history and say why. A row from an older server has no `actions`.
export function sessionActionAvailability(row: Pick<SessionRow, 'status' | 'resumable' | 'agent'>): SessionActionAvailability {
  if (row.status === 'ended') {
    return { available: false, reason: 'Ask from this context and Hand off to… are unavailable: this session has ended. Its history stays here.' };
  }
  if (!row.resumable) {
    return {
      available: false,
      reason: `Ask from this context and Hand off to… are unavailable: Botmancers can’t resume this session under ${row.agent.name}’s current runtime.`,
    };
  }
  return { available: true };
}

// NOT-507: the three session actions of a row, in display order, from the
// server's capability- and state-based `actions` (lib/session-actions), or
// for an older row from `resumable` (no Resume work here).
export function sessionRowActions(row: Pick<SessionRow, 'status' | 'resumable' | 'agent' | 'actions'>): { action: SessionAction; label: string; availability: ActionAvailability }[] {
  let actions: SessionActions;
  if (row.actions) actions = row.actions;
  else {
    const legacy = sessionActionAvailability(row);
    const fallback: ActionAvailability = legacy.available
      ? { available: true }
      : { available: false, code: row.status === 'ended' ? 'session_ended' : 'session_not_resumable', reason: legacy.reason, recovery: 'choose_session' };
    actions = {
      ask: fallback,
      resume: { available: false, code: 'action_unavailable', reason: `${SESSION_ACTION_LABELS.resume} is unavailable: this runtime can’t resume a session with edits.`, recovery: 'choose_action' },
      handoff: fallback,
    };
  }
  return (['ask', 'resume', 'handoff'] as SessionAction[]).map(action => ({ action, label: SESSION_ACTION_LABELS[action], availability: actions[action] }));
}

// NOT-507: the owner's pin request (Ask from this context on a session only
// a SessionProvider can reach, or Resume work here).
export function pinRequestBody(action: 'ask' | 'resume', content: string, conversationId: string, approveWrite: boolean, idempotencyKey: string) {
  return {
    action, content: content.trim(), conversation_id: conversationId, idempotency_key: idempotencyKey,
    ...(action === 'resume' ? { approve_write: approveWrite } : {}),
  };
}

// NOT-507: the session dialog's three modes. 'continue' is the NOT-497
// handoff exchange, shown as Hand off to…; 'resume' is Resume work here.
export type SessionDialogMode = ExchangeMode | 'resume';

export function sessionDialogMode(action: SessionAction): SessionDialogMode {
  return action === 'handoff' ? 'continue' : action;
}

export function sessionDialogTitle(mode: SessionDialogMode): string {
  return SESSION_ACTION_LABELS[mode === 'continue' ? 'handoff' : mode];
}

// Ask goes through a pin when only a SessionProvider reaches the session;
// Resume always does. An engine-route Ask stays a NOT-498 Ask exchange.
export function sessionDialogUsesPin(mode: SessionDialogMode, route: SessionRow['route']): boolean {
  return mode === 'resume' || (mode === 'ask' && route === 'provider');
}

// Resume work here needs an instruction and the owner's explicit approval
// of edits in this session.
export function validateResumeDraft(instruction: string, approveWrite: boolean): DraftErrors & { approval?: string } {
  const errors: DraftErrors & { approval?: string } = {};
  if (!instruction.trim()) errors.instruction = 'Enter what to work on.';
  else if (instruction.length > INSTRUCTION_LIMIT) errors.instruction = `Keep it under ${INSTRUCTION_LIMIT} characters.`;
  if (!approveWrite) errors.approval = 'Approve edits in this session to resume work here.';
  return errors;
}

export interface ExchangeDraft {
  mode: ExchangeMode;
  instruction: string;
  originConversationId: string;
  destinationAgentId: string;
}

export type DraftErrors = Partial<Record<'instruction' | 'destination' | 'origin', string>>;

export function validateDraft(draft: ExchangeDraft): DraftErrors {
  const errors: DraftErrors = {};
  const text = draft.instruction.trim();
  const what = draft.mode === 'ask' ? 'a question' : 'an objective';
  if (!text) errors.instruction = `Enter ${what}.`;
  else if (draft.instruction.length > INSTRUCTION_LIMIT) errors.instruction = `Keep it under ${INSTRUCTION_LIMIT} characters.`;
  if (!draft.originConversationId) errors.origin = 'Choose the thread that follows this exchange.';
  if (draft.mode === 'continue' && !draft.destinationAgentId) errors.destination = 'Choose the Agent who continues the work.';
  return errors;
}

// The POST /api/exchanges body. The session is named by its Botmancers
// reference (the catalog row's ref), which the owner never types or sees.
export function exchangeRequestBody(draft: ExchangeDraft, source: { agentId: string; sessionRef: string }, idempotencyKey: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: draft.mode,
    idempotency_key: idempotencyKey,
    origin_conversation_id: draft.originConversationId,
    source: { agent_id: source.agentId, session_ref: source.sessionRef },
    instruction: draft.instruction.trim(),
  };
  if (draft.mode === 'continue') body.destination = { agent_id: draft.destinationAgentId };
  return body;
}

// A server refusal as a sentence the owner can act on. Field-level codes
// map onto the field they concern.
export function submitErrorMessage(code: string | null, message: string | null): string {
  switch (code) {
    case 'session_ended': return 'This session has ended and can’t be resumed.';
    case 'session_not_resumable': return 'Botmancers can’t resume this session under the Agent’s current runtime.';
    case 'source_session_busy': return 'This session already has an exchange in progress. Wait for it or cancel it from its card.';
    case 'agent_unavailable': return message || 'That Agent has no Agent Deck selected.';
    case 'idempotency_conflict': return 'This request changed while it was being sent. Send again.';
    // NOT-507: pin refusals. The session is never swapped for another.
    case 'session_missing': return 'The runtime no longer has this session. Its history stays here; choose another session.';
    case 'approval_required': return 'Resume work here needs your approval of edits. Tick the approval, then send again.';
    case 'authority_not_allowed': return message || 'This Agent’s policy doesn’t allow edits in a resumed session. Change it in Config.';
    case 'action_unavailable': return message || 'This runtime can’t do that in this session. Choose another action.';
    case 'provider_failed': return 'The runtime failed this turn. Nothing moved to another session; try again later.';
    default: return message || 'The exchange could not be started. Your draft is kept; try again.';
  }
}

// ----- Ledger -------------------------------------------------------------

export type ModeFilter = 'all' | ExchangeMode;
export type StateFilter = 'all' | 'active' | ExchangeState;

export const MODE_FILTER_OPTIONS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ask', label: 'Ask' },
  { value: 'continue', label: 'Continue' },
];

export const STATE_FILTER_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'In progress' },
  { value: 'queued', label: 'Queued' },
  { value: 'extracting', label: 'Asking / extracting' },
  { value: 'delivering', label: 'Delivering' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export interface LedgerFilter {
  mode: ModeFilter;
  state: StateFilter;
  agentId: string;
}

export const DEFAULT_LEDGER_FILTER: LedgerFilter = { mode: 'all', state: 'all', agentId: '' };

export function matchesFilter(summary: ExchangeSummary, filter: LedgerFilter): boolean {
  if (filter.mode !== 'all' && summary.mode !== filter.mode) return false;
  if (filter.state === 'active' && summary.terminal) return false;
  if (filter.state !== 'all' && filter.state !== 'active' && summary.state !== filter.state) return false;
  if (filter.agentId && summary.source.agent_id !== filter.agentId && summary.destination?.agent_id !== filter.agentId) return false;
  return true;
}

// Newest activity first; ties by newest creation, then id, so the order is
// the same on every refresh.
export function byActivity(a: ExchangeSummary, b: ExchangeSummary): number {
  return b.updated_at - a.updated_at || b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function ledgerRows(all: ExchangeSummary[], filter: LedgerFilter): ExchangeSummary[] {
  return all.filter(summary => matchesFilter(summary, filter)).sort(byActivity);
}

// Every Agent that appears in the ledger, by name.
export function ledgerAgents(all: ExchangeSummary[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const summary of all) {
    seen.set(summary.source.agent_id, summary.source.agent_name);
    if (summary.destination) seen.set(summary.destination.agent_id, summary.destination.agent_name);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type LedgerView = 'loading' | 'error' | 'empty' | 'filtered-out' | 'rows';

export function ledgerView(all: ExchangeSummary[] | null, error: string, rows: ExchangeSummary[]): LedgerView {
  if (all === null) return error ? 'error' : 'loading';
  if (all.length === 0) return 'empty';
  return rows.length === 0 ? 'filtered-out' : 'rows';
}

// One timeline entry, worded from the event type and its data. Ids in the
// data are never shown.
export function eventLabel(event: ExchangeEventView, summary: Pick<ExchangeSummary, 'mode' | 'source' | 'destination' | 'origin'>): string {
  const data = event.data ?? {};
  const source = summary.source.agent_name;
  const destination = summary.destination?.agent_name ?? 'the destination Agent';
  const hop = typeof data.hop === 'string' ? data.hop : null;
  switch (event.type) {
    case 'created':
      return summary.mode === 'ask' ? `You asked ${source}'s session a question` : `You handed ${source}'s session to ${destination}`;
    case 'hop_queued':
      if (hop === 'deliver') return `Handoff queued for ${destination}'s new session`;
      return hop === 'extract' ? `Handoff extraction queued in ${source}'s session` : `Question queued for ${source}'s session`;
    case 'hop_started':
      if (hop === 'deliver') return `${destination} started a new session`;
      return hop === 'extract' ? `${source}'s session started extracting the handoff` : `${source}'s session started answering`;
    case 'state_changed': {
      const to = typeof data.to === 'string' && EXCHANGE_STATES.includes(data.to as ExchangeState) ? data.to as ExchangeState : null;
      return to ? `Now ${stateLabel(summary.mode, to).toLowerCase()}` : 'State changed';
    }
    case 'answer_returned':
      return `Answer returned to ${summary.origin?.label ?? 'the origin thread'}${data.truncated ? ' (shortened)' : ''}`;
    case 'packet_extracted':
      return 'Handoff packet extracted';
    case 'packet_rejected':
      return `Handoff packet refused${typeof data.reason === 'string' ? `: ${data.reason}` : ''}`;
    case 'destination_replied':
      return `${destination} replied in ${summary.destination?.conversation?.label ?? 'its thread'}`;
    case 'destination_session_rejected':
      return `${destination}'s session was not new; the handoff stopped`;
    case 'cancel_requested':
      return 'You asked to cancel';
    case 'hop_result_discarded':
      return 'A late result was discarded';
    default:
      return event.type.replace(/_/g, ' ');
  }
}
