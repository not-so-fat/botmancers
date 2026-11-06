'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAgentOverview } from '../AgentShell';
import { ownerConversationTypeLabel, type OwnerConversationSummary } from '@/lib/owner-conversations';

interface ConversationPage { conversations: OwnerConversationSummary[]; next_cursor: string | null }

export default function ConversationsPage() {
  const { id, overview, loading: agentLoading, error: agentError, notFound } = useAgentOverview();
  const [rows, setRows] = useState<OwnerConversationSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [error, setError] = useState('');
  const [paging, setPaging] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (!id) return;
    if (append) setPaging(true);
    try {
      const search = new URLSearchParams({ limit: '30' });
      if (activeQuery) search.set('q', activeQuery);
      if (cursor) search.set('cursor', cursor);
      const response = await fetch(`/api/bots/${encodeURIComponent(id)}/conversations?${search}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as ConversationPage | null;
      if (!response.ok || !body || !Array.isArray(body.conversations)) throw new Error('load');
      setRows(current => append && current ? [...current, ...body.conversations] : body.conversations);
      setNextCursor(body.next_cursor);
      setError('');
    } catch {
      setError('Could not load conversations.');
    } finally {
      setPaging(false);
    }
  }, [activeQuery, id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setRows(null); void load(null, false); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, reload]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setActiveQuery(query.trim());
  };

  if (agentLoading) return <div className="agent-state" role="status">Loading agent conversations…</div>;
  if (notFound) return <div className="agent-state"><h2>Agent not found</h2><Link href="/">Choose an agent</Link></div>;
  if (agentError || !overview) return <div className="agent-state" role="alert">This agent’s conversations are unavailable.</div>;

  return (
    <div className="conversation-index" data-agent-conversations>
      <header className="conversation-index-head">
        <div><p className="agent-eyebrow">Conversations</p><h2>Durable history</h2><p>Direct messages, agent handoffs, and connected-service conversations involving {overview.agent.name}.</p></div>
        {overview.conversation ? <Link className="agent-primary-action" href={`/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(overview.conversation.id)}`}>Message {overview.agent.name}</Link> : null}
      </header>
      <form className="conversation-search" role="search" onSubmit={search}>
        <label htmlFor="conversation-query">Search conversations</label>
        <div><input id="conversation-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Participant, origin, or type" /><button type="submit">Search</button></div>
      </form>

      {rows === null && !error ? <p className="conversation-state" role="status" data-conversation-state="loading">Loading conversations…</p> : null}
      {error ? <div className="conversation-state" role="alert" data-conversation-state="error"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry</button></div> : null}
      {rows?.length === 0 && !error ? <p className="conversation-state" data-conversation-state="empty">{activeQuery ? 'No conversations match this search.' : 'No conversations involve this agent yet.'}</p> : null}
      {rows && rows.length > 0 ? (
        <ol className="conversation-list" aria-label="Conversations, newest activity first">
          {rows.map(row => (
            <li key={row.conversation_id}>
              <Link href={`/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(row.conversation_id)}`}>
                <span className="conversation-row-title"><strong>{row.label}</strong><span>{ownerConversationTypeLabel(row)}</span></span>
                <span className="conversation-row-participants">{row.participants.map(value => value.label).join(' · ')}</span>
                <span className="conversation-row-meta"><span>Origin: {row.origin?.label ?? 'Unknown'}</span><span>{row.message_count} {row.message_count === 1 ? 'message' : 'messages'}</span><time dateTime={new Date(row.last_activity_at).toISOString()}>{new Date(row.last_activity_at).toLocaleString()}</time></span>
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
      {nextCursor && rows && !error ? <button className="conversation-more" type="button" disabled={paging} onClick={() => void load(nextCursor, true)}>{paging ? 'Loading…' : 'Load older conversations'}</button> : null}
    </div>
  );
}
