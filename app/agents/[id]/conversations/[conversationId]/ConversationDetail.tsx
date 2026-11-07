'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import BotAvatar from '@/app/components/BotAvatar';
import ExchangeCard from '@/app/components/ExchangeCard';
import RuntimeFailureNotice from '@/app/components/RuntimeFailureNotice';
import WakeNotice from '@/app/components/WakeNotice';
import { useAgentOverview } from '../../AgentShell';
import { agentEventDisplay, isAgentEventLine } from '@/lib/bot-runtime-ui';
import { parseApprovalCode, parseDraft, draftTitle, parseFileNames } from '@/lib/draft';
import { classifyRuntimeFailure } from '@/lib/runtime-failure';
import { parseRun, runLine } from '@/lib/run';
import { wakeNotices, type WakeEventView } from '@/lib/wake-notice';
import type { ExchangeSummary } from '@/lib/exchange-view';
import { type OwnerConversationDetail, type OwnerConversationMessage } from '@/lib/owner-conversations';
import { ownerConversationEyebrow } from '@/lib/owner-conversation-labels';

const POLL_MS = 2000;

function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function senderMonogram(name: string): string {
  const cleaned = name.replace(/^Service\s+/i, '').trim();
  const parts = cleaned.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (cleaned.slice(0, 2) || '?').toUpperCase();
}

function MessageMeta({
  message,
  mine,
  systemLabel,
}: {
  message: OwnerConversationMessage;
  mine: boolean;
  /** Runtime/system traces: never attribute them as agent speech. */
  systemLabel?: string;
}) {
  const timeLabel = formatMessageTime(message.created_at);
  const timeTitle = new Date(message.created_at).toLocaleString();
  const name = systemLabel ?? message.sender_name;
  const avatar = systemLabel
    ? <span className="msg-monogram msg-monogram-system" aria-hidden="true">RT</span>
    : message.sender_kind === 'bot' && message.sender_avatar
      ? <BotAvatar bot={message.sender_avatar} size={28} title={`${message.sender_name} avatar`} className="msg-avatar bot-avatar" />
      : !mine
        ? <span className="msg-monogram" aria-hidden="true">{senderMonogram(message.sender_name)}</span>
        : null;
  return (
    <div className={mine ? 'msg-meta msg-meta-you' : 'msg-meta'}>
      {avatar}
      <div className="msg-meta-text">
        <span className={mine ? 'msg-name msg-name-you' : systemLabel ? 'msg-name msg-name-system' : 'msg-name'}>{name}</span>
        <time className="msg-time" dateTime={new Date(message.created_at).toISOString()} title={timeTitle}>{timeLabel}</time>
      </div>
    </div>
  );
}

function stripStoredPrefix(content: string) {
  let text = content;
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/^\s*\[(?:Message from|From) [^\]]+\]\s*(?:\r?\n)?/, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/^\s+/, '');
}

/** Split durable runtime traces from the speech the owner cares about. */
function splitThreadContent(text: string): { speech: string[]; events: string[] } {
  const speech: string[] = [];
  const events: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (isAgentEventLine(line)) events.push(line);
    else speech.push(line);
  }
  while (speech.length && speech[0].trim() === '') speech.shift();
  while (speech.length && speech[speech.length - 1].trim() === '') speech.pop();
  return { speech, events };
}

function renderSpeechLines(lines: string[], keyPrefix: string): ReactNode {
  if (!lines.length) return null;
  return lines.map((line, index) => (
    <Fragment key={`${keyPrefix}-speech-${index}`}>
      {index > 0 ? <br /> : null}
      <span>{line}</span>
    </Fragment>
  ));
}

function renderEventLines(lines: string[], keyPrefix: string): ReactNode {
  return lines.map((line, index) => {
    const event = agentEventDisplay(line);
    return (
      <Fragment key={`${keyPrefix}-event-${index}`}>
        {index > 0 ? <br /> : null}
        {event
          ? <span className="agent-event"><span className="agent-event-label">{event.label}</span>{event.detail ? ` ${event.detail}` : ''}</span>
          : <span>{line}</span>}
      </Fragment>
    );
  });
}

