// NOT-518: the Slack relay in the Botmancers server lifecycle
// (docs/slack-transport.md; design §5).
//
// The core server process (instrumentation.ts) calls startSlackRuntime() once
// at boot and stopSlackRuntime() on SIGTERM/SIGINT. No other process runs.
//
// Slack is enabled only when both credentials and a valid share
// configuration are present:
//
//   BOTMANCERS_SLACK_APP_TOKEN  xapp-…  Socket Mode (connections:write)
//   BOTMANCERS_SLACK_BOT_TOKEN  xoxb-…  Web API (chat:write, auth.test)
//
// read from the core's environment only (core.env or the shell; the bridge
// process never receives them). Both names match lib/service-redaction's
// CREDENTIAL_ENV, so their values are redacted from everything a service is
// shown. Every other state is reported, stable and token-free, by
// slackRuntimeStatus() (GET /api/health "slack"):
//
//   disabled       slack_tokens_absent
//   misconfigured  app_token_missing | bot_token_missing | app_token_invalid |
//                  bot_token_invalid | share_config_absent |
//                  share_config_invalid | share_config_no_audience |
//                  workspace_not_allowlisted
//   failed         slack_auth_failed | slack_connect_failed
//   connecting | connected | reconnecting | stopped
//
// Once connected, every envelope, the relay's recovery (at start and after
// each reconnect), and a periodic sweep run one at a time:
//
//   - envelope: relay.handleEnvelope (persist -> ack -> askShare -> reply);
//   - recovery: relay.recover (pending questions re-dispatched with their
//     original key, unposted notices and answers posted);
//   - sweep: every active share of this workspace with no anchor yet is
//     bound (relay.bindShare posts its anchor), and late answers flushed.
//
// stop() disconnects without reconnecting and leaves every relay row as it
// is: a pending question or an unposted answer is finished by the next start.
import db from './db';
import { createSlackRelay, type SlackRelay } from './slack-relay';
import {
  createSlackClients, createSlackTransport, slackBotIdentity, tokenRedactor,
  type SlackClientOptions, type SlackClients, type SlackTokens,
} from './slack-transport';
import { ShareError, loadSessionSharesConfig } from './session-shares';

export const SLACK_APP_TOKEN_ENV = 'BOTMANCERS_SLACK_APP_TOKEN';
export const SLACK_BOT_TOKEN_ENV = 'BOTMANCERS_SLACK_BOT_TOKEN';

const APP_TOKEN = /^xapp-[A-Za-z0-9-]{8,250}$/;
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{8,250}$/;

export type SlackRuntimeState = 'disabled' | 'misconfigured' | 'failed' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export type SlackRuntimeReason =
  | 'slack_tokens_absent'
  | 'app_token_missing' | 'bot_token_missing' | 'app_token_invalid' | 'bot_token_invalid'
  | 'share_config_absent' | 'share_config_invalid' | 'share_config_no_audience' | 'workspace_not_allowlisted'
  | 'slack_auth_failed' | 'slack_connect_failed';

export interface SlackRuntimeStatus {
  state: SlackRuntimeState;
  reason: SlackRuntimeReason | null;
  since: number;
  // Socket Mode connections opened (1 + reconnects) since this start.
  connections: number;
}

export type SlackConfig =
  | { state: 'disabled' | 'misconfigured'; reason: SlackRuntimeReason }
  | { state: 'ready'; tokens: SlackTokens; teams: ReadonlySet<string> };

