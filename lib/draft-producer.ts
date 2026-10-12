// Typed draft producer (NOT-417): model-or-user-driven structured outputs
// that become `[draft]` cards.
//
// The snapshot (NOT-410 `lib/draft.ts` `outboundDraftFromUser`) turned any
// message containing the word email or slack into a draft. This module
// rebuilds that as a general capability: a draft request must name a channel
// (email/slack), carry a creation ask (draft/write/compose/... or an
// imperative email/slack verb), and include a body after `that says`,
// `saying` or `note:`. A plain mention ("we should email less") yields null.
//
// Two inputs share one strict schema (`validateDraftRequest`):
// - the user path (`parseDraftRequest`) parses a chat message,
// - the model path (`parseDraftProduceMarker`) parses a `[produce]`
//   `{"type":"draft",...}` line from a bot reply (unified with file results
//   in `lib/artifacts.ts` `parseTypedResult`).
//
// Drafts are recorded in the thread only; sending real external messages
// stays out of scope. Pure functions only (like `lib/draft.ts`): no
// node-only imports, so the parser stays usable from the agent loop and
// tests without side effects.

import type { Draft, DraftChannel } from './draft';

export interface DraftRequest {
  channel: DraftChannel;
  recipient: string;
  body: string;
}

export class DraftRefused extends Error {}

export const DRAFT_MAX_BODY_BYTES = 32 * 1024;
export const DRAFT_MAX_RECIPIENT_CHARS = 256;

function hasWord(text: string, word: string): boolean {
  return new RegExp('\\b' + word + '\\b', 'i').test(text);
}

function draftBodyFromMarkers(text: string): string | null {
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
  if (at < 0) return null;
  const body = text.slice(at + marker.length).trim();
  return body || null;
}

function headBeforeBody(text: string): string {
  const lower = text.toLowerCase();
  const markers = ['that says', 'saying', 'note:'];
  let at = -1;
  for (const item of markers) {
    const found = lower.indexOf(item);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text;
  return text.slice(0, at);
}

function cleanRecipient(raw: string): string {
  return raw.trim().replace(/^[@"'`]+|["'`]+$/g, '').replace(/[.?!;,:'"`]+$/g, '').trim();
}

// Strict schema: channel enum, recipient string (empty allowed, like the
// snapshot), body non-empty string within the byte cap. Throws DraftRefused
// on anything else; unknown fields are ignored.
export function validateDraftRequest(input: unknown): DraftRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DraftRefused('draft needs {channel, recipient, body}');
  }
  const row = input as Record<string, unknown>;
  if (row.channel !== 'email' && row.channel !== 'slack') {
    throw new DraftRefused('draft channel must be email or slack');
  }
  if (typeof row.recipient !== 'string') throw new DraftRefused('draft needs a recipient string');
  if (typeof row.body !== 'string') throw new DraftRefused('draft needs a body string');
  const recipient = row.recipient.trim();
  const body = row.body.trim();
  if (recipient.length > DRAFT_MAX_RECIPIENT_CHARS) {
    throw new DraftRefused('draft recipient is too long');
  }
  if (!body) throw new DraftRefused('draft needs a body');
  if (Buffer.byteLength(body, 'utf8') > DRAFT_MAX_BODY_BYTES) {
    throw new DraftRefused('draft body is too large');
  }
  return { channel: row.channel, recipient, body };
}

export function createDraft(request: DraftRequest): Draft {
  const valid = validateDraftRequest(request);
  return {
    channel: valid.channel,
    recipient: valid.recipient,
    body: valid.body,
    state: 'open',
  };
}

// Deterministic user path: snapshot sentences ("Please email Alice that
// says ...", "Please slack Bob saying ...") plus paraphrases ("Draft an
// email to Sam saying ...", "Can you draft a Slack message to Carol
// saying ...", imperative "Email Alice the summary."). Returns null for
// plain mentions, questions, birth requests, and incomplete asks.
export function parseDraftRequest(userContent: string): DraftRequest | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  if (/^\s*(create a specialist|duplicate)\b/i.test(text)) return null;

  let channel: DraftChannel | null = null;
  if (hasWord(text, 'email')) channel = 'email';
  else if (hasWord(text, 'slack')) channel = 'slack';
  if (!channel) return null;

  const hasCreateVerb = /\b(draft|write|compose|create|prepare|send)\b/i.test(text);
  const hasPlease = /\bplease\b/i.test(text);
  const hasCanYou = /\b(can|could|would)\s+you\b/i.test(text);
  const startsWithChannelVerb = /^\s*(please\s+)?(email|slack)\b/i.test(text);
  if (!hasCreateVerb && !hasPlease && !hasCanYou && !startsWithChannelVerb) return null;

  const markedBody = draftBodyFromMarkers(text);
  if (markedBody) {
    const head = headBeforeBody(text);
    let recipient = '';
    const toMatch = head.match(/\bto\s+@?([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+\.[A-Za-z]+)?)/i);
    if (toMatch) {
      recipient = cleanRecipient(toMatch[1] || '');
    } else {
      const verbMatch = head.match(/\b(email|slack)\b\s+@?([A-Za-z0-9_.-]+)/i);
      if (verbMatch) {
        const candidate = cleanRecipient(verbMatch[2] || '');
        const stop = ['to', 'a', 'an', 'the', 'that', 'saying', 'note'];
        if (candidate && !stop.includes(candidate.toLowerCase())) recipient = candidate;
      }
    }
    try {
      return validateDraftRequest({ channel, recipient, body: markedBody });
    } catch {
      return null;
    }
  }

  // Marker-less imperative fallback ("Email Alice the summary."): the verb
  // leads, the next token is the recipient, the rest is the body. Scoped to
  // leading Email/Slack verbs only, so "we should email less" still yields
  // nothing.
  if (!startsWithChannelVerb) return null;
  const bare = text.match(/^\s*(?:please\s+)?(?:email|slack)\s+@?([A-Za-z0-9_.-]+)\s+(.+?)\s*[.?!]?\s*$/i);
  if (!bare) return null;
  const bareRecipient = cleanRecipient(bare[1] || '');
  const bareBody = (bare[2] || '').trim();
  const stop = ['to', 'a', 'an', 'the', 'that', 'saying', 'note'];
  if (!bareRecipient || stop.includes(bareRecipient.toLowerCase())) return null;
  if (!bareBody || bareBody.length < 2) return null;
  try {
    return validateDraftRequest({ channel, recipient: bareRecipient, body: bareBody });
  } catch {
    return null;
  }
}

// Model path: a `[produce] {"type":"draft",...}` line (case-insensitive
// marker, JSON object on the same line). Strict schema; anything invalid
// returns null so the loop falls through to the normal reply instead of
// posting a bad card.
export function parseDraftProduceMarker(modelReply: string): DraftRequest | null {
  if (!modelReply) return null;
  for (const line of modelReply.split(/\r?\n/)) {
    const match = line.match(/^\s*\[produce\]\s*(\{.*\})\s*$/i);
    if (!match) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row.type !== 'draft') continue;
    try {
      return validateDraftRequest({
        channel: row.channel,
        recipient: row.recipient ?? '',
        body: row.body,
      });
    } catch {
      return null;
    }
  }
  return null;
}
