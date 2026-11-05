'use client';

import { Fragment, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { parseRun, runLine } from '@/lib/run';
import BotAvatar from '@/app/components/BotAvatar';
import AgentRail from '@/app/components/AgentRail';
import type { AvatarConfig } from '@/lib/avatar';
import { parseDraft, draftTitle, parseApprovalCode, parseFileNames, parseHandoff } from '@/lib/draft';
import {
  NEW_AGENT_WORKSPACE_HINT,
  WORKSPACE_TEMPLATE,
  agentEventDisplay,
} from '@/lib/bot-runtime-ui';
import {
  DEFAULT_REGISTRATION_FORM,
  hasRegistrationErrors,
  registrationCreateBody,
  registrationFormView,
  type RegistrationFormInput,
} from '@/lib/agent-registration-ui';
import { RegistrationFields } from '@/app/components/AgentRegistration';
import { useRuntimeConnections } from '@/app/components/useRuntimeConnections';
import { importedBotId, importedConfigPath } from '@/lib/market-handoff';
import ManageAgentsPanel from '@/app/components/ManageAgentsPanel';
import SessionsPanel from '@/app/components/SessionsPanel';
import { deletedStatusLine, type DeleteAgentRef } from '@/lib/bot-deletion';
import { DIALOG_FOCUSABLE, newAgentDialogPlacement, wrapFocusTarget, type DialogPlacement } from '@/lib/new-agent-dialog';
import ThreadState from '@/app/components/ThreadState';
import { threadView, type ThreadLoad } from '@/lib/thread-state';
import RuntimeFailureNotice from '@/app/components/RuntimeFailureNotice';
import { classifyRuntimeFailure } from '@/lib/runtime-failure';
import WakeNotice from '@/app/components/WakeNotice';
import { wakeNotices, type WakeEventView, type WakeNotice as WakeNoticeItem } from '@/lib/wake-notice';
import ExchangeCard from '@/app/components/ExchangeCard';
import type { ExchangeSummary } from '@/lib/exchange-view';
import { registrationSessionSyncCopy, type RegistrationSessionSync } from '@/lib/session-view';
import { agentLabel } from '@/lib/bot-definition';
import { legacyAgentChatHref } from '@/lib/owner-conversations';

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
  launchable?: boolean | null;
  launch_blocker?: string | null;
  runtime_connection_id?: string | null;
  runtime_connection?: { id: string; provider: string; label: string; host: string } | null;
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

interface Conversation {
  id: string;
  details: Bot;
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
  if (!lines.some(line => agentEventDisplay(line) !== null)) return text;
  const out: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={keyPrefix + '-br-' + index} />);
    const event = agentEventDisplay(line);
    if (event) {
      out.push(
        <span key={keyPrefix + '-' + index} className="agent-event">
          <span className="agent-event-label">{event.label}</span>
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
  const router = useRouter();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botsLoaded, setBotsLoaded] = useState(false);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const defaulted = useRef(false);
  const linkedSessionsRef = useRef(false);
  const linkedSessionRef = useRef<string | null>(null);
  const deletedCountRef = useRef(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notices, setNotices] = useState<WakeNoticeItem[]>([]);
  const [exchangeCards, setExchangeCards] = useState<ExchangeSummary[]>([]);
  const focusExchange = useRef<string | null>(null);
  const [threadLoad, setThreadLoad] = useState<ThreadLoad | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [inputMessage, setInputMessage] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const [attachError, setAttachError] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [showBotModal, setShowBotModal] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [avatarStep, setAvatarStep] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, Message[]>>({});
  const revealing = useRef<Record<string, boolean>>({});
  const [manageOpen, setManageOpen] = useState(false);
  const manageRef = useRef<HTMLButtonElement>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const sessionsRef = useRef<HTMLButtonElement>(null);
  const [rosterStatus, setRosterStatus] = useState('');
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

  useEffect(() => {
    if (logoSettled.current || bots.length === 0) return;
    logoSettled.current = true;
    setLogoDrop(true);
  }, [bots.length]);

  useEffect(() => {
    // A legacy `/?imported=<id>` return forwards to the imported bot's Config; the rail never handles imports.
    const imported = importedBotId(window.location.search);
    if (imported) {
      window.location.replace(importedConfigPath(imported));
      return;
    }
    const query = new URLSearchParams(window.location.search);
    if (query.get('new') === '1') {
      defaulted.current = true;
      window.setTimeout(() => setShowBotModal(true), 0);
      window.history.replaceState(null, '', '/');
    } else if (query.get('manage') === '1') {
      defaulted.current = true;
      window.setTimeout(() => setManageOpen(true), 0);
      window.history.replaceState(null, '', '/');
    }
    const deleted = Number(query.get('deleted'));
    if (deleted > 0) {
      deletedCountRef.current = deleted;
      window.history.replaceState(null, '', '/');
    }
    // NOT-551: compatibility for old direct-thread/session/exchange URLs.
    // The Agent itself still opens Overview; only an explicit old chat link
    // resolves the canonical direct conversation before moving to detail.
    const linkedAgent = query.get('agent');
    if (linkedAgent) {
      // NOT-551: old `/?agent=` chat links resolve to durable Conversations
      // detail (or Sessions). Do not restore ambient home chat.
      defaulted.current = true;
      if (query.get('sessions') === '1') {
        window.location.replace(`/agents/${encodeURIComponent(linkedAgent)}/sessions`);
      } else {
        const exchange = query.get('exchange');
        void fetch(`/api/conversations?botId=${encodeURIComponent(linkedAgent)}`, { cache: 'no-store' })
          .then(async response => response.ok ? response.json() : null)
          .then(conversation => {
            window.location.replace(legacyAgentChatHref(linkedAgent, conversation?.id ?? null, exchange));
          })
          .catch(() => window.location.replace(legacyAgentChatHref(linkedAgent, null, exchange)));
      }
    }
    void loadBots().then(() => {
      if (deleted > 0) setRosterStatus(deletedStatusLine(deleted));
    });
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
    const deleted = deletedCountRef.current;
    router.replace(`/agents/${encodeURIComponent(first.id)}${deleted > 0 ? `?deleted=${deleted}` : ''}`);
  }, [bots, activeConversation]);

  useEffect(() => {
    if (!activeConversation || !linkedSessionsRef.current) return;
    linkedSessionsRef.current = false;
    setSessionsOpen(true);
  }, [activeConversation]);


  useEffect(() => {
    activeIdRef.current = activeConversation?.id ?? null;
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

  const openThreadBot = activeConversation
    ? (bots.find(bot => bot.id === activeConversation.details.id) ?? activeConversation.details)
    : undefined;
  const computerOpen = !!activeConversation && isChiefOfStaff(openThreadBot);
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

  useEffect(() => {
    const id = focusExchange.current;
    if (!id) return;
    const card = document.getElementById(`exchange-${id}`);
    if (!card) return;
    focusExchange.current = null;
    card.scrollIntoView({ block: 'center' });
    card.focus({ preventScroll: true });
  }, [exchangeCards]);

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
    setBotsLoaded(true);
  }

  async function loadMessages() {
    if (!activeConversation) return;
    const id = activeConversation.id;
    let data: unknown = null;
    let ok = false;
    // NOT-475: Wake safety outcomes come from the projected conversation
    // read model; a failed read keeps the last notices.
    const eventsRead = fetch(`/api/conversations/${id}`)
      .then(async res => {
        const body = await res.json();
        return res.ok && Array.isArray(body?.events) ? body.events as WakeEventView[] : null;
      })
      .catch(() => null);
    // NOT-498: exchanges linked to this thread, typed from the exchange
    // API; a failed read keeps the last cards.
    const exchangesRead = fetch(`/api/exchanges?conversation=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json();
        return res.ok && Array.isArray(body?.exchanges) ? body.exchanges as ExchangeSummary[] : null;
      })
      .catch(() => null);
    try {
      const res = await fetch(`/api/conversations/${id}/messages`);
      data = await res.json();
      ok = res.ok && Array.isArray(data);
    } catch {
      ok = false;
    }
    const events = await eventsRead;
    const linkedExchanges = await exchangesRead;
    // A reply for a thread the owner already left must not paint this one.
    if (activeIdRef.current !== id) return;
    if (ok) setMessages(data as Message[]);
    if (events) setNotices(wakeNotices(events));
    if (linkedExchanges) setExchangeCards(linkedExchanges);
    setThreadLoad({ conversationId: id, status: ok ? 'ready' : 'error' });
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

  async function openBot(id: string) {
    const bot = bots.find(b => b.id === id);
    if (!bot) return;

    const convRes = await fetch(`/api/conversations?botId=${id}`);
    const conv = await convRes.json();

    setPictureOpen(false);
    setAvatarStep(false);
    if (conv.id !== activeConversation?.id) {
      setMessages([]);
      setNotices([]);
      setExchangeCards([]);
    }
    // Retarget the stale-read guard before the new thread commits, so a read
    // for the previous thread that resolves in between is dropped.
    activeIdRef.current = conv.id;
    setActiveConversation({
      id: conv.id,
      details: bot,
    });
  }

  const setAvatar = async () => {
    if (!activeConversation) return;
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
      details: { ...activeConversation.details, avatar: saved.avatar },
    });
  };

  const storeGallery = async (file: File | undefined) => {
    if (!file || !activeConversation) return;
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
      details: { ...activeConversation.details, avatar: saved.avatar },
    });
  };

  const removePhoto = async () => {
    if (!activeConversation) return;
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
      details: { ...activeConversation.details, avatar: saved.avatar || '' },
    });
  };

  // True zero-bot roster only once /api/bots has answered, so a populated
  // workspace never flashes the welcome state on cold load.
  const noBots = botsLoaded && bots.length === 0;
  const afterDelete = async (deleted: DeleteAgentRef[]) => {
    const ids = deleted.map(item => item.id);
    setManageOpen(false);
    setRosterStatus(deletedStatusLine(ids.length));
    requestAnimationFrame(() => manageRef.current?.focus());
    setBots(current => current.filter(bot => !ids.includes(bot.id)));
    if (activeConversation && ids.includes(activeConversation.details.id)) {
      setActiveConversation(null);
      setMessages([]);
      setNotices([]);
    }
    await loadBots();
  };

  const mentionItems = mentionOpen
    ? bots.filter(bot => bot.name.toLowerCase().includes(mentionQuery.toLowerCase()))
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

    const targets = [activeConversation.details.id];
    markWorking(targets);

    const mentioned = [...bots].sort((a, b) => b.name.length - a.name.length).find(bot => mentionAt(content, bot.name));
    const sent = await fetch(`/api/conversations/${activeConversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, mentionedBotId: mentioned?.id, idempotencyKey: crypto.randomUUID() }),
    });
    if (!sent.ok) {
      for (const id of targets) delete pendingAfter.current[id];
      setWorkingIds(current => current.filter(id => !targets.includes(id)));
    }

    setInputMessage('');
    setAttachments([]);
    setAttachError('');
    setMentionOpen(false);
    loadMessages();
  };

  const view = activeConversation ? threadView(threadLoad, activeConversation.id, messages.length) : 'loading';
  // The chief-of-staff computer covers the message column; its band is the
  // one see-through strip, so the thread note sits there instead.
  const threadNote = activeConversation ? <ThreadState view={view} agentName={activeConversation.details.name} /> : null;
  const title = (activeConversation?.details.title || '').trim();
  const nameColor = activeConversation?.details.color;

  // NOT-475: Wake safety notices interleave with messages by time.
  const shownNotices = new Set<string>();
  const wakeNoticeRow = (notice: WakeNoticeItem) => (
    <div key={notice.eventId} className="msg-status">
      <WakeNotice notice={notice} onDone={() => { void loadMessages(); }} />
    </div>
  );
  // NOT-498: linked exchanges sit where they started, among messages and
  // notices, one card per exchange id.
  const shownExchanges = new Set<string>();
  const exchangeRow = (summary: ExchangeSummary) => (
    <div key={`exchange-${summary.id}`} className="msg-status">
      <ExchangeCard summary={summary} onChanged={() => { void loadMessages(); }} />
    </div>
  );
  const exchangesBefore = (at: number) => {
    const due = exchangeCards
      .filter(summary => !shownExchanges.has(summary.id) && summary.created_at < at)
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    due.forEach(summary => shownExchanges.add(summary.id));
    return due.map(exchangeRow);
  };

  const closeBotModal = () => {
    setShowBotModal(false);
    requestAnimationFrame(() => newRef.current?.focus());
  };

  return (
    <>
    <div className="field" inert={showBotModal}>
      <AgentRail
        agents={bots}
        activeAgentId={activeConversation?.details.id}
        workingIds={workingIds}
        beatClock={beatClock}
        now={now}
        status={rosterStatus}
        logoDrop={logoDrop}
        onAgentsChange={next => setBots(next as Bot[])}
        onNew={() => setShowBotModal(true)}
        onManage={() => { setRosterStatus(''); setManageOpen(true); }}
        onDeleted={deleted => { void afterDelete(deleted); }}
        newButtonRef={newRef}
        manageButtonRef={manageRef}
      />

      <section className="pane">
        {activeConversation ? (
          <div className="thread">
            <div className="thread-bar">
              <div>
                <button type="button" className="thread-name" style={nameColor ? { color: nameColor } : undefined} onClick={() => {
                  setPictureOpen(true);
                  setAvatarStep(false);
                }}>
                  {activeConversation.details.name}
                </button>
                {title ? <div className="thread-role">{title}</div> : null}
                <div className="thread-role">{workWord(workingIds.includes(activeConversation.details.id))}</div>
                <div className="thread-role">{lifeWord((openThreadBot ?? activeConversation.details).last_seen, beatClock.serverNow, beatClock.fetchedAt, now)}</div>
                {pictureOpen ? (
                  <button type="button" className="avatar-pic" onClick={() => setAvatarStep(true)} aria-label="Picture">
                    {activeConversation.details.avatar ? (
                      <img src={activeConversation.details.avatar} alt="" />
                    ) : (
                      <BotAvatar bot={activeConversation.details} size={46} />
                    )}
                  </button>
                ) : null}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <Link
                  href={`/bots/${activeConversation.details.id}/config`}
                  className="attach-word"
                  style={{ textDecoration: 'none' }}
                >
                  Config
                </Link>
                <button
                  ref={sessionsRef}
                  type="button"
                  className="attach-word"
                  aria-haspopup="dialog"
                  aria-expanded={sessionsOpen}
                  onClick={() => setSessionsOpen(true)}
                >
                  Sessions
                </button>
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
            {avatarStep ? (
              <>
                <div className="avatar-step avatar-desk">
                  <span className="kind-word">Agent</span>
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
              {computerOpen ? null : threadNote}
              {messages.map((msg) => {
                // Notices recorded before this message sit above it.
                const before = notices.filter(notice => !shownNotices.has(notice.eventId) && notice.createdAt < msg.created_at);
                before.forEach(notice => shownNotices.add(notice.eventId));
                const cardsBefore = exchangesBefore(msg.created_at);
                const mine = msg.sender_type === 'user';
                const failure = mine ? null : classifyRuntimeFailure(stripStoredPrefix(msg.content));
                if (failure) {
                  return (
                    <Fragment key={msg.id}>
                      {before.map(wakeNoticeRow)}
                      {cardsBefore}
                      <div className="msg-status">
                        <RuntimeFailureNotice failure={failure} />
                      </div>
                    </Fragment>
                  );
                }
                const shown = messagePicture(stripStoredPrefix(msg.content));
                const picture = shown.images.map(src => (
                  <img key={src.slice(0, 48)} src={src} alt="" style={{ display: 'block', width: 64, height: 64 }} />
                ));
                const speaker = mine ? undefined : activeConversation.details.color;
                const run = mine ? null : parseRun(msg.content);
                const draft = !mine && !run ? parseDraft(stripStoredPrefix(msg.content)) : null;
                const approvalCode = !mine && !run ? parseApprovalCode(msg.content) : null;
                const fileNames = !mine && !run ? parseFileNames(msg.content) : [];
                const handoff = !mine && !run ? parseHandoff(shown.text) : null;
                const draftStatus = msg.draftStatus ?? (draft ? 'open' : null);
                const approvalStatus = msg.approvalStatus ?? (approvalCode ? 'pending' : null);
                return (
                  <Fragment key={msg.id}>
                  {before.map(wakeNoticeRow)}
                  {cardsBefore}
                  <div className={mine ? 'msg-you' : 'msg-bot'} ref={run && run.state === 'running' ? runningLineRef : undefined}>
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
                          <div key={item.id}>{(item.sender_name || 'Agent') + ': ' + displayBody(item.content)}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  </Fragment>
                );
              })}
              {notices.filter(notice => !shownNotices.has(notice.eventId)).map(wakeNoticeRow)}
              {exchangesBefore(Number.POSITIVE_INFINITY)}
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
                <div className={view === 'messages' ? 'computer-band' : 'computer-band computer-band-note'} ref={computerBandRef}>
                  {threadNote}
                </div>
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
                    <button key={item.id} type="button" onMouseDown={e => { e.preventDefault(); insertMention(item.name); }}>
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
        ) : noBots ? (
          <div className="welcome">
            <Image
              className="welcome-mark"
              src="/brand/botmancers-logo-outline-256.png"
              alt="Botmancers"
              width={144}
              height={144}
              priority
            />
            <p className="empty-line">Pick someone to talk to.</p>
          </div>
        ) : (
          <p className="empty-line">Pick someone to talk to.</p>
        )}
      </section>

      {sessionsOpen && activeConversation ? (
        <SessionsPanel
          key={activeConversation.details.id}
          agentId={activeConversation.details.id}
          agentName={activeConversation.details.name}
          agentProvider={activeConversation.details.agent ?? undefined}
          initialSessionRef={linkedSessionRef.current}
          agents={bots.map(bot => ({ id: bot.id, name: bot.name }))}
          origin={{ conversationId: activeConversation.id, label: `${activeConversation.details.name} thread` }}
          onExchangeStarted={() => { void loadMessages(); }}
          onClose={() => {
            setSessionsOpen(false);
            requestAnimationFrame(() => sessionsRef.current?.focus());
          }}
          onOpenThread={id => {
            setSessionsOpen(false);
            void openBot(id).then(() => requestAnimationFrame(() => sessionsRef.current?.focus()));
          }}
        />
      ) : null}
      {manageOpen ? (
        <ManageAgentsPanel
          onClose={() => {
            setManageOpen(false);
            requestAnimationFrame(() => manageRef.current?.focus());
          }}
          onDeleted={deleted => { void afterDelete(deleted); }}
        />
      ) : null}

    </div>

    {/* NOT-447: the dialog sits outside the inert page so only it stays
        reachable by keyboard and assistive technology. */}
    {showBotModal && (
      <BotModal
        anchorRef={newRef}
        onClose={closeBotModal}
        onCreated={() => {
          loadBots();
          closeBotModal();
        }}
      />
    )}
    </>
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


function BotModal({ anchorRef, onClose, onCreated }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [form, setForm] = useState<RegistrationFormInput>(DEFAULT_REGISTRATION_FORM);
  const [botError, setBotError] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdSync, setCreatedSync] = useState<{ line: string; agentName: string } | null>(null);
  const connections = useRuntimeConnections();
  const [placement, setPlacement] = useState<DialogPlacement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  // Anchor under New; re-place when the viewport changes.
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      setPlacement(newAgentDialogPlacement(
        rect ? { left: rect.left, bottom: rect.bottom } : null,
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (createdSync) doneRef.current?.focus();
  }, [createdSync]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const containTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
    const target = wrapFocusTarget(focusable, document.activeElement as HTMLElement | null, e.shiftKey);
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const view = registrationFormView(form, connections.state);

  const changeForm = (patch: Partial<RegistrationFormInput>) => {
    setBotError('');
    setForm(current => ({ ...current, ...patch }));
  };

  const handleBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (view.submitDisabled || submitting) return;
    if (hasRegistrationErrors(view)) {
      setShowErrors(true);
      setBotError('Fix the highlighted fields.');
      return;
    }
    setBotError('');
    setSubmitting(true);
    let res: Response;
    try {
      res = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registrationCreateBody(name, form)),
      });
    } finally {
      setSubmitting(false);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setBotError(typeof body?.error === 'string' && body.error ? body.error : 'Failed to create agent');
      return;
    }
    // NOT-547: one line with the registration sync result. An older
    // server without session_sync keeps the old immediate close.
    const sync = body?.session_sync as RegistrationSessionSync | undefined;
    if (!sync || typeof sync.outcome !== 'string') {
      onCreated();
      return;
    }
    const provider = typeof body?.agent === 'string' ? agentLabel(body.agent) : 'Sessions';
    setCreatedSync({ line: registrationSessionSyncCopy(sync, provider), agentName: typeof body?.name === 'string' ? body.name : name });
  };

  return (
    <div className="modal-scrim new-agent-scrim" onKeyDown={containTab}>
      <div
        ref={dialogRef}
        className="form-card new-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-agent-title"
        style={placement ?? undefined}
      >
        <div className="kind-row">
          <h2 id="new-agent-title" className="kind-word new-agent-title">New Agent</h2>
        </div>
        {createdSync ? (
          <div className="bot-form">
            <div className="new-agent-body">
              <p role="status">{createdSync.agentName} created. {createdSync.line}</p>
            </div>
            <div className="form-actions">
              <button ref={doneRef} type="button" className="create-btn" onClick={onCreated}>
                Done
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleBot} className="bot-form">
          <div className="new-agent-body">
          <label htmlFor="bot-name">Name</label>
          <input ref={nameRef} id="bot-name" type="text" value={name} onChange={e => setName(e.target.value)} required />
          <RegistrationFields
            idPrefix="bot"
            variant="modal"
            form={form}
            onChange={changeForm}
            view={view}
            showErrors={showErrors}
            connections={connections.state}
            onRetryConnections={connections.retry}
            onAddConnection={connections.add}
            workspacePlaceholder={WORKSPACE_TEMPLATE}
            workspaceHint={NEW_AGENT_WORKSPACE_HINT}
          />
          {botError ? <p className="form-error" role="alert">{botError}</p> : null}
          </div>
          <div className="form-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="create-btn" disabled={view.submitDisabled || submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