// The Slack credentials and the share configuration, checked; never returns
// or reports a token value outside `tokens`.
export function slackRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  const appToken = (env[SLACK_APP_TOKEN_ENV] ?? '').trim();
  const botToken = (env[SLACK_BOT_TOKEN_ENV] ?? '').trim();
  if (!appToken && !botToken) return { state: 'disabled', reason: 'slack_tokens_absent' };
  if (!appToken) return { state: 'misconfigured', reason: 'app_token_missing' };
  if (!botToken) return { state: 'misconfigured', reason: 'bot_token_missing' };
  if (!APP_TOKEN.test(appToken)) return { state: 'misconfigured', reason: 'app_token_invalid' };
  if (!BOT_TOKEN.test(botToken)) return { state: 'misconfigured', reason: 'bot_token_invalid' };
  const shares = loadSessionSharesConfig(env);
  if (shares.state === 'absent') return { state: 'misconfigured', reason: 'share_config_absent' };
  if (shares.state === 'invalid') return { state: 'misconfigured', reason: 'share_config_invalid' };
  if (shares.config.audiences.length === 0) return { state: 'misconfigured', reason: 'share_config_no_audience' };
  return { state: 'ready', tokens: { appToken, botToken }, teams: new Set(shares.config.audiences.map(a => a.team_id)) };
}

export interface SlackRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  // The SDK clients (a test injects fakes, or real clients on a local fake
  // Slack); default createSlackClients(tokens, clientOptions).
  clients?: (tokens: SlackTokens) => SlackClients;
  clientOptions?: SlackClientOptions;
  sweepMs?: number;
  // A share that failed to bind is retried after this long.
  bindRetryMs?: number;
  stopGraceMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

interface Runtime {
  status: SlackRuntimeStatus;
  relay: SlackRelay | null;
  clients: SlackClients | null;
  stop: (() => Promise<void>) | null;
  starting: Promise<SlackRuntimeStatus> | null;
}

// One runtime per process, shared by every module graph Next builds
// (instrumentation and route handlers).
const KEY = Symbol.for('botmancers.slack-runtime');
const holder = globalThis as unknown as Record<symbol, Runtime | undefined>;
function runtime(): Runtime {
  if (!holder[KEY]) holder[KEY] = { status: { state: 'stopped', reason: null, since: Date.now(), connections: 0 }, relay: null, clients: null, stop: null, starting: null };
  return holder[KEY] as Runtime;
}

export function slackRuntimeStatus(): SlackRuntimeStatus {
  return { ...runtime().status };
}

// The running relay (the operator smoke binds its share through it).
export function slackRuntimeRelay(): SlackRelay | null {
  return runtime().relay;
}

export function startSlackRuntime(options: SlackRuntimeOptions = {}): Promise<SlackRuntimeStatus> {
  const rt = runtime();
  if (rt.starting) return rt.starting;
  if (rt.stop) return Promise.resolve(slackRuntimeStatus());
  rt.starting = start(rt, options).finally(() => { rt.starting = null; });
  return rt.starting;
}

export async function stopSlackRuntime(): Promise<SlackRuntimeStatus> {
  const rt = runtime();
  if (rt.starting) await rt.starting.catch(() => {});
  if (rt.stop) await rt.stop();
  return slackRuntimeStatus();
}

