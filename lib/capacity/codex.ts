// Codex capacity via App Server account/rateLimits/read (read-only).
// Adapted from agent-dealer; Botmancers-owned (client name botmancers).

import { spawn, type ChildProcess } from 'node:child_process';
import type { CapacityWindow } from './types';
import { remainingPercentFromFraction, remainingPercentFromUsedPercent } from './types';

const READ_ONLY_METHODS = ['initialize', 'initialized', 'account/rateLimits/read'] as const;
type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];

const CLIENT_INFO = { name: 'botmancers', title: 'botmancers', version: '0.9.3' } as const;

const AUTH_RE =
  /unauthenticated|unauthorized|not (signed|logged)[ -]in|not authenticated|authentication (required|failed|expired)|please (sign|log) in|signed out|logged out|\b401\b|\b403\b|forbidden/i;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = asFiniteNumber(c);
    if (n !== null) return n;
  }
  return null;
}

function normalizeResetsAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeResetsAt(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function assertReadOnly(method: string): asserts method is ReadOnlyMethod {
  if (!(READ_ONLY_METHODS as readonly string[]).includes(method)) {
    throw new Error(`codex-capacity: refusing non-read method ${method}`);
  }
}

function request(id: number, method: ReadOnlyMethod, params: unknown): string {
  assertReadOnly(method);
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

function notification(method: ReadOnlyMethod, params: unknown): string {
  assertReadOnly(method);
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

function windowFromEntry(
  entry: unknown,
  role: 'five_hour' | 'weekly',
  observedAt: string
): CapacityWindow | null {
  if (!entry || typeof entry !== 'object') return null;
  const w = entry as Record<string, unknown>;
  const usedPercent = pickNumber([w.usedPercent, w.used_percent]);
  const usedFraction = pickNumber([w.usedFraction, w.used_fraction]);
  if (usedPercent === null && usedFraction === null) return null;
  const remaining =
    usedPercent !== null
      ? remainingPercentFromUsedPercent(usedPercent)
      : remainingPercentFromFraction(usedFraction as number);
  return {
    windowKey: role === 'five_hour' ? 'codex_rate_limit_primary' : 'codex_rate_limit_secondary',
    providerBucket: role === 'five_hour' ? 'primary' : 'secondary',
    displayLabel: role === 'five_hour' ? '5H' : '1W',
    remainingPercent: remaining,
    resetAt: normalizeResetsAt(w.resetsAt ?? w.resets_at ?? w.resetAt ?? w.reset_at),
    observedAt,
    source: 'supported_protocol',
    unavailableReason: null,
    criticalRole: role,
  };
}

/** Normalize aggregate rateLimits.primary/secondary into critical windows. */
export function parseCodexRateLimits(payload: unknown, observedAt = new Date().toISOString()): CapacityWindow[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const rateLimits = (payload as Record<string, unknown>).rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const map = rateLimits as Record<string, unknown>;
  const windows: CapacityWindow[] = [];
  const primary = windowFromEntry(map.primary, 'five_hour', observedAt);
  const secondary = windowFromEntry(map.secondary, 'weekly', observedAt);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows.length > 0 ? windows : null;
}

export function codexCapacityTimeoutMs(): number {
  const raw = process.env.BOTMANCERS_CODEX_CAPACITY_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 15_000;
}

type FailureKind = 'unavailable' | 'unauthenticated' | 'timeout' | 'malformed' | 'unsupported';

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseLine(line: string): (RpcResponse & { method?: unknown }) | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as RpcResponse & { method?: unknown };
  } catch {
    return null;
  }
}

function errorLooksAuth(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  return AUTH_RE.test(String(e.message ?? '')) || e.code === 401 || e.code === 403;
}

/**
 * Spawn Codex app-server, initialize, read account/rateLimits/read. Never throws.
 */
export function readCodexCapacity(opts: {
  command?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
} = {}): Promise<{ windows: CapacityWindow[] | null; failure: FailureKind | null }> {
  const command = opts.command || process.env.BOTMANCERS_CODEX_BIN || 'codex';
  const timeoutMs = opts.timeoutMs ?? codexCapacityTimeoutMs();
  const spawnImpl = opts.spawnImpl ?? spawn;
  return new Promise(resolve => {
    let settled = false;
    let child: ChildProcess | undefined;
    let buffer = '';
    let initResolve: ((r: RpcResponse) => void) | null = null;
    let readResolve: ((r: RpcResponse) => void) | null = null;

    const finish = (out: { windows: CapacityWindow[] | null; failure: FailureKind | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already exited */
      }
      resolve(out);
    };
    const fail = (kind: FailureKind) => finish({ windows: null, failure: kind });

    const onLine = (line: string) => {
      const msg = parseLine(line);
      if (!msg) return;
      if (typeof msg.method === 'string' && msg.id === undefined) return;
      if (msg.id === 1 && initResolve) {
        const cb = initResolve;
        initResolve = null;
        cb(msg);
      } else if (msg.id === 2 && readResolve) {
        const cb = readResolve;
        readResolve = null;
        cb(msg);
      }
    };

    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      const killer = setTimeout(() => {
        try {
          if (child && child.exitCode === null) child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      killer.unref?.();
      fail('timeout');
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(command, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch {
      fail('unavailable');
      return;
    }

    let stderrTail = '';
    child.stderr?.on('data', (buf: Buffer) => {
      stderrTail = `${stderrTail}${buf.toString()}`.slice(-2000);
    });
    child.stdout?.on('data', (buf: Buffer) => {
      buffer += buf.toString();
      if (buffer.length > 10 * 1024 * 1024) {
        fail('malformed');
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
        if (settled) return;
      }
    });
    child.on('error', () => fail('unavailable'));
    child.stdin?.on('error', () => fail('unavailable'));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 && code !== null && AUTH_RE.test(stderrTail)) {
        fail('unauthenticated');
        return;
      }
      fail('unavailable');
    });

    const write = (chunk: string): boolean => {
      try {
        child?.stdin?.write(chunk);
        return true;
      } catch {
        return false;
      }
    };

    void (async () => {
      if (!write(request(1, 'initialize', { clientInfo: { ...CLIENT_INFO } }))) {
        fail('unavailable');
        return;
      }
      const init = await new Promise<RpcResponse | null>(res => {
        initResolve = res;
      });
      if (settled) return;
      if (!init || init.error) {
        fail(init?.error && errorLooksAuth(init.error) ? 'unauthenticated' : 'unavailable');
        return;
      }
      write(notification('initialized', {}));
      if (!write(request(2, 'account/rateLimits/read', {}))) {
        fail('unavailable');
        return;
      }
      const read = await new Promise<RpcResponse | null>(res => {
        readResolve = res;
      });
      if (settled) return;
      if (!read) {
        fail('unavailable');
        return;
      }
      if (read.error) {
        if (errorLooksAuth(read.error)) fail('unauthenticated');
        else if (read.error.code === -32601) fail('unsupported');
        else fail('malformed');
        return;
      }
      let payload = read.result;
      if (
        payload &&
        typeof payload === 'object' &&
        !('rateLimits' in (payload as Record<string, unknown>)) &&
        (payload as Record<string, unknown>).result !== undefined
      ) {
        payload = (payload as Record<string, unknown>).result;
      }
      const windows = parseCodexRateLimits(payload);
      finish({ windows, failure: windows ? null : 'malformed' });
    })();
  });
}
