// NOT-437: Botmancers runtime/deck UI helpers (pure, no I/O).
//
// Single source for the Atelier-approved copy used by the New Bot modal,
// the roster, the per-bot config card, and the same-thread delegation
// trace. React components in `app/page.tsx` and
// `app/bots/[id]/config/page.tsx` render these values; the plain-node
// regression test (`test-bot-runtime-ui.js`) asserts them without a
// browser. No adapter, schema, or routing contract lives here.

export interface AvailabilityState {
  status: 'loading' | 'ready' | 'empty' | 'error';
  runtimes: string[];
}

export interface BotRuntimeLike {
  persistent_runtime?: string | null;
  coding_runtime?: string | null;
  deck_name?: string | null;
  working_directory?: string | null;
  coding_configured?: boolean | null;
}

// Chat line is fixed: every manually created bot converses through Hermes.
export const CHAT_RUNTIME_LINE = 'Chat: Hermes';

export const CHAT_RUNTIME_FIXED_LINE = 'Chat runtime: Hermes (fixed)';

export const UNCONFIGURED_CODE_LINE = 'Code: not set — add it in Config.';

export const UNVERIFIED_SUFFIX = '(not verified — see Config).';

export const AVAILABILITY_LOADING_COPY = 'Checking available runtimes…';

export const AVAILABILITY_EMPTY_COPY =
  'No coding runtimes verified on this machine yet. The bot will still chat via Hermes; add a coding path later from Config once a runtime is installed.';

export const AVAILABILITY_ERROR_COPY = "Couldn't check coding runtimes. Retry.";

export const CONFIG_AVAILABILITY_EMPTY_COPY =
  'No coding runtimes verified on this machine yet — only already-stored values can be kept.';

export const CONFIG_UNCONFIGURED_COPY =
  'Code: not configured — this bot chats only.';

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
// carries no coding keys and omits `launchable`, so nothing partial is
// stored — the bot is created fully unconfigured.
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
  return {
    name,
    launchable: true,
    coding_runtime: input.codingRuntime,
    deck_name: input.deckName,
    working_directory: input.workingDirectory,
  };
}

// Roster two-line runtime block for one bot. The stored `coding_runtime`
// is checked against the availability payload only for the
// verified/unverified marker; it never invents a value and never offers
// an unverified runtime as a choice.
export function rosterRuntimeLines(
  bot: BotRuntimeLike,
  availability: AvailabilityState | null | undefined,
): { chat: string; code: string } {
  const chat = CHAT_RUNTIME_LINE;
  const runtime = (bot.coding_runtime ?? '').trim();
  const deck = (bot.deck_name ?? '').trim();
  const workdir = (bot.working_directory ?? '').trim();
  const configured = bot.coding_configured === true || (runtime !== '' && deck !== '' && workdir !== '');
  if (!configured || !runtime || !deck) {
    return { chat, code: UNCONFIGURED_CODE_LINE };
  }
  const verified =
    !availability ||
    availability.status === 'loading' ||
    availability.status === 'error' ||
    availability.runtimes.includes(runtime);
  if (verified) {
    return { chat, code: configuredCodeLine(runtime, deck) };
  }
  return { chat, code: `${configuredCodeLine(runtime, deck)} ${UNVERIFIED_SUFFIX}` };
}

// Config card read view.
export function configCodingPathLines(bot: BotRuntimeLike): { chat: string; code: string; workingDirectory: string | null } {
  const chat = 'Chat: Hermes (fixed)';
  const runtime = (bot.coding_runtime ?? '').trim();
  const deck = (bot.deck_name ?? '').trim();
  const workdir = (bot.working_directory ?? '').trim();
  const configured = bot.coding_configured === true || (runtime !== '' && deck !== '' && workdir !== '');
  if (!configured || !runtime || !deck) {
    return { chat, code: CONFIG_UNCONFIGURED_COPY, workingDirectory: null };
  }
  return { chat, code: configuredCodeLine(runtime, deck), workingDirectory: workdir || null };
}

// Same-thread delegation trace: the adapter (`delegateCodingViaDeck` in
// lib/agent-deck-run.ts) and the conversation loop (DECK directive path in
// lib/agent.ts) post these verbatim prefixes into the originating
// conversation. The UI renders them as ordinary bot turns.
export const DECK_EVENT_PREFIXES = [
  '[Deck handoff]',
  '[Deck run]',
  '[Deck review]',
  '[Deck resume]',
  '[Deck result]',
  '[Deck failed]',
] as const;

export type DeckEventKind = 'handoff' | 'run' | 'review' | 'resume' | 'result' | 'failed' | null;

export function deckEventKindOfLine(line: string): DeckEventKind {
  const text = String(line ?? '').trimStart();
  if (text.startsWith('[Deck handoff]')) return 'handoff';
  if (text.startsWith('[Deck run]')) return 'run';
  if (text.startsWith('[Deck review]')) return 'review';
  if (text.startsWith('[Deck resume]')) return 'resume';
  if (text.startsWith('[Deck result]')) return 'result';
  if (text.startsWith('[Deck failed]')) return 'failed';
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
