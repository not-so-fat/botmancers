'use client';

import { useState } from 'react';
import { AGENT_OPTIONS, type DeckListState } from '@/lib/bot-runtime-ui';
import { LAUNCH_PROFILE_LABELS, LOCAL_HOST, POLICY_MODE_LABELS, SCOPE_KIND_LABELS } from '@/lib/agent-registration';
import {
  CONNECTIONS_ERROR_COPY,
  CONNECTIONS_LOADING_COPY,
  HINTS,
  LABELS,
  connectionOptionLabel,
  type ConnectionListState,
  type ConnectionOption,
  type RegistrationField,
  type RegistrationFormInput,
  type RegistrationFormView,
  type SessionOption,
} from '@/lib/agent-registration-ui';
import { AgentDeckFields } from '@/app/components/AgentDeckRuntime';

type Variant = 'modal' | 'config';

const CLASSES: Record<Variant, {
  fieldset: string;
  legend: string;
  label: string;
  picks: string;
  pick: string;
  stack: string;
  control: string;
  input: string;
  hint: string;
  error: string;
  button: string;
  note: string;
}> = {
  modal: {
    fieldset: 'agent-fieldset reg-fieldset',
    legend: 'field-legend',
    label: '',
    picks: 'runtime-picks',
    pick: 'runtime-pick',
    stack: 'reg-stack',
    control: 'deck-control',
    input: '',
    hint: 'runtime-hint',
    error: 'form-error reg-error',
    button: 'runtime-retry',
    note: 'runtime-note',
  },
  config: {
    fieldset: 'agent-fieldset reg-fieldset',
    legend: 'block text-sm cfg-muted mt-3 mb-1 p-0',
    label: 'block text-sm cfg-muted mt-3 mb-1',
    picks: 'flex flex-wrap gap-x-4 gap-y-1 text-sm cfg-muted',
    pick: 'text-sm cfg-muted',
    stack: 'flex flex-col gap-1 text-sm cfg-muted',
    control: 'cfg-input text-sm',
    input: 'cfg-input text-sm',
    hint: 'mt-1 text-xs cfg-faint',
    error: 'mt-1 text-sm cfg-error',
    button: 'cfg-link text-sm',
    note: 'text-sm cfg-muted mt-1',
  },
};

function FieldError({ id, message, variant }: { id: string; message?: string; variant: Variant }) {
  if (!message) return null;
  return <p id={id} className={CLASSES[variant].error} role="alert">{message}</p>;
}

