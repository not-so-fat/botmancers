// The supervised Botmancers product: the packaged UI/API/core engine on
// 127.0.0.1:43123 and the MCP bridge on 127.0.0.1:43124, run as two child
// processes of one supervisor and reported as one health model.
//
//   start [--daemon] [--open]  launch (idempotent: an already healthy product is left alone)
//   stop                       terminate the supervisor and both children
//   status                     healthy / degraded / stopped, with versions and endpoints
//   doctor                     preflight checks, including optional Hermes and Agent Deck
//   open                       open the UI in a browser
//
// Health: healthy only when the supervisor and both children are alive, the
// core's /api/health and the bridge's /healthz both answer with the installed
// release version, and an authenticated bridge call reaches the core. Any
// other running combination is degraded. Run metadata lives in
// <home>/run/product.json and records each process's PID plus its start time;
// metadata whose processes are gone is removed, and a PID is only signalled
// when its start time and command line both still match the record. When the
// identity cannot be verified nothing is signalled and the metadata is kept.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { DEFAULT_PORT, ENV } from './config.js';
import { packageVersion } from './contract.js';
import {
  CLI_PATH, HOME_DIRS, PRODUCT_HOST, UI_PORT_ENV, DEFAULT_UI_PORT, type HomePaths,
  appDir, homePaths, missingAppFiles, modeOf, portFrom, readBuildInfo, readEnvFile, resolveHome,
} from './home.js';
import { createRedactor, type Redactor } from './redact.js';
import { SERVICE_TOKENS_ENV, credentialState } from './setup.js';

export const PRODUCT_EXIT = {
  ok: 0,
  degraded: 1,       // running but not healthy; doctor found a problem; browser launch failed
  usage: 2,
  stopped: 3,        // status/open: not running
  portInUse: 6,
  childFailed: 7,    // the core or the bridge did not come up
  missingAssets: 8,  // the packaged app is incomplete
  home: 9,           // BOTMANCERS_HOME is not writable
  notSetUp: 10,      // run `botmancers setup` first
} as const;

export const STARTUP_TIMEOUT_ENV = 'BOTMANCERS_STARTUP_TIMEOUT_MS';
export const BROWSER_ENV = 'BOTMANCERS_BROWSER';
export const AGENT_DECK_URL_ENV = 'BOTMANCERS_AGENT_DECK_URL';
export const CORE_HEALTH_PATH = '/api/health';
export const BRIDGE_HEALTH_PATH = '/healthz';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_DECK_URL = 'http://127.0.0.1:1111';

export interface ProductIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  io: ProductIo;
  paths: HomePaths;
  appDir: string;
  uiPort: number;
  mcpPort: number;
  version: string;
  redact: Redactor;
}

export class UsageError extends Error {}

