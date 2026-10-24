// NOT-518: the production SlackTransport over native Socket Mode
// (docs/design/2026-10-24-session-share-preflight.md §5; docs/slack-relay.md).
//
// The four frozen methods, and nothing else:
//
//   start(onEnvelope)  connect a SocketModeClient; every events_api envelope
//                      is handed to the relay with envelope_id, type,
//                      accepts_response_payload, retry_attempt, retry_reason,
//                      and the payload object (team, event_id, channel,
//                      thread, user, message ts) exactly as Slack sent them
//   ack(envelope_id)   the Socket Mode acknowledgement; the relay calls it
//                      only after its ledger row committed
//   post(message)      chat.postMessage in the given thread with the relay's
//                      metadata; text over SHARE_LIMITS.replyChars is refused;
//                      refused only after stop()
//   stop()             disconnect for good: no auto-reconnect afterwards
//
// Reconnects are @slack/socket-mode's own: a socket close or a server
// "disconnect" (pod recycle) message reconnects unless stop() ran. Slack
// redelivers what was not acked; deduplicating it is the relay's job.
//
// The two tokens (BOTMANCERS_SLACK_APP_TOKEN, BOTMANCERS_SLACK_BOT_TOKEN; read
// by lib/slack-runtime) are given to the SDK clients only. The SDK logs
// through a logger that drops debug/info (where payloads are printed) and
// redacts both tokens; every error leaving this module is a new
// SlackTransportError holding a code and a token-free message, never the
// SDK error (whose request config carries the Authorization header).
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { SlackPost, SlackTransport, SocketModeEnvelope } from './slack-relay';
import { SHARE_LIMITS } from './session-shares';

// What the transport needs of a SocketModeClient and a WebClient: injectable,
// so a test can drive the adapter without a socket.
export type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SocketModeClientLike {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
  send(envelopeId: string, body?: Record<string, unknown>): Promise<void>;
}
export interface WebClientLike {
  chat: { postMessage(args: Record<string, unknown>): Promise<{ ok?: boolean; ts?: string; error?: string }> };
  auth: { test(): Promise<{ ok?: boolean; user_id?: string; team_id?: string; bot_id?: string; error?: string }> };
}
export interface SlackClients {
  socket: SocketModeClientLike;
  web: WebClientLike;
}

export interface SlackTokens {
  appToken: string;
  botToken: string;
}

// The SDK's own event (SocketModeClient 'slack_event').
interface SlackEventArgs {
  envelope_id?: string;
  type?: string;
  body?: SocketModeEnvelope['payload'];
  retry_num?: number;
  retry_reason?: string;
  accepts_response_payload?: boolean;
}

export type SlackTransportErrorCode =
  | 'slack_transport_started'
  | 'slack_transport_stopped'
  | 'slack_connect_failed'
  | 'slack_ack_failed'
  | 'slack_post_failed'
  | 'slack_post_too_long'
  | 'slack_auth_failed';

export class SlackTransportError extends Error {
  readonly code: SlackTransportErrorCode;
  // The Slack API error string (invalid_auth, channel_not_found, ...) when
  // Slack answered one; never a token, header, or request body.
  readonly slackError: string | null;
  constructor(code: SlackTransportErrorCode, message: string, slackError: string | null = null) {
    super(message);
    this.name = 'SlackTransportError';
    this.code = code;
    this.slackError = slackError;
  }
}

const SLACK_ERROR = /^[a-z0-9_]{1,64}$/;

// The Slack API error string of an SDK failure, if it carries one.
function slackErrorOf(error: unknown): string | null {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  const value = data && typeof data.error === 'string' ? data.error : null;
  return value && SLACK_ERROR.test(value) ? value : null;
}

