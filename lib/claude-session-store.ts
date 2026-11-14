// NOT-506: read-only access to Claude Code's local session store, the one
// place that parses its on-disk format (versioned fixtures:
// test-support/fixtures/claude-code/).
//
// Format CLAUDE_STORE_FORMAT, as written by Claude Code 2.1.x:
//   $CLAUDE_CONFIG_DIR (default ~/.claude)
//     projects/<project slug>/<session uuid>.jsonl   one record per line;
//         records carry sessionId, cwd, timestamp, and type (user,
//         assistant, custom-title, ai-title, summary, ... ); isSidechain
//         records belong to subagents.
//     sessions/<pid>.json                            live processes:
//         { pid, sessionId, cwd, status }.
//     settings.json                                  cleanupPeriodDays.
// The project slug is the session's cwd with every non-alphanumeric
// character replaced by '-'. It is lossy, so it only pre-filters
// directories; a session's workspace is always the cwd its records state.
//
// Unknown record types are ignored, malformed lines are counted and
// skipped, and a file whose name is not a session uuid or that holds no
// record naming a cwd is not a session. Nothing here writes to the store.
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TranscriptEntry } from './session-provider';

export const CLAUDE_STORE_FORMAT = 'claude-code-projects-jsonl/v1';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_LIMIT = 4000;
const DEFAULT_CLEANUP_DAYS = 30;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.CLAUDE_CONFIG_DIR || '').trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.claude');
}

export function projectSlug(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]/g, '-');
}

export function workspaceWithin(root: string, workspace: string): boolean {
  const base = root.replace(/\/+$/, '') || '/';
  return workspace === base || workspace.startsWith(base === '/' ? '/' : `${base}/`);
}

export interface SessionFile {
  id: string;
  file: string;
  mtime_ms: number;
}

