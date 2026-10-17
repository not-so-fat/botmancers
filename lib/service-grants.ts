// NOT-499: the owner-managed service-grants document.
//
// A service principal (lib/service-token-auth, service:<id>) can use the
// granted /api/v0 resources (lib/service-api) only for the Agents and
// capabilities the owner lists here. The document lives at
//
//   <BOTMANCERS_HOME>/config/service-grants.json
//
// (BOTMANCERS_SERVICE_GRANTS_PATH overrides the path, as the other
// per-path variables do in lib/home). Version 1:
//
//   {
//     "version": 1,
//     "grants": [
//       { "service": "grok-bot", "agent": "<agent id>",
//         "capabilities": ["agents:read", "sessions:read"] }
//     ]
//   }
//
// One entry per (service, Agent) pair, naming an explicit subset of
// SERVICE_CAPABILITIES. There is no wildcard and no default: a service or
// Agent that is not listed is granted nothing.
//
// Fail closed: the whole document is refused (state 'invalid', nothing is
// granted to anyone) when it is not owner-only (owned by another user, or
// writable by group or others), too large, not JSON, the wrong version, or
// carries an unknown field, an unknown or duplicate capability, a wildcard,
// a duplicate (service, Agent) entry, or a reserved engine principal. A
// missing document is state 'absent': installations without one keep the
// narrow bridge behavior (lib/agent-api) and the granted resources see no
// Agents. The file is re-read when it changes, so a rotation or rollback
// applies on the next request without a restart.
import fs from 'fs';
import path from 'path';
import { botmancersHome } from './home';

export const SERVICE_GRANTS_PATH_ENV = 'BOTMANCERS_SERVICE_GRANTS_PATH';
export const SERVICE_GRANTS_FILE = 'config/service-grants.json';
export const SERVICE_GRANTS_VERSION = 1;

export const SERVICE_CAPABILITIES = [
  'agents:read',
  'sessions:read',
  'conversations:read',
  'sessions:message',
  'exchanges:read',
  'exchanges:create',
] as const;

export type ServiceCapability = typeof SERVICE_CAPABILITIES[number];

export function isServiceCapability(value: unknown): value is ServiceCapability {
  return typeof value === 'string' && (SERVICE_CAPABILITIES as readonly string[]).includes(value);
}

// Engine-internal service principals (lib/session-exchanges,
// lib/coordinator-loop). A grant naming one is refused.
export const RESERVED_SERVICE_IDS: readonly string[] = ['botmancers-exchanges', 'botmancers-engine'];

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 512;

// service id -> agent id -> capabilities
export type ServiceGrantTable = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<ServiceCapability>>>;

export type ServiceGrantsState =
  | { state: 'absent'; path: string | null }
  | { state: 'invalid'; path: string; reason: string }
  | { state: 'loaded'; path: string; grants: ServiceGrantTable };

export class ServiceGrantsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceGrantsError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new ServiceGrantsError(`${where} has an unknown field "${unknown}".`);
}

// Parses and validates the document text. Throws ServiceGrantsError with
// the first problem; never returns a partial table.
export function parseServiceGrants(text: string): ServiceGrantTable {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ServiceGrantsError('The document is not valid JSON.');
  }
  if (!isObject(doc)) throw new ServiceGrantsError('The document must be a JSON object.');
  onlyKeys(doc, ['version', 'grants'], 'The document');
  if (doc.version !== SERVICE_GRANTS_VERSION) throw new ServiceGrantsError(`version must be ${SERVICE_GRANTS_VERSION}.`);
  if (!Array.isArray(doc.grants)) throw new ServiceGrantsError('grants must be a list.');
  if (doc.grants.length > MAX_ENTRIES) throw new ServiceGrantsError(`grants has more than ${MAX_ENTRIES} entries.`);
  const table = new Map<string, Map<string, Set<ServiceCapability>>>();
  doc.grants.forEach((entry, index) => {
    const where = `grants[${index}]`;
    if (!isObject(entry)) throw new ServiceGrantsError(`${where} must be an object.`);
    onlyKeys(entry, ['service', 'agent', 'capabilities'], where);
    const { service, agent, capabilities } = entry;
    if (typeof service !== 'string' || !SERVICE_ID.test(service)) {
      throw new ServiceGrantsError(`${where}.service must be a configured service id (letters, digits, ".", "_", "-").`);
    }
    if (RESERVED_SERVICE_IDS.includes(service)) throw new ServiceGrantsError(`${where}.service names a reserved engine principal.`);
    if (typeof agent !== 'string' || !AGENT_ID.test(agent)) {
      throw new ServiceGrantsError(`${where}.agent must be one Agent id; wildcards are not allowed.`);
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new ServiceGrantsError(`${where}.capabilities must list at least one capability.`);
    }
    const set = new Set<ServiceCapability>();
    for (const capability of capabilities) {
      if (!isServiceCapability(capability)) throw new ServiceGrantsError(`${where}.capabilities has an unknown capability.`);
      if (set.has(capability)) throw new ServiceGrantsError(`${where}.capabilities lists ${capability} twice.`);
      set.add(capability);
    }
    const agents = table.get(service) ?? new Map<string, Set<ServiceCapability>>();
    if (agents.has(agent)) throw new ServiceGrantsError(`${where} repeats the grant of service ${service} for that Agent.`);
    agents.set(agent, set);
    table.set(service, agents);
  });
  return table;
}

export function serviceGrantsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env[SERVICE_GRANTS_PATH_ENV] || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = botmancersHome(env);
  return home ? path.join(home, SERVICE_GRANTS_FILE) : null;
}

let cache: { key: string; state: ServiceGrantsState } | null = null;

// The current document state. Re-reads the file when its identity, size,
// mode, owner, or modification time changes.
export function loadServiceGrants(env: NodeJS.ProcessEnv = process.env): ServiceGrantsState {
  const file = serviceGrantsPath(env);
  if (!file) return { state: 'absent', path: null };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent', path: file };
    return { state: 'invalid', path: file, reason: 'The document cannot be read.' };
  }
  const key = [file, stat.ino, stat.size, stat.mode, stat.uid, stat.mtimeMs].join(':');
  if (cache && cache.key === key) return cache.state;
  const state = readState(file, stat);
  cache = { key, state };
  return state;
}

function readState(file: string, stat: fs.Stats): ServiceGrantsState {
  if (!stat.isFile()) return { state: 'invalid', path: file, reason: 'The document is not a regular file.' };
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { state: 'invalid', path: file, reason: 'The document must be owned by the user running Botmancers.' };
  }
  if ((stat.mode & 0o022) !== 0) {
    return { state: 'invalid', path: file, reason: 'The document must not be writable by group or others (chmod 600).' };
  }
  if (stat.size > MAX_BYTES) return { state: 'invalid', path: file, reason: `The document exceeds ${MAX_BYTES} bytes.` };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'invalid', path: file, reason: 'The document cannot be read.' };
  }
  try {
    return { state: 'loaded', path: file, grants: parseServiceGrants(text) };
  } catch (error) {
    if (error instanceof ServiceGrantsError) return { state: 'invalid', path: file, reason: error.message };
    throw error;
  }
}

// Test seam: forget the cached document.
export function resetServiceGrantsCache(): void {
  cache = null;
}
