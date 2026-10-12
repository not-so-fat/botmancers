// File artifact producer (NOT-417): validate and write `[file]` artifacts.
//
// The snapshot (`lib/agent.ts` `fileWriteAsk`/`writeArtifact`) accepted one
// exact sentence and wrote a single word under `files/` with a path-prefix
// check. This module rebuilds that as a general capability: a file request
// names a file (`named`/`called`) and its content (`whose contents are the
// word`, `containing the word`, `with the word`, quoted or `:` content),
// validated with a strict schema; traversal, bad names and oversize content
// are refused and never written.
//
// Two inputs share the validator:
// - the user path (`parseFileWriteRequest`) parses a chat message,
// - the model path (`parseFileProduceMarker` / unified `parseTypedResult`
//   with draft results) parses a `[produce]` `{"type":"file",...}` line.
//
// Safety: names match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, the resolved path must
// stay under the files root, content has a byte cap, existing files are
// never overwritten unless `allowOverwrite` is set (the agent loop gates
// overwrites through an approval request instead), content is data and is
// never executed.
//
// Server-only: this module uses node imports (fs, path). The files root
// honors `BOTMANCERS_FILES_ROOT` so tests use an isolated temp directory;
// production defaults to `<cwd>/files`.
import fs from 'fs';
import path from 'path';
import { isSafeFileName } from './draft';
import { validateDraftRequest } from './draft-producer';
import type { DraftRequest } from './draft-producer';

export class ArtifactRefused extends Error {}

export const ARTIFACT_MAX_BYTES = 64 * 1024;
export const ARTIFACT_MAX_NAME_CHARS = 128;

export interface FileRequest {
  name: string;
  content: string;
}

export type TypedProducerResult =
  | { kind: 'draft'; draft: DraftRequest }
  | { kind: 'file'; file: FileRequest };

export function filesRoot(): string {
  const override = (process.env.BOTMANCERS_FILES_ROOT || '').trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), 'files');
}

export function resolveArtifactPath(name: string): string {
  const valid = validateArtifactName(name);
  const root = filesRoot();
  const resolved = path.resolve(root, valid);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ArtifactRefused(`refused: path traversal in ${JSON.stringify(name)}`);
  }
  return resolved;
}

export function validateArtifactName(name: unknown): string {
  if (typeof name !== 'string' || !name) {
    throw new ArtifactRefused('file needs a name');
  }
  if (name.length > ARTIFACT_MAX_NAME_CHARS) {
    throw new ArtifactRefused(`refused: file name too long ${JSON.stringify(name)}`);
  }
  if (!isSafeFileName(name)) {
    throw new ArtifactRefused(`refused: unsafe file name ${JSON.stringify(name)}`);
  }
  return name;
}

export function validateArtifactContent(content: unknown): string {
  if (typeof content !== 'string') throw new ArtifactRefused('file needs string content');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) throw new ArtifactRefused('file needs content');
  if (bytes > ARTIFACT_MAX_BYTES) {
    throw new ArtifactRefused(`refused: file content exceeds ${ARTIFACT_MAX_BYTES} bytes`);
  }
  return content;
}

// Strict schema: {name, content} with a safe name and capped content.
// Throws ArtifactRefused on anything else; unknown fields are ignored.
export function validateArtifact(input: unknown): FileRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ArtifactRefused('file needs {name, content}');
  }
  const row = input as Record<string, unknown>;
  return {
    name: validateArtifactName(row.name),
    content: validateArtifactContent(row.content),
  };
}

// Writes one validated artifact and returns its absolute path. Refuses to
// overwrite an existing file unless allowOverwrite is set (fixtures stay
// protected; the loop raises an approval for overwrites instead).
export function writeArtifactFile(
  name: string,
  content: string,
  opts?: { allowOverwrite?: boolean }
): string {
  const valid = validateArtifact({ name, content });
  const root = filesRoot();
  fs.mkdirSync(root, { recursive: true });
  const resolved = resolveArtifactPath(valid.name);
  if (fs.existsSync(resolved)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new ArtifactRefused(`refused: cannot stat ${JSON.stringify(valid.name)}`);
    }
    if (!stat.isFile()) throw new ArtifactRefused(`refused: not a file ${JSON.stringify(valid.name)}`);
    if (!opts?.allowOverwrite) {
      throw new ArtifactRefused(`refused: ${JSON.stringify(valid.name)} already exists`);
    }
  }
  fs.writeFileSync(resolved, valid.content, 'utf8');
  return resolved;
}