function FoldedRuntimeTrace({ lines, keyPrefix }: { lines: string[]; keyPrefix: string }) {
  if (!lines.length) return null;
  const first = agentEventDisplay(lines[0]);
  const summary = first ? first.label : 'Runtime detail';
  return (
    <details className="msg-trace">
      <summary>{summary}{lines.length > 1 ? ` · ${lines.length} lines` : ''}</summary>
      <div className="msg-trace-body">{renderEventLines(lines, keyPrefix)}</div>
    </details>
  );
}

function mergeMessages(current: OwnerConversationMessage[], incoming: OwnerConversationMessage[]): OwnerConversationMessage[] {
  const rows = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) rows.set(message.id, message);
  return [...rows.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

export default function ConversationDetail() {
  const route = useParams<{ id: string; conversationId: string }>();
  const search = useSearchParams();
  const id = String(route.id ?? '');
  const conversationId = String(route.conversationId ?? '');
  const { overview } = useAgentOverview();
  const [detail, setDetail] = useState<OwnerConversationDetail | null>(null);
  const [messages, setMessages] = useState<OwnerConversationMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [paging, setPaging] = useState(false);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const [attachError, setAttachError] = useState('');
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const initialScroll = useRef(false);
  const focusedExchange = useRef(false);

  const load = useCallback(async (cursor: string | null = null, older = false) => {
    if (!id || !conversationId) return;
    if (older) setPaging(true);
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (cursor) params.set('cursor', cursor);
      const [historyResponse, exchangeResponse] = await Promise.all([
        fetch(`/api/bots/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}?${params}`, { cache: 'no-store' }),
        fetch(`/api/exchanges?conversation=${encodeURIComponent(conversationId)}`, { cache: 'no-store' }),
      ]);
      if (historyResponse.status === 404) { setNotFound(true); setError(''); return; }
      const history = await historyResponse.json().catch(() => null) as OwnerConversationDetail | null;
      if (!historyResponse.ok || !history || !Array.isArray(history.messages)) throw new Error('history');
      const exchangeBody = await exchangeResponse.json().catch(() => null);
      setDetail(history);
      setMessages(current => older ? mergeMessages(history.messages, current) : mergeMessages(current, history.messages));
      // Refresh polls must not reset an already-paged older cursor.
      if (older || !initialScroll.current) setNextCursor(history.next_cursor);
      if (exchangeResponse.ok && Array.isArray(exchangeBody?.exchanges)) setExchanges(exchangeBody.exchanges as ExchangeSummary[]);
      setError('');
      setNotFound(false);
    } catch {
      setError('Could not load this conversation.');
    } finally {
      setPaging(false);
    }
  }, [conversationId, id]);

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load, reload]);

  useEffect(() => {
    if (!detail || initialScroll.current) return;
    initialScroll.current = true;
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
    if (detail.writable) composerRef.current?.focus({ preventScroll: true });
  }, [detail]);

  useEffect(() => {
    const exchange = search.get('exchange');
    if (!exchange || focusedExchange.current) return;
    const card = document.getElementById(`exchange-${exchange}`);
    if (!card) return;
    focusedExchange.current = true;
    card.scrollIntoView({ block: 'center' });
    card.focus({ preventScroll: true });
  }, [exchanges, search]);

  const addAttachments = (files: File[]) => {
    const room = 6 - attachments.length;
    setAttachError(files.length > room ? 'Up to six attachments.' : '');
    setAttachments(current => [...current, ...files.slice(0, Math.max(room, 0)).map((file, index) => ({ id: `${file.name}-${file.size}-${current.length + index}`, name: file.name }))]);
  };
  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    addAttachments(files);
  };
  const send = async () => {
    if (!detail?.writable || sending) return;
    const content = [input.trim(), ...attachments.map(item => item.name)].filter(Boolean).join('\n');
    if (!content) return;
    setSending(true);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, idempotencyKey: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error('send');
      setInput(''); setAttachments([]); setAttachError('');
      await load();
    } catch { setAttachError('Message could not be sent. Try again.'); }
    finally { setSending(false); }
  };
  const stop = async (messageId?: string) => {
    if (!detail?.writable) return;
    const suffix = messageId ? `/messages/${encodeURIComponent(messageId)}/stop` : '/stop';
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}${suffix}`, { method: 'POST' });
    await load();
  };

  if (notFound) return <div className="conversation-detail-state"><h2>Conversation not found</h2><p>This conversation does not involve the selected agent or no longer exists.</p><Link href={`/agents/${encodeURIComponent(id)}/conversations`}>All conversations</Link></div>;
  if (!detail && !error) return <p className="conversation-detail-state" role="status" data-conversation-detail-state="loading">Loading conversation…</p>;
  if (!detail && error) return <div className="conversation-detail-state" role="alert" data-conversation-detail-state="error"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry</button></div>;
  if (!detail) return null;

  const notices = wakeNotices(detail.events as WakeEventView[]).map(notice => ({ ...notice, actionable: notice.actionable && detail.writable }));
  const shownNotices = new Set<string>();
  const shownExchanges = new Set<string>();
  const noticesBefore = (at: number) => notices.filter(notice => !shownNotices.has(notice.eventId) && notice.createdAt < at).map(notice => { shownNotices.add(notice.eventId); return <li key={notice.eventId} className="msg-status"><WakeNotice notice={notice} onDone={() => void load()} /></li>; });
  const exchangesBefore = (at: number) => exchanges.filter(exchange => !shownExchanges.has(exchange.id) && exchange.created_at < at).sort((a, b) => a.created_at - b.created_at).map(exchange => { shownExchanges.add(exchange.id); return <li key={exchange.id} className="msg-status"><ExchangeCard summary={exchange} onChanged={() => void load()} /></li>; });

  return (
    <div className="conversation-detail" data-conversation-writable={detail.writable ? 'true' : 'false'}>
      <header className="conversation-detail-head">
        <div><Link href={`/agents/${encodeURIComponent(id)}/conversations`}>← Conversations</Link><p className="agent-eyebrow">{ownerConversationEyebrow(detail)}</p><h2>{detail.label}</h2><p className="conversation-participant-line">{detail.participants.map(value => value.label).join(' · ')}</p><p className="conversation-origin-line">Origin: {detail.origin?.label ?? 'Unknown'} · {detail.message_count} messages</p></div>
        {detail.writable ? <button type="button" className="conversation-stop" onClick={() => void stop()}>Stop delegated turns</button> : null}
      </header>
      {!detail.writable ? <aside className="conversation-read-only" role="note"><strong>Read-only history</strong><p>{detail.read_only_reason}</p>{overview?.conversation ? <Link href={`/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(overview.conversation.id)}`}>Open direct conversation</Link> : null}</aside> : null}
      {error ? <p className="conversation-refresh-error" role="alert">{error} Showing the last loaded history.</p> : null}
      <div className="conversation-history">
        {nextCursor ? <button className="conversation-older" type="button" disabled={paging} onClick={() => void load(nextCursor, true)}>{paging ? 'Loading…' : 'Load older messages'}</button> : null}
        <ol ref={listRef} className="conversation-message-list" aria-label="Conversation history">
          {messages.length === 0 ? <li className="conversation-empty-history">No messages in this conversation yet.</li> : null}
          {messages.map(message => {
            const mine = message.sender_name === 'You';
            const content = stripStoredPrefix(message.content);
            const failure = mine ? null : classifyRuntimeFailure(content);
            const run = mine ? null : parseRun(message.content);
            const draft = !mine && !run ? parseDraft(content) : null;
            const approval = !mine && !run ? parseApprovalCode(message.content) : null;
            const { speech, events } = splitThreadContent(content);
            const runtimeOnly = !mine && !failure && !run && !draft && events.length > 0 && speech.length === 0;
            const mixedRuntime = !mine && !failure && !run && !draft && events.length > 0 && speech.length > 0;
            const systemLabel = (runtimeOnly || mixedRuntime) ? 'Runtime' : undefined;
            return (
              <Fragment key={message.id}>
                {noticesBefore(message.created_at)}
                {exchangesBefore(message.created_at)}
                <li className={mine ? 'msg-you' : runtimeOnly ? 'msg-system' : 'msg-bot'}>
                  <MessageMeta message={message} mine={mine} systemLabel={systemLabel} />
                  {failure ? (
                    <div className="msg-status"><RuntimeFailureNotice failure={failure} /></div>
                  ) : run ? (
                    <div className="msg-body">
                      {runLine(run)}
                      {run.state === 'running' && detail.writable ? <> <button type="button" className="attach-word" onClick={() => void stop(message.id)}>Stop</button></> : null}
                    </div>
                  ) : draft && message.draftStatus ? (
                    <div className="msg-body">
                      <DraftCard message={message} conversationId={conversationId} status={message.draftStatus} writable={detail.writable} onDone={() => void load()} />
                    </div>
                  ) : (
                    <div className="msg-body">
                      {speech.length ? <div className="msg-speech">{renderSpeechLines(speech, message.id)}</div> : null}
                      <FoldedRuntimeTrace lines={events} keyPrefix={message.id} />
                      {approval && message.approvalStatus ? (
                        <ApprovalCard message={message} conversationId={conversationId} status={message.approvalStatus} writable={detail.writable} onDone={() => void load()} />
                      ) : null}
                      <FileLinks names={parseFileNames(message.content)} />
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
          {noticesBefore(Number.POSITIVE_INFINITY)}
          {exchangesBefore(Number.POSITIVE_INFINITY)}
        </ol>
      </div>
      {detail.writable ? <div className="composer conversation-composer" onPaste={paste}><div className="composer-box">{attachError ? <p className="attach-error" role="alert">{attachError}</p> : null}{attachments.length ? <div className="attach-names">{attachments.map(item => <span key={item.id}>{item.name}</span>)}</div> : null}<textarea ref={composerRef} rows={2} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={`Message ${overview?.agent.name ?? 'this agent'}`} aria-label="Message" /></div><input ref={attachRef} className="attach-input" type="file" multiple onChange={event => { addAttachments(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><button type="button" className="attach-word" onClick={() => attachRef.current?.click()}>Attach</button><button type="button" className="send-btn" disabled={sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</button></div> : null}
    </div>
  );
}

function DraftCard({ message, conversationId, status, writable, onDone }: { message: OwnerConversationMessage; conversationId: string; status: 'open' | 'sent' | 'discarded'; writable: boolean; onDone: () => void }) {
  const parsed = parseDraft(stripStoredPrefix(message.content));
  const [recipient, setRecipient] = useState(parsed?.recipient ?? '');
  const [body, setBody] = useState(parsed?.body ?? '');
  const [busy, setBusy] = useState(false);
  if (!parsed) return null;
  const locked = !writable || status !== 'open';
  const act = async (action: 'send' | 'discard') => {
    if (locked || busy) return;
    setBusy(true);
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: message.id, action, recipient, body }) });
    setBusy(false); onDone();
  };
  return <div className="draft-card"><div className="draft-title">{draftTitle(parsed.channel)}</div><input aria-label="Recipient" value={locked ? parsed.recipient : recipient} readOnly={locked} onChange={event => setRecipient(event.target.value)} /><textarea rows={3} aria-label="Draft body" value={locked ? parsed.body : body} readOnly={locked} onChange={event => setBody(event.target.value)} />{status !== 'open' || !writable ? <span className="draft-mark">{status === 'open' ? 'Read only' : status === 'sent' ? 'Sent' : 'Discarded'}</span> : <><button type="button" className="approve-control" disabled={busy || !recipient.trim()} onClick={() => void act('send')}>Send</button><button type="button" className="approve-control" disabled={busy} onClick={() => void act('discard')}>Discard</button></>}</div>;
}

function ApprovalCard({ message, conversationId, status, writable, onDone }: { message: OwnerConversationMessage; conversationId: string; status: 'pending' | 'approved' | 'denied'; writable: boolean; onDone: () => void }) {
  const code = parseApprovalCode(message.content);
  const [busy, setBusy] = useState(false);
  if (!code) return null;
  if (!writable || status !== 'pending') return <span className="draft-mark">{status === 'pending' ? 'Approval is read only' : status === 'approved' ? 'Approved' : 'Denied'}</span>;
  const act = async (decision: 'approve' | 'deny') => { if (busy) return; setBusy(true); await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/${decision}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, messageId: message.id }) }); setBusy(false); onDone(); };
  return <span className="draft-mark"><button type="button" className="approve-control" disabled={busy} onClick={() => void act('approve')}>Approve</button><button type="button" className="approve-control" disabled={busy} onClick={() => void act('deny')}>Deny</button></span>;
}

function FileLinks({ names }: { names: string[] }) {
  return names.length ? <>{names.map(name => <span key={name}><br /><a className="file-control" href={`/api/files/${encodeURIComponent(name)}`} download={name}>Download {name}</a></span>)}</> : null;
}
