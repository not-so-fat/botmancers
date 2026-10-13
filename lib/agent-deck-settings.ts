// NOT-443: workspace Agent Deck settings, verified deck discovery, and
// per-bot default workdirs.
//
// - One workspace Agent Deck server URL, defaulting to
//   http://127.0.0.1:1111, persisted in the workspace_settings table.
// - The only verified discovery operation is
//   GET <server URL>/api/launch/decks (agent-deck 2.1.1, route prefix
//   /api/launch). It sends no credentials and validates
//   success/data/decks/id/name. GET /api/decks returns GRANT_REQUIRED
//   and is never substituted; the local-only `agent-deck deck list` CLI
//   is never a remote-server fallback.
// - Each bot's default working directory is ~/.botmancers/{agentID},
//   expanded absolute and created on demand before first launch; a stored
//   per-bot override wins.
// - Whether `agent-deck run` can target a non-local server is
//   unconfirmed, so a non-local configured URL fails explicitly instead
//   of running locally against a same-named deck.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { workspaceSettings } from './db';

export const DEFAULT_AGENT_DECK_SERVER_URL = 'http://127.0.0.1:1111';

export const AGENT_DECK_SERVER_URL_KEY = 'agent_deck_server_url';

export const AGENT_DECK_DECKS_PATH = '/api/launch/decks';

export class InvalidAgentDeckServerUrlError extends Error {
  readonly code = 'invalid-agent-deck-server-url';
  constructor(value: unknown) {
    super(
      `Invalid Agent Deck server URL: ${JSON.stringify(String(value ?? ''))}. Expected an http(s) URL such as ${DEFAULT_AGENT_DECK_SERVER_URL}.`
    );
  }
}

// Normalized server URL with no trailing slash. Throws on blank,
// unparseable, or non-http(s) values.
export function normalizeAgentDeckServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidAgentDeckServerUrlError(value);
  const text = value.trim();
  if (!text) throw new InvalidAgentDeckServerUrlError(value);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new InvalidAgentDeckServerUrlError(value);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidAgentDeckServerUrlError(value);
  }
  if (!parsed.hostname) throw new InvalidAgentDeckServerUrlError(value);
  return parsed.toString().replace(/\/+$/, '');
}

// Reads the stored workspace URL, or the default when nothing valid has
// been stored.
export function getAgentDeckServerUrl(): string {
  try {
    const stored = workspaceSettings.get(AGENT_DECK_SERVER_URL_KEY);
    if (stored === null) return DEFAULT_AGENT_DECK_SERVER_URL;
    return normalizeAgentDeckServerUrl(stored);
  } catch {
    return DEFAULT_AGENT_DECK_SERVER_URL;
  }
}

// Validates and persists the workspace URL. Returns the normalized value.
export function setAgentDeckServerUrl(value: unknown): string {
  const normalized = normalizeAgentDeckServerUrl(value);
  workspaceSettings.set(AGENT_DECK_SERVER_URL_KEY, normalized);
  return normalized;
}

export function agentDeckDecksUrl(serverUrl: string): string {
  return `${normalizeAgentDeckServerUrl(serverUrl)}${AGENT_DECK_DECKS_PATH}`;
}

export interface AgentDeckOption {
  id: string;
  name: string;
}

export class AgentDeckDiscoveryError extends Error {
  readonly code: string;
  readonly attemptedUrls: string[];
  constructor(message: string, attemptedUrls: string[], code = 'agent-deck-discovery-failed') {
    super(message);
    this.code = code;
    this.attemptedUrls = attemptedUrls;
  }
}

export type AgentDeckFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  json: () => Promise<unknown>;
}>;

function defaultFetch(url: string, init?: { method?: string; headers?: Record<string, string> }): Promise<{ json: () => Promise<unknown> }> {
  const impl = (globalThis as { fetch?: unknown }).fetch;
  if (typeof impl !== 'function') {
    throw new Error('fetch is not available in this runtime.');
  }
  return (impl as typeof fetch)(url, init as RequestInit).then(response => ({
    json: () => (response as Response).json() as Promise<unknown>,
  }));
}

function discoveryBodyGrants(body: unknown): boolean {
  try {
    const text = JSON.stringify(body ?? '');
    return text.includes('GRANT_REQUIRED');
  } catch {
    return false;
  }
}

