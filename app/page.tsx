'use client';

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { parseDraft, draftTitle, type Draft } from '@/lib/draft';
import { parseRun, runLine } from '@/lib/run';

interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar?: string;
  color: string;
  pinned?: number;
  hidden?: number;
  last_seen?: number | null;
  unread?: number;
  latest?: string;
}

interface Message {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id?: string;
  sender_name?: string;
  content: string;
  handoff_targets?: string | null;
  created_at: number;
}

interface GroupRow {
  id: string;
  name: string;
  owner_bot_id?: string | null;
  members: Bot[];
}

function groupLabel(group: GroupRow) {
  const owner = group.members.find(member => member.id === group.owner_bot_id);
  if (!owner) return group.name;
  if (group.name.startsWith(owner.name)) return '@' + group.name;
  return group.name + ' @' + owner.name;
}

interface Conversation {
  id: string;
  type: 'bot' | 'group';
  details: Bot | { id: string; name: string };
}

const HEARTBEAT_STALE_MS = 15000;
const COMPUTER_BOT_ID = '6f427b40-c909-44ef-86ab-5ca857fffc3e';
const COMPUTER_THREAD_ID = '8d6756bd-cb55-4817-87a2-80c8606d1be3';

function computerPageHtml(list: Message[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const run = parseRun(list[i].content);
    if (!run) continue;
    if (run.state === 'stopped') return null;
    return run.page || null;
  }
  return null;
}

function workWord(working: boolean) {
  return working ? 'Working' : 'Not working';
}

function routineWord(content?: string) {
  if (!content) return null;
  const match = content.match(/^\s*\[routine\]\s*(\S+)\s*$/);
  return match ? match[1] : null;
}

function latestLine(content?: string) {
  if (!content) return '';
  const draft = parseDraft(content);
  if (draft) return draftTitle(draft.channel);
  const run = parseRun(content);
  if (run) return runLine(run);
  const routine = routineWord(content);
  if (routine) return routine;
  return content.replace(/\s+/g, ' ').trim();
}

function handoffCount(msg: Message) {
  if (!msg.handoff_targets) return 0;
  try {
    const ids = JSON.parse(msg.handoff_targets);
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return 0;
  }
}

function hiddenUnderMessaged(list: Message[], index: number) {
  const msg = list[index];
  if (!msg || msg.sender_type !== 'bot') return false;
  for (let i = index - 1; i >= 0; i--) {
    if (list[i].sender_type !== 'user') continue;
    return handoffCount(list[i]) > 1;
  }
  return false;
}

function agentComment(msg: Message) {
  return /^\[Handing off to\b/i.test(msg.content.trim());
}

function hiddenAboveMessaged(list: Message[], index: number) {
  const msg = list[index];
  if (!msg || msg.sender_type !== 'bot' || !agentComment(msg)) return false;
  for (let i = index + 1; i < list.length; i++) {
    if (list[i].sender_type !== 'user') continue;
    return handoffCount(list[i]) > 1;
  }
  return false;
}

function foreignReply(msg: Message, ownerId: string) {
  return msg.sender_type === 'bot' && !!msg.sender_id && msg.sender_id !== ownerId;
}

function repliesForHandoff(list: Message[], index: number, ownerId: string) {
  const found: Message[] = [];
  for (let i = index + 1; i < list.length; i++) {
    const item = list[i];
    if (item.sender_type === 'user') break;
    if (foreignReply(item, ownerId)) found.push(item);
  }
  return found;
}

function commentsBefore(list: Message[], index: number) {
  const found: Message[] = [];
  for (let i = index - 1; i >= 0; i--) {
    if (list[i].sender_type === 'user') break;
    if (agentComment(list[i])) found.push(list[i]);
  }
  return found.reverse();
}


function rosterPreview(latest: string | undefined, botId: string, list: Message[], ownerId: string, opened: Record<string, boolean>, kept: Record<string, string>) {
  if (kept[botId]) return kept[botId];
  if (ownerId) {
    let shown = '';
    for (let i = 0; i < list.length; i++) {
      if (!agentComment(list[i]) || !opened[list[i].id]) continue;
      for (const item of repliesForHandoff(list, i, ownerId)) {
        if (item.sender_id === botId) shown = latestLine(item.content);
      }
    }
    if (shown) return shown;
  }
  return latestLine(latest);
}
function lifeWord(lastSeen: number | null | undefined, serverNow: number, fetchedAt: number, now: number) {
  if (!lastSeen || !serverNow) return 'Stopped';
  const age = (now - fetchedAt) + (serverNow - lastSeen);
  if (age > HEARTBEAT_STALE_MS) return 'Stopped';
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(lastSeen));
  return 'Heartbeat ' + time;
}

function mentionAt(content: string, name: string) {
  const needle = '@' + name;
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf(needle, from);
    if (at < 0) return false;
    const after = content[at + needle.length];
    if (!after || /[\s.,!?:;]/.test(after)) return true;
    from = at + needle.length;
  }
  return false;
}

function displayBody(content: string) {
  let text = content;
  for (let i = 0; i < 2; i++) {
    const next = text.replace(/^\s*\[Message from [^\]]+\]\s*(?:\r?\n)?/, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/^\s+/, '');
}

function stripStoredPrefix(content: string) {
  let text = content;
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/^\s*\[(?:Message from|From) [^\]]+\]\s*(?:\r?\n)?/, '');
    if (next === text) break;
    text = next;
  }
  return text;
}

function fileArtifactName(content: string): string | null {
  const match = content.match(/^\[file\]\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/m);
  return match ? match[1] : null;
}

function withoutFileMarker(text: string) {
  return text.replace(/^\[file\]\s+\S+\s*(?:\r?\n)?/m, '').replace(/^\s+/, '');
}

function approvalCodeIn(content: string): string | null {
  const match = content.trim().match(/^approve using the code\s+(\S+)/i);
  if (!match) return null;
  const code = match[1].replace(/[^A-Za-z0-9_-]+$/, '');
  return code || null;
}

