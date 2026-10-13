'use client';

import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { parseRun, runLine } from '@/lib/run';
import BotAvatar from '@/app/components/BotAvatar';
import type { AvatarConfig } from '@/lib/avatar';
import { parseDraft, draftTitle, parseApprovalCode, parseFileNames, parseHandoff } from '@/lib/draft';
import {
  DEFAULT_RUNTIME_FORM,
  NEW_BOT_WORKDIR_HINT,
  SELECT_DECK_ERROR,
  deckEventDisplay,
  newBotSubmitBody,
  runtimeFormView,
  type DeckListState,
  type RuntimeFormInput,
} from '@/lib/bot-runtime-ui';
import { RosterRuntimeLine, RuntimeSection } from '@/app/components/AgentDeckRuntime';
import { useDeckList } from '@/app/components/useDeckList';

interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar?: string;
  avatar_color?: string | null;
  avatar_eyes?: string | null;
  avatar_hands?: string | null;
  avatar_accessory?: string | null;
  avatar_config?: AvatarConfig | null;
  color: string;
  pinned?: number;
  hidden?: number;
  last_seen?: number | null;
  unread?: number;
  latest?: string;
  agent?: string | null;
  deck_id?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: boolean | number | null;
  launchable?: boolean | null;
}

interface Message {
  id: string;
  sender_type: 'user' | 'bot';
  sender_id?: string;
  sender_name?: string;
  content: string;
  handoff_targets?: string | null;
  draftStatus?: 'open' | 'sent' | 'discarded' | null;
  approvalStatus?: 'pending' | 'approved' | 'denied' | null;
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

function isChiefOfStaff(bot: Bot | { name: string } | undefined): boolean {
  return !!bot && bot.name.toLowerCase() === 'chief-of-staff';
}

function rosterRank(bot: Bot) {
  return isChiefOfStaff(bot) ? 0 : bot.pinned ? 1 : 2;
}

function computerPageHtml(list: Message[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const run = parseRun(list[i].content);
    if (!run) continue;
    if (run.state === 'stopped') return null;
    return run.page || run.html || null;
  }
  return null;
}

function workWord(working: boolean) {
  return working ? 'Working' : 'Not working';
}

function latestLine(content?: string) {
  if (!content) return '';
  const run = parseRun(content);
  if (run) return runLine(run);
  const event = deckEventDisplay(content);
  if (event) return `${event.label} ${event.detail}`.replace(/\s+/g, ' ').trim();
  return content.replace(/\s+/g, ' ').trim();
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

function renderThreadBody(text: string, keyPrefix: string) {
  const lines = String(text ?? '').split('\n');
  if (!lines.some(line => deckEventDisplay(line) !== null)) return text;
  const out: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={keyPrefix + '-br-' + index} />);
    const event = deckEventDisplay(line);
    if (event) {
      out.push(
        <span key={keyPrefix + '-' + index} className="deck-event">
          <span className="deck-event-label">{event.label}</span>
          {event.detail ? ' ' + event.detail : ''}
        </span>
      );
    } else {
      out.push(<span key={keyPrefix + '-' + index}>{line}</span>);
    }
  });
  return out;
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

function messagePicture(content: string) {
  const images: string[] = [];
  const text = content.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, (url) => {
    images.push(url.replace(/\s/g, ''));
    return '';
  });
  return { text: displayBody(text), images };
}

