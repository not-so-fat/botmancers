'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import BotAvatar from './BotAvatar';
import DeleteAgentsDialog from './DeleteAgentsDialog';
import { latestLine } from '@/lib/message-preview';
import { rosterRuntimeLine } from '@/lib/bot-runtime-ui';
import type { DeleteAgentRef } from '@/lib/bot-deletion';

export interface RailAgent {
  id: string;
  name: string;
  title: string;
  avatar?: string | null;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
  pinned?: number;
  hidden?: number;
  last_seen?: number | null;
  unread?: number;
  latest?: string;
  agent?: string | null;
  launchable?: boolean | null;
  launch_blocker?: string | null;
  runtime_connection_id?: string | null;
  runtime_connection?: { id: string; provider: string; label: string; host: string } | null;
}

interface AgentRailProps {
  agents: RailAgent[];
  activeAgentId?: string | null;
  workingIds?: string[];
  beatClock: { serverNow: number; fetchedAt: number };
  now: number;
  status?: string;
  logoDrop?: boolean;
  onAgentsChange: (agents: RailAgent[]) => void;
  onNew: () => void;
  onManage: () => void;
  onDeleted: (deleted: DeleteAgentRef[]) => void;
  newButtonRef?: React.RefObject<HTMLButtonElement | null>;
  manageButtonRef?: React.RefObject<HTMLButtonElement | null>;
}

const HEARTBEAT_STALE_MS = 15000;

function isChiefOfStaff(agent: RailAgent): boolean {
  return agent.name.toLowerCase() === 'chief-of-staff';
}

function rosterRank(agent: RailAgent) {
  return isChiefOfStaff(agent) ? 0 : agent.pinned ? 1 : 2;
}

function lifeWord(lastSeen: number | null | undefined, serverNow: number, fetchedAt: number, now: number) {
  if (!lastSeen || !serverNow) return 'Stopped';
  if ((now - fetchedAt) + (serverNow - lastSeen) > HEARTBEAT_STALE_MS) return 'Stopped';
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).format(new Date(lastSeen));
  return `Heartbeat ${time}`;
}