function messagePicture(content: string) {
  const images: string[] = [];
  const text = content.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, (url) => {
    images.push(url.replace(/\s/g, ''));
    return '';
  });
  return { text: displayBody(text), images };
}

function DraftCard({
  draft,
  onSend,
  onDiscard,
}: {
  draft: Draft;
  onSend: (recipient: string, body: string) => void;
  onDiscard: (recipient: string, body: string) => void;
}) {
  const [recipient, setRecipient] = useState(draft.recipient);
  const [body, setBody] = useState(draft.body);
  const closed = useRef(draft.state !== 'open');
  const locked = draft.state !== 'open' || closed.current;
  const shownRecipient = locked ? draft.recipient : recipient;
  const shownBody = locked ? draft.body : body;

  return (
    <div className="draft-card">
      <div className="draft-title">{draftTitle(draft.channel)}</div>
      <input
        type="text"
        value={shownRecipient}
        readOnly={locked}
        onChange={e => {
          if (!locked) setRecipient(e.target.value);
        }}
      />
      <textarea
        rows={3}
        value={shownBody}
        readOnly={locked}
        onChange={e => {
          if (!locked) setBody(e.target.value);
        }}
      />
      {draft.state === 'sent' ? <span className="draft-mark">Sent</span> : null}
      {draft.state === 'discarded' ? <span className="draft-mark">Discarded</span> : null}
      {draft.state !== 'discarded' ? (
        <button
          type="button"
          className="approve-control"
          onClick={() => {
            if (locked || closed.current) return;
            if (recipient.trim() === '') return;
            closed.current = true;
            onSend(recipient, body);
          }}
        >
          Send
        </button>
      ) : null}
      {draft.state === 'open' ? (
        <button
          type="button"
          className="approve-control"
          style={{ marginLeft: 8 }}
          onClick={() => {
            if (locked || closed.current) return;
            closed.current = true;
            onDiscard(recipient, body);
          }}
        >
          Discard
        </button>
      ) : null}
    </div>
  );
}

