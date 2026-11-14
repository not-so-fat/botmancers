// NOT-519: pure presentation helpers for the owner's session-share UI: the
// Slack share section of a Sessions row (app/components/SessionShares) and
// the Session sharing card on Agent Config (app/components/SharePolicyCard).
// The shapes mirror lib/session-share-owner's JSON; nothing here sees a
// provider id, workspace, or token.

import { formatSessionDate, type SessionRow } from './session-view';
import { sessionRowActions } from './exchange-view';

export type OwnerShareStatus = 'active' | 'exhausted' | 'answering' | 'recovering' | 'expired' | 'revoked';

export interface SlackAudience {
  kind: 'slack';
  team_id: string;
  channel_id: string;
}

export interface OwnerShare {
  share_ref: string;
  agent: { id: string; name: string | null };
  session_ref: string;
  authority: 'ask';
  state: 'active' | 'expired' | 'revoked';
  status: OwnerShareStatus;
  audience: SlackAudience;
  created_via: 'session_ref' | 'current_session';
  created_by: 'owner' | 'service' | 'current_session';
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  max_turns: number;
  turns_used: number;
  thread: { posted: boolean; posted_at: number | null };
}

export interface SharePolicy {
  state: 'absent' | 'loaded' | 'invalid';
  reason: string | null;
  revision: string;
  audiences: SlackAudience[];
  agent: {
    id: string;
    share_from_turn: boolean;
    share_current: { supported: boolean; reason: string | null };
    live_contexts: number;
  };
  limits: { ttl_seconds: { min: number; default: number; max: number }; max_turns: { min: number; default: number; max: number }; audiences: number };
}

export const SHARE_STATUS_LABELS: Record<OwnerShareStatus, string> = {
  active: 'Active',
  exhausted: 'Questions used',
  answering: 'Answering',
  recovering: 'Recovering',
  expired: 'Expired',
  revoked: 'Revoked',
};

// A share that can still take (or is taking) a Slack question.
export function shareIsLive(share: Pick<OwnerShare, 'state'>): boolean {
  return share.state === 'active';
}

export function audienceLabel(audience: Pick<SlackAudience, 'team_id' | 'channel_id'>): string {
  return `Slack channel ${audience.channel_id} · workspace ${audience.team_id}`;
}

export function turnsLabel(share: Pick<OwnerShare, 'turns_used' | 'max_turns'>): string {
  return `${share.turns_used} of ${share.max_turns} question${share.max_turns === 1 ? '' : 's'} used`;
}

function inMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function expiryLabel(share: Pick<OwnerShare, 'state' | 'expires_at' | 'revoked_at'>, now: number = Date.now()): string {
  if (share.state === 'revoked') return `Revoked ${formatSessionDate(share.revoked_at ?? share.expires_at)}`;
  if (share.state === 'expired' || share.expires_at <= now) return `Expired ${formatSessionDate(share.expires_at)}`;
  return `Expires ${formatSessionDate(share.expires_at)} (in ${inMinutes(share.expires_at - now)})`;
}

export function threadLabel(share: Pick<OwnerShare, 'state' | 'thread'>): string {
  if (share.thread.posted) return `Slack thread posted ${formatSessionDate(share.thread.posted_at ?? 0)}`;
  return share.state === 'active' ? 'Waiting for the Slack relay to post the thread' : 'No Slack thread was posted';
}

// What the owner should know about a share's state, and what happens to
// the next Slack question in its thread.
export function shareStatusNote(share: Pick<OwnerShare, 'status' | 'max_turns'>): string {
  switch (share.status) {
    case 'active': return 'Slack replies in its thread ask this session (read-only).';
    case 'answering': return 'A Slack question is being answered now. The next one waits until it finishes.';
    case 'recovering': return 'A question was interrupted by a Botmancers restart. The next Slack question clears it.';
    case 'exhausted': return `All ${share.max_turns} questions are used. Slack questions get the limit notice; create a new share to keep going.`;
    case 'expired': return 'Expired: Slack questions get the expired notice. Its history stays here.';
    case 'revoked': return 'Revoked: Slack questions get the revoked notice. Its history stays here.';
  }
}

