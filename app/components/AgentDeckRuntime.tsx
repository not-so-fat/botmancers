import {
  AGENT_OPTIONS,
  DECK_PLACEHOLDER,
  NON_LOCAL_NOTE,
  SAVED_DECK_MISSING_NOTE,
  SETTINGS_LINK_COPY,
  SETTINGS_NON_LOCAL_NOTE,
  SETTINGS_PATH,
  deckSlotCopy,
  deckStateShowsRetry,
  rosterRuntimeParts,
  settingsStatusLine,
  type BotRuntimeLike,
  type DeckListState,
  type RuntimeFormInput,
} from '@/lib/bot-runtime-ui';

type Variant = 'modal' | 'config';

const CLASSES: Record<Variant, {
  label: string;
  legend: string;
  picks: string;
  pick: string;
  note: string;
  control: string;
  hint: string;
  link: string;
  retry: string;
}> = {
  modal: {
    label: '',
    legend: 'field-legend',
    picks: 'runtime-picks',
    pick: 'runtime-pick',
    note: 'runtime-note',
    control: 'deck-control',
    hint: 'runtime-hint',
    link: 'runtime-link',
    retry: 'runtime-retry',
  },
  config: {
    label: 'block text-sm cfg-muted mt-3 mb-1',
    legend: 'block text-sm cfg-muted mt-3 mb-1 p-0',
    picks: 'flex flex-wrap gap-x-4 gap-y-1 text-sm cfg-muted',
    pick: 'text-sm cfg-muted',
    note: 'text-sm cfg-muted mt-1',
    control: 'cfg-input text-sm',
    hint: 'mt-1 text-xs cfg-faint',
    link: 'cfg-link text-sm',
    retry: 'cfg-link text-sm',
  },
};

