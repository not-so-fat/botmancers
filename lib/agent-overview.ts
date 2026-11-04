import db, { bots, conversations, messages } from './db';
import { resolveAgent } from './bot-definition';
import { readSkillState } from './skills';
import { listAgentSessions } from './session-catalog';
import { agentMessagingReadiness } from './service-api';
import { SERVICE_CAPABILITIES, type ServiceCapability } from './service-grants';

const OVERVIEW_CAPABILITIES: ServiceCapability[] = [
  'agents:read',
  'sessions:read',
  'conversations:read',
  'sessions:message',
  'shares:create',
];

export interface AgentOverviewWork {
  ref: string;
  title: string;
  status: 'active' | 'ended';
  last_activity_at: number;
}

// Intentionally allow-listed. This DTO must never grow credentials, grant
// secrets, provider session ids, workspace paths, or runtime-selection inputs.
export interface AgentOverviewDto {
  agent: {
    id: string;
    name: string;
    title: string;
    role: string;
    avatar: string | null;
    avatar_color: string | null;
    avatar_eyes: string | null;
    avatar_hands: string | null;
    avatar_accessory: string | null;
  };
  instructions: { rules: string; skill: string; skill_present: boolean };
  runtime: {
    agent: string;
    connection: string | null;
    available: boolean;
    blocker: string | null;
    last_seen: number | null;
  };
  capabilities: ServiceCapability[];
  messaging: { home_session_ref: string | null; new_sessions_allowed: boolean; default_workspace_set: boolean };
  current_work: AgentOverviewWork[];
  recent_work: AgentOverviewWork[];
  conversation: { id: string; last_activity_at: number | null } | null;
}

export function summarizeInstruction(value: string | null | undefined, empty: string, limit = 180): string {
  const text = String(value ?? '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*#{1,6}\s*/, '').trim())
    .filter(line => line && !/^---+$/.test(line))
    .slice(0, 2)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!text) return empty;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function getAgentOverview(id: string): AgentOverviewDto | null {
  const bot = bots.getById(id);
  if (!bot) return null;
  const resolved = resolveAgent(bot);
  const skill = readSkillState(bot.name);
  const sessions = listAgentSessions(db, id, 'all');
  const work = sessions.map(session => ({
    ref: session.ref,
    title: session.title,
    status: session.status,
    last_activity_at: session.last_activity_at,
  }));
  const conversation = conversations.getByBotId(id);
  const conversationMessages = conversation ? messages.getByConversation(conversation.id) : [];
  const lastConversationMessage = conversationMessages.at(-1);
  const connection = bot.runtime_connection_id
    ? db.prepare('SELECT label FROM runtime_connections WHERE id = ?').get(bot.runtime_connection_id) as { label: string } | undefined
    : undefined;

  return {
    agent: {
      id: bot.id,
      name: bot.name,
      title: bot.title,
      role: bot.title.trim() || 'Botmancers Agent',
      avatar: bot.avatar ?? null,
      avatar_color: bot.avatar_color ?? null,
      avatar_eyes: bot.avatar_eyes ?? null,
      avatar_hands: bot.avatar_hands ?? null,
      avatar_accessory: bot.avatar_accessory ?? null,
    },
    instructions: {
      rules: summarizeInstruction(bot.description, 'No standing rules have been written yet.'),
      skill: summarizeInstruction(skill.content, 'No skill instructions are installed.'),
      skill_present: skill.present,
    },
    runtime: {
      agent: resolved.agent,
      connection: connection?.label ?? null,
      available: resolved.launchable,
      blocker: resolved.launch_blocker,
      last_seen: bot.last_seen ?? null,
    },
    capabilities: SERVICE_CAPABILITIES.filter(capability => OVERVIEW_CAPABILITIES.includes(capability)),
    messaging: agentMessagingReadiness(bot),
    current_work: work.filter(item => item.status === 'active').slice(0, 3),
    recent_work: work.slice(0, 7),
    conversation: conversation ? { id: conversation.id, last_activity_at: lastConversationMessage?.created_at ?? null } : null,
  };
}
