// Bounded command runs (NOT-419): the allowlist behind `beginCommandRun`.
// Only commands registered here ever execute, and only through execFile-style
// argv (no shell, no string evaluation). Anything else is refused here and, in
// the chat path, falls through to the approval engine, which refuses unknown
// actions unless a registered approval action allows them.

export const COMMAND_PRINT_WORD_PATTERN = /^[A-Za-z0-9_-]+$/;
export const COMMAND_PRINT_WORD_MAX_LENGTH = 64;

// Wait window shared by the phrase parser and the runner.
export const COMMAND_WAIT_MIN_SECONDS = 1;
export const COMMAND_WAIT_MAX_SECONDS = 30;
export const COMMAND_WAIT_DEFAULT_SECONDS = 4;

// Captured stdout is truncated to this size; the run still completes.
export const COMMAND_OUTPUT_MAX_BYTES = 4096;

// Hard timeout for one run: the requested wait plus this grace for the child
// itself. Firing it kills the child and marks the run stopped.
export const COMMAND_EXEC_GRACE_MS = 10_000;

export function commandTimeoutMs(waitSeconds: number): number {
  return waitSeconds * 1000 + COMMAND_EXEC_GRACE_MS;
}

export type AllowedCommandName = 'printf';

export const ALLOWED_COMMANDS: readonly AllowedCommandName[] = ['printf'];

export function isAllowedCommandName(value: unknown): value is AllowedCommandName {
  return value === 'printf';
}

export interface CommandRequest {
  command: AllowedCommandName;
  // Validated arguments, per command (printf: { word }).
  args: { word: string };
  waitSeconds: number;
}

export class CommandRefused extends Error {}

function refused(reason: string): never {
  throw new CommandRefused(reason);
}

function checkWord(word: unknown): string {
  if (typeof word !== 'string' || !COMMAND_PRINT_WORD_PATTERN.test(word)) {
    refused('refused: command not allowlisted');
  }
  if (word.length > COMMAND_PRINT_WORD_MAX_LENGTH) refused('refused: command not allowlisted');
  return word;
}

function checkWait(waitSeconds: unknown): number {
  if (
    typeof waitSeconds !== 'number' ||
    !Number.isInteger(waitSeconds) ||
    waitSeconds < COMMAND_WAIT_MIN_SECONDS ||
    waitSeconds > COMMAND_WAIT_MAX_SECONDS
  ) {
    refused(`refused: wait must be ${COMMAND_WAIT_MIN_SECONDS} to ${COMMAND_WAIT_MAX_SECONDS} seconds`);
  }
  return waitSeconds;
}

// Validates a typed request against the allowlist. Throws CommandRefused for
// anything outside it (unknown command, bad args, out-of-range wait).
export function validateCommandRequest(request: {
  command: unknown;
  args: unknown;
  waitSeconds: unknown;
}): CommandRequest {
  if (!isAllowedCommandName(request.command)) refused('refused: command not allowlisted');
  const args = request.args as Record<string, unknown> | null;
  const word = checkWord(args?.word);
  return { command: request.command, args: { word }, waitSeconds: checkWait(request.waitSeconds) };
}

export interface ResolvedCommand {
  bin: string;
  argv: string[];
  // Single-line display for the computer page, e.g. `printf %s boxmint8`.
  display: string;
}

// Maps a validated request to an argv vector. Absolute binary paths only, no
// shell. Throws CommandRefused for anything outside the allowlist.
export function resolveCommand(request: {
  command: unknown;
  args?: unknown;
  word?: unknown;
  format?: unknown;
}): ResolvedCommand {
  if (!isAllowedCommandName(request.command)) refused('refused: command not allowlisted');
  const args = (request.args as Record<string, unknown> | null) ?? null;
  // The approval engine passes { command, format, word } flat; accept both.
  const flat = request as Record<string, unknown>;
  const format = args?.format ?? flat.format;
  if (format !== undefined && format !== '%s') refused('refused: command not allowlisted');
  const word = checkWord(args?.word ?? flat.word);
  return { bin: '/usr/bin/printf', argv: ['%s', word], display: `printf %s ${word}` };
}

// ---------------------------------------------------------------------------
// Phrase parsing: `parsePrintAsk` generalised to a typed command request.
// ---------------------------------------------------------------------------

// Snapshot wait-phrasing forms (all "wait N seconds" with N 1..30); the bare
// print phrase defaults to 4 s. Paraphrases of the verb (output/display/show
// the word) and a leading "please" are accepted; anything else returns null
// so the message falls through to approvals or the model.
const PRINT_PHRASE =
  /^(?:please\s+)?(?:print|output|display|show|echo)\s+(?:the\s+)?word\s+([A-Za-z0-9_-]+)\s*(.*?)\s*[.?!]?\s*$/i;

const WAIT_FORMS: RegExp[] = [
  /^$/,
  /^wait\s+(\d+)\s*seconds?$/,
  /^and\s+wait\s+(\d+)\s*seconds?$/,
  /^wait\s+for\s+(\d+)\s*seconds?$/,
  /^and\s+wait\s+for\s+(\d+)\s*seconds?$/,
  /^then\s+wait\s+(\d+)\s*seconds?$/,
];

export function parseCommandAsk(text: string): CommandRequest | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // The approval engine owns the "run a command ..." shape; never claim it.
  if (/^(?:please\s+)?(run|execute)\s+(?:a\s+)?command\b/i.test(trimmed)) return null;
  const match = trimmed.match(PRINT_PHRASE);
  if (!match) return null;
  const word = match[1];
  if (!COMMAND_PRINT_WORD_PATTERN.test(word) || word.length > COMMAND_PRINT_WORD_MAX_LENGTH) return null;
  let tail = (match[2] || '').trim().replace(/^[,\s]+/, '').trim();
  tail = tail.replace(/\s+/g, ' ');
  for (const form of WAIT_FORMS) {
    const found = tail.match(form);
    if (!found) continue;
    if (!found[1]) return { command: 'printf', args: { word }, waitSeconds: COMMAND_WAIT_DEFAULT_SECONDS };
    const seconds = Number(found[1]);
    if (!Number.isInteger(seconds) || seconds < COMMAND_WAIT_MIN_SECONDS || seconds > COMMAND_WAIT_MAX_SECONDS) {
      return null;
    }
    return { command: 'printf', args: { word }, waitSeconds: seconds };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Computer page for a command run: the `page` payload rendered in the chief-
// of-staff computer float. Self-contained, no external assets.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function commandRunPage(request: CommandRequest, output: string | null): string {
  const display = `printf %s ${request.args.word}`;
  const body =
    output === null
      ? `<div class="cmd">$ ${escapeHtml(display)}</div><div class="dim">waiting ${request.waitSeconds}s…</div>`
      : `<div class="cmd">$ ${escapeHtml(display)}</div><div class="out">${escapeHtml(output)}</div>`;
  return (
    '<!doctype html><html><body style="margin:0;background:#0d1117;color:#c9d1d9;' +
    'font:13px/1.5 ui-monospace,monospace;padding:12px">' +
    body +
    '</body></html>'
  );
}