export function productContext(env: NodeJS.ProcessEnv, io: ProductIo): Ctx {
  const paths = homePaths(resolveHome(env));
  let uiPort: number;
  let mcpPort: number;
  try {
    uiPort = portFrom(env, UI_PORT_ENV, DEFAULT_UI_PORT);
    mcpPort = portFrom(env, ENV.port, DEFAULT_PORT);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const bridge = readEnvFile(paths.bridgeEnv) ?? {};
  const redact = createRedactor([bridge[ENV.serviceToken], bridge[ENV.mcpToken], env[ENV.serviceToken], env[ENV.mcpToken]]);
  const out = (write: (text: string) => void) => (text: string) => write(redact(text));
  return { env, io: { stdout: out(io.stdout), stderr: out(io.stderr) }, paths, appDir: appDir(env), uiPort, mcpPort, version: packageVersion(), redact };
}

const uiUrl = (ctx: Ctx) => `http://${PRODUCT_HOST}:${ctx.uiPort}`;
const mcpBase = (ctx: Ctx) => `http://${PRODUCT_HOST}:${ctx.mcpPort}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function startupTimeout(env: NodeJS.ProcessEnv): number {
  const value = Number(env[STARTUP_TIMEOUT_ENV]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STARTUP_TIMEOUT_MS;
}

// ---------------------------------------------------------------------
// Run metadata and process identity.

export interface ChildRecord {
  pid: number | null;
  started?: string;  // process start time from ps; with the command line, the process identity
  port: number;
  url: string;
  exited?: { code: number | null; signal: string | null; at: string };
}

export interface RunRecord {
  schema: 1;
  version: string;
  home: string;
  appDir: string;
  state: 'starting' | 'running' | 'stopping';
  startedAt: string;
  supervisor: { pid: number; started?: string };
  ui: ChildRecord;
  mcp: ChildRecord;
}

export function readRun(paths: HomePaths): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(paths.runFile, 'utf8')) as RunRecord;
    return record && record.schema === 1 && typeof record.supervisor?.pid === 'number' ? record : null;
  } catch {
    return null;
  }
}

function writeRun(paths: HomePaths, record: RunRecord, exclusive = false): void {
  writeFileSync(paths.runFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

export interface ProcessIdentity {
  started: string;
  command: string;
}

// The start time and command line of a live process, null when it is gone,
// or 'unverifiable' when this platform cannot tell (no ps, a failing ps,
// unparseable output). Fails closed: a ps failure only means "gone" when an
// independent liveness check also says the pid is not running.
export function processIdentity(pid: number): ProcessIdentity | null | 'unverifiable' {
  let out: string;
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    });
  } catch {
    return pidAlive(pid) ? 'unverifiable' : null;
  }
  const match = /^\s*(\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(out.trim());
  return match ? { started: match[1].replace(/ +/g, ' '), command: match[2] } : 'unverifiable';
}

export function processStarted(pid: number | null | undefined): string | undefined {
  if (!pid) return undefined;
  const identity = processIdentity(pid);
  return identity && identity !== 'unverifiable' ? identity.started : undefined;
}

// owned: alive with the recorded start time and one of our command lines.
// gone: not running, or the PID now belongs to another process (recycled).
// unverified: alive, but the identity cannot be confirmed (no ps, or the
// record predates start-time identity); such a PID is never signalled.
export type Ownership = 'owned' | 'gone' | 'unverified';

export function ownership(pid: number | null | undefined, started: string | undefined, markers: string[]): Ownership {
  if (!pidAlive(pid)) return 'gone';
  const identity = processIdentity(pid!);
  if (identity === 'unverifiable') return 'unverified';
  if (identity === null) return 'gone';
  if (!markers.some(marker => identity.command.includes(marker))) return 'gone';
  if (!started) return 'unverified';
  return identity.started === started ? 'owned' : 'gone';
}

// A foreground `botmancers start` may run through the npm bin link.
const supervisorMarkers = () => [CLI_PATH, 'botmancers'];
const bridgeMarkers = () => [`${CLI_PATH} mcp`];
// Next renames its process to "next-server (vX)" on some platforms; the
// recorded start time is what tells ours apart from any other Next server.
const coreMarkers = (record: RunRecord) => [join(record.appDir, 'server.js'), 'next-server'];

type Target = { name: 'supervisor' | 'core' | 'bridge'; pid: number | null; owner: Ownership };

function targetsOf(record: RunRecord): Target[] {
  return [
    { name: 'supervisor', pid: record.supervisor.pid, owner: ownership(record.supervisor.pid, record.supervisor.started, supervisorMarkers()) },
    { name: 'core', pid: record.ui.pid, owner: ownership(record.ui.pid, record.ui.started, coreMarkers(record)) },
    { name: 'bridge', pid: record.mcp.pid, owner: ownership(record.mcp.pid, record.mcp.started, bridgeMarkers()) },
  ];
}

const unverifiedNote = (targets: Target[]) => `cannot verify that ${targets.map(t => `${t.name} pid ${t.pid}`).join(', ')} ${targets.length > 1 ? 'are' : 'is'} botmancers (no start-time identity); not signalled`;

// ---------------------------------------------------------------------
// Probes.

export interface Probe {
  ok: boolean;
  version: string | null;
  detail: string;
  body?: Record<string, unknown>;
}

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 2500): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { body = null; }
  return { status: response.status, body };
}

function unreachable(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
  return `not answering (${cause})`;
}

export async function probeCore(url: string): Promise<Probe> {
  try {
    const { status, body } = await getJson(`${url}${CORE_HEALTH_PATH}`);
    if (status !== 200 || body?.service !== 'botmancers-core' || body?.status !== 'ok') {
      return { ok: false, version: typeof body?.version === 'string' ? body.version : null, detail: `unhealthy (HTTP ${status})`, body: body ?? undefined };
    }
    return { ok: true, version: String(body.version), detail: 'ok', body };
  } catch (error) {
    return { ok: false, version: null, detail: unreachable(error) };
  }
}

export async function probeBridge(base: string): Promise<Probe> {
  try {
    const { status, body } = await getJson(`${base}${BRIDGE_HEALTH_PATH}`);
    if (status !== 200 || body?.status !== 'ok') return { ok: false, version: null, detail: `unhealthy (HTTP ${status})` };
    return { ok: true, version: String(body.version), detail: 'ok', body };
  } catch (error) {
    return { ok: false, version: null, detail: unreachable(error) };
  }
}

// An authenticated, read-only bridge round trip that the bridge forwards to
// the core: proves the bridge reaches this engine with valid credentials.
export async function probeLink(base: string, mcpToken: string | undefined): Promise<Probe> {
  if (!mcpToken) return { ok: false, version: null, detail: 'no MCP token in bridge.env' };
  try {
    const { status, body } = await getJson(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'botmancers-status', method: 'tools/call', params: { name: 'botmancers_health', arguments: {} } }),
    }, 5000);
    const result = (body?.result ?? null) as { isError?: boolean; structuredContent?: { status?: string; principal?: { kind?: string; id?: string } } } | null;
    if (status !== 200 || !result || result.isError || result.structuredContent?.status !== 'ok') {
      const message = (body?.error as { message?: string } | undefined)?.message;
      return { ok: false, version: null, detail: `bridge call failed (HTTP ${status}${message ? `: ${message.slice(0, 160)}` : ''})` };
    }
    const principal = result.structuredContent.principal;
    return { ok: true, version: null, detail: `ok (${principal?.kind}:${principal?.id})` };
  } catch (error) {
    return { ok: false, version: null, detail: unreachable(error) };
  }
}

export function portFree(port: number, host = PRODUCT_HOST): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------------
// Inspection: the one health model behind status, start, stop, and doctor.

export interface Inspection {
  state: 'stopped' | 'healthy' | 'degraded';
  record: RunRecord | null;
  problems: string[];
  repaired: string | null;
  alive: { supervisor: boolean; ui: boolean; mcp: boolean };
  core: Probe | null;
  bridge: Probe | null;
  link: Probe | null;
}

export async function inspect(ctx: Ctx): Promise<Inspection> {
  const record = readRun(ctx.paths);
  const none = { supervisor: false, ui: false, mcp: false };
  if (!record) {
    const stray = existsSync(ctx.paths.runFile);
    if (stray) rmSync(ctx.paths.runFile, { force: true });
    return { state: 'stopped', record: null, problems: [], repaired: stray ? 'removed unreadable run metadata' : null, alive: none, core: null, bridge: null, link: null };
  }
  const targets = targetsOf(record);
  const [supervisor, ui, mcp] = targets.map(target => target.owner === 'owned');
  const alive = { supervisor, ui, mcp };
  const unverified = targets.filter(target => target.owner === 'unverified');
  if (targets.every(target => target.owner === 'gone')) {
    rmSync(ctx.paths.runFile, { force: true });
    return {
      state: 'stopped', record: null, problems: [], alive, core: null, bridge: null, link: null,
      repaired: `removed stale run metadata (supervisor pid ${record.supervisor.pid} is not running)`,
    };
  }
  const [core, bridge] = await Promise.all([probeCore(record.ui.url), probeBridge(record.mcp.url.replace(/\/mcp$/, ''))]);
  // The link probe carries the owner-only MCP bearer token, so it goes only
  // to a bridge whose recorded process is confirmed ours. A listener whose
  // process is gone or unverifiable may be another program on the port.
  const link = bridge.ok && core.ok && mcp ? await probeLink(record.mcp.url.replace(/\/mcp$/, ''), readEnvFile(ctx.paths.bridgeEnv)?.[ENV.mcpToken]) : null;
  const problems: string[] = [];
  if (unverified.length) problems.push(unverifiedNote(unverified));
  if (record.state === 'starting') problems.push('startup has not finished');
  if (record.state === 'stopping') problems.push('shutdown in progress');
  const isUnverified = (name: Target['name']) => unverified.some(target => target.name === name);
  if (!alive.supervisor && !isUnverified('supervisor')) problems.push(`supervisor (pid ${record.supervisor.pid}) is not running`);
  if (!alive.ui && !isUnverified('core')) problems.push(`core (pid ${record.ui.pid ?? '-'}) is not running${record.ui.exited ? ` (exited ${record.ui.exited.code ?? record.ui.exited.signal})` : ''}`);
  if (!alive.mcp && !isUnverified('bridge')) problems.push(`bridge (pid ${record.mcp.pid ?? '-'}) is not running${record.mcp.exited ? ` (exited ${record.mcp.exited.code ?? record.mcp.exited.signal})` : ''}`);
  if (!core.ok) problems.push(`core health ${core.detail}`);
  else if (core.version !== ctx.version) problems.push(`version mismatch: core reports ${core.version}, installed ${ctx.version}`);
  else if (core.body?.home !== ctx.paths.home) problems.push(`core is serving another home (${String(core.body?.home)})`);
  if (!bridge.ok) problems.push(`bridge health ${bridge.detail}`);
  else if (bridge.version !== ctx.version) problems.push(`version mismatch: bridge reports ${bridge.version}, installed ${ctx.version}`);
  if (link && !link.ok) problems.push(`bridge -> core ${link.detail}`);
  if (record.version !== ctx.version) problems.push(`started by botmancers ${record.version}, installed ${ctx.version}`);
  return { state: problems.length ? 'degraded' : 'healthy', record, problems, repaired: null, alive, core, bridge, link };
}

export function formatStatus(ctx: Ctx, view: Inspection): string {
  const lines = [`botmancers ${ctx.version}: ${view.state}`];
  if (view.repaired) lines.push(`  note        ${view.repaired}`);
  lines.push(`  home        ${ctx.paths.home}`);
  const record = view.record;
  if (record) {
    const show = (probe: Probe | null) => (probe ? `${probe.ok ? 'ok' : 'DOWN'}${probe.version ? ` version ${probe.version}` : ''}` : '-');
    lines.push(`  ui/core     ${record.ui.url}  ${show(view.core)} (pid ${record.ui.pid ?? '-'})`);
    lines.push(`  mcp bridge  ${record.mcp.url}  ${show(view.bridge)} (pid ${record.mcp.pid ?? '-'})`);
    if (view.link) lines.push(`  bridge→core ${view.link.detail}`);
    lines.push(`  supervisor  pid ${record.supervisor.pid}${view.alive.supervisor ? '' : ' (not running)'}, started ${record.startedAt}`);
    for (const problem of view.problems) lines.push(`  problem     ${problem}`);
    if (view.state === 'degraded') lines.push('  fix         botmancers stop && botmancers start --daemon   (logs: ' + ctx.paths.logs + ')');
  } else {
    lines.push(`  ui/core     ${uiUrl(ctx)}  (not running)`);
    lines.push(`  mcp bridge  ${mcpBase(ctx)}/mcp  (not running)`);
  }
  return `${lines.join('\n')}\n`;
}

export async function status(ctx: Ctx): Promise<number> {
  const view = await inspect(ctx);
  ctx.io.stdout(formatStatus(ctx, view));
  return view.state === 'healthy' ? PRODUCT_EXIT.ok : view.state === 'degraded' ? PRODUCT_EXIT.degraded : PRODUCT_EXIT.stopped;
}

// ---------------------------------------------------------------------
// Preconditions shared by start and doctor.

function homeWritable(paths: HomePaths): string | null {
  try {
    accessSync(paths.home, fsConstants.W_OK);
    for (const dir of HOME_DIRS) accessSync(join(paths.home, dir), fsConstants.W_OK);
    const probe = join(paths.run, `.write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unwritable';
  }
}

