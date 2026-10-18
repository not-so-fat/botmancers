'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CONNECTIONS_ENDPOINT,
  initialConnectionListState,
  parseConnectionList,
  type ConnectionListState,
  type ConnectionOption,
} from '@/lib/agent-registration-ui';

// NOT-502: the runtime connection list for New Agent and Config, plus
// adding one (name + host only; no credentials).
export function useRuntimeConnections(): {
  state: ConnectionListState;
  retry: () => void;
  add: (input: { provider: string; label: string; host: string }) => Promise<ConnectionOption | string>;
} {
  const [state, setState] = useState<ConnectionListState>(() => initialConnectionListState());
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(CONNECTIONS_ENDPOINT, { cache: 'no-store' })
      .then(async res => {
        const parsed = res.ok ? parseConnectionList(await res.json().catch(() => null)) : null;
        if (cancelled) return;
        setState(parsed
          ? { status: 'ready', connections: parsed, error: '' }
          : { status: 'error', connections: [], error: `HTTP ${res.status}` });
      })
      .catch(error => {
        if (!cancelled) setState({ status: 'error', connections: [], error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const retry = useCallback(() => {
    setState(initialConnectionListState());
    setToken(value => value + 1);
  }, []);

  const add = useCallback(async (input: { provider: string; label: string; host: string }) => {
    const res = await fetch(CONNECTIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return typeof body?.error === 'string' ? body.error : 'Failed to add the connection';
    const created = parseConnectionList({ connections: [body] })?.[0];
    if (!created) return 'Failed to add the connection';
    setState(current => ({ status: 'ready', connections: [...current.connections, created], error: '' }));
    return created;
  }, []);

  return { state, retry, add };
}
