'use client';

import { useId, useState } from 'react';
import { severityLabel, type RuntimeFailure } from '@/lib/runtime-failure';

// NOT-449: a known runtime/setup failure shown as application status, not
// as a bot utterance. No agent name or avatar; the exact stored message
// stays behind an explicit Details disclosure with a Copy control.
export default function RuntimeFailureNotice({ failure }: { failure: RuntimeFailure }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const label = severityLabel(failure.severity);
  const titleId = useId();

  async function copyDetail() {
    try {
      await navigator.clipboard.writeText(failure.detail);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div
      className={`runtime-failure runtime-failure-${failure.severity}`}
      role="status"
      aria-labelledby={titleId}
      data-runtime-failure={failure.kind}
    >
      <p className="runtime-failure-title" id={titleId}>
        <span className="runtime-failure-severity">{label}</span>
        {failure.title}
      </p>
      <p className="runtime-failure-recovery">{failure.recovery}</p>
      <details className="runtime-failure-details">
        <summary>Details</summary>
        <code className="runtime-failure-detail">{failure.detail}</code>
        <button type="button" className="runtime-failure-copy" onClick={() => { void copyDetail(); }}>
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy details'}
        </button>
      </details>
    </div>
  );
}
