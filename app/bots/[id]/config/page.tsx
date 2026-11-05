'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';

/** Legacy Config URL — keep deep links working, land inside the Agent shell. */
export default function LegacyBotConfigRedirect() {
  const params = useParams<{ id: string }>();
  const id = String(params.id ?? '');

  useEffect(() => {
    if (!id) return;
    const next = `/agents/${encodeURIComponent(id)}/config${window.location.search}${window.location.hash}`;
    window.location.replace(next);
  }, [id]);

  return (
    <div className="cfg-page flex items-center justify-center">
      <p className="text-sm cfg-faint">Opening Config…</p>
    </div>
  );
}
