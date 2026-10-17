'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ExchangeCard from '@/app/components/ExchangeCard';
import type { ExchangeSummary } from '@/lib/exchange-view';

const POLL_MS = 2000;

interface ThreadMessage {
  id: string;
  sender_type: 'user' | 'bot';
  sender_name?: string;
  content: string;
  created_at: number;
}

interface ThreadInfo {
  label: string;
  members: string[];
}

function displayBody(content: string) {
  return content.replace(/^\s*\[Message from [^\]]+\]\s*(?:\r?\n)?/, '').replace(/^\s+/, '');
}

// NOT-498: a linked thread with no owner Agent (a group room). Exchange
// backlinks and cards need every linked thread to be reachable, and the
// chat only opens Agent threads, so a group thread opens here: its
// messages, read-only, with the exchange cards linked to it (read from the
// exchange API, never parsed from prose) where they started.
export default function GroupThreadPage() {
  const params = useParams();
  const id = String(params.id ?? '');
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [cards, setCards] = useState<ExchangeSummary[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const focusExchange = useRef<string | null>(null);

  useEffect(() => {
    focusExchange.current = new URLSearchParams(window.location.search).get('exchange');
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [convRes, msgRes, exRes] = await Promise.all([
          fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: 'no-store' }),
          fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, { cache: 'no-store' }),
          fetch(`/api/exchanges?conversation=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (!convRes.ok) {
          setError(convRes.status === 404 ? 'This thread no longer exists.' : 'Could not load this thread.');
          return;
        }
        const conv = await convRes.json();
        const msgs = await msgRes.json().catch(() => null);
        const ex = await exRes.json().catch(() => null);
        if (cancelled) return;
        const details = conv?.details ?? null;
        const members = Array.isArray(details?.members) ? details.members.map((m: { name?: string }) => m?.name).filter(Boolean) : [];
        setInfo({ label: details?.name ? `Group ${details.name}` : 'Group thread', members });
        if (msgRes.ok && Array.isArray(msgs)) setMessages(msgs as ThreadMessage[]);
        if (exRes.ok && Array.isArray(ex?.exchanges)) setCards(ex.exchanges as ExchangeSummary[]);
        setError('');
      } catch {
        if (!cancelled) setError('Could not load this thread.');
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, tick]);

  useEffect(() => {
    const target = focusExchange.current;
    if (!target) return;
    const card = document.getElementById(`exchange-${target}`);
    if (!card) return;
    focusExchange.current = null;
    card.scrollIntoView({ block: 'center' });
    card.focus({ preventScroll: true });
  }, [cards]);

  const shown = new Set<string>();
  const cardRow = (summary: ExchangeSummary) => (
    <li key={`exchange-${summary.id}`} className="msg-status">
      <ExchangeCard summary={summary} onChanged={() => setTick(n => n + 1)} />
    </li>
  );
  const cardsBefore = (at: number) => {
    const due = cards
      .filter(summary => !shown.has(summary.id) && summary.created_at < at)
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    due.forEach(summary => shown.add(summary.id));
    return due.map(cardRow);
  };

  return (
    <div className="ledger-page group-thread-page">
      <header className="ledger-head">
        <nav className="group-thread-nav" aria-label="Thread navigation">
          <Link href="/" className="cfg-link ledger-back">← Back to chat</Link>
          <Link href="/exchanges" className="cfg-link ledger-back">Agent Exchanges</Link>
        </nav>
        <h1 className="ledger-title">{info?.label ?? 'Group thread'}</h1>
        {info && info.members.length > 0 ? <p className="ledger-sub">With {info.members.join(', ')}</p> : null}
      </header>
      <main className="group-thread-main" aria-label="Thread">
        {error ? (
          <div className="ledger-state" role="alert">
            <p className="delete-error">{error}</p>
            <button type="button" className="pin-word" onClick={() => setTick(n => n + 1)}>Retry</button>
          </div>
        ) : !info ? (
          <p className="ledger-state" role="status">Loading thread…</p>
        ) : (
          <ol className="group-thread-list" aria-label="Messages and exchanges">
            {messages.map(msg => (
              <Fragment key={msg.id}>
                {cardsBefore(msg.created_at)}
                <li className={msg.sender_type === 'user' ? 'msg-you' : 'msg-bot'}>
                  <div className={msg.sender_type === 'user' ? 'msg-name msg-name-you' : 'msg-name'}>
                    {msg.sender_type === 'user' ? 'You' : (msg.sender_name || 'Agent')}
                  </div>
                  <div className="msg-body group-thread-body">{displayBody(msg.content)}</div>
                </li>
              </Fragment>
            ))}
            {cardsBefore(Number.POSITIVE_INFINITY)}
            {messages.length === 0 && cards.length === 0 ? <li className="ledger-state">No messages in this thread yet.</li> : null}
          </ol>
        )}
      </main>
    </div>
  );
}
