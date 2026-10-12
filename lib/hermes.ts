// Hermes in-process gateway client (NOT-413).
//
// One gateway wakes specialists: each specialist waits inside the single
// gateway process, and a chat turn pokes it over HTTP with a per-specialist
// session id. The gateway is an external process; this module only speaks to
// it. With no HERMES_API_SERVER_KEY configured, the agent loop stays on
// main's existing path and never calls here.
//
// Configuration (all optional except the key):
// - HERMES_API_SERVER_KEY: Bearer key. Unset means "gateway off".
// - HERMES_BASE_URL: gateway origin. Defaults to the documented constant.
// - HERMES_TIMEOUT_MS: per-request timeout. Defaults to 240000.
// - HERMES_SESSION_PREFIX: session-id prefix. Defaults to the constant.
// - HERMES_PROFILE_PATH: single profile path for every bot. Unset means the
//   path is derived per bot from its role (title slug).
// - HERMES_MODEL: model name sent in the chat body. Defaults to 'hermes'.
// - HERMES_WAIT_LOG_PATH: wait-log file. Defaults to the .temporal JSONL log.

import fs from 'fs';
import path from 'path';

// Documented default base URL for a local Hermes gateway.
export const HERMES_DEFAULT_BASE_URL = 'http://127.0.0.1:8642';

export const HERMES_DEFAULT_CHAT_PATH = '/v1/chat/completions';
export const HERMES_DEFAULT_TIMEOUT_MS = 240000;
export const HERMES_DEFAULT_SESSION_PREFIX = 'botmancer-specialist-';
export const HERMES_DEFAULT_MODEL = 'hermes';

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  sessionPrefix: string;
  model: string;
}

export interface HermesChatMessage {
  role: string;
  content: string;
}

export type HermesErrorCode =
  | 'missing-key'
  | 'http'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'protocol';

export class HermesError extends Error {
  readonly code: HermesErrorCode;
  readonly status?: number;

  constructor(code: HermesErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
    this.status = status;
  }
}

function parseTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return HERMES_DEFAULT_TIMEOUT_MS;
}

// Null when the gateway is off (no key). Reads env on every call so tests
// can toggle configuration without re-importing the agent loop.
export function loadHermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig | null {
  const apiKey = (env.HERMES_API_SERVER_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.HERMES_BASE_URL || '').trim() || HERMES_DEFAULT_BASE_URL;
  const sessionPrefix = (env.HERMES_SESSION_PREFIX || '').trim() || HERMES_DEFAULT_SESSION_PREFIX;
  const model = (env.HERMES_MODEL || '').trim() || HERMES_DEFAULT_MODEL;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: parseTimeoutMs(env.HERMES_TIMEOUT_MS),
    sessionPrefix,
    model,
  };
}

export function isHermesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadHermesConfig(env) !== null;
}

export function hermesSessionIdForBot(botId: string, config: HermesConfig): string {
  return `${config.sessionPrefix}${botId}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Per-bot profile path, derived from the bot's role (title slug) or name.
// Never a UUID: slugs come from human-readable settings only. A global
// HERMES_PROFILE_PATH override wins when set.
export function hermesProfilePathForBot(
  bot: { name: string; title: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = (env.HERMES_PROFILE_PATH || '').trim();
  if (override) return override.startsWith('/') ? override : `/${override}`;
  const slug = slugify(bot.title || '') || slugify(bot.name || '');
  if (!slug) return HERMES_DEFAULT_CHAT_PATH;
  return `/p/${slug}${HERMES_DEFAULT_CHAT_PATH}`;
}

export function hermesChatUrl(baseUrl: string, profilePath: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const tail = profilePath.startsWith('/') ? profilePath : `/${profilePath}`;
  return `${origin}${tail}`;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function abortError(signal: AbortSignal, timeoutMs: number): HermesError {
  void timeoutMs;
  return new HermesError('aborted', 'Hermes request aborted');
}

export async function hermesChat(args: {
  config: HermesConfig;
  profilePath: string;
  sessionId: string;
  messages: HermesChatMessage[];
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}): Promise<string> {
  const { config, profilePath, sessionId, messages, signal } = args;
  const fetchImpl: FetchImpl =
    args.fetchImpl || ((url, init) => fetch(url, init));
  const url = hermesChatUrl(config.baseUrl, profilePath);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  if (timer.unref) timer.unref();

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError(signal, config.timeoutMs);
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Hermes-Session-Id': sessionId,
        },
        body: JSON.stringify({ model: config.model, stream: false, messages }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new HermesError('timeout', `Hermes request timed out after ${config.timeoutMs} ms`);
      }
      if (controller.signal.aborted) {
        throw abortError(signal ?? controller.signal, config.timeoutMs);
      }
      throw new HermesError('network', `Hermes request failed: ${String(error)}`);
    }

    let payload: {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new HermesError('protocol', 'Hermes reply was not JSON');
    }
    if (!response.ok) {
      throw new HermesError(
        'http',
        payload.error?.message || `Hermes turn failed with status ${response.status}`,
        response.status
      );
    }
    const reply = payload.choices?.[0]?.message?.content?.trim();
    return reply || 'No response';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

export type HermesWaitEvent = 'wait_start' | 'wait_finish' | 'wait_failed';

export function hermesWaitLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.HERMES_WAIT_LOG_PATH || '').trim();
  if (override) return override;
  return path.join(process.cwd(), '.temporal', 'specialist-waits.jsonl');
}

// One JSON object per line. Never throws: logging must not fail a turn.
export function appendHermesWaitLog(entry: Record<string, unknown>): void {
  try {
    const file = hermesWaitLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) {
    console.error('wait log failed', error);
  }
}