function preconditions(ctx: Ctx): { code: number; message: string } | null {
  const missing = missingAppFiles(ctx.appDir);
  if (missing.length) {
    return { code: PRODUCT_EXIT.missingAssets, message: `the packaged app at ${ctx.appDir} is incomplete (missing ${missing.join(', ')}). Reinstall botmancers.` };
  }
  if (!existsSync(ctx.paths.home)) {
    return { code: PRODUCT_EXIT.notSetUp, message: `${ctx.paths.home} does not exist. Run: botmancers setup` };
  }
  const unwritable = homeWritable(ctx.paths);
  if (unwritable === 'ENOENT') return { code: PRODUCT_EXIT.notSetUp, message: `${ctx.paths.home} is not fully set up. Run: botmancers setup` };
  if (unwritable) return { code: PRODUCT_EXIT.home, message: `BOTMANCERS_HOME ${ctx.paths.home} is not writable (${unwritable}). Fix its permissions or choose another BOTMANCERS_HOME.` };
  const credentials = credentialState(ctx.paths);
  if (!credentials.ok) return { code: PRODUCT_EXIT.notSetUp, message: `${credentials.problems.join('; ')}. Run: botmancers setup` };
  return null;
}

// ---------------------------------------------------------------------
// The supervisor.

function childEnvs(ctx: Ctx): { core: NodeJS.ProcessEnv; bridge: NodeJS.ProcessEnv } {
  const coreFile = readEnvFile(ctx.paths.coreEnv) ?? {};
  const bridgeFile = readEnvFile(ctx.paths.bridgeEnv) ?? {};
  const shell: NodeJS.ProcessEnv = { ...ctx.env };
  // The core never holds the raw bridge tokens.
  for (const key of [ENV.serviceToken, ENV.mcpToken, ENV.url, ENV.host, ENV.port, UI_PORT_ENV]) delete shell[key];
  const home = ctx.paths.home;
  return {
    core: {
      ...coreFile,
      ...shell,
      [SERVICE_TOKENS_ENV]: coreFile[SERVICE_TOKENS_ENV],
      BOTMANCERS_HOME: home,
      PORT: String(ctx.uiPort),
      HOSTNAME: PRODUCT_HOST,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    bridge: {
      ...shell,
      [ENV.serviceToken]: bridgeFile[ENV.serviceToken],
      [ENV.mcpToken]: bridgeFile[ENV.mcpToken],
      [ENV.url]: uiUrl(ctx),
      [ENV.host]: PRODUCT_HOST,
      [ENV.port]: String(ctx.mcpPort),
      BOTMANCERS_HOME: home,
    },
  };
}

function spawnLogged(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string }): ChildProcess {
  const fd = openSync(options.log, 'a', 0o600);
  try {
    return spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
}

async function waitUntil(child: ChildProcess, check: () => Promise<boolean>, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return 'exited';
    if (await check()) return 'ready';
    await sleep(200);
  }
  return 'timeout';
}

