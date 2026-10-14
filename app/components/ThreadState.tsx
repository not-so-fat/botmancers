import { THREAD_ERROR_COPY, THREAD_LOADING_COPY, emptyThreadCopy, type ThreadView } from '@/lib/thread-state';

// NOT-454: the note an agent thread shows while it has no messages to render.
export default function ThreadState({ view, agentName }: { view: ThreadView; agentName: string }) {
  if (view === 'loading') {
    return <p className="thread-note" role="status">{THREAD_LOADING_COPY}</p>;
  }
  if (view === 'error') {
    return <p className="thread-note thread-note-error" role="alert">{THREAD_ERROR_COPY}</p>;
  }
  if (view === 'empty') {
    const copy = emptyThreadCopy(agentName);
    return (
      <div className="thread-empty" data-thread-empty="">
        <p className="thread-empty-title">{copy.title}</p>
        <p className="thread-empty-hint">{copy.hint}</p>
      </div>
    );
  }
  return null;
}
