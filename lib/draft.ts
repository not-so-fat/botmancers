// Thread-card markers (NOT-410): message drafts, approval codes, file artifacts,
// and handoff comments. Ported from the reference-only thread interactions.
//
// Pure functions only: this module is shared by the server routes, the agent
// loop, and the client thread UI, so it must stay free of node-only imports.

export interface Draft {
  recipient: string;
  body: string;
}

// A draft is a bot message carrying a `[draft to RECIPIENT]` marker line. The
// body is the marker line's trailing text plus every line after it.
export function parseDraft(content: string): Draft | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*\[draft to ([^\]]+)\]\s*(.*)$/i);
    if (!match) continue;
    const recipient = match[1].trim();
    if (!recipient) return null;
    const body = [match[2], ...lines.slice(i + 1)].join('\n').trim();
    return { recipient, body };
  }
  return null;
}

export function draftTitle(recipient: string): string {
  return `Draft to ${recipient}`;
}

export function serializeDraft(recipient: string, body: string): string {
  return `[draft to ${recipient}]\n${body}`;
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
