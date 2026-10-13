'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDeckList,
  initialDeckListState,
  type DeckListState,
  type DeckOption,
  type FetchLike,
} from '@/lib/bot-runtime-ui';

const CACHE_KEY = 'botmancers.agentDeck.lastDecks';
const TIMEOUT_MS = 10000;

function isDeckOption(item: unknown): item is DeckOption {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
}

function readCache(): DeckOption[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isDeckOption) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(decks: DeckOption[] | null): void {
  if (!decks) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(decks));
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
  const cacheRef = useRef<DeckOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const previous = initialDeckListState(cacheRef.current ?? readCache());
    fetchDeckList(fetchWithTimeout, previous).then(next => {
      if (cancelled) return;
      cacheRef.current = next.cachedDecks;
      writeCache(next.cachedDecks);
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