export function createdByLabel(share: Pick<OwnerShare, 'created_by'>): string {
  return share.created_by === 'owner' ? 'Shared by you' : share.created_by === 'current_session' ? 'Shared from a turn of this session' : 'Shared by a service';
}

// Live shares first (newest first), then ended ones (most recent first).
export function sessionShares(shares: OwnerShare[], sessionRef: string): OwnerShare[] {
  const mine = shares.filter(share => share.session_ref === sessionRef);
  const ended = (share: OwnerShare) => share.revoked_at ?? share.expires_at;
  return [
    ...mine.filter(shareIsLive).sort((a, b) => b.created_at - a.created_at),
    ...mine.filter(share => !shareIsLive(share)).sort((a, b) => ended(b) - ended(a)),
  ];
}

export type ShareAvailability = { available: true } | { available: false; reason: string; configHref: string | null };

// Share to Slack is offered when the session can take an Ask now (the same
// answer as Ask from this context) and the owner's allowlist names at least
// one Slack channel.
export function shareCreateAvailability(row: Pick<SessionRow, 'status' | 'resumable' | 'agent' | 'actions'>, policy: SharePolicy | null): ShareAvailability {
  const configHref = `/agents/${encodeURIComponent(row.agent.id)}/config#session-sharing`;
  if (!policy) return { available: false, reason: 'Share to Slack is unavailable: the share policy could not be loaded.', configHref: null };
  const ask = sessionRowActions(row).find(item => item.action === 'ask');
  if (ask && !ask.availability.available) {
    return { available: false, reason: ask.availability.reason.replace(/^Ask from this context is unavailable:/, 'Share to Slack is unavailable:'), configHref: null };
  }
  if (policy.state === 'invalid') return { available: false, reason: 'Share to Slack is unavailable: the share policy file is invalid. Fix it in Config.', configHref };
  if (policy.audiences.length === 0) return { available: false, reason: 'Share to Slack needs a Slack channel on the share allowlist. Add one in Config.', configHref };
  return { available: true };
}

// NOT-610: an idle Claude Code CLI open on the session does not block a
// share, but a share question appends to the transcript it has open.
export const SHARE_OPEN_CLI_NOTE = "If Claude Code is still open on this session, don't type in it while the share is live. It won't see the Slack questions.";

export const SHARE_DURATIONS: { label: string; seconds: number }[] = [
  { label: '5 minutes', seconds: 300 },
  { label: '1 hour', seconds: 3600 },
  { label: '8 hours', seconds: 8 * 3600 },
  { label: '24 hours', seconds: 86400 },
];

export function shareCreateBody(audience: SlackAudience, ttlSeconds: number, maxTurns: number, idempotencyKey: string) {
  return { audience: { team_id: audience.team_id, channel_id: audience.channel_id }, ttl_seconds: ttlSeconds, max_turns: maxTurns, idempotency_key: idempotencyKey };
}

// Client-side check of one allowlist entry (the server validates the whole
// document again before writing it).
const TEAM_ID = /^T[A-Z0-9]{2,20}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/;

export function audienceInputError(teamId: string, channelId: string, existing: Pick<SlackAudience, 'team_id' | 'channel_id'>[]): string | null {
  const team = teamId.trim();
  const channel = channelId.trim();
  if (!TEAM_ID.test(team)) return 'Workspace ID must look like T0123ABCD (a Slack team ID; no wildcards).';
  if (!CHANNEL_ID.test(channel)) return 'Channel ID must look like C0123ABCD (a public or private channel ID; no wildcards).';
  if (existing.some(entry => entry.team_id === team && entry.channel_id === channel)) return 'That channel is already on the allowlist.';
  return null;
}

export function shareFromTurnNote(policy: SharePolicy): string {
  if (!policy.agent.share_current.supported) return policy.agent.share_current.reason ?? 'This runtime cannot share its own session from a turn.';
  return policy.agent.share_from_turn
    ? 'On: a turn Botmancers launches for this agent can share its own session to an allowlisted channel. Turning it off revokes every live turn context at once.'
    : 'Off: no turn of this agent can share its own session. Sessions can still be shared from the Sessions page.';
}
