// Thread-card markers (NOT-410): message drafts, approval codes, file artifacts,
// and handoff comments. Draft format ported from the reference-only thread
// interactions; approval/file/handoff helpers stay local.
//
// Pure functions only: this module is shared by the server routes, the agent
// loop, and the client thread UI, so it must stay free of node-only imports.

export type DraftChannel = 'email' | 'slack';
export type DraftState = 'open' | 'sent' | 'discarded';

export interface Draft {
  channel: DraftChannel;
  recipient: string;
  body: string;
  state: DraftState;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp('\\b' + word + '\\b', 'i').test(text);
}

function draftBody(text: string): string {
  if (text.toLowerCase().includes('one-line note')) return 'One-line note.';
  const lower = text.toLowerCase();
  const markers = ['that says', 'saying', 'note:'];
  let at = -1;
  let marker = '';
  for (const item of markers) {
    const found = lower.indexOf(item);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
      marker = item;
    }
  }
  if (at < 0) return '';
  return text.slice(at + marker.length).trim();
}

// A user ask mentioning email or slack creates an outbound draft card instead
// of a model reply. Returns null for anything else (including specialist
// birth requests, which must not become drafts).
export function outboundDraftFromUser(text: string): Draft | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('Create a specialist') || trimmed.startsWith('Duplicate')) return null;
  let channel: DraftChannel | null = null;
  if (hasWord(text, 'email')) channel = 'email';
  else if (hasWord(text, 'slack')) channel = 'slack';
  if (!channel) return null;
  return {
    channel,
    recipient: '',
    body: draftBody(text),
    state: 'open',
  };
}

// A draft is a bot message whose content is `[draft]` followed by JSON
// `{channel, recipient, body, state}`. The state lives in the content so a
// Send or Discard flips the stored message read-only.
export function parseDraft(content: string): Draft | null {
  const match = content.match(/^\s*\[draft\]\s*([\s\S]*)$/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.channel !== 'email' && row.channel !== 'slack') return null;
  if (row.state !== 'open' && row.state !== 'sent' && row.state !== 'discarded') return null;
  if (typeof row.recipient !== 'string' || typeof row.body !== 'string') return null;
  return {
    channel: row.channel,
    recipient: row.recipient,
    body: row.body,
    state: row.state,
  };
}

export function draftTitle(channel: DraftChannel): string {
  return channel === 'email' ? 'New Email' : 'New Slack Message';
}

export function serializeDraft(draft: Draft): string {
  return '[draft]\n' + JSON.stringify({
    channel: draft.channel,
    recipient: draft.recipient,
    body: draft.body,
    state: draft.state,
  });
}

// An approval request is a bot message containing
// `approve using the code <code>`. The code is scoped to its conversation.
export function parseApprovalCode(content: string): string | null {
  const match = content.match(/approve using the code ([A-Za-z0-9][A-Za-z0-9_-]*)/i);
  return match ? match[1] : null;
}

// A file artifact is a `[file] <name>` marker line. Names are validated
// separately with isSafeFileName; this returns every marked name as written.
export function parseFileNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*\[file\]\s*(\S+)\s*$/i);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

export const FILE_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Only simple names inside files/ are servable: no slashes, no leading dots,
// no path traversal.
export function isSafeFileName(name: string): boolean {
  return FILE_NAME_RE.test(name);
}

// A handoff comment is the caller-managed delegation marker the agent loop
// writes when one bot hands off to another in the same thread.
export function parseHandoff(content: string): string | null {
  const match = content.match(/^\s*\[Handing off to ([^\]]+)\]/);
  if (!match) return null;
  const target = match[1].trim();
  return target || null;
}
