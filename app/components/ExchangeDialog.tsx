'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { DIALOG_FOCUSABLE, wrapFocusTarget } from '@/lib/new-agent-dialog';
import { formatSessionDate, type SessionRow } from '@/lib/session-view';
import {
  INSTRUCTION_LIMIT,
  exchangeRequestBody,
  pinRequestBody,
  sessionDialogTitle,
  sessionDialogUsesPin,
  submitErrorMessage,
  validateDraft,
  validateResumeDraft,
  type DraftErrors,
  type SessionDialogMode,
} from '@/lib/exchange-view';

export interface ExchangeAgentOption {
  id: string;
  name: string;
}

// NOT-498: the session action dialog. The source is the
// session row the owner chose, shown by Agent, title, and activity; its
// Botmancers reference goes into the request and is never typed or shown.
// One network submission per Send: a pending request disables Send, and a
// retry after a recoverable error reuses the same idempotency key while
// the draft is unchanged (a replay, not a second exchange).
// NOT-507: titled Ask from this context / Resume work here / Hand off to….
// Resume work here (and Ask on a session only a SessionProvider reaches)
// pins exactly this session through the owner pin route; the turn never
// moves to another session. Resume needs the owner's explicit approval of
// edits, a checkbox that is never pre-ticked.
export default function ExchangeDialog({ mode, session, agents, origin, onClose, onStarted }: {
  mode: SessionDialogMode;
  session: SessionRow;
  agents: ExchangeAgentOption[];
  origin: { conversationId: string; label: string };
  onClose: () => void;
  onStarted: (exchangeId: string | null) => void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const destinationId = useId();
  const approvalId = useId();
  const [instruction, setInstruction] = useState('');
  const [destinationAgentId, setDestinationAgentId] = useState('');
  const [approveWrite, setApproveWrite] = useState(false);
  const [errors, setErrors] = useState<DraftErrors & { approval?: string }>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const keyRef = useRef<{ payload: string; key: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const destinationRef = useRef<HTMLSelectElement>(null);
  const approvalRef = useRef<HTMLInputElement>(null);
  const viaPin = sessionDialogUsesPin(mode, session.route);
  const destinations = agents.filter(agent => agent.id !== session.agent.id);

  useEffect(() => {
    (mode === 'continue' ? destinationRef.current : instructionRef.current)?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Closes only this dialog; the Sessions review page remains mounted.
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const containTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
    const target = wrapFocusTarget(focusable, document.activeElement as HTMLElement | null, e.shiftKey);
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const draft = { mode: mode === 'resume' ? 'ask' as const : mode, instruction, originConversationId: origin.conversationId, destinationAgentId };
    const found = mode === 'resume' ? validateResumeDraft(instruction, approveWrite) : validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      if (found.destination) destinationRef.current?.focus();
      else if (found.instruction) instructionRef.current?.focus();
      else approvalRef.current?.focus();
      return;
    }
    const pinAction = mode === 'resume' ? 'resume' : 'ask';
    const bodyFor = (key: string) => viaPin
      ? pinRequestBody(pinAction, instruction, origin.conversationId, approveWrite, key)
      : exchangeRequestBody(draft, { agentId: session.agent.id, sessionRef: session.ref }, key);
    const payload = JSON.stringify(bodyFor(''));
    if (!keyRef.current || keyRef.current.payload !== payload) keyRef.current = { payload, key: crypto.randomUUID() };
    submittingRef.current = true;
    setSubmitting(true);
    setServerError('');
    try {
      const url = viaPin
        ? `/api/bots/${encodeURIComponent(session.agent.id)}/sessions/${encodeURIComponent(session.ref)}/pins`
        : '/api/exchanges';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyFor(keyRef.current.key)),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = typeof body?.error?.code === 'string' ? body.error.code : null;
        // A conflicting key can only be retried under a new one.
        if (code === 'idempotency_conflict') keyRef.current = null;
        setServerError(submitErrorMessage(code, typeof body?.error?.message === 'string' ? body.error.message : null));
        return;
      }
      const exchangeId = viaPin ? body?.turn?.exchange_id : body?.exchange?.id;
      onStarted(typeof exchangeId === 'string' ? exchangeId : null);
    } catch {
      setServerError(submitErrorMessage(null, 'Botmancers could not be reached. Your draft is kept; try again.'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const destinationName = destinations.find(agent => agent.id === destinationAgentId)?.name;
  const isAsk = mode === 'ask';
  const isResume = mode === 'resume';

  return (
    <div className="modal-scrim exchange-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={containTab}>
      <div ref={dialogRef} className="form-card exchange-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-exchange-mode={mode}>
        <h2 id={titleId} className="delete-title">{sessionDialogTitle(mode)}</h2>
        <section className="exchange-source" aria-label="Source session">
          <p className="exchange-source-agent">{session.agent.name}</p>
          <p className="exchange-source-title">{session.title}</p>
          <p className="exchange-source-meta">
            Last activity {formatSessionDate(session.last_activity_at)}
            {session.origin.conversation ? ` · from ${session.origin.conversation.label}` : ''}
          </p>
        </section>
        <form onSubmit={submit} noValidate className="exchange-form">
          {isAsk || isResume ? null : (
            <>
              <label htmlFor={destinationId}>Hand off to</label>
              <select
                ref={destinationRef}
                id={destinationId}
                className="exchange-select"
                value={destinationAgentId}
                aria-invalid={errors.destination ? true : undefined}
                aria-describedby={errors.destination ? `${destinationId}-error` : undefined}
                disabled={submitting}
                onChange={e => { setDestinationAgentId(e.target.value); setErrors(current => ({ ...current, destination: undefined })); }}
              >
                <option value="">Choose an agent</option>
                {destinations.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
              {errors.destination ? <p id={`${destinationId}-error`} className="exchange-field-error">{errors.destination}</p> : null}
            </>
          )}
          <label htmlFor={fieldId}>{isAsk ? 'Question' : isResume ? 'Instruction' : 'Objective'}</label>
          <textarea
            ref={instructionRef}
            id={fieldId}
            rows={4}
            maxLength={INSTRUCTION_LIMIT}
            value={instruction}
            readOnly={submitting}
            aria-invalid={errors.instruction ? true : undefined}
            aria-describedby={`${fieldId}-hint${errors.instruction ? ` ${fieldId}-error` : ''}`}
            onChange={e => { setInstruction(e.target.value); setErrors(current => ({ ...current, instruction: undefined })); }}
          />
          {errors.instruction ? <p id={`${fieldId}-error`} className="exchange-field-error">{errors.instruction}</p> : null}
          <p id={`${fieldId}-hint`} className="exchange-hint">
            {isAsk
              ? `${session.agent.name} answers from this exact session, read-only. The answer arrives in ${origin.label}.`
              : isResume
                ? `${session.agent.name} resumes work in this exact session and may edit its workspace. The turn never moves to another session. Progress shows in ${origin.label}.`
                : `${destinationName ?? 'The agent you choose'} receives an extracted handoff (objective, decisions, constraints, references, open questions) and starts a new session of its own. ${session.agent.name}’s session is not shared and is not changed. Progress shows in ${origin.label}.`}
          </p>
          {isResume ? (
            <>
              <label className="exchange-approval" htmlFor={approvalId}>
                <input
                  ref={approvalRef}
                  id={approvalId}
                  type="checkbox"
                  checked={approveWrite}
                  disabled={submitting}
                  aria-invalid={errors.approval ? true : undefined}
                  aria-describedby={errors.approval ? `${approvalId}-error` : undefined}
                  onChange={e => { setApproveWrite(e.target.checked); setErrors(current => ({ ...current, approval: undefined })); }}
                />
                {' '}I approve edits by {session.agent.name} in this session
              </label>
              {errors.approval ? <p id={`${approvalId}-error`} className="exchange-field-error">{errors.approval}</p> : null}
            </>
          ) : null}
          {serverError ? <p className="exchange-server-error" role="alert">{serverError}</p> : null}
          <p className="exchange-sending" role="status">{submitting ? 'Sending…' : ''}</p>
          <div className="form-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="create-btn" disabled={submitting} aria-disabled={submitting}>
              {serverError ? 'Try again' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
