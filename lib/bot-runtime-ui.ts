// NOT-442: single bot runtime UI helpers (pure, no I/O).
//
// Single source for the Atelier-approved copy used by the New Bot modal,
// the roster, the per-bot config card, and the same-thread delegation
// trace. React components in `app/page.tsx` and
// `app/bots/[id]/config/page.tsx` render these values; the plain-node
// regression test (`test-bot-runtime-ui.js`) asserts them without a
// browser. No adapter, schema, or routing contract lives here.
//
// Every bot resolves to exactly one runtime: 'hermes' (the default) or
// 'agent-deck' (one of codex|claude|cursor|muse plus a selected deck ID,
// with an optional working-directory override). There is no separate
// persistent/coding split: these helpers read the single runtime only.

export interface AvailabilityState {
  status: 'loading' | 'ready' | 'empty' | 'error';
  runtimes: string[];
}

export interface BotRuntimeLike {
  runtime?: string | null;
  agent_client?: string | null;
  deck_id?: string | null;
  // Unresolved legacy free-text deck reference (migrated rows only).
  deck_name?: string | null;
  working_directory?: string | null;
  needs_deck_reselection?: boolean | number | null;
  launchable?: boolean | null;
}

// Hermes bots converse through Hermes; nothing else runs for them.
export const CHAT_RUNTIME_LINE = 'Chat: Hermes';

export const RUNTIME_AGENT_DECK_LINE = 'Runtime: Agent Deck';

export const CHAT_RUNTIME_FIXED_LINE = 'Runtime: Hermes by default — set a coding path for Agent Deck.';

export const HERMES_CODE_LINE = 'Code: none — Hermes only';

export const NEEDS_RESELECTION_CODE_LINE = 'Code: deck not selected — re-select in Config.';

export const UNVERIFIED_SUFFIX = '(not verified — see Config).';

export const AVAILABILITY_LOADING_COPY = 'Checking available runtimes…';

export const AVAILABILITY_EMPTY_COPY =
  'No coding runtimes verified on this machine yet. The bot will still chat via Hermes; add a coding path later from Config once a runtime is installed.';

export const AVAILABILITY_ERROR_COPY = "Couldn't check coding runtimes. Retry.";

export const CONFIG_AVAILABILITY_EMPTY_COPY =
  'No coding runtimes verified on this machine yet — only already-stored values can be kept.';

export const CONFIG_UNCONFIGURED_COPY =
  'Code: none — this bot runs on Hermes.';

export const STORED_UNVERIFIED_NOTE =
  'Stored but not currently verified — saving keeps it.';

function configuredCodeLine(runtime: string, deck: string): string {
  return `Code: ${runtime} · ${deck}`;
}

// Options for the coding-runtime picker: exactly the entries of
// GET /api/bots/availability. Never hard-codes enum values.
export function runtimeOptions(payload: { runtimes: Array<{ runtime: string; launchable: boolean }> } | null | undefined): string[] {
  if (!payload || !Array.isArray(payload.runtimes)) return [];
  return payload.runtimes
    .filter(entry => entry && entry.launchable === true && typeof entry.runtime === 'string' && entry.runtime.length > 0)
    .map(entry => entry.runtime);
}

export function availabilityFromPayload(
  payload: { runtimes: Array<{ runtime: string; launchable: boolean }> } | null | undefined,
): AvailabilityState {
  const options = runtimeOptions(payload);
  if (!payload) return { status: 'error', runtimes: [] };
  if (options.length === 0) return { status: 'empty', runtimes: [] };
  return { status: 'ready', runtimes: options };
}

// New Bot submit body. In the empty / load-error states the request
// carries only the name, so the server default (Hermes) applies and
// nothing partial is stored. When the Deck ID field is blank the same
// Hermes default applies: the Agent Deck coding path needs a selected
// deck, so without one the pre-selected client and any typed override
// are not stored. Otherwise the modal's coding fields map to the single
// runtime: an agent-deck bot with the picked agent client, the typed
// deck ID, and the working-directory override (blank means no override;
// the server normalizes it to null).
export function newBotSubmitBody(input: {
  name: string;
  availability: AvailabilityState;
  codingRuntime: string;
  deckName: string;
  workingDirectory: string;
}): Record<string, unknown> {
  const name = String(input.name ?? '').trim();
  if (input.availability.status === 'empty' || input.availability.status === 'error') {
    return { name };
  }
  if (!String(input.deckName ?? '').trim()) {
    return { name };
  }
  return {
    name,
    runtime: 'agent-deck',
    agent_client: input.codingRuntime,
    deck_id: input.deckName,
    working_directory: input.workingDirectory,
  };
}

