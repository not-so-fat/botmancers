// NOT-504: a JSON-RPC client for Codex's app-server protocol (`codex
// app-server`, newline-delimited JSON over stdio). The direct Codex
// SessionProvider (./codex-session-provider) is its only user.
//
// Everything here is structured protocol: requests with ids, responses,
// notifications, and server-initiated requests. Nothing reads terminal UI
// output; stderr is drained and ignored.
import { spawn, type ChildProcess } from 'child_process';

export interface RpcError {
  code: number;
  message: string;
}

// kind 'rpc': the server answered with an error. 'closed': the transport
// ended (spawn failure or exit) before an answer. 'timeout' / 'aborted':
// the caller stopped waiting.
export type RpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: 'rpc' | 'closed' | 'timeout' | 'aborted'; error: RpcError };

export interface RpcTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  // Fired once; `reason` is diagnostic text (for example a spawn errno).
  onClose(listener: (reason: string) => void): void;
  close(): void;
}

// Spawns `command[0] ...command.slice(1)` and speaks JSONL over its stdio.
export function spawnStdioTransport(command: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): RpcTransport {
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(reason);
  };
  let child: ChildProcess;
  try {
    child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env, cwd: options.cwd });
  } catch (error) {
    queueMicrotask(() => finish(`spawn failed: ${(error as Error).message}`));
    return { send: () => {}, onLine: l => lineListeners.push(l), onClose: l => closeListeners.push(l), close: () => {} };
  }
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) for (const listener of lineListeners) listener(line);
    }
  });
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  child.on('error', error => finish(`spawn failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
  child.on('exit', (code, signal) => finish(`exited (${signal ?? code})`));
  return {
    send(line) {
      if (!closed && child.stdin?.writable) child.stdin.write(`${line}\n`);
    },
    onLine: listener => lineListeners.push(listener),
    onClose: listener => closeListeners.push(listener),
    close() {
      if (closed) return;
      child.stdin?.end();
      child.kill('SIGTERM');
    },
  };
}

type Notification = { method: string; params: Record<string, unknown> };
type ServerRequestHandler = (method: string, params: Record<string, unknown>) => { result: unknown } | { error: RpcError };

interface Pending {
  resolve: (value: RpcResult<unknown>) => void;
  timer: NodeJS.Timeout | null;
  cleanup: () => void;
}

export class CodexAppServerClient {
  private readonly transport: RpcTransport;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(notification: Notification) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private nextId = 1;
  private serverRequestHandler: ServerRequestHandler | null = null;
  closed = false;
  closeReason: string | null = null;

  constructor(transport: RpcTransport, private readonly defaultTimeoutMs = 30_000) {
    this.transport = transport;
    transport.onLine(line => this.receive(line));
    transport.onClose(reason => {
      this.closed = true;
      this.closeReason = reason;
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.cleanup();
        pending.resolve({ ok: false, kind: 'closed', error: { code: -1, message: reason } });
      }
      for (const listener of this.closeListeners) listener(reason);
    });
  }

  request<T>(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal | null } = {}): Promise<RpcResult<T>> {
    if (this.closed) return Promise.resolve({ ok: false, kind: 'closed', error: { code: -1, message: this.closeReason ?? 'closed' } });
    const id = this.nextId++;
    return new Promise(resolve => {
      const signal = options.signal ?? null;
      const onAbort = () => settle({ ok: false, kind: 'aborted', error: { code: -1, message: 'aborted' } });
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const timer = timeoutMs > 0 ? setTimeout(() => settle({ ok: false, kind: 'timeout', error: { code: -1, message: `${method} timed out` } }), timeoutMs) : null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (value: RpcResult<unknown>) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        resolve(value as RpcResult<T>);
      };
      this.pending.set(id, { resolve: value => resolve(value as RpcResult<T>), timer, cleanup });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  handleServerRequests(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  close(): void {
    this.transport.close();
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not a protocol message; never interpreted.
    }
    if (!message || typeof message !== 'object') return;
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    if (hasId && typeof message.method === 'string') {
      const answer = this.serverRequestHandler
        ? this.serverRequestHandler(message.method, (message.params ?? {}) as Record<string, unknown>)
        : { error: { code: -32601, message: 'not handled' } };
      this.transport.send(JSON.stringify({ id: message.id, ...answer }));
      return;
    }
    if (hasId) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      pending.cleanup();
      if (message.error && typeof message.error === 'object') {
        const error = message.error as Partial<RpcError>;
        pending.resolve({ ok: false, kind: 'rpc', error: { code: Number(error.code ?? -32603), message: String(error.message ?? '') } });
      } else pending.resolve({ ok: true, result: message.result });
      return;
    }
    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: (message.params ?? {}) as Record<string, unknown> };
      for (const listener of this.listeners) listener(notification);
    }
  }
}

// Whether a JSON-RPC error says the server does not know `method` at all
// (as opposed to rejecting its parameters). Codex answers an unknown
// method with -32601, or -32600 "unknown variant `<method>`".
export function isUnknownMethod(error: RpcError, method: string): boolean {
  if (error.code === -32601 && !/not supported yet/i.test(error.message)) return true;
  return error.message.includes(`unknown variant \`${method}\``);
}