export default function Home() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const defaulted = useRef(false);
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowName, setRowName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [revealed, setRevealed] = useState<Record<string, Message[]>>({});
  const revealing = useRef<Record<string, boolean>>({});
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
  const [importMiss, setImportMiss] = useState('');
  const { state: deckState, retry: retryDecks } = useDeckList();

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
    const first = [...bots].filter(bot => !bot.hidden).sort((a, b) => rosterRank(a) - rosterRank(b))[0] || bots[0];
    defaulted.current = true;
    void openBot(first.id);
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

  const openThreadBot = activeConversation?.type === 'bot'
    ? (bots.find(bot => bot.id === activeConversation.details.id) ?? activeConversation.details as Bot)
    : undefined;
  const computerOpen = !!activeConversation && activeConversation.type === 'bot' && isChiefOfStaff(openThreadBot);
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

  async function loadBots() {
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
      setImportMiss('Imported bot not found. The bot may not have been created successfully.');
      defaulted.current = false;
      return;
    }
    const convRes = await fetch('/api/conversations?botId=' + encodeURIComponent(found.id));
    const conv = await convRes.json().catch(() => null);
    if (!convRes.ok || !conv || !conv.id) {
      setImportMiss('Imported bot not found. The bot may not have been created successfully.');
      defaulted.current = false;
      return;
    }
    setImportMiss('');
    setPictureOpen(false);
    setAvatarStep(false);
    setActiveConversation({
      id: conv.id,
      type: 'bot',
      details: found,
    });
  }

  async function loadGroups() {
    const res = await fetch('/api/groups');
    const data = await res.json();
    setGroups(data);
  }

  async function loadMessages() {
    if (!activeConversation) return;
    const res = await fetch(`/api/conversations/${activeConversation.id}/messages`);
    const data = await res.json();
    setMessages(data);
  }

  const stopRun = async (messageId: string) => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/messages/${messageId}/stop`, {
      method: 'POST',
    });
    await loadMessages();
  };

  const stopDelegation = async () => {
    if (!activeConversation) return;
    await fetch(`/api/conversations/${activeConversation.id}/stop`, {
      method: 'POST',
    });
    await loadMessages();
  };

  const toggleReveal = async (msg: Message, target: string) => {
    if (revealed[msg.id]) {
      setRevealed(current => {
        const next = { ...current };
        delete next[msg.id];
        return next;
      });
      return;
    }
    if (revealing.current[msg.id]) return;
    const index = messages.findIndex(item => item.id === msg.id);
    const bot = bots.find(item => item.name === target);
    const reply = messages.slice(index + 1).find(item =>
      item.sender_type === 'bot' && (bot ? item.sender_id === bot.id : item.sender_name === target)
    );
    if (!reply) return;
    revealing.current[msg.id] = true;
    try {
      const res = await fetch(`/api/messages/${msg.id}/between?other=${encodeURIComponent(reply.id)}`);
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data) && data.length > 0) {
        setRevealed(current => ({ ...current, [msg.id]: data }));
      }
    } finally {
      delete revealing.current[msg.id];
    }
  };

  const renameGroup = async (group: GroupRow) => {
    const name = groupName.trim();
    setEditingGroupId(null);
    if (!name || name === group.name) return;
    const res = await fetch('/api/groups', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: group.id, name }),
    });
    if (!res.ok) return;
    const saved = await res.json();
    setGroups(current => current.map(item => item.id === saved.id ? { ...item, name: saved.name } : item));
    if (activeConversation?.type === 'group' && activeConversation.details.id === saved.id) {
      setActiveConversation({
        ...activeConversation,
        details: { ...activeConversation.details, name: saved.name },
      });
    }
  };

  async function openBot(id: string) {
    const bot = bots.find(b => b.id === id);
    if (!bot) return;

    const convRes = await fetch(`/api/conversations?botId=${id}`);
    const conv = await convRes.json();

    setPictureOpen(false);
    setAvatarStep(false);
    setActiveConversation({
      id: conv.id,
      type: 'bot',
      details: bot,
    });
  }

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

  const rosterBots = [...bots].filter(bot => !bot.hidden).sort((a, b) => rosterRank(a) - rosterRank(b));
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
      if (!configured) {
        setImportMiss('CLONE_MARKET_URL is not configured. Please contact your administrator.');
        return;
      }
      const returnTo = window.location.origin + window.location.pathname;
      window.location.href = '/api/marketplace-handoff?return=' + encodeURIComponent(returnTo);
    } catch {
      setImportMiss('Failed to initiate import. Please try again.');
    }
  };

  return (
    <div className="field">
      <aside className="rail">
        <div className="brand">
          <div className={logoDrop ? 'logo-shape is-settling' : 'logo-shape'}>
            <Image
              src="/brand/botmancers-logo-filled-64.png"
              alt=""
              width={28}
              height={28}
            />
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
            {importMiss ? <p className="import-note">{importMiss}</p> : null}
          </div>
          <Link href="/settings" className="add-btn settings-link">
            Settings
          </Link>
        </div>
        {bots.length === 0 ? (
          <p className="empty-line">Pick someone to talk to.</p>
        ) : (
          <div className={rowMenu ? 'roster menu-open' : 'roster'}>
            {rosterBots.map(bot => isChiefOfStaff(bot) ? (
              <div
                key={bot.id}
                className="card"
                onClick={() => openBot(bot.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  setRowMenu({ bot, x: e.clientX, y: e.clientY });
                }}
              >
                <div className="row-head">
                  <span className="mark-avatar">
                    <BotAvatar bot={bot} size={44} title={`${bot.name} avatar`} />
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
                      style={{ color: '#D5D0C3', fontSize: 26 }}
                    />
                  ) : (
                    <div className="bot-name" style={{ fontSize: 26 }}>
                      {bot.name}
                    </div>
                  )}
                </div>
                {latestLine(bot.latest) ? <div className="bot-preview">{latestLine(bot.latest)}</div> : null}
                <RosterRuntimeLine bot={bot} state={deckState} />
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
                <span className="mark-avatar mark-avatar-sm">
                  <BotAvatar bot={bot} size={36} title={`${bot.name} avatar`} />
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
                  {latestLine(bot.latest) ? <div className="bot-preview">{latestLine(bot.latest)}</div> : null}
                  <RosterRuntimeLine bot={bot} state={deckState} />
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
        {groups.length > 0 ? (
          <div className="roster">
            {groups.map(group => (
              <div
                key={group.id}
                className="card"
                onClick={() => openGroup(group.id)}
                onDoubleClick={e => {
                  e.stopPropagation();
                  setEditingGroupId(group.id);
                  setGroupName(group.name);
                }}
              >
                {editingGroupId === group.id ? (
                  <input
                    className="card-name"
                    value={groupName}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                    onChange={e => setGroupName(e.target.value)}
                    onBlur={() => renameGroup(group)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                      if (e.key === 'Escape') {
                        setEditingGroupId(null);
                      }
                    }}
                    style={{ background: 'transparent', border: 0, outline: 'none', padding: 0 }}
                  />
                ) : (
                  <div className="card-name">{groupLabel(group)}</div>
                )}
              </div>
            ))}
          </div>
        ) : null}
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
                    setPictureOpen(true);
                    setAvatarStep(false);
                  }}>
                    {activeConversation.details.name}
                  </button>
                ) : (
                  <span className="thread-name">
                    {activeConversation.details.name}
                  </span>
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
                    {(activeConversation.details as Bot).avatar ? (
                      <img src={(activeConversation.details as Bot).avatar} alt="" />
                    ) : (
                      <BotAvatar bot={activeConversation.details as Bot} size={46} />
                    )}
                  </button>
                ) : null}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                {activeConversation.type === 'bot' ? (
                  <Link
                    href={`/bots/${activeConversation.details.id}/config`}
                    className="attach-word"
                    style={{ textDecoration: 'none' }}
                  >
                    Config
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="attach-word"
                  title="Stop delegated turns in this thread"
                  onClick={() => { void stopDelegation(); }}
                >
                  Stop
                </button>
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

            <div className="messages-wrap">
            <div className="messages">
              {messages.map((msg) => {
                const mine = msg.sender_type === 'user';
                const shown = messagePicture(stripStoredPrefix(msg.content));
                const picture = shown.images.map(src => (
                  <img key={src.slice(0, 48)} src={src} alt="" style={{ display: 'block', width: 64, height: 64 }} />
                ));
                const mark = (bot: Bot) => (
                  <span key={bot.id} className="agent-mark">
                    <BotAvatar bot={bot} size={16} title={`${bot.name} avatar`} />
                  </span>
                );
                if (!mine && activeConversation.type === 'group') {
                  const sender = bots.find(bot => bot.id === msg.sender_id);
                  const senderName = sender?.name || msg.sender_name || '';
                  const groupDraft = parseDraft(stripStoredPrefix(msg.content));
                  const groupCode = parseApprovalCode(msg.content);
                  const groupFiles = parseFileNames(msg.content);
                  const groupHandoff = parseHandoff(shown.text);
                  const groupDraftStatus = msg.draftStatus ?? (groupDraft ? 'open' : null);
                  const groupApprovalStatus = msg.approvalStatus ?? (groupCode ? 'pending' : null);
                  return (
                    <div key={msg.id} className="agent-turn">
                      <div className="agent-from">
                        <span>Message from</span>
                        {sender ? mark(sender) : <span className="agent-mark" />}
                        <span>{senderName}</span>
                      </div>
                      {groupDraft && groupDraftStatus ? (
                        <div className="agent-bar">
                          <DraftCard
                            key={msg.id + groupDraftStatus}
                            message={msg}
                            conversationId={activeConversation.id}
                            status={groupDraftStatus}
                            onDone={() => { void loadMessages(); }}
                          />
                        </div>
                      ) : (
                        <div
                          className="agent-bar"
                          onClick={groupHandoff ? () => { void toggleReveal(msg, groupHandoff); } : undefined}
                          title={groupHandoff ? 'Show the replies between this handoff and the reply' : undefined}
                          style={groupHandoff ? { cursor: 'pointer' } : undefined}
                        >
                          {shown.text}
                          {picture}
                          {groupCode && groupApprovalStatus ? (
                            <ApprovalCard
                              key={msg.id + groupApprovalStatus}
                              message={msg}
                              conversationId={activeConversation.id}
                              status={groupApprovalStatus}
                              onDone={() => { void loadMessages(); }}
                            />
                          ) : null}
                          <FileLinks names={groupFiles} />
                        </div>
                      )}
                      {revealed[msg.id] ? (
                        <div className="agent-bar">
                          {revealed[msg.id].map(item => (
                            <div key={item.id}>{(item.sender_name || 'Bot') + ': ' + displayBody(item.content)}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                }
                const speaker = mine
                  ? undefined
                  : (activeConversation.type === 'bot'
                    ? (activeConversation.details as Bot).color
                    : bots.find(b => b.id === msg.sender_id)?.color);
                const run = mine ? null : parseRun(msg.content);
                const draft = !mine && !run ? parseDraft(stripStoredPrefix(msg.content)) : null;
                const approvalCode = !mine && !run ? parseApprovalCode(msg.content) : null;
                const fileNames = !mine && !run ? parseFileNames(msg.content) : [];
                const handoff = !mine && !run ? parseHandoff(shown.text) : null;
                const draftStatus = msg.draftStatus ?? (draft ? 'open' : null);
                const approvalStatus = msg.approvalStatus ?? (approvalCode ? 'pending' : null);
                return (
                  <div key={msg.id} className={mine ? 'msg-you' : 'msg-bot'} ref={run && run.state === 'running' ? runningLineRef : undefined}>
                    <div
                      className={mine ? 'msg-name msg-name-you' : 'msg-name'}
                      style={speaker ? { color: speaker } : undefined}
                    >
                      {mine ? 'You' : (msg.sender_name || activeConversation.details.name)}
                    </div>
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
                    ) : draft && draftStatus ? (
                      <div className="msg-body">
                        <DraftCard
                          key={msg.id + draftStatus}
                          message={msg}
                          conversationId={activeConversation.id}
                          status={draftStatus}
                          onDone={() => { void loadMessages(); }}
                        />
                      </div>
                    ) : (
                      <div
                        className="msg-body"
                        onClick={handoff ? () => { void toggleReveal(msg, handoff); } : undefined}
                        title={handoff ? 'Show the replies between this handoff and the reply' : undefined}
                        style={handoff ? { cursor: 'pointer' } : undefined}
                      >
                        {renderThreadBody(shown.text, msg.id)}
                        {picture}
                        {approvalCode && approvalStatus ? (
                          <ApprovalCard
                            key={msg.id + approvalStatus}
                            message={msg}
                            conversationId={activeConversation.id}
                            status={approvalStatus}
                            onDone={() => { void loadMessages(); }}
                          />
                        ) : null}
                        <FileLinks names={fileNames} />
                      </div>
                    )}
                    {revealed[msg.id] ? (
                      <div className="msg-body">
                        {revealed[msg.id].map(item => (
                          <div key={item.id}>{(item.sender_name || 'Bot') + ': ' + displayBody(item.content)}</div>
                        ))}
                      </div>
                    ) : null}
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
          deckState={deckState}
          onRetryDecks={retryDecks}
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

function DraftCard({ message, conversationId, status, onDone }: {
  message: Message;
  conversationId: string;
  status: 'open' | 'sent' | 'discarded';
  onDone: () => void;
}) {
  const parsed = parseDraft(stripStoredPrefix(message.content));
  const [recipient, setRecipient] = useState(parsed?.recipient ?? '');
  const [body, setBody] = useState(parsed?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(status !== 'open');
  const closedRef = useRef(status !== 'open');
  if (!parsed) return null;
  const locked = status !== 'open' || closed;
  const shownRecipient = locked ? parsed.recipient : recipient;
  const shownBody = locked ? parsed.body : body;
  const act = async (action: 'send' | 'discard') => {
    if (locked || closedRef.current || busy) return;
    if (action === 'send' && recipient.trim() === '') return;
    closedRef.current = true;
    setClosed(true);
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, action, recipient, body }),
      });
      if (!res.ok) {
        closedRef.current = false;
        setClosed(false);
      }
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="draft-card">
      <div className="draft-title">{draftTitle(parsed.channel)}</div>
      <input
        type="text"
        aria-label="Recipient"
        value={shownRecipient}
        readOnly={locked}
        disabled={busy}
        onChange={e => {
          if (!locked) setRecipient(e.target.value);
        }}
      />
      <textarea
        rows={3}
        aria-label="Draft body"
        value={shownBody}
        readOnly={locked}
        disabled={busy}
        onChange={e => {
          if (!locked) setBody(e.target.value);
        }}
      />
      {status === 'sent' ? <span className="draft-mark">Sent</span> : null}
      {status === 'discarded' ? <span className="draft-mark">Discarded</span> : null}
      {status !== 'discarded' ? (
        <button
          type="button"
          className="approve-control"
          disabled={busy}
          onClick={() => { void act('send'); }}
        >
          Send
        </button>
      ) : null}
      {status === 'open' ? (
        <button
          type="button"
          className="approve-control"
          style={{ marginLeft: 8 }}
          disabled={busy}
          onClick={() => { void act('discard'); }}
        >
          Discard
        </button>
      ) : null}
    </div>
  );
}

function ApprovalCard({ message, conversationId, status, onDone }: {
  message: Message;
  conversationId: string;
  status: 'pending' | 'approved' | 'denied';
  onDone: () => void;
}) {
  const code = parseApprovalCode(message.content);
  const [busy, setBusy] = useState(false);
  const closed = useRef(status !== 'pending');
  if (!code) return null;
  const readOnly = status !== 'pending';
  const act = async (decision: 'approve' | 'deny') => {
    if (closed.current || busy) return;
    closed.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, messageId: message.id }),
      });
      if (!res.ok) closed.current = false;
    } finally {
      setBusy(false);
      onDone();
    }
  };
  if (readOnly) {
    return <span className="draft-mark">{status === 'approved' ? 'Approved' : 'Denied'}</span>;
  }
  return (
    <span className="draft-mark">
      <button
        type="button"
        className="approve-control"
        disabled={busy}
        onClick={() => { void act('approve'); }}
      >
        Approve
      </button>
      <button
        type="button"
        className="approve-control"
        style={{ marginLeft: 8 }}
        disabled={busy}
        onClick={() => { void act('deny'); }}
      >
        Deny
      </button>
    </span>
  );
}

function FileLinks({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <>
      {names.map(name => (
        <span key={name}>
          <br />
          <a className="file-control" href={`/api/files/${encodeURIComponent(name)}`} download={name}>
            Download {name}
          </a>
        </span>
      ))}
    </>
  );
}


function BotModal({ bots, deckState, onRetryDecks, onClose, onCreated }: {
  bots: Bot[];
  deckState: DeckListState;
  onRetryDecks: () => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<'bot' | 'group'>('bot');
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [groupError, setGroupError] = useState('');
  const [form, setForm] = useState<RuntimeFormInput>(DEFAULT_RUNTIME_FORM);
  const [botError, setBotError] = useState('');

  useEffect(() => {
    onRetryDecks();
  }, [onRetryDecks]);

  const view = runtimeFormView(form, deckState);

  const changeForm = (patch: Partial<RuntimeFormInput>) => {
    setBotError('');
    setForm(current => ({ ...current, ...patch }));
  };

  const handleBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (view.submitDisabled) return;
    if (!form.deckId.trim()) {
      setBotError(SELECT_DECK_ERROR);
      return;
    }
    setBotError('');
    const res = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newBotSubmitBody({ name, ...form })),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setBotError(typeof body?.error === 'string' && body.error ? body.error : 'Failed to create bot');
      return;
    }
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
        <form onSubmit={handleBot} className="bot-form">
          <label htmlFor="bot-name">Name</label>
          <input id="bot-name" type="text" value={name} onChange={e => setName(e.target.value)} required />
          <RuntimeSection
            idPrefix="bot"
            variant="modal"
            form={form}
            onChange={changeForm}
            deckState={deckState}
            onRetry={onRetryDecks}
            workdirPlaceholder=""
            workdirHint={NEW_BOT_WORKDIR_HINT}
          />
          {botError ? <p className="group-error">{botError}</p> : null}
          <div className="form-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="create-btn" disabled={view.submitDisabled}>
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