function terminate(children: ChildProcess[], graceMs = 8000): Promise<void> {
  const live = children.filter(child => child.exitCode === null && child.signalCode === null);
  if (!live.length) return Promise.resolve();
  return new Promise(resolve => {
    let pending = live.length;
    const timer = setTimeout(() => {
      for (const child of live) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, graceMs);
    for (const child of live) {
      child.once('exit', () => {
        if (--pending === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.kill('SIGTERM');
    }
  });
}

function tail(path: string, from: number, maxLines = 12): string[] {
  try {
    const size = statSync(path).size;
    if (size <= from) return [];
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(size - from, 64 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    closeSync(fd);
    return buffer.toString('utf8').trimEnd().split('\n').slice(-maxLines);
  } catch {
    return [];
  }
}

const logSize = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

// Runs the product in this process until a signal. Resolves with an exit
// code when startup fails or after a signal-initiated shutdown; calls
// onReady once both children are healthy.
export async function supervise(ctx: Ctx, onReady: (record: RunRecord) => void): Promise<number> {
  const log = (line: string) => ctx.io.stderr(`[${new Date().toISOString()}] botmancers supervisor: ${line}\n`);
  const record: RunRecord = {
    schema: 1,
    version: ctx.version,
    home: ctx.paths.home,
    appDir: ctx.appDir,
    state: 'starting',
    startedAt: new Date().toISOString(),
    supervisor: { pid: process.pid, started: processStarted(process.pid) },
    ui: { pid: null, port: ctx.uiPort, url: uiUrl(ctx) },
    mcp: { pid: null, port: ctx.mcpPort, url: `${mcpBase(ctx)}/mcp` },
  };
  try {
    writeRun(ctx.paths, record, true);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    log('another botmancers start owns this home; leaving it alone.');
    return PRODUCT_EXIT.degraded;
  }
  const owned = () => readRun(ctx.paths)?.supervisor.pid === process.pid;
  const save = () => { if (owned()) writeRun(ctx.paths, record); };
  const children: ChildProcess[] = [];
  let shuttingDown = false;
  const fail = async (code: number, message: string): Promise<number> => {
    shuttingDown = true;
    log(message);
    await terminate(children);
    if (owned()) rmSync(ctx.paths.runFile, { force: true });
    return code;
  };
  const envs = childEnvs(ctx);
  const timeout = startupTimeout(ctx.env);

  const watch = (name: 'ui' | 'mcp', child: ChildProcess) => {
    child.on('exit', (code, signal) => {
      record[name].exited = { code, signal, at: new Date().toISOString() };
      if (shuttingDown) return;
      log(`${name === 'ui' ? 'core' : 'bridge'} (pid ${child.pid}) exited unexpectedly (${code ?? signal}); the product is degraded. See ${name === 'ui' ? ctx.paths.uiLog : ctx.paths.mcpLog}.`);
      save();
    });
  };

  log(`starting botmancers ${ctx.version} (home ${ctx.paths.home})`);
  const coreLogStart = logSize(ctx.paths.uiLog);
  const ui = spawnLogged([join(ctx.appDir, 'server.js')], { cwd: ctx.appDir, env: envs.core, log: ctx.paths.uiLog });
  children.push(ui);
  record.ui.pid = ui.pid ?? null;
  record.ui.started = processStarted(ui.pid);
  watch('ui', ui);
  save();
  const coreUp = await waitUntil(ui, async () => (await probeCore(record.ui.url)).ok, timeout);
  if (coreUp !== 'ready') {
    const why = tail(ctx.paths.uiLog, coreLogStart).map(line => `    ${line}`).join('\n');
    const inUse = /EADDRINUSE/.test(why);
    return fail(inUse ? PRODUCT_EXIT.portInUse : PRODUCT_EXIT.childFailed,
      `degraded start: the core ${coreUp === 'exited' ? `exited (${ui.exitCode ?? ui.signalCode})` : `did not become healthy within ${timeout} ms`}${inUse ? `: port ${ctx.uiPort} is in use` : ''}; nothing left running. Log ${ctx.paths.uiLog}:\n${why}`);
  }
  log(`core healthy at ${record.ui.url} (pid ${ui.pid})`);

  const bridgeLogStart = logSize(ctx.paths.mcpLog);
  const mcp = spawnLogged([CLI_PATH, 'mcp'], { cwd: ctx.paths.home, env: envs.bridge, log: ctx.paths.mcpLog });
  children.push(mcp);
  record.mcp.pid = mcp.pid ?? null;
  record.mcp.started = processStarted(mcp.pid);
  watch('mcp', mcp);
  save();
  const bridgeUp = await waitUntil(mcp, async () => (await probeBridge(mcpBase(ctx))).ok, timeout);
  if (bridgeUp !== 'ready') {
    const why = tail(ctx.paths.mcpLog, bridgeLogStart).map(line => `    ${ctx.redact(line)}`).join('\n');
    const inUse = mcp.exitCode === 3;
    return fail(inUse ? PRODUCT_EXIT.portInUse : PRODUCT_EXIT.childFailed,
      `degraded start: the core started but the bridge ${bridgeUp === 'exited' ? `exited (${mcp.exitCode ?? mcp.signalCode})` : `did not become healthy within ${timeout} ms`}${inUse ? `: port ${ctx.mcpPort} is in use` : ''}; stopped the core too. Log ${ctx.paths.mcpLog}:\n${why}`);
  }
  log(`bridge healthy at ${record.mcp.url} (pid ${mcp.pid})`);
  record.state = 'running';
  save();
  onReady(record);

  return new Promise(resolve => {
    const stop = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} received; stopping core and bridge.`);
      record.state = 'stopping';
      save();
      terminate(children).then(() => {
        if (owned()) rmSync(ctx.paths.runFile, { force: true });
        log('stopped.');
        resolve(PRODUCT_EXIT.ok);
      });
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGHUP', () => stop('SIGHUP'));
  });
}

// ---------------------------------------------------------------------
// Commands.

function browserCommand(env: NodeJS.ProcessEnv): string[] {
  const custom = (env[BROWSER_ENV] ?? '').trim();
  if (custom) return custom.split(/\s+/);
  if (process.platform === 'darwin') return ['open'];
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '""'];
  return ['xdg-open'];
}

function launchBrowser(ctx: Ctx, url: string): Promise<boolean> {
  const [command, ...args] = browserCommand(ctx.env);
  return new Promise(resolve => {
    const child = spawn(command, [...args, url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function open(ctx: Ctx): Promise<number> {
  const view = await inspect(ctx);
  if (view.state === 'stopped' || !view.core?.ok) {
    ctx.io.stderr(`botmancers: the UI is not running (${view.state}). Start it with: botmancers start --daemon --open\n`);
    return PRODUCT_EXIT.stopped;
  }
  const url = view.record!.ui.url;
  if (await launchBrowser(ctx, url)) {
    ctx.io.stdout(`botmancers: opened ${url}\n`);
    return PRODUCT_EXIT.ok;
  }
  ctx.io.stderr(`botmancers: could not launch a browser; open ${url} yourself.\n`);
  return PRODUCT_EXIT.degraded;
}

export interface StartOptions {
  daemon: boolean;
  open: boolean;
  supervise: boolean;
}

export function parseStartArgs(argv: string[]): StartOptions {
  const options: StartOptions = { daemon: false, open: false, supervise: false };
  for (const arg of argv) {
    if (arg === '--daemon' || arg === '-d') options.daemon = true;
    else if (arg === '--open') options.open = true;
    else if (arg === '--supervise') options.supervise = true; // internal: the detached supervisor
    else throw new UsageError(/^--?[a-z][a-z0-9-]{0,38}$/.test(arg) ? `Unknown argument ${JSON.stringify(arg)} for start.` : 'Unexpected argument for start (value not shown).');
  }
  return options;
}

export async function start(ctx: Ctx, options: StartOptions): Promise<number> {
  const blocked = preconditions(ctx);
  if (blocked) {
    ctx.io.stderr(`botmancers: ${blocked.message}\n`);
    return blocked.code;
  }

  if (options.supervise) {
    // The detached supervisor started by `start --daemon`; its parent already checked.
    const code = await supervise(ctx, () => {});
    return code;
  }

  const view = await inspect(ctx);
  if (view.repaired) ctx.io.stderr(`botmancers: ${view.repaired}\n`);
  if (view.state === 'healthy') {
    ctx.io.stdout(`botmancers: already running.\n${formatStatus(ctx, view)}`);
    if (options.open) await launchBrowser(ctx, view.record!.ui.url);
    return PRODUCT_EXIT.ok;
  }
  if (view.state === 'degraded') {
    ctx.io.stdout(formatStatus(ctx, view));
    ctx.io.stderr('botmancers: a previous start is degraded; run `botmancers stop`, then start again.\n');
    return PRODUCT_EXIT.degraded;
  }

  for (const [port, what] of [[ctx.uiPort, 'UI/core'], [ctx.mcpPort, 'MCP bridge']] as const) {
    if (!(await portFree(port))) {
      ctx.io.stderr(`botmancers: port ${port} on ${PRODUCT_HOST} (${what}) is in use by another process. Stop it, or choose another port with ${what === 'UI/core' ? UI_PORT_ENV : ENV.port}.\n`);
      return PRODUCT_EXIT.portInUse;
    }
  }

  const announce = async (record: RunRecord) => {
    ctx.io.stdout(`botmancers ${ctx.version}: running\n  UI   ${record.ui.url}\n  MCP  ${record.mcp.url}\n  home ${ctx.paths.home}\n`);
    if (options.open) {
      if (!(await launchBrowser(ctx, record.ui.url))) ctx.io.stderr(`botmancers: could not launch a browser; open ${record.ui.url} yourself.\n`);
    }
  };

  if (!options.daemon) {
    const code = await supervise({ ...ctx, io: { stdout: ctx.io.stdout, stderr: ctx.io.stderr } }, record => { void announce(record); });
    return code;
  }

  const from = logSize(ctx.paths.supervisorLog);
  const fd = openSync(ctx.paths.supervisorLog, 'a', 0o600);
  const child = spawn(process.execPath, [CLI_PATH, 'start', '--supervise'], {
    cwd: ctx.paths.home,
    env: { ...ctx.env, BOTMANCERS_HOME: ctx.paths.home },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let exitCode: number | null = null;
  child.once('exit', code => { exitCode = code ?? PRODUCT_EXIT.childFailed; });
  const deadline = Date.now() + startupTimeout(ctx.env) * 2 + 5000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (exitCode !== null) break;
    const record = readRun(ctx.paths);
    if (record?.state === 'running' && record.supervisor.pid === child.pid) {
      child.unref();
      await announce(record);
      return PRODUCT_EXIT.ok;
    }
  }
  if (exitCode === null) {
    child.kill('SIGTERM');
    exitCode = PRODUCT_EXIT.childFailed;
  }
  ctx.io.stderr(`botmancers: start failed (exit ${exitCode}). Supervisor log ${ctx.paths.supervisorLog}:\n`);
  for (const line of tail(ctx.paths.supervisorLog, from, 40)) ctx.io.stderr(`  ${line}\n`);
  return exitCode;
}

// Re-checks identity each round, so a reaped-and-recycled PID counts as gone.
async function waitGone(record: RunRecord, names: Target['name'][], timeoutMs: number): Promise<Target[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = targetsOf(record).filter(target => names.includes(target.name) && target.owner === 'owned');
    if (!left.length || Date.now() >= deadline) return left;
    await sleep(150);
  }
}

export async function stop(ctx: Ctx): Promise<number> {
  const record = readRun(ctx.paths);
  if (!record) {
    if (existsSync(ctx.paths.runFile)) rmSync(ctx.paths.runFile, { force: true });
    ctx.io.stdout(`botmancers: not running (home ${ctx.paths.home}).\n`);
    return PRODUCT_EXIT.ok;
  }
  const targets = targetsOf(record);
  const owned = targets.filter(target => target.owner === 'owned');
  const unverified = targets.filter(target => target.owner === 'unverified');
  if (!owned.length && !unverified.length) {
    rmSync(ctx.paths.runFile, { force: true });
    ctx.io.stdout(`botmancers: not running; removed stale run metadata (supervisor pid ${record.supervisor.pid} is gone).\n`);
    return PRODUCT_EXIT.ok;
  }
  // The supervisor stops its children; orphans (supervisor gone) are signalled directly.
  const supervisorAlive = owned.some(target => target.name === 'supervisor');
  for (const { name, pid } of owned) {
    if (name === 'supervisor' || !supervisorAlive) {
      try { process.kill(pid!, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  const names = owned.map(target => target.name);
  let survivors = await waitGone(record, names, 15_000);
  if (survivors.length) {
    for (const { pid } of survivors) {
      try { process.kill(pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
    survivors = await waitGone(record, names, 3000);
  }
  const remaining = [...survivors, ...unverified];
  if (remaining.length) {
    // Keep the ownership record (the supervisor may have removed it on its way
    // out) so status reports the survivors and a later stop can retry.
    writeRun(ctx.paths, owned.length ? { ...record, state: 'stopping' } : record);
    if (survivors.length) ctx.io.stderr(`botmancers: could not stop ${survivors.map(({ name, pid }) => `${name} (pid ${pid})`).join(', ')}.\n`);
    if (unverified.length) ctx.io.stderr(`botmancers: ${unverifiedNote(unverified)}. If they are not botmancers, remove ${ctx.paths.runFile}.\n`);
    ctx.io.stderr(`botmancers: run metadata kept in ${ctx.paths.runFile}; retry with botmancers stop.\n`);
    return PRODUCT_EXIT.degraded;
  }
  rmSync(ctx.paths.runFile, { force: true });
  ctx.io.stdout(`botmancers: stopped (${owned.map(({ name, pid }) => `${name} pid ${pid}`).join(', ')}).\n`);
  return PRODUCT_EXIT.ok;
}

// ---------------------------------------------------------------------
// doctor

type Level = 'ok' | 'warn' | 'fail' | 'info';

function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, fsConstants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

export async function doctor(ctx: Ctx): Promise<number> {
  const checks: Array<[Level, string, string]> = [];
  const add = (level: Level, name: string, detail: string) => checks.push([level, name, detail]);

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 9)) add('fail', 'node', `Node ${process.version} is too old; the UI/core needs Node 20.9 or newer (22+ recommended).`);
  else if (major < 22) add('warn', 'node', `Node ${process.version}: the bundled better-sqlite3 declares Node 22+; the native check below decides.`);
  else add('ok', 'node', `Node ${process.version}`);

  const missing = missingAppFiles(ctx.appDir);
  const build = readBuildInfo(ctx.appDir);
  if (missing.length) add('fail', 'assets', `packaged app at ${ctx.appDir} is missing ${missing.join(', ')}; reinstall botmancers.`);
  else if (build?.version !== ctx.version) add('fail', 'assets', `packaged app is version ${build?.version ?? 'unknown'}, CLI is ${ctx.version}; reinstall botmancers.`);
  else add('ok', 'assets', `packaged UI/core ${build.version} (commit ${build.commit.slice(0, 12)})`);

  if (!existsSync(ctx.paths.home)) {
    add('fail', 'home', `${ctx.paths.home} does not exist; run botmancers setup.`);
  } else {
    const unwritable = homeWritable(ctx.paths);
    const mode = modeOf(ctx.paths.home);
    if (unwritable === 'ENOENT') add('fail', 'home', `${ctx.paths.home} is not fully set up; run botmancers setup.`);
    else if (unwritable) add('fail', 'home', `${ctx.paths.home} is not writable (${unwritable}).`);
    else if (mode !== null && (mode & 0o077) !== 0) add('warn', 'home', `${ctx.paths.home} is readable by others (mode ${mode.toString(8)}); run botmancers setup to restore owner-only.`);
    else add('ok', 'home', `${ctx.paths.home} is owner-only and writable`);
  }

  const credentials = credentialState(ctx.paths);
  if (!credentials.ok) add('fail', 'config', `${credentials.problems.join('; ')}; run botmancers setup.`);
  else {
    const loose = [ctx.paths.coreEnv, ctx.paths.bridgeEnv].filter(path => ((modeOf(path) ?? 0) & 0o077) !== 0);
    if (loose.length) add('fail', 'config', `${loose.join(', ')} readable by others; run botmancers setup.`);
    else add('ok', 'config', 'core.env and bridge.env are owner-only; the core lists the digest of the bridge service token');
  }

  if (!missing.includes('node_modules/better-sqlite3/package.json')) {
    try {
      execFileSync(process.execPath, ['-e', `const D=require(${JSON.stringify(join(ctx.appDir, 'node_modules/better-sqlite3'))});new D(':memory:').prepare('select 1').get()`], { cwd: ctx.appDir, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
      add('ok', 'native', `better-sqlite3 loads on ${process.platform}-${process.arch}`);
    } catch (error) {
      const message = String((error as { stderr?: Buffer }).stderr ?? '').split('\n').find(line => /Error/.test(line)) ?? 'load failed';
      add('fail', 'native', `better-sqlite3 does not load on ${process.platform}-${process.arch}: ${message.trim().slice(0, 200)}`);
    }
  }

  const view = await inspect(ctx);
  if (view.state === 'healthy') add('ok', 'product', `running and healthy: UI ${view.record!.ui.url}, MCP ${view.record!.mcp.url}`);
  else if (view.state === 'degraded') add('fail', 'product', `running but degraded: ${view.problems.join('; ')}`);
  else {
    const busy: string[] = [];
    for (const port of [ctx.uiPort, ctx.mcpPort]) if (!(await portFree(port))) busy.push(String(port));
    if (busy.length) add('fail', 'ports', `port${busy.length > 1 ? 's' : ''} ${busy.join(' and ')} on ${PRODUCT_HOST} ${busy.length > 1 ? 'are' : 'is'} in use by another process; botmancers start would fail.`);
    else add('ok', 'ports', `${PRODUCT_HOST}:${ctx.uiPort} and ${PRODUCT_HOST}:${ctx.mcpPort} are free (product stopped)`);
  }

  const core = { ...(readEnvFile(ctx.paths.coreEnv) ?? {}), ...ctx.env };
  if ((core.HERMES_API_SERVER_KEY ?? '').trim()) add('ok', 'hermes', `HERMES_API_SERVER_KEY is configured (gateway ${core.HERMES_BASE_URL?.trim() || 'http://127.0.0.1:8642'})`);
  else add('warn', 'hermes', `Hermes is not configured: conversational turns post a Hermes error until HERMES_API_SERVER_KEY is set in ${ctx.paths.coreEnv}.`);

  const deckUrl = (ctx.env[AGENT_DECK_URL_ENV] ?? '').trim() || DEFAULT_AGENT_DECK_URL;
  const deckBin = onPath('agent-deck', ctx.env);
  if (!deckBin) add('warn', 'agent-deck', 'Agent Deck is unavailable: `agent-deck` is not on PATH; coding-agent runs cannot launch.');
  else if (!(await reachable(deckUrl))) add('warn', 'agent-deck', `Agent Deck is unavailable: ${deckBin} found, but its server at ${deckUrl} is not answering.`);
  else if (!(core.AGENT_DECK_RUN_TOKEN ?? '').trim()) add('warn', 'agent-deck', `Agent Deck is reachable at ${deckUrl}, but AGENT_DECK_RUN_TOKEN is not set in ${ctx.paths.coreEnv}.`);
  else add('ok', 'agent-deck', `agent-deck on PATH, server ${deckUrl} reachable, run token configured`);

  const failures = checks.filter(([level]) => level === 'fail').length;
  const warnings = checks.filter(([level]) => level === 'warn').length;
  const lines = [`botmancers doctor ${ctx.version} (home ${ctx.paths.home})`];
  for (const [level, name, detail] of checks) lines.push(`  ${level.padEnd(5)} ${name.padEnd(11)} ${detail}`);
  lines.push(failures ? `result: FAILED (${failures} problem${failures > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'})` : `result: ok (${warnings} warning${warnings === 1 ? '' : 's'})`);
  ctx.io.stdout(`${lines.join('\n')}\n`);
  return failures ? PRODUCT_EXIT.degraded : PRODUCT_EXIT.ok;
}