// NOT-456/NOT-457: the one Agent choice (Hermes, Cursor, Claude, Codex,
// Muse Code). A fieldset + legend names the radio group; Agent Deck is a
// separate field that follows it and is never an option here.
export function AgentPicker({ value, onChange, name, variant, legendId }: {
  value: string;
  onChange: (value: RuntimeFormInput['agent']) => void;
  name: string;
  variant: Variant;
  legendId: string;
}) {
  const css = CLASSES[variant];
  return (
    <fieldset className="agent-fieldset" data-field="agent">
      <legend id={legendId} className={css.legend}>Agent</legend>
      <div className={css.picks} role="radiogroup" aria-labelledby={legendId} aria-required="true">
        {AGENT_OPTIONS.map(option => (
          <label key={option.value} className={css.pick}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {' ' + option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DeckSlot({ id, labelId, state, value, onChange, onRetry, savedDeckId, variant }: {
  id: string;
  labelId: string;
  state: DeckListState;
  value: string;
  onChange: (deckId: string) => void;
  onRetry: () => void;
  savedDeckId?: string | null;
  variant: Variant;
}) {
  const css = CLASSES[variant];
  const blocking = deckSlotCopy(state);
  const saved = (savedDeckId ?? '').trim();
  if (blocking === null) {
    const savedMissing = Boolean(saved) && !state.decks.some(deck => deck.id === saved);
    return (
      <div data-field="deck" data-state={state.status}>
        <select
          id={id}
          className={css.control}
          required
          aria-required="true"
          aria-describedby={savedMissing && value === saved ? `${id}-saved-note` : undefined}
          value={value}
          title={value || undefined}
          onChange={e => onChange(e.target.value)}
        >
          <option value="" disabled>{DECK_PLACEHOLDER}</option>
          {savedMissing ? <option value={saved} title={saved}>{saved} (saved)</option> : null}
          {state.decks.map(deck => (
            <option key={deck.id} value={deck.id} title={deck.id}>{deck.name}</option>
          ))}
        </select>
        {savedMissing && value === saved ? <p id={`${id}-saved-note`} className={css.note}>{SAVED_DECK_MISSING_NOTE}</p> : null}
      </div>
    );
  }
  return (
    <div data-field="deck" data-state={state.status}>
      {saved ? <p className={css.note}>Saved Agent Deck: <span title={saved}>{saved}</span></p> : null}
      <p id={id} className={`${css.note} deck-slot`} role="status" aria-labelledby={`${labelId} ${id}-copy`}>
        <span id={`${id}-copy`}>{blocking}</span>
        {deckStateShowsRetry(state) ? (
          <>
            {' '}
            <button type="button" className={css.retry} onClick={onRetry}>Retry</button>
          </>
        ) : null}
      </p>
    </div>
  );
}

export function AgentDeckFields({
  idPrefix,
  variant,
  deckId,
  onDeckId,
  deckState,
  onRetry,
  savedDeckId,
  workingDirectory,
  onWorkingDirectory,
  workdirPlaceholder,
  workdirHint,
}: {
  idPrefix: string;
  variant: Variant;
  deckId: string;
  onDeckId: (value: string) => void;
  deckState: DeckListState;
  onRetry: () => void;
  savedDeckId?: string | null;
  workingDirectory: string;
  onWorkingDirectory: (value: string) => void;
  workdirPlaceholder: string;
  workdirHint: string;
}) {
  const css = CLASSES[variant];
  return (
    <div className="agent-deck-fields">
      <label className={css.label} id={`${idPrefix}-deck-label`} htmlFor={`${idPrefix}-deck`}>Agent Deck</label>
      <DeckSlot
        id={`${idPrefix}-deck`}
        labelId={`${idPrefix}-deck-label`}
        state={deckState}
        value={deckId}
        onChange={onDeckId}
        onRetry={onRetry}
        savedDeckId={savedDeckId}
        variant={variant}
      />
      <a href={SETTINGS_PATH} className={css.link}>{SETTINGS_LINK_COPY}</a>
      <label className={css.label} htmlFor={`${idPrefix}-workdir`}>Working directory (optional)</label>
      <input
        id={`${idPrefix}-workdir`}
        type="text"
        className={variant === 'config' ? css.control : undefined}
        data-field="workdir"
        aria-describedby={`${idPrefix}-workdir-hint ${idPrefix}-workdir-note`}
        value={workingDirectory}
        placeholder={workdirPlaceholder}
        onChange={e => onWorkingDirectory(e.target.value)}
      />
      <p id={`${idPrefix}-workdir-hint`} className={css.hint}>{workdirHint}</p>
      <p id={`${idPrefix}-workdir-note`} className={css.hint}>{NON_LOCAL_NOTE}</p>
    </div>
  );
}

// New Agent / per-agent Config fields, in order: Agent, then the Agent
// Deck every agent needs, then the optional working directory.
export function AgentSection({
  idPrefix,
  variant,
  form,
  onChange,
  deckState,
  onRetry,
  savedDeckId,
  workdirPlaceholder,
  workdirHint,
}: {
  idPrefix: string;
  variant: Variant;
  form: RuntimeFormInput;
  onChange: (patch: Partial<RuntimeFormInput>) => void;
  deckState: DeckListState;
  onRetry: () => void;
  savedDeckId?: string | null;
  workdirPlaceholder: string;
  workdirHint: string;
}) {
  return (
    <>
      <AgentPicker
        value={form.agent}
        onChange={value => onChange({ agent: value })}
        name={`${idPrefix}-agent`}
        variant={variant}
        legendId={`${idPrefix}-agent-label`}
      />
      <AgentDeckFields
        idPrefix={idPrefix}
        variant={variant}
        deckId={form.deckId}
        onDeckId={value => onChange({ deckId: value })}
        deckState={deckState}
        onRetry={onRetry}
        savedDeckId={savedDeckId}
        workingDirectory={form.workingDirectory}
        onWorkingDirectory={value => onChange({ workingDirectory: value })}
        workdirPlaceholder={workdirPlaceholder}
        workdirHint={workdirHint}
      />
    </>
  );
}

export function RosterRuntimeLine({ bot, state }: { bot: BotRuntimeLike; state: DeckListState }) {
  const { prefix, deck, suffix } = rosterRuntimeParts(bot, state);
  return (
    <div className="bot-runtime" title={prefix + deck + suffix}>
      {prefix}
      {deck ? <span className="bot-runtime-deck">{deck}</span> : null}
      {suffix}
    </div>
  );
}

export function SettingsStatus({ state, onRetry }: { state: DeckListState; onRetry: () => void }) {
  return (
    <div data-field="status" data-state={state.status}>
      <p className={state.status === 'connected' ? 'text-sm cfg-ok' : 'text-sm cfg-muted'} role="status">
        {settingsStatusLine(state)}
      </p>
      {deckStateShowsRetry(state) ? (
        <button type="button" onClick={onRetry} className="mt-2 cfg-btn-ghost text-sm w-full sm:w-auto">
          Retry
        </button>
      ) : null}
      {state.status === 'connected' ? (
        <p className="mt-1 text-xs cfg-faint break-words">
          {state.decks.map(deck => deck.name).join(' · ')}
        </p>
      ) : null}
      <p className="mt-2 text-xs cfg-faint">{SETTINGS_NON_LOCAL_NOTE}</p>
    </div>
  );
}