function projectsDir(configDir: string): string {
  return path.join(configDir, 'projects');
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Slugs of a workspace root as given and as resolved (macOS /tmp is
// /private/tmp), for the directory pre-filter.
function rootSlugs(root: string): string[] {
  const slugs = new Set([projectSlug(root.replace(/\/+$/, ''))]);
  try {
    slugs.add(projectSlug(fs.realpathSync(root)));
  } catch {
    // A root that does not exist here can still name recorded sessions.
  }
  return [...slugs];
}

// Session files, newest first (ties by id). With roots, only project
// directories whose slug is a root's slug or extends it.
export function listSessionFiles(configDir: string, roots: string[] | null): SessionFile[] {
  const slugs = roots ? roots.flatMap(rootSlugs) : null;
  const out: SessionFile[] = [];
  for (const dir of readDir(projectsDir(configDir))) {
    if (slugs && !slugs.some(slug => dir === slug || dir.startsWith(`${slug}-`))) continue;
    const full = path.join(projectsDir(configDir), dir);
    for (const name of readDir(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isClaudeSessionId(id)) continue;
      try {
        const stat = fs.statSync(path.join(full, name));
        if (stat.isFile()) out.push({ id, file: path.join(full, name), mtime_ms: stat.mtimeMs });
      } catch {
        // Removed while listing.
      }
    }
  }
  return out.sort((a, b) => b.mtime_ms - a.mtime_ms || a.id.localeCompare(b.id));
}

export function findSessionFile(configDir: string, id: string): string | null {
  if (!isClaudeSessionId(id)) return null;
  for (const dir of readDir(projectsDir(configDir))) {
    const file = path.join(projectsDir(configDir), dir, `${id}.jsonl`);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not in this project.
    }
  }
  return null;
}

type Rec = Record<string, unknown>;

function readRecords(file: string): { records: Rec[]; malformed: number } | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const records: Rec[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed as Rec);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

function timeOf(record: Rec): number | null {
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

function blocks(record: Rec): unknown[] | string | null {
  const message = record.message as Rec | undefined;
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  return typeof content === 'string' || Array.isArray(content) ? content : null;
}

function isConversation(record: Rec): boolean {
  return (record.type === 'user' || record.type === 'assistant') && record.isSidechain !== true && record.isMeta !== true;
}

export interface LocalSessionMeta {
  id: string;
  workspace: string | null;
  title: string | null;
  created_at: number | null;
  updated_at: number | null;
  // User/assistant messages on the main chain.
  messages: number;
  claude_code_version: string | null;
  malformed: number;
}

function firstUserText(records: Rec[]): string | null {
  for (const record of records) {
    if (record.type !== 'user' || !isConversation(record)) continue;
    const content = blocks(record);
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(b => (b && typeof b === 'object' && (b as Rec).type === 'text' ? String((b as Rec).text ?? '') : '')).join('') : '';
    if (text.trim() && !text.trim().startsWith('<')) return text.trim();
  }
  return null;
}

// Metadata of one session file, or null when it is not a session.
export function readSessionMeta(file: SessionFile): LocalSessionMeta | null {
  const read = readRecords(file.file);
  if (!read) return null;
  const { records, malformed } = read;
  let workspace: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summary: string | null = null;
  let created: number | null = null;
  let updated: number | null = null;
  let version: string | null = null;
  let messages = 0;
  for (const record of records) {
    if (record.sessionId !== undefined && record.sessionId !== file.id) continue;
    if (workspace === null && typeof record.cwd === 'string' && record.cwd.startsWith('/')) workspace = record.cwd;
    if (typeof record.version === 'string') version = record.version;
    const at = timeOf(record);
    if (at !== null) {
      created = created === null ? at : Math.min(created, at);
      updated = updated === null ? at : Math.max(updated, at);
    }
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') customTitle = record.customTitle;
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') aiTitle = record.aiTitle;
    if (record.type === 'summary' && typeof record.summary === 'string') summary = record.summary;
    if (isConversation(record)) messages++;
  }
  if (workspace === null) return null;
  return {
    id: file.id,
    workspace,
    title: customTitle ?? aiTitle ?? summary ?? firstUserText(records),
    created_at: created,
    updated_at: updated ?? Math.floor(file.mtime_ms),
    messages,
    claude_code_version: version,
    malformed,
  };
}

// The main-chain transcript, in file order. Subagent (sidechain), meta, and
// non-message records are left out; thinking is never shown.
export function readTranscriptEntries(file: string, id: string): TranscriptEntry[] | null {
  const read = readRecords(file);
  if (!read) return null;
  const entries: TranscriptEntry[] = [];
  const push = (role: TranscriptEntry['role'], text: string, at: number | null) => {
    if (text.trim()) entries.push({ seq: entries.length + 1, role, text: clip(text), at });
  };
  for (const record of read.records) {
    if (!isConversation(record) || (record.sessionId !== undefined && record.sessionId !== id)) continue;
    const at = timeOf(record);
    const content = blocks(record);
    const role = record.type === 'user' ? 'user' : 'assistant';
    if (typeof content === 'string') { push(role, content, at); continue; }
    for (const block of content ?? []) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Rec;
      if (b.type === 'text') push(role, String(b.text ?? ''), at);
      else if (b.type === 'tool_use') push('tool', `tool call: ${String(b.name ?? 'unknown')}`, at);
      else if (b.type === 'tool_result') {
        const body = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => (c && typeof c === 'object' && (c as Rec).type === 'text' ? String((c as Rec).text ?? '') : '')).join('\n') : '';
        push('tool', `tool result: ${body || '(no text)'}`, at);
      }
    }
  }
  return entries;
}

// Session ids a live Claude Code process is working in right now. An
// interactive CLI waiting at its prompt reports status "idle" and is not
// working; any other, missing or unknown status counts (fails closed).
export function liveSessionIds(configDir: string, isAlive: (pid: number) => boolean): Set<string> {
  const live = new Set<string>();
  const dir = path.join(configDir, 'sessions');
  for (const name of readDir(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Rec;
      if (entry.status === 'idle') continue;
      if (isClaudeSessionId(entry.sessionId) && typeof entry.pid === 'number' && isAlive(entry.pid)) live.add(entry.sessionId);
    } catch {
      // Malformed or removed while reading.
    }
  }
  return live;
}

// Claude Code's transcript retention (settings.json cleanupPeriodDays).
export function cleanupPeriodDays(configDir: string): number {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')) as Rec;
    const days = Number(settings.cleanupPeriodDays);
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_CLEANUP_DAYS;
  } catch {
    return DEFAULT_CLEANUP_DAYS;
  }
}
