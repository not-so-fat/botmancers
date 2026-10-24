// NOT-499: the one sanitizer of everything a service principal is shown.
//
// A runtime may echo engine-private values into anything it writes: a
// transcript message, an Ask answer, a Continue handoff packet, a failure
// message, a projected event. Before any of it reaches a service (the
// granted API in lib/service-api, and the /api/v0 conversation and request
// reads in lib/agent-conversations), every string is passed through the
// redactor:
//
//   - every provider session and run id the engine ever recorded, as
//     "[redacted runtime id]";
//   - every working directory, Deck selection, and Hermes profile any Agent
//     is configured with or was ever launched with, and every credential in
//     the environment, as "[redacted]";
//   - NOT-515 (finding R1 of NOT-514): every Agent's default workspace and
//     session-scope workspaces, every native session's workspace (in raw and
//     home-expanded form), and any absolute path under the user's home
//     directory (cwd-shaped output a runtime echoes), as "[redacted]".
//
// Fields holding a Botmancers id or reference are left as they are.
import os from 'os';
import db, { bots } from './db';
import { privateProviderIds } from './provider-sessions';

// Launch-context and Agent configuration fields whose values are
// engine-private (working directory, Deck selection, Hermes profile).
const PRIVATE_CONFIG_KEY = /^(cwd|working_directory|workspace|default_workspace|workspaces|deck|deck_id|deck_name|hermes_profile|hermes_profile_path)$/;
// Environment variables holding a credential.
const CREDENTIAL_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
// Keys whose value is a Botmancers id or reference, never redacted: an
// explicit list of the entities Botmancers itself names (request_id,
// originConversationId, sender_id, ...). Not every key ending in id: the
// provider's own run and session ids (external_run_id, runId,
// externalSessionId) are engine-private and fall through to redaction.
const REFERENCE_KEY = /^(id|ref|session_ref|sessionRef|kind)$|(request|conversation|agent|message|attempt|exchange|event|wake|grant|binding|finalization|bot|participant|sender|requester|origin|group)_?id$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectPrivate(value: unknown, into: Set<string>, privateKey = false): void {
  if (typeof value === 'string') {
    if (privateKey) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPrivate(item, into, privateKey);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) collectPrivate(item, into, privateKey || PRIVATE_CONFIG_KEY.test(key));
  }
}

// Every provider session and run id the engine ever recorded: a runtime may
// echo another Agent's id as easily as its own.
function privateIds(): string[] {
  const ids = new Set<string>();
  for (const row of db.prepare('SELECT external_session_id AS id FROM session_bindings').all() as { id: string }[]) ids.add(row.id);
  // NOT-503: native provider session and turn ids (lib/provider-sessions).
  for (const id of privateProviderIds(db)) ids.add(id);
  const attempts = db.prepare('SELECT external_session_id, external_run_id FROM work_attempts WHERE external_session_id IS NOT NULL OR external_run_id IS NOT NULL')
    .all() as { external_session_id: string | null; external_run_id: string | null }[];
  for (const row of attempts) {
    if (row.external_session_id) ids.add(row.external_session_id);
    if (row.external_run_id) ids.add(row.external_run_id);
  }
  return [...ids].filter(id => id.length > 0).sort((a, b) => b.length - a.length);
}

// Every working directory, Deck selection, and Hermes profile any Agent is
// configured with or was ever launched with, and every credential in the
// environment.
function privateValues(): string[] {
  const values = new Set<string>();
  for (const bot of bots.getAll()) {
    collectPrivate(bot, values);
    // The session scope's workspaces are stored as a JSON list.
    if (typeof bot.session_scope_items === 'string') collectPrivate(parseJson(bot.session_scope_items), values, true);
  }
  // NOT-503: a native session's workspace (the runtime's cwd).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_sessions'").get()) {
    for (const row of db.prepare('SELECT workspace FROM provider_sessions WHERE workspace IS NOT NULL').all() as { workspace: string }[]) values.add(row.workspace);
  }
  for (const value of [...values]) {
    const expanded = expandHome(value);
    if (expanded) values.add(expanded);
    // A trailing slash never keeps the path itself visible.
    if (value.length > 1 && value.endsWith('/')) values.add(value.replace(/\/+$/, ''));
  }
  const snapshots = db.prepare(`
    SELECT launch_snapshot AS snapshot FROM work_attempts WHERE launch_snapshot IS NOT NULL
    UNION ALL SELECT snapshot FROM launch_snapshots
  `).all() as { snapshot: string }[];
  for (const row of snapshots) collectPrivate(parseJson(row.snapshot), values);
  const configured = [...values].filter(value => value.trim().length >= 4);
  const credentials = Object.entries(process.env)
    .filter(([name, value]) => CREDENTIAL_ENV.test(name) && typeof value === 'string')
    .flatMap(([, value]) => [value as string, ...(value as string).split(/[\s,=]+/)])
    .filter(value => value.length >= 8);
  return [...new Set([...configured, ...credentials])].sort((a, b) => b.length - a.length);
}

function expandHome(value: string): string | null {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? `${os.homedir()}/${value.slice(2)}` : null;
}

// Any absolute path under the user's home directory, up to the next
// whitespace, quote, or bracket: what a runtime prints for its cwd.
function homePathPattern(): RegExp | null {
  const home = os.homedir().replace(/\/+$/, '');
  if (home.length < 4) return null;
  return new RegExp(`${escapeRegExp(home)}(?=$|[/\\s"'\`)\\]}>,;:])[^\\s"'\`)\\]}>,;]*`, 'g');
}

// A short id (under SHORT_ID) would rewrite unrelated text as a substring, so
// it is redacted only as a whole token; a longer one wherever it appears.
const SHORT_ID = 6;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactAll(text: string, values: string[], label: string): string {
  return values.reduce((acc, value) => {
    if (value.length >= SHORT_ID) return acc.includes(value) ? acc.split(value).join(label) : acc;
    return acc.includes(value) ? acc.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, 'g'), label) : acc;
  }, text);
}

export interface Redactor {
  text(value: string): string;
  // A copy with every string redacted, except reference fields.
  deep<T>(value: T): T;
}

export function serviceRedactor(): Redactor {
  const ids = privateIds();
  const values = privateValues();
  const home = homePathPattern();
  const text = (value: string) => {
    const redacted = redactAll(redactAll(value, ids, '[redacted runtime id]'), values, '[redacted]');
    return home ? redacted.replace(home, '[redacted]') : redacted;
  };
  const deep = (value: unknown, key: string | null): unknown => {
    if (typeof value === 'string') return key !== null && REFERENCE_KEY.test(key) ? value : text(value);
    if (Array.isArray(value)) return value.map(item => deep(item, null));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, deep(item, k)]));
    return value;
  };
  return { text, deep: <T>(value: T) => deep(value, null) as T };
}