async function start(rt: Runtime, options: SlackRuntimeOptions): Promise<SlackRuntimeStatus> {
  const now = options.now ?? (() => Date.now());
  const config = slackRuntimeConfig(options.env ?? process.env);
  const redact = config.state === 'ready' ? tokenRedactor(config.tokens) : (text: string) => text;
  const log = (line: string) => (options.log ?? (l => console.log(l)))(redact(line));
  let connections = 0;
  const setStatus = (state: SlackRuntimeState, reason: SlackRuntimeReason | null = null) => {
    if (rt.status.state !== state || rt.status.reason !== reason) log(`Slack relay: ${state}${reason ? ` (${reason})` : ''}`);
    rt.status = { state, reason, since: now(), connections };
  };
  const onError = (error: unknown) => log(`Slack relay error: ${error instanceof Error ? error.message : 'unknown error'}`);

  if (config.state !== 'ready') {
    setStatus(config.state, config.reason);
    return slackRuntimeStatus();
  }
  const clients = (options.clients ?? (tokens => createSlackClients(tokens, { log, ...options.clientOptions })))(config.tokens);
  let identity: { user_id: string; team_id: string };
  try {
    identity = await slackBotIdentity(clients.web);
  } catch (error) {
    onError(error);
    setStatus('failed', 'slack_auth_failed');
    return slackRuntimeStatus();
  }
  if (!config.teams.has(identity.team_id)) {
    setStatus('misconfigured', 'workspace_not_allowlisted');
    return slackRuntimeStatus();
  }

  const transport = createSlackTransport(clients, { stopGraceMs: options.stopGraceMs, onError });
  const relay = createSlackRelay({ transport, botUserId: identity.user_id, onError, now });
  let stopped = false;

  // Envelopes, recovery, and the sweep, one at a time: a recovery never
  // races an envelope for the same pending question.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  let recoveryNeeded = true;
  const recover = () => serial(async () => {
    if (stopped) return;
    try {
      await relay.recover();
      recoveryNeeded = false;
    } catch (error) {
      recoveryNeeded = true;
      onError(error);
    }
  });

  const retryAt = new Map<string, number>();
  const bindRetryMs = options.bindRetryMs ?? 60_000;
  const sweep = () => serial(async () => {
    if (stopped) return;
    if (recoveryNeeded) {
      try {
        await relay.recover();
        recoveryNeeded = false;
      } catch (error) {
        onError(error);
      }
    }
    const unbound = db.prepare(`
      SELECT id FROM session_shares s
      WHERE state = 'active' AND expires_at > ? AND audience_team_id = ?
        AND NOT EXISTS (SELECT 1 FROM slack_share_threads t WHERE t.share_ref = s.id)
      ORDER BY created_at, id LIMIT 50
    `).all(now(), identity.team_id) as { id: string }[];
    for (const { id } of unbound) {
      if (stopped) return;
      if ((retryAt.get(id) ?? 0) > now()) continue;
      try {
        await relay.bindShare(id);
        retryAt.delete(id);
      } catch (error) {
        retryAt.set(id, now() + bindRetryMs);
        // A share no longer bindable (revoked, expired, off the allowlist)
        // is expected; anything else is reported.
        if (!(error instanceof ShareError)) onError(error);
      }
    }
    try {
      await relay.flushReplies();
    } catch (error) {
      onError(error);
    }
  });

  // Connection state, from the Socket Mode client's own lifecycle events.
  const socket = clients.socket;
  const onConnected = () => {
    if (stopped) return;
    connections += 1;
    setStatus('connected');
    // A question whose ack failed while the socket was down is still
    // pending; its redelivery is a duplicate event, so recovery sends it.
    if (connections > 1) recover();
  };
  const onReconnecting = () => { if (!stopped) setStatus('reconnecting'); };
  const onClose = () => { if (!stopped && rt.status.state === 'connected') setStatus('reconnecting'); };
  socket.on('connected', onConnected);
  socket.on('reconnecting', onReconnecting);
  socket.on('close', onClose);

  let timer: NodeJS.Timeout | null = null;
  rt.relay = relay;
  rt.clients = clients;
  rt.stop = async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    await relay.stop().catch(onError);
    socket.off('connected', onConnected);
    socket.off('reconnecting', onReconnecting);
    socket.off('close', onClose);
    rt.relay = null;
    rt.clients = null;
    rt.stop = null;
    setStatus('stopped');
  };

  setStatus('connecting');
  // Recovery first (Web API only), then the socket.
  await recover();
  try {
    await transport.start(envelope => serial(() => relay.handleEnvelope(envelope)).then(() => {}));
  } catch (error) {
    if (stopped) return slackRuntimeStatus();
    onError(error);
    const stop = rt.stop;
    await stop?.();
    setStatus('failed', 'slack_connect_failed');
    return slackRuntimeStatus();
  }
  if (stopped) return slackRuntimeStatus();
  if (rt.status.state !== 'connected') {
    // The SDK resolved start() on its "connected" event; count it if a fake
    // client did not emit one.
    connections = Math.max(connections, 1);
    setStatus('connected');
  }
  await sweep();
  timer = setInterval(() => { sweep().catch(onError); }, options.sweepMs ?? 5000);
  timer.unref?.();
  return slackRuntimeStatus();
}
