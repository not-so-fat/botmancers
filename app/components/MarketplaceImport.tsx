'use client';

import { useEffect, useState } from 'react';
import {
  HANDOFF_STATUS_PATH,
  IMPORT_RETURN_QUERY,
  handoffStartPath,
  importedBotId,
  marketImportView,
  resolveImportReturn,
  type MarketImportPhase,
} from '@/lib/market-handoff';

/** Template source action: the button plus one polite live region for every state. */
export function MarketplaceImportControl({
  phase,
  onImport,
}: {
  phase: MarketImportPhase;
  onImport: () => void;
}) {
  const view = marketImportView(phase);
  return (
    <div className="mt-3" data-field="marketplace-import">
      <button
        type="button"
        onClick={onImport}
        disabled={view.busy}
        aria-busy={view.busy}
        aria-describedby="cfg-market-import-status"
        className="cfg-btn-ghost text-sm w-full sm:w-auto"
      >
        Import from Grok Marketplace
      </button>
      <p
        id="cfg-market-import-status"
        role="status"
        aria-live="polite"
        className={view.tone === 'error' ? 'mt-2 text-sm cfg-error' : 'mt-2 text-xs cfg-faint'}
      >
        {view.message}
      </p>
    </div>
  );
}

/**
 * Starts the server-owned handoff from this Config page and, on return
 * (`?imported=<id>`), opens the imported bot's own Config page. The bot
 * whose page launched the handoff is never written to.
 */
export function useMarketplaceImport(currentId: string) {
  const [phase, setPhase] = useState<MarketImportPhase>('idle');

  useEffect(() => {
    const search = window.location.search;
    if (importedBotId(search) === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(IMPORT_RETURN_QUERY);
    window.history.replaceState(null, '', url.pathname + url.search);
    let cancelled = false;
    void resolveImportReturn(search, currentId, async botId => {
      const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/config`, { cache: 'no-store' });
      return res.ok;
    }).then(result => {
      if (cancelled) return;
      if (result.kind === 'open') window.location.replace(result.path);
      else if (result.kind === 'missing') setPhase('missing');
    });
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  async function startImport(): Promise<void> {
    setPhase('checking');
    try {
      const res = await fetch(HANDOFF_STATUS_PATH, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase('failed');
        return;
      }
      if (data?.configured !== true) {
        setPhase('unavailable');
        return;
      }
      setPhase('redirecting');
      window.location.href = handoffStartPath(window.location.origin, window.location.pathname);
      // Re-enable the button if the unsaved-changes prompt kept us here.
      setTimeout(() => setPhase(current => (current === 'redirecting' ? 'idle' : current)), 4000);
    } catch {
      setPhase('failed');
    }
  }

  return { phase, startImport };
}