// Replaces every token value (and any token-shaped string) in a text.
export function tokenRedactor(tokens: Partial<SlackTokens>): (text: string) => string {
  const values = [tokens.appToken, tokens.botToken].filter((v): v is string => typeof v === 'string' && v.length >= 8);
  return (text: string) => values
    .reduce((acc, value) => acc.split(value).join('[redacted]'), String(text))
    .replace(/\bx(?:app|ox[abpers])-[A-Za-z0-9-]+/g, '[redacted]');
}

// The @slack/logger Logger the SDK clients are given: warn and error only,
// one line, tokens redacted.
export function safeSlackLogger(redact: (text: string) => string, sink: (line: string) => void = line => console.warn(line)) {
  let name = 'slack';
  const write = (level: string) => (...msg: unknown[]) => sink(redact(`Slack ${name} ${level}: ${msg.map(m => (m instanceof Error ? m.message : String(m))).join(' ')}`).slice(0, 500));
  return {
    debug: () => {},
    info: () => {},
    warn: write('warn'),
    error: write('error'),
    setLevel: () => {},
    // 'warn': the SDK never builds its debug payload dumps.
    getLevel: () => 'warn' as never,
    setName: (next: string) => { name = next; },
  };
}

export interface SlackClientOptions {
  // A Slack API base URL (a test's local fake); default Slack's.
  slackApiUrl?: string;
  // Socket Mode reconnect backoff unit (clientPingTimeout x failures).
  clientPingTimeoutMs?: number;
  serverPingTimeoutMs?: number;
  log?: (line: string) => void;
}

// The real SDK clients: auto-reconnect on, the safe logger, no retries of
// chat.postMessage beyond the SDK default.
export function createSlackClients(tokens: SlackTokens, options: SlackClientOptions = {}): SlackClients {
  const logger = safeSlackLogger(tokenRedactor(tokens), options.log);
  const api = options.slackApiUrl ? { slackApiUrl: options.slackApiUrl } : {};
  const socket = new SocketModeClient({
    appToken: tokens.appToken,
    logger,
    autoReconnectEnabled: true,
    ...(options.clientPingTimeoutMs ? { clientPingTimeout: options.clientPingTimeoutMs } : {}),
    ...(options.serverPingTimeoutMs ? { serverPingTimeout: options.serverPingTimeoutMs } : {}),
    clientOptions: { ...api },
  });
  const web = new WebClient(tokens.botToken, { logger, ...api });
  return { socket: socket as unknown as SocketModeClientLike, web: web as unknown as WebClientLike };
}

// The bot's own identity (auth.test): its messages are never questions, and
// its team is the one workspace this installation serves.
export async function slackBotIdentity(web: WebClientLike): Promise<{ user_id: string; team_id: string }> {
  let res: Awaited<ReturnType<WebClientLike['auth']['test']>>;
  try {
    res = await web.auth.test();
  } catch (error) {
    const slackError = slackErrorOf(error);
    throw new SlackTransportError('slack_auth_failed', `Slack auth.test failed${slackError ? ` (${slackError})` : ''}.`, slackError);
  }
  if (!res?.ok || typeof res.user_id !== 'string' || typeof res.team_id !== 'string') {
    throw new SlackTransportError('slack_auth_failed', 'Slack auth.test returned no bot identity.', typeof res?.error === 'string' && SLACK_ERROR.test(res.error) ? res.error : null);
  }
  return { user_id: res.user_id, team_id: res.team_id };
}

export interface SlackTransportOptions {
  // How long stop() waits for envelopes being handled (their acks) before
  // disconnecting. A handler still running then simply loses its ack: Slack
  // redelivers and the relay's ledger recognizes it.
  stopGraceMs?: number;
  onError?: (error: unknown) => void;
}

