// NOT-454: what an agent thread shows before, instead of, or alongside its
// messages. Loading and failed loads are their own states; "empty" is only
// a successful read of this conversation that returned zero messages.

export type ThreadLoadStatus = 'loading' | 'ready' | 'error';

export interface ThreadLoad {
  conversationId: string;
  status: ThreadLoadStatus;
}

export type ThreadView = 'loading' | 'error' | 'empty' | 'messages';

export const THREAD_LOADING_COPY = 'Loading messages…';
export const THREAD_ERROR_COPY = 'Couldn’t load messages. Trying again…';

export function emptyThreadCopy(agentName: string) {
  return {
    title: `No messages with ${agentName} yet.`,
    hint: 'Say something below to start the conversation.',
  };
}

export function threadView(load: ThreadLoad | null, conversationId: string, messageCount: number): ThreadView {
  if (messageCount > 0) return 'messages';
  if (!load || load.conversationId !== conversationId || load.status === 'loading') return 'loading';
  if (load.status === 'error') return 'error';
  return 'empty';
}