// Adds a runtime connection inline: provider, name, host. No credentials.
function AddConnection({ idPrefix, variant, onAdd }: {
  idPrefix: string;
  variant: Variant;
  onAdd: (input: { provider: string; label: string; host: string }) => Promise<ConnectionOption | string>;
}) {
  const css = CLASSES[variant];
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>(AGENT_OPTIONS[0].value);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await onAdd({ provider, label, host: host.trim() || LOCAL_HOST });
    setBusy(false);
    if (typeof result === 'string') {
      setError(result);
      return;
    }
    setOpen(false);
    setLabel('');
    setHost('');
  };
  if (!open) {
    return (
      <button type="button" className={css.button} aria-expanded="false" aria-controls={`${idPrefix}-add-connection`} onClick={() => setOpen(true)}>
        Add connection…
      </button>
    );
  }
  return (
    <div id={`${idPrefix}-add-connection`} className="reg-add-connection" role="group" aria-label="Add connection">
      <label className={css.label} htmlFor={`${idPrefix}-add-provider`}>Provider</label>
      <select id={`${idPrefix}-add-provider`} className={css.control} value={provider} onChange={e => setProvider(e.target.value)}>
        {AGENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <label className={css.label} htmlFor={`${idPrefix}-add-label`}>Connection name</label>
      <input
        id={`${idPrefix}-add-label`}
        type="text"
        className={css.input || undefined}
        value={label}
        placeholder="Codex on my laptop"
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <label className={css.label} htmlFor={`${idPrefix}-add-host`}>Host</label>
      <input
        id={`${idPrefix}-add-host`}
        type="text"
        className={css.input || undefined}
        value={host}
        placeholder={LOCAL_HOST}
        aria-describedby={`${idPrefix}-add-hint`}
        onChange={e => setHost(e.target.value)}
      />
      <p id={`${idPrefix}-add-hint`} className={css.hint}>{HINTS.addConnection}</p>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className="reg-actions">
        <button type="button" className={css.button} onClick={() => void submit()} disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className={css.button} aria-expanded="true" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// NOT-502: the registered-Agent fields, each its own concept: runtime
// connection, session scope, default workspace, launch profile (Agent
// Deck controls only for agent_deck), policy, and on Config the optional
// home session.
export function RegistrationFields({
  idPrefix,
  variant,
  form,
  onChange,
  view,
  showErrors,
  connections,
  onRetryConnections,
  onAddConnection,
  deckState,
  onRetryDecks,
  savedDeckId,
  workdirPlaceholder,
  workdirHint,
  sessions,
  includeHomeSession,
}: {
  idPrefix: string;
  variant: Variant;
  form: RegistrationFormInput;
  onChange: (patch: Partial<RegistrationFormInput>) => void;
  view: RegistrationFormView;
  showErrors: boolean;
  connections: ConnectionListState;
  onRetryConnections: () => void;
  onAddConnection: (input: { provider: string; label: string; host: string }) => Promise<ConnectionOption | string>;
  deckState: DeckListState;
  onRetryDecks: () => void;
  savedDeckId?: string | null;
  workdirPlaceholder: string;
  workdirHint: string;
  // The Agent's own sessions (Config). Undefined on New Agent: a new
  // Agent has none, so the sessions scope is not offered.
  sessions?: SessionOption[];
  includeHomeSession?: boolean;
}) {
  const css = CLASSES[variant];
  const err = (field: RegistrationField) => (showErrors ? view.errors[field] : undefined);
  const errId = (field: RegistrationField) => `${idPrefix}-${field}-error`;
  const describe = (field: RegistrationField, ...ids: string[]) =>
    [...ids, err(field) ? errId(field) : ''].filter(Boolean).join(' ') || undefined;
  const hasSessions = Boolean(sessions && sessions.length > 0);

  return (
    <div className="registration-fields" data-registration={variant}>
      <fieldset className={css.fieldset} data-field="connection" aria-describedby={describe('connection', `${idPrefix}-connection-hint`)}>
        <legend className={css.legend} id={`${idPrefix}-connection-legend`}>{LABELS.connection}</legend>
        {connections.status === 'loading' ? (
          <p className={css.note} role="status">{CONNECTIONS_LOADING_COPY}</p>
        ) : connections.status === 'error' ? (
          <p className={css.note} role="status">
            {CONNECTIONS_ERROR_COPY}{' '}
            <button type="button" className={css.button} onClick={onRetryConnections}>Retry</button>
          </p>
        ) : (
          <select
            id={`${idPrefix}-connection`}
            className={css.control}
            aria-labelledby={`${idPrefix}-connection-legend`}
            aria-required="true"
            aria-invalid={err('connection') ? true : undefined}
            value={form.connectionId}
            onChange={e => onChange({ connectionId: e.target.value })}
          >
            <option value="" disabled>Select a connection…</option>
            {connections.connections.map(connection => (
              <option key={connection.id} value={connection.id}>{connectionOptionLabel(connection)}</option>
            ))}
          </select>
        )}
        <p id={`${idPrefix}-connection-hint`} className={css.hint}>{HINTS.connection}</p>
        <FieldError id={errId('connection')} message={err('connection')} variant={variant} />
        {connections.status === 'ready' ? (
          <AddConnection idPrefix={idPrefix} variant={variant} onAdd={async input => {
            const result = await onAddConnection(input);
            if (typeof result !== 'string') onChange({ connectionId: result.id });
            return result;
          }} />
        ) : null}
      </fieldset>

      <fieldset className={css.fieldset} data-field="scope">
        <legend className={css.legend} id={`${idPrefix}-scope-legend`}>{LABELS.scope}</legend>
        <div className={css.stack} role="radiogroup" aria-labelledby={`${idPrefix}-scope-legend`} aria-required="true" aria-describedby={describe('scope')}>
          {(['workspaces', 'sessions', 'all_provider_sessions'] as const).map(kind => (
            <label key={kind} className={css.pick}>
              <input
                type="radio"
                name={`${idPrefix}-scope`}
                value={kind}
                checked={form.scopeKind === kind}
                disabled={kind === 'sessions' && !hasSessions}
                onChange={() => onChange({ scopeKind: kind })}
              />
              {' ' + SCOPE_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
        {!hasSessions ? <p className={css.hint}>{HINTS.noSessions}</p> : null}
        <FieldError id={errId('scope')} message={err('scope')} variant={variant} />
        {form.scopeKind === 'workspaces' ? (
          <>
            <label className={css.label} htmlFor={`${idPrefix}-workspaces`}>Workspaces</label>
            <textarea
              id={`${idPrefix}-workspaces`}
              className={css.input || undefined}
              rows={2}
              value={form.workspaces}
              placeholder="/Users/you/work/project"
              aria-required="true"
              aria-invalid={err('workspaces') ? true : undefined}
              aria-describedby={describe('workspaces', `${idPrefix}-workspaces-hint`)}
              onChange={e => onChange({ workspaces: e.target.value })}
            />
            <p id={`${idPrefix}-workspaces-hint`} className={css.hint}>{HINTS.workspaces}</p>
            <FieldError id={errId('workspaces')} message={err('workspaces')} variant={variant} />
          </>
        ) : null}
        {form.scopeKind === 'sessions' && sessions ? (
          <div className={css.stack} role="group" aria-label="Sessions in scope" aria-describedby={describe('sessions', `${idPrefix}-sessions-hint`)}>
            {sessions.map(session => (
              <label key={session.ref} className={css.pick}>
                <input
                  type="checkbox"
                  checked={form.sessions.includes(session.ref)}
                  onChange={e => onChange({
                    sessions: e.target.checked ? [...form.sessions, session.ref] : form.sessions.filter(ref => ref !== session.ref),
                  })}
                />
                {` ${session.title} (${session.status})`}
              </label>
            ))}
            <p id={`${idPrefix}-sessions-hint`} className={css.hint}>{HINTS.sessions}</p>
            <FieldError id={errId('sessions')} message={err('sessions')} variant={variant} />
          </div>
        ) : null}
        {form.scopeKind === 'all_provider_sessions' ? <p className={css.hint}>{HINTS.allSessions}</p> : null}
      </fieldset>

      <div data-field="default-workspace">
        <label className={css.label} htmlFor={`${idPrefix}-default-workspace`}>{LABELS.defaultWorkspace}</label>
        <input
          id={`${idPrefix}-default-workspace`}
          type="text"
          className={css.input || undefined}
          value={form.defaultWorkspace}
          aria-invalid={err('defaultWorkspace') ? true : undefined}
          aria-describedby={describe('defaultWorkspace', `${idPrefix}-default-workspace-hint`)}
          onChange={e => onChange({ defaultWorkspace: e.target.value })}
        />
        <p id={`${idPrefix}-default-workspace-hint`} className={css.hint}>{HINTS.defaultWorkspace}</p>
        <FieldError id={errId('defaultWorkspace')} message={err('defaultWorkspace')} variant={variant} />
      </div>

      <fieldset className={css.fieldset} data-field="launch-profile">
        <legend className={css.legend} id={`${idPrefix}-profile-legend`}>{LABELS.launchProfile}</legend>
        <div className={css.stack} role="radiogroup" aria-labelledby={`${idPrefix}-profile-legend`} aria-required="true" aria-describedby={describe('launchProfile')}>
          {(['direct', 'agent_deck'] as const).map(profile => (
            <label key={profile} className={css.pick}>
              <input
                type="radio"
                name={`${idPrefix}-profile`}
                value={profile}
                checked={form.launchProfile === profile}
                aria-describedby={`${idPrefix}-profile-${profile}-hint`}
                onChange={() => onChange({ launchProfile: profile })}
              />
              {' ' + LAUNCH_PROFILE_LABELS[profile]}
              <span id={`${idPrefix}-profile-${profile}-hint`} className={`reg-option-hint ${css.hint}`}>
                {profile === 'direct' ? HINTS.direct : HINTS.agentDeck}
              </span>
            </label>
          ))}
        </div>
        <FieldError id={errId('launchProfile')} message={err('launchProfile')} variant={variant} />
        {view.showsAgentDeck ? (
          <>
            <AgentDeckFields
              idPrefix={idPrefix}
              variant={variant}
              deckId={form.deckId}
              onDeckId={value => onChange({ deckId: value })}
              deckState={deckState}
              onRetry={onRetryDecks}
              savedDeckId={savedDeckId}
              workingDirectory={form.workingDirectory}
              onWorkingDirectory={value => onChange({ workingDirectory: value })}
              workdirPlaceholder={workdirPlaceholder}
              workdirHint={workdirHint}
            />
            <FieldError id={errId('deck')} message={err('deck')} variant={variant} />
          </>
        ) : null}
      </fieldset>

      <fieldset className={css.fieldset} data-field="policy">
        <legend className={css.legend} id={`${idPrefix}-policy-legend`}>{LABELS.policy}</legend>
        <div className={css.picks} role="radiogroup" aria-labelledby={`${idPrefix}-policy-legend`}>
          {(['read_only', 'workspace_write'] as const).map(mode => (
            <label key={mode} className={css.pick}>
              <input
                type="radio"
                name={`${idPrefix}-policy`}
                value={mode}
                checked={form.policyMode === mode}
                onChange={() => onChange(mode === 'read_only' ? { policyMode: mode, allowResumeWithEdits: false } : { policyMode: mode })}
              />
              {' ' + POLICY_MODE_LABELS[mode]}
            </label>
          ))}
        </div>
        <div className={css.stack}>
          <label className={css.pick}>
            <input type="checkbox" checked={form.allowNewSessions} onChange={e => onChange({ allowNewSessions: e.target.checked })} />
            {' Allow new sessions'}
          </label>
          <label className={css.pick}>
            <input
              type="checkbox"
              checked={form.allowResumeWithEdits}
              disabled={form.policyMode !== 'workspace_write'}
              aria-describedby={`${idPrefix}-resume-hint`}
              onChange={e => onChange({ allowResumeWithEdits: e.target.checked })}
            />
            {' Allow resume with edits'}
          </label>
          <p id={`${idPrefix}-resume-hint`} className={css.hint}>{HINTS.resumeEdits}</p>
        </div>
        <FieldError id={errId('policy')} message={err('policy')} variant={variant} />
      </fieldset>

      {includeHomeSession ? (
        <div data-field="home-session">
          <label className={css.label} htmlFor={`${idPrefix}-home-session`}>{LABELS.homeSession}</label>
          <select
            id={`${idPrefix}-home-session`}
            className={css.control}
            value={form.homeSessionId}
            aria-describedby={`${idPrefix}-home-session-hint`}
            onChange={e => onChange({ homeSessionId: e.target.value })}
          >
            <option value="">None</option>
            {(sessions ?? []).map(session => (
              <option key={session.ref} value={session.ref}>{`${session.title} (${session.status})`}</option>
            ))}
          </select>
          <p id={`${idPrefix}-home-session-hint`} className={css.hint}>{HINTS.homeSession}</p>
        </div>
      ) : null}
    </div>
  );
}