export function createSlackTransport(clients: SlackClients, options: SlackTransportOptions = {}): SlackTransport {
  const { socket, web } = clients;
  const stopGraceMs = options.stopGraceMs ?? 5000;
  const onError = options.onError ?? ((error: unknown) => console.error('Slack transport:', error instanceof Error ? error.message : 'unknown error'));
  let phase: 'idle' | 'started' | 'stopping' | 'stopped' = 'idle';
  let listener: Listener | null = null;
  const inFlight = new Set<Promise<void>>();

  return {
    async start(onEnvelope) {
      if (phase !== 'idle') throw new SlackTransportError(phase === 'started' ? 'slack_transport_started' : 'slack_transport_stopped', 'This Slack transport was already started.');
      phase = 'started';
      listener = (event: SlackEventArgs) => {
        // events_api only; anything else (slash commands, interactivity) is
        // out of scope and never acknowledged.
        if (phase !== 'started' || event?.type !== 'events_api') return;
        const envelope: SocketModeEnvelope = {
          envelope_id: event.envelope_id,
          type: event.type,
          accepts_response_payload: event.accepts_response_payload,
          retry_attempt: event.retry_num,
          retry_reason: event.retry_reason,
          payload: event.body,
        };
        const run = Promise.resolve().then(() => onEnvelope(envelope)).catch(onError);
        inFlight.add(run);
        run.finally(() => inFlight.delete(run));
      };
      socket.on('slack_event', listener);
      try {
        await socket.start();
      } catch (error) {
        socket.off('slack_event', listener);
        listener = null;
        phase = 'stopped';
        await socket.disconnect().catch(() => {});
        const slackError = slackErrorOf(error);
        throw new SlackTransportError('slack_connect_failed', `The Slack Socket Mode connection could not be opened${slackError ? ` (${slackError})` : ''}.`, slackError);
      }
    },

    async ack(envelopeId) {
      if (phase === 'idle' || phase === 'stopped') throw new SlackTransportError('slack_transport_stopped', 'The Slack transport is not running.');
      try {
        await socket.send(envelopeId);
      } catch {
        throw new SlackTransportError('slack_ack_failed', 'The Socket Mode acknowledgement could not be sent (not connected).');
      }
    },

    async post(m: SlackPost) {
      // Posting is Web API only: it works before the socket connects (the
      // relay's recovery posts first) and while envelopes already being
      // handled finish during stop(); never after stop().
      if (phase === 'stopped') throw new SlackTransportError('slack_transport_stopped', 'The Slack transport is not running.');
      if (typeof m.text !== 'string' || m.text.length > SHARE_LIMITS.replyChars) {
        throw new SlackTransportError('slack_post_too_long', `A Slack post is at most ${SHARE_LIMITS.replyChars} characters.`);
      }
      let res: Awaited<ReturnType<WebClientLike['chat']['postMessage']>>;
      try {
        res = await web.chat.postMessage({
          channel: m.channel,
          ...(m.thread_ts !== null ? { thread_ts: m.thread_ts } : {}),
          text: m.text,
          metadata: { event_type: m.metadata.event_type, event_payload: { ...m.metadata.event_payload } },
          unfurl_links: false,
          unfurl_media: false,
        });
      } catch (error) {
        const slackError = slackErrorOf(error);
        throw new SlackTransportError('slack_post_failed', `Slack chat.postMessage failed${slackError ? ` (${slackError})` : ''}.`, slackError);
      }
      if (!res?.ok || typeof res.ts !== 'string') {
        throw new SlackTransportError('slack_post_failed', 'Slack chat.postMessage returned no message ts.', typeof res?.error === 'string' && SLACK_ERROR.test(res.error) ? res.error : null);
      }
      return { ts: res.ts };
    },

    async stop() {
      if (phase === 'stopped' || phase === 'stopping') return;
      const wasStarted = phase === 'started';
      phase = 'stopping';
      if (listener) socket.off('slack_event', listener);
      listener = null;
      if (inFlight.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise(resolve => { timer = setTimeout(resolve, stopGraceMs); }),
        ]);
        clearTimeout(timer);
      }
      phase = 'stopped';
      if (wasStarted) await socket.disconnect().catch(onError);
    },
  };
}
