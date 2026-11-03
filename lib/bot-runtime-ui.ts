// NOT-543: direct-only agent UI helpers (pure, no I/O).
//
// Single source for the roster line, the default-workspace hints, and
// the same-thread agent trace. React components render these values; the
// plain-node regression test (`test-bot-runtime-ui.js`) asserts them
// without a browser.
//
// Every bot shows exactly one summary: `Agent: <agent> · <connection>`
// (NOT-543). There is no deck, server URL, or launch profile: the Agent
// launches direct from its runtime connection.
import { AGENTS, AGENT_LABELS, DEFAULT_AGENT, agentLabel, type BotAgent } from './bot-definition';

// Ordered agent choices: Hermes, Cursor, Claude, Codex, Muse Code.
export const AGENT_OPTIONS: readonly { value: BotAgent; label: string }[] = AGENTS.map(agent => ({
  value: agent,
  label: AGENT_LABELS[agent],
}));

export interface BotRuntimeLike {
  id?: string | null;
  agent?: string | null;
  runtime_connection_id?: string | null;
  runtime_connection?: { id: string; provider: string; label: string; host: string } | null;
  launchable?: boolean | null;
  launch_blocker?: string | null;
}

// Display label for the bot's agent (Hermes when unset).
export function botAgentLabel(bot: BotRuntimeLike): string {
  return agentLabel((bot.agent ?? '').trim() || DEFAULT_AGENT);
}

// Display label for the bot's runtime connection, or null when none is
// configured.
export function botConnectionLabel(bot: BotRuntimeLike): string | null {
  const connection = bot.runtime_connection;
  if (connection && connection.label.trim()) return connection.label.trim();
  if ((bot.runtime_connection_id ?? '').trim()) return (bot.runtime_connection_id ?? '').trim();
  return null;
}

export const NO_CONNECTION_COPY = 'No connection';
export const ROSTER_CONFIG_SUFFIX = ' — see Config';

function agentPrefix(bot: BotRuntimeLike): string {
  return `Agent: ${botAgentLabel(bot)} · `;
}

export function runtimeSummary(bot: BotRuntimeLike): string {
  return agentPrefix(bot) + (botConnectionLabel(bot) ?? NO_CONNECTION_COPY);
}

// Roster: exactly one plain-text line per bot. An unlaunchable Agent
// points at Config.
export function rosterRuntimeLine(bot: BotRuntimeLike): string {
  const summary = runtimeSummary(bot);
  return bot.launchable === false ? summary + ROSTER_CONFIG_SUFFIX : summary;
}

export function defaultWorkdirFor(botId: string): string {
  return `~/.botmancers/${botId}`;
}

export const WORKSPACE_TEMPLATE = '~/.botmancers/{agentID}';
export const NEW_AGENT_WORKSPACE_HINT = `Default: ${WORKSPACE_TEMPLATE} — {agentID} is this agent's ID, assigned at creation.`;

export function configWorkspaceHint(botId: string): string {
  return `Default: ${defaultWorkdirFor(botId)} — leave blank to use it.`;
}



function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Same-thread agent trace. The direct-dispatch loop posts `[Agent
// failed]` verbatim into the originating conversation; the UI labels the
// line and keeps the remainder (agent, error) verbatim. The `[Deck ...]`
// entries are the pre-NOT-543 notices, kept so existing threads still
// render (relabeled: Agent Deck no longer exists).
export const AGENT_EVENT_PREFIXES = [
  '[Agent failed]',
  '[Deck handoff]',
  '[Deck run]',
  '[Deck review]',
  '[Deck resume]',
  '[Deck result]',
  '[Deck failed]',
  '[Deck needs selection]',
  '[Deck needs reselection]',
] as const;

export type AgentEventKind = 'handoff' | 'run' | 'review' | 'resume' | 'result' | 'failed' | 'reselection' | null;

const AGENT_EVENT_TABLE: Array<{ prefix: string; kind: Exclude<AgentEventKind, null>; label: string }> = [
  { prefix: '[Agent failed]', kind: 'failed', label: 'Agent failed' },
  { prefix: '[Deck handoff]', kind: 'handoff', label: 'Agent launch' },
  { prefix: '[Deck run]', kind: 'run', label: 'Agent run' },
  { prefix: '[Deck review]', kind: 'review', label: 'Agent review' },
  { prefix: '[Deck resume]', kind: 'resume', label: 'Agent resume' },
  { prefix: '[Deck result]', kind: 'result', label: 'Agent result' },
  { prefix: '[Deck failed]', kind: 'failed', label: 'Agent failed' },
  { prefix: '[Deck needs selection]', kind: 'reselection', label: 'Agent needs setup' },
  { prefix: '[Deck needs reselection]', kind: 'reselection', label: 'Agent needs setup' },
];

export function agentEventKindOfLine(line: string): AgentEventKind {
  const text = String(line ?? '').trimStart();
  return AGENT_EVENT_TABLE.find(entry => text.startsWith(entry.prefix))?.kind ?? null;
}

export function isAgentEventLine(line: string): boolean {
  return agentEventKindOfLine(line) !== null;
}

// Label + verbatim remainder for one trace line, or null for ordinary text.
export function agentEventDisplay(line: string): { label: string; detail: string } | null {
  const text = String(line ?? '').trimStart();
  const entry = AGENT_EVENT_TABLE.find(item => text.startsWith(item.prefix));
  if (!entry) return null;
  return { label: entry.label, detail: text.slice(entry.prefix.length).trim() };
}

// Ordered event kinds observed in one thread's bot turns, in thread order.
export function orderedAgentEventKinds(contents: string[]): AgentEventKind[] {
  const kinds: AgentEventKind[] = [];
  for (const content of contents) {
    for (const line of String(content ?? '').split('\n')) {
      const kind = agentEventKindOfLine(line);
      if (kind) kinds.push(kind);
    }
  }
  return kinds;
}
