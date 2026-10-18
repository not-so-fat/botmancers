// NOT-445/NOT-456: agent + Agent Deck UI helpers (pure, no I/O except
// the injected deck-list fetcher).
//
// Single source for the Atelier-approved copy (docs/design/
// bot-single-runtime-settings.md) used by the New Agent modal, the
// workspace settings page, the roster, the per-agent Config Agent card,
// and the same-thread Agent Deck trace. React components render these
// values; the plain-node regression test (`test-bot-runtime-ui.js`)
// asserts them without a browser.
//
// Every bot shows exactly one summary: `Agent: <agent> · Agent Deck:
// <deck>` (NOT-456). Agent Deck is the selected deck, never a runtime or
// an agent option. The Agent Deck server URL is
// a workspace setting; no per-bot URL exists. Deck options come only
// from the Botmancers proxy (`GET /api/agent-deck/decks`), which issues
// the verified `GET <server>/api/launch/decks` server-side.
import { AGENTS, AGENT_LABELS, DEFAULT_AGENT, agentLabel, type BotAgent } from './bot-definition';

// Ordered agent choices: Hermes, Cursor, Claude, Codex, Muse Code.
export const AGENT_OPTIONS: readonly { value: BotAgent; label: string }[] = AGENTS.map(agent => ({
  value: agent,
  label: AGENT_LABELS[agent],
}));

export const DECKS_ENDPOINT = '/api/agent-deck/decks';
export const SETTINGS_ENDPOINT = '/api/agent-deck/settings';
export const SETTINGS_PATH = '/settings';

export interface BotRuntimeLike {
  id?: string | null;
  agent?: string | null;
  deck_id?: string | null;
  // Unresolved legacy free-text deck reference (migrated rows only).
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_selection?: boolean | number | null;
  launchable?: boolean | null;
  // NOT-502: direct | agent_deck | null (unresolved). Only agent_deck
  // (and unresolved legacy rows) show an Agent Deck.
  launch_profile?: string | null;
}

export interface DeckOption {
  id: string;
  name: string;
}

export type DeckListStatus = 'loading' | 'connected' | 'empty' | 'malformed' | 'unreachable' | 'unconfigured';

export interface DeckListState {
  status: DeckListStatus;
  decks: DeckOption[];
  // Last successful list, used for availability and deck names during
  // an outage. Null when no list has ever loaded.
  cachedDecks: DeckOption[] | null;
  serverUrl: string;
  checkedAt: number;
  error: string;
}

export const ROSTER_UNAVAILABLE_SUFFIX = ' (deck unavailable — see Config)';
export const CONFIG_UNAVAILABLE_SUFFIX = ' (deck unavailable)';

export const DECK_PLACEHOLDER = 'Select an Agent Deck…';
export const SELECT_DECK_ERROR = 'Select an Agent Deck for this agent.';

export const WORKDIR_TEMPLATE = '~/.botmancers/{agentID}';
export const NEW_BOT_WORKDIR_HINT = `Default: ${WORKDIR_TEMPLATE} — {agentID} is this agent's ID, assigned at creation.`;

export const NON_LOCAL_NOTE =
  'Runs use the configured Agent Deck server. Remote execution is unconfirmed — see Settings for the configured server.';
export const SETTINGS_NON_LOCAL_NOTE = 'Runs use the server above. Remote execution is unconfirmed.';
export const REMOTE_SERVER_LIMITATION =
  "The workspace Agent Deck server isn't local. Remote runs are unconfirmed, so this agent's runs stop with an error until Settings points at a local server.";

export const SETTINGS_LINK_COPY = 'Configure the Agent Deck server in Settings';

export const UNAVAILABLE_DECK_NOTICE =
  "This deck isn't on the configured server right now. Pick another deck, or fix the server in Settings.";
export const UNCHECKED_DECK_NOTICE =
  "Can't reach the Agent Deck server, so this deck couldn't be checked — fix it in Settings, then retry.";
export const UNCONFIGURED_DECK_NOTICE = 'No Agent Deck server set — add it in Settings.';
export const SAVED_DECK_MISSING_NOTE = 'Saved Agent Deck not on this server — saving keeps it unless you pick another.';