function needsReselection(bot: BotRuntimeLike): boolean {
  const flag: unknown = bot.needs_deck_reselection;
  if (flag === true || flag === 1) return true;
  if (typeof flag === 'string') {
    const text = flag.trim().toLowerCase();
    if (text === '1' || text === 'true') return true;
  }
  return false;
}

function reselectionCodeLine(bot: BotRuntimeLike): string {
  const legacy = (bot.deck_name ?? '').trim();
  if (legacy) return `Code: deck not selected (was "${legacy}") — re-select in Config.`;
  return NEEDS_RESELECTION_CODE_LINE;
}

// Roster two-line runtime block for one bot, driven by the single
// runtime. The stored agent client is checked against the availability
// payload only for the verified/unverified marker; it never invents a
// value and never offers an unverified client as a choice.
export function rosterRuntimeLines(
  bot: BotRuntimeLike,
  availability: AvailabilityState | null | undefined,
): { chat: string; code: string } {
  if ((bot.runtime ?? '').trim() !== 'agent-deck') {
    return { chat: CHAT_RUNTIME_LINE, code: HERMES_CODE_LINE };
  }
  const chat = RUNTIME_AGENT_DECK_LINE;
  const client = (bot.agent_client ?? '').trim();
  const deck = (bot.deck_id ?? '').trim();
  if (needsReselection(bot) || !client || !deck) {
    return { chat, code: reselectionCodeLine(bot) };
  }
  const verified =
    !availability ||
    availability.status === 'loading' ||
    availability.status === 'error' ||
    availability.runtimes.includes(client);
  if (verified) {
    return { chat, code: configuredCodeLine(client, deck) };
  }
  return { chat, code: `${configuredCodeLine(client, deck)} ${UNVERIFIED_SUFFIX}` };
}

// Config card read view. `configured` is true for every agent-deck bot
// (the working-directory override is optional), so the card offers Edit
// even when no override is stored; Hermes bots show the fixed runtime.
export function configCodingPathLines(bot: BotRuntimeLike): { chat: string; code: string; workingDirectory: string | null; configured: boolean } {
  if ((bot.runtime ?? '').trim() !== 'agent-deck') {
    return { chat: 'Runtime: Hermes (fixed)', code: CONFIG_UNCONFIGURED_COPY, workingDirectory: null, configured: false };
  }
  const chat = RUNTIME_AGENT_DECK_LINE;
  const client = (bot.agent_client ?? '').trim();
  const deck = (bot.deck_id ?? '').trim();
  const workdir = (bot.working_directory ?? '').trim();
  if (needsReselection(bot) || !client || !deck) {
    return { chat, code: reselectionCodeLine(bot), workingDirectory: workdir || null, configured: true };
  }
  return { chat, code: configuredCodeLine(client, deck), workingDirectory: workdir || null, configured: true };
}

// Same-thread delegation trace: the adapter (`delegateCodingViaDeck` in
// lib/agent-deck-run.ts) and the direct-dispatch conversation loop
// (`processAgentDeckTurn` in lib/agent.ts) post these verbatim prefixes
// into the originating conversation. The UI renders them as ordinary bot
// turns.
export const DECK_EVENT_PREFIXES = [
  '[Deck handoff]',
  '[Deck run]',
  '[Deck review]',
  '[Deck resume]',
  '[Deck result]',
  '[Deck failed]',
  '[Deck needs reselection]',
] as const;

export type DeckEventKind = 'handoff' | 'run' | 'review' | 'resume' | 'result' | 'failed' | 'reselection' | null;

export function deckEventKindOfLine(line: string): DeckEventKind {
  const text = String(line ?? '').trimStart();
  if (text.startsWith('[Deck handoff]')) return 'handoff';
  if (text.startsWith('[Deck run]')) return 'run';
  if (text.startsWith('[Deck review]')) return 'review';
  if (text.startsWith('[Deck resume]')) return 'resume';
  if (text.startsWith('[Deck result]')) return 'result';
  if (text.startsWith('[Deck failed]')) return 'failed';
  if (text.startsWith('[Deck needs reselection]')) return 'reselection';
  return null;
}

export function isDeckEventLine(line: string): boolean {
  return deckEventKindOfLine(line) !== null;
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
