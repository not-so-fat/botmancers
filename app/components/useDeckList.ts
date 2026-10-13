'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDeckList,
  initialDeckListState,
  type DeckListState,
  type FetchLike,
} from '@/lib/bot-runtime-ui';

const CACHE_KEY = 'botmancers.agentDeck.lastDeckIds';
const TIMEOUT_MS = 10000;

function readCache(): string[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(ids: string[] | null): void {
  if (!ids) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable; the in-memory state still carries the list
  }
}

const fetchWithTimeout: FetchLike = (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { cache: 'no-store', signal: controller.signal, ...(init as RequestInit | undefined) })
    .finally(() => clearTimeout(timer));
};

// One deck-list state per surface, re-checked on mount and on retry().
export function useDeckList(): { state: DeckListState; retry: () => void } {
  const [state, setState] = useState<DeckListState>(() => initialDeckListState());
  const [token, setToken] = useState(0);
  const cacheRef = useRef<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const previous = initialDeckListState(cacheRef.current ?? readCache());
    fetchDeckList(fetchWithTimeout, previous).then(next => {
      if (cancelled) return;
      cacheRef.current = next.cachedIds;
      writeCache(next.cachedIds);
      setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const retry = useCallback(() => {
    setState(current => ({ ...current, status: 'loading', decks: [], error: '' }));
    setToken(value => value + 1);
  }, []);

  return { state, retry };
}