// §5.2 exact copy, one entry per state.
export const DECK_SLOT_COPY: Record<Exclude<DeckListStatus, 'connected'>, string> = {
  loading: 'Loading decks…',
  empty: 'No decks on this server — add one there, then retry.',
  malformed: 'The deck list came back unreadable. Retry — or fix the server, then retry.',
  unreachable: "Can't reach the Agent Deck server — fix it in Settings, then retry.",
  unconfigured: 'No Agent Deck server set — add it in Settings.',
};

export function initialDeckListState(cachedDecks: DeckOption[] | null = null): DeckListState {
  return { status: 'loading', decks: [], cachedDecks, serverUrl: '', checkedAt: 0, error: '' };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function settingsStatusLine(state: DeckListState): string {
  switch (state.status) {
    case 'loading':
      return 'Status: ○ Checking the Agent Deck server…';
    case 'connected':
      return `Status: ● Connected · ${state.decks.length} ${state.decks.length === 1 ? 'deck' : 'decks'} · checked ${formatClock(state.checkedAt)}`;
    case 'empty':
      return 'Status: ○ Connected — no decks on this server.';
    case 'malformed':
      return "Status: ○ The server returned decks this app can't read.";
    case 'unreachable':
      return "Status: ○ Can't reach the Agent Deck server.";
    case 'unconfigured':
      return 'Status: ○ No Agent Deck server set.';
  }
}

export function deckSlotCopy(state: DeckListState): string | null {
  if (state.status === 'connected') return null;
  return DECK_SLOT_COPY[state.status];
}

// Retry is offered in every non-connected state except loading (auto)
// and unconfigured (nothing to re-fetch; links to Settings instead).
export function deckStateShowsRetry(state: DeckListState): boolean {
  return state.status === 'empty' || state.status === 'malformed' || state.status === 'unreachable';
}

function parseDeckOptions(body: unknown): DeckOption[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const decks = (body as Record<string, unknown>).decks;
  if (!Array.isArray(decks)) return null;
  const out: DeckOption[] = [];
  for (const entry of decks) {
    if (typeof entry !== 'object' || entry === null) return null;
    const id = (entry as Record<string, unknown>).id;
    const name = (entry as Record<string, unknown>).name;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return null;
    out.push({ id, name });
  }
  return out;
}

// Classifies one proxy response into the §5.2 state model. `ok`/`status`
// mirror the HTTP response; `body` is the parsed JSON (or undefined when
// it could not be parsed). A thrown fetch (network/timeout) is
// unreachable and is handled by fetchDeckList.
export function deckListStateFromResponse(
  response: { ok: boolean; status: number; body: unknown },
  previous: DeckListState,
  now: number,
): DeckListState {
  const record = typeof response.body === 'object' && response.body !== null
    ? (response.body as Record<string, unknown>)
    : {};
  const serverUrl = typeof record.server_url === 'string' ? record.server_url : previous.serverUrl;
  const base = { cachedDecks: previous.cachedDecks, serverUrl, checkedAt: now };
  if (typeof record.server_url === 'string' && !record.server_url.trim()) {
    return { ...base, status: 'unconfigured', decks: [], error: '' };
  }
  if (response.ok) {
    const decks = parseDeckOptions(response.body);
    if (!decks) return { ...base, status: 'malformed', decks: [], error: 'Unexpected deck list shape.' };
    return { ...base, cachedDecks: decks, status: decks.length > 0 ? 'connected' : 'empty', decks, error: '' };
  }
  const error = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
  const malformed = record.code === 'invalid-payload' || /unexpected deck payload/i.test(error);
  return { ...base, status: malformed ? 'malformed' : 'unreachable', decks: [], error };
}

export type FetchLike = (url: string, init?: { cache?: string; signal?: unknown }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// Single fetcher shared by the settings page, New Agent, roster, and the
// config page. Calls only the Botmancers proxy; never `/api/decks`.
export async function fetchDeckList(fetchImpl: FetchLike, previous: DeckListState, now: () => number = Date.now): Promise<DeckListState> {
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(DECKS_ENDPOINT, { cache: 'no-store' });
  } catch (error) {
    return {
      status: 'unreachable',
      decks: [],
      cachedDecks: previous.cachedDecks,
      serverUrl: previous.serverUrl,
      checkedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return deckListStateFromResponse({ ok: response.ok, status: response.status, body }, previous, now());
}

// Ids the stored deck can be checked against: the fresh list when one
// loaded (connected/empty), else the last successful list, else null
// (availability unknown — never a blanket "unavailable" flag).
export function knownDeckIds(state: DeckListState | null | undefined): string[] | null {
  if (!state) return null;
  if (state.status === 'connected' || state.status === 'empty') return state.decks.map(deck => deck.id);
  if (state.status === 'unconfigured') return null;
  return state.cachedDecks ? state.cachedDecks.map(deck => deck.id) : null;
}

// Human label for a stored deck id: the server-returned name from the
// fresh or cached list, else the id verbatim.
export function deckLabel(deckId: string, state: DeckListState | null | undefined): string {
  const id = String(deckId ?? '').trim();
  const list = state ? (state.decks.length > 0 ? state.decks : state.cachedDecks ?? []) : [];
  return list.find(deck => deck.id === id)?.name ?? id;
}

function needsSelectionFlag(bot: BotRuntimeLike): boolean {
  const flag: unknown = bot.needs_deck_selection;
  if (flag === true || flag === 1) return true;
  if (typeof flag === 'string') {
    const text = flag.trim().toLowerCase();
    return text === '1' || text === 'true';
  }
  return false;
}

// Display label for the bot's agent (Hermes when unset).
export function botAgentLabel(bot: BotRuntimeLike): string {
  return agentLabel((bot.agent ?? '').trim() || DEFAULT_AGENT);
}

// Agent that still needs an Agent Deck picked from the configured server
// (legacy free-text deck, migrated row, or no deck ID).
export function isMigratedPending(bot: BotRuntimeLike): boolean {
  if (isDirectProfile(bot)) return false;
  return needsSelectionFlag(bot) || !(bot.deck_id ?? '').trim();
}

// NOT-502: a direct launch profile never shows or checks an Agent Deck.
export function isDirectProfile(bot: BotRuntimeLike): boolean {
  return bot.launch_profile === 'direct';
}

export const DIRECT_LAUNCH_SUFFIX = 'Launch: Direct';

export function isDeckUnavailable(bot: BotRuntimeLike, state: DeckListState | null | undefined): boolean {
  if (isMigratedPending(bot) || isDirectProfile(bot)) return false;
  const known = knownDeckIds(state);
  if (!known) return false;
  return !known.includes((bot.deck_id ?? '').trim());
}

function agentPrefix(bot: BotRuntimeLike): string {
  return `Agent: ${botAgentLabel(bot)} · Agent Deck: `;
}

export function runtimeSummary(bot: BotRuntimeLike, state?: DeckListState | null): string {
  if (isDirectProfile(bot)) return `Agent: ${botAgentLabel(bot)} · ${DIRECT_LAUNCH_SUFFIX}`;
  if (isMigratedPending(bot)) return `${agentPrefix(bot)}not selected`;
  return agentPrefix(bot) + deckLabel(bot.deck_id ?? '', state);
}

// Roster: exactly one plain-text line per bot.
export function rosterRuntimeLine(bot: BotRuntimeLike, state: DeckListState | null | undefined): string {
  const summary = runtimeSummary(bot, state);
  if (isMigratedPending(bot)) return `${summary} — select in Config`;
  if (isDeckUnavailable(bot, state)) return summary + ROSTER_UNAVAILABLE_SUFFIX;
  return summary;
}

// The roster line split so the deck token can truncate on its own (a
// deck known only by its UUID) without clipping the trailing marker.
// prefix + deck + suffix === rosterRuntimeLine(bot, state).
export function rosterRuntimeParts(
  bot: BotRuntimeLike,
  state: DeckListState | null | undefined
): { prefix: string; deck: string; suffix: string } {
  const line = rosterRuntimeLine(bot, state);
  if (isMigratedPending(bot) || isDirectProfile(bot)) return { prefix: line, deck: '', suffix: '' };
  const prefix = agentPrefix(bot);
  const deck = deckLabel(bot.deck_id ?? '', state);
  return { prefix, deck, suffix: line.slice(prefix.length + deck.length) };
}

export function defaultWorkdirFor(botId: string): string {
  return `~/.botmancers/${botId}`;
}

export function configWorkdirHint(botId: string): string {
  return `Default: ${defaultWorkdirFor(botId)} — leave blank to use it.`;
}

// The stored override, or null when the bot uses its implicit default.
// A stored value equal to the displayed default is still implicit.
export function workdirOverride(bot: BotRuntimeLike): string | null {
  const text = (bot.working_directory ?? '').trim();
  if (!text) return null;
  if (bot.id && text === defaultWorkdirFor(bot.id)) return null;
  return text;
}

export function workdirLine(bot: BotRuntimeLike): string {
  const override = workdirOverride(bot);
  if (override) return `Working directory: ${override} (custom)`;
  return `Working directory: ${defaultWorkdirFor(bot.id ?? '{agentID}')}`;
}

export interface ConfigRuntimeView {
  summary: string;
  workingDirectory: string | null;
  notices: string[];
  action: 'Edit';
}

export function isLocalServerUrl(value: unknown): boolean {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === 'string' ? value.trim() : '');
  } catch {
    return false;
  }
  const host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

// Config Agent card read view.
export function configRuntimeView(bot: BotRuntimeLike, state: DeckListState | null | undefined): ConfigRuntimeView {
  const notices: string[] = [];
  let summary = runtimeSummary(bot, state);
  if (isMigratedPending(bot)) {
    const legacy = (bot.deck_name ?? '').trim();
    notices.push(
      `No Agent Deck selected${legacy ? ` (was "${legacy}")` : ''}. Pick a deck from the configured server before this agent can run.`
    );
  } else if (isDeckUnavailable(bot, state)) {
    summary += CONFIG_UNAVAILABLE_SUFFIX;
    notices.push(UNAVAILABLE_DECK_NOTICE);
  } else if (state && state.status === 'unconfigured') {
    notices.push(UNCONFIGURED_DECK_NOTICE);
  } else if (state && (state.status === 'unreachable' || state.status === 'malformed') && !knownDeckIds(state)) {
    notices.push(UNCHECKED_DECK_NOTICE);
  }
  if (state && state.serverUrl && !isLocalServerUrl(state.serverUrl)) {
    notices.push(REMOTE_SERVER_LIMITATION);
  }
  return { summary, workingDirectory: workdirLine(bot), notices, action: 'Edit' };
}

export interface RuntimeFormInput {
  agent: BotAgent;
  deckId: string;
  workingDirectory: string;
}

export type RuntimeField = 'name' | 'agent' | 'deck' | 'workdir';

export interface RuntimeFormView {
  fields: RuntimeField[];
  submitDisabled: boolean;
  blocker: string;
}

// Field visibility + submit gating shared by New Agent and the config edit
// view. Every agent needs an Agent Deck, so Create/Save disables while the
// deck list loads and in every blocking state; a stored deck absent from
// the list still saves (it is kept).
export function runtimeFormView(
  input: { agent: string; deckId: string },
  state: DeckListState,
  options?: { includeName?: boolean; savedDeckId?: string | null },
): RuntimeFormView {
  const fields: RuntimeField[] = options?.includeName === false
    ? ['agent', 'deck', 'workdir']
    : ['name', 'agent', 'deck', 'workdir'];
  if (state.status === 'loading') return { fields, submitDisabled: true, blocker: '' };
  if (state.status === 'connected') return { fields, submitDisabled: false, blocker: '' };
  return { fields, submitDisabled: true, blocker: DECK_SLOT_COPY[state.status] };
}

// New Agent submit body: the picked agent and deck. The working directory
// is sent only when the user typed an override, so the default stays
// implicit (~/.botmancers/{agentID}, resolved at launch).
export function newBotSubmitBody(input: { name: string } & RuntimeFormInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(input.name ?? '').trim(),
    agent: input.agent,
    deck_id: input.deckId.trim(),
  };
  const workdir = input.workingDirectory.trim();
  if (workdir) body.working_directory = workdir;
  return body;
}

// Config save body: the visible agent, deck, and workdir. A blank or
// default-equal workdir is sent as '' which clears the override back to
// the implicit default.
export function configRuntimePatchBody(botId: string, input: RuntimeFormInput): Record<string, unknown> {
  const typed = input.workingDirectory.trim();
  return {
    id: botId,
    agent: input.agent,
    deck_id: input.deckId.trim(),
    working_directory: typed && typed !== defaultWorkdirFor(botId) ? typed : '',
  };
}

export const DEFAULT_RUNTIME_FORM: RuntimeFormInput = { agent: DEFAULT_AGENT, deckId: '', workingDirectory: '' };

// Edit form seed from the stored bot. The workdir input stays blank
// when the bot uses its default; a pending deck selection seeds blank.
export function runtimeFormFromBot(bot: BotRuntimeLike): RuntimeFormInput {
  const stored = (bot.agent ?? '').trim();
  return {
    agent: (AGENTS as readonly string[]).includes(stored) ? (stored as BotAgent) : DEFAULT_AGENT,
    deckId: isMigratedPending(bot) ? '' : (bot.deck_id ?? '').trim(),
    workingDirectory: workdirOverride(bot) ?? '',
  };
}

// Same-thread Agent Deck trace. The run adapter and the direct-dispatch
// loop post these verbatim prefixes into the originating conversation;
// the UI labels each line as an Agent Deck observation and keeps the
// remainder (ids, agent, deck) verbatim. '[Deck needs reselection]' is
// the pre-NOT-456 notice, kept so existing threads still render.
export const DECK_EVENT_PREFIXES = [
  '[Deck handoff]',
  '[Deck run]',
  '[Deck review]',
  '[Deck resume]',
  '[Deck result]',
  '[Deck failed]',
  '[Deck needs selection]',
  '[Deck needs reselection]',
] as const;

export type DeckEventKind = 'handoff' | 'run' | 'review' | 'resume' | 'result' | 'failed' | 'reselection' | null;

const DECK_EVENT_TABLE: Array<{ prefix: string; kind: Exclude<DeckEventKind, null>; label: string }> = [
  { prefix: '[Deck handoff]', kind: 'handoff', label: 'Agent Deck launch' },
  { prefix: '[Deck run]', kind: 'run', label: 'Agent Deck run' },
  { prefix: '[Deck review]', kind: 'review', label: 'Agent Deck review' },
  { prefix: '[Deck resume]', kind: 'resume', label: 'Agent Deck resume' },
  { prefix: '[Deck result]', kind: 'result', label: 'Agent Deck result' },
  { prefix: '[Deck failed]', kind: 'failed', label: 'Agent Deck failed' },
  { prefix: '[Deck needs selection]', kind: 'reselection', label: 'Agent Deck needs a deck' },
  { prefix: '[Deck needs reselection]', kind: 'reselection', label: 'Agent Deck needs a deck' },
];

export function deckEventKindOfLine(line: string): DeckEventKind {
  const text = String(line ?? '').trimStart();
  return DECK_EVENT_TABLE.find(entry => text.startsWith(entry.prefix))?.kind ?? null;
}

export function isDeckEventLine(line: string): boolean {
  return deckEventKindOfLine(line) !== null;
}

// Label + verbatim remainder for one trace line, or null for ordinary text.
export function deckEventDisplay(line: string): { label: string; detail: string } | null {
  const text = String(line ?? '').trimStart();
  const entry = DECK_EVENT_TABLE.find(item => text.startsWith(item.prefix));
  if (!entry) return null;
  return { label: entry.label, detail: text.slice(entry.prefix.length).trim() };
}

// Ordered event kinds observed in one thread's bot turns, in thread order.
export function orderedDeckEventKinds(contents: string[]): DeckEventKind[] {
  const kinds: DeckEventKind[] = [];
  for (const content of contents) {
    for (const line of String(content ?? '').split('\n')) {
      const kind = deckEventKindOfLine(line);
      if (kind) kinds.push(kind);
    }
  }
  return kinds;
}
