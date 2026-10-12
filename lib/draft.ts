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