export function artifactCardText(name: string): string {
  return `[file] ${name}`;
}

function cleanFileName(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, '')
    .replace(/[?!;,:'"`]+$/, '')
    .trim();
  // All-dots names (`..`, `.`) are preserved as written so they parse and
  // are refused by the validator instead of vanishing into an empty name.
  if (/^\.+$/.test(stripped)) return stripped;
  return stripped.replace(/[.]+$/, '');
}

// Deterministic user path: the snapshot sentence
// ("write a file named X whose contents are the word Y") plus paraphrases
// ("write a file named plan.txt containing the word launch",
// "please create a file named ... containing the word ...",
// "make a file called ... with the word ...", quoted or `:` content).
// Traversal/bad names parse here (captured as written) and are refused by
// the validator, never written. Returns null for non-requests.
export function parseFileWriteRequest(userContent: string): FileRequest | null {
  const text = (userContent || '').trim();
  if (!text) return null;
  if (!/\b(write|create|make)\b/i.test(text)) return null;
  if (!/\bfile\b/i.test(text)) return null;
  if (!/\bfile\b\s+(named|called)\b/i.test(text)) return null;

  const nameMatch = text.match(/\bfile\b\s+(?:named|called)\s+([`"'\u201c\u201d]?\S+?[`"'\u201c\u201d]?)(?:\s+|$)/i);
  if (!nameMatch) return null;
  const name = cleanFileName(nameMatch[1] || '');
  if (!name) return null;

  const wordMatch = text.match(
    /(?:whose\s+contents?\s+are\s+the\s+word|containing\s+the\s+word|with\s+the\s+word)\s+[`"'\u201c\u201d]?([A-Za-z0-9_-]+)[`"'\u201c\u201d]?/i
  );
  if (wordMatch) {
    return { name, content: wordMatch[1] };
  }

  const quoted = text.match(/(?:containing|with\s+contents?)\s+["\u201c](.+?)["\u201d]/i);
  if (quoted && quoted[1].trim()) {
    return { name, content: quoted[1] };
  }

  const colon = text.match(/(?:containing|with\s+contents?)\s*:\s*(.+?)\s*$/i);
  if (colon && colon[1].trim()) {
    const content = colon[1].trim().replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, '').trim();
    if (content) return { name, content };
  }

  const unquoted = text.match(/(?:containing|with\s+contents?)\s+(?!the\s+word\b)(.+?)\s*$/i);
  if (unquoted && unquoted[1].trim()) {
    let content = unquoted[1].trim().replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, '').trim();
    content = content.replace(/[.?!]+$/, '').trim();
    if (content) return { name, content };
  }

  return null;
}

function producePayloads(modelReply: string): unknown[] {
  const payloads: unknown[] = [];
  for (const line of (modelReply || '').split(/\r?\n/)) {
    const match = line.match(/^\s*\[produce\]\s*(\{.*\})\s*$/i);
    if (!match) continue;
    try {
      payloads.push(JSON.parse(match[1]));
    } catch {
      // Not JSON; try the next line.
    }
  }
  return payloads;
}

// Model path (file only): a `[produce] {"type":"file",...}` line. Strict
// schema; invalid markers return null so the loop falls through to the
// normal reply instead of writing a bad file.
export function parseFileProduceMarker(modelReply: string): FileRequest | null {
  for (const payload of producePayloads(modelReply)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const row = payload as Record<string, unknown>;
    if (row.type !== 'file') continue;
    try {
      return validateArtifact({ name: row.name, content: row.content });
    } catch {
      return null;
    }
  }
  return null;
}

// One parser for both typed results: the first `[produce]` line wins. A
// draft payload validates through the draft producer, a file payload
// through the artifact validator. Unknown types and invalid payloads
// return null (the loop posts the raw reply and writes nothing).
export function parseTypedResult(modelReply: string): TypedProducerResult | null {
  for (const payload of producePayloads(modelReply)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const row = payload as Record<string, unknown>;
    if (row.type === 'draft') {
      try {
        const draft = validateDraftRequest({
          channel: row.channel,
          recipient: row.recipient ?? '',
          body: row.body,
        });
        return { kind: 'draft', draft };
      } catch {
        return null;
      }
    }
    if (row.type === 'file') {
      try {
        const file = validateArtifact({ name: row.name, content: row.content });
        return { kind: 'file', file };
      } catch {
        return null;
      }
    }
    // Unknown type: not a producer result.
    return null;
  }
  return null;
}