export default function Home() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const defaulted = useRef(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [revealed, setRevealed] = useState<Record<string, Message[]>>({});
  const [handoffOpen, setHandoffOpen] = useState<Record<string, boolean>>({});
  const [keptPreview, setKeptPreview] = useState<Record<string, string>>({});
  const [inputMessage, setInputMessage] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const [attachError, setAttachError] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [showBotModal, setShowBotModal] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [avatarStep, setAvatarStep] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowName, setRowName] = useState('');
  const [deleteAsk, setDeleteAsk] = useState<Bot | null>(null);
  const [rowMenu, setRowMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const [showHidden, setShowHidden] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const runningLineRef = useRef<HTMLDivElement>(null);
  const computerBandRef = useRef<HTMLDivElement>(null);
  const computerRoomRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [workingIds, setWorkingIds] = useState<string[]>([]);
  const [beatClock, setBeatClock] = useState({ serverNow: 0, fetchedAt: 0 });
  const [now, setNow] = useState(() => Date.now());
  const pendingAfter = useRef<Record<string, number>>({});
  const logoSettled = useRef(false);
  const [logoDrop, setLogoDrop] = useState(false);
  const returnId = useRef<string | null>(null);
  const returnHandled = useRef(false);
  const [marketConfigured, setMarketConfigured] = useState<boolean | null>(null);
  const [importMiss, setImportMiss] = useState('');

  useEffect(() => {
    if (logoSettled.current || bots.length === 0) return;
    logoSettled.current = true;
    setLogoDrop(true);
  }, [bots.length]);

  useEffect(() => {
    const imported = new URLSearchParams(window.location.search).get('imported');
    if (imported) {
      returnId.current = imported;
      defaulted.current = true;
    }
    loadBots();
    loadGroups();
    const botsTimer = setInterval(loadBots, 2000);
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(botsTimer);
      clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    if (defaulted.current || bots.length === 0 || activeConversation) return;
    const cedar = bots.find(b => b.id === '9e363764-e0d5-4fff-8ebd-ccbc46ba0ba5') || bots[0];
    defaulted.current = true;
    void openBot(cedar.id);
  }, [bots, activeConversation]);


  useEffect(() => {
    if (activeConversation) {
      loadMessages();

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(loadMessages, 2000);

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
      };
    }
  }, [activeConversation]);

  const computerOpen = activeConversation?.type === 'bot'
    && activeConversation.id === COMPUTER_THREAD_ID
    && activeConversation.details.id === COMPUTER_BOT_ID;
  const computerHtml = computerOpen ? computerPageHtml(messages) : null;

  useLayoutEffect(() => {
    const scroller = messagesEndRef.current?.parentElement;
    if (!scroller) return;
    const line = runningLineRef.current;
    const band = computerBandRef.current;
    const room = computerRoomRef.current;
    if (computerOpen && line && band && room) {
      const align = (extra: number) => {
        const rowHeight = Math.ceil(line.getBoundingClientRect().height);
        band.style.height = (rowHeight + 16 + extra) + 'px';
        const desired = band.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        room.style.height = Math.max(0, scroller.clientHeight - desired) + 'px';
        const lineTop = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, lineTop - desired);
      };
      align(0);
      const desk = band.nextElementSibling;
      const rowBottom = line.getBoundingClientRect().bottom;
      const deskTop = desk ? desk.getBoundingClientRect().top : band.getBoundingClientRect().bottom;
      if (rowBottom >= deskTop) align(Math.max(16, Math.ceil(rowBottom - deskTop)));
      return;
    }
    if (room) room.style.height = '0px';
    if (band) band.style.height = '';
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages, computerOpen]);

  useLayoutEffect(() => {
    setWorkingIds(current => {
      if (current.length === 0) return current;
      const done = current.filter(id => {
        const floor = pendingAfter.current[id] ?? 0;
        return messages.some(msg =>
          msg.sender_type === 'bot' &&
          msg.sender_id === id &&
          msg.created_at > floor &&
          !/^\[(mcp|tool call|tool result)\]/i.test(msg.content.trim())
        );
      });
      if (done.length === 0) return current;
      for (const id of done) delete pendingAfter.current[id];
      return current.filter(id => !done.includes(id));
    });
  }, [messages]);

  const loadBots = async () => {
    const res = await fetch('/api/bots', { cache: 'no-store' });
    const data = await res.json();
    const headerNow = Date.parse(res.headers.get('date') || '');
    setBeatClock({
      serverNow: Number.isNaN(headerNow) ? Date.now() : headerNow,
      fetchedAt: Date.now(),
    });
    if (!Array.isArray(data)) return;
    const list: Bot[] = data;
    setBots(list);
    const imported = returnId.current;
    if (!imported || returnHandled.current) return;
    returnHandled.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('imported');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    const found = list.find(bot => bot.id === imported);
    if (!found) {
      setImportMiss('That bot is not in the list.');
      defaulted.current = false;
      return;
    }
    const convRes = await fetch('/api/conversations?botId=' + encodeURIComponent(found.id));
    const conv = await convRes.json().catch(() => null);
    if (!convRes.ok || !conv || !conv.id) {
      setImportMiss('That bot is not in the list.');
      defaulted.current = false;
      return;
    }
    setImportMiss('');
    setPictureOpen(false);
    setAvatarStep(false);
    setSettingsOpen(false);
    setActiveConversation({
      id: conv.id,
      type: 'bot',
      details: found,
    });
  };

  const loadGroups = async () => {
    const res = await fetch('/api/groups');
    const data = await res.json();
    setGroups(data);
  };

  const loadMessages = async () => {
    if (!activeConversation) return;
    const res = await fetch(`/api/conversations/${activeConversation.id}/messages`);
    const data = await res.json();
    setMessages(data);
  };

  const revealBetween = async (id: string) => {
    if (revealed[id]) return;
    const res = await fetch('/api/messages/' + id + '/between');
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    setRevealed(current => ({ ...current, [id]: data }));
  };

  const approveRequest = async (messageId: string) => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    await loadMessages();
  };

  const denyRequest = async (messageId: string) => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    await loadMessages();
  };

  const stopRun = async (messageId: string) => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    await loadMessages();
  };

  const draftAction = async (messageId: string, action: 'send' | 'discard', recipient: string, body: string) => {
    if (!activeConversation) return;
    if (action === 'send' && recipient.trim() === '') return;
    await fetch(`/api/conversations/${activeConversation.id}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, action, recipient, body }),
    });
    await loadMessages();
  };

  const openBot = async (id: string) => {
    const bot = bots.find(b => b.id === id);
    if (!bot) return;

    const convRes = await fetch(`/api/conversations?botId=${id}`);
    const conv = await convRes.json();

    setPictureOpen(false);
    setAvatarStep(false);
    setSettingsOpen(false);
    setActiveConversation({
      id: conv.id,
      type: 'bot',
      details: bot,
    });
  };

  const setAvatar = async () => {
    if (!activeConversation || activeConversation.type !== 'bot') return;
    const file = avatarFileRef.current?.files?.[0];
    if (!file) return;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    if (!data.startsWith('data:image/')) return;
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeConversation.details.id, avatar: data }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(bot => bot.id === saved.id ? { ...bot, avatar: saved.avatar } : bot));
    setActiveConversation({
      ...activeConversation,
      details: { ...(activeConversation.details as Bot), avatar: saved.avatar },
    });
  };

  const storeGallery = async (file: File | undefined) => {
    if (!file || !activeConversation || activeConversation.type !== 'bot') return;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    if (!data.startsWith('data:image/')) return;
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeConversation.details.id, avatar: data }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(bot => bot.id === saved.id ? { ...bot, avatar: saved.avatar } : bot));
    setActiveConversation({
      ...activeConversation,
      details: { ...(activeConversation.details as Bot), avatar: saved.avatar },
    });
  };

  const removePhoto = async () => {
    if (!activeConversation || activeConversation.type !== 'bot') return;
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeConversation.details.id, avatar: null }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(bot => bot.id === saved.id ? { ...bot, avatar: saved.avatar || '' } : bot));
    setActiveConversation({
      ...activeConversation,
      details: { ...(activeConversation.details as Bot), avatar: saved.avatar || '' },
    });
  };

  const saveIdentity = async (next: { name: string; title: string; description: string }) => {
    if (!activeConversation || activeConversation.type !== 'bot') return;
    const name = next.name.trim();
    if (!name) return;
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: activeConversation.details.id,
        name,
        title: next.title,
        description: next.description,
      }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(bot => bot.id === saved.id ? { ...bot, ...saved } : bot));
    setActiveConversation({
      ...activeConversation,
      details: { ...(activeConversation.details as Bot), ...saved },
    });
  };

  const saveGroupName = async (value: string) => {
    if (!activeConversation || activeConversation.type !== 'group') return;
    const name = value.trim();
    if (!name) return;
    const res = await fetch('/api/groups', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeConversation.details.id, name }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setGroups(current => current.map(group => group.id === saved.id ? { ...group, ...saved } : group));
    setActiveConversation({ ...activeConversation, details: { id: saved.id, name: saved.name } });
    setDraftName(saved.name);
  };

  const rosterBots = [...bots].filter(bot => !bot.hidden).sort((a, b) => {
    const rank = (bot: Bot) => (bot.id === '6f427b40-c909-44ef-86ab-5ca857fffc3e' ? 0 : bot.pinned ? 1 : 2);
    return rank(a) - rank(b);
  });
  const hiddenBots = bots.filter(bot => bot.hidden);

  const pinBot = async (bot: Bot) => {
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bot.id, pinned: bot.pinned ? 0 : 1 }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(item => item.id === saved.id ? { ...item, ...saved } : item));
  };

  const hideBot = async (bot: Bot, hidden: boolean) => {
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bot.id, hidden: hidden ? 1 : 0 }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(item => item.id === saved.id ? { ...item, ...saved, hidden: saved.hidden ? 1 : 0 } : item));
  };

  const markBotUnread = async (bot: Bot) => {
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bot.id, unread: 1 }),
    });
    if (!res.ok) return;
    setBots(current => current.map(item => item.id === bot.id ? { ...item, unread: 1 } : item));
  };

  useEffect(() => {
    if (!rowMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRowMenu(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (rowMenuRef.current && rowMenuRef.current.contains(e.target as Node)) return;
      setRowMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [rowMenu]);

  const renameFromRow = async (bot: Bot) => {
    const name = rowName.trim();
    setEditingId(null);
    if (!name || name === bot.name) return;
    const res = await fetch('/api/bots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bot.id, name }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setBots(current => current.map(item => item.id === saved.id ? { ...item, ...saved } : item));
    if (activeConversation?.type === 'bot' && activeConversation.details.id === saved.id) {
      setActiveConversation({ ...activeConversation, details: { ...(activeConversation.details as Bot), ...saved } });
    }
  };

  const confirmDelete = async () => {
    if (!deleteAsk) return;
    const id = deleteAsk.id;
    const res = await fetch('/api/bots', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setDeleteAsk(null);
    if (!res.ok) return;
    setBots(current => current.filter(bot => bot.id !== id));
    if (activeConversation?.type === 'bot' && activeConversation.details.id === id) {
      setActiveConversation(null);
    }
  };

  const openGroup = async (id: string) => {
    const group = groups.find(g => g.id === id);
    if (!group) return;
    const convRes = await fetch(`/api/conversations?groupId=${id}`);
    const conv = await convRes.json();
    setActiveConversation({
      id: conv.id,
      type: 'group',
      details: { id: group.id, name: group.name },
    });
  };

  const mentionItems = mentionOpen
    ? [
        ...bots.map(bot => ({ id: bot.id, name: bot.name, kind: 'bot' as const })),
        ...groups.map(group => ({ id: group.id, name: group.name, kind: 'group' as const })),
      ].filter(item => item.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];

  const syncMention = (value: string, cursor: number) => {
    const upto = value.slice(0, cursor);
    const at = upto.lastIndexOf('@');
    if (at < 0 || /\s/.test(upto.slice(at + 1))) {
      setMentionOpen(false);
      return;
    }
    setMentionQuery(upto.slice(at + 1));
    setMentionOpen(true);
  };

  const insertMention = (name: string) => {
    const el = composerRef.current;
    const cursor = el ? el.selectionStart : inputMessage.length;
    const upto = inputMessage.slice(0, cursor);
    const at = upto.lastIndexOf('@');
    if (at < 0) return;
    const next = inputMessage.slice(0, at) + '@' + name + ' ' + inputMessage.slice(cursor);
    setInputMessage(next);
    setMentionOpen(false);
    const pos = at + name.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const addAttachments = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const room = 6 - attachments.length;
    if (incoming.length > room) setAttachError('Up to six attachments.');
    else setAttachError('');
    const accepted = incoming.slice(0, Math.max(room, 0));
    if (accepted.length === 0) return;
    setAttachments(current => [
      ...current,
      ...accepted.map((file, index) => ({
        id: file.name + '-' + current.length + '-' + index + '-' + file.size,
        name: file.name,
      })),
    ]);
  };

  const onComposerPaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    const listed = e.clipboardData.files;
    if (listed && listed.length > 0) {
      files.push(...Array.from(listed));
    } else {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    addAttachments(files);
  };

  const markWorking = (ids: string[]) => {
    const floor = messages.reduce((max, msg) => Math.max(max, msg.created_at || 0), 0);
    for (const id of ids) pendingAfter.current[id] = floor;
    setWorkingIds(current => Array.from(new Set([...current, ...ids])));
  };

  const sendMessage = async () => {
    const names = attachments.map(item => item.name);
    const text = inputMessage.trim();
    if ((!text && names.length === 0) || !activeConversation) return;
    const content = [text, ...names].filter(part => part.length > 0).join('\n');

    const targets: string[] = [];
    if (activeConversation.type === 'bot') {
      targets.push(activeConversation.details.id);
    } else {
      const group = groups.find(item => item.id === activeConversation.details.id);
      const members = group?.members || [];
      const named = members.filter(bot => mentionAt(content, bot.name));
      const picked = named.length > 0 ? named : members;
      for (const bot of picked) targets.push(bot.id);
    }
    if (targets.length > 0) markWorking(targets);

    const mentioned = [...bots].sort((a, b) => b.name.length - a.name.length).find(bot => mentionAt(content, bot.name));
    const sent = await fetch(`/api/conversations/${activeConversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, mentionedBotId: mentioned?.id }),
    });
    if (!sent.ok && targets.length > 0) {
      for (const id of targets) delete pendingAfter.current[id];
      setWorkingIds(current => current.filter(id => !targets.includes(id)));
    }

    setInputMessage('');
    setAttachments([]);
    setAttachError('');
    setMentionOpen(false);
    loadMessages();
  };

  const title = activeConversation?.type === 'bot'
    ? ((activeConversation.details as Bot).title || '').trim()
    : '';
  const nameColor = activeConversation?.type === 'bot'
    ? (activeConversation.details as Bot).color
    : undefined;

  const importFromMarketplace = async () => {
    setImportMiss('');
    try {
      const res = await fetch('/api/marketplace-handoff/status', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      const configured = data?.configured === true;
      setMarketConfigured(configured);
      if (!configured) return;
      const returnTo = window.location.origin + window.location.pathname;
      window.location.href = '/api/marketplace-handoff?return=' + encodeURIComponent(returnTo);
    } catch {
      setMarketConfigured(false);
    }
  };

  return (
    <div className="field">
      <aside className="rail">
        <div className="brand">
          <div className={logoDrop ? 'logo-shape is-settling' : 'logo-shape'}>
            <svg viewBox="0 0 36 28" width="28" height="22" aria-hidden="true">
              <path fill="#D5D0C3" d="M18 2c6.4.8 13.2 5.2 14 11 .8 6.2-4.2 12.2-11.2 12.6-6.6.4-13.6-3.6-15.4-9.4C3.4 10.2 9.2 1.2 18 2z" />
              <circle cx="13.2" cy="13" r="2.05" fill="#0E120C" />
              <circle cx="22.2" cy="12.2" r="2.05" fill="#0E120C" />
            </svg>
          </div>
          <div className="logo-word">botmancers</div>
        </div>
        <div className="bar">
          <div className="create-stack">
            <button type="button" className="add-btn" onClick={() => setShowBotModal(true)}>
              New
            </button>
            <button type="button" className="import-btn" onClick={() => { void importFromMarketplace(); }}>
              Import from Grok Marketplace
            </button>
            {marketConfigured === false ? (
              <p className="import-note">CLONE_MARKET_URL is not set.</p>
            ) : null}
            {importMiss ? <p className="import-note">{importMiss}</p> : null}
          </div>
        </div>
        {bots.length === 0 ? (
          <p className="empty-line">Pick someone to talk to.</p>
        ) : (
          <div className={rowMenu ? 'roster menu-open' : 'roster'}>
            {rosterBots.map(bot => bot.id === '6f427b40-c909-44ef-86ab-5ca857fffc3e' ? (
              <div
                key={bot.id}
                className={activeConversation?.type === 'bot' && activeConversation.details.id === bot.id ? 'bot-lead is-open' : 'bot-lead'}
                onClick={() => openBot(bot.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  setRowMenu({ bot, x: e.clientX, y: e.clientY });
                }}
              >
                <div className="row-head">
                  <span className="mark" style={{ color: bot.color }}>
                    <span className="mark-tri" />
                    {workingIds.includes(bot.id) ? <span className="mark-dot" /> : null}
                  </span>
                  {editingId === bot.id ? (
                    <input
                      className="bot-name"
                      value={rowName}
                      autoFocus
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRowName(e.target.value)}
                      onBlur={() => renameFromRow(bot)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                        if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                      style={{ color: '#D5D0C3' }}
                    />
                  ) : (
                    <div className="bot-name">
                      {bot.name}
                    </div>
                  )}
                </div>
                {rosterPreview(bot.latest, bot.id, messages, activeConversation?.type === 'bot' ? activeConversation.details.id : '', handoffOpen, keptPreview) ? <div className="bot-preview">{rosterPreview(bot.latest, bot.id, messages, activeConversation?.type === 'bot' ? activeConversation.details.id : '', handoffOpen, keptPreview)}</div> : null}
                <div className="row-tip" onClick={e => e.stopPropagation()}>
                  {bot.unread && !(activeConversation?.type === 'bot' && activeConversation.details.id === bot.id) ? (
                    <div className="card-role">Unread</div>
                  ) : null}
                  <div className="card-role">{lifeWord(bot.last_seen, beatClock.serverNow, beatClock.fetchedAt, now)}</div>
                  <button
                    type="button"
                    className="pin-word"
                    onClick={e => {
                      e.stopPropagation();
                      pinBot(bot);
                    }}
                  >
                    {bot.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    className="pin-word"
                    onClick={e => {
                      e.stopPropagation();
                      hideBot(bot, true);
                    }}
                  >
                    Hide
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={bot.id}
                className={activeConversation?.type === 'bot' && activeConversation.details.id === bot.id ? 'bot-row is-open' : 'bot-row'}
                onClick={() => openBot(bot.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  setRowMenu({ bot, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="mark" style={{ color: bot.color }}>
                  <span className="mark-tri" />
                  {workingIds.includes(bot.id) ? <span className="mark-dot" /> : null}
                </span>
                <div className="bot-copy">
                  {editingId === bot.id ? (
                    <input
                      className="bot-name"
                      value={rowName}
                      autoFocus
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRowName(e.target.value)}
                      onBlur={() => renameFromRow(bot)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                        if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <div className="bot-name">
                      {bot.name}
                    </div>
                  )}
                  {rosterPreview(bot.latest, bot.id, messages, activeConversation?.type === 'bot' ? activeConversation.details.id : '', handoffOpen, keptPreview) ? <div className="bot-preview">{rosterPreview(bot.latest, bot.id, messages, activeConversation?.type === 'bot' ? activeConversation.details.id : '', handoffOpen, keptPreview)}</div> : null}
                </div>
                <div className="row-tip" onClick={e => e.stopPropagation()}>
                  {bot.unread && !(activeConversation?.type === 'bot' && activeConversation.details.id === bot.id) ? (
                    <div className="card-role">Unread</div>
                  ) : null}
                  <div className="card-role">{lifeWord(bot.last_seen, beatClock.serverNow, beatClock.fetchedAt, now)}</div>
                  <button
                    type="button"
                    className="pin-word"
                    onClick={e => {
                      e.stopPropagation();
                      pinBot(bot);
                    }}
                  >
                    {bot.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    className="pin-word"
                    onClick={e => {
                      e.stopPropagation();
                      hideBot(bot, true);
                    }}
                  >
                    Hide
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {hiddenBots.length > 0 ? (
          <div className="roster">
            <button type="button" className="pin-word" onClick={() => setShowHidden(open => !open)}>
              Hidden
            </button>
            {showHidden ? hiddenBots.map(bot => (
              <div key={bot.id} className="card">
                <div className="card-name" style={{ color: bot.color }}>{bot.name}</div>
                <button type="button" className="pin-word" onClick={() => hideBot(bot, false)}>
                  Unhide
                </button>
              </div>
            )) : null}
          </div>
        ) : null}
      </aside>

      <section className="pane">
        {activeConversation ? (
          <div className="thread">
            <div className="thread-bar">
              <div>
                {activeConversation.type === 'bot' ? (
                  <button type="button" className="thread-name" style={nameColor ? { color: nameColor } : undefined} onClick={() => {
                    const bot = activeConversation.details as Bot;
                    setDraftName(bot.name);
                    setDraftLabel(bot.title || '');
                    setDraftDescription(bot.description || '');
                    setSettingsOpen(true);
                    setPictureOpen(true);
                    setAvatarStep(false);
                  }}>
                    {activeConversation.details.name}
                  </button>
                ) : (
                  <button type="button" className="thread-name" onClick={() => {
                    setDraftName(activeConversation.details.name);
                    setSettingsOpen(true);
                  }}>
                    {activeConversation.details.name}
                  </button>
                )}
                {title ? <div className="thread-role">{title}</div> : null}
                {activeConversation.type === 'bot' ? (
                  <>
                    <div className="thread-role">{workWord(workingIds.includes(activeConversation.details.id))}</div>
                    <div className="thread-role">{lifeWord((bots.find(bot => bot.id === activeConversation.details.id) || activeConversation.details as Bot).last_seen, beatClock.serverNow, beatClock.fetchedAt, now)}</div>
                  </>
                ) : null}
                {pictureOpen && activeConversation.type === 'bot' ? (
                  <button type="button" className="avatar-pic" onClick={() => setAvatarStep(true)} aria-label="Picture">
                    {(activeConversation.details as Bot).avatar ? <img src={(activeConversation.details as Bot).avatar} alt="" /> : null}
                  </button>
                ) : null}
              </div>
            </div>
            {avatarStep && activeConversation.type === 'bot' ? (
              <>
                <div className="avatar-step avatar-desk">
                  <span className="kind-word">Bot</span>
                  <button type="button" className="kind-word">Generate</button>
                  <label className="kind-word">
                    Upload
                    <input ref={avatarFileRef} type="file" accept="image/*,.svg" />
                  </label>
                  <button type="button" className="create-btn" onClick={setAvatar}>Set avatar</button>
                </div>
                <div className="avatar-step avatar-phone">
                  <button type="button" className="kind-word" onClick={() => galleryRef.current?.click()}>Gallery</button>
                  <button type="button" className="kind-word">Generate</button>
                  <button type="button" className="kind-word" onClick={removePhoto}>Remove Photo</button>
                  <input
                    ref={galleryRef}
                    type="file"
                    accept="image/*,.svg"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      void storeGallery(file);
                    }}
                  />
                </div>
              </>
            ) : null}
            {settingsOpen && activeConversation.type === 'bot' ? (
              <form className="form-card header-settings" onSubmit={e => e.preventDefault()}>
                <label htmlFor="set-name">Name</label>
                <input id="set-name" type="text" value={draftName} onChange={e => setDraftName(e.target.value)} onBlur={e => saveIdentity({ name: e.target.value, title: draftLabel, description: draftDescription })} />
                <label htmlFor="set-label">Label</label>
                <input id="set-label" type="text" value={draftLabel} onChange={e => setDraftLabel(e.target.value)} onBlur={e => saveIdentity({ name: draftName, title: e.target.value, description: draftDescription })} />
                <label htmlFor="set-description">Description</label>
                <textarea id="set-description" rows={3} value={draftDescription} onChange={e => setDraftDescription(e.target.value)} onBlur={e => saveIdentity({ name: draftName, title: draftLabel, description: e.target.value })} />
              </form>
            ) : null}
            {settingsOpen && activeConversation.type === 'group' ? (
              <form className="form-card header-settings" onSubmit={e => e.preventDefault()}>
                <label htmlFor="set-name">Name</label>
                <input id="set-name" type="text" value={draftName} onChange={e => setDraftName(e.target.value)} onBlur={e => saveGroupName(e.target.value)} />
              </form>
            ) : null}

            <div className="messages-wrap">
            <div className="messages">
              {messages.map((msg, index) => {
                if (hiddenUnderMessaged(messages, index) || hiddenAboveMessaged(messages, index)) return null;
                if (activeConversation.type === 'bot' && foreignReply(msg, activeConversation.details.id)) return null;
                const mine = msg.sender_type === 'user';
                const shown = messagePicture(stripStoredPrefix(msg.content));
                const picture = shown.images.map(src => (
                  <img key={src.slice(0, 48)} src={src} alt="" style={{ display: 'block', width: 64, height: 64 }} />
                ));
                let targets: Bot[] = [];
                if (msg.handoff_targets) {
                  try {
                    const ids = JSON.parse(msg.handoff_targets);
                    if (Array.isArray(ids)) {
                      targets = ids.map(id => bots.find(bot => bot.id === String(id))).filter((bot): bot is Bot => Boolean(bot));
                    }
                  } catch {
                    targets = [];
                  }
                }
                const mark = (bot: Bot) => bot.avatar ? (
                  <img key={bot.id} className="agent-mark" src={bot.avatar} alt="" />
                ) : (
                  <span key={bot.id} className="agent-mark" style={{ background: bot.color || 'currentColor' }} />
                );
                if (targets.length > 1) {
                  const opened = revealed[msg.id] ? [...commentsBefore(messages, index), ...revealed[msg.id]] : [];
                  return [
                    <div key={msg.id} className="agent-turn">
                      <div className="agent-from">
                        <span>Messaged</span>
                        {targets.map(mark)}
                        <span>{targets.length} Bots</span>
                      </div>
                      <div className="agent-bar" onClick={() => { void revealBetween(msg.id); }}>
                        {shown.text}
                        {picture}
                      </div>
                    </div>,
                    ...opened.map(item => {
                      const sender = bots.find(bot => bot.id === item.sender_id);
                      const body = messagePicture(stripStoredPrefix(item.content));
                      const shots = body.images.map(src => (
                        <img key={src.slice(0, 48)} src={src} alt="" style={{ display: 'block', width: 64, height: 64 }} />
                      ));
                      return (
                        <div key={item.id} className="agent-turn">
                          <div className="agent-from">
                            <span>Message from</span>
                            {sender ? mark(sender) : <span className="agent-mark" />}
                            <span>{sender?.name || item.sender_name || ''}</span>
                          </div>
                          <div className="agent-bar">
                            {body.text}
                            {shots}
                          </div>
                        </div>
                      );
                    }),
                  ];
                }
                if (!mine && activeConversation.type === 'bot' && agentComment(msg)) {
                  const ownerId = activeConversation.details.id;
                  const opened = handoffOpen[msg.id] ? repliesForHandoff(messages, index, ownerId) : [];
                  const speaker = (activeConversation.details as Bot).color;
                  return [
                    <div
                      key={msg.id}
                      className="msg-bot"
                      onClick={() => {
                        const replies = repliesForHandoff(messages, index, ownerId);
                        setHandoffOpen(current => current[msg.id] ? current : { ...current, [msg.id]: true });
                        setKeptPreview(current => {
                          const next = { ...current };
                          for (const item of replies) {
                            if (item.sender_id) next[item.sender_id] = latestLine(item.content);
                          }
                          return next;
                        });
                      }}
                    >
                      <div className="msg-name" style={speaker ? { color: speaker } : undefined}>
                        {msg.sender_name || activeConversation.details.name}
                      </div>
                      <div className="msg-body">
                        {shown.text}
                        {picture}
                      </div>
                    </div>,
                    ...opened.map(item => {
                      const sender = bots.find(bot => bot.id === item.sender_id);
                      const body = messagePicture(stripStoredPrefix(item.content));
                      const shots = body.images.map(src => (
                        <img key={src.slice(0, 48)} src={src} alt="" style={{ display: 'block', width: 64, height: 64 }} />
                      ));
                      return (
                        <div key={item.id} className="agent-turn">
                          <div className="agent-from">
                            <span>Message from</span>
                            {sender ? mark(sender) : <span className="agent-mark" />}
                            <span>{sender?.name || item.sender_name || ''}</span>
                          </div>
                          <div className="agent-bar">
                            {body.text}
                            {shots}
                          </div>
                        </div>
                      );
                    }),
                  ];
                }
                if (!mine && activeConversation.type === 'group') {
                  const sender = bots.find(bot => bot.id === msg.sender_id);
                  const senderName = sender?.name || msg.sender_name || '';
                  return (
                    <div key={msg.id} className="agent-turn">
                      <div className="agent-from">
                        <span>Message from</span>
                        {sender ? mark(sender) : <span className="agent-mark" />}
                        <span>{senderName}</span>
                      </div>
                      <div className="agent-bar">
                        {shown.text}
                        {picture}
                      </div>
                    </div>
                  );
                }
                const speaker = mine
                  ? undefined
                  : (activeConversation.type === 'bot'
                    ? (activeConversation.details as Bot).color
                    : bots.find(b => b.id === msg.sender_id)?.color);
                const draft = mine ? null : parseDraft(msg.content);
                const run = mine || draft ? null : parseRun(msg.content);
                const routine = mine || draft || run ? null : routineWord(msg.content);
                return (
                  <div key={msg.id} className={mine ? 'msg-you' : 'msg-bot'} ref={run && run.state === 'running' ? runningLineRef : undefined}>
                    <div
                      className={mine ? 'msg-name msg-name-you' : 'msg-name'}
                      style={speaker ? { color: speaker } : undefined}
                    >
                      {mine ? 'You' : routine ? 'routine' : (msg.sender_name || activeConversation.details.name)}
                    </div>
                    {draft ? (
                      <DraftCard
                        draft={draft}
                        onSend={(recipient, body) => { void draftAction(msg.id, 'send', recipient, body); }}
                        onDiscard={(recipient, body) => { void draftAction(msg.id, 'discard', recipient, body); }}
                      />
                    ) : null}
                    {run ? (
                      <div className="msg-body">
                        {runLine(run)}
                        {run.state === 'running' ? (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="attach-word"
                              style={{ font: 'inherit' }}
                              onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                void stopRun(msg.id);
                              }}
                            >
                              Stop
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {routine ? (
                      <div className="msg-body">{routine}</div>
                    ) : null}
                    {draft || run || routine ? null : <div className="msg-body">
                      {fileArtifactName(msg.content) ? withoutFileMarker(shown.text) : shown.text}
                      {picture}
                      {fileArtifactName(msg.content) ? (
                        <a
                          className="file-control"
                          href={'/api/files/' + encodeURIComponent(fileArtifactName(msg.content) || '')}
                          download={fileArtifactName(msg.content) || undefined}
                        >
                          {fileArtifactName(msg.content)}
                        </a>
                      ) : null}
                      {!mine && approvalCodeIn(shown.text) && !messages.some(later =>
                        later.sender_type === 'bot' &&
                        later.created_at > msg.created_at &&
                        (later.content.includes(approvalCodeIn(shown.text) || '') || later.content.startsWith('Denied'))
                      ) ? (
                        <>
                          <button type="button" className="approve-control" onClick={() => approveRequest(msg.id)}>
                            Approve
                          </button>
                          <button type="button" className="approve-control" style={{ marginLeft: 8 }} onClick={() => denyRequest(msg.id)}>
                            Deny
                          </button>
                        </>
                      ) : null}
                    </div>}
                  </div>
                );
              })}
              <div ref={computerRoomRef} />
              <div ref={messagesEndRef} />
            </div>
            {computerOpen ? (
              <div className="computer-float">
                <div className="computer-top">
                  <span className="computer-lights" aria-hidden="true">
                    <span className="computer-light computer-light-red" />
                    <span className="computer-light computer-light-yellow" />
                    <span className="computer-light computer-light-green" />
                  </span>
                  <span className="computer-teach">
                    <span className="computer-teach-pill">
                      <span className="computer-teach-mark" aria-hidden="true" />
                      Teach a task
                    </span>
                    <span className="computer-expand" aria-hidden="true">
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <path d="M9.2 2.6H13.4V6.8M6.8 13.4H2.6V9.2M13.1 2.9L9.4 6.6M2.9 13.1L6.6 9.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </span>
                </div>
                <div className="computer-band" ref={computerBandRef} />
                <div className="computer-desk">
                  {computerHtml ? (
                    <iframe className="computer-page" sandbox="" srcDoc={computerHtml} tabIndex={-1} />
                  ) : null}
                  <div className="computer-dock">
                    <img src="/computer/dock-chrome.png" alt="" />
                    <img src="/computer/dock-gray.png" alt="" />
                    <img src="/computer/dock-terminal.png" alt="" />
                  </div>
                </div>
              </div>
            ) : null}
            </div>

            <div className="composer" onPaste={onComposerPaste}>
              {mentionOpen && mentionItems.length > 0 ? (
                <div className="mention-list">
                  {mentionItems.map(item => (
                    <button key={item.kind + item.id} type="button" onMouseDown={e => { e.preventDefault(); insertMention(item.name); }}>
                      @{item.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="composer-box">
                {attachError ? <p className="attach-error">{attachError}</p> : null}
                {attachments.length > 0 ? (
                  <div className="attach-names">
                    {attachments.map(item => <span key={item.id}>{item.name}</span>)}
                  </div>
                ) : null}
                <textarea
                  ref={composerRef}
                  rows={2}
                  value={inputMessage}
                  onChange={e => {
                    setInputMessage(e.target.value);
                    syncMention(e.target.value, e.target.selectionStart);
                  }}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' || e.shiftKey) return;
                    e.preventDefault();
                    if (mentionOpen && mentionItems.length > 0) {
                      insertMention(mentionItems[0].name);
                      return;
                    }
                    sendMessage();
                  }}
                  placeholder="Say something"
                />
              </div>
              <input
                ref={attachInputRef}
                className="attach-input"
                type="file"
                multiple
                onChange={e => {
                  addAttachments(Array.from(e.target.files || []));
                  e.target.value = '';
                }}
              />
              <button type="button" className="attach-word" onClick={() => attachInputRef.current?.click()}>
                Attach
              </button>
              <button type="button" className="send-btn" onClick={sendMessage}>
                Send
              </button>
            </div>
          </div>
        ) : (
          <p className="empty-line">Pick someone to talk to.</p>
        )}
      </section>

      {deleteAsk ? (
        <div className="modal-scrim">
          <div className="confirm-card">
            <p>Delete {deleteAsk.name}?</p>
            <div className="form-actions">
              <button type="button" className="cancel-btn" onClick={() => setDeleteAsk(null)}>Cancel</button>
              <button type="button" className="create-btn" onClick={confirmDelete}>Confirm</button>
            </div>
          </div>
        </div>
      ) : null}

      {rowMenu ? (
        <div
          ref={rowMenuRef}
          className="row-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button type="button" onClick={e => { e.stopPropagation(); setRowMenu(null); pinBot(rowMenu.bot); }}>Pin</button>
          <button type="button" onClick={e => { e.stopPropagation(); setRowMenu(null); markBotUnread(rowMenu.bot); }}>Mark as Unread</button>
          <button type="button" onClick={e => { e.stopPropagation(); setRowMenu(null); setEditingId(rowMenu.bot.id); setRowName(rowMenu.bot.name); }}>Rename Bot</button>
          <button type="button" onClick={e => { e.stopPropagation(); setRowMenu(null); hideBot(rowMenu.bot, true); }}>Hide from sidebar</button>
          <button type="button" onClick={e => { e.stopPropagation(); setRowMenu(null); setDeleteAsk(rowMenu.bot); }}>Delete</button>
        </div>
      ) : null}

      {showBotModal && (
        <BotModal
          bots={bots}
          onClose={() => setShowBotModal(false)}
          onCreated={() => {
            loadBots();
            loadGroups();
            setShowBotModal(false);
          }}
        />
      )}
    </div>
  );
}

function BotModal({ bots, onClose, onCreated }: { bots: Bot[]; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<'bot' | 'group'>('bot');
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [groupError, setGroupError] = useState('');

  const handleBot = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    onCreated();
  };

  const handleGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const picked = memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
    if (picked.length < 2 || picked.length > 6) {
      setGroupError('Pick 2 to 6 bots.');
      return;
    }
    const generated = picked.map(bot => bot.name).join(', ');
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: generated, botIds: picked.map(bot => bot.id), ownerId: picked[0].id }),
    });
    if (!res.ok) {
      setGroupError('Pick 2 to 6 bots.');
      return;
    }
    onCreated();
  };

  const toggleMember = (id: string) => {
    setMemberIds(current => {
      if (current.includes(id)) return current.filter(item => item !== id);
      if (current.length >= 6) return current;
      return [...current, id];
    });
  };

  return (
    <div className="modal-scrim">
      <div className="new-forms">
        <div className="form-card">
        <div className="kind-row">
          <button type="button" className="kind-word" aria-pressed={kind === 'bot'} onClick={() => setKind('bot')} style={{ opacity: kind === 'bot' ? 1 : 0.45 }}>
            Bot
          </button>
          <button type="button" className="kind-word" aria-pressed={kind === 'group'} onClick={() => setKind('group')} style={{ opacity: kind === 'group' ? 1 : 0.45 }}>
            Group
          </button>
        </div>
        {kind === 'bot' ? (
        <form onSubmit={handleBot}>
          <label htmlFor="bot-name">Name</label>
          <input id="bot-name" type="text" value={name} onChange={e => setName(e.target.value)} required />
          <div className="form-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="create-btn">
              Create
            </button>
          </div>
        </form>
        ) : (
        <form onSubmit={handleGroup}>
          {groupError ? <p className="group-error">{groupError}</p> : null}
          <div className="member-picks">
            {bots.map(bot => {
              const on = memberIds.includes(bot.id);
              return (
                <button
                  key={bot.id}
                  type="button"
                  className="card"
                  aria-pressed={on}
                  onClick={() => toggleMember(bot.id)}
                  style={{ opacity: on ? 1 : 0.45 }}
                >
                  <div className="card-name" style={{ color: bot.color }}>{bot.name}</div>
                </button>
              );
            })}
          </div>
          <div className="form-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="create-btn">
              Create
            </button>
          </div>
        </form>
        )}
        </div>
      </div>
    </div>
  );
}