function validateDecksBody(body: unknown): AgentDeckOption[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Expected {"success":true,"data":{"decks":[{"id","name"}]}}.');
  }
  const record = body as Record<string, unknown>;
  if (discoveryBodyGrants(body)) {
    throw new AgentDeckDiscoveryError(
      'Agent Deck server refused deck discovery with GRANT_REQUIRED. Only GET /api/launch/decks is supported; GET /api/decks must not be used.',
      [],
      'grant-required'
    );
  }
  if (record.success !== true) {
    throw new Error('Expected {"success":true,"data":{"decks":[{"id","name"}]}}.');
  }
  const data = record.data as Record<string, unknown> | undefined;
  const decks = (data as Record<string, unknown> | undefined)?.decks;
  if (!Array.isArray(decks)) {
    throw new Error('Expected {"success":true,"data":{"decks":[{"id","name"}]}}.');
  }
  const options: AgentDeckOption[] = decks.map(entry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Expected every deck to carry a string id and name.');
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!id || !name) {
      throw new Error('Expected every deck to carry a string id and name.');
    }
    return { id, name };
  });
  options.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return options;
}

// Verified discovery only: exactly one GET to
// <configured URL>/api/launch/decks with no credentials. Never retries
// through /api/decks and never shells out to the local CLI.
export async function listAgentDecks(options?: {
  serverUrl?: string;
  fetchImpl?: AgentDeckFetch;
}): Promise<AgentDeckOption[]> {
  const serverUrl = options?.serverUrl !== undefined ? normalizeAgentDeckServerUrl(options.serverUrl) : getAgentDeckServerUrl();
  const url = agentDeckDecksUrl(serverUrl);
  const fetchImpl = options?.fetchImpl ?? defaultFetch;
  let body: unknown;
  try {
    const response = await fetchImpl(url, { method: 'GET' });
    body = await response.json();
  } catch (error) {
    if (error instanceof AgentDeckDiscoveryError) {
      if (error.attemptedUrls.length === 0) throw new AgentDeckDiscoveryError(error.message, [url], error.code);
      throw error;
    }
    throw new AgentDeckDiscoveryError(
      `Cannot reach the Agent Deck server at ${url}: ${error instanceof Error ? error.message : String(error)}. Check the workspace Agent Deck URL and that the server is running.`,
      [url],
      'connection-failed'
    );
  }
  if (discoveryBodyGrants(body)) {
    throw new AgentDeckDiscoveryError(
      'Agent Deck server refused deck discovery with GRANT_REQUIRED. Only GET /api/launch/decks is supported; GET /api/decks must not be used.',
      [url],
      'grant-required'
    );
  }
  try {
    return validateDecksBody(body);
  } catch (error) {
    if (error instanceof AgentDeckDiscoveryError) throw error;
    throw new AgentDeckDiscoveryError(
      `Agent Deck server at ${url} returned an unexpected deck payload: ${error instanceof Error ? error.message : String(error)}`,
      [url],
      'invalid-payload'
    );
  }
}

// Loopback detection for the remote-launch guard. 127/8, ::1, and
// localhost are local; everything else is a non-local server whose
// launch path is unconfirmed.
export function isLocalAgentDeckUrl(value: unknown): boolean {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === 'string' ? value.trim() : '');
  } catch {
    return false;
  }
  const host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

export const REMOTE_LAUNCH_UNSUPPORTED_MESSAGE =
  '[Deck failed] Remote Agent Deck launch is not supported: the workspace Agent Deck server is non-local and remote `agent-deck run` targeting is unconfirmed. Point the workspace server URL at the local Agent Deck server to launch.';

export function remoteLaunchUnsupportedMessage(serverUrl: string): string {
  return `${REMOTE_LAUNCH_UNSUPPORTED_MESSAGE} (server_url=${serverUrl})`;
}

function homeDirForTests(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const fromEnv = (process.env.HOME ?? '').trim();
  if (fromEnv) return fromEnv;
  return os.homedir();
}

// Absolute default workdir for one bot: ~/.botmancers/{agentID}.
export function defaultBotWorkdir(agentId: string, homeDir?: string): string {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error('defaultBotWorkdir requires a bot id.');
  const home = homeDirForTests(homeDir);
  return path.resolve(home, '.botmancers', id);
}

function expandLeadingTilde(candidate: string, homeDir?: string): string {
  if (candidate === '~') return homeDirForTests(homeDir);
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(homeDirForTests(homeDir), candidate.slice(2));
  }
  return candidate;
}

// Stored override wins (preserved verbatim after trimming, with a
// leading ~ expanded); otherwise the absolute per-bot default.
export function resolveBotWorkdir(botId: string, override?: string | null, homeDir?: string): string {
  const text = typeof override === 'string' ? override.trim() : '';
  if (text) return expandLeadingTilde(text, homeDir);
  return defaultBotWorkdir(botId, homeDir);
}

// Creates the resolved directory on demand. Returns the path.
export function ensureBotWorkdir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolves (override or default) and creates the directory immediately
// before launch. Returns the absolute-or-override path that launched.
export function resolveAndEnsureBotWorkdir(botId: string, override?: string | null, homeDir?: string): string {
  const resolved = resolveBotWorkdir(botId, override, homeDir);
  ensureBotWorkdir(resolved);
  return resolved;
}
