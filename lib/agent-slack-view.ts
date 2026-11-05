// NOT-552: safe presentation helpers for the Agent Slack operations page.
// This module deliberately accepts only the redacted health contract and
// owner share views. Unknown values become an unavailable state; raw server
// errors and configured credential values never become display copy.

import type { OwnerShare, OwnerShareStatus } from './share-view';

export type RelayState = 'disabled' | 'misconfigured' | 'failed' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export type RelayReason =
  | 'slack_tokens_absent'
  | 'app_token_missing' | 'bot_token_missing' | 'app_token_invalid' | 'bot_token_invalid'
  | 'share_config_absent' | 'share_config_invalid' | 'share_config_no_audience' | 'workspace_not_allowlisted'
  | 'slack_auth_failed' | 'slack_connect_failed';

export interface RelayHealth {
  state: RelayState;
  reason: RelayReason | null;
  since: number;
  connections: number;
}

export const RELAY_STATES: RelayState[] = ['disabled', 'misconfigured', 'connecting', 'connected', 'reconnecting', 'failed', 'stopped'];
const RELAY_REASONS: RelayReason[] = [
  'slack_tokens_absent', 'app_token_missing', 'bot_token_missing', 'app_token_invalid', 'bot_token_invalid',
  'share_config_absent', 'share_config_invalid', 'share_config_no_audience', 'workspace_not_allowlisted',
  'slack_auth_failed', 'slack_connect_failed',
];

export function normalizeRelayHealth(value: unknown): RelayHealth | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!RELAY_STATES.includes(candidate.state as RelayState)) return null;
  const reason = candidate.reason === null ? null : RELAY_REASONS.includes(candidate.reason as RelayReason) ? candidate.reason as RelayReason : null;
  return {
    state: candidate.state as RelayState,
    reason,
    since: Number.isFinite(candidate.since) ? Number(candidate.since) : 0,
    connections: Number.isInteger(candidate.connections) && Number(candidate.connections) >= 0 ? Number(candidate.connections) : 0,
  };
}

export interface RelayCopy { label: string; summary: string; guidance: string; tone: 'good' | 'working' | 'warning' | 'quiet' }

const MISCONFIGURED_GUIDANCE: Partial<Record<RelayReason, string>> = {
  app_token_missing: 'Add the Socket Mode app token to the Botmancers core environment, then restart Botmancers.',
  bot_token_missing: 'Add the bot token to the Botmancers core environment, then restart Botmancers.',
  app_token_invalid: 'Replace the Socket Mode app token with a valid value, then restart Botmancers.',
  bot_token_invalid: 'Replace the bot token with a valid value, then restart Botmancers.',
  share_config_absent: 'Add an allowlisted Slack channel in Agent Config, then restart Botmancers.',
  share_config_invalid: 'Repair the session sharing policy in Agent Config, then restart Botmancers.',
  share_config_no_audience: 'Add an allowlisted Slack channel in Agent Config, then restart Botmancers.',
  workspace_not_allowlisted: 'Allowlist a channel from the workspace connected to the Botmancers Slack app, then restart Botmancers.',
};

export function relayCopy(health: RelayHealth): RelayCopy {
  switch (health.state) {
    case 'disabled': return { label: 'Disabled', summary: 'The optional Botmancers Slack relay is off.', guidance: 'To use Slack sharing, configure both Slack relay credentials and at least one allowlisted channel, then restart Botmancers.', tone: 'quiet' };
    case 'misconfigured': return { label: 'Needs configuration', summary: 'The Botmancers Slack relay cannot start with its current configuration.', guidance: MISCONFIGURED_GUIDANCE[health.reason ?? 'share_config_invalid'] ?? 'Review the Slack relay credentials and sharing allowlist, then restart Botmancers.', tone: 'warning' };
    case 'connecting': return { label: 'Connecting', summary: 'The Botmancers Slack relay is opening its Socket Mode connection.', guidance: 'Wait a moment, then refresh. Existing shares remain bounded to their exact sessions.', tone: 'working' };
    case 'connected': return { label: 'Connected', summary: 'The single Botmancers Slack relay is connected.', guidance: 'It can post and answer eligible shared-session threads for all Agents on this Botmancers instance.', tone: 'good' };
    case 'reconnecting': return { label: 'Reconnecting', summary: 'The Botmancers Slack relay lost its connection and is reconnecting.', guidance: 'Wait and refresh. Pending work is recovered after the connection returns; do not recreate shares just for a reconnect.', tone: 'working' };
    case 'failed': return { label: 'Failed', summary: 'The Botmancers Slack relay could not authenticate or connect.', guidance: health.reason === 'slack_auth_failed' ? 'Check the configured Slack app and bot credentials, then restart Botmancers.' : 'Check Slack connectivity and the Socket Mode app configuration, then restart Botmancers.', tone: 'warning' };
    case 'stopped': return { label: 'Stopped', summary: 'The Botmancers Slack relay is not running.', guidance: 'Start or restart Botmancers. Existing share records remain available for review.', tone: 'quiet' };
  }
}

export function creationPathLabel(share: Pick<OwnerShare, 'created_via' | 'created_by'>): string {
  if (share.created_via === 'current_session') return 'Running Agent turn';
  return share.created_by === 'owner' ? 'Agent Sessions' : 'Session share API';
}

export const SHARE_FILTERS: Array<{ value: 'all' | 'active' | 'expired' | 'revoked'; label: string }> = [
  { value: 'all', label: 'All states' },
  { value: 'active', label: 'Live' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
];

export const ALL_SHARE_STATUSES: OwnerShareStatus[] = ['active', 'answering', 'recovering', 'exhausted', 'expired', 'revoked'];
