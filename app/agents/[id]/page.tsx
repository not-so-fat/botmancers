'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAgentOverview } from './AgentShell';
import { agentLabel } from '@/lib/bot-definition';
import { HarnessIcon } from '@/app/components/HarnessIcon';
import { ActivityList } from './activity/AgentActivityPage';

const COPIED_MS = 1600;

// --- reach-copy helpers (test-agent-home.js evaluates this block) ---
const BRIDGE_CLIENTS = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
] as const;

type BridgeClientId = (typeof BRIDGE_CLIENTS)[number]['id'];

function setupCommand(id: BridgeClientId) {
  return `botmancers setup --client ${id}`;
}

function askAgentPrompt(agentName: string) {
  return `Use Botmancers to ask ${agentName}: <your question>`;
}

type ClipboardWriter = { writeText(text: string): Promise<void> };

/** Writes text to the clipboard; resolves true only when the write succeeded. */
async function copyText(text: string, clipboard?: ClipboardWriter): Promise<boolean> {
  try {
    const target = clipboard ?? navigator.clipboard;
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}
// --- end reach-copy helpers ---

function BridgeSetupClients() {
  const [active, setActive] = useState<BridgeClientId>('cursor');
  const [copied, setCopied] = useState<BridgeClientId | null>(null);
  const command = setupCommand(active);

  async function copyFor(id: BridgeClientId) {
    setActive(id);
    if (await copyText(setupCommand(id))) {
      setCopied(id);
      window.setTimeout(() => setCopied(current => (current === id ? null : current)), COPIED_MS);
    } else {
      setCopied(null);
    }
  }

  return (
    <div className="agent-setup-clients">
      <div className="agent-setup-client-row" role="group" aria-label="Copy setup command for a coding client">
        {BRIDGE_CLIENTS.map(client => {
          const isActive = active === client.id;
          const justCopied = copied === client.id;
          return (
            <button
              key={client.id}
              type="button"
              className={`agent-setup-client${isActive ? ' is-active' : ''}${justCopied ? ' is-copied' : ''}`}
              aria-pressed={isActive}
              aria-label={justCopied ? `Copied setup command for ${client.label}` : `Copy setup command for ${client.label}`}
              onClick={() => void copyFor(client.id)}
            >
              <HarnessIcon agent={client.id} size={14} className="agent-setup-client-mark" />
              <span>{justCopied ? 'Copied' : client.label}</span>
            </button>
          );
        })}
      </div>
      <pre className="agent-setup-command"><code>{command}</code></pre>
    </div>
  );
}

function AskAgentPrompt({ agentName }: { agentName: string }) {
  const [copied, setCopied] = useState(false);
  const prompt = askAgentPrompt(agentName);

  async function copyPrompt() {
    if (await copyText(prompt)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    } else {
      setCopied(false);
    }
  }

  return (
    <div className="agent-setup-prompt">
      <pre className="agent-setup-command"><code>{prompt}</code></pre>
      <button
        type="button"
        className={`agent-setup-client agent-setup-copy${copied ? ' is-copied' : ''}`}
        aria-label={copied ? `Copied prompt to ask ${agentName}` : `Copy prompt to ask ${agentName}`}
        onClick={() => void copyPrompt()}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function WorkList({ rows, empty }: { rows: Array<{ ref: string; title: string; status: string; last_activity_at: number }>; empty: string }) {
  if (!rows.length) return <p className="agent-empty">{empty}</p>;
  return (
    <ul className="agent-work-list">
      {rows.map(row => (
        <li key={row.ref}>
          <span><strong>{row.title}</strong><small>{row.status === 'active' ? 'Active now' : 'Recent'} · {new Date(row.last_activity_at).toLocaleString()}</small></span>
        </li>
      ))}
    </ul>
  );
}

export default function AgentOverviewPage() {
  const { id, overview, loading, error, notFound } = useAgentOverview();
  if (loading) return <div className="agent-state" role="status">Loading agent overview…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><p>This agent does not exist or was removed.</p><Link href="/">Choose an agent</Link></div>;
  if (error || !overview) return <div className="agent-state" role="alert"><h2>Overview unavailable</h2><p>Botmancers could not load this agent. Refresh to try again.</p></div>;

  const configHref = `/agents/${encodeURIComponent(id)}/config`;
  const messageHref = overview.conversation
    ? `/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(overview.conversation.id)}`
    : `/agents/${encodeURIComponent(id)}/conversations`;
  const messagingStatus = overview.messaging.home_session_ref
    ? 'Home session configured'
    : overview.messaging.new_sessions_allowed && overview.messaging.default_workspace_set
      ? 'Can start a configured session'
      : overview.current_work.length > 0
        ? 'Uses an eligible existing session'
        : 'No ready session is known';
  return (
    <div className="agent-overview" data-agent-overview>
      <div className="agent-overview-grid">
        <section className="agent-panel agent-instructions">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Standing instructions</p><h2>How this agent works</h2></div><Link href={configHref}>Config</Link></div>
          <dl>
            <div><dt>Rules</dt><dd>{overview.instructions.rules}</dd></div>
            <div><dt>Skill</dt><dd>{overview.instructions.skill}</dd></div>
          </dl>
        </section>

        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Runtime</p><h2>{overview.runtime.available ? 'Ready to work' : 'Setup required'}</h2></div><Link href={configHref}>Config</Link></div>
          <p>{overview.runtime.available
            ? `${agentLabel(overview.runtime.agent)} is connected through ${overview.runtime.connection || 'the configured runtime'}.`
            : 'This agent cannot launch with its current registration. Open Config to resolve the connection or session scope.'}</p>
          <dl className="agent-runtime-facts">
            <div><dt>Heartbeat</dt><dd>{overview.runtime.last_seen ? new Date(overview.runtime.last_seen).toLocaleString() : 'Not reported'}</dd></div>
            <div><dt>Messaging</dt><dd>{messagingStatus}</dd></div>
          </dl>
          <p className="agent-muted">Messages use the agent’s configured home session or launch policy. Callers do not choose its runtime, model, or provider session.</p>
        </section>
      </div>

      <section className="agent-use" aria-labelledby="open-this-agent">
        <p className="agent-eyebrow">Open this agent</p>
        <h2 id="open-this-agent">Make it reachable</h2>
        <div className="agent-use-grid">
          <article>
            <span className="agent-use-number">01</span>
            <h3>Use from a coding agent</h3>
            <p>Let another coding agent discover {overview.agent.name} and ask its sessions — so work learned here can travel between agents.</p>
            <ol className="agent-setup-steps">
              <li>
                <h4><span className="agent-setup-step-label">Step 1</span> Install in your coding agent</h4>
                <p className="agent-muted">Run this where your coding agent runs (the one that will ask {overview.agent.name}), not on this registered agent. Click your client to copy it:</p>
                <BridgeSetupClients />
              </li>
              <li>
                <h4><span className="agent-setup-step-label">Step 2</span> Ask it to talk to {overview.agent.name}</h4>
                <AskAgentPrompt agentName={overview.agent.name} />
                <p className="agent-muted">Your coding agent sends the question to {overview.agent.name}, waits for the answer, and can read the conversation.</p>
              </li>
            </ol>
          </article>
          <article>
            <span className="agent-use-number">02</span>
            <h3>Share a session to Slack</h3>
            <p>Open one of this agent’s sessions to people in Slack — a time-limited, read-only share so others can ask what the session already knows.</p>
            <Link href={`/agents/${encodeURIComponent(id)}/slack`}>Share through Slack</Link>
          </article>
          <article>
            <span className="agent-use-number">03</span>
            <h3>Message in Botmancers</h3>
            <p>Talk directly with {overview.agent.name} in a focused conversation when you are the one asking.</p>
            <Link href={messageHref}>Open conversation</Link>
          </article>
        </div>
      </section>

      <div className="agent-overview-grid agent-work-grid">
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Current work</p><h2>Active sessions</h2></div><Link href={`/agents/${encodeURIComponent(id)}/sessions`}>All sessions</Link></div>
          <WorkList rows={overview.current_work} empty="No active work right now." />
        </section>
        <section className="agent-panel">
          <div className="agent-panel-head"><div><p className="agent-eyebrow">Recent activity</p><h2>Latest work</h2></div><Link href={`/agents/${encodeURIComponent(id)}/activity`}>View activity</Link></div>
          {overview.recent_activity.length ? <ActivityList items={overview.recent_activity} compact /> : <p className="agent-empty">No operational activity yet.</p>}
        </section>
      </div>
    </div>
  );
}