export default function AgentRail({
  agents, activeAgentId, workingIds = [], beatClock, now, status = '', logoDrop = false,
  onAgentsChange, onNew, onManage, onDeleted, newButtonRef, manageButtonRef,
}: AgentRailProps) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowName, setRowName] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState<RailAgent | null>(null);
  const [rowMenu, setRowMenu] = useState<{ agent: RailAgent; x: number; y: number; returnTo: HTMLElement | null } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const hiddenToggleRef = useRef<HTMLButtonElement>(null);
  const visible = agents.filter(agent => !agent.hidden).sort((a, b) => rosterRank(a) - rosterRank(b));
  const hidden = agents.filter(agent => agent.hidden);

  const patchAgent = async (agent: RailAgent, fields: Record<string, unknown>) => {
    const response = await fetch('/api/bots', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: agent.id, ...fields }),
    });
    if (!response.ok) return null;
    const saved = await response.json() as RailAgent;
    onAgentsChange(agents.map(item => item.id === saved.id ? { ...item, ...saved } : item));
    return saved;
  };

  const focusRow = (id: string, frames = 30) => requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-open-bot="${id}"]`);
    if (row) row.focus();
    else if (frames > 0) focusRow(id, frames - 1);
  });

  const closeRowMenu = (restore = true) => {
    const returnTo = rowMenu?.returnTo;
    setRowMenu(null);
    if (restore && returnTo) requestAnimationFrame(() => { if (returnTo.isConnected) returnTo.focus(); });
  };

  useEffect(() => {
    if (!rowMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRowMenu(null);
      rowMenu.returnTo?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rowMenuRef.current?.contains(event.target as Node)) setRowMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [rowMenu]);

  const onRowMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Tab') { event.preventDefault(); closeRowMenu(); }
  };

  const rename = async (agent: RailAgent) => {
    const name = rowName.trim();
    setEditingId(null);
    if (name && name !== agent.name) await patchAgent(agent, { name });
  };

  const rowRename = (agent: RailAgent, style?: React.CSSProperties) => (
    <input className="bot-name" aria-label={`Rename ${agent.name}`} value={rowName} autoFocus
      onChange={event => setRowName(event.target.value)} onBlur={() => { void rename(agent); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); focusRow(agent.id); }
        if (event.key === 'Escape') { setEditingId(null); focusRow(agent.id); }
      }} style={style} />
  );

  const rowOpen = (agent: RailAgent, style?: React.CSSProperties) => (
    <button type="button" className="bot-name row-open" data-open-bot={agent.id}
      aria-current={activeAgentId === agent.id ? 'true' : undefined}
      onClick={() => router.push(`/agents/${encodeURIComponent(agent.id)}`)} style={style}>{agent.name}</button>
  );

  const rowActions = (agent: RailAgent) => (
    <button type="button" className="row-actions" aria-haspopup="menu"
      aria-expanded={rowMenu?.agent.id === agent.id} aria-label={`Actions for ${agent.name}`} title={`Actions for ${agent.name}`}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setRowMenu({ agent, x: rect.left, y: rect.bottom + 4, returnTo: event.currentTarget }); }}>⋯</button>
  );

  const rowTip = (agent: RailAgent) => (
    <div className="row-tip">
      {agent.unread && activeAgentId !== agent.id ? <div className="card-role">Unread</div> : null}
      <div className="card-role">{lifeWord(agent.last_seen, beatClock.serverNow, beatClock.fetchedAt, now)}</div>
    </div>
  );

  const onContextMenu = (event: React.MouseEvent<HTMLElement>, agent: RailAgent) => {
    event.preventDefault();
    setRowMenu({ agent, x: event.clientX, y: event.clientY, returnTo: event.currentTarget.querySelector<HTMLElement>('[data-open-bot]') });
  };

  const agentRow = (agent: RailAgent) => (
    <div key={agent.id} className={activeAgentId === agent.id ? 'bot-row is-open' : 'bot-row'} onContextMenu={event => onContextMenu(event, agent)}>
      <span className="mark-avatar mark-avatar-sm"><BotAvatar bot={agent} size={36} title={`${agent.name} avatar`} />{workingIds.includes(agent.id) ? <span className="mark-dot" /> : null}</span>
      <div className="bot-copy">
        {editingId === agent.id ? rowRename(agent) : rowOpen(agent)}
        {latestLine(agent.latest) ? <div className="bot-preview">{latestLine(agent.latest)}</div> : null}
        <div className="bot-runtime" title={rosterRuntimeLine(agent)}>{rosterRuntimeLine(agent)}</div>
      </div>
      {rowActions(agent)}{rowTip(agent)}
    </div>
  );

  return <>
    <aside className="rail agent-rail">
      <Link href="/" className="brand agent-brand" aria-label="Botmancers home">
        <span className={logoDrop ? 'logo-shape is-settling' : 'logo-shape'}><Image src="/brand/botmancers-logo-filled-256.png" alt="" width={40} height={40} /></span>
        <span className="logo-word">botmancers</span>
      </Link>
      <div className="bar">
        <button ref={newButtonRef} type="button" className="add-btn" aria-haspopup="dialog" onClick={onNew}>New</button>
        {agents.length ? <button ref={manageButtonRef} type="button" className="add-btn" aria-haspopup="dialog" onClick={onManage}>Manage agents</button> : null}
        <Link className="add-btn settings-link" href="/settings">Settings</Link>
      </div>
      {agents.length ? <nav className="rail-nav" aria-label="Workspace"><Link href="/exchanges" className="add-btn rail-nav-link">Exchanges</Link></nav> : null}
      <p className="roster-status" role="status">{status}</p>
      {agents.length ? <div className={rowMenu ? 'roster menu-open' : 'roster'}>
        {visible.map(agent => isChiefOfStaff(agent) ? (
          <div key={agent.id} className="card" onContextMenu={event => onContextMenu(event, agent)}>
            <div className="row-head"><span className="mark-avatar"><BotAvatar bot={agent} size={44} title={`${agent.name} avatar`} />{workingIds.includes(agent.id) ? <span className="mark-dot" /> : null}</span>
              {editingId === agent.id ? rowRename(agent, { color: '#D5D0C3', fontSize: 26 }) : rowOpen(agent, { fontSize: 26 })}{rowActions(agent)}</div>
            {latestLine(agent.latest) ? <div className="bot-preview">{latestLine(agent.latest)}</div> : null}
            <div className="bot-runtime" title={rosterRuntimeLine(agent)}>{rosterRuntimeLine(agent)}</div>{rowTip(agent)}
          </div>
        ) : agentRow(agent))}
      </div> : null}
      {hidden.length ? <div className={rowMenu ? 'roster menu-open' : 'roster'}>
        <button ref={hiddenToggleRef} type="button" className="pin-word" aria-expanded={showHidden} onClick={() => setShowHidden(open => !open)}>Hidden</button>
        {showHidden ? hidden.map(agentRow) : null}
      </div> : null}
    </aside>
    {deleteAsk ? <DeleteAgentsDialog ids={[deleteAsk.id]} onCancel={() => { focusRow(deleteAsk.id); setDeleteAsk(null); }} onDeleted={deleted => { setDeleteAsk(null); onAgentsChange(agents.filter(agent => !deleted.some(item => item.id === agent.id))); onDeleted(deleted); }} /> : null}
    {rowMenu ? <div ref={rowMenuRef} className="row-menu" role="menu" aria-label={`Actions for ${rowMenu.agent.name}`}
      style={{ left: rowMenu.x, top: rowMenu.y }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()} onKeyDown={onRowMenuKey}>
      <button type="button" role="menuitem" tabIndex={-1} autoFocus onClick={() => { closeRowMenu(); void patchAgent(rowMenu.agent, { pinned: rowMenu.agent.pinned ? 0 : 1 }); }}>{rowMenu.agent.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { closeRowMenu(); void patchAgent(rowMenu.agent, { unread: 1 }); }}>Mark as Unread</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { const agent = rowMenu.agent; closeRowMenu(false); setEditingId(agent.id); setRowName(agent.name); }}>Rename Agent</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { const agent = rowMenu.agent; closeRowMenu(false); void patchAgent(agent, { hidden: agent.hidden ? 0 : 1 }).then(() => agent.hidden ? focusRow(agent.id) : hiddenToggleRef.current?.focus()); }}>{rowMenu.agent.hidden ? 'Unhide' : 'Hide from sidebar'}</button>
      <Link role="menuitem" tabIndex={-1} href={`/bots/${rowMenu.agent.id}/config`} onClick={() => setRowMenu(null)}>Config</Link>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { const agent = rowMenu.agent; closeRowMenu(false); setDeleteAsk(agent); }}>Delete agent…</button>
    </div> : null}
  </>;
}
